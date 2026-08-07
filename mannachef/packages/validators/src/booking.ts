// mannachef/packages/validators/src/booking.ts

/**
 * Calendar domain — a chef's availability, the bookable windows materialised
 * from it, and the engagements booked into those windows.
 *
 * Mirrors `ChefAvailability`, `BookingSlot`, `ChefAppointment`, and
 * `AppointmentMenuItem` in `mannachef/packages/db/prisma/schema.prisma`. Field
 * names, optionality, and enum values are taken from that file verbatim.
 *
 * Every temporal rule in this file states itself in its own error message: a
 * guest who is told "the end must fall after the start" can fix their booking
 * without guessing what the calendar objected to.
 *
 * No runtime dependency on `@prisma/client` — enums come from `./enums`.
 */

import { z } from 'zod'

import {
  addressSchema,
  buildUpdateSchema,
  crossField,
  crossFieldMixed,
  cuidSchema,
  currencySchema,
  durationMinutesSchema,
  endMinutesFromMidnightSchema,
  hasUniqueValues,
  isoDateTimeSchema,
  MAX_DURATION_MINUTES,
  MAX_NOTE_LENGTH,
  minutesFromMidnightSchema,
  moneyCentsSchema,
  MS_PER_DAY,
  paginationSchema,
  queryFlag,
  withTemporalCoercion,
} from './common'
import {
  appointmentStatusSchema,
  bookingSlotStatusSchema,
  serviceTypeSchema,
} from './enums'
import type {
  AppointmentStatus,
  AvailabilityRuleKind,
  ServiceType,
} from './enums'

// =============================================================================
// Limits
// =============================================================================

/**
 * Milliseconds in one minute — every duration comparison below runs through it.
 *
 * Its daily counterpart is `MS_PER_DAY`, which lives in `common.ts` because the
 * billing and CRM modules need it too.
 */
const MS_PER_MINUTE = 60_000

/** Nothing on the calendar is shorter than a quarter of an hour. */
export const MIN_APPOINTMENT_MINUTES = 15

/** Travel either side of an engagement, in minutes. Eight hours is the ceiling. */
export const MAX_TRAVEL_BUFFER_MINUTES = 480

/** Preparation may begin at most a day before service. */
export const MAX_PREP_LEAD_MINUTES = MAX_DURATION_MINUTES

/** Guests at one engagement. Beyond this it is catering, quoted by hand. */
export const MIN_GUEST_COUNT = 1
export const MAX_GUEST_COUNT = 200

/** Seats in a single bookable window. */
export const MAX_SLOT_CAPACITY = 50

/** How far ahead recurring generation may run in one pass. Half a year. */
export const MAX_GENERATION_HORIZON_WEEKS = 26

/** Hard ceiling on rows one generation pass may create. */
export const MAX_GENERATED_SLOTS = 500

/** Dates a single generation pass may be told to skip. */
export const MAX_SKIP_DATES = 60

/** Gap between consecutive generated slots, in minutes. */
export const MAX_SLOT_GAP_MINUTES = 240

/** Distinct dishes on one engagement's menu. */
export const MAX_APPOINTMENT_MENU_ITEMS = 40

/** Portions of a single dish. */
export const MAX_MENU_ITEM_QUANTITY = 200

/** Courses in a single service. */
export const MAX_COURSE_ORDER = 20

/** `ChefAvailability.reason` is `VarChar(280)`. */
export const MAX_REASON_LENGTH = 280

/**
 * `MAX_NOTE_LENGTH` was declared and exported here, and `referral.ts` carried
 * an identical unexported shadow of it. Two declarations of one rule meant the
 * barrel published whichever of them `export *` reached first, and keeping the
 * pair in step was a manual chore. MCV-010 moved the single declaration to
 * `./common`, which is where the import at the head of this file comes from.
 *
 * It is deliberately *not* re-exported from here. `export * from './common'` in
 * the barrel already publishes it, so `@mannachef/validators` still exports
 * `MAX_NOTE_LENGTH` with the same value; re-exporting it would put two paths to
 * one binding through the barrel for no gain.
 */

/** `ChefAvailability.timeZone` / `StaffProfile.calendarTimeZone` are `VarChar(64)`. */
const MAX_TIME_ZONE_LENGTH = 64

/** Where the whole platform lives until we open a second city. */
export const DEFAULT_TIME_ZONE = 'America/Toronto'

// =============================================================================
// Calendar primitives
// =============================================================================

/**
 * True when the runtime recognises the identifier as an IANA time zone.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` for anything it cannot resolve,
 * which is a far better authority than a regular expression.
 */
function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * An IANA time zone identifier. Availability is written in the chef's local
 * wall-clock time, so the zone travels with the rule.
 *
 * Defined here rather than in `common.ts` because the calendar is its only
 * consumer; if a second domain needs it, it moves rather than being copied.
 */
export const timeZoneSchema = z
  .string({ error: 'Please choose a time zone.' })
  .trim()
  .min(1, { error: 'Please choose a time zone.' })
  .max(MAX_TIME_ZONE_LENGTH, {
    error: 'That time zone identifier is longer than our records allow.',
  })
  .refine(isSupportedTimeZone, {
    error:
      'We do not recognise that time zone — please choose one such as America/Toronto.',
  })
  .default(DEFAULT_TIME_ZONE)
export type TimeZone = z.infer<typeof timeZoneSchema>

/**
 * Sunday-indexed day of the week, matching `ChefAvailability.dayOfWeek`
 * and JavaScript's `Date.prototype.getDay()`.
 */
export const dayOfWeekSchema = z
  .int({ error: 'Please choose a day of the week.' })
  .min(0, { error: 'Days of the week run from 0 (Sunday) to 6 (Saturday).' })
  .max(6, { error: 'Days of the week run from 0 (Sunday) to 6 (Saturday).' })
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>

/** Minutes of travel either side of an engagement. Zero is perfectly valid. */
const travelBufferSchema = z
  .int({ error: 'Please give the travel time in whole minutes.' })
  .min(0, { error: 'Travel time cannot be less than none.' })
  .max(MAX_TRAVEL_BUFFER_MINUTES, {
    error: 'Travel time either side of an engagement tops out at eight hours.',
  })

// =============================================================================
// Shared temporal predicates
// =============================================================================

