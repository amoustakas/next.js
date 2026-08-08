// mannachef/apps/web/src/server/referral-eligibility.ts

/**
 * What makes a referral redemption valid, said once (MCV-041, finding F).
 *
 * ## Why this module exists
 *
 * Three call sites decide whether an invitation code may be accepted, and until
 * this file they each decided it differently:
 *
 *  1. `redeemReferralCode` in `actions/referral.ts` — the portal's "I was
 *     invited" form. Applied all seven rules.
 *  2. `resolveReferralCode` in `actions/billing.ts` — the pre-flight check that
 *     runs while a Checkout session is being opened, so that a bad code is
 *     reported on the form rather than swallowed by Stripe. Applied five, and
 *     omitted the two that make a *household* heuristic: {@link
 *     sharesEmailIdentity} and the one-live-redemption rule.
 *  3. `recordReferralRedemption` in `api/webhooks/stripe/route.ts` — where the
 *     redemption is actually written, once money has moved. Applied four, and
 *     wrote `QUALIFIED` on the spot.
 *
 * So an inviter could sign a second account up under a plus-addressed alias of
 * their own inbox, pay through Checkout, and have the redemption written by a
 * path that never consulted the heuristic the portal form would have refused
 * them on. The checkout route was, in effect, a second definition of "valid
 * redemption" with the household checks missing from it.
 *
 * Two divergent definitions of the same predicate is the defect regardless of
 * whether today's sweep happens to pay it out. This module is the one
 * definition; the three call sites are entry points to it and add nothing.
 *
 * ## Why it is not in `actions/`
 *
 * A `'use server'` module may only export async functions, so nothing in
 * `actions/referral.ts` could have published this to `actions/billing.ts`, and
 * the webhook route is not an action module at all. Same reasoning, and the
 * same shelf, as `@/server/referral-program` and `@/server/scheduling`: the
 * rule lives in an ordinary server module and the actions are the thin
 * authorised entry points to it.
 *
 * ## What this module does not decide
 *
 * Whether a referral has been **earned**. Eligibility is about accepting an
 * invitation; qualification is about a paid invoice clearing the programme's
 * floor, and that lives with `findQualifyingInvoice` and the settlement sweep
 * in `actions/referral.ts`. {@link createReferralRedemption} therefore writes
 * `PENDING` and nothing else — no `qualifiedAt`, no `rewardCents` — from every
 * path, including the webhook, which used to write `QUALIFIED` with a
 * `qualifiedAt` of "now" and had consulted neither the invoice nor the floor.
 * Crediting at signup is how a referral programme becomes a faucet, and
 * stamping `QUALIFIED` at signup is the same faucet one status further along.
 *
 * ## What this module *does* decide, since MCV-051
 *
 * Whether the household is one a referral can acquire at all. That is an
 * eligibility question and it belongs here, but it is asked against the same
 * moment qualification is later measured from, so the two rules are duals rather
 * than two opinions:
 *
 *  - here, at acceptance: a household that had *already* paid us before
 *    {@link RedemptionEligibilityOptions.establishedAt} is refused with
 *    `ALREADY_A_CUSTOMER`, unless the standing offer says a win-back is the
 *    point (`ReferralProgram.allowExistingCustomerReferral`, off by default);
 *  - later, at settlement: `findQualifyingInvoice` will not look at an invoice
 *    paid before that same moment, which
 *    {@link createReferralRedemption} persists as
 *    `ReferralRedemption.qualifyingFromAt`.
 *
 * Neither rule existed before MCV-051, and their absence was one finding rather
 * than two: an ACTIVE_SUBSCRIBER of two years' standing could accept an
 * invitation minted this morning, and the settlement sweep — searching the whole
 * of their billing history with no lower bound and taking the *earliest*
 * qualifying invoice — would settle it against a bill paid long before the code
 * existed. The reward was real money and the revenue behind it was money the
 * house had already booked. Two existing customers redeeming each other's codes
 * were both paid; the customer base could be farmed once each.
 */

import { sharesEmailIdentity } from '@mannachef/validators'
import type { ReferralRedemptionStatus } from '@mannachef/validators'

