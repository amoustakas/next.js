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
 */

import { sharesEmailIdentity } from '@mannachef/validators'
import type { ReferralRedemptionStatus } from '@mannachef/validators'

import { Prisma } from '@/server/db'

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
   */
  readonly applyHouseholdHeuristic: boolean
}

export type RedemptionEligibility =
  | { readonly kind: 'eligible'; readonly code: EligibleReferralCode }
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

  return { kind: 'eligible', code }
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
 * ## The counter
 *
 * `redemptionCount` is bumped with `updateMany` guarded on its prior value — a
 * compare-and-swap. Two guests taking the last seat of a capped code therefore
 * produce one redemption and one `raced`; the loser's `create` is rolled back
 * with the caller's transaction, which is why this must be called inside one.
 */
export async function createReferralRedemption(
  tx: Prisma.TransactionClient,
  code: EligibleReferralCode,
  referredUserId: string
): Promise<RedemptionWriteOutcome> {
  const created = await tx.referralRedemption.create({
    data: {
      referralCodeId: code.id,
      referredUserId,
      status: 'PENDING',
      currency: code.currency,
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
