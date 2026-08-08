// mannachef/apps/web/scripts/verify-mcv043.ts

/**
 * MCV-043 — the re-quote marker (finding G) and the referral programme's
 * economics.
 *
 * ```bash
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter @mannachef/web verify:mcv043
 * ```
 *
 * Exits non-zero on the first failed assertion.
 *
 * ## What this drives
 *
 * The **real** Server Actions against a **real** PostgreSQL, through
 * `scripts/action-resolver.mjs` — the real `withAction` wrapper, the real role
 * checks, the real zod schemas, the real handler bodies, the real Prisma client,
 * and the real `CHECK` constraints from `prisma/migrations`. Only the session
 * and the three request-scoped Next.js modules are substituted, at module
 * resolution, so nothing under `src/` knows this file exists.
 *
 * That last point matters more here than usual. Two of the four findings are
 * closed *partly in SQL* — `ReferralProgram_reward_economics_check` and
 * `ChefAppointment_quotedGuestCount_range_check` — and a harness against a fake
 * database would be evidence about the fake's author's beliefs rather than about
 * PostgreSQL. Section 3 deliberately goes around the validator and writes with
 * the raw client, for exactly that reason.
 *
 * ## The four things it proves
 *
 *  1. **Finding G.** A household may still change the party size when it moves
 *     an engagement — that is the product decision, and it is asserted rather
 *     than assumed — but the quote taken for the old party size is now visibly
 *     stale instead of silently wrong. The money columns are untouched by the
 *     reschedule in either direction, the household cannot re-price, and the
 *     concierge's re-quote is refused if the party moved underneath it.
 *  2. **A zero-amount invoice never qualifies a referral.** The invoice used is
 *     the shape Stripe actually sends for a trial start: `status: PAID`,
 *     `amount_paid: 0`, `paid_at` set. It is refused by a programme whose floor
 *     is zero, which is the configuration that made it free.
 *  3. **A programme may not pay out more than the invoice that earns it**,
 *     unless somebody has said so on the row — at the validator, and at the
 *     database.
 *  4. **Minting invitation codes is rate limited.** Proved by exhausting the
 *     bucket and then emptying it, so the refusal is attributable to the bucket
 *     and not to anything else the sixth call might have tripped over.
 */

import assert from 'node:assert/strict'

import {
  repriceAppointment,
  requestAppointment,
  rescheduleAppointment,
} from '@/server/actions/booking'
import {
  createReferralCode,
  redeemReferralCode,
  settleReferralRedemptions,
} from '@/server/actions/referral'
import { updateReferralProgram } from '@/server/actions/referral-program'
import type { ActionResult } from '@/server/actions/types'
import { prisma } from '@/server/db'

import { assertDisposableDatabase, clearRateLimits } from './fixtures/database'
import { signInAs, type HarnessUser } from './fixtures/harness-state'
import {
  check,
  checkCount,
  money,
  note,
  printTable,
  section,
} from './fixtures/report'

// =============================================================================
// 1. Unwrapping an action result
// =============================================================================

interface ActionFailureShape {
  readonly error: string
  readonly code: string
  readonly fieldErrors?: Record<string, string[]> | undefined
}

function expectOk<T>(result: ActionResult<T>): T {
  assert.ok(
    result.ok,
    `expected success, got ${result.ok ? '' : `${result.code}: ${result.error}`}`
  )

  return result.data
}

function expectFail<T>(result: ActionResult<T>): ActionFailureShape {
  assert.ok(!result.ok, 'expected a refusal, got success')

  return result
}

// =============================================================================
// 2. The cast
//
// Ids are literal cuids because every one of them travels through `cuidSchema`
// before an action body is reached; a readable placeholder would be rejected by
// validation and the scenario would prove nothing.
// =============================================================================

/** The household whose dinner grows from four people to forty. */
const HOUSEHOLD: HarnessUser = {
  id: 'cuserhousehold0000000001',
  name: 'Beatrice Ardagh',
  email: 'beatrice.ardagh@example.com',
  image: null,
  role: 'CLIENT',
  isActive: true,
  timeZone: 'UTC',
  locale: 'en-CA',
  clientProfileId: 'cclienthousehold00000001',
  staffProfileId: null,
}

