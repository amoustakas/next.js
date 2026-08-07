// mannachef/apps/web/src/app/api/webhooks/stripe/route.ts

/**
 * The Stripe webhook endpoint — the only route on this platform that accepts a
 * write from outside without a session behind it.
 *
 * `mannachef/CONTRACT.md` §5 states the four rules this file exists to keep:
 * verify `stripe-signature` with `constructEvent`, run on the Node runtime,
 * read the **raw** body, and be idempotent through a persisted `StripeEvent`
 * ledger. Each is implemented below, in that order, and none of them is
 * optional.
 *
 * ## 1. The raw body, and why `runtime = 'nodejs'`
 *
 * Stripe signs the exact bytes it sent. Anything that parses the body first —
 * `req.json()`, a body-parsing middleware, a re-serialisation — changes those
 * bytes (key order, whitespace, unicode escaping) and the signature will not
 * verify. The handler therefore reads `await req.text()` **once**, before
 * anything else looks at the request, and hands that same string to
 * `constructEvent`. It never calls `req.json()`.
 *
 * The Node runtime is required rather than merely preferred: signature
 * verification uses `node:crypto`, and so does the SHA-256 digest of the
 * payload that the ledger stores in place of the payload itself.
 *
 * ## 2. Nothing is processed unverified
 *
 * A missing or bad signature is a **400** and stops there. An event object is
 * just JSON until `constructEvent` has proved it came from Stripe; every field
 * read below — the customer id, the amounts, the metadata that decides which
 * user a subscription belongs to — would otherwise be attacker-controlled.
 *
 * ## 3. Idempotency: record first, then process
 *
 * The event id is inserted into the `StripeEvent` ledger **before** any effect
 * runs, and the unique index on `stripeEventId` is what rejects a replay. The
 * ordering is the interesting part:
 *
 *  - **Record-then-process** (what this does). A crash between the insert and
 *    the effect leaves a row with `processedAt IS NULL`. Stripe redelivers, we
 *    find that row, increment `attempts`, and run the effect again. Nothing is
 *    dropped. The cost is that an effect may run more than once, which is why
 *    every handler below is written to be idempotent — upserts keyed on the
 *    Stripe id, monotonic guards, no blind increments.
 *  - **Process-then-record** would lose the memory of a completed effect if the
 *    crash landed the other side of it, replaying a non-idempotent write with
 *    no record that it had already happened.
 *  - **Both in one transaction** does not help either: the commit can succeed
 *    and the process still die before the 200 reaches Stripe, so redelivery is
 *    unavoidable no matter where the ledger write sits.
 *
 * So the semantics are deliberately **at-least-once**, and idempotency is the
 * handlers' job rather than the transaction's. `attempts` is what makes that
 * visible: a row whose `attempts` keeps climbing while `processedAt` stays null
 * is an effect that cannot succeed, and after {@link MAX_PROCESSING_ATTEMPTS}
 * it is left as a dead letter for an operator to sweep — see
 * {@link admitEvent}.
 *
 * A replay of an already-processed event returns **200 immediately** and runs
 * nothing.
 *
 * ## 4. Stripe delivers out of order
 *
 * Stripe makes no ordering guarantee, and retries make it worse: an event
 * created at 10:00 that failed twice can arrive after one created at 10:05. A
 * `customer.subscription.updated` carrying older state must not overwrite newer
 * state, so every handler compares `event.created` against a watermark before
 * it writes. See {@link isStaleAgainst} for the watermark, its one known
 * imprecision, and the migration that would remove it.
 *
 * ## 5. Never logged, never persisted
 *
 * No secret, no raw payload, no card number. The ledger stores a SHA-256 digest
 * of the body — `StripeEvent.payloadHash`, exactly as the schema comment
 * requires — and the body itself is discarded. Log lines carry event ids,
 * object ids and types; the response body carries an acknowledgement and
 * nothing else. `errorMessage` on the ledger is a truncated exception summary
 * for an operator and is never returned to the caller.
 *
 * ## 6. Attribution is evidence, not resemblance
 *
 * Verifying the signature proves the event came from Stripe. It does not prove
 * *whose* it is, and the two are easy to conflate: a Stripe account holds
 * customers created by things other than this platform, and one of them
 * resembling a MannaChef account is not the same as belonging to one.
 *
 * {@link resolveUserId} therefore accepts only evidence this platform itself
 * produced — the `mannachefUserId` metadata, the checkout
 * `client_reference_id`, or a `UserSubscription` row already linked to the
 * customer. A customer whose sole connection to an account is a **shared email
 * address** is refused and quarantined instead: nothing is attached, the ledger
 * row is marked for a human, and one line is logged naming the customer id.
 * See {@link resolveUserIdFromCustomer} for the reasoning and
 * {@link RECONCILE_PREFIX} for how to find the queue.
 */

import { createHash } from 'node:crypto'

import {
  paymentStatusAfterRefund,
  type InvoiceStatus,
  type PaymentMethodType,
  type PaymentStatus,
  type SubscriptionStatus,
} from '@mannachef/validators'
import type Stripe from 'stripe'

import { Prisma, prisma } from '@/server/db'
import {
  createReferralRedemption,
  resolveRedemptionEligibility,
} from '@/server/referral-eligibility'
import { getStripe, STRIPE_CUSTOMER_USER_ID_KEY } from '@/server/stripe'

/**
 * Required. Signature verification and the payload digest both use
 * `node:crypto`, which the edge runtime does not provide in the form the
 * Stripe SDK expects.
 */
export const runtime = 'nodejs'

/**
 * A webhook is never cached and never prerendered. `POST` handlers are dynamic
 * by default; this states it so a future `export const revalidate` somewhere in
 * the segment tree cannot quietly change it.
 */
export const dynamic = 'force-dynamic'

// =============================================================================
// 1. Constants
// =============================================================================

/**
 * How many times an event may fail before it is abandoned.
 *
 * Beyond this the handler answers 200 so Stripe stops redelivering, and the
 * ledger row — `processedAt IS NULL`, `errorMessage` set, `attempts` at the
 * ceiling — becomes the dead letter. `@@index([processedAt])` exists on
 * `StripeEvent` precisely so that queue can be swept.
 *
 * The alternative, answering 500 forever, hands the alerting to Stripe's own
 * dashboard but re-runs a broken effect roughly fifteen more times over three
 * days. Failing loudly into a table we own is the better trade for a platform
 * whose effects touch money.
 */
const MAX_PROCESSING_ATTEMPTS = 5

/** How much of an exception summary the ledger keeps. Operator-facing only. */
const MAX_LEDGER_ERROR_LENGTH = 400

