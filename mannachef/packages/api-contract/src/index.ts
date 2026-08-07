// mannachef/packages/api-contract/src/index.ts

/**
 * The MannaChef API contract.
 *
 * A transport-agnostic description of every endpoint a *client* consumes. It is
 * imported unchanged by both surfaces:
 *
 *  - `@mannachef/web` — the Next.js app, where route handlers under
 *    `src/app/api/**` parse `entry.input` on the way in and `entry.output` is
 *    the shape their JSON must satisfy;
 *  - the future Expo client — which builds URLs with {@link buildUrl}, sends
 *    `inferInput<K>`, and parses responses with `entry.output`.
 *
 * Nothing here imports React, Next.js, Prisma, or `fetch`. It is data plus zod
 * schemas, so it runs identically in a React Server Component, a route handler,
 * a React Native bundle, and a test.
 *
 * ## What an entry declares
 *
 * | Field     | Meaning                                                        |
 * | --------- | -------------------------------------------------------------- |
 * | `method`  | HTTP verb.                                                      |
 * | `path`    | Path builder. Takes typed params; returns a leading-slash path.  |
 * | `input`   | Request payload schema, imported from `@mannachef/validators`.   |
 * | `output`  | Success-response schema, defined in this file.                   |
 * | `auth`    | The minimum the server must enforce before running the handler.  |
 * | `summary` | One line, for generated documentation.                           |
 *
 * ## `auth` is documentation, not enforcement
 *
 * Per `mannachef/CONTRACT.md` §5, authorization is enforced *inside* the route
 * handler or server action — session resolution, role check, then an ownership
 * check on every client-scoped id. The `auth` field records what the handler is
 * required to do so the requirement is reviewable in one place; a client must
 * never treat it as a guarantee, and a handler must never treat it as a
 * substitute for the real check.
 *
 * ## Input vs. output typing
 *
 * `inferInput<K>` is `z.input` — the shape a client may *send*, before defaults
 * and coercion. `inferParsedInput<K>` is `z.output` — what the handler sees once
 * `input.safeParse` has run. `inferOutput<K>` is `z.output` of the response
 * schema: dates arrive as ISO strings on the wire and land as `Date` instances,
 * because the shared `isoDateTimeSchema` absorbs both.
 */

import { z } from 'zod'

import {
  appointmentCreateSchema,
  appointmentFilterSchema,
  appointmentStatusSchema,
  appointmentStatusTransitionSchema,
  billingIntervalSchema,
  bookingSlotFilterSchema,
  bookingSlotStatusSchema,
  clientIntakeCreateSchema,
  clientStatusSchema,
  cuidSchema,
  currencySchema,
  deliveryFrequencySchema,
  emailSchema,
  invoiceFilterSchema,
  invoiceLineKindSchema,
  invoiceStatusSchema,
  isoDateTimeSchema,
  measurementUnitSchema,
  mediaKindSchema,
  menuItemFilterSchema,
  moneyCentsSchema,
  onboardingFlowFilterSchema,
  onboardingStageAdvanceSchema,
  onboardingStageSchema,
  paymentFilterSchema,
  paymentMethodTypeSchema,
  paymentStatusSchema,
  percentSchema,
  queryFlag,
  ratingSchema,
  referralCodeFilterSchema,
  reviewStatusSchema,
  reviewSubjectSchema,
  reviewSubmissionSchema,
  rewardTypeSchema,
  roleSchema,
  serviceTypeSchema,
  slugSchema,
  spiceLevelSchema,
  staffDirectoryFilterSchema,
  subscriptionChangeSchema,
  subscriptionStatusSchema,
  tagKindSchema,
  timeZoneSchema,
  urlSchema,
  userSubscriptionFilterSchema,
} from '@mannachef/validators'

// =============================================================================
// 0. Route primitives
// =============================================================================

/** The verbs this API uses. `PUT` is deliberately absent: updates are partial. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/**
 * What the handler is required to establish before it does any work.
 *
 *  - `PUBLIC` — no session needed. The handler must still refuse to widen the
 *    result set (for example, `includeInactive` on the menu filter).
 *  - `SESSION` — an authenticated `User` of any role.
 *  - `OWNER` — an authenticated user *and* an ownership check tying every
 *    client-scoped id in the payload back to the caller. Staff roles may pass
 *    the ownership check by role instead.
 *  - `STAFF` — at least `CHEF_STAFF`.
 */
export type AuthRequirement = 'PUBLIC' | 'SESSION' | 'OWNER' | 'STAFF'

/** Path parameters are always strings — they are interpolated into a URL. */
export type PathParams = Readonly<Record<string, string>>

/** The parameter type of a route whose path is constant. */
export type NoPathParams = Readonly<Record<never, never>>

/**
 * A path builder.
 *
 * The parameters are `never[]` so that *every* concrete builder is assignable —
 * a nullary `() => '/api/invoices'` as readily as
 * `(params: MenuDetailParams) => …`. That is what lets the contract be checked
 * against a single route type without flattening each route's own parameter
 * shape, which {@link inferPathParams} then reads back with `Parameters<…>`.
 */
export type PathBuilder = (...args: never[]) => string

/** One endpoint. */
export interface ApiRoute<
  TPath extends PathBuilder,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
> {
  readonly method: HttpMethod
  readonly path: TPath
  readonly input: TInput
  readonly output: TOutput
  readonly auth: AuthRequirement
  readonly summary: string
}

/**
 * The widest route type. Use it as a constraint — `satisfies
 * Record<string, AnyApiRoute>` — never as an annotation, which would erase the
 * per-route schema types that the `infer*` helpers depend on.
 */
export type AnyApiRoute = ApiRoute<PathBuilder, z.ZodType, z.ZodType>

// =============================================================================
// 1. Response envelopes
// =============================================================================

/**
 * The error body every non-2xx response carries.
 *
 * `code` mirrors `ActionErrorCode` in `apps/web/src/server/actions/types.ts` so
 * a screen can branch on the same value whether it called a server action
 * directly or went over HTTP from Expo. Per `CONTRACT.md` §5, `message` is
 * always a sentence written for a guest — Prisma and Stripe text never reaches
 * it.
 */
export const apiErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
])
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>