/**
 * ## Why every cross-field rule below is attached with `.check(crossField(…))`
 *
 * In zod 4 an object-level `.refine()` runs even when one of the object's own
 * fields has already failed, and it is handed the *raw* value for that field.
 * `isoDateTimeSchema` is a `z.ZodPipe` (union → transform → refine), and a
 * failing `ZodPipe` records its issue with `continue: true`, so it does not
 * abort the parent object the way a plain `z.number()` would.
 *
 * The consequence was a crash rather than a validation error:
 * `bookingSlotFilterSchema.safeParse({ startsFrom: 'foo', startsUntil: 'bar' })`
 * threw `TypeError: value.startsUntil.getTime is not a function`. Over GET that
 * is an HTTP 500 from a two-character query string.
 *
 * `crossField` (see `common.ts`) fixes both halves: it declares which fields a
 * rule reads, suppresses the rule when one of them has already produced an
 * issue, and runs the predicate only once every declared field is present and
 * of the right runtime type. The predicates below keep their `undefined`
 * guards so they remain callable from a server action on a merged row, but the
 * helper means those guards are no longer what stands between a typo and a 500.
 */

interface Window {
  readonly startsAt?: Date | undefined
  readonly endsAt?: Date | undefined
}

function windowEndsAfterItBegins(window: Window): boolean {
  if (window.startsAt === undefined || window.endsAt === undefined) {
    return true
  }

  return window.endsAt.getTime() > window.startsAt.getTime()
}

function windowIsLongEnough(window: Window): boolean {
  if (window.startsAt === undefined || window.endsAt === undefined) {
    return true
  }

  return (
    window.endsAt.getTime() - window.startsAt.getTime() >=
    MIN_APPOINTMENT_MINUTES * MS_PER_MINUTE
  )
}

function windowFitsInOneDay(window: Window): boolean {
  if (window.startsAt === undefined || window.endsAt === undefined) {
    return true
  }

  return (
    window.endsAt.getTime() - window.startsAt.getTime() <=
    MAX_DURATION_MINUTES * MS_PER_MINUTE
  )
}

const WINDOW_ORDER_ERROR =
  'The end of the window must fall after its start — please choose a later finish.'
const WINDOW_TOO_SHORT_ERROR = `Nothing on our calendar runs for less than ${MIN_APPOINTMENT_MINUTES} minutes — please lengthen the window.`
const WINDOW_TOO_LONG_ERROR =
  'A single engagement cannot run longer than twenty-four hours — please split it across two days.'

interface MinuteWindow {
  readonly startMinute?: number | undefined
  readonly endMinute?: number | undefined
}

function minuteWindowClosesAfterItOpens(window: MinuteWindow): boolean {
  if (window.startMinute === undefined || window.endMinute === undefined) {
    return true
  }

  return window.endMinute > window.startMinute
}

const MINUTE_WINDOW_ORDER_ERROR =
  'An availability window must close after it opens — set the closing time later than the opening time.'

interface EffectiveRange {
  readonly effectiveFrom?: Date | undefined
  readonly effectiveUntil?: Date | undefined
}

function effectiveRangeIsOrdered(range: EffectiveRange): boolean {
  if (range.effectiveFrom === undefined || range.effectiveUntil === undefined) {
    return true
  }

  return range.effectiveUntil.getTime() > range.effectiveFrom.getTime()
}

const EFFECTIVE_RANGE_ERROR =
  'The date this rule stops applying must fall after the date it starts applying.'

// =============================================================================
// 1. Chef availability
// =============================================================================

/**
 * Everything about an availability rule that may be edited after it is written.
 *
 * Split out from `availabilityBaseShape` so `chefAvailabilityUpdateSchema` can be
 * built from a shape rather than by carving `staffProfileId` back off an
 * assembled object — `buildUpdateSchema` needs the raw shape in order to strip
 * the `.default(...)`s before making the fields optional.
 */
const availabilityWindowShape = {
  /** Minutes from local midnight. `540` is 09:00. */
  startMinute: minutesFromMidnightSchema,
  /** Minutes from local midnight; `1440` closes the window at midnight. */
  endMinute: endMinutesFromMidnightSchema,
  timeZone: timeZoneSchema,
  effectiveFrom: isoDateTimeSchema.optional(),
  effectiveUntil: isoDateTimeSchema.optional(),
  /** `true` subtracts this window from the calendar instead of adding it. */
  isBlackout: z
    .boolean({
      error: 'Please say whether this window opens or closes the diary.',
    })
    .default(false),
  reason: z
    .string({ error: 'Please give a reason.' })
    .trim()
    .max(MAX_REASON_LENGTH, {
      error: `Please keep the reason to ${MAX_REASON_LENGTH} characters or fewer.`,
    })
    .optional(),
  note: z
    .string({ error: 'Please add a note.' })
    .trim()
    .max(MAX_NOTE_LENGTH, {
      error: `Please keep the note to ${MAX_NOTE_LENGTH} characters or fewer.`,
    })
    .optional(),
} as const

/** The window, plus the chef it belongs to. Only a create payload names the chef. */
const availabilityBaseShape = {
  staffProfileId: cuidSchema,
  ...availabilityWindowShape,
} as const

/**
 * `reason` is typed `unknown` rather than `string | undefined` because this
 * predicate is reached through `crossField`'s raw view of the object: the rule
 * has to *fire* when the reason is absent, so `reason` cannot be a declared
 * dependency (a declared dependency that is absent skips the check). The
 * `typeof` test below reproduces the original `value.reason !== undefined &&
 * value.reason.length > 0` exactly — a non-string reason has no `.length`, so
 * the old expression was already false for it — without reading `.length` off
 * a value that might be `null`.
 */
function blackoutCarriesAReason(value: {
  readonly isBlackout?: boolean | undefined
  readonly reason?: unknown
}): boolean {
  if (value.isBlackout !== true) {
    return true
  }

  return typeof value.reason === 'string' && value.reason.length > 0
}

const BLACKOUT_REASON_ERROR =
  'Please note why this window is closed, so the concierge can explain it.'

/**
 * A recurring weekly availability rule — `ChefAvailability` with
 * `kind = RECURRING_WEEKLY`.
 *
 * The literal is checked against the enum at compile time so the two can never
 * drift apart, without pulling the enum's runtime value into the branch.
 */