/** Stripe payment-method type strings we have an enum member for. */
const PAYMENT_METHOD_TYPES: Readonly<Record<string, PaymentMethodType>> = {
  card: 'CARD',
  card_present: 'CARD',
  link: 'CARD',
  us_bank_account: 'ACH_DEBIT',
  ach_debit: 'ACH_DEBIT',
  acss_debit: 'ACH_DEBIT',
  au_becs_debit: 'ACH_DEBIT',
  bacs_debit: 'ACH_DEBIT',
  sepa_debit: 'ACH_DEBIT',
  customer_balance: 'BANK_TRANSFER',
  interac_present: 'INTERAC',
}

// =============================================================================
// 2. The route
// =============================================================================

interface AcknowledgementBody {
  readonly received: boolean
  /** `true` when the ledger recognised the event and nothing was re-run. */
  readonly duplicate?: boolean
  /** `false` when the event is one this platform has no opinion about. */
  readonly handled?: boolean
  /**
   * Present when an ordering guard, a missing linkage or a refused attribution
   * skipped the write. A fixed vocabulary — `stale-event`, `unknown-user`,
   * `unattributed-customer` and the like — never free text about the payload.
   */
  readonly skipped?: string
}

function acknowledge(body: AcknowledgementBody, status = 200): Response {
  return Response.json(body, { status })
}

function refuse(reason: string, status: number): Response {
  // The reason is a fixed string chosen from the four below — never an
  // exception message, which could carry detail about our configuration.
  return Response.json({ received: false, error: reason }, { status })
}

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature')

  if (signature === null || signature.length === 0) {
    return refuse('missing signature', 400)
  }

  const webhookSecret = readWebhookSecret()

  if (webhookSecret === null) {
    // A deployment that receives Stripe webhooks without a signing secret
    // cannot verify anything, and must never fall back to trusting the body.
    console.error(
      '[stripe-webhook] STRIPE_WEBHOOK_SECRET is not configured; refusing the delivery.'
    )

    return refuse('webhook unavailable', 500)
  }

  // The client is obtained *before* the verification try/catch on purpose.
  // `getStripe()` throws when `STRIPE_SECRET_KEY` is absent, and folding that
  // throw into the catch below would answer 400 — which Stripe reads as a
  // permanent rejection and stops retrying. A missing key is a deployment
  // fault that will be fixed, so it must be a retryable 500.
  let stripe: Stripe

  try {
    stripe = getStripe()
  } catch (error) {
    console.error('[stripe-webhook] Stripe client unavailable', {
      reason: summariseError(error),
    })

    return refuse('webhook unavailable', 500)
  }

  // The raw bytes, read exactly once and never re-parsed. `request.json()` is
  // deliberately not called anywhere in this file.
  const rawBody = await request.text()

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (error) {
    // The exception carries the reason verification failed. It is logged
    // without the payload and never returned.
    console.error('[stripe-webhook] signature verification failed', {
      reason: summariseError(error),
    })

    return refuse('invalid signature', 400)
  }

  const payloadHash = createHash('sha256').update(rawBody).digest('hex')
  const eventCreatedAt = new Date(event.created * 1000)

  let admission: Admission

  try {
    admission = await admitEvent(event, payloadHash)
  } catch (error) {
    // The ledger is unreachable. Refusing to process is the only safe answer:
    // running the effect without a ledger row would leave no memory of it and
    // let the redelivery run it a second time.
    console.error(`[stripe-webhook] ledger write failed for ${event.id}`, {
      reason: summariseError(error),
    })

    return refuse('processing failed', 500)
  }

  if (admission === 'duplicate') {
    // Already processed. Acknowledge and run nothing — this is the whole point
    // of the ledger.
    return acknowledge({ received: true, duplicate: true })
  }

  if (admission === 'exhausted') {
    console.error(
      `[stripe-webhook] abandoning ${event.type} ${event.id} after ${MAX_PROCESSING_ATTEMPTS} failed attempts; left unprocessed in the ledger.`
    )

    return acknowledge({ received: true, handled: false, skipped: 'abandoned' })
  }

  try {
    const outcome = await processEvent(event, eventCreatedAt)

    // `updateMany` rather than `update`: the ledger row is addressed by its
    // Stripe id, and a `P2025` here — if the row were swept between admission
    // and completion — must not turn a completed effect into a 500 that asks
    // Stripe to run it again.
    // `errorMessage` is cleared on success, unless the handler asked for a
    // reconciliation note — see `RECONCILE_PREFIX` for why that note shares a
    // column with the failure summaries, and why the row is still `processed`.
    await prisma.stripeEvent.updateMany({
      where: { stripeEventId: event.id },
      data: {
        processedAt: new Date(),
        errorMessage: outcome.reconcile ?? null,
      },
    })

    return acknowledge({
      received: true,
      handled: outcome.handled,
      ...(outcome.skipped !== undefined ? { skipped: outcome.skipped } : {}),
    })
  } catch (error) {
    const summary = summariseError(error)

    console.error(`[stripe-webhook] ${event.type} ${event.id} failed`, {
      reason: summary,
    })

    await prisma.stripeEvent
      .updateMany({
        where: { stripeEventId: event.id },
        data: { errorMessage: summary },
      })
      .catch(() => {
        // The ledger write is best-effort. Losing the note must not mask the
        // 500 that asks Stripe to redeliver.
      })

    // 500 tells Stripe to retry. `processedAt` is still null, so the retry
    // will be admitted rather than treated as a duplicate.
    return refuse('processing failed', 500)
  }
}

function readWebhookSecret(): string | null {
  const raw = process.env['STRIPE_WEBHOOK_SECRET']

  if (raw === undefined) {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * A short, operator-facing summary of a thrown value.
 *
 * Deliberately not the whole error: no stack, no cause chain, truncated. It is
 * written to `StripeEvent.errorMessage` and to the server log, and it is never
 * part of a response body.
 */
function summariseError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `PrismaClientKnownRequestError (${error.code})`.slice(
      0,
      MAX_LEDGER_ERROR_LENGTH
    )
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, MAX_LEDGER_ERROR_LENGTH)
  }

  return 'unknown error'
}

// =============================================================================
// 3. The idempotency ledger
// =============================================================================

/** What {@link admitEvent} decided. */
type Admission =
  /** Run the effect. Either the first delivery, or a retry of a failed one. */
  | 'admitted'
  /** Already processed successfully. Acknowledge, run nothing. */
  | 'duplicate'
  /** Failed too many times. Acknowledge, run nothing, leave a dead letter. */
  | 'exhausted'

/**
 * Insert the event into the ledger, or decide what to do with the row that is
 * already there.
 *
 * The insert is attempted **first and unconditionally**, so the unique index on
 * `StripeEvent.stripeEventId` — not a read-then-write, which two concurrent
 * deliveries of the same event would both pass — is what serialises the
 * decision. Only the loser of that race takes the `P2002` branch.
 *
 * `attempts` starts at 1 on the first admission and is incremented on every
 * subsequent one, so it counts *attempts to process*, not deliveries received.
 */
