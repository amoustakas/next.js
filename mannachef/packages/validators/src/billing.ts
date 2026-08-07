// mannachef/packages/validators/src/billing.ts

/**
 * Billing domain validation — subscription plans, Stripe checkout, the
 * subscription lifecycle, bespoke invoices, and the webhook surface.
 *
 * Mirrors `SubscriptionPlan`, `UserSubscription`, `Invoice`, `InvoiceLineItem`
 * and `StripeEvent` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * Rules that govern this file (see `mannachef/CONTRACT.md`):
 *
 *  1. No runtime dependency on `@prisma/client` — enum values arrive from
 *     `./enums`, which re-declares them as Zod enums.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *     `hasUniqueValues`, `withoutDefaults`, `hasSomethingToSave`,
 *     `NOTHING_TO_SAVE_MESSAGE`, `queryFlag`, `optionalProse`, `isInTheFuture`,
 *     `MS_PER_DAY` and `MAX_SEARCH_LENGTH` were all declared locally here — and
 *     in as many as five sibling modules — until MCV-004 gave each of them a
 *     single home. This file carried the third and worst copy of
 *     `withoutDefaults`, the one that bridged its return type through
 *     `as unknown as`; the shared version needs only a direct narrowing cast.
 *  3. Money is always a whole count of minor units. A total is never trusted
 *     from the client: it is recomputed here and the client's figure, if it sent
 *     one, has to agree.
 *  4. Attribution fields (`issuedById`, `stripeCustomerId`, …) are resolved from
 *     the session or from Stripe inside the server action and are never accepted
 *     from the browser (`mannachef/CONTRACT.md` §5).
 *  5. Filter bounds are read from a query string — `invoice.list`,
 *     `subscription.list` and `plan.list` are all `GET` routes in
 *     `@mannachef/api-contract`. Every numeric and temporal bound in an
 *     `xFilterSchema` therefore goes through the coercion helpers in `./common`;
 *     the create, update and webhook schemas stay strict, because a string where
 *     a number belongs in a request body is a bug in the caller rather than an
 *     artefact of the transport.
 */

import { z } from 'zod'

import {
  MAX_SEARCH_LENGTH,
  MS_PER_DAY,
  buildUpdateSchema,
  cuidSchema,
  currencySchema,
  hasUniqueValues,
  isInTheFuture,
  isoDateTimeSchema,
  moneyCentsSchema,
  optionalProse,
  paginationSchema,
  queryFlag,
  slugSchema,
  urlSchema,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'
import {
  billingIntervalSchema,
  invoiceLineKindSchema,
  invoiceStatusSchema,
  subscriptionStatusSchema,
} from './enums'
import { referralCodeSchema } from './referral'

// =============================================================================
// Limits
// =============================================================================

/** Matches `SubscriptionPlan.name` — `@db.VarChar(200)`. */
const MAX_PLAN_NAME_LENGTH = 200

/** Matches `SubscriptionPlan.tagline` — `@db.VarChar(280)`. */
const MAX_TAGLINE_LENGTH = 280

/** Generous ceiling for a `@db.Text` description. */
const MAX_DESCRIPTION_LENGTH = 4_000

/** Generous ceiling for a `@db.Text` memo or reason. */
const MAX_MEMO_LENGTH = 2_000

/** Matches every Stripe identifier column — `@db.VarChar(255)`. */
const MAX_STRIPE_ID_LENGTH = 255

/** Matches `Invoice.number` — `@db.VarChar(64)`. */
const MAX_INVOICE_NUMBER_LENGTH = 64

/** Matches `InvoiceLineItem.description` — `@db.VarChar(400)`. */
const MAX_LINE_DESCRIPTION_LENGTH = 400

/** Matches `InvoiceLineItem.sourceRefId` — `@db.VarChar(64)`. */
const MAX_SOURCE_REF_LENGTH = 64

/** Matches `StripeEvent.type` — `@db.VarChar(160)`. */
const MAX_STRIPE_EVENT_TYPE_LENGTH = 160

/** A single selling point on a plan card. */
const MAX_FEATURE_LENGTH = 160

/** How many selling points one plan card may carry before it stops selling. */
export const MAX_PLAN_FEATURES = 20

/** A manual position within the plan ladder. */
const MAX_SORT_ORDER = 10_000

/** $1,000,000.00 — the ceiling on any single amount we will invoice. */
export const MAX_AMOUNT_CENTS = 100_000_000

/** How many lines one bespoke invoice may carry. */
export const MAX_INVOICE_LINE_ITEMS = 100

/** How many of one thing a single invoice line may bill for. */
export const MAX_LINE_QUANTITY = 1_000

/** Stripe caps a subscription's `interval_count`; this is the house limit. */
export const MAX_INTERVAL_COUNT = 12

/** Twenty-one meals a week is three a day — nobody eats more than that. */
export const MAX_MEALS_PER_WEEK = 21

/** Servings plated per meal on a single plan. */
export const MAX_SERVINGS_PER_MEAL = 20

/** A trial longer than a year is not a trial. */
export const MAX_TRIAL_DAYS = 365

/** How many seats one subscription may carry. */
export const MAX_SUBSCRIPTION_QUANTITY = 20

/** The longest a subscription may rest before it must be resumed or ended. */
export const MAX_PAUSE_DAYS = 180

/** Stripe price identifier: `price_1PabcdEFGHijklMN`. */
const STRIPE_PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]+$/

