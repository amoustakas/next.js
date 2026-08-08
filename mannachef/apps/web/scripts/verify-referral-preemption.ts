// mannachef/apps/web/scripts/verify-referral-preemption.ts

/**
 * The MCV-050 regression: **an unauthenticated caller may not stake money
 * against a mailbox**, including one that does not exist yet — and a genuine
 * referral must still be paid, end to end, through the same door.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma migrate deploy
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:preemption
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable — see `assertDisposableDatabase` in `fixtures/database.ts`.
 *
 * ## The exploit this exists to keep dead
 *
 * Grown out of the adversarial probe written during the review, which measured
 * it against a live database as `{examined: 1, qualified: 1, rewarded: 1,
 * creditedCents: 5000}`. In four steps:
 *
 *  1. An ordinary `CLIENT` mints one programme-priced invitation code.
 *  2. Signed out, they POST `requestConsultation` (`auth: 'PUBLIC'`) carrying
 *     their own code and an address belonging to **nobody we have ever heard
 *     of** — `not.yet.a.customer@example.org`.
 *  3. `resolveIdentity` creates the `User` and the `ClientProfile` and reports
 *     `kind: 'created'`. The MCV-040 guard admits `created`, so a `PENDING`
 *     `ReferralRedemption` is written.
 *  4. Weeks later the genuine owner of that mailbox signs in by magic link.
 *     Auth.js's `database` strategy binds to the **existing** row for that email
 *     — exactly as this repository's own `signIn` callback does — subscribes,
 *     pays a real invoice, and the settlement sweep credits the attacker.
 *
 * The victim never saw a form, never clicked a link, and never met the attacker.
 *
 * ## Why the previous fix admitted it
 *
 * MCV-040 finding A asked *"did this call insert the `User` row?"*. The property
 * that decides whether money may move is *"has this caller proved control of
 * this mailbox?"*. Those coincide only if a freshly created row means a
 * masterless address, which the `ResolvedIdentity` docblock asserted outright:
 * *"Nobody else has ever held this account."* Nobody had held it **yet**.
 *
 * ## What the fix is
 *
 * A referral is accepted only by an authenticated session. The public path
 * records `ClientProfile.claimedReferralCode` — a string with no ledger row and
 * no financial meaning — and `settleFirstAuthenticatedSession` turns it into a
 * `ReferralRedemption` at the first sign-in that proves the mailbox, re-running
 * the whole of `resolveRedemptionEligibility` at *that* moment and writing
 * through `createReferralRedemption`, the one canonical writer. See
 * `@/server/referral-claim`, which also states what this does **not** buy.
 *
 * ## How the two columns are produced
 *
 * The "after" column is the **real** `requestConsultation`, the **real**
 * `submitProspectIntake` and the **real** `settleFirstAuthenticatedSession`,
 * driven through the real `withAction` wrapper, the real zod schemas and the
 * real rate limiter against a real PostgreSQL. The money figures come from the
 * **real** `settleReferralRedemptions`.
 *
 * The "before" column is `legacyRequestConsultation` in
 * `fixtures/intake-legacy.ts`, running against the same database. For an address
 * that does not exist yet the pre-MCV-040 source and the MCV-040 source behave
 * identically — both create the `User` and both attach the redemption — so that
 * one transcription is a faithful "before" for this finding as well as for
 * finding A. Scenario 1 is what keeps it honest: if it ever stops staking the
 * claim, the fixture has drifted and the comparison is worthless.
 *
 * ## The scenarios
 *
 * | #  | Shape                                                | Proves                                     |
 * | -- | ---------------------------------------------------- | ------------------------------------------ |
 * | 1  | pre-emption, pre-fix source                          | $50.00 to a stranger, no sign-in involved  |
 * | 2  | pre-emption, shipped `requestConsultation`           | no redemption, no counter, sweep pays $0   |
 * | 3  | pre-emption, shipped `submitProspectIntake`          | the second public door is closed too       |
 * | 4  | an address that is already ours                      | not one row, not one column, not a claim   |
 * | 5  | a genuine prospect: claim → sign-in → invoice → sweep | the programme still pays, end to end       |
 * | 6  | settling the same claim twice                        | a claim is a one-shot token                |
 * | 7  | a claim older than the window                        | spray-and-wait has a horizon               |
 * | 8  | code withdrawn / cap filled / already referred        | eligibility is asked at settlement         |
 * | 9  | an unclaimed placeholder meets Google                | the denial of registration is closed       |
 * | 10 | `redeemReferralCode`                                 | the audited door is still open             |
 */

