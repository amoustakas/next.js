// mannachef/apps/web/scripts/verify-referral-redemption-parity.ts

/**
 * The MCV-041 finding F regression: there must be exactly one definition of a
 * valid referral redemption, and the webhook must not qualify one.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma db push
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:redemption
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable.
 *
 * ## The defect
 *
 * Three call sites decided whether an invitation could be accepted, and each
 * decided it differently:
 *
 * | rule                        | `redeemReferralCode` | `resolveReferralCode` | webhook |
 * | --------------------------- | -------------------- | --------------------- | ------- |
 * | code exists, is live        | yes                  | yes                   | yes     |
 * | not expired                 | yes                  | yes                   | yes     |
 * | cap not reached             | yes                  | yes                   | yes     |
 * | not the owner's own code    | yes                  | yes                   | yes     |
 * | not the owner's own mailbox | **yes**              | no                    | no      |
 * | no other live redemption    | **yes**              | no                    | no      |
 * | account exists and is live  | yes                  | no                    | no      |
 * | counter compare-and-swap    | yes                  | n/a                   | no      |
 *
 * So the cheapest self-referral there is — mint a code, sign a second account
 * up under a plus-addressed alias of the same inbox, and accept it — was
 * refused at the portal and waved through at Checkout, and the webhook that
 * actually wrote the row checked less still. On top of that the webhook wrote
 * `status: 'QUALIFIED'`, `qualifiedAt: new Date()` and the code's
 * `rewardValueCents`, having consulted neither `findQualifyingInvoice` nor the
 * programme's `minimumQualifyingInvoiceCents` floor — the two things that
 * decide whether a referral has been *earned*.
 *
 * That row escaped being a payout only because the settlement sweep selects
 * `status: 'PENDING'` and so never looked at it. A `WHERE` clause in one query
 * is not where this platform's rules are supposed to live, and a predicate with
 * two implementations has two meanings — the weaker one being the one that
 * decides.
 *
 * ## The five scenarios
 *
 * | # | Shape                                                     | Proves                                      |
 * | - | --------------------------------------------------------- | ------------------------------------------- |
 * | 1 | the alias, through all three paths, pre-fix and shipped    | one definition, and it is the strict one    |
 * | 2 | a genuine referral through the real signed webhook         | the fix did not break the happy path        |
 * | 3 | what the webhook writes, pre-fix and shipped               | `PENDING`, no `qualifiedAt`, no `rewardCents` |
 * | 4 | the floor, through the settlement sweep                    | qualification is the sweep's and the floor's |
 * | 5 | the legacy transcription against the shipped happy path    | the "before" column is still the defect     |
 *
 * Scenario 1 is the parity claim itself: one household with one plus-addressed
 * alias is put to all three entry points, and the three verdicts have to match.
 * Before the fix they did not — the portal refused, Checkout accepted, and the
 * webhook wrote a `QUALIFIED` row.
 */

import assert from 'node:assert/strict'

import {
  createReferralCode,
  redeemReferralCode,
  settleReferralRedemptions,
} from '@/server/actions/referral'
import { createCheckoutSession } from '@/server/actions/billing'
import { prisma } from '@/server/db'
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route'

import {
  legacyReferralCodeIsAcceptable,
  legacyRecordReferralRedemption,
} from './fixtures/billing-legacy'
import { installStripeRecorder } from './fixtures/stripe-recorder'
import { signInAs } from './fixtures/harness-state'
import {
  ALIAS,
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
  redemptionsForCode,
  resetDatabase,
  section,
  seedPaidInvoice,
  seedPlan,
  seedProgram,
  seedUser,
} from './fixtures/billing-harness'

// =============================================================================
// 1. The figures
// =============================================================================

const CODE = 'MALLORY8'
const REWARD_CENTS = 5_000

/** MCV-030's floor. A one-dollar invoice must not earn a full reward. */
const FLOOR_CENTS = 10_000

/** Under the floor: a delivery fee, not a conversion. */
const TRIVIAL_INVOICE_CENTS = 200

/** Over the floor: a household that has actually become a customer. */
const REAL_INVOICE_CENTS = 45_000

const PLAN_ID = 'cplanentry0000000000001'
const PLAN_PRICE_ID = 'price_entry'
const PLAN_CENTS = 5_000

const WEBHOOK_SECRET = 'whsec_mannachef_harness_not_a_real_secret'
const APP_ORIGIN = 'https://mannachef.test'

// =============================================================================
// 2. Staging
// =============================================================================

/**
 * The offer, the ladder, the inviter, and the code.
 *
 * The code is minted through the real `createReferralCode` by an ordinary
 * `CLIENT`, so it carries the terms MCV-030 says a client-minted code carries.
 * Staging it any other way would be staging a code the platform cannot produce.
 */
