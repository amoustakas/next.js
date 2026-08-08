// mannachef/apps/web/scripts/verify-mcv051.ts

/**
 * MCV-051 — a referral is paid on money the invitation brought in, and never on
 * revenue the house already had.
 *
 * ```bash
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter @mannachef/web verify:mcv051
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied at the start of each scenario**, so it refuses to run unless the
 * database name looks disposable — see `assertDisposableDatabase`.
 *
 * ## What this drives
 *
 * The **real** Server Actions and the **real** Stripe webhook route against a
 * **real** PostgreSQL, through `scripts/action-resolver.mjs`: the real
 * `withAction` wrapper, the real role checks, the real zod schemas, the real
 * handler bodies, the real Prisma client, and the real `CHECK` constraints from
 * `prisma/migrations`. Only the session and the three request-scoped Next.js
 * modules are substituted, at module resolution, so nothing under `src/` knows
 * this file exists.
 *
 * A real database is not optional here. Half of the fix is a `WHERE` clause and
 * the rest of it is one `CHECK` constraint, and a harness pointed at a fake
 * would be evidence about the fake's author rather than about PostgreSQL.
 *
 * ## The finding
 *
 * `findQualifyingInvoice` searched a referred household's **entire** billing
 * history: `{ userId, status: 'PAID', paidAt: { not: null }, amountPaidCents:
 * { gte: floor, gt: 0 } }`, ordered `paidAt ASC`, with no lower bound tied to
 * the redemption. Its docblock argued *for* that — "a household with a long
 * billing history qualifies on the invoice that actually converted them" —
 * which is exactly backwards for a household that had already been converted:
 * for them the earliest invoice is the one furthest from having anything to do
 * with the referral. `resolveRedemptionEligibility`, for its part, had no rule
 * against an existing customer at all.
 *
 * So an `ACTIVE_SUBSCRIBER` whose only invoice was paid two years ago could
 * sign in, redeem a code minted this morning, and the next sweep would report
 * `{examined: 1, qualified: 1, rewarded: 1, creditedCents: 5000}` against that
 * two-year-old invoice. Two existing customers redeeming each other's codes
 * were both paid. The whole customer base could be farmed once each, out of
 * revenue the house had already booked — and MCV-043's economics invariant,
 * whose premise is that a referred household costs a *new* paid invoice to
 * manufacture, was defeated at its root rather than at its arithmetic.
 *
 * ## The fix, and the two rules it is
 *
 * One moment — `ReferralRedemption.qualifyingFromAt`, when the invitation was
 * accepted — and two rules that are duals around it:
 *
 *  1. **Settlement.** `findQualifyingInvoice` takes the anchor and puts
 *     `paidAt >= it` in the `WHERE` clause. Nothing paid earlier is reachable.
 *  2. **Eligibility.** `resolveRedemptionEligibility` refuses a household that
 *     had already paid us before that moment, with `ALREADY_A_CUSTOMER`, unless
 *     the standing offer says a win-back is the point
 *     (`ReferralProgram.allowExistingCustomerReferral`, off by default).
 *
 * ## The eight things this proves
 *
 *  1. **The farm is refused, and it used to work.** The "before" figure is
 *     produced by *running* the pre-fix query
 *     (`fixtures/referral-legacy.ts`), not by asserting a comment.
 *  2. **Two colluding existing customers are refused both ways.**
 *  3. **A genuine new-customer referral still qualifies and still pays.**
 *  4. **The boundary is exact and it is a bound, not a preference.** One second
 *     before does not qualify; one second after does; the same instant does.
 *  5. **The Checkout race is handled.** The ordinary new-customer referral
 *     through Stripe writes its redemption *after* the payment that converts
 *     them. It still pays, because the anchor that path stores is when the
 *     session was opened — and a household that had paid us before *that* is
 *     still refused.
 *  6. **A win-back is an explicit decision, and still buys nothing retroactive.**
 *  7. **PostgreSQL enforces the anchor's floor**, against a write that goes
 *     round the application entirely.
 *  8. **The two hand-driven paths measure the same bound** — the `QUALIFY`
 *     branch of `updateReferralRedemption` and `payReferralReward`, which are
 *     the other two callers of `findQualifyingInvoice` an operator can reach.
 */

import assert from 'node:assert/strict'

import {
  createReferralCode,
  payReferralReward,
  redeemReferralCode,
  settleReferralRedemptions,
  updateReferralRedemption,
} from '@/server/actions/referral'
import { prisma } from '@/server/db'
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route'