import assert from 'node:assert/strict'

import {
  requestConsultation,
  submitProspectIntake,
} from '@/server/actions/intake'
import {
  createReferralCode,
  redeemReferralCode,
  settleReferralRedemptions,
} from '@/server/actions/referral'
import type { ActionResult } from '@/server/actions/types'
import { prisma } from '@/server/db'
import {
  CLAIM_WINDOW_DAYS,
  adoptUnclaimedAccount,
  readPendingReferralClaim,
  settleFirstAuthenticatedSession,
  type ReferralClaimOutcome,
} from '@/server/referral-claim'

import { legacyRequestConsultation } from './fixtures/intake-legacy'
import { signInAs, type HarnessUser } from './fixtures/harness-state'
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
  linkedProvidersOf,
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
} from './fixtures/intake-harness'

// =============================================================================
// 1. The figures
// =============================================================================

/** What the programme pays an inviter. The probe's `$50.00`. */
const REWARD_CENTS = 5_000

/** The floor a referred household's invoice must clear to qualify. */
const FLOOR_CENTS = 5_000

/** What the pre-empted household eventually pays us, of their own accord. */
const VICTIM_INVOICE_CENTS = 12_000

const CODE = 'HARVEST24'

/** An address whose owner has never heard of us. The probe's own wording. */
const VICTIM_EMAIL = 'not.yet.a.customer@example.org'

/** A genuine prospect, who really was invited. */
const NEWCOMER_EMAIL = 'iris.calloway@example.org'

/** A second genuine prospect, for the scenarios that need two. */
const SECOND_EMAIL = 'oscar.pemberton@example.org'

const PATRON_EMAIL = PATRON.email ?? ''

// =============================================================================
// 2. Staging
// =============================================================================

interface StageOptions {
  /** The redemption cap programme codes carry. `null` leaves them open. */
  readonly cap?: number | null | undefined
}

/**
 * The world every scenario starts from: a standing offer, an attacker with a
 * `ClientProfile`, a patron who has already paid, and a concierge to sweep.
 *
 * The code is minted through the **real** `createReferralCode` as the attacker,
 * because "an ordinary `CLIENT` mints one programme-priced code" is step one of
 * the exploit and it should be the action that proves it rather than an
 * `INSERT`.
 */
async function stage(options: StageOptions = {}): Promise<string> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
    defaultMaxRedemptions: options.cap ?? null,
  })

  await seedHousehold({ person: ATTACKER, status: 'ACTIVE_SUBSCRIBER' })
  await seedHousehold({
    person: PATRON,
    status: 'ACTIVE_SUBSCRIBER',
    allergies: ['peanuts'],
    paidInvoiceCents: 24_000,
  })
  await seedBareUser(OVERSEER)

  signInAs(ATTACKER)

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    // Stated, and discarded: below `ADMIN` the terms are the programme's
    // (MCV-030). The figure that reaches the row is `REWARD_CENTS`.
    rewardValueCents: 1_000_000,
    ownerId: ATTACKER.id,
    code: CODE,
    isActive: true,
  })

  signInAs(null)
  clearRateLimits()

  assert.equal(
    minted.ok,
    true,
    `the attacker could not mint a code: ${minted.ok ? '' : minted.error}`
  )

  const row = await prisma.referralCode.findUniqueOrThrow({
    where: { code: CODE },
    select: { id: true, rewardValueCents: true },
  })

  assert.equal(
    row.rewardValueCents,
    REWARD_CENTS,
    'the minted code should carry the programme figure, not the payload one'
  )

  return row.id
}

/** A `PAID` invoice for a household, over the floor. */
async function payInvoice(userId: string, cents: number): Promise<void> {
  await prisma.invoice.create({
    data: {
      userId,
      amountDueCents: cents,
      amountPaidCents: cents,
      amountRemainingCents: 0,
      subtotalCents: cents,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: new Date(),
      paidAt: new Date(),
    },
    select: { id: true },
  })
}

/** What the settlement sweep moved. The probe reported these five numbers. */
interface SweepRecord {
  readonly examined: number
  readonly rewarded: number
  readonly creditedCents: number
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

function codeOf(result: ActionResult<unknown>): string {
  return result.ok ? 'ok' : result.code
}

/**
 * The `HarnessUser` for an account the actions created, so the audited
 * signed-in door can be driven as them.
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

/**
 * The first authenticated session, as `authConfig.events.signIn` fires it.
 *
 * `server/auth.ts` cannot be imported outside a Next.js runtime — `next-auth`
 * reaches `next/server` — which is exactly why the decision lives in a plain
 * server module and that file holds only the mapping onto it. This calls the
 * same function with the same argument the event passes.
 */
async function firstSignIn(userId: string): Promise<ReferralClaimOutcome> {
  const outcome = await settleFirstAuthenticatedSession(userId)

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  })

  return outcome
}

