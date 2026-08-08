// mannachef/apps/web/scripts/verify-referral-preemption.ts

/**
 * The MCV-052 regression: **an attribution becomes money only when the
 * household holding the mailbox says so**, and it still becomes money when they
 * do.
 *
 * ```bash
 * createdb mannachef_mcv052_harness
 * DATABASE_URL='postgresql://…/mannachef_mcv052_harness' \
 *   pnpm --filter=@mannachef/db exec prisma migrate deploy
 * DATABASE_URL='postgresql://…/mannachef_mcv052_harness' \
 *   pnpm --filter=@mannachef/web verify:preemption
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied at the head of each scenario**, so it refuses to start unless the
 * database name looks disposable — see `assertDisposableDatabase` in
 * `fixtures/database.ts`.
 *
 * ## Why this file was rewritten rather than extended
 *
 * The previous version reported the pre-emption closed. It was not. Its attack
 * scenario ("the pre-emption") never called `firstSignIn`; its legitimate
 * scenario ("a genuine prospect") was byte-identical in mechanism and did. So
 * the attacker "failed" only because the harness declined, on the attacker's
 * behalf, to perform the one step that made the money move — and the two
 * scenarios were separated by nothing but the author's choice of email literal.
 * Measured properly, the sprayed claim settled against the victim's own organic
 * magic-link sign-in and paid the sprayer `{examined: 1, rewarded: 1,
 * creditedCents: 5000}`.
 *
 * A harness whose scenarios differ by test data proves nothing about a server.
 * Every scenario below is therefore separated by a **property of the system**,
 * and scenarios 1, 2, 3 and 6 go further: they share one prefix function, one
 * email literal and one invitation code, so the *only* difference between "the
 * sprayer is paid nothing" and "the sprayer is paid $50.00" is which consent
 * action the household invoked. Nothing about the attacker's behaviour differs
 * between them. Nothing about the data differs between them. In particular the
 * victim signs in **in every attack scenario**, because a victim signing into
 * their own account is not something an attacker has to arrange — it is the
 * thing victims do, and omitting it is how the last harness deceived itself.
 *
 * ## The structural change these scenarios measure
 *
 * Settlement used to be automatic: `settleFirstAuthenticatedSession`, fired from
 * `authConfig.events.signIn`. Automatic settlement cannot be made safe, because
 * the server cannot tell the genuine prospect's sign-in from the victim's — they
 * are the same request, in the same shape, from the same mailbox. Every
 * narrowing of that guard produced a narrower wrong answer.
 *
 * The answer is consent. `@/server/referral-claim` records a string and nothing
 * else, and `actions/referral-claim.ts` offers it to the **authenticated
 * household** with its provenance stated. `acceptReferralClaim` is the one path
 * from that string to a `ReferralRedemption`, and the id it settles for is the
 * resolved session's own. A party who does not hold the mailbox cannot reach it
 * at all — not by racing, not by guessing, not by waiting.
 *
 * ## The scenarios, and the property that separates each from its neighbours
 *
 * | # | Shape                            | Separated by                          |
 * | - | -------------------------------- | ------------------------------------- |
 * | 1 | spray, household never answers   | no decision action was invoked        |
 * | 2 | spray, household declines        | `referral.claim.decline` was invoked  |
 * | 3 | spray, household accepts         | `referral.claim.accept` was invoked   |
 * | 4 | two anonymous POSTs at one       | which of them the *placeholder*       |
 * |   | address, run in **both** orders  | received last, before it was proved   |
 * | 5 | genuine invitation, end to end   | a second sweep over settled rows      |
 * | 6 | four simultaneous acceptances    | concurrency against one claim token   |
 * | 7 | the same spray, aged one day     | the age of the claim, and nothing     |
 * |   | inside and one day outside the   | else — see §12                        |
 * |   | window, and accepted both times  |                                       |
 * | 8 | a sign-in whose clear of         | whether `unclaimedSince` is still     |
 * |   | `unclaimedSince` faulted         | stamped on an account with a session  |
 *
 * Scenario 4 is the one that had to be run twice, and §9 argues why at length.
 * Its previous single ordering — spray, then the household's own enquiry —
 * concluded that the household is shown their own code, and that conclusion was
 * produced by the author's choice of which POST to send second rather than by
 * anything the server does. `recordReferralClaim` is last-writer-wins; the other
 * ordering shows a genuinely-referred household the sprayer's code with the
 * sprayer named as their inviter, and a sprayer picks when to fire. Both
 * orderings now run from one body, the differing property is asserted as `last`
 * rather than as a code literal, and the invariant that does *not* vary — the
 * genuine inviter is paid, the sprayer is not — is asserted in identical terms
 * on both sides.
 *
 * ## What is real here
 *
 * The real `requestConsultation` and `submitProspectIntake` (`auth: 'PUBLIC'`),
 * the real `readPendingReferralClaim` / `acceptReferralClaim` /
 * `declineReferralClaim` (`auth: 'SESSION'`), the real `markMailboxProved` as
 * `authConfig.events.signIn` calls it, the real `createReferralCode`, the real
 * `redeemReferralCode` and the real `settleReferralRedemptions` — every one of
 * them driven through the real `withAction` wrapper, the real zod schemas and
 * the real rate limiter, against a real PostgreSQL. Only the session and the
 * three request-scoped Next.js modules are substituted, at module resolution, by
 * `scripts/action-resolver.mjs`.
 *
 * Three scenarios reach past the actions, and all three say so where they do it:
 * scenario 2 forges a claim back onto a profile to prove the tombstone outranks
 * the column; scenario 7 ages `claimedAt` with `backdateReferralClaim` so the
 * lapse window can be crossed without waiting a month; and scenario 8 renames
 * `User.unclaimedSince` for the length of one call so that a clear of it faults
 * for real. None of the three substitutes a decision — the clock stays the real
 * one, the fault is PostgreSQL's own, and every verdict is the shipped code's.
 *
 * Every scenario asserts on **rows**: redemptions, `ReferralCode.redemptionCount`,
 * `RewardBalance`, `RewardLedgerEntry`, the two claim columns on `ClientProfile`,
 * and the `InteractionLog` tombstones. A return value is what the code says it
 * did; the rows are what it did. Nothing is asserted inside an `async` callback
 * — `check` does not await, so an async body would report `ok` before its
 * assertions ran, which is the same class of self-deception this file was
 * rewritten to remove.
 */

import assert from 'node:assert/strict'

import {
  requestConsultation,
  submitProspectIntake,
} from '@/server/actions/intake'
import {
  acceptReferralClaim,
  declineReferralClaim,
  readPendingReferralClaim,
  type PendingReferralClaimView,
  type ReferralClaimStanding,
} from '@/server/actions/referral-claim'
import {
  createReferralCode,
  redeemReferralCode,
  settleReferralRedemptions,
} from '@/server/actions/referral'
import { prisma } from '@/server/db'
import {
  CLAIM_WINDOW_DAYS,
  ensureMailboxProved,
  markMailboxProved,
} from '@/server/referral-claim'

import { asUser, signInAs, type HarnessUser } from './fixtures/harness-state'
import {
  ATTACKER,
  OVERSEER,
  PATRON,
  accountSnapshot,
  assertDisposableDatabase,
  backdateReferralClaim,
  balanceCentsOf,
  check,
  checkCount,
  clearRateLimits,
  consultationPayload,
  disconnect,
  money,
  note,
  printTable,
  profileIdForEmail,
  prospectPayload,
  redemptionCountOf,
  redemptionsForCode,
  referralClaimOf,
  resetDatabase,
  section,
  seedBareUser,
  seedHousehold,
  seedProgram,
  unclaimedSinceOf,
  userIdForEmail,
  type AccountSnapshot,
} from './fixtures/intake-harness'

// =============================================================================
// 1. The figures, and the one address every attack aims at
// =============================================================================

/** What the programme pays an inviter. The original probe's `$50.00`. */
const REWARD_CENTS = 5_000

/** The floor a referred household's invoice must clear to qualify. */
const FLOOR_CENTS = 5_000

/** What the pre-empted household eventually pays us, of their own accord. */
const HOUSEHOLD_INVOICE_CENTS = 12_000

/** The sprayer's code. Minted by `ATTACKER`, who has invited nobody. */
const SPRAYED_CODE = 'HARVEST24'

/** The code a real member actually handed out. Minted by `PATRON`. */
const GENUINE_CODE = 'GENUINE24'

/**
 * The one address in this file. Every scenario uses it — attacks and the
 * legitimate end-to-end alike.
 *
 * There is deliberately no second literal, and no `VICTIM_EMAIL` /
 * `NEWCOMER_EMAIL` pair, because the previous harness's two headline scenarios
 * were separated by exactly that and nothing else. An address is test data. If
 * an outcome here changes, a **property of the system** changed, because there
 * is no address left for it to have changed with.
 */
const HOUSEHOLD_EMAIL = 'not.yet.a.customer@example.org'

// =============================================================================
// 2. Staging
// =============================================================================

/** The two invitation codes every scenario starts with. */
interface Stage {
  /** `SPRAYED_CODE`, owned by `ATTACKER`. */
  readonly sprayedCodeId: string
  /** `GENUINE_CODE`, owned by `PATRON`. */
  readonly genuineCodeId: string
}

/**
 * The world every scenario starts from.
 *
 * A standing offer, two members who each hold a live invitation code, and a
 * concierge to run the sweep. Both codes are minted every time, whether the
 * scenario uses both or not, so that no scenario's premise differs from any
 * other scenario's premise.
 *
 * The codes are minted through the **real** `createReferralCode` rather than an
 * `INSERT`, because "an ordinary `CLIENT` mints a programme-priced code" is step
 * one of the exploit and it should be the shipped action that proves it.
 */
async function stage(): Promise<Stage> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
    defaultMaxRedemptions: null,
  })

  await seedHousehold({ person: ATTACKER, status: 'ACTIVE_SUBSCRIBER' })
  await seedHousehold({
    person: PATRON,
    status: 'ACTIVE_SUBSCRIBER',
    allergies: ['peanuts'],
    paidInvoiceCents: 24_000,
  })
  await seedBareUser(OVERSEER)

  const sprayedCodeId = await mintCode(ATTACKER, SPRAYED_CODE)
  const genuineCodeId = await mintCode(PATRON, GENUINE_CODE)

  signInAs(null)
  clearRateLimits()

  return { sprayedCodeId, genuineCodeId }
}

