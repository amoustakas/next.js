// mannachef/apps/web/src/server/actions/booking.ts

'use server'

/**
 * Engagements — requesting one, moving one, and moving one through the state
 * machine.
 *
 * ## The one thing this file exists to get right
 *
 * **A booking is never written on the strength of a check that happened in a
 * different statement.** Reading the calendar, deciding it is free, and then
 * inserting a row is a time-of-check-to-time-of-use race, and the way it fails
 * is two households expecting the same chef at seven o'clock on a Saturday.
 *
 * Every mutation below that places or moves an appointment therefore does all
 * of the following, in one `prisma.$transaction`:
 *
 *  1. **Re-reads** the chef, their availability rules, and every neighbouring
 *     engagement *inside* the transaction. Nothing read before it opened is
 *     trusted, including the row an ownership guard just fetched.
 *  2. **Re-runs the full conflict evaluation** against those fresh rows, via
 *     the pure engine in `@/server/scheduling`. No conflict logic is
 *     reimplemented here — not overlap, not buffers, not blackouts, not DST.
 *  3. Runs at **`Serializable`** isolation, so PostgreSQL's SSI detects the
 *     read-write dependency between two concurrent bookings that each read the
 *     range the other was about to insert into, and aborts one of them.
 *  4. Claims the seat with a **conditional `updateMany`** guarded on
 *     `bookedCount`, which is atomic in its own right — PostgreSQL re-evaluates
 *     the `WHERE` after taking the row lock, so the loser of a race sees the
 *     winner's count and matches zero rows.
 *
 * Steps 3 and 4 are belt *and* braces on purpose, because they cover different
 * holes. The conditional update protects one row and cannot see an overlapping
 * engagement that has no slot at all; `Serializable` protects the range read
 * and costs a retry when it fires. {@link runSerializable} performs that retry,
 * because a serialization failure is a signal to try again, not a fault to
 * show a guest.
 *
 * ## Rescheduling excludes itself
 *
 * An engagement being moved must not be found conflicting with where it
 * currently sits. Every evaluation on the reschedule path passes
 * `excludeAppointmentId`, which is the field the engine's `ConflictOptions`
 * documents as "the engagement being amended, which must not conflict with
 * itself".
 *
 * ## What a client is allowed to see, and to say
 *
 * `chefNotes` is the kitchen's private column and is nulled for anybody below
 * `CHEF_STAFF` — see {@link toAppointmentView}. The engine's conflict messages
 * name the colliding appointment's id, which belongs to *another household*, so
 * they are replaced with generic sentences for a client caller; see
 * {@link describeConflict}. Money is server-owned on the client path: a
 * `CLIENT` cannot set `totalCents`, and dish prices are snapshotted from
 * `MenuItem.basePriceCents` rather than taken from the payload.
 */

import {
  appointmentCreateSchema,
  appointmentFilterSchema,
  appointmentStatusTransitionSchema,
  appointmentUpdateSchema,
  cuidSchema,
  dateRangeSchema,
  DEFAULT_BLOCKING_APPOINTMENT_STATUSES,
  hasRoleAtLeast,
  intSchema,
  MAX_PREP_LEAD_MINUTES,
  MAX_TRAVEL_BUFFER_MINUTES,
  paginationToSkipTake,
  type AppointmentStatus,
  type Role,
  type ServiceType,
} from '@mannachef/validators'
import {
  appointmentCancelInputSchema,
  type PageMeta,
} from '@mannachef/api-contract'
import type { AppointmentView } from '@mannachef/api-contract'
import { z } from 'zod'

import {
  ActionError,
  fail,
  ok,
  type ActionFailure,
  type ActionResult,
  type FieldErrors,
} from '@/server/actions/types'
import { Prisma, type PrismaClient } from '@/server/db'
import {
  requireAppointmentOwnership,
  withAction,
  type AuthenticatedUser,
} from '@/server/guards'
import {
  checkStatusTransition,
  evaluateBooking,
  isTerminalAppointmentStatus,
  occupiedInterval,
  type AlternativeSlot,
  type AppointmentLike,
  type AvailabilityRule,
  type BookingConflict,
  type BookingSlotLike,
  type BookingTiming,
} from '@/server/scheduling'
import { runSerializable } from '@/server/transaction'

// =============================================================================
// 0. Constants
// =============================================================================

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

/**
 * How far *forward* of the candidate an existing engagement may start and still
 * collide with it.
 *
 * An engagement's occupied interval reaches back from `startsAt` by its
 * preparation lead and then by its inbound travel buffer, so one that starts
 * thirty-two hours after the candidate ends can still be occupying the same
 * minutes. Querying a narrower neighbourhood would silently hide it, and the
 * engine would then declare the candidate free.
 */
const NEIGHBOURHOOD_AHEAD_MS =
  (MAX_PREP_LEAD_MINUTES + MAX_TRAVEL_BUFFER_MINUTES) * MS_PER_MINUTE

/** The mirror image: outbound travel is all that extends an engagement past `endsAt`. */
const NEIGHBOURHOOD_BEHIND_MS = MAX_TRAVEL_BUFFER_MINUTES * MS_PER_MINUTE

/**
 * How much calendar either side of the candidate is expanded when a refusal
 * needs alternatives to offer. Two days back and a week forward is the window a
 * guest will actually accept a move within; the engine widens it further if the
 * candidate itself falls outside.
 */
const SUGGESTION_LOOKBACK_MS = 2 * MS_PER_DAY
const SUGGESTION_LOOKAHEAD_MS = 7 * MS_PER_DAY

/** Alternatives offered on a refusal. */
const SUGGESTION_LIMIT = 3

/** Ceiling on how long a concierge may freeze a window while a guest decides. */
const MAX_HOLD_MINUTES = 120
const DEFAULT_HOLD_MINUTES = 15

const APPOINTMENT_PATHS = [
  '/portal/appointments',
  '/admin/calendar',
  '/admin/appointments',
  '/book',
] as const

const APPOINTMENT_TAGS = ['appointments', 'booking-slots'] as const

/**
 * A signed-in household requesting engagements. Ten an hour is far more than
 * anybody books and far less than a script can use to enumerate a diary through
 * the difference between "not free" and "not found".
 */
const REQUEST_RATE_LIMIT = { tokens: 10, windowMs: 60 * 60 * 1_000 } as const

// =============================================================================
// 1. Local input schemas
//
// Composed from `@mannachef/validators` primitives, never restating a rule the
// package already owns. The three status actions *derive* from the shared
// transition schema exactly as `@mannachef/api-contract` derives its cancel
// input, so a mistargeted call fails at the edge rather than performing a
// different transition than the button promised.
// =============================================================================

const appointmentIdSchema = z.object({ appointmentId: cuidSchema }).strict()

const appointmentConfirmSchema = appointmentStatusTransitionSchema.refine(
  (value) => value.to === 'CONFIRMED',
  { error: 'This action only confirms an engagement.', path: ['to'] }
)

const appointmentCompleteSchema = appointmentStatusTransitionSchema.refine(
  (value) => value.to === 'COMPLETED',
  { error: 'This action only closes out an engagement.', path: ['to'] }
)

/**
 * Rescheduling requires both ends of the new window.
 *
 * `appointmentUpdateSchema` is a partial — every field is optional, and it
 * already carries the temporal cross-field rules (the window closes after it
 * opens, is at least fifteen minutes, is at most a day, preparation precedes
 * service and leads it by no more than a day). Requiring the pair here turns
 * that partial into a move without restating any of those rules.
 */
const appointmentRescheduleSchema = appointmentUpdateSchema.refine(
  (value) => value.startsAt !== undefined && value.endsAt !== undefined,
  {
    error:
      'Please choose both a new start and a new finish for the engagement.',
    path: ['startsAt'],
  }
)

const slotHoldSchema = z
  .object({
    bookingSlotId: cuidSchema,
    holdMinutes: intSchema(1, MAX_HOLD_MINUTES, {
      notAnInteger: 'Please give the hold in whole minutes.',
      tooSmall: 'A hold lasts at least a minute.',
      tooLarge: `We hold a window for up to ${String(MAX_HOLD_MINUTES)} minutes.`,
    }).default(DEFAULT_HOLD_MINUTES),
  })
  .strict()

const slotIdSchema = z.object({ bookingSlotId: cuidSchema }).strict()

const dispatchQueueSchema = z
  .object({
    staffProfileId: cuidSchema.optional(),
    range: dateRangeSchema.optional(),
  })
  .strict()

// =============================================================================
// 2. Projections
// =============================================================================

/** Exactly the columns an appointment read may touch. Nothing is spread. */
const APPOINTMENT_SELECT = {
  id: true,
  clientProfileId: true,
  staffProfileId: true,
  bookingSlotId: true,
  serviceType: true,
  status: true,
  startsAt: true,
  endsAt: true,
  prepStartsAt: true,
  travelBufferBeforeMinutes: true,
  travelBufferAfterMinutes: true,
  guestCount: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  country: true,
  accessNotes: true,
  totalCents: true,
  depositCents: true,
  gratuityCents: true,
  currency: true,
  clientNotes: true,
  chefNotes: true,
  confirmedAt: true,
  completedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  cancelledById: true,
  createdAt: true,
  updatedAt: true,
  staffProfile: { select: { user: { select: { name: true } } } },
  menuItems: {
    orderBy: { courseOrder: 'asc' },
    select: {
      id: true,
      menuItemId: true,
      quantity: true,
      courseOrder: true,
      notes: true,
      priceCentsAtBooking: true,
      currency: true,
      menuItem: { select: { slug: true, name: true } },
    },
  },
} satisfies Prisma.ChefAppointmentSelect

