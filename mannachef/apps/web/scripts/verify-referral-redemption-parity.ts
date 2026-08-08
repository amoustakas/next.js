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
 *
 * ## Scenarios 6 and 7 (MCV-057)
 *
 * A mutation audit found that most of `resolveRedemptionEligibility` was
 * unreached: delete `NO_ACCOUNT`, `UNKNOWN_CODE`, `EXPIRED`, `OWN_CODE`,
 * `ALREADY_USED` or `ALREADY_REFERRED` from the predicate and every harness in
 * this repository still printed a pass. Three of the nine refusals were covered
 * — `SAME_HOUSEHOLD` by scenario 1 above, `FULLY_REDEEMED` by
 * `verify-intake-referral-cap.ts`, `ALREADY_A_CUSTOMER` by `verify-mcv051.ts` —
 * and the other six were prose. The caller check on `redeemReferralCode` itself,
 * the one that stops a `CLIENT` naming somebody else's `referredUserId`, was in
 * the same state.
 *
 * They are covered here rather than in a harness of their own because this file
 * is already the one that says what a valid redemption *is*, and because the
 * shape each of them needs is the shape scenario 1 established: drive the
 * shipped door, then read the rows.
 *
 * Every probe in scenario 6 is a **pair**, and the two halves of a pair differ
 * by exactly one property of the server's own state — never by the payload,
 * never by which literal was typed. The concierge closes an account in both
 * halves and the halves differ in *whose*; the owner withdraws a code in both
 * halves and the halves differ in *which*; the abuse review revokes a redemption
 * in both halves and the halves differ in *whose*. The refusing half therefore
 * always performs at least as many steps as the accepting one, which is the
 * property that stops a refusal being manufactured by omission.
 */

import assert from 'node:assert/strict'

import {
  createReferralCode,
  deactivateReferralCode,
  redeemReferralCode,
  settleReferralRedemptions,
  updateReferralRedemption,
} from '@/server/actions/referral'
import { createCheckoutSession } from '@/server/actions/billing'
import { setUserActive } from '@/server/actions/user'
import { prisma } from '@/server/db'
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route'

import {
  legacyReferralCodeIsAcceptable,
  legacyRecordReferralRedemption,
} from './fixtures/billing-legacy'
import { installStripeRecorder } from './fixtures/stripe-recorder'
import { signInAs, type HarnessUser } from './fixtures/harness-state'
import {
  ALIAS,
  CHEF,
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

/**
 * A second invitation, identical to {@link CODE} in every column that is not
 * its identity: same owner, same terms, same mint path, minted a millisecond
 * later through the same action.
 *
 * It exists so that scenario 6 can vary a *server-side property* rather than a
 * payload. "The owner withdrew a code" is performed in both halves of the
 * `UNKNOWN_CODE` pair; what differs is which of two interchangeable codes was
 * withdrawn. A pair whose accepting half simply skipped the withdrawal would be
 * a pair separated by an omission, and an omission is not a property.
 */
const SPARE_CODE = 'MALLORY9'

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

  // Both invoices below are paid *after* the redemption the delivery above
  // wrote, because since MCV-051 `findQualifyingInvoice` will not look at one
  // paid before it. A fixed calendar date would make this scenario stop being
  // about the floor the moment it fell into the past — and the trivial invoice
  // in particular has to be refused *on its amount*, which it can only
  // demonstrate by clearing the date bound first.
  await seedPaidInvoice(NEIGHBOUR.id, TRIVIAL_INVOICE_CENTS, new Date())

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

  const qualifyingPaidAt = new Date()

  await seedPaidInvoice(NEIGHBOUR.id, REAL_INVOICE_CENTS, qualifyingPaidAt)

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
        qualifyingPaidAt.toISOString()
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
// 5. Scenario 6 — the six refusals nothing in this suite had reached
// =============================================================================

/**
 * The world every probe in scenario 6 starts from.
 *
 * Two interchangeable codes owned by `SUBSCRIBER`, and four accounts: the
 * inviter, the alias, an unrelated household (`NEIGHBOUR` — the one who
 * redeems), a second unrelated household (`CHEF`), and the concierge who runs
 * the admin doors.
 *
 * Nobody here has ever paid us anything, deliberately: `ALREADY_A_CUSTOMER` is
 * `verify-mcv051.ts`'s claim, and an invoice in this world would let a probe
 * pass for the wrong reason.
 */
async function stageRefusals(mintCodeFor: HarnessUser): Promise<{
  readonly codeId: string
  readonly spareId: string
}> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
  })

  for (const person of [SUBSCRIBER, ALIAS, NEIGHBOUR, CHEF, CONCIERGE]) {
    await seedUser(person)
  }

  const codeId = await mintOneCode(mintCodeFor, CODE)
  const spareId = await mintOneCode(mintCodeFor, SPARE_CODE)

  signInAs(null)
  clearRateLimits()

  return { codeId, spareId }
}