import { legacyFindQualifyingInvoice } from './fixtures/referral-legacy'
import { installStripeRecorder } from './fixtures/stripe-recorder'
import { signInAs, type HarnessUser } from './fixtures/harness-state'
import {
  CONCIERGE,
  NEIGHBOUR,
  SUBSCRIBER,
  assertDisposableDatabase,
  balanceCentsOf,
  check,
  checkCount,
  clearRateLimits,
  disconnect,
  money,
  note,
  printTable,
  redemptionCountOf,
  resetDatabase,
  section,
  seedPaidInvoice,
  seedProgram,
  seedUser,
} from './fixtures/billing-harness'

// =============================================================================
// 1. The figures
// =============================================================================

/** What the inviter earns. The figure the finding measured. */
const REWARD_CENTS = 5_000

/**
 * The programme's floor.
 *
 * Comfortably above the reward, so that every offer this harness writes
 * satisfies `ReferralProgram_reward_economics_check` without needing
 * `allowLossLeader`. MCV-043's economics are not what is under test here and an
 * acknowledged loss would only muddy the transcript.
 */
const FLOOR_CENTS = 25_000

/** A real bill, comfortably over the floor. */
const INVOICE_CENTS = 50_000

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const DAY_MS = 24 * 60 * MINUTE_MS
const YEAR_MS = 365 * DAY_MS

const WEBHOOK_SECRET = 'whsec_mannachef_harness_not_a_real_secret'
const APP_ORIGIN = 'https://mannachef.test'

// =============================================================================
// 2. The cast
//
// `SUBSCRIBER`, `NEIGHBOUR` and `CONCIERGE` come from `billing-harness.ts`. The
// rest are declared here, with literal cuids because every id travels through
// `cuidSchema` before an action body is reached, and with genuinely distinct
// mailboxes because `sharesEmailIdentity` would otherwise refuse them for a
// reason that has nothing to do with this task.
// =============================================================================

/** The two-year customer. The account the whole finding is about. */
const PATRON: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cuserpatron00000000051a',
  name: 'Hugo Vasseur',
  email: 'hugo.vasseur@example.org',
  clientProfileId: 'cclientpatron0000000051a',
}

/** The other half of the mutual arrangement. Also an existing customer. */
const COLLUDER: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cusercolluder0000000051b',
  name: 'Ines Bergqvist',
  email: 'ines.bergqvist@example.info',
  clientProfileId: 'cclientcolluder00000051b',
}

/** A household genuinely new to us. The case that must keep working. */
const NEWCOMER: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cusernewcomer0000000051c',
  name: 'Rafael Okonkwo',
  email: 'rafael.okonkwo@example.co',
  clientProfileId: 'cclientnewcomer00000051c',
}

/**
 * The proprietor. `payReferralReward` and the manual `REWARD` branch are
 * `SUPER_ADMIN`, and `billing-harness.ts`'s cast tops out at `ADMIN`.
 */
const OWNER: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cuserowner0000000000051e',
  name: 'The Proprietor',
  email: 'proprietor@mannachef.test',
  role: 'SUPER_ADMIN',
  clientProfileId: null,
}

/** A second newcomer, for the second half of the boundary. */
const NEWCOMER_TWO: HarnessUser = {
  ...SUBSCRIBER,
  id: 'cusernewcomer2000000051d',
  name: 'Saoirse Delacroix',
  email: 'saoirse.delacroix@example.biz',
  clientProfileId: 'cclientnewcomer20000051d',
}

// =============================================================================
// 3. Staging
//
// Built with the raw client and the real `createReferralCode`. The world a
// scenario finds is its premise rather than a thing under test; the code is
// minted through the real action because a code staged any other way would be
// a code the platform cannot produce.
// =============================================================================

interface StagedProgram {
  readonly allowExistingCustomerReferral?: boolean | undefined
}

/** Everyone who ever appears, plus the offer. Returns nothing yet. */
async function stageWorld(program: StagedProgram = {}): Promise<void> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
    allowExistingCustomerReferral: program.allowExistingCustomerReferral,
  })

  for (const person of [
    SUBSCRIBER,
    NEIGHBOUR,
    CONCIERGE,
    OWNER,
    PATRON,
    COLLUDER,
    NEWCOMER,
    NEWCOMER_TWO,
  ]) {
    await seedUser(person)
  }
}