/** The chef booked to cook it, who is also the person who quotes it. */
const CHEF: HarnessUser = {
  ...HOUSEHOLD,
  id: 'cuserchef00000000000002',
  name: 'Chef Aurélien',
  email: 'aurelien@mannachef.test',
  role: 'CHEF_STAFF',
  clientProfileId: null,
  staffProfileId: 'cstaffchef000000000002',
}

/** Runs the settlement sweep. `settleReferralRedemptions` is `ADMIN`. */
const CONCIERGE: HarnessUser = {
  ...HOUSEHOLD,
  id: 'cuserconcierge000000003',
  name: 'The Concierge',
  email: 'concierge@mannachef.test',
  role: 'ADMIN',
  clientProfileId: null,
}

/** Sets the standing offer. `updateReferralProgram` is `SUPER_ADMIN`. */
const OWNER: HarnessUser = {
  ...HOUSEHOLD,
  id: 'cuserowner0000000000004',
  name: 'The Proprietor',
  email: 'owner@mannachef.test',
  role: 'SUPER_ADMIN',
  clientProfileId: null,
}

/** An unrelated household, so a genuine referral has somebody to be earned by. */
const NEIGHBOUR: HarnessUser = {
  ...HOUSEHOLD,
  id: 'cuserneighbour000000005',
  name: 'Eleanor Whitcombe',
  email: 'eleanor.whitcombe@example.net',
  clientProfileId: 'cclientneighbour00000005',
}

// =============================================================================
// 3. The world the actions find
//
// Built with the raw client on purpose. This is the premise of each scenario,
// not a thing under test, and seeding it through the actions would make every
// assertion below depend on a second action also being correct.
// =============================================================================

async function resetDatabase(): Promise<void> {
  await prisma.chefAppointment.deleteMany({})
  await prisma.chefAvailability.deleteMany({})
  await prisma.staffProfile.deleteMany({})
  await prisma.user.deleteMany({})
  await prisma.referralProgram.deleteMany({})

  clearRateLimits()
  signInAs(null)
}

async function seedUser(person: HarnessUser): Promise<void> {
  await prisma.user.create({
    data: {
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role,
      isActive: person.isActive,
      timeZone: person.timeZone,
      locale: person.locale,
      ...(person.clientProfileId === null
        ? {}
        : {
            clientProfile: {
              create: {
                id: person.clientProfileId,
                displayName: person.name,
                preferredName: person.name,
                status: 'ACTIVE_SUBSCRIBER',
                source: 'DIRECT',
                preferredContactMethod: 'EMAIL',
              },
            },
          }),
      ...(person.staffProfileId === null
        ? {}
        : {
            staffProfile: {
              create: {
                id: person.staffProfileId,
                title: 'Chef de cuisine',
                specialties: [],
                languages: ['en'],
                // Finding H's column, seeded non-zero so that the appointment
                // figures below cannot accidentally have come from it.
                hourlyRateCents: 25_000,
                currency: 'CAD',
                calendarTimeZone: 'UTC',
                isAcceptingClients: true,
                maxConcurrentEvents: 1,
              },
            },
          }),
    },
    select: { id: true },
  })
}

/**
 * Open the chef's diary for every day of the week, all day, in UTC.
 *
 * `evaluateBooking` refuses a candidate that falls outside published
 * availability, and rightly — but availability is not what any of this is
 * about, so it is made total. Every booking below sits in the middle of a day,
 * well away from the midnight seam where two adjacent windows meet.
 */
async function seedAvailability(staffProfileId: string): Promise<void> {
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    await prisma.chefAvailability.create({
      data: {
        staffProfileId,
        kind: 'RECURRING_WEEKLY',
        dayOfWeek,
        startMinute: 0,
        endMinute: 1_440,
        timeZone: 'UTC',
        isBlackout: false,
      },
      select: { id: true },
    })
  }
}

