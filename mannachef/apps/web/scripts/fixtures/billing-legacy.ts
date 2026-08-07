// mannachef/apps/web/scripts/fixtures/billing-legacy.ts

/**
 * The pre-MCV-041 source of the two fragments this task changed, reproduced so
 * the "before" column of each transcript is produced by **running the defect**
 * rather than by asserting a comment.
 *
 * The technique and its justification are `fixtures/intake-legacy.ts`'s: the
 * only lever that would let the shipped files run both ways is a flag inside
 * the shipped files, which is a worse thing to have in a codebase than a
 * fixture is.
 *
 * Transcribed from
 * `git show 6ca23610:mannachef/apps/web/src/server/actions/billing.ts` (lines
 * 2026 and 2036–2039) and
 * `git show 6ca23610:mannachef/apps/web/src/app/api/webhooks/stripe/route.ts`
 * (lines 1051–1123), verbatim, comments included.
 *
 * ## The copies are checked, not trusted
 *
 * A transcription is evidence only for as long as it still matches. Each
 * harness therefore asserts that the legacy path and the shipped code agree
 * where they are *supposed* to agree — the proration harness compares the
 * `proration_behavior` each derives for the request the schema's own defaults
 * produce, and the redemption harness compares the row each writes for a
 * genuine, unrelated referral. If a future edit changes what the real code does
 * and nobody updates these copies, that assertion fails and says so, rather
 * than leaving a harness quietly measuring a codebase that no longer exists.
 *
 * Nothing under `src/` imports this file, and nothing here is reachable from
 * the application.
 */

import type {
  ChangeEffectiveAt,
  ProrationBehavior,
} from '@mannachef/validators'
import type Stripe from 'stripe'

import { Prisma, prisma } from '@/server/db'

// =============================================================================
// 1. `changeSubscription` — pre-fix (billing.ts lines 2026, 2036–2039)
//
// The whole of finding C is these two expressions. `price:
// target.stripePriceId` sat between them and was unconditional, so the plan
// always moved; what the caller controlled was solely whether the move was
// billed.
// =============================================================================

/** The pre-fix quantity: the caller's figure, whoever the caller was. */
export function legacyQuantity(
  input: { readonly quantity?: number | undefined },
  current: { readonly quantity: number }
): number {
  return input.quantity ?? current.quantity
}

/**
 * The pre-fix `proration_behavior`, verbatim:
 *
 * ```ts
 * proration_behavior:
 *   input.effectiveAt === 'PERIOD_END'
 *     ? 'none'
 *     : input.prorationBehavior,
 * ```
 *
 * Two caller-suppliable fields, either of which reaches `'none'` on its own.
 */
export function legacyProrationBehavior(input: {
  readonly effectiveAt: ChangeEffectiveAt
  readonly prorationBehavior: ProrationBehavior
}): Stripe.SubscriptionUpdateParams.ProrationBehavior {
  return input.effectiveAt === 'PERIOD_END' ? 'none' : input.prorationBehavior
}

// =============================================================================
// 2. `recordReferralRedemption` — pre-fix (webhook route lines 1051–1123)
//
// Four checks, and then a `QUALIFIED` row. Missing against
// `redeemReferralCode`: `sharesEmailIdentity`, the one-live-redemption rule,
// the compare-and-swap on the counter, and — the one that decides money —
// `findQualifyingInvoice` against the programme's floor.
// =============================================================================

export async function legacyRecordReferralRedemption(
  referralCodeId: string,
  referredUserId: string
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const code = await tx.referralCode.findUnique({
        where: { id: referralCodeId },
        select: {
          id: true,
          ownerId: true,
          isActive: true,
          expiresAt: true,
          maxRedemptions: true,
          redemptionCount: true,
          rewardValueCents: true,
          currency: true,
        },
      })

      if (code === null || !code.isActive || code.ownerId === referredUserId) {
        return
      }

      if (code.expiresAt !== null && code.expiresAt.getTime() <= Date.now()) {
        return
      }

      if (
        code.maxRedemptions !== null &&
        code.redemptionCount >= code.maxRedemptions
      ) {
        return
      }

      const existing = await tx.referralRedemption.findUnique({
        where: {
          referralCodeId_referredUserId: {
            referralCodeId: code.id,
            referredUserId,
          },
        },
        select: { id: true },
      })

      if (existing !== null) {
        return
      }

      await tx.referralRedemption.create({
        data: {
          referralCodeId: code.id,
          referredUserId,
          status: 'QUALIFIED',
          qualifiedAt: new Date(),
          rewardCents: code.rewardValueCents,
          currency: code.currency,
        },
      })

      await tx.referralCode.update({
        where: { id: code.id },
        data: { redemptionCount: { increment: 1 } },
      })
    })
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
// 3. `resolveReferralCode` — pre-fix (billing.ts lines 1714–1770)
//
// The Checkout pre-flight. Five checks, and neither of the two that make the
// household heuristic: no `sharesEmailIdentity`, no one-live-redemption rule.
// Reproduced as a predicate rather than as the `{ failure }` envelope the
// action wanted, because what the harness needs from it is the verdict.
// =============================================================================

export async function legacyReferralCodeIsAcceptable(
  userId: string,
  code: string
): Promise<boolean> {
  const row = await prisma.referralCode.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      ownerId: true,
      isActive: true,
      expiresAt: true,
      maxRedemptions: true,
      redemptionCount: true,
    },
  })

  if (row === null || !row.isActive) {
    return false
  }

  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return false
  }

  if (
    row.maxRedemptions !== null &&
    row.redemptionCount >= row.maxRedemptions
  ) {
    return false
  }

  if (row.ownerId === userId) {
    return false
  }

  const alreadyRedeemed = await prisma.referralRedemption.findUnique({
    where: {
      referralCodeId_referredUserId: {
        referralCodeId: row.id,
        referredUserId: userId,
      },
    },
    select: { id: true },
  })

  return alreadyRedeemed === null
}
