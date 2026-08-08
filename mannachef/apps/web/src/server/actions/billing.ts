// mannachef/apps/web/src/server/actions/billing.ts

'use server'

/**
 * Billing domain Server Actions — the plan ladder, Stripe Checkout, the
 * subscription lifecycle, bespoke event invoicing, and the revenue dashboard.
 *
 * Every exported function here is produced by {@link withAction}, so each one
 * runs the sequence `mannachef/CONTRACT.md` §5 prescribes before it touches a
 * row: resolve the session, enforce the minimum role, rate limit where a
 * stranger can reach it, `safeParse` the raw payload, run, translate anything
 * thrown into a guest-safe `ActionResult`, and revalidate on success only.
 * Ownership — §5 step 4 — is the handler's first statement wherever the row is
 * scoped to a client, and it goes through the guards in `@/server/guards`.
 *
 * ## Who may do what
 *
 * | Action                      | Requirement | Ownership                              |
 * | --------------------------- | ----------- | -------------------------------------- |
 * | `listSubscriptionPlans`     | `PUBLIC`    | n/a — the pricing page is public        |
 * | `createSubscriptionPlan`    | `ADMIN`     | n/a — the ladder is house-wide          |
 * | `updateSubscriptionPlan`    | `ADMIN`     | n/a                                     |
 * | `deleteSubscriptionPlan`    | `ADMIN`     | n/a                                     |
 * | `createCheckoutSession`     | `SESSION`   | the payer **is** the session user       |
 * | `listSubscriptions`         | `SESSION`   | pinned to the caller below `ADMIN`      |
 * | `changeSubscription`        | `SESSION`   | `requireSubscriptionOwnership`          |
 * | `createManualInvoice`       | `ADMIN`     | recipient re-read; appointment re-tied  |
 * | `listInvoices`              | `SESSION`   | pinned to the caller below `ADMIN`      |
 * | `getInvoice`                | `SESSION`   | `requireInvoiceOwnership`               |
 * | `getBillingDashboard`       | `ADMIN`     | n/a — house aggregate                   |
 *
 * Ownership is not the whole of it on `changeSubscription`. Owning the row says
 * *which* subscription may be moved; the *terms* of the move — `effectiveAt`,
 * `prorationBehavior`, `quantity` — are the house's below `ADMIN`, and the
 * payload's are discarded. See {@link resolveSubscriptionChangeTerms}.
 *
 * `CHEF_STAFF` is deliberately **not** privileged anywhere in this module. A
 * chef needs a household's allergies, not its bank statements; the ownership
 * guards for `invoice` and `subscription` default their bypass to `ADMIN` for
 * exactly that reason, and every role comparison below uses the same threshold.
 *
 * ## Money is recomputed, never accepted
 *
 * `manualInvoiceCreateSchema` lets a caller send `amountCents` on a line and an
 * `expectedTotalCents` on the invoice. Both are **agreement checks**, not
 * inputs: the schema rejects a payload whose arithmetic disagrees, and
 * {@link createManualInvoice} then throws the client's figures away and writes
 * what `computeInvoiceTotals` — the single authority, shared with the form that
 * rendered the footer — says the invoice comes to. A tampered total therefore
 * has to survive both the schema and being ignored.
 *
 * The same rule governs the plan ladder. A plan's `priceCents` is not taken on
 * trust either: when Stripe is configured, {@link createSubscriptionPlan} and
 * {@link updateSubscriptionPlan} retrieve the named `price` and refuse to save
 * a plan whose stated amount, currency, product or renewal cadence disagrees
 * with it. A plan card that promises one figure and charges another is the
 * worst bug this domain can ship.
 *
 * ## Projections
 *
 * Two selects per entity, one per privilege level, exactly as `media.ts` does
 * it — the columns a caller may not see are never read into the process:
 *
 *  - **Plans.** `stripePriceId` and `stripeProductId` are infrastructure
 *    handles that address the account, not the plan. `ADMIN` and above.
 *  - **Subscriptions.** `stripeCustomerId` addresses *every* subscription on
 *    the account and is never selected for anybody — it is read only inside
 *    the ownership guard, which does not return it to a view. This matches
 *    `subscriptionSchema` in `@mannachef/api-contract`, which exposes
 *    `stripeSubscriptionId` and withholds the customer.
 *  - **Invoices.** `memo` is the house's private note on a bill and
 *    `issuedById` names the colleague who raised it. `ADMIN` and above.
 *
 * ## Never logged
 *
 * No Stripe key, no raw Stripe payload, no card data. `withAction` collapses a
 * Stripe SDK throw into a generic `INTERNAL` with an incident reference, and
 * the real error is written to the server log by the wrapper — never here, and
 * never with the action's input, which on this domain carries amounts and
 * addresses.
 */

import { z } from 'zod'

import type { PageMeta } from '@mannachef/api-contract'
import {
  checkoutSessionSchema,
  computeInvoiceTotals,
  crossField,
  cuidSchema,
  hasRoleAtLeast,
  invoiceFilterSchema,
  isoDateTimeSchema,
  lineItemAmountCents,
  manualInvoiceCreateSchema,
  MS_PER_DAY,
  subscriptionPlanCreateSchema,
  subscriptionPlanFilterSchema,
  subscriptionPlanUpdateSchema,
  subscriptionChangeSchema,
  userSubscriptionFilterSchema,
  withTemporalCoercion,
  type BillingInterval,
  type ChangeEffectiveAt,
  type InvoiceLineKind,
  type InvoiceSortBy,
  type InvoiceStatus,
  type ProrationBehavior,
  type SortDirection,
  type SubscriptionPlanSortBy,
  type SubscriptionStatus,
} from '@mannachef/validators'
import type Stripe from 'stripe'

import {
  fail,
  ok,
  type ActionFailure,
  type ActionResult,
} from '@/server/actions/types'
import { Prisma, prisma } from '@/server/db'
import {
  resolveRedemptionEligibility,
  REDEMPTION_REFUSALS,
} from '@/server/referral-eligibility'
import {
  requireAppointmentOwnership,
  requireInvoiceOwnership,
  requireSubscriptionOwnership,
  withAction,
  type AuthenticatedUser,
  type RevalidatePathTarget,
} from '@/server/guards'
import {
  getOrCreateStripeCustomer,
  getStripe,
  isStripeConfigured,
  STRIPE_CUSTOMER_USER_ID_KEY,
} from '@/server/stripe'

// =============================================================================
// 0. Cache invalidation targets
// =============================================================================

/** Editing the ladder changes the public pricing page and the admin screens. */
const PLAN_REVALIDATE_PATHS: readonly RevalidatePathTarget[] = [
  '/',
  '/pricing',
  '/portal/billing',
  '/admin/billing',
  '/admin/billing/plans',
]

/** A subscription or invoice write only moves the two billing surfaces. */
const BILLING_REVALIDATE_PATHS: readonly RevalidatePathTarget[] = [
  '/portal/billing',
  '/admin/billing',
  '/admin/billing/invoices',
]

/** Immediate expiry, so the screen that saved re-reads what it just wrote. */
const PLAN_REVALIDATE_TAGS: readonly string[] = ['subscription-plans']
const BILLING_REVALIDATE_TAGS: readonly string[] = ['billing']

// =============================================================================
// 1. Domain constants
// =============================================================================

/**
 * The statuses in which a subscriber is being served — the set that makes a
 * second checkout a conflict rather than an upsell, and the set that counts
 * towards MRR.
 */
const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAUSED',
  'UNPAID',
]

/** The statuses that earn revenue this month. `PAST_DUE` has not been paid. */
const REVENUE_BEARING_STATUSES: readonly SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
]

/** A subscription in one of these has finished; nothing may be done to it. */
const TERMINAL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'CANCELED',
  'INCOMPLETE_EXPIRED',
]

/**
 * How often one identity may move a subscription's plan.
 *
 * MCV-041's exploit was not a single call but a loop — upgrade, hold the dear
 * plan unbilled, downgrade before renewal, repeat — and the action carried no
 * limit at all. The proration policy is what makes the loop unprofitable; this
 * is what makes it slow, and it is the same defence in depth `createCheckoutSession`
 * applies to the other Stripe write a signed-in caller can reach.
 */
const SUBSCRIPTION_CHANGE_RATE_LIMIT = {
  tokens: 12,
  windowMs: 60 * 60 * 1_000,
  scope: 'identity',
} as const

/** Money that has moved, for the "collected in window" figure. */
const SETTLED_PAYMENT_STATUSES = [
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const

/**
 * The mean length of a Gregorian month, used to normalise a daily or weekly
 * plan onto a monthly axis. `30` would overstate MRR by ~1.5%.
 */
const DAYS_PER_MONTH = 365 / 12

/** The dashboard window when the caller does not name one. */
const DEFAULT_DASHBOARD_WINDOW_DAYS = 30

/**
 * How many live subscriptions the MRR pass will read before it gives up and
 * says so. A chef's book is nowhere near this; the cap exists so a dashboard
 * can never become the slowest query on the platform without anybody noticing.
 */
const MAX_MRR_ROWS = 10_000

/** How many times {@link createManualInvoice} will re-draw a house number. */
const MAX_INVOICE_NUMBER_ATTEMPTS = 6

/**
 * Two Checkout sessions for the same plan within this window are one
 * double-click, not two intentions. See {@link createCheckoutSession}.
 */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

// =============================================================================
// 2. Projections
//
// Two selects per entity. The narrower one is a strict subset, so a caller
// below ADMIN never has a Stripe handle or a private memo read into the
// process at all — "select only the columns the caller may see", made
// structural rather than remembered.
// =============================================================================

const PLAN_PUBLIC_SELECT = Prisma.validator<Prisma.SubscriptionPlanSelect>()({
  id: true,
  slug: true,
  name: true,
  tagline: true,
  description: true,
  interval: true,
  intervalCount: true,
  priceCents: true,
  currency: true,
  setupFeeCents: true,
  trialDays: true,
  mealsPerWeek: true,
  servingsPerMeal: true,
  features: true,
  isActive: true,
  isFeatured: true,
  sortOrder: true,
  createdAt: true,
})

const PLAN_ADMIN_SELECT = Prisma.validator<Prisma.SubscriptionPlanSelect>()({
  ...PLAN_PUBLIC_SELECT,
  stripePriceId: true,
  stripeProductId: true,
  updatedAt: true,
  _count: { select: { subscriptions: true } },
})

type PlanPublicRow = Prisma.SubscriptionPlanGetPayload<{
  select: typeof PLAN_PUBLIC_SELECT
}>

type PlanAdminRow = Prisma.SubscriptionPlanGetPayload<{
  select: typeof PLAN_ADMIN_SELECT
}>

/** The plan card carried inside a subscription view. */
const PLAN_SUMMARY_SELECT = Prisma.validator<Prisma.SubscriptionPlanSelect>()({
  id: true,
  slug: true,
  name: true,
  tagline: true,
  interval: true,
  intervalCount: true,
  priceCents: true,
  currency: true,
  setupFeeCents: true,
  trialDays: true,
  mealsPerWeek: true,
  servingsPerMeal: true,
  features: true,
  isFeatured: true,
})

/**
 * `stripeCustomerId` is absent on purpose and for everybody. It addresses the
 * whole customer — every other subscription, every saved card — and nothing on
 * a client, or on an admin screen, needs it to do its job.
 */
const SUBSCRIPTION_SELECT = Prisma.validator<Prisma.UserSubscriptionSelect>()({
  id: true,
  userId: true,
  planId: true,
  plan: { select: PLAN_SUMMARY_SELECT },
  stripeSubscriptionId: true,
  status: true,
  quantity: true,
  currency: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  cancelAt: true,
  canceledAt: true,
  cancellationReason: true,
  endedAt: true,
  trialEndsAt: true,
  pausedUntil: true,
  startedAt: true,
})

type SubscriptionRow = Prisma.UserSubscriptionGetPayload<{
  select: typeof SUBSCRIPTION_SELECT
}>

const INVOICE_LINE_SELECT = Prisma.validator<Prisma.InvoiceLineItemSelect>()({
  id: true,
  kind: true,
  description: true,
  quantity: true,
  unitAmountCents: true,
  amountCents: true,
  taxCents: true,
  currency: true,
  sortOrder: true,
  sourceRefId: true,
})

/** What the person being billed may read about their own bill. */
const INVOICE_CLIENT_SELECT = Prisma.validator<Prisma.InvoiceSelect>()({
  id: true,
  userId: true,
  subscriptionId: true,
  appointmentId: true,
  number: true,
  status: true,
  amountDueCents: true,
  amountPaidCents: true,
  amountRemainingCents: true,
  subtotalCents: true,
  taxCents: true,
  discountCents: true,
  currency: true,
  hostedInvoiceUrl: true,
  pdfUrl: true,
  description: true,
  issuedAt: true,
  dueAt: true,
  paidAt: true,
  voidedAt: true,
  isManual: true,
  createdAt: true,
  lineItems: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: INVOICE_LINE_SELECT,
  },
})