type AppointmentRow = Prisma.ChefAppointmentGetPayload<{
  select: typeof APPOINTMENT_SELECT
}>

/** The timing columns the engine reads, and nothing else. */
const APPOINTMENT_TIMING_SELECT = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  prepStartsAt: true,
  travelBufferBeforeMinutes: true,
  travelBufferAfterMinutes: true,
} satisfies Prisma.ChefAppointmentSelect

/** The `ChefAvailability` columns `expandAvailability` reads, and nothing else. */
const AVAILABILITY_RULE_SELECT = {
  id: true,
  kind: true,
  dayOfWeek: true,
  specificDate: true,
  startMinute: true,
  endMinute: true,
  timeZone: true,
  effectiveFrom: true,
  effectiveUntil: true,
  isBlackout: true,
} satisfies Prisma.ChefAvailabilitySelect

/** The `BookingSlot` columns capacity and containment depend on. */
const BOOKING_SLOT_SELECT = {
  id: true,
  staffProfileId: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  bookedCount: true,
  status: true,
  serviceType: true,
  holdsUntil: true,
} satisfies Prisma.BookingSlotSelect

type BookingSlotRow = Prisma.BookingSlotGetPayload<{
  select: typeof BOOKING_SLOT_SELECT
}>

/**
 * Render a stored engagement for a caller.
 *
 * `canSeeChefNotes` is the only conditional, and it is a *column* decision
 * rather than a row decision: the caller has already proved they may read this
 * engagement, and the question here is whether they may read the kitchen's
 * private commentary on it. A household may not — `chefNotes` is where a chef
 * writes "the husband is difficult about the wine".
 *
 * Written as an explicit field list. A spread of the Prisma row would publish
 * whatever column `ChefAppointment` gains next.
 */
function toAppointmentView(
  row: AppointmentRow,
  canSeeChefNotes: boolean
): AppointmentView {
  const hasAddress =
    row.addressLine1 !== null ||
    row.addressLine2 !== null ||
    row.city !== null ||
    row.region !== null ||
    row.postalCode !== null ||
    row.country !== null

  return {
    id: row.id,
    clientProfileId: row.clientProfileId,
    staffProfileId: row.staffProfileId,
    staffName: row.staffProfile.user.name,
    bookingSlotId: row.bookingSlotId,
    serviceType: row.serviceType,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    prepStartsAt: row.prepStartsAt,
    travelBufferBeforeMinutes: row.travelBufferBeforeMinutes,
    travelBufferAfterMinutes: row.travelBufferAfterMinutes,
    guestCount: row.guestCount,
    address: hasAddress
      ? {
          line1: row.addressLine1,
          line2: row.addressLine2,
          city: row.city,
          region: row.region,
          postalCode: row.postalCode,
          country: row.country,
        }
      : null,
    accessNotes: row.accessNotes,
    totalCents: row.totalCents,
    depositCents: row.depositCents,
    gratuityCents: row.gratuityCents,
    currency: row.currency,
    clientNotes: row.clientNotes,
    chefNotes: canSeeChefNotes ? row.chefNotes : null,
    confirmedAt: row.confirmedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    cancelledById: row.cancelledById,
    menuItems: row.menuItems.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      slug: item.menuItem.slug,
      name: item.menuItem.name,
      quantity: item.quantity,
      courseOrder: item.courseOrder,
      notes: item.notes,
      priceCentsAtBooking: item.priceCentsAtBooking,
      currency: item.currency,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Page counters, matching `pageMetaSchema` in `@mannachef/api-contract`.
 *
 * The same six lines appear in `availability.ts`. A `'use server'` module may
 * export nothing but async functions, so the helper cannot be shared between
 * them without a fourth module existing solely to hold it.
 */
function pageMetaFor(page: number, pageSize: number, total: number): PageMeta {
  const pageCount = Math.ceil(total / pageSize)

  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  }
}

// =============================================================================
// 3. Refusals
// =============================================================================

/**
 * The form field a conflict belongs against, so React Hook Form can put the
 * message where the guest is looking.
 */
function fieldForConflict(conflict: BookingConflict): string {
  switch (conflict.kind) {
    case 'INVALID_INTERVAL':
      return conflict.field === 'travelBuffer'
        ? 'travelBufferBeforeMinutes'
        : conflict.field

    case 'CAPACITY':
      return 'bookingSlotId'

    case 'ILLEGAL_TRANSITION':
      return 'to'

    case 'CORE_OVERLAP':
    case 'BUFFER_OVERLAP':
    case 'OUTSIDE_AVAILABILITY':
    case 'STARTS_IN_THE_PAST':
      return 'startsAt'

    default: {
      const exhaustive: never = conflict
      return exhaustive
    }
  }
}

/**
 * Turn one engine refusal into a sentence the caller may read.
 *
 * The engine writes for the admin OS, and two of its messages name the
 * colliding engagement's id — which identifies **another household's booking**.
 * Handing that to a guest would turn every refused booking into a disclosure,
 * and a patient attacker into a map of a chef's client list. So a caller below
 * `CHEF_STAFF` gets a sentence that says what to do and nothing about who else
 * is in the diary.
 *
 * `INVALID_INTERVAL` and `STARTS_IN_THE_PAST` pass through unchanged: they
 * describe the caller's own payload and contain no third party.
 */
function describeConflict(
  conflict: BookingConflict,
  forStaff: boolean
): string {
  if (forStaff) {
    return conflict.message
  }

  switch (conflict.kind) {
    case 'CORE_OVERLAP':
    case 'BUFFER_OVERLAP':
      return 'The chef is not free at that time. Please choose another.'

    case 'OUTSIDE_AVAILABILITY':
      return 'The chef does not work at that time — travel to and from the engagement is counted, so a booking can fit while the journey either side of it does not.'

    case 'CAPACITY':
      return conflict.cause === 'LIVE_HOLD'
        ? 'Another guest is holding this sitting. It will reopen if their hold lapses.'
        : 'That sitting is no longer available.'

    case 'ILLEGAL_TRANSITION':
      return conflict.message

    case 'INVALID_INTERVAL':
    case 'STARTS_IN_THE_PAST':
      return conflict.message

    default: {
      const exhaustive: never = conflict
      return exhaustive
    }
  }
}

/** A readable instant in the chef's own zone, for the alternatives offered. */
function formatInstant(
  instant: Date,
  timeZone: string,
  locale: string
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(instant)
  } catch {
    // An unrecognised locale or zone is a data problem, not a reason to lose
    // the suggestion. ISO is ugly and unambiguous.
    return instant.toISOString()
  }
}

/**
 * Package an engine refusal as an {@link ActionFailure}.
 *
 * `ActionResult` has no third arm for "refused, and here are three other
 * times", and inventing one would break the contract every screen and the Expo
 * client branch on. So the alternatives ride in `fieldErrors.startsAt`, which
 * is exactly where a form renders them and exactly the spelling
 * `setError` accepts. A guest sees "the chef is not free at that time" followed
 * by "try Sat, 15 Feb, 19:00", inline, under the field they need to change.
 */
function conflictFailure(
  reasons: readonly BookingConflict[],
  alternatives: readonly AlternativeSlot[],
  forStaff: boolean,
  timeZone: string,
  locale: string
): ActionFailure {
  const fieldErrors: FieldErrors = {}

  for (const reason of reasons) {
    const key = fieldForConflict(reason)
    const message = describeConflict(reason, forStaff)
    const bucket = fieldErrors[key]

    if (bucket === undefined) {
      fieldErrors[key] = [message]
    } else {
      bucket.push(message)
    }
  }

  for (const alternative of alternatives) {
    const message = `Try ${formatInstant(alternative.startsAt, timeZone, locale)}.`
    const bucket = fieldErrors.startsAt

    if (bucket === undefined) {
      fieldErrors.startsAt = [message]
    } else {
      bucket.push(message)
    }
  }

  const first = reasons[0]

  return fail(
    'CONFLICT',
    first === undefined
      ? 'That time is not available.'
      : describeConflict(first, forStaff),
    fieldErrors
  )
}

// =============================================================================
// 4. Transaction plumbing
// =============================================================================

/**
 * What a guest is told when every `Serializable` attempt has aborted.
 *
 * The runner itself is {@link runSerializable} in `@/server/transaction`. It
 * moved out of this file when `actions/user.ts` needed the same mechanism for
 * its last-super-admin rule — see that module's docblock for why a helper
 * shared between two action files cannot live in either of them. What stays
 * here is the sentence, because the runner deliberately refuses to invent one:
 * losing a race for a Saturday sitting and losing a race to step down are
 * different disappointments, and are owed different apologies.
 */
const RACE_MESSAGE =
  'Somebody else was booking the same window at that exact moment. Please try again.'

// =============================================================================
// 5. Calendar state, read fresh
// =============================================================================

interface CalendarState {
  readonly staffProfileId: string
  readonly calendarTimeZone: string
  readonly maxConcurrentEvents: number
  readonly isAcceptingClients: boolean
  readonly availabilityRules: readonly AvailabilityRule[]
  readonly existingAppointments: readonly AppointmentLike[]
}

/**
 * Everything the engine needs about one chef, read inside the caller's
 * transaction.
 *
 * The appointment query is widened by {@link NEIGHBOURHOOD_AHEAD_MS} and
 * {@link NEIGHBOURHOOD_BEHIND_MS} rather than clipped to the candidate's own
 * hours, because an engagement's *occupied* interval is wider than its
 * `startsAt`–`endsAt`: preparation reaches back up to a day and travel reaches
 * out up to eight hours either side. A tighter query would hide the very
 * collision the engine is being asked about.
 *
 * Blocking statuses are `DEFAULT_BLOCKING_APPOINTMENT_STATUSES` from
 * `@mannachef/validators` — the same list the engine defaults to, imported
 * rather than restated so the query and the evaluation can never disagree about
 * which engagements occupy a diary.
 */
