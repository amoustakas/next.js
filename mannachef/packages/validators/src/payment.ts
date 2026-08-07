// mannachef/packages/validators/src/payment.ts

/**
 * Payment domain validation — the money that actually moved, as opposed to the
 * money we asked for.
 *
 * Mirrors `PaymentHistory` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * ## Why this file exists (MCV-005)
 *
 * `billing.ts` covers plans, subscriptions, invoices and the Stripe webhook
 * ledger, but stops at the invoice. `PaymentHistory` — the row that records a
 * charge succeeding, failing, or being handed back — had no schema at all, and
 * the audit noticed the consequence downstream: `paymentStatusSchema` and
 * `paymentMethodTypeSchema` were declared in `./enums`, mirrored faithfully
 * from Prisma, and then never imported by anything. Two dead exports are a
 * reliable sign that a table is being written to without validation.
 *
 * ## Rules that govern this file (see `mannachef/CONTRACT.md`)
 *
 *  1. No runtime dependency on `@prisma/client` — enums arrive from `./enums`.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *  3. Money bounds come from `./billing`, not from a second copy of the
 *     ceiling. `amountCentsSchema` and `chargeableAmountCentsSchema` are the
 *     money rules this application already agreed on, and a payment against an
 *     invoice must not be allowed to exceed what an invoice may say.
 *  4. Nothing here sets `refundedCents` on the way in. A payment is recorded at
 *     its full amount; the refunded portion is written only by
 *     {@link paymentRefundSchema}, which is the one payload that has a reason
 *     attached to it.
 *  5. `paymentFilterSchema` is reachable over GET, so every numeric and
 *     temporal bound goes through the coercion helpers in `./common`. The four
 *     write payloads stay strict.
 */

import { z } from 'zod'

import { amountCentsSchema, chargeableAmountCentsSchema } from './billing'
import {
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  crossField,
  crossFieldMixed,
  cuidSchema,
  currencySchema,
  hasUniqueValues,
  isNotInTheFuture,
  isoDateTimeSchema,
  optionalProse,
  paginationSchema,
  queryFlag,
  stripeIdSchema,
  urlSchema,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'
import {
  type PaymentStatus,
  paymentMethodTypeSchema,
  paymentStatusSchema,
} from './enums'

// =============================================================================
// Limits & patterns
// =============================================================================

/** Matches `PaymentHistory.cardBrand` — `@db.VarChar(40)`. */
const MAX_CARD_BRAND_LENGTH = 40

/** Matches `PaymentHistory.failureCode` — `@db.VarChar(120)`. */
export const MAX_FAILURE_CODE_LENGTH = 120

/** Generous ceiling for the `@db.Text` failure reason Stripe hands back. */
export const MAX_FAILURE_REASON_LENGTH = 2_000

/** A refund is never issued without an explanation this long at least. */
export const MIN_REFUND_REASON_LENGTH = 4

/** Generous ceiling for the reason recorded against a refund. */
export const MAX_REFUND_REASON_LENGTH = 2_000

/** Stripe payment-intent identifier: `pi_3PabcdEFGHijklMN`. */
const STRIPE_PAYMENT_INTENT_ID_PATTERN = /^pi_[A-Za-z0-9_]+$/

/**
 * Stripe charge identifier: `ch_3PabcdEFGHijklMN`.
 *
 * `py_` is accepted alongside `ch_` because Stripe mints that prefix for
 * charges settled outside the card rails, which is exactly what the `INTERAC`,
 * `ACH_DEBIT` and `BANK_TRANSFER` members of `paymentMethodTypeSchema` are for.
 */
const STRIPE_CHARGE_ID_PATTERN = /^(?:ch|py)_[A-Za-z0-9_]+$/

/** The last four digits printed on a card. */
const CARD_LAST4_PATTERN = /^\d{4}$/

/**
 * The statuses from which a refund is a coherent request.
 *
 * `PARTIALLY_REFUNDED` is here because a second partial refund is ordinary;
 * `REFUNDED` is not, because the whole amount is already back.
 */
export const REFUNDABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
]

