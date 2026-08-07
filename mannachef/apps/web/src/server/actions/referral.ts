// mannachef/apps/web/src/server/actions/referral.ts

'use server'

/**
 * Growth — invitation codes, their redemptions, and the append-only ledger that
 * sits behind every credit balance on the platform.
 *
 * ## A reward is earned when money arrives, not when somebody signs up
 *
 * This is the single most important rule in the file, and it is enforced in
 * three separate places so that no path around it exists:
 *
 *  - {@link redeemReferralCode} writes a `PENDING` redemption and **nothing
 *    else**. No ledger entry, no balance movement. A signup is a claim on a
 *    future reward, not a reward.
 *  - {@link settleReferralRedemptions} is the only automatic path to a credit,
 *    and it will not move a redemption off `PENDING` until it has found a real
 *    `Invoice` for the referred user with `status = 'PAID'` **and an
 *    `amountPaidCents` clearing the programme's
 *    `minimumQualifyingInvoiceCents`**. The amount is computed from the code
 *    and that invoice — the operator running the sweep does not choose it.
 *  - {@link updateReferralRedemption} is the manual path, and its `QUALIFY` and
 *    `REWARD` branches perform the *same* database check before they will do
 *    anything. An administrator cannot qualify a redemption by asserting it.
 *
 * ## What a code is worth is the house's to say (MCV-030)
 *
 * A reward is a liability, and below `ADMIN` the caller does not get to state
 * one. {@link createReferralCode} discards `rewardType`, `rewardValueCents`,
 * `rewardValuePercent`, `refereeRewardCents`, `currency`, `maxRedemptions` and
 * `expiresAt` from the payload of anybody who is not staff and takes all seven
 * from the standing `ReferralProgram` instead — the same shape as
 * `booking.ts`'s `totalCents: staffCaller ? input.totalCents : 0` and
 * `client.ts`'s staff-only `vipNotes`. {@link updateReferralCode} discards the
 * same seven, because a strip on the create path is worth nothing if the amend
 * path will raise the figure afterwards. With no active programme a subscriber
 * is **refused**, never defaulted to something generous. See
 * `@/server/referral-program` for the offer itself and for what the exploit
 * looked like before it existed.
 *
 * Those are the only two. The rest of this file's mutations were audited in the
 * same pass: {@link deactivateReferralCode} writes one boolean behind the
 * ownership guard, {@link redeemReferralCode} writes a `PENDING` row whose
 * every figure is copied from the code, and everything that touches the ledger
 * — {@link settleReferralRedemptions}, {@link updateReferralRedemption},
 * {@link payReferralReward}, {@link recordRewardAdjustment} and
 * {@link recomputeRewardBalance} — is `ADMIN` or `SUPER_ADMIN` already. No
 * other action below `ADMIN` writes a number the caller supplied.
 *
 * ## Anti-abuse, stated explicitly
 *
 * `redeemReferralCode` refuses, each with its own sentence on the `code` field:
 *
 * | Rule                         | Why                                          |
 * | ---------------------------- | -------------------------------------------- |
 * | self-referral                | `ReferralCode.ownerId === referredUserId`     |
 * | same mailbox as the owner    | `sharesEmailIdentity`, below `ADMIN`          |
 * | one redemption per user      | any live redemption already names them        |
 * | one redemption per code/user | `@@unique([referralCodeId, referredUserId])`  |
 * | `maxRedemptions`             | `redemptionCount` may not pass it             |
 * | `expiresAt`                  | an expired invitation is not an invitation    |
 * | `isActive`                   | a withdrawn code is not redeemable            |
 *
 * That table is not implemented here. It is
 * `resolveRedemptionEligibility` in `@/server/referral-eligibility`, which the
 * Checkout pre-flight in `actions/billing.ts` and the Stripe webhook call as
 * well — before MCV-041 each of the three carried its own subset of the rows
 * above, and the webhook's was missing the two that make it a household
 * heuristic at all.
 *
 * The second of those is a **deterrent, not a proof**: it catches the inviter
 * who signs a second account up to a plus-addressed alias of their own inbox,
 * and it is defeated by anybody willing to use a second real address. Nothing
 * downstream may read its silence as a clearance. The control point for a
 * referral that was not really earned remains where it has always been — an
 * administrator, running or declining to run the settlement sweep, and
 * `REVOKE` with `reverseLedgerEntry` when one gets through.
 *
 * The counter is bumped with a compare-and-swap on its own prior value, so two
 * guests redeeming the last seat of a capped code produce one redemption and
 * one refusal rather than two redemptions and an over-subscribed code.
 *
 * ## The balance is derived, never incremented
 *
 * `RewardBalance` is a **cache of the ledger**, and this file treats it as one.
 * Every movement goes through {@link appendLedgerEntry}, which writes a
 * `RewardLedgerEntry` and then recomputes all four counters by aggregating
 * `RewardLedgerEntry` from scratch — `SUM` over the credits, `SUM` over the
 * debits, and the difference. Nothing anywhere does `{ increment: n }` against
 * `RewardBalance.balanceCents`, which is what makes the balance auditable: it
 * cannot drift from the ledger, because it is not maintained independently of
 * it. {@link recomputeRewardBalance} exposes the same recomputation on its own,
 * for reconciling a row that a historical bug may have left wrong.
 *
 * The ledger itself is append-only, per the docblock on the Prisma model.
 * Nothing here updates or deletes a `RewardLedgerEntry`; a correction is a
 * compensating `REVERSAL` row.
 *
 * ## Who may move money
 *
 * `SUPER_ADMIN`, for anything discretionary — {@link payReferralReward},
 * {@link recordRewardAdjustment}, the manual `REWARD` branch, and the reversal
 * half of `REVOKE`. `ADMIN` may run {@link settleReferralRedemptions}, because
 * that action has no discretion at all: it credits exactly what the code
 * promises to exactly the people the rules entitle, or it credits nothing.
 */

import {
  cuidSchema,
  generateReferralCode,
  hasRoleAtLeast,
  intSchema,
  paginationToSkipTake,
  referralCodeCreateSchema,
  referralCodeFilterSchema,
  referralCodeUpdateSchema,
  referralRedemptionCreateSchema,
  referralRedemptionFilterSchema,
  referralRedemptionStatusUpdateSchema,
  referralRewardValueKind,
  rewardAdjustmentSchema,
  rewardLedgerFilterSchema,
  rewardPayoutSchema,
  signedLedgerAmountCents,
  MAX_REWARD_CENTS,
  type ReferralCodeCreateInput,
  type ReferralCodeSortBy,
  type ReferralRedemptionStatus,
  type RewardLedgerDirection,
  type RewardLedgerReason,
  type RewardType,
  type SortDirection,
} from '@mannachef/validators'
import type {
  PageMeta,
  ReferralCodeSummary,
  ReferralOverview,
  RewardBalanceView,
} from '@mannachef/api-contract'
import { z } from 'zod'

import {
  ActionError,
  fail,
  ok,
  type ActionFailure,
  type ActionResult,
} from '@/server/actions/types'
import { Prisma, prisma } from '@/server/db'
import {
  requireReferralCodeOwnership,
  withAction,
  type AuthenticatedUser,
} from '@/server/guards'
import {
  createReferralRedemption,
  resolveRedemptionEligibility,
  REDEMPTION_REFUSALS,
} from '@/server/referral-eligibility'
import {
  readQualifyingFloorCents,
  resolveProgramCodeTerms,
  NO_PROGRAM_OFFER_MESSAGE,
  PROGRAM_MISCONFIGURED_MESSAGE,
  type ReferralCodeTerms,
} from '@/server/referral-program'

// =============================================================================
// 0. Constants
// =============================================================================

const REFERRAL_PATHS = [
  '/portal/referrals',
  '/portal/rewards',
  '/admin/growth',
  '/admin/rewards',
] as const

const REFERRAL_TAGS = ['referrals', 'rewards', 'reward-ledger'] as const

/**
 * How many times {@link mintReferralCode} redraws before giving up.
 *
 * `generateReferralCode` draws eight characters from a thirty-two symbol
 * alphabet, so a collision is a five-in-a-trillion event on an empty table and
 * still vanishingly rare on a large one. Eight attempts is therefore not a
 * retry budget so much as a guarantee that the loop terminates: exhausting it
 * means something is wrong with the generator rather than that we were unlucky.
 */
const MAX_CODE_MINT_ATTEMPTS = 8

/**
 * Redemption is the one action in this file a stranger with a fresh account can
 * reach, and each attempt is a probe at the code space. Ten an hour lets a
 * guest fix a typo several times over and makes enumeration pointless.
 */
const REDEMPTION_RATE_LIMIT = { tokens: 10, windowMs: 60 * 60 * 1_000 } as const

/**
 * Minting invitation codes (MCV-043).
 *
 * Not a defence against enumeration — a code's owner already knows their own
 * codes. It bounds the *aggregate* liability a single account can create in an
 * afternoon, which is the one dimension of this programme nothing else measures:
 * every ceiling that exists is per redemption, and a script that mints codes in
 * a loop turns a per-redemption ceiling into no ceiling at all.
 *
 * Five an hour is generous for the real behaviour — a household issues one code
 * and gives it out, and a concierge issuing a run of bespoke codes for an event
 * is `ADMIN`, who is bounded by the same bucket but is also the person being
 * protected — and hostile for the other. `scope` is left at its `'identity'`
 * default so the bucket is the signed-in user's; the action is `auth: 'SESSION'`
 * and unreachable without one, so it never falls back to IP.
 *
 * Read the production note on {@link rateLimit} before treating this as a
 * control rather than a speed bump: the buckets live in the process.
 */