/** A `PAID` invoice, which is what `findQualifyingInvoice` looks for. */
async function seedPaidInvoice(
  userId: string,
  amountPaidCents: number,
  paidAt: Date
): Promise<string> {
  const row = await prisma.invoice.create({
    data: {
      userId,
      amountDueCents: amountPaidCents,
      amountPaidCents,
      amountRemainingCents: 0,
      subtotalCents: amountPaidCents,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: paidAt,
      paidAt,
    },
    select: { id: true },
  })

  return row.id
}

// =============================================================================
// 4. Times, and the payloads that carry them
// =============================================================================

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS

/** A Wednesday evening a fortnight out, so no rule about the past can fire. */
function futureAt(daysAhead: number, hourUtc: number): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS)

  base.setUTCHours(hourUtc, 0, 0, 0)

  return base
}

const ADDRESS = {
  line1: '18 Rosedale Heights Drive',
  city: 'Toronto',
  region: 'Ontario',
  postalCode: 'M4T 1C4',
  country: 'CA',
} as const

const QUOTED_TOTAL_CENTS = 400_00
const QUOTED_DEPOSIT_CENTS = 100_00
const REQUOTED_TOTAL_CENTS = 4_000_00
const REQUOTED_DEPOSIT_CENTS = 1_000_00

// =============================================================================
// 5. Finding G — the party grows, and the quote goes stale rather than wrong
// =============================================================================

