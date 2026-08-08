// mannachef/apps/web/src/components/admin/calendar/calendar-grid.tsx
'use client'

/**
 * The dispatch grid — Day / Week / Month.
 *
 * ## What this component is, and is not
 *
 * It is a *presentation* of `src/server/scheduling.ts`. That module is the
 * authority on what a booking occupies, on what a wall-clock time means on a
 * day the clocks move, and on whether two engagements collide. Nothing in this
 * file re-decides any of it:
 *
 * - `occupiedInterval()` is what draws a block. The four bands a dispatcher
 *   sees — drive out, prep, service, drive home — are exactly the boundaries
 *   the engine returns (`start`, `coreStart`, `startsAt`, `endsAt`/`coreEnd`,
 *   `end`), never a re-derivation from the raw columns.
 * - `resolveWallClock()` is what turns "09:00 on this date" into an instant on
 *   a transition day, so the ruler is right on the two days a year it could be
 *   wrong.
 * - `timeZoneOffsetMs()` is what places an instant on that ruler.
 *
 * Overlap detection here answers one question only — "how many side-by-side
 * lanes does this column need so nothing is hidden" — which is a layout
 * question, not a scheduling one. Whether an overlap is *permitted* is
 * `findConflicts` / `checkCapacity`, and this grid never guesses at it.
 *
 * ## Time zone
 *
 * Everything is drawn and labelled in the chef's `calendarTimeZone`, which is
 * named in the header and repeated in the ruler's corner. A dispatcher looking
 * at a Toronto chef from a laptop in Lisbon must see the Toronto clock, because
 * the chef has to be at a door at a wall-clock time. The viewer's own zone is
 * never used for placement, and is offered only as a secondary annotation when
 * it differs.
 *
 * The vertical axis is wall-clock minutes from local midnight, not elapsed
 * time. That is deliberate: on a spring-forward day a 09:00 rule sits at 09:00,
 * and the hour the clocks skipped is marked as skipped rather than silently
 * shrinking the column.
 *
 * ## Data
 *
 * Props only. This component fetches nothing and calls no action. Its parent
 * (a Server Component) loads appointments, calls `expandAvailability`, and
 * hands the results down.
 */

import * as React from 'react'
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Info,
  MapPin,
  Users,
} from 'lucide-react'

import {
  occupiedInterval,
  resolveWallClock,
  timeZoneOffsetMs,
} from '@/server/scheduling'
import type {
  AppointmentLike,
  AvailabilityWindow,
  CivilDate,
  OccupiedInterval,
  TimeInterval,
} from '@/server/scheduling'
import type { AppointmentStatus, ServiceType } from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Hint, TooltipProvider } from '@/components/ui/tooltip'
import { cn, FOCUS_RING } from '@/lib/utils'

// =============================================================================
// 0. Constants
// =============================================================================

const MS_PER_MINUTE = 60_000
const MINUTES_PER_DAY = 1_440
const MS_PER_DAY = 86_400_000

/** The window the ruler shows before the data is allowed to widen it. */
const DEFAULT_WINDOW_START_MINUTE = 8 * 60
const DEFAULT_WINDOW_END_MINUTE = 22 * 60

/** Below this height a band cannot carry a legible label, only its texture. */
const MIN_LABELLED_BAND_PX = 22

/** Below this height a block collapses to a single line. */
const MIN_DETAILED_BLOCK_PX = 64

// =============================================================================
// 1. Public shapes
// =============================================================================

export type CalendarView = 'day' | 'week' | 'month'

/**
 * An engagement, in the exact shape the conflict engine consumes plus the few
 * fields a human needs to recognise it.
 *
 * Extending `AppointmentLike` rather than restating its five timing fields is
 * the point: a row that is valid input to `occupiedInterval` is valid input to
 * this grid, with no mapping layer able to drift from the engine's idea of what
 * a booking occupies.
 */
export interface CalendarAppointment extends AppointmentLike {
  /**
   * What the block says. Optional because the dispatch page hands this grid
   * `listAppointments` rows straight from the action, and an engagement has no
   * free-text title of its own — `serviceType` is what names it. A caller with
   * a better label (a menu name, an occasion) passes one and it wins.
   */
  readonly title?: string | null
  /** Falls back to naming the block when there is no `title`. */
  readonly serviceType?: ServiceType | null
  /** The household. Rendered secondary, omitted when the block is short. */
  readonly clientName?: string | null
  /** Where the chef has to be. Falls back to `city`. */
  readonly locationLabel?: string | null
  readonly city?: string | null
  readonly guestCount?: number | null
}

/**
 * A stretch the chef has taken off the market, already resolved to instants.
 *
 * Note what this is *not*: a `ChefAvailability` row with `isBlackout` set. Those
 * are minute-of-day rules that only `expandAvailability` knows how to land on a
 * calendar, and it has already subtracted them from the windows this grid is
 * given. Pass this prop only for blackouts a caller has resolved through the
 * engine; never hand-expand a rule to fill it.
 */
export interface CalendarBlackout extends TimeInterval {
  readonly id: string
  /** Shown in the tooltip — "Annual leave", "Wedding — not working". */
  readonly label?: string | null
}

/**
 * An availability rule, carried purely so a window can say what produced it.
 *
 * `AvailabilityWindow.sourceRuleIds` is the join. Nothing here is expanded,
 * matched against a weekday, or subtracted — that is `expandAvailability`'s
 * job and it has already run. This is a lookup table for labels.
 */
export interface CalendarAvailabilityRule {
  readonly id: string
  readonly startMinute: number
  readonly endMinute: number
  readonly isBlackout: boolean
  readonly reason?: string | null
  readonly note?: string | null
}

/** The half-open slot a click on empty grid selects. */
export interface CalendarSlotSelection {
  readonly start: Date
  readonly end: Date
}

export interface CalendarGridProps {
  /**
   * The chef's `StaffProfile.calendarTimeZone`. Every time on screen is drawn
   * and labelled in this zone. Required, and deliberately not defaulted to the
   * viewer's zone — a silent fallback is the bug this prop exists to prevent.
   */
  timeZone: string

  /** Any instant inside the range to show. Uncontrolled if `defaultAnchorDate`. */
  anchorDate?: Date
  defaultAnchorDate?: Date

  /**
   * `YYYY-MM-DD`, read as a calendar date in `timeZone`. What a Server
   * Component that keeps the focused day in the URL passes instead of an
   * instant, since a date key survives a link and an instant does not.
   * Outranked by `anchorDate`.
   */
  focusedDate?: string

  view?: CalendarView
  defaultView?: CalendarView

  /**
   * An explicit range to draw, half-open. When both are given they replace the
   * range this grid would have derived from `view` and the anchor — which is
   * what lets a server that already computed the range (leading and trailing
   * weeks of a month included) stay the single authority on it.
   */
  rangeStart?: Date
  rangeEnd?: Date

  appointments: readonly CalendarAppointment[]
  availabilityWindows: readonly AvailabilityWindow[]
  /** Instant-level blackouts. Optional; see `CalendarBlackout`. */
  blackouts?: readonly CalendarBlackout[]
  /** Rules, for labelling windows and counting blackouts. Never expanded here. */
  rules?: readonly CalendarAvailabilityRule[]

  /** 0 = Sunday … 6 = Saturday, matching the engine's `AvailabilityRule`. */
  weekStartsOn?: number

  /** Grid resolution for keyboard slots and empty-space selection. */
  slotMinutes?: number

  /** Pixels per wall-clock hour in Day and Week. */
  hourHeight?: number

  /** "Now" — injected so a test can pin it. Defaults to the render clock. */
  now?: Date

  onViewChange?: (view: CalendarView) => void
  onAnchorDateChange?: (anchorDate: Date) => void
  onSelectAppointment?: (appointment: CalendarAppointment) => void
  onSelectSlot?: (selection: CalendarSlotSelection) => void

  className?: string
}

const SERVICE_TYPE_LABELS: Readonly<Record<ServiceType, string>> = {
  IN_HOME_DINNER: 'In-home dinner',
  MEAL_PREP: 'Meal prep',
  PRIVATE_EVENT: 'Private event',
  COOKING_CLASS: 'Cooking class',
  TASTING: 'Tasting',
  CATERING: 'Catering',
  CONSULTATION: 'Consultation',
  DELIVERY_DROP_OFF: 'Delivery drop-off',
}

/** What a block is called: an explicit title, else the service, else a noun. */
function appointmentLabel(appointment: CalendarAppointment): string {
  if (appointment.title !== null && appointment.title !== undefined && appointment.title !== '') {
    return appointment.title
  }

  if (appointment.serviceType !== null && appointment.serviceType !== undefined) {
    return SERVICE_TYPE_LABELS[appointment.serviceType]
  }

  return 'Engagement'
}