const CODE_MINT_RATE_LIMIT = { tokens: 5, windowMs: 60 * 60 * 1_000 } as const

/** The reasons that represent an inbound referral payment. */
const REFERRAL_CREDIT_REASONS = [
  'REFERRAL_REWARD',
  'REFERRAL_SIGNUP_BONUS',
] as const

// =============================================================================
// 1. Local input schemas
//
// Composed from `@mannachef/validators`; nothing here restates a rule the
// package already owns.
// =============================================================================

const referralCodeIdSchema = z.object({ referralCodeId: cuidSchema }).strict()

const rewardSubjectSchema = z.object({ userId: cuidSchema }).strict()

/**
 * The settlement sweep's arguments.
 *
 * `referredUserId` narrows the sweep to one household — the shape a webhook or
 * a support conversation wants. `limit` bounds the work so a single invocation
 * cannot hold a transaction open across the whole redemption table.
 */
const referralSettlementSchema = z
  .object({
    referredUserId: cuidSchema.optional(),
    limit: intSchema(1, 200, {
      notAnInteger: 'Please give the batch size as a whole number.',
      tooSmall: 'Settle at least one redemption.',
      tooLarge: 'Please settle two hundred redemptions at a time or fewer.',
    }).default(50),
  })
  .strict()

// =============================================================================
// 2. Projections
// =============================================================================

const REFERRAL_CODE_SELECT = {
  id: true,
  code: true,
  ownerId: true,
  label: true,
  rewardType: true,
  rewardValueCents: true,
  rewardValuePercent: true,
  refereeRewardCents: true,
  currency: true,
  maxRedemptions: true,
  redemptionCount: true,
  expiresAt: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.ReferralCodeSelect

type ReferralCodeRow = Prisma.ReferralCodeGetPayload<{
  select: typeof REFERRAL_CODE_SELECT
}>

const REWARD_BALANCE_SELECT = {
  balanceCents: true,
  lifetimeEarnedCents: true,
  lifetimeRedeemedCents: true,
  currency: true,
  lastEarnedAt: true,
  lastRedeemedAt: true,
} satisfies Prisma.RewardBalanceSelect

const REDEMPTION_SELECT = {
  id: true,
  referralCodeId: true,
  referredUserId: true,
  status: true,
  qualifiedAt: true,
  rewardedAt: true,
  revokedAt: true,
  revokedReason: true,
  rewardCents: true,
  currency: true,
  createdAt: true,
  referralCode: { select: { code: true, ownerId: true, label: true } },
  referredUser: { select: { name: true } },
} satisfies Prisma.ReferralRedemptionSelect

type RedemptionRow = Prisma.ReferralRedemptionGetPayload<{
  select: typeof REDEMPTION_SELECT
}>

const LEDGER_SELECT = {
  id: true,
  userId: true,
  direction: true,
  reason: true,
  amountCents: true,
  balanceAfterCents: true,
  currency: true,
  referralRedemptionId: true,
  invoiceId: true,
  createdById: true,
  note: true,
  createdAt: true,
} satisfies Prisma.RewardLedgerEntrySelect

type LedgerRow = Prisma.RewardLedgerEntryGetPayload<{
  select: typeof LEDGER_SELECT
}>

/**
 * A redemption, as much of it as the caller is entitled to see.
 *
 * `referredUserId` and `referredUserName` are the reason this is not simply the
 * Prisma row. A code owner is entitled to know that *somebody* accepted their
 * invitation and that it has been rewarded; they are not entitled to the
 * identity of the household who did, which is somebody else's relationship with
 * us. Both fields are populated for `ADMIN` and above, and `referredUserId`
 * alone for the referred person reading their own row.
 */
export interface ReferralRedemptionView {
  readonly id: string
  readonly referralCodeId: string
  readonly code: string
  readonly codeLabel: string | null
  readonly status: ReferralRedemptionStatus
  readonly qualifiedAt: Date | null
  readonly rewardedAt: Date | null
  readonly revokedAt: Date | null
  /** Staff-only. A guest is never shown the internal wording of a revocation. */
  readonly revokedReason: string | null
  readonly rewardCents: number | null
  readonly currency: string
  readonly createdAt: Date
  readonly referredUserId: string | null
  readonly referredUserName: string | null
}

export interface RewardLedgerEntryView {
  readonly id: string
  readonly userId: string
  readonly direction: RewardLedgerDirection
  readonly reason: RewardLedgerReason
  readonly amountCents: number
  readonly balanceAfterCents: number
  readonly currency: string
  readonly referralRedemptionId: string | null
  readonly invoiceId: string | null
  readonly note: string | null
  readonly createdAt: Date
}

export interface ReferralCodeListView {
  readonly items: readonly ReferralCodeSummary[]
  readonly meta: PageMeta
}

export interface ReferralRedemptionListView {
  readonly items: readonly ReferralRedemptionView[]
  readonly meta: PageMeta
}

export interface RewardLedgerView {
  readonly items: readonly RewardLedgerEntryView[]
  readonly meta: PageMeta
  readonly balance: RewardBalanceView
}

/** What one pass of {@link settleReferralRedemptions} did. */
export interface ReferralSettlementView {
  /** `PENDING` redemptions the sweep looked at. */
  readonly examined: number
  /** How many moved to `QUALIFIED` because a paid invoice was found. */
  readonly qualified: number
  /** How many reached `REWARDED` with the ledger written. */
  readonly rewarded: number
  /** Examined but left alone — no paid invoice yet, or already settled. */
  readonly skipped: number
  /** Total credited across every ledger entry this pass wrote. */
  readonly creditedCents: number
}

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

/** `isActive && not expired && redemptions remaining` — the contract's field. */
function isRedeemable(row: ReferralCodeRow, now: Date): boolean {
  if (!row.isActive) {
    return false
  }

  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return false
  }

  return row.maxRedemptions === null || row.redemptionCount < row.maxRedemptions
}

function toReferralCodeSummary(
  row: ReferralCodeRow,
  now: Date
): ReferralCodeSummary {
  return {
    id: row.id,
    code: row.code,
    ownerId: row.ownerId,
    label: row.label,
    rewardType: row.rewardType,
    rewardValueCents: row.rewardValueCents,
    rewardValuePercent: row.rewardValuePercent,
    refereeRewardCents: row.refereeRewardCents,
    currency: row.currency,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    expiresAt: row.expiresAt,
    isActive: row.isActive,
    isRedeemable: isRedeemable(row, now),
    createdAt: row.createdAt,
  }
}

function toRedemptionView(
  row: RedemptionRow,
  viewer: AuthenticatedUser
): ReferralRedemptionView {
  const privileged = hasRoleAtLeast(viewer.role, 'ADMIN')
  const isSubject = row.referredUserId === viewer.id

  return {
    id: row.id,
    referralCodeId: row.referralCodeId,
    code: row.referralCode.code,
    codeLabel: row.referralCode.label,
    status: row.status,
    qualifiedAt: row.qualifiedAt,
    rewardedAt: row.rewardedAt,
    revokedAt: row.revokedAt,
    revokedReason: privileged ? row.revokedReason : null,
    rewardCents: row.rewardCents,
    currency: row.currency,
    createdAt: row.createdAt,
    referredUserId: privileged || isSubject ? row.referredUserId : null,
    referredUserName: privileged ? row.referredUser.name : null,
  }
}

function toLedgerView(row: LedgerRow): RewardLedgerEntryView {
  return {
    id: row.id,
    userId: row.userId,
    direction: row.direction,
    reason: row.reason,
    amountCents: row.amountCents,
    balanceAfterCents: row.balanceAfterCents,
    currency: row.currency,
    referralRedemptionId: row.referralRedemptionId,
    invoiceId: row.invoiceId,
    note: row.note,
    createdAt: row.createdAt,
  }
}

/** The zero balance a person who has never earned anything is shown. */
function emptyBalance(currency: string): RewardBalanceView {
  return {
    balanceCents: 0,
    lifetimeEarnedCents: 0,
    lifetimeRedeemedCents: 0,
    currency,
    lastEarnedAt: null,
    lastRedeemedAt: null,
  }
}

// =============================================================================
// 3. The ledger
// =============================================================================

/** What the ledger says about one person, computed from the ledger. */
interface LedgerTotals {
  readonly balanceCents: number
  readonly lifetimeEarnedCents: number
  readonly lifetimeRedeemedCents: number
  readonly lastEarnedAt: Date | null
  readonly lastRedeemedAt: Date | null
}

/**
 * Aggregate every `RewardLedgerEntry` this person has.
 *
 * One grouped query — `SUM(amountCents)` and `MAX(createdAt)` per direction —
 * so the cost is independent of how long they have been a customer. This is the
 * only definition of a balance in the application; everything else reads the
 * cache that this computes.
 */
