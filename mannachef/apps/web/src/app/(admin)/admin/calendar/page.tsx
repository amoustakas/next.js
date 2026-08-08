// mannachef/apps/web/src/app/(admin)/admin/calendar/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarClock, CalendarOff, ShieldAlert } from 'lucide-react'

import type { AppointmentView } from '@mannachef/api-contract'
import {
  appointmentFilterSchema,
  DEFAULT_TIME_ZONE,
  MINUTES_PER_DAY,
  type AppointmentFilterInput,
  type ServiceType,
} from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Separator } from '@/components/ui/separator'
import {
  CalendarGrid,
  type CalendarAppointment,
  type CalendarBlackout,
} from '@/components/admin/calendar/calendar-grid'
import {
  AvailabilityEditor,
  BookingComposer,
  type AvailabilityRuleRow,
  type AvailabilityWindowView,
} from '@/components/admin/calendar/availability-editor'
import {
  listAvailabilityRules,
  previewAvailabilityWindows,
} from '@/server/actions/availability'
import { listAppointments } from '@/server/actions/booking'
import { listStaffRoster, readMyStaffProfile } from '@/server/actions/staff'

export const metadata: Metadata = {
  title: 'Calendar',
}

// =============================================================================
// 1. The address bar is the state
// =============================================================================

/**
 * The three ways a diary is read, and the query key that selects one.
 *
 * View, focused date and chef all live in `searchParams` rather than in client
 * state, so a chef de cuisine can send "the week of the 16th, Marc's diary" as
 * a link and the person opening it sees exactly that. The same reason the Menu
 * Engine and the moderation hub keep their filters in the address bar.
 */
const VIEWS = ['day', 'week', 'month'] as const
type CalendarView = (typeof VIEWS)[number]

const VIEW_LABELS: Readonly<Record<CalendarView, string>> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
}

function isCalendarView(value: string | undefined): value is CalendarView {
  return VIEWS.includes(value as CalendarView)
}

/** The shape Next hands every server component under `app/`. */
type RawSearchParams = Record<string, string | string[] | undefined>

interface CalendarPageProps {
  readonly searchParams: Promise<RawSearchParams>
}

/** Always the first of a possibly-repeated query key. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// =============================================================================
// 2. Calendar arithmetic in the chef's zone
// =============================================================================
//
// Every boundary on this page — the start of the focused day, the Sunday a week
// opens on, the first cell of a month grid — is a *wall-clock* boundary in the
// chef's own zone, not in the reader's and not in UTC. A dispatcher in Halifax
// looking at a Toronto diary must see Toronto's midnight, or the last hour of
// every Toronto evening would appear on the following day.
//
// `Date` has no zone arithmetic, so the two primitives below are built out of
// `Intl.DateTimeFormat`, which does. Everything else is expressed in terms of
// them.

const MS_PER_DAY = 86_400_000

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** The wall-clock components of an instant, as read in `timeZone`. */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

  const read: Record<string, number> = {}

  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') {
      read[part.type] = Number.parseInt(part.value, 10)
    }
  }

  return {
    year: read.year ?? 1970,
    month: read.month ?? 1,
    day: read.day ?? 1,
    hour: read.hour ?? 0,
    minute: read.minute ?? 0,
    second: read.second ?? 0,
  }
}

/** How far `timeZone` stood from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)

  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - instant.getTime()
  )
}

/**
 * The instant at which `timeZone` reads the given wall clock.
 *
 * The offset depends on the answer, so the answer is guessed and then corrected
 * once. One correction is enough for every real zone: the guess is wrong only
 * across a transition, and a second reading taken at the corrected instant is
 * on the far side of it.
 */
function zonedWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute)
  const firstPass = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone)

  return new Date(asIfUtc - zoneOffsetMs(new Date(firstPass), timeZone))
}

/** Local midnight opening the day `instant` falls on, in `timeZone`. */
function startOfZonedDay(instant: Date, timeZone: string): Date {
  const parts = zonedParts(instant, timeZone)

  return zonedWallClockToInstant(
    parts.year,
    parts.month,
    parts.day,
    0,
    0,
    timeZone
  )
}

/** Local midnight `days` whole days after the day `instant` falls on. */
function addZonedDays(instant: Date, timeZone: string, days: number): Date {
  const parts = zonedParts(instant, timeZone)

  // `Date.UTC` normalises an out-of-range day, so "the 34th of January" becomes
  // the 3rd of February without a calendar table.
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  )

  return zonedWallClockToInstant(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
    timeZone
  )
}

