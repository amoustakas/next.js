// mannachef/apps/web/src/server/referral-program.ts

/**
 * The house's standing referral offer, and the terms a code minted from it
 * carries.
 *
 * ## Why this is not in `actions/`
 *
 * Two Server Action modules need it — `actions/referral-program.ts`, which is
 * where an owner configures the offer, and `actions/referral.ts`, which is
 * where the offer is *applied* to a code somebody below `ADMIN` has asked for —
 * and a `'use server'` module may only export async functions, so neither could
 * have published `programCodeTerms` to the other. Same reasoning as
 * `@/server/scheduling`: the rule lives in an ordinary server module, the
 * actions are the thin authorised entry points to it.
 *
 * ## What the offer is for (MCV-030)
 *
 * The figures on a `ReferralCode` are a liability the business takes on, and a
 * `CLIENT` may mint one. Before this row existed, `createReferralCode` wrote
 * `rewardValueCents`, `refereeRewardCents` and `maxRedemptions` straight from
 * the payload for *every* caller, so an ordinary subscriber could issue
 * themselves a code worth $10,000 with no redemption cap, have a second account
 * they controlled accept it, pay one invoice, and be credited by the settlement
 * sweep — a movement indistinguishable in the ledger from a referral they had
 * earned.
 *
 * The fix is the ordinary shape of every other server-owned figure in this
 * codebase: `booking.ts` writes `totalCents: staffCaller ? input.totalCents : 0`
 * and `client.ts` writes `vipNotes` only for staff. A reward is the same kind of
 * field, except that discarding the payload leaves a hole — a code has to be
 * worth *something* — and this module is what fills it. Below `ADMIN` the terms
 * come from here and the payload's reward fields are discarded entirely;
 * `ADMIN` and above still state them per code, which is what makes a bespoke
 * arrangement possible at all.
 *
 * ## Off by default
 *
 * `ReferralProgram.isActive` defaults to `false`, so an unconfigured platform
 * makes no offer and a `CLIENT` asking for a code is **refused**. That is the
 * deliberate direction to fail in: the alternative — falling back to some
 * built-in figure — would put a number nobody chose behind a payout.
 */

import {
  REFERRAL_PROGRAM_KEY,
  referralRewardValueKind,
  type ReferralProgramKey,
  type RewardType,
} from '@mannachef/validators'

import { Prisma } from '@/server/db'

// =============================================================================
// 1. The row
// =============================================================================

export const REFERRAL_PROGRAM_SELECT = {
  id: true,
  key: true,
  rewardType: true,
  rewardValueCents: true,
  rewardValuePercent: true,
  currency: true,
  refereeRewardCents: true,
  defaultMaxRedemptions: true,
  defaultExpiryDays: true,
  minimumQualifyingInvoiceCents: true,
  isActive: true,
  updatedById: true,
  updatedAt: true,
} satisfies Prisma.ReferralProgramSelect

export type ReferralProgramRow = Prisma.ReferralProgramGetPayload<{
  select: typeof REFERRAL_PROGRAM_SELECT
}>

/** The offer as the admin OS renders it. Nothing here is a secret from `ADMIN`. */
export interface ReferralProgramView {
  readonly key: string
  readonly rewardType: RewardType
  readonly rewardValueCents: number | null
  readonly rewardValuePercent: number | null
  readonly currency: string
  readonly refereeRewardCents: number | null
  readonly defaultMaxRedemptions: number | null
  readonly defaultExpiryDays: number | null
  readonly minimumQualifyingInvoiceCents: number
  readonly isActive: boolean
  readonly updatedById: string | null
  readonly updatedAt: Date
  /**
   * `false` when the stored reward triple does not pair up — a
   * `FIXED_CREDIT` offer with no `rewardValueCents`, say. The
   * `ReferralProgram_reward_pairing_check` constraint makes that unreachable
   * through SQL on a migrated database, so this is here for the screen to be
   * able to *say so* if it is ever reading one that predates the constraint,
   * rather than for the figure to be silently patched up.
   */
  readonly isCoherent: boolean
}

export function toReferralProgramView(
  row: ReferralProgramRow
): ReferralProgramView {
  return {
    key: row.key,
    rewardType: row.rewardType,
    rewardValueCents: row.rewardValueCents,
    rewardValuePercent: row.rewardValuePercent,
    currency: row.currency,
    refereeRewardCents: row.refereeRewardCents,
    defaultMaxRedemptions: row.defaultMaxRedemptions,
    defaultExpiryDays: row.defaultExpiryDays,
    minimumQualifyingInvoiceCents: row.minimumQualifyingInvoiceCents,
    isActive: row.isActive,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
    isCoherent: programRewardIsCoherent(row),
  }
}

/**
 * Read the standing offer, whatever state it is in.
 *
 * Deliberately *not* filtered on `isActive`: the callers that need an active
 * offer say so themselves, and the two that do not — the admin screen, and the
 * qualification floor — must still see a withdrawn one. A programme switched
 * off stops new codes being minted; it does not retrospectively change what
 * counts as a paid invoice for the codes already in circulation.
 */
export async function readReferralProgramRow(
  db: Prisma.TransactionClient,
  key: ReferralProgramKey = REFERRAL_PROGRAM_KEY
): Promise<ReferralProgramRow | null> {
  return db.referralProgram.findUnique({
    where: { key },
    select: REFERRAL_PROGRAM_SELECT,
  })
}