export const apiErrorSchema = z
  .object({
    ok: z.literal(false),
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Keyed by the zod path that failed, matching React Hook Form's shape. */
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict()
export type ApiError = z.infer<typeof apiErrorSchema>

/** Page counters returned alongside every list. */
export const pageMetaSchema = z
  .object({
    page: z.int().min(1),
    pageSize: z.int().min(1),
    total: z.int().min(0),
    pageCount: z.int().min(0),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  })
  .strict()
export type PageMeta = z.infer<typeof pageMetaSchema>

/** Wraps an item schema in the standard list envelope. */
export function paginated<TItem extends z.ZodType>(
  item: TItem
): z.ZodObject<{ items: z.ZodArray<TItem>; meta: typeof pageMetaSchema }> {
  return z.object({ items: z.array(item), meta: pageMetaSchema })
}

// =============================================================================
// 2. Read models
//
// These mirror `packages/db/prisma/schema.prisma`. Field names are taken from
// that file verbatim. Relations are flattened or summarised — a client is never
// handed a raw Prisma row, and nothing here exposes a column a guest may not
// see (`chefNotes`, `moderationNote`, `stripeCustomerId`, …) unless the route's
// `auth` requirement puts it behind staff.
//
// ## Why a response schema never carries a default
//
// A `.default(...)` is an *input* affordance: it lets a client omit a field and
// have the server fill it in. On an output schema it inverts into a hazard,
// because the direction of trust is reversed. Here the payload is the thing
// being checked and the client is the thing being protected, so a default stops
// the schema from reporting a malformed response and instead **fabricates** the
// missing field, handing the caller a value the server never sent.
//
// Two schemas in `@mannachef/validators` are defaulted, and both were reachable
// from this section:
//
//  - `currencySchema` defaults to `'CAD'`. A response that lost its `currency`
//    column would render as Canadian dollars — the failure mode being a guest
//    in another market shown a price in the wrong currency, silently and with
//    no error anywhere.
//  - `timeZoneSchema` defaults to `'America/Toronto'` *and* carries a runtime
//    `Intl.DateTimeFormat` probe. A session missing `timeZone` would be handed
//    a plausible zone, and every appointment time the client rendered from it
//    would be wrong by whatever the offset happens to be.
//
// Both are unwrapped once, here, and it is the unwrapped twin that every read
// model below uses. `.unwrap()` is the current spelling of what used to be
// `.removeDefault()`, which zod 4.4 deprecates; it strips the `ZodDefault`
// wrapper and leaves every other rule — the three-letter check, the length
// bound, the `Intl` probe — exactly as it was. The result is a schema that
// accepts precisely what the server is contracted to send and rejects an
// incomplete payload loudly.
//
// The same reasoning is already applied on the request side in
// `payment.ts`, where `paymentFilterSchema.currency` unwraps rather than
// defaults so an unfiltered ledger is not narrowed to one currency.
// =============================================================================

/**
 * ISO 4217, with no fallback. Required in every response that quotes an amount.
 */
export const responseCurrencySchema = currencySchema.unwrap()
export type ResponseCurrency = z.infer<typeof responseCurrencySchema>

/**
 * An IANA time zone identifier, with no fallback. Required wherever a response
 * states the zone a wall-clock time should be read in.
 */
export const responseTimeZoneSchema = timeZoneSchema.unwrap()
export type ResponseTimeZone = z.infer<typeof responseTimeZoneSchema>

/** A `Tag`, as attached to a dish. */
export const tagSummarySchema = z
  .object({
    id: cuidSchema,
    slug: slugSchema,
    name: z.string(),
    kind: tagKindSchema,
    colorToken: z.string().nullable(),
  })
  .strict()
export type TagSummary = z.infer<typeof tagSummarySchema>

/** A `MediaAsset` reduced to what a gallery needs. */
export const mediaSummarySchema = z
  .object({
    id: cuidSchema,
    url: urlSchema,
    thumbnailUrl: urlSchema.nullable(),
    alt: z.string(),
    caption: z.string().nullable(),
    credit: z.string().nullable(),
    kind: mediaKindSchema,
    width: z.int().nullable(),
    height: z.int().nullable(),
    blurData: z.string().nullable(),
  })
  .strict()
export type MediaSummary = z.infer<typeof mediaSummarySchema>

/** A `MenuItemIngredient` joined to its `Ingredient`. */
export const menuItemIngredientViewSchema = z
  .object({
    id: cuidSchema,
    ingredientId: cuidSchema,
    slug: slugSchema,
    name: z.string(),
    /** `Decimal(10,3)` in Postgres; serialised as a string to stay exact. */
    quantity: z.string(),
    unit: measurementUnitSchema,
    preparation: z.string().nullable(),
    isAllergen: z.boolean(),
    isOptional: z.boolean(),
    isGarnish: z.boolean(),
    sortOrder: z.int(),
  })
  .strict()
export type MenuItemIngredientView = z.infer<
  typeof menuItemIngredientViewSchema
>

/** A `MenuItem` as it appears in a list or a card. */
export const menuItemSummarySchema = z
  .object({
    id: cuidSchema,
    slug: slugSchema,
    name: z.string(),
    description: z.string().nullable(),
    categoryId: cuidSchema,
    categorySlug: slugSchema,
    categoryName: z.string(),
    subcategorySlug: slugSchema.nullable(),
    basePriceCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    spiceLevel: spiceLevelSchema,
    isSeasonal: z.boolean(),
    seasonStart: z.int().min(1).max(12).nullable(),
    seasonEnd: z.int().min(1).max(12).nullable(),
    isSignature: z.boolean(),
    isActive: z.boolean(),
    sortOrder: z.int(),
    tags: z.array(tagSummarySchema),
    primaryMedia: mediaSummarySchema.nullable(),
    /** Mean of approved reviews, to one decimal. `null` until the first one. */
    averageRating: z.number().min(1).max(5).nullable(),
    reviewCount: z.int().min(0),
  })
  .strict()
export type MenuItemSummary = z.infer<typeof menuItemSummarySchema>

/** A `MenuItem` on its own page: the narrative, the plate, the pantry. */
export const menuItemDetailSchema = menuItemSummarySchema
  .extend({
    story: z.string().nullable(),
    tastingNote: z.string().nullable(),
    pairingNote: z.string().nullable(),
    servingSize: z.string().nullable(),
    servingsPerUnit: z.int().nullable(),
    prepTimeMinutes: z.int().nullable(),
    cookTimeMinutes: z.int().nullable(),
    calories: z.int().nullable(),
    proteinGram: z.int().nullable(),
    carbGram: z.int().nullable(),
    fatGram: z.int().nullable(),
    media: z.array(mediaSummarySchema),
    ingredients: z.array(menuItemIngredientViewSchema),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
export type MenuItemDetail = z.infer<typeof menuItemDetailSchema>

/** The signed-in `User`, trimmed to what a client may hold. */
export const sessionUserSchema = z
  .object({
    id: cuidSchema,
    name: z.string().nullable(),
    email: emailSchema.nullable(),
    image: urlSchema.nullable(),
    role: roleSchema,
    timeZone: responseTimeZoneSchema,
    locale: z.string(),
    isActive: z.boolean(),
  })
  .strict()
export type SessionUser = z.infer<typeof sessionUserSchema>

/**
 * The whole session in one read.
 *
 * The profile ids are included so a client can address its own rows without a
 * second round trip. They remain untrusted on the way back: every mutating
 * route re-derives ownership from the session rather than believing an id the
 * client echoes.
 */
export const sessionSchema = z
  .object({
    authenticated: z.boolean(),
    user: sessionUserSchema.nullable(),
    clientProfileId: cuidSchema.nullable(),
    staffProfileId: cuidSchema.nullable(),
    clientStatus: clientStatusSchema.nullable(),
    onboardingStage: onboardingStageSchema.nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
  })
  .strict()
export type SessionView = z.infer<typeof sessionSchema>

/** What the intake form returns once it has been accepted. */
export const intakeSubmissionSchema = z
  .object({
    intakeFormId: cuidSchema,
    clientProfileId: cuidSchema,
    submittedAt: isoDateTimeSchema.nullable(),
    clientStatus: clientStatusSchema,
    onboardingStage: onboardingStageSchema,
    deliveryFrequency: deliveryFrequencySchema,
    /** Set when submitting the form also opened a consultation request. */
    consultationInterviewId: cuidSchema.nullable(),
  })
  .strict()
export type IntakeSubmissionView = z.infer<typeof intakeSubmissionSchema>

/** A `BookingSlot` — one window in the chef's diary. */
export const bookingSlotSchema = z
  .object({
    id: cuidSchema,
    staffProfileId: cuidSchema,
    staffName: z.string().nullable(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    capacity: z.int().min(1),
    bookedCount: z.int().min(0),
    status: bookingSlotStatusSchema,
    serviceType: serviceTypeSchema.nullable(),
    priceCents: moneyCentsSchema.nullable(),
    currency: responseCurrencySchema,
    holdsUntil: isoDateTimeSchema.nullable(),
    note: z.string().nullable(),
    /** `status === 'OPEN' && bookedCount < capacity`, computed server-side. */
    isBookable: z.boolean(),
  })
  .strict()
export type BookingSlotView = z.infer<typeof bookingSlotSchema>

/** An `AppointmentMenuItem` with enough of the dish to render a course list. */
export const appointmentMenuItemSchema = z
  .object({
    id: cuidSchema,
    menuItemId: cuidSchema,
    slug: slugSchema,
    name: z.string(),
    quantity: z.int().min(1),
    courseOrder: z.int().min(0),
    notes: z.string().nullable(),
    priceCentsAtBooking: moneyCentsSchema.nullable(),
    currency: responseCurrencySchema,
  })
  .strict()
export type AppointmentMenuItemView = z.infer<typeof appointmentMenuItemSchema>

/**
 * A `ChefAppointment`.
 *
 * `chefNotes` is present but nullable: the handler nulls it for a `CLIENT` and
 * fills it only for `CHEF_STAFF` and above. The address columns are returned
 * grouped, mirroring `addressSchema` on the way in.
 *
 * `quotedGuestCount` and `requiresRequote` describe the *money* rather than the
 * party: the first is the party size the three cash figures were priced for,
 * and the second says those figures no longer describe the dinner they are
 * attached to. `requiresRequote` is derived by the handler from the two counts
 * rather than stored, so it can never disagree with them (MCV-043).
 */
export const appointmentSchema = z
  .object({
    id: cuidSchema,
    clientProfileId: cuidSchema,
    staffProfileId: cuidSchema,
    staffName: z.string().nullable(),
    bookingSlotId: cuidSchema.nullable(),
    serviceType: serviceTypeSchema,
    status: appointmentStatusSchema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    prepStartsAt: isoDateTimeSchema.nullable(),
    travelBufferBeforeMinutes: z.int().min(0),
    travelBufferAfterMinutes: z.int().min(0),
    guestCount: z.int().min(1),
    address: z
      .object({
        line1: z.string().nullable(),
        line2: z.string().nullable(),
        city: z.string().nullable(),
        region: z.string().nullable(),
        postalCode: z.string().nullable(),
        country: z.string().nullable(),
      })
      .strict()
      .nullable(),
    accessNotes: z.string().nullable(),
    totalCents: moneyCentsSchema,
    depositCents: moneyCentsSchema,
    gratuityCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    /** The party size the three figures above were priced for. */
    quotedGuestCount: z.int().min(1).nullable(),
    /** `quotedGuestCount` is set and no longer matches `guestCount`. */
    requiresRequote: z.boolean(),
    clientNotes: z.string().nullable(),
    /** Staff-only. `null` for a `CLIENT` caller. */
    chefNotes: z.string().nullable(),
    confirmedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    cancelledAt: isoDateTimeSchema.nullable(),
    cancellationReason: z.string().nullable(),
    cancelledById: cuidSchema.nullable(),
    menuItems: z.array(appointmentMenuItemSchema),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
export type AppointmentView = z.infer<typeof appointmentSchema>

/** A `SubscriptionPlan`, as shown on the plan card a subscriber is moving to. */
export const subscriptionPlanSummarySchema = z
  .object({
    id: cuidSchema,
    slug: slugSchema,
    name: z.string(),
    tagline: z.string().nullable(),
    interval: billingIntervalSchema,
    intervalCount: z.int().min(1),
    priceCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    setupFeeCents: moneyCentsSchema.nullable(),
    trialDays: z.int().min(0).nullable(),
    mealsPerWeek: z.int().min(1),
    servingsPerMeal: z.int().min(1),
    features: z.array(z.string()),
    isFeatured: z.boolean(),
  })
  .strict()
export type SubscriptionPlanSummary = z.infer<
  typeof subscriptionPlanSummarySchema
>

/**
 * A `UserSubscription`.
 *
 * `stripeSubscriptionId` is exposed because the portal needs it to open a
 * Stripe billing-portal session; `stripeCustomerId` is not, because nothing on
 * a client needs it and it addresses every other subscription on the account.
 */
export const subscriptionSchema = z
  .object({
    id: cuidSchema,
    userId: cuidSchema,
    planId: cuidSchema,
    plan: subscriptionPlanSummarySchema,
    stripeSubscriptionId: z.string(),
    status: subscriptionStatusSchema,
    quantity: z.int().min(1),
    currency: responseCurrencySchema,
    currentPeriodStart: isoDateTimeSchema,
    currentPeriodEnd: isoDateTimeSchema,
    cancelAtPeriodEnd: z.boolean(),
    cancelAt: isoDateTimeSchema.nullable(),
    canceledAt: isoDateTimeSchema.nullable(),
    cancellationReason: z.string().nullable(),
    endedAt: isoDateTimeSchema.nullable(),
    trialEndsAt: isoDateTimeSchema.nullable(),
    pausedUntil: isoDateTimeSchema.nullable(),
    startedAt: isoDateTimeSchema,
  })
  .strict()
export type SubscriptionView = z.infer<typeof subscriptionSchema>

/** An `InvoiceLineItem`. */
export const invoiceLineItemSchema = z
  .object({
    id: cuidSchema,
    kind: invoiceLineKindSchema,
    description: z.string(),
    quantity: z.int().min(1),
    unitAmountCents: moneyCentsSchema,
    amountCents: moneyCentsSchema,
    taxCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    sortOrder: z.int().min(0),
  })
  .strict()
export type InvoiceLineItemView = z.infer<typeof invoiceLineItemSchema>

/** An `Invoice` with its lines. */
export const invoiceSchema = z
  .object({
    id: cuidSchema,
    userId: cuidSchema,
    subscriptionId: cuidSchema.nullable(),
    appointmentId: cuidSchema.nullable(),
    number: z.string().nullable(),
    status: invoiceStatusSchema,
    amountDueCents: moneyCentsSchema,
    amountPaidCents: moneyCentsSchema,
    amountRemainingCents: moneyCentsSchema,
    subtotalCents: moneyCentsSchema,
    taxCents: moneyCentsSchema,
    discountCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    hostedInvoiceUrl: urlSchema.nullable(),
    pdfUrl: urlSchema.nullable(),
    description: z.string().nullable(),
    issuedAt: isoDateTimeSchema.nullable(),
    dueAt: isoDateTimeSchema.nullable(),
    paidAt: isoDateTimeSchema.nullable(),
    voidedAt: isoDateTimeSchema.nullable(),
    isManual: z.boolean(),
    lineItems: z.array(invoiceLineItemSchema),
    createdAt: isoDateTimeSchema,
  })
  .strict()
export type InvoiceView = z.infer<typeof invoiceSchema>

/** A `Review` as the author or a reader sees it. Moderator notes are omitted. */
export const reviewSchema = z
  .object({
    id: cuidSchema,
    subject: reviewSubjectSchema,
    menuItemId: cuidSchema.nullable(),
    staffProfileId: cuidSchema.nullable(),
    appointmentId: cuidSchema.nullable(),
    authorId: cuidSchema,
    authorName: z.string().nullable(),
    rating: ratingSchema,
    title: z.string().nullable(),
    body: z.string(),
    status: reviewStatusSchema,
    isVerified: z.boolean(),
    featuredOrder: z.int().min(0).nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict()
export type ReviewView = z.infer<typeof reviewSchema>

/** A `ReferralCode` with its running totals. */
export const referralCodeSummarySchema = z
  .object({
    id: cuidSchema,
    code: z.string(),
    ownerId: cuidSchema,
    label: z.string().nullable(),
    rewardType: rewardTypeSchema,
    rewardValueCents: moneyCentsSchema.nullable(),
    rewardValuePercent: percentSchema.nullable(),
    refereeRewardCents: moneyCentsSchema.nullable(),
    currency: responseCurrencySchema,
    maxRedemptions: z.int().min(1).nullable(),
    redemptionCount: z.int().min(0),
    expiresAt: isoDateTimeSchema.nullable(),
    isActive: z.boolean(),
    /** `isActive && not expired && redemptionCount < maxRedemptions`. */
    isRedeemable: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict()
export type ReferralCodeSummary = z.infer<typeof referralCodeSummarySchema>

/** A `RewardBalance`. */
export const rewardBalanceSchema = z
  .object({
    balanceCents: moneyCentsSchema,
    lifetimeEarnedCents: moneyCentsSchema,
    lifetimeRedeemedCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    lastEarnedAt: isoDateTimeSchema.nullable(),
    lastRedeemedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
export type RewardBalanceView = z.infer<typeof rewardBalanceSchema>

/** Everything the referral screen renders, in one read. */
export const referralOverviewSchema = z
  .object({
    codes: paginated(referralCodeSummarySchema),
    balance: rewardBalanceSchema,
    /** How many redemptions are awaiting qualification across all codes. */
    pendingRedemptions: z.int().min(0),
  })
  .strict()
export type ReferralOverview = z.infer<typeof referralOverviewSchema>

/**
 * A `StaffProfile` — a chef, as the public directory card and the admin roster
 * row both render them.
 *
 * One schema for both audiences, because the two differ in *which rows* they
 * may see rather than in which columns: the directory action pins
 * `isPubliclyListed` to `true` and the roster action does not. Both columns are
 * returned either way so the roster can show an administrator the state they
 * are about to change, and neither is a secret — a chef who is listed is, by
 * definition, listed publicly.
 */
export const staffProfileSummarySchema = z
  .object({
    id: cuidSchema,
    userId: cuidSchema,
    /** From the joined `User`. `null` when the account has no name set. */
    name: z.string().nullable(),
    title: z.string().nullable(),
    bio: z.string().nullable(),
    specialties: z.array(z.string()),
    languages: z.array(z.string()),
    hourlyRateCents: moneyCentsSchema,
    currency: responseCurrencySchema,
    serviceRadiusKm: z.int().min(0),
    /** `null` means we have not recorded it, which is not the same as zero. */
    yearsExperience: z.int().min(0).nullable(),
    baseCity: z.string().nullable(),
    baseRegion: z.string().nullable(),
    baseCountry: z.string().nullable(),
    calendarTimeZone: responseTimeZoneSchema,
    isAcceptingClients: z.boolean(),
    maxConcurrentEvents: z.int().min(1),
    isPubliclyListed: z.boolean(),
    sortOrder: z.int().min(0),
    avatarMedia: mediaSummarySchema.nullable(),
    /** Mean of approved chef reviews, to one decimal. `null` until the first. */
    averageRating: z.number().min(1).max(5).nullable(),
    reviewCount: z.int().min(0),
    createdAt: isoDateTimeSchema,
  })
  .strict()
export type StaffProfileSummary = z.infer<typeof staffProfileSummarySchema>

/**
 * A `PaymentHistory` row — money that actually moved, as opposed to money we
 * asked for.
 *
 * `stripePaymentIntentId` and `stripeChargeId` are exposed because a client
 * quoting a reference is the fastest route through a support conversation, and
 * neither addresses anything beyond the single charge it names. Nothing on this
 * row carries card data beyond the brand and the last four, per
 * `mannachef/CONTRACT.md` §5.
 */
export const paymentSchema = z
  .object({
    id: cuidSchema,
    userId: cuidSchema,
    invoiceId: cuidSchema.nullable(),
    subscriptionId: cuidSchema.nullable(),
    stripePaymentIntentId: z.string().nullable(),
    stripeChargeId: z.string().nullable(),
    amountCents: moneyCentsSchema,
    /** Cumulative, not the last increment. `0` when nothing went back. */
    refundedCents: moneyCentsSchema,
    /** Stripe's cut, when the webhook told us. `null` when it did not. */
    feeCents: moneyCentsSchema.nullable(),
    currency: responseCurrencySchema,
    status: paymentStatusSchema,
    method: paymentMethodTypeSchema,
    cardBrand: z.string().nullable(),
    /** Four digits, as a string — leading zeros are significant. */
    cardLast4: z.string().nullable(),
    failureCode: z.string().nullable(),
    failureReason: z.string().nullable(),
    receiptUrl: urlSchema.nullable(),
    processedAt: isoDateTimeSchema.nullable(),
    refundedAt: isoDateTimeSchema.nullable(),
    /** `isRefundablePaymentStatus(status)`, computed server-side. */
    isRefundable: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict()
export type PaymentView = z.infer<typeof paymentSchema>

/** An `OnboardingStepCompletion` — one rung of the ladder, once it was reached. */
export const onboardingStepSchema = z
  .object({
    id: cuidSchema,
    stage: onboardingStageSchema,
    completedAt: isoDateTimeSchema,
    note: z.string().nullable(),
  })
  .strict()
export type OnboardingStepView = z.infer<typeof onboardingStepSchema>

/**
 * An `OnboardingFlow` — where a household stands on the journey.
 *
 * `allowedNextStages` is `allowedOnboardingStages(currentStage)` evaluated on
 * the server. It is returned rather than recomputed on the client so a stage
 * picker cannot drift from the ladder the server will actually enforce; the
 * handler still re-checks the move against `onboardingStageAdvanceSchema` when
 * one is submitted, because a list in a response is a convenience and not a
 * permission (`mannachef/CONTRACT.md` §5).
 */
export const onboardingFlowSchema = z
  .object({
    id: cuidSchema,
    clientProfileId: cuidSchema,
    currentStage: onboardingStageSchema,
    progressPercent: percentSchema,
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
    abandonedAt: isoDateTimeSchema.nullable(),
    abandonedReason: z.string().nullable(),
    lastAdvancedAt: isoDateTimeSchema.nullable(),
    allowedNextStages: z.array(onboardingStageSchema),
    steps: z.array(onboardingStepSchema),
    createdAt: isoDateTimeSchema,
  })
  .strict()
export type OnboardingFlowView = z.infer<typeof onboardingFlowSchema>

// =============================================================================
// 3. Inputs that have no domain schema of their own
//
// Everything else reuses a schema from `@mannachef/validators` unchanged. The
// three below are composed here from that package's primitives rather than
// invented: a route needs an input schema even when the request carries nothing
// but a path parameter.
// =============================================================================

/** A request with no payload. `.strict()` so a stray field is a 400, not noise. */
export const emptyInputSchema = z.strictObject({})
export type EmptyInput = z.infer<typeof emptyInputSchema>

/**
 * Reading one dish. The slug is duplicated into the body/query so a client can
 * validate it before it ever reaches {@link buildUrl}.
 *
 * `includeInactive` uses the shared `queryFlag`, as every sibling filter does.
 * A bare `z.boolean()` here was a transport defect rather than a style
 * inconsistency: `menu.detail` is a `GET`, so the flag reaches the handler as
 * the *string* `'false'`, which `z.boolean()` rejects. The round trip that
 * `buildQueryUrl` performs on this very schema therefore produced a 400 for the
 * one caller who was explicit about not wanting inactive dishes, while the
 * caller who omitted the flag entirely succeeded. `queryFlag` accepts a real
 * boolean or its string spelling and keeps the same `false` default.
 */
export const menuDetailInputSchema = z
  .object({
    slug: slugSchema,
    /**
     * Staff-only. The handler must confirm the caller is at least `CHEF_STAFF`
     * before honouring it — a guest may never see a dish taken off the menu.
     * See `mannachef/CONTRACT.md` §5.
     */
    includeInactive: queryFlag(
      false,
      'Please say whether a dish that is off the menu should be shown.'
    ),
  })
  .strict()
export type MenuDetailInput = z.infer<typeof menuDetailInputSchema>

/**
 * Cancelling an engagement.
 *
 * The shared transition schema already refuses an illegal move, insists on a
 * reason for a cancellation, and rejects a back-dated `occurredAt`. This route
 * narrows it to the one transition it performs, so a mistargeted call fails at
 * the edge instead of quietly confirming an appointment.
 */
export const appointmentCancelInputSchema =
  appointmentStatusTransitionSchema.refine(
    (value) => value.to === 'CANCELLED',
    {
      error: 'This endpoint only cancels an engagement.',
      path: ['to'],
    }
  )
export type AppointmentCancelInput = z.infer<
  typeof appointmentCancelInputSchema
>

// =============================================================================
// 4. Path parameters
// =============================================================================

/**
 * `/api/menu/items/:slug`
 *
 * Declared as a type alias rather than an interface on purpose: an alias of an
 * object literal type gets an implicit index signature, which is what makes it
 * assignable to {@link PathParams} and therefore usable with {@link buildUrl}.
 */
export type MenuDetailParams = {
  readonly slug: string
}

/** `/api/appointments/:appointmentId/cancel` */
export type AppointmentParams = {
  readonly appointmentId: string
}

// =============================================================================
// 5. The contract
// =============================================================================

/**
 * Every endpoint the mobile client needs, keyed by `<domain>.<action>`.
 *
 * Keys are stable: they appear in query keys, in telemetry, and in the Expo
 * client's generated hooks. Renaming one is a breaking change.
 */
export const ApiContract = {
  // --- Auth ----------------------------------------------------------------

  'auth.session': {
    method: 'GET',
    path: (): string => '/api/auth/session',
    input: emptyInputSchema,
    output: sessionSchema,
    auth: 'PUBLIC',
    summary:
      'Resolve the current session. Returns an unauthenticated envelope rather than a 401 so a cold app launch can branch without handling an error.',
  },

  // --- Menu ----------------------------------------------------------------

  'menu.list': {
    method: 'GET',
    path: (): string => '/api/menu/items',
    input: menuItemFilterSchema,
    output: paginated(menuItemSummarySchema),
    auth: 'PUBLIC',
    summary:
      'Browse the menu. `includeInactive` is honoured only for CHEF_STAFF and above.',
  },

  'menu.detail': {
    method: 'GET',
    path: (params: MenuDetailParams): string =>
      `/api/menu/items/${encodeURIComponent(params.slug)}`,
    input: menuDetailInputSchema,
    output: menuItemDetailSchema,
    auth: 'PUBLIC',
    summary: 'One dish, with its story, gallery, and pantry.',
  },

  // --- Intake --------------------------------------------------------------

  'intake.submit': {
    method: 'POST',
    path: (): string => '/api/intake',
    input: clientIntakeCreateSchema,
    output: intakeSubmissionSchema,
    auth: 'OWNER',
    summary:
      'Submit the household questionnaire. The handler must confirm `clientProfileId` belongs to the caller before writing.',
  },

  // --- Availability --------------------------------------------------------

  'availability.query': {
    method: 'GET',
    path: (): string => '/api/availability',
    input: bookingSlotFilterSchema,
    output: paginated(bookingSlotSchema),
    auth: 'PUBLIC',
    summary:
      "Search the chef's diary for bookable windows. Held and cancelled windows are filtered out unless the caller is staff.",
  },

  // --- Appointments --------------------------------------------------------

  'appointment.create': {
    method: 'POST',
    path: (): string => '/api/appointments',
    input: appointmentCreateSchema,
    output: appointmentSchema,
    auth: 'OWNER',
    summary:
      'Book an engagement. The handler re-checks slot capacity and conflicts inside the transaction, not from the payload.',
  },

  'appointment.list': {
    method: 'GET',
    path: (): string => '/api/appointments',
    input: appointmentFilterSchema,
    output: paginated(appointmentSchema),
    auth: 'OWNER',
    summary:
      "The caller's engagements. A CLIENT caller has `clientProfileId` forced to their own profile regardless of what the filter asked for.",
  },

  'appointment.cancel': {
    method: 'POST',
    path: (params: AppointmentParams): string =>
      `/api/appointments/${encodeURIComponent(params.appointmentId)}/cancel`,
    input: appointmentCancelInputSchema,
    output: appointmentSchema,
    auth: 'OWNER',
    summary:
      'Cancel an engagement. `from` is the status the caller believes it is in; a mismatch is a 409 rather than a silent overwrite.',
  },

  // --- Subscription --------------------------------------------------------

  'subscription.read': {
    method: 'GET',
    path: (): string => '/api/subscriptions',
    input: userSubscriptionFilterSchema,
    output: paginated(subscriptionSchema),
    auth: 'OWNER',
    summary:
      "The caller's subscriptions with their plans. `userId` is forced to the session user unless the caller is staff.",
  },

  'subscription.change': {
    method: 'POST',
    path: (): string => '/api/subscriptions/change',
    input: subscriptionChangeSchema,
    output: subscriptionSchema,
    auth: 'OWNER',
    summary:
      'Upgrade, downgrade, pause, resume, or cancel. The handler owns the Stripe call; the response is the subscription as it stands afterwards.',
  },

  // --- Invoices ------------------------------------------------------------

  'invoice.list': {
    method: 'GET',
    path: (): string => '/api/invoices',
    input: invoiceFilterSchema,
    output: paginated(invoiceSchema),
    auth: 'OWNER',
    summary:
      "The caller's invoices. `userId` is forced to the session user unless the caller is staff.",
  },

  // --- Reviews -------------------------------------------------------------

  'review.submit': {
    method: 'POST',
    path: (): string => '/api/reviews',
    input: reviewSubmissionSchema,
    output: reviewSchema,
    auth: 'SESSION',
    summary:
      'Leave a review. A submission always lands as PENDING, and `isVerified` is derived from a completed engagement the handler looks up — never from the payload.',
  },

  // --- Referrals -----------------------------------------------------------

  'referral.read': {
    method: 'GET',
    path: (): string => '/api/referrals',
    input: referralCodeFilterSchema,
    output: referralOverviewSchema,
    auth: 'OWNER',
    summary:
      "The caller's invitation codes, reward balance, and pending redemptions. `ownerId` is forced to the session user unless the caller is staff.",
  },

  // --- Staff ---------------------------------------------------------------

  'staff.directory': {
    method: 'GET',
    path: (): string => '/api/staff',
    input: staffDirectoryFilterSchema,
    output: paginated(staffProfileSummarySchema),
    auth: 'PUBLIC',
    summary:
      'Browse the chefs. The filter has no key for `isPubliclyListed` by design — the handler pins that column to `true`, so no arrangement of query parameters can surface a chef we have hidden.',
  },

  // --- Payments ------------------------------------------------------------

  'payment.history': {
    method: 'GET',
    path: (): string => '/api/payments',
    input: paymentFilterSchema,
    output: paginated(paymentSchema),
    auth: 'OWNER',
    summary:
      "The caller's payment ledger — what cleared, what failed, and what went back. `userId` is forced to the session user unless the caller is staff.",
  },

  // --- Onboarding ----------------------------------------------------------

  'onboarding.read': {
    method: 'GET',
    path: (): string => '/api/onboarding',
    input: onboardingFlowFilterSchema,
    output: paginated(onboardingFlowSchema),
    auth: 'OWNER',
    summary:
      "Where a household stands on the journey, with the rungs it has already reached. `clientProfileId` is forced to the caller's own profile unless the caller is staff.",
  },

  'onboarding.advance': {
    method: 'POST',
    path: (): string => '/api/onboarding/advance',
    input: onboardingStageAdvanceSchema,
    output: onboardingFlowSchema,
    auth: 'STAFF',
    summary:
      'Move a household along the journey. `from` is the stage the caller believes it is standing at; the handler re-reads `currentStage` and answers a mismatch with a 409 rather than letting two administrators both succeed.',
  },
} satisfies Record<string, AnyApiRoute>

/** The type of the contract itself. */
export type ApiContract = typeof ApiContract

/** Every route key: `'auth.session' | 'menu.list' | …`. */
export type ApiRouteKey = keyof ApiContract

/**
 * The route keys at runtime, in declaration order.
 *
 * Written out rather than taken from `Object.keys(ApiContract)`. `Object.keys`
 * is declared to return `string[]` and cannot be otherwise: an object type in
 * TypeScript is not exact, so a value assignable to `ApiContract` may carry
 * extra properties at runtime and a narrower return type would be unsound. The
 * `as readonly ApiRouteKey[]` that used to sit here was therefore not a
 * harmless annotation — it was an assertion the compiler had no way to check,
 * and it would have gone on asserting after a key was renamed.
 *
 * The literal array is checked in both directions instead, with no cast:
 *
 *  - `satisfies readonly ApiRouteKey[]` rejects a typo or a key that no longer
 *    exists, while `as const` keeps the individual literal types;
 *  - {@link _EveryRouteKeyIsListed} rejects an *omission*, which the `satisfies`
 *    clause on its own would not notice.
 *
 * Adding a route therefore fails to compile until it is listed here, which is
 * the only moment anybody will think about whether the new endpoint belongs in
 * the generated client.
 */
export const API_ROUTE_KEYS = [
  'auth.session',
  'menu.list',
  'menu.detail',
  'intake.submit',
  'availability.query',
  'appointment.create',
  'appointment.list',
  'appointment.cancel',
  'subscription.read',
  'subscription.change',
  'invoice.list',
  'review.submit',
  'referral.read',
  'staff.directory',
  'payment.history',
  'onboarding.read',
  'onboarding.advance',
] as const satisfies readonly ApiRouteKey[]

/** Fails to instantiate unless `T` is exactly `true`. */
type Assert<T extends true> = T

/**
 * Every key of {@link ApiContract} appears in {@link API_ROUTE_KEYS}.
 *
 * The tuple is wrapped so the conditional is not distributed over the union —
 * a naked `ApiRouteKey extends …` would test each member separately and pass
 * as soon as *one* of them was listed.
 */
export type _EveryRouteKeyIsListed = Assert<
  [ApiRouteKey] extends [(typeof API_ROUTE_KEYS)[number]] ? true : false
>

// =============================================================================
// 6. End-to-end inference
// =============================================================================

/** The entry for a key, with its concrete schema types intact. */
export type inferRoute<K extends ApiRouteKey> = ApiContract[K]

/**
 * What a client may *send* for a route: `z.input` of its request schema, before
 * defaults are applied and coerced fields are narrowed.
 */
export type inferInput<K extends ApiRouteKey> = z.input<ApiContract[K]['input']>

/**
 * What the handler receives once `entry.input.safeParse` has succeeded:
 * `z.output` of the request schema. Defaults are filled, strings are coerced,
 * and ISO date strings have become `Date` instances.
 */
export type inferParsedInput<K extends ApiRouteKey> = z.output<
  ApiContract[K]['input']
>

/** What a route resolves to once its response has been parsed. */
export type inferOutput<K extends ApiRouteKey> = z.output<
  ApiContract[K]['output']
>

/**
 * The path parameters a route's builder needs. `NoPathParams` for the routes
 * whose path is constant.
 */
export type inferPathParams<K extends ApiRouteKey> =
  Parameters<ApiContract[K]['path']> extends readonly [
    infer TParams,
    ...unknown[],
  ]
    ? TParams
    : NoPathParams

/** The HTTP verb a route uses, as a literal. */
export type inferMethod<K extends ApiRouteKey> = ApiContract[K]['method']

// =============================================================================
// 7. URL construction
// =============================================================================

/** Trailing slashes on the base and the leading slash on the path, reconciled. */
function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '')
  const normalisedPath = path.startsWith('/') ? path : `/${path}`

  return `${trimmedBase}${normalisedPath}`
}

/**
 * Builds the absolute URL for a route.
 *
 * The third argument is typed as the route's own path parameters, so a missing
 * or misspelled one is a compile error rather than a `/undefined` in the URL.
 * Routes whose path is constant take `{}`:
 *
 * ```ts
 * buildUrl(API_BASE, ApiContract['menu.list'], {})
 * buildUrl(API_BASE, ApiContract['menu.detail'], { slug: 'chef-tasting-menu' })
 * ```
 *
 * `base` is the origin the client is pointed at — `''` in the web app, where a
 * relative path is correct, and `process.env.EXPO_PUBLIC_API_URL` in Expo. It is
 * never read from the request, so a forged `Host` header cannot redirect a call.
 */
export function buildUrl<TParams extends PathParams = NoPathParams>(
  base: string,
  entry: { readonly path: (params: TParams) => string },
  params: TParams
): string {
  return joinUrl(base, entry.path(params))
}

/**
 * Serialises a parsed GET input into query parameters.
 *
 * The rules match what the filter schemas expect back: `undefined` is dropped
 * so a default is not overridden with an empty string, arrays repeat their key
 * (`tagSlugs=vegan&tagSlugs=gluten-free`, which `z.array` re-reads via
 * `getAll`), `Date` becomes an ISO string for `isoDateTimeSchema`, and booleans
 * become `'true'` / `'false'`. `null` is sent through as an empty value so a
 * filter can be explicitly cleared.
 */
export function toSearchParams(
  input: Readonly<Record<string, unknown>>
): URLSearchParams {
  const search = new URLSearchParams()

  const append = (key: string, value: unknown): void => {
    if (value === undefined) {
      return
    }

    if (value === null) {
      search.append(key, '')
      return
    }

    if (value instanceof Date) {
      search.append(key, value.toISOString())
      return
    }

    if (Array.isArray(value)) {
      for (const element of value) {
        append(key, element)
      }
      return
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      search.append(key, String(value))
      return
    }

    // Nested objects have no unambiguous query encoding. A route that needs one
    // takes a body instead.
    search.append(key, JSON.stringify(value))
  }

  for (const [key, value] of Object.entries(input)) {
    append(key, value)
  }

  return search
}

/**
 * `buildUrl` with a query string attached — the usual shape of a GET call.
 *
 * ```ts
 * buildQueryUrl(API_BASE, ApiContract['menu.list'], {}, { page: 1, tagSlugs: ['vegan'] })
 * buildQueryUrl(API_BASE, ApiContract['menu.detail'], { slug }, { includeInactive: false })
 * ```
 */
export function buildQueryUrl<TParams extends PathParams = NoPathParams>(
  base: string,
  entry: { readonly path: (params: TParams) => string },
  params: TParams,
  query: Readonly<Record<string, unknown>>
): string {
  const url = joinUrl(base, entry.path(params))
  const search = toSearchParams(query).toString()

  return search.length > 0 ? `${url}?${search}` : url
}

// =============================================================================
// 8. Reading a query string back
//
// `toSearchParams` had no inverse, which is why nothing could check that a GET
// route's own serialisation survives its own input schema. The two halves are
// declared together from here on, and `scripts/verify-round-trip.ts` asserts
// that composing them is the identity for every GET entry in the contract.
// =============================================================================

/**
 * The subset of a zod definition this module reads.
 *
 * Zod does not publish a stable visitor, so the wrappers are walked by hand.
 * Only these four members are touched, and every one of them is optional, so a
 * node shape this does not recognise degrades to "not an array" rather than
 * throwing.
 */
interface SchemaDefNode {
  readonly type: string
  readonly shape?: Readonly<Record<string, unknown>>
  readonly innerType?: unknown
  readonly in?: unknown
  readonly out?: unknown
}

/** How many wrappers deep to walk before giving up. Nothing here nests past 4. */
const MAX_SCHEMA_DEPTH = 8

/** The definition node of a zod schema, or `undefined` for anything else. */
function schemaDef(schema: unknown): SchemaDefNode | undefined {
  if (typeof schema !== 'object' || schema === null) {
    return undefined
  }

  const internals = (schema as { readonly _zod?: unknown })._zod

  if (typeof internals !== 'object' || internals === null) {
    return undefined
  }

  const def = (internals as { readonly def?: unknown }).def

  if (typeof def !== 'object' || def === null) {
    return undefined
  }

  const { type } = def as { readonly type?: unknown }

  return typeof type === 'string' ? (def as SchemaDefNode) : undefined
}

/**
 * True when a field ultimately holds an array, whatever it is wrapped in.
 *
 * The wrappers that actually occur on these filters are
 * `ZodDefault<ZodArray>` (`tagSlugs`, `statuses`, `stages`) and
 * `ZodDefault<ZodPipe<ZodArray, ZodTransform>>` — the shape `freeTextList`
 * produces, where the de-duplicating `.transform()` sits between the default
 * and the array. Both sides of a pipe are examined, because the array may be
 * either the input of a transform or the output of a coercion.
 */
function isArrayField(schema: unknown, depth: number = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) {
    return false
  }

  const def = schemaDef(schema)

  if (def === undefined) {
    return false
  }

  if (def.type === 'array') {
    return true
  }

  if (def.innerType !== undefined) {
    return isArrayField(def.innerType, depth + 1)
  }

  return isArrayField(def.in, depth + 1) || isArrayField(def.out, depth + 1)
}

/** The object shape underneath any wrappers, or `undefined` if there is none. */
function objectShape(
  schema: unknown,
  depth: number = 0
): Readonly<Record<string, unknown>> | undefined {
  if (depth > MAX_SCHEMA_DEPTH) {
    return undefined
  }

  const def = schemaDef(schema)

  if (def === undefined) {
    return undefined
  }

  if (def.shape !== undefined) {
    return def.shape
  }

  if (def.innerType !== undefined) {
    return objectShape(def.innerType, depth + 1)
  }

  return objectShape(def.in, depth + 1)
}

/** Derived once per schema; the contract's schemas are module-level singletons. */
const arrayKeyCache = new WeakMap<object, ReadonlySet<string>>()

/**
 * The keys of a request schema that hold arrays.
 *
 * This is the one thing a query string cannot tell you about itself.
 * `?tagSlugs=vegan&tagSlugs=nut-free` is unambiguously a list, but
 * `?tagSlugs=vegan` is indistinguishable from a scalar, and reading it as one
 * hands `z.array(...)` a bare string — a 400 on the single-element case only,
 * which is exactly the sort of defect that survives a hand-written test suite.
 *
 * The schema already knows the answer, so it is asked rather than a second list
 * of array keys being kept in step by hand.
 */
export function queryArrayKeys(schema: z.ZodType): ReadonlySet<string> {
  const cached = arrayKeyCache.get(schema)

  if (cached !== undefined) {
    return cached
  }

  const shape = objectShape(schema)
  const keys = new Set<string>()

  if (shape !== undefined) {
    for (const [key, field] of Object.entries(shape)) {
      if (isArrayField(field)) {
        keys.add(key)
      }
    }
  }

  arrayKeyCache.set(schema, keys)

  return keys
}

/**
 * The inverse of {@link toSearchParams}: a query string, read back into the bag
 * a route's input schema expects.
 *
 * ```ts
 * const entry = ApiContract['menu.list']
 * const parsed = entry.input.safeParse(fromSearchParams(url.search, entry.input))
 * ```
 *
 * A key listed by {@link queryArrayKeys} always yields an array, even with one
 * value or none; every other key yields the string it carried, and a key that
 * repeats anyway yields an array so the schema reports the mistake rather than
 * this function silently discarding a value.
 *
 * `null` does not survive the round trip, and should not: `toSearchParams`
 * writes it as an empty value, so it returns as `''`. That is precisely what a
 * browser sends for a control that was rendered and left blank, and the filter
 * schemas already read `''` as "no filter" through `withNumericCoercion` and
 * the trimming `.transform()`s on their search fields.
 */
export function fromSearchParams(
  search: URLSearchParams | string,
  schema: z.ZodType
): Record<string, string | readonly string[]> {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search
  const arrayKeys = queryArrayKeys(schema)
  const result: Record<string, string | readonly string[]> = {}

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)

    if (arrayKeys.has(key) || values.length > 1) {
      result[key] = values
      continue
    }

    const [only] = values

    if (only !== undefined) {
      result[key] = only
    }
  }

  return result
}
