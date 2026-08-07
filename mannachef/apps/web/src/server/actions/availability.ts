// mannachef/apps/web/src/server/actions/availability.ts

'use server'

/**
 * Chef availability — the rules that describe when a chef *can* work, the
 * concrete windows materialised from those rules, and the one query a stranger
 * is allowed to run against them.
 *
 * ## The three layers, and which one each action touches
 *
 * 1. **`ChefAvailability`** — the authored rules. "Tuesdays 09:00–17:00",
 *    "closed on 24 December". Written by {@link createAvailabilityRule},
 *    {@link createAvailabilityBlackout}, {@link updateAvailabilityRule} and
 *    {@link deleteAvailabilityRule}; read back by
 *    {@link listAvailabilityRules}.
 * 2. **The expansion** — what those rules mean as instants on a particular
 *    range of days, blackouts subtracted, DST honoured.
 *    {@link previewAvailabilityWindows} runs it through the pure engine in
 *    `@/server/scheduling` so a chef can see the effect of an edit before it
 *    reaches a guest.
 * 3. **`BookingSlot`** — concrete, bookable, sellable windows with a capacity
 *    and a price. {@link generateBookingSlots} materialises them from a weekly
 *    pattern over a bounded horizon; {@link listBookableWindows} is the public
 *    read that the consultation gateway and the marketing booking page call.
 *
 * Nothing in this module re-implements conflict, overlap, blackout, or
 * time-zone logic. `@/server/scheduling` owns all of it, is pure, and is
 * covered by ninety tests; every date arithmetic below is either a civil-date
 * loop counter or a call into that engine.
 *
 * ## Who may edit whose diary
 *
 * Every mutating action is behind `auth: 'CHEF_STAFF'` **and** an ownership
 * check ({@link requireStaffScope}): a `CHEF_STAFF` may only touch the
 * `StaffProfile` that is their own, and `ADMIN` and above may touch any. The
 * role check alone is not sufficient and is never treated as if it were — one
 * chef editing another chef's blackouts is exactly the kind of lateral move
 * `CONTRACT.md` §5 exists to stop.
 *
 * ## The public path
 *
 * {@link listBookableWindows} is `auth: 'PUBLIC'` and rate limited. It returns
 * the chef's **display name and nothing else** about the person: no email, no
 * telephone number, no base address, no internal note, no hold expiry. The
 * projection is written out field by field in {@link toPublicWindow} rather
 * than being spread from a Prisma row, because a spread is how a column added
 * next year leaks.
 */

import {
  bookingSlotFilterSchema,
  chefAvailabilityRuleSchema,
  chefAvailabilityUpdateSchema,
  cuidSchema,
  dateRangeSchema,
  hasRoleAtLeast,
  MAX_GENERATED_SLOTS,
  paginationToSkipTake,
  recurringSlotGenerationSchema,
} from '@mannachef/validators'
import type { BookingSlotStatus, ServiceType } from '@mannachef/validators'
import { z } from 'zod'
import type { PageMeta } from '@mannachef/api-contract'

// Nothing in this module throws: every refusal below is reachable without a
// transaction rollback, so each one is *returned*. `ActionError` is therefore
// deliberately not imported here — it earns its keep in `booking.ts`, inside
// `$transaction`, where returning would commit.
import { ok, fail, type ActionResult } from '@/server/actions/types'
import type { Prisma } from '@/server/db'
import { withAction, type AuthenticatedUser } from '@/server/guards'
import {
  expandAvailability,
  MAX_EXPANSION_DAYS,
  resolveWallClock,
  timeZoneOffsetMs,
  type AvailabilityRule,
  type CivilDate,
} from '@/server/scheduling'

// =============================================================================
// 0. Constants
// =============================================================================

const MS_PER_DAY = 86_400_000

/**
 * Cache surfaces a change to the diary invalidates.
 *
 * `withAction` takes these statically, so they are deliberately coarse: there
 * is no per-chef tag here because the configuration cannot see the payload.
 * Coarse and correct beats fine-grained and wrong — a chef publishing a
 * blackout must never leave a stale window on the public booking page.
 */
const AVAILABILITY_PATHS = [
  '/admin/calendar',
  '/admin/availability',
  '/book',
] as const

const AVAILABILITY_TAGS = ['availability', 'booking-slots'] as const

/**
 * The public window search is the one action in this module a stranger can
 * reach. Thirty searches a minute is generous for a person choosing a date and
 * miserly for a scraper enumerating a chef's diary.
 */
const PUBLIC_QUERY_RATE_LIMIT = { tokens: 30, windowMs: 60_000 } as const

// =============================================================================
// 1. Local input schemas
//
// Everything that has a schema in `@mannachef/validators` uses it. The three
// below have none, because the package has no "delete this row by id" or
// "list by owner" schema to import — so they are *composed* from the package's
// own primitives (`cuidSchema`, `dateRangeSchema`) rather than restating any
// rule those primitives already carry.
// =============================================================================

