// mannachef/apps/web/src/server/scheduling.test.ts

/**
 * Unit tests for the booking conflict engine.
 *
 * Run with `pnpm --filter @mannachef/web test`. There is no database, no clock,
 * and no network: every test is a pure function call over literal data, which is
 * the entire reason `./scheduling` was written the way it was.
 *
 * ## The fixture calendar
 *
 * One chef, `America/Toronto`, available every Tuesday 09:00–17:00 local.
 *
 * Instants are written in UTC throughout, with the local time in a comment,
 * because the whole point of the time-zone tests is that the same local rule
 * lands on different UTC instants either side of a transition:
 *
 * | Local (Toronto)          | UTC                    | Offset |
 * | ------------------------ | ---------------------- | ------ |
 * | Tue 2024-03-05 09:00 EST | `2024-03-05T14:00:00Z` | −05:00 |
 * | Tue 2024-03-12 09:00 EDT | `2024-03-12T13:00:00Z` | −04:00 |
 * | Tue 2024-06-11 09:00 EDT | `2024-06-11T13:00:00Z` | −04:00 |
 * | Tue 2024-06-11 17:00 EDT | `2024-06-11T21:00:00Z` | −04:00 |
 *
 * The 2024 transitions used below are Sunday 10 March (02:00 EST → 03:00 EDT,
 * one hour vanishes) and Sunday 3 November (02:00 EDT → 01:00 EST, one hour
 * repeats).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { APPOINTMENT_TRANSITIONS } from '@mannachef/validators'
import type { AppointmentStatus } from '@mannachef/validators'

import {
  checkCapacity,
  checkStatusTransition,
  evaluateBooking,
  expandAvailability,
  findConflicts,
  isWithinAvailability,
  MAX_EXPANSION_DAYS,
  MAX_TRAVEL_BUFFER_MINUTES,
  occupiedInterval,
  resolveWallClock,
  suggestAlternatives,
  timeZoneOffsetMs,
  validateBookingTiming,
} from './scheduling'
import type {
  AppointmentLike,
  AvailabilityRule,
  AvailabilityWindow,
  BookingConflict,
  BookingSlotLike,
  BookingTiming,
  SchedulingStaffProfile,
  TimeRange,
} from './scheduling'

// =============================================================================
// Fixtures
// =============================================================================

const TORONTO = 'America/Toronto'
const HOUR = 3_600_000

function at(iso: string): Date {
  return new Date(iso)
}

function range(from: string, until: string): TimeRange {
  return { from: at(from), until: at(until) }
}

function staff(
  maxConcurrentEvents = 1,
  calendarTimeZone = TORONTO
): SchedulingStaffProfile {
  return { maxConcurrentEvents, calendarTimeZone }
}

function rule(overrides: Partial<AvailabilityRule> = {}): AvailabilityRule {
  return {
    id: 'rule-tuesday',
    kind: 'RECURRING_WEEKLY',
    dayOfWeek: 2,
    specificDate: null,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    timeZone: null,
    effectiveFrom: null,
    effectiveUntil: null,
    isBlackout: false,
    ...overrides,
  }
}

function booking(
  startsAt: string,
  endsAt: string,
  overrides: Partial<BookingTiming> = {}
): BookingTiming {
  return {
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    prepStartsAt: null,
    travelBufferBeforeMinutes: 0,
    travelBufferAfterMinutes: 0,
    ...overrides,
  }
}

function appointment(
  id: string,
  startsAt: string,
  endsAt: string,
  overrides: Partial<Omit<AppointmentLike, 'id'>> = {}
): AppointmentLike {
  return {
    id,
    status: 'CONFIRMED',
    ...booking(startsAt, endsAt),
    ...overrides,
  }
}

function slot(overrides: Partial<BookingSlotLike> = {}): BookingSlotLike {
  return {
    id: 'slot-1',
    capacity: 1,
    bookedCount: 0,
    status: 'OPEN',
    holdsUntil: null,
    ...overrides,
  }
}

function isoWindows(windows: readonly AvailabilityWindow[]): readonly string[] {
  return windows.map(
    (window) => `${window.start.toISOString()}/${window.end.toISOString()}`
  )
}

function kinds(reasons: readonly BookingConflict[]): readonly string[] {
  return reasons.map((reason) => reason.kind)
}

/** The Tuesday window on 2024-06-11 in UTC: 09:00–17:00 EDT. */
const JUNE_TUESDAY = '2024-06-11T13:00:00.000Z/2024-06-11T21:00:00.000Z'
const JUNE_RANGE = range('2024-06-10T00:00:00Z', '2024-06-13T00:00:00Z')
const BEFORE_EVERYTHING = at('2024-06-01T00:00:00Z')

// =============================================================================
// 1. occupiedInterval — what a booking actually costs
// =============================================================================

describe('occupiedInterval', () => {
  it('is startsAt..endsAt when there is no preparation and no travel', () => {
    const occupied = occupiedInterval(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z')
    )

    assert.equal(occupied.start.toISOString(), '2024-06-11T15:00:00.000Z')
    assert.equal(occupied.end.toISOString(), '2024-06-11T17:00:00.000Z')
    assert.equal(occupied.coreStart.toISOString(), '2024-06-11T15:00:00.000Z')
    assert.equal(occupied.coreEnd.toISOString(), '2024-06-11T17:00:00.000Z')
  })

  it('starts at prepStartsAt when preparation begins before service', () => {
    const occupied = occupiedInterval(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        prepStartsAt: at('2024-06-11T13:30:00Z'),
      })
    )

    assert.equal(occupied.coreStart.toISOString(), '2024-06-11T13:30:00.000Z')
    assert.equal(occupied.start.toISOString(), '2024-06-11T13:30:00.000Z')
  })

  it('composes prep and both travel buffers into one interval', () => {
    const occupied = occupiedInterval(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        prepStartsAt: at('2024-06-11T13:00:00Z'),
        travelBufferBeforeMinutes: 30,
        travelBufferAfterMinutes: 45,
      })
    )

    // 13:00 prep − 30m travel … 17:00 service end + 45m travel.
    assert.equal(occupied.start.toISOString(), '2024-06-11T12:30:00.000Z')
    assert.equal(occupied.end.toISOString(), '2024-06-11T17:45:00.000Z')
    assert.equal(occupied.coreStart.toISOString(), '2024-06-11T13:00:00.000Z')
    assert.equal(occupied.coreEnd.toISOString(), '2024-06-11T17:00:00.000Z')
  })

  it('takes the minimum, so a prepStartsAt after startsAt cannot shrink the booking', () => {
    const occupied = occupiedInterval(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        // Nonsense the validators reject on the way in; a legacy row must still
        // not be able to make the occupied interval smaller than the service.
        prepStartsAt: at('2024-06-11T16:00:00Z'),
      })
    )

    assert.equal(occupied.coreStart.toISOString(), '2024-06-11T15:00:00.000Z')
  })

  it('handles an appointment with no prepStartsAt identically to one prepping at startsAt', () => {
    const withoutPrep = occupiedInterval(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        travelBufferBeforeMinutes: 20,
      })
    )
    const withPrepAtStart = occupiedInterval(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        prepStartsAt: at('2024-06-11T15:00:00Z'),
        travelBufferBeforeMinutes: 20,
      })
    )

    assert.equal(
      withoutPrep.start.toISOString(),
      withPrepAtStart.start.toISOString()
    )
    assert.equal(withoutPrep.start.toISOString(), '2024-06-11T14:40:00.000Z')
  })
})

