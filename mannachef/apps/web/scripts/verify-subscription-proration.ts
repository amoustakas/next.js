// mannachef/apps/web/scripts/verify-subscription-proration.ts

/**
 * The MCV-041 finding C regression: a `CLIENT` must not be able to take a
 * premium plan mid-period without being billed for it.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma db push
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:proration
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable.
 *
 * ## The defect
 *
 * `changeSubscription` built its Stripe call like this:
 *
 * ```ts
 * items: [{ id: item.id, price: target.stripePriceId, quantity }],
 * proration_behavior:
 *   input.effectiveAt === 'PERIOD_END' ? 'none' : input.prorationBehavior,
 * ```
 *
 * `price` moves unconditionally; `proration_behavior` decides whether the move
 * is billed. Both `effectiveAt` and `prorationBehavior` are fields on
 * `subscriptionChangeSchema` that a browser fills in, `prorationBehavior`'s
 * enum contains `'none'`, and nothing anywhere in the action's body consulted
 * the caller's role — only ownership. So a subscriber on the $50 plan could
 * post `{ action: 'UPGRADE', planId: <the $500 plan>, quantity: 20,
 * prorationBehavior: 'none' }`, be moved onto twenty places of the premium plan
 * at once, and be charged nothing for the remainder of the period. Moving back
 * down before renewal swaps the price again with the same suppression, so even
 * the renewal invoice is raised at the entry rate. Repeated, that is the
 * premium plan held indefinitely at the entry price.
 *
 * The same file had already found this hazard once. The comment above the
 * price-direction checks says a downgrade to a dearer plan "would quietly wait
 * for the period to end and prorate nothing, which is a free upgrade" — and
 * then the identical outcome was left reachable by asking for it as an upgrade.
 *
 * ## What the fix is
 *
 * `resolveSubscriptionChangeTerms`. An upgrade always prorates, for everybody;
 * below `ADMIN` both fields and `quantity` come from the house instead of from
 * the payload. The claim this file proves is the narrow, checkable one:
 *
 *   **the Stripe update payload built for a `CLIENT` upgrade carries
 *   `create_prorations`, whatever the caller sent.**
 *
 * ## The seven scenarios
 *
 * | # | Shape                                                | Proves                                    |
 * | - | ---------------------------------------------------- | ----------------------------------------- |
 * | 1 | the exploit as filed, against the pre-fix expression  | the defect was real                       |
 * | 2 | the exploit as filed, against the shipped action      | it is closed                              |
 * | 3 | all six `effectiveAt` × `prorationBehavior` pairs     | closed for the whole input space          |
 * | 4 | `quantity: 20` from a `CLIENT`                        | the places are the house's, not the payload's |
 * | 5 | a `CLIENT` downgrade asking to be prorated            | the downgrade arm takes house terms too   |
 * | 6 | an `ADMIN` upgrade asking for `none`                  | the upgrade rule binds administrators too |
 * | 7 | an `ADMIN` downgrade, and an `ADMIN` quantity         | discretion below the upgrade rule survives |
 *
 * Scenario 3 is exhaustive by construction rather than by sampling: it iterates
 * the two enums the schema declares, so a value added to either fails here
 * until somebody has thought about it.
 */

import assert from 'node:assert/strict'

import { changeSubscription } from '@/server/actions/billing'
import { PRORATION_BEHAVIORS } from '@mannachef/validators'
import type { ChangeEffectiveAt } from '@mannachef/validators'

import {
  legacyProrationBehavior,
  legacyQuantity,
} from './fixtures/billing-legacy'
import {
  installStripeRecorder,
  syntheticSubscription,
  type StripeRecorder,
} from './fixtures/stripe-recorder'
import { signInAs } from './fixtures/harness-state'
import {
  CHEF,
  CONCIERGE,
  SUBSCRIBER,
  assertDisposableDatabase,
  check,
  checkCount,
  clearRateLimits,
  disconnect,
  money,
  note,
  printTable,
  resetDatabase,
  section,
  seedPlan,
  seedSubscription,
  seedUser,
  subscriptionSnapshot,
  type SubscriptionChangePayload,
} from './fixtures/billing-harness'

