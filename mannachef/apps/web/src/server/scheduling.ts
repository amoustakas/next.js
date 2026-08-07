// mannachef/apps/web/src/server/scheduling.ts

/**
 * The booking conflict engine.
 *
 * This module decides whether a chef can be in a place at a time. Every refusal
 * a guest or an administrator ever sees about a double-booking, a blackout, or a
 * drive that does not fit originates here.
 *
 * ## Why it is pure
 *
 * There is not a single Prisma import, network call, or `Date.now()` read below
 * this comment. Everything is a function of its arguments, "now" included. Three
 * things follow from that:
 *
 * 1. **It is exhaustively testable.** A DST transition, a chef with two
 *    simultaneous engagements, and a soft hold that lapsed four seconds ago are
 *    all plain values in `scheduling.test.ts` — no database, no clock, no
 *    flakiness.
 * 2. **It cannot half-apply a decision.** The action layer queries, calls
 *    `evaluateBooking`, and only then writes inside its transaction. The engine
 *    has no way to leave a row behind.
 * 3. **It is deterministic.** The same inputs always produce the same conflicts
 *    in the same order, so the admin UI's explanation of a refusal is stable and
 *    a snapshot test of it is meaningful.
 *
 * ## Errors versus refusals
 *
 * A *refusal* — the calendar is busy, the window is closed, the slot is sold out
 * — is returned as data: `{ ok: false, reasons }`. A *programming error* — an
 * unknown IANA zone, a range spanning three years, asking for zero seats —
 * throws, because no user action can produce it and silently coping with it
 * would hide the bug. `withAction` in `./guards` turns a thrown error into an
 * `INTERNAL` `ActionResult`; refusals map to `CONFLICT`.
 *
 * ## Half-open intervals, everywhere
 *
 * Every interval in this file is `[start, end)`. Two engagements that touch —
 * one ending at 17:00, the next occupying from 17:00 — do **not** collide. One
 * minute of genuine overlap does. This single convention is what makes
 * back-to-back bookings work without a fudge factor.
 *
 * ## Time zones
 *
 * See the block comment above `resolveWallClock`. In one sentence: availability
 * is authored as minutes from local midnight and must be resolved against the
 * IANA database for the specific day it lands on, because the day a clock jumps
 * is 23 or 25 hours long and no fixed offset survives it.
 */

import {
  allowedAppointmentTransitions,
  APPOINTMENT_TRANSITIONS,
  canTransition,
  DEFAULT_BLOCKING_APPOINTMENT_STATUSES,
  isTerminalAppointmentStatus,
  TERMINAL_APPOINTMENT_STATUSES,
} from '@mannachef/validators'
import type {
  AppointmentStatus,
  AvailabilityRuleKind,
  BookingSlotStatus,
} from '@mannachef/validators'

/**
 * ## The appointment state machine is not redefined here
 *
 * `APPOINTMENT_TRANSITIONS` and `canTransition` already live in
 * `@mannachef/validators` (`src/booking.ts` §5), where the transition payload
 * schema also consumes them. Re-declaring the table in the server layer would
 * create two authorities that could drift, and the drift would be invisible
 * until a guest was refused a cancellation the API had accepted.
 *
 * They are imported, wrapped by `checkStatusTransition` below so a refusal comes
 * back in this module's `BookingConflict` vocabulary, and re-exported so an
 * action that needs the raw table does not have to import from two places.
 *
 * **The validators' table was reviewed against what the action layer needs and
 * is complete; nothing was added to it.** Specifically:
 *
 * - `REQUESTED → CONFIRMED | CANCELLED` covers accept and decline.
 * - `CONFIRMED → IN_PROGRESS | COMPLETED | CANCELLED | NO_SHOW` covers the chef
 *   arriving, a chef who closed out a dinner without touching their phone, a
 *   late cancellation, and a household that was not home.
 * - `IN_PROGRESS → COMPLETED | CANCELLED` covers service finishing or being
 *   abandoned midway.
 * - `COMPLETED`, `CANCELLED`, `NO_SHOW` are terminal. Rescheduling is not a
 *   transition — it is a `CANCELLED` engagement plus a new one, which is what
 *   keeps the invoice and review trails honest.
 */
export {
  allowedAppointmentTransitions,
  APPOINTMENT_TRANSITIONS,
  canTransition,
  DEFAULT_BLOCKING_APPOINTMENT_STATUSES,
  isTerminalAppointmentStatus,
  TERMINAL_APPOINTMENT_STATUSES,
}

// =============================================================================
// 0. Constants
// =============================================================================

const MS_PER_SECOND = 1_000
const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000
const MINUTES_PER_DAY = 1_440

/**
 * The widest range `expandAvailability` will materialise in one call.
 *
 * A recurring rule has no end, so the range is the only thing bounding the work.
 * Thirteen months is more than any screen in the product asks for, and a request
 * for more is a bug in the caller rather than an unusual booking.
 */
export const MAX_EXPANSION_DAYS = 400

/** Slot statuses that take a window off the market whatever the arithmetic says. */
export const UNBOOKABLE_SLOT_STATUSES: readonly BookingSlotStatus[] = [
  'CANCELLED',
  'EXPIRED',
  'FULL',
]

// =============================================================================
// 1. Time primitives
// =============================================================================

/** A half-open instant interval, `[start, end)`. */
export interface TimeInterval {
  readonly start: Date
  readonly end: Date
}

/** The half-open span of instants a query covers, `[from, until)`. */
export interface TimeRange {
  readonly from: Date
  readonly until: Date
}

/**
 * A calendar date with no zone and no time — 2024-03-10, not an instant.
 *
 * `month` is 1–12, unlike `Date`'s zero-indexed month. Availability rules are
 * authored against civil dates, so the engine keeps them in that form until the
 * last possible moment.
 */
export interface CivilDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Internal working shape: a half-open interval in epoch milliseconds. */
interface MsInterval {
  readonly start: number
  readonly end: number
}

/** An `MsInterval` that remembers which availability rules produced it. */
interface MsSpan extends MsInterval {
  readonly sourceRuleIds: readonly string[]
}

function isFiniteDate(value: Date): boolean {
  return Number.isFinite(value.getTime())
}

/**
 * `Date.UTC` maps years 0–99 onto 1900–1999. Booking a chef for the year 42 is
 * not a use case, but an engine that silently relocates instants by nineteen
 * centuries is not one either, so the remap is undone.
 */
function utcMsFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, 0)

  if (year >= 0 && year <= 99) {
    const corrected = new Date(naive)
    corrected.setUTCFullYear(year)
    return corrected.getTime()
  }

  return naive
}

/** Midnight at the start of a civil date, read as though the date were UTC. */
function civilDayStartMs(date: CivilDate): number {
  return utcMsFromParts(date.year, date.month, date.day, 0, 0, 0)
}

/**
 * Whole days between the epoch and a civil date. Used as a stable integer key
 * for "which day is this", and as the loop variable when walking a range.
 */
function civilDayNumber(date: CivilDate): number {
  return Math.floor(civilDayStartMs(date) / MS_PER_DAY)
}

function civilDateFromDayNumber(dayNumber: number): CivilDate {
  const asDate = new Date(dayNumber * MS_PER_DAY)

  return {
    year: asDate.getUTCFullYear(),
    month: asDate.getUTCMonth() + 1,
    day: asDate.getUTCDate(),
  }
}

/** 0 = Sunday … 6 = Saturday, matching `ChefAvailability.dayOfWeek`. */
function civilDayOfWeek(date: CivilDate): number {
  return new Date(civilDayStartMs(date)).getUTCDay()
}

/** The civil date a `@db.Date` column carries. Prisma hands those back as UTC midnight. */
function civilDateFromDateOnlyColumn(value: Date): CivilDate {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  }
}

/** The day number of an instant's UTC calendar date. */
function utcDayNumberOf(value: Date): number {
  return Math.floor(value.getTime() / MS_PER_DAY)
}

// =============================================================================
// 2. Time-zone machinery
// =============================================================================