/** Statuses no further movement is expected from. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'CANCELED',
  'FAILED',
  'REFUNDED',
]

/** True when a payment in this state may still be handed back. */
export function isRefundablePaymentStatus(status: PaymentStatus): boolean {
  return REFUNDABLE_PAYMENT_STATUSES.includes(status)
}

/** True when a payment in this state is finished moving. */
export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status)
}

// =============================================================================
// Field schemas
// =============================================================================

/**
 * The local `stripeReferenceSchema` is gone. It was byte-identical to
 * `billing.ts`'s `stripeIdSchema` — same trim, same blank check, same
 * `VarChar(255)` bound, same over-long message, same `.refine` — so MCV-010
 * hoisted the single definition into `./common` under the `stripeIdSchema`
 * name and both modules now import it. `MAX_STRIPE_ID_LENGTH` moved with it,
 * since bounding that helper was its only use here.
 *
 * The `pi_` and `ch_`/`py_` patterns above stay: they are facts about
 * `PaymentHistory`, not shared vocabulary.
 */

/** `PaymentHistory.stripePaymentIntentId` — `@unique`, so idempotency hangs on it. */
export const stripePaymentIntentIdSchema = stripeIdSchema(
  STRIPE_PAYMENT_INTENT_ID_PATTERN,
  'Please provide the Stripe payment reference.',
  'A Stripe payment reference begins with pi_ — copy it from the Stripe dashboard.'
)
export type StripePaymentIntentId = z.infer<typeof stripePaymentIntentIdSchema>

/** `PaymentHistory.stripeChargeId`. */
export const stripeChargeIdSchema = stripeIdSchema(
  STRIPE_CHARGE_ID_PATTERN,
  'Please provide the Stripe charge reference.',
  'A Stripe charge reference begins with ch_ or py_.'
)
export type StripeChargeId = z.infer<typeof stripeChargeIdSchema>

/**
 * The last four digits of the card.
 *
 * Four digits and nothing else ever reaches this application — see
 * `mannachef/CONTRACT.md` §5 on never logging full card data. Leading zeros are
 * significant, so this is a string and must stay one.
 */
export const cardLast4Schema = z
  .string({ error: 'Please give the last four digits of the card.' })
  .trim()
  .refine((value) => CARD_LAST4_PATTERN.test(value), {
    error: 'Please give exactly the last four digits of the card.',
  })
export type CardLast4 = z.infer<typeof cardLast4Schema>

/** `Visa`, `Mastercard`, `American Express`. `null` when we were not told. */
export const cardBrandSchema = optionalProse(
  MAX_CARD_BRAND_LENGTH,
  'Please keep the card brand to 40 characters or fewer.'
)

/** The machine-readable code Stripe attaches to a declined charge. */
export const failureCodeSchema = z
  .string({ error: 'Please give the failure code Stripe reported.' })
  .trim()
  .min(1, { error: 'Please give the failure code Stripe reported.' })
  .max(MAX_FAILURE_CODE_LENGTH, {
    error: 'That failure code is longer than our records allow.',
  })
export type FailureCode = z.infer<typeof failureCodeSchema>

/** The sentence Stripe hands back with a declined charge. */
export const failureReasonSchema = z
  .string({ error: 'Please record why this payment did not go through.' })
  .trim()
  .min(1, { error: 'Please record why this payment did not go through.' })
  .max(MAX_FAILURE_REASON_LENGTH, {
    error: 'Please keep the failure reason to 2,000 characters or fewer.',
  })
export type FailureReason = z.infer<typeof failureReasonSchema>

/** Why the money went back. Recorded verbatim on the audit trail. */
export const refundReasonSchema = z
  .string({ error: 'Please record why this payment is being refunded.' })
  .trim()
  .min(MIN_REFUND_REASON_LENGTH, {
    error: 'Please record why this payment is being refunded.',
  })
  .max(MAX_REFUND_REASON_LENGTH, {
    error: 'Please keep the reason to 2,000 characters or fewer.',
  })
export type RefundReason = z.infer<typeof refundReasonSchema>

/** The moment a payment settled. Never in the future — money does not pre-move. */
const settledAtSchema = isoDateTimeSchema.refine(isNotInTheFuture, {
  error: 'A payment cannot have settled at a moment still to come.',
})