/** Stripe product identifier: `prod_QabcdEFGHijkl`. */
const STRIPE_PRODUCT_ID_PATTERN = /^prod_[A-Za-z0-9_]+$/

/** Stripe subscription identifier: `sub_1PabcdEFGHijklMN`. */
const STRIPE_SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/

/** Stripe customer identifier: `cus_QabcdEFGHijkl`. */
const STRIPE_CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/

/** Stripe event identifier: `evt_1PabcdEFGHijklMN`. */
const STRIPE_EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_]+$/

/** A human-facing invoice number: `MC-2026-0148`. */
const INVOICE_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,63}$/

/** Lowercase SHA-256 digest, as stored on `StripeEvent.payloadHash`. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/

// =============================================================================
// Local helpers
// =============================================================================

/**
 * Only one helper is genuinely local to billing. Everything that used to sit
 * here — `hasUniqueValues`, `withoutDefaults`, `hasSomethingToSave`,
 * `NOTHING_TO_SAVE_MESSAGE`, `queryFlag`, `optionalProse` and `isInTheFuture` —
 * now lives in `./common` and is imported at the head of this file.
 */

/** A Stripe identifier of a known shape. */
function stripeIdSchema(
  pattern: RegExp,
  missingMessage: string,
  shapeMessage: string
) {
  return z
    .string({ error: missingMessage })
    .trim()
    .min(1, { error: missingMessage })
    .max(MAX_STRIPE_ID_LENGTH, {
      error: 'That Stripe reference is longer than our records allow.',
    })
    .refine((value) => pattern.test(value), { error: shapeMessage })
}

// =============================================================================
// Shared money & Stripe field schemas
// =============================================================================

/** An amount that may legitimately be nothing — a waived fee, a zero tax line. */
export const amountCentsSchema = moneyCentsSchema.max(MAX_AMOUNT_CENTS, {
  error: 'That amount is beyond anything we invoice in a single line.',
})
export type AmountCents = z.infer<typeof amountCentsSchema>

/** An amount that has to be worth charging for. */
export const chargeableAmountCentsSchema = amountCentsSchema.min(1, {
  error: 'Please enter an amount greater than nothing.',
})
export type ChargeableAmountCents = z.infer<typeof chargeableAmountCentsSchema>

export const stripePriceIdSchema = stripeIdSchema(
  STRIPE_PRICE_ID_PATTERN,
  'Please connect this plan to a Stripe price.',
  'A Stripe price reference begins with price_ — copy it from the Stripe dashboard.'
)
export type StripePriceId = z.infer<typeof stripePriceIdSchema>

export const stripeProductIdSchema = stripeIdSchema(
  STRIPE_PRODUCT_ID_PATTERN,
  'Please connect this plan to a Stripe product.',
  'A Stripe product reference begins with prod_ — copy it from the Stripe dashboard.'
)
export type StripeProductId = z.infer<typeof stripeProductIdSchema>

export const stripeSubscriptionIdSchema = stripeIdSchema(
  STRIPE_SUBSCRIPTION_ID_PATTERN,
  'Please provide the Stripe subscription reference.',
  'A Stripe subscription reference begins with sub_.'
)
export type StripeSubscriptionId = z.infer<typeof stripeSubscriptionIdSchema>

export const stripeCustomerIdSchema = stripeIdSchema(
  STRIPE_CUSTOMER_ID_PATTERN,
  'Please provide the Stripe customer reference.',
  'A Stripe customer reference begins with cus_.'
)
export type StripeCustomerId = z.infer<typeof stripeCustomerIdSchema>

export const stripeEventIdSchema = stripeIdSchema(
  STRIPE_EVENT_ID_PATTERN,
  'Please provide the Stripe event reference.',
  'A Stripe event reference begins with evt_.'
)
export type StripeEventId = z.infer<typeof stripeEventIdSchema>

/** A human-facing invoice number, as printed at the head of the document. */
export const invoiceNumberSchema = z
  .string({ error: 'Please give this invoice a number.' })
  .trim()
  .toUpperCase()
  .min(3, { error: 'An invoice number needs at least three characters.' })
  .max(MAX_INVOICE_NUMBER_LENGTH, {
    error: 'Please keep the invoice number to 64 characters or fewer.',
  })
  .refine((value) => INVOICE_NUMBER_PATTERN.test(value), {
    error:
      'Use capitals, numerals and hyphens only — for example, MC-2026-0148.',
  })
export type InvoiceNumber = z.infer<typeof invoiceNumberSchema>

// =============================================================================
// 1. Subscription plans
// =============================================================================