// =============================================================================
// 3. Scenario 1 — the pre-emption, against the pre-fix source
// =============================================================================

interface PreemptionOutcome {
  readonly redemptionsStaked: number
  readonly claimRecorded: string | null
  readonly sweep: SweepRecord
  readonly attackerBalanceCents: number
}

async function scenarioLegacy(): Promise<PreemptionOutcome> {
  section(
    '1. the pre-emption against the pre-fix source — $50.00 to a stranger'
  )

  const codeId = await stage()

  // No session. No password. No mailbox. One HTTP request, naming an address
  // that belongs to somebody who has never heard of us.
  await legacyRequestConsultation({
    sessionUserId: null,
    fullName: 'M. Quist',
    email: VICTIM_EMAIL,
    preferredContactMethod: 'EMAIL',
    source: 'REFERRAL',
    referralCode: CODE,
  })

  const victimId = await userIdForEmail(VICTIM_EMAIL)
  const staked = await redemptionsForCode(codeId)

  check('an account is opened for an address nobody has proved', () => {
    assert.notEqual(victimId, null)
  })

  check('and a PENDING redemption is staked against it', () => {
    assert.equal(staked.length, 1)
    assert.equal(staked[0]?.referredUserId, victimId)
    assert.equal(staked[0]?.status, 'PENDING')
  })

  // The genuine owner of that mailbox now signs up of their own accord, binds to
  // the existing row for their address, and pays a real invoice.
  assert.notEqual(victimId, null)
  await payInvoice(victimId ?? '', VICTIM_INVOICE_CENTS)

  const swept = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the sweep qualifies it on the victim’s own invoice', () => {
    assert.deepEqual(swept, {
      examined: 1,
      rewarded: 1,
      creditedCents: REWARD_CENTS,
    })
  })

  check('the attacker is credited for a household they never referred', () => {
    assert.equal(attackerBalanceCents, REWARD_CENTS)
  })

  note(
    `outcome: ${money(attackerBalanceCents)} credited off an address the caller only typed.`
  )

  return {
    redemptionsStaked: staked.length,
    claimRecorded: null,
    sweep: swept,
    attackerBalanceCents,
  }
}

// =============================================================================
// 4. Scenarios 2 and 3 — the same, against the shipped public doors
// =============================================================================

async function scenarioShippedConsultation(): Promise<PreemptionOutcome> {
  section('2. the same pre-emption against the shipped requestConsultation')

  const codeId = await stage()

  const posted = await requestConsultation(
    consultationPayload({ email: VICTIM_EMAIL, referralCode: CODE })
  )

  const victimId = await userIdForEmail(VICTIM_EMAIL)
  const profileId = await profileIdForEmail(VICTIM_EMAIL)
  const staked = await redemptionsForCode(codeId)
  const counter = await redemptionCountOf(codeId)

  assert.notEqual(victimId, null)
  assert.notEqual(profileId, null)

  const claim = await referralClaimOf(profileId ?? '')
  const unclaimedSince = await unclaimedSinceOf(victimId ?? '')

  check('the enquiry is accepted, so the form is not an oracle', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('the receipt still withholds every row identifier', () => {
    assert.equal(posted.ok, true)
    assert.equal(posted.ok ? posted.data.consultationInterviewId : 'x', null)
  })

  check(
    'NO redemption is staked — nothing that carries money is written',
    () => {
      assert.deepEqual(staked, [])
    }
  )

  check('and the code’s counter has not moved, so no cap was burnt', () => {
    assert.equal(counter, 0)
  })

  check('what is written is a string on the prospect’s own file', () => {
    assert.notEqual(claim, null)
    assert.equal(claim?.code, CODE)
  })

  check('the account is marked as a placeholder nobody has proved', () => {
    assert.notEqual(unclaimedSince, null)
  })

  // The genuine owner of that mailbox pays a real invoice, exactly as in
  // scenario 1. The difference is that there is nothing for the sweep to find.
  await payInvoice(victimId ?? '', VICTIM_INVOICE_CENTS)

  const swept = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the sweep examines nothing and credits nothing', () => {
    assert.deepEqual(swept, { examined: 0, rewarded: 0, creditedCents: 0 })
  })

  check('the attacker’s reward balance is untouched', () => {
    assert.equal(attackerBalanceCents, 0)
  })

  note(
    `outcome: ${money(attackerBalanceCents)} credited, ${String(staked.length)} redemptions staked, claim = ${claim?.code ?? '—'}`
  )

  return {
    redemptionsStaked: staked.length,
    claimRecorded: claim?.code ?? null,
    sweep: swept,
    attackerBalanceCents,
  }
}