/**
 * Sunday-indexed weekday of the calendar date `instant` falls on in `timeZone`.
 *
 * Sunday-indexed to match `ChefAvailability.dayOfWeek` and `dayOfWeekSchema`,
 * so a weekly rule and a week column agree on what "day 0" means.
 */
function zonedDayOfWeek(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

/** `2026-02-16` for the calendar date `instant` falls on in `timeZone`. */
function toZonedDateKey(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone)
  const month = String(parts.month).padStart(2, '0')
  const day = String(parts.day).padStart(2, '0')

  return `${String(parts.year)}-${month}-${day}`
}

interface CalendarRange {
  /** Inclusive lower bound: local midnight opening the range. */
  readonly start: Date
  /** Exclusive upper bound: local midnight closing it. */
  readonly end: Date
  /** How many whole local days the range spans. Never above 42. */
  readonly days: number
}

/**
 * The half-open span a view covers, always whole local days.
 *
 * A month is rendered as the grid a wall calendar shows — the Sunday on or
 * before the 1st, through the Saturday on or after the last — because a month
 * view whose first row starts mid-week is a month view nobody can read. Six
 * rows is the worst case, so the widest range this returns is 42 days, well
 * inside the 400-day ceiling `previewAvailabilityWindows` enforces.
 */
function rangeFor(
  view: CalendarView,
  focused: Date,
  timeZone: string
): CalendarRange {
  const dayStart = startOfZonedDay(focused, timeZone)

  if (view === 'day') {
    return {
      start: dayStart,
      end: addZonedDays(dayStart, timeZone, 1),
      days: 1,
    }
  }

  if (view === 'week') {
    const start = addZonedDays(
      dayStart,
      timeZone,
      -zonedDayOfWeek(dayStart, timeZone)
    )

    return { start, end: addZonedDays(start, timeZone, 7), days: 7 }
  }

  const parts = zonedParts(dayStart, timeZone)
  const firstOfMonth = zonedWallClockToInstant(
    parts.year,
    parts.month,
    1,
    0,
    0,
    timeZone
  )
  const firstOfNextMonth = zonedWallClockToInstant(
    parts.year,
    parts.month + 1,
    1,
    0,
    0,
    timeZone
  )

  const start = addZonedDays(
    firstOfMonth,
    timeZone,
    -zonedDayOfWeek(firstOfMonth, timeZone)
  )
  const lastOfMonth = addZonedDays(firstOfNextMonth, timeZone, -1)
  const end = addZonedDays(
    lastOfMonth,
    timeZone,
    7 - zonedDayOfWeek(lastOfMonth, timeZone)
  )

  return {
    start,
    end,
    days: Math.round((end.getTime() - start.getTime()) / MS_PER_DAY),
  }
}

/** How far a prev/next step moves, in whole local days, for each view. */
function stepDaysFor(view: CalendarView, range: CalendarRange): number {
  return view === 'month' ? range.days : view === 'week' ? 7 : 1
}

/** The heading over the grid: what span the reader is looking at. */
function describeRange(
  view: CalendarView,
  range: CalendarRange,
  focused: Date,
  timeZone: string
): string {
  const long = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  if (view === 'day') {
    return long.format(focused)
  }

  if (view === 'month') {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      month: 'long',
      year: 'numeric',
    }).format(focused)
  }

  const edge = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const lastDay = new Date(range.end.getTime() - MS_PER_DAY)

  return `${edge.format(range.start)} – ${edge.format(lastDay)}`
}

// =============================================================================
// 3. Feeding the grid
// =============================================================================

/** What a block on the grid is called when the engagement has no other name. */
const SERVICE_TITLES: Readonly<Record<ServiceType, string>> = {
  IN_HOME_DINNER: 'Dinner at home',
  MEAL_PREP: 'Meal preparation',
  PRIVATE_EVENT: 'Private event',
  COOKING_CLASS: 'Cooking class',
  TASTING: 'Tasting',
  CATERING: 'Catering',
  CONSULTATION: 'Consultation',
  DELIVERY_DROP_OFF: 'Delivery drop-off',
}

/**
 * An `AppointmentView` in the shape the grid — and therefore the conflict
 * engine — consumes.
 *
 * The five timing fields are passed through untouched: `CalendarAppointment`
 * extends the engine's own `AppointmentLike`, so what the grid draws as
 * occupied is computed by the same `occupiedInterval` the engine refuses
 * bookings with. There is no second idea of what an engagement occupies.
 */
