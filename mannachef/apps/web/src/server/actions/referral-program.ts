// mannachef/apps/web/src/server/actions/referral-program.ts

'use server'

/**
 * The house's standing referral offer, configured from the admin OS.
 *
 * One singleton row, two actions: an `ADMIN` may read the offer, and a
 * `SUPER_ADMIN` may set it. The rule itself — what the offer means, and how a
 * code minted from it is priced — lives in `@/server/referral-program`, which
 * both this module and `./referral.ts` import; a `'use server'` module may only
 * export async functions, so it could not have lived in either of them.
 *
 * ## Why the split is `ADMIN` read / `SUPER_ADMIN` write
 *
 * Reading the offer is the same kind of act as reading the growth table: an
 * operator answering "why is this code worth forty dollars" needs to see it,
 * and the row contains nothing about any individual household. Writing it is
 * the same kind of act as {@link recordRewardAdjustment} in `./referral.ts`,
 * which is `SUPER_ADMIN` for exactly this reason: this is the row that decides
 * what every future client-minted invitation will cost the business, so setting
 * it is finance rather than operations. The one action in `./referral.ts` that
 * sits between them — `settleReferralRedemptions` at `ADMIN` — is there because
 * it has no discretion at all. This one is nothing but discretion.
 *
 * ## Why an upsert rather than a create and an update
 *
 * There is exactly one row and its key is `@unique`, so "create" and "update"
 * are the same intention performed against a table that may or may not have
 * been initialised yet. `referralProgramUpsertSchema` is a discriminated union
 * over `rewardType` stating the whole offer at once, which means the reward
 * triple is written as a coherent whole and nothing here has to merge a partial
 * payload against what is already stored — the failure mode
 * `referralCodeUpdateSchema` needs a `superRefine` and `mergedRewardIsCoherent`
 * to police on the per-code path.
 *
 * ## What is not accepted from the payload
 *
 * `updatedById` — it is the session's, as `createdById` is on every ledger
 * entry. A payload that could name its own author would make the audit column
 * worth nothing.
 */

import {
  referralProgramReadSchema,
  referralProgramUpsertSchema,
} from '@mannachef/validators'

import { ok, type ActionResult } from '@/server/actions/types'
import { Prisma } from '@/server/db'
import { withAction } from '@/server/guards'
import {
  readReferralProgramRow,
  toReferralProgramView,
  REFERRAL_PROGRAM_SELECT,
  type ReferralProgramView,
} from '@/server/referral-program'

// =============================================================================
// 0. Constants
// =============================================================================

/**
 * The screens whose content depends on the offer.
 *
 * `/portal/referrals` is included because it is where a subscriber asks for a
 * code, and what they will be given changed the moment this row did.
 */
const PROGRAM_PATHS = [
  '/admin/growth',
  '/admin/settings',
  '/portal/referrals',
] as const

const PROGRAM_TAGS = ['referral-program', 'referrals'] as const

// =============================================================================
// 1. Read
// =============================================================================

/**
 * The offer as it stands, or `null` when the platform has never configured one.
 *
 * `null` rather than a manufactured default row: "no offer has been made" and
 * "an offer has been made and it is switched off" are different states of the
 * business, and a screen that cannot tell them apart cannot prompt for the
 * first. It is also what a subscriber is refused against — see
 * `NO_PROGRAM_OFFER_MESSAGE`.
 */
export const readReferralProgram = withAction(
  {
    name: 'referral.program.read',
    auth: 'ADMIN',
    input: referralProgramReadSchema,
  },
  async (ctx, input): Promise<ActionResult<ReferralProgramView | null>> => {
    const row = await readReferralProgramRow(ctx.db, input.key)

    return ok(row === null ? null : toReferralProgramView(row))
  }
)

// =============================================================================
// 2. Write
// =============================================================================

/**
 * Set the standing offer.
 *
 * The reward triple is rebuilt from the discriminant rather than spread from
 * the payload, so the column that does not belong to this reward kind is
 * written `null` explicitly. Without that, switching a `FIXED_CREDIT` offer to
 * `PERCENT_DISCOUNT` would leave the old cash value sitting in
 * `rewardValueCents` — and the `ReferralProgram_reward_pairing_check`
 * constraint would reject the write, which is the right outcome but a
 * `CONFLICT` the operator did nothing to deserve.
 *
 * `create` and `update` carry the same figures because an upsert of a singleton
 * is a statement about the whole row either way.
 */
export const updateReferralProgram = withAction(
  {
    name: 'referral.program.update',
    auth: 'SUPER_ADMIN',
    input: referralProgramUpsertSchema,
    revalidatePaths: PROGRAM_PATHS,
    revalidateTags: PROGRAM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralProgramView>> => {
    // Narrowed on the discriminant itself, exactly as `statedCodeTerms` in
    // `./referral.ts` is, so each value column is read from the branch that
    // actually declares it.
    const reward =
      input.rewardType === 'PERCENT_DISCOUNT'
        ? {
            rewardValueCents: null,
            rewardValuePercent: input.rewardValuePercent,
          }
        : {
            rewardValueCents: input.rewardValueCents,
            rewardValuePercent: null,
          }

    const figures = {
      rewardType: input.rewardType,
      ...reward,
      currency: input.currency,
      refereeRewardCents: input.refereeRewardCents ?? null,
      defaultMaxRedemptions: input.defaultMaxRedemptions ?? null,
      defaultExpiryDays: input.defaultExpiryDays ?? null,
      minimumQualifyingInvoiceCents: input.minimumQualifyingInvoiceCents,
      isActive: input.isActive,
      // From the session, never from the payload.
      updatedById: ctx.user.id,
    } satisfies Omit<Prisma.ReferralProgramUncheckedCreateInput, 'key'>

    const row = await ctx.db.referralProgram.upsert({
      where: { key: input.key },
      create: { key: input.key, ...figures },
      update: figures,
      select: REFERRAL_PROGRAM_SELECT,
    })

    return ok(toReferralProgramView(row))
  }
)
