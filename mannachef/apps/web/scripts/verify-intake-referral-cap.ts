// mannachef/apps/web/scripts/verify-intake-referral-cap.ts

/**
 * The MCV-040 finding B regression: a code's redemption cap must actually bind
 * on the public intake path.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma db push
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:intake-cap
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable.
 *
 * ## The defect
 *
 * `attachReferral` opened with what looks like a cap:
 *
 * ```ts
 * if (
 *   referral.maxRedemptions !== null &&
 *   referral.redemptionCount >= referral.maxRedemptions
 * ) {
 *   return
 * }
 * ```
 *
 * and then created the redemption **without ever moving `redemptionCount`**.
 * `redeemReferralCode` — the signed-in path into the same table — bumps it with
 * a compare-and-swap on the value it read. This path did not, so the number the
 * comparison consulted was zero for every caller, for ever. A code capped at
 * five accepted an unbounded run of redemptions through the public enquiry
 * form, and an operator reading `redemptionCount` off the growth screen saw a
 * code nobody had used.
 *
 * A comparison against a counter nobody updates is not a control. It is the
 * *appearance* of one, which is worse than nothing: it is why nobody looked.
 *
 * ## Why the cap survived the finding A fix
 *
 * Finding A confined this function to identities it just created, which closes
 * the hijack but leaves the cap live and load-bearing: fresh email addresses
 * are free, so a code capped at five is still a code a scraper can redeem
 * twelve times. The instruction was to delete the check if the fix had made it
 * unreachable. It has not, so it is enforced instead — with the same
 * compare-and-swap `redeemReferralCode` uses, taken *before* the insert and
 * inside the same transaction, so a lost race costs a refused referral rather
 * than a counter that disagrees with the rows.
 *
 * ## The four scenarios
 *
 * | # | Shape                                        | Proves                              |
 * | - | -------------------------------------------- | ----------------------------------- |
 * | 1 | twelve enquiries, pre-fix source, cap 5      | twelve redemptions, counter at zero |
 * | 2 | twelve enquiries, shipped action, cap 5      | five redemptions, counter at five   |
 * | 3 | four *simultaneous* enquiries, cap 2         | the cap holds under concurrency     |
 * | 4 | three enquiries, no cap at all               | an open code is not throttled       |
 */

import assert from 'node:assert/strict'

import { requestConsultation } from '@/server/actions/intake'
import { createReferralCode } from '@/server/actions/referral'
import { prisma } from '@/server/db'

import { legacyRequestConsultation } from './fixtures/intake-legacy'
import { signInAs } from './fixtures/harness-state'
import {
  ATTACKER,
  assertDisposableDatabase,
  check,
  checkCount,
  clearRateLimits,
  consultationPayload,
  disconnect,
  note,
  printTable,
  redemptionCountOf,
  redemptionsForCode,
  resetDatabase,
  section,
  seedHousehold,
  seedProgram,
} from './fixtures/intake-harness'

// =============================================================================
// 1. The figures
// =============================================================================

const REWARD_CENTS = 5_000
const FLOOR_CENTS = 10_000
const CODE = 'AUTUMN25'

/** The cap the finding was demonstrated against. */
const CAP = 5

/** How many enquiries the finding put through it. */
const ATTEMPTS = 12

// =============================================================================
// 2. Staging
// =============================================================================

/**
 * A standing offer whose codes carry `cap`, and one code minted from it by an
 * ordinary `CLIENT` through the real `createReferralCode`.
 *
 * `defaultMaxRedemptions` rather than a stated `maxRedemptions`, because below
 * `ADMIN` the payload's figure is discarded (MCV-030) and the programme's is
 * what a client-minted code actually carries. Staging it any other way would
 * be staging a code the platform cannot produce.
 */
async function stage(cap: number | null): Promise<string> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
    defaultMaxRedemptions: cap,
  })

  await seedHousehold({ person: ATTACKER, status: 'PROSPECT' })

  signInAs(ATTACKER)

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: REWARD_CENTS,
    ownerId: ATTACKER.id,
    code: CODE,
    isActive: true,
  })

  signInAs(null)
  clearRateLimits()

  assert.equal(
    minted.ok,
    true,
    `the code could not be minted: ${minted.ok ? '' : minted.error}`
  )

  const row = await prisma.referralCode.findUniqueOrThrow({
    where: { code: CODE },
    select: { id: true, maxRedemptions: true, redemptionCount: true },
  })

  assert.equal(row.maxRedemptions, cap, 'the code should carry the cap')
  assert.equal(
    row.redemptionCount,
    0,
    'a fresh code has been redeemed nought times'
  )

  return row.id
}

