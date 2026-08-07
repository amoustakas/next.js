// mannachef/apps/web/src/server/actions/staff.ts

'use server'

/**
 * The chefs — their own records, the public directory card, and the admin
 * roster behind it.
 *
 * ## Two audiences, one table, two projections
 *
 * `StaffProfile` is read by a stranger browsing the marketing site and by an
 * administrator managing the kitchen, and the difference between them is
 * enforced in two places rather than one:
 *
 *  - **Which rows.** {@link listStaffDirectory} pins `isPubliclyListed` to
 *    `true` in the `WHERE` clause. `staffDirectoryFilterSchema` deliberately has
 *    no key for that column — see its own docblock — so no arrangement of query
 *    parameters can surface a chef we have hidden. {@link listStaffRoster} may
 *    ask the question, and is behind `auth: 'ADMIN'`.
 *  - **Which columns.** `STAFF_PUBLIC_SELECT` joins `User` for the chef's
 *    *name* and nothing else. No email address, no telephone number, no account
 *    id beyond the one already published in `staffProfileSummarySchema`, and no
 *    `isActive`. `STAFF_ROSTER_SELECT` adds the account columns, and every
 *    action that uses it is behind the role check.
 *
 * The directory returns exactly `staffProfileSummarySchema` from
 * `@mannachef/api-contract`, which is the shape the Expo client already expects
 * from `staff.directory`. That schema carries a base city and region — a chef
 * publishes where they cook, because that is what the visitor is choosing on —
 * and carries no contact detail of any kind.
 *
 * ## Who may edit whom
 *
 * A `CHEF_STAFF` may amend exactly one profile: the one their session names in
 * `staffProfileId`. Not "a profile whose `userId` matches", which would trust a
 * column of the row being edited — the session is the authority, and
 * {@link resolveStaffWriteAccess} compares against it before a write is even
 * shaped. `ADMIN` and above may amend anybody's.
 *
 * Two columns are narrower still. `isPubliclyListed` and `sortOrder` are
 * *curatorial*: they decide who appears on the marketing site and in what
 * order, which is a decision about the business rather than about the chef.
 * They are refused below `ADMIN` rather than silently dropped, because a chef
 * who tries to list themselves deserves to be told the answer is no.
 */

import {
  cuidSchema,
  hasRoleAtLeast,
  paginationToSkipTake,
  staffDirectoryFilterSchema,
  staffFlagFilterToBoolean,
  staffProfileCreateSchema,
  staffProfileUpdateSchema,
  staffRosterFilterSchema,
  type Role,
  type SortDirection,
  type StaffDirectorySortBy,
  type StaffRosterSortBy,
} from '@mannachef/validators'
import {
  emptyInputSchema,
  type PageMeta,
  type StaffProfileSummary,
} from '@mannachef/api-contract'
import { z } from 'zod'

import { fail, ok, type ActionResult } from '@/server/actions/types'
import { Prisma, type prisma } from '@/server/db'
import { withAction, type AuthenticatedUser } from '@/server/guards'

// =============================================================================
// 0. Constants
// =============================================================================

const STAFF_PATHS = [
  '/chefs',
  '/admin/staff',
  '/admin/calendar',
  '/portal/chefs',
] as const

const STAFF_TAGS = ['staff', 'staff-directory'] as const

/** The review statuses a public average rating is computed from. */
const PUBLISHED_REVIEW_STATUSES = ['APPROVED', 'FEATURED'] as const

// =============================================================================
// 1. Local input schemas
// =============================================================================

const staffProfileIdSchema = z.object({ staffProfileId: cuidSchema }).strict()

// =============================================================================
// 2. Projections
// =============================================================================

/** Exactly `mediaSummarySchema` from `@mannachef/api-contract`. */
const STAFF_MEDIA_SELECT = {
  id: true,
  url: true,
  thumbnailUrl: true,
  alt: true,
  caption: true,
  credit: true,
  kind: true,
  width: true,
  height: true,
  blurData: true,
} satisfies Prisma.MediaAssetSelect