/** Does the stored reward triple pair up the way the discriminated union says? */
export function programRewardIsCoherent(
  row: Pick<
    ReferralProgramRow,
    'rewardType' | 'rewardValueCents' | 'rewardValuePercent'
  >
): boolean {
  if (referralRewardValueKind(row.rewardType) === 'PERCENT') {
    return row.rewardValuePercent !== null
  }

  return row.rewardValueCents !== null
}

// =============================================================================
// 2. The terms a programme code carries
// =============================================================================

/**
 * Everything about an invitation code that costs the business money.
 *
 * Assembled either from the payload (`ADMIN` and above) or from the standing
 * offer (everybody else), and written to `ReferralCode` as a whole. Keeping it
 * one object is what makes the privilege branch in `createReferralCode` a
 * single expression rather than seven conditionals, each of which would be its
 * own opportunity to forget one.
 */
export interface ReferralCodeTerms {
  readonly rewardType: RewardType
  readonly rewardValueCents: number | null
  readonly rewardValuePercent: number | null
  readonly refereeRewardCents: number | null
  readonly currency: string
  readonly maxRedemptions: number | null
  readonly expiresAt: Date | null
}

/** Milliseconds in a day. `defaultExpiryDays` is counted from the mint. */
const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * What {@link resolveProgramCodeTerms} found.
 *
 * Three outcomes rather than `ReferralCodeTerms | null`, because "we are not
 * making an offer" and "the offer on file does not add up" want different
 * sentences: the first is ordinary and the second is a misconfiguration
 * somebody has to go and fix.
 */
export type ProgramTermsOutcome =
  | { readonly kind: 'terms'; readonly terms: ReferralCodeTerms }
  | { readonly kind: 'noOffer' }
  | { readonly kind: 'misconfigured' }

/** Said to a subscriber when no offer is being made. */
export const NO_PROGRAM_OFFER_MESSAGE =
  'We are not running a referral offer at the moment, so there is no invitation to issue. Please ask the concierge.'

/** Said when the offer exists but its figures do not pair up. */
export const PROGRAM_MISCONFIGURED_MESSAGE =
  'Our referral offer is not set up correctly just now. Please ask the concierge, who has been told.'

/**
 * The terms a code minted from the standing offer carries.
 *
 * The reward triple is rebuilt from the discriminant rather than copied
 * column-for-column, so a row carrying a stale percentage from a shape it no
 * longer has cannot pass one on to a code.
 */
export function programCodeTerms(
  program: ReferralProgramRow,
  now: Date
): ReferralCodeTerms {
  const isPercent = referralRewardValueKind(program.rewardType) === 'PERCENT'

  return {
    rewardType: program.rewardType,
    rewardValueCents: isPercent ? null : program.rewardValueCents,
    rewardValuePercent: isPercent ? program.rewardValuePercent : null,
    refereeRewardCents: program.refereeRewardCents,
    currency: program.currency,
    maxRedemptions: program.defaultMaxRedemptions,
    expiresAt:
      program.defaultExpiryDays === null
        ? null
        : new Date(now.getTime() + program.defaultExpiryDays * DAY_MS),
  }
}

/**
 * Read the offer and turn it into terms, or say why it cannot be.
 *
 * An offer that is absent and one that is switched off are the same answer on
 * purpose: neither is an offer, and telling a subscriber which of the two it is
 * tells them nothing they can act on.
 */
export async function resolveProgramCodeTerms(
  db: Prisma.TransactionClient,
  now: Date,
  key: ReferralProgramKey = REFERRAL_PROGRAM_KEY
): Promise<ProgramTermsOutcome> {
  const program = await readReferralProgramRow(db, key)

  if (program === null || !program.isActive) {
    return { kind: 'noOffer' }
  }

  if (!programRewardIsCoherent(program)) {
    return { kind: 'misconfigured' }
  }

  return { kind: 'terms', terms: programCodeTerms(program, now) }
}

// =============================================================================
// 3. The qualification floor
// =============================================================================

/**
 * The floor a referred household's first paid invoice has to clear before the
 * referral counts as earned, in whole cents.
 *
 * `0` when no programme row exists at all, which is the same answer the column
 * defaults to and the same behaviour the platform had before MCV-030 — every
 * paid invoice qualifies. Read from the row **whether or not the offer is
 * active**, for the reason given on {@link readReferralProgramRow}: switching
 * the offer off withdraws it from new codes, it does not change what "paid"
 * means for the ones already out there.
 *
 * Every caller of `findQualifyingInvoice` passes this. It is not defaulted at
 * the call site, because `0` is the permissive reading and a default that
 * quietly picks the permissive branch is a default that is doing the deciding —
 * which is precisely the abuse this half of MCV-030 closed: without a floor, a
 * one-dollar invoice earns a full referral reward.
 */
export async function readQualifyingFloorCents(
  db: Prisma.TransactionClient,
  key: ReferralProgramKey = REFERRAL_PROGRAM_KEY
): Promise<number> {
  const program = await db.referralProgram.findUnique({
    where: { key },
    select: { minimumQualifyingInvoiceCents: true },
  })

  return program?.minimumQualifyingInvoiceCents ?? 0
}