/** Mint one code for `owner` through the real action, and return its id. */
async function mintCodeFor(owner: HarnessUser, code: string): Promise<string> {
  signInAs(owner)
  clearRateLimits()

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    // Stated and discarded: below `ADMIN` the terms are the programme's
    // (MCV-030). What reaches the row is `REWARD_CENTS`.
    rewardValueCents: 1_000_000,
    ownerId: owner.id,
    code,
    isActive: true,
  })

  signInAs(null)

  assert.equal(
    minted.ok,
    true,
    `could not mint ${code}: ${minted.ok ? '' : minted.error}`
  )

  const row = await prisma.referralCode.findUniqueOrThrow({
    where: { code },
    select: { id: true, rewardValueCents: true },
  })

  assert.equal(
    row.rewardValueCents,
    REWARD_CENTS,
    'the minted code should carry the programme figure, not the payload one'
  )

  return row.id
}

/** What one attempt at redemption came back with. */
interface RedeemOutcome {
  readonly ok: boolean
  readonly code: string
  readonly error: string
}

async function redeemAs(
  who: HarnessUser,
  code: string
): Promise<RedeemOutcome> {
  signInAs(who)
  clearRateLimits()

  const result = await redeemReferralCode({ code })

  signInAs(null)

  return result.ok
    ? { ok: true, code: 'OK', error: '' }
    : { ok: false, code: result.code, error: result.error }
}

/** What one pass of the real settlement sweep did. */
interface SweepOutcome {
  readonly examined: number
  readonly qualified: number
  readonly rewarded: number
  readonly creditedCents: number
}

async function sweep(): Promise<SweepOutcome> {
  signInAs(CONCIERGE)
  clearRateLimits()

  const settled = await settleReferralRedemptions({})

  signInAs(null)

  assert.equal(
    settled.ok,
    true,
    `the sweep failed: ${settled.ok ? '' : settled.error}`
  )
  assert.ok(settled.ok)

  return {
    examined: settled.data.examined,
    qualified: settled.data.qualified,
    rewarded: settled.data.rewarded,
    creditedCents: settled.data.creditedCents,
  }
}

/** The one redemption on this household's account, anchor included. */
async function redemptionOf(userId: string): Promise<{
  readonly id: string
  readonly status: string
  readonly qualifiedAt: Date | null
  readonly rewardCents: number | null
  readonly qualifyingFromAt: Date
}> {
  return prisma.referralRedemption.findFirstOrThrow({
    where: { referredUserId: userId },
    select: {
      id: true,
      status: true,
      qualifiedAt: true,
      rewardCents: true,
      qualifyingFromAt: true,
    },
  })
}

async function redemptionCountFor(userId: string): Promise<number> {
  return prisma.referralRedemption.count({ where: { referredUserId: userId } })
}

// =============================================================================
// 4. Scenario 1 — the farm, and what it used to be worth
// =============================================================================