async function admitEvent(
  event: Stripe.Event,
  payloadHash: string
): Promise<Admission> {
  try {
    await prisma.stripeEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        apiVersion: event.api_version,
        livemode: event.livemode,
        payloadHash,
        attempts: 1,
      },
    })

    return 'admitted'
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error
    }
  }

  const existing = await prisma.stripeEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true, processedAt: true, attempts: true },
  })

  if (existing === null) {
    // The row lost the insert race and then disappeared — only possible if a
    // sweep deleted it in between. Treat the delivery as new; the handlers are
    // idempotent, so re-running is safe, and the completion write below uses
    // `updateMany`, which tolerates the absent row.
    return 'admitted'
  }

  if (existing.processedAt !== null) {
    return 'duplicate'
  }

  if (existing.attempts >= MAX_PROCESSING_ATTEMPTS) {
    return 'exhausted'
  }

  await prisma.stripeEvent.update({
    where: { id: existing.id },
    data: { attempts: { increment: 1 } },
  })

  return 'admitted'
}

// =============================================================================
// 4. Ordering guards
// =============================================================================

/**
 * `true` when this event describes state older than what is already stored.
 *
 * ## The watermark
 *
 * `lastWrittenAt` is the row's `updatedAt`, which is the moment we last wrote
 * it — from a webhook or from a Server Action. An event created before that
 * moment is describing a world we have already moved past, so applying it would
 * be a regression: a retried `customer.subscription.updated` from an hour ago
 * resurrecting a subscription that has since been cancelled, for instance.
 *
 * ## The one imprecision, stated plainly
 *
 * `event.created` has one-second resolution, while `updatedAt` is a wall-clock
 * instant that includes however long *we* took to process the previous event.
 * If two events for the same object are created less than one processing
 * latency apart, the second can look older than the first's write. Two things
 * keep that from mattering:
 *
 *  1. The comparison floors the watermark to its second, so an event created in
 *     the same second as the last write is **not** treated as stale.
 *  2. Where the object carries its own monotonic field, that field is checked
 *     as well and takes precedence — `current_period_start` for a subscription,
 *     the cumulative `amount_refunded` for a charge. Those are exact.
 *
 * The clean fix is a dedicated `lastStripeEventAt DateTime?` column on
 * `UserSubscription`, `Invoice` and `PaymentHistory`, written from
 * `event.created` rather than from the clock, which would make the comparison
 * exact in both directions. It needs a migration this task does not own, and it
 * is the first thing to add when one is next cut.
 */
function isStaleAgainst(eventCreatedAt: Date, lastWrittenAt: Date): boolean {
  const watermark = Math.floor(lastWrittenAt.getTime() / 1000) * 1000

  return eventCreatedAt.getTime() < watermark
}

// =============================================================================
// 5. Shared mapping helpers
// =============================================================================

/** What a handler did, for the acknowledgement body and the logs. */
interface HandlerOutcome {
  /** `false` for an event type this platform has no opinion about. */
  readonly handled: boolean
  /** Why nothing was written, when nothing was. */
  readonly skipped?: string
  /**
   * A note for a human, persisted to `StripeEvent.errorMessage` alongside
   * `processedAt`. See {@link RECONCILE_PREFIX}.
   */
  readonly reconcile?: string
}

const HANDLED: HandlerOutcome = { handled: true }
const UNHANDLED: HandlerOutcome = { handled: false }

function skipped(reason: string): HandlerOutcome {
  return { handled: true, skipped: reason }
}

/**
 * How a row that needs a human is marked in the ledger.
 *
 * `StripeEvent` has no column for "processed, but somebody should look at
 * this", and adding one is a migration this task does not own — the same
 * position `actions/user.ts` takes about the absent `AuditLog`. So the note
 * goes in `errorMessage` behind a fixed, greppable prefix, and the
 * reconciliation queue is:
 *
 * ```sql
 * SELECT "stripeEventId", "type", "receivedAt", "errorMessage"
 *   FROM "StripeEvent"
 *  WHERE "errorMessage" LIKE 'reconcile: %'
 *  ORDER BY "receivedAt" DESC;
 * ```
 *
 * `processedAt` **is** set on these rows, deliberately. Redelivery cannot
 * change the outcome — the customer will still have no metadata — so leaving
 * them unprocessed would put permanent residents in the dead-letter sweep that
 * `@@index([processedAt])` exists to keep short, and would tell an operator to
 * retry something no retry can fix.
 */
const RECONCILE_PREFIX = 'reconcile: '

/**
 * Nothing was attached, and here is what to say about it.
 *
 * The `unknown` case is the long-standing behaviour: log it, skip it. The
 * `quarantined` case is MCV-031's — a customer whose *only* link to an account
 * is a shared email address, which this platform declines to treat as
 * evidence. It differs in exactly two ways: the ledger row is marked for an
 * operator, and the skip reason names the real cause so the acknowledgement
 * body does not claim the user was merely unknown.
 *
 * `subject` is the Stripe object under discussion, already rendered by the
 * caller — `charge ch_123`, `invoice in_456`. Ids only: no email address, no
 * amount, no payload. `CONTRACT.md` §5.
 */
function declineAttribution(
  attribution: Exclude<Attribution, { kind: 'resolved' }>,
  subject: string
): HandlerOutcome {
  if (attribution.kind === 'unknown') {
    console.error(
      `[stripe-webhook] ${subject}: no MannaChef user could be resolved.`
    )

    return skipped('unknown-user')
  }

  const note = `${RECONCILE_PREFIX}customer ${attribution.customerId} matches an account by email address only; nothing was attached.`

  console.warn(`[stripe-webhook] ${subject}: ${note}`)

  return {
    handled: true,
    skipped: 'unattributed-customer',
    reconcile: note.slice(0, MAX_LEDGER_ERROR_LENGTH),
  }
}

/** The id of a Stripe reference that may or may not have been expanded. */
function stripeIdOf(
  value: string | { id: string } | null | undefined
): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return typeof value === 'string' ? value : value.id
}

/** `null` for a Stripe timestamp that is absent. */
function fromUnixSeconds(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value * 1000)
}

/**
 * Our `SubscriptionStatus` for a Stripe subscription.
 *
 * The schema keeps Stripe's American single-L `CANCELED` on the billing enums
 * deliberately, so all eight of Stripe's statuses uppercase straight across.
 * Do not confuse this with the *domain* enums — `AppointmentStatus.CANCELLED`
 * and `BookingSlotStatus.CANCELLED` are double-L, because they are ours rather
 * than Stripe's, and a mapping that reached for the wrong spelling would not
 * compile.
 *
 * The only derivation is the pause. Stripe leaves `status` at `active` while
 * `pause_collection` is set — `PAUSED` is our own state — so it is derived from
 * the presence of that object, exactly as `changeSubscription` derives it when
 * it sets the pause. Without this, the `customer.subscription.updated` that
 * follows a pause would immediately un-pause the row we had just paused. A
 * delinquent or terminal status always wins: a subscriber whose card has failed
 * is `PAST_DUE`, resting or not.
 */
