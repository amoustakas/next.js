// mannachef/packages/validators/src/enums.ts

/**
 * Zod mirrors of every enum declared in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * This module deliberately has **no** runtime dependency on `@prisma/client`: the
 * values are re-declared here so that the validators package can be consumed by
 * the Expo client, edge runtimes, and any other environment where the generated
 * Prisma client is neither present nor desirable. The values must therefore stay
 * character-for-character identical to the Prisma schema — a mismatch is a bug.
 *
 * Convention: `<camelCaseEnumName>Schema` plus an inferred type named exactly
 * after the Prisma enum, e.g. `roleSchema` / `Role`.
 */

import { z } from 'zod'

// =============================================================================
// 1. IDENTITY
// =============================================================================

export const roleSchema = z.enum(
  ['SUPER_ADMIN', 'ADMIN', 'CHEF_STAFF', 'CLIENT'],
  { error: 'Please choose one of the available access levels.' }
)
export type Role = z.infer<typeof roleSchema>

export const clientStatusSchema = z.enum(
  ['PROSPECT', 'LEAD_QUALIFIED', 'ACTIVE_SUBSCRIBER', 'PAUSED', 'CHURNED'],
  { error: 'Please choose a status from the client lifecycle.' }
)
export type ClientStatus = z.infer<typeof clientStatusSchema>

export const clientSourceSchema = z.enum(
  [
    'ORGANIC_SEARCH',
    'PAID_SEARCH',
    'SOCIAL',
    'REFERRAL',
    'PARTNER',
    'EVENT',
    'WORD_OF_MOUTH',
    'DIRECT',
    'OTHER',
  ],
  { error: 'Please tell us how this client found us.' }
)
export type ClientSource = z.infer<typeof clientSourceSchema>

export const contactMethodSchema = z.enum(
  ['EMAIL', 'PHONE', 'SMS', 'IN_APP'],
  { error: 'Please choose how you would prefer to be reached.' }
)
export type ContactMethod = z.infer<typeof contactMethodSchema>

// =============================================================================
// 2. MENU PRIMITIVES
// =============================================================================

export const tagKindSchema = z.enum(
  ['DIETARY', 'ALLERGEN', 'CUISINE', 'TECHNIQUE', 'OCCASION'],
  { error: 'Please choose the kind of tag you are creating.' }
)
export type TagKind = z.infer<typeof tagKindSchema>

export const spiceLevelSchema = z.enum(
  ['NONE', 'MILD', 'MEDIUM', 'HOT', 'FIERY'],
  { error: 'Please choose a heat level for this dish.' }
)
export type SpiceLevel = z.infer<typeof spiceLevelSchema>

export const measurementUnitSchema = z.enum(
  [
    'GRAM',
    'KILOGRAM',
    'MILLILITER',
    'LITER',
    'OUNCE',
    'POUND',
    'TEASPOON',
    'TABLESPOON',
    'CUP',
    'PIECE',
    'CLOVE',
    'BUNCH',
    'SLICE',
    'PINCH',
    'TO_TASTE',
  ],
  { error: 'Please choose a unit of measure for this ingredient.' }
)
export type MeasurementUnit = z.infer<typeof measurementUnitSchema>

// =============================================================================
// 3. MEDIA
// =============================================================================

export const mediaProviderSchema = z.enum(
  ['UPLOADTHING', 'S3', 'CLOUDINARY', 'VERCEL_BLOB', 'EXTERNAL'],
  { error: 'Please choose where this asset is hosted.' }
)
export type MediaProvider = z.infer<typeof mediaProviderSchema>

export const mediaKindSchema = z.enum(
  ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO'],
  { error: 'Please choose the kind of media you are adding.' }
)
export type MediaKind = z.infer<typeof mediaKindSchema>

// =============================================================================
// 4. REVIEWS
// =============================================================================

export const reviewSubjectSchema = z.enum(
  ['MENU_ITEM', 'CHEF', 'PLATFORM', 'APPOINTMENT'],
  { error: 'Please tell us what this review is about.' }
)
export type ReviewSubject = z.infer<typeof reviewSubjectSchema>

export const reviewStatusSchema = z.enum(
  ['PENDING', 'APPROVED', 'REJECTED', 'FEATURED'],
  { error: 'Please choose a moderation status for this review.' }
)
export type ReviewStatus = z.infer<typeof reviewStatusSchema>