async function scenarioTheFarm(): Promise<void> {
  section('1. an existing customer redeeming a code minted this morning')

  await stageWorld()

  // The premise: one household, one invoice, paid two years ago. Nothing about
  // this row is hostile — it is an ordinary subscriber's ordinary bill.
  const bookedAt = new Date(Date.now() - 2 * YEAR_MS)

  await seedPaidInvoice(PATRON.id, INVOICE_CENTS, bookedAt)

  const codeId = await mintCodeFor(SUBSCRIBER, 'FARMONE1')

  // --- The "before" column, run rather than asserted --------------------

  const legacyMatch = await legacyFindQualifyingInvoice(PATRON.id, FLOOR_CENTS)

  check('the pre-fix query finds the two-year-old invoice', () => {
    assert.ok(legacyMatch !== null)
    assert.equal(legacyMatch.amountPaidCents, INVOICE_CENTS)
    assert.equal(legacyMatch.paidAt.getTime(), bookedAt.getTime())
  })

  note(
    `that invoice is ${money(INVOICE_CENTS)} of revenue the house booked in ${String(bookedAt.getUTCFullYear())},`
  )
  note(
    `and it was the whole of the test that released ${money(REWARD_CENTS)} to the inviter.`
  )

  // --- The shipped eligibility rule ---------------------------------------

  const refused = await redeemAs(PATRON, 'FARMONE1')
  const rowsWritten = await redemptionCountFor(PATRON.id)
  const counter = await redemptionCountOf(codeId)

  check('the household is refused before any row is written', () => {
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'VALIDATION')
    assert.match(refused.error, /already ordered with us/)
  })

  check('…and nothing was written on the way out', () => {
    assert.equal(rowsWritten, 0)
    assert.equal(counter, 0)
  })

  // --- The shipped settlement rule, on its own ----------------------------
  //
  // Written with the raw client so the sweep is tested *independently* of the
  // rule that would have refused this household at the door. This is also
  // exactly the shape of a redemption that predates MCV-051: the backfill in
  // `0005_mcv051_referral_new_money` anchored every historical row to its own
  // `createdAt`, which for a row written now is now.

  const smuggled = await prisma.referralRedemption.create({
    data: {
      referralCodeId: codeId,
      referredUserId: PATRON.id,
      status: 'PENDING',
      currency: 'CAD',
      qualifyingFromAt: new Date(),
    },
    select: { id: true },
  })

  const swept = await sweep()
  const inviterBalance = await balanceCentsOf(SUBSCRIBER.id)
  const afterSweep = await redemptionOf(PATRON.id)

  check('the sweep looks at the smuggled redemption and pays nothing', () => {
    assert.equal(swept.examined, 1)
    assert.equal(swept.qualified, 0)
    assert.equal(swept.rewarded, 0)
    assert.equal(swept.creditedCents, 0)
  })

  check('it is still PENDING, and the inviter has nothing', () => {
    assert.equal(afterSweep.id, smuggled.id)
    assert.equal(afterSweep.status, 'PENDING')
    assert.equal(afterSweep.rewardCents, null)
    assert.equal(inviterBalance, 0)
  })

  printTable(
    'One existing customer, one code minted this morning',
    [
      ['', 'pre-fix', 'shipped'],
      [
        'qualifying invoice found',
        `${money(INVOICE_CENTS)}, paid ${String(bookedAt.getUTCFullYear())}`,
        'none',
      ],
      ['redemption accepted', 'yes', 'no — ALREADY_A_CUSTOMER'],
      ['sweep: qualified', '1', String(swept.qualified)],
      ['credited to the inviter', money(REWARD_CENTS), money(inviterBalance)],
    ],
    '  The pre-fix column is the query in fixtures/referral-legacy.ts run against\n' +
      '  these very rows. Both locks are shown: the household is refused at the door,\n' +
      '  and a row that reaches the sweep anyway is refused the money.'
  )
}

// =============================================================================
// 5. Scenario 2 — two existing customers, each other's codes
// =============================================================================

async function scenarioMutual(): Promise<void> {
  section('2. two existing customers redeeming each other’s invitations')

  await stageWorld()

  const paidLongAgo = new Date(Date.now() - 2 * YEAR_MS)

  await seedPaidInvoice(PATRON.id, INVOICE_CENTS, paidLongAgo)
  await seedPaidInvoice(COLLUDER.id, INVOICE_CENTS, paidLongAgo)

  await mintCodeFor(PATRON, 'MUTUALAA')
  await mintCodeFor(COLLUDER, 'MUTUALBB')

  const first = await redeemAs(COLLUDER, 'MUTUALAA')
  const second = await redeemAs(PATRON, 'MUTUALBB')

  const rows = await prisma.referralRedemption.count({})
  const swept = await sweep()

  check('each is refused the other’s invitation', () => {
    assert.equal(first.ok, false)
    assert.equal(second.ok, false)
    assert.match(first.error, /already ordered with us/)
    assert.match(second.error, /already ordered with us/)
  })

  check('no redemption exists for the sweep to examine', () => {
    assert.equal(rows, 0)
    assert.equal(swept.examined, 0)
    assert.equal(swept.creditedCents, 0)
  })

  note('Neither of them spent anything. That was the point of the arrangement.')
}

// =============================================================================
// 6. Scenario 3 — the programme still works
// =============================================================================