export const chefAvailabilityCreateSchema = z
  .object({
    kind: z
      .literal('RECURRING_WEEKLY' satisfies AvailabilityRuleKind, {
        error: 'This rule repeats every week.',
      })
      .default('RECURRING_WEEKLY'),
    dayOfWeek: dayOfWeekSchema,
    ...availabilityBaseShape,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startMinute', 'endMinute'],
        as: 'number',
        error: MINUTE_WINDOW_ORDER_ERROR,
        path: ['endMinute'],
      },
      (values) => minuteWindowClosesAfterItOpens(values)
    ),
    crossField(
      {
        deps: ['effectiveFrom', 'effectiveUntil'],
        as: 'date',
        error: EFFECTIVE_RANGE_ERROR,
        path: ['effectiveUntil'],
      },
      (values) => effectiveRangeIsOrdered(values)
    ),
    crossField(
      {
        deps: ['isBlackout'],
        as: 'boolean',
        error: BLACKOUT_REASON_ERROR,
        path: ['reason'],
      },
      ({ isBlackout }, raw) =>
        blackoutCarriesAReason({ isBlackout, reason: raw.reason })
    )
  )
export type ChefAvailabilityCreateInput = z.infer<
  typeof chefAvailabilityCreateSchema
>
export type ChefAvailabilityCreateRawInput = z.input<
  typeof chefAvailabilityCreateSchema
>

/**
 * A single-date exception — `ChefAvailability` with `kind = DATE_OVERRIDE`.
 * An override always wins over the recurring rules underneath it.
 */
export const availabilityOverrideSchema = z
  .object({
    kind: z
      .literal('DATE_OVERRIDE' satisfies AvailabilityRuleKind, {
        error: 'This rule covers a single date.',
      })
      .default('DATE_OVERRIDE'),
    /** Stored as `@db.Date`; only the calendar date is retained. */
    specificDate: isoDateTimeSchema,
    ...availabilityBaseShape,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startMinute', 'endMinute'],
        as: 'number',
        error: MINUTE_WINDOW_ORDER_ERROR,
        path: ['endMinute'],
      },
      (values) => minuteWindowClosesAfterItOpens(values)
    ),
    crossField(
      {
        deps: ['effectiveFrom', 'effectiveUntil'],
        as: 'date',
        error: EFFECTIVE_RANGE_ERROR,
        path: ['effectiveUntil'],
      },
      (values) => effectiveRangeIsOrdered(values)
    ),
    crossField(
      {
        deps: ['isBlackout'],
        as: 'boolean',
        error: BLACKOUT_REASON_ERROR,
        path: ['reason'],
      },
      ({ isBlackout }, raw) =>
        blackoutCarriesAReason({ isBlackout, reason: raw.reason })
    ),
    crossField(
      {
        deps: ['specificDate', 'effectiveFrom'],
        as: 'date',
        error:
          'The date this override covers must fall on or after the date the rule starts applying.',
        path: ['specificDate'],
      },
      ({ specificDate, effectiveFrom }) =>
        specificDate.getTime() >= effectiveFrom.getTime()
    ),
    crossField(
      {
        deps: ['specificDate', 'effectiveUntil'],
        as: 'date',
        error:
          'The date this override covers must fall on or before the date the rule stops applying.',
        path: ['specificDate'],
      },
      ({ specificDate, effectiveUntil }) =>
        specificDate.getTime() <= effectiveUntil.getTime()
    )
  )
export type AvailabilityOverrideInput = z.infer<
  typeof availabilityOverrideSchema
>
export type AvailabilityOverrideRawInput = z.input<
  typeof availabilityOverrideSchema
>

/** Either kind of availability rule, for endpoints that accept both. */
export const chefAvailabilityRuleSchema = z.union(
  [chefAvailabilityCreateSchema, availabilityOverrideSchema],
  {
    error:
      'An availability rule either repeats weekly on a chosen day or covers one specific date.',
  }
)
export type ChefAvailabilityRuleInput = z.infer<
  typeof chefAvailabilityRuleSchema
>
export type ChefAvailabilityRuleRawInput = z.input<
  typeof chefAvailabilityRuleSchema
>

/**
 * Editing an existing rule. The chef it belongs to is not editable — moving a
 * window between chefs is a delete and a create, so nothing is silently
 * reassigned.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * This schema used to be `z.object(availabilityBaseShape).omit(…).partial()`,
 * and `.partial()` does not stop a `.default(...)` from firing. Sending
 * `{ availabilityId, note: 'moved' }` therefore parsed to a payload that also
 * carried `isBlackout: false` and `timeZone: 'America/Toronto'`. Handed to
 * `prisma.update`, that turns a blackout into a bookable window — a chef who
 * closed their diary for a funeral would be offered to guests again because
 * somebody tidied up the note. `buildUpdateSchema` strips every default *before*
 * `.partial()`, so an untouched field stays untouched.
 *
 * `dayOfWeek` and `specificDate` are handed in as part of the shape rather than
 * bolted on afterwards, so `.partial()` makes them optional alongside the rest.
 */
export const chefAvailabilityUpdateSchema = buildUpdateSchema(
  {
    ...availabilityWindowShape,
    dayOfWeek: dayOfWeekSchema,
    specificDate: isoDateTimeSchema,
  },
  { requireKeys: { availabilityId: cuidSchema } }
)
  .check(
    crossField(
      {
        deps: ['startMinute', 'endMinute'],
        as: 'number',
        error: MINUTE_WINDOW_ORDER_ERROR,
        path: ['endMinute'],
      },
      (values) => minuteWindowClosesAfterItOpens(values)
    ),
    crossField(
      {
        deps: ['effectiveFrom', 'effectiveUntil'],
        as: 'date',
        error: EFFECTIVE_RANGE_ERROR,
        path: ['effectiveUntil'],
      },
      (values) => effectiveRangeIsOrdered(values)
    ),
    crossField(
      {
        deps: ['isBlackout'],
        as: 'boolean',
        error: BLACKOUT_REASON_ERROR,
        path: ['reason'],
      },
      ({ isBlackout }, raw) =>
        blackoutCarriesAReason({ isBlackout, reason: raw.reason })
    )
  )
  /**
   * Left as a plain `.refine()` deliberately: this rule reads only whether the
   * two fields are *present*, never their values, so it cannot throw on a
   * malformed payload and has nothing to narrow.
   */
  .refine(
    (value) =>
      value.dayOfWeek === undefined || value.specificDate === undefined,
    {
      error:
        'A rule either repeats on a weekday or covers one date — it cannot do both.',
      path: ['specificDate'],
    }
  )
export type ChefAvailabilityUpdateInput = z.infer<
  typeof chefAvailabilityUpdateSchema
>
export type ChefAvailabilityUpdateRawInput = z.input<
  typeof chefAvailabilityUpdateSchema
>

// =============================================================================
// 2. Booking slots
// =============================================================================