// =============================================================================
// 2. Time-zone machinery
// =============================================================================

describe('timeZoneOffsetMs', () => {
  it('reads the offset from the IANA database at the instant given', () => {
    assert.equal(
      timeZoneOffsetMs(TORONTO, at('2024-01-15T12:00:00Z')),
      -5 * HOUR
    )
    assert.equal(
      timeZoneOffsetMs(TORONTO, at('2024-07-15T12:00:00Z')),
      -4 * HOUR
    )
  })

  it('handles a half-hour zone', () => {
    assert.equal(
      timeZoneOffsetMs('Asia/Kolkata', at('2024-06-01T00:00:00Z')),
      5.5 * HOUR
    )
  })
})

describe('resolveWallClock', () => {
  it('maps an ordinary wall clock to exactly one instant', () => {
    const resolved = resolveWallClock(
      { year: 2024, month: 6, day: 11 },
      9 * 60,
      TORONTO
    )

    assert.equal(resolved.disambiguation, 'EXACT')
    assert.equal(resolved.instant.toISOString(), '2024-06-11T13:00:00.000Z')
  })

  it('shifts a wall clock inside the spring-forward gap forward to the far side', () => {
    // 02:30 on 2024-03-10 never happened in Toronto: 02:00 EST became 03:00 EDT.
    const resolved = resolveWallClock(
      { year: 2024, month: 3, day: 10 },
      2 * 60 + 30,
      TORONTO
    )

    assert.equal(resolved.disambiguation, 'GAP_SHIFTED_FORWARD')
    // 03:30 EDT, i.e. shifted forward by the hour that vanished.
    assert.equal(resolved.instant.toISOString(), '2024-03-10T07:30:00.000Z')
  })

  it('shifts BY the width of the gap rather than clamping to its far edge', () => {
    // The two are only the same thing for a bound sitting exactly on the near
    // edge. 02:00 shifted forward by the missing hour happens to land on the
    // far edge, 03:00 EDT. 02:30 is half an hour into the gap, so the same
    // shift lands half an hour PAST that edge, at 03:30 EDT. A clamp would have
    // collapsed both onto 07:00Z, and a `02:30–04:00` rule would then have
    // yielded an hour of availability the chef does not have.
    const nearEdge = resolveWallClock(
      { year: 2024, month: 3, day: 10 },
      2 * 60,
      TORONTO
    )
    const insideTheGap = resolveWallClock(
      { year: 2024, month: 3, day: 10 },
      2 * 60 + 30,
      TORONTO
    )

    assert.equal(nearEdge.disambiguation, 'GAP_SHIFTED_FORWARD')
    assert.equal(nearEdge.instant.toISOString(), '2024-03-10T07:00:00.000Z')

    assert.equal(insideTheGap.disambiguation, 'GAP_SHIFTED_FORWARD')
    assert.equal(insideTheGap.instant.toISOString(), '2024-03-10T07:30:00.000Z')

    assert.equal(
      insideTheGap.instant.getTime() - nearEdge.instant.getTime(),
      HOUR / 2,
      'the half hour between the two bounds survives the transition'
    )
  })

  it('resolves a repeated wall clock to the first (pre-transition) occurrence', () => {
    // 01:30 on 2024-11-03 happened twice: once as EDT, once as EST.
    const resolved = resolveWallClock(
      { year: 2024, month: 11, day: 3 },
      60 + 30,
      TORONTO
    )

    assert.equal(resolved.disambiguation, 'AMBIGUOUS_FIRST_OCCURRENCE')
    assert.equal(resolved.instant.toISOString(), '2024-11-03T05:30:00.000Z')
    // The second occurrence, one hour later, is deliberately not chosen.
    assert.equal(
      timeZoneOffsetMs(TORONTO, resolved.instant),
      -4 * HOUR,
      'the first occurrence is still on the summer offset'
    )
  })

  it('treats minute 1440 as midnight ending the day, across a 25-hour day', () => {
    const dayStart = resolveWallClock(
      { year: 2024, month: 11, day: 3 },
      0,
      TORONTO
    )
    const dayEnd = resolveWallClock(
      { year: 2024, month: 11, day: 3 },
      1440,
      TORONTO
    )

    assert.equal(dayStart.instant.toISOString(), '2024-11-03T04:00:00.000Z')
    assert.equal(dayEnd.instant.toISOString(), '2024-11-04T05:00:00.000Z')
    assert.equal(
      dayEnd.instant.getTime() - dayStart.instant.getTime(),
      25 * HOUR,
      'the fall-back day really is twenty-five hours long'
    )
  })

  it('makes the spring-forward day twenty-three hours long', () => {
    const dayStart = resolveWallClock(
      { year: 2024, month: 3, day: 10 },
      0,
      TORONTO
    )
    const dayEnd = resolveWallClock(
      { year: 2024, month: 3, day: 10 },
      1440,
      TORONTO
    )

    assert.equal(
      dayEnd.instant.getTime() - dayStart.instant.getTime(),
      23 * HOUR
    )
  })

  it('handles a reverse-DST, half-hour-shift zone', () => {
    // Lord Howe shifts by thirty minutes: 02:00 → 02:30 on 2024-10-06.
    const gap = resolveWallClock(
      { year: 2024, month: 10, day: 6 },
      2 * 60 + 15,
      'Australia/Lord_Howe'
    )

    assert.equal(gap.disambiguation, 'GAP_SHIFTED_FORWARD')
    assert.equal(gap.instant.toISOString(), '2024-10-05T15:45:00.000Z')
  })
})

// =============================================================================
// 3. expandAvailability
// =============================================================================