/** The same, plus the house's private annotations. `ADMIN` and above. */
const INVOICE_ADMIN_SELECT = Prisma.validator<Prisma.InvoiceSelect>()({
  ...INVOICE_CLIENT_SELECT,
  memo: true,
  issuedById: true,
  issuedBy: { select: { name: true } },
  stripeInvoiceId: true,
  updatedAt: true,
})

type InvoiceClientRow = Prisma.InvoiceGetPayload<{
  select: typeof INVOICE_CLIENT_SELECT
}>

type InvoiceAdminRow = Prisma.InvoiceGetPayload<{
  select: typeof INVOICE_ADMIN_SELECT
}>

// =============================================================================
// 3. Return shapes
// =============================================================================

/** The Stripe handles behind a plan. `null` for every caller below `ADMIN`. */
export interface SubscriptionPlanAdminDetailView {
  readonly stripePriceId: string
  readonly stripeProductId: string
  readonly updatedAt: Date
  /** How many subscriptions — of any status — reference this plan. */
  readonly subscriptionCount: number
}

/** One rung of the plan ladder. */
export interface SubscriptionPlanView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly tagline: string | null
  readonly description: string | null
  readonly interval: BillingInterval
  readonly intervalCount: number
  readonly priceCents: number
  readonly currency: string
  readonly setupFeeCents: number | null
  readonly trialDays: number | null
  readonly mealsPerWeek: number
  readonly servingsPerMeal: number
  readonly features: readonly string[]
  readonly isActive: boolean
  readonly isFeatured: boolean
  readonly sortOrder: number
  readonly createdAt: Date
  /** Present only for `ADMIN` and above. */
  readonly admin: SubscriptionPlanAdminDetailView | null
}

/** A page of the plan ladder. */
export interface SubscriptionPlanListView {
  readonly items: readonly SubscriptionPlanView[]
  readonly meta: PageMeta
}

/** What removing a plan acknowledges. */
export interface SubscriptionPlanDeletionView {
  readonly id: string
  readonly slug: string
  readonly name: string
}

/** The plan card carried alongside a subscription. */
export interface SubscriptionPlanSummaryView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly tagline: string | null
  readonly interval: BillingInterval
  readonly intervalCount: number
  readonly priceCents: number
  readonly currency: string
  readonly setupFeeCents: number | null
  readonly trialDays: number | null
  readonly mealsPerWeek: number
  readonly servingsPerMeal: number
  readonly features: readonly string[]
  readonly isFeatured: boolean
}

/** A `UserSubscription`, without the customer handle. */
export interface SubscriptionView {
  readonly id: string
  readonly userId: string
  readonly planId: string
  readonly plan: SubscriptionPlanSummaryView
  readonly stripeSubscriptionId: string
  readonly status: SubscriptionStatus
  readonly quantity: number
  readonly currency: string
  readonly currentPeriodStart: Date
  readonly currentPeriodEnd: Date
  readonly cancelAtPeriodEnd: boolean
  readonly cancelAt: Date | null
  readonly canceledAt: Date | null
  readonly cancellationReason: string | null
  readonly endedAt: Date | null
  readonly trialEndsAt: Date | null
  readonly pausedUntil: Date | null
  readonly startedAt: Date
}

/** A page of subscriptions. */
export interface SubscriptionListView {
  readonly items: readonly SubscriptionView[]
  readonly meta: PageMeta
}

/** Where a guest is sent to pay. */
export interface CheckoutSessionView {
  readonly sessionId: string
  /** Stripe's hosted page. Absolute, and always on Stripe's own domain. */
  readonly url: string
  readonly planId: string
  readonly planName: string
  readonly quantity: number
  readonly amountCents: number
  readonly currency: string
  /** `null` when the plan offers no trial, or the caller declined it. */
  readonly trialDays: number | null
  /** The invitation code that will be redeemed once payment confirms. */
  readonly referralCode: string | null
}

/** One line of an invoice. */
export interface InvoiceLineView {
  readonly id: string
  readonly kind: InvoiceLineKind
  readonly description: string
  readonly quantity: number
  readonly unitAmountCents: number
  readonly amountCents: number
  readonly taxCents: number
  readonly currency: string
  readonly sortOrder: number
  readonly sourceRefId: string | null
}

/** The house's private annotations. `null` for every caller below `ADMIN`. */
export interface InvoiceAdminDetailView {
  readonly memo: string | null
  readonly issuedById: string | null
  readonly issuedByName: string | null
  readonly stripeInvoiceId: string | null
  readonly updatedAt: Date
}

/** An `Invoice` with its lines. */
export interface InvoiceView {
  readonly id: string
  readonly userId: string
  readonly subscriptionId: string | null
  readonly appointmentId: string | null
  readonly number: string | null
  readonly status: InvoiceStatus
  readonly amountDueCents: number
  readonly amountPaidCents: number
  readonly amountRemainingCents: number
  readonly subtotalCents: number
  readonly taxCents: number
  readonly discountCents: number
  readonly currency: string
  readonly hostedInvoiceUrl: string | null
  readonly pdfUrl: string | null
  readonly description: string | null
  readonly issuedAt: Date | null
  readonly dueAt: Date | null
  readonly paidAt: Date | null
  readonly voidedAt: Date | null
  readonly isManual: boolean
  readonly createdAt: Date
  readonly lineItems: readonly InvoiceLineView[]
  /** Present only for `ADMIN` and above. */
  readonly admin: InvoiceAdminDetailView | null
}

/** A page of invoices. */
export interface InvoiceListView {
  readonly items: readonly InvoiceView[]
  readonly meta: PageMeta
}

/** Recurring revenue, normalised onto a monthly axis, for one currency. */
export interface BillingMrrBucketView {
  readonly currency: string
  readonly mrrCents: number
  readonly subscriptionCount: number
  readonly subscriberCount: number
}

/** Money that actually moved inside the window, for one currency. */
export interface BillingCollectedBucketView {
  readonly currency: string
  readonly grossCents: number
  readonly refundedCents: number
  readonly netCents: number
  readonly paymentCount: number
}

/** Money still owed, for one currency. */
export interface BillingOutstandingBucketView {
  readonly currency: string
  readonly invoiceCount: number
  readonly amountRemainingCents: number
  readonly overdueInvoiceCount: number
}

/** Movement in and out of the subscriber base across the window. */
export interface BillingChurnView {
  readonly subscribersAtWindowStart: number
  readonly startedInWindow: number
  readonly cancelledInWindow: number
  readonly netChange: number
  /**
   * `cancelledInWindow / subscribersAtWindowStart`, as a percentage to one
   * decimal. `null` when there was nobody to lose — a rate of "100%" computed
   * from a base of zero is a lie a dashboard should not tell.
   */
  readonly churnRatePercent: number | null
}

/** What {@link getBillingDashboard} answers. */
export interface BillingDashboardView {
  readonly windowFrom: Date
  readonly windowTo: Date
  readonly mrr: readonly BillingMrrBucketView[]
  /** Distinct users holding a `TRIALING` or `ACTIVE` subscription. */
  readonly activeSubscribers: number
  readonly subscriptionsByStatus: Readonly<Record<SubscriptionStatus, number>>
  readonly churn: BillingChurnView
  readonly collected: readonly BillingCollectedBucketView[]
  readonly outstanding: readonly BillingOutstandingBucketView[]
  /** `true` when the MRR pass hit {@link MAX_MRR_ROWS} and stopped counting. */
  readonly truncated: boolean
}

// =============================================================================
// 4. Locally composed input schemas
//
// Every domain rule this module validates against comes from
// `@mannachef/validators` and none of them is restated here. The two below
// describe *operations* rather than entities — "remove the plan with this id",
// "aggregate over this window" — and are built entirely from shared primitives.
// =============================================================================

const planIdSchema = z.strictObject({ id: cuidSchema })

const invoiceIdSchema = z.strictObject({ id: cuidSchema })

/**
 * The dashboard window.
 *
 * Both bounds coerce, because an admin screen builds this from `searchParams`
 * and a rendered-but-empty `?from=` is the string `''` rather than an absent
 * key. The ordering rule goes through `crossField` rather than `.refine()` for
 * the reason `common.ts` documents at length: `isoDateTimeSchema` is a
 * `z.ZodPipe`, a failing pipe does not abort the object around it, and a plain
 * refinement would reach `.getTime()` on the raw string — a `TypeError` out of
 * `safeParse`, which is a 500 where a 400 belongs.
 */
const billingDashboardRangeSchema = z
  .strictObject({
    from: withTemporalCoercion(isoDateTimeSchema.optional()),
    to: withTemporalCoercion(isoDateTimeSchema.optional()),
  })
  .check(
    crossField(
      {
        deps: ['from', 'to'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['to'],
      },
      ({ from, to }) => from.getTime() <= to.getTime()
    )
  )

// =============================================================================
// 5. Shared helpers
//
// Duplicated from `menu.ts` / `media.ts` rather than shared: a `'use server'`
// module may only export async functions, so a helper cannot cross between two
// of them without a third, non-action module to live in.
// =============================================================================

function buildPageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0

  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  }
}

/**
 * `true` when the caller administers billing.
 *
 * The threshold is `ADMIN`, not `CHEF_STAFF`. See the module docblock.
 */
function isBillingAdmin(role: Parameters<typeof hasRoleAtLeast>[0]): boolean {
  return hasRoleAtLeast(role, 'ADMIN')
}

function toPlanSummaryView(row: {
  id: string
  slug: string
  name: string
  tagline: string | null
  interval: BillingInterval
  intervalCount: number
  priceCents: number
  currency: string
  setupFeeCents: number | null
  trialDays: number | null
  mealsPerWeek: number
  servingsPerMeal: number
  features: string[]
  isFeatured: boolean
}): SubscriptionPlanSummaryView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    interval: row.interval,
    intervalCount: row.intervalCount,
    priceCents: row.priceCents,
    currency: row.currency,
    setupFeeCents: row.setupFeeCents,
    trialDays: row.trialDays,
    mealsPerWeek: row.mealsPerWeek,
    servingsPerMeal: row.servingsPerMeal,
    features: row.features,
    isFeatured: row.isFeatured,
  }
}

function toPublicPlanView(row: PlanPublicRow): SubscriptionPlanView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    interval: row.interval,
    intervalCount: row.intervalCount,
    priceCents: row.priceCents,
    currency: row.currency,
    setupFeeCents: row.setupFeeCents,
    trialDays: row.trialDays,
    mealsPerWeek: row.mealsPerWeek,
    servingsPerMeal: row.servingsPerMeal,
    features: row.features,
    isActive: row.isActive,
    isFeatured: row.isFeatured,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    admin: null,
  }
}