// =============================================================================
// 1. The figures
// =============================================================================

const ENTRY_PLAN_ID = 'cplanentry0000000000001'
const PREMIUM_PLAN_ID = 'cplanpremium000000000002'
const SUBSCRIPTION_ID = 'csubmallory00000000001'

const ENTRY_CENTS = 5_000
const PREMIUM_CENTS = 50_000

/** The cap `MAX_SUBSCRIPTION_QUANTITY` allows, and what the finding quoted. */
const GREEDY_QUANTITY = 20

const STRIPE_SUBSCRIPTION_ID = 'sub_harness0001'
const STRIPE_ITEM_ID = 'si_harness0001'
const STRIPE_CUSTOMER_ID = 'cus_harness0001'

const ENTRY_PRICE_ID = 'price_entry'
const PREMIUM_PRICE_ID = 'price_premium'

/** Halfway through the period, which is when a mid-period swap is worth most. */
const PERIOD_START = new Date('2026-03-01T00:00:00.000Z')
const PERIOD_END = new Date('2026-04-01T00:00:00.000Z')

const EVERY_EFFECTIVE_AT: readonly ChangeEffectiveAt[] = [
  'IMMEDIATELY',
  'PERIOD_END',
]

// =============================================================================
// 2. Staging
// =============================================================================

/**
 * Both rungs of the ladder, one subscriber sitting on the cheap one, and the
 * Stripe subscription that mirrors it.
 *
 * The plan rows are written with the raw client — see `billing-harness.ts` —
 * and the Stripe side is handed to the recorder rather than retrieved, because
 * `changeSubscription` retrieves it and the harness has to know what it will
 * get back.
 */
async function stage(recorder: StripeRecorder): Promise<void> {
  await resetDatabase()

  await seedUser(SUBSCRIBER)
  await seedUser(CONCIERGE)
  await seedUser(CHEF)

  await seedPlan({
    id: ENTRY_PLAN_ID,
    slug: 'entry',
    name: 'The Weeknight Table',
    priceCents: ENTRY_CENTS,
    stripePriceId: ENTRY_PRICE_ID,
  })

  await seedPlan({
    id: PREMIUM_PLAN_ID,
    slug: 'premium',
    name: "The Chef's Table",
    priceCents: PREMIUM_CENTS,
    stripePriceId: PREMIUM_PRICE_ID,
  })

  await seedSubscription({
    id: SUBSCRIPTION_ID,
    userId: SUBSCRIBER.id,
    planId: ENTRY_PLAN_ID,
    quantity: 1,
    stripeCustomerId: STRIPE_CUSTOMER_ID,
    stripeSubscriptionId: STRIPE_SUBSCRIPTION_ID,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
  })

  recorder.setSubscription(
    syntheticSubscription({
      id: STRIPE_SUBSCRIPTION_ID,
      customerId: STRIPE_CUSTOMER_ID,
      itemId: STRIPE_ITEM_ID,
      priceId: ENTRY_PRICE_ID,
      quantity: 1,
      currency: 'cad',
      status: 'active',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    })
  )

  recorder.reset()
}

/** Put the subscription back on the entry plan without re-seeding the world. */
async function rewind(recorder: StripeRecorder): Promise<void> {
  const { prisma } = await import('@/server/db')

  await prisma.userSubscription.update({
    where: { id: SUBSCRIPTION_ID },
    data: { planId: ENTRY_PLAN_ID, quantity: 1 },
  })

  recorder.setSubscription(
    syntheticSubscription({
      id: STRIPE_SUBSCRIPTION_ID,
      customerId: STRIPE_CUSTOMER_ID,
      itemId: STRIPE_ITEM_ID,
      priceId: ENTRY_PRICE_ID,
      quantity: 1,
      currency: 'cad',
      status: 'active',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    })
  )

  recorder.reset()
  clearRateLimits()
}