// =============================================================================
// 1. Recording a payment
// =============================================================================

/**
 * The columns a payment carries that may later be corrected.
 *
 * `userId`, `amountCents` and `currency` are absent on purpose: who paid, how
 * much, and in what — those are facts about an event that already happened. A
 * mistake in them is a reversal followed by a new row, not an edit.
 */
export const paymentAmendableShape = {
  invoiceId: cuidSchema.nullable().optional(),
  subscriptionId: cuidSchema.nullable().optional(),
  stripePaymentIntentId: stripePaymentIntentIdSchema.nullable().optional(),
  stripeChargeId: stripeChargeIdSchema.nullable().optional(),
  /** Stripe's cut, when the webhook told us. `null` when it did not. */
  feeCents: amountCentsSchema.nullable().optional(),
  status: paymentStatusSchema.default('PROCESSING'),
  method: paymentMethodTypeSchema.default('CARD'),
  cardBrand: cardBrandSchema,
  cardLast4: cardLast4Schema.nullable().optional(),
  receiptUrl: urlSchema.nullable().optional(),
  processedAt: settledAtSchema.nullable().optional(),
} as const

/**
 * Recording that money moved.
 *
 * `amountCents` uses `chargeableAmountCentsSchema` — at least one cent. A
 * zero-value payment is not a payment, and recording one puts a row in the
 * client's payment history that says nothing happened, at length.
 *
 * Three refinements, each of which the webhook handler would otherwise have to
 * remember:
 *
 *  - card details only where a card was used, so an `INTERAC` transfer cannot
 *    arrive carrying a Visa brand and a last four;
 *  - a `SUCCEEDED` payment must say when it settled, because the client's
 *    receipt and the revenue report both read that column;
 *  - `FAILED` is not recorded here — it is {@link paymentFailureSchema}, which
 *    requires the reason that a bare status cannot carry.
 */
export const paymentRecordSchema = z
  .object({
    /** The payer. Re-checked against the invoice's recipient in the action. */
    userId: cuidSchema,
    amountCents: chargeableAmountCentsSchema,
    currency: currencySchema,
    ...paymentAmendableShape,
  })
  .strict()
  .check(
    // All three go through `crossFieldMixed` rather than `.refine()`. Two of
    // them read `processedAt`, which is a `settledAtSchema` — an
    // `isoDateTimeSchema`, and therefore a `z.ZodPipe`, whose failure does not
    // abort the object's own checks. Declaring the discriminating field as a
    // dependency also stops a rejected `method` or `status` from producing a
    // second, contradictory issue on top of its own.
    //
    // `cardBrand`, `cardLast4` and `processedAt` are read from the raw object
    // instead of being declared, because it is precisely their absence each
    // rule turns on, and a declared dependency that is absent skips the check.
    crossFieldMixed(
      {
        deps: { method: 'present' },
        error: 'Card details belong only on a payment that was made by card.',
        path: ['cardLast4'],
      },
      ({ method }, raw) =>
        method === 'CARD' || (raw.cardBrand == null && raw.cardLast4 == null)
    ),
    crossFieldMixed(
      {
        deps: { status: 'present' },
        error: 'A payment that succeeded must say when it settled.',
        path: ['processedAt'],
      },
      ({ status }, raw) => status !== 'SUCCEEDED' || raw.processedAt != null
    ),
    crossFieldMixed(
      {
        deps: { status: 'present' },
        error:
          'Record a failed payment with its reason, so the client can be told why.',
        path: ['status'],
      },
      ({ status }) => status !== 'FAILED'
    )
  )
export type PaymentRecordInput = z.infer<typeof paymentRecordSchema>
export type PaymentRecordRawInput = z.input<typeof paymentRecordSchema>

/**
 * Correcting a recorded payment — reconciling a receipt URL, attaching a charge
 * id a webhook delivered late, moving a status Stripe revised.
 *
 * Built by `buildUpdateSchema`, which strips the two `.default(...)`s — `status`
 * and `method` — *before* the `.partial()`. Without that strip, attaching a
 * receipt URL to a settled `INTERAC` transfer would silently rewrite it as a
 * `CARD` payment stuck in `PROCESSING`, and the client's history would show a
 * charge that never cleared.
 */