/**
 * Memoised formatters. Constructing an `Intl.DateTimeFormat` is expensive and
 * `expandAvailability` needs one per zone per call; the cache is keyed purely by
 * the zone identifier, so it is a memoisation of a pure function rather than
 * state the engine can be wrong about.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * @throws {RangeError} when the runtime does not recognise the identifier. That
 * is a data error (a `ChefAvailability.timeZone` that never passed
 * `timeZoneSchema`), not something a guest can trigger.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timeZone)

  if (cached !== undefined) {
    return cached
  }

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // `h23` rather than `hour12: false`: the legacy spelling renders midnight as
    // hour 24 on some ICU builds, which would put every midnight boundary a day
    // out. The defensive normalisation in `partsAt` covers builds that ignore it.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  zoneFormatters.set(timeZone, created)

  return created
}

interface ZonedParts extends CivilDate {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** The wall clock a zone shows at an instant. */
function partsAt(timeZone: string, instantMs: number): ZonedParts {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instantMs))

  let year = 1970
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  let second = 0

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number.parseInt(part.value, 10)
        break
      case 'month':
        month = Number.parseInt(part.value, 10)
        break
      case 'day':
        day = Number.parseInt(part.value, 10)
        break
      case 'hour':
        hour = Number.parseInt(part.value, 10)
        break
      case 'minute':
        minute = Number.parseInt(part.value, 10)
        break
      case 'second':
        second = Number.parseInt(part.value, 10)
        break
      default:
        break
    }
  }

  // Defensive only: `hourCycle: 'h23'` should never yield 24, but an ICU build
  // that ignored it would put every midnight boundary an hour out.
  return { year, month, day, hour: hour === 24 ? 0 : hour, minute, second }
}

/**
 * The zone's UTC offset, in milliseconds, at a given instant. Positive east of
 * Greenwich; `America/Toronto` in July is `-14_400_000`.
 *
 * Derived by asking the zone what wall clock it shows and diffing that against
 * the instant, which is the only way to get an offset that is correct for a
 * historical instant as well as a present one.
 */
export function timeZoneOffsetMs(timeZone: string, instant: Date): number {
  return zoneOffsetMsAt(timeZone, instant.getTime())
}

function zoneOffsetMsAt(timeZone: string, instantMs: number): number {
  const parts = partsAt(timeZone, instantMs)
  const asIfUtc = utcMsFromParts(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )

  // `formatToParts` has no millisecond field, so compare against the instant
  // truncated to the second rather than the raw instant.
  const wholeSeconds = Math.floor(instantMs / MS_PER_SECOND) * MS_PER_SECOND

  return asIfUtc - wholeSeconds
}

/** The civil date a zone is showing at an instant. */
function civilDateAt(timeZone: string, instantMs: number): CivilDate {
  const parts = partsAt(timeZone, instantMs)

  return { year: parts.year, month: parts.month, day: parts.day }
}

function civilDayNumberAt(timeZone: string, instantMs: number): number {
  return civilDayNumber(civilDateAt(timeZone, instantMs))
}

/** How a requested wall-clock time was mapped onto the instant timeline. */
export type WallClockDisambiguation =
  /** The wall clock happened exactly once. The overwhelming majority of cases. */
  | 'EXACT'
  /**
   * The wall clock never happened — it fell in the hour a spring-forward
   * transition skipped. The instant returned is the requested time shifted
   * **forward** by the size of the gap, which is the end of the gap.
   */
  | 'GAP_SHIFTED_FORWARD'
  /**
   * The wall clock happened twice — a fall-back transition repeated the hour.
   * The instant returned is the **first** occurrence, i.e. the one still on the
   * pre-transition (summer) offset.
   */
  | 'AMBIGUOUS_FIRST_OCCURRENCE'

export interface WallClockResolution {
  readonly instant: Date
  readonly disambiguation: WallClockDisambiguation
}

/**
 * Turn "09:00 local on 2024-03-12, in America/Toronto" into a UTC instant.
 *
 * ## The DST contract, stated exactly
 *
 * A chef writes "Tuesday, 09:00–17:00". That is nine o'clock as the chef's
 * kitchen clock reads it, on every Tuesday, forever. In `America/Toronto` that
 * is 14:00Z in January and 13:00Z in July. **No fixed offset is ever computed
 * and reused** — the offset is looked up from the IANA database for the specific
 * instant, every time, which is what makes the rule survive both transitions.
 *
 * The mapping from wall clock to instant is not a function: it is many-to-one on
 * the fall-back day and undefined for an hour on the spring-forward day. Both
 * are resolved explicitly rather than left to whatever the arithmetic happens to
 * do:
 *
 * - **Spring forward (the gap).** On 2024-03-10 in Toronto the clocks jump
 *   02:00 EST → 03:00 EDT, so 02:30 local never occurs. A window whose bound
 *   lands in the gap is shifted **forward** to the far side of it: 02:30 becomes
 *   03:00 EDT (`07:00Z`), the same policy as `Temporal`'s `compatible`
 *   disambiguation. The consequence is deliberate and desirable: a window
 *   written `01:00–04:00` yields two real hours rather than three, and a window
 *   written `02:00–03:00` collapses to zero length and is **dropped entirely**,
 *   because that hour genuinely does not exist and no chef can work it.
 *
 * - **Fall back (the overlap).** On 2024-11-03 in Toronto the clocks repeat
 *   01:00–01:59 as EDT and then again as EST. A bound landing in the repeat
 *   resolves to the **first** occurrence — the earlier instant, still on the
 *   summer offset — again matching `Temporal`'s `compatible`. The consequence is
 *   also deliberate: `01:00–02:00` on that day is two real hours long, because
 *   the chef really is available for two hours of wall-clock-repeating time, and
 *   an engine that returned one hour would refuse a booking that is physically
 *   fine.
 *
 * ## The algorithm
 *
 * The offset is sampled a day either side of the nominal time (transitions are
 * never less than a day apart, so those two samples bracket at most one
 * transition). Each sample yields a candidate instant; a candidate is *valid*
 * only if converting it back through the zone reproduces exactly the requested
 * wall clock. Two valid candidates means the overlap; none means the gap; one
 * means an ordinary day. This round-trip check is what makes the routine correct
 * for zones with half-hour offsets, historical offset changes, and reverse-DST
 * jurisdictions such as `Australia/Lord_Howe`, none of which hand-rolled
 * arithmetic on a `getTimezoneOffset()` reading gets right.
 *
 * `minuteOfDay` may be any non-negative number of minutes from local midnight,
 * including `1440`, which `ChefAvailability.endMinute` uses to mean midnight at
 * the *end* of the day. Values of 1440 and above roll the civil date forward.
 *
 * @throws {RangeError} for an unrecognised IANA identifier.
 */
export function resolveWallClock(
  date: CivilDate,
  minuteOfDay: number,
  timeZone: string
): WallClockResolution {
  const dayShift = Math.floor(minuteOfDay / MINUTES_PER_DAY)
  const minuteWithinDay = minuteOfDay - dayShift * MINUTES_PER_DAY

  // The requested wall clock expressed as though it were a UTC instant. Every
  // valid answer `u` satisfies `u + offsetAt(u) === nominalMs`.
  const nominalMs =
    civilDayStartMs(date) +
    dayShift * MS_PER_DAY +
    minuteWithinDay * MS_PER_MINUTE

  const offsetBefore = zoneOffsetMsAt(timeZone, nominalMs - MS_PER_DAY)
  const offsetAfter = zoneOffsetMsAt(timeZone, nominalMs + MS_PER_DAY)

  const candidates =
    offsetBefore === offsetAfter
      ? [nominalMs - offsetBefore]
      : [nominalMs - offsetBefore, nominalMs - offsetAfter]

  const valid: number[] = []

  for (const candidate of candidates) {
    if (zoneOffsetMsAt(timeZone, candidate) === nominalMs - candidate) {
      valid.push(candidate)
    }
  }

  const first = valid[0]
  const second = valid[1]

  if (first !== undefined && second !== undefined) {
    return {
      instant: new Date(Math.min(first, second)),
      disambiguation: 'AMBIGUOUS_FIRST_OCCURRENCE',
    }
  }

  if (first !== undefined) {
    return { instant: new Date(first), disambiguation: 'EXACT' }
  }

  // The gap. A gap always means the offset jumped *up*, so the pre-transition
  // offset is the smaller of the two samples; subtracting the smaller offset
  // yields the later instant, which is the forward shift promised above.
  return {
    instant: new Date(nominalMs - Math.min(offsetBefore, offsetAfter)),
    disambiguation: 'GAP_SHIFTED_FORWARD',
  }
}