const subscriptionPlanBaseSchema = z
  .object({
    slug: slugSchema,
    name: z
      .string({ error: 'Every plan needs a name.' })
      .trim()
      .min(2, { error: 'A plan name needs at least two characters.' })
      .max(MAX_PLAN_NAME_LENGTH, {
        error: 'Please keep the plan name to 200 characters or fewer.',
      }),
    tagline: optionalProse(
      MAX_TAGLINE_LENGTH,
      'Please keep the tagline to 280 characters or fewer.'
    ),
    description: optionalProse(
      MAX_DESCRIPTION_LENGTH,
      'Please keep the description to 4,000 characters or fewer.'
    ),

    stripePriceId: stripePriceIdSchema,
    stripeProductId: stripeProductIdSchema,

    interval: billingIntervalSchema.default('MONTH'),
    intervalCount: z
      .int({ error: 'Please give the renewal cadence as a whole number.' })
      .min(1, { error: 'A plan renews at least once per interval.' })
      .max(MAX_INTERVAL_COUNT, {
        error: 'A plan cannot span more than twelve intervals at a time.',
      })
      .default(1),
    priceCents: chargeableAmountCentsSchema,
    currency: currencySchema,
    setupFeeCents: amountCentsSchema.nullable().optional(),
    trialDays: z
      .int({ error: 'Please give the trial length in whole days.' })
      .min(1, { error: 'A trial runs for at least one day.' })
      .max(MAX_TRIAL_DAYS, {
        error: 'A trial cannot run longer than a year.',
      })
      .nullable()
      .optional(),

    mealsPerWeek: z
      .int({ error: 'Please say how many meals this plan includes each week.' })
      .min(1, { error: 'A plan includes at least one meal a week.' })
      .max(MAX_MEALS_PER_WEEK, {
        error: 'Twenty-one meals a week is three a day — our generous limit.',
      }),
    servingsPerMeal: z
      .int({ error: 'Please say how many servings each meal plates.' })
      .min(1, { error: 'Each meal plates at least one serving.' })
      .max(MAX_SERVINGS_PER_MEAL, {
        error:
          'For a table larger than twenty, please arrange a private event.',
      }),
    features: z
      .array(
        z
          .string({ error: 'Please write out each inclusion.' })
          .trim()
          .min(2, { error: 'An inclusion needs at least two characters.' })
          .max(MAX_FEATURE_LENGTH, {
            error: 'Please keep each inclusion to 160 characters or fewer.',
          }),
        { error: 'Please list what this plan includes.' }
      )
      .max(MAX_PLAN_FEATURES, {
        error: 'Twenty inclusions is plenty — the card should still breathe.',
      })
      .refine(hasUniqueValues, {
        error: 'That inclusion is already listed on this plan.',
      })
      .default([]),

    isActive: z
      .boolean({ error: 'Please say whether this plan is open for enrolment.' })
      .default(true),
    isFeatured: z
      .boolean({ error: 'Please say whether this plan leads the collection.' })
      .default(false),
    sortOrder: z
      .int({ error: 'Please give a whole number for the running order.' })
      .min(0, { error: 'The running order begins at zero.' })
      .max(MAX_SORT_ORDER, {
        error: 'That position sits far beyond the end of the ladder.',
      })
      .default(0),
  })
  .strict()

/** A trial only makes sense on a plan that is open for enrolment. */
function trialIsOfferable(value: {
  trialDays?: number | null | undefined
  isActive?: boolean | undefined
}): boolean {
  if (value.trialDays == null) {
    return true
  }

  return value.isActive !== false
}

const TRIAL_REQUIRES_ACTIVE_MESSAGE =
  'A plan that is closed to enrolment cannot offer a trial. Open the plan, or clear the trial.'

export const subscriptionPlanCreateSchema = subscriptionPlanBaseSchema.refine(
  trialIsOfferable,
  { error: TRIAL_REQUIRES_ACTIVE_MESSAGE, path: ['trialDays'] }
)
export type SubscriptionPlanCreateInput = z.infer<
  typeof subscriptionPlanCreateSchema
>
export type SubscriptionPlanCreateRawInput = z.input<
  typeof subscriptionPlanCreateSchema
>

/**
 * Amending a plan.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * The three steps this schema performs by hand — strip the defaults, make the
 * rest optional, put the identifier back and refuse an identifier on its own —
 * are the three steps every update schema in the package performs, in the one
 * order that is correct. They are now performed in exactly one place.
 *
 * The order is what matters. `subscriptionPlanBaseSchema` carries six defaults
 * (`interval`, `intervalCount`, `currency`, `features`, `isActive`,
 * `isFeatured`, `sortOrder`), and a default survives `.partial()` in zod 4:
 * `z.ZodOptional` wrapping a `z.ZodDefault` delegates rather than
 * short-circuiting on `undefined`. Correcting a plan's tagline would therefore
 * have parsed to a payload that also reset its renewal cadence to monthly, its
 * currency to CAD, its inclusions to `[]`, its position in the ladder to zero,
 * and re-opened it for enrolment. Handed to `prisma.update`, a closed plan goes
 * back on sale because somebody fixed a typo.
 *
 * Both refinements survive the move: `trialIsOfferable` still guards the
 * trial/enrolment pairing, and the "nothing to save" guard is supplied by
 * `buildUpdateSchema` itself as `hasSomethingToSaveBeyond(1)` — the generalised
 * form of `hasSomethingToSave`, computed from the one key kept required.
 */
export const subscriptionPlanUpdateSchema = buildUpdateSchema(
  subscriptionPlanBaseSchema.shape,
  { requireKeys: { id: cuidSchema } }
).refine(trialIsOfferable, {
  error: TRIAL_REQUIRES_ACTIVE_MESSAGE,
  path: ['trialDays'],
})
export type SubscriptionPlanUpdateInput = z.infer<
  typeof subscriptionPlanUpdateSchema
>
export type SubscriptionPlanUpdateRawInput = z.input<
  typeof subscriptionPlanUpdateSchema
