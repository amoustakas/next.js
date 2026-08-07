// mannachef/apps/web/scripts/verify-referral-privilege.ts

/**
 * The MCV-030 regression: a `CLIENT` may not decide what their own invitation
 * code is worth.
 *
 * ```bash
 * pnpm --filter @mannachef/web verify:referral
 * ```
 *
 * Exits non-zero on the first failed assertion.
 *
 * ## The exploit this exists to keep dead
 *
 * `createReferralCode` is `auth: 'SESSION'`. It computed `privileged =
 * hasRoleAtLeast(ctx.user.role, 'ADMIN')`, used it for the `ownerId` check and
 * for nothing else, then wrote `rewardValueCents`, `refereeRewardCents` and
 * `maxRedemptions` straight from the payload. So:
 *
 *  1. an ordinary subscriber posts `{ ownerId: <self>, rewardType:
 *     'FIXED_CREDIT', rewardValueCents: 1_000_000, refereeRewardCents:
 *     1_000_000, maxRedemptions: null }` — a payload `referralCodeCreateSchema`
 *     accepts, because every figure in it is inside the schema's own ceilings;
 *  2. they register a second account by magic link to an inbox they control;
 *  3. that account redeems the code — the self-referral check compares
 *     `code.ownerId` against the *redeeming account's* id, so it does not fire;
 *  4. the second account pays any invoice at all, however small;
 *  5. `settleReferralRedemptions` credits `ownerRewardCents(code, invoice)` —
 *     $10,000 — to the attacker's `RewardBalance`, as a `REFERRAL_REWARD`
 *     ledger entry indistinguishable from one that was earned.
 *
 * ## What this harness proves, and how
 *
 * It drives the **real** Server Actions: the real `withAction` wrapper, the
 * real role check, the real zod schemas, the real handler bodies. Only the
 * session, the database and the three request-scoped Next.js modules are
 * substituted, and they are substituted by `scripts/stub-resolver.mjs` at
 * module resolution — nothing under `src/` knows this file exists, so there is
 * no injection seam here that a caller could also reach.
 *
 * The "before" figures are not asserted from a comment. They are produced by
 * putting the *same hostile payload* through the *same action* as an `ADMIN`,
 * for whom stating a bespoke figure is the intended behaviour: every number in
 * the closing table was written to a row by the code under test.
 *
 * The payloads are typed as the actions' own parameters, so a schema that
 * stopped accepting them would fail `tsc` here rather than quietly leave this
 * file testing nothing.
 */

import assert from 'node:assert/strict'

import {
  createReferralCode,
  redeemReferralCode,
  updateReferralCode,
  updateReferralRedemption,
} from '@/server/actions/referral'
import {
  readReferralProgram,
  updateReferralProgram,
} from '@/server/actions/referral-program'
import type { ActionResult } from '@/server/actions/types'
import {
  NO_PROGRAM_OFFER_MESSAGE,
  PROGRAM_MISCONFIGURED_MESSAGE,
} from '@/server/referral-program'

import type { CallRecord, Row } from './fixtures/fake-db'
import {
  harnessDatabase,
  resetDatabase,
  signInAs,
  type HarnessUser,
} from './fixtures/harness-state'

// =============================================================================
// 0. Reporting
// =============================================================================

let checks = 0
let scenario = ''