// =============================================================================
// 3. Interval algebra
// =============================================================================

/** Half-open overlap. Touching intervals do not overlap; one shared minute does. */
function msIntervalsOverlap(a: MsInterval, b: MsInterval): boolean {
  return a.start < b.end && b.start < a.end
}

function unionIds(
  left: readonly string[],
  right: readonly string[]
): readonly string[] {
  const out = [...left]

  for (const id of right) {
    if (!out.includes(id)) {
      out.push(id)
    }
  }

  return out
}

/**
 * Collapse overlapping *and touching* intervals into a disjoint, ordered set.
 *
 * Touching intervals are merged on purpose: two availability rules covering
 * 09:00–12:00 and 12:00–17:00 describe one eight-hour stretch, and a booking
 * that spans noon must not be refused for crossing a seam that exists only in
 * the rule table.
 */
function mergeMsIntervals(intervals: readonly MsInterval[]): MsInterval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const out: MsInterval[] = []

  for (const interval of sorted) {
    const last = out[out.length - 1]

    if (last !== undefined && interval.start <= last.end) {
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, interval.end),
      }
      continue
    }

    out.push({ start: interval.start, end: interval.end })
  }

  return out
}

/** `mergeMsIntervals`, carrying rule provenance through the merge. */
function mergeMsSpans(spans: readonly MsSpan[]): MsSpan[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const out: MsSpan[] = []

  for (const span of sorted) {
    const last = out[out.length - 1]

    if (last !== undefined && span.start <= last.end) {
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, span.end),
        sourceRuleIds: unionIds(last.sourceRuleIds, span.sourceRuleIds),
      }
      continue
    }

    out.push({
      start: span.start,
      end: span.end,
      sourceRuleIds: [...span.sourceRuleIds],
    })
  }

  return out
}

/**
 * Remove `cuts` from `base`. A cut through the middle of a span leaves two
 * pieces, each of which keeps the parent's provenance — the surviving morning of
 * a Tuesday window is still that Tuesday rule's doing.
 */
function subtractMsSpans(
  base: readonly MsSpan[],
  cuts: readonly MsInterval[]
): MsSpan[] {
  let result = base.slice()

  for (const cut of mergeMsIntervals(cuts)) {
    const next: MsSpan[] = []

    for (const span of result) {
      if (cut.end <= span.start || cut.start >= span.end) {
        next.push(span)
        continue
      }

      if (cut.start > span.start) {
        next.push({
          start: span.start,
          end: cut.start,
          sourceRuleIds: span.sourceRuleIds,
        })
      }

      if (cut.end < span.end) {
        next.push({
          start: cut.end,
          end: span.end,
          sourceRuleIds: span.sourceRuleIds,
        })
      }
    }

    result = next
  }

  return result.filter((span) => span.end > span.start)
}

/** The parts of `target` that `cover` does not reach. */
function uncoveredParts(
  target: MsInterval,
  cover: readonly MsInterval[]
): MsInterval[] {
  if (target.end <= target.start) {
    return []
  }

  const gaps: MsInterval[] = []
  let cursor = target.start

  for (const piece of mergeMsIntervals(cover)) {
    if (piece.end <= cursor) {
      continue
    }

    if (piece.start >= target.end) {
      break
    }

    if (piece.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(piece.start, target.end) })
    }

    cursor = Math.max(cursor, piece.end)

    if (cursor >= target.end) {
      break
    }
  }

  if (cursor < target.end) {
    gaps.push({ start: cursor, end: target.end })
  }

  return gaps
}

// =============================================================================
// 4. Domain input shapes
// =============================================================================

/**
 * A `ChefAvailability` row, reduced to the columns scheduling reads.
 *
 * Field names and nullability are taken verbatim from
 * `mannachef/packages/db/prisma/schema.prisma`, so a Prisma row is assignable
 * with no mapping. `timeZone` is widened to `string | null` only so a caller
 * that has not selected the column can pass `null` and fall back to the chef's
 * `calendarTimeZone`; Prisma's non-null `string` satisfies it unchanged.
 */
export interface AvailabilityRule {
  readonly id: string
  readonly kind: AvailabilityRuleKind
  /** 0 = Sunday … 6 = Saturday. Null on a `DATE_OVERRIDE` row. */
  readonly dayOfWeek: number | null
  /** A `@db.Date` column — Prisma returns it as UTC midnight. Null on a recurring row. */
  readonly specificDate: Date | null
  /** Minutes from local midnight, 0–1439. */
  readonly startMinute: number
  /** Minutes from local midnight, 1–1440. 1440 is midnight ending the day. */
  readonly endMinute: number
  readonly timeZone: string | null
  readonly effectiveFrom: Date | null
  readonly effectiveUntil: Date | null
  /** `true` subtracts this window from the calendar instead of adding it. */
  readonly isBlackout: boolean
}

/** A concrete stretch of instants a chef is available, after blackouts. */
export interface AvailabilityWindow extends TimeInterval {
  /** The `ChefAvailability.id`s that contributed to this window. */
  readonly sourceRuleIds: readonly string[]
}

/**
 * The timing columns of a `ChefAppointment`, or the same shape for an engagement
 * that does not exist yet. This is everything `occupiedInterval` needs.
 */
export interface BookingTiming {
  readonly startsAt: Date
  readonly endsAt: Date
  readonly prepStartsAt: Date | null
  readonly travelBufferBeforeMinutes: number
  readonly travelBufferAfterMinutes: number
}

/** An existing `ChefAppointment` the candidate has to be checked against. */
export interface AppointmentLike extends BookingTiming {
  readonly id: string
  readonly status: AppointmentStatus
}

/** A `BookingSlot`, reduced to the columns capacity depends on. */
export interface BookingSlotLike {
  readonly id: string
  readonly capacity: number
  readonly bookedCount: number
  readonly status: BookingSlotStatus
  readonly holdsUntil: Date | null
}

/** The `StaffProfile` columns scheduling depends on. */
export interface SchedulingStaffProfile {
  /**
   * `StaffProfile.maxConcurrentEvents`. A chef with a brigade may accept more
   * than one overlapping engagement; the engine honours the column rather than
   * assuming one.
   */
  readonly maxConcurrentEvents: number
  /** `StaffProfile.calendarTimeZone` — the fallback for rules with no zone. */
  readonly calendarTimeZone: string
}

// =============================================================================
// 5. Conflicts
// =============================================================================

export type BookingConflictKind =
  | 'CORE_OVERLAP'
  | 'BUFFER_OVERLAP'
  | 'CAPACITY'
  | 'OUTSIDE_AVAILABILITY'
  | 'INVALID_INTERVAL'
  | 'STARTS_IN_THE_PAST'
  | 'ILLEGAL_TRANSITION'

/**
 * The candidate collides with an engagement already on the calendar.
 *
 * `kind` separates the two refusals an administrator has to explain differently:
 *
 * - `CORE_OVERLAP` — the engagements themselves (preparation through service)
 *   overlap. The chef would have to be in two places at once.
 * - `BUFFER_OVERLAP` — the engagements do not overlap, but the travel time
 *   between them does. The chef could cook both; they could not get between
 *   them. Shortening a buffer, not moving a booking, is often the fix.
 */
export interface AppointmentOverlapConflict {
  readonly kind: 'CORE_OVERLAP' | 'BUFFER_OVERLAP'
  readonly appointmentId: string
  readonly appointmentStatus: AppointmentStatus
  /** The instants during which both engagements are occupied, buffers included. */
  readonly overlapStart: Date
  readonly overlapEnd: Date
  /**
   * How many engagements — the candidate included — are simultaneously occupied
   * at the busiest instant of this overlap. Always greater than
   * `maxConcurrentEvents`, or the overlap would not be a conflict.
   */
  readonly concurrentCount: number
  readonly maxConcurrentEvents: number
  readonly message: string
}

/** Why a slot could not take the booking. */
export type CapacityConflictCause =
  /** `bookedCount` already consumes the window's `capacity`. */
  | 'SOLD_OUT'
  /** A `HELD` window whose `holdsUntil` has not yet passed. */
  | 'LIVE_HOLD'
  /** `CANCELLED`, `EXPIRED`, or `FULL` — off the market whatever the count says. */
  | 'SLOT_CLOSED'

