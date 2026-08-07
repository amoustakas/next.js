// mannachef/apps/web/scripts/fixtures/billing-harness.ts

/**
 * The plumbing the two MCV-041 regressions share.
 *
 * `verify-subscription-proration.ts` (finding C) and
 * `verify-referral-redemption-parity.ts` (finding F) are separate claims and
 * each transcript stands on its own. What they have in common is the cast, the
 * disposable database, the plan ladder and the Stripe recorder, so those live
 * here.
 *
 * ## A real PostgreSQL, and the real actions
 *
 * Finding C is a claim about the payload `changeSubscription` builds, and every
 * step between the request and that payload is load-bearing to it:
 * `subscriptionChangeSchema`'s defaults, `requireSubscriptionOwnership`'s
 * `SELECT`, `isBillingAdmin`'s threshold, the plan-direction checks. Substitute
 * any of them and the harness measures the substitute. So the actions, the
 * `withAction` wrapper, the zod schemas, the guards, the rate limiter and the
 * SQL are all real.
 *
 * Finding F is a claim about **three call sites agreeing**, one of which is an
 * HTTP route with a signature check on it. There is no version of that claim a
 * fake database could answer.
 *
 * ## What is substituted
 *
 * The session, the three request-scoped Next.js modules `guards.ts` imports at
 * module scope, and Stripe's HTTP — the last through the `globalThis` slot
 * `@/server/stripe` already memoises its client into, so `@/server/stripe`
 * itself is the shipped module. See `fixtures/stripe-recorder.ts`. Nothing
 * under `src/` knows this file exists.
 */

import type { changeSubscription } from '@/server/actions/billing'
import { prisma } from '@/server/db'

import { clearRateLimits } from './database'
import { signInAs, type HarnessUser } from './harness-state'

export { check, checkCount, money, note, printTable, section } from './report'

export { assertDisposableDatabase, clearRateLimits } from './database'

// =============================================================================
// 1. The database
// =============================================================================

/**
 * Empty every table these harnesses write to.
 *
 * `User` cascades to `UserSubscription`, `Invoice`, the referral codes it owns,
 * the redemptions it received, its reward balance and its ledger entries. Three
 * tables are not owned by a user and are cleared explicitly: `SubscriptionPlan`
 * (the house's ladder), `ReferralProgram` (a singleton), and `StripeEvent` (the
 * webhook's idempotency ledger, which would otherwise make the second run of a
 * scenario a replay).
 */
export async function resetDatabase(): Promise<void> {
  await prisma.user.deleteMany({})
  await prisma.subscriptionPlan.deleteMany({})
  await prisma.referralProgram.deleteMany({})
  await prisma.stripeEvent.deleteMany({})

  clearRateLimits()
  signInAs(null)
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}

// =============================================================================
// 2. The cast
// =============================================================================

/**
 * Ids are literal cuids because every one of them travels through `cuidSchema`
 * before an action body is reached; a readable placeholder would be rejected by
 * validation and the scenario would prove nothing.
 */
export const SUBSCRIBER: HarnessUser = {
  id: 'cusersubscriber000000001',
  name: 'Mallory Quist',
  email: 'mallory.quist@example.net',
  image: null,
  role: 'CLIENT',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: 'cclientsubscriber0000001',
  staffProfileId: null,
}

/**
 * The same person's second account, opened under a plus-addressed alias of the
 * same inbox. Finding F's whole exploit.
 */
export const ALIAS: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cuseralias0000000000002',
  name: 'M. Quist',
  email: 'mallory.quist+dinner@example.net',
  clientProfileId: 'cclientalias000000000002',
}

/** An unrelated household, so the harness can show a genuine referral working. */
export const NEIGHBOUR: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cuserneighbour0000000003',
  name: 'Eleanor Whitcombe',
  email: 'eleanor.whitcombe@example.com',
  clientProfileId: 'cclientneighbour00000003',
}

/** A billing administrator. `isBillingAdmin` is `ADMIN` and above. */
export const CONCIERGE: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cuserconcierge00000000004',
  name: 'The Concierge',
  email: 'concierge@mannachef.test',
  role: 'ADMIN',
  clientProfileId: null,
}

/** A chef. Deliberately **not** privileged in the billing module. */
export const CHEF: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cuserchef000000000000005',
  name: 'Chef Aurélien',
  email: 'aurelien@mannachef.test',
  role: 'CHEF_STAFF',
  clientProfileId: null,
  staffProfileId: 'cstaffchef0000000000005',
}

// =============================================================================
// 3. Seeding
// =============================================================================