async function scenarioRequote(): Promise<void> {
  section('1. Finding G — a party of four rescheduled as a party of forty')

  await resetDatabase()
  await seedUser(HOUSEHOLD)
  await seedUser(CHEF)
  await seedAvailability(CHEF.staffProfileId ?? '')

  const firstStart = futureAt(14, 18)
  const firstEnd = new Date(firstStart.getTime() + 3 * HOUR_MS)

  // The concierge books and prices it in one call, which is the only way money
  // has ever reached a `ChefAppointment`: `requestAppointment` writes
  // `totalCents: staffCaller ? input.totalCents : 0`.
  signInAs(CHEF)
  const booked = expectOk(
    await requestAppointment({
      clientProfileId: HOUSEHOLD.clientProfileId ?? '',
      staffProfileId: CHEF.staffProfileId ?? '',
      serviceType: 'IN_HOME_DINNER',
      startsAt: firstStart,
      endsAt: firstEnd,
      guestCount: 4,
      address: ADDRESS,
      totalCents: QUOTED_TOTAL_CENTS,
      depositCents: QUOTED_DEPOSIT_CENTS,
      gratuityCents: 0,
      currency: 'CAD',
    })
  )

  check('a staff booking records the party size it was quoted for', () => {
    assert.equal(booked.guestCount, 4)
    assert.equal(booked.totalCents, QUOTED_TOTAL_CENTS)
    assert.equal(booked.quotedGuestCount, 4)
    assert.equal(booked.requiresRequote, false)
  })

  // --- The finding itself -------------------------------------------------

  signInAs(HOUSEHOLD)
  const withMoney = expectFail(
    await rescheduleAppointment({
      appointmentId: booked.id,
      startsAt: new Date(firstStart.getTime() + DAY_MS),
      endsAt: new Date(firstEnd.getTime() + DAY_MS),
      totalCents: 1,
    })
  )

  check('a household still cannot touch the money on a reschedule', () => {
    assert.equal(withMoney.code, 'VALIDATION')
    assert.ok(withMoney.fieldErrors !== undefined)
    assert.ok('totalCents' in withMoney.fieldErrors)
  })

  const secondStart = futureAt(21, 18)
  const secondEnd = new Date(secondStart.getTime() + 3 * HOUR_MS)

  const moved = expectOk(
    await rescheduleAppointment({
      appointmentId: booked.id,
      startsAt: secondStart,
      endsAt: secondEnd,
      guestCount: 40,
    })
  )

  check('…but it may still say forty are coming — the change lands', () => {
    assert.equal(moved.guestCount, 40)
    assert.equal(moved.startsAt.getTime(), secondStart.getTime())
  })

  check('the four-person figures are neither honoured nor erased', () => {
    assert.equal(moved.totalCents, QUOTED_TOTAL_CENTS)
    assert.equal(moved.depositCents, QUOTED_DEPOSIT_CENTS)
  })

  check('and the engagement now says so: it needs re-quoting', () => {
    assert.equal(moved.quotedGuestCount, 4)
    assert.equal(moved.requiresRequote, true)
  })

  note(
    'Before MCV-043 the row was identical except for the last two fields, which'
  )
  note(
    'did not exist — forty guests at the four-person price, and nothing to say so.'
  )

  // --- Clearing it --------------------------------------------------------

  const householdReprice = expectFail(
    await repriceAppointment({
      appointmentId: booked.id,
      guestCount: 40,
      totalCents: 1,
      depositCents: 0,
      gratuityCents: 0,
      currency: 'CAD',
    })
  )

  check(
    'a household may not clear the marker by pricing its own dinner',
    () => {
      assert.equal(householdReprice.code, 'FORBIDDEN')
    }
  )

  signInAs(CHEF)
  const stale = expectFail(
    await repriceAppointment({
      appointmentId: booked.id,
      guestCount: 4,
      totalCents: QUOTED_TOTAL_CENTS,
      depositCents: QUOTED_DEPOSIT_CENTS,
      gratuityCents: 0,
      currency: 'CAD',
    })
  )

  check('a quote made for a party that has since moved is refused', () => {
    assert.equal(stale.code, 'CONFLICT')
    assert.ok(stale.fieldErrors !== undefined)
    assert.deepEqual(stale.fieldErrors['guestCount'], ['It is now 40 guests.'])
  })

  const stillStale = await prisma.chefAppointment.findUniqueOrThrow({
    where: { id: booked.id },
    select: { totalCents: true, quotedGuestCount: true },
  })

  check('…and it wrote nothing on its way out', () => {
    assert.equal(stillStale.totalCents, QUOTED_TOTAL_CENTS)
    assert.equal(stillStale.quotedGuestCount, 4)
  })

  const repriced = expectOk(
    await repriceAppointment({
      appointmentId: booked.id,
      guestCount: 40,
      totalCents: REQUOTED_TOTAL_CENTS,
      depositCents: REQUOTED_DEPOSIT_CENTS,
      gratuityCents: 0,
      currency: 'CAD',
    })
  )

  check('quoting for the party that is actually coming clears it', () => {
    assert.equal(repriced.totalCents, REQUOTED_TOTAL_CENTS)
    assert.equal(repriced.depositCents, REQUOTED_DEPOSIT_CENTS)
    assert.equal(repriced.quotedGuestCount, 40)
    assert.equal(repriced.requiresRequote, false)
  })

  // --- The unpriced case --------------------------------------------------

  const ownStart = futureAt(28, 18)
  const ownEnd = new Date(ownStart.getTime() + 3 * HOUR_MS)

  signInAs(HOUSEHOLD)
  const selfBooked = expectOk(
    await requestAppointment({
      clientProfileId: HOUSEHOLD.clientProfileId ?? '',
      staffProfileId: CHEF.staffProfileId ?? '',
      serviceType: 'IN_HOME_DINNER',
      startsAt: ownStart,
      endsAt: ownEnd,
      guestCount: 2,
      address: ADDRESS,
      currency: 'CAD',
    })
  )

  const selfMoved = expectOk(
    await rescheduleAppointment({
      appointmentId: selfBooked.id,
      startsAt: new Date(ownStart.getTime() + DAY_MS),
      endsAt: new Date(ownEnd.getTime() + DAY_MS),
      guestCount: 12,
    })
  )

  check('a booking nobody has priced never asks to be re-priced', () => {
    assert.equal(selfBooked.totalCents, 0)
    assert.equal(selfBooked.quotedGuestCount, null)
    assert.equal(selfMoved.guestCount, 12)
    assert.equal(selfMoved.quotedGuestCount, null)
    assert.equal(selfMoved.requiresRequote, false)
  })

  printTable(
    'The engagement, at each step',
    [
      [
        'step',
        'guestCount',
        'totalCents',
        'quotedGuestCount',
        'requiresRequote',
      ],
      ['booked and quoted', '4', money(QUOTED_TOTAL_CENTS), '4', 'false'],
      [
        'rescheduled by the household',
        '40',
        money(QUOTED_TOTAL_CENTS),
        '4',
        'true',
      ],
      [
        're-quoted by the chef',
        '40',
        money(REQUOTED_TOTAL_CENTS),
        '40',
        'false',
      ],
    ],
    '  The middle row is the finding. It is still reachable — a household may still\n' +
      '  grow its own party — and it is no longer silent.'
  )
}