>

/** How the plan ladder is ordered; direction comes from `sortDirection`. */
export const subscriptionPlanSortBySchema = z
  .enum(['SORT_ORDER', 'PRICE', 'NAME', 'CREATED', 'UPDATED'], {
    error: 'Please choose how the plans should be ordered.',
  })
  .default('SORT_ORDER')
export type SubscriptionPlanSortBy = z.infer<
  typeof subscriptionPlanSortBySchema
>

export const subscriptionPlanFilterSchema = paginationSchema
  .extend({
    search: z
      .string({ error: 'Please type something to search the plans for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    intervals: z
      .array(billingIntervalSchema, {
        error: 'Please choose the renewal cadences to show.',
      })
      .max(5, { error: 'There are only five cadences to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That cadence is already part of your search.',
      })
      .default([]),
    isActive: queryFlag(
      true,
      'Please say whether to show plans that are open for enrolment.'
    ),
    featuredOnly: queryFlag(
      false,
      'Please say whether to show only the plans that lead the collection.'
    ),
    /**
     * GET filter bounds, so both go through the query-string coercion in
     * `./common`: `?minPriceCents=1500` arrives as the string `"1500"` and has
     * to parse, while a JSON body carrying a real `1500` is held to the very
     * same ceiling and reports the very same message.
     *
     * The `.optional()` sits *inside* the coercion deliberately. Wrapped the
     * other way round, a rendered-but-empty `?minPriceCents=` is the string
     * `''`, which sails straight past `z.ZodOptional` and is then rejected by
     * `z.int()`; inside, it is read as "no filter" and becomes `undefined`.
     */
    minPriceCents: withNumericCoercion(amountCentsSchema.optional()),
    maxPriceCents: withNumericCoercion(amountCentsSchema.optional()),
    sortBy: subscriptionPlanSortBySchema,
  })
  .refine(
    ({ minPriceCents, maxPriceCents }) =>
      minPriceCents === undefined ||
      maxPriceCents === undefined ||
      minPriceCents <= maxPriceCents,
    {
      error: 'The lower price must not exceed the higher one.',
      path: ['maxPriceCents'],
    }
  )
export type SubscriptionPlanFilterInput = z.infer<
  typeof subscriptionPlanFilterSchema
>
export type SubscriptionPlanFilterRawInput = z.input<
  typeof subscriptionPlanFilterSchema
>

// =============================================================================
// 2. Checkout
// =============================================================================

/**
 * What the portal sends to open a Stripe Checkout session.
 *
 * The customer is resolved from the session inside the action — a caller may
 * choose a plan, never a payer. Both return addresses are validated as absolute
 * URLs because Stripe will not accept anything else, and the action additionally
 * confirms the host against `NEXT_PUBLIC_APP_URL` before the session is created.
 */
export const checkoutSessionSchema = z
  .object({
    planId: cuidSchema,
    quantity: z
      .int({ error: 'Please choose how many places to reserve.' })
      .min(1, { error: 'Please reserve at least one place.' })
      .max(MAX_SUBSCRIPTION_QUANTITY, {
        error:
          'For more than twenty places, we would rather arrange it personally.',
      })
      .default(1),
    successUrl: urlSchema,
    cancelUrl: urlSchema,
    /** Optional invitation code, applied as a Stripe coupon by the action. */
    referralCode: referralCodeSchema.optional(),
    /** Overrides the plan's trial. The action refuses to lengthen it. */
    trialDays: z
      .int({ error: 'Please give the trial length in whole days.' })
      .min(0, { error: 'A trial cannot run for less than no days at all.' })
      .max(MAX_TRIAL_DAYS, { error: 'A trial cannot run longer than a year.' })
      .optional(),
    allowPromotionCodes: z
      .boolean({
        error: 'Please say whether promotion codes may be entered at checkout.',
      })
      .default(true),
  })
  .strict()
  .refine((value) => value.successUrl !== value.cancelUrl, {
    error:
      'Please send guests somewhere different when they change their mind.',
    path: ['cancelUrl'],
  })
export type CheckoutSessionInput = z.infer<typeof checkoutSessionSchema>
export type CheckoutSessionRawInput = z.input<typeof checkoutSessionSchema>

/**
 * Opening the Stripe billing portal, where a subscriber manages their card.
 * The customer reference is resolved server-side from the session.
 */
export const billingPortalSessionSchema = z
  .object({
    returnUrl: urlSchema,
  })
  .strict()
export type BillingPortalSessionInput = z.infer<
  typeof billingPortalSessionSchema
>
export type BillingPortalSessionRawInput = z.input<
  typeof billingPortalSessionSchema
>

// =============================================================================
// 3. Subscription lifecycle
// =============================================================================

/**
 * How Stripe should settle the difference when a plan changes mid-period.
 * The values are Stripe's own, so the action can forward them untranslated.
 */
export const PRORATION_BEHAVIORS = [
  'create_prorations',
  'always_invoice',
  'none',
] as const

const PRORATION_BEHAVIOR_MESSAGE =
  'Please choose how the difference in price should be settled.'

/** Defaults to prorating, which is what an upgrade should do. */
export const prorationBehaviorSchema = z
  .enum(PRORATION_BEHAVIORS, { error: PRORATION_BEHAVIOR_MESSAGE })
  .default('create_prorations')
export type ProrationBehavior = z.infer<typeof prorationBehaviorSchema>

/** Whether a change lands now or waits for the current period to close. */
export const changeEffectiveAtSchema = z.enum(['IMMEDIATELY', 'PERIOD_END'], {
  error: 'Please choose when this change should take effect.',
})
export type ChangeEffectiveAt = z.infer<typeof changeEffectiveAtSchema>

/**
 * Every move a subscriber (or an admin acting for one) may make, as a
 * discriminated union so each action carries exactly the arguments it needs.
 *
 * `subscriptionId` is re-checked against the caller inside the action — a
 * subscription reference from the browser is never trusted on its own
 * (`mannachef/CONTRACT.md` §5).
 */
export const subscriptionChangeSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('UPGRADE'),
        subscriptionId: cuidSchema,
        /** The richer plan being moved to. */
        planId: cuidSchema,
        quantity: z
          .int({ error: 'Please choose how many places to reserve.' })
          .min(1, { error: 'Please reserve at least one place.' })
          .max(MAX_SUBSCRIPTION_QUANTITY, {
            error:
              'For more than twenty places, we would rather arrange it personally.',
          })
          .optional(),
        /** An upgrade is a welcome, so it lands at once unless told otherwise. */
        effectiveAt: changeEffectiveAtSchema.default('IMMEDIATELY'),
        prorationBehavior: prorationBehaviorSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('DOWNGRADE'),
        subscriptionId: cuidSchema,
        /** The lighter plan being moved to. */
        planId: cuidSchema,
        quantity: z
          .int({ error: 'Please choose how many places to reserve.' })
          .min(1, { error: 'Please reserve at least one place.' })
          .max(MAX_SUBSCRIPTION_QUANTITY, {
            error:
              'For more than twenty places, we would rather arrange it personally.',
          })
          .optional(),
        /**
         * A downgrade waits for the period the subscriber has already paid for,
         * so nothing they have bought is taken away early.
         */
        effectiveAt: changeEffectiveAtSchema.default('PERIOD_END'),
        /**
         * Nothing is prorated on the way down by default: the subscriber keeps
         * what they have paid for and the lighter price applies from the next
         * period.
         */
        prorationBehavior: z
          .enum(PRORATION_BEHAVIORS, { error: PRORATION_BEHAVIOR_MESSAGE })
          .default('none'),
        reason: optionalProse(
          MAX_MEMO_LENGTH,
          'Please keep the reason to 2,000 characters or fewer.'
        ),
      })
      .strict(),
    z
      .object({
        action: z.literal('PAUSE'),
        subscriptionId: cuidSchema,
        /**
         * When service resumes. Mirrors `UserSubscription.pausedUntil`, and must
         * be a date still ahead of us — a rest cannot be taken in the past.
         */
        pausedUntil: isoDateTimeSchema,
        reason: optionalProse(
          MAX_MEMO_LENGTH,
          'Please keep the reason to 2,000 characters or fewer.'
        ),
      })
      .strict()
      .refine(({ pausedUntil }) => isInTheFuture(pausedUntil), {
        error: 'Please choose a date in the future for service to resume.',
        path: ['pausedUntil'],
      })
      .refine(
        ({ pausedUntil }) =>
          pausedUntil.getTime() - Date.now() <= MAX_PAUSE_DAYS * MS_PER_DAY,
        {
          error:
            'A subscription may rest for up to six months. Beyond that, please cancel and rejoin when you are ready.',
          path: ['pausedUntil'],
        }
      ),
    z
      .object({
        action: z.literal('RESUME'),
        subscriptionId: cuidSchema,
        /** Omit to resume immediately. */
        resumeAt: isoDateTimeSchema.optional(),
      })
      .strict()
      .refine(
        ({ resumeAt }) => resumeAt === undefined || isInTheFuture(resumeAt),
        {
          error: 'Please choose a date in the future for service to resume.',
          path: ['resumeAt'],
        }
      ),
    z
      .object({
        action: z.literal('CANCEL'),
        subscriptionId: cuidSchema,
        /**
         * The gracious default: service continues to the end of the period the
         * subscriber has already paid for.
         */
        cancelAtPeriodEnd: z
          .boolean({
            error:
              'Please say whether service should continue to the end of the paid period.',
          })
          .default(true),
        /** A specific closing date, when neither now nor the period end will do. */
        cancelAt: isoDateTimeSchema.optional(),
        cancellationReason: optionalProse(
          MAX_MEMO_LENGTH,
          'Please keep the reason to 2,000 characters or fewer.'
        ),
      })
      .strict()
      .refine(
        ({ cancelAt }) => cancelAt === undefined || isInTheFuture(cancelAt),
        {
          error: 'Please choose a closing date in the future.',
          path: ['cancelAt'],
        }
      )
      .refine(
        ({ cancelAtPeriodEnd, cancelAt }) =>
          !cancelAtPeriodEnd || cancelAt === undefined,
        {
          error:
            'Choose either the end of the paid period or a specific date — not both.',
          path: ['cancelAt'],
        }
      ),
  ],
  { error: 'Please choose what should happen to this subscription.' }
)
export type SubscriptionChangeInput = z.infer<typeof subscriptionChangeSchema>
export type SubscriptionChangeRawInput = z.input<
  typeof subscriptionChangeSchema