const bookingSlotMutableShape = {
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  capacity: z
    .int({ error: 'Please say how many bookings this window can take.' })
    .min(1, { error: 'A bookable window needs room for at least one booking.' })
    .max(MAX_SLOT_CAPACITY, {
      error: `A single window holds up to ${MAX_SLOT_CAPACITY} bookings.`,
    })
    .default(1),
  status: bookingSlotStatusSchema.default('OPEN'),
  serviceType: serviceTypeSchema.optional(),
  priceCents: moneyCentsSchema.optional(),
  currency: currencySchema,
  holdsUntil: isoDateTimeSchema.optional(),
  note: z
    .string({ error: 'Please add a note.' })
    .trim()
    .max(MAX_NOTE_LENGTH, {
      error: `Please keep the note to ${MAX_NOTE_LENGTH} characters or fewer.`,
    })
    .optional(),
} as const

function holdExpiresBeforeService(value: {
  readonly startsAt?: Date | undefined
  readonly holdsUntil?: Date | undefined
}): boolean {
  if (value.holdsUntil === undefined || value.startsAt === undefined) {
    return true
  }

  return value.holdsUntil.getTime() < value.startsAt.getTime()
}

/**
 * `holdsUntil` is `unknown` for the same reason `blackoutCarriesAReason`'s
 * `reason` is: the rule exists to catch an *absent* expiry, so the field cannot
 * be a declared `crossField` dependency. Only its presence is read, never a
 * property of it, so nothing here can throw.
 */
function heldSlotCarriesAnExpiry(value: {
  readonly status?: string | undefined
  readonly holdsUntil?: unknown
}): boolean {
  if (value.status !== 'HELD') {
    return true
  }

  return value.holdsUntil !== undefined
}

const HOLD_ORDER_ERROR =
  'A hold must lapse before the window it is holding begins.'
const HELD_WITHOUT_EXPIRY_ERROR =
  'A held window needs an expiry — choose the moment the hold lapses.'

/**
 * A concrete bookable window. `bookedCount` is absent by design: it is owned by
 * the booking transaction, never by the client.
 */
export const bookingSlotCreateSchema = z
  .object({
    staffProfileId: cuidSchema,
    ...bookingSlotMutableShape,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_ORDER_ERROR,
        path: ['endsAt'],
      },
      (values) => windowEndsAfterItBegins(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_TOO_SHORT_ERROR,
        path: ['endsAt'],
      },
      (values) => windowIsLongEnough(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_TOO_LONG_ERROR,
        path: ['endsAt'],
      },
      (values) => windowFitsInOneDay(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'holdsUntil'],
        as: 'date',
        error: HOLD_ORDER_ERROR,
        path: ['holdsUntil'],
      },
      (values) => holdExpiresBeforeService(values)
    ),
    crossField(
      {
        deps: ['status'],
        as: 'string',
        error: HELD_WITHOUT_EXPIRY_ERROR,
        path: ['holdsUntil'],
      },
      ({ status }, raw) =>
        heldSlotCarriesAnExpiry({ status, holdsUntil: raw.holdsUntil })
    )
  )
export type BookingSlotCreateInput = z.infer<typeof bookingSlotCreateSchema>
export type BookingSlotCreateRawInput = z.input<typeof bookingSlotCreateSchema>

/**
 * Editing a window that already exists. The chef it belongs to is fixed.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * `.partial()` alone left `status: 'OPEN'`, `capacity: 1`, and
 * `currency: 'CAD'` in the parsed payload of every edit, because a zod default
 * still fires underneath an optional. Correcting the note on a window that was
 * `BOOKED` or `FULL` reopened it at capacity one — a double-booking handed to
 * the next guest who loaded the availability board. Stripping the defaults first
 * means an edit touches exactly the fields the caller named.
 */
export const bookingSlotUpdateSchema = buildUpdateSchema(
  bookingSlotMutableShape,
  { requireKeys: { bookingSlotId: cuidSchema } }
).check(
  crossField(
    {
      deps: ['startsAt', 'endsAt'],
      as: 'date',
      error: WINDOW_ORDER_ERROR,
      path: ['endsAt'],
    },
    (values) => windowEndsAfterItBegins(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'endsAt'],
      as: 'date',
      error: WINDOW_TOO_SHORT_ERROR,
      path: ['endsAt'],
    },
    (values) => windowIsLongEnough(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'endsAt'],
      as: 'date',
      error: WINDOW_TOO_LONG_ERROR,
      path: ['endsAt'],
    },
    (values) => windowFitsInOneDay(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'holdsUntil'],
      as: 'date',
      error: HOLD_ORDER_ERROR,
      path: ['holdsUntil'],
    },
    (values) => holdExpiresBeforeService(values)
  ),
  crossField(
    {
      deps: ['status'],
      as: 'string',
      error: HELD_WITHOUT_EXPIRY_ERROR,
      path: ['holdsUntil'],
    },
    ({ status }, raw) =>
      heldSlotCarriesAnExpiry({ status, holdsUntil: raw.holdsUntil })
  )
)
export type BookingSlotUpdateInput = z.infer<typeof bookingSlotUpdateSchema>
export type BookingSlotUpdateRawInput = z.input<typeof bookingSlotUpdateSchema>

/**
 * Filter for the availability board in the admin OS.
 *
 * Every bound here has to survive a `URLSearchParams` round trip, because the
 * board reads its state out of the query string. The dates go through
 * `withTemporalCoercion` and the flag through `queryFlag`; the coercion sits
 * *inside* the `.optional()` so a rendered-but-empty `?startsFrom=` reads as
 * "no bound" rather than as an invalid date.
 */
export const bookingSlotFilterSchema = paginationSchema
  .extend({
    staffProfileId: cuidSchema.optional(),
    status: bookingSlotStatusSchema.optional(),
    serviceType: serviceTypeSchema.optional(),
    startsFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    startsUntil: withTemporalCoercion(isoDateTimeSchema.optional()),
    onlyBookable: queryFlag(
      false,
      'Please choose whether to show only open windows.'
    ),
  })
  /**
   * The minimal reproduction of the bug this whole pattern exists for:
   * `safeParse({ startsFrom: 'foo', startsUntil: 'bar' })` used to throw
   * `TypeError: value.startsUntil.getTime is not a function` instead of
   * returning `{ success: false }`, turning a mistyped query string on a
   * `PUBLIC` route into an unauthenticated HTTP 500.
   */
  .check(
    crossField(
      {
        deps: ['startsFrom', 'startsUntil'],
        as: 'date',
        error: 'The end of the range must fall after its start.',
        path: ['startsUntil'],
      },
      ({ startsFrom, startsUntil }) =>
        startsUntil.getTime() > startsFrom.getTime()
    )
  )