// =============================================================================
// 6. The economics — an invoice paid for nothing
// =============================================================================

/**
 * The offer the two referral scenarios run against.
 *
 * A floor of zero, which is what the column defaults to and what makes the
 * abuse free, plus an acknowledged loss so the row can exist at all. Both
 * halves are deliberate: this is the *most* permissive programme the platform
 * will now store, and the zero-amount invoice is refused even by it.
 */
const OPEN_OFFER = {
  key: 'default',
  rewardType: 'FIXED_CREDIT',
  rewardValueCents: 50_00,
  currency: 'CAD',
  refereeRewardCents: null,
  defaultMaxRedemptions: null,
  defaultExpiryDays: null,
  minimumQualifyingInvoiceCents: 0,
  allowLossLeader: true,
  isActive: true,
} as const

async function scenarioZeroAmountInvoice(): Promise<void> {
  section('2. A Stripe trial invoice is PAID, and earns nobody anything')

  await resetDatabase()
  await seedUser(HOUSEHOLD)
  await seedUser(NEIGHBOUR)
  await seedUser(CONCIERGE)
  await seedUser(OWNER)

  signInAs(OWNER)
  expectOk(await updateReferralProgram({ ...OPEN_OFFER }))

  signInAs(HOUSEHOLD)
  const minted = expectOk(
    await createReferralCode({
      ownerId: HOUSEHOLD.id,
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 50_00,
      currency: 'CAD',
    })
  )

  signInAs(NEIGHBOUR)
  expectOk(await redeemReferralCode({ code: minted.code }))

  // Exactly what `handleInvoiceChanged` writes for a Stripe trial start or a
  // 100%-off promotion: `status: 'PAID'` from `invoiceStatusFor`,
  // `amountPaidCents: invoice.amount_paid` — zero — and a real `paid_at`.
  //
  // Both invoices in this scenario are paid *after* the redemption above, since
  // MCV-051 bounds `findQualifyingInvoice` below by the redemption's own
  // `qualifyingFromAt`. Dating them into the past would make this scenario stop
  // being about the amount, which is what it is here to be about.
  const trialInvoiceId = await seedPaidInvoice(NEIGHBOUR.id, 0, new Date())

  signInAs(CONCIERGE)
  const firstSweep = expectOk(await settleReferralRedemptions({}))

  const afterTrial = await prisma.referralRedemption.findFirstOrThrow({
    where: { referredUserId: NEIGHBOUR.id },
    select: { status: true, rewardCents: true },
  })
  const creditedAfterTrial = await prisma.rewardLedgerEntry.count({
    where: { userId: HOUSEHOLD.id },
  })

  check('the sweep looked at the redemption and left it alone', () => {
    assert.equal(firstSweep.examined, 1)
    assert.equal(firstSweep.qualified, 0)
    assert.equal(firstSweep.rewarded, 0)
    assert.equal(firstSweep.creditedCents, 0)
  })

  check(
    'a PAID invoice of nothing qualifies nothing, at a floor of zero',
    () => {
      assert.equal(afterTrial.status, 'PENDING')
      assert.equal(afterTrial.rewardCents, null)
      assert.equal(creditedAfterTrial, 0)
    }
  )

  note(
    `the invoice is real and is still there: ${trialInvoiceId} — PAID, paid_at set, amount_paid 0`
  )

  // One cent is enough. The rule is not a floor in disguise.
  await seedPaidInvoice(NEIGHBOUR.id, 1, new Date())

  const secondSweep = expectOk(await settleReferralRedemptions({}))
  const afterPenny = await prisma.referralRedemption.findFirstOrThrow({
    where: { referredUserId: NEIGHBOUR.id },
    select: { status: true, rewardCents: true },
  })

  check('a single cent does qualify — the rule is about zero, not size', () => {
    assert.equal(secondSweep.qualified, 1)
    assert.equal(secondSweep.rewarded, 1)
    assert.equal(secondSweep.creditedCents, 50_00)
    assert.equal(afterPenny.status, 'REWARDED')
  })

  printTable(
    'What the referred household paid, and what the inviter earned',
    [
      ['invoice', 'status', 'amount_paid', 'qualifies?', 'credited'],
      ['trial start', 'PAID', money(0), 'no', money(0)],
      ['first real bill', 'PAID', money(1), 'yes', money(50_00)],
    ],
    '  Both rows are against a programme whose floor is 0. Before MCV-043 the first\n' +
      '  row read "yes" and "$50.00", and the whole cost of getting there was a signup.'
  )
}