import { Prisma } from '@/server/db'
import { readExistingCustomerReferralAllowed } from '@/server/referral-program'

// =============================================================================
// 1. The rules, as values
// =============================================================================

/**
 * Redemptions that still occupy the "you have already been referred" slot.
 *
 * `REVOKED` is absent on purpose: a redemption taken back after an abuse review
 * has released the household, and a genuine invitation accepted afterwards
 * should not be refused because of it.
 */
export const LIVE_REDEMPTION_STATUSES = [
  'PENDING',
  'QUALIFIED',
  'REWARDED',
] as const satisfies readonly ReferralRedemptionStatus[]

/** Every way an invitation can be refused. */
export type RedemptionRefusal =
  /** No such account, or the account has been deactivated. */
  | 'NO_ACCOUNT'
  /** No such code, or it has been withdrawn. */
  | 'UNKNOWN_CODE'
  | 'EXPIRED'
  | 'FULLY_REDEEMED'
  /** The code belongs to the person redeeming it. */
  | 'OWN_CODE'
  /** The owner's address and the guest's reduce to one likely mailbox. */
  | 'SAME_HOUSEHOLD'
  /** This guest has already redeemed this same code. */
  | 'ALREADY_USED'
  /** This guest already has a live redemption of some other code. */
  | 'ALREADY_REFERRED'
  /**
   * This household had already paid us before the invitation was accepted, and
   * the standing offer does not reward a win-back (MCV-051).
   */
  | 'ALREADY_A_CUSTOMER'

/**
 * What a guest is told, and how the failure is classified.
 *
 * The message is written for the person who typed the code, so it never
 * distinguishes "no such code" from "withdrawn" — knowing which would turn the
 * form into an oracle over the code space. `NO_ACCOUNT` is the one refusal that
 * is not about the code, so it is the one that is not a `VALIDATION`.
 */
export interface RedemptionRefusalTerms {
  readonly code: 'VALIDATION' | 'NOT_FOUND'
  readonly message: string
}

export const REDEMPTION_REFUSALS: Readonly<
  Record<RedemptionRefusal, RedemptionRefusalTerms>
> = {
  NO_ACCOUNT: {
    code: 'NOT_FOUND',
    message: 'We could not find that account.',
  },
  UNKNOWN_CODE: {
    code: 'VALIDATION',
    message: 'That invitation code is not one we recognise.',
  },
  EXPIRED: {
    code: 'VALIDATION',
    message: 'That invitation code has expired.',
  },
  FULLY_REDEEMED: {
    code: 'VALIDATION',
    message: 'That invitation code has already been fully redeemed.',
  },
  OWN_CODE: {
    code: 'VALIDATION',
    message: 'An invitation code cannot be redeemed by its own owner.',
  },
  SAME_HOUSEHOLD: {
    code: 'VALIDATION',
    message:
      'That invitation appears to have been issued to this same household.',
  },
  ALREADY_USED: {
    code: 'VALIDATION',
    message: 'You have already used that invitation code.',
  },
  ALREADY_REFERRED: {
    code: 'VALIDATION',
    message: 'An invitation has already been accepted on this account.',
  },
  ALREADY_A_CUSTOMER: {
    code: 'VALIDATION',
    message:
      'Invitations are for households new to us, and this account has already ordered with us.',
  },
}

// =============================================================================
// 2. The predicate
// =============================================================================

/** The columns every eligibility rule and every caller's receipt needs. */
export const ELIGIBILITY_CODE_SELECT = {
  id: true,
  code: true,
  ownerId: true,
  isActive: true,
  expiresAt: true,
  maxRedemptions: true,
  redemptionCount: true,
  refereeRewardCents: true,
  currency: true,
} satisfies Prisma.ReferralCodeSelect

export type EligibleReferralCode = Prisma.ReferralCodeGetPayload<{
  select: typeof ELIGIBILITY_CODE_SELECT
}>

/** How the code was named: by the string a guest typed, or by its row id. */
export type ReferralCodeRef =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'id'; readonly referralCodeId: string }