export async function seedUser(person: HarnessUser): Promise<void> {
  await prisma.user.create({
    data: {
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role,
      isActive: person.isActive,
      timeZone: person.timeZone,
      locale: person.locale,
      ...(person.clientProfileId === null
        ? {}
        : {
            clientProfile: {
              create: {
                id: person.clientProfileId,
                displayName: person.name,
                preferredName: person.name,
                status: 'ACTIVE_SUBSCRIBER',
                source: 'DIRECT',
                phone: '+14165550188',
                preferredContactMethod: 'EMAIL',
              },
            },
          }),
    },
    select: { id: true },
  })
}

export interface SeedPlan {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly priceCents: number
  readonly stripePriceId: string
}

/**
 * One rung of the ladder.
 *
 * Written with the raw client on purpose. This is the *world the actions find*,
 * not a thing under test, and building it through `createSubscriptionPlan`
 * would make each scenario's premise depend on another action being correct —
 * and on Stripe, which that action retrieves the price from.
 */
export async function seedPlan(plan: SeedPlan): Promise<void> {
  await prisma.subscriptionPlan.create({
    data: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      interval: 'MONTH',
      intervalCount: 1,
      priceCents: plan.priceCents,
      currency: 'CAD',
      mealsPerWeek: 3,
      servingsPerMeal: 2,
      features: [],
      isActive: true,
      stripePriceId: plan.stripePriceId,
      stripeProductId: `prod_${plan.slug}`,
    },
    select: { id: true },
  })
}

export interface SeedSubscription {
  readonly id: string
  readonly userId: string
  readonly planId: string
  readonly quantity: number
  readonly stripeCustomerId: string
  readonly stripeSubscriptionId: string
  readonly currentPeriodStart: Date
  readonly currentPeriodEnd: Date
}

export async function seedSubscription(seed: SeedSubscription): Promise<void> {
  await prisma.userSubscription.create({
    data: {
      id: seed.id,
      userId: seed.userId,
      planId: seed.planId,
      status: 'ACTIVE',
      quantity: seed.quantity,
      currency: 'CAD',
      stripeCustomerId: seed.stripeCustomerId,
      stripeSubscriptionId: seed.stripeSubscriptionId,
      currentPeriodStart: seed.currentPeriodStart,
      currentPeriodEnd: seed.currentPeriodEnd,
      cancelAtPeriodEnd: false,
    },
    select: { id: true },
  })
}

/** A `PAID` invoice, which is what `findQualifyingInvoice` looks for. */
export async function seedPaidInvoice(
  userId: string,
  amountCents: number,
  paidAt: Date
): Promise<void> {
  await prisma.invoice.create({
    data: {
      userId,
      amountDueCents: amountCents,
      amountPaidCents: amountCents,
      amountRemainingCents: 0,
      subtotalCents: amountCents,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: paidAt,
      paidAt,
    },
    select: { id: true },
  })
}

/** The standing referral offer. @see `@/server/referral-program` */
export interface SeedProgram {
  readonly rewardValueCents: number
  readonly minimumQualifyingInvoiceCents: number
}

export async function seedProgram(seed: SeedProgram): Promise<void> {
  await prisma.referralProgram.create({
    data: {
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: seed.rewardValueCents,
      rewardValuePercent: null,
      currency: 'CAD',
      refereeRewardCents: null,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: seed.minimumQualifyingInvoiceCents,
      isActive: true,
    },
    select: { id: true },
  })
}

// =============================================================================
// 4. Reading the world back
// =============================================================================

export interface SubscriptionSnapshot {
  readonly planId: string
  readonly quantity: number
  readonly status: string
}

export async function subscriptionSnapshot(
  id: string
): Promise<SubscriptionSnapshot> {
  const row = await prisma.userSubscription.findUniqueOrThrow({
    where: { id },
    select: { planId: true, quantity: true, status: true },
  })

  return row
}

export interface RedemptionSnapshot {
  readonly referredUserId: string
  readonly status: string
  readonly qualifiedAt: Date | null
  readonly rewardCents: number | null
}

export async function redemptionsForCode(
  referralCodeId: string
): Promise<readonly RedemptionSnapshot[]> {
  return prisma.referralRedemption.findMany({
    where: { referralCodeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      referredUserId: true,
      status: true,
      qualifiedAt: true,
      rewardCents: true,
    },
  })
}

export async function redemptionCountOf(
  referralCodeId: string
): Promise<number> {
  const row = await prisma.referralCode.findUnique({
    where: { id: referralCodeId },
    select: { redemptionCount: true },
  })

  return row?.redemptionCount ?? -1
}

export async function balanceCentsOf(userId: string): Promise<number> {
  const row = await prisma.rewardBalance.findUnique({
    where: { userId },
    select: { balanceCents: true },
  })

  return row?.balanceCents ?? 0
}

// =============================================================================
// 5. Payloads
//
// Typed as the action's own parameter, for the reason the MCV-040 harnesses
// give: a schema that stopped accepting one of these would fail `tsc` here
// rather than quietly leave a harness testing nothing.
// =============================================================================

export type SubscriptionChangePayload = Parameters<typeof changeSubscription>[0]