async function stage(): Promise<string> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
  })

  await seedPlan({
    id: PLAN_ID,
    slug: 'entry',
    name: 'The Weeknight Table',
    priceCents: PLAN_CENTS,
    stripePriceId: PLAN_PRICE_ID,
  })

  await seedUser(SUBSCRIBER)
  await seedUser(ALIAS)
  await seedUser(NEIGHBOUR)
  await seedUser(CONCIERGE)

  signInAs(SUBSCRIBER)

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: REWARD_CENTS,
    ownerId: SUBSCRIBER.id,
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
    select: { id: true },
  })

  return row.id
}

// =============================================================================
// 3. Driving the three entry points
// =============================================================================

/** What one entry point said about one attempt. */
type Verdict = 'accepted' | 'refused'

/** The portal form: `redeemReferralCode`, `auth: 'SESSION'`. */
async function portalVerdict(who: typeof ALIAS): Promise<Verdict> {
  signInAs(who)
  clearRateLimits()

  const result = await redeemReferralCode({ code: CODE })

  signInAs(null)

  return result.ok ? 'accepted' : 'refused'
}

/**
 * The Checkout pre-flight: `createCheckoutSession`, which calls
 * `resolveReferralCode` and refuses the whole session when the code will not
 * do.
 */
async function checkoutVerdict(who: typeof ALIAS): Promise<Verdict> {
  signInAs(who)
  clearRateLimits()

  const result = await createCheckoutSession({
    planId: PLAN_ID,
    successUrl: `${APP_ORIGIN}/portal/billing?welcome=1`,
    cancelUrl: `${APP_ORIGIN}/pricing`,
    referralCode: CODE,
  })

  signInAs(null)

  return result.ok ? 'accepted' : 'refused'
}

/** The pre-fix Checkout pre-flight, for the "before" column. */
async function legacyCheckoutVerdict(who: typeof ALIAS): Promise<Verdict> {
  return (await legacyReferralCodeIsAcceptable(who.id, CODE))
    ? 'accepted'
    : 'refused'
}

let eventSequence = 0

/**
 * Deliver a genuine `checkout.session.completed` to the real route handler,
 * signed the way Stripe signs one.
 *
 * `subscription` is left null so the handler's other effect —
 * `subscriptions.retrieve` followed by `handleSubscriptionChanged` — does not
 * run: this scenario is about the redemption, and a subscription mirror would
 * only add rows to read past. Everything else is the shipped path: the
 * signature is verified by Stripe's own `constructEvent`, the `StripeEvent`
 * ledger is written, and `handleCheckoutCompleted` resolves the user from the
 * metadata `createCheckoutSession` would have put there.
 */