async function scenarioShippedProspectIntake(): Promise<void> {
  section('3. the same pre-emption against the shipped submitProspectIntake')

  const codeId = await stage()

  const posted = await submitProspectIntake(
    prospectPayload({ email: VICTIM_EMAIL, referralCode: CODE })
  )

  const victimId = await userIdForEmail(VICTIM_EMAIL)
  const profileId = await profileIdForEmail(VICTIM_EMAIL)
  const staked = await redemptionsForCode(codeId)

  assert.notEqual(victimId, null)

  const claim = await referralClaimOf(profileId ?? '')
  const counter = await redemptionCountOf(codeId)

  await payInvoice(victimId ?? '', VICTIM_INVOICE_CENTS)

  const swept = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the questionnaire is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('no redemption through the second public door either', () => {
    assert.deepEqual(staked, [])
    assert.equal(counter, 0)
  })

  check('the same attribution string is recorded, and only that', () => {
    assert.equal(claim?.code, CODE)
  })

  check('and the sweep credits nothing', () => {
    assert.deepEqual(swept, { examined: 0, rewarded: 0, creditedCents: 0 })
    assert.equal(attackerBalanceCents, 0)
  })

  note('both public entry points write attribution, and neither writes money.')
}

// =============================================================================
// 5. Scenario 4 — an address that is already ours
// =============================================================================

/**
 * MCV-040 finding A, restated over the new column.
 *
 * The claim is attribution, but it is attribution *on somebody's `ClientProfile`*
 * — so the rule at the head of `actions/intake.ts` still binds: a public
 * submission writes neither a row nor a column of a household that was already
 * ours. If that had been forgotten, an anonymous caller could relabel a paying
 * client's referral source, and the settlement at that household's next sign-in
 * would pay for a customer they already were.
 */
async function scenarioMatchedHousehold(): Promise<void> {
  section('4. the same enquiry naming a household that is already ours')

  const codeId = await stage()
  const before = await accountSnapshot(PATRON.id)

  const posted = await requestConsultation(
    consultationPayload({ email: PATRON_EMAIL, referralCode: CODE })
  )

  const staked = await redemptionsForCode(codeId)
  const claim = await referralClaimOf(PATRON.clientProfileId ?? '')
  const after = await accountSnapshot(PATRON.id)

  check('the enquiry is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('no redemption names the patron', () => {
    assert.deepEqual(staked, [])
  })

  check('and NO claim is written on their file either', () => {
    assert.equal(claim, null)
  })

  check('not one column of the patron’s account moved', () => {
    assert.deepEqual(after, before)
  })

  // Their own first sign-in must not turn a stranger's enquiry into money.
  const outcome = await firstSignIn(PATRON.id)
  const afterSignIn = await redemptionsForCode(codeId)

  check('so their next sign-in settles nothing', () => {
    assert.equal(outcome.kind, 'nothing-claimed')
    assert.deepEqual(afterSignIn, [])
  })

  note('a household we already hold is untouchable from a public form.')
}

// =============================================================================
// 6. Scenario 5 — the programme still pays, end to end
// =============================================================================

/**
 * A fix that closed the hole by never attaching a referral at all would pass
 * every scenario above and would have quietly deleted the feature. So this asks
 * for the opposite result and insists on it: a genuine prospect types a genuine
 * code on the public form, signs in, subscribes, pays, and the inviter is paid.
 */