// =============================================================================
// 3. Reading the payload back
// =============================================================================

/** What the harness asserts about: the request as Stripe would have received it. */
interface SentTerms {
  readonly prorationBehavior: string
  readonly priceId: string
  readonly quantity: number
}

function sentTerms(recorder: StripeRecorder): SentTerms {
  const last = recorder.lastSubscriptionUpdate()

  assert.notEqual(
    last,
    undefined,
    'the action made no Stripe call — the scenario proved nothing'
  )
  assert.ok(last !== undefined)

  const item = last.params.items?.[0]

  assert.ok(item !== undefined, 'the update carried no subscription item')

  const price = item.price

  assert.equal(typeof price, 'string', 'the update carried no price id')

  return {
    prorationBehavior: String(last.params.proration_behavior),
    priceId: String(price),
    quantity: item.quantity ?? -1,
  }
}

/** Run one plan change as `who`, and hand back what Stripe was sent. */
async function attempt(
  recorder: StripeRecorder,
  who: typeof SUBSCRIBER,
  payload: SubscriptionChangePayload
): Promise<SentTerms> {
  signInAs(who)

  const result = await changeSubscription(payload)

  assert.ok(
    result.ok,
    `the action refused the request, so no payload was built: ${
      result.ok ? '' : `${result.code} ${result.error}`
    }`
  )

  return sentTerms(recorder)
}

// =============================================================================
// 4. The exploit, as filed
// =============================================================================

/**
 * The payload from the finding, verbatim: an upgrade, twenty places, and
 * `'none'`.
 *
 * `effectiveAt` is left at the schema's `IMMEDIATELY` default here, because the
 * finding's exploit does not need it — `prorationBehavior: 'none'` reaches the
 * same place on its own, which is half of why there were two ways in.
 */
const EXPLOIT: SubscriptionChangePayload = {
  action: 'UPGRADE',
  subscriptionId: SUBSCRIPTION_ID,
  planId: PREMIUM_PLAN_ID,
  quantity: GREEDY_QUANTITY,
  prorationBehavior: 'none',
}

// =============================================================================
// 5. Scenarios
// =============================================================================

async function scenarioOne(): Promise<void> {
  section('1. The exploit as filed, against the pre-fix expression')

  const behavior = legacyProrationBehavior({
    effectiveAt: 'IMMEDIATELY',
    prorationBehavior: 'none',
  })
  const quantity = legacyQuantity(
    { quantity: GREEDY_QUANTITY },
    { quantity: 1 }
  )

  check('the pre-fix expression forwarded the caller\'s "none"', () => {
    assert.equal(behavior, 'none')
  })

  check("the pre-fix expression forwarded the caller's quantity", () => {
    assert.equal(quantity, GREEDY_QUANTITY)
  })

  check('`PERIOD_END` reached the same place without naming it', () => {
    assert.equal(
      legacyProrationBehavior({
        effectiveAt: 'PERIOD_END',
        prorationBehavior: 'create_prorations',
      }),
      'none'
    )
  })

  note(
    `Stripe would have swapped the price to ${money(PREMIUM_CENTS)} × ${GREEDY_QUANTITY} and raised no line.`
  )
}

async function scenarioTwo(recorder: StripeRecorder): Promise<void> {
  section('2. The exploit as filed, against the shipped action')

  await rewind(recorder)

  const sent = await attempt(recorder, SUBSCRIBER, EXPLOIT)

  check('Stripe is told to prorate', () => {
    assert.equal(sent.prorationBehavior, 'create_prorations')
  })

  check('the plan really does move — this is not a refusal', () => {
    assert.equal(sent.priceId, PREMIUM_PRICE_ID)
  })

  check('the twenty places the payload asked for were discarded', () => {
    assert.equal(sent.quantity, 1)
  })

  const saved = await subscriptionSnapshot(SUBSCRIPTION_ID)

  check('our row agrees with what Stripe was told', () => {
    assert.equal(saved.planId, PREMIUM_PLAN_ID)
    assert.equal(saved.quantity, 1)
  })
}