/** Mint one code as `owner`, through the audited door, and return its row id. */
async function mintOneCode(owner: HarnessUser, code: string): Promise<string> {
  signInAs(owner)
  clearRateLimits()

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    rewardValueCents: REWARD_CENTS,
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
    select: { id: true },
  })

  return row.id
}

/**
 * What one attempt at the portal door did, to the answer **and** to the rows.
 *
 * The counts are deltas rather than totals, because two of the probes below
 * have a redemption on file before the call under test and the claim being made
 * is always the same one: a refusal writes nothing and moves nothing, and its
 * contrast writes exactly one row and moves the counter exactly once.
 */
interface RedeemObservation {
  readonly verdict: Verdict
  readonly failureCode: string
  readonly message: string
  /** Rows naming the household the invitation was accepted *for*. */
  readonly rowsAdded: number
  /** `ReferralCode.redemptionCount` on the code that was named. */
  readonly counterMoved: number
  /** Rows naming the *caller*, when that is somebody else. Always nought. */
  readonly rowsAddedForCaller: number
}

const ACCEPTED_AND_WRITTEN = { rowsAdded: 1, counterMoved: 1 } as const
const REFUSED_AND_INERT = { rowsAdded: 0, counterMoved: 0 } as const

async function redemptionCountFor(userId: string): Promise<number> {
  return prisma.referralRedemption.count({ where: { referredUserId: userId } })
}

/**
 * Drive `redeemReferralCode` once, reading the rows either side of it.
 *
 * `referredUserId` is passed only when the caller is acting for somebody else,
 * because `exactOptionalPropertyTypes` distinguishes an absent key from an
 * explicit `undefined` — and the absent key is what a household's own portal
 * form posts.
 */
async function observeRedeem(options: {
  readonly caller: HarnessUser
  readonly code: string
  readonly codeId: string
  readonly onBehalfOf?: HarnessUser | undefined
}): Promise<RedeemObservation> {
  const subject = options.onBehalfOf ?? options.caller

  const rowsBefore = await redemptionCountFor(subject.id)
  const callerRowsBefore = await redemptionCountFor(options.caller.id)
  const counterBefore = await redemptionCountOf(options.codeId)

  signInAs(options.caller)
  clearRateLimits()

  const result = await redeemReferralCode(
    options.onBehalfOf === undefined
      ? { code: options.code }
      : { code: options.code, referredUserId: options.onBehalfOf.id }
  )

  signInAs(null)

  const rowsAfter = await redemptionCountFor(subject.id)
  const callerRowsAfter = await redemptionCountFor(options.caller.id)
  const counterAfter = await redemptionCountOf(options.codeId)

  return {
    verdict: result.ok ? 'accepted' : 'refused',
    failureCode: result.ok ? '' : result.code,
    message: result.ok ? '' : result.error,
    rowsAdded: rowsAfter - rowsBefore,
    counterMoved: counterAfter - counterBefore,
    rowsAddedForCaller: callerRowsAfter - callerRowsBefore,
  }
}