/** Mint one code as `owner`, through the audited door, and return its row id. */
async function mintCode(owner: HarnessUser, code: string): Promise<string> {
  signInAs(owner)
  clearRateLimits()

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    // Stated, and discarded: below `ADMIN` the terms are the programme's
    // (MCV-030). The figure that reaches the row is `REWARD_CENTS`, and the
    // assertion below is what says so.
    rewardValueCents: 1_000_000,
    ownerId: owner.id,
    code,
    isActive: true,
  })

  signInAs(null)

  assert.equal(
    minted.ok,
    true,
    `${owner.name ?? 'a member'} could not mint ${code}: ${minted.ok ? '' : minted.error}`
  )

  const row = await prisma.referralCode.findUniqueOrThrow({
    where: { code },
    select: { id: true, ownerId: true, rewardValueCents: true },
  })

  assert.equal(row.ownerId, owner.id)
  assert.equal(
    row.rewardValueCents,
    REWARD_CENTS,
    'a minted code should carry the programme figure, not the payload one'
  )

  return row.id
}

// =============================================================================
// 3. Driving the shipped doors
// =============================================================================

/**
 * One anonymous HTTP POST: no session, no password, no mailbox — an address the
 * caller has only typed, and a code they hold.
 *
 * This is the entirety of what the attacker can do, and it is byte-identical in
 * every scenario that uses it.
 */
async function sprayAnonymously(email: string, code: string): Promise<void> {
  signInAs(null)
  clearRateLimits()

  const posted = await requestConsultation(
    consultationPayload({ email, referralCode: code })
  )

  assert.equal(
    posted.ok,
    true,
    `the public enquiry was refused: ${posted.ok ? '' : posted.error}`
  )
}

/**
 * The household's own enquiry, naming the code they were actually given.
 *
 * Deliberately a one-line alias of {@link sprayAnonymously} rather than a second
 * implementation, because that is the fact scenario 4 turns on: the server
 * cannot tell these two calls apart. They arrive from the same anonymous
 * position, through the same action, carrying the same fields. Whatever
 * separates a sprayer from a prospect, it is not anything in this request.
 */
async function enquireAnonymously(email: string, code: string): Promise<void> {
  await sprayAnonymously(email, code)
}

/**
 * The magic link, as `authConfig.events.signIn` fires it.
 *
 * `server/auth.ts` cannot be imported outside a Next.js runtime, which is why
 * the decision lives in a plain server module and that file holds only the
 * mapping onto it. This calls the same function with the same argument the event
 * passes, and then stamps `lastLoginAt` as the adapter would.
 */
async function magicLinkSignIn(userId: string): Promise<void> {
  const outcome = await markMailboxProved(userId)

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  })

  assert.equal(
    outcome.kind,
    'newly-proved',
    'the first sign-in should have cleared the placeholder marker'
  )
}

/** Read the consent banner as `user`, through the real `auth: 'SESSION'` door. */
async function readBanner(
  user: HarnessUser
): Promise<PendingReferralClaimView | null> {
  signInAs(user)
  clearRateLimits()

  const read = await readPendingReferralClaim({})

  signInAs(null)

  assert.equal(
    read.ok,
    true,
    `the claim read failed: ${read.ok ? '' : read.error}`
  )

  return read.ok ? read.data : null
}

/** The acceptance, as the household, through the real rate-limited door. */
async function acceptAs(
  user: HarnessUser,
  code: string
): Promise<Awaited<ReturnType<typeof acceptReferralClaim>>> {
  signInAs(user)
  clearRateLimits()

  const result = await acceptReferralClaim({ code })

  signInAs(null)

  return result
}

/** The decline, as the household. */
async function declineAs(
  user: HarnessUser,
  code: string
): Promise<Awaited<ReturnType<typeof declineReferralClaim>>> {
  signInAs(user)
  clearRateLimits()

  const result = await declineReferralClaim({ code })

  signInAs(null)

  return result
}

/**
 * The *other* door: `redeemReferralCode`, as the household, naming a code they
 * were given privately rather than one the platform is holding for them.
 *
 * This is what `ReferralClaimBanner`'s "I was given a different code" affordance
 * routes to, and it is deliberately not the consent door. It is separately
 * audited, separately rate limited, and it takes free-form input — which is
 * exactly why the consent door refuses free-form input and converts only the
 * attribution already on file. A household whose banner is showing a stranger's
 * code has this; nothing here depends on the claim column at all.
 */
async function redeemAs(
  user: HarnessUser,
  code: string
): Promise<Awaited<ReturnType<typeof redeemReferralCode>>> {
  signInAs(user)
  clearRateLimits()

  const result = await redeemReferralCode({ code })

  signInAs(null)

  return result
}

/** The same door, with nobody behind it. */
async function acceptAnonymously(
  code: string
): Promise<Awaited<ReturnType<typeof acceptReferralClaim>>> {
  signInAs(null)
  clearRateLimits()

  return acceptReferralClaim({ code })
}

/** What the settlement sweep moved. The original probe reported these three. */
interface SweepRecord {
  readonly examined: number
  readonly rewarded: number
  readonly creditedCents: number
}

const NOTHING_SWEPT: SweepRecord = {
  examined: 0,
  rewarded: 0,
  creditedCents: 0,
}

const ONE_REWARD_SWEPT: SweepRecord = {
  examined: 1,
  rewarded: 1,
  creditedCents: REWARD_CENTS,
}

/** Run the real sweep as the concierge. */
async function sweep(): Promise<SweepRecord> {
  signInAs(OVERSEER)
  clearRateLimits()

  const settled = await settleReferralRedemptions({ limit: 50 })

  signInAs(null)

  assert.equal(
    settled.ok,
    true,
    `the sweep failed: ${settled.ok ? '' : settled.error}`
  )

  if (!settled.ok) {
    return { examined: -1, rewarded: -1, creditedCents: -1 }
  }

  return {
    examined: settled.data.examined,
    rewarded: settled.data.rewarded,
    creditedCents: settled.data.creditedCents,
  }
}

/** A `PAID` invoice for a household, over the floor. */
async function payInvoice(userId: string, cents: number): Promise<void> {
  const now = new Date()

  await prisma.invoice.create({
    data: {
      userId,
      amountDueCents: cents,
      amountPaidCents: cents,
      amountRemainingCents: 0,
      subtotalCents: cents,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: now,
      paidAt: now,
    },
    select: { id: true },
  })
}

/**
 * The `HarnessUser` for an account the public path opened, so the signed-in
 * doors can be driven as them.
 */
async function sessionFor(email: string): Promise<HarnessUser> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      clientProfile: { select: { id: true } },
    },
  })

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: null,
    role: row.role,
    isActive: true,
    timeZone: 'America/Toronto',
    locale: 'en-CA',
    clientProfileId: row.clientProfile?.id ?? null,
    staffProfileId: null,
  }
}

// =============================================================================
// 4. Reading the rows back
// =============================================================================

/**
 * Every `RewardLedgerEntry` a user holds, flattened.
 *
 * Asserted alongside the balance rather than instead of it: the balance is a
 * maintained column and the entries are the audit trail behind it, so a scenario
 * that checked only one of them could not tell "never credited" from "credited
 * and reversed".
 */
interface LedgerRow {
  readonly reason: string
  readonly direction: string
  readonly amountCents: number
}

async function ledgerOf(userId: string): Promise<readonly LedgerRow[]> {
  const rows = await prisma.rewardLedgerEntry.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { reason: true, direction: true, amountCents: true },
  })

  return rows
}

/** One credit of the programme figure, as `settleReferralRedemptions` writes it. */
const ONE_REFERRAL_CREDIT: readonly LedgerRow[] = [
  { reason: 'REFERRAL_REWARD', direction: 'CREDIT', amountCents: REWARD_CENTS },
]

/**
 * The tombstones a household has written, as `actions/referral-claim.ts` keys
 * them: `referral-claim:<answer>:<code>`.
 *
 * This row is what separates "declined" from "never asked" — the property
 * scenario 2 turns on, and the thing that makes a decline outlive the claim it
 * cleared.
 */