export type BookingSlotFilter = z.infer<typeof bookingSlotFilterSchema>
export type BookingSlotFilterInput = z.input<typeof bookingSlotFilterSchema>

// =============================================================================
// 3. Recurring slot generation
// =============================================================================

/**
 * The weekly pattern a generation pass repeats — the same shape as a
 * `RECURRING_WEEKLY` availability rule, but able to name several days at once.
 */
export const weeklyRecurrenceRuleSchema = z
  .object({
    daysOfWeek: z
      .array(dayOfWeekSchema, {
        error: 'Please choose at least one day of the week to repeat on.',
      })
      .min(1, {
        error: 'Please choose at least one day of the week to repeat on.',
      })
      .max(7, { error: 'There are only seven days in the week.' })
      .refine(hasUniqueValues, {
        error: 'Each day may only be chosen once.',
      }),
    startMinute: minutesFromMidnightSchema,
    endMinute: endMinutesFromMidnightSchema,
    timeZone: timeZoneSchema,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startMinute', 'endMinute'],
        as: 'number',
        error: MINUTE_WINDOW_ORDER_ERROR,
        path: ['endMinute'],
      },
      (values) => minuteWindowClosesAfterItOpens(values)
    )
  )
export type WeeklyRecurrenceRule = z.infer<typeof weeklyRecurrenceRuleSchema>
export type WeeklyRecurrenceRuleInput = z.input<
  typeof weeklyRecurrenceRuleSchema
>

/**
 * How many windows a pass would create. Exported so the admin OS can show the
 * count before anything is written, and reused by the cap below.
 */
export function countGeneratedSlots(input: {
  readonly rule: {
    readonly daysOfWeek: readonly number[]
    readonly startMinute: number
    readonly endMinute: number
  }
  readonly slotDurationMinutes: number
  readonly gapMinutes: number
  readonly horizonWeeks: number
}): number {
  const windowMinutes = input.rule.endMinute - input.rule.startMinute
  const stride = input.slotDurationMinutes + input.gapMinutes

  if (windowMinutes < input.slotDurationMinutes || stride <= 0) {
    return 0
  }

  const perDay =
    Math.floor((windowMinutes - input.slotDurationMinutes) / stride) + 1

  return perDay * input.rule.daysOfWeek.length * input.horizonWeeks
}

/**
 * Materialises a weekly rule into `BookingSlot` rows across a bounded horizon.
 *
 * The horizon is capped so one careless pass cannot fill the calendar to the end
 * of time, and the projected row count is capped on top of that.
 */
export const recurringSlotGenerationSchema = z
  .object({
    staffProfileId: cuidSchema,
    rule: weeklyRecurrenceRuleSchema,
    /** The first day the pattern may produce a window on. */
    startsOn: isoDateTimeSchema,
    horizonWeeks: z
      .int({ error: 'Please say how many weeks ahead to open the diary.' })
      .min(1, { error: 'Please open at least one week of the diary.' })
      .max(MAX_GENERATION_HORIZON_WEEKS, {
        error: `We open the diary up to ${MAX_GENERATION_HORIZON_WEEKS} weeks ahead in one pass.`,
      }),
    slotDurationMinutes: durationMinutesSchema
      .min(MIN_APPOINTMENT_MINUTES, {
        error: `Nothing on our calendar runs for less than ${MIN_APPOINTMENT_MINUTES} minutes.`,
      })
      .max(MAX_DURATION_MINUTES, {
        error: 'A single window cannot run longer than twenty-four hours.',
      }),
    gapMinutes: z
      .int({ error: 'Please give the gap between windows in whole minutes.' })
      .min(0, { error: 'A gap cannot be less than none.' })
      .max(MAX_SLOT_GAP_MINUTES, {
        error: 'A gap between windows tops out at four hours.',
      })
      .default(0),
    capacity: z
      .int({ error: 'Please say how many bookings each window can take.' })
      .min(1, { error: 'Each window needs room for at least one booking.' })
      .max(MAX_SLOT_CAPACITY, {
        error: `A single window holds up to ${MAX_SLOT_CAPACITY} bookings.`,
      })
      .default(1),
    serviceType: serviceTypeSchema.optional(),
    priceCents: moneyCentsSchema.optional(),
    currency: currencySchema,
    /** Holidays, travel, anything the pattern should step over. */
    skipDates: z
      .array(isoDateTimeSchema, {
        error: 'Please list the dates to skip, or leave the list empty.',
      })
      .max(MAX_SKIP_DATES, {
        error: `Please list up to ${MAX_SKIP_DATES} dates to skip in one pass.`,
      })
      .default([]),
    /** Clears untouched OPEN windows in the horizon before writing the new ones. */
    replaceExistingOpenSlots: z
      .boolean({
        error: 'Please choose whether to replace the windows already open.',
      })
      .default(false),
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startsOn'],
        as: 'date',
        error:
          'The diary opens from today onward — please choose a start date that is not in the past.',
        path: ['startsOn'],
      },
      ({ startsOn }) => startsOn.getTime() >= Date.now() - MS_PER_DAY
    ),
    /**
     * `rule` is declared `'present'` rather than left undeclared: the old
     * `.refine()` read `value.rule.endMinute` off whatever the caller sent, so
     * `{ rule: null }` threw. Declaring it also means a `rule` that failed its
     * own schema suppresses this rule instead of reporting a second, derived
     * complaint about a window nobody successfully described.
     */
    crossFieldMixed(
      {
        deps: { rule: 'present', slotDurationMinutes: 'number' },
        error:
          'The daily window is shorter than a single booking — lengthen the window or shorten the booking.',
        path: ['slotDurationMinutes'],
      },
      ({ rule, slotDurationMinutes }) =>
        rule.endMinute - rule.startMinute >= slotDurationMinutes
    ),
    crossFieldMixed(
      {
        deps: {
          rule: 'present',
          slotDurationMinutes: 'number',
          gapMinutes: 'number',
          horizonWeeks: 'number',
        },
        error: `That pattern would open more than ${MAX_GENERATED_SLOTS} windows — shorten the horizon or lengthen each booking.`,
        path: ['horizonWeeks'],
      },
      (values) => countGeneratedSlots(values) <= MAX_GENERATED_SLOTS
    ),
    crossFieldMixed(
      {
        deps: { skipDates: 'array', startsOn: 'date' },
        error:
          'Every date you skip must fall on or after the day generation begins.',
        path: ['skipDates'],
      },
      ({ skipDates, startsOn }) =>
        skipDates.every((date) => date.getTime() >= startsOn.getTime())
    )
  )