/** Close or reopen an account through the real `ADMIN` door. */
async function setAccountActive(
  subject: HarnessUser,
  isActive: boolean
): Promise<void> {
  signInAs(CONCIERGE)
  clearRateLimits()

  const changed = await setUserActive({
    userId: subject.id,
    isActive,
    reason: 'Closed for the duration of an abuse review.',
  })

  signInAs(null)

  assert.equal(
    changed.ok,
    true,
    `the concierge could not close ${subject.name ?? 'the account'}: ${changed.ok ? '' : changed.error}`
  )
}

/** Withdraw one code through its owner's real door. */
async function withdrawCode(owner: HarnessUser, codeId: string): Promise<void> {
  signInAs(owner)
  clearRateLimits()

  const withdrawn = await deactivateReferralCode({ referralCodeId: codeId })

  signInAs(null)

  assert.equal(
    withdrawn.ok,
    true,
    `the owner could not withdraw the code: ${withdrawn.ok ? '' : withdrawn.error}`
  )
}

/**
 * Move a code's expiry into the past.
 *
 * Written with the raw client, for the reason `backdateReferralClaim` in
 * `fixtures/intake-harness.ts` gives about a claim's age: the *data* is moved
 * rather than the clock, and the shipped comparison
 * (`expiresAt.getTime() <= Date.now()`) is left to decide on its own. The
 * amend door cannot do this — `referralCodeUpdateSchema` refuses an expiry that
 * is not ahead of now, which is a boundary rule of its own and not the one
 * under test here.
 */
async function expireCode(codeId: string, expiresAt: Date): Promise<void> {
  await prisma.referralCode.update({
    where: { id: codeId },
    data: { expiresAt },
    select: { id: true },
  })
}

/** Take one redemption back, through the real `ADMIN` door. */
async function revokeRedemption(redemptionId: string): Promise<void> {
  signInAs(CONCIERGE)
  clearRateLimits()

  const revoked = await updateReferralRedemption({
    action: 'REVOKE',
    redemptionId,
    revokedReason: 'Withdrawn by the abuse review.',
    reverseLedgerEntry: false,
  })

  signInAs(null)

  assert.equal(
    revoked.ok,
    true,
    `the concierge could not revoke the redemption: ${revoked.ok ? '' : revoked.error}`
  )
}

/** The id of the row joining one household to one code. */
async function redemptionIdFor(
  userId: string,
  referralCodeId: string
): Promise<string> {
  const row = await prisma.referralRedemption.findFirstOrThrow({
    where: { referredUserId: userId, referralCodeId },
    select: { id: true },
  })

  return row.id
}

const HOUR_MS = 60 * 60 * 1_000

/**
 * `NO_ACCOUNT` — the concierge closes an account, and the question is whose.
 *
 * `redeemReferralCode` is `auth: 'SESSION'`, and the session was minted before
 * the closure: `withAction` reads `getSessionUser()` and never re-reads the row.
 * That is not a contrivance, it is the ordinary shape of a closure — a session
 * cookie outlives the decision to close the account it names — and it is
 * precisely why the predicate re-reads `User.isActive` inside the transaction
 * that writes rather than trusting what the wrapper handed it.
 */
async function probeNoAccount(closed: HarnessUser): Promise<RedeemObservation> {
  const staged = await stageRefusals(SUBSCRIBER)

  await setAccountActive(closed, false)

  return observeRedeem({
    caller: NEIGHBOUR,
    code: CODE,
    codeId: staged.codeId,
  })
}

/** `UNKNOWN_CODE` — the owner withdraws a code, and the question is which. */
async function probeUnknownCode(
  withdrawn: 'named' | 'spare'
): Promise<RedeemObservation> {
  const staged = await stageRefusals(SUBSCRIBER)

  await withdrawCode(
    SUBSCRIBER,
    withdrawn === 'named' ? staged.codeId : staged.spareId
  )

  return observeRedeem({
    caller: NEIGHBOUR,
    code: CODE,
    codeId: staged.codeId,
  })
}