function subscriptionStatusFor(
  subscription: Stripe.Subscription
): SubscriptionStatus {
  const mapped = subscriptionStatusName(subscription.status)

  if (
    subscription.pause_collection !== null &&
    (mapped === 'ACTIVE' || mapped === 'TRIALING')
  ) {
    return 'PAUSED'
  }

  return mapped
}

/**
 * Stripe's eight subscription statuses, written out rather than uppercased.
 *
 * The uppercase really is a straight mapping — that is why the schema keeps the
 * single-L spelling — but writing it as a `switch` makes a ninth status Stripe
 * might add a **compile error** instead of an invalid enum value handed to
 * Postgres at three in the morning.
 */
function subscriptionStatusName(
  status: Stripe.Subscription.Status
): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'ACTIVE'

    case 'canceled':
      return 'CANCELED'

    case 'incomplete':
      return 'INCOMPLETE'

    case 'incomplete_expired':
      return 'INCOMPLETE_EXPIRED'

    case 'past_due':
      return 'PAST_DUE'

    case 'paused':
      return 'PAUSED'

    case 'trialing':
      return 'TRIALING'

    case 'unpaid':
      return 'UNPAID'

    default: {
      const exhaustive: never = status
      void exhaustive
      return 'INCOMPLETE'
    }
  }
}

/**
 * Our `InvoiceStatus` for a Stripe invoice.
 *
 * A `null` status is only ever seen on an *upcoming* invoice, which is never
 * delivered by webhook; it becomes `DRAFT` rather than crashing the delivery.
 */
function invoiceStatusFor(invoice: Stripe.Invoice): InvoiceStatus {
  switch (invoice.status) {
    case 'draft':
    case null:
      return 'DRAFT'

    case 'open':
      return 'OPEN'

    case 'paid':
      return 'PAID'

    case 'uncollectible':
      return 'UNCOLLECTIBLE'

    case 'void':
      return 'VOID'

    default: {
      const exhaustive: never = invoice.status
      void exhaustive
      return 'DRAFT'
    }
  }
}

/**
 * Our `PaymentStatus` for a Stripe payment intent.
 *
 * `requires_capture` has no member of its own — this platform never separates
 * authorisation from capture — so it maps onto `REQUIRES_CONFIRMATION`, the
 * nearest "waiting on us" state. Everything else is a straight uppercase, and
 * the refund states are reached from `charge.refunded` rather than from here.
 */
function paymentStatusFor(status: Stripe.PaymentIntent.Status): PaymentStatus {
  switch (status) {
    case 'requires_payment_method':
      return 'REQUIRES_PAYMENT_METHOD'

    case 'requires_confirmation':
    case 'requires_capture':
      return 'REQUIRES_CONFIRMATION'

    case 'requires_action':
      return 'REQUIRES_ACTION'

    case 'processing':
      return 'PROCESSING'

    case 'succeeded':
      return 'SUCCEEDED'

    case 'canceled':
      return 'CANCELED'

    default: {
      // A new member of Stripe's status union is a compile error here rather
      // than a payment silently filed as "processing" forever.
      const exhaustive: never = status
      void exhaustive
      return 'PROCESSING'
    }
  }
}

function paymentMethodFor(charge: Stripe.Charge | null): PaymentMethodType {
  const type = charge?.payment_method_details?.type

  if (type === undefined) {
    return 'OTHER'
  }

  return PAYMENT_METHOD_TYPES[type] ?? 'OTHER'
}

/**
 * What could be established about who a Stripe object belongs to.
 *
 * Three answers rather than two, because "we found a plausible account and are
 * deliberately not using it" is not the same event as "we found nothing", and
 * filing them under one `null` is what made the email fallback dangerous.
 */
type Attribution =
  /** A confirmed `User.id`. The only value a handler may write against. */
  | { readonly kind: 'resolved'; readonly userId: string }
  /** Nothing matched. The event is skipped. */
  | { readonly kind: 'unknown' }
  /**
   * An account matched **by email address alone**, and was refused. See
   * {@link resolveUserIdFromCustomer} for why, and {@link declineAttribution}
   * for what is recorded instead.
   */
  | { readonly kind: 'quarantined'; readonly customerId: string }

const UNKNOWN_ATTRIBUTION: Attribution = { kind: 'unknown' }

function attributed(userId: string): Attribution {
  return { kind: 'resolved', userId }
}

/**
 * The MannaChef user behind a Stripe object.
 *
 * Four sources, cheapest and most trustworthy first. Every candidate is
 * confirmed against the `User` table before it is used: the metadata is written
 * by us, but a foreign key violation deep inside a handler is a far worse
 * failure than a skipped event, and confirming costs one indexed read.
 *
 *  1. `metadata.mannachefUserId` — set by `createCheckoutSession` on both the
 *     session and the subscription.
 *  2. `client_reference_id` — the Checkout session's own copy of the same id.
 *  3. The local `UserSubscription` rows for this customer. Any existing
 *     subscriber resolves here with no network call.
 *  4. The Stripe customer's own metadata.
 *
 * The customer's **email address** used to be a fifth source. It is not any
 * more; it now quarantines instead — see {@link resolveUserIdFromCustomer}.
 */
async function resolveUserId(args: {
  metadata?: Stripe.Metadata | null
  clientReferenceId?: string | null
  customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null
}): Promise<Attribution> {
  const fromMetadata = await confirmUserId(
    args.metadata?.[STRIPE_CUSTOMER_USER_ID_KEY]
  )

  if (fromMetadata !== null) {
    return attributed(fromMetadata)
  }

  const fromReference = await confirmUserId(args.clientReferenceId)

  if (fromReference !== null) {
    return attributed(fromReference)
  }

  const customerId = stripeIdOf(args.customer ?? null)

  if (customerId === null) {
    return UNKNOWN_ATTRIBUTION
  }

  const local = await prisma.userSubscription.findFirst({
    where: { stripeCustomerId: customerId },
    orderBy: { createdAt: 'desc' },
    select: { userId: true },
  })

  if (local !== null) {
    return attributed(local.userId)
  }

  return resolveUserIdFromCustomer(args.customer ?? customerId, customerId)
}

async function confirmUserId(
  candidate: string | null | undefined
): Promise<string | null> {
  if (candidate === undefined || candidate === null || candidate.length === 0) {
    return null
  }

  const user = await prisma.user.findUnique({
    where: { id: candidate },
    select: { id: true },
  })

  return user?.id ?? null
}