/** Where the chef has to be: an explicit label, else the city, else nothing. */
function appointmentPlace(appointment: CalendarAppointment): string | null {
  if (
    appointment.locationLabel !== null &&
    appointment.locationLabel !== undefined &&
    appointment.locationLabel !== ''
  ) {
    return appointment.locationLabel
  }

  if (appointment.city !== null && appointment.city !== undefined && appointment.city !== '') {
    return appointment.city
  }

  return null
}

// =============================================================================
// 2. Civil-date helpers
// =============================================================================

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** `Date.UTC` for a civil date — the canonical key for "which day is this". */
function civilKeyMs(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day)
}

function civilKey(date: CivilDate): string {
  return `${String(date.year)}-${pad2(date.month)}-${pad2(date.day)}`
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(civilKeyMs(date) + days * MS_PER_DAY)

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * The civil date a zone is showing at an instant.
 *
 * Shifting the instant by the engine's offset and reading the UTC components is
 * exact: `timeZoneOffsetMs` is defined as the difference between the wall clock
 * and the instant, so the shifted value's UTC fields *are* the wall clock.
 */
function civilDateIn(timeZone: string, instant: Date): CivilDate {
  const shifted = new Date(
    instant.getTime() + timeZoneOffsetMs(timeZone, instant)
  )

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/** 0 = Sunday … 6 = Saturday, for a civil date. */
function civilDayOfWeek(date: CivilDate): number {
  return new Date(civilKeyMs(date)).getUTCDay()
}

// =============================================================================
// 3. The day column model
// =============================================================================

interface DayColumn {
  readonly key: string
  readonly civil: CivilDate
  /** The instant local midnight begins. */
  readonly start: Date
  /** The instant the next local midnight begins. */
  readonly end: Date
  readonly keyMs: number
  readonly dayOfWeek: number
  readonly isToday: boolean
  readonly isOutsideMonth: boolean
  /** True when the zone's offset is not constant across this civil day. */
  readonly hasOffsetShift: boolean
  /** Signed minutes the day gained (+60) or lost (−60), 0 on an ordinary day. */
  readonly offsetShiftMinutes: number
}

function buildDayColumn(
  timeZone: string,
  civil: CivilDate,
  todayKeyMs: number,
  focusMonth: number | null
): DayColumn {
  const start = resolveWallClock(civil, 0, timeZone).instant
  const end = resolveWallClock(civil, MINUTES_PER_DAY, timeZone).instant

  const offsetAtStart = timeZoneOffsetMs(timeZone, start)
  const offsetAtEnd = timeZoneOffsetMs(timeZone, new Date(end.getTime() - 1))

  return {
    key: civilKey(civil),
    civil,
    start,
    end,
    keyMs: civilKeyMs(civil),
    dayOfWeek: civilDayOfWeek(civil),
    isToday: civilKeyMs(civil) === todayKeyMs,
    isOutsideMonth: focusMonth !== null && civil.month !== focusMonth,
    hasOffsetShift: offsetAtStart !== offsetAtEnd,
    offsetShiftMinutes: (offsetAtEnd - offsetAtStart) / MS_PER_MINUTE,
  }
}

/**
 * Where an instant sits on a column's wall-clock ruler, in minutes from local
 * midnight. Negative before the day, above 1440 after it.
 */
function minuteOnColumn(
  timeZone: string,
  column: DayColumn,
  instant: Date
): number {
  const shifted = instant.getTime() + timeZoneOffsetMs(timeZone, instant)

  return (shifted - column.keyMs) / MS_PER_MINUTE
}

/**
 * The instant a column's ruler minute denotes.
 *
 * On an ordinary day the offset is constant, so plain arithmetic from local
 * midnight is exact and free. On a transition day it is not, and the engine's
 * `resolveWallClock` — which knows what to do with an hour that did not happen
 * — is the only correct answer.
 */
function instantOnColumn(
  timeZone: string,
  column: DayColumn,
  minute: number
): Date {
  if (!column.hasOffsetShift) {
    return new Date(column.start.getTime() + minute * MS_PER_MINUTE)
  }

  return resolveWallClock(column.civil, minute, timeZone).instant
}

// =============================================================================
// 4. Zoned formatting
// =============================================================================

interface ZoneFormatters {
  readonly time: Intl.DateTimeFormat
  readonly weekdayShort: Intl.DateTimeFormat
  readonly weekdayLong: Intl.DateTimeFormat
  readonly dayNumber: Intl.DateTimeFormat
  readonly dateMedium: Intl.DateTimeFormat
  readonly dateLong: Intl.DateTimeFormat
  readonly monthYear: Intl.DateTimeFormat
  readonly zoneName: Intl.DateTimeFormat
}

function buildFormatters(timeZone: string): ZoneFormatters {
  const base = { timeZone } as const

  return {
    // `h23` so the ruler reads 09:00 and 21:00 — a dispatch board is not the
    // place to make someone parse "9 p.m." against "9 a.m.".
    time: new Intl.DateTimeFormat('en-CA', {
      ...base,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
    weekdayShort: new Intl.DateTimeFormat('en-CA', {
      ...base,
      weekday: 'short',
    }),
    weekdayLong: new Intl.DateTimeFormat('en-CA', { ...base, weekday: 'long' }),
    dayNumber: new Intl.DateTimeFormat('en-CA', { ...base, day: 'numeric' }),
    dateMedium: new Intl.DateTimeFormat('en-CA', {
      ...base,
      month: 'short',
      day: 'numeric',
    }),
    dateLong: new Intl.DateTimeFormat('en-CA', {
      ...base,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
    monthYear: new Intl.DateTimeFormat('en-CA', {
      ...base,
      month: 'long',
      year: 'numeric',
    }),
    zoneName: new Intl.DateTimeFormat('en-CA', {
      ...base,
      timeZoneName: 'shortOffset',
    }),
  }
}

/** `UTC−05:00` for the zone at an instant, without the date beside it. */
function offsetLabel(formatters: ZoneFormatters, instant: Date): string {
  const part = formatters.zoneName
    .formatToParts(instant)
    .find((candidate) => candidate.type === 'timeZoneName')

  return part === undefined ? '' : part.value
}

/** `09:00` for a ruler minute, from arithmetic rather than a formatter. */
function rulerLabel(minute: number): string {
  const normalised =
    ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY

  return `${pad2(Math.floor(normalised / 60))}:${pad2(normalised % 60)}`
}

// =============================================================================
// 5. Bands — the four stretches a booking occupies
// =============================================================================

type BandKind = 'travelBefore' | 'prep' | 'service' | 'travelAfter'

interface Band {
  readonly kind: BandKind
  readonly startMinute: number
  readonly endMinute: number
}

const BAND_LABELS: Readonly<Record<BandKind, string>> = {
  travelBefore: 'Travel out',
  prep: 'Prep',
  service: 'Service',
  travelAfter: 'Travel home',
}

/**
 * The visual grammar of a band, on three independent channels.
 *
 * Hue alone would fail a dispatcher with a colour vision deficiency, and this
 * is the one distinction the view exists to make. So each band also differs in
 * **texture** (solid / coarse 45° hatch / fine −45° hatch), in **opacity**, and
 * in **border style** (solid / dashed / dotted). Any one of the three is enough
 * to tell the bands apart; the hue is a convenience for everyone else.
 *
 * Textures are inline `repeating-linear-gradient`s because there is no Tailwind
 * utility for them. They still reference only design tokens — never a literal
 * colour — per CONTRACT.md §3.
 */
function bandStyle(kind: BandKind): React.CSSProperties {
  switch (kind) {
    case 'service':
      // Solid, opaque, the only band with weight. This is the engagement.
      return {
        backgroundColor:
          'color-mix(in oklab, var(--color-slate-warm) 92%, var(--color-champagne))',
        borderLeft: '2px solid var(--color-champagne)',
      }
    case 'prep':
      // Fine hatch leaning the other way, warm — the kitchen is already busy.
      return {
        backgroundColor:
          'color-mix(in oklab, var(--color-charcoal) 88%, transparent)',
        backgroundImage:
          'repeating-linear-gradient(-45deg, color-mix(in oklab, var(--color-terracotta) 42%, transparent) 0 2px, transparent 2px 6px)',
        borderLeft:
          '2px dotted color-mix(in oklab, var(--color-terracotta) 75%, transparent)',
      }
    case 'travelBefore':
    case 'travelAfter':
    default:
      // Coarse 45° hatch, cool and quiet — the chef is in transit, not cooking.
      return {
        backgroundColor:
          'color-mix(in oklab, var(--color-charcoal) 70%, transparent)',
        backgroundImage:
          'repeating-linear-gradient(45deg, color-mix(in oklab, var(--color-stone) 34%, transparent) 0 1px, transparent 1px 7px)',
        borderLeft:
          '2px dashed color-mix(in oklab, var(--color-stone) 60%, transparent)',
      }
  }
}

/**
 * The band boundaries, taken verbatim from `occupiedInterval`.
 *
 * Empty stretches are dropped so a booking with no prep and no travel renders
 * as one clean service band rather than three zero-height slivers.
 */
function bandsFor(
  timeZone: string,
  column: DayColumn,
  appointment: CalendarAppointment,
  occupied: OccupiedInterval
): readonly Band[] {
  const at = (instant: Date): number =>
    minuteOnColumn(timeZone, column, instant)

  const outerStart = at(occupied.start)
  const coreStart = at(occupied.coreStart)
  const serviceStart = at(appointment.startsAt)
  const serviceEnd = at(occupied.coreEnd)
  const outerEnd = at(occupied.end)

  const candidates: readonly Band[] = [
    { kind: 'travelBefore', startMinute: outerStart, endMinute: coreStart },
    // `coreStart` is `min(prepStartsAt, startsAt)`. When there is no prep row
    // the two coincide and this band collapses to nothing, which is correct.
    {
      kind: 'prep',
      startMinute: coreStart,
      endMinute: Math.max(coreStart, serviceStart),
    },
    {
      kind: 'service',
      startMinute: Math.max(coreStart, serviceStart),
      endMinute: serviceEnd,
    },
    { kind: 'travelAfter', startMinute: serviceEnd, endMinute: outerEnd },
  ]

  return candidates.filter((band) => band.endMinute > band.startMinute)
}

// =============================================================================
// 6. Lane packing — so nothing is ever hidden behind anything
// =============================================================================

interface LaneItem {
  readonly startMinute: number
  readonly endMinute: number
}

/**
 * Greedy interval-graph colouring: the classic calendar column layout.
 *
 * Items are grouped into clusters of transitively overlapping intervals, and
 * every cluster is given as many lanes as its widest moment needs. Two blocks
 * that overlap therefore never share a lane, and no block is ever drawn on top
 * of another.
 *
 * The intervals compared are the **buffered** ones from `occupiedInterval`, not
 * `startsAt..endsAt`: two dinners an hour apart with forty minutes of driving
 * between them do compete for the chef, and a layout that stacked them would
 * hide precisely the collision a dispatcher is looking for.
 */
function packLanes<T extends LaneItem>(
  items: readonly T[]
): ReadonlyArray<{ item: T; lane: number; laneCount: number }> {
  const sorted = [...items].sort(
    (a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute
  )

  const placed: Array<{ item: T; lane: number; laneCount: number }> = []
  let clusterStartIndex = 0
  let clusterEnd = Number.NEGATIVE_INFINITY
  let laneEnds: number[] = []

  const sealCluster = (endIndex: number): void => {
    const laneCount = Math.max(1, laneEnds.length)

    for (let index = clusterStartIndex; index < endIndex; index += 1) {
      const entry = placed[index]

      if (entry === undefined) {
        continue
      }

      placed[index] = { item: entry.item, lane: entry.lane, laneCount }
    }
  }

  sorted.forEach((item, index) => {
    if (item.startMinute >= clusterEnd) {
      sealCluster(index)
      clusterStartIndex = index
      clusterEnd = Number.NEGATIVE_INFINITY
      laneEnds = []
    }

    let lane = laneEnds.findIndex((end) => end <= item.startMinute)

    if (lane === -1) {
      lane = laneEnds.length
    }

    laneEnds[lane] = item.endMinute
    clusterEnd = Math.max(clusterEnd, item.endMinute)
    placed[index] = { item, lane, laneCount: 1 }
  })

  sealCluster(sorted.length)

  return placed
}

// =============================================================================
// 7. Status vocabulary
// =============================================================================

const STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
}

type BadgeVariant =
  | 'default'
  | 'champagne'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'muted'
  | 'outline'

const STATUS_BADGE: Readonly<Record<AppointmentStatus, BadgeVariant>> = {
  REQUESTED: 'warning',
  CONFIRMED: 'champagne',
  IN_PROGRESS: 'champagne',
  COMPLETED: 'success',
  CANCELLED: 'muted',
  NO_SHOW: 'destructive',
}

/**
 * A status stripe drawn as an edge, never as a fill.
 *
 * The block's interior belongs to the band grammar; recolouring it by status
 * would put two meanings on one channel and destroy the distinction the view
 * exists to make. Status lives on the top edge instead.
 */
const STATUS_EDGE: Readonly<Record<AppointmentStatus, string>> = {
  REQUESTED: 'before:bg-terracotta',
  CONFIRMED: 'before:bg-champagne',
  IN_PROGRESS: 'before:bg-sage',
  COMPLETED: 'before:bg-stone',
  CANCELLED: 'before:bg-ash',
  NO_SHOW: 'before:bg-claret',
}

// =============================================================================
// 8. Range derivation
// =============================================================================

function buildColumns(
  timeZone: string,
  view: CalendarView,
  anchor: Date,
  weekStartsOn: number,
  now: Date
): readonly DayColumn[] {
  const anchorCivil = civilDateIn(timeZone, anchor)
  const todayKeyMs = civilKeyMs(civilDateIn(timeZone, now))

  if (view === 'day') {
    return [buildDayColumn(timeZone, anchorCivil, todayKeyMs, null)]
  }

  if (view === 'week') {
    const offset = (civilDayOfWeek(anchorCivil) - weekStartsOn + 7) % 7
    const first = addCivilDays(anchorCivil, -offset)

    return Array.from({ length: 7 }, (_unused, index) =>
      buildDayColumn(timeZone, addCivilDays(first, index), todayKeyMs, null)
    )
  }

  // Month: whole weeks covering the anchor's month, so every row is seven days.
  const firstOfMonth: CivilDate = {
    year: anchorCivil.year,
    month: anchorCivil.month,
    day: 1,
  }
  const lead = (civilDayOfWeek(firstOfMonth) - weekStartsOn + 7) % 7
  const gridStart = addCivilDays(firstOfMonth, -lead)

  const daysInMonth = new Date(
    Date.UTC(anchorCivil.year, anchorCivil.month, 0)
  ).getUTCDate()
  const weeks = Math.ceil((lead + daysInMonth) / 7)

  return Array.from({ length: weeks * 7 }, (_unused, index) =>
    buildDayColumn(
      timeZone,
      addCivilDays(gridStart, index),
      todayKeyMs,
      anchorCivil.month
    )
  )
}

function shiftAnchor(
  timeZone: string,
  view: CalendarView,
  anchor: Date,
  direction: number
): Date {
  const civil = civilDateIn(timeZone, anchor)

  if (view === 'day') {
    return resolveWallClock(addCivilDays(civil, direction), 12 * 60, timeZone)
      .instant
  }

  if (view === 'week') {
    return resolveWallClock(
      addCivilDays(civil, direction * 7),
      12 * 60,
      timeZone
    ).instant
  }

  const month = civil.month - 1 + direction
  const year = civil.year + Math.floor(month / 12)
  const normalisedMonth = (((month % 12) + 12) % 12) + 1
  const daysInTarget = new Date(Date.UTC(year, normalisedMonth, 0)).getUTCDate()

  return resolveWallClock(
    { year, month: normalisedMonth, day: Math.min(civil.day, daysInTarget) },
    12 * 60,
    timeZone
  ).instant
}

/**
 * The vertical window, widened from the default business day to hold whatever
 * the data actually contains, snapped outward to the hour.
 *
 * Deriving it rather than always drawing midnight-to-midnight means a normal
 * week is legible without scrolling, and a 04:00 catering load-in is still on
 * screen rather than requiring a scroll a dispatcher may not think to make.
 */
function deriveWindow(
  timeZone: string,
  columns: readonly DayColumn[],
  appointments: readonly CalendarAppointment[],
  availabilityWindows: readonly AvailabilityWindow[]
): { startMinute: number; endMinute: number } {
  let start = DEFAULT_WINDOW_START_MINUTE
  let end = DEFAULT_WINDOW_END_MINUTE

  const consider = (column: DayColumn, interval: TimeInterval): void => {
    if (interval.end <= column.start || interval.start >= column.end) {
      return
    }

    start = Math.min(start, minuteOnColumn(timeZone, column, interval.start))
    end = Math.max(end, minuteOnColumn(timeZone, column, interval.end))
  }

  columns.forEach((column) => {
    appointments.forEach((appointment) => {
      consider(column, occupiedInterval(appointment))
    })
    availabilityWindows.forEach((availabilityWindow) => {
      consider(column, availabilityWindow)
    })
  })

  return {
    startMinute: Math.max(0, Math.floor(start / 60) * 60),
    endMinute: Math.min(MINUTES_PER_DAY, Math.ceil(end / 60) * 60),
  }
}

// =============================================================================
// 9. Per-column derived data
// =============================================================================

interface PositionedAppointment {
  readonly appointment: CalendarAppointment
  readonly occupied: OccupiedInterval
  readonly bands: readonly Band[]
  readonly startMinute: number
  readonly endMinute: number
  readonly lane: number
  readonly laneCount: number
}

interface ColumnData {
  readonly column: DayColumn
  readonly positioned: readonly PositionedAppointment[]
  readonly availability: readonly TimeInterval[]
  readonly blackouts: readonly CalendarBlackout[]
}

function overlaps(a: TimeInterval, b: TimeInterval): boolean {
  return a.start < b.end && b.start < a.end
}

function buildColumnData(
  timeZone: string,
  columns: readonly DayColumn[],
  appointments: readonly CalendarAppointment[],
  availabilityWindows: readonly AvailabilityWindow[],
  blackouts: readonly CalendarBlackout[]
): readonly ColumnData[] {
  const occupancy = new Map<string, OccupiedInterval>()

  appointments.forEach((appointment) => {
    occupancy.set(appointment.id, occupiedInterval(appointment))
  })

  return columns.map((column) => {
    const span: TimeInterval = { start: column.start, end: column.end }

    const onDay = appointments.filter((appointment) => {
      const occupied = occupancy.get(appointment.id)

      return occupied !== undefined && overlaps(occupied, span)
    })

    const laneInputs = onDay.map((appointment) => {
      // A definite `get` immediately after the guard above, which is the only
      // exception CONTRACT.md §4 allows.
      const occupied = occupancy.get(appointment.id)

      if (occupied === undefined) {
        throw new Error('unreachable: occupancy was populated for every id')
      }

      const startMinute = minuteOnColumn(timeZone, column, occupied.start)
      const endMinute = minuteOnColumn(timeZone, column, occupied.end)

      return {
        appointment,
        occupied,
        startMinute,
        endMinute,
        bands: bandsFor(timeZone, column, appointment, occupied),
      }
    })

    const positioned = packLanes(laneInputs).map((entry) => ({
      ...entry.item,
      lane: entry.lane,
      laneCount: entry.laneCount,
    }))

    return {
      column,
      positioned,
      availability: availabilityWindows.filter((candidate) =>
        overlaps(candidate, span)
      ),
      blackouts: blackouts.filter((blackout) => overlaps(blackout, span)),
    }
  })
}

/**
 * What a transition day says on its badge.
 *
 * The sign is the trap. `offsetShiftMinutes` is the change in the zone's UTC
 * offset across the day, and a day whose offset **rises** is a day that **lost**
 * time: Toronto on 8 March 2026 goes from UTC−05:00 to UTC−04:00, a shift of
 * `+60`, and is 23 hours long, not 25. So the real length is `24 − shift`, and
 * a positive shift means the clocks went *forward*.
 *
 * Written out because the intuitive reading — "positive means more" — is
 * backwards here, and this was wrong on the first pass.
 */
function describeTransitionDay(offsetShiftMinutes: number): string {
  const realHours = 24 - offsetShiftMinutes / 60
  const direction =
    offsetShiftMinutes > 0 ? 'clocks go forward' : 'clocks go back'
  const length = Number.isInteger(realHours)
    ? String(realHours)
    : realHours.toFixed(1)

  return `${direction}, this day is ${length} hours long`
}

/**
 * Whether the runtime's ICU recognises the identifier.
 *
 * `resolveWallClock` throws a `RangeError` for an unknown zone, and a chef row
 * carrying a typo'd `calendarTimeZone` would otherwise take the whole dispatch
 * page down during render. Checking once and degrading to an explained panel is
 * the difference between a data problem and an outage.
 */
function isUsableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })

    return true
  } catch {
    return false
  }
}

// =============================================================================
// 10. Component
// =============================================================================

export function CalendarGrid({
  timeZone,
  anchorDate,
  defaultAnchorDate,
  view,
  defaultView = 'week',
  appointments,
  availabilityWindows,
  blackouts,
  weekStartsOn = 0,
  slotMinutes = 30,
  hourHeight = 64,
  now,
  onViewChange,
  onAnchorDateChange,
  onSelectAppointment,
  onSelectSlot,
  className,
}: CalendarGridProps) {
  // A zone this runtime cannot resolve would make `resolveWallClock` throw
  // mid-render. Every calculation below therefore runs against a zone that is
  // definitely resolvable, and the unusable case is reported rather than drawn.
  const zoneIsUsable = React.useMemo(
    () => isUsableTimeZone(timeZone),
    [timeZone]
  )
  const zone = zoneIsUsable ? timeZone : 'UTC'

  // "Now" is read once per mount rather than at every render, so the current
  // time indicator cannot make a render impure or a hydration disagree.
  const [mountedNow] = React.useState<Date>(() => now ?? new Date())
  const effectiveNow = now ?? mountedNow

  const [internalView, setInternalView] =
    React.useState<CalendarView>(defaultView)
  const activeView = view ?? internalView

  const [internalAnchor, setInternalAnchor] = React.useState<Date>(
    () => defaultAnchorDate ?? effectiveNow
  )
  const activeAnchor = anchorDate ?? internalAnchor

  const changeView = React.useCallback(
    (next: CalendarView) => {
      if (view === undefined) {
        setInternalView(next)
      }
      onViewChange?.(next)
    },
    [onViewChange, view]
  )

  const changeAnchor = React.useCallback(
    (next: Date) => {
      if (anchorDate === undefined) {
        setInternalAnchor(next)
      }
      onAnchorDateChange?.(next)
    },
    [anchorDate, onAnchorDateChange]
  )

  const formatters = React.useMemo(() => buildFormatters(zone), [zone])

  const columns = React.useMemo(
    () =>
      buildColumns(zone, activeView, activeAnchor, weekStartsOn, effectiveNow),
    [zone, activeView, activeAnchor, weekStartsOn, effectiveNow]
  )

  const columnData = React.useMemo(
    () =>
      buildColumnData(
        zone,
        columns,
        appointments,
        availabilityWindows,
        blackouts
      ),
    [zone, columns, appointments, availabilityWindows, blackouts]
  )

  const viewWindow = React.useMemo(
    () =>
      activeView === 'month'
        ? { startMinute: 0, endMinute: MINUTES_PER_DAY }
        : deriveWindow(zone, columns, appointments, availabilityWindows),
    [activeView, zone, columns, appointments, availabilityWindows]
  )

  const slotCount = Math.max(
    1,
    Math.ceil((viewWindow.endMinute - viewWindow.startMinute) / slotMinutes)
  )

  // ---- Roving focus -------------------------------------------------------
  //
  // One tab stop for the whole lattice, moved with the arrow keys. Appointment
  // blocks are separately tabbable in DOM order, so a keyboard user reaches
  // every engagement without having to arrow through empty grid to find it.

  const [focus, setFocus] = React.useState<{ day: number; slot: number }>({
    day: 0,
    slot: 0,
  })
  const [focusVisible, setFocusVisible] = React.useState(false)
  const gridRef = React.useRef<HTMLDivElement | null>(null)
  const pendingFocusRef = React.useRef<string | null>(null)

  // Focus is moved after the commit that rendered the destination, so an arrow
  // key that also re-ranged the grid still lands on a cell that exists.
  React.useEffect(() => {
    const target = pendingFocusRef.current

    if (target === null) {
      return
    }

    pendingFocusRef.current = null
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-cell="${target}"]`)
      ?.focus()
  })

  const clampedFocus = React.useMemo(
    () => ({
      day: Math.min(Math.max(focus.day, 0), Math.max(0, columns.length - 1)),
      slot: Math.min(Math.max(focus.slot, 0), slotCount - 1),
    }),
    [focus, columns.length, slotCount]
  )

  const moveFocus = React.useCallback((next: { day: number; slot: number }) => {
    setFocus(next)
    setFocusVisible(true)
    pendingFocusRef.current = `${String(next.day)}-${String(next.slot)}`
  }, [])

  const openAt = React.useCallback(
    (dayIndex: number, slotIndex: number) => {
      const data = columnData[dayIndex]

      if (data === undefined) {
        return
      }

      const startMinute = viewWindow.startMinute + slotIndex * slotMinutes
      const endMinute = Math.min(
        viewWindow.endMinute,
        startMinute + slotMinutes
      )
      const start = instantOnColumn(zone, data.column, startMinute)
      const end = instantOnColumn(zone, data.column, endMinute)

      const hit = data.positioned.find(
        (entry) =>
          entry.startMinute < endMinute && startMinute < entry.endMinute
      )

      if (hit !== undefined && onSelectAppointment !== undefined) {
        onSelectAppointment(hit.appointment)
        return
      }

      onSelectSlot?.({ start, end })
    },
    [
      columnData,
      onSelectAppointment,
      onSelectSlot,
      slotMinutes,
      zone,
      viewWindow,
    ]
  )

  const onGridKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      const cell = target.dataset.cell

      if (cell === undefined) {
        // The event came from an appointment block; leave its own handler to it.
        return
      }

      const { day, slot } = clampedFocus
      const lastDay = columns.length - 1

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          if (day >= lastDay) {
            changeAnchor(shiftAnchor(zone, activeView, activeAnchor, 1))
            moveFocus({ day: activeView === 'day' ? 0 : lastDay, slot })
          } else {
            moveFocus({ day: day + 1, slot })
          }
          break

        case 'ArrowLeft':
          event.preventDefault()
          if (day <= 0) {
            changeAnchor(shiftAnchor(zone, activeView, activeAnchor, -1))
            moveFocus({ day: activeView === 'day' ? 0 : 0, slot })
          } else {
            moveFocus({ day: day - 1, slot })
          }
          break

        case 'ArrowDown':
          event.preventDefault()
          moveFocus({ day, slot: Math.min(slotCount - 1, slot + 1) })
          break

        case 'ArrowUp':
          event.preventDefault()
          moveFocus({ day, slot: Math.max(0, slot - 1) })
          break

        case 'Home':
          event.preventDefault()
          moveFocus({ day, slot: 0 })
          break

        case 'End':
          event.preventDefault()
          moveFocus({ day, slot: slotCount - 1 })
          break

        case 'PageUp':
          event.preventDefault()
          changeAnchor(shiftAnchor(zone, activeView, activeAnchor, -1))
          break

        case 'PageDown':
          event.preventDefault()
          changeAnchor(shiftAnchor(zone, activeView, activeAnchor, 1))
          break

        case 'Enter':
        case ' ':
          event.preventDefault()
          openAt(day, slot)
          break

        default:
          break
      }
    },
    [
      activeAnchor,
      activeView,
      changeAnchor,
      clampedFocus,
      columns.length,
      moveFocus,
      openAt,
      slotCount,
      zone,
    ]
  )

  // ---- Header labels ------------------------------------------------------

  const rangeLabel = React.useMemo(() => {
    const first = columns[0]
    const last = columns[columns.length - 1]

    if (first === undefined || last === undefined) {
      return ''
    }

    if (activeView === 'day') {
      return formatters.dateLong.format(first.start)
    }

    if (activeView === 'month') {
      return formatters.monthYear.format(
        resolveWallClock(civilDateIn(zone, activeAnchor), 12 * 60, zone).instant
      )
    }

    return `${formatters.dateMedium.format(first.start)} – ${formatters.dateMedium.format(last.start)}`
  }, [activeAnchor, activeView, columns, formatters, zone])

  const anchorOffset = React.useMemo(() => {
    const first = columns[0]

    return first === undefined ? '' : offsetLabel(formatters, first.start)
  }, [columns, formatters])

  const viewerZone = React.useMemo(() => {
    try {
      return new Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return ''
    }
  }, [])

  const transitionDays = React.useMemo(
    () => columns.filter((column) => column.hasOffsetShift),
    [columns]
  )

  const hasAnything =
    appointments.length > 0 ||
    availabilityWindows.length > 0 ||
    blackouts.length > 0

  const minuteToPx = hourHeight / 60
  const bodyHeight =
    (viewWindow.endMinute - viewWindow.startMinute) * minuteToPx

  const hourLines = React.useMemo(() => {
    const lines: number[] = []
    const firstHour = Math.ceil(viewWindow.startMinute / 60) * 60

    for (let minute = firstHour; minute <= viewWindow.endMinute; minute += 60) {
      lines.push(minute)
    }

    return lines
  }, [viewWindow])

  // =========================================================================
  // Render
  // =========================================================================

  if (!zoneIsUsable) {
    return (
      <section
        aria-label="Dispatch calendar unavailable"
        className={cn(
          'rounded-lg border border-claret/40 bg-charcoal p-6',
          className
        )}
      >
        <EmptyState
          description={`This chef's calendar time zone is recorded as "${timeZone}", which this browser cannot resolve to a real zone. Nothing is drawn rather than drawn in the wrong clock. Correct the calendar time zone on the staff profile.`}
          icon={CircleAlert}
          title="Unrecognised calendar time zone"
          tone="error"
        />
      </section>
    )
  }

  return (
    <TooltipProvider>
      <section
        aria-label={`Dispatch calendar, ${rangeLabel}, times shown in ${zone}`}
        className={cn(
          'flex flex-col rounded-lg border border-ash bg-charcoal',
          className
        )}
      >
        <CalendarHeader
          activeView={activeView}
          anchorOffset={anchorOffset}
          onGoToToday={() => {
            changeAnchor(effectiveNow)
          }}
          onStep={(direction) => {
            changeAnchor(shiftAnchor(zone, activeView, activeAnchor, direction))
          }}
          onViewChange={changeView}
          rangeLabel={rangeLabel}
          timeZone={zone}
          viewerZone={viewerZone}
        />

        <Separator variant="hairline" />

        {transitionDays.length > 0 ? (
          <ul className="flex flex-wrap gap-2 border-b border-ash/70 px-4 py-2">
            {transitionDays.map((column) => (
              <li key={column.key}>
                <Badge variant="warning">
                  <CircleAlert aria-hidden="true" />
                  {formatters.dateMedium.format(column.start)} —{' '}
                  {describeTransitionDay(column.offsetShiftMinutes)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {!hasAnything ? (
          <div className="p-6">
            <EmptyState
              icon={CalendarClock}
              title="Nothing scheduled in this range"
              description={`No engagements, availability or blackouts fall between these dates. All times are read in ${zone}.`}
            />
          </div>
        ) : activeView === 'month' ? (
          <MonthGrid
            columnData={columnData}
            formatters={formatters}
            onSelectAppointment={onSelectAppointment}
            onSelectSlot={onSelectSlot}
            timeZone={zone}
            weekStartsOn={weekStartsOn}
          />
        ) : (
          <TimeGrid
            bodyHeight={bodyHeight}
            clampedFocus={clampedFocus}
            columnData={columnData}
            focusVisible={focusVisible}
            formatters={formatters}
            gridRef={gridRef}
            hourLines={hourLines}
            minuteToPx={minuteToPx}
            now={effectiveNow}
            onGridKeyDown={onGridKeyDown}
            onSelectAppointment={onSelectAppointment}
            openAt={openAt}
            setFocus={setFocus}
            slotCount={slotCount}
            slotMinutes={slotMinutes}
            timeZone={zone}
            viewWindow={viewWindow}
          />
        )}

        <Separator variant="hairline" />
        <BandLegend />
      </section>
    </TooltipProvider>
  )
}

// =============================================================================
// 11. Header
// =============================================================================

interface CalendarHeaderProps {
  activeView: CalendarView
  anchorOffset: string
  onGoToToday: () => void
  onStep: (direction: number) => void
  onViewChange: (view: CalendarView) => void
  rangeLabel: string
  timeZone: string
  viewerZone: string
}

function CalendarHeader({
  activeView,
  anchorOffset,
  onGoToToday,
  onStep,
  onViewChange,
  rangeLabel,
  timeZone,
  viewerZone,
}: CalendarHeaderProps) {
  const stepNoun =
    activeView === 'day' ? 'day' : activeView === 'week' ? 'week' : 'month'

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
      <div className="flex items-center gap-2">
        <Button
          aria-label={`Previous ${stepNoun}`}
          onClick={() => {
            onStep(-1)
          }}
          size="icon"
          variant="ghost"
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          aria-label={`Next ${stepNoun}`}
          onClick={() => {
            onStep(1)
          }}
          size="icon"
          variant="ghost"
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button onClick={onGoToToday} size="sm" variant="outline">
          Today
        </Button>

        <div className="ml-2 min-w-0">
          {/* The one champagne element in this group is the range title. */}
          <h2 className="truncate font-display text-xl leading-tight text-champagne">
            {rangeLabel}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-stone">
            <Clock3 aria-hidden="true" className="size-3" />
            <span className="tabular-nums">
              All times in {timeZone}
              {anchorOffset === '' ? '' : ` (${anchorOffset})`}
            </span>
            {viewerZone !== '' && viewerZone !== timeZone ? (
              <Hint
                label={`Your device is in ${viewerZone}. This board is deliberately drawn in the chef's calendar zone, ${timeZone}, because that is the clock they have to be at a door by.`}
              >
                <button
                  className={cn(
                    'rounded-sm text-stone hover:text-parchment',
                    FOCUS_RING
                  )}
                  type="button"
                >
                  <Info aria-hidden="true" className="size-3" />
                  <span className="sr-only">
                    Why these times differ from your device clock
                  </span>
                </button>
              </Hint>
            ) : null}
          </p>
        </div>
      </div>

      <Tabs
        onValueChange={(value) => {
          onViewChange(value as CalendarView)
        }}
        value={activeView}
      >
        <TabsList aria-label="Calendar range">
          <TabsTrigger value="day">Day</TabsTrigger>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="month">Month</TabsTrigger>
        </TabsList>
      </Tabs>
    </header>
  )
}

// =============================================================================
// 12. Legend
// =============================================================================

const LEGEND_ORDER: readonly BandKind[] = [
  'travelBefore',
  'prep',
  'service',
  'travelAfter',
]

const LEGEND_DESCRIPTIONS: Readonly<Record<BandKind, string>> = {
  travelBefore: 'Coarse diagonal hatch, dashed edge — the drive out.',
  prep: 'Fine reverse hatch, dotted edge — shopping, mise en place, ovens.',
  service: 'Solid fill, solid edge — the engagement itself.',
  travelAfter: 'Coarse diagonal hatch, dashed edge — the drive home.',
}

function BandLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
      <span className="text-xs font-medium tracking-wide text-stone uppercase">
        Block bands
      </span>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {LEGEND_ORDER.map((kind) => (
          <li className="flex items-center gap-2" key={kind}>
            <span
              aria-hidden="true"
              className="inline-block h-4 w-8 rounded-sm border border-ash"
              style={bandStyle(kind)}
            />
            <span className="text-xs text-parchment">{BAND_LABELS[kind]}</span>
            <span className="sr-only">{LEGEND_DESCRIPTIONS[kind]}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-stone">
        Bands differ by texture and edge style as well as by colour.
      </p>
    </div>
  )
}

// =============================================================================
// 13. Day / Week
// =============================================================================

interface TimeGridProps {
  bodyHeight: number
  clampedFocus: { day: number; slot: number }
  columnData: readonly ColumnData[]
  focusVisible: boolean
  formatters: ZoneFormatters
  gridRef: React.RefObject<HTMLDivElement | null>
  hourLines: readonly number[]
  minuteToPx: number
  now: Date
  onGridKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onSelectAppointment: ((appointment: CalendarAppointment) => void) | undefined
  openAt: (dayIndex: number, slotIndex: number) => void
  setFocus: React.Dispatch<React.SetStateAction<{ day: number; slot: number }>>
  slotCount: number
  slotMinutes: number
  timeZone: string
  viewWindow: { startMinute: number; endMinute: number }
}

function TimeGrid({
  bodyHeight,
  clampedFocus,
  columnData,
  focusVisible,
  formatters,
  gridRef,
  hourLines,
  minuteToPx,
  now,
  onGridKeyDown,
  onSelectAppointment,
  openAt,
  setFocus,
  slotCount,
  slotMinutes,
  timeZone,
  viewWindow,
}: TimeGridProps) {
  const templateColumns = `4.75rem repeat(${String(columnData.length)}, minmax(0, 1fr))`

  return (
    <div className="flex flex-col">
      {/* ---- Column headers ------------------------------------------- */}
      <div
        className="grid border-b border-ash/70"
        style={{ gridTemplateColumns: templateColumns }}
      >
        <div className="flex items-end justify-end px-2 pb-2 pt-3">
          <abbr
            className="text-[0.625rem] tracking-wide text-stone uppercase no-underline"
            title={`Times are shown in ${timeZone}`}
          >
            {timeZone.split('/').pop() ?? timeZone}
          </abbr>
        </div>
        {columnData.map((data) => (
          <div
            className={cn(
              'border-l border-ash/50 px-2 pb-2 pt-3 text-center',
              data.column.isToday && 'bg-slate-warm/40'
            )}
            key={data.column.key}
          >
            <p className="text-[0.625rem] tracking-wide text-stone uppercase">
              {formatters.weekdayShort.format(data.column.start)}
            </p>
            <p
              className={cn(
                'font-display text-lg leading-tight tabular-nums',
                data.column.isToday ? 'text-champagne' : 'text-linen'
              )}
            >
              <time dateTime={data.column.key}>
                {formatters.dayNumber.format(data.column.start)}
              </time>
            </p>
            {data.column.hasOffsetShift ? (
              <p className="mt-0.5 text-[0.625rem] text-terracotta">
                clock change
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {/* ---- Body ------------------------------------------------------- */}
      <ScrollArea viewportClassName="max-h-[68vh]">
        <div
          className="grid"
          onKeyDown={onGridKeyDown}
          ref={gridRef}
          style={{ gridTemplateColumns: templateColumns }}
        >
          {/* Hour gutter */}
          <div
            className="relative"
            style={{ height: `${String(bodyHeight)}px` }}
          >
            {hourLines.map((minute) => (
              <span
                className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-stone"
                key={minute}
                style={{
                  top: `${String((minute - viewWindow.startMinute) * minuteToPx)}px`,
                }}
              >
                {rulerLabel(minute)}
              </span>
            ))}
          </div>

          {columnData.map((data, dayIndex) => (
            <DayColumnBody
              clampedFocus={clampedFocus}
              data={data}
              dayIndex={dayIndex}
              focusVisible={focusVisible}
              formatters={formatters}
              height={bodyHeight}
              hourLines={hourLines}
              key={data.column.key}
              minuteToPx={minuteToPx}
              now={now}
              onSelectAppointment={onSelectAppointment}
              openAt={openAt}
              setFocus={setFocus}
              slotCount={slotCount}
              slotMinutes={slotMinutes}
              timeZone={timeZone}
              viewWindow={viewWindow}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

interface DayColumnBodyProps {
  clampedFocus: { day: number; slot: number }
  data: ColumnData
  dayIndex: number
  focusVisible: boolean
  formatters: ZoneFormatters
  height: number
  hourLines: readonly number[]
  minuteToPx: number
  now: Date
  onSelectAppointment: ((appointment: CalendarAppointment) => void) | undefined
  openAt: (dayIndex: number, slotIndex: number) => void
  setFocus: React.Dispatch<React.SetStateAction<{ day: number; slot: number }>>
  slotCount: number
  slotMinutes: number
  timeZone: string
  viewWindow: { startMinute: number; endMinute: number }
}

function DayColumnBody({
  clampedFocus,
  data,
  dayIndex,
  focusVisible,
  formatters,
  height,
  hourLines,
  minuteToPx,
  now,
  onSelectAppointment,
  openAt,
  setFocus,
  slotCount,
  slotMinutes,
  timeZone,
  viewWindow,
}: DayColumnBodyProps) {
  const { column } = data
  const dayLabel = formatters.dateLong.format(column.start)

  const top = (minute: number): number =>
    (Math.max(viewWindow.startMinute, minute) - viewWindow.startMinute) *
    minuteToPx

  const heightOf = (startMinute: number, endMinute: number): number =>
    (Math.min(viewWindow.endMinute, endMinute) -
      Math.max(viewWindow.startMinute, startMinute)) *
    minuteToPx

  const nowMinute = minuteOnColumn(timeZone, column, now)
  const showNowLine =
    nowMinute >= viewWindow.startMinute && nowMinute <= viewWindow.endMinute

  return (
    <div
      className={cn(
        'relative border-l border-ash/50',
        // Outside any availability window the ground is darker: a dispatcher
        // should see at a glance where the chef is simply not working.
        'bg-obsidian/60',
        column.isToday && 'bg-obsidian/30'
      )}
      style={{ height: `${String(height)}px` }}
    >
      {/* ---- Availability ground --------------------------------------- */}
      {data.availability.map((availabilityWindow, index) => {
        const startMinute = minuteOnColumn(
          timeZone,
          column,
          availabilityWindow.start
        )
        const endMinute = minuteOnColumn(
          timeZone,
          column,
          availabilityWindow.end
        )

        if (
          endMinute <= viewWindow.startMinute ||
          startMinute >= viewWindow.endMinute
        ) {
          return null
        }

        return (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bg-charcoal"
            key={`availability-${String(index)}`}
            style={{
              top: `${String(top(startMinute))}px`,
              height: `${String(heightOf(startMinute, endMinute))}px`,
            }}
          />
        )
      })}

      {/* ---- Blackouts -------------------------------------------------- */}
      {data.blackouts.map((blackout) => {
        const startMinute = minuteOnColumn(timeZone, column, blackout.start)
        const endMinute = minuteOnColumn(timeZone, column, blackout.end)

        if (
          endMinute <= viewWindow.startMinute ||
          startMinute >= viewWindow.endMinute
        ) {
          return null
        }

        return (
          <Hint
            key={blackout.id}
            label={`${blackout.label ?? 'Blackout'} — ${formatters.time.format(
              blackout.start
            )} to ${formatters.time.format(blackout.end)} ${timeZone}`}
          >
            <div
              className={cn(
                'absolute inset-x-0 border-y border-claret/40',
                FOCUS_RING
              )}
              role="note"
              style={{
                top: `${String(top(startMinute))}px`,
                height: `${String(heightOf(startMinute, endMinute))}px`,
                backgroundImage:
                  'repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-claret) 45%, transparent) 0 3px, transparent 3px 9px)',
              }}
              tabIndex={0}
            >
              <span className="sr-only">
                {blackout.label ?? 'Blackout'} on {dayLabel}, unavailable.
              </span>
            </div>
          </Hint>
        )
      })}

      {/* ---- Hour rules -------------------------------------------------- */}
      {hourLines.map((minute) => (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 border-t border-ash/45"
          key={minute}
          style={{ top: `${String(top(minute))}px` }}
        />
      ))}

      {/* ---- Slot lattice ------------------------------------------------ */}
      {Array.from({ length: slotCount }, (_unused, slotIndex) => {
        const startMinute = viewWindow.startMinute + slotIndex * slotMinutes
        const endMinute = Math.min(
          viewWindow.endMinute,
          startMinute + slotMinutes
        )
        const slotStart = instantOnColumn(timeZone, column, startMinute)
        const slotEnd = instantOnColumn(timeZone, column, endMinute)

        const isAvailable = data.availability.some(
          (candidate) =>
            candidate.start <= slotStart && slotEnd <= candidate.end
        )
        const isBlackedOut = data.blackouts.some((candidate) =>
          overlaps(candidate, { start: slotStart, end: slotEnd })
        )
        const hits = data.positioned.filter(
          (entry) =>
            entry.startMinute < endMinute && startMinute < entry.endMinute
        )

        const state = isBlackedOut
          ? 'Blacked out'
          : isAvailable
            ? 'Available'
            : 'Outside availability'

        const firstHit = hits[0]
        const engagements =
          firstHit === undefined
            ? 'no engagements'
            : hits.length === 1
              ? `1 engagement: ${firstHit.appointment.title}`
              : `${String(hits.length)} overlapping engagements`

        const isFocused =
          clampedFocus.day === dayIndex && clampedFocus.slot === slotIndex

        return (
          <button
            aria-label={`${dayLabel}, ${rulerLabel(startMinute)} to ${rulerLabel(
              endMinute
            )} ${timeZone}. ${state}, ${engagements}.`}
            className={cn(
              'absolute inset-x-0 block w-full cursor-pointer border-0 bg-transparent p-0',
              'hover:bg-champagne/5',
              'focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-champagne/40',
              'focus-visible:outline-none',
              isFocused && focusVisible && 'z-30'
            )}
            data-cell={`${String(dayIndex)}-${String(slotIndex)}`}
            key={slotIndex}
            onClick={() => {
              setFocus({ day: dayIndex, slot: slotIndex })
              openAt(dayIndex, slotIndex)
            }}
            onFocus={() => {
              setFocus({ day: dayIndex, slot: slotIndex })
            }}
            style={{
              top: `${String(top(startMinute))}px`,
              height: `${String(heightOf(startMinute, endMinute))}px`,
            }}
            tabIndex={isFocused ? 0 : -1}
            type="button"
          />
        )
      })}

      {/* ---- Now line ---------------------------------------------------- */}
      {showNowLine ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-20 border-t border-champagne/70"
          style={{ top: `${String(top(nowMinute))}px` }}
        >
          <span className="absolute left-0 top-0 size-1.5 -translate-y-1/2 rounded-full bg-champagne" />
        </div>
      ) : null}

      {/* ---- Appointment blocks ----------------------------------------- */}
      <ul
        aria-label={`Engagements on ${dayLabel}`}
        className="pointer-events-none absolute inset-0 z-10 m-0 list-none p-0"
      >
        {data.positioned.map((entry) => (
          <AppointmentBlock
            entry={entry}
            formatters={formatters}
            key={entry.appointment.id}
            minuteToPx={minuteToPx}
            onSelect={onSelectAppointment}
            timeZone={timeZone}
            viewWindow={viewWindow}
          />
        ))}
      </ul>
    </div>
  )
}

// =============================================================================
// 14. One appointment block
// =============================================================================

interface AppointmentBlockProps {
  entry: PositionedAppointment
  formatters: ZoneFormatters
  minuteToPx: number
  onSelect: ((appointment: CalendarAppointment) => void) | undefined
  timeZone: string
  viewWindow: { startMinute: number; endMinute: number }
}

function AppointmentBlock({
  entry,
  formatters,
  minuteToPx,
  onSelect,
  timeZone,
  viewWindow,
}: AppointmentBlockProps) {
  const { appointment, bands, laneCount, lane, occupied } = entry

  const visibleStart = Math.max(viewWindow.startMinute, entry.startMinute)
  const visibleEnd = Math.min(viewWindow.endMinute, entry.endMinute)

  if (visibleEnd <= visibleStart) {
    return null
  }

  const clippedTop = entry.startMinute < viewWindow.startMinute
  const clippedBottom = entry.endMinute > viewWindow.endMinute

  const laneWidth = 100 / laneCount
  const blockHeight = (visibleEnd - visibleStart) * minuteToPx
  const detailed = blockHeight >= MIN_DETAILED_BLOCK_PX

  const serviceMinutes = Math.round(
    (appointment.endsAt.getTime() - appointment.startsAt.getTime()) /
      MS_PER_MINUTE
  )
  const totalMinutes = Math.round(
    (occupied.end.getTime() - occupied.start.getTime()) / MS_PER_MINUTE
  )

  const bandSentence = bands
    .map((band) => {
      const minutes = Math.round(band.endMinute - band.startMinute)

      return `${BAND_LABELS[band.kind]} ${String(minutes)} minutes`
    })
    .join(', ')

  const description = [
    appointment.title,
    appointment.clientName ?? null,
    `${STATUS_LABELS[appointment.status]}.`,
    `Service ${formatters.time.format(appointment.startsAt)} to ${formatters.time.format(
      appointment.endsAt
    )} ${timeZone}.`,
    `Chef committed ${formatters.time.format(occupied.start)} to ${formatters.time.format(
      occupied.end
    )}, ${String(totalMinutes)} minutes in total.`,
    `${bandSentence}.`,
    appointment.locationLabel === null ||
    appointment.locationLabel === undefined
      ? null
      : `At ${appointment.locationLabel}.`,
    appointment.guestCount === null || appointment.guestCount === undefined
      ? null
      : `${String(appointment.guestCount)} guests.`,
    laneCount > 1 ? 'Overlaps another engagement.' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ')

  return (
    <li
      className="pointer-events-none absolute"
      style={{
        top: `${String((visibleStart - viewWindow.startMinute) * minuteToPx)}px`,
        height: `${String(blockHeight)}px`,
        left: `calc(${String(lane * laneWidth)}% + 2px)`,
        width: `calc(${String(laneWidth)}% - 4px)`,
      }}
    >
      <button
        aria-label={description}
        className={cn(
          'pointer-events-auto relative flex size-full flex-col overflow-hidden',
          'rounded-sm border border-ash/90 bg-transparent p-0 text-left',
          'transition-[border-color] duration-200 ease-luxe',
          'hover:border-champagne/50',
          // The status stripe: an edge, not a fill, so it cannot be confused
          // with the band textures inside.
          'before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5 before:content-[""]',
          STATUS_EDGE[appointment.status],
          appointment.status === 'CANCELLED' && 'opacity-55',
          FOCUS_RING
        )}
        onClick={() => {
          onSelect?.(appointment)
        }}
        type="button"
      >
        {/* ---- The four bands ------------------------------------------ */}
        {bands.map((band) => {
          const bandStart = Math.max(visibleStart, band.startMinute)
          const bandEnd = Math.min(visibleEnd, band.endMinute)

          if (bandEnd <= bandStart) {
            return null
          }

          const bandPx = (bandEnd - bandStart) * minuteToPx

          return (
            <div
              aria-hidden="true"
              className="absolute inset-x-0 overflow-hidden"
              key={band.kind}
              style={{
                ...bandStyle(band.kind),
                top: `${String((bandStart - visibleStart) * minuteToPx)}px`,
                height: `${String(bandPx)}px`,
              }}
            >
              {band.kind !== 'service' && bandPx >= MIN_LABELLED_BAND_PX ? (
                <span className="block px-1.5 py-0.5 text-[0.625rem] leading-none tracking-wide text-stone uppercase">
                  {BAND_LABELS[band.kind]}
                </span>
              ) : null}
            </div>
          )
        })}

        {/* ---- Service label, over the service band --------------------- */}
        {bands.map((band) => {
          if (band.kind !== 'service') {
            return null
          }

          const bandStart = Math.max(visibleStart, band.startMinute)
          const bandEnd = Math.min(visibleEnd, band.endMinute)

          if (bandEnd <= bandStart) {
            return null
          }

          return (
            <div
              aria-hidden="true"
              className="absolute inset-x-0 z-[1] overflow-hidden px-2 py-1"
              key="service-label"
              style={{
                top: `${String((bandStart - visibleStart) * minuteToPx)}px`,
                height: `${String((bandEnd - bandStart) * minuteToPx)}px`,
              }}
            >
              <p className="truncate font-display text-sm leading-snug text-linen">
                {appointment.title}
              </p>
              {detailed ? (
                <>
                  <p className="truncate text-[0.6875rem] tabular-nums text-parchment">
                    {clippedTop ? '↑ ' : ''}
                    {formatters.time.format(appointment.startsAt)}–
                    {formatters.time.format(appointment.endsAt)}
                    {clippedBottom ? ' ↓' : ''}
                    <span className="text-stone">
                      {' '}
                      · {String(serviceMinutes)} min
                    </span>
                  </p>
                  {appointment.clientName === null ||
                  appointment.clientName === undefined ? null : (
                    <p className="truncate text-[0.6875rem] text-stone">
                      {appointment.clientName}
                    </p>
                  )}
                  <p className="mt-0.5 flex items-center gap-2 text-[0.625rem] text-stone">
                    {appointment.locationLabel === null ||
                    appointment.locationLabel === undefined ? null : (
                      <span className="flex min-w-0 items-center gap-1">
                        <MapPin
                          aria-hidden="true"
                          className="size-2.5 shrink-0"
                        />
                        <span className="truncate">
                          {appointment.locationLabel}
                        </span>
                      </span>
                    )}
                    {appointment.guestCount === null ||
                    appointment.guestCount === undefined ? null : (
                      <span className="flex items-center gap-1 tabular-nums">
                        <Users
                          aria-hidden="true"
                          className="size-2.5 shrink-0"
                        />
                        {appointment.guestCount}
                      </span>
                    )}
                  </p>
                </>
              ) : null}
            </div>
          )
        })}
      </button>
    </li>
  )
}

// =============================================================================
// 15. Month
// =============================================================================

interface MonthGridProps {
  columnData: readonly ColumnData[]
  formatters: ZoneFormatters
  onSelectAppointment: ((appointment: CalendarAppointment) => void) | undefined
  onSelectSlot: ((selection: CalendarSlotSelection) => void) | undefined
  timeZone: string
  weekStartsOn: number
}

function MonthGrid({
  columnData,
  formatters,
  onSelectAppointment,
  onSelectSlot,
  timeZone,
  weekStartsOn,
}: MonthGridProps) {
  const [focusedDay, setFocusedDay] = React.useState(0)
  const gridRef = React.useRef<HTMLDivElement | null>(null)

  const weekdayNames = React.useMemo(
    () =>
      Array.from({ length: 7 }, (_unused, index) => {
        // 2024-01-07 was a Sunday, so it seeds a weekday-name cycle without
        // depending on today's date.
        const seed = new Date(
          Date.UTC(2024, 0, 7 + ((weekStartsOn + index) % 7))
        )

        return new Intl.DateTimeFormat('en-CA', {
          weekday: 'short',
          timeZone: 'UTC',
        }).format(seed)
      }),
    [weekStartsOn]
  )

  const moveTo = React.useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(index, 0), columnData.length - 1)

      setFocusedDay(clamped)
      queueMicrotask(() => {
        gridRef.current
          ?.querySelector<HTMLElement>(`[data-day="${String(clamped)}"]`)
          ?.focus()
      })
    },
    [columnData.length]
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

    if (target.dataset.day === undefined) {
      return
    }

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        moveTo(focusedDay + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveTo(focusedDay - 1)
        break
      case 'ArrowDown':
        event.preventDefault()
        moveTo(focusedDay + 7)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveTo(focusedDay - 7)
        break
      case 'Home':
        event.preventDefault()
        moveTo(focusedDay - (focusedDay % 7))
        break
      case 'End':
        event.preventDefault()
        moveTo(focusedDay - (focusedDay % 7) + 6)
        break
      default:
        break
    }
  }

  const clampedFocusedDay = Math.min(
    Math.max(focusedDay, 0),
    Math.max(0, columnData.length - 1)
  )

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-7 border-b border-ash/70">
        {weekdayNames.map((name) => (
          <div
            className="px-2 py-2 text-center text-[0.625rem] tracking-wide text-stone uppercase"
            key={name}
          >
            {name}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7" onKeyDown={onKeyDown} ref={gridRef}>
        {columnData.map((data, index) => {
          const { column } = data
          const dayLabel = formatters.dateLong.format(column.start)
          const isFocused = index === clampedFocusedDay

          return (
            <div
              className={cn(
                'flex min-h-28 flex-col gap-1 border-b border-l border-ash/45 p-1.5',
                column.isOutsideMonth ? 'bg-obsidian/50' : 'bg-charcoal',
                column.isToday && 'bg-slate-warm/50'
              )}
              key={column.key}
            >
              <button
                aria-label={`${dayLabel}. ${
                  data.positioned.length === 0
                    ? 'No engagements'
                    : `${String(data.positioned.length)} engagement${
                        data.positioned.length === 1 ? '' : 's'
                      }`
                }. ${data.blackouts.length > 0 ? 'Has a blackout. ' : ''}Times in ${timeZone}.`}
                className={cn(
                  'flex items-center justify-between rounded-sm px-1 text-left',
                  FOCUS_RING
                )}
                data-day={String(index)}
                onClick={() => {
                  setFocusedDay(index)
                  onSelectSlot?.({ start: column.start, end: column.end })
                }}
                onFocus={() => {
                  setFocusedDay(index)
                }}
                tabIndex={isFocused ? 0 : -1}
                type="button"
              >
                <time
                  className={cn(
                    'font-display text-base tabular-nums',
                    column.isToday
                      ? 'text-champagne'
                      : column.isOutsideMonth
                        ? 'text-stone'
                        : 'text-linen'
                  )}
                  dateTime={column.key}
                >
                  {formatters.dayNumber.format(column.start)}
                </time>
                {column.hasOffsetShift ? (
                  <span className="text-[0.625rem] text-terracotta">DST</span>
                ) : null}
              </button>

              {data.blackouts.length > 0 ? (
                <div
                  aria-hidden="true"
                  className="h-1 rounded-full border border-claret/40"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-claret) 45%, transparent) 0 3px, transparent 3px 9px)',
                  }}
                />
              ) : null}

              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {data.positioned.map((entry) => (
                  <MonthChip
                    entry={entry}
                    formatters={formatters}
                    key={entry.appointment.id}
                    onSelect={onSelectAppointment}
                    timeZone={timeZone}
                  />
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface MonthChipProps {
  entry: PositionedAppointment
  formatters: ZoneFormatters
  onSelect: ((appointment: CalendarAppointment) => void) | undefined
  timeZone: string
}

/**
 * The month chip carries the same four bands as a Day/Week block, laid out
 * horizontally and proportionally, so the band grammar is one grammar across
 * all three ranges rather than a Day-view-only idea.
 */
function MonthChip({ entry, formatters, onSelect, timeZone }: MonthChipProps) {
  const { appointment, bands, occupied } = entry
  const totalMinutes = Math.max(1, entry.endMinute - entry.startMinute)

  return (
    <li>
      <button
        aria-label={`${appointment.title}. ${STATUS_LABELS[appointment.status]}. Service ${formatters.time.format(
          appointment.startsAt
        )} to ${formatters.time.format(appointment.endsAt)} ${timeZone}. Chef committed from ${formatters.time.format(
          occupied.start
        )} to ${formatters.time.format(occupied.end)}.`}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-sm border border-ash/80 bg-slate-warm/70 px-1.5 py-1 text-left',
          'transition-[border-color] duration-200 ease-luxe hover:border-champagne/50',
          appointment.status === 'CANCELLED' && 'opacity-55',
          FOCUS_RING
        )}
        onClick={() => {
          onSelect?.(appointment)
        }}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex h-1.5 w-full overflow-hidden rounded-full"
        >
          {bands.map((band) => (
            <span
              key={band.kind}
              style={{
                ...bandStyle(band.kind),
                borderLeft: 'none',
                width: `${String(
                  ((band.endMinute - band.startMinute) / totalMinutes) * 100
                )}%`,
              }}
            />
          ))}
        </span>
        <span aria-hidden="true" className="flex items-baseline gap-1.5">
          <span className="text-[0.625rem] tabular-nums text-champagne">
            {formatters.time.format(appointment.startsAt)}
          </span>
          <span className="truncate text-[0.6875rem] text-linen">
            {appointment.title}
          </span>
        </span>
        <Badge
          aria-hidden="true"
          className="w-fit px-1 py-0 text-[0.5625rem]"
          variant={STATUS_BADGE[appointment.status]}
        >
          {STATUS_LABELS[appointment.status]}
        </Badge>
      </button>
    </li>
  )
}