export interface RedemptionEligibilityOptions {
  /**
   * `false` skips {@link sharesEmailIdentity} only.
   *
   * The escape hatch for `ADMIN` and above, who are the people to overrule a
   * heuristic that is simply wrong about two members of one household. It is
   * deliberately the *only* rule privilege can switch off, and it is
   * deliberately not defaulted: an unprivileged path that forgot to pass it
   * would otherwise silently become the checkout route again.
   *
   * Note what it is not: an escape hatch for `ALREADY_A_CUSTOMER`. That rule is
   * about the *offer*, not about a guess at who somebody is, so the only thing
   * that switches it off is the offer saying so —
   * `ReferralProgram.allowExistingCustomerReferral`. An administrator who wants
   * to pay an inviter for a household that was already ours has
   * `recordRewardAdjustment`, which is `SUPER_ADMIN` and requires a note.
   */
  readonly applyHouseholdHeuristic: boolean
  /**
   * The moment this invitation was accepted (MCV-051).
   *
   * Two things are measured against it and they have to be the same instant, or
   * the rule that admits a household and the rule that pays it would be
   * answering slightly different questions:
   *
   *  - `ALREADY_A_CUSTOMER` below asks whether anything was paid *before* it;
   *  - {@link createReferralRedemption} persists it as
   *    `ReferralRedemption.qualifyingFromAt`, and `findQualifyingInvoice` will
   *    later look at nothing paid before it.
   *
   * It is usually simply `new Date()`, and it is required rather than defaulted
   * to one because the two paths where it is *not* now are the two that matter.
   * The Stripe webhook writes the redemption after the payment it is reacting
   * to, racing the `invoice.paid` delivery that records that payment, so its
   * anchor is the moment the Checkout session was opened. The MCV-050 claim
   * settlement writes it at the first proved sign-in, so its anchor is when the
   * code was typed into the enquiry form. A `new Date()` default would have
   * quietly given both of them the wrong instant, and the Checkout one would
   * have refused the ordinary new-customer referral about half the time.
   *
   * An anchor earlier than the truth widens what may qualify, so it is the
   * direction that costs money; `createReferralRedemption` clamps how far back
   * it may reach, and the database restates that bound.
   */
  readonly establishedAt: Date
}

/**
 * An invitation this household may accept, and the moment it was accepted.
 *
 * The anchor travels with the verdict rather than being passed to the writer
 * separately, so the row {@link createReferralRedemption} writes is anchored to
 * the same instant the predicate judged it against. Handing the writer its own
 * copy would be two statements of one fact, which is the shape this whole module
 * exists to remove.
 */
export interface EligibleRedemption {
  readonly kind: 'eligible'
  readonly code: EligibleReferralCode
  readonly qualifyingFromAt: Date
}

export type RedemptionEligibility =
  | EligibleRedemption
  | { readonly kind: 'refused'; readonly reason: RedemptionRefusal }

/**
 * May `referredUserId` accept this invitation?
 *
 * Every rule is decided inside the caller's transaction against freshly-read
 * rows — the code is a string a browser sent, not a permission — and the rules
 * are checked in the order a guest would find most useful: the account, then
 * the code's own validity, then the relationship between the two.
 *
 * The household heuristic is a **deterrent and not a proof**. It reduces both
 * addresses to a likely mailbox, which has false positives by construction and
 * is defeated outright by a second real address. Nothing downstream may read
 * its silence as evidence that a referral was earned; the control point remains
 * an administrator, who chooses whether to run the settlement sweep and can
 * `REVOKE` with `reverseLedgerEntry` afterwards. What it does buy is that the
 * five-second version of a self-referral is refused on **every** path, which
 * before this function it was not.
 */