async function claimAnswersOf(
  clientProfileId: string
): Promise<readonly string[]> {
  const rows = await prisma.interactionLog.findMany({
    where: { clientProfileId, externalRef: { startsWith: 'referral-claim:' } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { externalRef: true },
  })

  return rows.map((row) => row.externalRef ?? '(none)')
}

/** Every redemption naming a household, with the code it was taken against. */
interface HouseholdRedemption {
  readonly code: string
  readonly status: string
}

async function redemptionsOf(
  userId: string
): Promise<readonly HouseholdRedemption[]> {
  const rows = await prisma.referralRedemption.findMany({
    where: { referredUserId: userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { status: true, referralCode: { select: { code: true } } },
  })

  return rows.map((row) => ({
    code: row.referralCode.code,
    status: row.status,
  }))
}

/**
 * Everything the reward machinery would have to have moved for anybody to be
 * paid, read in one go.
 *
 * Gathered as a value so the assertion that nothing moved can be a single
 * synchronous `deepEqual` inside `check` — `check` does not await, so a `check`
 * whose body was `async` would print `ok` before its assertions ran.
 */
interface MoneySnapshot {
  readonly sprayedRedemptions: number
  readonly genuineRedemptions: number
  readonly sprayedCounter: number
  readonly genuineCounter: number
  readonly attackerBalanceCents: number
  readonly patronBalanceCents: number
  readonly attackerLedgerEntries: number
  readonly patronLedgerEntries: number
}

const NO_MONEY_MOVED: MoneySnapshot = {
  sprayedRedemptions: 0,
  genuineRedemptions: 0,
  sprayedCounter: 0,
  genuineCounter: 0,
  attackerBalanceCents: 0,
  patronBalanceCents: 0,
  attackerLedgerEntries: 0,
  patronLedgerEntries: 0,
}

async function moneySnapshot(stageIds: Stage): Promise<MoneySnapshot> {
  const [
    sprayedRows,
    genuineRows,
    sprayedCounter,
    genuineCounter,
    attackerBalanceCents,
    patronBalanceCents,
    attackerLedger,
    patronLedger,
  ] = await Promise.all([
    redemptionsForCode(stageIds.sprayedCodeId),
    redemptionsForCode(stageIds.genuineCodeId),
    redemptionCountOf(stageIds.sprayedCodeId),
    redemptionCountOf(stageIds.genuineCodeId),
    balanceCentsOf(ATTACKER.id),
    balanceCentsOf(PATRON.id),
    ledgerOf(ATTACKER.id),
    ledgerOf(PATRON.id),
  ])

  return {
    sprayedRedemptions: sprayedRows.length,
    genuineRedemptions: genuineRows.length,
    sprayedCounter,
    genuineCounter,
    attackerBalanceCents,
    patronBalanceCents,
    attackerLedgerEntries: attackerLedger.length,
    patronLedgerEntries: patronLedger.length,
  }
}

/** The `acceptable` arm's attribution, or `null` for every other standing. */
function attributionOf(
  standing: ReferralClaimStanding | undefined
): { readonly inviterDisplayName: string | null } | null {
  return standing !== undefined && standing.kind === 'acceptable'
    ? standing.attribution
    : null
}

// =============================================================================
// 5. The prefix scenarios 1, 2, 3 and 6 all share
// =============================================================================

/** What {@link sprayedAtAProvedHousehold} leaves for a scenario to act on. */
interface SprayedWorld extends Stage {
  readonly household: HarnessUser
  readonly clientProfileId: string
  readonly banner: PendingReferralClaimView | null
}

/**
 * The attack, in full, up to the moment of the household's decision.
 *
 * One anonymous POST naming an address the caller does not control; the genuine
 * owner of that mailbox then signs in through their own magic link, pays us a
 * real invoice, and opens their portal. **Every step an attacker could influence
 * has happened by the time this returns, and so has every step the victim would
 * have taken anyway.**
 *
 * Scenarios 1, 2, 3 and 6 differ from one another only in what they call next.
 * That is why this is extracted: the mechanism is not merely equivalent between
 * them, it is the same function, called with no arguments.
 */
async function sprayedAtAProvedHousehold(): Promise<SprayedWorld> {
  const stageIds = await stage()

  await sprayAnonymously(HOUSEHOLD_EMAIL, SPRAYED_CODE)

  const userId = (await userIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const clientProfileId = (await profileIdForEmail(HOUSEHOLD_EMAIL)) ?? ''

  assert.notEqual(userId, '', 'the public form did not open an account')
  assert.notEqual(clientProfileId, '', 'the public form did not open a file')

  const claim = await referralClaimOf(clientProfileId)
  const placeholder = await unclaimedSinceOf(userId)
  const afterSpray = await moneySnapshot(stageIds)

  check('the spray writes one string on a placeholder file', () => {
    assert.equal(claim?.code, SPRAYED_CODE)
    assert.notEqual(placeholder, null)
  })

  check('and no row that carries money exists anywhere', () => {
    assert.deepEqual(afterSpray, NO_MONEY_MOVED)
  })

  // An unauthenticated caller cannot reach the consent door at all, which is
  // the property the whole design rests on. Asserted here rather than in one
  // scenario, so it holds in front of every decision below.
  const anonymous = await acceptAnonymously(SPRAYED_CODE)

  check('and the consent door is closed to the caller who typed the address', () => {
    assert.equal(anonymous.ok, false)
    assert.equal(anonymous.ok ? '' : anonymous.code, 'UNAUTHENTICATED')
  })

  // The genuine owner of that mailbox now does what victims do: signs in
  // through their own magic link, and pays us.
  await magicLinkSignIn(userId)
  await payInvoice(userId, HOUSEHOLD_INVOICE_CENTS)

  const proved = await unclaimedSinceOf(userId)

  check('the sign-in that proved the mailbox clears the placeholder marker', () => {
    assert.equal(proved, null)
  })

  const household = await sessionFor(HOUSEHOLD_EMAIL)
  const banner = await readBanner(household)

  return { ...stageIds, household, clientProfileId, banner }
}

// =============================================================================
// 6. Scenario 1 — sprayed, and nobody ever answered
// =============================================================================

/**
 * The victim signs in, pays, and simply never touches the banner.
 *
 * This is the scenario the previous harness could not express, because its
 * attack case never signed the victim in. Here the victim does everything:
 * proves the mailbox, becomes a paying customer whose invoice clears the floor,
 * and lets the prompt sit there. The sprayer is paid nothing, and the claim is
 * still merely **pending** — not consumed, not refused, not converted. Silence
 * is not consent.
 */
async function scenarioNoConsent(): Promise<SweepRecord> {
  section('1. sprayed at an address the caller does not control — never answered')

  const world = await sprayedAtAProvedHousehold()

  check('the banner offers the sprayed code, marked unverified', () => {
    assert.notEqual(world.banner, null)
    assert.equal(world.banner?.code, SPRAYED_CODE)
    assert.equal(world.banner?.provenance, 'public-enquiry-form')
    assert.equal(world.banner?.assurance, 'unverified')
  })

  check('and the $50.00 is genuinely there to be taken — it is acceptable now', () => {
    // Not "the claim was already dead". It is live, it names the sprayer's
    // code, and the household's invoice already clears the floor. The only
    // thing between the sprayer and the money is a click nobody makes.
    assert.equal(world.banner?.standing.kind, 'acceptable')
  })

  const swept = await sweep()

  const money_ = await moneySnapshot(world)
  const redemptions = await redemptionsOf(world.household.id)
  const claim = await referralClaimOf(world.clientProfileId)
  const answers = await claimAnswersOf(world.clientProfileId)

  check('the sweep examines nothing and credits nothing', () => {
    assert.deepEqual(swept, NOTHING_SWEPT)
  })

  check('no redemption names the household, on either code', () => {
    assert.deepEqual(redemptions, [])
  })

  check('no counter moved, no ledger entry exists, no balance exists', () => {
    assert.deepEqual(money_, NO_MONEY_MOVED)
  })

  check('the claim is still merely pending — unconsumed and unanswered', () => {
    assert.equal(claim?.code, SPRAYED_CODE)
    assert.deepEqual(answers, [])
  })

  note(
    `outcome: ${money(0)} to the sprayer, against a household that signed in and paid us ${money(HOUSEHOLD_INVOICE_CENTS)}.`
  )

  return swept
}

// =============================================================================
// 7. Scenario 2 — sprayed, and declined
// =============================================================================

/**
 * The same spray, the same address, the same code, the same sign-in, the same
 * invoice. The household presses *decline*.
 *
 * Two things must hold, and the second is what makes a decline worth having:
 * nothing is credited, and the answer **outlives the claim it cleared**. A
 * decline that only nulled the column would leave the household one stray write
 * away from being asked the same question again, for ever, by the same sprayer.
 *
 * So the resurrection is attempted three times, by three routes of increasing
 * strength:
 *
 *  1. a second anonymous submission naming the same code — refused at the
 *     writer, because the account is no longer an unproved placeholder;
 *  2. the column forced back on with a direct `UPDATE`, behind the actions'
 *     backs, which is stronger than any route that exists in the shipped code —
 *     discarded on sight by the read, because the tombstone outranks the column;
 *  3. accepting it anyway — an idempotent no-op rather than a payment.
 */
async function scenarioDeclined(): Promise<SweepRecord> {
  section('2. the same spray, declined by the household')

  const world = await sprayedAtAProvedHousehold()

  const declined = await declineAs(world.household, SPRAYED_CODE)

  const claim = await referralClaimOf(world.clientProfileId)
  const answers = await claimAnswersOf(world.clientProfileId)

  check('the decline is accepted and names the code that was shown', () => {
    assert.equal(declined.ok, true)
    assert.equal(declined.ok ? declined.data.kind : '', 'declined')
  })

  check('the claim columns are cleared', () => {
    assert.equal(claim, null)
  })

  check('and a tombstone records that this household said no to this code', () => {
    assert.deepEqual(answers, [`referral-claim:declined:${SPRAYED_CODE}`])
  })

  // --- resurrection 1: spray it again --------------------------------------
  await sprayAnonymously(HOUSEHOLD_EMAIL, SPRAYED_CODE)

  const afterRespray = await referralClaimOf(world.clientProfileId)

  check('a second public submission cannot write to a proved account', () => {
    assert.equal(afterRespray, null)
  })

  // --- resurrection 2: forge the column directly ---------------------------
  // No route in the shipped code can do this. It is done anyway, because what
  // must answer is the tombstone, not the absence of a writer.
  await prisma.clientProfile.update({
    where: { id: world.clientProfileId },
    data: {
      claimedReferralCode: SPRAYED_CODE,
      claimedReferralCodeAt: new Date(),
    },
    select: { id: true },
  })

  const forgedBanner = await readBanner(world.household)
  const afterRead = await referralClaimOf(world.clientProfileId)

  check('a forged claim for an answered code is not offered a second time', () => {
    assert.equal(forgedBanner, null)
  })

  check('and the read clears it, so the disagreement does not survive', () => {
    assert.equal(afterRead, null)
  })

  // --- resurrection 3: accept it anyway ------------------------------------
  const forced = await acceptAs(world.household, SPRAYED_CODE)

  check('accepting an answered code is an idempotent no-op, not a payment', () => {
    assert.equal(forced.ok, true)
    assert.equal(forced.ok ? forced.data.kind : '', 'already-answered')
  })

  const swept = await sweep()

  const money_ = await moneySnapshot(world)
  const redemptions = await redemptionsOf(world.household.id)

  check('the sweep still examines nothing', () => {
    assert.deepEqual(swept, NOTHING_SWEPT)
  })

  check('no redemption, no counter, no ledger entry, no balance', () => {
    assert.deepEqual(redemptions, [])
    assert.deepEqual(money_, NO_MONEY_MOVED)
  })

  note('"no" said once is said for good, and the tombstone is what says it.')

  return swept
}

// =============================================================================
// 8. Scenario 3 — sprayed, and accepted
// =============================================================================

/**
 * The same spray, the same address, the same code — and the household clicks
 * *accept*.
 *
 * **This pays, and it is meant to.** Said plainly, because a reader arriving at
 * a green assertion reading "$50.00 credited to the sprayer" is owed the
 * reasoning rather than a bug report:
 *
 * Consent is the control. The whole of MCV-052 is that the party holding the
 * mailbox decides, and a control that only permits decisions somebody else has
 * pre-approved is not consent — it is the automatic settlement wearing a button.
 * A human may consent to something unwise. The platform's obligation is that the
 * choice is theirs, informed, and free:
 *
 *  - the banner states the provenance (`public-enquiry-form`), the assurance
 *    (`unverified`) and the disclosure sentence, all asserted below;
 *  - declining is one click and is permanent (scenario 2);
 *  - doing nothing costs nothing (scenario 1).
 *
 * What the platform must never do is let the *attacker* choose, and it cannot:
 * this redemption exists because a session holding this mailbox asked for it.
 * Compare scenario 1 — the identical attack, on the identical address, with the
 * identical code — which pays zero.
 */
async function scenarioAccepted(): Promise<SweepRecord> {
  section('3. the same spray, accepted by the household — this one pays')

  const world = await sprayedAtAProvedHousehold()

  check('the household is told, before deciding, that we do not vouch for it', () => {
    assert.equal(world.banner?.assurance, 'unverified')
    assert.match(world.banner?.disclosure ?? '', /have not verified who typed it/)
    assert.equal(world.banner?.standing.kind, 'acceptable')
  })

  const accepted = await acceptAs(world.household, SPRAYED_CODE)

  const redemptions = await redemptionsOf(world.household.id)
  const claim = await referralClaimOf(world.clientProfileId)
  const answers = await claimAnswersOf(world.clientProfileId)

  check('the acceptance writes one redemption, against the sprayed code', () => {
    assert.equal(accepted.ok, true)
    assert.equal(accepted.ok ? accepted.data.kind : '', 'accepted')
    assert.deepEqual(redemptions, [{ code: SPRAYED_CODE, status: 'PENDING' }])
  })

  check('the claim is consumed and the acceptance is tombstoned', () => {
    assert.equal(claim, null)
    assert.deepEqual(answers, [`referral-claim:accepted:${SPRAYED_CODE}`])
  })

  const swept = await sweep()

  const counter = await redemptionCountOf(world.sprayedCodeId)
  const ledger = await ledgerOf(ATTACKER.id)
  const balance = await balanceCentsOf(ATTACKER.id)
  const patronBalance = await balanceCentsOf(PATRON.id)

  check('and the sweep pays, on the household’s own invoice', () => {
    assert.deepEqual(swept, ONE_REWARD_SWEPT)
    assert.equal(counter, 1)
    assert.equal(balance, REWARD_CENTS)
    assert.deepEqual(ledger, ONE_REFERRAL_CREDIT)
  })

  check('the member who invited nobody is untouched', () => {
    assert.equal(patronBalance, 0)
  })

  note(
    `outcome: ${money(balance)} credited — because the mailbox holder said so, and for no other reason.`
  )

  return swept
}

// =============================================================================
// 9. Scenario 4 — precedence, run in both orderings
// =============================================================================

/**
 * One anonymous submission at {@link HOUSEHOLD_EMAIL}: a code, whose code it is,
 * and the call that sends it.
 *
 * Two names for one function, carried as data on purpose. Whichever of `send`
 * this scenario invokes, the server receives the identical request from the
 * identical position — see {@link enquireAnonymously}. Nothing downstream can
 * branch on which field of this record produced the POST, and that is the fact
 * the whole scenario turns on.
 */
interface Submission {
  readonly code: string
  readonly inviter: HarnessUser
  readonly send: (email: string, code: string) => Promise<void>
}

const SPRAY: Submission = {
  code: SPRAYED_CODE,
  inviter: ATTACKER,
  send: sprayAnonymously,
}

const GENUINE: Submission = {
  code: GENUINE_CODE,
  inviter: PATRON,
  send: enquireAnonymously,
}

/** Which of the two anonymous submissions arrived first. */
type SubmissionOrder = 'spray-first' | 'genuine-first'

/** How the household reached the invitation they actually hold. */
type RouteToTheTruth =
  /** The standing claim *was* theirs. One click on the banner. */
  | 'accept the standing claim'
  /** It was not. They asserted their own through `redeemReferralCode`. */
  | 'redeem the code they hold, then decline the standing claim'

/** What one ordering left behind, read from rows rather than return values. */
interface PrecedenceObservation {
  readonly order: SubmissionOrder
  readonly firstSubmitted: string
  readonly lastSubmitted: string
  /** `ClientProfile.claimedReferralCode` once both submissions have landed. */
  readonly standingCode: string | null
  /** What the consent banner offered the signed-in household. */
  readonly bannerCode: string | null
  /** Who the banner named as the inviter. */
  readonly bannerInviter: string | null
  /** Every money-bearing row, read before the household did anything. */
  readonly moneyBeforeConsent: MoneySnapshot
  readonly route: RouteToTheTruth
  /** How many authenticated acts the household had to perform. */
  readonly authenticatedActs: number
  readonly swept: SweepRecord
  readonly redemptions: readonly HouseholdRedemption[]
  readonly patronBalanceCents: number
  readonly attackerBalanceCents: number
}

/**
 * Round three's finding 1, and the residual round five found sitting beside it,
 * measured in **both** orderings.
 *
 * ## Why this scenario is parameterised, and what the previous version proved
 *
 * The version this replaces ran one ordering: the sprayer POSTs `HARVEST24`,
 * then the household POSTs `GENUINE24`, and it concluded "the household is shown
 * the code THEY were given". That conclusion was produced by the author's choice
 * of which submission to send second. `recordReferralClaim` is last-writer-wins
 * and says so; run the same two calls the other way round and the household —
 * a household that genuinely *was* referred, who will answer *yes* to "were you
 * referred?" — is shown `HARVEST24` with the **attacker** named as their
 * inviter. That ordering is at least as available to a sprayer as the other one,
 * because a sprayer choosing when to fire is the one degree of freedom a sprayer
 * definitely has. A harness that runs only the flattering ordering is the same
 * self-deception this file was rewritten to remove — it is the `firstSignIn`
 * mistake wearing different clothes.
 *
 * So both orderings run, from one body, and the report prints them side by side.
 *
 * ## The property the two orderings differ by
 *
 * Exactly one, and it is a property of the row rather than of the test data:
 *
 * > While `User.unclaimedSince` is stamped, `ClientProfile.claimedReferralCode`
 * > holds whichever public submission arrived **last**.
 *
 * That is asserted directly, in terms of `first` and `last` rather than in terms
 * of `GENUINE_CODE` and `SPRAYED_CODE`, so the assertion cannot be satisfied by
 * an ordering-dependent accident. The banner's contents follow from it, in both
 * directions, including the direction that is bad news.
 *
 * ## The properties that do *not* differ by ordering
 *
 * These are the guarantees the system actually makes, and they are asserted
 * identically in both arms:
 *
 *  1. **No money moves before the household acts.** `moneyBeforeConsent` is
 *     `NO_MONEY_MOVED` in both orderings, however the two POSTs were arranged.
 *  2. **The genuine inviter is paid and the sprayer is not** — `PATRON` ends on
 *     `REWARD_CENTS`, `ATTACKER` on zero, one redemption against `GENUINE_CODE`,
 *     `SPRAYED_CODE`'s counter at zero. In both orderings. What differs is only
 *     the *route*: one click when the standing claim happens to be theirs, and
 *     `redeemReferralCode` — the authenticated, separately audited, rate-limited
 *     door that `ReferralClaimBanner`'s "I was given a different code" affordance
 *     opens — when it is not.
 *  3. **The sprayed code never locks the genuine inviter out.** Under the
 *     automatic settlement this replaces, `HARVEST24` became a live redemption at
 *     the victim's sign-in and `ALREADY_REFERRED` then refused every genuine
 *     invitation for ever, by any route. Here the one live redemption per
 *     household is held by the invitation the household chose, in both orderings,
 *     and the refusal of the *other* code is the rule working rather than the
 *     harm.
 *
 * ## What is therefore admitted rather than papered over
 *
 * In `genuine-first`, a household that really was referred is shown a stranger's
 * code with a stranger's name on it. That is a phishing surface and it is real.
 * The system's answer is not that it cannot happen — it demonstrably can, and
 * this scenario is what makes it a measured fact rather than a paragraph — but
 * that it costs the sprayer nothing and gains them nothing, and that the
 * household has a one-action route to the invitation they actually hold. Both
 * halves of that are asserted below.
 */
async function runPrecedence(
  order: SubmissionOrder
): Promise<PrecedenceObservation> {
  section(`4${order === 'spray-first' ? 'a' : 'b'}. precedence — ${order}`)

  const stageIds = await stage()

  // The only line in this function that reads the parameter. Everything after
  // it is written in terms of `first` and `last`, never of which party sent
  // them, because the server has no access to that distinction either.
  const submissions: readonly [Submission, Submission] =
    order === 'spray-first' ? [SPRAY, GENUINE] : [GENUINE, SPRAY]
  const [first, last] = submissions

  await first.send(HOUSEHOLD_EMAIL, first.code)

  const userId = (await userIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const clientProfileId = (await profileIdForEmail(HOUSEHOLD_EMAIL)) ?? ''

  assert.notEqual(userId, '', 'the public form did not open an account')
  assert.notEqual(clientProfileId, '', 'the public form did not open a file')

  const afterFirst = await referralClaimOf(clientProfileId)
  const placeholderBefore = await unclaimedSinceOf(userId)

  check('the first submission stands, whichever party sent it', () => {
    assert.equal(afterFirst?.code, first.code)
  })

  await last.send(HOUSEHOLD_EMAIL, last.code)

  const standing = await referralClaimOf(clientProfileId)
  const placeholderAfter = await unclaimedSinceOf(userId)

  // The property, stated as a property. Not "the genuine code wins" — that is
  // an artefact of which submission a test author sends second.
  check('the LAST public submission is what stands, while the row is unproved', () => {
    assert.notEqual(placeholderBefore, null)
    assert.notEqual(placeholderAfter, null)
    assert.equal(standing?.code, last.code)
    assert.notEqual(standing?.code, first.code)
  })

  await magicLinkSignIn(userId)

  const household = await sessionFor(HOUSEHOLD_EMAIL)
  const banner = await readBanner(household)
  const attribution = attributionOf(banner?.standing)

  check('the banner offers exactly that submission, and names its owner', () => {
    assert.equal(banner?.code, last.code)
    assert.notEqual(attribution, null)
    assert.equal(attribution?.inviterDisplayName, last.inviter.name)
  })

  // Whoever the named party turns out to be, the card says where the string
  // came from and that nobody has vouched for it. In `genuine-first` this is
  // the only thing standing between a referred household and a stranger's
  // code, which is why it is asserted in both arms rather than in one.
  check('and states its provenance as what it is: unverified public input', () => {
    assert.equal(banner?.provenance, 'public-enquiry-form')
    assert.equal(banner?.assurance, 'unverified')
  })

  // A prompt rendered against the *other* code must consume nothing. This is
  // the stale-render guard, and it holds in both directions.
  const stale = await acceptAs(household, first.code)
  const afterStale = await referralClaimOf(clientProfileId)

  check('accepting the superseded submission takes nothing with it', () => {
    assert.equal(stale.ok, true)
    assert.equal(stale.ok ? stale.data.kind : '', 'superseded')
    assert.equal(
      stale.ok && stale.data.kind === 'superseded' ? stale.data.standing : '',
      last.code
    )
    assert.equal(afterStale?.code, last.code)
  })

  const moneyBeforeConsent = await moneySnapshot(stageIds)

  check('no row carrying money exists in either ordering, before consent', () => {
    assert.deepEqual(moneyBeforeConsent, NO_MONEY_MOVED)
  })

  // ---- the household reaches the invitation it actually holds --------------
  // The household knows one thing the server does not and cannot: their friend
  // gave them `GENUINE_CODE`. Which route that takes is decided by the standing
  // claim, not by this function's parameter.
  const standingIsTheirs = last.code === GENUINE_CODE
  const route: RouteToTheTruth = standingIsTheirs
    ? 'accept the standing claim'
    : 'redeem the code they hold, then decline the standing claim'

  if (standingIsTheirs) {
    const accepted = await acceptAs(household, GENUINE_CODE)

    check('the genuine case is one authenticated act, on the banner', () => {
      assert.equal(accepted.ok, true)
      assert.equal(accepted.ok ? accepted.data.kind : '', 'accepted')
    })
  } else {
    // `ReferralClaimBanner`'s "I was given a different code" affordance, driven
    // through the two shipped actions it calls, in the order it calls them.
    // Redeem first: a decline is a tombstone, so declining before the assertion
    // succeeded would cost the household the standing claim with nothing to
    // show for it if their own code turned out to be refused.
    const redeemed = await redeemAs(household, GENUINE_CODE)
    const declined = await declineAs(household, SPRAYED_CODE)
    const afterDecline = await referralClaimOf(clientProfileId)

    check('a household shown a stranger’s code can assert their own', () => {
      assert.equal(redeemed.ok, true)
      assert.equal(redeemed.ok ? redeemed.data.code : '', GENUINE_CODE)
      assert.equal(redeemed.ok ? redeemed.data.status : '', 'PENDING')
    })

    check('and the stranger’s claim is then cleared, not left on the card', () => {
      assert.equal(declined.ok, true)
      assert.equal(declined.ok ? declined.data.kind : '', 'declined')
      assert.equal(afterDecline, null)
    })
  }

  await payInvoice(userId, HOUSEHOLD_INVOICE_CENTS)

  const swept = await sweep()

  const redemptions = await redemptionsOf(userId)
  const sprayedCounter = await redemptionCountOf(stageIds.sprayedCodeId)
  const genuineCounter = await redemptionCountOf(stageIds.genuineCodeId)
  const patronBalanceCents = await balanceCentsOf(PATRON.id)
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  // The invariant. Identical text, identical values, in both orderings.
  check('the member who actually invited them is paid, and the sprayer is not', () => {
    assert.deepEqual(redemptions, [{ code: GENUINE_CODE, status: 'REWARDED' }])
    assert.equal(genuineCounter, 1)
    assert.equal(sprayedCounter, 0)
    assert.deepEqual(swept, ONE_REWARD_SWEPT)
    assert.equal(patronBalanceCents, REWARD_CENTS)
    assert.equal(attackerBalanceCents, 0)
  })

  // ---- the lockout, asserted from the other end ---------------------------
  // A household holding a live redemption is refused a second one. Under the
  // automatic settlement the *sprayed* code occupied that slot before the
  // household had done anything at all, so the real inviter could never be
  // paid. Here the slot is held by the invitation the household chose — in
  // both orderings — so the refusal below is the rule working, not the harm.
  const second = await redeemAs(household, SPRAYED_CODE)
  const unchanged = await redemptionsOf(userId)

  check('one live redemption per household still binds — on the right one', () => {
    assert.equal(second.ok, false)
    assert.equal(second.ok ? '' : second.code, 'VALIDATION')
    assert.deepEqual(unchanged, [{ code: GENUINE_CODE, status: 'REWARDED' }])
  })

  return {
    order,
    firstSubmitted: first.code,
    lastSubmitted: last.code,
    standingCode: standing?.code ?? null,
    bannerCode: banner?.code ?? null,
    bannerInviter: attribution?.inviterDisplayName ?? null,
    moneyBeforeConsent,
    route,
    authenticatedActs: standingIsTheirs ? 1 : 2,
    swept,
    redemptions,
    patronBalanceCents,
    attackerBalanceCents,
  }
}

/**
 * Both orderings, plus the bound that makes the refresh tolerable at all.
 *
 * The refresh `runPrecedence` measures — a second public POST overwriting the
 * first — is admitted only while the row is an **unproved placeholder**. The
 * tail of this function asserts the other side of that: a member who has ever
 * proved their mailbox cannot have their attribution rewritten by anybody's
 * public submission, so the whole of the above is confined to accounts the
 * public path itself opened.
 */
async function scenarioPrecedence(): Promise<{
  readonly sprayFirst: PrecedenceObservation
  readonly genuineFirst: PrecedenceObservation
}> {
  const sprayFirst = await runPrecedence('spray-first')
  const genuineFirst = await runPrecedence('genuine-first')

  section('4c. precedence — the bound on the refresh itself')

  const patronBefore: AccountSnapshot = await accountSnapshot(PATRON.id)

  await sprayAnonymously(PATRON.email ?? '', SPRAYED_CODE)

  const patronClaim = await referralClaimOf(PATRON.clientProfileId ?? '')
  const patronAfter: AccountSnapshot = await accountSnapshot(PATRON.id)

  check('a proved household is untouchable from the public form', () => {
    assert.equal(patronClaim, null)
    assert.deepEqual(patronAfter, patronBefore)
  })

  note('ordering decides which code is *shown*; consent decides who is paid.')

  return { sprayFirst, genuineFirst }
}

// =============================================================================
// 10. Scenario 5 — a genuine invitation, end to end
// =============================================================================

/**
 * A fix that closed the hole by never attaching a referral at all would pass
 * every scenario above and would have quietly deleted the feature.
 *
 * So this asks for the opposite result and insists on it: a prospect a member
 * really invited types the code into the public *questionnaire* — the second
 * public door, so both are covered — signs in, is shown the invitation with the
 * inviter's name on it, accepts, subscribes, pays, and the member is paid.
 * Exactly once.
 *
 * The second sweep is the assertion that matters most. A sweep that paid again
 * on the next pass would be a slower version of the same theft, and what stops
 * it is a status transition on the row rather than a memory of having run.
 *
 * ## What separates this from scenario 3, and what deliberately does not
 *
 * Same address, same programme, same seeded world. Three server-side properties
 * differ, and they are the three this scenario asserts: the public door used
 * (`submitProspectIntake` rather than `requestConsultation`), the **owner of the
 * code** — read back through `inviterDisplayName`, so the assertion is on a row
 * and not on a variable name — and the second sweep.
 *
 * What does **not** separate them is that this prospect was "genuinely invited"
 * and scenario 3's was not. That distinction is invisible to the server and is
 * asserted nowhere in this file, because it does not exist: both are one
 * anonymous POST carrying an address and a code. Pretending otherwise is
 * precisely the fiction the previous harness was built on. It is why consent is
 * the control, and it is why scenario 3 pays.
 */
async function scenarioLegitimate(): Promise<SweepRecord> {
  section(
    '5. a genuine invitation — questionnaire, sign-in, consent, invoice, sweep'
  )

  const stageIds = await stage()

  signInAs(null)
  clearRateLimits()
  const posted = await submitProspectIntake(
    prospectPayload({ email: HOUSEHOLD_EMAIL, referralCode: GENUINE_CODE })
  )

  const userId = (await userIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const clientProfileId = (await profileIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const claimed = await referralClaimOf(clientProfileId)
  const beforeConsent = await moneySnapshot(stageIds)
  const noRedemptions = await redemptionsOf(userId)

  check('the questionnaire is accepted and records the attribution', () => {
    assert.equal(posted.ok, true)
    assert.equal(claimed?.code, GENUINE_CODE)
  })

  check('nothing that carries money exists before the household consents', () => {
    assert.deepEqual(noRedemptions, [])
    assert.deepEqual(beforeConsent, NO_MONEY_MOVED)
  })

  await magicLinkSignIn(userId)

  const household = await sessionFor(HOUSEHOLD_EMAIL)
  const banner = await readBanner(household)
  const attribution = attributionOf(banner?.standing)

  check('the prospect is shown the invitation, with the inviter’s name', () => {
    assert.equal(banner?.code, GENUINE_CODE)
    assert.notEqual(attribution, null)
    assert.equal(attribution?.inviterDisplayName, PATRON.name)
  })

  const accepted = await acceptAs(household, GENUINE_CODE)
  const pending = await redemptionsOf(userId)

  check('the acceptance writes one PENDING redemption', () => {
    assert.equal(accepted.ok, true)
    assert.equal(accepted.ok ? accepted.data.kind : '', 'accepted')
    assert.deepEqual(pending, [{ code: GENUINE_CODE, status: 'PENDING' }])
  })

  await payInvoice(userId, 18_000)

  const first = await sweep()
  const balanceAfterFirst = await balanceCentsOf(PATRON.id)
  const ledgerAfterFirst = await ledgerOf(PATRON.id)

  check('the first sweep pays the inviter exactly the programme figure', () => {
    assert.deepEqual(first, ONE_REWARD_SWEPT)
    assert.equal(balanceAfterFirst, REWARD_CENTS)
    assert.deepEqual(ledgerAfterFirst, ONE_REFERRAL_CREDIT)
  })

  const second = await sweep()

  const balanceAfterSecond = await balanceCentsOf(PATRON.id)
  const ledgerAfterSecond = await ledgerOf(PATRON.id)
  const counter = await redemptionCountOf(stageIds.genuineCodeId)
  const settled = await redemptionsOf(userId)

  check('a second sweep over the same rows credits nothing', () => {
    assert.deepEqual(second, NOTHING_SWEPT)
  })

  check('and the ledger is unchanged — one entry, one payment, one seat', () => {
    assert.equal(balanceAfterSecond, REWARD_CENTS)
    assert.deepEqual(ledgerAfterSecond, ONE_REFERRAL_CREDIT)
    assert.equal(counter, 1)
    assert.deepEqual(settled, [{ code: GENUINE_CODE, status: 'REWARDED' }])
  })

  note('the programme still pays, through the one door that requires consent.')

  return first
}

// =============================================================================
// 11. Scenario 6 — idempotence under concurrency
// =============================================================================

/**
 * Four acceptances of one claim, at the same instant, from four tabs of one
 * household's session.
 *
 * `asUser` rather than `signInAs`, because a process-wide caller slot could only
 * ever name one of them, and the point is that all four are the same
 * authenticated household arriving together.
 *
 * The claim is consumed by a compare-and-swap before anything is decided, so one
 * transaction takes it and the rest find nothing; and `createReferralRedemption`
 * writes its row *before* it swaps the code's counter, so a loser that merely
 * reported the loss would commit an orphan redemption and the cap would stop
 * binding. `settleAcceptedClaim` throws its own rollback signal instead, which
 * is what keeps the counter and the rows agreeing under load.
 */
async function scenarioIdempotence(): Promise<void> {
  section('6. four simultaneous acceptances of one claim')

  const world = await sprayedAtAProvedHousehold()

  clearRateLimits()

  const attempts = await Promise.all(
    [0, 1, 2, 3].map(async () =>
      asUser(world.household, async () =>
        acceptReferralClaim({ code: SPRAYED_CODE })
      )
    )
  )

  signInAs(null)

  const kinds = attempts.map((attempt) =>
    attempt.ok ? attempt.data.kind : `error:${attempt.code}`
  )
  const acceptedCount = kinds.filter((kind) => kind === 'accepted').length

  const redemptions = await redemptionsOf(world.household.id)
  const counter = await redemptionCountOf(world.sprayedCodeId)
  const claim = await referralClaimOf(world.clientProfileId)

  check('all four calls answer, and exactly one of them settles', () => {
    assert.equal(attempts.length, 4)
    assert.equal(acceptedCount, 1, `outcomes were ${kinds.join(', ')}`)
  })

  check('exactly one redemption exists, and the counter agrees with it', () => {
    assert.deepEqual(redemptions, [{ code: SPRAYED_CODE, status: 'PENDING' }])
    assert.equal(counter, 1)
  })

  check('the claim token is consumed exactly once', () => {
    assert.equal(claim, null)
  })

  await payInvoice(world.household.id, HOUSEHOLD_INVOICE_CENTS)

  const swept = await sweep()
  const balance = await balanceCentsOf(ATTACKER.id)
  const ledger = await ledgerOf(ATTACKER.id)

  check('and one reward is paid, not four', () => {
    assert.deepEqual(swept, ONE_REWARD_SWEPT)
    assert.equal(balance, REWARD_CENTS)
    assert.deepEqual(ledger, ONE_REFERRAL_CREDIT)
  })

  note(`outcomes: ${kinds.join(', ')}`)
}

// =============================================================================
// 12. Scenario 7 — the claim window, at both edges
// =============================================================================

/**
 * The window the design promises, in days.
 *
 * ## Why this is a literal here and not an import
 *
 * `CLAIM_WINDOW_DAYS` is imported above, and it is used for exactly one thing:
 * the tripwire in {@link scenarioClaimWindow} that pins it to this number. It is
 * deliberately **not** used to compute the two ages below, and that is the whole
 * reason this scenario exists at all.
 *
 * A harness that aged its claims to `CLAIM_WINDOW_DAYS ± 1` would move with the
 * constant. Widen the window to 30_000 and such a harness would faithfully
 * backdate one claim 29_999 days and another 30_001, observe the second lapse,
 * and print a pass — while a two-year-old sprayed claim, the actual thing the
 * bound exists to stop, settled for $50.00. The expectation has to be written
 * down independently of the value under test or it is not an expectation, it is
 * a restatement.
 *
 * Thirty is therefore the *promise*, transcribed from the `CLAIM_WINDOW_DAYS`
 * docblock: "the ordinary gap between 'I asked for a consultation' and 'I signed
 * in' is days, not seasons". Changing the shipped constant is allowed; changing
 * it without coming here and changing this one too is not, because that is the
 * change nobody would otherwise notice.
 */
const PROMISED_WINDOW_DAYS = 30

/** One day inside the promise. Must still be acceptable, and must still pay. */
const INSIDE_EDGE_DAYS = PROMISED_WINDOW_DAYS - 1

/** One day outside it. Must be refused, consumed, and credit nothing. */
const OUTSIDE_EDGE_DAYS = PROMISED_WINDOW_DAYS + 1

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MILLISECONDS_PER_DAY)
}

/** Whole days between two instants, as an operator would say them. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MILLISECONDS_PER_DAY)
}

/**
 * Everything one aged claim did, gathered before anything is asserted.
 *
 * A value rather than a sequence of awaited assertions for the reason the module
 * docblock gives: `check` does not await, so every row these scenarios turn on
 * is read first and compared afterwards, synchronously.
 */
interface AgedClaimObservation {
  readonly ageDays: number
  /** The banner's standing: `acceptable`, `lapsed`, `unacceptable` — or `none`. */
  readonly standing: string
  /**
   * `expiresAt − claimedAt` in whole days, as the household was *told* it.
   *
   * Asserted as well as the behaviour, because this is the number the consent
   * surface renders. A window the server enforces at thirty days and states as
   * eighty-two years would be a lie told to the one party the whole design puts
   * in charge of the decision.
   */
  readonly windowShownDays: number
  /** The acceptance's own verdict — `accepted`, `expired`, `refused`, … */
  readonly acceptance: string
  readonly redemptionsAtAcceptance: readonly HouseholdRedemption[]
  readonly redemptionsAfterSweep: readonly HouseholdRedemption[]
  readonly answers: readonly string[]
  /** `true` if the claim columns still hold something after the acceptance. */
  readonly claimStillStanding: boolean
  readonly sprayedCounter: number
  readonly swept: SweepRecord
  readonly attackerBalanceCents: number
  readonly attackerLedger: readonly LedgerRow[]
}

/**
 * Everything the sprayer got out of one aged claim, in one shape.
 *
 * Deliberately not {@link MoneySnapshot}: that one asserts *nothing moved
 * anywhere*, which is the right question for an attack scenario and the wrong
 * one here, because the household on the inside edge legitimately moves half of
 * it. This narrows to the sprayer's side of the ledger so that both edges can be
 * asserted with the same `deepEqual` against two different constants — which is
 * what lets the failure message name the amount rather than a field.
 */
interface SprayerTake {
  readonly redemptions: number
  readonly counter: number
  readonly sweptExamined: number
  readonly sweptRewarded: number
  readonly creditedCents: number
  readonly balanceCents: number
  readonly ledgerEntries: number
}

/** What a lapsed claim must be worth: nothing, in every column at once. */
const PAID_NOTHING: SprayerTake = {
  redemptions: 0,
  counter: 0,
  sweptExamined: 0,
  sweptRewarded: 0,
  creditedCents: 0,
  balanceCents: 0,
  ledgerEntries: 0,
}

/** What a live claim the household accepted must be worth: the reward, once. */
const PAID_ONE_REWARD: SprayerTake = {
  redemptions: 1,
  counter: 1,
  sweptExamined: 1,
  sweptRewarded: 1,
  creditedCents: REWARD_CENTS,
  balanceCents: REWARD_CENTS,
  ledgerEntries: 1,
}

function sprayerTake(observation: AgedClaimObservation): SprayerTake {
  return {
    redemptions: observation.redemptionsAtAcceptance.length,
    counter: observation.sprayedCounter,
    sweptExamined: observation.swept.examined,
    sweptRewarded: observation.swept.rewarded,
    creditedCents: observation.swept.creditedCents,
    balanceCents: observation.attackerBalanceCents,
    ledgerEntries: observation.attackerLedger.length,
  }
}

/**
 * The whole attack again, with the claim aged `ageDays` days before the
 * household is asked.
 *
 * The prefix is {@link sprayedAtAProvedHousehold}, unchanged and uncopied — the
 * same anonymous POST, the same address, the same code, the same magic-link
 * sign-in, the same paid invoice. Then one column is moved into the past and the
 * household accepts.
 *
 * ## Why the column is moved and not the clock
 *
 * `backdateReferralClaim`'s own docblock says it: `settleAcceptedClaim` takes
 * `now` as an argument, so a harness that passed itself a future date would be
 * testing its own arithmetic rather than the server's. This moves the *data*
 * into the past and lets the real default `now` — the one the shipped action
 * computes — decide. Nothing in this scenario passes a clock to anything.
 *
 * The backdate lands after the invoice is paid, which is the arrangement that
 * matters: the household's money arrives *after* the moment the invitation is
 * dated to, so `ALREADY_A_CUSTOMER` has nothing to catch and
 * `findQualifyingInvoice` has a qualifying invoice to find. The only reason the
 * outside edge can fail to pay is its age.
 */
async function observeAgedClaim(
  ageDays: number
): Promise<AgedClaimObservation> {
  const world = await sprayedAtAProvedHousehold()

  await backdateReferralClaim(world.clientProfileId, daysAgo(ageDays))

  const banner = await readBanner(world.household)
  const accepted = await acceptAs(world.household, SPRAYED_CODE)

  const redemptionsAtAcceptance = await redemptionsOf(world.household.id)
  const claim = await referralClaimOf(world.clientProfileId)
  const answers = await claimAnswersOf(world.clientProfileId)

  const swept = await sweep()

  const redemptionsAfterSweep = await redemptionsOf(world.household.id)
  const sprayedCounter = await redemptionCountOf(world.sprayedCodeId)
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)
  const attackerLedger = await ledgerOf(ATTACKER.id)

  return {
    ageDays,
    standing: banner === null ? 'none' : banner.standing.kind,
    windowShownDays:
      banner === null ? -1 : daysBetween(banner.claimedAt, banner.expiresAt),
    acceptance: accepted.ok ? accepted.data.kind : `error:${accepted.code}`,
    redemptionsAtAcceptance,
    redemptionsAfterSweep,
    answers,
    claimStillStanding: claim !== null,
    sprayedCounter,
    swept,
    attackerBalanceCents,
    attackerLedger,
  }
}

/**
 * `CLAIM_WINDOW_DAYS` is the only bound left on the residual this module's
 * subject names as its principal risk — so it is measured, at both edges, by
 * what it does to money.
 *
 * ## What was wrong before this scenario existed
 *
 * The bound shipped, and was documented as *the* mitigation for "claim a million
 * mailboxes, wait however long it takes for any of them to become a customer,
 * collect". No harness exercised it. `backdateReferralClaim` — the fixture
 * written for precisely this, with the docblock explaining precisely this — had
 * no caller anywhere in the repository.
 *
 * That is the shape `referral-claim.ts` condemns one layer in ("a named
 * mitigation with no production caller is not a mitigation"), reproduced one
 * layer out: a named mitigation with no *test* caller. Measured, it read exactly
 * as it reads when it is broken. Widening the constant from 30 to 30_000 — 82
 * years, `tsc`-clean, every symbol still used — let a two-year-old sprayed claim
 * settle and credit the sprayer $50.00, and the whole suite still printed four
 * of four green.
 *
 * ## Why both edges, and why they are one paragraph apart
 *
 * The two runs below share the prefix function, the address, the code, the
 * invoice and the acceptance. **The only difference between them is two days of
 * `claimedAt`.** A window that never expires and a window that expires
 * immediately are both catastrophes — the first is the standing bet, the second
 * quietly deletes the feature for every household that took a fortnight to
 * answer the concierge — so a single-edge assertion could be satisfied by either
 * failure. Asserting one edge accepts and the neighbouring edge refuses is what
 * pins the bound to a number rather than to a direction.
 *
 * ## What the outside edge must show, beyond "not paid"
 *
 * Three separate things, because "the sprayer was not paid" is true of a great
 * many broken servers:
 *
 *  - the acceptance answers `expired` and *consumes* the claim, so the prompt
 *    does not survive to be clicked again tomorrow;
 *  - a tombstone records the expiry, which is what makes the refusal outlive the
 *    columns it cleared (scenario 2's property, at a different door);
 *  - no redemption row, no counter movement, no ledger entry and no balance —
 *    the {@link SprayerTake} shape, asserted in one `deepEqual`.
 *
 * ## The order of the assertions below is load-bearing
 *
 * `check` throws on the first failure, so whatever is asserted first is what a
 * reader sees when this scenario goes red — and the point of the scenario is
 * that they should see **money**, not a constant.
 *
 * So both runs are taken first, then their two {@link SprayerTake} verdicts are
 * asserted side by side, then the narrative detail, and the equality against
 * `CLAIM_WINDOW_DAYS` runs dead last. Every mutation of the bound therefore
 * reports itself as an amount:
 *
 *  - widened to 30_000, this fails on `{creditedCents: 5000, balanceCents:
 *    5000, …} !== {…: 0, …}` — the two-year-old sprayed claim settling;
 *  - narrowed to 7, it fails on the neighbouring line, `{…: 0, …} !==
 *    {creditedCents: 5000, …}` — the feature deleted for anybody who took a
 *    fortnight to answer the concierge.
 *
 * Both are evidence. `30000 !== 30` is a spelling test, and a scenario that led
 * with it would have taught the next reader exactly the wrong lesson about what
 * this file is for.
 */
async function scenarioClaimWindow(): Promise<{
  readonly inside: AgedClaimObservation
  readonly outside: AgedClaimObservation
}> {
  section('7. the claim window — one day outside it, and one day inside')

  // Both runs happen before anything is asserted, so that the two money
  // verdicts can be adjacent. Each `observeAgedClaim` empties the tables it
  // starts from, which is safe here because an observation is a value read out
  // before the next run begins.
  const outside = await observeAgedClaim(OUTSIDE_EDGE_DAYS)
  const inside = await observeAgedClaim(INSIDE_EDGE_DAYS)

  // --- the two money verdicts, first and side by side ------------------------
  check(
    `the sprayer takes nothing from a claim ${String(OUTSIDE_EDGE_DAYS)} days old`,
    () => {
      assert.deepEqual(sprayerTake(outside), PAID_NOTHING)
    }
  )

  check(
    `and takes the whole reward from one ${String(INSIDE_EDGE_DAYS)} days old`,
    () => {
      assert.deepEqual(sprayerTake(inside), PAID_ONE_REWARD)
    }
  )

  // --- then how each of them got there --------------------------------------
  check('the lapsed claim is shown as lapsed, against the stated window', () => {
    assert.equal(outside.standing, 'lapsed')
    assert.equal(outside.windowShownDays, PROMISED_WINDOW_DAYS)
  })

  check('accepting it answers expired, and consumes the claim anyway', () => {
    assert.equal(outside.acceptance, 'expired')
    assert.equal(outside.claimStillStanding, false)
    assert.deepEqual(outside.answers, [
      `referral-claim:expired:${SPRAYED_CODE}`,
    ])
    assert.deepEqual(outside.redemptionsAfterSweep, [])
  })

  check('the live claim is offered, against the same stated window', () => {
    assert.equal(inside.standing, 'acceptable')
    assert.equal(inside.windowShownDays, PROMISED_WINDOW_DAYS)
  })

  check('the acceptance settles, and the sweep carries it to REWARDED', () => {
    assert.equal(inside.acceptance, 'accepted')
    assert.equal(inside.claimStillStanding, false)
    assert.deepEqual(inside.answers, [`referral-claim:accepted:${SPRAYED_CODE}`])
    assert.deepEqual(inside.redemptionsAtAcceptance, [
      { code: SPRAYED_CODE, status: 'PENDING' },
    ])
    assert.deepEqual(inside.redemptionsAfterSweep, [
      { code: SPRAYED_CODE, status: 'REWARDED' },
    ])
    assert.deepEqual(inside.attackerLedger, ONE_REFERRAL_CREDIT)
  })

  // --- and only now, the constant -------------------------------------------
  // Deliberately last. On its own this says the constant holds a number, not
  // that the number does anything — and a bound that nothing exercises is the
  // exact defect this scenario exists to close, so leading with it would
  // reproduce that defect in the harness. It survives only because it makes the
  // diagnosis one line long once the two runs above have already gone red.
  check('the shipped window is the thirty days the design promises', () => {
    assert.equal(CLAIM_WINDOW_DAYS, PROMISED_WINDOW_DAYS)
  })

  note(
    `${money(inside.attackerBalanceCents)} at ${String(INSIDE_EDGE_DAYS)} days, ` +
      `${money(outside.attackerBalanceCents)} at ${String(OUTSIDE_EDGE_DAYS)} days — ` +
      'two days of claimedAt, and nothing else, between them.'
  )

  return { inside, outside }
}

// =============================================================================
// 13. Scenario 8 — the degraded placeholder, and its repair
// =============================================================================

/**
 * Rename `User.unclaimedSince` for the duration of `run`, so that every write
 * touching it faults against a real PostgreSQL.
 *
 * The only fault injection in this file, and it is a real fault rather than a
 * substituted decision: Prisma issues its ordinary statement, the server refuses
 * it because the column is not there, and the code under test meets a genuine
 * `PrismaClientKnownRequestError` from a genuine connection. Nothing is mocked
 * and no branch is forced.
 *
 * `finally` puts the column back whatever happens, and the database this runs
 * against has already been asserted disposable — but the rename is still scoped
 * as tightly as it can be, because a harness that leaves a schema mangled on a
 * failed assertion is a harness that makes the *next* failure unreadable.
 */
async function withoutUnclaimedSinceColumn<T>(run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "User" RENAME COLUMN "unclaimedSince" TO "unclaimedSince_hidden"'
  )

  try {
    return await run()
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "User" RENAME COLUMN "unclaimedSince_hidden" TO "unclaimedSince"'
    )
  }
}

/**
 * The state a reviewer reproduced, and the two things that were missing from it.
 *
 * `authConfig.events.signIn` used to call `markMailboxProved` inside a
 * `try`/`catch` that logged and dropped the error. The reviewer produced the
 * consequence directly: a session exists, and `User.unclaimedSince` is still
 * stamped. Nothing reported it, and nothing ever fixed it — the old comment
 * conceded the window and left it open "until the next sign-in re-runs this",
 * which for a magic-link household can be never.
 *
 * What makes that a defect rather than a stale column is asserted first, before
 * anything is repaired: while the stamp stands, `attachReferralClaim` still
 * admits an anonymous POST against this household, so a sprayer can **re-aim
 * the consent prompt of an account that already has a session**. That is the
 * capability the clear is supposed to have closed.
 *
 * Then the two properties `ensureMailboxProved` adds:
 *
 *  1. **Observable.** A failing clear returns `{kind: 'failed'}` — a value the
 *     caller has to handle rather than an exception a `catch` can drop on the
 *     floor. Measured here against a real fault, not a stub.
 *  2. **Recoverable.** `authConfig.callbacks.session` calls it again on every
 *     authenticated request, so the very next page load repairs it. That call
 *     cannot be driven from here (`server/auth.ts` needs a Next.js runtime),
 *     so this drives the function that callback calls, with the argument it
 *     passes — the same seam every other scenario in this file uses for
 *     `signIn`.
 *
 * The scenario ends by proving the repair actually bought the property it was
 * for: the same anonymous POST that landed a moment ago is now inert.
 */
async function scenarioDegradedPlaceholder(): Promise<void> {
  section('8. a sign-in whose clear failed — observable, and repaired')

  await stage()

  await sprayAnonymously(HOUSEHOLD_EMAIL, SPRAYED_CODE)

  const userId = (await userIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const clientProfileId = (await profileIdForEmail(HOUSEHOLD_EMAIL)) ?? ''

  // The sign-in, with its clear faulting. `magicLinkSignIn` is not used here
  // precisely because it asserts the clear succeeded; this is the run where it
  // does not, and the fault is a real one against a real column.
  const atSignIn = await withoutUnclaimedSinceColumn(async () =>
    ensureMailboxProved(userId)
  )

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  })

  const stampAfterSignIn = await unclaimedSinceOf(userId)

  check('the failed clear is reported as a value, not swallowed', () => {
    assert.equal(atSignIn.kind, 'failed')
    assert.equal(atSignIn.kind === 'failed' ? atSignIn.attempts : 0, 2)
    assert.notEqual(
      atSignIn.kind === 'failed' ? atSignIn.message : '',
      'unknown'
    )
  })

  check('and the household is left signed in, with the stamp still standing', () => {
    assert.notEqual(stampAfterSignIn, null)
  })

  // --- what the stamp still permits, stated before it is cleared ------------
  // This is the harm. A second sprayer POSTs at an address whose owner is
  // already signed in, and re-aims the consent prompt they will be shown.
  await sprayAnonymously(HOUSEHOLD_EMAIL, GENUINE_CODE)

  const reAimed = await referralClaimOf(clientProfileId)

  check('while it stands, the public form can still re-aim a live account', () => {
    assert.equal(reAimed?.code, GENUINE_CODE)
  })

  // --- the repair, as `authConfig.callbacks.session` performs it ------------
  const atSession = await ensureMailboxProved(userId)
  const stampAfterRepair = await unclaimedSinceOf(userId)

  check('the next authenticated request repairs it', () => {
    assert.equal(atSession.kind, 'newly-proved')
    assert.equal(stampAfterRepair, null)
  })

  const again = await ensureMailboxProved(userId)

  check('and every request after that is a WHERE and no UPDATE', () => {
    assert.equal(again.kind, 'not-applicable')
  })

  // --- and the repair bought the property it was for ------------------------
  const beforeThirdSpray = await referralClaimOf(clientProfileId)

  await sprayAnonymously(HOUSEHOLD_EMAIL, SPRAYED_CODE)

  const afterThirdSpray = await referralClaimOf(clientProfileId)

  check('the identical POST is inert once the stamp is gone', () => {
    assert.equal(beforeThirdSpray?.code, GENUINE_CODE)
    assert.equal(afterThirdSpray?.code, GENUINE_CODE)
  })

  note('a swallowed failure was a standing capability; now it is a logged one that heals.')
}