const availabilityRuleIdSchema = z
  .object({ availabilityId: cuidSchema })
  .strict()

const staffScopedQuerySchema = z.object({ staffProfileId: cuidSchema }).strict()

const availabilityPreviewSchema = z
  .object({ staffProfileId: cuidSchema, range: dateRangeSchema })
  .strict()

const bookingSlotIdSchema = z.object({ bookingSlotId: cuidSchema }).strict()

// =============================================================================
// 2. Ownership
// =============================================================================

/** What {@link requireStaffScope} proves, and what the engine needs anyway. */
interface StaffScope {
  readonly staffProfileId: string
  readonly calendarTimeZone: string
  readonly maxConcurrentEvents: number
  readonly isAcceptingClients: boolean
}

/**
 * The diary-level ownership check: does this caller control this chef's
 * calendar?
 *
 * `CHEF_STAFF` reaches only their own `StaffProfile.id`; `ADMIN` and above
 * reach any. There is no ambient "staff can edit staff" rule.
 *
 * ## Why this denies with `FORBIDDEN` rather than `NOT_FOUND`
 *
 * `guards.ts` defaults its ownership denials to `NOT_FOUND` so a guard cannot
 * be used to enumerate cuids. That reasoning does not apply here: every caller
 * who reaches this function has already passed `auth: 'CHEF_STAFF'`, and the
 * set of `StaffProfile` rows is *already* public — `listBookableWindows` and
 * the staff directory publish it. Confirming to a colleague that another chef
 * exists reveals nothing they could not read signed out, and `FORBIDDEN` is
 * the answer that tells an operator to ask an administrator rather than to go
 * looking for a typo in the id.
 */
async function requireStaffScope(
  db: Prisma.TransactionClient,
  user: AuthenticatedUser,
  staffProfileId: string
): Promise<ActionResult<StaffScope>> {
  const staff = await db.staffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      id: true,
      calendarTimeZone: true,
      maxConcurrentEvents: true,
      isAcceptingClients: true,
    },
  })

  if (staff === null) {
    return fail('NOT_FOUND', 'We could not find that chef.')
  }

  const isOwnDiary =
    user.staffProfileId !== null && user.staffProfileId === staff.id

  if (!isOwnDiary && !hasRoleAtLeast(user.role, 'ADMIN')) {
    return fail(
      'FORBIDDEN',
      'You may only change your own calendar. An administrator can change anyone’s.'
    )
  }

  return ok({
    staffProfileId: staff.id,
    calendarTimeZone: staff.calendarTimeZone,
    maxConcurrentEvents: staff.maxConcurrentEvents,
    isAcceptingClients: staff.isAcceptingClients,
  })
}

/** The stored shape of an availability rule the caller has proved they own. */
interface OwnedAvailabilityRule {
  readonly id: string
  readonly staffProfileId: string
  readonly kind: 'RECURRING_WEEKLY' | 'DATE_OVERRIDE'
  readonly isBlackout: boolean
  readonly reason: string | null
  /** The rule's *own* zone, which is what the engine resolves it against. */
  readonly timeZone: string
  readonly scope: StaffScope
}

/**
 * A rule id arriving from a browser is a claim. This turns it into a fact, or
 * into a refusal, by reading the row and then running the diary-level check
 * against the chef the row actually belongs to.
 */
async function requireAvailabilityRuleOwnership(
  db: Prisma.TransactionClient,
  user: AuthenticatedUser,
  availabilityId: string
): Promise<ActionResult<OwnedAvailabilityRule>> {
  const rule = await db.chefAvailability.findUnique({
    where: { id: availabilityId },
    select: {
      id: true,
      staffProfileId: true,
      kind: true,
      isBlackout: true,
      reason: true,
      timeZone: true,
    },
  })

  if (rule === null) {
    return fail('NOT_FOUND', 'We could not find that availability rule.')
  }

  const scope = await requireStaffScope(db, user, rule.staffProfileId)

  if (!scope.ok) {
    return scope
  }

  return ok({
    id: rule.id,
    staffProfileId: rule.staffProfileId,
    kind: rule.kind,
    isBlackout: rule.isBlackout,
    reason: rule.reason,
    timeZone: rule.timeZone,
    scope: scope.data,
  })
}

// =============================================================================
// 3. Civil-date helpers
//
// The engine keeps its own copies of these private, so the three lines below
// are re-derived here rather than exported from it. They are pure integer
// arithmetic over a calendar date — no offsets, no transitions, no policy. The
// only zone-aware step, `civilDateInZone`, goes through the engine's exported
// `timeZoneOffsetMs`, so the IANA lookup has exactly one implementation.
// =============================================================================

/** Whole days from the epoch to a civil date, read as though it were UTC. */
function dayNumberOf(date: CivilDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY)
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
function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/**
 * The calendar date a zone is showing at an instant.
 *
 * Adding the zone's offset at that instant and then reading the UTC fields is
 * the standard inversion; it is correct for half-hour zones and for historical
 * offsets because `timeZoneOffsetMs` derives the offset from the IANA database
 * for that specific instant rather than assuming one.
 */