export const paymentUpdateSchema = buildUpdateSchema(paymentAmendableShape, {
  requireKeys: { id: cuidSchema },
})
export type PaymentUpdateInput = z.infer<typeof paymentUpdateSchema>
export type PaymentUpdateRawInput = z.input<typeof paymentUpdateSchema>

// =============================================================================
// 2. Refunds
// =============================================================================

/**
 * Handing money back.
 *
 * `amountCents` is echoed by the caller so the bound on `refundedCents` is
 * checkable at validation time rather than only after a database read. The
 * action re-reads the row and re-checks both figures against it before it calls
 * Stripe — a payload cannot be trusted about the size of its own charge
 * (`mannachef/CONTRACT.md` §5). The refinement here exists so the person at the
 * keyboard is told immediately, on the field they typed into.
 *
 * `refundedCents` is the **cumulative** figure the column will hold, not the
 * increment, which is why it is bounded by `amountCents` rather than by
 * whatever remains. A second partial refund therefore sends the running total.
 */
export const paymentRefundSchema = z
  .object({
    paymentId: cuidSchema,
    /** The original charge, as the caller believes it to be. */
    amountCents: chargeableAmountCentsSchema,
    /** The cumulative refunded total after this refund is issued. */
    refundedCents: chargeableAmountCentsSchema,
    reason: refundReasonSchema,
    /** Defaults to now in the action when the caller does not back-date it. */
    refundedAt: isoDateTimeSchema
      .refine(isNotInTheFuture, {
        error: 'A refund cannot have been issued at a moment still to come.',
      })
      .optional(),
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['refundedCents', 'amountCents'],
        as: 'number',
        error: 'A refund cannot exceed the amount that was paid.',
        path: ['refundedCents'],
      },
      ({ refundedCents, amountCents }) => refundedCents <= amountCents
    )
  )
export type PaymentRefundInput = z.infer<typeof paymentRefundSchema>
export type PaymentRefundRawInput = z.input<typeof paymentRefundSchema>

/**
 * The status a payment lands in once a refund of `refundedCents` is recorded
 * against a charge of `amountCents`.
 *
 * Mirrors `reviewStatusAfterModeration` in `./review`: the transition is a
 * property of the domain, so it is written beside the schema that produces it
 * rather than inline in whichever action happens to need it first.
 */
export function paymentStatusAfterRefund(
  amountCents: number,
  refundedCents: number
): Extract<PaymentStatus, 'REFUNDED' | 'PARTIALLY_REFUNDED'> {
  return refundedCents >= amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
}

// =============================================================================
// 3. Failures
// =============================================================================

/**
 * Recording that a charge did not go through.
 *
 * `failureReason` is required and `failureCode` is not, which is the right way
 * round: the code is Stripe's, and Stripe does not always send one, whereas the
 * reason is what the client is eventually shown and there is always something
 * to say. A failure with no explanation produces a support conversation that
 * begins with "we don't know".
 *
 * `processedAt` is the column this writes to — `PaymentHistory` has no separate
 * `failedAt`, and the moment a charge was attempted is the moment it was
 * processed, whichever way it went.
 */
export const paymentFailureSchema = z
  .object({
    paymentId: cuidSchema,
    failureReason: failureReasonSchema,
    failureCode: failureCodeSchema.optional(),
    /** Defaults to now in the action when the caller does not back-date it. */
    processedAt: settledAtSchema.optional(),
  })
  .strict()
export type PaymentFailureInput = z.infer<typeof paymentFailureSchema>
export type PaymentFailureRawInput = z.input<typeof paymentFailureSchema>

// =============================================================================
// 4. Filtering
// =============================================================================

/** How a page of payments is ordered; direction comes from `sortDirection`. */
export const paymentSortBySchema = z
  .enum(['CREATED', 'PROCESSED', 'AMOUNT', 'REFUNDED', 'STATUS'], {
    error: 'Please choose how the payments should be ordered.',
  })
  .default('CREATED')
export type PaymentSortBy = z.infer<typeof paymentSortBySchema>

/** How many statuses and methods there are to choose from. */
const PAYMENT_STATUS_COUNT = 9
const PAYMENT_METHOD_COUNT = 8