// =============================================================================
// 14. The report
// =============================================================================

function printReport(
  noConsent: SweepRecord,
  declined: SweepRecord,
  accepted: SweepRecord,
  legitimate: SweepRecord
): void {
  printTable(
    'One anonymous POST at one address with one code — and four things the household did next',
    [
      ['', 'no answer', 'declined', 'accepted', 'genuine invite'],
      ['redemptions written by the POST', '0', '0', '0', '0'],
      ['household proved the mailbox', 'yes', 'yes', 'yes', 'yes'],
      ['household paid a real invoice', 'yes', 'yes', 'yes', 'yes'],
      [
        'redemptions examined by the sweep',
        String(noConsent.examined),
        String(declined.examined),
        String(accepted.examined),
        String(legitimate.examined),
      ],
      [
        'credited by the sweep',
        money(noConsent.creditedCents),
        money(declined.creditedCents),
        money(accepted.creditedCents),
        money(legitimate.creditedCents),
      ],
    ],
    '  The first three columns are the same prefix function, the same email\n' +
      '  literal and the same invitation code, run three times. Nothing the\n' +
      '  attacker does differs between them, and nothing in the test data differs\n' +
      '  between them. The only difference is which consent action the household\n' +
      '  invoked, and that is the only thing that moves the money.'
  )
}