/**
 * The user behind a Stripe customer, from the customer object itself.
 *
 * Retrieves the customer when only an id was delivered. A deleted customer has
 * neither metadata nor an email, so it resolves to `unknown` and the event is
 * skipped rather than misattributed.
 *
 * ## Why an email match is refused (MCV-031)
 *
 * The customer's metadata carries `mannachefUserId` because
 * `createCheckoutSession` put it there. That is a claim *this platform* made
 * about *this customer*, and it is trustworthy for the same reason the
 * signature check is: nobody else could have written it.
 *
 * An email address is not that. A Stripe account can hold customers created
 * anywhere — the dashboard, an invoice typed by hand, a Payment Link, a second
 * product sharing the same Stripe account, an import from a previous system —
 * and any of them may carry an address that also belongs to a MannaChef
 * account. Matching on it was a guess dressed as a lookup, and the cost of
 * guessing wrong is not an abstraction: `handlePaymentIntentChanged` and
 * `handleChargeRefunded` write a `PaymentHistory` row with the amount, the card
 * brand, the last four digits and the Stripe receipt URL. A stranger's payment
 * would appear in a household's billing history, and the receipt URL would show
 * them the rest.
 *
 * Nothing about the ranking saved it. Being fourth behind metadata,
 * `client_reference_id` and a local subscription only means the fallback fires
 * exactly when the platform has *no* evidence at all — which is precisely when
 * a guess is least defensible. Nor does the sign-in method: magic link and
 * OAuth prove the *account holder* controls the mailbox, and prove nothing
 * whatsoever about who created some customer object in Stripe.
 *
 * ## What happens instead
 *
 * The match is found and then deliberately dropped. `quarantined` carries the
 * customer id up to {@link declineAttribution}, which attaches nothing, marks
 * the ledger row for an operator, and logs one line naming the customer.
 *
 * The alternative considered was deleting the fallback outright and requiring
 * the metadata unconditionally. It was rejected because it is the same
 * behaviour with less information: a concierge who raises an invoice for an
 * existing household from the Stripe dashboard creates a customer with no
 * metadata, and that is a legitimate thing to do. Under a hard requirement the
 * payment simply vanishes from the platform with a log line nobody reads; under
 * quarantine it lands in a queue an administrator can work through and attach
 * by hand. Neither version ever attributes on the strength of an email address,
 * which is the whole of the security property — quarantine just declines to
 * throw away the operator's ability to fix it.
 *
 * The email address itself is never logged and never returned: `CONTRACT.md`
 * §5, and the same rule `recordAccountAudit` follows in `actions/user.ts`.
 */
async function resolveUserIdFromCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer,
  customerId: string
): Promise<Attribution> {
  let resolved: Stripe.Customer | Stripe.DeletedCustomer

  if (typeof customer === 'string') {
    resolved = await getStripe().customers.retrieve(customer)
  } else {
    resolved = customer
  }

  if (resolved.deleted === true) {
    return UNKNOWN_ATTRIBUTION
  }

  const fromMetadata = await confirmUserId(
    resolved.metadata[STRIPE_CUSTOMER_USER_ID_KEY]
  )

  if (fromMetadata !== null) {
    return attributed(fromMetadata)
  }

  if (resolved.email === null || resolved.email.length === 0) {
    return UNKNOWN_ATTRIBUTION
  }

  const byEmail = await prisma.user.findUnique({
    where: { email: resolved.email },
    select: { id: true },
  })

  if (byEmail === null) {
    return UNKNOWN_ATTRIBUTION
  }

  // A match, and therefore a decision — not a resolution. The id is
  // intentionally dropped here and never travels further.
  return { kind: 'quarantined', customerId }
}

// =============================================================================
// 6. Dispatch
// =============================================================================

/**
 * Route a verified event to its handler.
 *
 * Anything not listed is acknowledged and ignored. Stripe sends a great deal
 * this platform has no opinion about, and answering 500 to those would make
 * Stripe retry them for three days apiece.
 */
async function processEvent(
  event: Stripe.Event,
  eventCreatedAt: Date
): Promise<HandlerOutcome> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event.data.object, eventCreatedAt)

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return handleSubscriptionChanged(event.data.object, eventCreatedAt)

    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
    case 'invoice.marked_uncollectible':
    case 'invoice.voided':
      return handleInvoiceChanged(event.data.object, eventCreatedAt)

    case 'payment_intent.succeeded':
    case 'payment_intent.processing':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      return handlePaymentIntentChanged(event.data.object, eventCreatedAt)

    case 'charge.refunded':
      return handleChargeRefunded(event.data.object, eventCreatedAt)

    default:
      return UNHANDLED
  }
}

// =============================================================================
// 7. Checkout
// =============================================================================

/**
 * A guest finished paying.
 *
 * Two effects, both idempotent:
 *
 *  1. **The subscription is written immediately** rather than waited for. The
 *     `customer.subscription.created` event will arrive too and would do the
 *     same upsert, but it may be seconds behind the browser redirect — and the
 *     page the guest lands on is the billing page. Retrieving the subscription
 *     here means it is already there when they arrive.
 *  2. **The invitation code, if one was carried, is redeemed.** The code was
 *     validated when the session was opened; this is where it becomes a
 *     `ReferralRedemption`, because until now no money had changed hands.
 *
 * A session whose `payment_status` is still `unpaid` — an asynchronous method
 * that has not settled — redeems nothing. `checkout.session.async_payment_
 * succeeded` is the event for that case, and this platform does not yet offer
 * such a method.
 */
async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  eventCreatedAt: Date
): Promise<HandlerOutcome> {
  const attribution = await resolveUserId({
    metadata: session.metadata,
    clientReferenceId: session.client_reference_id,
    customer: session.customer,
  })

  if (attribution.kind !== 'resolved') {
    return declineAttribution(
      attribution,
      `checkout.session.completed ${session.id}`
    )
  }

  const userId = attribution.userId

  const subscriptionId = stripeIdOf(session.subscription)

  if (subscriptionId !== null) {
    const subscription =
      await getStripe().subscriptions.retrieve(subscriptionId)

    await handleSubscriptionChanged(subscription, eventCreatedAt)
  }

  const referralCodeId = session.metadata?.['mannachefReferralCodeId']

  if (
    referralCodeId !== undefined &&
    referralCodeId.length > 0 &&
    session.payment_status !== 'unpaid'
  ) {
    await recordReferralRedemption(referralCodeId, userId)
  }

  return HANDLED
}