/** `EXPIRED` — an expiry falls behind, and the question is whose. */
async function probeExpired(
  expired: 'named' | 'spare'
): Promise<RedeemObservation> {
  const staged = await stageRefusals(SUBSCRIBER)

  await expireCode(
    expired === 'named' ? staged.codeId : staged.spareId,
    new Date(Date.now() - HOUR_MS)
  )

  return observeRedeem({
    caller: NEIGHBOUR,
    code: CODE,
    codeId: staged.codeId,
  })
}

/**
 * `OWN_CODE` — both halves mint two codes through the same action; the question
 * is whose name is on them.
 *
 * The caller, the payload and the number of steps are identical. What moves is
 * `ReferralCode.ownerId`, which is the only column the guard reads.
 */
async function probeOwnCode(owner: HarnessUser): Promise<RedeemObservation> {
  const staged = await stageRefusals(owner)

  return observeRedeem({
    caller: NEIGHBOUR,
    code: CODE,
    codeId: staged.codeId,
  })
}

/**
 * `ALREADY_REFERRED` — the abuse review takes one redemption back, and the
 * question is whose.
 *
 * Both halves: `NEIGHBOUR` accepts `CODE`, `CHEF` accepts `CODE`, the concierge
 * revokes one of the two, and `NEIGHBOUR` then accepts `SPARE_CODE`. `REVOKED`
 * is deliberately absent from `LIVE_REDEMPTION_STATUSES` — a redemption taken
 * back after an abuse review has released the household — so revoking
 * `NEIGHBOUR`'s frees the slot and revoking `CHEF`'s does not.
 */
async function probeAlreadyReferred(
  released: HarnessUser
): Promise<RedeemObservation> {
  const staged = await stageRefusals(SUBSCRIBER)

  await acceptFirstInvitation(staged.codeId)
  await revokeRedemption(await redemptionIdFor(released.id, staged.codeId))

  return observeRedeem({
    caller: NEIGHBOUR,
    code: SPARE_CODE,
    codeId: staged.spareId,
  })
}

/**
 * `ALREADY_USED` — the identical sequence, and the question is which code the
 * released household names next.
 *
 * `NEIGHBOUR`'s own redemption is revoked in both halves, so the
 * one-live-redemption rule has nothing to say in either. The only thing left
 * standing between the household and a second acceptance is whether a
 * `ReferralRedemption` already joins them to the code they named — which is what
 * `ALREADY_USED` is, and why it is checked on the pair rather than on the
 * status.
 */
async function probeAlreadyUsed(
  named: 'same' | 'other'
): Promise<RedeemObservation> {
  const staged = await stageRefusals(SUBSCRIBER)

  await acceptFirstInvitation(staged.codeId)
  await revokeRedemption(await redemptionIdFor(NEIGHBOUR.id, staged.codeId))

  return observeRedeem({
    caller: NEIGHBOUR,
    code: named === 'same' ? CODE : SPARE_CODE,
    codeId: named === 'same' ? staged.codeId : staged.spareId,
  })
}

/** Two unrelated households accept `CODE`, through the shipped portal door. */
async function acceptFirstInvitation(codeId: string): Promise<void> {
  for (const household of [NEIGHBOUR, CHEF]) {
    const accepted = await observeRedeem({
      caller: household,
      code: CODE,
      codeId,
    })

    assert.equal(
      accepted.verdict,
      'accepted',
      `${household.name ?? 'a household'} should have been able to accept ${CODE}: ${accepted.message}`
    )
  }
}

/** One line of the scenario 6 table. */
interface RefusalPair {
  readonly reason: string
  readonly property: string
  readonly refused: RedeemObservation
  readonly accepted: RedeemObservation
  readonly expectedCode: 'VALIDATION' | 'NOT_FOUND'
  readonly expectedMessage: RegExp
}