function toCalendarAppointment(
  appointment: AppointmentView
): CalendarAppointment {
  const city = appointment.address?.city ?? null

  return {
    id: appointment.id,
    status: appointment.status,
    startsAt: new Date(appointment.startsAt),
    endsAt: new Date(appointment.endsAt),
    prepStartsAt:
      appointment.prepStartsAt === null
        ? null
        : new Date(appointment.prepStartsAt),
    travelBufferBeforeMinutes: appointment.travelBufferBeforeMinutes,
    travelBufferAfterMinutes: appointment.travelBufferAfterMinutes,
    title: SERVICE_TITLES[appointment.serviceType],
    clientName: appointment.staffName,
    locationLabel: city,
    guestCount: appointment.guestCount,
  }
}

/**
 * The blackout rules, expanded into the instants they cover inside the range.
 *
 * `previewAvailabilityWindows` has already *subtracted* these — what it returns
 * is the calendar with the blackouts taken out. The grid wants them back as
 * bands in their own right, because "closed for a funeral" and "never open on a
 * Monday" look identical as an absence and mean entirely different things.
 *
 * Each window is built from its rule's own zone, at whole wall-clock minutes,
 * so a blackout written as 18:00–midnight is 18:00–midnight on the Sunday the
 * clocks change as well as on every other Sunday.
 */
function expandBlackouts(
  rules: readonly AvailabilityRuleRow[],
  range: CalendarRange,
  timeZone: string
): readonly CalendarBlackout[] {
  const blackouts: CalendarBlackout[] = []
  const seen = new Set<string>()

  for (let index = 0; index < range.days; index += 1) {
    // Midday, so that reading the day's civil date in another zone cannot land
    // on the neighbouring day for any offset the world actually uses.
    const midday = new Date(
      addZonedDays(range.start, timeZone, index).getTime() + MS_PER_DAY / 2
    )

    for (const rule of rules) {
      if (!rule.isBlackout) {
        continue
      }

      const local = zonedParts(midday, rule.timeZone)

      if (rule.kind === 'RECURRING_WEEKLY') {
        const weekday = new Date(
          Date.UTC(local.year, local.month - 1, local.day)
        ).getUTCDay()

        if (rule.dayOfWeek !== weekday) {
          continue
        }
      } else {
        const on = rule.specificDate

        if (
          on === null ||
          on.getUTCFullYear() !== local.year ||
          on.getUTCMonth() + 1 !== local.month ||
          on.getUTCDate() !== local.day
        ) {
          continue
        }
      }

      const dayStart = zonedWallClockToInstant(
        local.year,
        local.month,
        local.day,
        0,
        0,
        rule.timeZone
      )

      if (
        (rule.effectiveFrom !== null &&
          dayStart.getTime() < rule.effectiveFrom.getTime()) ||
        (rule.effectiveUntil !== null &&
          dayStart.getTime() > rule.effectiveUntil.getTime())
      ) {
        continue
      }

      const start = zonedWallClockToInstant(
        local.year,
        local.month,
        local.day,
        Math.floor(rule.startMinute / 60),
        rule.startMinute % 60,
        rule.timeZone
      )

      // `1440` closes the window at midnight, which is the *next* civil day at
      // 00:00. `Date.UTC` normalises the overflowing day for us.
      const end = zonedWallClockToInstant(
        local.year,
        local.month,
        local.day + (rule.endMinute === MINUTES_PER_DAY ? 1 : 0),
        rule.endMinute === MINUTES_PER_DAY
          ? 0
          : Math.floor(rule.endMinute / 60),
        rule.endMinute === MINUTES_PER_DAY ? 0 : rule.endMinute % 60,
        rule.timeZone
      )

      if (
        end.getTime() <= range.start.getTime() ||
        start.getTime() >= range.end.getTime()
      ) {
        continue
      }

      const key = `${rule.id}:${String(start.getTime())}`

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      blackouts.push({
        id: key,
        start,
        end,
        label: rule.reason ?? rule.note ?? 'Closed',
      })
    }
  }

  return blackouts
}

// =============================================================================
// 4. Failure copy
// =============================================================================

interface FailureCopy {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
}