async function scenarioLegitimateReferral(): Promise<PreemptionOutcome> {
  section('5. a genuine prospect — claim, sign-in, invoice, sweep')

  const codeId = await stage()

  const posted = await requestConsultation(
    consultationPayload({ email: NEWCOMER_EMAIL, referralCode: CODE })
  )

  const newcomerId = await userIdForEmail(NEWCOMER_EMAIL)
  const profileId = await profileIdForEmail(NEWCOMER_EMAIL)

  assert.notEqual(newcomerId, null)
  assert.notEqual(profileId, null)

  const claimed = await referralClaimOf(profileId ?? '')
  const pending = await readPendingReferralClaim(newcomerId ?? '')
  const beforeSignIn = await redemptionsForCode(codeId)

  check('the enquiry is accepted and the claim is recorded', () => {
    assert.equal(codeOf(posted), 'ok')
    assert.equal(claimed?.code, CODE)
  })

  check('a portal could offer it back to them, and it has not lapsed', () => {
    assert.equal(pending?.code, CODE)
    assert.equal(pending?.lapsed, false)
  })

  check('but no redemption exists yet — nobody has proved the mailbox', () => {
    assert.deepEqual(beforeSignIn, [])
  })

  // The prospect clicks the magic link in their own inbox. This is the moment
  // the platform first knows the address is theirs.
  const outcome = await firstSignIn(newcomerId ?? '')

  const staked = await redemptionsForCode(codeId)
  const counter = await redemptionCountOf(codeId)
  const consumed = await referralClaimOf(profileId ?? '')
  const unclaimedSince = await unclaimedSinceOf(newcomerId ?? '')

  check('the first authenticated session settles the claim', () => {
    assert.equal(outcome.kind, 'settled')
  })

  check('a PENDING redemption now names them, and the counter moved', () => {
    assert.equal(staked.length, 1)
    assert.equal(staked[0]?.referredUserId, newcomerId)
    assert.equal(staked[0]?.status, 'PENDING')
    assert.equal(counter, 1)
  })

  check('the claim is consumed, so it can never settle twice', () => {
    assert.equal(consumed, null)
  })

  check('and the placeholder marker is cleared — the account is theirs', () => {
    assert.equal(unclaimedSince, null)
  })

  await payInvoice(newcomerId ?? '', 18_000)

  const swept = await sweep()
  const inviterBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the sweep pays the inviter, exactly as the programme intends', () => {
    assert.deepEqual(swept, {
      examined: 1,
      rewarded: 1,
      creditedCents: REWARD_CENTS,
    })
    assert.equal(inviterBalanceCents, REWARD_CENTS)
  })

  const entries = await prisma.rewardLedgerEntry.findMany({
    where: { userId: ATTACKER.id },
    select: { reason: true, direction: true, amountCents: true },
  })

  check('and the ledger entry is an ordinary earned referral', () => {
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.reason, 'REFERRAL_REWARD')
    assert.equal(entries[0]?.direction, 'CREDIT')
    assert.equal(entries[0]?.amountCents, REWARD_CENTS)
  })

  note(
    `outcome: ${money(inviterBalanceCents)} paid for a household that really was referred.`
  )

  return {
    redemptionsStaked: staked.length,
    claimRecorded: CODE,
    sweep: swept,
    attackerBalanceCents: inviterBalanceCents,
  }
}

// =============================================================================
// 7. Scenario 6 — a claim is a one-shot token
// =============================================================================

async function scenarioSettledOnce(): Promise<void> {
  section('6. settling the same claim twice')

  const codeId = await stage()

  await requestConsultation(
    consultationPayload({ email: NEWCOMER_EMAIL, referralCode: CODE })
  )

  const newcomerId = (await userIdForEmail(NEWCOMER_EMAIL)) ?? ''

  const first = await firstSignIn(newcomerId)
  const second = await firstSignIn(newcomerId)
  const third = await firstSignIn(newcomerId)

  const staked = await redemptionsForCode(codeId)
  const counter = await redemptionCountOf(codeId)

  check('the first session settles it', () => {
    assert.equal(first.kind, 'settled')
  })

  check('every session after that finds nothing to settle', () => {
    assert.equal(second.kind, 'nothing-claimed')
    assert.equal(third.kind, 'nothing-claimed')
  })

  check('so one redemption exists and the counter moved once', () => {
    assert.equal(staked.length, 1)
    assert.equal(counter, 1)
  })

  note('the compare-and-swap on the claim columns is what says so.')
}

// =============================================================================
// 8. Scenario 7 — an attribution has a horizon
// =============================================================================

/**
 * The bound on the residual `@/server/referral-claim` names honestly.
 *
 * No server-side test separates "the prospect who typed the code then signed in"
 * from "a stranger typed it and the prospect signed in" — they are the same two
 * requests. What can be bounded is how long an unproved attribution stays
 * settleable, which is what turns "spray a million addresses and wait" from a
 * standing bet into one that expires.
 */