// =============================================================================
// 5. BILLING
// =============================================================================

export const billingIntervalSchema = z.enum(
  ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'],
  { error: 'Please choose how often this plan renews.' }
)
export type BillingInterval = z.infer<typeof billingIntervalSchema>

/**
 * Mirrors Stripe's `subscription.status`. Stripe's American single-L spelling of
 * `CANCELED` is preserved deliberately so webhook mapping is a straight uppercase.
 */
export const subscriptionStatusSchema = z.enum(
  [
    'INCOMPLETE',
    'INCOMPLETE_EXPIRED',
    'TRIALING',
    'ACTIVE',
    'PAST_DUE',
    'CANCELED',
    'UNPAID',
    'PAUSED',
  ],
  { error: 'Please choose a valid subscription status.' }
)
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>

/** Mirrors Stripe's `invoice.status`. */
export const invoiceStatusSchema = z.enum(
  ['DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID'],
  { error: 'Please choose a valid invoice status.' }
)
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>

/** Mirrors Stripe's `payment_intent.status` plus terminal refund states. */
export const paymentStatusSchema = z.enum(
  [
    'REQUIRES_PAYMENT_METHOD',
    'REQUIRES_CONFIRMATION',
    'REQUIRES_ACTION',
    'PROCESSING',
    'SUCCEEDED',
    'CANCELED',
    'FAILED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
  ],
  { error: 'Please choose a valid payment status.' }
)
export type PaymentStatus = z.infer<typeof paymentStatusSchema>

export const paymentMethodTypeSchema = z.enum(
  [
    'CARD',
    'ACH_DEBIT',
    'BANK_TRANSFER',
    'INTERAC',
    'CASH',
    'CHEQUE',
    'CREDIT_BALANCE',
    'OTHER',
  ],
  { error: 'Please choose how this payment was made.' }
)
export type PaymentMethodType = z.infer<typeof paymentMethodTypeSchema>

export const invoiceLineKindSchema = z.enum(
  [
    'SUBSCRIPTION',
    'APPOINTMENT',
    'MENU_ITEM',
    'INGREDIENT_COST',
    'TRAVEL',
    'GRATUITY',
    'DISCOUNT',
    'TAX',
    'OTHER',
  ],
  { error: 'Please choose what this line item represents.' }
)
export type InvoiceLineKind = z.infer<typeof invoiceLineKindSchema>

// =============================================================================
// 6. GROWTH
// =============================================================================

export const rewardTypeSchema = z.enum(
  ['FIXED_CREDIT', 'PERCENT_DISCOUNT', 'FREE_MEAL', 'FREE_DELIVERY'],
  { error: 'Please choose the reward this code should grant.' }
)
export type RewardType = z.infer<typeof rewardTypeSchema>

export const referralRedemptionStatusSchema = z.enum(
  ['PENDING', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'REVOKED'],
  { error: 'Please choose a valid redemption status.' }
)
export type ReferralRedemptionStatus = z.infer<
  typeof referralRedemptionStatusSchema
>

export const rewardLedgerDirectionSchema = z.enum(['CREDIT', 'DEBIT'], {
  error: 'Please indicate whether this entry credits or debits the balance.',
})
export type RewardLedgerDirection = z.infer<typeof rewardLedgerDirectionSchema>

export const rewardLedgerReasonSchema = z.enum(
  [
    'REFERRAL_REWARD',
    'REFERRAL_SIGNUP_BONUS',
    'PROMOTIONAL_GRANT',
    'MANUAL_ADJUSTMENT',
    'INVOICE_REDEMPTION',
    'EXPIRATION',
    'REVERSAL',
  ],
  { error: 'Please choose a reason for this ledger entry.' }
)
export type RewardLedgerReason = z.infer<typeof rewardLedgerReasonSchema>

// =============================================================================
// 7. ONBOARDING
// =============================================================================

export const onboardingStageSchema = z.enum(
  [
    'INVITED',
    'ACCOUNT_CREATED',
    'INTAKE_SUBMITTED',
    'CONSULTATION_SCHEDULED',
    'CONSULTATION_COMPLETED',
    'PLAN_SELECTED',
    'PAYMENT_CONFIRMED',
    'FIRST_APPOINTMENT_BOOKED',
    'ACTIVATED',
    'ABANDONED',
  ],
  { error: 'Please choose a stage in the onboarding journey.' }
)
export type OnboardingStage = z.infer<typeof onboardingStageSchema>