export type RecurringSlotGenerationInput = z.infer<
  typeof recurringSlotGenerationSchema
>
export type RecurringSlotGenerationRawInput = z.input<
  typeof recurringSlotGenerationSchema
>

// =============================================================================
// 4. Appointments
// =============================================================================

/**
 * Every service that puts a chef in somebody's home or venue, and therefore
 * needs an address. `CONSULTATION` is the one conversation we can have anywhere.
 */
export const ON_SITE_SERVICE_TYPES: readonly ServiceType[] = [
  'IN_HOME_DINNER',
  'MEAL_PREP',
  'PRIVATE_EVENT',
  'COOKING_CLASS',
  'TASTING',
  'CATERING',
  'DELIVERY_DROP_OFF',
]

/** One dish on an engagement's menu — an `AppointmentMenuItem` row. */
export const appointmentMenuItemSelectionSchema = z
  .object({
    menuItemId: cuidSchema,
    quantity: z
      .int({ error: 'Please say how many portions of this dish.' })
      .min(1, { error: 'A dish on the menu needs at least one portion.' })
      .max(MAX_MENU_ITEM_QUANTITY, {
        error: `We prepare up to ${MAX_MENU_ITEM_QUANTITY} portions of a single dish.`,
      })
      .default(1),
    courseOrder: z
      .int({ error: 'Please say where this dish falls in the service.' })
      .min(0, { error: 'The first course is numbered zero.' })
      .max(MAX_COURSE_ORDER, {
        error: `A menu runs to ${MAX_COURSE_ORDER} courses at most.`,
      })
      .default(0),
    notes: z
      .string({ error: 'Please add a note for the chef.' })
      .trim()
      .max(MAX_NOTE_LENGTH, {
        error: `Please keep the note to ${MAX_NOTE_LENGTH} characters or fewer.`,
      })
      .optional(),
    /** Price snapshot taken at booking time so history never rewrites itself. */
    priceCentsAtBooking: moneyCentsSchema.optional(),
    currency: currencySchema,
  })
  .strict()
export type AppointmentMenuItemSelection = z.infer<
  typeof appointmentMenuItemSelectionSchema
>
export type AppointmentMenuItemSelectionInput = z.input<
  typeof appointmentMenuItemSelectionSchema
>

const appointmentMutableShape = {
  serviceType: serviceTypeSchema.default('IN_HOME_DINNER'),
  /** The window this engagement was booked into, when it came from the diary. */
  bookingSlotId: cuidSchema.optional(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  prepStartsAt: isoDateTimeSchema.optional(),
  travelBufferBeforeMinutes: travelBufferSchema.default(0),
  travelBufferAfterMinutes: travelBufferSchema.default(0),
  guestCount: z
    .int({ error: 'Please tell us how many will be dining.' })
    .min(MIN_GUEST_COUNT, { error: 'We cook for at least one guest.' })
    .max(MAX_GUEST_COUNT, {
      error: `For more than ${MAX_GUEST_COUNT} guests, speak with us about catering.`,
    })
    .default(2),
  /** Flattened onto `addressLine1 … country` on `ChefAppointment` by the action. */
  address: addressSchema.optional(),
  accessNotes: z
    .string({ error: 'Please tell us how to reach your door.' })
    .trim()
    .max(MAX_NOTE_LENGTH, {
      error: `Please keep the access notes to ${MAX_NOTE_LENGTH} characters or fewer.`,
    })
    .optional(),
  totalCents: moneyCentsSchema.default(0),
  depositCents: moneyCentsSchema.default(0),
  gratuityCents: moneyCentsSchema.default(0),
  currency: currencySchema,
  clientNotes: z
    .string({ error: 'Please add anything the chef should know.' })
    .trim()
    .max(MAX_NOTE_LENGTH, {
      error: `Please keep your notes to ${MAX_NOTE_LENGTH} characters or fewer.`,
    })
    .optional(),
  chefNotes: z
    .string({ error: 'Please add a note for the kitchen.' })
    .trim()
    .max(MAX_NOTE_LENGTH, {
      error: `Please keep the note to ${MAX_NOTE_LENGTH} characters or fewer.`,
    })
    .optional(),
  menuItems: z
    .array(appointmentMenuItemSelectionSchema, {
      error: 'Please choose the dishes for this engagement.',
    })
    .max(MAX_APPOINTMENT_MENU_ITEMS, {
      error: `A single menu runs to ${MAX_APPOINTMENT_MENU_ITEMS} dishes — the chef will help you choose.`,
    })
    /**
     * The uniqueness rule is attached *before* `.default([])`, not after.
     *
     * A check added after a default lands on the `z.ZodDefault` wrapper, and
     * `withoutDefaults` strips that wrapper by calling `.unwrap()` — which would
     * take the rule with it and leave the update schema accepting the same dish
     * twice. With the order below the rule lives on the array, `.unwrap()`
     * returns the array still carrying it, and the empty default needs no
     * checking anyway.
     */
    .refine((items) => hasUniqueValues(items.map((item) => item.menuItemId)), {
      error:
        'Each dish may appear on the menu only once — raise the number of portions instead.',
    })
    .default([]),
} as const

function preparationPrecedesService(value: {
  readonly startsAt?: Date | undefined
  readonly prepStartsAt?: Date | undefined
}): boolean {
  if (value.prepStartsAt === undefined || value.startsAt === undefined) {
    return true
  }

  return value.prepStartsAt.getTime() <= value.startsAt.getTime()
}

function preparationIsNotTooEarly(value: {
  readonly startsAt?: Date | undefined
  readonly prepStartsAt?: Date | undefined
}): boolean {
  if (value.prepStartsAt === undefined || value.startsAt === undefined) {
    return true
  }

  return (
    value.startsAt.getTime() - value.prepStartsAt.getTime() <=
    MAX_PREP_LEAD_MINUTES * MS_PER_MINUTE
  )
}

function depositFitsWithinTotal(value: {
  readonly totalCents?: number | undefined
  readonly depositCents?: number | undefined
}): boolean {
  if (value.totalCents === undefined || value.depositCents === undefined) {
    return true
  }

  return value.depositCents <= value.totalCents
}

const PREP_ORDER_ERROR =
  'Preparation must begin at or before the service itself begins.'
const PREP_LEAD_ERROR =
  'Preparation cannot begin more than twenty-four hours before the service.'
const DEPOSIT_ERROR =
  'A deposit cannot be larger than the total for the engagement.'

/**
 * Booking an engagement. `status` is absent on purpose: a new booking is always
 * `REQUESTED`, and every move after that goes through
 * `appointmentStatusTransitionSchema`.
 */
export const appointmentCreateSchema = z
  .object({
    clientProfileId: cuidSchema,
    staffProfileId: cuidSchema,
    ...appointmentMutableShape,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_ORDER_ERROR,
        path: ['endsAt'],
      },
      (values) => windowEndsAfterItBegins(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_TOO_SHORT_ERROR,
        path: ['endsAt'],
      },
      (values) => windowIsLongEnough(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_TOO_LONG_ERROR,
        path: ['endsAt'],
      },
      (values) => windowFitsInOneDay(values)
    ),
    crossField(
      {
        deps: ['startsAt'],
        as: 'date',
        error: 'An engagement must be booked for a moment still ahead of us.',
        path: ['startsAt'],
      },
      ({ startsAt }) => startsAt.getTime() > Date.now()
    ),
    crossField(
      {
        deps: ['startsAt', 'prepStartsAt'],
        as: 'date',
        error: PREP_ORDER_ERROR,
        path: ['prepStartsAt'],
      },
      (values) => preparationPrecedesService(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'prepStartsAt'],
        as: 'date',
        error: PREP_LEAD_ERROR,
        path: ['prepStartsAt'],
      },
      (values) => preparationIsNotTooEarly(values)
    ),
    crossField(
      {
        deps: ['totalCents', 'depositCents'],
        as: 'number',
        error: DEPOSIT_ERROR,
        path: ['depositCents'],
      },
      (values) => depositFitsWithinTotal(values)
    )
  )
  /**
   * Left as a plain `.refine()`: `Array.prototype.includes` cannot throw on an
   * unexpected value and `address` is only tested for presence, so there is
   * nothing here to narrow and nothing that could reach a property of a field
   * that failed to parse.
   */
  .refine(
    (value) =>
      !ON_SITE_SERVICE_TYPES.includes(value.serviceType) ||
      value.address !== undefined,
    {
      error: 'Please tell us where we are cooking for this kind of service.',
      path: ['address'],
    }
  )