async function scenarioLapsedClaim(): Promise<void> {
  section(`7. a claim older than ${String(CLAIM_WINDOW_DAYS)} days`)

  const codeId = await stage()

  await requestConsultation(
    consultationPayload({ email: VICTIM_EMAIL, referralCode: CODE })
  )

  const victimId = (await userIdForEmail(VICTIM_EMAIL)) ?? ''
  const profileId = (await profileIdForEmail(VICTIM_EMAIL)) ?? ''

  const staleAt = new Date(
    Date.now() - (CLAIM_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1_000
  )
  await backdateReferralClaim(profileId, staleAt)

  const pending = await readPendingReferralClaim(victimId)
  const outcome = await firstSignIn(victimId)

  const staked = await redemptionsForCode(codeId)
  const counter = await redemptionCountOf(codeId)
  const consumed = await referralClaimOf(profileId)

  check('the claim reads back as lapsed', () => {
    assert.equal(pending?.lapsed, true)
  })

  check('the sign-in refuses it rather than settling it', () => {
    assert.equal(outcome.kind, 'lapsed')
  })

  check('no redemption, no counter movement', () => {
    assert.deepEqual(staked, [])
    assert.equal(counter, 0)
  })

  check('and the stale attribution is cleared off the file', () => {
    assert.equal(consumed, null)
  })

  await payInvoice(victimId, VICTIM_INVOICE_CENTS)

  const swept = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('so even a paying victim earns the sprayer nothing', () => {
    assert.deepEqual(swept, { examined: 0, rewarded: 0, creditedCents: 0 })
    assert.equal(attackerBalanceCents, 0)
  })
}

// =============================================================================
// 9. Scenario 8 — eligibility is asked at settlement, not at claim time
// =============================================================================

/**
 * The public path has no cap check, no expiry check and no owner check, and
 * that is the point: it writes nothing those could bound. Every one of them is
 * asked once, by `resolveRedemptionEligibility`, at the moment the claim
 * settles — which is also the only moment their answers are current.
 *
 * MCV-040 finding B is the reason this scenario is three cases rather than one.
 * `attachReferral` compared `redemptionCount` against `maxRedemptions` and then
 * wrote the redemption **without moving the counter**, so the comparison was
 * against zero for every caller, for ever. A control whose result changes
 * nothing is why nobody looks at it. These assertions are what stands in its
 * place.
 */
async function scenarioEligibilityAtSettlement(): Promise<void> {
  section('8. the code changes between the claim and the sign-in')

  // --- a. withdrawn ------------------------------------------------------
  const withdrawnCodeId = await stage()

  await requestConsultation(
    consultationPayload({ email: NEWCOMER_EMAIL, referralCode: CODE })
  )

  await prisma.referralCode.update({
    where: { id: withdrawnCodeId },
    data: { isActive: false },
    select: { id: true },
  })

  const withdrawn = await firstSignIn(
    (await userIdForEmail(NEWCOMER_EMAIL)) ?? ''
  )
  const withdrawnRows = await redemptionsForCode(withdrawnCodeId)

  check('a code withdrawn after the claim is refused at settlement', () => {
    assert.equal(withdrawn.kind, 'refused')
    assert.equal(
      withdrawn.kind === 'refused' ? withdrawn.reason : '',
      'UNKNOWN_CODE'
    )
    assert.deepEqual(withdrawnRows, [])
  })

  // --- b. the cap fills in between ---------------------------------------
  const cappedCodeId = await stage({ cap: 1 })

  await requestConsultation(
    consultationPayload({ email: NEWCOMER_EMAIL, referralCode: CODE })
  )
  clearRateLimits()
  await requestConsultation(
    consultationPayload({ email: SECOND_EMAIL, referralCode: CODE })
  )

  const firstId = (await userIdForEmail(NEWCOMER_EMAIL)) ?? ''
  const secondId = (await userIdForEmail(SECOND_EMAIL)) ?? ''
  const counterAfterClaims = await redemptionCountOf(cappedCodeId)

  check('two claims may be recorded against a code capped at one', () => {
    // Recording costs nothing, so nothing needs rationing here. The cap binds
    // where the redemption is written, which is the only place it can.
    assert.equal(counterAfterClaims, 0)
  })

  const winner = await firstSignIn(firstId)
  const loser = await firstSignIn(secondId)

  const capped = await redemptionsForCode(cappedCodeId)
  const cappedCounter = await redemptionCountOf(cappedCodeId)

  check('the first to prove a mailbox takes the seat', () => {
    assert.equal(winner.kind, 'settled')
  })

  check('the second is refused, by the cap, at settlement', () => {
    assert.equal(loser.kind, 'refused')
    assert.equal(loser.kind === 'refused' ? loser.reason : '', 'FULLY_REDEEMED')
  })

  check('so the cap binds and the counter agrees with the rows', () => {
    assert.equal(capped.length, 1)
    assert.equal(cappedCounter, 1)
  })

  // --- c. the household accepted a different invitation in between --------
  const otherCodeId = await stage()

  await requestConsultation(
    consultationPayload({ email: NEWCOMER_EMAIL, referralCode: CODE })
  )

  const newcomer = await sessionFor(NEWCOMER_EMAIL)

  // A second, unrelated invitation, taken through the audited door.
  signInAs(PATRON)
  clearRateLimits()
  const rival = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: 1,
    ownerId: PATRON.id,
    code: 'WINTER26',
    isActive: true,
  })
  signInAs(null)
  assert.equal(rival.ok, true)

  signInAs(newcomer)
  clearRateLimits()
  const redeemed = await redeemReferralCode({ code: 'WINTER26' })
  signInAs(null)

  const already = await firstSignIn(newcomer.id)
  const stakedOnAttacker = await redemptionsForCode(otherCodeId)

  check('the household accepts a different invitation, signed in', () => {
    assert.equal(codeOf(redeemed), 'ok')
  })

  check(
    'the stale claim is then refused — one live redemption per account',
    () => {
      assert.equal(already.kind, 'refused')
      assert.equal(
        already.kind === 'refused' ? already.reason : '',
        'ALREADY_REFERRED'
      )
      assert.deepEqual(stakedOnAttacker, [])
    }
  )

  note('none of these three rules exists on the public path. All three bind.')
}