export async function resolveRedemptionEligibility(
  tx: Prisma.TransactionClient,
  ref: ReferralCodeRef,
  referredUserId: string,
  options: RedemptionEligibilityOptions
): Promise<RedemptionEligibility> {
  const refused = (
    reason: RedemptionRefusal
  ): { kind: 'refused'; reason: RedemptionRefusal } => ({
    kind: 'refused',
    reason,
  })

  const account = await tx.user.findUnique({
    where: { id: referredUserId },
    select: { id: true, isActive: true, email: true },
  })

  if (account === null || !account.isActive) {
    return refused('NO_ACCOUNT')
  }

  const code = await tx.referralCode.findUnique({
    where:
      ref.kind === 'code' ? { code: ref.code } : { id: ref.referralCodeId },
    select: ELIGIBILITY_CODE_SELECT,
  })

  if (code === null || !code.isActive) {
    return refused('UNKNOWN_CODE')
  }

  if (code.expiresAt !== null && code.expiresAt.getTime() <= Date.now()) {
    return refused('EXPIRED')
  }

  if (
    code.maxRedemptions !== null &&
    code.redemptionCount >= code.maxRedemptions
  ) {
    return refused('FULLY_REDEEMED')
  }

  if (code.ownerId === account.id) {
    return refused('OWN_CODE')
  }

  // The identity check above catches one account redeeming its own code. It
  // does not catch the five-second version of the same thing: mint a code, sign
  // a second account up with a plus-addressed alias of the same inbox, redeem
  // it there.
  if (options.applyHouseholdHeuristic) {
    const owner = await tx.user.findUnique({
      where: { id: code.ownerId },
      select: { email: true },
    })

    if (sharesEmailIdentity(owner?.email, account.email)) {
      return refused('SAME_HOUSEHOLD')
    }
  }

  const sameCode = await tx.referralRedemption.findUnique({
    where: {
      referralCodeId_referredUserId: {
        referralCodeId: code.id,
        referredUserId: account.id,
      },
    },
    select: { id: true },
  })

  if (sameCode !== null) {
    return refused('ALREADY_USED')
  }

  const anyLive = await tx.referralRedemption.findFirst({
    where: {
      referredUserId: account.id,
      status: { in: [...LIVE_REDEMPTION_STATUSES] },
    },
    select: { id: true },
  })

  if (anyLive !== null) {
    return refused('ALREADY_REFERRED')
  }

  // Last, and last on purpose. It is the only rule that reads a table other
  // than the three this predicate is about, and the only one whose answer
  // depends on the standing offer rather than on the code, so a guest reaches
  // it having already been told anything simpler that was wrong. It is also the
  // one rule below that the *pre-flight* in `actions/billing.ts` and the webhook
  // must agree on across a payment — see `establishedAt`.
  if (await hasPriorCustom(tx, account.id, options.establishedAt)) {
    if (!(await readExistingCustomerReferralAllowed(tx))) {
      return refused('ALREADY_A_CUSTOMER')
    }
  }

  return {
    kind: 'eligible',
    code,
    qualifyingFromAt: options.establishedAt,
  }
}

/**
 * Had this household paid us anything before `before`?
 *
 * The same three conditions `findQualifyingInvoice` calls a real payment —
 * `status = 'PAID'`, a stamped `paidAt`, and a non-zero `amountPaidCents` —
 * because the two functions have to agree about what an invoice is or the pair
 * of rules stops being a pair. `paidAt < before` implies the column is not null,
 * so the `not: null` the sibling query carries would be noise here.
 *
 * `amountPaidCents > 0` is load-bearing rather than tidy. Stripe issues a
 * genuine `paid` invoice for `0` at a trial start and for a fully discounted
 * bill, and a household holding one of those has paid us nothing at all: they
 * are exactly the new customer a referral is for, and counting that invoice as
 * prior custom would refuse the ordinary case in the name of the hostile one.
 */
async function hasPriorCustom(
  tx: Prisma.TransactionClient,
  userId: string,
  before: Date
): Promise<boolean> {
  const paid = await tx.invoice.findFirst({
    where: {
      userId,
      status: 'PAID',
      paidAt: { lt: before },
      amountPaidCents: { gt: 0 },
    },
    select: { id: true },
  })

  return paid !== null
}

// =============================================================================
// 3. The write
// =============================================================================

export interface CreatedRedemption {
  readonly id: string
  readonly status: ReferralRedemptionStatus
  readonly currency: string
}

/**
 * What {@link createReferralRedemption} did.
 *
 * `raced` is not `created`, and it is not a duplicate either: it means the
 * code's counter moved under us, so somebody else took the seat this redemption
 * was counted into. The caller decides what that means — a portal form says
 * "please try again", a webhook lets the delivery be retried.
 */