/**
 * What a stranger may read.
 *
 * The `User` join is one column wide on purpose. Widening it is how an email
 * address ends up on a public page, so the narrowness is the safeguard rather
 * than an optimisation.
 */
const STAFF_PUBLIC_SELECT = {
  id: true,
  userId: true,
  title: true,
  bio: true,
  specialties: true,
  languages: true,
  hourlyRateCents: true,
  currency: true,
  serviceRadiusKm: true,
  yearsExperience: true,
  baseCity: true,
  baseRegion: true,
  baseCountry: true,
  calendarTimeZone: true,
  isAcceptingClients: true,
  maxConcurrentEvents: true,
  isPubliclyListed: true,
  sortOrder: true,
  createdAt: true,
  avatarMedia: { select: STAFF_MEDIA_SELECT },
  user: { select: { name: true } },
} satisfies Prisma.StaffProfileSelect

type StaffPublicPayload = Prisma.StaffProfileGetPayload<{
  select: typeof STAFF_PUBLIC_SELECT
}>

/** Everything above, plus the account columns only staff may read. */
const STAFF_ROSTER_SELECT = {
  ...STAFF_PUBLIC_SELECT,
  updatedAt: true,
  user: {
    select: { name: true, email: true, role: true, isActive: true },
  },
} satisfies Prisma.StaffProfileSelect

type StaffRosterPayload = Prisma.StaffProfileGetPayload<{
  select: typeof STAFF_ROSTER_SELECT
}>

/**
 * The shape {@link toStaffProfileSummary} needs.
 *
 * Written as a structural type rather than as a union of the two payloads so
 * that both selects satisfy it without the function having to know which one it
 * was handed — and so that adding a column to the roster select cannot change
 * what the public card renders.
 */
type StaffSummarySource = Omit<StaffPublicPayload, 'user'> & {
  readonly user: { readonly name: string | null }
}

/** A roster row: the public card, plus the account behind it. */
export interface StaffRosterView extends StaffProfileSummary {
  readonly accountName: string | null
  readonly accountEmail: string | null
  readonly accountRole: Role
  readonly isAccountActive: boolean
  readonly updatedAt: Date
}

export interface StaffDirectoryView {
  readonly items: readonly StaffProfileSummary[]
  readonly meta: PageMeta
}

export interface StaffRosterListView {
  readonly items: readonly StaffRosterView[]
  readonly meta: PageMeta
}

/** Mean rating and count over the published reviews of a set of chefs. */
interface RatingSummary {
  readonly averageRating: number | null
  readonly reviewCount: number
}

function buildPageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0

  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  }
}

/**
 * Published-review averages for a page of chefs, in one grouped query.
 *
 * `PENDING` and `REJECTED` reviews are excluded, so an unmoderated one-star
 * complaint cannot move a public average before anybody has read it. Returns an
 * empty map for an empty page rather than issuing a query with `in: []`.
 */
async function readChefRatings(
  db: typeof prisma,
  staffProfileIds: readonly string[]
): Promise<Map<string, RatingSummary>> {
  const summaries = new Map<string, RatingSummary>()

  if (staffProfileIds.length === 0) {
    return summaries
  }

  const grouped = await db.review.groupBy({
    by: ['staffProfileId'],
    where: {
      staffProfileId: { in: [...staffProfileIds] },
      status: { in: [...PUBLISHED_REVIEW_STATUSES] },
    },
    _avg: { rating: true },
    _count: { _all: true },
  })

  for (const group of grouped) {
    if (group.staffProfileId === null) {
      continue
    }

    const average = group._avg.rating

    summaries.set(group.staffProfileId, {
      averageRating: average === null ? null : Math.round(average * 10) / 10,
      reviewCount: group._count._all,
    })
  }

  return summaries
}