/** A distinct, previously unknown address. Fresh addresses are what make a cap matter. */
function guestEmail(index: number): string {
  return `guest${index.toString().padStart(2, '0')}@example.org`
}

// =============================================================================
// 3. What each run produced
// =============================================================================

interface CapOutcome {
  readonly attempts: number
  readonly redemptions: number
  readonly counter: number
  /** Distinct households named across all the redemptions written. */
  readonly distinct: number
}

async function readOutcome(
  codeId: string,
  attempts: number
): Promise<CapOutcome> {
  const rows = await redemptionsForCode(codeId)

  return {
    attempts,
    redemptions: rows.length,
    counter: await redemptionCountOf(codeId),
    distinct: new Set(rows.map((row) => row.referredUserId)).size,
  }
}

function describe(outcome: CapOutcome): string {
  return (
    `${String(outcome.attempts)} enquiries → ` +
    `${String(outcome.redemptions)} redemptions, ` +
    `redemptionCount = ${String(outcome.counter)}`
  )
}

// =============================================================================
// 4. Scenario 1 — twelve enquiries against the pre-fix source
// =============================================================================

async function scenarioLegacy(): Promise<CapOutcome> {
  section('1. twelve enquiries against the pre-fix source, cap 5')

  const codeId = await stage(CAP)

  for (let index = 1; index <= ATTEMPTS; index += 1) {
    await legacyRequestConsultation({
      sessionUserId: null,
      fullName: `Guest ${String(index)}`,
      email: guestEmail(index),
      preferredContactMethod: 'EMAIL',
      source: 'REFERRAL',
      referralCode: CODE,
    })
  }

  const outcome = await readOutcome(codeId, ATTEMPTS)

  check('every one of the twelve attaches succeeds', () => {
    assert.equal(outcome.redemptions, ATTEMPTS)
  })

  check('all twelve name different households', () => {
    assert.equal(outcome.distinct, ATTEMPTS)
  })

  check('and redemptionCount is still zero', () => {
    assert.equal(outcome.counter, 0)
  })

  note(describe(outcome))
  note(
    `the cap said ${String(CAP)}; the growth screen said nobody had used the code at all.`
  )

  return outcome
}

// =============================================================================
// 5. Scenario 2 — the same twelve against the shipped action
// =============================================================================

async function scenarioFixed(): Promise<CapOutcome> {
  section('2. the same twelve against the shipped requestConsultation, cap 5')

  const codeId = await stage(CAP)

  let accepted = 0

  for (let index = 1; index <= ATTEMPTS; index += 1) {
    // The public form is throttled at five an hour per IP and every caller
    // here shares one bucket; the limiter is not what this scenario is about.
    clearRateLimits()

    const posted = await requestConsultation(
      consultationPayload({
        email: guestEmail(index),
        fullName: `Guest ${String(index)}`,
        referralCode: CODE,
      })
    )

    if (posted.ok) {
      accepted += 1
    }
  }

  const outcome = await readOutcome(codeId, ATTEMPTS)

  check(
    'all twelve enquiries are still accepted — the form is not an oracle',
    () => {
      assert.equal(accepted, ATTEMPTS)
    }
  )

  check('but only five redemptions are written', () => {
    assert.equal(outcome.redemptions, CAP)
  })

  check('and redemptionCount agrees with the rows', () => {
    assert.equal(outcome.counter, CAP)
  })

  check('the five name five different households', () => {
    assert.equal(outcome.distinct, CAP)
  })

  const households = await prisma.user.count({
    where: { email: { endsWith: '@example.org' } },
  })

  check('and all twelve guests still got their consultation', () => {
    assert.equal(households, ATTEMPTS)
  })

  note(describe(outcome))

  return outcome
}

// =============================================================================
// 6. Scenario 3 — the cap under concurrency
// =============================================================================

/** Four at once against a cap of two. Within the five-per-hour bucket. */
const CONCURRENT = 4
const SMALL_CAP = 2