export type RedemptionWriteOutcome =
  | { readonly kind: 'created'; readonly redemption: CreatedRedemption }
  | { readonly kind: 'raced' }

/**
 * How far before the redemption row its anchor may reach, in days (MCV-051).
 *
 * The three legitimate anchors precede the row by: nothing (the portal form),
 * up to 24 hours (a Stripe Checkout session, which is as long as one can stay
 * open), and up to `CLAIM_WINDOW_DAYS` (an MCV-050 claim typed into an enquiry
 * form and settled at the first proved sign-in). Thirty days covers all three
 * and is the figure `ReferralRedemption_qualifyingFromAt_floor_check` enforces.
 *
 * {@link clampAnchor} clamps to **twenty-nine**, one day inside the constraint,
 * because the constraint compares the anchor against `createdAt` — a `now()`
 * from the *database's* clock, evaluated a round trip after the application read
 * its own. A claim settled at the very edge of its window would otherwise be a
 * constraint violation rather than a redemption, decided by milliseconds of
 * skew. The day of slack is only reachable by an anchor that is already at the
 * outer limit of what any path produces.
 */
export const MAX_ANCHOR_LOOKBACK_DAYS = 30

const ANCHOR_CLAMP_DAYS = MAX_ANCHOR_LOOKBACK_DAYS - 1

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

/**
 * The anchor, brought forward if it reaches further back than a redemption's
 * anchor may.
 *
 * Only ever moves *forward*, which is the direction that refuses invoices
 * rather than admitting them — so a caller passing something absurd loses a
 * payout it may have been owed and can never gain one it was not. That
 * asymmetry is why this is a clamp and not a rejection: the alternative is
 * throwing out of the one writer every path funnels through, over a value no
 * guest supplied.
 */
function clampAnchor(anchor: Date, now: Date): Date {
  const floor = now.getTime() - ANCHOR_CLAMP_DAYS * MILLISECONDS_PER_DAY

  return anchor.getTime() < floor ? new Date(floor) : anchor
}

/**
 * Write the `PENDING` redemption and count it against the code.
 *
 * ## `PENDING`, from every path
 *
 * See the module docblock. A redemption becomes `QUALIFIED` when
 * `findQualifyingInvoice` finds a paid invoice clearing the programme's floor,
 * and the only things that may make that transition are the settlement sweep
 * and the two `SUPER_ADMIN` actions that also call it. `rewardCents` is left
 * null for the same reason: it is a *denormalised snapshot of the reward
 * actually paid out*, per the schema comment, and nothing has been paid out.
 *
 * ## `qualifyingFromAt`, from every path (MCV-051)
 *
 * It is taken from the verdict rather than from a separate argument, so the row
 * cannot be anchored to a moment other than the one the predicate measured
 * prior custom against. That pairing is the whole fix: `ALREADY_A_CUSTOMER`
 * refuses a household that had paid before this instant, and
 * `findQualifyingInvoice` refuses an invoice paid before it, so between them
 * every cent a referral is settled against arrived after the invitation did.
 *
 * ## The counter
 *
 * `redemptionCount` is bumped with `updateMany` guarded on its prior value — a
 * compare-and-swap. Two guests taking the last seat of a capped code therefore
 * produce one redemption and one `raced`; the loser's `create` is rolled back
 * with the caller's transaction, which is why this must be called inside one.
 */
export async function createReferralRedemption(
  tx: Prisma.TransactionClient,
  eligible: EligibleRedemption,
  referredUserId: string
): Promise<RedemptionWriteOutcome> {
  const { code } = eligible

  const created = await tx.referralRedemption.create({
    data: {
      referralCodeId: code.id,
      referredUserId,
      status: 'PENDING',
      currency: code.currency,
      qualifyingFromAt: clampAnchor(eligible.qualifyingFromAt, new Date()),
    },
    select: { id: true, status: true, currency: true },
  })

  const bumped = await tx.referralCode.updateMany({
    where: { id: code.id, redemptionCount: code.redemptionCount },
    data: { redemptionCount: { increment: 1 } },
  })

  if (bumped.count !== 1) {
    return { kind: 'raced' }
  }

  return { kind: 'created', redemption: created }
}
