// mannachef/apps/web/scripts/verify-intake-referral-hijack.ts

/**
 * The MCV-040 finding A regression: a referral may not be attached to an
 * account the caller did not just open.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma db push
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:intake-hijack
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable — see `assertDisposableDatabase` in
 * `fixtures/intake-harness.ts`.
 *
 * ## The exploit this exists to keep dead
 *
 * `requestConsultation` and `submitProspectIntake` are both `auth: 'PUBLIC'`.
 * Both resolved the enquiry's subject through `resolveIdentity`, whose
 * anonymous branch is a lookup by the payload's own email address —
 * `tx.user.findUnique({ where: { email: contact.email } })` — and both then
 * handed the resulting `userId` to `attachReferral` as a bare string.
 *
 * So:
 *
 *  1. an ordinary `CLIENT` mints one programme-priced invitation code, which
 *     `createReferralCode` is happy to give them;
 *  2. with **no session, no password and no access to the mailbox**, they post
 *     the public consultation form carrying `email: <a paying household's
 *     address>` and `referralCode: <their own>`;
 *  3. `resolveIdentity` matches the victim's real `User` and returns it;
 *  4. `attachReferral` writes a `PENDING` `ReferralRedemption` naming the victim
 *     as the referred party;
 *  5. the victim already has a genuine `PAID` invoice clearing the programme's
 *     floor, so `findQualifyingInvoice` succeeds on the very next sweep and
 *     `settleReferralRedemptions` credits the attacker.
 *
 * Nothing in that sequence needs the victim to do anything at all. They had
 * already paid.
 *
 * ## Why the file docblock did not catch it
 *
 * It enumerated the protections an anonymous email claim runs into, and
 * promised that of a matched household "not one of their columns is written".
 * `attachReferral` writes no column. It writes a **row**, in another table, and
 * that row is money. The fix restates the enumeration over rows as well as
 * columns, and — so that the restatement is enforced rather than merely
 * written down — gives `resolveIdentity` a `'created' | 'matched'` discriminant
 * and makes `attachReferral` take the whole identity, so there is no way to
 * spell a call to it that does not carry the provenance along.
 *
 * ## How the two columns are produced
 *
 * The "after" column is the **real** `requestConsultation` and the **real**
 * `submitProspectIntake`, driven through the real `withAction` wrapper, the
 * real zod schemas and the real rate limiter, against a real PostgreSQL. The
 * money figures come from the **real** `settleReferralRedemptions`.
 *
 * The "before" column is the pre-fix source, reproduced in
 * `fixtures/intake-legacy.ts` and running against the same database — see that
 * file for why the defect is transcribed rather than switched, and scenario 4
 * for the assertion that keeps the transcription honest.
 *
 * ## The five scenarios
 *
 * | # | Shape                                             | Proves                                 |
 * | - | ------------------------------------------------- | -------------------------------------- |
 * | 1 | the exploit, pre-fix source                       | $50.00 to an unauthenticated stranger  |
 * | 2 | the exploit, shipped `requestConsultation`        | no redemption, no credit               |
 * | 3 | the exploit, shipped `submitProspectIntake`       | the second entry point is closed too   |
 * | 4 | an unknown address, shipped action                | the programme still works, and the     |
 * |   |                                                   | legacy transcription still matches     |
 * | 5 | a signed-in caller quoting a code                 | referrals go through `redeemReferralCode` |
 */

import assert from 'node:assert/strict'

import {
  requestConsultation,
  submitProspectIntake,
} from '@/server/actions/intake'
import {
  createReferralCode,
  settleReferralRedemptions,
} from '@/server/actions/referral'
import type { ActionResult } from '@/server/actions/types'
import { prisma } from '@/server/db'

import { legacyRequestConsultation } from './fixtures/intake-legacy'
import { signInAs } from './fixtures/harness-state'
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
  consultationCountOf,
  consultationPayload,
  disconnect,
  money,
  note,
  printTable,
  prospectPayload,
  redemptionsForCode,
  resetDatabase,
  section,
  seedBareUser,
  seedHousehold,
  seedProgram,
} from './fixtures/intake-harness'