function toAdminPlanView(row: PlanAdminRow): SubscriptionPlanView {
  return {
    ...toPublicPlanView(row),
    admin: {
      stripePriceId: row.stripePriceId,
      stripeProductId: row.stripeProductId,
      updatedAt: row.updatedAt,
      subscriptionCount: row._count.subscriptions,
    },
  }
}

function toSubscriptionView(row: SubscriptionRow): SubscriptionView {
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    plan: toPlanSummaryView(row.plan),
    stripeSubscriptionId: row.stripeSubscriptionId,
    status: row.status,
    quantity: row.quantity,
    currency: row.currency,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelAt: row.cancelAt,
    canceledAt: row.canceledAt,
    cancellationReason: row.cancellationReason,
    endedAt: row.endedAt,
    trialEndsAt: row.trialEndsAt,
    pausedUntil: row.pausedUntil,
    startedAt: row.startedAt,
  }
}

function toClientInvoiceView(row: InvoiceClientRow): InvoiceView {
  return {
    id: row.id,
    userId: row.userId,
    subscriptionId: row.subscriptionId,
    appointmentId: row.appointmentId,
    number: row.number,
    status: row.status,
    amountDueCents: row.amountDueCents,
    amountPaidCents: row.amountPaidCents,
    amountRemainingCents: row.amountRemainingCents,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    discountCents: row.discountCents,
    currency: row.currency,
    hostedInvoiceUrl: row.hostedInvoiceUrl,
    pdfUrl: row.pdfUrl,
    description: row.description,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    voidedAt: row.voidedAt,
    isManual: row.isManual,
    createdAt: row.createdAt,
    lineItems: row.lineItems,
    admin: null,
  }
}

function toAdminInvoiceView(row: InvoiceAdminRow): InvoiceView {
  return {
    ...toClientInvoiceView(row),
    admin: {
      memo: row.memo,
      issuedById: row.issuedById,
      issuedByName: row.issuedBy?.name ?? null,
      stripeInvoiceId: row.stripeInvoiceId,
      updatedAt: row.updatedAt,
    },
  }
}

/** Seconds since the epoch, as Stripe counts time. */
function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000)
}

/** `null` for a Stripe timestamp that is absent. */
function fromUnixSeconds(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value * 1000)
}

/**
 * The origin this deployment answers on, from `NEXT_PUBLIC_APP_URL`.
 *
 * Returns `null` when the variable is missing or unparseable, which
 * {@link createCheckoutSession} treats as a deployment fault rather than as
 * permission to accept any return address at all.
 */
function appOrigin(): string | null {
  const raw = process.env['NEXT_PUBLIC_APP_URL']

  if (raw === undefined || raw.trim().length === 0) {
    return null
  }

  try {
    return new URL(raw.trim()).origin
  } catch {
    return null
  }
}

/**
 * `true` when `candidate` points at our own origin.
 *
 * `urlSchema` has already proved the string is an absolute `http(s)` address;
 * what it cannot know is whether it is *ours*. An unchecked `successUrl` is an
 * open redirect signed by Stripe: a guest completes a genuine payment and is
 * then delivered to somebody else's page, with our brand behind them.
 */
function isOwnOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === origin
  } catch {
    return false
  }
}

/**
 * How Stripe spells a plan's renewal cadence.
 *
 * Stripe has no quarterly interval, so a quarter is three months — which is
 * exactly how Stripe itself models it. Returning the pair lets
 * {@link assertStripePriceMatches} compare a plan against its price without
 * either side having to know about the other's vocabulary.
 */
function stripeRecurrenceFor(
  interval: BillingInterval,
  intervalCount: number
): { interval: 'day' | 'week' | 'month' | 'year'; count: number } {
  switch (interval) {
    case 'DAY':
      return { interval: 'day', count: intervalCount }

    case 'WEEK':
      return { interval: 'week', count: intervalCount }

    case 'MONTH':
      return { interval: 'month', count: intervalCount }

    case 'QUARTER':
      return { interval: 'month', count: intervalCount * 3 }

    case 'YEAR':
      return { interval: 'year', count: intervalCount * 12 }

    default: {
      // A new member of `billingIntervalSchema` is a compile error here rather
      // than a plan that silently bills on the wrong cadence.
      const exhaustive: never = interval
      return exhaustive
    }
  }
}

/** How many months one billing period of this plan spans. */
function monthsPerPeriod(
  interval: BillingInterval,
  intervalCount: number
): number {
  switch (interval) {
    case 'DAY':
      return intervalCount / DAYS_PER_MONTH

    case 'WEEK':
      return (intervalCount * 7) / DAYS_PER_MONTH

    case 'MONTH':
      return intervalCount

    case 'QUARTER':
      return intervalCount * 3

    case 'YEAR':
      return intervalCount * 12

    default: {
      const exhaustive: never = interval
      return exhaustive
    }
  }
}

/** The plan shape {@link assertStripePriceMatches} compares against Stripe. */
interface PlanPricingFacts {
  readonly stripePriceId: string
  readonly stripeProductId: string
  readonly priceCents: number
  readonly currency: string
  readonly interval: BillingInterval
  readonly intervalCount: number
}

/**
 * Refuse to save a plan whose figures disagree with the Stripe price it names.
 *
 * The plan card is a promise and the Stripe price is the charge. When the two
 * drift apart the guest is quoted one amount and billed another, silently, with
 * no error anywhere — so the two are compared before the row is written rather
 * than after somebody complains.
 *
 * Returns `null` when everything agrees, or the failure to hand straight back.
 * Skipped entirely when `STRIPE_SECRET_KEY` is absent: the marketing site and
 * the seed scripts must run without it, and a plan saved in that environment is
 * re-checked the moment it is edited on a deployment that has the key.
 *
 * A Stripe call that throws is *not* converted into a "your figures are wrong"
 * message — that would blame the operator for our outage. It is left to
 * propagate into `withAction`, which logs the real cause and answers `INTERNAL`.
 */
async function assertStripePriceMatches(
  plan: PlanPricingFacts
): Promise<ActionFailure | null> {
  if (!isStripeConfigured()) {
    return null
  }

  const price = await getStripe().prices.retrieve(plan.stripePriceId)

  if (!price.active) {
    return fail(
      'VALIDATION',
      'That Stripe price is archived, so nobody could be billed on it.',
      { stripePriceId: ['That Stripe price is archived.'] }
    )
  }

  const productId =
    typeof price.product === 'string' ? price.product : price.product.id

  if (productId !== plan.stripeProductId) {
    return fail(
      'VALIDATION',
      'That Stripe price belongs to a different product.',
      {
        stripeProductId: ['That Stripe price belongs to a different product.'],
      }
    )
  }

  if (price.unit_amount !== plan.priceCents) {
    return fail(
      'VALIDATION',
      'The price on this plan does not match the Stripe price it points at. Correct one of the two before saving.',
      { priceCents: ['This does not match the amount configured in Stripe.'] }
    )
  }

  if (price.currency.toUpperCase() !== plan.currency) {
    return fail(
      'VALIDATION',
      'The currency on this plan does not match the Stripe price it points at.',
      { currency: ['This does not match the currency configured in Stripe.'] }
    )
  }

  const expected = stripeRecurrenceFor(plan.interval, plan.intervalCount)
  const recurring = price.recurring

  if (
    recurring === null ||
    recurring.interval !== expected.interval ||
    recurring.interval_count !== expected.count
  ) {
    return fail(
      'VALIDATION',
      'The renewal cadence on this plan does not match the Stripe price it points at.',
      { interval: ['This does not match the cadence configured in Stripe.'] }
    )
  }

  return null
}

/**
 * The columns a `P2002` names, or `null` when the error is not a unique
 * violation at all.
 *
 * An empty array means Prisma reported the violation without a `meta.target`,
 * which some drivers do. Callers treat that as "the column I was writing",
 * which is sound only where exactly one unique column is in play — see
 * {@link isInvoiceNumberCollision}.
 */
function uniqueViolationTargets(error: unknown): readonly string[] | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return null
  }

  const target = error.meta?.['target']

  if (typeof target === 'string') {
    return [target]
  }

  if (Array.isArray(target)) {
    return target.filter((entry): entry is string => typeof entry === 'string')
  }

  return []
}

/**
 * `true` when a failed invoice insert collided on `Invoice.number`.
 *
 * `number` is the only unique column {@link createManualInvoice} populates —
 * `stripeInvoiceId` is left null, and Postgres does not collide nulls — so an
 * un-targeted `P2002` can only be this one.
 */
function isInvoiceNumberCollision(error: unknown): boolean {
  const targets = uniqueViolationTargets(error)

  if (targets === null) {
    return false
  }

  return targets.length === 0 || targets.includes('number')
}

/**
 * The next house invoice number, `MC-2026-0148`.
 *
 * Derived from a count rather than a sequence, so it is inherently racy — two
 * admins raising an invoice in the same second can draw the same number. That
 * is why {@link createManualInvoice} writes inside a retry loop and lets the
 * unique index on `Invoice.number` be the arbiter: the loser re-counts and
 * takes the next one. A Postgres sequence would be tidier and is the obvious
 * follow-up, but it needs a migration this task does not own.
 */
async function nextInvoiceNumber(db: typeof prisma): Promise<string> {
  const year = new Date().getUTCFullYear()
  const prefix = `MC-${year}-`

  const issuedThisYear = await db.invoice.count({
    where: { number: { startsWith: prefix } },
  })

  return `${prefix}${String(issuedThisYear + 1).padStart(4, '0')}`
}

// =============================================================================
// 6. Subscription plans — CRUD
// =============================================================================