/**
 * The two orderings, side by side.
 *
 * Printed separately from {@link printReport} because it answers the question
 * that report cannot: that one holds the *submissions* fixed and varies the
 * household's answer; this one holds the household's intent fixed — they were
 * genuinely referred, and they want the invitation they were actually given —
 * and varies only which of two identical anonymous POSTs arrived second.
 *
 * The top half of the table is where the two columns differ, and every line of
 * it is bad news in the right-hand column. The bottom half is where they do not,
 * and that is the guarantee: the divergence is confined to what the household is
 * *shown* and how many acts it costs them, and never reaches who is paid.
 */
function printPrecedenceReport(
  sprayFirst: PrecedenceObservation,
  genuineFirst: PrecedenceObservation
): void {
  printTable(
    'The same two anonymous POSTs, at one address, in the two possible orders',
    [
      ['', 'spray first', 'genuine first'],
      [
        'second POST to arrive',
        sprayFirst.lastSubmitted,
        genuineFirst.lastSubmitted,
      ],
      [
        'code standing on the file',
        sprayFirst.standingCode ?? '(none)',
        genuineFirst.standingCode ?? '(none)',
      ],
      [
        'code the banner offered',
        sprayFirst.bannerCode ?? '(none)',
        genuineFirst.bannerCode ?? '(none)',
      ],
      [
        'inviter the banner named',
        sprayFirst.bannerInviter ?? '(none)',
        genuineFirst.bannerInviter ?? '(none)',
      ],
      ['route to the real invitation', sprayFirst.route, genuineFirst.route],
      [
        'authenticated acts required',
        String(sprayFirst.authenticatedActs),
        String(genuineFirst.authenticatedActs),
      ],
      ['—', '—', '—'],
      [
        'money moved before consent',
        money(
          sprayFirst.moneyBeforeConsent.attackerBalanceCents +
            sprayFirst.moneyBeforeConsent.patronBalanceCents
        ),
        money(
          genuineFirst.moneyBeforeConsent.attackerBalanceCents +
            genuineFirst.moneyBeforeConsent.patronBalanceCents
        ),
      ],
      [
        'redemption finally written',
        sprayFirst.redemptions.map((row) => row.code).join(', ') || '(none)',
        genuineFirst.redemptions.map((row) => row.code).join(', ') || '(none)',
      ],
      [
        'paid to the real inviter',
        money(sprayFirst.patronBalanceCents),
        money(genuineFirst.patronBalanceCents),
      ],
      [
        'paid to the sprayer',
        money(sprayFirst.attackerBalanceCents),
        money(genuineFirst.attackerBalanceCents),
      ],
    ],
    '  Above the rule the columns differ, and the right-hand one is the honest\n' +
      '  bad news: a household that really was referred is shown a stranger’s\n' +
      '  code, with the stranger named as their inviter. `recordReferralClaim`\n' +
      '  is last-writer-wins, and a sprayer chooses when to fire. Below the rule\n' +
      '  the columns are identical, and that is the guarantee — the ordering\n' +
      '  decides what is displayed and how many acts it costs, never who is paid.\n' +
      '  The right-hand column costs one extra act because the household reaches\n' +
      '  `redeemReferralCode` instead of the banner’s Accept.'
  )
}