function civilDateInZone(instant: Date, timeZone: string): CivilDate {
  const shifted = new Date(
    instant.getTime() + timeZoneOffsetMs(timeZone, instant)
  )

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * A `@db.Date` column carries a calendar date, not an instant, and Prisma round
 * trips it through UTC midnight — which is also how the engine reads it back
 * (`civilDateFromDateOnlyColumn`). An override submitted as "18 June, 19:00
 * Toronto" must therefore be stored as `2024-06-18T00:00:00Z`, or the engine
 * would place it on the 18th while the database believed something else.
 */
function toDateOnlyColumn(instant: Date, timeZone: string): Date {
  const civil = civilDateInZone(instant, timeZone)

  return new Date(dayNumberOf(civil) * MS_PER_DAY)
}

// =============================================================================
// 4. Projections
// =============================================================================

/**
 * A bookable window as the public gateway sees it.
 *
 * Deliberately a *subset* of `bookingSlotSchema` in `@mannachef/api-contract`:
 * the two internal columns that schema carries for the staff caller —
 * `holdsUntil` and `note` — are present but always `null` on the public path.
 * See {@link toPublicWindow}.
 */
interface BookableWindow {
  readonly id: string
  readonly staffProfileId: string
  readonly staffName: string | null
  readonly startsAt: Date
  readonly endsAt: Date
  readonly capacity: number
  readonly bookedCount: number
  readonly status: BookingSlotStatus
  readonly serviceType: ServiceType | null
  readonly priceCents: number | null
  readonly currency: string
  readonly holdsUntil: Date | null
  readonly note: string | null
  readonly isBookable: boolean
}

/** Exactly the columns any caller of {@link listBookableWindows} may read. */
const BOOKABLE_WINDOW_SELECT = {
  id: true,
  staffProfileId: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  bookedCount: true,
  status: true,
  serviceType: true,
  priceCents: true,
  currency: true,
  holdsUntil: true,
  note: true,
  staffProfile: {
    select: {
      // `User.name` is the chef's display name and is the *only* thing about
      // the person that crosses this boundary. No email, no phone, no
      // `baseCity`, no `bio`, no `hourlyRateCents`.
      user: { select: { name: true } },
    },
  },
} satisfies Prisma.BookingSlotSelect

type BookingSlotRow = Prisma.BookingSlotGetPayload<{
  select: typeof BOOKABLE_WINDOW_SELECT
}>

/**
 * Project a slot row for a caller.
 *
 * Written as an explicit field list rather than a spread with deletions: a
 * spread inherits whatever `BookingSlot` gains next, and the failure mode of
 * that mistake is a private column on a public page.
 *
 * `isBookable` is `status === 'OPEN' && bookedCount < capacity`, which is the
 * definition `bookingSlotSchema` in `@mannachef/api-contract` documents. The
 * write path in `booking.ts` maintains the matching invariant: a window stays
 * `OPEN` while it has room and becomes `FULL` the moment the last seat goes.
 */
function toPublicWindow(
  row: BookingSlotRow,
  forStaff: boolean
): BookableWindow {
  return {
    id: row.id,
    staffProfileId: row.staffProfileId,
    staffName: row.staffProfile.user.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacity,
    bookedCount: row.bookedCount,
    status: row.status,
    serviceType: row.serviceType,
    priceCents: row.priceCents,
    currency: row.currency,
    // Both are operational detail. A guest learning that a window is held
    // until 19:42 learns when to retry a race they should not be running, and
    // the note is written for the kitchen, not for the guest.
    holdsUntil: forStaff ? row.holdsUntil : null,
    note: forStaff ? row.note : null,
    isBookable: row.status === 'OPEN' && row.bookedCount < row.capacity,
  }
}

/**
 * Page counters for a list response, matching `pageMetaSchema` in
 * `@mannachef/api-contract`.
 *
 * The identical six lines appear in `booking.ts`. That duplication is forced
 * rather than careless: a `'use server'` module may export nothing but async
 * functions, so a shared helper cannot live in either file, and inventing a
 * fourth module for six lines of arithmetic would be worse.
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
// 5. Rule mutations
// =============================================================================

/**
 * Publish an availability rule — either a weekly pattern or a single-date
 * override.
 *
 * `chefAvailabilityRuleSchema` is the union of the two, and it has already
 * enforced everything that can be decided from the payload alone: the window
 * closes after it opens, the effective range is ordered, an override falls
 * inside that range, and a blackout carries a reason. What is left for the
 * server is the part a payload cannot prove — that the caller owns this chef's
 * diary — plus the `@db.Date` normalisation on `specificDate`.
 */
export const createAvailabilityRule = withAction(
  {
    name: 'availability.createRule',
    auth: 'CHEF_STAFF',
    input: chefAvailabilityRuleSchema,
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx, input) => {
    const scope = await requireStaffScope(
      ctx.db,
      ctx.user,
      input.staffProfileId
    )

    if (!scope.ok) {
      return scope
    }

    const created = await ctx.db.chefAvailability.create({
      data: {
        staffProfileId: scope.data.staffProfileId,
        kind: input.kind,
        // Nullable columns are written as `null`, never as `undefined`: with
        // `exactOptionalPropertyTypes` an absent optional and an explicit
        // `undefined` are different types, and Prisma reads the latter as
        // "leave this alone", which is not what an absent field means on a
        // create.
        dayOfWeek: input.kind === 'RECURRING_WEEKLY' ? input.dayOfWeek : null,
        specificDate:
          input.kind === 'DATE_OVERRIDE'
            ? toDateOnlyColumn(input.specificDate, input.timeZone)
            : null,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        timeZone: input.timeZone,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        isBlackout: input.isBlackout,
        reason: input.reason ?? null,
        note: input.note ?? null,
      },
      select: { id: true, kind: true, staffProfileId: true, isBlackout: true },
    })

    return ok(created)
  }
)

/**
 * Close the diary — a blackout, of either kind.
 *
 * The same schema as {@link createAvailabilityRule}, narrowed to the blackout
 * case exactly as `@mannachef/api-contract` narrows the transition schema for
 * its cancel route: a derivation of the shared rule, never a second copy of
 * it. A mistargeted call therefore fails at the edge instead of quietly
 * *opening* a window on the day a chef meant to close.
 *
 * Both kinds are accepted on purpose. A recurring blackout ("never on a
 * Sunday") and a dated one ("closed on the 24th") are the same concept at two
 * cadences, and the engine subtracts both from the union at the end, which is
 * what lets a blackout carve a hole in the middle of a working day and leave
 * the morning and afternoon either side of it intact.
 */
export const createAvailabilityBlackout = withAction(
  {
    name: 'availability.createBlackout',
    auth: 'CHEF_STAFF',
    input: chefAvailabilityRuleSchema.refine((value) => value.isBlackout, {
      error: 'This action only closes the diary — set the blackout flag.',
      path: ['isBlackout'],
    }),
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx, input) => {
    const scope = await requireStaffScope(
      ctx.db,
      ctx.user,
      input.staffProfileId
    )

    if (!scope.ok) {
      return scope
    }

    const created = await ctx.db.chefAvailability.create({
      data: {
        staffProfileId: scope.data.staffProfileId,
        kind: input.kind,
        dayOfWeek: input.kind === 'RECURRING_WEEKLY' ? input.dayOfWeek : null,
        specificDate:
          input.kind === 'DATE_OVERRIDE'
            ? toDateOnlyColumn(input.specificDate, input.timeZone)
            : null,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        timeZone: input.timeZone,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        isBlackout: true,
        reason: input.reason ?? null,
        note: input.note ?? null,
      },
      select: { id: true, kind: true, staffProfileId: true, isBlackout: true },
    })

    return ok(created)
  }
)

/**
 * Amend a rule already on the calendar.
 *
 * `chefAvailabilityUpdateSchema` is built by `buildUpdateSchema`, so an
 * untouched field stays untouched — correcting a note on a blackout cannot
 * silently reopen it, which is the regression MCV-005 removed. Two rules the
 * payload cannot decide are enforced here instead:
 *
 *  - **A rule does not change kind.** A `RECURRING_WEEKLY` row has no
 *    `specificDate` and a `DATE_OVERRIDE` row has no `dayOfWeek`; the database
 *    would accept either, and the engine would then skip the malformed row
 *    silently. Moving a rule between kinds is a delete and a create.
 *  - **A blackout keeps a reason.** The schema requires one only when
 *    `isBlackout` is in the payload, so an edit that blanked `reason` on an
 *    existing blackout would pass. The check runs against the *merged* row.
 */
export const updateAvailabilityRule = withAction(
  {
    name: 'availability.updateRule',
    auth: 'CHEF_STAFF',
    input: chefAvailabilityUpdateSchema,
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx, input) => {
    const owned = await requireAvailabilityRuleOwnership(
      ctx.db,
      ctx.user,
      input.availabilityId
    )

    if (!owned.ok) {
      return owned
    }

    const rule = owned.data

    if (rule.kind === 'RECURRING_WEEKLY' && input.specificDate !== undefined) {
      return fail(
        'VALIDATION',
        'This rule repeats weekly. To move it to a single date, delete it and create a date override.',
        { specificDate: ['This rule repeats weekly and has no single date.'] }
      )
    }

    if (rule.kind === 'DATE_OVERRIDE' && input.dayOfWeek !== undefined) {
      return fail(
        'VALIDATION',
        'This rule covers one date. To make it repeat weekly, delete it and create a weekly rule.',
        { dayOfWeek: ['This rule covers a single date, not a weekday.'] }
      )
    }

    const mergedIsBlackout = input.isBlackout ?? rule.isBlackout
    const mergedReason =
      input.reason !== undefined ? input.reason : (rule.reason ?? '')

    if (mergedIsBlackout && mergedReason.trim().length === 0) {
      return fail(
        'VALIDATION',
        'Please note why this window is closed, so the concierge can explain it.',
        { reason: ['Please note why this window is closed.'] }
      )
    }

    // Built key by key rather than spread: `exactOptionalPropertyTypes` makes
    // `{ reason: undefined }` a different thing from `{}`, and Prisma reads
    // the former as an instruction it should never receive here.
    const data: Prisma.ChefAvailabilityUpdateInput = {}

    if (input.startMinute !== undefined) {
      data.startMinute = input.startMinute
    }

    if (input.endMinute !== undefined) {
      data.endMinute = input.endMinute
    }

    if (input.timeZone !== undefined) {
      data.timeZone = input.timeZone
    }

    if (input.effectiveFrom !== undefined) {
      data.effectiveFrom = input.effectiveFrom
    }

    if (input.effectiveUntil !== undefined) {
      data.effectiveUntil = input.effectiveUntil
    }

    if (input.isBlackout !== undefined) {
      data.isBlackout = input.isBlackout
    }

    if (input.reason !== undefined) {
      data.reason = input.reason
    }

    if (input.note !== undefined) {
      data.note = input.note
    }

    if (input.dayOfWeek !== undefined) {
      data.dayOfWeek = input.dayOfWeek
    }

    if (input.specificDate !== undefined) {
      // Reduced against the zone the *rule* is written in — the one the
      // engine will resolve it against — taking the payload's zone only when
      // the same edit is moving it. The caller's own zone is irrelevant: an
      // administrator in Vancouver editing a Toronto chef's override must not
      // shift the date by three hours' worth of midnight.
      data.specificDate = toDateOnlyColumn(
        input.specificDate,
        input.timeZone ?? rule.timeZone
      )
    }

    const updated = await ctx.db.chefAvailability.update({
      where: { id: rule.id },
      data,
      select: { id: true, kind: true, staffProfileId: true, isBlackout: true },
    })

    return ok(updated)
  }
)

/**
 * Withdraw a rule.
 *
 * Windows already materialised into `BookingSlot` rows are *not* removed:
 * `ChefAvailability` and `BookingSlot` have no foreign key between them, and a
 * window a guest has already been offered should be withdrawn deliberately
 * rather than as a side effect of tidying the rules. Use
 * {@link generateBookingSlots} with `replaceExistingOpenSlots` to sweep the
 * untaken ones.
 */
export const deleteAvailabilityRule = withAction(
  {
    name: 'availability.deleteRule',
    auth: 'CHEF_STAFF',
    input: availabilityRuleIdSchema,
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx, input) => {
    const owned = await requireAvailabilityRuleOwnership(
      ctx.db,
      ctx.user,
      input.availabilityId
    )

    if (!owned.ok) {
      return owned
    }

    await ctx.db.chefAvailability.delete({ where: { id: owned.data.id } })

    return ok({ id: owned.data.id, deleted: true as const })
  }
)

// =============================================================================
// 6. Reads for the chef's own editor
// =============================================================================

/**
 * Every rule on one chef's calendar, newest weekly patterns first and then the
 * dated exceptions.
 *
 * Staff-only and ownership-checked: the rules carry `note`, which is written
 * for colleagues ("back specialist on Thursdays"), and `reason`, which is
 * written for the concierge. Neither belongs on the public path — that is what
 * {@link listBookableWindows} is for.
 */
export const listAvailabilityRules = withAction(
  {
    name: 'availability.listRules',
    auth: 'CHEF_STAFF',
    input: staffScopedQuerySchema,
  },
  async (ctx, input) => {
    const scope = await requireStaffScope(
      ctx.db,
      ctx.user,
      input.staffProfileId
    )

    if (!scope.ok) {
      return scope
    }

    const rules = await ctx.db.chefAvailability.findMany({
      where: { staffProfileId: scope.data.staffProfileId },
      orderBy: [
        { kind: 'asc' },
        { dayOfWeek: 'asc' },
        { specificDate: 'asc' },
        { startMinute: 'asc' },
      ],
      select: {
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
        reason: true,
        note: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return ok({
      staffProfileId: scope.data.staffProfileId,
      calendarTimeZone: scope.data.calendarTimeZone,
      rules,
    })
  }
)

/**
 * What the rules actually *mean* over a range of days, as instants.
 *
 * This is the engine's `expandAvailability` and nothing else: positive
 * overrides replace recurring windows on their local date, the survivors are
 * merged, every blackout is subtracted, and the result is clipped to the
 * range. Daylight-saving transitions are honoured — the Sunday the clocks go
 * forward is genuinely 23 hours long here, and a window authored inside the
 * skipped hour is dropped rather than clamped, because nobody can work an hour
 * that did not happen.
 *
 * Staff-only. It is the answer to "why is the 18th not offered?", which is a
 * question about the chef's rules rather than about what a guest may book.
 */
export const previewAvailabilityWindows = withAction(
  {
    name: 'availability.preview',
    auth: 'CHEF_STAFF',
    input: availabilityPreviewSchema,
  },
  async (ctx, input) => {
    const scope = await requireStaffScope(
      ctx.db,
      ctx.user,
      input.staffProfileId
    )

    if (!scope.ok) {
      return scope
    }

    const spanDays =
      (input.range.end.getTime() - input.range.start.getTime()) / MS_PER_DAY

    // The engine throws a `RangeError` past this bound, which `withAction`
    // would translate into an opaque `INTERNAL`. A range chosen in a date
    // picker is a guest-visible mistake, not a bug, so it is refused as one.
    if (spanDays > MAX_EXPANSION_DAYS) {
      return fail(
        'VALIDATION',
        `We can only look ${String(MAX_EXPANSION_DAYS)} days ahead at a time — please narrow the range.`,
        { range: ['Please choose a shorter range.'] }
      )
    }

    const rules = await ctx.db.chefAvailability.findMany({
      where: { staffProfileId: scope.data.staffProfileId },
      select: {
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
      },
    })

    // The row shape is `AvailabilityRule` verbatim — the engine's interface was
    // written against this schema, so no mapping is needed and none is done.
    const engineRules: readonly AvailabilityRule[] = rules

    const windows = expandAvailability(
      engineRules,
      { from: input.range.start, until: input.range.end },
      scope.data.calendarTimeZone
    )

    return ok({
      staffProfileId: scope.data.staffProfileId,
      calendarTimeZone: scope.data.calendarTimeZone,
      windows: windows.map((window) => ({
        start: window.start,
        end: window.end,
        sourceRuleIds: [...window.sourceRuleIds],
      })),
    })
  }
)

// =============================================================================
// 7. Slot generation
// =============================================================================

/** One `BookingSlot` row a generation pass wants to write. */
interface GeneratedSlot {
  readonly staffProfileId: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly capacity: number
  readonly status: 'OPEN'
  readonly serviceType: ServiceType | null
  readonly priceCents: number | null
  readonly currency: string
}

/**
 * Materialise a weekly pattern into concrete bookable windows over a bounded
 * horizon.
 *
 * ## How the horizon is walked
 *
 * `startsOn` is reduced to a **calendar date in the rule's own time zone** —
 * a chef in Toronto opening the diary "from tomorrow" means tomorrow as their
 * kitchen clock reads it, not as UTC does. The walk then proceeds over integer
 * day numbers, which is immune to every off-by-one that arises from adding
 * 86,400,000 milliseconds across a transition. `skipDates` are reduced the
 * same way, so a holiday named as an instant lands on the day the chef meant.
 *
 * ## How each day is sliced
 *
 * Both ends of every slot go through the engine's `resolveWallClock`, so
 * "18:00" is eighteen hundred on the chef's clock on that specific date, at
 * whatever offset the IANA database says applied. Two consequences follow, and
 * both are correct rather than tolerated:
 *
 *  - On a **spring-forward** day a slot written entirely inside the skipped
 *    hour resolves to zero length and is dropped. That hour did not happen.
 *  - On a **fall-back** day a slot spanning the repeated hour is two real
 *    hours long. The chef really is available for both of them.
 *
 * A slot that has already ended by the time the pass runs is also dropped —
 * generating windows into the past would put unbookable rows on the diary.
 *
 * ## Concurrency
 *
 * The pass runs in one `Serializable` transaction. `replaceExistingOpenSlots`
 * makes it a delete followed by an insert over the same rows, and anything
 * weaker would let a guest book, between the two statements, a window that is
 * about to be replaced. The delete is additionally narrowed to windows that
 * are `OPEN`, have no bookings counted against them, and have no appointment
 * attached — a window somebody has already taken is never swept, whatever the
 * flag says. Re-running an identical pass is harmless: the
 * `@@unique([staffProfileId, startsAt, endsAt])` index plus `skipDuplicates`
 * makes it a no-op rather than a duplicate diary.
 */
export const generateBookingSlots = withAction(
  {
    name: 'availability.generateSlots',
    auth: 'CHEF_STAFF',
    input: recurringSlotGenerationSchema,
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx, input) => {
    const scope = await requireStaffScope(
      ctx.db,
      ctx.user,
      input.staffProfileId
    )

    if (!scope.ok) {
      return scope
    }

    const now = new Date()
    const zone = input.rule.timeZone
    const firstDay = dayNumberOf(civilDateInZone(input.startsOn, zone))
    const lastDay = firstDay + input.horizonWeeks * 7 - 1

    const wantedWeekdays = new Set(input.rule.daysOfWeek)
    const skippedDays = new Set(
      input.skipDates.map((date) => dayNumberOf(civilDateInZone(date, zone)))
    )

    const stride = input.slotDurationMinutes + input.gapMinutes
    const rows: GeneratedSlot[] = []

    for (let dayNumber = firstDay; dayNumber <= lastDay; dayNumber += 1) {
      const date = civilDateFromDayNumber(dayNumber)

      if (!wantedWeekdays.has(weekdayOf(date)) || skippedDays.has(dayNumber)) {
        continue
      }

      for (
        let minute = input.rule.startMinute;
        minute + input.slotDurationMinutes <= input.rule.endMinute;
        minute += stride
      ) {
        const startsAt = resolveWallClock(date, minute, zone).instant
        const endsAt = resolveWallClock(
          date,
          minute + input.slotDurationMinutes,
          zone
        ).instant

        // Zero or negative length is the spring-forward gap; an end already in
        // the past is a window nobody could book.
        if (
          endsAt.getTime() <= startsAt.getTime() ||
          endsAt.getTime() <= now.getTime()
        ) {
          continue
        }

        rows.push({
          staffProfileId: scope.data.staffProfileId,
          startsAt,
          endsAt,
          capacity: input.capacity,
          status: 'OPEN',
          serviceType: input.serviceType ?? null,
          priceCents: input.priceCents ?? null,
          currency: input.currency,
        })

        // `recurringSlotGenerationSchema` already projected the row count and
        // refused a pattern above the ceiling. This is the belt to that
        // braces: the projection assumes uniform days, and a horizon crossing
        // a transition is not quite uniform.
        if (rows.length > MAX_GENERATED_SLOTS) {
          return fail(
            'VALIDATION',
            `That pattern would open more than ${String(MAX_GENERATED_SLOTS)} windows — shorten the horizon or lengthen each booking.`,
            { horizonWeeks: ['Please shorten the horizon.'] }
          )
        }
      }
    }

    if (rows.length === 0) {
      return fail(
        'VALIDATION',
        'That pattern does not open a single window. Check the days of the week and the horizon.',
        { horizonWeeks: ['This pattern opens no windows.'] }
      )
    }

    const horizonStart = resolveWallClock(
      civilDateFromDayNumber(firstDay),
      0,
      zone
    ).instant

    const horizonEnd = resolveWallClock(
      civilDateFromDayNumber(lastDay + 1),
      0,
      zone
    ).instant

    const outcome = await ctx.db.$transaction(
      async (tx) => {
        let removed = 0

        if (input.replaceExistingOpenSlots) {
          const deleted = await tx.bookingSlot.deleteMany({
            where: {
              staffProfileId: scope.data.staffProfileId,
              status: 'OPEN',
              bookedCount: 0,
              startsAt: { gte: horizonStart, lt: horizonEnd },
              appointments: { none: {} },
            },
          })

          removed = deleted.count
        }

        const inserted = await tx.bookingSlot.createMany({
          data: rows.map((row) => ({ ...row })),
          skipDuplicates: true,
        })

        return { removed, created: inserted.count }
      },
      { isolationLevel: 'Serializable', timeout: 30_000 }
    )

    return ok({
      staffProfileId: scope.data.staffProfileId,
      created: outcome.created,
      removed: outcome.removed,
      skippedAsDuplicate: rows.length - outcome.created,
      horizonStart,
      horizonEnd,
    })
  }
)

/**
 * Withdraw a single bookable window.
 *
 * Refuses rather than orphans: a window with an appointment attached, or with
 * seats counted against it, is not deleted. Withdrawing it would leave a
 * booked guest pointing at nothing (`onDelete: SetNull` on
 * `ChefAppointment.bookingSlotId` would quietly detach the engagement instead
 * of cancelling it). Cancel the engagements first.
 */
export const withdrawBookingSlot = withAction(
  {
    name: 'availability.withdrawSlot',
    auth: 'CHEF_STAFF',
    input: bookingSlotIdSchema,
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx, input) => {
    const slot = await ctx.db.bookingSlot.findUnique({
      where: { id: input.bookingSlotId },
      select: {
        id: true,
        staffProfileId: true,
        bookedCount: true,
        _count: { select: { appointments: true } },
      },
    })

    if (slot === null) {
      return fail('NOT_FOUND', 'We could not find that window.')
    }

    const scope = await requireStaffScope(ctx.db, ctx.user, slot.staffProfileId)

    if (!scope.ok) {
      return scope
    }

    if (slot.bookedCount > 0 || slot._count.appointments > 0) {
      return fail(
        'CONFLICT',
        'This window has bookings against it. Cancel those engagements before withdrawing it.'
      )
    }

    await ctx.db.bookingSlot.delete({ where: { id: slot.id } })

    return ok({ id: slot.id, deleted: true as const })
  }
)

// =============================================================================
// 8. The public gateway
// =============================================================================

/**
 * Search the diary for windows a guest may actually book.
 *
 * This is `availability.query` in `@mannachef/api-contract` — the same input
 * schema, the same envelope, so the Expo client and a React Server Component
 * see one API.
 *
 * ## What a stranger is allowed to learn
 *
 * A chef's **display name**, and the shape of the window: when it starts and
 * ends, how many seats it has, how many are gone, what service it is for, and
 * what it costs. That is the whole list. No email, no telephone number, no
 * base city, no hourly rate, no internal note, no hold expiry, and nothing at
 * all about the guests who took the other seats.
 *
 * ## What a stranger cannot reach
 *
 * Four filters are *overridden* rather than merely defaulted for a caller
 * below `CHEF_STAFF`, because a filter the client supplies is a request and
 * not a permission:
 *
 *  1. **Status.** Forced to `OPEN`. `HELD`, `BOOKED`, `FULL`, `CANCELLED` and
 *     `EXPIRED` windows are operational state; a guest who could ask for
 *     `HELD` would be reading a live checkout over somebody's shoulder.
 *  2. **The past.** The lower bound is raised to now. A diary of last month is
 *     a record of where a chef has been.
 *  3. **Unlisted chefs.** Only `isPubliclyListed` and `isAcceptingClients`
 *     profiles appear. A chef taken off the directory is off it here too.
 *  4. **Page size.** Left to `paginationSchema`'s ceiling of 100, which the
 *     rate limit above then bounds in aggregate.
 *
 * A `CHEF_STAFF` caller keeps the filters they asked for, including the closed
 * statuses and the past, because the same query backs the admin availability
 * board.
 */
export const listBookableWindows = withAction(
  {
    name: 'availability.query',
    auth: 'PUBLIC',
    input: bookingSlotFilterSchema,
    rateLimit: PUBLIC_QUERY_RATE_LIMIT,
  },
  async (ctx, input) => {
    const forStaff = hasRoleAtLeast(ctx.user?.role ?? null, 'CHEF_STAFF')
    const now = new Date()

    const startsAt: Prisma.DateTimeFilter = {}

    if (input.startsUntil !== undefined) {
      startsAt.lt = input.startsUntil
    }

    const where: Prisma.BookingSlotWhereInput = {}

    if (input.staffProfileId !== undefined) {
      where.staffProfileId = input.staffProfileId
    }

    if (input.serviceType !== undefined) {
      where.serviceType = input.serviceType
    }

    if (forStaff) {
      if (input.startsFrom !== undefined) {
        startsAt.gte = input.startsFrom
      }

      if (input.status !== undefined) {
        where.status = input.status
      }

      if (input.onlyBookable) {
        where.status = 'OPEN'
      }
    } else {
      // The requested lower bound is honoured only when it is *narrower* than
      // now. Raising it is a filter; lowering it would be a permission.
      startsAt.gte =
        input.startsFrom !== undefined &&
        input.startsFrom.getTime() > now.getTime()
          ? input.startsFrom
          : now

      where.status = 'OPEN'
      where.staffProfile = { isPubliclyListed: true, isAcceptingClients: true }
    }

    if (startsAt.gte !== undefined || startsAt.lt !== undefined) {
      where.startsAt = startsAt
    }

    const { skip, take } = paginationToSkipTake(input)

    const [rows, total] = await Promise.all([
      ctx.db.bookingSlot.findMany({
        where,
        orderBy: { startsAt: input.sortDirection },
        skip,
        take,
        select: BOOKABLE_WINDOW_SELECT,
      }),
      ctx.db.bookingSlot.count({ where }),
    ])

    return ok({
      items: rows.map((row) => toPublicWindow(row, forStaff)),
      meta: pageMetaFor(input.page, input.pageSize, total),
    })
  }
)

/**
 * Return lapsed soft holds to the market.
 *
 * Correctness does not depend on this running. `checkCapacity` in the engine
 * reads `holdsUntil` against the instant of the decision, so a hold that
 * lapsed a second ago already consumes nothing and a paying guest is already
 * being let through. What the sweep fixes is *visibility*: a lapsed hold still
 * carries `status: 'HELD'`, and the public filter above keys off `OPEN`, so
 * the window would go on being invisible until somebody touched it.
 *
 * Idempotent, and safe to run from a cron route or by hand.
 */
export const expireLapsedSlotHolds = withAction(
  {
    name: 'availability.expireHolds',
    auth: 'ADMIN',
    input: z.object({}).strict(),
    revalidatePaths: AVAILABILITY_PATHS,
    revalidateTags: AVAILABILITY_TAGS,
  },
  async (ctx) => {
    const now = new Date()

    const swept = await ctx.db.bookingSlot.updateMany({
      where: {
        status: 'HELD',
        // Strictly less than or equal, matching the engine: a hold expiring
        // exactly at `now` has expired.
        holdsUntil: { lte: now },
      },
      data: { status: 'OPEN', holdsUntil: null },
    })

    // A `HELD` row with no expiry at all cannot lapse and cannot be swept.
    // `bookingSlotCreateSchema` refuses to write one, so its presence means
    // somebody wrote to the table directly; surfacing the count is more useful
    // than silently leaving the window off the market for ever.
    const strandedHolds = await ctx.db.bookingSlot.count({
      where: { status: 'HELD', holdsUntil: null },
    })

    if (swept.count === 0 && strandedHolds === 0) {
      return ok({ swept: 0, strandedHolds: 0 })
    }

    return ok({ swept: swept.count, strandedHolds })
  }
)