async function readLedgerTotals(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<LedgerTotals> {
  const grouped = await tx.rewardLedgerEntry.groupBy({
    by: ['direction'],
    where: { userId },
    _sum: { amountCents: true },
    _max: { createdAt: true },
  })

  let lifetimeEarnedCents = 0
  let lifetimeRedeemedCents = 0
  let lastEarnedAt: Date | null = null
  let lastRedeemedAt: Date | null = null

  for (const group of grouped) {
    const sum = group._sum.amountCents ?? 0
    const latest = group._max.createdAt

    if (group.direction === 'CREDIT') {
      lifetimeEarnedCents = sum
      lastEarnedAt = latest
    } else {
      lifetimeRedeemedCents = sum
      lastRedeemedAt = latest
    }
  }

  return {
    balanceCents: lifetimeEarnedCents - lifetimeRedeemedCents,
    lifetimeEarnedCents,
    lifetimeRedeemedCents,
    lastEarnedAt,
    lastRedeemedAt,
  }
}

/**
 * Rebuild `RewardBalance` from `RewardLedgerEntry`.
 *
 * The row is created if it does not exist and overwritten if it does — never
 * incremented. `currency` is only written when the caller supplies one, so a
 * pure reconciliation cannot change the currency a balance is denominated in.
 */
async function writeRecomputedBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  currency: string | null
): Promise<RewardBalanceView> {
  const totals = await readLedgerTotals(tx, userId)

  const row = await tx.rewardBalance.upsert({
    where: { userId },
    create: {
      userId,
      balanceCents: totals.balanceCents,
      lifetimeEarnedCents: totals.lifetimeEarnedCents,
      lifetimeRedeemedCents: totals.lifetimeRedeemedCents,
      lastEarnedAt: totals.lastEarnedAt,
      lastRedeemedAt: totals.lastRedeemedAt,
      ...(currency === null ? {} : { currency }),
    },
    update: {
      balanceCents: totals.balanceCents,
      lifetimeEarnedCents: totals.lifetimeEarnedCents,
      lifetimeRedeemedCents: totals.lifetimeRedeemedCents,
      lastEarnedAt: totals.lastEarnedAt,
      lastRedeemedAt: totals.lastRedeemedAt,
      ...(currency === null ? {} : { currency }),
    },
    select: REWARD_BALANCE_SELECT,
  })

  return row
}

/** One movement on the ledger, as {@link appendLedgerEntry} wants it. */
interface LedgerWrite {
  readonly userId: string
  readonly direction: RewardLedgerDirection
  readonly reason: RewardLedgerReason
  readonly amountCents: number
  readonly currency: string
  readonly referralRedemptionId: string | null
  readonly invoiceId: string | null
  /** From the session. Never from a payload. */
  readonly createdById: string | null
  readonly note: string | null
}

/**
 * Write one entry and rebuild the balance behind it.
 *
 * ## Order, and why it is this order
 *
 * 1. Aggregate the ledger as it stands, to learn the balance *before* this
 *    movement. `balanceAfterCents` is a column on the entry, so it has to be
 *    known before the insert; deriving it from the aggregate rather than from
 *    `RewardBalance.balanceCents` means a stale cache cannot poison a new row.
 * 2. Refuse an overdraft. A `DEBIT` may not take a balance below zero, with one
 *    deliberate exception: `REVERSAL`. Clawing back credit that has already
 *    been spent is exactly the case where a negative balance is the *truthful*
 *    record, and refusing it would leave the platform having paid for a
 *    referral it revoked.
 * 3. Insert the entry, joined to the balance row so the audit trail can be
 *    walked from either end.
 * 4. Recompute the four counters from the ledger, now including this row.
 *
 * Every refusal is an `ActionError`, so it rolls the surrounding transaction
 * back and still reaches the caller with its own code rather than `INTERNAL`.
 */
async function appendLedgerEntry(
  tx: Prisma.TransactionClient,
  write: LedgerWrite
): Promise<{ entry: LedgerRow; balance: RewardBalanceView }> {
  const priorTotals = await readLedgerTotals(tx, write.userId)

  const delta = signedLedgerAmountCents({
    direction: write.direction,
    amountCents: write.amountCents,
  })

  const balanceAfterCents = priorTotals.balanceCents + delta

  if (balanceAfterCents < 0 && write.reason !== 'REVERSAL') {
    throw new ActionError(
      'CONFLICT',
      'There is not enough credit on this balance for that movement.'
    )
  }

  const existing = await tx.rewardBalance.findUnique({
    where: { userId: write.userId },
    select: { id: true, currency: true },
  })

  if (
    existing !== null &&
    existing.currency !== write.currency &&
    priorTotals.balanceCents !== 0
  ) {
    throw new ActionError(
      'CONFLICT',
      'This balance is held in a different currency. Please settle it before changing currencies.'
    )
  }

  // The balance row must exist before the entry can point at it. Created with
  // the pre-movement totals so that, should anything after this throw, the
  // rollback leaves nothing half-written.
  const balanceRow = await tx.rewardBalance.upsert({
    where: { userId: write.userId },
    create: { userId: write.userId, currency: write.currency },
    update: {},
    select: { id: true },
  })

  const entry = await tx.rewardLedgerEntry.create({
    data: {
      userId: write.userId,
      balanceId: balanceRow.id,
      direction: write.direction,
      reason: write.reason,
      amountCents: write.amountCents,
      balanceAfterCents,
      currency: write.currency,
      referralRedemptionId: write.referralRedemptionId,
      invoiceId: write.invoiceId,
      createdById: write.createdById,
      note: write.note,
    },
    select: LEDGER_SELECT,
  })

  const balance = await writeRecomputedBalance(tx, write.userId, write.currency)

  return { entry, balance }
}

// =============================================================================
// 4. Qualification — the paid-invoice test
// =============================================================================

/** The invoice that earned a referral its reward. */
interface QualifyingInvoice {
  readonly id: string
  readonly amountPaidCents: number
  readonly currency: string
  readonly paidAt: Date
}

/**
 * The referred person's **first genuinely paid, genuinely qualifying** invoice,
 * or `null`.
 *
 * `status = 'PAID'` and `paidAt IS NOT NULL` together, because an invoice can
 * be marked paid by a webhook that has not yet stamped the moment, and the
 * moment is what a qualification is dated by. Ordered ascending so a household
 * with a long billing history qualifies on the invoice that actually converted
 * them rather than on their most recent one.
 *
 * This function is the whole of the "not at signup" rule. Every path that
 * credits a referral calls it, and none of them takes the caller's word for it.
 *
 * ## The floor (MCV-030)
 *
 * `minimumQualifyingInvoiceCents` is the programme's, read by
 * {@link readQualifyingFloorCents}, and it is a **required argument**: `0` is
 * the permissive reading, and defaulting to it here would put the permissive
 * branch behind a forgotten parameter rather than behind a decision. Without a
 * floor, a household paying a one-dollar invoice earns the inviter a full
 * reward, which is the second half of the abuse this task closed.
 *
 * The floor filters rather than gates — the earliest invoice **that clears it**
 * qualifies, not "the earliest invoice, if it happens to clear it". A household
 * whose first bill was a two-dollar delivery and whose second was a four-figure
 * dinner has converted; dating the referral to the dinner is both the truthful
 * reading and the one that cannot be gamed by asking a referred guest to buy
 * something trivial first.
 *
 * ## An invoice paid for nothing is not a paid invoice (MCV-043)
 *
 * `amountPaidCents > 0` is a *separate* condition from the floor, deliberately
 * not folded into it as `Math.max(floor, 1)`, because it is not a matter of
 * degree: whatever the programme is willing to accept as a qualifying purchase,
 * "no money changed hands" is not one, and an operator who sets the floor to
 * zero is saying "any purchase" rather than "no purchase at all".
 *
 * The gap this closes is not hypothetical and it does not need a hostile
 * `Invoice` row to open it. `handleInvoiceChanged` in the Stripe webhook writes
 * `amountPaidCents: invoice.amount_paid` and `paidAt` from
 * `status_transitions.paid_at`, both verbatim and both correct — and Stripe
 * issues a genuine, `paid`, `amount_paid: 0` invoice in two ordinary cases:
 * the invoice that opens a subscription trial, and one a 100%-off promotion
 * code has zeroed. `createCheckoutSession` enables both (`trial_period_days`
 * and `allow_promotion_codes`). So without this condition, and with a
 * programme whose floor is the column's default of zero, the entire cost of
 * manufacturing a referred household was a free trial signup, and the reward
 * for it was real money.
 *
 * Prisma renders the two conditions as one `AND`ed predicate on the column, so
 * this costs nothing: `"amountPaidCents" >= $floor AND "amountPaidCents" > 0`.
 */
async function findQualifyingInvoice(
  tx: Prisma.TransactionClient,
  referredUserId: string,
  minimumQualifyingInvoiceCents: number
): Promise<QualifyingInvoice | null> {
  const invoice = await tx.invoice.findFirst({
    where: {
      userId: referredUserId,
      status: 'PAID',
      paidAt: { not: null },
      amountPaidCents: { gte: minimumQualifyingInvoiceCents, gt: 0 },
    },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      amountPaidCents: true,
      currency: true,
      paidAt: true,
    },
  })

  if (invoice === null || invoice.paidAt === null) {
    return null
  }

  return {
    id: invoice.id,
    amountPaidCents: invoice.amountPaidCents,
    currency: invoice.currency,
    paidAt: invoice.paidAt,
  }
}

/**
 * What the code's owner earns, in whole cents.
 *
 * A `PERCENT_DISCOUNT` code is a share of the bill that actually arrived, so
 * the figure is computed from `Invoice.amountPaidCents` rather than from what
 * was invoiced — the same distinction `crm.ts` draws for lifetime value, and
 * for the same reason. Everything else is the flat `rewardValueCents`.
 *
 * The result is clamped to `MAX_REWARD_CENTS`, which is the ceiling
 * `rewardCentsSchema` enforces on a hand-entered reward; a percentage of a very
 * large invoice must not be able to walk around it.
 */