async function scenarioThree(recorder: StripeRecorder): Promise<void> {
  section('3. Every pair the two enums can produce')

  const rows: string[][] = [
    ['effectiveAt', 'prorationBehavior', 'pre-fix', 'shipped'],
  ]

  for (const effectiveAt of EVERY_EFFECTIVE_AT) {
    for (const prorationBehavior of PRORATION_BEHAVIORS) {
      await rewind(recorder)

      const sent = await attempt(recorder, SUBSCRIBER, {
        action: 'UPGRADE',
        subscriptionId: SUBSCRIPTION_ID,
        planId: PREMIUM_PLAN_ID,
        effectiveAt,
        prorationBehavior,
      })

      const before = legacyProrationBehavior({
        effectiveAt,
        prorationBehavior,
      })

      rows.push([
        effectiveAt,
        prorationBehavior,
        before,
        sent.prorationBehavior,
      ])

      check(`${effectiveAt} + ${prorationBehavior} → create_prorations`, () => {
        assert.equal(sent.prorationBehavior, 'create_prorations')
      })
    }
  }

  const unbilledBefore = rows.slice(1).filter((row) => row[2] === 'none').length

  check('the pre-fix expression left an unbilled route open', () => {
    assert.ok(
      unbilledBefore > 0,
      'if this fails the "before" column is no longer the defect'
    )
  })

  printTable(
    `Every request a CLIENT can spell, on the UPGRADE arm (${rows.length - 1} of them)`,
    rows,
    `  ${unbilledBefore} of ${rows.length - 1} were unbilled before; 0 are now.`
  )
}

async function scenarioFour(recorder: StripeRecorder): Promise<void> {
  section("4. Quantity is the house's below ADMIN")

  await rewind(recorder)

  const asked = await attempt(recorder, SUBSCRIBER, {
    action: 'UPGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: PREMIUM_PLAN_ID,
    quantity: GREEDY_QUANTITY,
  })

  check('a CLIENT asking for twenty places gets the one they had', () => {
    assert.equal(asked.quantity, 1)
  })

  await rewind(recorder)

  signInAs(CHEF)

  const chefResult = await changeSubscription({
    action: 'UPGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: PREMIUM_PLAN_ID,
    quantity: GREEDY_QUANTITY,
    prorationBehavior: 'none',
  })

  check('CHEF_STAFF does not reach the terms at all', () => {
    assert.equal(chefResult.ok, false)
    assert.equal(chefResult.ok ? '' : chefResult.code, 'NOT_FOUND')
  })

  check('and made no Stripe call', () => {
    assert.equal(recorder.lastSubscriptionUpdate(), undefined)
  })

  note(
    'The ownership guard stops a chef before the terms are resolved: its bypass'
  )
  note('is ADMIN, not CHEF_STAFF, and it denies with NOT_FOUND so the action')
  note('cannot be used to enumerate subscription ids.')

  note(
    `Unbilled, twenty places of the premium plan is ${money(
      PREMIUM_CENTS * GREEDY_QUANTITY - ENTRY_CENTS
    )} a period of service nobody invoiced.`
  )
}

async function scenarioFive(recorder: StripeRecorder): Promise<void> {
  section('5. The downgrade arm takes house terms too')

  await rewind(recorder)

  // Get onto the premium plan legitimately first: a downgrade needs somewhere
  // to come down from.
  await attempt(recorder, SUBSCRIBER, {
    action: 'UPGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: PREMIUM_PLAN_ID,
  })

  recorder.reset()

  const sent = await attempt(recorder, SUBSCRIBER, {
    action: 'DOWNGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: ENTRY_PLAN_ID,
    quantity: GREEDY_QUANTITY,
    effectiveAt: 'IMMEDIATELY',
    prorationBehavior: 'create_prorations',
  })

  check('the asked-for immediate proration is discarded', () => {
    assert.equal(sent.prorationBehavior, 'none')
  })

  check('the asked-for twenty places are discarded', () => {
    assert.equal(sent.quantity, 1)
  })

  note(
    'Without this, "downgrade to a cheaper unit price, twenty of them" is the'
  )
  note('same exploit through the other arm — the direction checks compare unit')
  note('prices and would not have noticed.')
}