export interface CapacityConflict {
  readonly kind: 'CAPACITY'
  readonly cause: CapacityConflictCause
  readonly bookingSlotId: string
  readonly capacity: number
  readonly bookedCount: number
  /** Capacity consumed at the instant checked — booked seats plus any live hold. */
  readonly consumed: number
  readonly remaining: number
  readonly requested: number
  readonly message: string
}

/**
 * Part of the candidate's occupied interval falls outside every availability
 * window. `uncovered` names exactly which part, so the UI can say "your booking
 * fits, but the hour of driving afterwards does not".
 */
export interface AvailabilityConflict {
  readonly kind: 'OUTSIDE_AVAILABILITY'
  readonly uncovered: readonly TimeInterval[]
  readonly message: string
}

/** The candidate is not a well-formed interval at all. */
export interface IntervalConflict {
  readonly kind: 'INVALID_INTERVAL'
  readonly field: 'startsAt' | 'endsAt' | 'prepStartsAt' | 'travelBuffer'
  readonly message: string
}

/** The candidate is wholly or partly in the past. */
export interface PastStartConflict {
  readonly kind: 'STARTS_IN_THE_PAST'
  readonly occupiedStart: Date
  readonly now: Date
  readonly message: string
}

/** The appointment cannot make the requested move through the state machine. */
export interface StatusTransitionConflict {
  readonly kind: 'ILLEGAL_TRANSITION'
  readonly from: AppointmentStatus
  readonly to: AppointmentStatus
  readonly allowed: readonly AppointmentStatus[]
  readonly isTerminal: boolean
  readonly message: string
}

/**
 * Every way the engine can say no. Discriminated on `kind`; every member carries
 * a `message` the admin OS can render without a lookup table, and the structured
 * fields a UI needs to do better than that.
 */
export type BookingConflict =
  | AppointmentOverlapConflict
  | CapacityConflict
  | AvailabilityConflict
  | IntervalConflict
  | PastStartConflict
  | StatusTransitionConflict

// =============================================================================
// 6. Availability expansion
// =============================================================================

/** One rule, resolved onto one civil date. */
interface RuleOccurrence {
  readonly ruleId: string
  readonly isBlackout: boolean
  readonly isOverride: boolean
  /**
   * `zone`, a NUL, and the local day number — the key a positive override
   * suppresses recurring rules on. NUL cannot occur in an IANA identifier, so
   * the two halves can never be confused for one another.
   */
  readonly dateKey: string
  readonly start: number
  readonly end: number
}

/**
 * Whether a rule is in force on a given day.
 *
 * `effectiveFrom` / `effectiveUntil` bound the rule at **date granularity, read
 * in UTC, inclusive at both ends**.
 *
 * ## Why UTC, and why inclusive
 *
 * Both choices exist to agree with the validator rather than to be independently
 * elegant. `availabilityOverrideSchema` in `@mannachef/validators` enforces
 * `specificDate >= effectiveFrom` and `specificDate <= effectiveUntil` as raw
 * instant comparisons, and `specificDate` is a `@db.Date` column, so it always
 * arrives as UTC midnight. An override dated 18 June therefore passes validation
 * against an `effectiveUntil` of `2024-06-18T00:00:00Z` — and this engine has to
 * agree, or the API would accept a rule the calendar then silently ignored.
 *
 * Inclusivity matters for the same reason: an administrator who types "until 18
 * June" means the 18th is the last working day, not the last midnight. An
 * exclusive instant comparison would have dropped the whole of that day.
 *
 * The tradeoff, stated rather than hidden: for a chef far enough east that local
 * midnight precedes UTC midnight, a bound serialised as *local* midnight lands
 * on the previous UTC date and the rule stops a day early. The alternative —
 * reading the bound in the chef's zone — breaks the far more common case of a
 * bound serialised as UTC midnight, and breaks agreement with the validator.
 * Callers wanting exactness should store the bound at local **noon**, which is
 * unambiguous in every inhabited zone.
 */
function ruleAppliesOnDay(rule: AvailabilityRule, dayNumber: number): boolean {
  if (rule.effectiveFrom !== null) {
    if (!isFiniteDate(rule.effectiveFrom)) {
      return false
    }

    if (dayNumber < utcDayNumberOf(rule.effectiveFrom)) {
      return false
    }
  }

  if (rule.effectiveUntil !== null) {
    if (!isFiniteDate(rule.effectiveUntil)) {
      return false
    }

    if (dayNumber > utcDayNumberOf(rule.effectiveUntil)) {
      return false
    }
  }

  return true
}

function occurrenceFor(
  rule: AvailabilityRule,
  zone: string,
  date: CivilDate,
  isOverride: boolean
): RuleOccurrence | null {
  const start = resolveWallClock(date, rule.startMinute, zone).instant.getTime()
  const end = resolveWallClock(date, rule.endMinute, zone).instant.getTime()

  // Zero length is the spring-forward case: a window written entirely inside the
  // hour the clocks skipped. It is dropped rather than clamped, because nobody
  // can work an hour that did not happen.
  if (!(end > start)) {
    return null
  }

  return {
    ruleId: rule.id,
    isBlackout: rule.isBlackout,
    isOverride,
    dateKey: `${zone}\u0000${String(civilDayNumber(date))}`,
    start,
    end,
  }
}

/**
 * Turn `ChefAvailability` rows into the concrete instants a chef is free.
 *
 * ## What the two rule kinds mean
 *
 * - `RECURRING_WEEKLY` fires on every civil date in `range` whose local weekday
 *   equals `dayOfWeek`, using the rule's own `timeZone` (falling back to the
 *   chef's `calendarTimeZone`, the `timeZone` argument).
 * - `DATE_OVERRIDE` fires only on `specificDate`. Because that column is
 *   `@db.Date`, its civil date is read in UTC — a date-only column has no zone
 *   and reading it in the chef's zone would slide it a day for any chef east of
 *   Greenwich.
 *
 * ## How the two kinds combine
 *
 * The schema says an override "wins over recurring rules". Concretely: a
 * **non-blackout** override on a local date replaces every recurring window on
 * that same local date in that same zone. A chef who writes "Tuesdays 09:00–17:00"
 * and then a single override "this Tuesday, 18:00–22:00 only" gets the evening
 * and not the day.
 *
 * A **blackout** override does not replace anything — blackouts of either kind
 * are subtracted from the union at the end, which is what lets one carve a hole
 * in the middle of a recurring window and leave the morning and afternoon
 * either side of it intact.
 *
 * ## Ordering of operations
 *
 * positive overrides replace positive recurring rules on their dates → the
 * surviving positives are merged (overlapping *and* touching windows collapse)
 * → every blackout is subtracted → the result is clipped to `range`.
 *
 * @param rules Unordered; may mix chefs' zones, kinds, and blackout flags.
 * @param range Half-open `[from, until)`. An empty or inverted range yields `[]`.
 * @param timeZone The chef's `calendarTimeZone`, used for any rule with no zone.
 * @returns Disjoint, ascending, non-empty windows clipped to `range`.
 * @throws {RangeError} for a non-finite range bound, a range wider than
 * `MAX_EXPANSION_DAYS`, or an unrecognised IANA zone on a rule.
 */