/**
 * A sentence per `ActionErrorCode`, so a refused read never renders as a
 * generic fault.
 *
 * `FORBIDDEN` is the one that matters most here and is deliberately not a
 * variation on "something went wrong": a `CHEF_STAFF` account reaching another
 * chef's diary is not a bug and retrying will never help. It is told whose
 * permission to ask for.
 */
function calendarFailureCopy(code: string, subject: string): FailureCopy {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: `This diary is not yours to open.`,
        description: `You are signed in, but ${subject} belongs to another chef. A chef reaches only their own calendar; an administrator reaches every one. Ask an admin to raise your access, or switch to your own diary.`,
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to open the calendar.',
        isAccessIssue: true,
      }
    case 'VALIDATION':
      return {
        title: 'That view of the calendar does not add up.',
        description:
          'Something in the address bar is not a date, a view, or a chef we recognise. Return to this week to start again.',
        isAccessIssue: false,
      }
    case 'NOT_FOUND':
      return {
        title: 'There is no chef profile on this account yet.',
        description:
          'A calendar belongs to a chef. Ask an administrator to create your chef profile, or open a colleague’s diary from the roster.',
        isAccessIssue: true,
      }
    case 'CONFLICT':
      return {
        title: 'The diary changed while this page loaded.',
        description: 'Refresh to see the calendar as it now stands.',
        isAccessIssue: false,
      }
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests, too quickly.',
        description: 'Wait a moment, then refresh the page.',
        isAccessIssue: false,
      }
    default:
      return {
        title: `We could not load ${subject}.`,
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

function CalendarFailure({
  code,
  message,
  subject,
  retryHref,
}: {
  readonly code: string
  readonly message: string
  readonly subject: string
  readonly retryHref: string
}): React.JSX.Element {
  const copy = calendarFailureCopy(code, subject)

  return (
    <EmptyState
      tone="error"
      icon={copy.isAccessIssue ? ShieldAlert : CalendarOff}
      title={copy.title}
      description={`${copy.description} ${message}`}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href={retryHref}>Back to this week</Link>
        </Button>
      }
    />
  )
}

// =============================================================================
// 4. Link building
// =============================================================================

/** An address for this page, with only the keys this page reads. */
function calendarHref(params: {
  readonly view: CalendarView
  readonly date: string
  readonly chef?: string | undefined
}): string {
  const search = new URLSearchParams({
    view: params.view,
    date: params.date,
  })

  if (params.chef !== undefined) {
    search.set('chef', params.chef)
  }

  return `/admin/calendar?${search.toString()}`
}

// =============================================================================
// 5. The page
// =============================================================================

/**
 * The chef's diary.
 *
 * A Server Component. It resolves which chef's calendar is being read, works
 * out the span the chosen view covers *in that chef's zone*, and reads three
 * things in parallel: the engagements inside the span, the availability rules
 * behind it, and what those rules actually mean as instants over the span.
 *
 * Nothing here is interactive. The grid, the availability editor and the
 * booking composer are client components; this page is the address-bar-to-data
 * translation and nothing else.
 */