export type AppointmentCreateInput = z.infer<typeof appointmentCreateSchema>
export type AppointmentCreateRawInput = z.input<typeof appointmentCreateSchema>

/**
 * Amending an engagement already on the calendar.
 *
 * Neither the household nor the chef can be swapped here, and `status` stays out
 * of reach — those are separate, audited moves. The address rule cannot be
 * checked on a partial payload, so the action re-applies it after merging the
 * change onto the stored row.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * This was the worst of the five. `z.object(appointmentMutableShape).partial()`
 * still fired every default underneath the optionals, so
 * `{ appointmentId, chefNotes: 'allergic to shellfish' }` parsed to a payload
 * that additionally carried `totalCents: 0`, `depositCents: 0`,
 * `gratuityCents: 0`, `guestCount: 2`, `menuItems: []`,
 * `serviceType: 'IN_HOME_DINNER'`, `travelBufferBeforeMinutes: 0`,
 * `travelBufferAfterMinutes: 0`, and `currency: 'CAD'`.
 *
 * Adding a note to a four-thousand-dollar engagement zeroed its price, wiped its
 * deposit, emptied its booked menu, and reset the party to two. `buildUpdateSchema`
 * removes every default before `.partial()` runs and refuses a payload that is
 * nothing but an identifier.
 */
export const appointmentUpdateSchema = buildUpdateSchema(
  appointmentMutableShape,
  { requireKeys: { appointmentId: cuidSchema } }
).check(
  crossField(
    {
      deps: ['startsAt', 'endsAt'],
      as: 'date',
      error: WINDOW_ORDER_ERROR,
      path: ['endsAt'],
    },
    (values) => windowEndsAfterItBegins(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'endsAt'],
      as: 'date',
      error: WINDOW_TOO_SHORT_ERROR,
      path: ['endsAt'],
    },
    (values) => windowIsLongEnough(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'endsAt'],
      as: 'date',
      error: WINDOW_TOO_LONG_ERROR,
      path: ['endsAt'],
    },
    (values) => windowFitsInOneDay(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'prepStartsAt'],
      as: 'date',
      error: PREP_ORDER_ERROR,
      path: ['prepStartsAt'],
    },
    (values) => preparationPrecedesService(values)
  ),
  crossField(
    {
      deps: ['startsAt', 'prepStartsAt'],
      as: 'date',
      error: PREP_LEAD_ERROR,
      path: ['prepStartsAt'],
    },
    (values) => preparationIsNotTooEarly(values)
  ),
  crossField(
    {
      deps: ['totalCents', 'depositCents'],
      as: 'number',
      error: DEPOSIT_ERROR,
      path: ['depositCents'],
    },
    (values) => depositFitsWithinTotal(values)
  )
)
export type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>
export type AppointmentUpdateRawInput = z.input<typeof appointmentUpdateSchema>

// =============================================================================
// 5. The appointment state machine
// =============================================================================

/**
 * The only moves an engagement may make, as data.
 *
 * ```
 *   REQUESTED ──▶ CONFIRMED ──▶ IN_PROGRESS ──▶ COMPLETED
 *       │             │              │
 *       │             ├──▶ NO_SHOW   │
 *       └──▶ CANCELLED ◀─────────────┘
 * ```
 *
 * `CONFIRMED → COMPLETED` is permitted so a chef who cooked a whole dinner
 * without touching their phone can still close it out. `COMPLETED`, `CANCELLED`,
 * and `NO_SHOW` are terminal: a correction is a new engagement, never a rewrite.
 */
export const APPOINTMENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  REQUESTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
}

/** Statuses an engagement can never leave. */
export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]

/** Every status this engagement could legally move to next. */
export function allowedAppointmentTransitions(
  from: AppointmentStatus
): readonly AppointmentStatus[] {
  return APPOINTMENT_TRANSITIONS[from]
}

/**
 * Whether an engagement may move from one status to another.
 *
 * This is the authority for the state machine — the server action calls it
 * before writing, and the UI calls it to decide which buttons to render. The UI
 * copy is a convenience; the action's call is the enforcement.
 */
export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus
): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to)
}

/** Whether an engagement has reached a status it can never leave. */
export function isTerminalAppointmentStatus(
  status: AppointmentStatus
): boolean {
  return APPOINTMENT_TRANSITIONS[status].length === 0
}