async function scenarioGenuineReferral(): Promise<void> {
  section('3. a household genuinely new to us — the case that must keep paying')

  await stageWorld()

  await mintCodeFor(SUBSCRIBER, 'WELCOME1')

  const accepted = await redeemAs(NEWCOMER, 'WELCOME1')

  check('a newcomer with no billing history is accepted', () => {
    assert.equal(accepted.ok, true)
  })

  const pending = await redemptionOf(NEWCOMER.id)

  check('the redemption is PENDING and carries its own anchor', () => {
    assert.equal(pending.status, 'PENDING')
    assert.ok(pending.qualifyingFromAt instanceof Date)
  })

  const emptySweep = await sweep()

  check('a signup on its own still earns nobody anything', () => {
    assert.equal(emptySweep.examined, 1)
    assert.equal(emptySweep.qualified, 0)
    assert.equal(emptySweep.creditedCents, 0)
  })

  // They convert: a real bill, paid after they accepted the invitation.
  const convertedAt = new Date()

  await seedPaidInvoice(NEWCOMER.id, INVOICE_CENTS, convertedAt)

  const paidSweep = await sweep()
  const settled = await redemptionOf(NEWCOMER.id)
  const inviterBalance = await balanceCentsOf(SUBSCRIBER.id)

  check('their first real invoice qualifies the referral', () => {
    assert.equal(paidSweep.qualified, 1)
    assert.equal(paidSweep.rewarded, 1)
    assert.equal(paidSweep.creditedCents, REWARD_CENTS)
  })

  check('and the inviter is credited exactly the code’s reward', () => {
    assert.equal(settled.status, 'REWARDED')
    assert.equal(settled.rewardCents, REWARD_CENTS)
    assert.equal(settled.qualifiedAt?.getTime(), convertedAt.getTime())
    assert.equal(inviterBalance, REWARD_CENTS)
  })

  note('MCV-051 costs the honest case nothing at all.')
}

// =============================================================================
// 7. Scenario 4 — the boundary, to the second
// =============================================================================

async function scenarioBoundary(): Promise<void> {
  section('4. one second before the anchor, and one second after')

  await stageWorld()
  await mintCodeFor(SUBSCRIBER, 'EDGECAS1')

  // --- One second before --------------------------------------------------

  assert.equal((await redeemAs(NEWCOMER, 'EDGECAS1')).ok, true)

  const anchor = (await redemptionOf(NEWCOMER.id)).qualifyingFromAt
  const justBefore = new Date(anchor.getTime() - SECOND_MS)

  await seedPaidInvoice(NEWCOMER.id, INVOICE_CENTS, justBefore)

  const beforeSweep = await sweep()
  const afterBefore = await redemptionOf(NEWCOMER.id)

  check('an invoice paid one second before the anchor does not qualify', () => {
    assert.equal(beforeSweep.examined, 1)
    assert.equal(beforeSweep.qualified, 0)
    assert.equal(beforeSweep.creditedCents, 0)
    assert.equal(afterBefore.status, 'PENDING')
  })

  // --- One second after ---------------------------------------------------

  const justAfter = new Date(anchor.getTime() + SECOND_MS)

  await seedPaidInvoice(NEWCOMER.id, INVOICE_CENTS, justAfter)

  const afterSweep = await sweep()
  const settled = await redemptionOf(NEWCOMER.id)

  check('an invoice paid one second after it does', () => {
    assert.equal(afterSweep.qualified, 1)
    assert.equal(afterSweep.creditedCents, REWARD_CENTS)
    assert.equal(settled.status, 'REWARDED')
  })

  check(
    '…and the referral is dated by that invoice, not the earlier one',
    () => {
      // This is the assertion that says the rule is a *bound* and not a
      // preference. `findQualifyingInvoice` orders `paidAt ASC`, so had the
      // earlier invoice merely been deprioritised it would still have won.
      assert.equal(settled.qualifiedAt?.getTime(), justAfter.getTime())
      assert.notEqual(settled.qualifiedAt?.getTime(), justBefore.getTime())
    }
  )

  // --- The same instant ---------------------------------------------------

  assert.equal((await redeemAs(NEWCOMER_TWO, 'EDGECAS1')).ok, true)

  const exactAnchor = (await redemptionOf(NEWCOMER_TWO.id)).qualifyingFromAt

  await seedPaidInvoice(NEWCOMER_TWO.id, INVOICE_CENTS, exactAnchor)

  const exactSweep = await sweep()
  const exactSettled = await redemptionOf(NEWCOMER_TWO.id)

  check(
    'an invoice paid in the same instant qualifies — the bound is gte',
    () => {
      assert.equal(exactSweep.qualified, 1)
      assert.equal(exactSettled.status, 'REWARDED')
      assert.equal(exactSettled.qualifiedAt?.getTime(), exactAnchor.getTime())
    }
  )

  printTable(
    'The same invoice, moved by one second',
    [
      ['invoice paidAt', 'relative to the anchor', 'qualifies?'],
      ['anchor − 1s', 'before the invitation', 'no'],
      ['anchor', 'the same instant', 'yes'],
      ['anchor + 1s', 'after the invitation', 'yes'],
    ],
    '  The boundary belongs to the referral, because the Checkout conversion is\n' +
      '  paid in the same breath as the invitation is accepted.'
  )
}