describe('expandAvailability', () => {
  it('keeps a recurring window at the same LOCAL time across a DST transition', () => {
    const windows = expandAvailability(
      [rule()],
      range('2024-03-01T00:00:00Z', '2024-03-20T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      // 09:00–17:00 EST — five hours behind UTC.
      '2024-03-05T14:00:00.000Z/2024-03-05T22:00:00.000Z',
      // 09:00–17:00 EDT — four hours behind. Different UTC hour, same local hour.
      '2024-03-12T13:00:00.000Z/2024-03-12T21:00:00.000Z',
      '2024-03-19T13:00:00.000Z/2024-03-19T21:00:00.000Z',
    ])
  })

  it('produces two real hours for a three-hour window across the spring-forward gap', () => {
    const windows = expandAvailability(
      // Sunday 01:00–04:00 local, on the day 02:00–03:00 does not exist.
      [
        rule({
          id: 'sunday',
          dayOfWeek: 0,
          startMinute: 60,
          endMinute: 4 * 60,
        }),
      ],
      range('2024-03-10T00:00:00Z', '2024-03-11T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-03-10T06:00:00.000Z/2024-03-10T08:00:00.000Z',
    ])

    const first = windows[0]
    assert.ok(first !== undefined)
    assert.equal(
      first.end.getTime() - first.start.getTime(),
      2 * HOUR,
      'three nominal hours, two real ones'
    )
  })

  it('drops a window that falls entirely inside the spring-forward gap', () => {
    const windows = expandAvailability(
      // 02:00–03:00 on 2024-03-10 is an hour that never happened.
      [
        rule({
          id: 'sunday',
          dayOfWeek: 0,
          startMinute: 2 * 60,
          endMinute: 3 * 60,
        }),
      ],
      range('2024-03-10T00:00:00Z', '2024-03-11T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(windows, [])
  })

  it('produces thirty minutes, not sixty, for 02:30–04:00 on the spring-forward day', () => {
    const windows = expandAvailability(
      // Sunday 02:30–04:00 local. 02:30 never happened, and the bound is
      // shifted forward BY the missing hour rather than clamped to the end of
      // it, so the window opens at 03:30 EDT and closes at 04:00 EDT.
      [
        rule({
          id: 'sunday',
          dayOfWeek: 0,
          startMinute: 2 * 60 + 30,
          endMinute: 4 * 60,
        }),
      ],
      range('2024-03-10T00:00:00Z', '2024-03-11T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-03-10T07:30:00.000Z/2024-03-10T08:00:00.000Z',
    ])

    const first = windows[0]
    assert.ok(first !== undefined)
    assert.equal(
      first.end.getTime() - first.start.getTime(),
      HOUR / 2,
      'ninety nominal minutes, thirty real ones'
    )
  })

  it('produces two real hours for a one-hour window across the fall-back overlap', () => {
    const windows = expandAvailability(
      // Sunday 01:00–02:00 local, on the day 01:00–01:59 happens twice.
      [
        rule({
          id: 'sunday',
          dayOfWeek: 0,
          startMinute: 60,
          endMinute: 2 * 60,
        }),
      ],
      range('2024-11-03T00:00:00Z', '2024-11-04T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-11-03T05:00:00.000Z/2024-11-03T07:00:00.000Z',
    ])

    const first = windows[0]
    assert.ok(first !== undefined)
    assert.equal(
      first.end.getTime() - first.start.getTime(),
      2 * HOUR,
      'one nominal hour, two real ones, because the hour repeated'
    )
  })

  it('lets a recurring blackout carve a hole in a recurring window', () => {
    const windows = expandAvailability(
      [
        rule(),
        rule({
          id: 'lunch',
          startMinute: 12 * 60,
          endMinute: 13 * 60,
          isBlackout: true,
        }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-06-11T13:00:00.000Z/2024-06-11T16:00:00.000Z', // 09:00–12:00
      '2024-06-11T17:00:00.000Z/2024-06-11T21:00:00.000Z', // 13:00–17:00
    ])
  })

  it('lets a DATE_OVERRIDE blackout carve a hole on one date only', () => {
    const windows = expandAvailability(
      [
        rule(),
        rule({
          id: 'dentist',
          kind: 'DATE_OVERRIDE',
          dayOfWeek: null,
          specificDate: at('2024-06-11T00:00:00Z'),
          startMinute: 14 * 60,
          endMinute: 15 * 60,
          isBlackout: true,
        }),
      ],
      range('2024-06-01T00:00:00Z', '2024-06-20T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-06-04T13:00:00.000Z/2024-06-04T21:00:00.000Z',
      '2024-06-11T13:00:00.000Z/2024-06-11T18:00:00.000Z', // 09:00–14:00
      '2024-06-11T19:00:00.000Z/2024-06-11T21:00:00.000Z', // 15:00–17:00
      '2024-06-18T13:00:00.000Z/2024-06-18T21:00:00.000Z',
    ])
  })

  it('lets a positive DATE_OVERRIDE replace the recurring window on its date', () => {
    const windows = expandAvailability(
      [
        rule(),
        rule({
          id: 'evening-only',
          kind: 'DATE_OVERRIDE',
          dayOfWeek: null,
          specificDate: at('2024-06-11T00:00:00Z'),
          startMinute: 18 * 60,
          endMinute: 22 * 60,
        }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    assert.deepEqual(
      isoWindows(windows),
      ['2024-06-11T22:00:00.000Z/2024-06-12T02:00:00.000Z'],
      'the override wins outright; the 09:00–17:00 recurring window is gone'
    )
  })

  it('honours effectiveFrom and effectiveUntil inclusively', () => {
    const windows = expandAvailability(
      [
        rule({
          effectiveFrom: at('2024-06-11T00:00:00Z'),
          effectiveUntil: at('2024-06-18T00:00:00Z'),
        }),
      ],
      range('2024-06-01T00:00:00Z', '2024-07-01T00:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-06-11T13:00:00.000Z/2024-06-11T21:00:00.000Z',
      '2024-06-18T13:00:00.000Z/2024-06-18T21:00:00.000Z',
    ])
  })

  it('merges touching windows into one stretch', () => {
    const windows = expandAvailability(
      [
        rule({ id: 'morning', startMinute: 9 * 60, endMinute: 12 * 60 }),
        rule({ id: 'afternoon', startMinute: 12 * 60, endMinute: 17 * 60 }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [JUNE_TUESDAY])
  })

  it('records which rules produced each window', () => {
    const windows = expandAvailability(
      [
        rule({ id: 'morning', startMinute: 9 * 60, endMinute: 12 * 60 }),
        rule({ id: 'afternoon', startMinute: 12 * 60, endMinute: 17 * 60 }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    const first = windows[0]
    assert.ok(first !== undefined)
    assert.deepEqual([...first.sourceRuleIds].sort(), ['afternoon', 'morning'])
  })

  it('clips windows to the range', () => {
    const windows = expandAvailability(
      [rule()],
      range('2024-06-11T15:00:00Z', '2024-06-11T16:00:00Z'),
      TORONTO
    )

    assert.deepEqual(isoWindows(windows), [
      '2024-06-11T15:00:00.000Z/2024-06-11T16:00:00.000Z',
    ])
  })

  it('prefers the rule’s own time zone over the chef’s calendar zone', () => {
    const windows = expandAvailability(
      [rule({ timeZone: 'Europe/London' })],
      JUNE_RANGE,
      TORONTO
    )

    // 09:00–17:00 BST is 08:00–16:00Z, not 13:00–21:00Z.
    assert.deepEqual(isoWindows(windows), [
      '2024-06-11T08:00:00.000Z/2024-06-11T16:00:00.000Z',
    ])
  })

  it('skips malformed rows rather than guessing at them', () => {
    const windows = expandAvailability(
      [
        rule({ id: 'no-day', dayOfWeek: null }),
        rule({
          id: 'no-date',
          kind: 'DATE_OVERRIDE',
          dayOfWeek: null,
          specificDate: null,
        }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    assert.deepEqual(windows, [])
  })

  it('returns nothing for an empty or inverted range', () => {
    assert.deepEqual(
      expandAvailability(
        [rule()],
        range('2024-06-11T00:00:00Z', '2024-06-11T00:00:00Z'),
        TORONTO
      ),
      []
    )
    assert.deepEqual(
      expandAvailability(
        [rule()],
        range('2024-06-13T00:00:00Z', '2024-06-10T00:00:00Z'),
        TORONTO
      ),
      []
    )
  })

  it('throws rather than materialise an unbounded range', () => {
    assert.throws(
      () =>
        expandAvailability(
          [rule()],
          range('2024-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
          TORONTO
        ),
      (error: unknown) =>
        error instanceof RangeError &&
        error.message.includes(String(MAX_EXPANSION_DAYS))
    )
  })

  it('throws for a time zone the runtime does not know', () => {
    assert.throws(
      () =>
        expandAvailability(
          [rule({ timeZone: 'Mars/Olympus_Mons' })],
          JUNE_RANGE,
          TORONTO
        ),
      RangeError
    )
  })
})

// =============================================================================
// 4. isWithinAvailability
// =============================================================================

describe('isWithinAvailability', () => {
  const windows = expandAvailability([rule()], JUNE_RANGE, TORONTO)

  it('accepts a booking wholly inside a window', () => {
    const fit = isWithinAvailability(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      windows
    )

    assert.equal(fit.ok, true)
    assert.deepEqual(fit.uncovered, [])
  })

  it('REFUSES a booking whose core fits but whose trailing buffer spills past the window', () => {
    // Service 15:00–17:00 local, flush with the chef's last hour. The hour of
    // driving home afterwards is not covered by anything.
    const fit = isWithinAvailability(
      booking('2024-06-11T19:00:00Z', '2024-06-11T21:00:00Z', {
        travelBufferAfterMinutes: 60,
      }),
      windows
    )

    assert.equal(fit.ok, false)
    assert.deepEqual(
      fit.uncovered.map(
        (gap) => `${gap.start.toISOString()}/${gap.end.toISOString()}`
      ),
      ['2024-06-11T21:00:00.000Z/2024-06-11T22:00:00.000Z']
    )
  })

  it('refuses a booking whose leading buffer starts before the window opens', () => {
    const fit = isWithinAvailability(
      booking('2024-06-11T13:00:00Z', '2024-06-11T15:00:00Z', {
        travelBufferBeforeMinutes: 30,
      }),
      windows
    )

    assert.equal(fit.ok, false)
    assert.deepEqual(
      fit.uncovered.map(
        (gap) => `${gap.start.toISOString()}/${gap.end.toISOString()}`
      ),
      ['2024-06-11T12:30:00.000Z/2024-06-11T13:00:00.000Z']
    )
  })

  it('refuses everything when no availability is published', () => {
    const fit = isWithinAvailability(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      []
    )

    assert.equal(fit.ok, false)
    assert.equal(fit.uncovered.length, 1)
  })

  it('accepts a booking spanning a seam between two touching windows', () => {
    const seamed = expandAvailability(
      [
        rule({ id: 'morning', startMinute: 9 * 60, endMinute: 12 * 60 }),
        rule({ id: 'afternoon', startMinute: 12 * 60, endMinute: 17 * 60 }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    const fit = isWithinAvailability(
      booking('2024-06-11T15:30:00Z', '2024-06-11T16:30:00Z'),
      seamed
    )

    assert.equal(fit.ok, true)
  })

  it('refuses a booking spanning a genuine gap between windows', () => {
    const carved = expandAvailability(
      [
        rule(),
        rule({
          id: 'lunch',
          startMinute: 12 * 60,
          endMinute: 13 * 60,
          isBlackout: true,
        }),
      ],
      JUNE_RANGE,
      TORONTO
    )

    const fit = isWithinAvailability(
      booking('2024-06-11T15:30:00Z', '2024-06-11T17:30:00Z'),
      carved
    )

    assert.equal(fit.ok, false)
    assert.deepEqual(
      fit.uncovered.map(
        (gap) => `${gap.start.toISOString()}/${gap.end.toISOString()}`
      ),
      ['2024-06-11T16:00:00.000Z/2024-06-11T17:00:00.000Z']
    )
  })
})

// =============================================================================
// 5. findConflicts
// =============================================================================

describe('findConflicts', () => {
  const existing = [
    appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
  ]

  it('allows EXACTLY back-to-back bookings', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T17:00:00Z', '2024-06-11T19:00:00Z'),
      existing,
      { maxConcurrentEvents: 1 }
    )

    assert.deepEqual(conflicts, [], 'half-open intervals must not collide')
  })

  it('allows a booking that ends exactly when the next begins', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T13:00:00Z', '2024-06-11T15:00:00Z'),
      existing,
      { maxConcurrentEvents: 1 }
    )

    assert.deepEqual(conflicts, [])
  })

  it('refuses a ONE-MINUTE overlap', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T16:59:00Z', '2024-06-11T19:00:00Z'),
      existing,
      { maxConcurrentEvents: 1 }
    )

    assert.equal(conflicts.length, 1)

    const conflict = conflicts[0]
    assert.ok(conflict !== undefined)
    assert.equal(conflict.kind, 'CORE_OVERLAP')
    assert.equal(conflict.appointmentId, 'a1')
    assert.equal(conflict.appointmentStatus, 'CONFIRMED')
    assert.equal(
      conflict.overlapStart.toISOString(),
      '2024-06-11T16:59:00.000Z'
    )
    assert.equal(conflict.overlapEnd.toISOString(), '2024-06-11T17:00:00.000Z')
    assert.equal(conflict.concurrentCount, 2)
    assert.equal(conflict.maxConcurrentEvents, 1)
  })

  it('refuses an overlap that exists ONLY because of travel buffers', () => {
    // The engagements are back-to-back and would be legal. The chef needs thirty
    // minutes to drive away from the first and twenty to reach the second, and
    // those journeys collide.
    const conflicts = findConflicts(
      booking('2024-06-11T17:00:00Z', '2024-06-11T19:00:00Z', {
        travelBufferBeforeMinutes: 20,
      }),
      [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          travelBufferAfterMinutes: 30,
        }),
      ],
      { maxConcurrentEvents: 1 }
    )

    assert.equal(conflicts.length, 1)

    const conflict = conflicts[0]
    assert.ok(conflict !== undefined)
    assert.equal(
      conflict.kind,
      'BUFFER_OVERLAP',
      'the engagements do not overlap; only the journeys between them do'
    )
    assert.equal(
      conflict.overlapStart.toISOString(),
      '2024-06-11T16:40:00.000Z'
    )
    assert.equal(conflict.overlapEnd.toISOString(), '2024-06-11T17:30:00.000Z')
    assert.match(conflict.message, /Travel time collides/)
  })

  it('does not report a buffer overlap when only one side carries a buffer that clears', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T17:30:00Z', '2024-06-11T19:00:00Z'),
      [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          travelBufferAfterMinutes: 30,
        }),
      ],
      { maxConcurrentEvents: 1 }
    )

    assert.deepEqual(conflicts, [])
  })

  it('ignores engagements whose status does not occupy the calendar', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      [
        appointment(
          'cancelled',
          '2024-06-11T15:00:00Z',
          '2024-06-11T17:00:00Z',
          {
            status: 'CANCELLED',
          }
        ),
        appointment('missed', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          status: 'NO_SHOW',
        }),
        appointment('done', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          status: 'COMPLETED',
        }),
      ],
      { maxConcurrentEvents: 1 }
    )

    assert.deepEqual(conflicts, [])
  })

  it('honours an explicit blockingStatuses list', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      [
        appointment('done', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          status: 'COMPLETED',
        }),
      ],
      {
        maxConcurrentEvents: 1,
        blockingStatuses: ['COMPLETED'] satisfies readonly AppointmentStatus[],
      }
    )

    assert.equal(conflicts.length, 1)
  })

  it('does not let an engagement conflict with itself when it is being amended', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:30:00Z'),
      existing,
      { maxConcurrentEvents: 1, excludeAppointmentId: 'a1' }
    )

    assert.deepEqual(conflicts, [])
  })

  it('allows ONE overlap when maxConcurrentEvents is 2', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
      existing,
      { maxConcurrentEvents: 2 }
    )

    assert.deepEqual(
      conflicts,
      [],
      'a chef with a brigade of two may hold two engagements at once'
    )
  })

  it('refuses TWO simultaneous overlaps when maxConcurrentEvents is 2', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T16:00:00Z', '2024-06-11T16:30:00Z'),
      [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
        appointment('a2', '2024-06-11T15:30:00Z', '2024-06-11T17:30:00Z'),
      ],
      { maxConcurrentEvents: 2 }
    )

    assert.deepEqual(
      conflicts.map((conflict) => conflict.appointmentId),
      ['a1', 'a2']
    )
    assert.deepEqual(
      conflicts.map((conflict) => conflict.concurrentCount),
      [3, 3],
      'the candidate would be the third engagement running at once'
    )
  })

  it('allows two overlapping engagements that do not overlap EACH OTHER at limit 2', () => {
    // Pairwise counting would call this two conflicts. The sweep is what gets it
    // right: at no instant are more than two engagements running.
    const conflicts = findConflicts(
      booking('2024-06-11T16:00:00Z', '2024-06-11T16:30:00Z'),
      [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T16:15:00Z'),
        appointment('a2', '2024-06-11T16:15:00Z', '2024-06-11T17:30:00Z'),
      ],
      { maxConcurrentEvents: 2 }
    )

    assert.deepEqual(conflicts, [])
  })

  it('treats a maxConcurrentEvents below one as one', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
      existing,
      { maxConcurrentEvents: 0 }
    )

    assert.equal(conflicts.length, 1)
  })

  it('returns nothing for a degenerate candidate rather than pretending it fits', () => {
    assert.deepEqual(
      findConflicts(
        booking('2024-06-11T16:00:00Z', '2024-06-11T16:00:00Z'),
        existing,
        { maxConcurrentEvents: 1 }
      ),
      [],
      'validateBookingTiming is the gate for this, not findConflicts'
    )
  })

  it('orders conflicts by when the clash begins', () => {
    const conflicts = findConflicts(
      booking('2024-06-11T13:00:00Z', '2024-06-11T21:00:00Z'),
      [
        appointment('late', '2024-06-11T18:00:00Z', '2024-06-11T19:00:00Z'),
        appointment('early', '2024-06-11T14:00:00Z', '2024-06-11T15:00:00Z'),
      ],
      { maxConcurrentEvents: 1 }
    )

    assert.deepEqual(
      conflicts.map((conflict) => conflict.appointmentId),
      ['early', 'late']
    )
  })
})