// =============================================================================
// 7. The economics — an offer that cannot quietly lose money
// =============================================================================

async function scenarioLossLeader(): Promise<void> {
  section('3. An offer may not pay out more than the invoice that earns it')

  await resetDatabase()
  await seedUser(OWNER)
  signInAs(OWNER)

  const underWater = expectFail(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 50_00,
      currency: 'CAD',
      refereeRewardCents: null,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 0,
      isActive: true,
    })
  )

  const writtenAnyway = await prisma.referralProgram.count({})

  check('a $50 reward against a floor of nothing is refused', () => {
    assert.equal(underWater.code, 'VALIDATION')
    assert.ok(underWater.fieldErrors !== undefined)
    assert.ok('minimumQualifyingInvoiceCents' in underWater.fieldErrors)
    assert.match(underWater.error, /pays out more than the invoice/)
  })

  check('…and the refusal happened before the row existed', () => {
    assert.equal(writtenAnyway, 0)
  })

  const acknowledged = expectOk(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 50_00,
      currency: 'CAD',
      refereeRewardCents: null,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 0,
      allowLossLeader: true,
      isActive: true,
    })
  )

  check('the identical offer is accepted once the loss is acknowledged', () => {
    assert.equal(acknowledged.rewardValueCents, 50_00)
    assert.equal(acknowledged.minimumQualifyingInvoiceCents, 0)
    assert.equal(acknowledged.allowLossLeader, true)
  })

  const breakEven = expectOk(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 50_00,
      currency: 'CAD',
      refereeRewardCents: 50_00,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 100_00,
      isActive: true,
    })
  )

  check('exactly breaking even is allowed, and turns the flag back off', () => {
    assert.equal(breakEven.allowLossLeader, false)
    assert.equal(breakEven.minimumQualifyingInvoiceCents, 100_00)
  })

  const oneCentUnder = expectFail(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 50_00,
      currency: 'CAD',
      refereeRewardCents: 50_01,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 100_00,
      isActive: true,
    })
  )

  check('one cent under water is refused — the boundary is exact', () => {
    assert.equal(oneCentUnder.code, 'VALIDATION')
  })

  const wholeInvoice = expectOk(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'PERCENT_DISCOUNT',
      rewardValuePercent: 100,
      currency: 'CAD',
      refereeRewardCents: null,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 100_00,
      isActive: true,
    })
  )

  check('giving away the entire invoice breaks even, so it is allowed', () => {
    assert.equal(wholeInvoice.rewardValuePercent, 100)
  })

  const percentPlusReferee = expectFail(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'PERCENT_DISCOUNT',
      rewardValuePercent: 100,
      currency: 'CAD',
      refereeRewardCents: 1,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 100_00,
      isActive: true,
    })
  )

  check('the whole invoice plus a penny for the guest is not', () => {
    assert.equal(percentPlusReferee.code, 'VALIDATION')
  })

  // --- And the database says the same thing -------------------------------

  const stored = await prisma.referralProgram.findUniqueOrThrow({
    where: { key: 'default' },
    select: { id: true },
  })

  let constraintMessage = ''

  try {
    // Straight past the validator, with the raw client, the way a `psql`
    // session or a future action that forgot the rule would. This is the
    // assertion the whole harness is pointed at a real PostgreSQL for.
    await prisma.referralProgram.update({
      where: { id: stored.id },
      data: {
        rewardType: 'FIXED_CREDIT',
        rewardValueCents: 1_000_00,
        rewardValuePercent: null,
        refereeRewardCents: null,
        minimumQualifyingInvoiceCents: 0,
        allowLossLeader: false,
      },
      select: { id: true },
    })
  } catch (error) {
    constraintMessage = error instanceof Error ? error.message : String(error)
  }

  check(
    'PostgreSQL refuses the same offer written around the validator',
    () => {
      assert.match(constraintMessage, /ReferralProgram_reward_economics_check/)
    }
  )

  const survived = await prisma.referralProgram.findUniqueOrThrow({
    where: { id: stored.id },
    select: { rewardValuePercent: true, minimumQualifyingInvoiceCents: true },
  })

  check('…so the row is exactly as the last accepted write left it', () => {
    assert.equal(survived.rewardValuePercent, 100)
    assert.equal(survived.minimumQualifyingInvoiceCents, 100_00)
  })
}