/**
 * Turn a validated invitation code into a `ReferralRedemption`.
 *
 * Idempotent twice over: {@link resolveRedemptionEligibility} refuses with
 * `ALREADY_USED` when the redemption already exists, and
 * `@@unique([referralCodeId, referredUserId])` catches the concurrent case,
 * which is swallowed because a duplicate here means the work is already done.
 *
 * Only the redemption and the code's counter are written. Crediting the reward
 * — `RewardBalance`, `RewardLedgerEntry` — belongs to the referral domain,
 * which owns the append-only ledger and the compensating-entry rules; writing
 * a balance from here would fork that authority.
 *
 * ## One definition of a valid redemption (MCV-041, finding F)
 *
 * This handler used to carry its own. It checked four things — the code exists
 * and is live, it has not expired, it is not full, and it is not the redeemer's
 * own — and then wrote the row. It did **not** check `sharesEmailIdentity` or
 * the one-live-redemption rule, both of which `redeemReferralCode` refuses on,
 * so an inviter who signed a second account up under a plus-addressed alias of
 * their own inbox was turned away by the portal form and let through here. A
 * predicate with two implementations has two meanings, and the weaker one is
 * the one that decides. There is now one, in `@/server/referral-eligibility`,
 * and this function contributes nothing to it.
 *
 * The heuristic is applied with no escape hatch, unlike `redeemReferralCode`'s
 * `ADMIN` bypass: there is no operator on this path to exercise judgement, only
 * Stripe. A household wrongly caught by it asks the concierge, who has the
 * bypass.
 *
 * ## Why `PENDING` and not `QUALIFIED`
 *
 * Because a paid Checkout session is not a qualification. The row written here
 * used to be `QUALIFIED`, stamped `qualifiedAt: new Date()` and carrying the
 * code's `rewardValueCents` as `rewardCents`, without consulting
 * `findQualifyingInvoice` or the programme's `minimumQualifyingInvoiceCents`
 * floor — the two things that decide whether a referral has been earned, and
 * the whole of what MCV-030 put in place. It escaped being a payout only
 * because the settlement sweep walks `PENDING` and never looked at these rows.
 * That is a filter in one query standing between a webhook and the ledger, and
 * it is not where this platform's rules are supposed to live.
 *
 * So the webhook writes what every other path writes: `PENDING`, no
 * `qualifiedAt`, no `rewardCents`. The sweep applies the floor and moves it on.
 */
async function recordReferralRedemption(
  referralCodeId: string,
  referredUserId: string
): Promise<void> {
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const eligibility = await resolveRedemptionEligibility(
        tx,
        { kind: 'id', referralCodeId },
        referredUserId,
        { applyHouseholdHeuristic: true }
      )

      if (eligibility.kind === 'refused') {
        return { kind: 'refused' as const, reason: eligibility.reason }
      }

      return createReferralRedemption(tx, eligibility.code, referredUserId)
    })

    if (outcome.kind === 'refused') {
      // Not an error, and not a retry: the code was checked when the session
      // was opened and something about it has changed since, or it was never
      // eligible for this household. The reason is a rule name, not a payload.
      console.info(
        `[stripe-webhook] referral code ${referralCodeId} not redeemable for user ${referredUserId} (${outcome.reason}); no redemption written.`
      )

      return
    }

    if (outcome.kind === 'raced') {
      // The counter moved under us, so somebody else took the seat. The
      // transaction rolled the row back; throwing leaves `processedAt` null so
      // Stripe's redelivery runs the whole check again against fresh rows,
      // which is the only way this resolves correctly.
      throw new Error(
        `[stripe-webhook] referral code ${referralCodeId} was taken concurrently; redemption for user ${referredUserId} will be retried.`
      )
    }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // Two deliveries raced. The redemption exists, which is the outcome.
      return
    }

    throw error
  }
}

// =============================================================================
// 8. Subscriptions
// =============================================================================

/**
 * Mirror a Stripe subscription onto `UserSubscription`.
 *
 * Serves `created`, `updated`, `deleted`, `paused` and `resumed` alike, because
 * all five carry a complete subscription object and the correct response to
 * every one of them is "make our row say what Stripe says".
 *
 * ## Two ordering guards
 *
 *  1. `current_period_start` going **backwards** is decisive: an event
 *     describing an earlier billing period is describing the past, whatever its
 *     timestamp says. This is exact, because Stripe advances the field
 *     monotonically.
 *  2. {@link isStaleAgainst} on `event.created` catches the within-period case
 *     — a retried `updated` arriving after a newer one.
 *
 * ## Two linkages that can fail
 *
 * The plan is resolved from the price on the subscription's first item; the
 * user from the metadata, the customer, or an existing row. Either failing is a
 * skip rather than an error: a subscription created directly in the Stripe
 * dashboard on a price we do not sell has nothing to attach to, and retrying it
 * for three days will not change that. Both are logged with ids.
 */
async function handleSubscriptionChanged(
  subscription: Stripe.Subscription,
  eventCreatedAt: Date
): Promise<HandlerOutcome> {
  const existing = await prisma.userSubscription.findUnique({
    where: { stripeSubscriptionId: subscription.id },
    select: {
      id: true,
      userId: true,
      planId: true,
      updatedAt: true,
      currentPeriodStart: true,
    },
  })

  const currentPeriodStart = new Date(subscription.current_period_start * 1000)

  if (existing !== null) {
    if (currentPeriodStart.getTime() < existing.currentPeriodStart.getTime()) {
      return skipped('older-billing-period')
    }

    if (isStaleAgainst(eventCreatedAt, existing.updatedAt)) {
      return skipped('stale-event')
    }
  }

  const planId = await resolvePlanId(subscription, existing?.planId ?? null)

  if (planId === null) {
    console.error(
      `[stripe-webhook] subscription ${subscription.id}: no SubscriptionPlan matches its price.`
    )

    return skipped('unknown-plan')
  }

  const attribution =
    existing === null
      ? await resolveUserId({
          metadata: subscription.metadata,
          customer: subscription.customer,
        })
      : attributed(existing.userId)

  if (attribution.kind !== 'resolved') {
    return declineAttribution(attribution, `subscription ${subscription.id}`)
  }

  const userId = attribution.userId

  const customerId = stripeIdOf(subscription.customer)

  if (customerId === null) {
    console.error(
      `[stripe-webhook] subscription ${subscription.id}: no customer on the object.`
    )

    return skipped('unknown-customer')
  }

  const item = subscription.items.data[0]
  const status = subscriptionStatusFor(subscription)

  // A `deleted` event always carries `canceled_at`, but Stripe has been known
  // to omit `ended_at` on subscriptions cancelled from the dashboard. Falling
  // back to the event's own clock keeps the column honest without inventing a
  // moment out of nothing.
  const endedAt =
    fromUnixSeconds(subscription.ended_at) ??
    (status === 'CANCELED' ? eventCreatedAt : null)

  const shared = {
    planId,
    status,
    quantity: item?.quantity ?? 1,
    currency: subscription.currency.toUpperCase(),
    currentPeriodStart,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: fromUnixSeconds(subscription.cancel_at),
    canceledAt: fromUnixSeconds(subscription.canceled_at),
    endedAt,
    trialEndsAt: fromUnixSeconds(subscription.trial_end),
    pausedUntil: fromUnixSeconds(
      subscription.pause_collection?.resumes_at ?? null
    ),
  } satisfies Prisma.UserSubscriptionUncheckedUpdateInput

  await prisma.userSubscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    create: {
      ...shared,
      userId,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId,
      startedAt: new Date(subscription.created * 1000),
    },
    // `userId`, `stripeCustomerId` and `startedAt` are deliberately not
    // updated: the payer and the moment the relationship began do not change,
    // and re-writing them from a late event is how a subscription ends up
    // attached to the wrong household.
    update: shared,
  })

  return HANDLED
}