function section(title: string): void {
  scenario = title
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

/** Run one assertion block. Throws on failure, naming the scenario. */
function check(label: string, run: () => void): void {
  try {
    run()
    checks += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}`)
    console.error(`  in:  ${scenario}\n`)
    throw error
  }
}

// =============================================================================
// 1. Fixtures
// =============================================================================

const ATTACKER: HarnessUser = {
  id: 'cuserattacker00000000001',
  name: 'Ada Lovelace',
  email: 'ada.lovelace+host@example.com',
  image: null,
  role: 'CLIENT',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: 'cclientattacker000000001',
  staffProfileId: null,
}

const ACCOMPLICE: HarnessUser = {
  ...ATTACKER,
  id: 'cuseraccomplice000000002',
  name: 'A. Lovelace',
  // The same mailbox, spelled so that neither string equality nor the
  // `ownerId === account.id` identity check would notice.
  email: 'adalovelace@example.com',
  clientProfileId: 'cclientaccomplice0000002',
}

const STRANGER: HarnessUser = {
  ...ATTACKER,
  id: 'cuserstranger00000000003',
  name: 'Grace Hopper',
  email: 'grace.hopper@example.org',
  clientProfileId: 'cclientstranger000000003',
}

const ADMIN: HarnessUser = {
  id: 'cuseradmin0000000000004',
  name: 'The Concierge',
  email: 'concierge@mannachef.example',
  image: null,
  role: 'ADMIN',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: null,
  staffProfileId: 'cstaffadmin00000000000004',
}

const OWNER: HarnessUser = {
  ...ADMIN,
  id: 'cuserowner0000000000005',
  role: 'SUPER_ADMIN',
}

/** $10,000 — `MAX_REWARD_CENTS`, the most the schema will accept. */
const HOSTILE_CENTS = 1_000_000

/** The standing offer the house is actually making. */
const PROGRAM = {
  rewardValueCents: 2_500,
  refereeRewardCents: 1_000,
  defaultMaxRedemptions: 5,
  defaultExpiryDays: 30,
  minimumQualifyingInvoiceCents: 5_000,
  currency: 'CAD',
} as const

const DAY_MS = 24 * 60 * 60 * 1_000

/** Ten years out — the expiry the attacker would like their code to carry. */
function hostileExpiry(): Date {
  return new Date(Date.now() + 3_650 * DAY_MS)
}

function hostileCreatePayload(
  ownerId: string
): Parameters<typeof createReferralCode>[0] {
  return {
    ownerId,
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: HOSTILE_CENTS,
    refereeRewardCents: HOSTILE_CENTS,
    maxRedemptions: null,
    currency: 'USD',
    expiresAt: hostileExpiry(),
    label: 'Dinner with friends',
  }
}

/**
 * The amendment, hostile in all seven terms at once.
 *
 * `rewardType` deliberately differs from the stored `FIXED_CREDIT`: a payload
 * that restated the same kind would leave a lapse in the `rewardType` strip
 * invisible, because the wrong answer and the right one would be the same
 * string. `FREE_MEAL` is still a cash-measured reward, so the payload stays
 * coherent and the refusal — if one came — could not be blamed on the pairing
 * rule instead of on the privilege check.
 */
function hostileUpdatePayload(
  id: string
): Parameters<typeof updateReferralCode>[0] {
  return {
    id,
    label: 'Dinner with friends, amended',
    rewardType: 'FREE_MEAL',
    rewardValueCents: HOSTILE_CENTS,
    rewardValuePercent: null,
    refereeRewardCents: HOSTILE_CENTS,
    maxRedemptions: null,
    currency: 'USD',
    expiresAt: hostileExpiry(),
  }
}

/** The seven fields on a code that cost the business money. */
const TERMS = [
  'rewardType',
  'rewardValueCents',
  'rewardValuePercent',
  'refereeRewardCents',
  'currency',
  'maxRedemptions',
  'expiresAt',
] as const

type Term = (typeof TERMS)[number]

// =============================================================================
// 2. Store helpers
// =============================================================================

function seedUsers(...users: readonly HarnessUser[]): void {
  const { store } = harnessDatabase()

  for (const user of users) {
    store.users.push({
      id: user.id,
      name: user.name,
      email: user.email,
      isActive: true,
      role: user.role,
    })
  }
}

function seedProgram(overrides: Row = {}): void {
  const { store } = harnessDatabase()

  store.referralPrograms.push({
    id: 'cprogramdefault000000001',
    key: 'default',
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: PROGRAM.rewardValueCents,
    rewardValuePercent: null,
    currency: PROGRAM.currency,
    refereeRewardCents: PROGRAM.refereeRewardCents,
    defaultMaxRedemptions: PROGRAM.defaultMaxRedemptions,
    defaultExpiryDays: PROGRAM.defaultExpiryDays,
    minimumQualifyingInvoiceCents: PROGRAM.minimumQualifyingInvoiceCents,
    isActive: true,
    updatedById: OWNER.id,
    updatedAt: new Date(),
    ...overrides,
  })
}

/** The persisted row, read out of the store rather than off the returned view. */
function storedCode(id: string): Row {
  const row = harnessDatabase().store.referralCodes.find(
    (candidate) => candidate['id'] === id
  )

  assert.ok(row !== undefined, `no ReferralCode row ${id} was written`)

  return row
}

function expectOk<T>(result: ActionResult<T>): T {
  assert.ok(
    result.ok,
    result.ok ? '' : `expected success, got ${result.code}: ${result.error}`
  )

  return result.data
}

function expectFail<T>(result: ActionResult<T>): {
  readonly code: string
  readonly error: string
} {
  assert.ok(!result.ok, 'expected a refusal, got a success')

  return { code: result.code, error: result.error }
}

function begin(): void {
  resetDatabase()
  signInAs(null)
}

function lastInvoiceLookup(calls: readonly CallRecord[]): CallRecord {
  const lookups = calls.filter(
    (call) => call.model === 'invoice' && call.method === 'findFirst'
  )
  const last = lookups.at(-1)

  assert.ok(last !== undefined, 'no invoice lookup was recorded')

  return last
}

// =============================================================================
// 3. The table the run prints
// =============================================================================

const report: Record<string, Record<Term, string>> = {}

function recordTerms(column: string, row: Row): void {
  const cells: Record<string, string> = {}

  for (const field of TERMS) {
    const value = row[field]
    cells[field] = value instanceof Date ? value.toISOString() : String(value)
  }

  report[column] = cells as Record<Term, string>
}

// =============================================================================
// 4. Scenarios
// =============================================================================

async function scenarioClientCreate(): Promise<void> {
  section('1. create — CLIENT: the payload’s figures are discarded')

  begin()
  seedUsers(ATTACKER)
  seedProgram()
  signInAs(ATTACKER)

  const payload = hostileCreatePayload(ATTACKER.id)

  recordTerms('asked for', {
    rewardType: payload.rewardType,
    rewardValueCents: HOSTILE_CENTS,
    rewardValuePercent: null,
    refereeRewardCents: HOSTILE_CENTS,
    currency: 'USD',
    maxRedemptions: null,
    expiresAt: hostileExpiry(),
  })

  const mintedAt = Date.now()
  const summary = expectOk(await createReferralCode(payload))
  const row = storedCode(summary.id)

  recordTerms('CLIENT create', row)

  check('the code was minted, in the caller’s own name', () => {
    assert.equal(row['ownerId'], ATTACKER.id)
    assert.match(String(row['code']), /^[A-Z0-9]{6,12}$/)
  })

  check(
    `rewardValueCents is the programme’s ${PROGRAM.rewardValueCents}, not ${HOSTILE_CENTS}`,
    () => {
      assert.equal(row['rewardValueCents'], PROGRAM.rewardValueCents)
      assert.notEqual(row['rewardValueCents'], HOSTILE_CENTS)
    }
  )

  check(
    `refereeRewardCents is the programme’s ${PROGRAM.refereeRewardCents}, not ${HOSTILE_CENTS}`,
    () => {
      assert.equal(row['refereeRewardCents'], PROGRAM.refereeRewardCents)
      assert.notEqual(row['refereeRewardCents'], HOSTILE_CENTS)
    }
  )

  check(
    `maxRedemptions is the programme’s ${PROGRAM.defaultMaxRedemptions}, not uncapped`,
    () => {
      assert.equal(row['maxRedemptions'], PROGRAM.defaultMaxRedemptions)
      assert.notEqual(row['maxRedemptions'], null)
    }
  )

  check('currency is the programme’s CAD, not the payload’s USD', () => {
    assert.equal(row['currency'], PROGRAM.currency)
  })

  check('rewardValuePercent stays null on a cash reward', () => {
    assert.equal(row['rewardValuePercent'], null)
  })

  check(
    `expiresAt is ${PROGRAM.defaultExpiryDays} days out, not ten years`,
    () => {
      const expiresAt = row['expiresAt']
      assert.ok(expiresAt instanceof Date)

      const days = (expiresAt.getTime() - mintedAt) / DAY_MS
      assert.ok(
        Math.abs(days - PROGRAM.defaultExpiryDays) < 0.01,
        `expiry is ${days} days out`
      )
    }
  )

  check('the fields that cost nothing are still the caller’s', () => {
    assert.equal(row['label'], 'Dinner with friends')
    assert.equal(row['isActive'], true)
  })
}

async function scenarioAdminCreate(): Promise<void> {
  section('2. create — ADMIN: the same payload is honoured (the “before”)')

  begin()
  seedUsers(ATTACKER, ADMIN)
  seedProgram()
  signInAs(ADMIN)

  const summary = expectOk(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )
  const row = storedCode(summary.id)

  recordTerms('ADMIN create', row)

  check(
    `an ADMIN still writes ${HOSTILE_CENTS} — the figures are theirs to state`,
    () => {
      assert.equal(row['rewardValueCents'], HOSTILE_CENTS)
      assert.equal(row['refereeRewardCents'], HOSTILE_CENTS)
      assert.equal(row['maxRedemptions'], null)
      assert.equal(row['currency'], 'USD')
    }
  )

  check('…and it is issued in the subscriber’s name, as an admin may', () => {
    assert.equal(row['ownerId'], ATTACKER.id)
  })
}

async function scenarioNoOffer(): Promise<void> {
  section('3. create — CLIENT: refused when there is no offer to copy')

  begin()
  seedUsers(ATTACKER)
  seedProgram({ isActive: false })
  signInAs(ATTACKER)

  const withdrawn = expectFail(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )

  check('a withdrawn programme refuses, with its own sentence', () => {
    assert.equal(withdrawn.code, 'CONFLICT')
    assert.equal(withdrawn.error, NO_PROGRAM_OFFER_MESSAGE)
    assert.equal(harnessDatabase().store.referralCodes.length, 0)
  })

  begin()
  seedUsers(ATTACKER)
  signInAs(ATTACKER)

  const absent = expectFail(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )

  check('an unconfigured platform refuses the same way', () => {
    assert.equal(absent.code, 'CONFLICT')
    assert.equal(absent.error, NO_PROGRAM_OFFER_MESSAGE)
    assert.equal(harnessDatabase().store.referralCodes.length, 0)
  })

  begin()
  seedUsers(ATTACKER)
  seedProgram({ rewardValueCents: null })
  signInAs(ATTACKER)

  const broken = expectFail(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )

  check('an offer whose figures do not pair up refuses, and says so', () => {
    assert.equal(broken.code, 'CONFLICT')
    assert.equal(broken.error, PROGRAM_MISCONFIGURED_MESSAGE)
    assert.equal(harnessDatabase().store.referralCodes.length, 0)
  })

  begin()
  seedUsers(ATTACKER, ADMIN)
  seedProgram({ isActive: false })
  signInAs(ADMIN)

  const admin = expectOk(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )

  check('an ADMIN is not blocked by a withdrawn programme', () => {
    assert.equal(storedCode(admin.id)['rewardValueCents'], HOSTILE_CENTS)
  })
}

async function scenarioClientUpdate(codeId: string): Promise<void> {
  section('4. update — CLIENT: the figures cannot be raised afterwards')

  signInAs(ATTACKER)

  const before: Row = { ...storedCode(codeId) }
  const summary = expectOk(
    await updateReferralCode(hostileUpdatePayload(codeId))
  )
  const after = storedCode(codeId)

  recordTerms('CLIENT update', after)

  check('the amendment succeeded rather than erroring', () => {
    assert.equal(summary.id, codeId)
  })

  for (const field of TERMS) {
    check(`${field} is unchanged`, () => {
      const left = before[field]
      const right = after[field]

      if (left instanceof Date) {
        assert.ok(right instanceof Date)
        assert.equal(right.getTime(), left.getTime())

        return
      }

      assert.equal(right, left)
    })
  }

  check('rewardValueCents is still the programme’s', () => {
    assert.equal(after['rewardValueCents'], PROGRAM.rewardValueCents)
    assert.notEqual(after['rewardValueCents'], HOSTILE_CENTS)
  })

  check('…and the reward has not changed kind either', () => {
    assert.equal(after['rewardType'], 'FIXED_CREDIT')
    assert.notEqual(after['rewardType'], 'FREE_MEAL')
  })

  check('the label — which costs nothing — was applied', () => {
    assert.equal(after['label'], 'Dinner with friends, amended')
  })

  // The ownership and session guards are not what MCV-030 changed; they are
  // asserted here so that a future refactor of the privilege branch cannot
  // quietly swallow one of them on the way past.
  signInAs(STRANGER)
  const foreign = expectFail(
    await updateReferralCode(hostileUpdatePayload(codeId))
  )

  check('a stranger amending it is refused by the ownership guard', () => {
    assert.equal(foreign.code, 'NOT_FOUND')
    assert.equal(
      storedCode(codeId)['rewardValueCents'],
      PROGRAM.rewardValueCents
    )
  })

  signInAs(null)
  const anonymous = expectFail(
    await updateReferralCode(hostileUpdatePayload(codeId))
  )

  check('a signed-out caller never reaches the handler', () => {
    assert.equal(anonymous.code, 'UNAUTHENTICATED')
  })
}

async function scenarioAdminUpdate(codeId: string): Promise<void> {
  section('5. update — ADMIN: the same amendment lands (the “before”)')

  seedUsers(ADMIN)
  signInAs(ADMIN)

  expectOk(await updateReferralCode(hostileUpdatePayload(codeId)))
  const after = storedCode(codeId)

  recordTerms('ADMIN update', after)

  check(`an ADMIN raises it to ${HOSTILE_CENTS} and uncaps it`, () => {
    assert.equal(after['rewardType'], 'FREE_MEAL')
    assert.equal(after['rewardValueCents'], HOSTILE_CENTS)
    assert.equal(after['refereeRewardCents'], HOSTILE_CENTS)
    assert.equal(after['maxRedemptions'], null)
    assert.equal(after['currency'], 'USD')
  })
}

async function scenarioProgramActions(): Promise<void> {
  section('6. the programme itself — ADMIN reads, SUPER_ADMIN writes')

  begin()
  seedUsers(ATTACKER, ADMIN, OWNER)

  const offer: Parameters<typeof updateReferralProgram>[0] = {
    key: 'default',
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: PROGRAM.rewardValueCents,
    currency: PROGRAM.currency,
    refereeRewardCents: PROGRAM.refereeRewardCents,
    defaultMaxRedemptions: PROGRAM.defaultMaxRedemptions,
    defaultExpiryDays: PROGRAM.defaultExpiryDays,
    minimumQualifyingInvoiceCents: PROGRAM.minimumQualifyingInvoiceCents,
    isActive: true,
  }

  signInAs(ATTACKER)
  const clientRead = expectFail(await readReferralProgram({}))
  const clientWrite = expectFail(
    await updateReferralProgram({ ...offer, rewardValueCents: HOSTILE_CENTS })
  )

  check('a CLIENT may neither read nor set the offer', () => {
    assert.equal(clientRead.code, 'FORBIDDEN')
    assert.equal(clientWrite.code, 'FORBIDDEN')
    assert.equal(harnessDatabase().store.referralPrograms.length, 0)
  })

  signInAs(ADMIN)
  const adminWrite = expectFail(
    await updateReferralProgram({ ...offer, rewardValueCents: HOSTILE_CENTS })
  )
  const adminRead = expectOk(await readReferralProgram({}))

  check('an ADMIN may read it but not set it — that is finance', () => {
    assert.equal(adminWrite.code, 'FORBIDDEN')
    assert.equal(harnessDatabase().store.referralPrograms.length, 0)
    assert.equal(adminRead, null)
  })

  signInAs(OWNER)
  const written = expectOk(await updateReferralProgram(offer))
  const stored = harnessDatabase().store.referralPrograms.at(0)

  check('a SUPER_ADMIN sets the offer, and it is attributed to them', () => {
    assert.equal(written.rewardValueCents, PROGRAM.rewardValueCents)
    assert.equal(written.isCoherent, true)
    assert.ok(stored !== undefined)
    assert.equal(stored['updatedById'], OWNER.id)
  })

  signInAs(ATTACKER)
  const minted = expectOk(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )

  check('the offer just written is the one a CLIENT’s code copies', () => {
    assert.equal(
      storedCode(minted.id)['rewardValueCents'],
      PROGRAM.rewardValueCents
    )
  })
}

async function scenarioSelfReferralAndFloor(): Promise<void> {
  section('7. the two subsidiary rules — same mailbox, and the invoice floor')

  begin()
  seedUsers(ATTACKER, ACCOMPLICE, STRANGER, ADMIN)
  seedProgram()
  signInAs(ATTACKER)

  const summary = expectOk(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )
  const code = String(storedCode(summary.id)['code'])

  signInAs(ACCOMPLICE)
  const alias = expectFail(await redeemReferralCode({ code }))

  check('a second account on the owner’s own mailbox is refused', () => {
    assert.equal(alias.code, 'VALIDATION')
    assert.match(alias.error, /same household/)
    assert.equal(harnessDatabase().store.referralRedemptions.length, 0)
  })

  signInAs(STRANGER)
  const accepted = expectOk(await redeemReferralCode({ code }))

  check('a genuine third party is not caught by the deterrent', () => {
    assert.equal(accepted.status, 'PENDING')
  })

  const { store, calls } = harnessDatabase()
  const redemption = store.referralRedemptions.at(0)

  assert.ok(redemption !== undefined, 'the redemption was not written')

  store.invoices.push({
    id: 'cinvoicetrivial000000001',
    userId: STRANGER.id,
    status: 'PAID',
    amountPaidCents: 100,
    currency: 'CAD',
    paidAt: new Date('2026-01-05T12:00:00Z'),
  })

  signInAs(ADMIN)
  const trivial = expectFail(
    await updateReferralRedemption({
      action: 'QUALIFY',
      redemptionId: String(redemption['id']),
    })
  )

  check(
    `a $1 invoice does not clear the $${PROGRAM.minimumQualifyingInvoiceCents / 100} floor`,
    () => {
      assert.equal(trivial.code, 'CONFLICT')
      assert.match(trivial.error, /no paid invoice yet/)
      assert.equal(redemption['status'], 'PENDING')
    }
  )

  check('…and the floor was in the query, not merely in a comment', () => {
    const where = lastInvoiceLookup(calls).args['where']

    assert.ok(where !== null && typeof where === 'object')
    assert.deepEqual((where as Row)['amountPaidCents'], {
      gte: PROGRAM.minimumQualifyingInvoiceCents,
    })
  })

  const qualifyingPaidAt = new Date('2026-02-14T19:30:00Z')

  store.invoices.push({
    id: 'cinvoicedinner0000000002',
    userId: STRANGER.id,
    status: 'PAID',
    amountPaidCents: 50_000,
    currency: 'CAD',
    paidAt: qualifyingPaidAt,
  })

  const qualified = expectOk(
    await updateReferralRedemption({
      action: 'QUALIFY',
      redemptionId: String(redemption['id']),
    })
  )
  const qualifiedAt = qualified.qualifiedAt

  check('a $500 invoice does, and dates the referral to that invoice', () => {
    assert.equal(qualified.status, 'QUALIFIED')
    assert.ok(qualifiedAt !== null)
    assert.equal(qualifiedAt.getTime(), qualifyingPaidAt.getTime())
  })
}

// =============================================================================
// 5. Run
// =============================================================================

function printReport(): void {
  const columns = Object.keys(report)
  const header = ['field', ...columns]
  const body = TERMS.map((field) => [
    field,
    ...columns.map((column) => report[column]?.[field] ?? '—'),
  ])
  const rows = [header, ...body]
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length))
  )
  const rule = widths.map((width) => '-'.repeat(width)).join('  ')

  console.log('\nWhat was asked for, and what was written\n')

  for (const [index, row] of rows.entries()) {
    console.log(
      `  ${header
        .map((_, column) => (row[column] ?? '').padEnd(widths[column] ?? 0))
        .join('  ')}`
    )

    if (index === 0) {
      console.log(`  ${rule}`)
    }
  }

  console.log(
    '\n  “asked for” is the create payload. The amendment asks for the same' +
      '\n  figures and additionally for rewardType FREE_MEAL, so that a lapse in' +
      '\n  the rewardType strip cannot hide behind an unchanged value.'
  )
}

async function main(): Promise<void> {
  console.log('MCV-030 — a CLIENT may not price their own invitation')

  await scenarioClientCreate()
  await scenarioAdminCreate()
  await scenarioNoOffer()

  // 4 and 5 amend a code the CLIENT minted, so scenario 1 is set up again.
  begin()
  seedUsers(ATTACKER, STRANGER)
  seedProgram()
  signInAs(ATTACKER)

  const minted = expectOk(
    await createReferralCode(hostileCreatePayload(ATTACKER.id))
  )

  await scenarioClientUpdate(minted.id)
  await scenarioAdminUpdate(minted.id)

  await scenarioProgramActions()
  await scenarioSelfReferralAndFloor()

  printReport()

  console.log(`\nPASS — ${checks} assertions, 0 failures.`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