async function scenarioSix(): Promise<readonly RefusalPair[]> {
  section('6. the six refusals, each against its own contrast')

  const pairs: readonly RefusalPair[] = [
    {
      reason: 'NO_ACCOUNT',
      property: 'which account the concierge closed',
      refused: await probeNoAccount(NEIGHBOUR),
      accepted: await probeNoAccount(ALIAS),
      expectedCode: 'NOT_FOUND',
      expectedMessage: /could not find that account/,
    },
    {
      reason: 'UNKNOWN_CODE',
      property: 'which code the owner withdrew',
      refused: await probeUnknownCode('named'),
      accepted: await probeUnknownCode('spare'),
      expectedCode: 'VALIDATION',
      expectedMessage: /not one we recognise/,
    },
    {
      reason: 'EXPIRED',
      property: 'which code’s expiry fell behind',
      refused: await probeExpired('named'),
      accepted: await probeExpired('spare'),
      expectedCode: 'VALIDATION',
      expectedMessage: /has expired/,
    },
    {
      reason: 'OWN_CODE',
      property: 'whose name is on the code',
      refused: await probeOwnCode(NEIGHBOUR),
      accepted: await probeOwnCode(SUBSCRIBER),
      expectedCode: 'VALIDATION',
      expectedMessage: /cannot be redeemed by its own owner/,
    },
    {
      reason: 'ALREADY_REFERRED',
      property: 'whose redemption the abuse review took back',
      refused: await probeAlreadyReferred(CHEF),
      accepted: await probeAlreadyReferred(NEIGHBOUR),
      expectedCode: 'VALIDATION',
      expectedMessage: /already been accepted on this account/,
    },
    {
      reason: 'ALREADY_USED',
      property: 'which code the released household named next',
      refused: await probeAlreadyUsed('same'),
      accepted: await probeAlreadyUsed('other'),
      expectedCode: 'VALIDATION',
      expectedMessage: /already used that invitation code/,
    },
  ]

  for (const pair of pairs) {
    check(`${pair.reason}: the contrast is accepted and written`, () => {
      assert.equal(pair.accepted.verdict, 'accepted', pair.accepted.message)
      assert.equal(pair.accepted.rowsAdded, ACCEPTED_AND_WRITTEN.rowsAdded)
      assert.equal(
        pair.accepted.counterMoved,
        ACCEPTED_AND_WRITTEN.counterMoved
      )
    })

    check(`${pair.reason}: the refusal says so, in the guest’s words`, () => {
      assert.equal(pair.refused.verdict, 'refused')
      assert.equal(pair.refused.failureCode, pair.expectedCode)
      assert.match(pair.refused.message, pair.expectedMessage)
    })

    check(`${pair.reason}: and nothing was written on the way out`, () => {
      assert.equal(pair.refused.rowsAdded, REFUSED_AND_INERT.rowsAdded)
      assert.equal(pair.refused.counterMoved, REFUSED_AND_INERT.counterMoved)
    })
  }

  note('Every pair above ran the same call, from the same session, with the')
  note('same payload. What differed each time was a row the server holds.')

  return pairs
}

// =============================================================================
// 6. Scenario 7 — who a redemption may be written *for*
// =============================================================================

/**
 * `redeemReferralCode` accepts an optional `referredUserId`, so that an
 * administrator can record an acceptance on a household's behalf. The guard
 * that keeps it from being an open door is four lines long:
 *
 * ```ts
 * const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')
 * const referredUserId = input.referredUserId ?? ctx.user.id
 * if (!privileged && referredUserId !== ctx.user.id) { … FORBIDDEN … }
 * ```
 *
 * Delete it and every harness here still passed, because nothing had ever sent
 * the field. Without it any `CLIENT` may write a `PENDING` redemption against
 * **any** account on the platform: they would consume that household's
 * one-live-redemption slot with an invitation of the caller's choosing, and
 * `ALREADY_REFERRED` would then refuse the genuine invitation the household was
 * actually given. That is CONTRACT.md §5 step 4 — never trust an id from the
 * client without re-checking whom it belongs to — and it is the reason the
 * eligibility predicate, which decides everything else, deliberately decides
 * nothing about this.
 *
 * The two halves send the **same payload from the same account**. `CONCIERGE`
 * is one person with one id and one row; what differs between the halves is the
 * role their session carries, which is the single thing the guard reads.
 */