>

/** The discriminator values, handy for rendering the subscription controls. */
export const SUBSCRIPTION_CHANGE_ACTIONS = [
  'UPGRADE',
  'DOWNGRADE',
  'PAUSE',
  'RESUME',
  'CANCEL',
] as const

export type SubscriptionChangeAction =
  (typeof SUBSCRIPTION_CHANGE_ACTIONS)[number]

/** Filter for the subscriptions table in the admin OS. */
export const userSubscriptionFilterSchema = paginationSchema
  .extend({
    userId: cuidSchema.optional(),
    planId: cuidSchema.optional(),
    statuses: z
      .array(subscriptionStatusSchema, {
        error: 'Please choose the subscription statuses to show.',
      })
      .max(8, { error: 'There are only eight statuses to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That status is already part of your search.',
      })
      .default([]),
    /** Surfaces the subscriptions closing at the end of this period. */
    cancellingOnly: queryFlag(
      false,
      'Please say whether to show only subscriptions due to close.'
    ),
    /** Surfaces subscriptions currently resting. */
    pausedOnly: queryFlag(
      false,
      'Please say whether to show only subscriptions at rest.'
    ),
    /**
     * `subscription.list` is a `GET` route, so both bounds coerce. Beyond the
     * epoch-millisecond form, this is what absorbs `Date.prototype.toString()`
     * output — which is what `new URLSearchParams({ renewingFrom: someDate })`
     * actually writes, and which the strict `isoDateTimeSchema` rightly refuses.
     */
    renewingFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    renewingUntil: withTemporalCoercion(isoDateTimeSchema.optional()),
  })
  .refine(
    ({ renewingFrom, renewingUntil }) =>
      renewingFrom === undefined ||
      renewingUntil === undefined ||
      renewingFrom.getTime() <= renewingUntil.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['renewingUntil'],
    }
  )