function ownerRewardCents(
  code: Pick<
    ReferralCodeRow,
    'rewardType' | 'rewardValueCents' | 'rewardValuePercent'
  >,
  invoice: QualifyingInvoice
): number {
  if (referralRewardValueKind(code.rewardType) === 'PERCENT') {
    const percent = code.rewardValuePercent ?? 0
    const raw = Math.round((invoice.amountPaidCents * percent) / 100)

    return Math.min(Math.max(raw, 0), MAX_REWARD_CENTS)
  }

  return Math.min(Math.max(code.rewardValueCents ?? 0, 0), MAX_REWARD_CENTS)
}

/**
 * Has this redemption already been paid for?
 *
 * The ledger is the authority rather than `ReferralRedemption.status`, because
 * the status is a summary and the ledger is the record. A redemption that was
 * credited and then had its status hand-edited would still be caught here, and
 * "credited once" is the property that actually matters.
 */
async function alreadyCredited(
  tx: Prisma.TransactionClient,
  redemptionId: string,
  userId: string
): Promise<boolean> {
  const existing = await tx.rewardLedgerEntry.count({
    where: {
      referralRedemptionId: redemptionId,
      userId,
      direction: 'CREDIT',
      reason: { in: [...REFERRAL_CREDIT_REASONS] },
    },
    take: 1,
  })

  return existing > 0
}

// =============================================================================
// 5. Invitation codes — writing
// =============================================================================

/**
 * Mint a unique code, redrawing on collision.
 *
 * The uniqueness of `ReferralCode.code` is a database constraint, and this is
 * the only honest way to satisfy one: attempt the insert and let PostgreSQL be
 * the judge. A "check then insert" would be a race, and on a column this
 * important a race means two households sharing an invitation.
 *
 * `P2002` is caught and redrawn; every other Prisma error is rethrown for the
 * wrapper to classify. Exhausting {@link MAX_CODE_MINT_ATTEMPTS} raises a
 * `CONFLICT` rather than looping.
 */
async function mintReferralCode(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.ReferralCodeUncheckedCreateInput, 'code'>
): Promise<ReferralCodeRow> {
  for (let attempt = 0; attempt < MAX_CODE_MINT_ATTEMPTS; attempt += 1) {
    try {
      return await tx.referralCode.create({
        data: { ...data, code: generateReferralCode() },
        select: REFERRAL_CODE_SELECT,
      })
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        continue
      }

      throw error
    }
  }

  throw new ActionError(
    'CONFLICT',
    'We could not mint a free invitation code just now. Please try again.'
  )
}

/**
 * The seven fields on an invitation code that cost the business money, as an
 * `ADMIN` stated them.
 *
 * Narrowed on the discriminant itself rather than through a boolean, so the two
 * value columns are read from the branch that actually declares them, and both
 * are written explicitly with one of them null so a code can never carry a
 * stale percentage from a shape it no longer has.
 */
function statedCodeTerms(input: ReferralCodeCreateInput): ReferralCodeTerms {
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

  return {
    rewardType: input.rewardType,
    ...reward,
    refereeRewardCents: input.refereeRewardCents ?? null,
    currency: input.currency,
    maxRedemptions: input.maxRedemptions ?? null,
    expiresAt: input.expiresAt ?? null,
  }
}

/**
 * Decide what the code being minted is worth — from the payload for staff, from
 * the standing offer for everybody else.
 *
 * Returns an `ActionResult` rather than the terms, because the two ways this
 * can fail are refusals with their own sentences rather than exceptions, and
 * because that is the shape every guard in `@/server/guards` already speaks.
 */
async function resolveCodeTerms(
  db: Prisma.TransactionClient,
  input: ReferralCodeCreateInput,
  privileged: boolean,
  now: Date
): Promise<ActionResult<ReferralCodeTerms>> {
  if (privileged) {
    return ok(statedCodeTerms(input))
  }

  const outcome = await resolveProgramCodeTerms(db, now)

  switch (outcome.kind) {
    case 'terms':
      return ok(outcome.terms)

    case 'noOffer':
      return fail('CONFLICT', NO_PROGRAM_OFFER_MESSAGE)

    case 'misconfigured':
      return fail('CONFLICT', PROGRAM_MISCONFIGURED_MESSAGE)

    default: {
      const exhaustive: never = outcome
      return exhaustive
    }
  }
}

/**
 * Issue an invitation code.
 *
 * ## Whose code it is
 *
 * `ownerId` arrives in the payload because an administrator issues codes on
 * behalf of others, and it is therefore re-checked: below `ADMIN` it must be
 * the caller's own id, and a mismatch is `FORBIDDEN` before any row is read.
 * A code carries money, so issuing one in somebody else's name is issuing them
 * a liability.
 *
 * ## The code string
 *
 * Omit `code` and the house mints one — see {@link mintReferralCode} for how
 * the collision retry works. Supply one and it is taken as written (already
 * normalised to capitals by `referralCodeSchema`) and checked for uniqueness by
 * the database, which turns a clash into a field error on `code` rather than a
 * Prisma message.
 *
 * ## The reward (MCV-030)
 *
 * `referralCodeCreateSchema` is a discriminated union over `rewardType`, so the
 * measure and its value travel together and a well-formed payload always states
 * a coherent pair. That is a statement about *shape*, and it was never a
 * statement about *authority*: a `CLIENT` posting `rewardValueCents:
 * 1_000_000` with `maxRedemptions: null` passes the schema perfectly, and
 * before this change the action wrote it.
 *
 * So the payload's seven money-bearing fields are only honoured for `ADMIN` and
 * above. For everybody else {@link resolveCodeTerms} reads them off the
 * standing `ReferralProgram` and the payload's are discarded in silence — the
 * same treatment `booking.ts` gives a guest-quoted `totalCents` and `client.ts`
 * gives a guest-written `vipNotes`, and silent for the same reason: the form a
 * subscriber submits legitimately renders the offer's figures back to us, so
 * refusing the request would break the ordinary case in order to scold the
 * hostile one.
 *
 * What is *not* discarded, because none of it is worth anything: `label`,
 * `code`, `isActive`, and the `ownerId` the check above has already pinned to
 * the caller.
 *
 * With no active programme, a subscriber is refused. There is no built-in
 * fallback figure, and adding one would put a number nobody chose behind a
 * payout.
 *
 * ## Why this is rate-limited (MCV-043)
 *
 * MCV-030 bounded what *one* code is worth. It did not bound how many a caller
 * may mint, and the two ceilings this platform has are both per redemption:
 * `ownerRewardCents` clamps at `MAX_REWARD_CENTS`, and the one-live-redemption
 * rule caps a referred household at one accepted invitation. Neither says
 * anything about a thousand codes.
 *
 * That is not, by itself, the abuse — the cost of *using* a code is a referred
 * household that pays a qualifying invoice, and MCV-043's other two changes are
 * what make that cost real (a zero-amount invoice no longer qualifies, and a
 * programme may no longer pay out more than the invoice that earns it without
 * saying so). What the limit adds is that the cheap half of the loop is no
 * longer free either: minting is the one step in the scheme that costs an
 * attacker nothing at all, and leaving it unmetered means the whole scheme runs
 * at whatever rate their script does.
 *
 * See {@link CODE_MINT_RATE_LIMIT} for the figures, and the production note on
 * `rateLimit` in `@/server/guards` for why this is a speed bump until the
 * buckets move to a shared store.
 */
export const createReferralCode = withAction(
  {
    name: 'referral.code.create',
    auth: 'SESSION',
    input: referralCodeCreateSchema,
    rateLimit: CODE_MINT_RATE_LIMIT,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralCodeSummary>> => {
    const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')

    if (!privileged && input.ownerId !== ctx.user.id) {
      return fail(
        'FORBIDDEN',
        'You may only issue invitation codes in your own name.'
      )
    }

    const owner = await ctx.db.user.findUnique({
      where: { id: input.ownerId },
      select: { id: true, isActive: true },
    })

    if (owner === null || !owner.isActive) {
      return fail('NOT_FOUND', 'We could not find that account.')
    }

    const now = new Date()
    const terms = await resolveCodeTerms(ctx.db, input, privileged, now)

    if (!terms.ok) {
      return terms
    }

    const shared = {
      ownerId: owner.id,
      label: input.label ?? null,
      rewardType: terms.data.rewardType,
      rewardValueCents: terms.data.rewardValueCents,
      rewardValuePercent: terms.data.rewardValuePercent,
      refereeRewardCents: terms.data.refereeRewardCents,
      currency: terms.data.currency,
      maxRedemptions: terms.data.maxRedemptions,
      expiresAt: terms.data.expiresAt,
      isActive: input.isActive,
      redemptionCount: 0,
    } satisfies Omit<Prisma.ReferralCodeUncheckedCreateInput, 'code'>

    if (input.code === undefined) {
      const minted = await ctx.db.$transaction((tx) =>
        mintReferralCode(tx, shared)
      )

      return ok(toReferralCodeSummary(minted, now))
    }

    try {
      const created = await ctx.db.referralCode.create({
        data: { ...shared, code: input.code },
        select: REFERRAL_CODE_SELECT,
      })

      return ok(toReferralCodeSummary(created, now))
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return fail('CONFLICT', 'That invitation code is already in use.', {
          code: ['Please choose another code, or let us mint one for you.'],
        })
      }

      throw error
    }
  }
)