async function loadCalendarState(
  tx: Prisma.TransactionClient,
  staffProfileId: string,
  occupied: { readonly start: Date; readonly end: Date }
): Promise<CalendarState | null> {
  const staff = await tx.staffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      id: true,
      calendarTimeZone: true,
      maxConcurrentEvents: true,
      isAcceptingClients: true,
    },
  })

  if (staff === null) {
    return null
  }

  const [availabilityRules, existingAppointments] = await Promise.all([
    tx.chefAvailability.findMany({
      where: { staffProfileId: staff.id },
      select: AVAILABILITY_RULE_SELECT,
    }),
    tx.chefAppointment.findMany({
      where: {
        staffProfileId: staff.id,
        status: { in: [...DEFAULT_BLOCKING_APPOINTMENT_STATUSES] },
        startsAt: {
          lt: new Date(occupied.end.getTime() + NEIGHBOURHOOD_AHEAD_MS),
        },
        endsAt: {
          gt: new Date(occupied.start.getTime() - NEIGHBOURHOOD_BEHIND_MS),
        },
      },
      select: APPOINTMENT_TIMING_SELECT,
    }),
  ])

  return {
    staffProfileId: staff.id,
    calendarTimeZone: staff.calendarTimeZone,
    maxConcurrentEvents: staff.maxConcurrentEvents,
    isAcceptingClients: staff.isAcceptingClients,
    availabilityRules,
    existingAppointments,
  }
}

// =============================================================================
// 6. Seat accounting
// =============================================================================

/**
 * Take one booking's worth of capacity from a window, atomically.
 *
 * The `WHERE` is the whole point. PostgreSQL re-evaluates it after acquiring
 * the row lock, so when two transactions race for the last seat the loser sees
 * the winner's committed `bookedCount`, matches no rows, and is told the
 * sitting has gone — without either of them having to hold a lock across the
 * conflict evaluation.
 *
 * `HELD` is an accepted starting status *provided the hold has lapsed*, which
 * the `holdsUntil` clause enforces. That agrees with the engine, whose
 * `checkCapacity` treats an expired hold as consuming nothing rather than
 * waiting for a sweeper to rewrite `status`.
 *
 * A window holds a whole number of **bookings**, not covers —
 * `bookingSlotCreateSchema` calls `capacity` "how many bookings this window can
 * take" — so one engagement consumes one seat whatever its `guestCount`.
 */
async function claimSlotSeat(
  tx: Prisma.TransactionClient,
  slot: BookingSlotRow,
  now: Date
): Promise<boolean> {
  const claimed = await tx.bookingSlot.updateMany({
    where: {
      id: slot.id,
      status: { in: ['OPEN', 'BOOKED', 'HELD'] },
      bookedCount: { lt: slot.capacity },
      OR: [{ holdsUntil: null }, { holdsUntil: { lte: now } }],
    },
    data: { bookedCount: { increment: 1 } },
  })

  if (claimed.count !== 1) {
    return false
  }

  // Keep the invariant the public window search depends on: a window is `OPEN`
  // while it has room and `FULL` the moment the last seat goes. Consuming a
  // lapsed hold also clears it, so the window stops advertising a hold that
  // expired.
  await tx.bookingSlot.updateMany({
    where: { id: slot.id, bookedCount: { gte: slot.capacity } },
    data: { status: 'FULL', holdsUntil: null },
  })

  await tx.bookingSlot.updateMany({
    where: { id: slot.id, bookedCount: { lt: slot.capacity }, status: 'HELD' },
    data: { status: 'OPEN', holdsUntil: null },
  })

  return true
}

/**
 * Give a seat back.
 *
 * Guarded on `bookedCount > 0` so a double release — two operators cancelling
 * the same engagement at once, a retry after a timeout — cannot drive the count
 * negative and open a window that is genuinely full.
 */
async function releaseSlotSeat(
  tx: Prisma.TransactionClient,
  bookingSlotId: string
): Promise<boolean> {
  const released = await tx.bookingSlot.updateMany({
    where: { id: bookingSlotId, bookedCount: { gt: 0 } },
    data: { bookedCount: { decrement: 1 } },
  })

  if (released.count !== 1) {
    return false
  }

  // It had no room a moment ago and now it does.
  await tx.bookingSlot.updateMany({
    where: { id: bookingSlotId, status: 'FULL' },
    data: { status: 'OPEN' },
  })

  return true
}

// =============================================================================
// 7. Shared checks
// =============================================================================

/** The engine's view of a candidate, from a create or an amended row. */
function timingOf(source: {
  readonly startsAt: Date
  readonly endsAt: Date
  readonly prepStartsAt: Date | null
  readonly travelBufferBeforeMinutes: number
  readonly travelBufferAfterMinutes: number
}): BookingTiming {
  return {
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    prepStartsAt: source.prepStartsAt,
    travelBufferBeforeMinutes: source.travelBufferBeforeMinutes,
    travelBufferAfterMinutes: source.travelBufferAfterMinutes,
  }
}

/**
 * A window a booking claims a seat in has to be the *same* window the booking
 * happens in.
 *
 * Without this, a guest could claim the seat in a cheap nine-o'clock
 * consultation slot and then write the engagement itself for eight in the
 * evening: the capacity arithmetic would balance, the diary would show a free
 * morning, and the chef would discover the dinner on the day.
 */
function slotContains(slot: BookingSlotRow, timing: BookingTiming): boolean {
  return (
    timing.startsAt.getTime() >= slot.startsAt.getTime() &&
    timing.endsAt.getTime() <= slot.endsAt.getTime()
  )
}

/** The engine reads only these four columns off a slot. */
function toSlotLike(slot: BookingSlotRow): BookingSlotLike {
  return {
    id: slot.id,
    capacity: slot.capacity,
    bookedCount: slot.bookedCount,
    status: slot.status,
    holdsUntil: slot.holdsUntil,
  }
}

/**
 * Who may drive an engagement to a given status.
 *
 * A household may withdraw its own booking; everything else — accepting one,
 * starting it, closing it out, recording that nobody was home — is the
 * kitchen's to record. Exhaustive over `AppointmentStatus`, so adding a status
 * to the enum without deciding who may set it is a compile error rather than an
 * accidental grant.
 */