export type UserSubscriptionFilterInput = z.infer<
  typeof userSubscriptionFilterSchema
>
export type UserSubscriptionFilterRawInput = z.input<
  typeof userSubscriptionFilterSchema
>

// =============================================================================
// 4. Manual invoices
// =============================================================================

/**
 * One line of a bespoke invoice.
 *
 * Field names mirror `InvoiceLineItem`: the per-unit figure is
 * `unitAmountCents` and the extended figure is `amountCents`. `amountCents` is
 * optional on input — the generator computes it — but if a caller does send one
 * it has to agree with quantity × unit price, so a tampered total is caught
 * before it ever reaches the ledger.
 */
export const manualInvoiceLineItemSchema = z
  .object({
    kind: invoiceLineKindSchema.default('OTHER'),
    description: z
      .string({ error: 'Please describe what this line is for.' })
      .trim()
      .min(2, { error: 'A line needs at least two characters of description.' })
      .max(MAX_LINE_DESCRIPTION_LENGTH, {
        error: 'Please keep each line to 400 characters or fewer.',
      }),
    quantity: z
      .int({ error: 'Please give the quantity as a whole number.' })
      .min(1, { error: 'A line bills for at least one.' })
      .max(MAX_LINE_QUANTITY, {
        error: 'Please bill up to a thousand of one thing per line.',
      })
      .default(1),
    unitAmountCents: amountCentsSchema,
    /** Optional; recomputed and cross-checked by the generator. */
    amountCents: amountCentsSchema.optional(),
    taxCents: amountCentsSchema.default(0),
    sortOrder: z
      .int({ error: 'Please give a whole number for the running order.' })
      .min(0, { error: 'The running order begins at zero.' })
      .max(MAX_SORT_ORDER, {
        error: 'That position sits far beyond the end of the invoice.',
      })
      .default(0),
    /**
     * Free-form pointer to the domain row this line was derived from. Not a
     * foreign key, so a historical invoice never breaks when the catalogue moves
     * on — see the note on `InvoiceLineItem.sourceRefId`.
     */
    sourceRefId: z
      .string({ error: 'Please provide a reference for this line.' })
      .trim()
      .max(MAX_SOURCE_REF_LENGTH, {
        error: 'That reference is longer than our records allow.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    ({ quantity, unitAmountCents, amountCents }) =>
      amountCents === undefined || amountCents === quantity * unitAmountCents,
    {
      error:
        'This line does not add up — the total should be the quantity times the unit price.',
      path: ['amountCents'],
    }
  )
  .refine(
    ({ quantity, unitAmountCents }) =>
      quantity * unitAmountCents <= MAX_AMOUNT_CENTS,
    {
      error: 'That line comes to more than we invoice in a single entry.',
      path: ['unitAmountCents'],
    }
  )
export type ManualInvoiceLineItemInput = z.infer<
  typeof manualInvoiceLineItemSchema
>
export type ManualInvoiceLineItemRawInput = z.input<
  typeof manualInvoiceLineItemSchema
>

/** The extended amount of a single line: quantity × unit price. */
export function lineItemAmountCents(line: {
  quantity: number
  unitAmountCents: number
}): number {
  return line.quantity * line.unitAmountCents
}

/** Everything an invoice footer prints, derived from the lines and the discount. */
export interface InvoiceTotals {
  subtotalCents: number
  taxCents: number
  discountCents: number
  amountDueCents: number
}

/**
 * The single authority for what a bespoke invoice comes to.
 *
 * The server action calls this and writes the result; the form calls it to
 * render a live footer. Because both read the same function, the figure a guest
 * agrees to is the figure that reaches Stripe.
 */
export function computeInvoiceTotals(input: {
  lineItems: readonly {
    quantity: number
    unitAmountCents: number
    taxCents?: number | undefined
  }[]
  discountCents?: number | undefined
}): InvoiceTotals {
  let subtotalCents = 0
  let taxCents = 0

  for (const line of input.lineItems) {
    subtotalCents += lineItemAmountCents(line)
    taxCents += line.taxCents ?? 0
  }

  const discountCents = input.discountCents ?? 0

  return {
    subtotalCents,
    taxCents,
    discountCents,
    amountDueCents: subtotalCents + taxCents - discountCents,
  }
}

/**
 * The bespoke invoice generator — a private event, a tasting, a bottle of
 * something rare, billed outside the subscription engine.
 *
 * `issuedById` is taken from the session, and `isManual` is set by the action:
 * neither is accepted here. The recipient is stated explicitly because an admin
 * raises this invoice on someone else's behalf, and the action re-checks that
 * the recipient is a client it is entitled to bill.
 */
export const manualInvoiceCreateSchema = z
  .object({
    userId: cuidSchema,
    /** Set when the invoice settles a booked engagement. */
    appointmentId: cuidSchema.nullable().optional(),
    /** Omit to let the house numbering sequence assign one. */
    number: invoiceNumberSchema.optional(),
    currency: currencySchema,

    lineItems: z
      .array(manualInvoiceLineItemSchema, {
        error: 'Please add what this invoice is for.',
      })
      .min(1, { error: 'An invoice needs at least one line.' })
      .max(MAX_INVOICE_LINE_ITEMS, {
        error: 'Please keep an invoice to a hundred lines or fewer.',
      }),

    discountCents: amountCentsSchema.default(0),
    /**
     * What the caller believes the invoice comes to. Optional, and checked
     * against the recomputed figure — a client-supplied total is never the one
     * we bill.
     */
    expectedTotalCents: amountCentsSchema.optional(),

    description: optionalProse(
      MAX_DESCRIPTION_LENGTH,
      'Please keep the description to 4,000 characters or fewer.'
    ),
    memo: optionalProse(
      MAX_MEMO_LENGTH,
      'Please keep the memo to 2,000 characters or fewer.'
    ),
    dueAt: isoDateTimeSchema.optional(),
    /** Leave unset to keep the invoice a draft until it is reviewed. */
    issueImmediately: z
      .boolean({ error: 'Please say whether to send this invoice now.' })
      .default(false),
  })
  .strict()
  .refine(
    (value) => {
      const totals = computeInvoiceTotals(value)
      return value.discountCents <= totals.subtotalCents + totals.taxCents
    },
    {
      error: 'A discount cannot be larger than the invoice it reduces.',
      path: ['discountCents'],
    }
  )
  .refine(
    (value) =>
      value.expectedTotalCents === undefined ||
      value.expectedTotalCents === computeInvoiceTotals(value).amountDueCents,
    {
      error:
        'The total does not match the lines above. Please review the invoice before sending it.',
      path: ['expectedTotalCents'],
    }
  )
  .refine(
    (value) => computeInvoiceTotals(value).amountDueCents <= MAX_AMOUNT_CENTS,
    {
      error:
        'This invoice comes to more than we settle in one document. Please split it.',
      path: ['lineItems'],
    }
  )
  .refine((value) => value.dueAt === undefined || isInTheFuture(value.dueAt), {
    error: 'Please choose a due date in the future.',
    path: ['dueAt'],
  })
  .refine(
    (value) =>
      value.lineItems.every(
        (line) =>
          line.amountCents === undefined ||
          line.amountCents === lineItemAmountCents(line)
      ),
    {
      error:
        'One of these lines does not add up. Please check the quantities and unit prices.',
      path: ['lineItems'],
    }
  )
export type ManualInvoiceCreateInput = z.infer<typeof manualInvoiceCreateSchema>
export type ManualInvoiceCreateRawInput = z.input<
  typeof manualInvoiceCreateSchema
>

// =============================================================================
// 5. Invoice filtering
// =============================================================================

/** How a page of invoices is ordered; direction comes from `sortDirection`. */
export const invoiceSortBySchema = z
  .enum(['CREATED', 'ISSUED', 'DUE', 'AMOUNT', 'NUMBER', 'STATUS'], {
    error: 'Please choose how the invoices should be ordered.',
  })
  .default('CREATED')
export type InvoiceSortBy = z.infer<typeof invoiceSortBySchema>

export const invoiceFilterSchema = paginationSchema
  .extend({
    /** Matches the number, description, and memo. */
    search: z
      .string({ error: 'Please type something to search the invoices for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    /** Server actions confirm the caller may see another person's invoices. */
    userId: cuidSchema.optional(),
    subscriptionId: cuidSchema.optional(),
    appointmentId: cuidSchema.optional(),
    issuedById: cuidSchema.optional(),
    statuses: z
      .array(invoiceStatusSchema, {
        error: 'Please choose the invoice statuses to show.',
      })
      .max(5, { error: 'There are only five statuses to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That status is already part of your search.',
      })
      .default([]),
    /** Narrows to bespoke invoices raised outside the subscription engine. */
    manualOnly: queryFlag(
      false,
      'Please say whether to show only bespoke invoices.'
    ),
    /** Narrows to invoices with something still to pay. */
    outstandingOnly: queryFlag(
      false,
      'Please say whether to show only invoices with a balance.'
    ),
    /** Narrows to invoices whose due date has passed and are still unpaid. */
    overdueOnly: queryFlag(
      false,
      'Please say whether to show only invoices past their due date.'
    ),
    /**
     * The two bounds the MCV-005 audit proved broken.
     *
     * `invoice.list` is a `GET` route in `@mannachef/api-contract`, and the
     * contract's own serializer turns a filter object into a `URLSearchParams`
     * bag — so `{ minAmountDueCents: 1500 }` leaves as `?minAmountDueCents=1500`
     * and arrives as the string `"1500"`. `amountCentsSchema` is built on
     * `z.int()`, which does not coerce, so the invoice table rejected every
     * amount filter it had itself just rendered.
     *
     * The bounds and the messages are unchanged: `withNumericCoercion` wraps
     * `amountCentsSchema`, it does not restate it.
     */
    minAmountDueCents: withNumericCoercion(amountCentsSchema.optional()),
    maxAmountDueCents: withNumericCoercion(amountCentsSchema.optional()),
    /** Four temporal bounds on the same GET route, coerced for the same reason. */
    issuedFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    issuedTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    dueFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    dueTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: invoiceSortBySchema,
  })
  .refine(
    ({ minAmountDueCents, maxAmountDueCents }) =>
      minAmountDueCents === undefined ||
      maxAmountDueCents === undefined ||
      minAmountDueCents <= maxAmountDueCents,
    {
      error: 'The lower amount must not exceed the higher one.',
      path: ['maxAmountDueCents'],
    }
  )
  .refine(
    ({ issuedFrom, issuedTo }) =>
      issuedFrom === undefined ||
      issuedTo === undefined ||
      issuedFrom.getTime() <= issuedTo.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['issuedTo'],
    }
  )
  .refine(
    ({ dueFrom, dueTo }) =>
      dueFrom === undefined ||
      dueTo === undefined ||
      dueFrom.getTime() <= dueTo.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['dueTo'],
    }
  )
export type InvoiceFilterInput = z.infer<typeof invoiceFilterSchema>
export type InvoiceFilterRawInput = z.input<typeof invoiceFilterSchema>

// =============================================================================
// 6. Stripe webhooks
// =============================================================================

/**
 * Every Stripe event this application acts on.
 *
 * The webhook route verifies the signature, records the event in the
 * `StripeEvent` ledger for idempotency, and then dispatches on this union.
 * Anything not listed here is acknowledged with a 200 and ignored — Stripe
 * sends a great deal we have no opinion about, and retrying those forever helps
 * nobody.
 */
export const HANDLED_STRIPE_EVENT_TYPES = [
  // --- Checkout -------------------------------------------------------------
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',

  // --- Subscriptions --------------------------------------------------------
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',

  // --- Invoices -------------------------------------------------------------
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.marked_uncollectible',
  'invoice.voided',

  // --- Payments -------------------------------------------------------------
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',

  // --- Customers ------------------------------------------------------------
  'customer.deleted',
] as const

export const stripeWebhookEventTypeSchema = z.enum(HANDLED_STRIPE_EVENT_TYPES, {
  error: 'That is not an event this application knows how to handle.',
})
export type StripeWebhookEventType = z.infer<
  typeof stripeWebhookEventTypeSchema
>

/**
 * Narrowing guard for the `type` field of a verified Stripe event.
 *
 * Call this only after `constructEvent` has verified the signature: a type name
 * on its own proves nothing about who sent it.
 */
export function isHandledStripeEventType(
  value: unknown
): value is StripeWebhookEventType {
  return stripeWebhookEventTypeSchema.safeParse(value).success
}

/**
 * The row written to the `StripeEvent` idempotency ledger.
 *
 * `payloadHash` is a digest of the raw body — the raw payload itself is never
 * persisted and never logged (`mannachef/CONTRACT.md` §5).
 */
export const stripeEventLedgerEntrySchema = z
  .object({
    stripeEventId: stripeEventIdSchema,
    type: z
      .string({ error: 'Please provide the Stripe event name.' })
      .trim()
      .min(1, { error: 'Please provide the Stripe event name.' })
      .max(MAX_STRIPE_EVENT_TYPE_LENGTH, {
        error: 'That event name is longer than our records allow.',
      }),
    apiVersion: z
      .string({ error: 'Please provide the Stripe API version.' })
      .trim()
      .max(40, { error: 'That API version is longer than our records allow.' })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
    livemode: z
      .boolean({ error: 'Please say whether this event came from live mode.' })
      .default(false),
    payloadHash: z
      .string({ error: 'Please provide the payload digest.' })
      .trim()
      .toLowerCase()
      .refine((value) => SHA256_PATTERN.test(value), {
        error: 'The payload digest must be a 64-character SHA-256 hash.',
      }),
  })
  .strict()
export type StripeEventLedgerEntryInput = z.infer<
  typeof stripeEventLedgerEntrySchema
>
export type StripeEventLedgerEntryRawInput = z.input<
  typeof stripeEventLedgerEntrySchema
>