export function expandAvailability(
  rules: readonly AvailabilityRule[],
  range: TimeRange,
  timeZone: string
): readonly AvailabilityWindow[] {
  if (!isFiniteDate(range.from) || !isFiniteDate(range.until)) {
    throw new RangeError(
      'expandAvailability requires a range bounded by two valid dates.'
    )
  }

  const rangeStart = range.from.getTime()
  const rangeEnd = range.until.getTime()

  if (rangeEnd <= rangeStart) {
    return []
  }

  if ((rangeEnd - rangeStart) / MS_PER_DAY > MAX_EXPANSION_DAYS) {
    throw new RangeError(
      `expandAvailability refuses a range wider than ${String(MAX_EXPANSION_DAYS)} days; narrow the query.`
    )
  }

  const occurrences: RuleOccurrence[] = []
  const suppressedDateKeys = new Set<string>()

  for (const rule of rules) {
    const zone = rule.timeZone ?? timeZone

    if (rule.kind === 'DATE_OVERRIDE') {
      if (rule.specificDate === null || !isFiniteDate(rule.specificDate)) {
        // A malformed row: the schema allows the column to be null so recurring
        // rules can leave it empty. Skipping is the only safe reading — an
        // override with no date cannot be placed on the calendar.
        continue
      }

      const date = civilDateFromDateOnlyColumn(rule.specificDate)

      if (!ruleAppliesOnDay(rule, civilDayNumber(date))) {
        continue
      }

      const occurrence = occurrenceFor(rule, zone, date, true)

      if (occurrence === null) {
        continue
      }

      occurrences.push(occurrence)

      if (!rule.isBlackout) {
        suppressedDateKeys.add(occurrence.dateKey)
      }

      continue
    }

    if (rule.dayOfWeek === null) {
      // Equally malformed, and equally unplaceable.
      continue
    }

    // One day of slack at the head covers a window that opened on the previous
    // local date and runs to midnight; one at the tail covers a window that
    // opens on the last local date the range touches.
    const firstDay = civilDayNumberAt(zone, rangeStart) - 1
    const lastDay = civilDayNumberAt(zone, rangeEnd) + 1

    for (let dayNumber = firstDay; dayNumber <= lastDay; dayNumber += 1) {
      const date = civilDateFromDayNumber(dayNumber)

      if (civilDayOfWeek(date) !== rule.dayOfWeek) {
        continue
      }

      if (!ruleAppliesOnDay(rule, dayNumber)) {
        continue
      }

      const occurrence = occurrenceFor(rule, zone, date, false)

      if (occurrence !== null) {
        occurrences.push(occurrence)
      }
    }
  }

  const positives: MsSpan[] = []
  const blackouts: MsInterval[] = []

  for (const occurrence of occurrences) {
    if (occurrence.isBlackout) {
      blackouts.push({ start: occurrence.start, end: occurrence.end })
      continue
    }

    if (!occurrence.isOverride && suppressedDateKeys.has(occurrence.dateKey)) {
      continue
    }

    positives.push({
      start: occurrence.start,
      end: occurrence.end,
      sourceRuleIds: [occurrence.ruleId],
    })
  }

  const carved = subtractMsSpans(mergeMsSpans(positives), blackouts)
  const windows: AvailabilityWindow[] = []

  for (const span of carved) {
    const start = Math.max(span.start, rangeStart)
    const end = Math.min(span.end, rangeEnd)

    if (end <= start) {
      continue
    }

    windows.push({
      start: new Date(start),
      end: new Date(end),
      sourceRuleIds: span.sourceRuleIds,
    })
  }

  return windows
}

// =============================================================================
// 7. The interval a booking actually consumes
// =============================================================================

/**
 * What a booking costs the chef's day.
 *
 * `start`/`end` are the buffered interval — the one that must not collide with
 * anything and must fit inside availability. `coreStart`/`coreEnd` are the
 * engagement itself, kept so a conflict can say whether the chef would have to
 * cook in two places or merely teleport between them.
 */
export interface OccupiedInterval extends TimeInterval {
  /** `min(prepStartsAt, startsAt)` — when the chef's obligation begins. */
  readonly coreStart: Date
  /** `endsAt` — when it ends, before travel home. */
  readonly coreEnd: Date
}

/**
 * The interval a booking genuinely consumes, which is **not** `startsAt..endsAt`.
 *
 * ```text
 *   ├── travelBufferBeforeMinutes ──┤├─ prep ─┤├── service ──┤├─ travelBufferAfterMinutes ─┤
 *   start                     coreStart   startsAt        endsAt/coreEnd                 end
 * ```
 *
 * - `coreStart = min(prepStartsAt, startsAt)`. Preparation — shopping, mise en
 *   place, an oven that has to come up to temperature — is time the chef is not
 *   available for anything else. `prepStartsAt` is nullable in the schema, in
 *   which case the engagement begins at `startsAt`.
 *
 *   The `min` is not redundant even though the validators enforce
 *   `prepStartsAt <= startsAt` on the way in: a row written before that rule
 *   existed, or amended through a path that skipped it, must not be able to make
 *   a booking *smaller* than the service it contains. `min` makes a mis-ordered
 *   prep time harmless instead of dangerous.
 *
 * - `coreEnd = endsAt`. Nothing extends the service itself.
 * - `start = coreStart - travelBufferBeforeMinutes`, `end = coreEnd +
 *   travelBufferAfterMinutes`. The drive there and the drive back.
 */
export function occupiedInterval(booking: BookingTiming): OccupiedInterval {
  const startsAtMs = booking.startsAt.getTime()
  const endsAtMs = booking.endsAt.getTime()
  const prepMs =
    booking.prepStartsAt === null ? startsAtMs : booking.prepStartsAt.getTime()

  const coreStartMs = Math.min(prepMs, startsAtMs)
  const coreEndMs = endsAtMs

  return {
    start: new Date(
      coreStartMs - booking.travelBufferBeforeMinutes * MS_PER_MINUTE
    ),
    end: new Date(coreEndMs + booking.travelBufferAfterMinutes * MS_PER_MINUTE),
    coreStart: new Date(coreStartMs),
    coreEnd: new Date(coreEndMs),
  }
}

/**
 * Structural checks on a candidate, before any calendar reasoning.
 *
 * Returns every problem it finds rather than the first, so a form can show all
 * of them at once. An empty array means the candidate is well formed — it says
 * nothing about whether the chef is free.
 */
export function validateBookingTiming(
  candidate: BookingTiming
): readonly IntervalConflict[] {
  const conflicts: IntervalConflict[] = []

  if (!isFiniteDate(candidate.startsAt)) {
    conflicts.push({
      kind: 'INVALID_INTERVAL',
      field: 'startsAt',
      message: 'The start of the engagement is not a valid date.',
    })
  }

  if (!isFiniteDate(candidate.endsAt)) {
    conflicts.push({
      kind: 'INVALID_INTERVAL',
      field: 'endsAt',
      message: 'The end of the engagement is not a valid date.',
    })
  }

  if (
    candidate.prepStartsAt !== null &&
    !isFiniteDate(candidate.prepStartsAt)
  ) {
    conflicts.push({
      kind: 'INVALID_INTERVAL',
      field: 'prepStartsAt',
      message: 'The preparation start is not a valid date.',
    })
  }

  for (const [field, minutes] of [
    ['travelBufferBeforeMinutes', candidate.travelBufferBeforeMinutes],
    ['travelBufferAfterMinutes', candidate.travelBufferAfterMinutes],
  ] as const) {
    if (!Number.isInteger(minutes) || minutes < 0) {
      conflicts.push({
        kind: 'INVALID_INTERVAL',
        field: 'travelBuffer',
        message: `${field} must be a whole number of minutes, and cannot be negative.`,
      })
    }
  }

  if (
    isFiniteDate(candidate.startsAt) &&
    isFiniteDate(candidate.endsAt) &&
    candidate.endsAt.getTime() <= candidate.startsAt.getTime()
  ) {
    conflicts.push({
      kind: 'INVALID_INTERVAL',
      field: 'endsAt',
      message:
        candidate.endsAt.getTime() === candidate.startsAt.getTime()
          ? 'An engagement cannot be zero minutes long — the end must fall after the start.'
          : 'The end of the engagement falls before its start.',
    })
  }

  return conflicts
}

// =============================================================================
// 8. Availability fit
// =============================================================================

export interface AvailabilityFit {
  readonly ok: boolean
  /** The parts of the occupied interval no window covers. Empty when `ok`. */
  readonly uncovered: readonly TimeInterval[]
}

function toOccupied(value: BookingTiming | OccupiedInterval): OccupiedInterval {
  return 'coreStart' in value ? value : occupiedInterval(value)
}

/**
 * Whether the whole occupied interval — **travel buffers included** — falls
 * inside the chef's availability.
 *
 * This is the check that catches the booking an admin swears should fit: the
 * dinner ends at 21:00 and the chef works until 21:00, but the ninety minutes of
 * driving home after it do not, so the booking is refused and `uncovered` says
 * "21:00–22:30".
 *
 * The windows are merged before the test, so touching windows behave as one
 * stretch and a booking is never refused for crossing a seam in the rule table.
 * With no windows at all, nothing is covered — an empty diary is a closed one.
 */