async function scenarioSeven(): Promise<{
  readonly asClient: RedeemObservation
  readonly asAdmin: RedeemObservation
}> {
  section('7. a redemption may be written for somebody else, by an ADMIN only')

  const unprivileged: HarnessUser = { ...CONCIERGE, role: 'CLIENT' }

  const stagedForClient = await stageRefusals(SUBSCRIBER)
  const asClient = await observeRedeem({
    caller: unprivileged,
    code: CODE,
    codeId: stagedForClient.codeId,
    onBehalfOf: NEIGHBOUR,
  })

  const stagedForAdmin = await stageRefusals(SUBSCRIBER)
  const asAdmin = await observeRedeem({
    caller: CONCIERGE,
    code: CODE,
    codeId: stagedForAdmin.codeId,
    onBehalfOf: NEIGHBOUR,
  })

  check('an unprivileged caller is refused, by name', () => {
    assert.equal(asClient.verdict, 'refused')
    assert.equal(asClient.failureCode, 'FORBIDDEN')
    assert.match(asClient.message, /only accept an invitation on your own/)
  })

  check('…and the household they named has no redemption', () => {
    assert.equal(asClient.rowsAdded, 0)
    assert.equal(asClient.counterMoved, 0)
  })

  check('…nor did the refusal quietly fall back to the caller', () => {
    assert.equal(asClient.rowsAddedForCaller, 0)
  })

  check('the identical payload from an ADMIN writes the row', () => {
    assert.equal(asAdmin.verdict, 'accepted', asAdmin.message)
    assert.equal(asAdmin.rowsAdded, 1)
    assert.equal(asAdmin.counterMoved, 1)
  })

  check('…for the household named, and not for the administrator', () => {
    assert.equal(asAdmin.rowsAddedForCaller, 0)
  })

  note('One id, one row, one payload. Only the session’s role differs, and')
  note('that is the whole of what stands between a CLIENT and every account.')

  return { asClient, asAdmin }
}

function printRefusalReport(
  pairs: readonly RefusalPair[],
  ownership: {
    readonly asClient: RedeemObservation
    readonly asAdmin: RedeemObservation
  }
): void {
  printTable(
    'Seven guards, each measured against a contrast that differs by one server-side fact',
    [
      ['guard', 'the property that differs', 'refused', 'contrast', 'rows'],
      ...pairs.map((pair) => [
        pair.reason,
        pair.property,
        pair.refused.failureCode,
        pair.accepted.verdict,
        `${String(pair.refused.rowsAdded)} vs ${String(pair.accepted.rowsAdded)}`,
      ]),
      [
        'caller ≠ subject',
        'the role on the session',
        ownership.asClient.failureCode,
        ownership.asAdmin.verdict,
        `${String(ownership.asClient.rowsAdded)} vs ${String(ownership.asAdmin.rowsAdded)}`,
      ],
    ],
    '  The last column is the one that matters: a refusal that returned the right\n' +
      '  sentence while writing the row would read identically to a caller and cost\n' +
      '  the same money as no guard at all.'
  )
}

// =============================================================================
// 7. Entry point
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

  const refusals = await scenarioSix()
  const ownership = await scenarioSeven()

  printRefusalReport(refusals, ownership)

  console.log(`\n${checkCount()} assertions passed.`)

  await resetDatabase()
  await disconnect()
}

main().catch(async (error: unknown) => {
  console.error(error)
  await disconnect()
  process.exitCode = 1
})