// =============================================================================
// 6. checkCapacity
// =============================================================================

describe('checkCapacity', () => {
  const now = at('2024-06-01T12:00:00Z')

  it('accepts a booking when the window has room', () => {
    const assessment = checkCapacity(
      slot({ capacity: 4, bookedCount: 1 }),
      1,
      now
    )

    assert.equal(assessment.ok, true)
    assert.equal(assessment.remaining, 3)
    assert.equal(assessment.conflict, null)
  })

  it('refuses a booking when the window is sold out', () => {
    const assessment = checkCapacity(
      slot({ capacity: 2, bookedCount: 2 }),
      1,
      now
    )

    assert.equal(assessment.ok, false)
    assert.equal(assessment.conflict?.cause, 'SOLD_OUT')
    assert.equal(assessment.remaining, 0)
  })

  it('refuses more bookings than remain', () => {
    const assessment = checkCapacity(
      slot({ capacity: 4, bookedCount: 3 }),
      2,
      now
    )

    assert.equal(assessment.ok, false)
    assert.equal(assessment.conflict?.cause, 'SOLD_OUT')
    assert.match(assessment.conflict?.message ?? '', /room for 1 more booking/)
  })

  it('lets a LIVE soft hold consume the whole window', () => {
    const assessment = checkCapacity(
      slot({
        capacity: 4,
        bookedCount: 0,
        status: 'HELD',
        holdsUntil: at('2024-06-01T12:05:00Z'),
      }),
      1,
      now
    )

    assert.equal(assessment.holdIsLive, true)
    assert.equal(assessment.ok, false)
    assert.equal(assessment.remaining, 0)
    assert.equal(assessment.conflict?.cause, 'LIVE_HOLD')
  })

  it('lets an EXPIRED soft hold consume nothing', () => {
    const assessment = checkCapacity(
      slot({
        capacity: 4,
        bookedCount: 1,
        status: 'HELD',
        // Lapsed one second ago. No sweeper has rewritten `status` yet, and the
        // next guest must not be kept out while it waits.
        holdsUntil: at('2024-06-01T11:59:59Z'),
      }),
      1,
      now
    )

    assert.equal(assessment.holdIsLive, false)
    assert.equal(assessment.ok, true)
    assert.equal(assessment.remaining, 3)
    assert.equal(assessment.conflict, null)
  })

  it('treats a hold expiring exactly at now as expired', () => {
    const assessment = checkCapacity(
      slot({ capacity: 1, status: 'HELD', holdsUntil: now }),
      1,
      now
    )

    assert.equal(assessment.holdIsLive, false)
    assert.equal(assessment.ok, true)
  })

  it('treats a HELD window with no expiry as unheld', () => {
    const assessment = checkCapacity(
      slot({ capacity: 1, status: 'HELD', holdsUntil: null }),
      1,
      now
    )

    assert.equal(assessment.holdIsLive, false)
    assert.equal(assessment.ok, true)
  })

  it('refuses a cancelled or expired window whatever the arithmetic says', () => {
    for (const status of ['CANCELLED', 'EXPIRED', 'FULL'] as const) {
      const assessment = checkCapacity(
        slot({ capacity: 10, bookedCount: 0, status }),
        1,
        now
      )

      assert.equal(assessment.ok, false, status)
      assert.equal(assessment.conflict?.cause, 'SLOT_CLOSED', status)
    }
  })

  it('still allows a BOOKED window that has room left', () => {
    const assessment = checkCapacity(
      slot({ capacity: 5, bookedCount: 1, status: 'BOOKED' }),
      1,
      now
    )

    assert.equal(assessment.ok, true)
    assert.equal(assessment.remaining, 4)
  })

  it('throws for a non-positive seat count', () => {
    assert.throws(() => checkCapacity(slot(), 0, now), RangeError)
    assert.throws(() => checkCapacity(slot(), -1, now), RangeError)
    assert.throws(() => checkCapacity(slot(), 1.5, now), RangeError)
  })
})