function toStaffProfileSummary(
  row: StaffSummarySource,
  ratings: ReadonlyMap<string, RatingSummary>
): StaffProfileSummary {
  const rating = ratings.get(row.id)

  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    title: row.title,
    bio: row.bio,
    specialties: row.specialties,
    languages: row.languages,
    hourlyRateCents: row.hourlyRateCents,
    currency: row.currency,
    serviceRadiusKm: row.serviceRadiusKm,
    yearsExperience: row.yearsExperience,
    baseCity: row.baseCity,
    baseRegion: row.baseRegion,
    baseCountry: row.baseCountry,
    calendarTimeZone: row.calendarTimeZone,
    isAcceptingClients: row.isAcceptingClients,
    maxConcurrentEvents: row.maxConcurrentEvents,
    isPubliclyListed: row.isPubliclyListed,
    sortOrder: row.sortOrder,
    avatarMedia: row.avatarMedia,
    averageRating: rating?.averageRating ?? null,
    reviewCount: rating?.reviewCount ?? 0,
    createdAt: row.createdAt,
  }
}

function toStaffRosterView(
  row: StaffRosterPayload,
  ratings: ReadonlyMap<string, RatingSummary>
): StaffRosterView {
  return {
    ...toStaffProfileSummary(row, ratings),
    accountName: row.user.name,
    accountEmail: row.user.email,
    accountRole: row.user.role,
    isAccountActive: row.user.isActive,
    updatedAt: row.updatedAt,
  }
}

// =============================================================================
// 3. Write access
// =============================================================================

/**
 * May this caller amend this profile?
 *
 * The chef's own id comes from the **session** — `AuthenticatedUser.staffProfileId`,
 * put there by the session callback in `@/server/auth` — and never from the row
 * being edited. Comparing against `row.userId` would work today and would be
 * the wrong shape: it asks the object under attack to vouch for itself.
 *
 * There is no ownership guard in `@/server/guards` for `StaffProfile` because
 * the entity is not client-scoped; the seven guards there cover the rows a
 * *household* owns. This is the staff-side equivalent, and it is deliberately
 * the only place the rule is written.
 *
 * Returns `NOT_FOUND` for a profile that does not exist and for one the caller
 * has no business touching — the same answer, so the id space cannot be
 * enumerated.
 */
async function resolveStaffWriteAccess(
  db: typeof prisma,
  user: AuthenticatedUser,
  staffProfileId: string
): Promise<ActionResult<{ id: string; userId: string }>> {
  const row = await db.staffProfile.findUnique({
    where: { id: staffProfileId },
    select: { id: true, userId: true },
  })

  if (row === null) {
    return fail('NOT_FOUND', 'We could not find that chef.')
  }

  if (hasRoleAtLeast(user.role, 'ADMIN')) {
    return ok(row)
  }

  if (user.staffProfileId !== null && user.staffProfileId === row.id) {
    return ok(row)
  }

  return fail('NOT_FOUND', 'We could not find that chef.')
}

/**
 * A base country with no city and no region is not a base.
 *
 * `staffProfileCreateSchema` already enforces this within a payload. The update
 * path needs the same rule against the *merged* row, because a partial update
 * that clears `baseCity` never mentions `baseCountry` and so slips past a
 * payload-only check. Returns the message, or `null` when the trio is coherent.
 */
function incoherentBase(
  baseCountry: string | null,
  baseCity: string | null,
  baseRegion: string | null
): string | null {
  if (baseCountry === null) {
    return null
  }

  if (baseCity !== null || baseRegion !== null) {
    return null
  }

  return 'A country on its own is not a base — please add a city or region.'
}

// =============================================================================
// 4. Create, update, remove
// =============================================================================

/**
 * Open a chef's profile against an account.
 *
 * `ADMIN` and above. A chef does not create their own record — `StaffProfile`
 * is what makes an account bookable, and an account that can make itself
 * bookable is an account that can put itself on the marketing site.
 *
 * Three checks the schema cannot make, in the order a mistake is most likely:
 *
 *  1. the account exists and is active;
 *  2. it carries `CHEF_STAFF` or above, because a profile on a `CLIENT` account
 *     would be bookable by a household with no standing to cook;
 *  3. it has no profile already — `StaffProfile.userId` is `@unique`, and the
 *     pre-check turns a second attempt into a sentence rather than a `P2002`.
 *
 * `avatarMediaId` is confirmed to name a real `MediaAsset`, so a mistyped id is
 * `NOT_FOUND` rather than a foreign-key violation arriving as `CONFLICT`.
 */