export function isWithinAvailability(
  candidate: BookingTiming | OccupiedInterval,
  windows: readonly AvailabilityWindow[]
): AvailabilityFit {
  const occupied = toOccupied(candidate)
  const target: MsInterval = {
    start: occupied.start.getTime(),
    end: occupied.end.getTime(),
  }

  if (!Number.isFinite(target.start) || !Number.isFinite(target.end)) {
    return { ok: false, uncovered: [] }
  }

  const gaps = uncoveredParts(
    target,
    windows.map((window) => ({
      start: window.start.getTime(),
      end: window.end.getTime(),
    }))
  )

  return {
    ok: gaps.length === 0,
    uncovered: gaps.map((gap) => ({
      start: new Date(gap.start),
      end: new Date(gap.end),
    })),
  }
}

// =============================================================================
// 9. Conflict detection
// =============================================================================

export interface ConflictOptions {
  /**
   * `StaffProfile.maxConcurrentEvents`. One overlapping engagement is refused
   * when this is 1; with 2 a chef may hold two at once and is only refused on
   * the third. Values below 1, or non-integers, are treated as 1.
   */
  readonly maxConcurrentEvents: number
  /** Defaults to `DEFAULT_BLOCKING_APPOINTMENT_STATUSES` from the validators. */
  readonly blockingStatuses?: readonly AppointmentStatus[] | undefined
  /** The engagement being amended, which must not conflict with itself. */
  readonly excludeAppointmentId?: string | null | undefined
}

interface OccupiedAppointment {
  readonly appointment: AppointmentLike
  readonly occupied: OccupiedInterval
  readonly start: number
  readonly end: number
}

/**
 * Which existing engagements the candidate collides with, and why.
 *
 * ## Half-open, so back-to-back works
 *
 * Overlap is `a.start < b.end && b.start < a.end`. An engagement occupying
 * `[15:00, 17:00)` and one occupying `[17:00, 19:00)` do not conflict. Move the
 * second to 16:59 and they do.
 *
 * ## Concurrency, not pairwise collision
 *
 * A chef with `maxConcurrentEvents: 2` is *allowed* to overlap. Reporting every
 * pairwise overlap as a conflict would refuse bookings that column exists to
 * permit. So the engine sweeps the candidate's occupied interval instead: at
 * every boundary it counts how many engagements — candidate included — are
 * simultaneously occupied, and only the stretches where that count exceeds the
 * limit are conflicts. An engagement is reported only if it is active during one
 * of those over-subscribed stretches, and it carries the peak count it was part
 * of, so the UI can say "this would be your third engagement at once".
 *
 * ## Never a bare boolean
 *
 * The admin OS has to explain a refusal to a guest on the telephone. Every
 * conflict names the appointment, its status, the exact instants of the clash,
 * and whether the clash is the engagements themselves or only the travel between
 * them.
 *
 * A degenerate candidate — zero length or inverted — returns `[]`, because a
 * half-open interval of no width genuinely overlaps nothing. That is not a
 * licence to book it: `validateBookingTiming` is the gate for that, and
 * `evaluateBooking` runs it first.
 *
 * @returns Conflicts ordered by overlap start, then appointment id.
 */
export function findConflicts(
  candidate: BookingTiming | OccupiedInterval,
  existing: readonly AppointmentLike[],
  options: ConflictOptions
): readonly AppointmentOverlapConflict[] {
  const limit =
    Number.isInteger(options.maxConcurrentEvents) &&
    options.maxConcurrentEvents >= 1
      ? options.maxConcurrentEvents
      : 1

  const blocking =
    options.blockingStatuses ?? DEFAULT_BLOCKING_APPOINTMENT_STATUSES
  const excluded = options.excludeAppointmentId ?? null

  const own = toOccupied(candidate)
  const ownStart = own.start.getTime()
  const ownEnd = own.end.getTime()

  if (
    !Number.isFinite(ownStart) ||
    !Number.isFinite(ownEnd) ||
    ownEnd <= ownStart
  ) {
    return []
  }

  const relevant: OccupiedAppointment[] = []

  for (const appointment of existing) {
    if (appointment.id === excluded) {
      continue
    }

    if (!blocking.includes(appointment.status)) {
      continue
    }

    const occupied = occupiedInterval(appointment)
    const start = occupied.start.getTime()
    const end = occupied.end.getTime()

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue
    }

    if (!msIntervalsOverlap({ start: ownStart, end: ownEnd }, { start, end })) {
      continue
    }

    relevant.push({ appointment, occupied, start, end })
  }

  if (relevant.length === 0) {
    return []
  }

  const boundaries = new Set<number>([ownStart, ownEnd])

  for (const entry of relevant) {
    if (entry.start > ownStart && entry.start < ownEnd) {
      boundaries.add(entry.start)
    }

    if (entry.end > ownStart && entry.end < ownEnd) {
      boundaries.add(entry.end)
    }
  }

  const points = [...boundaries].sort((a, b) => a - b)
  const peakConcurrency = new Map<string, number>()

  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentStart = points[index]
    const segmentEnd = points[index + 1]

    if (
      segmentStart === undefined ||
      segmentEnd === undefined ||
      segmentEnd <= segmentStart
    ) {
      continue
    }

    const active = relevant.filter((entry) =>
      msIntervalsOverlap(
        { start: segmentStart, end: segmentEnd },
        { start: entry.start, end: entry.end }
      )
    )

    // The candidate itself occupies every segment of its own interval.
    const concurrent = active.length + 1

    if (concurrent <= limit) {
      continue
    }

    for (const entry of active) {
      const previous = peakConcurrency.get(entry.appointment.id) ?? 0
      peakConcurrency.set(entry.appointment.id, Math.max(previous, concurrent))
    }
  }

  const conflicts: AppointmentOverlapConflict[] = []

  for (const entry of relevant) {
    const concurrentCount = peakConcurrency.get(entry.appointment.id)

    if (concurrentCount === undefined) {
      continue
    }

    const overlapStart = Math.max(ownStart, entry.start)
    const overlapEnd = Math.min(ownEnd, entry.end)

    const coreOverlaps = msIntervalsOverlap(
      { start: own.coreStart.getTime(), end: own.coreEnd.getTime() },
      {
        start: entry.occupied.coreStart.getTime(),
        end: entry.occupied.coreEnd.getTime(),
      }
    )

    conflicts.push({
      kind: coreOverlaps ? 'CORE_OVERLAP' : 'BUFFER_OVERLAP',
      appointmentId: entry.appointment.id,
      appointmentStatus: entry.appointment.status,
      overlapStart: new Date(overlapStart),
      overlapEnd: new Date(overlapEnd),
      concurrentCount,
      maxConcurrentEvents: limit,
      message: coreOverlaps
        ? `This engagement overlaps engagement ${entry.appointment.id} (${entry.appointment.status}) — the chef cannot cook both at once.`
        : `Travel time collides with engagement ${entry.appointment.id} (${entry.appointment.status}) — the engagements do not overlap, but the journey between them does.`,
    })
  }

  conflicts.sort(
    (a, b) =>
      a.overlapStart.getTime() - b.overlapStart.getTime() ||
      (a.appointmentId < b.appointmentId
        ? -1
        : a.appointmentId > b.appointmentId
          ? 1
          : 0)
  )

  return conflicts
}

// =============================================================================
// 10. Capacity
// =============================================================================

export interface CapacityAssessment {
  readonly bookingSlotId: string
  readonly capacity: number
  readonly bookedCount: number
  /** Seats consumed at `now` — `bookedCount`, or the whole window under a live hold. */
  readonly consumed: number
  readonly remaining: number
  readonly requested: number
  /** `true` when a `HELD` window's `holdsUntil` is still in the future. */
  readonly holdIsLive: boolean
  readonly ok: boolean
  readonly conflict: CapacityConflict | null
}