// =============================================================================
// 7. validateBookingTiming
// =============================================================================

describe('validateBookingTiming', () => {
  it('passes a well-formed candidate', () => {
    assert.deepEqual(
      validateBookingTiming(
        booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z')
      ),
      []
    )
  })

  it('refuses a ZERO-LENGTH candidate', () => {
    const conflicts = validateBookingTiming(
      booking('2024-06-11T15:00:00Z', '2024-06-11T15:00:00Z')
    )

    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0]?.kind, 'INVALID_INTERVAL')
    assert.match(conflicts[0]?.message ?? '', /zero minutes long/)
  })

  it('refuses an INVERTED candidate', () => {
    const conflicts = validateBookingTiming(
      booking('2024-06-11T17:00:00Z', '2024-06-11T15:00:00Z')
    )

    assert.equal(conflicts.length, 1)
    assert.match(conflicts[0]?.message ?? '', /falls before its start/)
  })

  it('refuses a negative or fractional travel buffer', () => {
    const conflicts = validateBookingTiming(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        travelBufferBeforeMinutes: -10,
        travelBufferAfterMinutes: 12.5,
      })
    )

    assert.equal(conflicts.length, 2)
    assert.deepEqual(
      conflicts.map((conflict) => conflict.field),
      ['travelBuffer', 'travelBuffer']
    )
  })

  it('refuses a travel buffer beyond the eight-hour ceiling', () => {
    assert.deepEqual(
      validateBookingTiming(
        booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          travelBufferBeforeMinutes: MAX_TRAVEL_BUFFER_MINUTES,
          travelBufferAfterMinutes: MAX_TRAVEL_BUFFER_MINUTES,
        })
      ),
      [],
      'the ceiling itself is a legal buffer'
    )

    const conflicts = validateBookingTiming(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        travelBufferBeforeMinutes: MAX_TRAVEL_BUFFER_MINUTES + 1,
        // The value that used to reach expandAvailability and throw there.
        travelBufferAfterMinutes: 580_000,
      })
    )

    assert.equal(conflicts.length, 2)
    assert.deepEqual(
      conflicts.map((conflict) => conflict.field),
      ['travelBuffer', 'travelBuffer']
    )
    assert.match(
      conflicts[0]?.message ?? '',
      new RegExp(`tops out at ${String(MAX_TRAVEL_BUFFER_MINUTES)} minutes`)
    )
  })

  it('reports an out-of-range buffer once, not twice', () => {
    // A fractional buffer is not comparable against the ceiling, so it must not
    // collect both complaints.
    const conflicts = validateBookingTiming(
      booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        travelBufferBeforeMinutes: 900.5,
      })
    )

    assert.equal(conflicts.length, 1)
    assert.match(conflicts[0]?.message ?? '', /whole number of minutes/)
  })

  it('refuses invalid dates', () => {
    const conflicts = validateBookingTiming({
      startsAt: new Date('not a date'),
      endsAt: at('2024-06-11T17:00:00Z'),
      prepStartsAt: new Date('also not a date'),
      travelBufferBeforeMinutes: 0,
      travelBufferAfterMinutes: 0,
    })

    assert.deepEqual(
      conflicts.map((conflict) => conflict.field),
      ['startsAt', 'prepStartsAt']
    )
  })
})