// =============================================================================
// 8. Scenario 5 — the Checkout race, which is why the anchor is not `createdAt`
// =============================================================================

let eventSequence = 0

/**
 * Deliver a genuine `checkout.session.completed` to the real route handler,
 * signed the way Stripe signs one.
 *
 * `created` on the session is the field this scenario is about: it is when the
 * guest opened the session, which is *before* they paid, and it is what
 * `checkoutOpenedAt` in the route turns into the redemption's anchor.
 * `subscription` is left null so the handler's other effect does not run —
 * this scenario is about the redemption.
 */
async function deliverCheckoutCompleted(
  recorder: ReturnType<typeof installStripeRecorder>,
  who: HarnessUser,
  referralCodeId: string,
  sessionOpenedAt: Date
): Promise<number> {
  eventSequence += 1

  const suffix = eventSequence.toString().padStart(6, '0')

  const body = JSON.stringify({
    id: `evt_mcv051${suffix}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1_000),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_mcv051${suffix}`,
        object: 'checkout.session',
        created: Math.floor(sessionOpenedAt.getTime() / 1_000),
        subscription: null,
        client_reference_id: who.id,
        customer: null,
        payment_status: 'paid',
        metadata: {
          mannachefUserId: who.id,
          mannachefReferralCodeId: referralCodeId,
        },
      },
    },
  })

  const response = await stripeWebhook(
    new Request(`${APP_ORIGIN}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': recorder.signPayload(body, WEBHOOK_SECRET),
      },
      body,
    })
  )

  return response.status
}

async function scenarioCheckoutRace(
  recorder: ReturnType<typeof installStripeRecorder>
): Promise<void> {
  section('5. the Checkout path, where the payment precedes the redemption')

  await stageWorld()

  const codeId = await mintCodeFor(SUBSCRIBER, 'CHECKOU1')

  // The ordinary sequence for a household converting through Stripe: the
  // session is opened, they pay, and the two webhooks arrive in whichever order
  // Stripe feels like. Here `invoice.paid` has already been recorded by the
  // time `checkout.session.completed` is handled, which is the arrival order
  // that would have broken a `createdAt` anchor.
  const sessionOpenedAt = new Date(Date.now() - 5 * MINUTE_MS)
  const paidAt = new Date(Date.now() - 2 * MINUTE_MS)

  await seedPaidInvoice(NEWCOMER.id, INVOICE_CENTS, paidAt)

  const status = await deliverCheckoutCompleted(
    recorder,
    NEWCOMER,
    codeId,
    sessionOpenedAt
  )

  check('the webhook acknowledges the delivery', () => {
    assert.equal(status, 200)
  })

  const written = await redemptionOf(NEWCOMER.id)

  check('the conversion invoice does not read as prior custom', () => {
    assert.equal(written.status, 'PENDING')
  })

  check('the anchor is when the session was opened, not when we heard', () => {
    assert.equal(
      Math.floor(written.qualifyingFromAt.getTime() / 1_000),
      Math.floor(sessionOpenedAt.getTime() / 1_000)
    )
    assert.ok(written.qualifyingFromAt.getTime() < paidAt.getTime())
  })

  const swept = await sweep()
  const settled = await redemptionOf(NEWCOMER.id)

  check('and the ordinary Checkout referral is paid', () => {
    assert.equal(swept.qualified, 1)
    assert.equal(swept.creditedCents, REWARD_CENTS)
    assert.equal(settled.qualifiedAt?.getTime(), paidAt.getTime())
  })

  note(
    'Anchored on the redemption row’s own createdAt this would have been refused,'
  )
  note('and only when invoice.paid happened to be delivered first.')

  // --- The contrast: prior custom, through the same door ------------------

  const priorPaidAt = new Date(Date.now() - 2 * YEAR_MS)

  await seedPaidInvoice(COLLUDER.id, INVOICE_CENTS, priorPaidAt)

  const secondStatus = await deliverCheckoutCompleted(
    recorder,
    COLLUDER,
    codeId,
    new Date(Date.now() - 5 * MINUTE_MS)
  )
  const colluderRows = await redemptionCountFor(COLLUDER.id)

  check('an existing customer through the same door writes no row', () => {
    assert.equal(secondStatus, 200)
    assert.equal(colluderRows, 0)
  })

  note(
    'The webhook path applies the whole predicate; it is not a weaker copy of it.'
  )
}

// =============================================================================
// 9. Scenario 6 — the win-back, said out loud
// =============================================================================

async function scenarioWinBack(): Promise<void> {
  section('6. a win-back offer, and what it does not buy')

  // First, the default. Nobody has said anything, so nothing is permitted.
  await stageWorld()

  const defaulted = await prisma.referralProgram.findUniqueOrThrow({
    where: { key: 'default' },
    select: { allowExistingCustomerReferral: true },
  })

  check('an offer that says nothing does not reward a win-back', () => {
    assert.equal(defaulted.allowExistingCustomerReferral, false)
  })

  // Now the offer says so.
  await stageWorld({ allowExistingCustomerReferral: true })

  const lapsedAt = new Date(Date.now() - 2 * YEAR_MS)

  await seedPaidInvoice(PATRON.id, INVOICE_CENTS, lapsedAt)
  await mintCodeFor(SUBSCRIBER, 'WINBACK1')

  const accepted = await redeemAs(PATRON, 'WINBACK1')

  check('the former customer may now accept the invitation', () => {
    assert.equal(accepted.ok, true)
  })

  const staleSweep = await sweep()

  check('but their two-year-old invoice still pays nobody', () => {
    assert.equal(staleSweep.examined, 1)
    assert.equal(staleSweep.qualified, 0)
    assert.equal(staleSweep.creditedCents, 0)
  })

  // They come back, and that is the acquisition the offer meant to buy.
  const returnedAt = new Date()

  await seedPaidInvoice(PATRON.id, INVOICE_CENTS, returnedAt)

  const paidSweep = await sweep()
  const settled = await redemptionOf(PATRON.id)
  const inviterBalance = await balanceCentsOf(SUBSCRIBER.id)

  check('the invoice that wins them back does', () => {
    assert.equal(paidSweep.qualified, 1)
    assert.equal(paidSweep.creditedCents, REWARD_CENTS)
    assert.equal(settled.qualifiedAt?.getTime(), returnedAt.getTime())
    assert.equal(inviterBalance, REWARD_CENTS)
  })

  note(
    'The flag decides who may be referred. It never widens what pays for them.'
  )
}

// =============================================================================
// 10. Scenario 7 — and PostgreSQL says the same thing
// =============================================================================

async function scenarioConstraint(): Promise<void> {
  section('7. the anchor’s floor, enforced where psql cannot walk around it')

  await stageWorld()

  const codeId = await mintCodeFor(SUBSCRIBER, 'FLOORCH1')

  let constraintMessage = ''

  try {
    // Straight past the application, with the raw client, the way a `psql`
    // session or a future writer that forgot the rule would: an anchor sixty
    // days before the row, which would re-open two months of a household's
    // billing history to a referral accepted today.
    await prisma.referralRedemption.create({
      data: {
        referralCodeId: codeId,
        referredUserId: NEWCOMER.id,
        status: 'PENDING',
        currency: 'CAD',
        qualifyingFromAt: new Date(Date.now() - 60 * DAY_MS),
      },
      select: { id: true },
    })
  } catch (error) {
    constraintMessage = error instanceof Error ? error.message : String(error)
  }

  const written = await redemptionCountFor(NEWCOMER.id)

  check('PostgreSQL refuses an anchor sixty days in the past', () => {
    assert.match(
      constraintMessage,
      /ReferralRedemption_qualifyingFromAt_floor_check/
    )
  })

  check('…and the row does not exist', () => {
    assert.equal(written, 0)
  })

  // The same write inside the window is accepted, so the refusal above is
  // attributable to the bound and not to anything else about the statement.
  const inside = await prisma.referralRedemption.create({
    data: {
      referralCodeId: codeId,
      referredUserId: NEWCOMER.id,
      status: 'PENDING',
      currency: 'CAD',
      qualifyingFromAt: new Date(Date.now() - 10 * DAY_MS),
    },
    select: { id: true },
  })

  check('an anchor inside the claim window is accepted', () => {
    assert.ok(inside.id.length > 0)
  })

  note(
    'Thirty days is CLAIM_WINDOW_DAYS — the longest an MCV-050 claim may precede'
  )
  note('the sign-in that settles it, and so the longest an anchor may reach.')
}

// =============================================================================
// 11. Scenario 8 — the manual paths are not a way round it either
// =============================================================================

/**
 * `findQualifyingInvoice` has four callers, and an operator can reach three of
 * them by hand. The sweep is covered above; this covers the other two.
 *
 * The `QUALIFY` branch of `updateReferralRedemption` and `payReferralReward`
 * both exist so that a human can settle a case the sweep cannot express, and
 * both have always refused to pay a referral the database says was not earned.
 * What "earned" means moved in MCV-051, and a fix applied to the automatic path
 * alone would have left two `ADMIN`-and-above doors open onto stale revenue.
 */
async function scenarioManualPaths(): Promise<void> {
  section('8. the hand-driven paths measure the same bound')

  await stageWorld()

  const codeId = await mintCodeFor(SUBSCRIBER, 'BYHANDA1')

  await seedPaidInvoice(
    PATRON.id,
    INVOICE_CENTS,
    new Date(Date.now() - YEAR_MS)
  )

  // Anchored now, as the MCV-051 backfill anchors a historical row: this stands
  // for a redemption written before the eligibility rule existed.
  const redemption = await prisma.referralRedemption.create({
    data: {
      referralCodeId: codeId,
      referredUserId: PATRON.id,
      status: 'PENDING',
      currency: 'CAD',
      qualifyingFromAt: new Date(),
    },
    select: { id: true },
  })

  signInAs(OWNER)
  clearRateLimits()

  const handQualified = await updateReferralRedemption({
    action: 'QUALIFY',
    redemptionId: redemption.id,
  })

  const handPaid = await payReferralReward({
    userId: SUBSCRIBER.id,
    referralRedemptionId: redemption.id,
    amountCents: REWARD_CENTS,
    currency: 'CAD',
    reason: 'REFERRAL_REWARD',
  })

  signInAs(null)

  const balance = await balanceCentsOf(SUBSCRIBER.id)
  const still = await redemptionOf(PATRON.id)

  check('an administrator cannot QUALIFY it against the old invoice', () => {
    assert.equal(handQualified.ok, false)
    assert.equal(handQualified.ok ? '' : handQualified.code, 'CONFLICT')
    assert.match(
      handQualified.ok ? '' : handQualified.error,
      /no paid invoice yet/
    )
  })

  check('nor can a super administrator pay it by hand', () => {
    assert.equal(handPaid.ok, false)
    assert.equal(handPaid.ok ? '' : handPaid.code, 'CONFLICT')
    assert.match(handPaid.ok ? '' : handPaid.error, /no paid invoice/)
  })

  check('the redemption and the balance are untouched', () => {
    assert.equal(still.status, 'PENDING')
    assert.equal(balance, 0)
  })

  // The household pays a real bill, and every door opens at once.
  const paidAt = new Date()

  await seedPaidInvoice(PATRON.id, INVOICE_CENTS, paidAt)

  signInAs(OWNER)
  clearRateLimits()

  const nowQualified = await updateReferralRedemption({
    action: 'QUALIFY',
    redemptionId: redemption.id,
  })

  const nowPaid = await payReferralReward({
    userId: SUBSCRIBER.id,
    referralRedemptionId: redemption.id,
    amountCents: REWARD_CENTS,
    currency: 'CAD',
    reason: 'REFERRAL_REWARD',
  })

  signInAs(null)

  const earned = await balanceCentsOf(SUBSCRIBER.id)
  const settled = await redemptionOf(PATRON.id)

  check('a genuinely new invoice reopens both of them', () => {
    assert.equal(nowQualified.ok, true)
    assert.equal(nowPaid.ok, true)
    assert.equal(earned, REWARD_CENTS)
    // `QUALIFY` moved it to QUALIFIED and dated it by the new invoice;
    // `payReferralReward` then carried it on to REWARDED, which is that
    // action's own behaviour and not MCV-051's.
    assert.equal(settled.status, 'REWARDED')
    assert.equal(settled.qualifiedAt?.getTime(), paidAt.getTime())
  })

  note(
    'A refusal that only the automatic path enforced would be a rule with two'
  )
  note('ADMIN-shaped doors left in it.')
}

// =============================================================================
// 12. Entry point
// =============================================================================

async function main(): Promise<void> {
  const database = assertDisposableDatabase()

  process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  process.env['NEXT_PUBLIC_APP_URL'] = APP_ORIGIN

  const recorder = installStripeRecorder()

  console.log('MCV-051 — a referral is paid on money the invitation brought in')
  console.log(`database: ${database}\n`)

  await scenarioTheFarm()
  await scenarioMutual()
  await scenarioGenuineReferral()
  await scenarioBoundary()
  await scenarioCheckoutRace(recorder)
  await scenarioWinBack()
  await scenarioConstraint()
  await scenarioManualPaths()

  await resetDatabase()
  await disconnect()

  console.log(`\nPASS — ${String(checkCount())} assertions, 0 failures.`)
}

await main()