// =============================================================================
// 10. Scenario 9 — the denial of registration
// =============================================================================

/**
 * The second, quieter harm of the same call.
 *
 * A placeholder `User` has no `Account`, and `allowDangerousEmailAccountLinking`
 * is `false` on the Google provider — correctly. So Auth.js would refuse the
 * genuine owner's Google sign-in with `OAuthAccountNotLinked`, permanently: an
 * anonymous caller could deny Google registration to any address on earth by
 * typing it into the enquiry form.
 *
 * `adoptUnclaimedAccount` links the OAuth account to a row that has never had an
 * `Account`, never had a `Session` and never had a `lastLoginAt` — a row no human
 * has ever exercised, which is why this is narrower than the provider flag rather
 * than a rename of it.
 */
async function scenarioOAuthAdoption(): Promise<void> {
  section('9. the genuine owner of a pre-empted address arrives via Google')

  await stage()

  await requestConsultation(
    consultationPayload({ email: VICTIM_EMAIL, referralCode: CODE })
  )

  const victimId = (await userIdForEmail(VICTIM_EMAIL)) ?? ''

  const adopted = await adoptUnclaimedAccount(VICTIM_EMAIL, {
    provider: 'google',
    providerAccountId: 'google-oauth-subject-1',
    type: 'oidc',
    access_token: 'redacted',
    scope: 'openid email profile',
  })

  const providers = await linkedProvidersOf(victimId)

  check('the placeholder is adopted rather than collided with', () => {
    assert.equal(adopted.kind, 'adopted')
    assert.equal(adopted.kind === 'adopted' ? adopted.userId : '', victimId)
  })

  check('so an Account row now exists and the sign-in can proceed', () => {
    assert.deepEqual(providers, ['google'])
  })

  // The same call against an account somebody has actually been using must be
  // refused — that would be the takeover the provider flag exists to prevent.
  const refused = await adoptUnclaimedAccount(PATRON_EMAIL, {
    provider: 'google',
    providerAccountId: 'google-oauth-subject-2',
    type: 'oidc',
  })
  const patronProviders = await linkedProvidersOf(PATRON.id)

  check('a real household’s account is never adopted', () => {
    assert.equal(refused.kind, 'not-applicable')
    assert.deepEqual(patronProviders, [])
  })

  // Nor one that began as a placeholder and has since been signed into:
  // `unclaimedSince` is cleared the moment a mailbox is proved, and the row is
  // an ordinary account from then on.
  await firstSignIn(victimId)
  const unclaimedAfterSignIn = await unclaimedSinceOf(victimId)

  const secondAttempt = await adoptUnclaimedAccount(VICTIM_EMAIL, {
    provider: 'google',
    providerAccountId: 'google-oauth-subject-3',
    type: 'oidc',
  })
  const victimProviders = await linkedProvidersOf(victimId)

  check('an adopted account is not adoptable a second time', () => {
    assert.equal(unclaimedAfterSignIn, null)
    assert.equal(secondAttempt.kind, 'not-applicable')
    assert.deepEqual(victimProviders, ['google'])
  })

  // And an address nobody has ever named to us is simply not our business: the
  // adapter opens the account, as it does for every other new registration.
  const unknown = await adoptUnclaimedAccount(NEWCOMER_EMAIL, {
    provider: 'google',
    providerAccountId: 'google-oauth-subject-4',
    type: 'oidc',
  })

  check('an address we have never seen is left to the adapter', () => {
    assert.equal(unknown.kind, 'not-applicable')
  })

  note('adoption applies to rows no human has ever exercised, and only those.')
}