// =============================================================================
// 1. The figures
// =============================================================================

/** What the programme pays an inviter. The finding's `$50.00`. */
const REWARD_CENTS = 5_000

/** The floor a referred household's invoice must clear to qualify. */
const FLOOR_CENTS = 10_000

/** What the patron has genuinely already paid us. Well over the floor. */
const PATRON_INVOICE_CENTS = 24_000

const CODE = 'HARVEST24'

// =============================================================================
// 2. Staging
// =============================================================================

/**
 * The world every scenario starts from: a standing offer, an attacker with a
 * `ClientProfile`, a patron who has paid, and a concierge to run the sweep.
 *
 * The code itself is minted through the **real** `createReferralCode` as the
 * attacker, because "an ordinary CLIENT mints one programme-priced code" is
 * step one of the exploit and it should be the action that proves it rather
 * than an `INSERT`.
 */
async function stage(): Promise<string> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
    defaultMaxRedemptions: null,
  })

  await seedHousehold({ person: ATTACKER, status: 'PROSPECT' })
  await seedHousehold({
    person: PATRON,
    status: 'ACTIVE_SUBSCRIBER',
    allergies: ['peanuts'],
    paidInvoiceCents: PATRON_INVOICE_CENTS,
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

/** Run the real sweep as the concierge and report what it moved. */
async function sweep(): Promise<number> {
  signInAs(OVERSEER)

  const settled = await settleReferralRedemptions({ limit: 50 })

  signInAs(null)

  assert.equal(
    settled.ok,
    true,
    `the sweep failed: ${settled.ok ? '' : settled.error}`
  )

  return settled.ok ? settled.data.creditedCents : -1
}

function codeOf(result: ActionResult<unknown>): string {
  return result.ok ? 'ok' : result.code
}

/** The patron's address, as the payload schema will have normalised it. */
const PATRON_EMAIL = PATRON.email ?? ''

// =============================================================================
// 3. Scenario 1 — the exploit, against the pre-fix source
// =============================================================================

interface ExploitOutcome {
  readonly redeemedFor: readonly string[]
  readonly attackerBalanceCents: number
  readonly creditedCents: number
}

async function scenarioLegacy(): Promise<ExploitOutcome> {
  section('1. the exploit against the pre-fix source — $50.00 to a stranger')

  const codeId = await stage()

  // No session. No password. No mailbox. One HTTP request.
  await legacyRequestConsultation({
    sessionUserId: null,
    fullName: 'M. Quist',
    email: PATRON_EMAIL,
    preferredContactMethod: 'EMAIL',
    source: 'REFERRAL',
    referralCode: CODE,
  })

  const attached = await redemptionsForCode(codeId)

  check('a PENDING redemption is written naming the patron', () => {
    assert.equal(attached.length, 1)
    assert.equal(attached[0]?.referredUserId, PATRON.id)
    assert.equal(attached[0]?.status, 'PENDING')
  })

  const creditedCents = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the sweep qualifies it on the patron’s own invoice', () => {
    assert.equal(creditedCents, REWARD_CENTS)
  })

  check('the attacker’s reward balance is credited', () => {
    assert.equal(attackerBalanceCents, REWARD_CENTS)
  })

  const entries = await prisma.rewardLedgerEntry.findMany({
    where: { userId: ATTACKER.id },
    select: { reason: true, direction: true, amountCents: true },
  })

  check(
    'the ledger entry is indistinguishable from one that was earned',
    () => {
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.reason, 'REFERRAL_REWARD')
      assert.equal(entries[0]?.direction, 'CREDIT')
      assert.equal(entries[0]?.amountCents, REWARD_CENTS)
    }
  )

  note(
    `outcome: ${money(attackerBalanceCents)} credited to an unauthenticated caller`
  )
  note(
    'the patron never saw a form, never clicked a link, and had already paid.'
  )

  return {
    redeemedFor: attached.map((row) => row.referredUserId),
    attackerBalanceCents,
    creditedCents,
  }
}