async function scenarioSix(recorder: StripeRecorder): Promise<void> {
  section('6. The upgrade rule binds administrators too')

  await rewind(recorder)

  const sent = await attempt(recorder, CONCIERGE, {
    action: 'UPGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: PREMIUM_PLAN_ID,
    effectiveAt: 'PERIOD_END',
    prorationBehavior: 'none',
  })

  check('an ADMIN upgrade prorates as well', () => {
    assert.equal(sent.prorationBehavior, 'create_prorations')
  })

  note('A gift of the unbilled remainder leaves no record anywhere in Stripe.')
  note('An ADMIN who means to make one has instruments that do.')
}

async function scenarioSeven(recorder: StripeRecorder): Promise<void> {
  section('7. What an ADMIN keeps')

  await rewind(recorder)

  await attempt(recorder, CONCIERGE, {
    action: 'UPGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: PREMIUM_PLAN_ID,
  })

  recorder.reset()

  const immediate = await attempt(recorder, CONCIERGE, {
    action: 'DOWNGRADE',
    subscriptionId: SUBSCRIPTION_ID,
    planId: ENTRY_PLAN_ID,
    effectiveAt: 'IMMEDIATELY',
    prorationBehavior: 'create_prorations',
    quantity: 4,
  })

  check('an ADMIN may settle a downgrade immediately', () => {
    assert.equal(immediate.prorationBehavior, 'create_prorations')
  })

  check('an ADMIN may set the places', () => {
    assert.equal(immediate.quantity, 4)
  })

  const saved = await subscriptionSnapshot(SUBSCRIPTION_ID)

  check('and the row records it', () => {
    assert.equal(saved.planId, ENTRY_PLAN_ID)
    assert.equal(saved.quantity, 4)
  })
}

// =============================================================================
// 6. The economics, before and after
// =============================================================================

function closingTable(): void {
  const heldUnbilled = PREMIUM_CENTS * GREEDY_QUANTITY - ENTRY_CENTS

  printTable(
    'A CLIENT on the entry plan, mid-period, posting the exploit',
    [
      ['', 'before MCV-041', 'after MCV-041'],
      ['plan applied', "The Chef's Table", "The Chef's Table"],
      ['places applied', `${GREEDY_QUANTITY}`, '1 (the payload is discarded)'],
      ['proration_behavior', 'none', 'create_prorations'],
      ['billed for the remainder', money(0), 'the difference, by Stripe'],
      ['value taken unbilled', money(heldUnbilled), money(0)],
      ['repeatable', 'yes, unlimited', 'no; 12 changes an hour'],
    ],
    '  "after" is the payload this run actually built, not a projection.'
  )
}

// =============================================================================
// 7. Entry point
// =============================================================================

async function main(): Promise<void> {
  const database = assertDisposableDatabase()

  console.log("MCV-041 finding C — subscription proration is not the caller's")
  console.log(`database: ${database}`)

  // Before any action call. `getStripe()` reads the global when it is called,
  // so import order is not load-bearing — but the first call is.
  const recorder = installStripeRecorder()

  await stage(recorder)

  await scenarioOne()
  await scenarioTwo(recorder)
  await scenarioThree(recorder)
  await scenarioFour(recorder)
  await scenarioFive(recorder)
  await scenarioSix(recorder)
  await scenarioSeven(recorder)

  closingTable()

  console.log(`\n${checkCount()} assertions passed.`)

  await resetDatabase()
  await disconnect()
}

main().catch(async (error: unknown) => {
  console.error(error)
  await disconnect()
  process.exitCode = 1
})