/**
 * Which of our plans this subscription is sold on.
 *
 * Matched on `stripePriceId`, which is unique on `SubscriptionPlan`. Falls back
 * to the plan already recorded, so a price archived in Stripe after a
 * subscriber joined does not detach them from their plan.
 */
async function resolvePlanId(
  subscription: Stripe.Subscription,
  fallbackPlanId: string | null
): Promise<string | null> {
  const priceId = subscription.items.data[0]?.price.id

  if (priceId !== undefined) {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { stripePriceId: priceId },
      select: { id: true },
    })

    if (plan !== null) {
      return plan.id
    }
  }

  return fallbackPlanId
}

// =============================================================================
// 9. Invoices
// =============================================================================

/**
 * Mirror a Stripe invoice onto `Invoice`.
 *
 * Serves the whole invoice lifecycle, `payment_succeeded` and `payment_failed`
 * included, because each carries the complete invoice and the right response to
 * all of them is the same upsert. The status comes from the object rather than
 * from the event name: `invoice.payment_failed` leaves an invoice `open`, and
 * inferring `UNCOLLECTIBLE` from the event name would be wrong.
 *
 * `isManual` is set to `false` on insert and **never touched on update**: a
 * bespoke invoice raised by `createManualInvoice` and later pushed to Stripe
 * must not lose the flag that says a person wrote it.
 *
 * The human-facing `number` is unique across the whole table, and Stripe's
 * numbering scheme is not aware of the house one. A collision with a
 * hand-written `MC-2026-0148` would fail the upsert, so it is checked for and
 * the Stripe number dropped rather than the event failing — the Stripe id
 * remains the authoritative reference either way.
 */
async function handleInvoiceChanged(
  invoice: Stripe.Invoice,
  eventCreatedAt: Date
): Promise<HandlerOutcome> {
  const existing = await prisma.invoice.findUnique({
    where: { stripeInvoiceId: invoice.id },
    select: { id: true, userId: true, updatedAt: true },
  })

  if (existing !== null && isStaleAgainst(eventCreatedAt, existing.updatedAt)) {
    return skipped('stale-event')
  }

  const attribution =
    existing === null
      ? await resolveUserId({
          metadata: invoice.metadata,
          customer: invoice.customer,
        })
      : attributed(existing.userId)

  if (attribution.kind !== 'resolved') {
    return declineAttribution(attribution, `invoice ${invoice.id}`)
  }

  const userId = attribution.userId

  const subscriptionId = await resolveLocalSubscriptionId(invoice.subscription)
  const number = await resolveInvoiceNumber(invoice)

  const discountCents = (invoice.total_discount_amounts ?? []).reduce(
    (total, entry) => total + entry.amount,
    0
  )

  const shared = {
    status: invoiceStatusFor(invoice),
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    amountRemainingCents: invoice.amount_remaining,
    subtotalCents: invoice.subtotal,
    taxCents: invoice.tax ?? 0,
    discountCents,
    currency: invoice.currency.toUpperCase(),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
    description: invoice.description,
    number,
    subscriptionId,
    issuedAt: fromUnixSeconds(invoice.status_transitions.finalized_at),
    dueAt: fromUnixSeconds(invoice.due_date),
    paidAt: fromUnixSeconds(invoice.status_transitions.paid_at),
    voidedAt: fromUnixSeconds(invoice.status_transitions.voided_at),
  } satisfies Prisma.InvoiceUncheckedUpdateInput

  await prisma.invoice.upsert({
    where: { stripeInvoiceId: invoice.id },
    create: {
      ...shared,
      userId,
      stripeInvoiceId: invoice.id,
      isManual: false,
    },
    update: shared,
  })

  return HANDLED
}

/** Our `UserSubscription` id for the Stripe subscription an invoice names. */
async function resolveLocalSubscriptionId(
  subscription: string | Stripe.Subscription | null
): Promise<string | null> {
  const stripeSubscriptionId = stripeIdOf(subscription)

  if (stripeSubscriptionId === null) {
    return null
  }

  const row = await prisma.userSubscription.findUnique({
    where: { stripeSubscriptionId },
    select: { id: true },
  })

  return row?.id ?? null
}

/**
 * The invoice number to store, or `null` when the house sequence already owns
 * it. See the note on collisions in {@link handleInvoiceChanged}.
 */
async function resolveInvoiceNumber(
  invoice: Stripe.Invoice
): Promise<string | null> {
  if (invoice.number === null || invoice.number.length === 0) {
    return null
  }

  const clash = await prisma.invoice.findUnique({
    where: { number: invoice.number },
    select: { stripeInvoiceId: true },
  })

  if (clash === null || clash.stripeInvoiceId === invoice.id) {
    return invoice.number
  }

  console.error(
    `[stripe-webhook] invoice ${invoice.id}: number ${invoice.number} is already held by another invoice; storing without it.`
  )

  return null
}

// =============================================================================
// 10. Payments
// =============================================================================

/**
 * Mirror a Stripe payment intent onto `PaymentHistory`.
 *
 * ## Refund state is never clobbered
 *
 * `refundedCents` is written only on insert. `charge.refunded` owns that column
 * afterwards, and a `payment_intent.succeeded` arriving late must not reset a
 * refund to zero or move a `REFUNDED` row back to `SUCCEEDED` — so a row that
 * already carries a refund keeps the refund-derived status.
 *
 * ## Card details cost one extra call, and only on success
 *
 * `latest_charge` arrives as a bare id. The brand, the last four digits and the
 * receipt URL live on the charge, and `@mannachef/api-contract` exposes all
 * three — a client quoting a receipt is the fastest route through a support
 * conversation. The charge is therefore retrieved, but only for a payment that
 * actually succeeded, and a retrieval that fails degrades to `null` columns
 * rather than failing the whole event. Nothing beyond the brand and the last
 * four is ever stored (`CONTRACT.md` §5).
 */