/**
 * The window, as two columns that differ by two days of `claimedAt`.
 *
 * Printed separately from {@link printReport} because it answers a different
 * question. That table asks what the *household* did; this one holds the
 * household's behaviour fixed — it accepts in both columns — and varies only how
 * long the invitation had been sitting there.
 */
function printClaimWindowReport(
  inside: AgedClaimObservation,
  outside: AgedClaimObservation
): void {
  printTable(
    'One spray, one address, one code, accepted in both columns — ' +
      `${String(OUTSIDE_EDGE_DAYS - INSIDE_EDGE_DAYS)} days apart`,
    [
      [
        '',
        `claimed ${String(inside.ageDays)} days ago`,
        `claimed ${String(outside.ageDays)} days ago`,
      ],
      [
        'window shown to the household',
        `${String(inside.windowShownDays)} days`,
        `${String(outside.windowShownDays)} days`,
      ],
      ['standing on the banner', inside.standing, outside.standing],
      ['what the acceptance answered', inside.acceptance, outside.acceptance],
      [
        'redemptions written',
        String(inside.redemptionsAtAcceptance.length),
        String(outside.redemptionsAtAcceptance.length),
      ],
      [
        'credited by the sweep',
        money(inside.swept.creditedCents),
        money(outside.swept.creditedCents),
      ],
      [
        'sprayer’s balance',
        money(inside.attackerBalanceCents),
        money(outside.attackerBalanceCents),
      ],
    ],
    '  CLAIM_WINDOW_DAYS is the only bound on "claim a million mailboxes, wait\n' +
      '  however long it takes for any of them to become a customer, collect".\n' +
      '  The right-hand column is what stops the waiting being free, and the\n' +
      '  left-hand one is what stops the bound from having deleted the feature.'
  )
}

// =============================================================================
// 15. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log(
    'MCV-052 — an attribution becomes money only when the mailbox holder says so'
  )
  console.log(`database: ${name}`)

  const noConsent = await scenarioNoConsent()
  const declined = await scenarioDeclined()
  const accepted = await scenarioAccepted()

  const precedence = await scenarioPrecedence()

  const legitimate = await scenarioLegitimate()

  await scenarioIdempotence()

  const window = await scenarioClaimWindow()

  await scenarioDegradedPlaceholder()

  printReport(noConsent, declined, accepted, legitimate)
  printPrecedenceReport(precedence.sprayFirst, precedence.genuineFirst)
  printClaimWindowReport(window.inside, window.outside)

  console.log(`\nPASS — ${String(checkCount())} assertions, 0 failures.`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void disconnect()
  })