/**
 * Moving an engagement through the state machine.
 *
 * `from` is sent by the caller and compared against the stored row by the
 * action, so two people pressing the same button at once cannot both win.
 */
export const appointmentStatusTransitionSchema = z
  .object({
    appointmentId: cuidSchema,
    /** The status the caller believes the engagement is currently in. */
    from: appointmentStatusSchema,
    to: appointmentStatusSchema,
    /** Defaults to now in the action when the caller does not back-date it. */
    occurredAt: isoDateTimeSchema.optional(),
    reason: z
      .string({ error: 'Please record why.' })
      .trim()
      .min(1, { error: 'Please record why.' })
      .max(MAX_NOTE_LENGTH, {
        error: `Please keep the reason to ${MAX_NOTE_LENGTH} characters or fewer.`,
      })
      .optional(),
    /** The `User` who cancelled. Only meaningful on a cancellation. */
    cancelledById: cuidSchema.optional(),
  })
  .strict()
  /** Presence-and-equality only; nothing to dereference, nothing to narrow. */
  .refine((value) => value.from !== value.to, {
    error: 'This engagement is already in that state.',
    path: ['to'],
  })
  .check(
    /**
     * `canTransition` indexes `APPOINTMENT_TRANSITIONS` by `from` and calls
     * `.includes` on the result. A `from` the enum rejected — `'foo'`, or a
     * missing field — used to make that lookup `undefined` and the call a
     * `TypeError`. Declaring both statuses as dependencies means the rule is
     * skipped whenever either one failed to parse.
     */
    crossField(
      {
        deps: ['from', 'to'],
        as: 'string',
        error:
          'An engagement cannot make that move — a completed, cancelled, or missed engagement is final, and one is confirmed before it begins.',
        path: ['to'],
      },
      ({ from, to }) => canTransition(from, to)
    ),
    /**
     * `reason` stays undeclared because the rule has to fire when it is absent;
     * the `typeof` test reproduces the old `!== undefined && .length > 0`
     * exactly while refusing to read `.length` off `null`.
     */
    crossField(
      {
        deps: ['to'],
        as: 'string',
        error: 'Please record why the engagement was cancelled.',
        path: ['reason'],
      },
      ({ to }, raw) =>
        to !== 'CANCELLED' ||
        (typeof raw.reason === 'string' && raw.reason.length > 0)
    )
  )
  /** Presence only. */
  .refine(
    (value) => value.to === 'CANCELLED' || value.cancelledById === undefined,
    {
      error: 'Only a cancellation records who cancelled it.',
      path: ['cancelledById'],
    }
  )
  .check(
    crossField(
      {
        deps: ['occurredAt'],
        as: 'date',
        error:
          'A change of status cannot be recorded for a moment still to come.',
        path: ['occurredAt'],
      },
      ({ occurredAt }) => occurredAt.getTime() <= Date.now()
    )
  )
export type AppointmentStatusTransitionInput = z.infer<
  typeof appointmentStatusTransitionSchema
>
export type AppointmentStatusTransitionRawInput = z.input<
  typeof appointmentStatusTransitionSchema
>

// =============================================================================
// 6. Conflict checking
// =============================================================================

/**
 * The statuses that occupy a chef's calendar. A cancelled or missed engagement
 * frees its window; a completed one is in the past and cannot be double-booked.
 */
export const DEFAULT_BLOCKING_APPOINTMENT_STATUSES: readonly AppointmentStatus[] =
  ['REQUESTED', 'CONFIRMED', 'IN_PROGRESS']

/**
 * Asks whether a chef is free for a window, travel included.
 *
 * The buffers widen the window on both sides before the overlap test, so an
 * engagement across town cannot be booked against the end of another.
 */
export const appointmentConflictCheckSchema = z
  .object({
    staffProfileId: cuidSchema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    travelBufferBeforeMinutes: travelBufferSchema.default(0),
    travelBufferAfterMinutes: travelBufferSchema.default(0),
    /** Ignore this engagement — set when re-checking one that already exists. */
    excludeAppointmentId: cuidSchema.optional(),
    /** Ignore this window — set when re-checking a slot being rewritten. */
    excludeBookingSlotId: cuidSchema.optional(),
    blockingStatuses: z
      .array(appointmentStatusSchema, {
        error: 'Please choose which statuses count as occupied.',
      })
      .min(1, {
        error: 'Please choose at least one status that counts as occupied.',
      })
      .max(6, { error: 'There are only six statuses to choose from.' })
      /** Before the default, for the reason spelled out on `menuItems` above. */
      .refine(hasUniqueValues, {
        error: 'Each status may only be chosen once.',
      })
      .default([...DEFAULT_BLOCKING_APPOINTMENT_STATUSES]),
    /** Whether blackout availability rules also count as a conflict. */
    includeBlackouts: z
      .boolean({ error: 'Please choose whether blackouts count as conflicts.' })
      .default(true),
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_ORDER_ERROR,
        path: ['endsAt'],
      },
      (values) => windowEndsAfterItBegins(values)
    ),
    crossField(
      {
        deps: ['startsAt', 'endsAt'],
        as: 'date',
        error: WINDOW_TOO_LONG_ERROR,
        path: ['endsAt'],
      },
      (values) => windowFitsInOneDay(values)
    )
  )
export type AppointmentConflictCheckInput = z.infer<
  typeof appointmentConflictCheckSchema
>
export type AppointmentConflictCheckRawInput = z.input<
  typeof appointmentConflictCheckSchema
>

/**
 * Filter for the engagements table and the chef's day view.
 *
 * Reachable over GET, so both date bounds coerce — see the note on
 * `bookingSlotFilterSchema`.
 */
export const appointmentFilterSchema = paginationSchema
  .extend({
    clientProfileId: cuidSchema.optional(),
    staffProfileId: cuidSchema.optional(),
    bookingSlotId: cuidSchema.optional(),
    status: appointmentStatusSchema.optional(),
    serviceType: serviceTypeSchema.optional(),
    startsFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    startsUntil: withTemporalCoercion(isoDateTimeSchema.optional()),
  })
  .check(
    crossField(
      {
        deps: ['startsFrom', 'startsUntil'],
        as: 'date',
        error: 'The end of the range must fall after its start.',
        path: ['startsUntil'],
      },
      ({ startsFrom, startsUntil }) =>
        startsUntil.getTime() > startsFrom.getTime()
    )
  )
export type AppointmentFilter = z.infer<typeof appointmentFilterSchema>
export type AppointmentFilterInput = z.input<typeof appointmentFilterSchema>
