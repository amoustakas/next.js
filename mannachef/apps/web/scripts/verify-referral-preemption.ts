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
 * | 4 | spray, then the household's own  | which submission the *placeholder*    |
 * |   | enquiry naming a different code  | received last, before it was proved   |
 * | 5 | genuine invitation, end to end   | a second sweep over settled rows      |
 * | 6 | four simultaneous acceptances    | concurrency against one claim token   |
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
import { markMailboxProved } from '@/server/referral-claim'

import { asUser, signInAs, type HarnessUser } from './fixtures/harness-state'
import {
  ATTACKER,
  OVERSEER,
  PATRON,
  accountSnapshot,
  assertDisposableDatabase,
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
// 9. Scenario 4 — precedence
// =============================================================================

/**
 * Round three's finding 1, measured.
 *
 * An attacker sprays `HARVEST24` at an address. The household — who really were
 * invited, by a member who really gave them `GENUINE24` — then fill in the same
 * public enquiry form themselves, naming their own code. Then they sign in.
 *
 * Three things must hold:
 *
 *  1. the household is shown **the code they were given**, not the sprayed one;
 *  2. they can accept it, and the member who actually invited them is paid;
 *  3. the sprayed code cannot lock the genuine inviter out. Under the automatic
 *     settlement this replaces, `HARVEST24` was converted into a live redemption
 *     at the victim's sign-in, and `ALREADY_REFERRED` then refused every genuine
 *     invitation for ever — by any route, `redeemReferralCode` included. That is
 *     theft *and* denial, and it was deterministic rather than racy.
 *
 * What makes (1) true is bounded by a property of the row rather than by
 * ordering luck: a public submission may refresh the claim on a `User` that is
 * still an **unproved placeholder** — a row this same public path opened and
 * that no human has ever signed into. It may not touch a household that has ever
 * proved its mailbox, which is asserted at the end of this scenario. And it
 * confers nothing either way, because the household still has to consent.
 */
async function scenarioPrecedence(): Promise<void> {
  section('4. precedence — the sprayed code must not outrank the real one')

  const stageIds = await stage()

  // The sprayer goes first, as a sprayer would.
  await sprayAnonymously(HOUSEHOLD_EMAIL, SPRAYED_CODE)

  const userId = (await userIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const clientProfileId = (await profileIdForEmail(HOUSEHOLD_EMAIL)) ?? ''
  const sprayed = await referralClaimOf(clientProfileId)

  check('the spray lands first, as it always could', () => {
    assert.equal(sprayed?.code, SPRAYED_CODE)
  })

  // The household now fills in the same form themselves, with the code their
  // friend actually gave them. Same action, same anonymous position.
  await enquireAnonymously(HOUSEHOLD_EMAIL, GENUINE_CODE)

  const standingClaim = await referralClaimOf(clientProfileId)

  check('the household’s own submission is what stands on their unproved file', () => {
    assert.equal(standingClaim?.code, GENUINE_CODE)
  })

  await magicLinkSignIn(userId)

  const household = await sessionFor(HOUSEHOLD_EMAIL)
  const banner = await readBanner(household)
  const attribution = attributionOf(banner?.standing)

  check('so the banner shows them the code THEY were given', () => {
    assert.equal(banner?.code, GENUINE_CODE)
  })

  check('and names the member who invited them, not the sprayer', () => {
    assert.notEqual(attribution, null)
    assert.equal(attribution?.inviterDisplayName, PATRON.name)
  })

  // A prompt rendered against the sprayed code must consume nothing.
  const stale = await acceptAs(household, SPRAYED_CODE)
  const afterStale = await referralClaimOf(clientProfileId)

  check('accepting the sprayed code is superseded, and takes nothing with it', () => {
    assert.equal(stale.ok, true)
    assert.equal(stale.ok ? stale.data.kind : '', 'superseded')
    assert.equal(
      stale.ok && stale.data.kind === 'superseded' ? stale.data.standing : '',
      GENUINE_CODE
    )
    assert.equal(afterStale?.code, GENUINE_CODE)
  })

  const accepted = await acceptAs(household, GENUINE_CODE)

  await payInvoice(userId, HOUSEHOLD_INVOICE_CENTS)

  const swept = await sweep()

  const redemptions = await redemptionsOf(userId)
  const sprayedCounter = await redemptionCountOf(stageIds.sprayedCodeId)
  const genuineCounter = await redemptionCountOf(stageIds.genuineCodeId)
  const patronBalance = await balanceCentsOf(PATRON.id)
  const attackerBalance = await balanceCentsOf(ATTACKER.id)

  check('the genuine invitation settles, and only it', () => {
    assert.equal(accepted.ok, true)
    assert.equal(accepted.ok ? accepted.data.kind : '', 'accepted')
    assert.deepEqual(redemptions, [{ code: GENUINE_CODE, status: 'REWARDED' }])
    assert.equal(sprayedCounter, 0)
    assert.equal(genuineCounter, 1)
  })

  check('the member who actually invited them is paid, and the sprayer is not', () => {
    assert.deepEqual(swept, ONE_REWARD_SWEPT)
    assert.equal(patronBalance, REWARD_CENTS)
    assert.equal(attackerBalance, 0)
  })

  // --- the lockout, asserted from the other end ----------------------------
  // A household holding a live redemption is refused a second one with
  // `ALREADY_REFERRED`. Under the automatic settlement the *sprayed* code
  // occupied that slot before the household had done anything at all, so the
  // real inviter could never be paid. Here the slot is held by the invitation
  // the household consented to, which is the correct occupant — the refusal
  // below is the rule working rather than the harm.
  signInAs(household)
  clearRateLimits()
  const second = await redeemReferralCode({ code: SPRAYED_CODE })
  signInAs(null)

  const unchanged = await redemptionsOf(userId)

  check('one live redemption per household still binds — on the right one', () => {
    assert.equal(second.ok, false)
    assert.equal(second.ok ? '' : second.code, 'VALIDATION')
    assert.deepEqual(unchanged, [{ code: GENUINE_CODE, status: 'REWARDED' }])
  })

  // --- and the refresh is bounded by a property, not by ordering -----------
  // A member who has ever proved their mailbox cannot have their attribution
  // rewritten by anybody's public submission.
  const patronBefore: AccountSnapshot = await accountSnapshot(PATRON.id)

  await sprayAnonymously(PATRON.email ?? '', SPRAYED_CODE)

  const patronClaim = await referralClaimOf(PATRON.clientProfileId ?? '')
  const patronAfter: AccountSnapshot = await accountSnapshot(PATRON.id)

  check('a proved household is untouchable from the public form', () => {
    assert.equal(patronClaim, null)
    assert.deepEqual(patronAfter, patronBefore)
  })

  note('the household chooses; the sprayer neither wins nor blocks.')
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
// 12. The report
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

// =============================================================================
// 13. Entry point
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

  await scenarioPrecedence()

  const legitimate = await scenarioLegitimate()

  await scenarioIdempotence()

  printReport(noConsent, declined, accepted, legitimate)

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