// =============================================================================
// 11. Scenario 10 — the audited door
// =============================================================================

/**
 * `redeemReferralCode` is unchanged and is still the way an account that already
 * exists accepts an invitation, with the household heuristic, the
 * one-live-redemption rule and an honest error for every refusal. MCV-050 moved
 * the public path *onto* that door rather than around it; this asserts the door
 * still opens.
 */
async function scenarioAuditedDoor(): Promise<void> {
  section('10. a signed-in household accepts an invitation directly')

  const codeId = await stage()

  // A household with an account and no claim of any kind.
  await requestConsultation(consultationPayload({ email: SECOND_EMAIL }))

  const guest = await sessionFor(SECOND_EMAIL)

  await firstSignIn(guest.id)

  signInAs(guest)
  clearRateLimits()
  const redeemed = await redeemReferralCode({ code: CODE })
  signInAs(null)

  const staked = await redemptionsForCode(codeId)

  check('the redemption is accepted', () => {
    assert.equal(codeOf(redeemed), 'ok')
    assert.equal(staked.length, 1)
    assert.equal(staked[0]?.referredUserId, guest.id)
  })

  await payInvoice(guest.id, 18_000)

  const swept = await sweep()
  const inviterBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('and it is paid on the referred household’s own invoice', () => {
    assert.deepEqual(swept, {
      examined: 1,
      rewarded: 1,
      creditedCents: REWARD_CENTS,
    })
    assert.equal(inviterBalanceCents, REWARD_CENTS)
  })

  note('one writer, one predicate, one door.')
}

// =============================================================================
// 12. The report
// =============================================================================

function printReport(
  before: PreemptionOutcome,
  after: PreemptionOutcome,
  legitimate: PreemptionOutcome
): void {
  printTable(
    'An unauthenticated caller types an address that does not exist yet, with their own code',
    [
      ['', 'pre-fix', 'shipped', 'genuine prospect'],
      [
        'redemptions staked by the POST',
        String(before.redemptionsStaked),
        String(after.redemptionsStaked),
        '0',
      ],
      [
        'attribution recorded',
        before.claimRecorded ?? '—',
        after.claimRecorded ?? '—',
        legitimate.claimRecorded ?? '—',
      ],
      [
        'redemptions examined by the sweep',
        String(before.sweep.examined),
        String(after.sweep.examined),
        String(legitimate.sweep.examined),
      ],
      [
        'credited by the sweep',
        money(before.sweep.creditedCents),
        money(after.sweep.creditedCents),
        money(legitimate.sweep.creditedCents),
      ],
      [
        'inviter’s balance',
        money(before.attackerBalanceCents),
        money(after.attackerBalanceCents),
        money(legitimate.attackerBalanceCents),
      ],
    ],
    '  All three columns are the same database, the same seeded rows, the same\n' +
      '  minted code and the same settlement sweep. The first two are the same\n' +
      '  HTTP request. The only difference between the second and the third is\n' +
      '  whether anybody ever proved they own the mailbox.'
  )
}

// =============================================================================
// 13. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log(
    'MCV-050 — a referral may not be staked against a mailbox nobody has proved'
  )
  console.log(`database: ${name}`)

  const before = await scenarioLegacy()
  const after = await scenarioShippedConsultation()

  await scenarioShippedProspectIntake()
  await scenarioMatchedHousehold()

  const legitimate = await scenarioLegitimateReferral()

  await scenarioSettledOnce()
  await scenarioLapsedClaim()
  await scenarioEligibilityAtSettlement()
  await scenarioOAuthAdoption()
  await scenarioAuditedDoor()

  printReport(before, after, legitimate)

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