function planOrderBy(
  sortBy: SubscriptionPlanSortBy,
  direction: SortDirection
): Prisma.SubscriptionPlanOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'SORT_ORDER':
      return [{ sortOrder: direction }, { priceCents: 'asc' }, { id: 'asc' }]

    case 'PRICE':
      return [{ priceCents: direction }, { id: 'asc' }]

    case 'NAME':
      return [{ name: direction }, { id: 'asc' }]

    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    default: {
      // A new member of `subscriptionPlanSortBySchema` is a compile error here
      // rather than a silently unordered ladder.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * Browse the plan ladder.
 *
 * Public, because the pricing page is public. Two things narrow by role:
 *
 *  - **`isActive` is pinned to `true` below `ADMIN`.** The filter's own default
 *    is already `true`, but a default is a suggestion and this is a rule: no
 *    arrangement of query parameters surfaces a plan we have closed. An admin
 *    is honoured as asked.
 *  - **The Stripe handles are only read for `ADMIN`.** The two branches differ
 *    solely in their `select`, and that difference *is* the access control —
 *    the public branch cannot leak a price id because it never reads one.
 *
 * No rate limit, for the same reason as `menu.list`: this runs during static
 * generation, where `headers()` yields no address and every anonymous render
 * would share one bucket.
 */
export const listSubscriptionPlans = withAction(
  {
    name: 'plan.list',
    auth: 'PUBLIC',
    input: subscriptionPlanFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<SubscriptionPlanListView>> => {
    const mayAdminister = isBillingAdmin(ctx.user?.role ?? null)

    const filters: Prisma.SubscriptionPlanWhereInput[] = [
      { isActive: mayAdminister ? filter.isActive : true },
    ]

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { tagline: { contains: filter.search, mode: 'insensitive' } },
          { slug: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    if (filter.intervals.length > 0) {
      filters.push({ interval: { in: [...filter.intervals] } })
    }

    if (filter.featuredOnly) {
      filters.push({ isFeatured: true })
    }

    if (filter.minPriceCents !== undefined) {
      filters.push({ priceCents: { gte: filter.minPriceCents } })
    }

    if (filter.maxPriceCents !== undefined) {
      filters.push({ priceCents: { lte: filter.maxPriceCents } })
    }

    const where: Prisma.SubscriptionPlanWhereInput = { AND: filters }
    const orderBy = planOrderBy(filter.sortBy, filter.sortDirection)
    const skip = (filter.page - 1) * filter.pageSize
    const take = filter.pageSize

    const total = await ctx.db.subscriptionPlan.count({ where })

    if (mayAdminister) {
      const rows = await ctx.db.subscriptionPlan.findMany({
        where,
        select: PLAN_ADMIN_SELECT,
        orderBy,
        skip,
        take,
      })

      return ok({
        items: rows.map(toAdminPlanView),
        meta: buildPageMeta(filter.page, filter.pageSize, total),
      })
    }

    const rows = await ctx.db.subscriptionPlan.findMany({
      where,
      select: PLAN_PUBLIC_SELECT,
      orderBy,
      skip,
      take,
    })

    return ok({
      items: rows.map(toPublicPlanView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * Add a rung to the ladder. `ADMIN` and above.
 *
 * `subscriptionPlanCreateSchema` has already refused a plan that offers a trial
 * while closed to enrolment, a duplicate inclusion, and a Stripe reference of
 * the wrong shape. What is left for the handler is the three things a schema
 * cannot know: that the slug is free, that the Stripe price is free, and that
 * the Stripe price actually charges what the card promises.
 */
export const createSubscriptionPlan = withAction(
  {
    name: 'plan.create',
    auth: 'ADMIN',
    input: subscriptionPlanCreateSchema,
    revalidatePaths: PLAN_REVALIDATE_PATHS,
    revalidateTags: PLAN_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<SubscriptionPlanView>> => {
    const clash = await ctx.db.subscriptionPlan.findFirst({
      where: {
        OR: [{ slug: input.slug }, { stripePriceId: input.stripePriceId }],
      },
      select: { id: true, slug: true, stripePriceId: true },
    })

    if (clash !== null) {
      return clash.slug === input.slug
        ? fail('CONFLICT', 'A plan already uses that web address.', {
            slug: ['A plan already uses that web address.'],
          })
        : fail(
            'CONFLICT',
            'Another plan is already sold on that Stripe price.',
            {
              stripePriceId: [
                'Another plan is already sold on that Stripe price.',
              ],
            }
          )
    }

    const mismatch = await assertStripePriceMatches(input)

    if (mismatch !== null) {
      return mismatch
    }

    const created = await ctx.db.subscriptionPlan.create({
      data: {
        slug: input.slug,
        name: input.name,
        tagline: input.tagline ?? null,
        description: input.description ?? null,
        stripePriceId: input.stripePriceId,
        stripeProductId: input.stripeProductId,
        interval: input.interval,
        intervalCount: input.intervalCount,
        priceCents: input.priceCents,
        currency: input.currency,
        setupFeeCents: input.setupFeeCents ?? null,
        trialDays: input.trialDays ?? null,
        mealsPerWeek: input.mealsPerWeek,
        servingsPerMeal: input.servingsPerMeal,
        features: [...input.features],
        isActive: input.isActive,
        isFeatured: input.isFeatured,
        sortOrder: input.sortOrder,
      },
      select: PLAN_ADMIN_SELECT,
    })

    return ok(toAdminPlanView(created))
  }
)

/**
 * Amend a rung. `ADMIN` and above.
 *
 * `subscriptionPlanUpdateSchema` is built by `buildUpdateSchema`, so it has
 * already stripped the base schema's defaults before making the rest optional —
 * correcting a tagline cannot silently re-open a closed plan or reset its
 * currency. Every field below is therefore written only when the caller
 * actually sent it.
 *
 * The Stripe cross-check runs against the plan **as it will be**, merging the
 * amendment over the stored row, so changing only the price still verifies that
 * price against the Stripe price the plan already pointed at.
 */
export const updateSubscriptionPlan = withAction(
  {
    name: 'plan.update',
    auth: 'ADMIN',
    input: subscriptionPlanUpdateSchema,
    revalidatePaths: PLAN_REVALIDATE_PATHS,
    revalidateTags: PLAN_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<SubscriptionPlanView>> => {
    const existing = await ctx.db.subscriptionPlan.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        slug: true,
        stripePriceId: true,
        stripeProductId: true,
        priceCents: true,
        currency: true,
        interval: true,
        intervalCount: true,
      },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That plan is no longer on the ladder.')
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const slugClash = await ctx.db.subscriptionPlan.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      })

      if (slugClash !== null && slugClash.id !== existing.id) {
        return fail('CONFLICT', 'A plan already uses that web address.', {
          slug: ['A plan already uses that web address.'],
        })
      }
    }

    if (
      input.stripePriceId !== undefined &&
      input.stripePriceId !== existing.stripePriceId
    ) {
      const priceClash = await ctx.db.subscriptionPlan.findUnique({
        where: { stripePriceId: input.stripePriceId },
        select: { id: true },
      })

      if (priceClash !== null && priceClash.id !== existing.id) {
        return fail(
          'CONFLICT',
          'Another plan is already sold on that Stripe price.',
          {
            stripePriceId: [
              'Another plan is already sold on that Stripe price.',
            ],
          }
        )
      }
    }

    const mismatch = await assertStripePriceMatches({
      stripePriceId: input.stripePriceId ?? existing.stripePriceId,
      stripeProductId: input.stripeProductId ?? existing.stripeProductId,
      priceCents: input.priceCents ?? existing.priceCents,
      currency: input.currency ?? existing.currency,
      interval: input.interval ?? existing.interval,
      intervalCount: input.intervalCount ?? existing.intervalCount,
    })

    if (mismatch !== null) {
      return mismatch
    }

    const updated = await ctx.db.subscriptionPlan.update({
      where: { id: existing.id },
      data: {
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.tagline !== undefined && { tagline: input.tagline }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.stripePriceId !== undefined && {
          stripePriceId: input.stripePriceId,
        }),
        ...(input.stripeProductId !== undefined && {
          stripeProductId: input.stripeProductId,
        }),
        ...(input.interval !== undefined && { interval: input.interval }),
        ...(input.intervalCount !== undefined && {
          intervalCount: input.intervalCount,
        }),
        ...(input.priceCents !== undefined && { priceCents: input.priceCents }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.setupFeeCents !== undefined && {
          setupFeeCents: input.setupFeeCents,
        }),
        ...(input.trialDays !== undefined && { trialDays: input.trialDays }),
        ...(input.mealsPerWeek !== undefined && {
          mealsPerWeek: input.mealsPerWeek,
        }),
        ...(input.servingsPerMeal !== undefined && {
          servingsPerMeal: input.servingsPerMeal,
        }),
        ...(input.features !== undefined && { features: [...input.features] }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.isFeatured !== undefined && { isFeatured: input.isFeatured }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
      select: PLAN_ADMIN_SELECT,
    })

    return ok(toAdminPlanView(updated))
  }
)

/**
 * Remove a rung. `ADMIN` and above.
 *
 * **Refuses while any subscription references the plan**, and says how many.
 * `UserSubscription.plan` is `onDelete: Restrict`, so the database would refuse
 * too — but it would refuse with a foreign key violation that `withAction` can
 * only render as "something this depends on is missing or still in use", which
 * tells an operator nothing about what to do next. This check exists so the
 * refusal names the number and points at the alternative.
 *
 * The alternative is almost always the right answer: closing a plan to
 * enrolment (`isActive: false`) keeps every historical invoice legible, whereas
 * deleting the row would strand them.
 */
export const deleteSubscriptionPlan = withAction(
  {
    name: 'plan.delete',
    auth: 'ADMIN',
    input: planIdSchema,
    revalidatePaths: PLAN_REVALIDATE_PATHS,
    revalidateTags: PLAN_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<SubscriptionPlanDeletionView>> => {
    const existing = await ctx.db.subscriptionPlan.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        slug: true,
        name: true,
        _count: { select: { subscriptions: true } },
      },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That plan is no longer on the ladder.')
    }

    if (existing._count.subscriptions > 0) {
      const count = existing._count.subscriptions

      return fail(
        'CONFLICT',
        `${count} ${count === 1 ? 'subscription references' : 'subscriptions reference'} this plan, so it cannot be removed. Close it to enrolment instead — every past invoice stays legible that way.`,
        {
          id: [
            'This plan is still referenced by a subscription. Close it to enrolment instead.',
          ],
        }
      )
    }

    await ctx.db.subscriptionPlan.delete({ where: { id: existing.id } })

    return ok({ id: existing.id, slug: existing.slug, name: existing.name })
  }
)

// =============================================================================
// 7. Checkout
// =============================================================================

/**
 * Open a Stripe Checkout session for the signed-in caller.
 *
 * ## The payer is the session, never the payload
 *
 * `checkoutSessionSchema` has no field for a customer, a user, or an amount,
 * and this handler adds none: the Stripe customer is resolved from
 * `ctx.user.id` through {@link getOrCreateStripeCustomer}, and the price is the
 * plan's `stripePriceId` read from our own row. A caller chooses a plan. That
 * is the entire extent of their say in what they are charged.
 *
 * ## Both return addresses are checked against our own origin
 *
 * `urlSchema` proves `successUrl` and `cancelUrl` are absolute `http(s)`
 * addresses; it cannot know whether they are *ours*. An unchecked one is an
 * open redirect with a completed payment behind it — the guest pays us and
 * lands on somebody else's page. Both are therefore compared against the origin
 * in `NEXT_PUBLIC_APP_URL`, and a deployment with no such variable refuses to
 * open a session at all rather than accepting anything.
 *
 * ## A trial may be declined or shortened, never lengthened
 *
 * `checkoutSessionSchema.trialDays` is documented as an override, and this is
 * where the limit is enforced: a value above the plan's own trial is refused
 * rather than clamped, because silently giving somebody less than they asked
 * for is how a support conversation starts.
 *
 * ## The invitation code is validated here and redeemed by the webhook
 *
 * A `ReferralCode` carries a reward *value* (`rewardValueCents`,
 * `rewardValuePercent`), not a Stripe coupon id — the schema has no column for
 * one, and inventing a coupon per code would make Stripe a second source of
 * truth for the growth ledger. So the code is checked for validity here, where
 * a bad one can still be reported on the form, and carried into the session's
 * metadata so the webhook can write the `ReferralRedemption` once money has
 * actually changed hands. Stripe's own promotion codes remain available to the
 * guest through `allow_promotion_codes`, which is a different mechanism for a
 * different purpose.
 *
 * ## Rate limited
 *
 * Opening a Checkout session is a write against Stripe on our account's quota,
 * reachable by anybody with a session. Five in ten minutes is generous for a
 * person and useless to a script.
 */
export const createCheckoutSession = withAction(
  {
    name: 'billing.checkout.create',
    auth: 'SESSION',
    input: checkoutSessionSchema,
    rateLimit: { tokens: 5, windowMs: 10 * 60 * 1000, scope: 'identity' },
  },
  async (ctx, input): Promise<ActionResult<CheckoutSessionView>> => {
    const origin = appOrigin()

    if (origin === null) {
      console.error(
        `[action:${ctx.actionName}] NEXT_PUBLIC_APP_URL is missing or unparseable; refusing to open a Checkout session.`
      )

      return fail(
        'INTERNAL',
        'Checkout is unavailable at the moment. Please try again shortly.'
      )
    }

    if (!isOwnOrigin(input.successUrl, origin)) {
      return fail(
        'VALIDATION',
        'Guests must be returned to MannaChef after paying.',
        { successUrl: ['This address does not belong to MannaChef.'] }
      )
    }

    if (!isOwnOrigin(input.cancelUrl, origin)) {
      return fail(
        'VALIDATION',
        'Guests must be returned to MannaChef if they change their mind.',
        { cancelUrl: ['This address does not belong to MannaChef.'] }
      )
    }

    const plan = await ctx.db.subscriptionPlan.findUnique({
      where: { id: input.planId },
      select: {
        id: true,
        name: true,
        stripePriceId: true,
        priceCents: true,
        currency: true,
        trialDays: true,
        isActive: true,
      },
    })

    if (plan === null || !plan.isActive) {
      return fail('NOT_FOUND', 'That plan is no longer open for enrolment.', {
        planId: ['That plan is no longer open for enrolment.'],
      })
    }

    // A second subscription would bill the same household twice. Changing plan
    // is `changeSubscription`, which prorates; this is not that.
    const live = await ctx.db.userSubscription.findFirst({
      where: {
        userId: ctx.user.id,
        status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
      },
      select: { id: true },
    })

    if (live !== null) {
      return fail(
        'CONFLICT',
        'You already have a subscription with us. Change your plan from the billing page rather than starting a second one.'
      )
    }

    const trialDays = resolveTrialDays(plan.trialDays, input.trialDays)

    if (trialDays === 'TOO_LONG') {
      return fail('VALIDATION', 'This plan does not offer a trial that long.', {
        trialDays: [
          plan.trialDays === null
            ? 'This plan does not include a trial.'
            : `This plan includes a trial of up to ${plan.trialDays} days.`,
        ],
      })
    }

    const referral = await resolveReferralCode(
      ctx.db,
      ctx.user.id,
      input.referralCode
    )

    if (referral !== null && 'failure' in referral) {
      return referral.failure
    }

    const { customerId } = await getOrCreateStripeCustomer(ctx.user.id)

    const metadata: Record<string, string> = {
      [STRIPE_CUSTOMER_USER_ID_KEY]: ctx.user.id,
      mannachefPlanId: plan.id,
    }

    if (referral !== null) {
      metadata['mannachefReferralCodeId'] = referral.id
      metadata['mannachefReferralCode'] = referral.code
    }

    const session = await getStripe().checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: ctx.user.id,
        line_items: [{ price: plan.stripePriceId, quantity: input.quantity }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: input.allowPromotionCodes,
        metadata,
        subscription_data: {
          metadata,
          ...(trialDays !== null && trialDays > 0
            ? { trial_period_days: trialDays }
            : {}),
        },
      },
      {
        // A double-clicked button must not open two sessions and two
        // half-finished subscriptions. The key is bucketed rather than fixed:
        // a guest who genuinely abandons checkout and comes back later gets a
        // fresh session instead of Stripe replaying an expired one.
        idempotencyKey: `mannachef-checkout-${ctx.user.id}-${plan.id}-${Math.floor(
          Date.now() / CHECKOUT_IDEMPOTENCY_WINDOW_MS
        )}`,
      }
    )

    if (session.url === null) {
      console.error(
        `[action:${ctx.actionName}] Stripe returned a session with no hosted URL (session ${session.id}).`
      )

      return fail(
        'INTERNAL',
        'Checkout is unavailable at the moment. Please try again shortly.'
      )
    }

    return ok({
      sessionId: session.id,
      url: session.url,
      planId: plan.id,
      planName: plan.name,
      quantity: input.quantity,
      amountCents: plan.priceCents * input.quantity,
      currency: plan.currency,
      trialDays: trialDays === null || trialDays === 0 ? null : trialDays,
      referralCode: referral?.code ?? null,
    })
  }
)

/**
 * The trial the session should carry.
 *
 * `null` means no trial. `'TOO_LONG'` means the caller asked for more than the
 * plan offers, which is refused rather than clamped — see
 * {@link createCheckoutSession}.
 */
function resolveTrialDays(
  planTrialDays: number | null,
  requested: number | undefined
): number | null | 'TOO_LONG' {
  if (requested === undefined) {
    return planTrialDays
  }

  if (requested === 0) {
    return null
  }

  if (planTrialDays === null || requested > planTrialDays) {
    return 'TOO_LONG'
  }

  return requested
}

/** What {@link resolveReferralCode} proved, or why it would not. */
interface ResolvedReferralCode {
  readonly id: string
  readonly code: string
}

/**
 * Check an invitation code on the caller's behalf.
 *
 * Returns `null` when no code was offered, the resolved code when it is
 * genuinely redeemable, or a `{ failure }` envelope to hand straight back. Each
 * way a code fails is the caller's to fix, so each one gets its own sentence on
 * the `referralCode` field.
 *
 * ## The rules are not this module's (MCV-041, finding F)
 *
 * They are {@link resolveRedemptionEligibility}'s, shared with the portal's
 * redemption form and with the Stripe webhook that does the actual write. This
 * function used to restate a *subset* of them inline — it checked the owner's
 * identity, the expiry, the cap and the same-code rule, and omitted
 * `sharesEmailIdentity` and the one-live-redemption rule entirely. So the
 * cheapest self-referral there is, a plus-addressed second account, was refused
 * by the portal and waved through by Checkout, and the webhook downstream
 * checked fewer rules still. Two definitions of "valid redemption" is the
 * defect; there is now one.
 *
 * The household heuristic applies here whatever the caller's role, because
 * `createCheckoutSession` is the caller paying for **their own** subscription —
 * there is no "acting for somebody else" case for an `ADMIN` to need the escape
 * hatch on. An administrator arranging a redemption by hand goes through
 * `redeemReferralCode`, which has one.
 *
 * Nothing is written here. Eligibility can lapse between opening a session and
 * paying for it, so the webhook re-runs the same predicate before it writes.
 */
async function resolveReferralCode(
  db: typeof prisma,
  userId: string,
  code: string | undefined
): Promise<ResolvedReferralCode | { failure: ActionFailure } | null> {
  if (code === undefined) {
    return null
  }

  const eligibility = await resolveRedemptionEligibility(
    db,
    { kind: 'code', code },
    userId,
    {
      applyHouseholdHeuristic: true,
      // Now, because nothing has been paid yet: this runs while the session is
      // being opened. The webhook that eventually writes the redemption anchors
      // it to `session.created`, which is this same moment give or take the
      // round trip to Stripe — deliberately, so the invoice this session is
      // about does not read as prior custom to the rule that judged it here.
      // See `RedemptionEligibilityOptions.establishedAt`.
      establishedAt: new Date(),
    }
  )

  if (eligibility.kind === 'refused') {
    const terms = REDEMPTION_REFUSALS[eligibility.reason]

    return {
      failure:
        terms.code === 'NOT_FOUND'
          ? fail('NOT_FOUND', terms.message)
          : fail('VALIDATION', terms.message, {
              referralCode: [terms.message],
            }),
    }
  }

  return { id: eligibility.code.id, code: eligibility.code.code }
}

// =============================================================================
// 8. Subscriptions — reading
// =============================================================================

/**
 * The subscriptions a caller is entitled to.
 *
 * ## The filter is a request, not a permission
 *
 * `userSubscriptionFilterSchema` lets a caller name a `userId`. Below `ADMIN`
 * it is **overridden** with the session user rather than honoured — which is
 * the whole difference between a filter and an access-control decision. A
 * `CHEF_STAFF` caller is pinned exactly as a `CLIENT` is: money is not a chef's
 * concern, and the ownership guard for `subscription` draws the same line.
 */
export const listSubscriptions = withAction(
  {
    name: 'subscription.read',
    auth: 'SESSION',
    input: userSubscriptionFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<SubscriptionListView>> => {
    const filters: Prisma.UserSubscriptionWhereInput[] = []

    if (isBillingAdmin(ctx.user.role)) {
      if (filter.userId !== undefined) {
        filters.push({ userId: filter.userId })
      }
    } else {
      filters.push({ userId: ctx.user.id })
    }

    if (filter.planId !== undefined) {
      filters.push({ planId: filter.planId })
    }

    if (filter.statuses.length > 0) {
      filters.push({ status: { in: [...filter.statuses] } })
    }

    if (filter.cancellingOnly) {
      filters.push({ cancelAtPeriodEnd: true })
    }

    if (filter.pausedOnly) {
      filters.push({ status: 'PAUSED' })
    }

    if (filter.renewingFrom !== undefined) {
      filters.push({ currentPeriodEnd: { gte: filter.renewingFrom } })
    }

    if (filter.renewingUntil !== undefined) {
      filters.push({ currentPeriodEnd: { lte: filter.renewingUntil } })
    }

    const where: Prisma.UserSubscriptionWhereInput = { AND: filters }
    const skip = (filter.page - 1) * filter.pageSize
    const take = filter.pageSize

    const [rows, total] = await Promise.all([
      ctx.db.userSubscription.findMany({
        where,
        select: SUBSCRIPTION_SELECT,
        orderBy: [{ createdAt: filter.sortDirection }, { id: 'asc' }],
        skip,
        take,
      }),
      ctx.db.userSubscription.count({ where }),
    ])

    return ok({
      items: rows.map(toSubscriptionView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 9. Subscriptions — the lifecycle
// =============================================================================

/** The two commercial terms of a plan move, after policy has had its say. */
interface SubscriptionChangeTerms {
  readonly effectiveAt: ChangeEffectiveAt
  readonly prorationBehavior: ProrationBehavior
  /**
   * `true` when the caller's `effectiveAt` or `prorationBehavior` was
   * discarded. Logged rather than returned: the substitution is policy, not an
   * error, and telling a browser which of its fields were ignored is a map of
   * where to push next.
   */
  readonly overridden: boolean
}

/**
 * What Stripe is actually told about a plan move, as opposed to what the
 * browser asked for (MCV-041).
 *
 * `subscriptionChangeSchema` accepts `effectiveAt` and `prorationBehavior` from
 * the caller, and both were forwarded to Stripe untouched. Neither is a
 * preference: together they decide **whether the difference in price is
 * billed**, and the item's `price` is swapped immediately either way — there is
 * no branch anywhere in this action that defers the swap. `PERIOD_END`
 * therefore never delayed anything; it only suppressed the invoice, and
 * `prorationBehavior: 'none'` did the same thing by the shorter route.
 *
 * So a `CLIENT` on a $50 plan could post
 * `{ action: 'UPGRADE', planId: <$500 plan>, prorationBehavior: 'none' }`,
 * receive the dear plan at once, be charged nothing for the remainder of the
 * period, and then move back down before renewal — which swaps the price again,
 * so even the renewal is raised at the cheap rate. Repeated, that is a premium
 * plan held indefinitely at the entry price.
 *
 * The direction checks in {@link changeSubscription} already refuse the
 * mirror-image of this through `DOWNGRADE`; this function closes the same
 * outcome through `UPGRADE`, and takes both fields away from everybody below
 * `ADMIN` on both arms.
 *
 * ## An upgrade always prorates, for everybody
 *
 * Not `privileged ? … : …`. A price rise that bills nothing is a gift of the
 * unbilled remainder, and it is one Stripe records nowhere — no invoice line,
 * no credit note, nothing naming who decided. An `ADMIN` who means to make that
 * gift has instruments that do leave a record ({@link createManualInvoice}, and
 * the reward ledger in `actions/referral.ts`), so nothing is lost but the
 * silence. `effectiveAt` is forced to `IMMEDIATELY` alongside it because the
 * upgrade *is* immediate — saying `PERIOD_END` over the top of an immediate
 * price swap was only ever a way of spelling "and do not bill me".
 *
 * ## A downgrade below `ADMIN` takes the house's terms
 *
 * `PERIOD_END` and `none`: the subscriber keeps everything the period they have
 * already paid for entitles them to, and the lighter price applies from the
 * next invoice. Those are the schema's own defaults for the arm — the
 * difference is that they are now the house's decision rather than a value the
 * browser happened not to override. An `ADMIN` still states both per change,
 * which is what makes a hand-arranged settlement possible at all.
 */
function resolveSubscriptionChangeTerms(
  action: 'UPGRADE' | 'DOWNGRADE',
  requested: {
    readonly effectiveAt: ChangeEffectiveAt
    readonly prorationBehavior: ProrationBehavior
  },
  privileged: boolean
): SubscriptionChangeTerms {
  if (action === 'UPGRADE') {
    return {
      effectiveAt: 'IMMEDIATELY',
      prorationBehavior: 'create_prorations',
      overridden:
        requested.effectiveAt !== 'IMMEDIATELY' ||
        requested.prorationBehavior !== 'create_prorations',
    }
  }

  if (privileged) {
    return {
      effectiveAt: requested.effectiveAt,
      prorationBehavior: requested.prorationBehavior,
      overridden: false,
    }
  }

  return {
    effectiveAt: 'PERIOD_END',
    prorationBehavior: 'none',
    overridden:
      requested.effectiveAt !== 'PERIOD_END' ||
      requested.prorationBehavior !== 'none',
  }
}

/**
 * What Stripe's `proration_behavior` is set to for a resolved set of terms.
 *
 * The `PERIOD_END → 'none'` mapping is the one described on
 * {@link changeSubscription}, kept here so that the single expression Stripe is
 * handed cannot drift from the terms policy just decided.
 */
function prorationBehaviorFor(
  terms: SubscriptionChangeTerms
): Stripe.SubscriptionUpdateParams.ProrationBehavior {
  return terms.effectiveAt === 'PERIOD_END' ? 'none' : terms.prorationBehavior
}

/**
 * Upgrade, downgrade, pause, resume, or cancel a subscription.
 *
 * One action rather than five, because `subscriptionChangeSchema` is one
 * discriminated union and `subscription.change` is one route in
 * `@mannachef/api-contract`. Each arm carries exactly the arguments its move
 * needs, and the `switch` below is exhaustive — a sixth move added to the union
 * is a compile error here rather than a silently ignored request.
 *
 * ## Ownership is the first statement
 *
 * `input.subscriptionId` arrives from a browser and is therefore a claim.
 * {@link requireSubscriptionOwnership} turns it into a fact with a real
 * `SELECT`, denies with `NOT_FOUND` so the action cannot be used to enumerate
 * subscription ids, and hands back the two Stripe references the Stripe call
 * needs — so there is no second read that could resolve to a different row.
 *
 * A `CLIENT` may only ever act on their own. An `ADMIN` may act for anybody,
 * through the guard's documented bypass.
 *
 * ## Ownership is not the whole of the authorisation (MCV-041)
 *
 * It was, and that was the bug. Owning a subscription says which row may be
 * changed; it says nothing about *on what terms*. Three fields on the two plan
 * arms decide the terms and all three arrived from the browser —
 * `effectiveAt`, `prorationBehavior` and `quantity`. Below `ADMIN` none of them
 * is now read: the first two come from
 * {@link resolveSubscriptionChangeTerms} and the third stays at whatever the
 * subscription already carries. This is the shape `actions/referral.ts` and
 * `actions/booking.ts` use for every other server-owned figure — the payload is
 * accepted, and then the value that costs money is taken from the house.
 *
 * ## How `PERIOD_END` is expressed to Stripe
 *
 * Stripe has no "change the price later" flag short of a subscription schedule.
 * What it has is `proration_behavior: 'none'`, which swaps the item's price
 * immediately while charging nothing for the remainder of the current period —
 * so the subscriber keeps everything they have already paid for and the new
 * rate applies from the next invoice. That is precisely the guarantee
 * `changeEffectiveAtSchema` documents for `PERIOD_END`, so the two are mapped
 * onto each other by {@link prorationBehaviorFor} and the `prorationBehavior`
 * of the resolved terms is overridden. On `IMMEDIATELY` the resolved terms
 * stand.
 *
 * Note what that mapping does **not** do: it does not defer the plan. The
 * `items` update below swaps `price` unconditionally, so `PERIOD_END` has
 * always meant "now, but do not bill for the remainder". An upgrade is
 * therefore never `PERIOD_END`, whoever asks.
 *
 * ## Rate limited
 *
 * Each plan move is a write against Stripe on our account's quota, and MCV-041
 * turned on repeating one. Twelve an hour per identity is more changes of mind
 * than a household has and few enough that a loop is pointless.
 *
 * ## How a pause is expressed to Stripe
 *
 * `pause_collection` with `behavior: 'void'`, which stops collecting without
 * ending the subscription. Note that Stripe leaves `subscription.status` at
 * `active` while collection is paused — `PAUSED` is *our* state, derived from
 * the presence of `pause_collection`, and the webhook derives it the same way
 * so an incoming `customer.subscription.updated` cannot quietly un-pause a
 * subscription that is resting.
 */
export const changeSubscription = withAction(
  {
    name: 'subscription.change',
    auth: 'SESSION',
    input: subscriptionChangeSchema,
    rateLimit: SUBSCRIPTION_CHANGE_RATE_LIMIT,
    revalidatePaths: BILLING_REVALIDATE_PATHS,
    revalidateTags: BILLING_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<SubscriptionView>> => {
    const privileged = isBillingAdmin(ctx.user.role)

    const owned = await requireSubscriptionOwnership(
      ctx.user,
      input.subscriptionId
    )

    if (!owned.ok) {
      return owned
    }

    if (TERMINAL_SUBSCRIPTION_STATUSES.includes(owned.data.status)) {
      return fail(
        'CONFLICT',
        'That subscription has already ended, so it cannot be changed.'
      )
    }

    const current = await ctx.db.userSubscription.findUnique({
      where: { id: owned.data.id },
      select: {
        id: true,
        userId: true,
        planId: true,
        quantity: true,
        currentPeriodEnd: true,
        status: true,
        plan: {
          select: { id: true, name: true, priceCents: true, currency: true },
        },
      },
    })

    if (current === null) {
      return fail('NOT_FOUND')
    }

    const stripe = getStripe()

    switch (input.action) {
      case 'UPGRADE':
      case 'DOWNGRADE': {
        const target = await ctx.db.subscriptionPlan.findUnique({
          where: { id: input.planId },
          select: {
            id: true,
            name: true,
            stripePriceId: true,
            priceCents: true,
            currency: true,
            isActive: true,
          },
        })

        if (target === null || !target.isActive) {
          return fail(
            'NOT_FOUND',
            'That plan is no longer open for enrolment.',
            { planId: ['That plan is no longer open for enrolment.'] }
          )
        }

        if (target.id === current.planId) {
          return fail(
            'CONFLICT',
            'That is the plan this subscription is already on.',
            { planId: ['This subscription is already on that plan.'] }
          )
        }

        if (target.currency !== current.plan.currency) {
          return fail(
            'CONFLICT',
            'A subscription cannot move to a plan billed in another currency. Please cancel and rejoin.',
            { planId: ['That plan is billed in a different currency.'] }
          )
        }

        // The direction is not cosmetic: it selects the proration and timing
        // defaults the schema applies. A "downgrade" to a dearer plan would
        // quietly wait for the period to end and prorate nothing, which is a
        // free upgrade.
        if (
          input.action === 'UPGRADE' &&
          target.priceCents < current.plan.priceCents
        ) {
          return fail(
            'VALIDATION',
            'That plan costs less than the current one — please move down to it as a downgrade.',
            { planId: ['That plan is cheaper than the current one.'] }
          )
        }

        if (
          input.action === 'DOWNGRADE' &&
          target.priceCents > current.plan.priceCents
        ) {
          return fail(
            'VALIDATION',
            'That plan costs more than the current one — please move up to it as an upgrade.',
            { planId: ['That plan is dearer than the current one.'] }
          )
        }

        const stripeSubscription = await stripe.subscriptions.retrieve(
          owned.data.stripeSubscriptionId
        )

        const item = stripeSubscription.items.data[0]

        if (item === undefined) {
          console.error(
            `[action:${ctx.actionName}] Stripe subscription ${owned.data.stripeSubscriptionId} has no items.`
          )

          return fail(
            'CONFLICT',
            'We could not change that subscription. Please contact us and we will sort it out.'
          )
        }

        // `quantity` is places at the table, and places are billed. The
        // direction checks above compare the two plans' **unit** prices, so a
        // caller free to set it could walk straight around them: "downgrade"
        // from one place on a $500 plan to twenty on a $499 one is a cheaper
        // unit price and four-fifths more service, and on the downgrade arm's
        // `none` it would arrive unbilled. It is not a preference either, for
        // the same reason `booking.ts` writes `totalCents: staffCaller ?
        // input.totalCents : 0` — so below `ADMIN` the subscription keeps the
        // quantity it has and the payload's figure is discarded. Buying more
        // places is a commercial conversation, not a field on a plan change.
        const quantity = privileged
          ? (input.quantity ?? current.quantity)
          : current.quantity

        const terms = resolveSubscriptionChangeTerms(
          input.action,
          input,
          privileged
        )

        if (terms.overridden || (!privileged && input.quantity !== undefined)) {
          // Not a failure: the request is honoured, on the house's terms. It is
          // logged because a client repeatedly posting terms that are being
          // discarded is worth an operator seeing. No amounts, no payload.
          console.warn(
            `[action:${ctx.actionName}] ${input.action} on subscription ${current.id} took server terms (${terms.effectiveAt}/${terms.prorationBehavior}, quantity ${quantity}); caller was not a billing administrator or asked for an unbillable upgrade.`
          )
        }

        const updated = await stripe.subscriptions.update(
          owned.data.stripeSubscriptionId,
          {
            items: [
              { id: item.id, price: target.stripePriceId, quantity },
              // Any additional items are left exactly as they are; this
              // platform sells one plan per subscription.
            ],
            proration_behavior: prorationBehaviorFor(terms),
            metadata: {
              [STRIPE_CUSTOMER_USER_ID_KEY]: current.userId,
              mannachefPlanId: target.id,
              // A downgrade may carry a reason. `UserSubscription` has no
              // column for it — `cancellationReason` means what its name says,
              // and writing a downgrade note there would make an active
              // subscription read as a cancelled one to every query that
              // consults it. Until the schema gains a change log, the reason
              // is kept on the Stripe object, whose metadata values cap at 500
              // characters against the schema's 2,000.
              ...(input.action === 'DOWNGRADE' && input.reason != null
                ? { mannachefChangeReason: input.reason.slice(0, 500) }
                : {}),
            },
          }
        )

        const saved = await writeStripeSubscription(ctx.db, current.id, {
          subscription: updated,
          planId: target.id,
        })

        return ok(toSubscriptionView(saved))
      }

      case 'PAUSE': {
        if (current.status === 'PAUSED') {
          return fail('CONFLICT', 'That subscription is already at rest.')
        }

        const updated = await stripe.subscriptions.update(
          owned.data.stripeSubscriptionId,
          {
            pause_collection: {
              behavior: 'void',
              resumes_at: toUnixSeconds(input.pausedUntil),
            },
            // As with a downgrade, there is no column for a pause reason and
            // `cancellationReason` is not one. It rides on the Stripe object.
            ...(input.reason != null
              ? {
                  metadata: {
                    mannachefPauseReason: input.reason.slice(0, 500),
                  },
                }
              : {}),
          }
        )

        const saved = await writeStripeSubscription(ctx.db, current.id, {
          subscription: updated,
          planId: current.planId,
        })

        return ok(toSubscriptionView(saved))
      }

      case 'RESUME': {
        if (current.status !== 'PAUSED') {
          return fail('CONFLICT', 'That subscription is not at rest.')
        }

        // No `resumeAt` means "now", which is `pause_collection: ''` —
        // Stripe's spelling for clearing the pause. A future `resumeAt` moves
        // the pause's end date instead, so the subscription stays at rest.
        const updated = await stripe.subscriptions.update(
          owned.data.stripeSubscriptionId,
          input.resumeAt === undefined
            ? { pause_collection: '' }
            : {
                pause_collection: {
                  behavior: 'void',
                  resumes_at: toUnixSeconds(input.resumeAt),
                },
              }
        )

        const saved = await writeStripeSubscription(ctx.db, current.id, {
          subscription: updated,
          planId: current.planId,
        })

        return ok(toSubscriptionView(saved))
      }

      case 'CANCEL': {
        const reason = input.cancellationReason ?? null

        if (input.cancelAtPeriodEnd) {
          const updated = await stripe.subscriptions.update(
            owned.data.stripeSubscriptionId,
            {
              cancel_at_period_end: true,
              ...(reason !== null
                ? { cancellation_details: { comment: reason } }
                : {}),
            }
          )

          const saved = await writeStripeSubscription(ctx.db, current.id, {
            subscription: updated,
            planId: current.planId,
            cancellationReason: reason,
          })

          return ok(toSubscriptionView(saved))
        }

        if (input.cancelAt !== undefined) {
          const updated = await stripe.subscriptions.update(
            owned.data.stripeSubscriptionId,
            {
              cancel_at: toUnixSeconds(input.cancelAt),
              cancel_at_period_end: false,
              ...(reason !== null
                ? { cancellation_details: { comment: reason } }
                : {}),
            }
          )

          const saved = await writeStripeSubscription(ctx.db, current.id, {
            subscription: updated,
            planId: current.planId,
            cancellationReason: reason,
          })

          return ok(toSubscriptionView(saved))
        }

        const cancelled = await stripe.subscriptions.cancel(
          owned.data.stripeSubscriptionId,
          reason !== null ? { cancellation_details: { comment: reason } } : {}
        )

        const saved = await writeStripeSubscription(ctx.db, current.id, {
          subscription: cancelled,
          planId: current.planId,
          cancellationReason: reason,
        })

        return ok(toSubscriptionView(saved))
      }

      default: {
        // A sixth member of `subscriptionChangeSchema` is a compile error here
        // rather than a request that quietly does nothing.
        const exhaustive: never = input
        return exhaustive
      }
    }
  }
)

/**
 * Write Stripe's answer back onto our row, and return the view projection.
 *
 * The subscription state we store is always the state Stripe just told us
 * about, never the state we asked for: an `update` that Stripe partially
 * honoured must leave the database agreeing with Stripe, not with the request.
 *
 * `PAUSED` is derived from `pause_collection` rather than from Stripe's
 * `status`, which stays `active` while collection is paused. A genuinely
 * terminal or delinquent status always wins over the derivation — a subscriber
 * whose card has failed is `PAST_DUE`, resting or not.
 *
 * The webhook route derives the same fields from the same object. The two are
 * deliberately separate copies: a `'use server'` module may only export async
 * functions, so a shared mapper would need a third module, and the two do
 * differ — this one knows which plan the caller moved to, the webhook has to
 * look it up from the price.
 */
async function writeStripeSubscription(
  db: typeof prisma,
  id: string,
  args: {
    subscription: Stripe.Subscription
    planId: string
    cancellationReason?: string | null
  }
): Promise<SubscriptionRow> {
  const { subscription, planId } = args
  const item = subscription.items.data[0]

  return db.userSubscription.update({
    where: { id },
    data: {
      planId,
      status: subscriptionStatusFor(subscription),
      quantity: item?.quantity ?? 1,
      currency: subscription.currency.toUpperCase(),
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: fromUnixSeconds(subscription.cancel_at),
      canceledAt: fromUnixSeconds(subscription.canceled_at),
      endedAt: fromUnixSeconds(subscription.ended_at),
      trialEndsAt: fromUnixSeconds(subscription.trial_end),
      pausedUntil: fromUnixSeconds(
        subscription.pause_collection?.resumes_at ?? null
      ),
      ...(args.cancellationReason !== undefined
        ? { cancellationReason: args.cancellationReason }
        : {}),
    },
    select: SUBSCRIPTION_SELECT,
  })
}

/**
 * Our `SubscriptionStatus` for a Stripe subscription.
 *
 * Stripe's eight statuses map one-for-one onto the enum — the schema keeps
 * Stripe's single-L `CANCELED` deliberately so that they can. It is written as
 * a `switch` rather than an uppercase-and-cast so a ninth status Stripe might
 * add is a compile error here rather than an invalid enum value handed to
 * Postgres. Note that the *domain* enums spell it `CANCELLED`, with two Ls;
 * reaching for that spelling here would not compile, which is the point.
 *
 * The only derivation is the pause, described in
 * {@link writeStripeSubscription}.
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

// =============================================================================
// 10. Invoices
// =============================================================================

function invoiceOrderBy(
  sortBy: InvoiceSortBy,
  direction: SortDirection
): Prisma.InvoiceOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'ISSUED':
      // A draft has never been issued; it sorts last either way rather than
      // crowding the head of the page.
      return [{ issuedAt: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'DUE':
      return [{ dueAt: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'AMOUNT':
      return [{ amountDueCents: direction }, { id: 'asc' }]

    case 'NUMBER':
      return [{ number: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'STATUS':
      return [{ status: direction }, { createdAt: 'desc' }, { id: 'asc' }]

    default: {
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * The invoices a caller is entitled to, filtered and paged.
 *
 * ## Scoped by ownership, not by filter
 *
 * `invoiceFilterSchema` carries a `userId` and an `issuedById`. Below `ADMIN`
 * both are **discarded** and the query is pinned to `userId: ctx.user.id`, so
 * no arrangement of parameters returns another household's bills. Above
 * `ADMIN`, both are honoured.
 *
 * `search` reads `memo` only for an admin, for the same reason the projection
 * withholds it: matching on a column a caller may not read is a way of reading
 * it one query at a time.
 */
export const listInvoices = withAction(
  {
    name: 'invoice.list',
    auth: 'SESSION',
    input: invoiceFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<InvoiceListView>> => {
    const mayAdminister = isBillingAdmin(ctx.user.role)
    const filters: Prisma.InvoiceWhereInput[] = []

    if (mayAdminister) {
      if (filter.userId !== undefined) {
        filters.push({ userId: filter.userId })
      }

      if (filter.issuedById !== undefined) {
        filters.push({ issuedById: filter.issuedById })
      }
    } else {
      filters.push({ userId: ctx.user.id })
    }

    if (filter.search !== undefined) {
      const search = filter.search

      filters.push({
        OR: [
          { number: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          ...(mayAdminister
            ? [
                {
                  memo: { contains: search, mode: 'insensitive' as const },
                },
              ]
            : []),
        ],
      })
    }

    if (filter.subscriptionId !== undefined) {
      filters.push({ subscriptionId: filter.subscriptionId })
    }

    if (filter.appointmentId !== undefined) {
      filters.push({ appointmentId: filter.appointmentId })
    }

    if (filter.statuses.length > 0) {
      filters.push({ status: { in: [...filter.statuses] } })
    }

    if (filter.manualOnly) {
      filters.push({ isManual: true })
    }

    if (filter.outstandingOnly) {
      filters.push({ amountRemainingCents: { gt: 0 } })
    }

    if (filter.overdueOnly) {
      filters.push({
        status: 'OPEN',
        dueAt: { lt: new Date() },
        amountRemainingCents: { gt: 0 },
      })
    }

    if (filter.minAmountDueCents !== undefined) {
      filters.push({ amountDueCents: { gte: filter.minAmountDueCents } })
    }

    if (filter.maxAmountDueCents !== undefined) {
      filters.push({ amountDueCents: { lte: filter.maxAmountDueCents } })
    }

    if (filter.issuedFrom !== undefined) {
      filters.push({ issuedAt: { gte: filter.issuedFrom } })
    }

    if (filter.issuedTo !== undefined) {
      filters.push({ issuedAt: { lte: filter.issuedTo } })
    }

    if (filter.dueFrom !== undefined) {
      filters.push({ dueAt: { gte: filter.dueFrom } })
    }

    if (filter.dueTo !== undefined) {
      filters.push({ dueAt: { lte: filter.dueTo } })
    }

    const where: Prisma.InvoiceWhereInput = { AND: filters }
    const orderBy = invoiceOrderBy(filter.sortBy, filter.sortDirection)
    const skip = (filter.page - 1) * filter.pageSize
    const take = filter.pageSize

    const total = await ctx.db.invoice.count({ where })

    if (mayAdminister) {
      const rows = await ctx.db.invoice.findMany({
        where,
        select: INVOICE_ADMIN_SELECT,
        orderBy,
        skip,
        take,
      })

      return ok({
        items: rows.map(toAdminInvoiceView),
        meta: buildPageMeta(filter.page, filter.pageSize, total),
      })
    }

    const rows = await ctx.db.invoice.findMany({
      where,
      select: INVOICE_CLIENT_SELECT,
      orderBy,
      skip,
      take,
    })

    return ok({
      items: rows.map(toClientInvoiceView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * One invoice, by id.
 *
 * The id arrives from a browser, so {@link requireInvoiceOwnership} is the
 * first statement: it does a real `SELECT` against `Invoice.userId`, bypasses
 * for `ADMIN` and above, and denies with `NOT_FOUND` so the action cannot be
 * used to discover which invoice ids exist. Only then is the row read again
 * through the projection the caller's role earns.
 */
export const getInvoice = withAction(
  {
    name: 'invoice.read',
    auth: 'SESSION',
    input: invoiceIdSchema,
  },
  async (ctx, input): Promise<ActionResult<InvoiceView>> => {
    const owned = await requireInvoiceOwnership(ctx.user, input.id)

    if (!owned.ok) {
      return owned
    }

    if (isBillingAdmin(ctx.user.role)) {
      const row = await ctx.db.invoice.findUnique({
        where: { id: owned.data.id },
        select: INVOICE_ADMIN_SELECT,
      })

      return row === null ? fail('NOT_FOUND') : ok(toAdminInvoiceView(row))
    }

    const row = await ctx.db.invoice.findUnique({
      where: { id: owned.data.id },
      select: INVOICE_CLIENT_SELECT,
    })

    return row === null ? fail('NOT_FOUND') : ok(toClientInvoiceView(row))
  }
)

/**
 * Raise a bespoke invoice — a private event, a tasting, a bottle of something
 * rare — outside the subscription engine. `ADMIN` and above.
 *
 * ## Every figure is recomputed
 *
 * The caller may send `amountCents` on each line and `expectedTotalCents` on
 * the invoice. `manualInvoiceCreateSchema` has already refused a payload whose
 * arithmetic disagrees with itself, and this handler then **ignores both** and
 * writes what `computeInvoiceTotals` and `lineItemAmountCents` — the functions
 * the form used to render its footer — say the invoice comes to. The client's
 * figures are an agreement check, never an input.
 *
 * ## The recipient and the engagement are re-tied
 *
 * `userId` and `appointmentId` both arrive from a browser. The recipient is
 * re-read and must be an active user with a client profile; the appointment, if
 * one is named, goes through {@link requireAppointmentOwnership} *and* is then
 * checked to belong to that same household. Billing one client for another
 * client's dinner is exactly the mistake the second check exists to prevent —
 * the guard alone would not catch it, because an `ADMIN` legitimately bypasses
 * it for every appointment on the platform.
 *
 * ## Numbering
 *
 * A caller may supply `number`; otherwise the house sequence draws one. That
 * draw is racy by construction — see {@link nextInvoiceNumber} — so the write
 * runs in a retry loop and the unique index on `Invoice.number` is the arbiter.
 * A caller-supplied number is never retried: a collision there is a real
 * conflict the operator has to resolve.
 */
export const createManualInvoice = withAction(
  {
    name: 'invoice.create',
    auth: 'ADMIN',
    input: manualInvoiceCreateSchema,
    revalidatePaths: BILLING_REVALIDATE_PATHS,
    revalidateTags: BILLING_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<InvoiceView>> => {
    const recipient = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        isActive: true,
        clientProfile: { select: { id: true } },
      },
    })

    if (recipient === null || !recipient.isActive) {
      return fail('NOT_FOUND', 'We could not find that client.', {
        userId: ['We could not find that client.'],
      })
    }

    const appointmentId = input.appointmentId ?? null

    if (appointmentId !== null) {
      const linkage = await tieInvoiceToAppointment(
        ctx.user,
        appointmentId,
        recipient.clientProfile?.id ?? null
      )

      if (linkage !== null) {
        return linkage
      }
    }

    // The single authority for what this invoice comes to. The client's
    // `expectedTotalCents` is not consulted — the schema already refused a
    // payload where the two disagree, and this figure is the one we bill.
    const totals = computeInvoiceTotals({
      lineItems: input.lineItems,
      discountCents: input.discountCents,
    })

    const issuedAt = input.issueImmediately ? new Date() : null

    for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_ATTEMPTS; attempt += 1) {
      const number = input.number ?? (await nextInvoiceNumber(ctx.db))

      try {
        const created = await ctx.db.invoice.create({
          data: {
            userId: recipient.id,
            issuedById: ctx.user.id,
            appointmentId,
            number,
            currency: input.currency,
            amountDueCents: totals.amountDueCents,
            amountPaidCents: 0,
            amountRemainingCents: totals.amountDueCents,
            subtotalCents: totals.subtotalCents,
            taxCents: totals.taxCents,
            discountCents: totals.discountCents,
            status: input.issueImmediately ? 'OPEN' : 'DRAFT',
            description: input.description ?? null,
            memo: input.memo ?? null,
            issuedAt,
            dueAt: input.dueAt ?? null,
            isManual: true,
            lineItems: {
              create: input.lineItems.map((line, index) => ({
                kind: line.kind,
                description: line.description,
                quantity: line.quantity,
                unitAmountCents: line.unitAmountCents,
                // Recomputed, never copied from `line.amountCents`.
                amountCents: lineItemAmountCents(line),
                taxCents: line.taxCents,
                currency: input.currency,
                sortOrder: line.sortOrder === 0 ? index : line.sortOrder,
                sourceRefId: line.sourceRefId ?? null,
              })),
            },
          },
          select: INVOICE_ADMIN_SELECT,
        })

        return ok(toAdminInvoiceView(created))
      } catch (error) {
        if (!isInvoiceNumberCollision(error)) {
          // Anything else is a real fault. `withAction` logs it in full and
          // answers a generic `INTERNAL`; swallowing it here would turn a
          // broken write into six broken writes.
          throw error
        }

        // A caller-chosen number that collides is a genuine conflict for the
        // operator to resolve. A house-drawn one that collides is two admins
        // racing for the same sequence position, and re-drawing is the whole
        // point of the loop.
        if (input.number !== undefined) {
          return fail('CONFLICT', 'That invoice number is already in use.', {
            number: ['That invoice number is already in use.'],
          })
        }
      }
    }

    return fail(
      'CONFLICT',
      'We could not assign an invoice number just then. Please try again.'
    )
  }
)

/**
 * Confirm that a named engagement may be billed to this household.
 *
 * Two distinct checks, because they answer two different questions and only
 * one of them is about the caller:
 *
 *  1. **{@link requireAppointmentOwnership}** — may this caller reach that
 *     appointment at all? An `ADMIN` bypasses, which is the point: an
 *     administrator raises invoices on other people's engagements all day.
 *     `denyWith: 'FORBIDDEN'` is chosen here rather than the default because an
 *     operator typing an id into an admin form is entitled to be told the
 *     difference between "no such engagement" and "not yours" — and this action
 *     is already behind `ADMIN`, so it is no enumeration oracle for a stranger.
 *  2. **The household tie** — is it *this recipient's* engagement? The guard
 *     alone cannot answer that, because the admin bypass waves through every
 *     appointment on the platform. Billing one client for another client's
 *     dinner is precisely the mistake this second check exists to prevent.
 *
 * Returns `null` when the linkage is sound, or the failure to hand back.
 */
async function tieInvoiceToAppointment(
  user: AuthenticatedUser,
  appointmentId: string,
  clientProfileId: string | null
): Promise<ActionFailure | null> {
  if (clientProfileId === null) {
    return fail(
      'VALIDATION',
      'That client has no household profile, so an engagement cannot be billed to them.',
      { appointmentId: ['This client has no household profile.'] }
    )
  }

  const owned = await requireAppointmentOwnership(user, appointmentId, {
    denyWith: 'FORBIDDEN',
  })

  if (!owned.ok) {
    return owned
  }

  if (owned.data.clientProfileId !== clientProfileId) {
    return fail(
      'VALIDATION',
      'That engagement belongs to a different household.',
      { appointmentId: ['That engagement belongs to a different household.'] }
    )
  }

  return null
}

// =============================================================================
// 11. The billing dashboard
// =============================================================================

/**
 * MRR, the subscriber base, churn, money collected and money still owed.
 * `ADMIN` and above — this is the whole book, so it is behind the same
 * threshold as everything else that reads across households.
 *
 * ## How MRR is computed
 *
 * Every `TRIALING` or `ACTIVE` subscription contributes
 * `plan.priceCents × quantity ÷ months-per-period`, where a quarter is three
 * months and a day or a week is normalised on a 365/12-day month. `PAST_DUE` is
 * excluded: it is revenue we have not been paid.
 *
 * The result is bucketed **by currency and never summed across them**. Adding
 * cents of one currency to cents of another produces a number that is wrong in
 * both, and a dashboard that quietly does so is worse than one that declines to.
 *
 * ## How churn is computed
 *
 * `cancelledInWindow ÷ subscribersAtWindowStart`, where the base is every
 * subscription that had started before the window opened and had not ended by
 * then. It is a subscription-count churn rather than a revenue churn, and the
 * base excludes `INCOMPLETE` rows, which are checkouts that never completed
 * rather than subscribers who left. The rate is `null` rather than `100` when
 * the base is zero.
 */
export const getBillingDashboard = withAction(
  {
    name: 'billing.dashboard',
    auth: 'ADMIN',
    input: billingDashboardRangeSchema,
  },
  async (ctx, input): Promise<ActionResult<BillingDashboardView>> => {
    const windowTo = input.to ?? new Date()
    const windowFrom =
      input.from ??
      new Date(windowTo.getTime() - DEFAULT_DASHBOARD_WINDOW_DAYS * MS_PER_DAY)

    const [
      revenueRows,
      statusGroups,
      activeSubscriberGroups,
      subscribersAtWindowStart,
      startedInWindow,
      cancelledInWindow,
      paymentGroups,
      outstandingGroups,
      overdueGroups,
    ] = await Promise.all([
      ctx.db.userSubscription.findMany({
        where: { status: { in: [...REVENUE_BEARING_STATUSES] } },
        select: {
          userId: true,
          quantity: true,
          plan: {
            select: {
              priceCents: true,
              currency: true,
              interval: true,
              intervalCount: true,
            },
          },
        },
        take: MAX_MRR_ROWS + 1,
      }),
      ctx.db.userSubscription.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      ctx.db.userSubscription.groupBy({
        by: ['userId'],
        where: { status: { in: [...REVENUE_BEARING_STATUSES] } },
      }),
      ctx.db.userSubscription.count({
        where: {
          startedAt: { lte: windowFrom },
          status: { notIn: ['INCOMPLETE', 'INCOMPLETE_EXPIRED'] },
          OR: [{ endedAt: null }, { endedAt: { gt: windowFrom } }],
        },
      }),
      ctx.db.userSubscription.count({
        where: { startedAt: { gte: windowFrom, lte: windowTo } },
      }),
      ctx.db.userSubscription.count({
        where: { canceledAt: { gte: windowFrom, lte: windowTo } },
      }),
      ctx.db.paymentHistory.groupBy({
        by: ['currency'],
        where: {
          status: { in: [...SETTLED_PAYMENT_STATUSES] },
          processedAt: { gte: windowFrom, lte: windowTo },
        },
        _sum: { amountCents: true, refundedCents: true },
        _count: { _all: true },
      }),
      ctx.db.invoice.groupBy({
        by: ['currency'],
        where: { status: 'OPEN', amountRemainingCents: { gt: 0 } },
        _sum: { amountRemainingCents: true },
        _count: { _all: true },
      }),
      ctx.db.invoice.groupBy({
        by: ['currency'],
        where: {
          status: 'OPEN',
          amountRemainingCents: { gt: 0 },
          dueAt: { lt: new Date() },
        },
        _count: { _all: true },
      }),
    ])

    const truncated = revenueRows.length > MAX_MRR_ROWS
    const counted = truncated ? revenueRows.slice(0, MAX_MRR_ROWS) : revenueRows

    const mrrByCurrency = new Map<
      string,
      { mrrCents: number; subscriptionCount: number; subscribers: Set<string> }
    >()

    for (const row of counted) {
      const currency = row.plan.currency
      const months = monthsPerPeriod(row.plan.interval, row.plan.intervalCount)
      const contribution =
        months > 0
          ? Math.round((row.plan.priceCents * row.quantity) / months)
          : 0

      const bucket = mrrByCurrency.get(currency)

      if (bucket === undefined) {
        mrrByCurrency.set(currency, {
          mrrCents: contribution,
          subscriptionCount: 1,
          subscribers: new Set([row.userId]),
        })
      } else {
        bucket.mrrCents += contribution
        bucket.subscriptionCount += 1
        bucket.subscribers.add(row.userId)
      }
    }

    const mrr: BillingMrrBucketView[] = [...mrrByCurrency.entries()]
      .map(([currency, bucket]) => ({
        currency,
        mrrCents: bucket.mrrCents,
        subscriptionCount: bucket.subscriptionCount,
        subscriberCount: bucket.subscribers.size,
      }))
      .sort((a, b) => b.mrrCents - a.mrrCents)

    const subscriptionsByStatus: Record<SubscriptionStatus, number> = {
      INCOMPLETE: 0,
      INCOMPLETE_EXPIRED: 0,
      TRIALING: 0,
      ACTIVE: 0,
      PAST_DUE: 0,
      CANCELED: 0,
      UNPAID: 0,
      PAUSED: 0,
    }

    for (const group of statusGroups) {
      subscriptionsByStatus[group.status] = group._count._all
    }

    const overdueByCurrency = new Map<string, number>()

    for (const group of overdueGroups) {
      overdueByCurrency.set(group.currency, group._count._all)
    }

    const collected: BillingCollectedBucketView[] = paymentGroups.map(
      (group) => {
        const grossCents = group._sum.amountCents ?? 0
        const refundedCents = group._sum.refundedCents ?? 0

        return {
          currency: group.currency,
          grossCents,
          refundedCents,
          netCents: grossCents - refundedCents,
          paymentCount: group._count._all,
        }
      }
    )

    const outstanding: BillingOutstandingBucketView[] = outstandingGroups.map(
      (group) => ({
        currency: group.currency,
        invoiceCount: group._count._all,
        amountRemainingCents: group._sum.amountRemainingCents ?? 0,
        overdueInvoiceCount: overdueByCurrency.get(group.currency) ?? 0,
      })
    )

    const churnRatePercent =
      subscribersAtWindowStart > 0
        ? Math.round((cancelledInWindow / subscribersAtWindowStart) * 1000) / 10
        : null

    return ok({
      windowFrom,
      windowTo,
      mrr,
      activeSubscribers: activeSubscriberGroups.length,
      subscriptionsByStatus,
      churn: {
        subscribersAtWindowStart,
        startedInWindow,
        cancelledInWindow,
        netChange: startedInWindow - cancelledInWindow,
        churnRatePercent,
      },
      collected,
      outstanding,
      truncated,
    })
  }
)