// =============================================================================
// 8. The state machine guard
// =============================================================================

describe('checkStatusTransition', () => {
  it('permits the moves the validators’ table permits', () => {
    const result = checkStatusTransition('REQUESTED', 'CONFIRMED')

    assert.equal(result.ok, true)
  })

  it('refuses a move out of a terminal status', () => {
    const result = checkStatusTransition('COMPLETED', 'CONFIRMED')

    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.equal(result.reasons[0].kind, 'ILLEGAL_TRANSITION')
    assert.equal(result.reasons[0].isTerminal, true)
    assert.deepEqual(result.reasons[0].allowed, [])
  })

  it('refuses a no-op with a message of its own', () => {
    const result = checkStatusTransition('CONFIRMED', 'CONFIRMED')

    assert.ok(!result.ok)
    assert.match(result.reasons[0].message, /already confirmed/)
  })

  it('reuses APPOINTMENT_TRANSITIONS rather than a private copy', () => {
    const statuses: readonly AppointmentStatus[] = [
      'REQUESTED',
      'CONFIRMED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]

    for (const from of statuses) {
      for (const to of statuses) {
        const expected =
          from !== to && APPOINTMENT_TRANSITIONS[from].includes(to)

        assert.equal(
          checkStatusTransition(from, to).ok,
          expected,
          `${from} -> ${to}`
        )
      }
    }
  })

  it('reports the legal next moves so the UI can render them', () => {
    const result = checkStatusTransition('REQUESTED', 'COMPLETED')

    assert.ok(!result.ok)
    assert.deepEqual(result.reasons[0].allowed, ['CONFIRMED', 'CANCELLED'])
  })
})

// =============================================================================
// 9. suggestAlternatives
// =============================================================================

describe('suggestAlternatives', () => {
  const windows = expandAvailability([rule()], JUNE_RANGE, TORONTO)
  const existing = [
    appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
  ]

  it('offers the nearest conflict-free starts', () => {
    const alternatives = suggestAlternatives(
      booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
      windows,
      existing,
      2,
      { now: BEFORE_EVERYTHING, maxConcurrentEvents: 1 }
    )

    assert.deepEqual(
      alternatives.map((alternative) => alternative.startsAt.toISOString()),
      [
        // Back-to-back with the existing engagement — legal, and one hour away.
        '2024-06-11T17:00:00.000Z',
        // Flush against the close of the window — three hours away.
        '2024-06-11T19:00:00.000Z',
      ]
    )
    assert.deepEqual(
      alternatives.map((alternative) => alternative.shiftMs),
      [HOUR, 3 * HOUR]
    )
  })

  it('never suggests a time that has already begun', () => {
    const alternatives = suggestAlternatives(
      booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
      windows,
      existing,
      5,
      { now: at('2024-06-11T18:00:00Z'), maxConcurrentEvents: 1 }
    )

    for (const alternative of alternatives) {
      assert.ok(
        alternative.occupied.start.getTime() >=
          at('2024-06-11T18:00:00Z').getTime()
      )
    }
    assert.deepEqual(
      alternatives.map((alternative) => alternative.startsAt.toISOString()),
      ['2024-06-11T19:00:00.000Z']
    )
  })

  it('moves the whole booking, buffers and preparation included', () => {
    const alternatives = suggestAlternatives(
      booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z', {
        prepStartsAt: at('2024-06-11T15:30:00Z'),
        travelBufferAfterMinutes: 30,
      }),
      windows,
      existing,
      1,
      { now: BEFORE_EVERYTHING, maxConcurrentEvents: 1 }
    )

    const first = alternatives[0]
    assert.ok(first !== undefined)
    assert.equal(
      first.occupied.end.getTime() - first.occupied.start.getTime(),
      3 * HOUR,
      'half an hour of prep, two of service, half of driving'
    )
    assert.ok(isWithinAvailability(first.occupied, windows).ok)
    assert.deepEqual(
      findConflicts(first.occupied, existing, { maxConcurrentEvents: 1 }),
      []
    )
  })

  it('returns nothing when the diary is closed', () => {
    assert.deepEqual(
      suggestAlternatives(
        booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
        [],
        existing,
        3,
        { now: BEFORE_EVERYTHING, maxConcurrentEvents: 1 }
      ),
      []
    )
  })

  it('offers nothing when the window it would book into is sold out', () => {
    // Every position the engine could shift to is in the same slot, and that
    // slot has no seats. Three times that are just as sold out is a worse
    // answer than none.
    assert.deepEqual(
      suggestAlternatives(
        booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
        windows,
        existing,
        3,
        {
          now: BEFORE_EVERYTHING,
          maxConcurrentEvents: 1,
          bookingSlot: slot({ capacity: 2, bookedCount: 2 }),
        }
      ),
      []
    )
  })

  it('suggests as usual when the window has room for the seats requested', () => {
    const roomy = slot({ capacity: 4, bookedCount: 1 })
    const request = booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z')

    assert.deepEqual(
      suggestAlternatives(request, windows, existing, 1, {
        now: BEFORE_EVERYTHING,
        maxConcurrentEvents: 1,
        bookingSlot: roomy,
        requestedSeats: 3,
      }).map((alternative) => alternative.startsAt.toISOString()),
      ['2024-06-11T17:00:00.000Z'],
      'three of the three remaining seats: capacity is not the obstruction'
    )

    assert.deepEqual(
      suggestAlternatives(request, windows, existing, 1, {
        now: BEFORE_EVERYTHING,
        maxConcurrentEvents: 1,
        bookingSlot: roomy,
        requestedSeats: 4,
      }),
      [],
      'one seat too many, and no shift in time can supply it'
    )
  })

  it('falls silent, rather than throwing, on a seat count checkCapacity rejects', () => {
    assert.doesNotThrow(() => {
      assert.deepEqual(
        suggestAlternatives(
          booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
          windows,
          existing,
          3,
          {
            now: BEFORE_EVERYTHING,
            maxConcurrentEvents: 1,
            bookingSlot: slot({ capacity: 4 }),
            requestedSeats: 0,
          }
        ),
        []
      )
    })
  })

  it('returns nothing for a non-positive limit or a degenerate candidate', () => {
    assert.deepEqual(
      suggestAlternatives(
        booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
        windows,
        existing,
        0,
        { now: BEFORE_EVERYTHING, maxConcurrentEvents: 1 }
      ),
      []
    )
    assert.deepEqual(
      suggestAlternatives(
        booking('2024-06-11T16:00:00Z', '2024-06-11T16:00:00Z'),
        windows,
        existing,
        3,
        { now: BEFORE_EVERYTHING, maxConcurrentEvents: 1 }
      ),
      []
    )
  })
})