/**
 * Whether a `BookingSlot` can take `requested` more bookings at `now`.
 *
 * ## The soft hold
 *
 * `BookingSlot.status = HELD` with a `holdsUntil` in the future is a soft
 * reservation over the window — a guest part-way through checkout. While it is
 * live nobody else may take the window, so `consumed` is the full `capacity` and
 * `remaining` is zero.
 *
 * **An expired hold consumes nothing.** The moment `holdsUntil` passes, the
 * window falls back to plain arithmetic on `bookedCount`, without waiting for a
 * sweeper job to rewrite `status`. That is the whole reason `now` is a parameter
 * rather than a `Date.now()` read: a hold that lapsed a second ago must not keep
 * a paying guest out, and the boundary has to be testable to the millisecond.
 * The comparison is strictly greater-than, so a hold expiring exactly at `now`
 * has expired.
 *
 * ## The closed statuses
 *
 * `CANCELLED`, `EXPIRED`, and `FULL` take the window off the market whatever the
 * counts say. `OPEN` and `BOOKED` are governed by arithmetic — a `BOOKED`
 * window with capacity five and one booking still has room for four.
 *
 * @throws {RangeError} when `requested` is not a positive integer. Asking for
 * zero or half a seat is a caller bug, not a booking that should be refused.
 */
export function checkCapacity(
  slot: BookingSlotLike,
  requested: number,
  now: Date
): CapacityAssessment {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new RangeError(
      'checkCapacity requires a whole number of bookings, at least one.'
    )
  }

  const capacity = Math.max(0, slot.capacity)
  const bookedCount = Math.max(0, slot.bookedCount)

  const holdIsLive =
    slot.status === 'HELD' &&
    slot.holdsUntil !== null &&
    isFiniteDate(slot.holdsUntil) &&
    slot.holdsUntil.getTime() > now.getTime()

  const slotIsClosed = UNBOOKABLE_SLOT_STATUSES.includes(slot.status)

  const consumed =
    slotIsClosed || holdIsLive ? Math.max(capacity, bookedCount) : bookedCount

  const remaining = Math.max(0, capacity - consumed)
  const ok = requested <= remaining

  if (ok) {
    return {
      bookingSlotId: slot.id,
      capacity,
      bookedCount,
      consumed,
      remaining,
      requested,
      holdIsLive,
      ok: true,
      conflict: null,
    }
  }

  const cause: CapacityConflictCause = slotIsClosed
    ? 'SLOT_CLOSED'
    : holdIsLive
      ? 'LIVE_HOLD'
      : 'SOLD_OUT'

  const message =
    cause === 'SLOT_CLOSED'
      ? `This window is ${slot.status.toLowerCase()} and is no longer taking bookings.`
      : cause === 'LIVE_HOLD'
        ? 'Another guest is holding this window; it will reopen if their hold lapses.'
        : `This window has room for ${String(remaining)} more booking${remaining === 1 ? '' : 's'}, and ${String(requested)} ${requested === 1 ? 'was' : 'were'} requested.`

  return {
    bookingSlotId: slot.id,
    capacity,
    bookedCount,
    consumed,
    remaining,
    requested,
    holdIsLive,
    ok: false,
    conflict: {
      kind: 'CAPACITY',
      cause,
      bookingSlotId: slot.id,
      capacity,
      bookedCount,
      consumed,
      remaining,
      requested,
      message,
    },
  }
}

// =============================================================================
// 11. Alternatives
// =============================================================================

export interface AlternativeSlot {
  readonly startsAt: Date
  readonly endsAt: Date
  readonly occupied: OccupiedInterval
  /** Signed milliseconds from the originally requested start. Negative is earlier. */
  readonly shiftMs: number
}

export interface AlternativeOptions {
  /** Nothing before this instant is suggested, buffers included. */
  readonly now: Date
  readonly maxConcurrentEvents: number
  readonly blockingStatuses?: readonly AppointmentStatus[] | undefined
  readonly excludeAppointmentId?: string | null | undefined
}

/** Move a whole booking — prep, service, and buffers — by a fixed offset. */
function shiftTiming(booking: BookingTiming, deltaMs: number): BookingTiming {
  return {
    startsAt: new Date(booking.startsAt.getTime() + deltaMs),
    endsAt: new Date(booking.endsAt.getTime() + deltaMs),
    prepStartsAt:
      booking.prepStartsAt === null
        ? null
        : new Date(booking.prepStartsAt.getTime() + deltaMs),
    travelBufferBeforeMinutes: booking.travelBufferBeforeMinutes,
    travelBufferAfterMinutes: booking.travelBufferAfterMinutes,
  }
}

/**
 * The nearest `limit` conflict-free starts for the same booking, so the UI can
 * offer options instead of a dead end.
 *
 * The booking is treated as rigid: preparation, service, and both travel buffers
 * move together, so an alternative is always the same engagement at a different
 * hour rather than a compressed version of it.
 *
 * ## Why the candidate positions are events, not a grid
 *
 * Sweeping a fixed 15-minute grid would miss the answer whenever the only gap
 * begins at 17:20, and would waste work everywhere else. Instead the engine
 * tries only the positions where the answer can possibly change:
 *
 * - the requested time itself (it may be free once a buffer is reconsidered),
 * - the start of every availability window (flush against opening),
 * - the end of every availability window minus the duration (flush against closing),
 * - the end of every blocking engagement (back-to-back, which half-open
 *   intervals make legal),
 * - the start of every blocking engagement minus the duration (slotting in just
 *   before one).
 *
 * Every position is then subjected to the full check — availability including
 * buffers, and `findConflicts` under the chef's real concurrency limit — so a
 * suggestion is never something the engine would subsequently refuse.
 *
 * Results are ordered by distance from the requested start; ties prefer the
 * later option, on the grounds that a guest offered "an hour earlier or an hour
 * later" usually means the later one.
 */
export function suggestAlternatives(
  candidate: BookingTiming,
  windows: readonly AvailabilityWindow[],
  existing: readonly AppointmentLike[],
  limit: number,
  options: AlternativeOptions
): readonly AlternativeSlot[] {
  const wanted = Math.trunc(limit)

  if (!Number.isFinite(wanted) || wanted < 1) {
    return []
  }

  if (validateBookingTiming(candidate).length > 0) {
    return []
  }

  const own = occupiedInterval(candidate)
  const ownStart = own.start.getTime()
  const ownEnd = own.end.getTime()
  const durationMs = ownEnd - ownStart

  if (durationMs <= 0) {
    return []
  }

  const blocking =
    options.blockingStatuses ?? DEFAULT_BLOCKING_APPOINTMENT_STATUSES
  const excluded = options.excludeAppointmentId ?? null
  const earliest = options.now.getTime()

  const positions = new Set<number>([ownStart])

  for (const window of mergeMsIntervals(
    windows.map((window) => ({
      start: window.start.getTime(),
      end: window.end.getTime(),
    }))
  )) {
    positions.add(window.start)
    positions.add(window.end - durationMs)
  }

  for (const appointment of existing) {
    if (appointment.id === excluded || !blocking.includes(appointment.status)) {
      continue
    }

    const occupied = occupiedInterval(appointment)
    const start = occupied.start.getTime()
    const end = occupied.end.getTime()

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue
    }

    positions.add(end)
    positions.add(start - durationMs)
  }

  const conflictOptions: ConflictOptions = {
    maxConcurrentEvents: options.maxConcurrentEvents,
    blockingStatuses: blocking,
    excludeAppointmentId: excluded,
  }

  const found: AlternativeSlot[] = []

  for (const position of [...positions].sort((a, b) => a - b)) {
    if (!Number.isFinite(position) || position < earliest) {
      continue
    }

    const shiftMs = position - ownStart
    const shifted = shiftTiming(candidate, shiftMs)

    if (!isWithinAvailability(shifted, windows).ok) {
      continue
    }

    if (findConflicts(shifted, existing, conflictOptions).length > 0) {
      continue
    }

    found.push({
      startsAt: shifted.startsAt,
      endsAt: shifted.endsAt,
      occupied: occupiedInterval(shifted),
      shiftMs,
    })
  }

  found.sort(
    (a, b) => Math.abs(a.shiftMs) - Math.abs(b.shiftMs) || b.shiftMs - a.shiftMs
  )

  return found.slice(0, wanted)
}

// =============================================================================
// 12. The state machine guard
// =============================================================================