/**
 * The payment ledger, in the portal and in the admin OS.
 *
 * Read from a query string in both places, so every bound coerces: the amount
 * window through `withNumericCoercion`, the two date windows through
 * `withTemporalCoercion`, and the three narrowing booleans through `queryFlag`.
 * A blank `?minAmountCents=` reads as "no filter" rather than as zero, which is
 * why the `.optional()` sits inside the coercion.
 *
 * `currency` unwraps `currencySchema` rather than using it directly: that
 * schema defaults to `CAD`, and a default on a *filter* silently narrows every
 * unfiltered ledger to one currency.
 *
 * The portal passes the caller's own `userId`; the action overrides it from the
 * session for anyone below `ADMIN`, because a cuid in a query string is not
 * proof of whose payments they are.
 */
export const paymentFilterSchema = paginationSchema
  .extend({
    /** Matches the Stripe references, the card brand, and the last four digits. */
    search: z
      .string({ error: 'Please type something to search the payments for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    userId: cuidSchema.optional(),
    invoiceId: cuidSchema.optional(),
    subscriptionId: cuidSchema.optional(),
    statuses: z
      .array(paymentStatusSchema, {
        error: 'Please choose the payment statuses to show.',
      })
      .max(PAYMENT_STATUS_COUNT, {
        error: 'There are only nine statuses to choose from.',
      })
      .refine(hasUniqueValues, {
        error: 'That status is already part of your search.',
      })
      .default([]),
    methods: z
      .array(paymentMethodTypeSchema, {
        error: 'Please choose the payment methods to show.',
      })
      .max(PAYMENT_METHOD_COUNT, {
        error: 'There are only eight methods to choose from.',
      })
      .refine(hasUniqueValues, {
        error: 'That method is already part of your search.',
      })
      .default([]),
    currency: currencySchema.unwrap().optional(),
    minAmountCents: withNumericCoercion(amountCentsSchema.optional()),
    maxAmountCents: withNumericCoercion(amountCentsSchema.optional()),
    /** Narrows to payments with something handed back. */
    refundedOnly: queryFlag(
      false,
      'Please say whether to show only payments that were refunded.'
    ),
    /** Narrows to payments that did not go through. */
    failedOnly: queryFlag(
      false,
      'Please say whether to show only payments that failed.'
    ),
    /** Narrows to payments that have not settled yet. */
    unsettledOnly: queryFlag(
      false,
      'Please say whether to show only payments that have not settled.'
    ),
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    processedFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    processedTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: paymentSortBySchema,
  })
  .check(
    // Every bound here is optional and every one of them arrives from a query
    // string, so `?minAmountCents=foo&maxAmountCents=bar` used to reach the
    // comparison with two raw strings, and `?createdFrom=foo` used to reach
    // `.getTime()` on one. The guards make all four rules total: a bound that
    // is absent, or that failed its own parse, skips the check instead of
    // crashing it or contradicting it.
    crossField(
      {
        deps: ['minAmountCents', 'maxAmountCents'],
        as: 'number',
        error: 'The smallest amount must not exceed the largest one.',
        path: ['maxAmountCents'],
      },
      ({ minAmountCents, maxAmountCents }) => minAmountCents <= maxAmountCents
    ),
    crossField(
      {
        deps: ['createdFrom', 'createdTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['createdTo'],
      },
      ({ createdFrom, createdTo }) =>
        createdFrom.getTime() <= createdTo.getTime()
    ),
    crossField(
      {
        deps: ['processedFrom', 'processedTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['processedTo'],
      },
      ({ processedFrom, processedTo }) =>
        processedFrom.getTime() <= processedTo.getTime()
    ),
    crossField(
      {
        deps: ['refundedOnly', 'failedOnly'],
        as: 'boolean',
        error:
          'A payment that failed was never taken, so it cannot be refunded.',
        path: ['failedOnly'],
      },
      ({ refundedOnly, failedOnly }) => !(refundedOnly && failedOnly)
    )
  )
export type PaymentFilterInput = z.infer<typeof paymentFilterSchema>
export type PaymentFilterRawInput = z.input<typeof paymentFilterSchema>