// =============================================================================
// 10. evaluateBooking — the entry point
// =============================================================================

describe('evaluateBooking', () => {
  const base = {
    now: BEFORE_EVERYTHING,
    staff: staff(1),
    availabilityRules: [rule()],
    existingAppointments: [] as readonly AppointmentLike[],
    searchRange: JUNE_RANGE,
  }

  it('accepts a clean booking', () => {
    const result = evaluateBooking({
      ...base,
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
    })

    assert.equal(result.ok, true)
    assert.ok(result.ok)
    assert.equal(result.capacity, null)
    assert.deepEqual(isoWindows(result.windows), [JUNE_TUESDAY])
  })

  it('accepts exactly back-to-back bookings', () => {
    const result = evaluateBooking({
      ...base,
      existingAppointments: [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      ],
      candidate: booking('2024-06-11T17:00:00Z', '2024-06-11T19:00:00Z'),
    })

    assert.equal(result.ok, true)
  })

  it('refuses a one-minute overlap and offers alternatives', () => {
    const result = evaluateBooking({
      ...base,
      existingAppointments: [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      ],
      candidate: booking('2024-06-11T16:59:00Z', '2024-06-11T18:59:00Z'),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['CORE_OVERLAP'])
    assert.ok(result.alternatives.length > 0)
    assert.equal(
      result.alternatives[0]?.startsAt.toISOString(),
      '2024-06-11T17:00:00.000Z'
    )
  })

  it('refuses an overlap that exists only in the travel buffers', () => {
    const result = evaluateBooking({
      ...base,
      existingAppointments: [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
          travelBufferAfterMinutes: 30,
        }),
      ],
      candidate: booking('2024-06-11T17:00:00Z', '2024-06-11T19:00:00Z', {
        travelBufferBeforeMinutes: 20,
      }),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['BUFFER_OVERLAP'])
  })

  it('refuses a booking whose trailing buffer spills past the last window', () => {
    const result = evaluateBooking({
      ...base,
      candidate: booking('2024-06-11T19:00:00Z', '2024-06-11T21:00:00Z', {
        travelBufferAfterMinutes: 60,
      }),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['OUTSIDE_AVAILABILITY'])

    const reason = result.reasons[0]
    assert.ok(reason !== undefined && reason.kind === 'OUTSIDE_AVAILABILITY')
    assert.equal(
      reason.uncovered[0]?.start.toISOString(),
      '2024-06-11T21:00:00.000Z'
    )
  })

  it('refuses a booking inside a blackout carved out of a recurring window', () => {
    const result = evaluateBooking({
      ...base,
      availabilityRules: [
        rule(),
        rule({
          id: 'lunch',
          startMinute: 12 * 60,
          endMinute: 13 * 60,
          isBlackout: true,
        }),
      ],
      candidate: booking('2024-06-11T16:15:00Z', '2024-06-11T16:45:00Z'),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['OUTSIDE_AVAILABILITY'])
  })

  it('reports a zero-length candidate on its own, with no calendar noise', () => {
    const result = evaluateBooking({
      ...base,
      existingAppointments: [
        appointment('a1', '2024-06-11T00:00:00Z', '2024-06-11T23:00:00Z'),
      ],
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T15:00:00Z'),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['INVALID_INTERVAL'])
    assert.deepEqual(result.windows, [])
    assert.deepEqual(result.alternatives, [])
  })

  it('reports an inverted candidate the same way', () => {
    const result = evaluateBooking({
      ...base,
      candidate: booking('2024-06-11T17:00:00Z', '2024-06-11T15:00:00Z'),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['INVALID_INTERVAL'])
  })

  it('reports every reason at once rather than making an admin guess', () => {
    const result = evaluateBooking({
      ...base,
      existingAppointments: [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      ],
      bookingSlot: slot({ capacity: 1, bookedCount: 1 }),
      candidate: booking('2024-06-11T16:00:00Z', '2024-06-11T22:00:00Z', {
        travelBufferAfterMinutes: 30,
      }),
    })

    assert.ok(!result.ok)
    assert.deepEqual([...kinds(result.reasons)].sort(), [
      'CAPACITY',
      'CORE_OVERLAP',
      'OUTSIDE_AVAILABILITY',
    ])
  })

  it('honours a chef who accepts two engagements at once', () => {
    const twoAtOnce = {
      ...base,
      staff: staff(2),
      candidate: booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
    }

    assert.equal(
      evaluateBooking({
        ...twoAtOnce,
        existingAppointments: [
          appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
        ],
      }).ok,
      true
    )

    assert.equal(
      evaluateBooking({
        ...twoAtOnce,
        existingAppointments: [
          appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
          appointment('a2', '2024-06-11T15:30:00Z', '2024-06-11T17:30:00Z'),
        ],
      }).ok,
      false
    )
  })

  it('refuses a booking that has already begun', () => {
    const result = evaluateBooking({
      ...base,
      now: at('2024-06-11T16:00:00Z'),
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
    })

    assert.ok(!result.ok)
    assert.ok(kinds(result.reasons).includes('STARTS_IN_THE_PAST'))
  })

  it('lets an administrator override published availability', () => {
    const result = evaluateBooking({
      ...base,
      requireWithinAvailability: false,
      // 03:00–05:00 local on a Tuesday: nowhere near the published diary.
      candidate: booking('2024-06-11T07:00:00Z', '2024-06-11T09:00:00Z'),
    })

    assert.equal(result.ok, true)
  })

  it('widens a search range that does not reach the candidate', () => {
    const result = evaluateBooking({
      ...base,
      // Deliberately empty; the engine must still materialise the Tuesday rule
      // over the candidate rather than refuse it for lack of a window.
      searchRange: range('2024-06-11T15:00:00Z', '2024-06-11T15:00:00Z'),
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
    })

    assert.equal(result.ok, true)
  })

  it('checks the booking slot’s capacity, honouring a lapsed hold', () => {
    const held = {
      ...base,
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      now: at('2024-06-10T12:00:00Z'),
    }

    const live = evaluateBooking({
      ...held,
      bookingSlot: slot({
        capacity: 2,
        status: 'HELD',
        holdsUntil: at('2024-06-10T12:05:00Z'),
      }),
    })

    assert.ok(!live.ok)
    assert.deepEqual(kinds(live.reasons), ['CAPACITY'])

    const lapsed = evaluateBooking({
      ...held,
      bookingSlot: slot({
        capacity: 2,
        status: 'HELD',
        holdsUntil: at('2024-06-10T11:59:59Z'),
      }),
    })

    assert.equal(lapsed.ok, true)
    assert.equal(lapsed.capacity?.remaining, 2)
  })

  it('offers no alternatives when the only reason is a sold-out window', () => {
    const result = evaluateBooking({
      ...base,
      bookingSlot: slot({ capacity: 2, bookedCount: 2 }),
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['CAPACITY'])
    // The suggestions used to be computed from the times alone, so a refusal
    // whose sole cause was capacity came back with three starts that were every
    // bit as sold out — and re-evaluating any of them refused with CAPACITY
    // again.
    assert.deepEqual(result.alternatives, [])
    assert.equal(result.capacity?.remaining, 0)
  })

  it('only offers alternatives it would itself accept, slot included', () => {
    const withRoom = {
      ...base,
      bookingSlot: slot({ capacity: 5, bookedCount: 1 }),
      existingAppointments: [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      ],
      candidate: booking('2024-06-11T16:00:00Z', '2024-06-11T18:00:00Z'),
    }

    const result = evaluateBooking(withRoom)

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['CORE_OVERLAP'])
    assert.ok(result.alternatives.length > 0)

    for (const alternative of result.alternatives) {
      const replay = evaluateBooking({
        ...withRoom,
        candidate: {
          ...withRoom.candidate,
          startsAt: alternative.startsAt,
          endsAt: alternative.endsAt,
        },
      })

      assert.equal(
        replay.ok,
        true,
        `re-evaluating ${alternative.startsAt.toISOString()} against the same slot must be accepted`
      )
    }
  })

  it('refuses an absurd travel buffer instead of throwing', () => {
    // 580 000 minutes is a whole number and not negative, so every structural
    // check except the ceiling accepts it. Before the ceiling existed, widening
    // the search range to contain the occupied interval pushed it past
    // MAX_EXPANSION_DAYS and expandAvailability threw a RangeError — an
    // INTERNAL error shown to a guest who should simply have been refused.
    const result = evaluateBooking({
      ...base,
      candidate: booking('2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z', {
        travelBufferBeforeMinutes: 580_000,
      }),
    })

    assert.ok(!result.ok)
    assert.deepEqual(kinds(result.reasons), ['INVALID_INTERVAL'])
    assert.deepEqual(result.windows, [])
    assert.deepEqual(result.alternatives, [])
  })

  it('does not let an engagement being amended conflict with itself', () => {
    const result = evaluateBooking({
      ...base,
      existingAppointments: [
        appointment('a1', '2024-06-11T15:00:00Z', '2024-06-11T17:00:00Z'),
      ],
      excludeAppointmentId: 'a1',
      candidate: booking('2024-06-11T15:30:00Z', '2024-06-11T17:30:00Z'),
    })

    assert.equal(result.ok, true)
  })

  it('keeps a booking on the far side of a DST transition at the right local hour', () => {
    // 09:00–11:00 local on the Tuesday AFTER the clocks went forward. In UTC
    // that is 13:00–15:00Z; the identical local booking a week earlier would
    // have been 14:00–16:00Z, and the recurring rule must accept both.
    const march = {
      ...base,
      now: at('2024-03-01T00:00:00Z'),
      searchRange: range('2024-03-01T00:00:00Z', '2024-03-20T00:00:00Z'),
    }

    const afterTransition = evaluateBooking({
      ...march,
      candidate: booking('2024-03-12T13:00:00Z', '2024-03-12T15:00:00Z'),
    })
    const beforeTransition = evaluateBooking({
      ...march,
      candidate: booking('2024-03-05T14:00:00Z', '2024-03-05T16:00:00Z'),
    })
    // The same UTC hour on the wrong side of the transition is 08:00 local,
    // before the chef starts, and must be refused.
    const wrongLocalHour = evaluateBooking({
      ...march,
      candidate: booking('2024-03-12T12:00:00Z', '2024-03-12T14:00:00Z'),
    })

    assert.equal(afterTransition.ok, true)
    assert.equal(beforeTransition.ok, true)
    assert.ok(!wrongLocalHour.ok)
    assert.deepEqual(kinds(wrongLocalHour.reasons), ['OUTSIDE_AVAILABILITY'])
  })
})