function minimumRoleToReach(status: AppointmentStatus): Role {
  switch (status) {
    case 'CANCELLED':
      return 'CLIENT'

    case 'CONFIRMED':
    case 'IN_PROGRESS':
    case 'COMPLETED':
    case 'NO_SHOW':
      return 'CHEF_STAFF'

    case 'REQUESTED':
      // Unreachable through the state machine — nothing transitions *to*
      // `REQUESTED` — but the enum has the member, so it gets an answer.
      return 'ADMIN'

    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/**
 * The statuses a household may change an engagement out of on its own.
 *
 * Withdrawing or moving a booking the kitchen has not begun is self-service.
 * Once a chef is `IN_PROGRESS` — shopping done, in the car, in the kitchen —
 * the change is a conversation with the concierge, because somebody has
 * already been paid for and dispatched.
 */
const CLIENT_CHANGEABLE_STATUSES: readonly AppointmentStatus[] = [
  'REQUESTED',
  'CONFIRMED',
]

/** `chefNotes`, dispatch detail and the engine's verbose refusals are staff-only. */
function isStaff(user: AuthenticatedUser): boolean {
  return hasRoleAtLeast(user.role, 'CHEF_STAFF')
}

// =============================================================================
// 8. Requesting an engagement
// =============================================================================

/** One dish, priced by the server. */
interface PricedMenuSelection {
  readonly menuItemId: string
  readonly quantity: number
  readonly courseOrder: number
  readonly notes: string | null
  readonly priceCentsAtBooking: number | null
  readonly currency: string
}

/**
 * Book an engagement.
 *
 * ## Order of operations
 *
 * 1. Role and payload are already done by `withAction`.
 * 2. **Household ownership.** A `CLIENT` may book only for their own
 *    `ClientProfile`; `CHEF_STAFF` and above may book on a household's behalf,
 *    which is what the concierge does on the telephone.
 * 3. **Menu pricing, server-side.** Every `menuItemId` is read back. A dish
 *    that does not exist refuses the booking; a dish that is off the menu
 *    refuses a guest's booking and is allowed to staff. Prices are snapshotted
 *    from `MenuItem.basePriceCents` for a guest, because
 *    `appointmentMenuItemSelectionSchema` accepts `priceCentsAtBooking` from
 *    the payload and a client-supplied price is a client-supplied invoice.
 * 4. **The transaction**, at `Serializable`, retried on abort: re-read the
 *    chef, the rules, the neighbouring engagements and the window; re-run
 *    `evaluateBooking` against those rows; claim the seat with a conditional
 *    update; write the engagement.
 *
 * Nothing between steps 3 and 4 is carried into the decision — the calendar
 * state used by the evaluation is read inside the transaction, every time.
 */
export const requestAppointment = withAction(
  {
    name: 'appointment.create',
    auth: 'SESSION',
    input: appointmentCreateSchema,
    rateLimit: REQUEST_RATE_LIMIT,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => {
    const staffCaller = isStaff(ctx.user)

    // --- 1. Whose household is this? ---------------------------------------
    if (!staffCaller) {
      if (ctx.user.clientProfileId === null) {
        return fail(
          'FORBIDDEN',
          'Please complete your household profile before booking.'
        )
      }

      if (input.clientProfileId !== ctx.user.clientProfileId) {
        return fail(
          'FORBIDDEN',
          'You may only book engagements for your own household.'
        )
      }
    } else {
      const household = await ctx.db.clientProfile.findUnique({
        where: { id: input.clientProfileId },
        select: { id: true },
      })

      if (household === null) {
        return fail('NOT_FOUND', 'We could not find that household.')
      }
    }

    // --- 2. Price the menu on the server -----------------------------------
    const priced = await priceMenuSelections(
      ctx.db,
      input.menuItems,
      input.currency,
      staffCaller
    )

    if (!priced.ok) {
      return priced
    }

    const timing = timingOf({
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      prepStartsAt: input.prepStartsAt ?? null,
      travelBufferBeforeMinutes: input.travelBufferBeforeMinutes,
      travelBufferAfterMinutes: input.travelBufferAfterMinutes,
    })

    const occupied = occupiedInterval(timing)
    const now = new Date()

    // --- 3. Decide and write, in one serializable transaction ---------------
    const outcome = await runSerializable(ctx.db, RACE_MESSAGE, async (tx) => {
      const calendar = await loadCalendarState(
        tx,
        input.staffProfileId,
        occupied
      )

      if (calendar === null) {
        return { kind: 'noChef' } as const
      }

      if (!calendar.isAcceptingClients) {
        return { kind: 'notAccepting' } as const
      }

      let slot: BookingSlotRow | null = null

      if (input.bookingSlotId !== undefined) {
        slot = await tx.bookingSlot.findUnique({
          where: { id: input.bookingSlotId },
          select: BOOKING_SLOT_SELECT,
        })

        if (slot === null || slot.staffProfileId !== calendar.staffProfileId) {
          return { kind: 'noSlot' } as const
        }

        if (!slotContains(slot, timing)) {
          return { kind: 'slotMismatch' } as const
        }

        if (
          slot.serviceType !== null &&
          slot.serviceType !== input.serviceType
        ) {
          return {
            kind: 'serviceMismatch',
            expected: slot.serviceType,
          } as const
        }
      }

      const verdict = evaluateBooking({
        now,
        candidate: timing,
        staff: {
          maxConcurrentEvents: calendar.maxConcurrentEvents,
          calendarTimeZone: calendar.calendarTimeZone,
        },
        availabilityRules: calendar.availabilityRules,
        existingAppointments: calendar.existingAppointments,
        searchRange: {
          from: new Date(occupied.start.getTime() - SUGGESTION_LOOKBACK_MS),
          until: new Date(occupied.end.getTime() + SUGGESTION_LOOKAHEAD_MS),
        },
        bookingSlot: slot === null ? null : toSlotLike(slot),
        requestedSeats: 1,
        suggestionLimit: SUGGESTION_LIMIT,
      })

      if (!verdict.ok) {
        return {
          kind: 'refused',
          reasons: verdict.reasons,
          alternatives: verdict.alternatives,
          timeZone: calendar.calendarTimeZone,
        } as const
      }

      // The seat is claimed *before* the engagement is written, so a lost race
      // leaves nothing behind: returning here commits an empty transaction.
      // Were the order reversed, the failed claim would have to roll back an
      // insert, and the guest would be told about a race rather than a
      // sold-out sitting.
      if (slot !== null && !(await claimSlotSeat(tx, slot, now))) {
        return { kind: 'soldOut' } as const
      }

      const created = await tx.chefAppointment.create({
        data: {
          clientProfileId: input.clientProfileId,
          staffProfileId: calendar.staffProfileId,
          bookingSlotId: slot === null ? null : slot.id,
          serviceType: input.serviceType,
          // A new engagement is always `REQUESTED`. Every move after this goes
          // through the state machine, which is why `appointmentCreateSchema`
          // has no `status` field to override.
          status: 'REQUESTED',
          startsAt: timing.startsAt,
          endsAt: timing.endsAt,
          prepStartsAt: timing.prepStartsAt,
          travelBufferBeforeMinutes: timing.travelBufferBeforeMinutes,
          travelBufferAfterMinutes: timing.travelBufferAfterMinutes,
          guestCount: input.guestCount,
          addressLine1: input.address?.line1 ?? null,
          addressLine2: input.address?.line2 ?? null,
          city: input.address?.city ?? null,
          region: input.address?.region ?? null,
          postalCode: input.address?.postalCode ?? null,
          country: input.address?.country ?? null,
          accessNotes: input.accessNotes ?? null,
          // Money is server-owned on the guest path. A household quoting its
          // own four-thousand-dollar dinner at nothing is a payload away
          // otherwise; the concierge sets the figures, or the invoice does.
          totalCents: staffCaller ? input.totalCents : 0,
          depositCents: staffCaller ? input.depositCents : 0,
          gratuityCents: staffCaller ? input.gratuityCents : 0,
          currency: input.currency,
          clientNotes: input.clientNotes ?? null,
          // Likewise the kitchen's private column: a guest may not write into
          // the field a guest may not read.
          chefNotes: staffCaller ? (input.chefNotes ?? null) : null,
          menuItems: {
            create: priced.data.map((item) => ({
              menuItemId: item.menuItemId,
              quantity: item.quantity,
              courseOrder: item.courseOrder,
              notes: item.notes,
              priceCentsAtBooking: item.priceCentsAtBooking,
              currency: item.currency,
            })),
          },
        },
        select: APPOINTMENT_SELECT,
      })

      return { kind: 'created', appointment: created } as const
    })

    switch (outcome.kind) {
      case 'created':
        return ok(toAppointmentView(outcome.appointment, staffCaller))

      case 'noChef':
        return fail('NOT_FOUND', 'We could not find that chef.')

      case 'notAccepting':
        return fail(
          'CONFLICT',
          'This chef is not taking new engagements at the moment.'
        )

      case 'noSlot':
        return fail('NOT_FOUND', 'We could not find that sitting.')

      case 'slotMismatch':
        return fail(
          'VALIDATION',
          'The times you chose fall outside the sitting you selected.',
          { startsAt: ['This time is not inside the sitting you chose.'] }
        )

      case 'serviceMismatch':
        return fail(
          'VALIDATION',
          'That sitting is reserved for a different kind of service.',
          {
            serviceType: [
              `This sitting is for ${outcome.expected.toLowerCase().replace(/_/g, ' ')}.`,
            ],
          }
        )

      case 'soldOut':
        return fail(
          'CONFLICT',
          'That sitting was taken while you were booking. Please choose another.',
          { bookingSlotId: ['This sitting has just been taken.'] }
        )

      case 'refused':
        return conflictFailure(
          outcome.reasons,
          outcome.alternatives,
          staffCaller,
          outcome.timeZone,
          ctx.user.locale
        )

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

/**
 * Read every referenced dish back and decide what it costs.
 *
 * Two jobs at once, and both matter. The read *proves the dishes exist*, which
 * turns a foreign-key violation deep inside the transaction into an ordinary
 * validation message pointing at the right array index. And it *sets the
 * price*: `appointmentMenuItemSelectionSchema` accepts `priceCentsAtBooking`
 * from the payload — appropriate when a concierge is quoting a bespoke menu,
 * and a self-service discount when a guest sends it. So a guest's figure is
 * discarded and `MenuItem.basePriceCents` is snapshotted instead.
 *
 * A dish that is `isActive: false` is off the menu. Staff may still book it —
 * that is how a dish is trialled — and a guest may not.
 */
async function priceMenuSelections(
  db: Prisma.TransactionClient,
  selections: readonly {
    readonly menuItemId: string
    readonly quantity: number
    readonly courseOrder: number
    readonly notes?: string | undefined
    readonly priceCentsAtBooking?: number | undefined
    readonly currency: string
  }[],
  fallbackCurrency: string,
  staffCaller: boolean
): Promise<ActionResult<readonly PricedMenuSelection[]>> {
  if (selections.length === 0) {
    return ok([])
  }

  const dishes = await db.menuItem.findMany({
    where: { id: { in: selections.map((item) => item.menuItemId) } },
    select: {
      id: true,
      name: true,
      isActive: true,
      basePriceCents: true,
      currency: true,
    },
  })

  const byId = new Map(dishes.map((dish) => [dish.id, dish]))
  const fieldErrors: FieldErrors = {}
  const priced: PricedMenuSelection[] = []

  for (const [index, selection] of selections.entries()) {
    const dish = byId.get(selection.menuItemId)

    if (dish === undefined) {
      fieldErrors[`menuItems[${String(index)}].menuItemId`] = [
        'We no longer have that dish.',
      ]
      continue
    }

    if (!dish.isActive && !staffCaller) {
      fieldErrors[`menuItems[${String(index)}].menuItemId`] = [
        `${dish.name} is not on the menu at the moment.`,
      ]
      continue
    }

    priced.push({
      menuItemId: dish.id,
      quantity: selection.quantity,
      courseOrder: selection.courseOrder,
      notes: selection.notes ?? null,
      priceCentsAtBooking: staffCaller
        ? (selection.priceCentsAtBooking ?? dish.basePriceCents)
        : dish.basePriceCents,
      currency: staffCaller
        ? selection.currency
        : dish.currency.length > 0
          ? dish.currency
          : fallbackCurrency,
    })
  }

  if (Object.keys(fieldErrors).length > 0) {
    return fail(
      'VALIDATION',
      'One of the dishes on this menu is no longer available.',
      fieldErrors
    )
  }

  return ok(priced)
}

// =============================================================================
// 9. Moving an engagement in time
// =============================================================================

/** Fields on `appointmentUpdateSchema` that a reschedule refuses to apply. */
const RESCHEDULE_FORBIDDEN_FIELDS = [
  'serviceType',
  'menuItems',
  'totalCents',
  'depositCents',
  'gratuityCents',
  'currency',
  'chefNotes',
] as const

/**
 * Move an engagement to a new time.
 *
 * ## Why this amends the row rather than cancelling and re-creating it
 *
 * `@/server/scheduling` observes, correctly, that the *state machine* has no
 * reschedule edge — there is no `RESCHEDULED` status and none is wanted. That
 * is a statement about statuses, and this action changes none: a `CONFIRMED`
 * engagement that moves is still `CONFIRMED`.
 *
 * The row survives because things point at it. `Invoice.appointmentId`,
 * `Review.appointmentId` and `AppointmentMenuItem.appointmentId` all reference
 * this id; cancelling and re-creating would strand a paid deposit against a
 * cancelled engagement and detach the menu the household already chose. The
 * engine anticipates exactly this — `ConflictOptions.excludeAppointmentId` is
 * documented as "the engagement being amended, which must not conflict with
 * itself" — and this action is its caller.
 *
 * ## What is re-checked, and against what
 *
 * Everything, inside the transaction, against freshly-read rows, with this
 * engagement excluded from its own conflict set. A move is a placement, so it
 * gets the identical treatment to {@link requestAppointment}: the chef's rules,
 * the neighbouring engagements, the destination window's capacity.
 *
 * ## What it refuses to do
 *
 * A terminal engagement does not move — a completed dinner is history and a
 * cancelled one is a new booking. And the payload's non-timing fields are
 * *refused*, not silently dropped: re-pricing, re-plating and rewriting the
 * kitchen's notes are separate, separately-audited changes, and an action that
 * quietly ignored half of what it was sent would be the worse failure.
 */
export const rescheduleAppointment = withAction(
  {
    name: 'appointment.reschedule',
    auth: 'SESSION',
    input: appointmentRescheduleSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => {
    const staffCaller = isStaff(ctx.user)

    const owned = await requireAppointmentOwnership(
      ctx.user,
      input.appointmentId
    )

    if (!owned.ok) {
      return owned
    }

    const offending = RESCHEDULE_FORBIDDEN_FIELDS.filter(
      (field) => input[field] !== undefined
    )

    if (offending.length > 0) {
      const fieldErrors: FieldErrors = {}

      for (const field of offending) {
        fieldErrors[field] = [
          'This is changed separately from the time of the engagement.',
        ]
      }

      return fail(
        'VALIDATION',
        'Moving an engagement changes when it happens and nothing else. Please amend the rest separately.',
        fieldErrors
      )
    }

    if (isTerminalAppointmentStatus(owned.data.status)) {
      return fail(
        'CONFLICT',
        `A ${owned.data.status.toLowerCase().replace(/_/g, ' ')} engagement cannot be moved — please book a new one.`
      )
    }

    // A household may move a booking the kitchen has not yet begun. Once a
    // chef is `IN_PROGRESS` — shopping done, in the car, in the kitchen — a
    // move is a conversation, not a form. The same list bounds a guest's
    // cancellation in `performTransition`, for the same reason.
    if (
      !staffCaller &&
      !CLIENT_CHANGEABLE_STATUSES.includes(owned.data.status)
    ) {
      return fail(
        'CONFLICT',
        'This engagement is already under way. Please telephone us to change it.'
      )
    }

    // Both are guaranteed present by `appointmentRescheduleSchema`; the
    // narrowing is restated for the compiler rather than asserted away.
    const { startsAt, endsAt } = input

    if (startsAt === undefined || endsAt === undefined) {
      return fail(
        'VALIDATION',
        'Please choose both a new start and a new finish for the engagement.',
        { startsAt: ['Please choose a new start.'] }
      )
    }

    const now = new Date()

    const outcome = await runSerializable(ctx.db, RACE_MESSAGE, async (tx) => {
      const current = await tx.chefAppointment.findUnique({
        where: { id: owned.data.id },
        select: {
          id: true,
          status: true,
          staffProfileId: true,
          bookingSlotId: true,
          serviceType: true,
          prepStartsAt: true,
          travelBufferBeforeMinutes: true,
          travelBufferAfterMinutes: true,
        },
      })

      if (current === null) {
        return { kind: 'gone' } as const
      }

      // Re-read rather than trust the ownership guard's snapshot: the status
      // may have moved between that read and this transaction.
      if (isTerminalAppointmentStatus(current.status)) {
        return { kind: 'terminal', status: current.status } as const
      }

      const timing = timingOf({
        startsAt,
        endsAt,
        prepStartsAt:
          input.prepStartsAt !== undefined
            ? input.prepStartsAt
            : current.prepStartsAt,
        travelBufferBeforeMinutes:
          input.travelBufferBeforeMinutes ?? current.travelBufferBeforeMinutes,
        travelBufferAfterMinutes:
          input.travelBufferAfterMinutes ?? current.travelBufferAfterMinutes,
      })

      // `appointmentUpdateSchema`'s preparation rules fire only when *both*
      // `startsAt` and `prepStartsAt` are in the payload — a cross-field check
      // cannot see a field the caller did not send. Moving a dinner two hours
      // earlier and leaving the stored preparation time behind therefore slips
      // through the parser and produces a row whose mise en place begins after
      // service does. The merged row is checked here instead.
      //
      // The stored value is not silently shifted along with the service: that
      // would quietly change when a chef has to start shopping, and a chef
      // reading a run sheet should never have to wonder whether a time was
      // typed or inferred.
      if (timing.prepStartsAt !== null) {
        const leadMs = timing.startsAt.getTime() - timing.prepStartsAt.getTime()

        if (leadMs < 0) {
          return {
            kind: 'prepInvalid',
            message:
              'Preparation must begin at or before the service itself begins — please give a new preparation time as well.',
          } as const
        }

        if (leadMs > MAX_PREP_LEAD_MINUTES * MS_PER_MINUTE) {
          return {
            kind: 'prepInvalid',
            message:
              'Preparation cannot begin more than twenty-four hours before the service — please give a new preparation time as well.',
          } as const
        }
      }

      const occupied = occupiedInterval(timing)

      const calendar = await loadCalendarState(
        tx,
        current.staffProfileId,
        occupied
      )

      if (calendar === null) {
        return { kind: 'noChef' } as const
      }

      const nextSlotId =
        input.bookingSlotId !== undefined
          ? input.bookingSlotId
          : current.bookingSlotId

      let slot: BookingSlotRow | null = null

      if (nextSlotId !== null) {
        slot = await tx.bookingSlot.findUnique({
          where: { id: nextSlotId },
          select: BOOKING_SLOT_SELECT,
        })

        if (slot === null || slot.staffProfileId !== calendar.staffProfileId) {
          return { kind: 'noSlot' } as const
        }

        if (!slotContains(slot, timing)) {
          return { kind: 'slotMismatch' } as const
        }

        if (
          slot.serviceType !== null &&
          slot.serviceType !== current.serviceType
        ) {
          return {
            kind: 'serviceMismatch',
            expected: slot.serviceType,
          } as const
        }
      }

      const slotChanged = nextSlotId !== current.bookingSlotId

      const verdict = evaluateBooking({
        now,
        candidate: timing,
        staff: {
          maxConcurrentEvents: calendar.maxConcurrentEvents,
          calendarTimeZone: calendar.calendarTimeZone,
        },
        availabilityRules: calendar.availabilityRules,
        existingAppointments: calendar.existingAppointments,
        searchRange: {
          from: new Date(occupied.start.getTime() - SUGGESTION_LOOKBACK_MS),
          until: new Date(occupied.end.getTime() + SUGGESTION_LOOKAHEAD_MS),
        },
        // The window this engagement is *already* counted against must not be
        // asked to find room for it a second time.
        bookingSlot: slotChanged && slot !== null ? toSlotLike(slot) : null,
        requestedSeats: 1,
        suggestionLimit: SUGGESTION_LIMIT,
        // The engagement being moved is not a conflict with itself.
        excludeAppointmentId: current.id,
      })

      if (!verdict.ok) {
        return {
          kind: 'refused',
          reasons: verdict.reasons,
          alternatives: verdict.alternatives,
          timeZone: calendar.calendarTimeZone,
        } as const
      }

      // Claim the destination first. A failure here has written nothing, so
      // returning is safe; had the old seat been released first, a refusal
      // would need a rollback to put it back.
      if (
        slotChanged &&
        slot !== null &&
        !(await claimSlotSeat(tx, slot, now))
      ) {
        return { kind: 'soldOut' } as const
      }

      if (slotChanged && current.bookingSlotId !== null) {
        await releaseSlotSeat(tx, current.bookingSlotId)
      }

      // Compare-and-swap on the status the evaluation was made against. If a
      // concierge cancelled the engagement while this transaction ran, the
      // count is zero and the throw rolls back both seat movements above —
      // this is precisely the case `ActionError` exists for, because returning
      // from inside `$transaction` would commit them.
      const moved = await tx.chefAppointment.updateMany({
        where: { id: current.id, status: current.status },
        data: {
          startsAt: timing.startsAt,
          endsAt: timing.endsAt,
          prepStartsAt: timing.prepStartsAt,
          travelBufferBeforeMinutes: timing.travelBufferBeforeMinutes,
          travelBufferAfterMinutes: timing.travelBufferAfterMinutes,
          bookingSlotId: nextSlotId,
          ...(input.guestCount === undefined
            ? {}
            : { guestCount: input.guestCount }),
          ...(input.accessNotes === undefined
            ? {}
            : { accessNotes: input.accessNotes }),
          ...(input.clientNotes === undefined
            ? {}
            : { clientNotes: input.clientNotes }),
          ...(input.address === undefined
            ? {}
            : {
                addressLine1: input.address.line1,
                addressLine2: input.address.line2 ?? null,
                city: input.address.city,
                region: input.address.region,
                postalCode: input.address.postalCode,
                country: input.address.country,
              }),
        },
      })

      if (moved.count !== 1) {
        throw new ActionError(
          'CONFLICT',
          'This engagement changed while you were moving it. Please reload and try again.'
        )
      }

      const refreshed = await tx.chefAppointment.findUniqueOrThrow({
        where: { id: current.id },
        select: APPOINTMENT_SELECT,
      })

      return { kind: 'moved', appointment: refreshed } as const
    })

    switch (outcome.kind) {
      case 'moved':
        return ok(toAppointmentView(outcome.appointment, staffCaller))

      case 'gone':
        return fail('NOT_FOUND', 'We could not find that engagement.')

      case 'terminal':
        return fail(
          'CONFLICT',
          `A ${outcome.status.toLowerCase().replace(/_/g, ' ')} engagement cannot be moved — please book a new one.`
        )

      case 'prepInvalid':
        return fail('VALIDATION', outcome.message, {
          prepStartsAt: [outcome.message],
        })

      case 'noChef':
        return fail('NOT_FOUND', 'We could not find that chef.')

      case 'noSlot':
        return fail('NOT_FOUND', 'We could not find that sitting.')

      case 'slotMismatch':
        return fail(
          'VALIDATION',
          'The times you chose fall outside the sitting you selected.',
          { startsAt: ['This time is not inside the sitting you chose.'] }
        )

      case 'serviceMismatch':
        return fail(
          'VALIDATION',
          'That sitting is reserved for a different kind of service.',
          {
            bookingSlotId: [
              `This sitting is for ${outcome.expected.toLowerCase().replace(/_/g, ' ')}.`,
            ],
          }
        )

      case 'soldOut':
        return fail(
          'CONFLICT',
          'That sitting was taken while you were moving the engagement. Please choose another.',
          { bookingSlotId: ['This sitting has just been taken.'] }
        )

      case 'refused':
        return conflictFailure(
          outcome.reasons,
          outcome.alternatives,
          staffCaller,
          outcome.timeZone,
          ctx.user.locale
        )

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

// =============================================================================
// 10. The state machine
// =============================================================================

/** The parsed shape every transition action hands to {@link performTransition}. */
interface TransitionRequest {
  readonly appointmentId: string
  readonly from: AppointmentStatus
  readonly to: AppointmentStatus
  readonly occurredAt?: Date | undefined
  readonly reason?: string | undefined
  readonly cancelledById?: string | undefined
}

/**
 * Move one engagement through the state machine.
 *
 * Shared by {@link confirmAppointment}, {@link cancelAppointment},
 * {@link completeAppointment} and {@link transitionAppointment}, so all four
 * enforce the identical five things:
 *
 *  1. **Ownership.** `requireAppointmentOwnership` from `@/server/guards` — the
 *     household it belongs to, or the chef assigned to it, or `ADMIN`.
 *  2. **Privilege for the destination.** {@link minimumRoleToReach}. A
 *     household may withdraw its own booking and may do nothing else; a client
 *     may not mark their own dinner `COMPLETED` and conjure a review, and may
 *     not `CONFIRM` a request the kitchen has not accepted.
 *  3. **The transition itself**, via `checkStatusTransition` in the engine,
 *     which delegates to `APPOINTMENT_TRANSITIONS` in `@mannachef/validators`.
 *     The table is not restated here and is not second-guessed. It is checked
 *     against the status **read from the database**, not against the `from` the
 *     caller sent.
 *  4. **Optimistic concurrency.** `from` is the status the caller believed the
 *     engagement was in. A mismatch is a `CONFLICT`, and the update is a
 *     compare-and-swap on that same status, so two operators pressing
 *     "confirm" and "cancel" at the same instant cannot both win.
 *  5. **Seat accounting.** A cancellation or a no-show gives the window's seat
 *     back and reopens it if it had filled; a completion does not, because the
 *     window was used.
 *
 * No conflict evaluation runs here, and that is deliberate rather than an
 * omission. None of these moves changes when the engagement happens, and
 * `REQUESTED`, `CONFIRMED` and `IN_PROGRESS` are all in
 * `DEFAULT_BLOCKING_APPOINTMENT_STATUSES` — an engagement already occupies the
 * diary from the moment it is requested, so accepting it consumes nothing new.
 */
async function performTransition(
  ctx: { readonly db: PrismaClient; readonly user: AuthenticatedUser },
  input: TransitionRequest
): Promise<ActionResult<AppointmentView>> {
  const staffCaller = isStaff(ctx.user)

  const owned = await requireAppointmentOwnership(ctx.user, input.appointmentId)

  if (!owned.ok) {
    return owned
  }

  if (!hasRoleAtLeast(ctx.user.role, minimumRoleToReach(input.to))) {
    return fail(
      'FORBIDDEN',
      'Only the kitchen can record that. Please contact your concierge.'
    )
  }

  if (
    !staffCaller &&
    input.to === 'CANCELLED' &&
    !CLIENT_CHANGEABLE_STATUSES.includes(owned.data.status)
  ) {
    return fail(
      'CONFLICT',
      'This engagement is already under way. Please telephone us to cancel it.'
    )
  }

  if (owned.data.status !== input.from) {
    return fail(
      'CONFLICT',
      'This engagement has already moved on. Please reload and try again.',
      {
        from: [
          `It is now ${owned.data.status.toLowerCase().replace(/_/g, ' ')}.`,
        ],
      }
    )
  }

  const transition = checkStatusTransition(owned.data.status, input.to)

  if (!transition.ok) {
    return conflictFailure(
      transition.reasons,
      [],
      staffCaller,
      'UTC',
      ctx.user.locale
    )
  }

  const occurredAt = input.occurredAt ?? new Date()

  const outcome = await runSerializable(ctx.db, RACE_MESSAGE, async (tx) => {
    const current = await tx.chefAppointment.findUnique({
      where: { id: owned.data.id },
      select: { id: true, status: true, bookingSlotId: true },
    })

    if (current === null) {
      return { kind: 'gone' } as const
    }

    // `UncheckedUpdateManyInput` rather than `UpdateManyMutationInput`: the
    // checked variant deliberately omits foreign-key scalars, and
    // `cancelledById` is one. A `connect` is not available on `updateMany`,
    // and switching to `update` would give up the compare-and-swap below.
    const data: Prisma.ChefAppointmentUncheckedUpdateManyInput = {
      status: input.to,
    }

    if (input.to === 'CONFIRMED') {
      data.confirmedAt = occurredAt
    }

    if (input.to === 'COMPLETED') {
      data.completedAt = occurredAt
    }

    if (input.to === 'CANCELLED') {
      data.cancelledAt = occurredAt
      data.cancellationReason = input.reason ?? null
      // Attribution is the *caller*, never a `cancelledById` the caller sent.
      // The schema accepts the field so an admin tool can record a back-office
      // cancellation on somebody's behalf; honouring it from a guest would let
      // anybody pin their own change of mind on the chef.
      data.cancelledById = staffCaller
        ? (input.cancelledById ?? ctx.user.id)
        : ctx.user.id
    }

    const moved = await tx.chefAppointment.updateMany({
      where: { id: current.id, status: input.from },
      data,
    })

    if (moved.count !== 1) {
      return { kind: 'raced' } as const
    }

    // A cancelled or missed engagement frees its window; a completed one does
    // not, because the window was used. This mirrors
    // `DEFAULT_BLOCKING_APPOINTMENT_STATUSES` exactly.
    if (
      current.bookingSlotId !== null &&
      (input.to === 'CANCELLED' || input.to === 'NO_SHOW')
    ) {
      await releaseSlotSeat(tx, current.bookingSlotId)
    }

    const refreshed = await tx.chefAppointment.findUniqueOrThrow({
      where: { id: current.id },
      select: APPOINTMENT_SELECT,
    })

    return { kind: 'moved', appointment: refreshed } as const
  })

  switch (outcome.kind) {
    case 'moved':
      return ok(toAppointmentView(outcome.appointment, staffCaller))

    case 'gone':
      return fail('NOT_FOUND', 'We could not find that engagement.')

    case 'raced':
      return fail(
        'CONFLICT',
        'This engagement changed while you were working on it. Please reload and try again.'
      )

    default: {
      const exhaustive: never = outcome
      return exhaustive
    }
  }
}

/**
 * Accept a request. `REQUESTED → CONFIRMED`.
 *
 * `from` must be the status the caller saw, so a concierge confirming a
 * request a colleague cancelled a second earlier is refused rather than
 * resurrecting it.
 */
export const confirmAppointment = withAction(
  {
    name: 'appointment.confirm',
    auth: 'CHEF_STAFF',
    input: appointmentConfirmSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => performTransition(ctx, input)
)

/**
 * Withdraw an engagement. `REQUESTED | CONFIRMED | IN_PROGRESS → CANCELLED`.
 *
 * The input is `appointmentCancelInputSchema` from `@mannachef/api-contract` —
 * the very schema the `/api/appointments/:id/cancel` route declares — so the
 * Server Action and the HTTP endpoint cannot drift into accepting different
 * payloads. It requires a reason, refuses a future `occurredAt`, and narrows
 * the transition to `CANCELLED` so a mistargeted call cannot confirm anything.
 *
 * `auth: 'SESSION'` rather than `'CHEF_STAFF'`: a household withdrawing its own
 * booking is the common case. {@link performTransition} then bounds that to the
 * statuses a guest may withdraw from.
 */
export const cancelAppointment = withAction(
  {
    name: 'appointment.cancel',
    auth: 'SESSION',
    input: appointmentCancelInputSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => performTransition(ctx, input)
)

/**
 * Close out a service. `CONFIRMED | IN_PROGRESS → COMPLETED`.
 *
 * `CONFIRMED → COMPLETED` is legal in the table on purpose: a chef who cooked
 * a whole dinner without touching their phone can still close it out without
 * inventing an `IN_PROGRESS` they never recorded.
 *
 * The seat is *not* returned to the window. It was used.
 */
export const completeAppointment = withAction(
  {
    name: 'appointment.complete',
    auth: 'CHEF_STAFF',
    input: appointmentCompleteSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => performTransition(ctx, input)
)

/**
 * Any legal move, for the admin OS.
 *
 * The general form of the three above — it is how `IN_PROGRESS` and `NO_SHOW`
 * are recorded, neither of which has a dedicated button worth its own action.
 * It enforces exactly the same five checks, because it goes through exactly the
 * same {@link performTransition}; it is a wider door, not a softer one.
 */
export const transitionAppointment = withAction(
  {
    name: 'appointment.transition',
    auth: 'CHEF_STAFF',
    input: appointmentStatusTransitionSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => performTransition(ctx, input)
)

// =============================================================================
// 11. Soft holds
// =============================================================================

/**
 * Freeze a window while a guest decides.
 *
 * ## Why this is staff-only
 *
 * `BookingSlot` has no holder column. The database can record *that* a window
 * is held and *until when*, but not *by whom* — so it cannot tell one guest's
 * hold from another's. Two consequences follow, and both point the same way:
 *
 *  - A guest-reachable hold would let any signed-in caller freeze any chef's
 *    Saturday evening, repeatedly, for nothing.
 *  - The holder could not consume their own hold. `checkCapacity` refuses a
 *    live hold to *everyone*, so the guest who placed it would be locked out of
 *    the window they were holding.
 *
 * A concierge placing a hold while a household decides on the telephone is
 * exactly what the column supports, and the expiry is what makes it safe. When
 * `BookingSlot` gains a `heldById`, this can open up and
 * {@link requestAppointment} can learn to consume the caller's own hold; until
 * then a live hold refuses everybody, which is the safe direction to be wrong
 * in.
 *
 * ## Why one conditional statement is enough here
 *
 * Placing a hold is the same TOCTOU shape as a booking — read `OPEN`, decide,
 * write `HELD` — but it touches exactly **one row**, so the conditional
 * `updateMany` below is sufficient on its own and no `Serializable`
 * transaction is opened. PostgreSQL re-evaluates the `WHERE` after taking the
 * row lock, so the loser of a race sees the winner's `HELD` and matches no
 * rows. A booking needs more than this because its conflict evaluation reads a
 * *range* of engagements that no single row lock covers.
 */
export const holdBookingSlot = withAction(
  {
    name: 'booking.holdSlot',
    auth: 'CHEF_STAFF',
    input: slotHoldSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => {
    const slot = await ctx.db.bookingSlot.findUnique({
      where: { id: input.bookingSlotId },
      select: BOOKING_SLOT_SELECT,
    })

    if (slot === null) {
      return fail('NOT_FOUND', 'We could not find that window.')
    }

    const permitted = await callerControlsDiary(
      ctx.db,
      ctx.user,
      slot.staffProfileId
    )

    if (!permitted.ok) {
      return permitted
    }

    const now = new Date()
    const holdsUntil = new Date(
      now.getTime() + input.holdMinutes * MS_PER_MINUTE
    )

    // `bookingSlotCreateSchema` states the rule — "a hold must lapse before the
    // window it is holding begins" — and it is restated here because that
    // schema never sees this payload. Clamping silently would be worse: a hold
    // that outlives its own window is a window nobody can book.
    if (holdsUntil.getTime() >= slot.startsAt.getTime()) {
      return fail(
        'VALIDATION',
        'A hold has to lapse before the window it is holding begins. Please choose a shorter hold.',
        { holdMinutes: ['This hold would outlast the window.'] }
      )
    }

    const held = await ctx.db.bookingSlot.updateMany({
      where: {
        id: slot.id,
        status: 'OPEN',
        bookedCount: { lt: slot.capacity },
        OR: [{ holdsUntil: null }, { holdsUntil: { lte: now } }],
      },
      data: { status: 'HELD', holdsUntil },
    })

    if (held.count !== 1) {
      return fail(
        'CONFLICT',
        'That window is not open — it may already be held, full, or withdrawn.'
      )
    }

    return ok({ id: slot.id, status: 'HELD' as const, holdsUntil })
  }
)

/**
 * Let a held window go before its hold lapses.
 *
 * Nothing depends on this running: the engine reads `holdsUntil` against the
 * instant of each decision, so a lapsed hold already consumes nothing. What
 * this buys is immediacy — the window returns to the public search now rather
 * than when the sweep next runs.
 *
 * Guarded on `status: 'HELD'` so releasing an already-released window is a
 * refusal rather than a way to reopen one that has since been withdrawn.
 */
export const releaseBookingSlot = withAction(
  {
    name: 'booking.releaseSlot',
    auth: 'CHEF_STAFF',
    input: slotIdSchema,
    revalidatePaths: APPOINTMENT_PATHS,
    revalidateTags: APPOINTMENT_TAGS,
  },
  async (ctx, input) => {
    const slot = await ctx.db.bookingSlot.findUnique({
      where: { id: input.bookingSlotId },
      select: { id: true, staffProfileId: true },
    })

    if (slot === null) {
      return fail('NOT_FOUND', 'We could not find that window.')
    }

    const permitted = await callerControlsDiary(
      ctx.db,
      ctx.user,
      slot.staffProfileId
    )

    if (!permitted.ok) {
      return permitted
    }

    const released = await ctx.db.bookingSlot.updateMany({
      where: { id: slot.id, status: 'HELD' },
      data: { status: 'OPEN', holdsUntil: null },
    })

    if (released.count !== 1) {
      return fail('CONFLICT', 'That window is not being held.')
    }

    return ok({ id: slot.id, status: 'OPEN' as const })
  }
)

/**
 * Diary-level ownership: a `CHEF_STAFF` controls their own calendar, `ADMIN`
 * and above control any.
 *
 * The mirror of `requireStaffScope` in `availability.ts`. It denies with
 * `FORBIDDEN` for the same reason: every caller here has already passed
 * `auth: 'CHEF_STAFF'`, and the existence of a `StaffProfile` is already public
 * through the staff directory, so there is no oracle to protect.
 */
async function callerControlsDiary(
  db: Prisma.TransactionClient,
  user: AuthenticatedUser,
  staffProfileId: string
): Promise<ActionResult<{ readonly staffProfileId: string }>> {
  if (user.staffProfileId !== null && user.staffProfileId === staffProfileId) {
    return ok({ staffProfileId })
  }

  if (!hasRoleAtLeast(user.role, 'ADMIN')) {
    return fail(
      'FORBIDDEN',
      'You may only change your own calendar. An administrator can change anyone’s.'
    )
  }

  const staff = await db.staffProfile.findUnique({
    where: { id: staffProfileId },
    select: { id: true },
  })

  if (staff === null) {
    return fail('NOT_FOUND', 'We could not find that chef.')
  }

  return ok({ staffProfileId: staff.id })
}

// =============================================================================
// 12. Reads
// =============================================================================

/**
 * One engagement, in full, for whoever is entitled to it.
 *
 * The ownership guard decides *whether*; {@link toAppointmentView} decides
 * *what*. A household reading its own dinner gets everything about it except
 * `chefNotes`.
 */
export const getAppointment = withAction(
  {
    name: 'appointment.detail',
    auth: 'SESSION',
    input: appointmentIdSchema,
  },
  async (ctx, input) => {
    const owned = await requireAppointmentOwnership(
      ctx.user,
      input.appointmentId
    )

    if (!owned.ok) {
      return owned
    }

    const row = await ctx.db.chefAppointment.findUnique({
      where: { id: owned.data.id },
      select: APPOINTMENT_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that engagement.')
    }

    return ok(toAppointmentView(row, isStaff(ctx.user)))
  }
)

/**
 * The engagements a caller is entitled to, filtered and paged.
 *
 * ## The filter is a request, not a permission
 *
 * `appointmentFilterSchema` lets a caller name a `clientProfileId` and a
 * `staffProfileId`. Both are **overridden** below rather than trusted, which is
 * the whole difference between a filter and an access-control decision:
 *
 *  - A `CLIENT` is pinned to their own `ClientProfile`, whatever they asked
 *    for. A client with no household profile gets an empty page rather than
 *    everybody's dinners.
 *  - A `CHEF_STAFF` below `ADMIN` is pinned to their own `StaffProfile`. A
 *    chef with no staff profile — staff role, no diary — likewise gets an empty
 *    page rather than the run of the house.
 *  - `ADMIN` and above are honoured as asked.
 *
 * `chefNotes` is nulled for anybody below `CHEF_STAFF`, per
 * {@link toAppointmentView}.
 */
export const listAppointments = withAction(
  {
    name: 'appointment.list',
    auth: 'SESSION',
    input: appointmentFilterSchema,
  },
  async (ctx, input) => {
    const staffCaller = isStaff(ctx.user)
    const where: Prisma.ChefAppointmentWhereInput = {}

    if (hasRoleAtLeast(ctx.user.role, 'ADMIN')) {
      if (input.clientProfileId !== undefined) {
        where.clientProfileId = input.clientProfileId
      }

      if (input.staffProfileId !== undefined) {
        where.staffProfileId = input.staffProfileId
      }
    } else if (staffCaller) {
      if (ctx.user.staffProfileId === null) {
        return ok({
          items: [],
          meta: pageMetaFor(input.page, input.pageSize, 0),
        })
      }

      where.staffProfileId = ctx.user.staffProfileId

      if (input.clientProfileId !== undefined) {
        where.clientProfileId = input.clientProfileId
      }
    } else {
      if (ctx.user.clientProfileId === null) {
        return ok({
          items: [],
          meta: pageMetaFor(input.page, input.pageSize, 0),
        })
      }

      where.clientProfileId = ctx.user.clientProfileId

      if (input.staffProfileId !== undefined) {
        where.staffProfileId = input.staffProfileId
      }
    }

    if (input.bookingSlotId !== undefined) {
      where.bookingSlotId = input.bookingSlotId
    }

    if (input.status !== undefined) {
      where.status = input.status
    }

    if (input.serviceType !== undefined) {
      where.serviceType = input.serviceType
    }

    const startsAt: Prisma.DateTimeFilter = {}

    if (input.startsFrom !== undefined) {
      startsAt.gte = input.startsFrom
    }

    if (input.startsUntil !== undefined) {
      startsAt.lt = input.startsUntil
    }

    if (startsAt.gte !== undefined || startsAt.lt !== undefined) {
      where.startsAt = startsAt
    }

    const { skip, take } = paginationToSkipTake(input)

    const [rows, total] = await Promise.all([
      ctx.db.chefAppointment.findMany({
        where,
        orderBy: { startsAt: input.sortDirection },
        skip,
        take,
        select: APPOINTMENT_SELECT,
      }),
      ctx.db.chefAppointment.count({ where }),
    ])

    return ok({
      items: rows.map((row) => toAppointmentView(row, staffCaller)),
      meta: pageMetaFor(input.page, input.pageSize, total),
    })
  }
)

// =============================================================================
// 13. Dispatch
// =============================================================================

/**
 * One row on the dispatch board.
 *
 * Not an {@link AppointmentView}: dispatch answers "who is going where, and
 * who do I ring when I am late", so it carries the household's name and
 * telephone number and drops the money, the menu and the audit trail.
 *
 * Every row returned is one the caller is assigned to or administers — the
 * query is pinned to the caller's own `StaffProfile` below `ADMIN` — so the
 * telephone number is reaching the person who is about to knock on the door.
 */
interface DispatchEntry {
  readonly id: string
  readonly status: AppointmentStatus
  readonly serviceType: ServiceType
  readonly startsAt: Date
  readonly endsAt: Date
  readonly prepStartsAt: Date | null
  readonly travelBufferBeforeMinutes: number
  readonly travelBufferAfterMinutes: number
  readonly guestCount: number
  readonly clientProfileId: string
  readonly clientName: string | null
  readonly clientPhone: string | null
  readonly staffProfileId: string
  readonly staffName: string | null
  readonly address: {
    readonly line1: string | null
    readonly line2: string | null
    readonly city: string | null
    readonly region: string | null
    readonly postalCode: string | null
    readonly country: string | null
  } | null
  readonly accessNotes: string | null
  readonly chefNotes: string | null
}

const DISPATCH_SELECT = {
  id: true,
  status: true,
  serviceType: true,
  startsAt: true,
  endsAt: true,
  prepStartsAt: true,
  travelBufferBeforeMinutes: true,
  travelBufferAfterMinutes: true,
  guestCount: true,
  clientProfileId: true,
  staffProfileId: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  country: true,
  accessNotes: true,
  chefNotes: true,
  clientProfile: {
    select: {
      displayName: true,
      preferredName: true,
      phone: true,
      user: { select: { name: true, phone: true } },
    },
  },
  staffProfile: { select: { user: { select: { name: true } } } },
} satisfies Prisma.ChefAppointmentSelect

type DispatchRow = Prisma.ChefAppointmentGetPayload<{
  select: typeof DISPATCH_SELECT
}>

function toDispatchEntry(row: DispatchRow): DispatchEntry {
  const hasAddress =
    row.addressLine1 !== null ||
    row.addressLine2 !== null ||
    row.city !== null ||
    row.region !== null ||
    row.postalCode !== null ||
    row.country !== null

  return {
    id: row.id,
    status: row.status,
    serviceType: row.serviceType,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    prepStartsAt: row.prepStartsAt,
    travelBufferBeforeMinutes: row.travelBufferBeforeMinutes,
    travelBufferAfterMinutes: row.travelBufferAfterMinutes,
    guestCount: row.guestCount,
    clientProfileId: row.clientProfileId,
    clientName:
      row.clientProfile.preferredName ??
      row.clientProfile.displayName ??
      row.clientProfile.user.name,
    clientPhone: row.clientProfile.phone ?? row.clientProfile.user.phone,
    staffProfileId: row.staffProfileId,
    staffName: row.staffProfile.user.name,
    address: hasAddress
      ? {
          line1: row.addressLine1,
          line2: row.addressLine2,
          city: row.city,
          region: row.region,
          postalCode: row.postalCode,
          country: row.country,
        }
      : null,
    accessNotes: row.accessNotes,
    chefNotes: row.chefNotes,
  }
}

/** How far ahead the dispatch board looks when the caller names no range. */
const DISPATCH_DEFAULT_HORIZON_MS = 7 * MS_PER_DAY

/**
 * The dispatch board: what needs a decision, what is happening, and what has
 * quietly run over.
 *
 * Four buckets, because they call for four different actions:
 *
 *  - **`awaitingConfirmation`** — `REQUESTED`. Somebody has to say yes.
 *  - **`inProgress`** — `IN_PROGRESS`. A chef is in a kitchen right now.
 *  - **`upcoming`** — `CONFIRMED` and still ahead. The run sheet.
 *  - **`overdue`** — `CONFIRMED` or `IN_PROGRESS` and already finished by the
 *    clock. These are the ones that fall through the cracks: a dinner that
 *    ended on Saturday and was never closed out holds its window's seat for
 *    ever and never becomes reviewable.
 *
 * A `CHEF_STAFF` below `ADMIN` sees only their own engagements — the filter is
 * overridden, not defaulted. An `ADMIN` sees everyone's, or one chef's on
 * request.
 */
export const getDispatchQueue = withAction(
  {
    name: 'appointment.dispatchQueue',
    auth: 'CHEF_STAFF',
    input: dispatchQueueSchema,
  },
  async (ctx, input) => {
    const now = new Date()

    const from = input.range?.start ?? now
    const until =
      input.range?.end ?? new Date(now.getTime() + DISPATCH_DEFAULT_HORIZON_MS)

    let staffProfileId: string | undefined

    if (hasRoleAtLeast(ctx.user.role, 'ADMIN')) {
      staffProfileId = input.staffProfileId
    } else {
      if (ctx.user.staffProfileId === null) {
        return ok({
          from,
          until,
          awaitingConfirmation: [],
          inProgress: [],
          upcoming: [],
          overdue: [],
          counts: {
            awaitingConfirmation: 0,
            inProgress: 0,
            upcoming: 0,
            overdue: 0,
          },
        })
      }

      // Overridden, not defaulted: a chef asking for a colleague's board gets
      // their own, not a `FORBIDDEN` that tells them the colleague exists.
      staffProfileId = ctx.user.staffProfileId
    }

    // The board looks backwards as well as forwards. `overdue` is by
    // definition in the past — an engagement that finished on Saturday and was
    // never closed out — so the lower bound is applied to `endsAt` and reaches
    // a horizon *behind* `from`, while `startsAt` bounds the far end.
    const where: Prisma.ChefAppointmentWhereInput = {
      status: { in: ['REQUESTED', 'CONFIRMED', 'IN_PROGRESS'] },
      endsAt: { gte: new Date(from.getTime() - DISPATCH_DEFAULT_HORIZON_MS) },
      startsAt: { lt: until },
    }

    if (staffProfileId !== undefined) {
      where.staffProfileId = staffProfileId
    }

    const rows = await ctx.db.chefAppointment.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      select: DISPATCH_SELECT,
    })

    const awaitingConfirmation: DispatchEntry[] = []
    const inProgress: DispatchEntry[] = []
    const upcoming: DispatchEntry[] = []
    const overdue: DispatchEntry[] = []

    for (const row of rows) {
      const entry = toDispatchEntry(row)
      const hasRunOver = row.endsAt.getTime() < now.getTime()

      if (hasRunOver && row.status !== 'REQUESTED') {
        overdue.push(entry)
        continue
      }

      switch (row.status) {
        case 'REQUESTED':
          awaitingConfirmation.push(entry)
          break

        case 'IN_PROGRESS':
          inProgress.push(entry)
          break

        case 'CONFIRMED':
          upcoming.push(entry)
          break

        default:
          break
      }
    }

    return ok({
      from,
      until,
      awaitingConfirmation,
      inProgress,
      upcoming,
      overdue,
      counts: {
        awaitingConfirmation: awaitingConfirmation.length,
        inProgress: inProgress.length,
        upcoming: upcoming.length,
        overdue: overdue.length,
      },
    })
  }
)