/**
 * Amend a code already in circulation.
 *
 * `requireReferralCodeOwnership` runs first and does a real `SELECT`; its
 * default bypass is `ADMIN`, which is right here — an administrator correcting
 * a mis-set expiry is ordinary work, and the guard's denial is `NOT_FOUND` so a
 * code belonging to somebody else is indistinguishable from one that does not
 * exist.
 *
 * ## Below `ADMIN`, the terms are not amendable at all (MCV-030)
 *
 * The same seven money-bearing fields {@link createReferralCode} takes from the
 * standing programme are discarded here for the same callers: `rewardType`,
 * `rewardValueCents`, `rewardValuePercent`, `refereeRewardCents`, `currency`,
 * `maxRedemptions` and `expiresAt`. Stripping them on the create path alone
 * would have been theatre — the code would be minted at the programme's figure
 * and raised to a million cents by the very next call.
 *
 * Note that they are discarded in *both* directions, not merely clamped
 * upwards. "A client code's terms are the programme's" is an invariant an
 * auditor can check against one row; "a client may move the terms, but only in
 * the house's favour" is a rule that has to be re-derived every time somebody
 * adds a field. `currency` is in the list on the same grounds: re-denominating
 * a CAD code as USD changes what it is worth without touching a figure.
 *
 * A subscriber keeps `label` and `isActive`, which is enough to rename an
 * invitation and to withdraw one.
 *
 * ## The two rules the schema cannot reach
 *
 * `referralCodeUpdateSchema` checks the reward pairing *within the payload*.
 * What it cannot do is check the payload against the row: clearing
 * `rewardValueCents` on a `FIXED_CREDIT` code leaves `rewardType` undefined in
 * the payload, so the schema sees no contradiction, and the code would be left
 * promising a fixed credit of nothing. {@link mergedRewardIsCoherent} performs
 * the same check against the *merged* result.
 *
 * The second is arithmetic: `maxRedemptions` may not be lowered below the
 * redemptions already granted, because that would silently invalidate
 * invitations people are already holding.
 */