// =============================================================================
// 8. Rate limiting the mint
// =============================================================================

const MINT_BUDGET = 5

async function scenarioMintRateLimit(): Promise<void> {
  section('4. Minting invitation codes is metered')

  await resetDatabase()
  await seedUser(HOUSEHOLD)
  await seedUser(OWNER)

  signInAs(OWNER)
  expectOk(
    await updateReferralProgram({
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 25_00,
      currency: 'CAD',
      refereeRewardCents: 10_00,
      defaultMaxRedemptions: null,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: 500_00,
      isActive: true,
    })
  )

  signInAs(HOUSEHOLD)

  for (let attempt = 0; attempt < MINT_BUDGET; attempt += 1) {
    expectOk(
      await createReferralCode({
        ownerId: HOUSEHOLD.id,
        rewardType: 'FIXED_CREDIT',
        rewardValueCents: 25_00,
        currency: 'CAD',
      })
    )
  }

  const refused = expectFail(
    await createReferralCode({
      ownerId: HOUSEHOLD.id,
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 25_00,
      currency: 'CAD',
    })
  )

  const mintedSoFar = await prisma.referralCode.count({
    where: { ownerId: HOUSEHOLD.id },
  })

  check(
    `${String(MINT_BUDGET)} codes an hour are minted, and the next is not`,
    () => {
      assert.equal(mintedSoFar, MINT_BUDGET)
      assert.equal(refused.code, 'RATE_LIMITED')
    }
  )

  // Emptying the bucket is what attributes the refusal *to* the bucket: if the
  // sixth call had failed for any other reason, the seventh would fail too.
  clearRateLimits()

  expectOk(
    await createReferralCode({
      ownerId: HOUSEHOLD.id,
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 25_00,
      currency: 'CAD',
    })
  )

  const mintedAfter = await prisma.referralCode.count({
    where: { ownerId: HOUSEHOLD.id },
  })

  check('an emptied bucket mints again — the limiter was the refusal', () => {
    assert.equal(mintedAfter, MINT_BUDGET + 1)
  })

  note(
    'The buckets live in the process. See the production note on `rateLimit`.'
  )
}

// =============================================================================
// 9. Entry point
// =============================================================================

async function main(): Promise<void> {
  const database = assertDisposableDatabase()

  console.log(`MCV-043 — findings G and H, and the programme's economics`)
  console.log(`database: ${database}\n`)

  await scenarioRequote()
  await scenarioZeroAmountInvoice()
  await scenarioLossLeader()
  await scenarioMintRateLimit()

  await resetDatabase()
  await prisma.$disconnect()

  console.log(`\nPASS — ${String(checkCount())} assertions, 0 failures.`)
}

await main()