export const deliveryFrequencySchema = z.enum(
  ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ON_DEMAND'],
  { error: 'Please choose how often you would like us to cook for you.' }
)
export type DeliveryFrequency = z.infer<typeof deliveryFrequencySchema>

export const consultationOutcomeSchema = z.enum(
  [
    'PENDING',
    'CONVERTED',
    'DECLINED_BY_CLIENT',
    'DECLINED_BY_CHEF',
    'NO_SHOW',
    'RESCHEDULED',
    'FOLLOW_UP_REQUIRED',
  ],
  { error: 'Please record how the consultation concluded.' }
)
export type ConsultationOutcome = z.infer<typeof consultationOutcomeSchema>

// =============================================================================
// 8. CALENDAR
// =============================================================================

export const availabilityRuleKindSchema = z.enum(
  ['RECURRING_WEEKLY', 'DATE_OVERRIDE'],
  { error: 'Please choose whether this rule repeats weekly or covers one date.' }
)
export type AvailabilityRuleKind = z.infer<typeof availabilityRuleKindSchema>

export const bookingSlotStatusSchema = z.enum(
  ['OPEN', 'HELD', 'BOOKED', 'FULL', 'CANCELLED', 'EXPIRED'],
  { error: 'Please choose a valid status for this booking window.' }
)
export type BookingSlotStatus = z.infer<typeof bookingSlotStatusSchema>

export const serviceTypeSchema = z.enum(
  [
    'IN_HOME_DINNER',
    'MEAL_PREP',
    'PRIVATE_EVENT',
    'COOKING_CLASS',
    'TASTING',
    'CATERING',
    'CONSULTATION',
    'DELIVERY_DROP_OFF',
  ],
  { error: 'Please choose the service you would like to arrange.' }
)
export type ServiceType = z.infer<typeof serviceTypeSchema>

export const appointmentStatusSchema = z.enum(
  ['REQUESTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  { error: 'Please choose a valid status for this engagement.' }
)
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>

// =============================================================================
// 9. CRM
// =============================================================================

export const noteVisibilitySchema = z.enum(
  ['PRIVATE', 'STAFF', 'ADMIN_ONLY', 'CLIENT_VISIBLE'],
  { error: 'Please choose who is allowed to read this note.' }
)
export type NoteVisibility = z.infer<typeof noteVisibilitySchema>

export const interactionChannelSchema = z.enum(
  ['EMAIL', 'PHONE', 'SMS', 'IN_APP', 'IN_PERSON'],
  { error: 'Please choose the channel this exchange took place on.' }
)
export type InteractionChannel = z.infer<typeof interactionChannelSchema>

export const interactionDirectionSchema = z.enum(['INBOUND', 'OUTBOUND'], {
  error: 'Please indicate whether this exchange came in or went out.',
})
export type InteractionDirection = z.infer<typeof interactionDirectionSchema>

// =============================================================================
// ROLE HIERARCHY
// =============================================================================

/**
 * Rank of each role, ascending. Higher wins.
 *
 * `SUPER_ADMIN > ADMIN > CHEF_STAFF > CLIENT` — see `mannachef/CONTRACT.md` §5.
 * Shared by the web guards (`apps/web/src/server/guards.ts`) and the Expo client,
 * which is why it lives beside the enum rather than in the app.
 */
export const ROLE_HIERARCHY: Record<Role, number> = {
  CLIENT: 0,
  CHEF_STAFF: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
}

/**
 * Ordered least-privileged first. Useful for rendering role pickers without
 * hand-maintaining a second list.
 */
export const ROLES_BY_PRIVILEGE: readonly Role[] = [
  'CLIENT',
  'CHEF_STAFF',
  'ADMIN',
  'SUPER_ADMIN',
]

/** Narrowing guard for values arriving from a session, JWT, or request body. */
export function isRole(value: unknown): value is Role {
  return roleSchema.safeParse(value).success
}

/**
 * True when `role` sits at or above `minimum` in the hierarchy.
 *
 * Accepts nullish input so callers can pass `session?.user.role` straight
 * through: an absent role is never sufficient.
 *
 * This is an authorization primitive — it must be called inside the server
 * action or route handler, never only in the UI.
 */
export function hasRoleAtLeast(
  role: Role | null | undefined,
  minimum: Role
): boolean {
  if (role == null) {
    return false
  }

  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimum]
}