async function handlePaymentIntentChanged(
  intent: Stripe.PaymentIntent,
  eventCreatedAt: Date
): Promise<HandlerOutcome> {
  const existing = await prisma.paymentHistory.findUnique({
    where: { stripePaymentIntentId: intent.id },
    select: {
      id: true,
      userId: true,
      updatedAt: true,
      refundedCents: true,
    },
  })

  if (existing !== null && isStaleAgainst(eventCreatedAt, existing.updatedAt)) {
    return skipped('stale-event')
  }

  const attribution =
    existing === null
      ? await resolveUserId({
          metadata: intent.metadata,
          customer: intent.customer,
        })
      : attributed(existing.userId)

  if (attribution.kind !== 'resolved') {
    return declineAttribution(attribution, `payment_intent ${intent.id}`)
  }

  const userId = attribution.userId

  const charge =
    intent.status === 'succeeded'
      ? await loadCharge(intent.latest_charge)
      : typeof intent.latest_charge === 'object'
        ? intent.latest_charge
        : null

  const card = charge?.payment_method_details?.card ?? null

  const invoiceId = await resolveLocalInvoiceId(intent.invoice)
  const subscriptionId =
    invoiceId === null ? null : await subscriptionIdForInvoice(invoiceId)

  // A refunded row keeps its refund-derived status; otherwise Stripe's own.
  const status: PaymentStatus =
    existing !== null && existing.refundedCents > 0
      ? paymentStatusAfterRefund(intent.amount, existing.refundedCents)
      : paymentStatusFor(intent.status)

  const processedAt =
    intent.status === 'succeeded'
      ? (fromUnixSeconds(charge?.created) ?? eventCreatedAt)
      : null

  const shared = {
    invoiceId,
    subscriptionId,
    stripeChargeId: stripeIdOf(intent.latest_charge),
    amountCents: intent.amount,
    feeCents: null,
    currency: intent.currency.toUpperCase(),
    status,
    method: paymentMethodFor(charge),
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    failureCode: intent.last_payment_error?.code ?? null,
    failureReason: intent.last_payment_error?.message ?? null,
    receiptUrl: charge?.receipt_url ?? null,
    processedAt,
  } satisfies Prisma.PaymentHistoryUncheckedUpdateInput

  await prisma.paymentHistory.upsert({
    where: { stripePaymentIntentId: intent.id },
    create: {
      ...shared,
      userId,
      stripePaymentIntentId: intent.id,
      refundedCents: 0,
    },
    // `refundedCents` is absent on purpose — see the docblock.
    update: shared,
  })

  return HANDLED
}

/**
 * The charge behind a payment intent, or `null`.
 *
 * A retrieval failure is swallowed: the receipt URL and the card brand are
 * conveniences, and losing them must not cost us the record that the money
 * moved. The reason is logged without the payload.
 */
async function loadCharge(
  latestCharge: string | Stripe.Charge | null
): Promise<Stripe.Charge | null> {
  if (latestCharge === null) {
    return null
  }

  if (typeof latestCharge !== 'string') {
    return latestCharge
  }

  try {
    return await getStripe().charges.retrieve(latestCharge)
  } catch (error) {
    console.error(
      `[stripe-webhook] could not retrieve charge ${latestCharge}`,
      { reason: summariseError(error) }
    )

    return null
  }
}

async function resolveLocalInvoiceId(
  invoice: string | Stripe.Invoice | null
): Promise<string | null> {
  const stripeInvoiceId = stripeIdOf(invoice)

  if (stripeInvoiceId === null) {
    return null
  }

  const row = await prisma.invoice.findUnique({
    where: { stripeInvoiceId },
    select: { id: true },
  })

  return row?.id ?? null
}

async function subscriptionIdForInvoice(
  invoiceId: string
): Promise<string | null> {
  const row = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { subscriptionId: true },
  })

  return row?.subscriptionId ?? null
}

/**
 * Money went back.
 *
 * ## Cumulative, and therefore monotonic
 *
 * `charge.amount_refunded` is the running total of everything refunded on that
 * charge, not the increment. That makes it a perfect ordering guard in its own
 * right: an event carrying a **smaller** total than the one already stored is
 * describing an earlier refund and is dropped, whatever its timestamp says.
 * Two partial refunds delivered out of order therefore settle on the larger
 * figure rather than on whichever arrived last.
 *
 * `paymentStatusAfterRefund` decides between `PARTIALLY_REFUNDED` and
 * `REFUNDED`; it lives in `@mannachef/validators` beside the enum rather than
 * being restated here.
 *
 * A refund for a charge we have no row for is written as a new
 * `PaymentHistory` when the payer can be resolved — a charge taken outside this
 * platform and refunded through the dashboard still belongs in the ledger.
 */
async function handleChargeRefunded(
  charge: Stripe.Charge,
  eventCreatedAt: Date
): Promise<HandlerOutcome> {
  const paymentIntentId = stripeIdOf(charge.payment_intent)

  const existing =
    paymentIntentId === null
      ? await prisma.paymentHistory.findFirst({
          where: { stripeChargeId: charge.id },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            userId: true,
            amountCents: true,
            refundedCents: true,
          },
        })
      : await prisma.paymentHistory.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: {
            id: true,
            userId: true,
            amountCents: true,
            refundedCents: true,
          },
        })

  const refundedCents = charge.amount_refunded

  if (existing !== null) {
    if (refundedCents <= existing.refundedCents) {
      return skipped('refund-already-recorded')
    }

    await prisma.paymentHistory.update({
      where: { id: existing.id },
      data: {
        refundedCents,
        status: paymentStatusAfterRefund(existing.amountCents, refundedCents),
        refundedAt: eventCreatedAt,
        stripeChargeId: charge.id,
        receiptUrl: charge.receipt_url ?? null,
      },
    })

    return HANDLED
  }

  const attribution = await resolveUserId({
    metadata: charge.metadata,
    customer: charge.customer,
  })

  if (attribution.kind !== 'resolved') {
    return declineAttribution(attribution, `charge ${charge.id} (refunded)`)
  }

  const userId = attribution.userId

  const card = charge.payment_method_details?.card ?? null

  await prisma.paymentHistory.create({
    data: {
      userId,
      ...(paymentIntentId !== null
        ? { stripePaymentIntentId: paymentIntentId }
        : {}),
      stripeChargeId: charge.id,
      amountCents: charge.amount,
      refundedCents,
      currency: charge.currency.toUpperCase(),
      status: paymentStatusAfterRefund(charge.amount, refundedCents),
      method: paymentMethodFor(charge),
      cardBrand: card?.brand ?? null,
      cardLast4: card?.last4 ?? null,
      receiptUrl: charge.receipt_url ?? null,
      processedAt: new Date(charge.created * 1000),
      refundedAt: eventCreatedAt,
    },
  })

  return HANDLED
}