// =============================================================================
// 4. Scenarios 2 and 3 — the exploit against the shipped actions
// =============================================================================

async function scenarioFixedConsultation(): Promise<ExploitOutcome> {
  section('2. the same exploit against the shipped requestConsultation')

  const codeId = await stage()
  const before = await accountSnapshot(PATRON.id)

  const posted = await requestConsultation(
    consultationPayload({ email: PATRON_EMAIL, referralCode: CODE })
  )

  const attached = await redemptionsForCode(codeId)
  const creditedCents = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)
  const after = await accountSnapshot(PATRON.id)
  const consultations = await consultationCountOf(PATRON.clientProfileId ?? '')

  check('the enquiry is accepted, so the form is not an oracle', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('the receipt withholds every row identifier', () => {
    assert.equal(posted.ok, true)
    assert.equal(posted.ok ? posted.data.consultationInterviewId : 'x', null)
  })

  check('NO redemption is written — the hijack is refused', () => {
    assert.deepEqual(attached, [])
  })

  check('the sweep therefore credits nothing', () => {
    assert.equal(creditedCents, 0)
    assert.equal(attackerBalanceCents, 0)
  })

  check('not one column of the patron’s account moved', () => {
    assert.deepEqual(after, before)
  })

  check('the concierge still gets the enquiry to telephone about', () => {
    assert.equal(consultations, 1)
  })

  note(
    `outcome: ${money(attackerBalanceCents)} credited, ${String(attached.length)} redemptions written`
  )

  return {
    redeemedFor: attached.map((row) => row.referredUserId),
    attackerBalanceCents,
    creditedCents,
  }
}

async function scenarioFixedProspectIntake(): Promise<void> {
  section('3. the same exploit against the shipped submitProspectIntake')

  const codeId = await stage()

  const posted = await submitProspectIntake(
    prospectPayload({ email: PATRON_EMAIL, referralCode: CODE })
  )

  const attached = await redemptionsForCode(codeId)
  const creditedCents = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the questionnaire is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check(
    'NO redemption is written through the second entry point either',
    () => {
      assert.deepEqual(attached, [])
    }
  )

  check('the sweep credits nothing', () => {
    assert.equal(creditedCents, 0)
    assert.equal(attackerBalanceCents, 0)
  })

  note('both public call sites hand attachReferral the identity, not the id.')
}

// =============================================================================
// 5. Scenario 4 — the fix must refuse nothing legitimate
// =============================================================================

const NEWCOMER_EMAIL = 'iris.calloway@example.org'

/**
 * A genuine invitation, accepted by a genuine newcomer.
 *
 * A fix that closed finding A by never attaching a referral at all would pass
 * scenarios 2 and 3 and would have quietly removed the feature. So this asks
 * for the opposite result and insists on it.
 *
 * It also does the transcription check the legacy fixture's docblock promises:
 * the same enquiry is put through the pre-fix path and the shipped action, and
 * the redemption rows they write are compared. If they ever stop matching, the
 * "before" column of scenario 1 has stopped describing this codebase.
 */