export const createStaffProfile = withAction(
  {
    name: 'staff.profile.create',
    auth: 'ADMIN',
    input: staffProfileCreateSchema,
    revalidatePaths: STAFF_PATHS,
    revalidateTags: STAFF_TAGS,
  },
  async (ctx, input): Promise<ActionResult<StaffRosterView>> => {
    const account = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        role: true,
        isActive: true,
        staffProfile: { select: { id: true } },
      },
    })

    if (account === null || !account.isActive) {
      return fail('NOT_FOUND', 'We could not find that account.')
    }

    if (!hasRoleAtLeast(account.role, 'CHEF_STAFF')) {
      return fail(
        'CONFLICT',
        'Please raise this account to chef staff before opening a profile for it.',
        { userId: ['This account is not a member of the kitchen.'] }
      )
    }

    if (account.staffProfile !== null) {
      return fail('CONFLICT', 'This account already has a chef profile.', {
        userId: ['A chef profile is already open on this account.'],
      })
    }

    const avatarMediaId = input.avatarMediaId ?? null

    if (avatarMediaId !== null) {
      const media = await ctx.db.mediaAsset.findUnique({
        where: { id: avatarMediaId },
        select: { id: true },
      })

      if (media === null) {
        return fail('NOT_FOUND', 'We could not find that portrait.', {
          avatarMediaId: ['Please choose an image that has been uploaded.'],
        })
      }
    }

    const created = await ctx.db.staffProfile.create({
      data: {
        userId: account.id,
        title: input.title ?? null,
        bio: input.bio ?? null,
        specialties: input.specialties,
        languages: input.languages,
        hourlyRateCents: input.hourlyRateCents,
        currency: input.currency,
        serviceRadiusKm: input.serviceRadiusKm,
        yearsExperience: input.yearsExperience ?? null,
        baseCity: input.baseCity ?? null,
        baseRegion: input.baseRegion ?? null,
        baseCountry: input.baseCountry ?? null,
        calendarTimeZone: input.calendarTimeZone,
        isAcceptingClients: input.isAcceptingClients,
        maxConcurrentEvents: input.maxConcurrentEvents,
        isPubliclyListed: input.isPubliclyListed,
        sortOrder: input.sortOrder,
        avatarMediaId,
      },
      select: STAFF_ROSTER_SELECT,
    })

    const ratings = await readChefRatings(ctx.db, [created.id])

    return ok(toStaffRosterView(created, ratings))
  }
)

/**
 * Amend a chef's profile.
 *
 * `auth: 'SESSION'` rather than `'CHEF_STAFF'`, because the role is not what
 * decides this: {@link resolveStaffWriteAccess} does, against the session's own
 * `staffProfileId`. A `CLIENT` with no profile fails that check and receives
 * `NOT_FOUND`, which is the same answer a chef gets for a colleague's id.
 *
 * `staffProfileUpdateSchema` is built by `buildUpdateSchema`, which strips the
 * eight `.default(...)`s before making the shape partial. That strip is
 * load-bearing here in a way worth naming: without it, a chef correcting a typo
 * in their biography would re-list themselves publicly, reset their hourly rate
 * to zero, move their calendar to Toronto, and go back to accepting new
 * households. The conditional spreads below carry the property through to the
 * column — a key the caller did not send is not written at all.
 *
 * `isPubliclyListed` and `sortOrder` are refused below `ADMIN`; see the file
 * docblock for why they are refused rather than dropped.
 */