export default async function CalendarPage({
  searchParams,
}: CalendarPageProps): Promise<React.JSX.Element> {
  const raw = await searchParams
  const requestedView = firstOf(raw.view)
  const view: CalendarView = isCalendarView(requestedView)
    ? requestedView
    : 'week'
  const requestedChef = firstOf(raw.chef)

  // --- Whose diary? --------------------------------------------------------
  //
  // A chef opens their own; an administrator may open anyone's. `chef` in the
  // address bar names the diary, and the roster read below is what makes an
  // administrator's switcher possible. Neither read is trusted for access —
  // the actions re-check ownership server-side on every call.
  const mine = await readMyStaffProfile({})
  const isMine =
    mine.ok && (requestedChef === undefined || requestedChef === mine.data.id)

  const roster = isMine
    ? null
    : await listStaffRoster({ page: 1, pageSize: 50, sortDirection: 'asc' })

  const chef = isMine
    ? mine.data
    : roster !== null && roster.ok
      ? (roster.data.items.find((item) => item.id === requestedChef) ??
        roster.data.items[0] ??
        null)
      : null

  const todayHref = calendarHref({
    view: 'week',
    date: toZonedDateKey(new Date(), DEFAULT_TIME_ZONE),
  })

  if (chef === null || chef === undefined) {
    const failure = !mine.ok
      ? mine
      : roster !== null && !roster.ok
        ? roster
        : null

    return (
      <div className="flex flex-col gap-8">
        <CalendarHeader />
        <CalendarFailure
          code={failure === null ? 'NOT_FOUND' : failure.code}
          message={
            failure === null
              ? 'There are no chef profiles on the roster yet.'
              : failure.error
          }
          subject="this calendar"
          retryHref={todayHref}
        />
      </div>
    )
  }

  const timeZone = chef.calendarTimeZone
  const chefName = chef.name ?? chef.accountName ?? 'this chef'

  // --- Which days? ---------------------------------------------------------
  const requestedDate = firstOf(raw.date)
  const focused =
    requestedDate !== undefined &&
    CALENDAR_DATE_PATTERN.test(requestedDate) &&
    !Number.isNaN(Date.parse(requestedDate))
      ? // A bare `YYYY-MM-DD` is UTC midnight, which lands on the intended
        // calendar date in every zone from UTC-11 to UTC+13. Noon is used so
        // that neither extreme rolls it over.
        new Date(`${requestedDate}T12:00:00Z`)
      : new Date()

  const range = rangeFor(view, focused, timeZone)
  const focusedKey = toZonedDateKey(focused, timeZone)
  const step = stepDaysFor(view, range)

  const previousKey = toZonedDateKey(
    addZonedDays(focused, timeZone, -step),
    timeZone
  )
  const nextKey = toZonedDateKey(
    addZonedDays(focused, timeZone, step),
    timeZone
  )
  const chefParam = isMine ? undefined : chef.id

  // The composer's first guess: seven in the evening, on the later of the day
  // the view opens on and today. Computed here rather than in the client
  // component so that the server render and the hydration agree on it — a
  // default derived from `Date.now()` inside a client component differs
  // between the two and React reports the input as mismatched.
  const composerDayStart = new Date(
    Math.max(
      range.start.getTime(),
      startOfZonedDay(new Date(), timeZone).getTime()
    )
  )
  const composerParts = zonedParts(composerDayStart, timeZone)
  const composerStart = zonedWallClockToInstant(
    composerParts.year,
    composerParts.month,
    composerParts.day,
    19,
    0,
    timeZone
  )

  // --- What is on it? ------------------------------------------------------
  const appointmentFilter: AppointmentFilterInput = {
    staffProfileId: chef.id,
    startsFrom: range.start,
    startsUntil: range.end,
    page: 1,
    pageSize: 100,
    sortDirection: 'asc',
  }

  const [appointments, rules, windows] = await Promise.all([
    listAppointments(appointmentFilterSchema.parse(appointmentFilter)),
    listAvailabilityRules({ staffProfileId: chef.id }),
    previewAvailabilityWindows({
      staffProfileId: chef.id,
      range: { start: range.start, end: range.end },
    }),
  ])

  const ruleRows: readonly AvailabilityRuleRow[] = rules.ok
    ? rules.data.rules
    : []
  const windowViews: readonly AvailabilityWindowView[] = windows.ok
    ? windows.data.windows
    : []

  return (
    <div className="flex flex-col gap-8">
      <CalendarHeader />

      <nav
        aria-label="Calendar view and date"
        className="flex flex-col gap-4 rounded-lg border border-ash bg-charcoal/60 p-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="sr-only" id="calendar-view-label">
            Choose a view
          </span>
          <ul
            aria-labelledby="calendar-view-label"
            className="flex items-center gap-1 rounded-md border border-ash bg-obsidian/60 p-1"
          >
            {VIEWS.map((candidate) => {
              const isActive = candidate === view

              return (
                <li key={candidate}>
                  <Button
                    asChild
                    size="sm"
                    variant={isActive ? 'champagne' : 'ghost'}
                  >
                    <Link
                      href={calendarHref({
                        view: candidate,
                        date: focusedKey,
                        chef: chefParam,
                      })}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      {VIEW_LABELS[candidate]}
                    </Link>
                  </Button>
                </li>
              )
            })}
          </ul>

          <Separator orientation="vertical" className="hidden h-6 lg:block" />

          <div className="flex items-center gap-1">
            <Button asChild size="sm" variant="outline">
              <Link
                href={calendarHref({
                  view,
                  date: previousKey,
                  chef: chefParam,
                })}
              >
                <span aria-hidden="true">←</span>
                <span className="sr-only">
                  Previous {view === 'day' ? 'day' : view}
                </span>
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link
                href={calendarHref({
                  view,
                  date: toZonedDateKey(new Date(), timeZone),
                  chef: chefParam,
                })}
              >
                Today
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link
                href={calendarHref({ view, date: nextKey, chef: chefParam })}
              >
                <span aria-hidden="true">→</span>
                <span className="sr-only">
                  Next {view === 'day' ? 'day' : view}
                </span>
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1 lg:items-end">
          <p
            id="calendar-range"
            className="font-display text-xl font-light tracking-tight text-linen"
          >
            {describeRange(view, range, focused, timeZone)}
          </p>
          <p className="font-sans text-xs text-stone">
            {chefName} · all times in{' '}
            <abbr title="The chef's calendar time zone">{timeZone}</abbr>
          </p>
        </div>
      </nav>

      {roster !== null && roster.ok && roster.data.items.length > 1 ? (
        <nav aria-label="Chef" className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-xs tracking-[0.18em] text-stone uppercase">
            Diary
          </span>
          {roster.data.items.map((entry) => (
            <Button
              key={entry.id}
              asChild
              size="sm"
              variant={entry.id === chef.id ? 'outline' : 'ghost'}
            >
              <Link
                href={calendarHref({
                  view,
                  date: focusedKey,
                  chef: entry.id,
                })}
                aria-current={entry.id === chef.id ? 'true' : undefined}
              >
                {entry.name ?? entry.accountName ?? 'Unnamed chef'}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}

      <section aria-labelledby="calendar-range" className="flex flex-col gap-3">
        {appointments.ok ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="muted" numeric>
                {appointments.data.meta.total} engagement
                {appointments.data.meta.total === 1 ? '' : 's'}
              </Badge>
              <Badge variant="muted" numeric>
                {windowViews.length} open window
                {windowViews.length === 1 ? '' : 's'}
              </Badge>
              <Badge variant="muted" numeric>
                {ruleRows.filter((rule) => rule.isBlackout).length} blackout
                {ruleRows.filter((rule) => rule.isBlackout).length === 1
                  ? ''
                  : 's'}
              </Badge>
              {appointments.data.meta.total > appointments.data.items.length ? (
                <span className="font-sans text-xs text-stone">
                  Showing the first {appointments.data.items.length}. Narrow the
                  view to see the rest.
                </span>
              ) : null}
            </div>

            <CalendarGrid
              view={view}
              timeZone={timeZone}
              anchorDate={focused}
              appointments={appointments.data.items.map(toCalendarAppointment)}
              availabilityWindows={windowViews}
              blackouts={expandBlackouts(ruleRows, range, timeZone)}
            />
          </>
        ) : (
          <CalendarFailure
            code={appointments.code}
            message={appointments.error}
            subject="the engagements on this calendar"
            retryHref={todayHref}
          />
        )}

        {windows.ok ? null : (
          <CalendarFailure
            code={windows.code}
            message={windows.error}
            subject="the published availability"
            retryHref={todayHref}
          />
        )}
      </section>

      <div className="hairline" role="presentation" />

      <div className="grid gap-8 xl:grid-cols-2">
        <section aria-labelledby="availability-heading">
          <h2
            id="availability-heading"
            className="mb-3 font-display text-2xl font-light tracking-tight text-linen"
          >
            When the kitchen is open
          </h2>
          {rules.ok ? (
            <AvailabilityEditor
              staffProfileId={chef.id}
              chefName={chefName}
              calendarTimeZone={timeZone}
              rules={ruleRows}
            />
          ) : (
            <CalendarFailure
              code={rules.code}
              message={rules.error}
              subject="this chef's availability rules"
              retryHref={todayHref}
            />
          )}
        </section>

        <section aria-labelledby="composer-heading">
          <h2
            id="composer-heading"
            className="mb-3 font-display text-2xl font-light tracking-tight text-linen"
          >
            Place an engagement
          </h2>
          <BookingComposer
            staffProfileId={chef.id}
            chefName={chefName}
            calendarTimeZone={timeZone}
            defaultStartsAt={composerStart}
          />
        </section>
      </div>
    </div>
  )
}

function CalendarHeader(): React.JSX.Element {
  return (
    <header className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-sans text-xs tracking-[0.24em] text-stone uppercase">
        <CalendarClock aria-hidden="true" className="size-3.5" />
        Calendar
      </p>
      <h1 className="font-display text-3xl font-light tracking-tight text-linen">
        The diary
      </h1>
      <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
        Every engagement, every open window, and every evening the kitchen is
        closed — read as a day, a week, or a month. Availability is authored in
        the chef’s own wall-clock time; the view follows it.
      </p>
    </header>
  )
}