async function scenarioNoFalseRefusal(): Promise<void> {
  section('4. an unknown address — the programme still works')

  const shippedCodeId = await stage()

  const posted = await requestConsultation(
    consultationPayload({ email: NEWCOMER_EMAIL, referralCode: CODE })
  )

  const shipped = await redemptionsForCode(shippedCodeId)

  check('the enquiry is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('a PENDING redemption IS written for the newcomer', () => {
    assert.equal(shipped.length, 1)
    assert.equal(shipped[0]?.status, 'PENDING')
  })

  const newcomer = await prisma.user.findUniqueOrThrow({
    where: { email: NEWCOMER_EMAIL },
    select: { id: true },
  })

  check('and it names the account this very call opened', () => {
    assert.equal(shipped[0]?.referredUserId, newcomer.id)
  })

  // The newcomer converts: they pay a real invoice over the floor.
  await prisma.invoice.create({
    data: {
      userId: newcomer.id,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
      amountRemainingCents: 0,
      subtotalCents: 18_000,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: new Date(),
      paidAt: new Date(),
    },
    select: { id: true },
  })

  const creditedCents = await sweep()
  const inviterBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the sweep pays the inviter, exactly as the programme intends', () => {
    assert.equal(creditedCents, REWARD_CENTS)
    assert.equal(inviterBalanceCents, REWARD_CENTS)
  })

  // --- the transcription check -------------------------------------------
  const legacyCodeId = await stage()

  await legacyRequestConsultation({
    sessionUserId: null,
    fullName: 'M. Quist',
    email: NEWCOMER_EMAIL,
    preferredContactMethod: 'EMAIL',
    source: 'REFERRAL',
    referralCode: CODE,
  })

  const legacy = await redemptionsForCode(legacyCodeId)

  check(
    'the pre-fix transcription still writes the same row for a new address',
    () => {
      assert.equal(legacy.length, shipped.length)
      assert.equal(legacy[0]?.status, shipped[0]?.status)
      assert.equal(legacy[0]?.rewardCents, shipped[0]?.rewardCents)
    }
  )

  note(
    'so scenario 1 is measuring the defect, not a fixture that has drifted away from it.'
  )
}

// =============================================================================
// 6. Scenario 5 — a signed-in caller
// =============================================================================

/**
 * A signed-in caller quoting a code is refused too, and is meant to be.
 *
 * Their identity is `matched` — a session proves they own the account, not that
 * it is new — and the audited way for an account that already exists to accept
 * an invitation is `redeemReferralCode`, which applies the expiry message, the
 * owner-identity check, `sharesEmailIdentity`, and the one-live-redemption
 * rule. This asserts the silent second door is shut and the audited one is open.
 */
async function scenarioSignedInCaller(): Promise<void> {
  section('5. a signed-in caller quoting a code on the public form')

  const codeId = await stage()

  signInAs(PATRON)

  const posted = await requestConsultation(
    consultationPayload({ email: PATRON_EMAIL, referralCode: CODE })
  )

  signInAs(null)

  const attached = await redemptionsForCode(codeId)

  check('the enquiry is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('but no redemption is written by this path', () => {
    assert.deepEqual(attached, [])
  })

  check('the identified caller does get their row identifiers back', () => {
    assert.equal(posted.ok, true)
    assert.notEqual(
      posted.ok ? posted.data.consultationInterviewId : null,
      null
    )
  })

  note('the audited door — redeemReferralCode — is the one that stays open.')
}

// =============================================================================
// 7. The report
// =============================================================================

function printReport(before: ExploitOutcome, after: ExploitOutcome): void {
  printTable(
    'An unauthenticated stranger posts a paying household’s address with their own code',
    [
      ['', 'pre-fix', 'shipped'],
      [
        'redemptions written',
        String(before.redeemedFor.length),
        String(after.redeemedFor.length),
      ],
      [
        'named as referee',
        before.redeemedFor.includes(PATRON.id) ? 'the patron' : '—',
        after.redeemedFor.includes(PATRON.id) ? 'the patron' : '—',
      ],
      [
        'credited by the sweep',
        money(before.creditedCents),
        money(after.creditedCents),
      ],
      [
        'attacker’s balance',
        money(before.attackerBalanceCents),
        money(after.attackerBalanceCents),
      ],
    ],
    '  Both columns are the same database, the same seeded rows, the same\n' +
      '  settlement sweep and the same minted code. The only difference is\n' +
      '  whether the code that resolved the identity reported where it came from.'
  )
}

// =============================================================================
// 8. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log(
    'MCV-040 finding A — a referral may not name a household you merely guessed'
  )
  console.log(`database: ${name}`)

  const before = await scenarioLegacy()
  const after = await scenarioFixedConsultation()

  await scenarioFixedProspectIntake()
  await scenarioNoFalseRefusal()
  await scenarioSignedInCaller()

  printReport(before, after)

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