export const updateStaffProfile = withAction(
  {
    name: 'staff.profile.update',
    auth: 'SESSION',
    input: staffProfileUpdateSchema,
    revalidatePaths: STAFF_PATHS,
    revalidateTags: STAFF_TAGS,
  },
  async (ctx, input): Promise<ActionResult<StaffRosterView>> => {
    const access = await resolveStaffWriteAccess(ctx.db, ctx.user, input.id)

    if (!access.ok) {
      return access
    }

    const curator = hasRoleAtLeast(ctx.user.role, 'ADMIN')

    if (
      !curator &&
      (input.isPubliclyListed !== undefined || input.sortOrder !== undefined)
    ) {
      return fail(
        'FORBIDDEN',
        'Whether a chef appears in the directory, and where, is set by an administrator.',
        {
          isPubliclyListed: [
            'Please ask an administrator to change your listing.',
          ],
        }
      )
    }

    const stored = await ctx.db.staffProfile.findUnique({
      where: { id: access.data.id },
      select: { baseCity: true, baseRegion: true, baseCountry: true },
    })

    if (stored === null) {
      return fail('NOT_FOUND', 'We could not find that chef.')
    }

    const mergedCountry =
      input.baseCountry === undefined ? stored.baseCountry : input.baseCountry
    const mergedCity =
      input.baseCity === undefined ? stored.baseCity : input.baseCity
    const mergedRegion =
      input.baseRegion === undefined ? stored.baseRegion : input.baseRegion

    const baseProblem = incoherentBase(mergedCountry, mergedCity, mergedRegion)

    if (baseProblem !== null) {
      return fail('VALIDATION', baseProblem, { baseCity: [baseProblem] })
    }

    if (input.avatarMediaId !== undefined && input.avatarMediaId !== null) {
      const media = await ctx.db.mediaAsset.findUnique({
        where: { id: input.avatarMediaId },
        select: { id: true },
      })

      if (media === null) {
        return fail('NOT_FOUND', 'We could not find that portrait.', {
          avatarMediaId: ['Please choose an image that has been uploaded.'],
        })
      }
    }

    const updated = await ctx.db.staffProfile.update({
      where: { id: access.data.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.bio === undefined ? {} : { bio: input.bio }),
        ...(input.specialties === undefined
          ? {}
          : { specialties: input.specialties }),
        ...(input.languages === undefined
          ? {}
          : { languages: input.languages }),
        // A chef sets their own rate, and that is deliberate (MCV-043, finding
        // H). It looks at first like the money hole `isPubliclyListed` and
        // `sortOrder` are gated against, and it is not one, because
        // `hourlyRateCents` never reaches an amount anybody is charged or paid.
        // Every read of the column in the repository was enumerated: the roster
        // projection at `STAFF_ROSTER_SELECT`/`toStaffRosterView`, the two sort
        // keys in `directoryOrderBy` and `rosterOrderBy`, and the two directory
        // filter bounds. That is all of them. No invoice line, no appointment
        // total, no ledger entry is computed from it — a chef's actual pay runs
        // through payroll, which this platform does not model, and an
        // engagement's price is `ChefAppointment.totalCents`, which
        // `booking.ts` writes only for a staff caller.
        //
        // So the column is a **listing figure**: the rate a chef advertises,
        // like their biography and their specialities, and the same thing they
        // would say on the telephone. Gating it would mean an administrator had
        // to retype a number that costs the business nothing.
        //
        // The distinction that decides it is *who bears the consequence*.
        // `isPubliclyListed` and `sortOrder` allocate a shared, finite resource
        // — the directory's attention — between chefs who are competing for it,
        // which is why they are the curator's. A rate is a claim about oneself.
        // If a future change ever multiplies this column by anything, it stops
        // being a claim and becomes a price, and it must be gated in the same
        // breath as that change.
        ...(input.hourlyRateCents === undefined
          ? {}
          : { hourlyRateCents: input.hourlyRateCents }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.serviceRadiusKm === undefined
          ? {}
          : { serviceRadiusKm: input.serviceRadiusKm }),
        ...(input.yearsExperience === undefined
          ? {}
          : { yearsExperience: input.yearsExperience }),
        ...(input.baseCity === undefined ? {} : { baseCity: input.baseCity }),
        ...(input.baseRegion === undefined
          ? {}
          : { baseRegion: input.baseRegion }),
        ...(input.baseCountry === undefined
          ? {}
          : { baseCountry: input.baseCountry }),
        ...(input.calendarTimeZone === undefined
          ? {}
          : { calendarTimeZone: input.calendarTimeZone }),
        ...(input.isAcceptingClients === undefined
          ? {}
          : { isAcceptingClients: input.isAcceptingClients }),
        ...(input.maxConcurrentEvents === undefined
          ? {}
          : { maxConcurrentEvents: input.maxConcurrentEvents }),
        ...(curator && input.isPubliclyListed !== undefined
          ? { isPubliclyListed: input.isPubliclyListed }
          : {}),
        ...(curator && input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
        ...(input.avatarMediaId === undefined
          ? {}
          : { avatarMediaId: input.avatarMediaId }),
      },
      select: STAFF_ROSTER_SELECT,
    })

    const ratings = await readChefRatings(ctx.db, [updated.id])

    return ok(toStaffRosterView(updated, ratings))
  }
)