/**
 * Four enquiries arriving at the same instant, for a code with two places left.
 *
 * A cap enforced by "read the counter, decide, then write" is not a cap; it is
 * a race with a comment on it. The compare-and-swap is conditioned on the exact
 * value that was read, so a transaction whose counter moved underneath it
 * updates nothing, sees `count !== 1`, and attaches nothing — silently, which
 * is this function's whole contract with a public caller.
 *
 * `Promise.all` here is genuinely concurrent: each call opens its own Prisma
 * interactive transaction on its own pooled connection, so these are four
 * PostgreSQL backends contending for one `ReferralCode` row.
 */
async function scenarioConcurrent(): Promise<void> {
  section('3. four simultaneous enquiries against a cap of two')

  const codeId = await stage(SMALL_CAP)

  const posted = await Promise.all(
    Array.from({ length: CONCURRENT }, (_unused, index) =>
      requestConsultation(
        consultationPayload({
          email: guestEmail(100 + index),
          fullName: `Guest ${String(100 + index)}`,
          referralCode: CODE,
        })
      )
    )
  )

  const outcome = await readOutcome(codeId, CONCURRENT)

  check('all four enquiries are accepted', () => {
    assert.equal(
      posted.filter((result) => result.ok).length,
      CONCURRENT,
      posted.map((result) => (result.ok ? 'ok' : result.code)).join(' / ')
    )
  })

  check('the cap is not exceeded', () => {
    assert.ok(
      outcome.redemptions <= SMALL_CAP,
      `${String(outcome.redemptions)} redemptions against a cap of ${String(SMALL_CAP)}`
    )
  })

  check('the counter and the rows do not disagree', () => {
    assert.equal(outcome.counter, outcome.redemptions)
  })

  check('no household is named twice', () => {
    assert.equal(outcome.distinct, outcome.redemptions)
  })

  note(describe(outcome))
  note(
    'a lost compare-and-swap costs a referral, never a counter out of step with the table.'
  )
}

// =============================================================================
// 7. Scenario 4 — an open-ended code must not be throttled
// =============================================================================

/**
 * `maxRedemptions: null` means "open until it is withdrawn".
 *
 * A fix that enforced a cap by refusing everything after the first redemption
 * would pass scenarios 2 and 3 and would have broken every uncapped code on the
 * platform. This asks for three and insists on three.
 */
async function scenarioUncapped(): Promise<void> {
  section('4. three enquiries against a code with no cap at all')

  const codeId = await stage(null)

  for (let index = 1; index <= 3; index += 1) {
    clearRateLimits()

    await requestConsultation(
      consultationPayload({
        email: guestEmail(200 + index),
        fullName: `Guest ${String(200 + index)}`,
        referralCode: CODE,
      })
    )
  }

  const outcome = await readOutcome(codeId, 3)

  check('all three redemptions are written', () => {
    assert.equal(outcome.redemptions, 3)
  })

  check('and the counter tracks them, cap or no cap', () => {
    assert.equal(outcome.counter, 3)
  })

  note(describe(outcome))
}

// =============================================================================
// 8. The report
// =============================================================================

function printReport(before: CapOutcome, after: CapOutcome): void {
  printTable(
    `Twelve public enquiries quoting one code capped at ${String(CAP)}`,
    [
      ['', 'pre-fix', 'shipped'],
      ['enquiries posted', String(before.attempts), String(after.attempts)],
      [
        'redemptions written',
        String(before.redemptions),
        String(after.redemptions),
      ],
      ['redemptionCount', String(before.counter), String(after.counter)],
      [
        'cap honoured',
        before.redemptions <= CAP ? 'yes' : 'no',
        after.redemptions <= CAP ? 'yes' : 'no',
      ],
    ],
    '  Both columns are the same database, the same twelve addresses and the\n' +
      '  same minted code. The only difference is whether the number the cap is\n' +
      '  compared against is a number anybody writes.'
  )
}

// =============================================================================
// 9. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log(
    'MCV-040 finding B — the redemption cap must bind on the public path'
  )
  console.log(`database: ${name}`)

  const before = await scenarioLegacy()
  const after = await scenarioFixed()

  await scenarioConcurrent()
  await scenarioUncapped()

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