export type StatusTransitionResult =
  | {
      readonly ok: true
      readonly from: AppointmentStatus
      readonly to: AppointmentStatus
    }
  | {
      readonly ok: false
      readonly reasons: readonly [StatusTransitionConflict]
    }

/**
 * Whether an engagement may move from one status to another, in this module's
 * refusal vocabulary.
 *
 * Delegates to `canTransition` from `@mannachef/validators` — the table is not
 * restated here (see the note at the head of this file). What this adds is a
 * `BookingConflict` an action can put straight into an `ActionResult`, and a
 * distinct message for the no-op case, which `canTransition` reports as an
 * ordinary illegal move because the table has no self-edges.
 */
export function checkStatusTransition(
  from: AppointmentStatus,
  to: AppointmentStatus
): StatusTransitionResult {
  const allowed = allowedAppointmentTransitions(from)
  const isTerminal = isTerminalAppointmentStatus(from)

  if (from === to) {
    return {
      ok: false,
      reasons: [
        {
          kind: 'ILLEGAL_TRANSITION',
          from,
          to,
          allowed,
          isTerminal,
          message: `This engagement is already ${from.toLowerCase().replace('_', ' ')}.`,
        },
      ],
    }
  }

  if (canTransition(from, to)) {
    return { ok: true, from, to }
  }

  return {
    ok: false,
    reasons: [
      {
        kind: 'ILLEGAL_TRANSITION',
        from,
        to,
        allowed,
        isTerminal,
        message: isTerminal
          ? `A ${from.toLowerCase().replace('_', ' ')} engagement is final and cannot be changed — record a new engagement instead.`
          : `An engagement cannot move from ${from} to ${to}. Available next: ${allowed.length > 0 ? allowed.join(', ') : 'none'}.`,
      },
    ],
  }
}

// =============================================================================
// 13. The entry point
// =============================================================================

export interface BookingEvaluationInput {
  /** The instant the decision is made at. Soft holds and past starts read it. */
  readonly now: Date
  readonly candidate: BookingTiming
  readonly staff: SchedulingStaffProfile
  /** Every `ChefAvailability` row for this chef. Filtering is the engine's job. */
  readonly availabilityRules: readonly AvailabilityRule[]
  /** Every engagement for this chef in the neighbourhood of the candidate. */
  readonly existingAppointments: readonly AppointmentLike[]
  /**
   * The span availability is materialised over. Widened automatically to contain
   * the candidate, so a caller cannot accidentally refuse a booking by querying
   * a range that does not reach it, but wide enough for the suggestions the
   * caller wants — a range of the candidate's day yields same-day alternatives
   * only.
   */
  readonly searchRange: TimeRange
  /** The window being booked into, when the booking came from the diary. */
  readonly bookingSlot?: BookingSlotLike | null | undefined
  /** Bookings taken from `bookingSlot`'s capacity. Defaults to 1. */
  readonly requestedSeats?: number | undefined
  /** Defaults to `DEFAULT_BLOCKING_APPOINTMENT_STATUSES`. */
  readonly blockingStatuses?: readonly AppointmentStatus[] | undefined
  /** The engagement being amended, excluded from conflicting with itself. */
  readonly excludeAppointmentId?: string | null | undefined
  /** How many alternatives to compute on a refusal. Defaults to 3; 0 disables. */
  readonly suggestionLimit?: number | undefined
  /**
   * Whether the booking must sit inside published availability. Defaults to
   * `true`. An administrator overriding the diary by hand passes `false`; the
   * overlap and capacity checks still run.
   */
  readonly requireWithinAvailability?: boolean | undefined
  /** Whether a booking whose occupied interval has begun is refused. Defaults to `true`. */
  readonly rejectPastStarts?: boolean | undefined
}

export type BookingEvaluation =
  | {
      readonly ok: true
      readonly occupied: OccupiedInterval
      readonly windows: readonly AvailabilityWindow[]
      readonly capacity: CapacityAssessment | null
    }
  | {
      readonly ok: false
      readonly reasons: readonly BookingConflict[]
      readonly occupied: OccupiedInterval
      readonly windows: readonly AvailabilityWindow[]
      readonly capacity: CapacityAssessment | null
      readonly alternatives: readonly AlternativeSlot[]
    }

/**
 * The single question the action layer asks: can this booking be written?
 *
 * Composes everything above, in the order that produces the most useful refusal:
 *
 * 1. **Structure.** A candidate that is not an interval is rejected on its own,
 *    with no calendar reasoning attached — telling a caller their zero-length
 *    booking also clashes with a dinner would be noise.
 * 2. **The past.** A booking whose occupied interval has already begun.
 * 3. **Availability**, buffers included, from the expanded rules.
 * 4. **Conflicts** with existing engagements, under the chef's real
 *    `maxConcurrentEvents`.
 * 5. **Capacity** of the booking slot, honouring live and lapsed soft holds.
 *
 * Steps 2–5 all run: a refusal lists every reason at once, because an
 * administrator who fixes the time only to be told about the capacity is being
 * made to guess.
 *
 * On refusal it also computes alternatives, so the caller always has something
 * to offer.
 *
 * @throws {RangeError} propagated from `expandAvailability` (bad zone, absurd
 * range) or `checkCapacity` (non-positive seat count). These are caller bugs;
 * `withAction` maps them to `INTERNAL`.
 */
export function evaluateBooking(
  input: BookingEvaluationInput
): BookingEvaluation {
  const occupied = occupiedInterval(input.candidate)
  const structural = validateBookingTiming(input.candidate)

  if (structural.length > 0) {
    return {
      ok: false,
      reasons: structural,
      occupied,
      windows: [],
      capacity: null,
      alternatives: [],
    }
  }

  const requireAvailability = input.requireWithinAvailability ?? true
  const rejectPast = input.rejectPastStarts ?? true
  const suggestionLimit = input.suggestionLimit ?? 3
  const requestedSeats = input.requestedSeats ?? 1
  const blocking =
    input.blockingStatuses ?? DEFAULT_BLOCKING_APPOINTMENT_STATUSES
  const excluded = input.excludeAppointmentId ?? null

  const range: TimeRange = {
    from: new Date(
      Math.min(input.searchRange.from.getTime(), occupied.start.getTime())
    ),
    until: new Date(
      Math.max(input.searchRange.until.getTime(), occupied.end.getTime())
    ),
  }

  const windows = expandAvailability(
    input.availabilityRules,
    range,
    input.staff.calendarTimeZone
  )

  const reasons: BookingConflict[] = []

  if (rejectPast && occupied.start.getTime() < input.now.getTime()) {
    reasons.push({
      kind: 'STARTS_IN_THE_PAST',
      occupiedStart: occupied.start,
      now: input.now,
      message:
        'This engagement — travel time included — has already begun; please choose a later time.',
    })
  }

  if (requireAvailability) {
    const fit = isWithinAvailability(occupied, windows)

    if (!fit.ok) {
      reasons.push({
        kind: 'OUTSIDE_AVAILABILITY',
        uncovered: fit.uncovered,
        message:
          fit.uncovered.length === 0
            ? 'The chef has no availability published for this time.'
            : 'Part of this engagement falls outside the chef’s availability — travel time is counted, so a booking can fit while the journey either side of it does not.',
      })
    }
  }

  const overlaps = findConflicts(occupied, input.existingAppointments, {
    maxConcurrentEvents: input.staff.maxConcurrentEvents,
    blockingStatuses: blocking,
    excludeAppointmentId: excluded,
  })

  for (const overlap of overlaps) {
    reasons.push(overlap)
  }

  const slot = input.bookingSlot ?? null
  const capacity =
    slot === null ? null : checkCapacity(slot, requestedSeats, input.now)

  if (capacity !== null && capacity.conflict !== null) {
    reasons.push(capacity.conflict)
  }

  if (reasons.length === 0) {
    return { ok: true, occupied, windows, capacity }
  }

  const alternatives =
    suggestionLimit > 0
      ? suggestAlternatives(
          input.candidate,
          windows,
          input.existingAppointments,
          suggestionLimit,
          {
            now: input.now,
            maxConcurrentEvents: input.staff.maxConcurrentEvents,
            blockingStatuses: blocking,
            excludeAppointmentId: excluded,
          }
        )
      : []

  return { ok: false, reasons, occupied, windows, capacity, alternatives }
}