/**
 * Close a chef's profile.
 *
 * `ChefAppointment.staffProfile` is `onDelete: Restrict`, so an engagement
 * anywhere in the diary — past or future — blocks the delete at the database.
 * The count is taken first so that block is a sentence with a number in it
 * rather than a foreign-key violation surfacing as a bare `CONFLICT`, and the
 * sentence points at the alternative: unlist the chef, which keeps the history
 * and takes them off the site.
 *
 * `ChefAvailability` and `BookingSlot` cascade, which is correct — an
 * availability rule for a chef who has gone is not a rule.
 */
export const deleteStaffProfile = withAction(
  {
    name: 'staff.profile.delete',
    auth: 'ADMIN',
    input: staffProfileIdSchema,
    revalidatePaths: STAFF_PATHS,
    revalidateTags: STAFF_TAGS,
  },
  async (ctx, input): Promise<ActionResult<{ id: string }>> => {
    const row = await ctx.db.staffProfile.findUnique({
      where: { id: input.staffProfileId },
      select: { id: true },
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that chef.')
    }

    const engagements = await ctx.db.chefAppointment.count({
      where: { staffProfileId: row.id },
    })

    if (engagements > 0) {
      return fail(
        'CONFLICT',
        `This chef has ${engagements} engagement${engagements === 1 ? '' : 's'} on record. Unlist them instead of removing the profile.`
      )
    }

    await ctx.db.staffProfile.delete({
      where: { id: row.id },
      select: { id: true },
    })

    return ok({ id: row.id })
  }
)

// =============================================================================
// 5. Reading — the public directory
// =============================================================================

function directoryOrderBy(
  sortBy: StaffDirectorySortBy,
  direction: SortDirection
): Prisma.StaffProfileOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CURATED':
      return [{ sortOrder: 'asc' }, { createdAt: direction }, { id: 'asc' }]

    case 'EXPERIENCE':
      return [
        { yearsExperience: { sort: direction, nulls: 'last' } },
        { id: 'asc' },
      ]

    case 'HOURLY_RATE':
      return [{ hourlyRateCents: direction }, { id: 'asc' }]

    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    default: {
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

function rosterOrderBy(
  sortBy: StaffRosterSortBy,
  direction: SortDirection
): Prisma.StaffProfileOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CURATED':
      return [{ sortOrder: 'asc' }, { createdAt: direction }, { id: 'asc' }]

    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    case 'EXPERIENCE':
      return [
        { yearsExperience: { sort: direction, nulls: 'last' } },
        { id: 'asc' },
      ]

    case 'HOURLY_RATE':
      return [{ hourlyRateCents: direction }, { id: 'asc' }]

    case 'TITLE':
      return [{ title: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    default: {
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * The narrowing both audiences share.
 *
 * `specialties` and `languages` are `String[]` columns, so they are matched
 * with `hasSome` — "any of these" is what a facet filter means, and PostgreSQL
 * array containment is exact rather than case-insensitive. `freeTextList` has
 * already trimmed and de-duplicated the terms; it deliberately does not
 * case-fold them, so the values stored and the values searched for are compared
 * as written.
 */
function sharedStaffFilters(filter: {
  readonly search?: string | undefined
  readonly specialties: readonly string[]
  readonly languages: readonly string[]
  readonly baseCity?: string | undefined
  readonly baseRegion?: string | undefined
  readonly baseCountry?: string | undefined
  readonly minHourlyRateCents?: number | undefined
  readonly maxHourlyRateCents?: number | undefined
  readonly minYearsExperience?: number | undefined
  readonly maxServiceRadiusKm?: number | undefined
}): Prisma.StaffProfileWhereInput[] {
  const filters: Prisma.StaffProfileWhereInput[] = []

  if (filter.search !== undefined) {
    filters.push({
      OR: [
        { title: { contains: filter.search, mode: 'insensitive' } },
        { bio: { contains: filter.search, mode: 'insensitive' } },
        { baseCity: { contains: filter.search, mode: 'insensitive' } },
        { user: { name: { contains: filter.search, mode: 'insensitive' } } },
      ],
    })
  }

  if (filter.specialties.length > 0) {
    filters.push({ specialties: { hasSome: [...filter.specialties] } })
  }

  if (filter.languages.length > 0) {
    filters.push({ languages: { hasSome: [...filter.languages] } })
  }

  if (filter.baseCity !== undefined) {
    filters.push({
      baseCity: { contains: filter.baseCity, mode: 'insensitive' },
    })
  }

  if (filter.baseRegion !== undefined) {
    filters.push({
      baseRegion: { contains: filter.baseRegion, mode: 'insensitive' },
    })
  }

  if (filter.baseCountry !== undefined) {
    filters.push({ baseCountry: filter.baseCountry })
  }

  if (filter.minHourlyRateCents !== undefined) {
    filters.push({ hourlyRateCents: { gte: filter.minHourlyRateCents } })
  }

  if (filter.maxHourlyRateCents !== undefined) {
    filters.push({ hourlyRateCents: { lte: filter.maxHourlyRateCents } })
  }

  if (filter.minYearsExperience !== undefined) {
    filters.push({ yearsExperience: { gte: filter.minYearsExperience } })
  }

  if (filter.maxServiceRadiusKm !== undefined) {
    filters.push({ serviceRadiusKm: { lte: filter.maxServiceRadiusKm } })
  }

  return filters
}

/**
 * The public chef directory.
 *
 * `isPubliclyListed: true` is pushed into the `WHERE` clause here and appears
 * nowhere in `staffDirectoryFilterSchema`, so it is not a default a caller can
 * override — it is not addressable at all. That is the security property this
 * action exists to hold, and it is why the roster below is a separate action
 * rather than the same one with a flag.
 *
 * The projection carries a chef's professional identity — name, title,
 * biography, repertoire, languages, base city and region, rate — and no contact
 * detail of any kind. Nothing here reaches `User.email` or `User.phone`.
 */
export const listStaffDirectory = withAction(
  {
    name: 'staff.directory',
    auth: 'PUBLIC',
    input: staffDirectoryFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<StaffDirectoryView>> => {
    const filters = sharedStaffFilters(filter)

    filters.push({ isPubliclyListed: true })

    if (filter.acceptingClientsOnly) {
      filters.push({ isAcceptingClients: true })
    }

    const where: Prisma.StaffProfileWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.staffProfile.count({ where }),
      ctx.db.staffProfile.findMany({
        where,
        select: STAFF_PUBLIC_SELECT,
        orderBy: directoryOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    const ratings = await readChefRatings(
      ctx.db,
      rows.map((row) => row.id)
    )

    return ok({
      items: rows.map((row) => toStaffProfileSummary(row, ratings)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * One chef's directory card.
 *
 * Public, and pinned the same way the list is: below `CHEF_STAFF` an unlisted
 * chef is `NOT_FOUND`, which is the answer an id that never existed gets. Staff
 * see the card whatever its listing state, because that is the preview an
 * administrator needs before publishing it.
 */
export const readStaffProfile = withAction(
  {
    name: 'staff.profile.read',
    auth: 'PUBLIC',
    input: staffProfileIdSchema,
  },
  async (ctx, input): Promise<ActionResult<StaffProfileSummary>> => {
    const row = await ctx.db.staffProfile.findUnique({
      where: { id: input.staffProfileId },
      select: STAFF_PUBLIC_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that chef.')
    }

    const insider =
      ctx.user !== null && hasRoleAtLeast(ctx.user.role, 'CHEF_STAFF')

    if (!row.isPubliclyListed && !insider) {
      return fail('NOT_FOUND', 'We could not find that chef.')
    }

    const ratings = await readChefRatings(ctx.db, [row.id])

    return ok(toStaffProfileSummary(row, ratings))
  }
)

// =============================================================================
// 6. Reading — the admin roster
// =============================================================================

/**
 * The roster in the business OS.
 *
 * Everything the directory can ask, plus the three questions only staff may
 * ask: whether a chef is listed, whether they are taking work, and when their
 * record was created. `staffFlagFilterToBoolean` turns the tri-state
 * `ANY | YES | NO` into the `boolean | undefined` a `where` clause wants, so
 * "either" is expressed by leaving the column out of the query rather than by a
 * pair of contradictory flags.
 *
 * `ADMIN`, and the projection is `STAFF_ROSTER_SELECT` — the one place in this
 * file where an email address is read.
 */
export const listStaffRoster = withAction(
  {
    name: 'staff.roster',
    auth: 'ADMIN',
    input: staffRosterFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<StaffRosterListView>> => {
    const filters = sharedStaffFilters(filter)

    if (filter.userId !== undefined) {
      filters.push({ userId: filter.userId })
    }

    const accepting = staffFlagFilterToBoolean(filter.isAcceptingClients)

    if (accepting !== undefined) {
      filters.push({ isAcceptingClients: accepting })
    }

    const listed = staffFlagFilterToBoolean(filter.isPubliclyListed)

    if (listed !== undefined) {
      filters.push({ isPubliclyListed: listed })
    }

    if (filter.missingAvatarOnly) {
      filters.push({ avatarMediaId: null })
    }

    if (filter.createdFrom !== undefined) {
      filters.push({ createdAt: { gte: filter.createdFrom } })
    }

    if (filter.createdTo !== undefined) {
      filters.push({ createdAt: { lte: filter.createdTo } })
    }

    const where: Prisma.StaffProfileWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.staffProfile.count({ where }),
      ctx.db.staffProfile.findMany({
        where,
        select: STAFF_ROSTER_SELECT,
        orderBy: rosterOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    const ratings = await readChefRatings(
      ctx.db,
      rows.map((row) => row.id)
    )

    return ok({
      items: rows.map((row) => toStaffRosterView(row, ratings)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * The caller's own chef profile.
 *
 * Takes no input, so there is no id to check ownership of — the profile is
 * whichever one the session names. A caller whose session carries no
 * `staffProfileId` has no profile, which is `NOT_FOUND` rather than an error.
 *
 * Returns the roster shape because a chef is entitled to see their own account
 * columns; they are their own.
 */
export const readMyStaffProfile = withAction(
  {
    name: 'staff.profile.read.mine',
    auth: 'CHEF_STAFF',
    input: emptyInputSchema,
  },
  async (ctx): Promise<ActionResult<StaffRosterView>> => {
    const staffProfileId = ctx.user.staffProfileId

    if (staffProfileId === null) {
      return fail('NOT_FOUND', 'There is no chef profile on this account yet.')
    }

    const row = await ctx.db.staffProfile.findUnique({
      where: { id: staffProfileId },
      select: STAFF_ROSTER_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'There is no chef profile on this account yet.')
    }

    const ratings = await readChefRatings(ctx.db, [row.id])

    return ok(toStaffRosterView(row, ratings))
  }
)