async function deliverCheckoutCompleted(
  recorder: ReturnType<typeof installStripeRecorder>,
  who: typeof ALIAS,
  referralCodeId: string
): Promise<number> {
  eventSequence += 1

  const body = JSON.stringify({
    id: `evt_harness${eventSequence.toString().padStart(6, '0')}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_harness${eventSequence.toString().padStart(6, '0')}`,
        object: 'checkout.session',
        subscription: null,
        client_reference_id: who.id,
        customer: null,
        payment_status: 'paid',
        metadata: {
          mannachefUserId: who.id,
          mannachefPlanId: PLAN_ID,
          mannachefReferralCodeId: referralCodeId,
          mannachefReferralCode: CODE,
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

// =============================================================================
// 4. Scenarios
// =============================================================================

async function scenarioOne(
  recorder: ReturnType<typeof installStripeRecorder>
): Promise<void> {
  section('1. The alias, through all three paths')

  const codeId = await stage()

  const legacyCheckout = await legacyCheckoutVerdict(ALIAS)

  check('the pre-fix Checkout pre-flight accepted the alias', () => {
    assert.equal(legacyCheckout, 'accepted')
  })

  await legacyRecordReferralRedemption(codeId, ALIAS.id)

  const legacyRows = await redemptionsForCode(codeId)

  check('the pre-fix webhook wrote a redemption for the alias', () => {
    assert.equal(legacyRows.length, 1)
    assert.equal(legacyRows[0]?.referredUserId, ALIAS.id)
  })

  check('…and marked it QUALIFIED on the spot', () => {
    assert.equal(legacyRows[0]?.status, 'QUALIFIED')
    assert.notEqual(legacyRows[0]?.qualifiedAt, null)
    assert.equal(legacyRows[0]?.rewardCents, REWARD_CENTS)
  })

  note('The alias has never paid us anything. There is no invoice at all.')

  // A clean world for the shipped paths.
  const freshCodeId = await stage()

  const portal = await portalVerdict(ALIAS)
  const checkout = await checkoutVerdict(ALIAS)
  const status = await deliverCheckoutCompleted(recorder, ALIAS, freshCodeId)
  const written = await redemptionsForCode(freshCodeId)
  const counter = await redemptionCountOf(freshCodeId)

  check('the portal refuses the alias', () => {
    assert.equal(portal, 'refused')
  })

  check('the Checkout pre-flight refuses the alias', () => {
    assert.equal(checkout, 'refused')
  })

  check('the webhook acknowledges the delivery', () => {
    assert.equal(status, 200)
  })

  check('…and writes nothing', () => {
    assert.equal(written.length, 0)
  })

  check('the code’s counter is still nought', () => {
    assert.equal(counter, 0)
  })

  printTable(
    'One household, one plus-addressed alias, three entry points',
    [
      ['entry point', 'before MCV-041', 'after MCV-041'],
      ['portal — redeemReferralCode', 'refused', 'refused'],
      ['checkout — resolveReferralCode', legacyCheckout, checkout],
      ['webhook — recordReferralRedemption', 'QUALIFIED row', 'nothing'],
    ],
    '  Before, two of the three disagreed with the one that was right.'
  )
}

async function scenarioTwo(
  recorder: ReturnType<typeof installStripeRecorder>
): Promise<void> {
  section('2. A genuine referral still works')

  // The portal first, on its own staging, because `redeemReferralCode` was
  // rewritten too and a harness that only exercised its refusals would have
  // said nothing about whether it still issues a receipt.
  await stage()

  signInAs(NEIGHBOUR)
  clearRateLimits()

  const receipt = await redeemReferralCode({ code: CODE })

  signInAs(null)

  check('the portal accepts an unrelated household', () => {
    assert.equal(receipt.ok, true)
  })

  check('and hands back the receipt the guest is entitled to', () => {
    assert.ok(receipt.ok)
    assert.equal(receipt.data.code, CODE)
    assert.equal(receipt.data.status, 'PENDING')
    assert.equal(receipt.data.currency, 'CAD')
    // The code rewards only its owner, so there is nothing to promise the
    // guest — and the owner's figure is deliberately not disclosed.
    assert.equal(receipt.data.refereeRewardCents, null)
  })

  const codeId = await stage()

  const status = await deliverCheckoutCompleted(recorder, NEIGHBOUR, codeId)
  const rows = await redemptionsForCode(codeId)
  const counter = await redemptionCountOf(codeId)

  check('the webhook acknowledges the delivery', () => {
    assert.equal(status, 200)
  })

  check('one redemption is written, naming the neighbour', () => {
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.referredUserId, NEIGHBOUR.id)
  })

  check('the counter moved exactly once', () => {
    assert.equal(counter, 1)
  })

  const replay = await deliverCheckoutCompleted(recorder, NEIGHBOUR, codeId)

  check('a redelivery is idempotent', () => {
    assert.equal(replay, 200)
  })

  const afterReplay = await redemptionsForCode(codeId)

  check('…and adds nothing', () => {
    assert.equal(afterReplay.length, 1)
  })

  const counterAfterReplay = await redemptionCountOf(codeId)

  check('…and does not move the counter again', () => {
    assert.equal(counterAfterReplay, 1)
  })
}

async function scenarioThree(
  recorder: ReturnType<typeof installStripeRecorder>
): Promise<void> {
  section('3. What the webhook is allowed to write')

  const legacyCodeId = await stage()
  await legacyRecordReferralRedemption(legacyCodeId, NEIGHBOUR.id)
  const before = (await redemptionsForCode(legacyCodeId))[0]

  const codeId = await stage()
  await deliverCheckoutCompleted(recorder, NEIGHBOUR, codeId)
  const after = (await redemptionsForCode(codeId))[0]

  check('the pre-fix webhook wrote QUALIFIED', () => {
    assert.equal(before?.status, 'QUALIFIED')
  })

  check('the shipped webhook writes PENDING', () => {
    assert.equal(after?.status, 'PENDING')
  })

  check('…with no qualification moment', () => {
    assert.equal(after?.qualifiedAt, null)
  })

  check('…and no reward snapshot', () => {
    assert.equal(after?.rewardCents, null)
  })

  printTable(
    'The row a paid Checkout session writes',
    [
      ['column', 'before MCV-041', 'after MCV-041'],
      ['status', String(before?.status), String(after?.status)],
      [
        'qualifiedAt',
        before?.qualifiedAt === null ? 'null' : 'now()',
        after?.qualifiedAt === null ? 'null' : 'now()',
      ],
      [
        'rewardCents',
        before?.rewardCents === null ? 'null' : money(before?.rewardCents ?? 0),
        after?.rewardCents === null ? 'null' : money(after?.rewardCents ?? 0),
      ],
      ['floor consulted', 'no', 'not here — by the sweep'],
    ],
    '  A paid session is not a qualification. A qualifying invoice is.'
  )
}

async function scenarioFour(
  recorder: ReturnType<typeof installStripeRecorder>
): Promise<void> {
  section('4. The floor decides, through the sweep')

  const codeId = await stage()

  await deliverCheckoutCompleted(recorder, NEIGHBOUR, codeId)
  await seedPaidInvoice(
    NEIGHBOUR.id,
    TRIVIAL_INVOICE_CENTS,
    new Date('2026-03-02T12:00:00.000Z')
  )

  signInAs(CONCIERGE)
  clearRateLimits()

  const firstSweep = await settleReferralRedemptions({})

  check('the sweep runs', () => {
    assert.equal(firstSweep.ok, true)
  })

  check(
    `a ${money(TRIVIAL_INVOICE_CENTS)} invoice does not clear the ${money(FLOOR_CENTS)} floor`,
    () => {
      assert.equal(firstSweep.ok ? firstSweep.data.qualified : -1, 0)
      assert.equal(firstSweep.ok ? firstSweep.data.creditedCents : -1, 0)
    }
  )

  const unearned = await balanceCentsOf(SUBSCRIBER.id)

  check('the inviter has been credited nothing', () => {
    assert.equal(unearned, 0)
  })

  await seedPaidInvoice(
    NEIGHBOUR.id,
    REAL_INVOICE_CENTS,
    new Date('2026-03-09T12:00:00.000Z')
  )

  clearRateLimits()

  const secondSweep = await settleReferralRedemptions({})

  signInAs(null)

  check(`a ${money(REAL_INVOICE_CENTS)} invoice does`, () => {
    assert.equal(secondSweep.ok ? secondSweep.data.qualified : -1, 1)
    assert.equal(
      secondSweep.ok ? secondSweep.data.creditedCents : -1,
      REWARD_CENTS
    )
  })

  const earned = await balanceCentsOf(SUBSCRIBER.id)
  const settled = (await redemptionsForCode(codeId))[0]

  check('the inviter is credited exactly the code’s reward', () => {
    assert.equal(earned, REWARD_CENTS)
  })

  check(
    'and the redemption is dated by the invoice, not by the webhook',
    () => {
      assert.equal(settled?.status, 'REWARDED')
      assert.equal(
        settled?.qualifiedAt?.toISOString(),
        '2026-03-09T12:00:00.000Z'
      )
    }
  )

  note(
    'The pre-fix row was QUALIFIED and stamped with the moment the webhook ran —'
  )
  note(
    'a date with no invoice behind it, on a row the sweep would never revisit.'
  )
}

async function scenarioFive(
  recorder: ReturnType<typeof installStripeRecorder>
): Promise<void> {
  section('5. The legacy transcription still matches where it should')

  const legacyCodeId = await stage()
  await legacyRecordReferralRedemption(legacyCodeId, NEIGHBOUR.id)
  const before = await redemptionsForCode(legacyCodeId)
  const beforeCounter = await redemptionCountOf(legacyCodeId)

  const codeId = await stage()
  await deliverCheckoutCompleted(recorder, NEIGHBOUR, codeId)
  const after = await redemptionsForCode(codeId)
  const afterCounter = await redemptionCountOf(codeId)

  check('both write exactly one row', () => {
    assert.equal(before.length, 1)
    assert.equal(after.length, 1)
  })

  check('both name the same household', () => {
    assert.equal(before[0]?.referredUserId, after[0]?.referredUserId)
  })

  check('both move the counter once', () => {
    assert.equal(beforeCounter, 1)
    assert.equal(afterCounter, 1)
  })

  note('The copy in fixtures/billing-legacy.ts is therefore still the')
  note('pre-fix code and not a description of it. Where the two differ is')
  note('the finding; where they agree is the evidence that they were ever')
  note('the same function.')
}

// =============================================================================
// 5. Entry point
// =============================================================================

async function main(): Promise<void> {
  const database = assertDisposableDatabase()

  console.log('MCV-041 finding F — one definition of a valid redemption')
  console.log(`database: ${database}`)

  // The route reads both of these when it is called, not when it is imported.
  // Neither is a secret: the signing secret is generated for this process and
  // the origin is a hostname the actions compare against.
  process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  process.env['NEXT_PUBLIC_APP_URL'] = APP_ORIGIN

  const recorder = installStripeRecorder()

  await scenarioOne(recorder)
  await scenarioTwo(recorder)
  await scenarioThree(recorder)
  await scenarioFour(recorder)
  await scenarioFive(recorder)

  console.log(`\n${checkCount()} assertions passed.`)

  await resetDatabase()
  await disconnect()
}

main().catch(async (error: unknown) => {
  console.error(error)
  await disconnect()
  process.exitCode = 1
})