export const updateReferralCode = withAction(
  {
    name: 'referral.code.update',
    auth: 'SESSION',
    input: referralCodeUpdateSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralCodeSummary>> => {
    const owned = await requireReferralCodeOwnership(ctx.user, input.id)

    if (!owned.ok) {
      return owned
    }

    const stored = await ctx.db.referralCode.findUnique({
      where: { id: owned.data.id },
      select: REFERRAL_CODE_SELECT,
    })

    if (stored === null) {
      return fail('NOT_FOUND')
    }

    const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')

    /**
     * The amendment as it will actually be applied. Every money-bearing key is
     * read through this rather than off `input`, so a field added to
     * `referralCodeUpdatableShape` later cannot reach the row by being wired up
     * one line below the privilege check and nowhere near it.
     */
    const amend = {
      rewardType: privileged ? input.rewardType : undefined,
      rewardValueCents: privileged ? input.rewardValueCents : undefined,
      rewardValuePercent: privileged ? input.rewardValuePercent : undefined,
      refereeRewardCents: privileged ? input.refereeRewardCents : undefined,
      currency: privileged ? input.currency : undefined,
      maxRedemptions: privileged ? input.maxRedemptions : undefined,
      expiresAt: privileged ? input.expiresAt : undefined,
      label: input.label,
      isActive: input.isActive,
    } as const

    const mergedType: RewardType = amend.rewardType ?? stored.rewardType
    const mergedCents =
      amend.rewardValueCents === undefined
        ? stored.rewardValueCents
        : amend.rewardValueCents
    const mergedPercent =
      amend.rewardValuePercent === undefined
        ? stored.rewardValuePercent
        : amend.rewardValuePercent

    const coherence = mergedRewardIsCoherent(
      mergedType,
      mergedCents,
      mergedPercent
    )

    if (coherence !== null) {
      return coherence
    }

    if (
      amend.maxRedemptions !== undefined &&
      amend.maxRedemptions !== null &&
      amend.maxRedemptions < stored.redemptionCount
    ) {
      return fail(
        'CONFLICT',
        'This code has already been redeemed more times than that.',
        {
          maxRedemptions: [
            `It has been redeemed ${stored.redemptionCount} times already.`,
          ],
        }
      )
    }

    const updated = await ctx.db.referralCode.update({
      where: { id: stored.id },
      data: {
        ...(amend.label === undefined ? {} : { label: amend.label }),
        ...(amend.currency === undefined ? {} : { currency: amend.currency }),
        ...(amend.refereeRewardCents === undefined
          ? {}
          : { refereeRewardCents: amend.refereeRewardCents }),
        ...(amend.maxRedemptions === undefined
          ? {}
          : { maxRedemptions: amend.maxRedemptions }),
        ...(amend.expiresAt === undefined
          ? {}
          : { expiresAt: amend.expiresAt }),
        ...(amend.isActive === undefined ? {} : { isActive: amend.isActive }),
        // The reward is written as a coherent triple whenever any part of it
        // moved, so the two value columns can never disagree with the type.
        ...(amend.rewardType === undefined &&
        amend.rewardValueCents === undefined &&
        amend.rewardValuePercent === undefined
          ? {}
          : {
              rewardType: mergedType,
              rewardValueCents:
                referralRewardValueKind(mergedType) === 'PERCENT'
                  ? null
                  : mergedCents,
              rewardValuePercent:
                referralRewardValueKind(mergedType) === 'PERCENT'
                  ? mergedPercent
                  : null,
            }),
      },
      select: REFERRAL_CODE_SELECT,
    })

    return ok(toReferralCodeSummary(updated, new Date()))
  }
)

/**
 * The merged reward triple, checked against itself.
 *
 * Returns the refusal, or `null` when the combination is coherent. Separated
 * from the action so the two failure sentences sit next to each other and match
 * the wording `referralCodeUpdateSchema` uses for the in-payload version of the
 * same rule.
 */
function mergedRewardIsCoherent(
  rewardType: RewardType,
  rewardValueCents: number | null,
  rewardValuePercent: number | null
): ActionFailure | null {
  if (referralRewardValueKind(rewardType) === 'PERCENT') {
    if (rewardValuePercent === null) {
      return fail(
        'VALIDATION',
        'A percentage code needs the share it takes off.',
        {
          rewardValuePercent: ['Please set it between 1 and 100.'],
        }
      )
    }

    return null
  }

  if (rewardValueCents === null) {
    return fail('VALIDATION', 'Please set what this code is worth.', {
      rewardValueCents: ['A reward has to be worth something.'],
    })
  }

  return null
}

/** Withdraw a code from circulation without deleting its history. */
export const deactivateReferralCode = withAction(
  {
    name: 'referral.code.deactivate',
    auth: 'SESSION',
    input: referralCodeIdSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralCodeSummary>> => {
    const owned = await requireReferralCodeOwnership(
      ctx.user,
      input.referralCodeId
    )

    if (!owned.ok) {
      return owned
    }

    const updated = await ctx.db.referralCode.update({
      where: { id: owned.data.id },
      data: { isActive: false },
      select: REFERRAL_CODE_SELECT,
    })

    return ok(toReferralCodeSummary(updated, new Date()))
  }
)

// =============================================================================
// 6. Invitation codes — reading
// =============================================================================

function referralCodeOrderBy(
  sortBy: ReferralCodeSortBy,
  direction: SortDirection
): Prisma.ReferralCodeOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'REDEMPTIONS':
      return [{ redemptionCount: direction }, { id: 'asc' }]

    case 'EXPIRES':
      return [{ expiresAt: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'CODE':
      return [{ code: direction }, { id: 'asc' }]

    default: {
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * Turn a parsed filter into a `WHERE`, with `ownerId` **pinned** rather than
 * honoured for anybody below `ADMIN`.
 *
 * That substitution is the access-control decision of the whole read path: a
 * filter says what the caller would like to see, and this decides what they are
 * allowed to see. The two are never the same object.
 */
function referralCodeScope(
  user: AuthenticatedUser,
  filter: {
    readonly search?: string | undefined
    readonly ownerId?: string | undefined
    readonly rewardTypes: readonly RewardType[]
    readonly isActive: boolean
    readonly expiredOnly: boolean
    readonly exhaustedOnly: boolean
    readonly createdFrom?: Date | undefined
    readonly createdTo?: Date | undefined
  },
  now: Date
): Prisma.ReferralCodeWhereInput {
  const privileged = hasRoleAtLeast(user.role, 'ADMIN')
  const filters: Prisma.ReferralCodeWhereInput[] = [
    { ownerId: privileged ? (filter.ownerId ?? user.id) : user.id },
  ]

  if (filter.search !== undefined) {
    filters.push({
      OR: [
        { code: { contains: filter.search, mode: 'insensitive' } },
        { label: { contains: filter.search, mode: 'insensitive' } },
      ],
    })
  }

  if (filter.rewardTypes.length > 0) {
    filters.push({ rewardType: { in: [...filter.rewardTypes] } })
  }

  filters.push({ isActive: filter.isActive })

  if (filter.expiredOnly) {
    filters.push({ expiresAt: { not: null, lte: now } })
  }

  if (filter.exhaustedOnly) {
    // "Capped, and at or past the cap." The second half compares two columns of
    // the same row, which Prisma expresses with a field reference —
    // `prisma.referralCode.fields.maxRedemptions` — rather than a literal. The
    // alternative, reading every capped code and filtering in JavaScript, is a
    // full scan of a table that grows with the customer base.
    filters.push({
      maxRedemptions: { not: null },
      redemptionCount: { gte: prisma.referralCode.fields.maxRedemptions },
    })
  }

  if (filter.createdFrom !== undefined) {
    filters.push({ createdAt: { gte: filter.createdFrom } })
  }

  if (filter.createdTo !== undefined) {
    filters.push({ createdAt: { lte: filter.createdTo } })
  }

  return { AND: filters }
}

/**
 * The referral screen, in one read: the caller's codes, their balance, and how
 * many invitations are still waiting to qualify.
 *
 * This is `referral.read` in `@mannachef/api-contract` and returns exactly
 * `referralOverviewSchema`. `ownerId` is pinned by {@link referralCodeScope};
 * the balance is always the caller's own, whatever the filter says, because a
 * balance is not a thing a filter should be able to address.
 */
export const readReferralOverview = withAction(
  {
    name: 'referral.read',
    auth: 'SESSION',
    input: referralCodeFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ReferralOverview>> => {
    const now = new Date()
    const where = referralCodeScope(ctx.user, filter, now)
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows, balance, pendingRedemptions] = await Promise.all([
      ctx.db.referralCode.count({ where }),
      ctx.db.referralCode.findMany({
        where,
        select: REFERRAL_CODE_SELECT,
        orderBy: referralCodeOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
      ctx.db.rewardBalance.findUnique({
        where: { userId: ctx.user.id },
        select: REWARD_BALANCE_SELECT,
      }),
      ctx.db.referralRedemption.count({
        where: {
          status: 'PENDING',
          referralCode: { ownerId: ctx.user.id },
        },
      }),
    ])

    return ok({
      codes: {
        items: rows.map((row) => toReferralCodeSummary(row, now)),
        meta: buildPageMeta(filter.page, filter.pageSize, total),
      },
      balance: balance ?? emptyBalance('CAD'),
      pendingRedemptions,
    })
  }
)

/** The same page of codes without the balance, for an admin growth table. */
export const listReferralCodes = withAction(
  {
    name: 'referral.code.list',
    auth: 'SESSION',
    input: referralCodeFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ReferralCodeListView>> => {
    const now = new Date()
    const where = referralCodeScope(ctx.user, filter, now)
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.referralCode.count({ where }),
      ctx.db.referralCode.findMany({
        where,
        select: REFERRAL_CODE_SELECT,
        orderBy: referralCodeOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map((row) => toReferralCodeSummary(row, now)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 7. Redemption
// =============================================================================

/** What a successful redemption tells the guest. */
export interface ReferralRedemptionReceipt {
  readonly redemptionId: string
  readonly code: string
  readonly status: ReferralRedemptionStatus
  /**
   * What the invited guest themselves will receive once they qualify, in whole
   * cents, or `null` when the code rewards only its owner. The *owner's* reward
   * is deliberately not disclosed: it is somebody else's money.
   */
  readonly refereeRewardCents: number | null
  readonly currency: string
}

/**
 * Accept an invitation.
 *
 * ## What this does not do
 *
 * It does not credit anybody. Not the owner, not the guest. It writes a
 * `PENDING` `ReferralRedemption` and stops, because a reward is earned when the
 * referred household actually pays a bill — see the file docblock and
 * {@link findQualifyingInvoice}. Crediting at signup is how a referral
 * programme becomes a faucet.
 *
 * ## The refusals are not decided here
 *
 * They are {@link resolveRedemptionEligibility}'s, and this action's only
 * contributions are the caller check above it and the sentence each refusal is
 * rendered as. That is deliberate (MCV-041, finding F): the same predicate
 * decides the checkout pre-flight in `actions/billing.ts` and the webhook write
 * in `api/webhooks/stripe/route.ts`, and when it lived here in longhand the
 * other two had drifted into weaker copies of it — the checkout path in
 * particular skipped the household heuristic and the one-live-redemption rule
 * altogether.
 *
 * ## The counter
 *
 * `redemptionCount` is bumped with `updateMany` guarded on its *prior* value, a
 * compare-and-swap, inside {@link createReferralRedemption}. Two guests taking
 * the last seat of a capped code therefore produce one redemption and one
 * `CONFLICT`; the loser's `create` is rolled back with the rest of the
 * transaction.
 */
export const redeemReferralCode = withAction(
  {
    name: 'referral.redeem',
    auth: 'SESSION',
    input: referralRedemptionCreateSchema,
    rateLimit: REDEMPTION_RATE_LIMIT,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralRedemptionReceipt>> => {
    const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')
    const referredUserId = input.referredUserId ?? ctx.user.id

    if (!privileged && referredUserId !== ctx.user.id) {
      return fail(
        'FORBIDDEN',
        'You may only accept an invitation on your own account.'
      )
    }

    const receipt = await ctx.db.$transaction(async (tx) => {
      const eligibility = await resolveRedemptionEligibility(
        tx,
        { kind: 'code', code: input.code },
        referredUserId,
        // `ADMIN` and above are the escape hatch when the household heuristic
        // is simply wrong about two members of one family.
        { applyHouseholdHeuristic: !privileged }
      )

      if (eligibility.kind === 'refused') {
        const terms = REDEMPTION_REFUSALS[eligibility.reason]

        // Every refusal about the code itself reads the same to a guest: a
        // sentence under the `code` field. `NO_ACCOUNT` is not about the code,
        // so it does not get one.
        throw terms.code === 'NOT_FOUND'
          ? new ActionError('NOT_FOUND', terms.message)
          : new ActionError('VALIDATION', terms.message, {
              code: [terms.message],
            })
      }

      const { code } = eligibility
      const written = await createReferralRedemption(tx, code, referredUserId)

      if (written.kind === 'raced') {
        throw new ActionError(
          'CONFLICT',
          'That invitation was taken a moment ago. Please try again.'
        )
      }

      return {
        redemptionId: written.redemption.id,
        code: code.code,
        status: written.redemption.status,
        refereeRewardCents: code.refereeRewardCents,
        currency: written.redemption.currency,
      }
    })

    return ok(receipt)
  }
)

// =============================================================================
// 8. Settlement — the rule-driven path to a credit
// =============================================================================

/**
 * Credit the referrals that have genuinely been earned.
 *
 * ## Why this is `ADMIN` and not `SUPER_ADMIN`
 *
 * Because it has no discretion. It cannot choose who is paid, or how much: the
 * population is "`PENDING` redemptions whose referred household has a paid
 * invoice clearing the programme's floor", and the amount is
 * `ownerRewardCents(code, invoice)`. Everything an
 * operator *can* decide — a goodwill grant, a hand-set figure, a reversal —
 * lives in the `SUPER_ADMIN` actions further down. Running the sweep is
 * operations; deciding an amount is finance.
 *
 * ## One transaction per redemption
 *
 * Deliberately not one transaction for the batch. A single malformed code
 * should not roll back forty correct settlements, and the per-redemption
 * compare-and-swap on `status` is what makes a concurrent second run a no-op
 * rather than a double payment. {@link alreadyCredited} is the belt to that
 * brace, and it consults the ledger rather than the status column.
 */
export const settleReferralRedemptions = withAction(
  {
    name: 'referral.settle',
    auth: 'ADMIN',
    input: referralSettlementSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralSettlementView>> => {
    const candidates = await ctx.db.referralRedemption.findMany({
      where: {
        status: 'PENDING',
        ...(input.referredUserId === undefined
          ? {}
          : { referredUserId: input.referredUserId }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: { id: true },
    })

    // Read once for the batch rather than once per redemption: the floor is a
    // property of the programme, not of the household, and a sweep that used
    // two different floors because somebody saved the admin form halfway
    // through would be a sweep nobody could reconcile afterwards.
    const floorCents = await readQualifyingFloorCents(ctx.db)

    let qualified = 0
    let rewarded = 0
    let creditedCents = 0

    for (const candidate of candidates) {
      const outcome = await ctx.db.$transaction(async (tx) => {
        const redemption = await tx.referralRedemption.findUnique({
          where: { id: candidate.id },
          select: {
            id: true,
            status: true,
            referredUserId: true,
            referralCode: { select: REFERRAL_CODE_SELECT },
          },
        })

        if (redemption === null || redemption.status !== 'PENDING') {
          return { qualified: 0, rewarded: 0, credited: 0 }
        }

        const invoice = await findQualifyingInvoice(
          tx,
          redemption.referredUserId,
          floorCents
        )

        if (invoice === null) {
          return { qualified: 0, rewarded: 0, credited: 0 }
        }

        // Compare-and-swap: only the run that moves it off PENDING may pay.
        const moved = await tx.referralRedemption.updateMany({
          where: { id: redemption.id, status: 'PENDING' },
          data: { status: 'QUALIFIED', qualifiedAt: invoice.paidAt },
        })

        if (moved.count !== 1) {
          return { qualified: 0, rewarded: 0, credited: 0 }
        }

        const code = redemption.referralCode
        const amount = ownerRewardCents(code, invoice)
        const currency = code.currency

        let credited = 0

        if (
          amount > 0 &&
          !(await alreadyCredited(tx, redemption.id, code.ownerId))
        ) {
          await appendLedgerEntry(tx, {
            userId: code.ownerId,
            direction: 'CREDIT',
            reason: 'REFERRAL_REWARD',
            amountCents: amount,
            currency,
            referralRedemptionId: redemption.id,
            invoiceId: invoice.id,
            createdById: ctx.user.id,
            note: `Referral reward for invitation ${code.code}.`,
          })

          credited += amount
        }

        const refereeAmount = code.refereeRewardCents ?? 0

        if (
          refereeAmount > 0 &&
          !(await alreadyCredited(tx, redemption.id, redemption.referredUserId))
        ) {
          await appendLedgerEntry(tx, {
            userId: redemption.referredUserId,
            direction: 'CREDIT',
            reason: 'REFERRAL_SIGNUP_BONUS',
            amountCents: refereeAmount,
            currency,
            referralRedemptionId: redemption.id,
            invoiceId: invoice.id,
            createdById: ctx.user.id,
            note: `Welcome credit for accepting invitation ${code.code}.`,
          })

          credited += refereeAmount
        }

        await tx.referralRedemption.update({
          where: { id: redemption.id },
          data: {
            status: 'REWARDED',
            rewardedAt: new Date(),
            rewardCents: amount,
            currency,
          },
          select: { id: true },
        })

        return { qualified: 1, rewarded: 1, credited }
      })

      qualified += outcome.qualified
      rewarded += outcome.rewarded
      creditedCents += outcome.credited
    }

    return ok({
      examined: candidates.length,
      qualified,
      rewarded,
      skipped: candidates.length - rewarded,
      creditedCents,
    })
  }
)

// =============================================================================
// 9. Redemption lifecycle — the manual path
// =============================================================================

/**
 * Move one redemption by hand.
 *
 * `referralRedemptionStatusUpdateSchema` is a discriminated union of four
 * commands; this is where each one meets the database.
 *
 * ## `QUALIFY` and `REWARD` still check the invoice
 *
 * An administrator asserting that a household has paid does not make it so.
 * Both branches call {@link findQualifyingInvoice} and refuse when it returns
 * `null`, with the same sentence the automatic sweep would have been silent
 * about. This is what stops the manual path from being a way around the rule
 * the automatic path enforces.
 *
 * ## Money needs `SUPER_ADMIN`
 *
 * `REWARD` writes a credit and `REVOKE` with `reverseLedgerEntry` writes a
 * debit; both are refused below `SUPER_ADMIN`, matching
 * {@link recordRewardAdjustment}. `QUALIFY` and `EXPIRE` move a status and
 * touch no balance, so `ADMIN` is enough for them.
 *
 * ## `REVOKE` writes a compensating entry, never an edit
 *
 * `RewardLedgerEntry` is append-only. Taking a reward back is a `REVERSAL`
 * debit for exactly what was credited, which is the one movement
 * {@link appendLedgerEntry} allows to drive a balance negative — because a
 * guest who has already spent a revoked credit genuinely owes it.
 */
export const updateReferralRedemption = withAction(
  {
    name: 'referral.redemption.update',
    auth: 'ADMIN',
    input: referralRedemptionStatusUpdateSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralRedemptionView>> => {
    const movesMoney =
      input.action === 'REWARD' ||
      (input.action === 'REVOKE' && input.reverseLedgerEntry)

    if (movesMoney && !hasRoleAtLeast(ctx.user.role, 'SUPER_ADMIN')) {
      return fail(
        'FORBIDDEN',
        'Moving credit on or off a balance is reserved to a super administrator.'
      )
    }

    const row = await ctx.db.$transaction(async (tx) => {
      const redemption = await tx.referralRedemption.findUnique({
        where: { id: input.redemptionId },
        select: {
          id: true,
          status: true,
          referredUserId: true,
          currency: true,
          rewardCents: true,
          referralCode: { select: REFERRAL_CODE_SELECT },
        },
      })

      if (redemption === null) {
        throw new ActionError('NOT_FOUND', 'We could not find that redemption.')
      }

      const code = redemption.referralCode
      const floorCents = await readQualifyingFloorCents(tx)

      switch (input.action) {
        case 'QUALIFY': {
          if (redemption.status !== 'PENDING') {
            throw new ActionError(
              'CONFLICT',
              'Only a pending redemption can be qualified.'
            )
          }

          const invoice = await findQualifyingInvoice(
            tx,
            redemption.referredUserId,
            floorCents
          )

          if (invoice === null) {
            throw new ActionError(
              'CONFLICT',
              'This household has no paid invoice yet, so the referral has not been earned.'
            )
          }

          const moved = await tx.referralRedemption.updateMany({
            where: { id: redemption.id, status: 'PENDING' },
            data: {
              status: 'QUALIFIED',
              qualifiedAt: input.qualifiedAt ?? invoice.paidAt,
            },
          })

          if (moved.count !== 1) {
            throw new ActionError(
              'CONFLICT',
              'This redemption moved a moment ago. Please reload and try again.'
            )
          }

          break
        }

        case 'REWARD': {
          if (redemption.status !== 'QUALIFIED') {
            throw new ActionError(
              'CONFLICT',
              'A redemption is rewarded once it has qualified.'
            )
          }

          const invoice = await findQualifyingInvoice(
            tx,
            redemption.referredUserId,
            floorCents
          )

          if (invoice === null) {
            throw new ActionError(
              'CONFLICT',
              'This household has no paid invoice, so there is nothing to reward.'
            )
          }

          if (await alreadyCredited(tx, redemption.id, code.ownerId)) {
            throw new ActionError(
              'CONFLICT',
              'This referral has already been paid.'
            )
          }

          const amount = input.rewardCents ?? ownerRewardCents(code, invoice)

          if (amount > 0) {
            await appendLedgerEntry(tx, {
              userId: code.ownerId,
              direction: 'CREDIT',
              reason: 'REFERRAL_REWARD',
              amountCents: amount,
              currency: code.currency,
              referralRedemptionId: redemption.id,
              invoiceId: invoice.id,
              createdById: ctx.user.id,
              note: `Referral reward for invitation ${code.code}.`,
            })
          }

          const moved = await tx.referralRedemption.updateMany({
            where: { id: redemption.id, status: 'QUALIFIED' },
            data: {
              status: 'REWARDED',
              rewardedAt: input.rewardedAt ?? new Date(),
              rewardCents: amount,
            },
          })

          if (moved.count !== 1) {
            throw new ActionError(
              'CONFLICT',
              'This redemption moved a moment ago. Please reload and try again.'
            )
          }

          break
        }

        case 'EXPIRE': {
          if (
            redemption.status !== 'PENDING' &&
            redemption.status !== 'QUALIFIED'
          ) {
            throw new ActionError(
              'CONFLICT',
              'Only an unsettled redemption can be allowed to lapse.'
            )
          }

          await tx.referralRedemption.update({
            where: { id: redemption.id },
            data: { status: 'EXPIRED' },
            select: { id: true },
          })

          break
        }

        case 'REVOKE': {
          if (redemption.status === 'REVOKED') {
            throw new ActionError(
              'CONFLICT',
              'This redemption has already been withdrawn.'
            )
          }

          if (input.reverseLedgerEntry) {
            const credits = await tx.rewardLedgerEntry.findMany({
              where: {
                referralRedemptionId: redemption.id,
                direction: 'CREDIT',
                reason: { in: [...REFERRAL_CREDIT_REASONS] },
              },
              select: {
                userId: true,
                amountCents: true,
                currency: true,
              },
            })

            for (const credit of credits) {
              await appendLedgerEntry(tx, {
                userId: credit.userId,
                direction: 'DEBIT',
                reason: 'REVERSAL',
                amountCents: credit.amountCents,
                currency: credit.currency,
                referralRedemptionId: redemption.id,
                invoiceId: null,
                createdById: ctx.user.id,
                note: `Reversal of the reward for invitation ${code.code}. ${input.revokedReason}`,
              })
            }
          }

          await tx.referralRedemption.update({
            where: { id: redemption.id },
            data: {
              status: 'REVOKED',
              revokedAt: input.revokedAt ?? new Date(),
              revokedReason: input.revokedReason,
            },
            select: { id: true },
          })

          break
        }

        default: {
          const exhaustive: never = input
          return exhaustive
        }
      }

      return tx.referralRedemption.findUniqueOrThrow({
        where: { id: redemption.id },
        select: REDEMPTION_SELECT,
      })
    })

    return ok(toRedemptionView(row, ctx.user))
  }
)

/**
 * The redemptions the caller may see.
 *
 * Below `ADMIN` the scope is the union of two relationships: redemptions *of
 * codes the caller owns*, and the caller's own redemption of somebody else's
 * code. Neither is a filter the caller supplies — both are derived from the
 * session — and {@link toRedemptionView} then withholds the referred
 * household's identity from a code owner who is not staff.
 */
export const listReferralRedemptions = withAction(
  {
    name: 'referral.redemption.list',
    auth: 'SESSION',
    input: referralRedemptionFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ReferralRedemptionListView>> => {
    const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')

    const filters: Prisma.ReferralRedemptionWhereInput[] = [
      privileged
        ? {}
        : {
            OR: [
              { referralCode: { ownerId: ctx.user.id } },
              { referredUserId: ctx.user.id },
            ],
          },
    ]

    if (filter.referralCodeId !== undefined) {
      filters.push({ referralCodeId: filter.referralCodeId })
    }

    if (filter.referredUserId !== undefined) {
      filters.push({ referredUserId: filter.referredUserId })
    }

    if (filter.ownerId !== undefined) {
      filters.push({ referralCode: { ownerId: filter.ownerId } })
    }

    if (filter.statuses.length > 0) {
      filters.push({ status: { in: [...filter.statuses] } })
    }

    if (filter.createdFrom !== undefined) {
      filters.push({ createdAt: { gte: filter.createdFrom } })
    }

    if (filter.createdTo !== undefined) {
      filters.push({ createdAt: { lte: filter.createdTo } })
    }

    const where: Prisma.ReferralRedemptionWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.referralRedemption.count({ where }),
      ctx.db.referralRedemption.findMany({
        where,
        select: REDEMPTION_SELECT,
        orderBy: [{ createdAt: filter.sortDirection }, { id: 'asc' }],
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map((row) => toRedemptionView(row, ctx.user)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 10. The ledger — reading
// =============================================================================

/**
 * A page of the ledger, with the balance it adds up to.
 *
 * `userId` is pinned to the session below `ADMIN`, exactly as `ownerId` is on
 * the code list. The balance returned alongside is recomputed from the ledger
 * rather than read from the cache, so this screen is also the reconciliation
 * report: if the two ever disagreed, this is the number that would be right.
 */
export const readRewardLedger = withAction(
  {
    name: 'referral.ledger.read',
    auth: 'SESSION',
    input: rewardLedgerFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<RewardLedgerView>> => {
    const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')
    const subjectId = privileged ? (filter.userId ?? ctx.user.id) : ctx.user.id

    const filters: Prisma.RewardLedgerEntryWhereInput[] = [
      { userId: subjectId },
    ]

    if (filter.referralRedemptionId !== undefined) {
      filters.push({ referralRedemptionId: filter.referralRedemptionId })
    }

    if (filter.invoiceId !== undefined) {
      filters.push({ invoiceId: filter.invoiceId })
    }

    if (filter.directions.length > 0) {
      filters.push({ direction: { in: [...filter.directions] } })
    }

    if (filter.reasons.length > 0) {
      filters.push({ reason: { in: [...filter.reasons] } })
    }

    if (filter.minAmountCents !== undefined) {
      filters.push({ amountCents: { gte: filter.minAmountCents } })
    }

    if (filter.maxAmountCents !== undefined) {
      filters.push({ amountCents: { lte: filter.maxAmountCents } })
    }

    if (filter.createdFrom !== undefined) {
      filters.push({ createdAt: { gte: filter.createdFrom } })
    }

    if (filter.createdTo !== undefined) {
      filters.push({ createdAt: { lte: filter.createdTo } })
    }

    const where: Prisma.RewardLedgerEntryWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows, totals, stored] = await Promise.all([
      ctx.db.rewardLedgerEntry.count({ where }),
      ctx.db.rewardLedgerEntry.findMany({
        where,
        select: LEDGER_SELECT,
        orderBy: [{ createdAt: filter.sortDirection }, { id: 'asc' }],
        skip,
        take,
      }),
      readLedgerTotals(ctx.db, subjectId),
      ctx.db.rewardBalance.findUnique({
        where: { userId: subjectId },
        select: { currency: true },
      }),
    ])

    return ok({
      items: rows.map(toLedgerView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
      balance: {
        balanceCents: totals.balanceCents,
        lifetimeEarnedCents: totals.lifetimeEarnedCents,
        lifetimeRedeemedCents: totals.lifetimeRedeemedCents,
        currency: stored?.currency ?? 'CAD',
        lastEarnedAt: totals.lastEarnedAt,
        lastRedeemedAt: totals.lastRedeemedAt,
      },
    })
  }
)

// =============================================================================
// 11. Payout and adjustment — SUPER_ADMIN only
// =============================================================================

/**
 * Pay a referral reward by hand.
 *
 * The escape hatch for the case the sweep cannot express: a reward agreed at a
 * different figure, a settlement re-run after a data fix, a bonus paid to the
 * invited household rather than the inviter. It is `SUPER_ADMIN` because the
 * amount is the caller's to choose, and it still refuses to pay a referral the
 * database says has not been earned — {@link findQualifyingInvoice} is called
 * here exactly as it is in the automatic path.
 *
 * `alreadyCredited` makes it idempotent per (redemption, recipient, reason
 * family): running it twice pays once.
 */
export const payReferralReward = withAction(
  {
    name: 'referral.reward.pay',
    auth: 'SUPER_ADMIN',
    input: rewardPayoutSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<RewardLedgerEntryView>> => {
    const result = await ctx.db.$transaction(async (tx) => {
      const redemption = await tx.referralRedemption.findUnique({
        where: { id: input.referralRedemptionId },
        select: {
          id: true,
          status: true,
          referredUserId: true,
          referralCode: { select: { id: true, code: true, ownerId: true } },
        },
      })

      if (redemption === null) {
        throw new ActionError('NOT_FOUND', 'We could not find that redemption.')
      }

      // The recipient must be one of the two parties to the referral. Paying a
      // referral reward to an unrelated account is not a payout, it is a grant,
      // and grants go through `recordRewardAdjustment` where a note is required.
      const isOwner = input.userId === redemption.referralCode.ownerId
      const isReferee = input.userId === redemption.referredUserId

      if (!isOwner && !isReferee) {
        throw new ActionError(
          'VALIDATION',
          'That account is not a party to this referral.',
          { userId: ['Pay the inviting or the invited account.'] }
        )
      }

      const invoice = await findQualifyingInvoice(
        tx,
        redemption.referredUserId,
        await readQualifyingFloorCents(tx)
      )

      if (invoice === null) {
        throw new ActionError(
          'CONFLICT',
          'This household has no paid invoice, so the referral has not been earned.'
        )
      }

      if (await alreadyCredited(tx, redemption.id, input.userId)) {
        throw new ActionError(
          'CONFLICT',
          'This account has already been paid for this referral.'
        )
      }

      const { entry } = await appendLedgerEntry(tx, {
        userId: input.userId,
        direction: 'CREDIT',
        reason: input.reason,
        amountCents: input.amountCents,
        currency: input.currency,
        referralRedemptionId: redemption.id,
        invoiceId: invoice.id,
        createdById: ctx.user.id,
        note: input.note ?? null,
      })

      if (
        redemption.status === 'QUALIFIED' ||
        redemption.status === 'PENDING'
      ) {
        await tx.referralRedemption.update({
          where: { id: redemption.id },
          data: {
            status: 'REWARDED',
            rewardedAt: new Date(),
            ...(isOwner ? { rewardCents: input.amountCents } : {}),
            ...(redemption.status === 'PENDING'
              ? { qualifiedAt: invoice.paidAt }
              : {}),
          },
          select: { id: true },
        })
      }

      return entry
    })

    return ok(toLedgerView(result))
  }
)

/**
 * Any other movement on the ledger.
 *
 * Goodwill, corrections, credit spent against a bill, an expiry sweep, a
 * reversal. `rewardAdjustmentSchema` already pairs each reason with the
 * direction it must carry and demands a note; what it cannot check is that the
 * rows being pointed at belong to the person being credited, and that is what
 * this action adds:
 *
 *  - `invoiceId`, when given, must be an invoice **of the subject account**.
 *    This is the ownership check for this action: the caller is a super
 *    administrator, so the question is not "may they reach this row" but "does
 *    this row belong to the balance being moved". Spending one household's
 *    credit against another's bill would otherwise be a typo away.
 *  - `referralRedemptionId`, when given, must name a redemption the subject is
 *    a party to.
 *
 * `SUPER_ADMIN`, because this is the one action that can put money on a balance
 * with no rule behind it at all.
 */
export const recordRewardAdjustment = withAction(
  {
    name: 'referral.reward.adjust',
    auth: 'SUPER_ADMIN',
    input: rewardAdjustmentSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<RewardLedgerEntryView>> => {
    const result = await ctx.db.$transaction(async (tx) => {
      const subject = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      })

      if (subject === null) {
        throw new ActionError('NOT_FOUND', 'We could not find that account.')
      }

      const invoiceId = input.invoiceId ?? null

      if (invoiceId !== null) {
        const invoice = await tx.invoice.findUnique({
          where: { id: invoiceId },
          select: { id: true, userId: true },
        })

        if (invoice === null || invoice.userId !== subject.id) {
          throw new ActionError(
            'VALIDATION',
            'That invoice does not belong to this account.',
            { invoiceId: ['Please choose one of this account’s invoices.'] }
          )
        }
      }

      const redemptionId = input.referralRedemptionId ?? null

      if (redemptionId !== null) {
        const redemption = await tx.referralRedemption.findUnique({
          where: { id: redemptionId },
          select: {
            id: true,
            referredUserId: true,
            referralCode: { select: { ownerId: true } },
          },
        })

        if (
          redemption === null ||
          (redemption.referredUserId !== subject.id &&
            redemption.referralCode.ownerId !== subject.id)
        ) {
          throw new ActionError(
            'VALIDATION',
            'That redemption does not involve this account.',
            {
              referralRedemptionId: [
                'Please choose a referral this account is part of.',
              ],
            }
          )
        }
      }

      const { entry } = await appendLedgerEntry(tx, {
        userId: subject.id,
        direction: input.direction,
        reason: input.reason,
        amountCents: input.amountCents,
        currency: input.currency,
        referralRedemptionId: redemptionId,
        invoiceId,
        createdById: ctx.user.id,
        note: input.note,
      })

      return entry
    })

    return ok(toLedgerView(result))
  }
)

/**
 * Rebuild one account's `RewardBalance` from its ledger.
 *
 * Writes no ledger entry and moves no money — it only makes the cache agree
 * with the record it is a cache of. That it can be run at all, and that running
 * it is a no-op on a healthy account, is the property that makes the balance
 * auditable: any disagreement is a bug in something else, and this is the fix.
 *
 * `ADMIN`, because reconciling a derived column is operations rather than
 * finance. It cannot change what anybody is owed.
 */
export const recomputeRewardBalance = withAction(
  {
    name: 'referral.balance.recompute',
    auth: 'ADMIN',
    input: rewardSubjectSchema,
    revalidatePaths: REFERRAL_PATHS,
    revalidateTags: REFERRAL_TAGS,
  },
  async (ctx, input): Promise<ActionResult<RewardBalanceView>> => {
    const subject = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    })

    if (subject === null) {
      return fail('NOT_FOUND', 'We could not find that account.')
    }

    const balance = await ctx.db.$transaction((tx) =>
      writeRecomputedBalance(tx, subject.id, null)
    )

    return ok(balance)
  }
)
