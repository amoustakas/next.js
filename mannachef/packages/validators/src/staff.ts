// mannachef/packages/validators/src/staff.ts

/**
 * Staff domain validation — the chef's own record: who they are, what they
 * cook, where they travel, what they cost, and whether the marketing site is
 * allowed to show them at all.
 *
 * Mirrors `StaffProfile` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * ## Why this file exists (MCV-005)
 *
 * `StaffProfile` had no schema of any kind, which is remarkable given that the
 * entire booking domain keys on `staffProfileId` — `ChefAvailability`,
 * `BookingSlot`, `ChefAppointment`, `ConsultationInterview` and the `CHEF`
 * branch of `reviewSubmissionSchema` all point here. Every one of those
 * validated the *reference* and nothing validated the *row*, so a chef could be
 * created with a negative hourly rate, a two-thousand-kilometre service radius,
 * a time zone the runtime cannot resolve, and forty duplicate specialities, and
 * the only thing that would ever complain was Postgres, on the `VarChar` widths.
 *
 * ## Rules that govern this file (see `mannachef/CONTRACT.md`)
 *
 *  1. No runtime dependency on `@prisma/client` — enums arrive from `./enums`.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *     `hasSomethingToSave`, `withoutDefaults`, `queryFlag` and `optionalProse`
 *     all have exactly one home, and it is not this file.
 *  3. `timeZoneSchema` is imported from `./booking` rather than restated.
 *     `StaffProfile.calendarTimeZone` and `ChefAvailability.timeZone` are the
 *     same `VarChar(64)` IANA identifier validated against the same
 *     `Intl.DateTimeFormat` authority, and the note above that schema already
 *     says it moves rather than being copied when a second domain needs it.
 *     This is that second domain; the import is the move.
 *  4. The eighteen writable columns are `userId` plus the seventeen the profile
 *     carries: title, bio, specialties, languages, hourlyRateCents, currency,
 *     serviceRadiusKm, yearsExperience, baseCity, baseRegion, baseCountry,
 *     calendarTimeZone, isAcceptingClients, maxConcurrentEvents,
 *     isPubliclyListed, sortOrder, avatarMediaId. `id`, `createdAt` and
 *     `updatedAt` are the database's business.
 *  5. Two filter schemas, because there are two audiences with two different
 *     rights. `staffDirectoryFilterSchema` is the public chef directory and has
 *     **no key for `isPubliclyListed`** — the action pins it to `true`, so a
 *     visitor cannot ask for the chefs we have deliberately hidden.
 *     `staffRosterFilterSchema` is the admin roster and can see everything.
 *  6. Both filters are read from a query string, so every numeric and temporal
 *     bound goes through the coercion helpers in `./common`. The create and
 *     update schemas stay strict — they are request bodies.
 */

import { z } from 'zod'

import { timeZoneSchema } from './booking'
import {
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  countryCodeSchema,
  crossField,
  crossFieldMixed,
  cuidSchema,
  currencySchema,
  freeTextList,
  intSchema,
  isoDateTimeSchema,
  moneyCentsSchema,
  optionalProse,
  paginationSchema,
  queryFlag,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'

// =============================================================================
// Limits
// =============================================================================

/** Matches `StaffProfile.title` — `@db.VarChar(160)`. */
export const MAX_STAFF_TITLE_LENGTH = 160

/** Generous ceiling for the `@db.Text` biography on a chef's directory card. */
export const MAX_STAFF_BIO_LENGTH = 4_000

/** How many specialities read as a repertoire rather than a phone book. */
export const MAX_STAFF_SPECIALTIES = 20

/** How many languages one chef may claim to cook and converse in. */
export const MAX_STAFF_LANGUAGES = 12

/** $10,000.00 an hour. Absurd, which is exactly what a ceiling is for. */
export const MAX_HOURLY_RATE_CENTS = 1_000_000

/** Beyond this a chef is not travelling to a dinner, they are relocating. */
export const MAX_SERVICE_RADIUS_KM = 500

/** Nobody has been cooking professionally for longer than this. */
export const MAX_YEARS_EXPERIENCE = 80

/** How many engagements one chef may hold at the same moment. */
export const MAX_CONCURRENT_EVENTS = 10

/** A manual position within the chef directory. */
export const MAX_STAFF_SORT_ORDER = 10_000

/** Matches `StaffProfile.baseCity` / `baseRegion` — `@db.VarChar(120)`. */
const MAX_STAFF_LOCALITY_LENGTH = 120

/** How many specialities or languages one search may narrow by. */
const MAX_FILTER_LIST_ENTRIES = 10

// =============================================================================
// Field schemas
// =============================================================================

/**
 * What the chef is called on their directory card — "Executive Chef",
 * "Pâtissier", "Chef de Cuisine". Sending `null` removes it.
 */
export const staffTitleSchema = optionalProse(
  MAX_STAFF_TITLE_LENGTH,
  'Please keep the title to 160 characters or fewer.'
)

/** The biography that runs beneath the chef's portrait. `null` clears it. */
export const staffBioSchema = optionalProse(
  MAX_STAFF_BIO_LENGTH,
  'Please keep the biography to 4,000 characters or fewer.'
)

/** What this chef is known for: "wood-fired", "Levantine", "pastry". */
export const staffSpecialtiesSchema = freeTextList({
  maxEntries: MAX_STAFF_SPECIALTIES,
  missingError: 'Please list what this chef is known for.',
  emptyEntryError: 'Please name the speciality, or remove the empty entry.',
  longEntryError: 'Please keep each speciality to 120 characters or fewer.',
  tooManyError: 'Twenty specialities is a repertoire; more is a phone book.',
})

/** The languages this chef cooks and converses in. */
export const staffLanguagesSchema = freeTextList({
  maxEntries: MAX_STAFF_LANGUAGES,
  missingError: 'Please list the languages this chef speaks.',
  emptyEntryError: 'Please name the language, or remove the empty entry.',
  longEntryError: 'Please keep each language to 120 characters or fewer.',
  tooManyError: 'Please list twelve languages or fewer.',
})

/** The chef's standard hourly rate, in whole cents. */
export const hourlyRateCentsSchema = moneyCentsSchema.max(
  MAX_HOURLY_RATE_CENTS,
  { error: 'That rate is beyond anything we bill — please check the figure.' }
)
export type HourlyRateCents = z.infer<typeof hourlyRateCentsSchema>

/** How far from their base the chef will travel for an engagement. */
export const serviceRadiusKmSchema = intSchema(0, MAX_SERVICE_RADIUS_KM, {
  notAnInteger: 'Please give the travelling distance in whole kilometres.',
  tooSmall: 'A travelling distance cannot be negative.',
  tooLarge: 'Please keep the travelling distance to 500 kilometres or fewer.',
})
export type ServiceRadiusKm = z.infer<typeof serviceRadiusKmSchema>

/** Years spent cooking professionally. `null` means we have not asked. */
export const yearsExperienceSchema = intSchema(0, MAX_YEARS_EXPERIENCE, {
  notAnInteger: 'Please give the experience in whole years.',
  tooSmall: 'Years of experience cannot be negative.',
  tooLarge: 'Please give a figure of eighty years or fewer.',
})
export type YearsExperience = z.infer<typeof yearsExperienceSchema>

/** How many engagements this chef may hold concurrently. */
export const maxConcurrentEventsSchema = intSchema(1, MAX_CONCURRENT_EVENTS, {
  notAnInteger: 'Please give a whole number of concurrent engagements.',
  tooSmall: 'A chef must be able to hold at least one engagement.',
  tooLarge: 'Ten concurrent engagements is the most we will schedule.',
})
export type MaxConcurrentEvents = z.infer<typeof maxConcurrentEventsSchema>

/** A manual position within the chef directory. */
export const staffSortOrderSchema = intSchema(0, MAX_STAFF_SORT_ORDER, {
  notAnInteger: 'Please give a whole number for the running order.',
  tooSmall: 'The running order begins at zero.',
  tooLarge: 'That position sits far beyond the end of the directory.',
})
export type StaffSortOrder = z.infer<typeof staffSortOrderSchema>

/** The city the chef works out of. `null` clears it. */
const baseCitySchema = optionalProse(
  MAX_STAFF_LOCALITY_LENGTH,
  'Please keep the city to 120 characters or fewer.'
)

/** The province or territory the chef works out of. `null` clears it. */
const baseRegionSchema = optionalProse(
  MAX_STAFF_LOCALITY_LENGTH,
  'Please keep the province or territory to 120 characters or fewer.'
)

// =============================================================================
// 1. Create & update
// =============================================================================

/**
 * The seventeen columns a chef's profile carries, before `userId` is added for
 * a create or `id` for an update.
 *
 * Seven of them declare a `.default(...)`, which is precisely why the update
 * schema below must go through `buildUpdateSchema`: `hourlyRateCents`,
 * `currency`, `serviceRadiusKm`, `calendarTimeZone`, `isAcceptingClients`,
 * `maxConcurrentEvents`, `isPubliclyListed` and `sortOrder` would otherwise be
 * re-applied by a `.partial()` on every save — quietly re-listing a chef we had
 * hidden and resetting the rate of one we had just repriced.
 */
export const staffProfileWritableShape = {
  title: staffTitleSchema,
  bio: staffBioSchema,
  specialties: staffSpecialtiesSchema,
  languages: staffLanguagesSchema,
  hourlyRateCents: hourlyRateCentsSchema.default(0),
  currency: currencySchema,
  serviceRadiusKm: serviceRadiusKmSchema.default(25),
  /** `null` means we have not recorded it, which is not the same as zero. */
  yearsExperience: yearsExperienceSchema.nullable().optional(),
  baseCity: baseCitySchema,
  baseRegion: baseRegionSchema,
  /** `null` clears it; anything else must be an ISO 3166-1 alpha-2 code. */
  baseCountry: countryCodeSchema.nullable().optional(),
  calendarTimeZone: timeZoneSchema,
  isAcceptingClients: z
    .boolean({
      error: 'Please say whether this chef is taking on new households.',
    })
    .default(true),
  maxConcurrentEvents: maxConcurrentEventsSchema.default(1),
  isPubliclyListed: z
    .boolean({
      error: 'Please say whether this chef appears in the public directory.',
    })
    .default(true),
  sortOrder: staffSortOrderSchema.default(0),
  /** A `MediaAsset` portrait. `null` detaches it. Ownership re-checked server-side. */
  avatarMediaId: cuidSchema.nullable().optional(),
} as const

/**
 * Creating a chef's profile.
 *
 * `userId` is the eighteenth writable column and appears only here: a profile
 * is attached to its account once and never re-parented, because
 * `StaffProfile.userId` is `@unique` and every booking already hanging off the
 * profile would silently change hands.
 *
 * The action still re-checks that the account exists, that it carries
 * `CHEF_STAFF` or above, and that it has no profile already
 * (`mannachef/CONTRACT.md` §5) — a cuid that parses is not a cuid that belongs
 * to the caller's tenant.
 */
export const staffProfileCreateSchema = z
  .object({
    userId: cuidSchema,
    ...staffProfileWritableShape,
  })
  .strict()
  .check(
    // `baseCountry` is the dependency: the rule only has anything to say once a
    // country has been given, and a `baseCountry` the ISO 3166 check rejected
    // should produce that one issue rather than also this one. `baseCity` and
    // `baseRegion` are read from the raw object because it is their absence the
    // rule is about, and a declared dependency that is absent skips the check.
    crossFieldMixed(
      {
        deps: { baseCountry: 'present' },
        error:
          'A country on its own is not a base — please add a city or region.',
        path: ['baseCity'],
      },
      (_country, raw) => raw.baseCity != null || raw.baseRegion != null
    )
  )
export type StaffProfileCreateInput = z.infer<typeof staffProfileCreateSchema>
export type StaffProfileCreateRawInput = z.input<
  typeof staffProfileCreateSchema
>

/**
 * Amending a chef's profile.
 *
 * Built by `buildUpdateSchema`, which strips the eight `.default(...)`s
 * *before* the `.partial()`, restores `id` as the one required key, closes the
 * object with `.strict()`, and refuses a payload that carries nothing but that
 * id via `hasSomethingToSaveBeyond(1)`.
 *
 * `userId` is deliberately absent: see the note on the create schema.
 */
export const staffProfileUpdateSchema = buildUpdateSchema(
  staffProfileWritableShape,
  { requireKeys: { id: cuidSchema } }
)
export type StaffProfileUpdateInput = z.infer<typeof staffProfileUpdateSchema>
export type StaffProfileUpdateRawInput = z.input<
  typeof staffProfileUpdateSchema
>

// =============================================================================
// 2. Filtering — a shared vocabulary for two audiences
// =============================================================================

/**
 * A tri-state boolean for a roster column.
 *
 * `queryFlag` is the right tool when a flag narrows or does nothing —
 * "featured only" has no third meaning. An admin roster genuinely has three
 * questions to ask of `isAcceptingClients`: *anyone*, *only the chefs taking
 * work*, and *only the chefs who are not*. A pair of `queryFlag`s can express
 * that, but it can also express "only accepting **and** only not accepting",
 * which is nonsense a schema should not be able to represent.
 *
 * Declared here rather than in `./common` because the staff roster is its only
 * consumer, following the same convention `timeZoneSchema` records in
 * `./booking`: if a second domain needs it, it moves rather than being copied.
 */
export const staffFlagFilterSchema = z
  .enum(['ANY', 'YES', 'NO'], {
    error: 'Please choose whether to narrow by this setting.',
  })
  .default('ANY')
export type StaffFlagFilter = z.infer<typeof staffFlagFilterSchema>

/**
 * Translates a {@link staffFlagFilterSchema} value into the `boolean` a Prisma
 * `where` clause wants, or `undefined` to leave the column out of the query
 * entirely.
 */
export function staffFlagFilterToBoolean(
  value: StaffFlagFilter
): boolean | undefined {
  switch (value) {
    case 'YES':
      return true
    case 'NO':
      return false
    case 'ANY':
      return undefined
  }
}

/** Free-text search across a chef's name, title, biography and base. */
const staffSearchSchema = z
  .string({ error: 'Please type something to search the chefs for.' })
  .trim()
  .max(MAX_SEARCH_LENGTH, {
    error: 'Please shorten your search to 120 characters or fewer.',
  })
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional()

/** Specialities to narrow by. De-duplicated case-insensitively on the way in. */
const staffSpecialtyFilterSchema = freeTextList({
  maxEntries: MAX_FILTER_LIST_ENTRIES,
  missingError: 'Please choose the specialities to narrow by.',
  emptyEntryError: 'Please name the speciality, or remove the empty entry.',
  longEntryError: 'Please keep each speciality to 120 characters or fewer.',
  tooManyError: 'Please narrow by ten specialities or fewer.',
})

/** Languages to narrow by. */
const staffLanguageFilterSchema = freeTextList({
  maxEntries: MAX_FILTER_LIST_ENTRIES,
  missingError: 'Please choose the languages to narrow by.',
  emptyEntryError: 'Please name the language, or remove the empty entry.',
  longEntryError: 'Please keep each language to 120 characters or fewer.',
  tooManyError: 'Please narrow by ten languages or fewer.',
})

/**
 * The bounds both audiences share.
 *
 * Every one of them is reachable over GET, so each wraps its strict twin in the
 * coercion helper rather than restating the bound: `?minHourlyRateCents=5000`
 * arrives as the string `"5000"`, and `?minHourlyRateCents=` — the control
 * rendered but left blank — must read as "no filter" rather than as zero. The
 * `.optional()` sits *inside* the coercion for exactly that reason; see the
 * note on `withNumericCoercion` in `./common`.
 */
const staffSharedFilterShape = {
  search: staffSearchSchema,
  specialties: staffSpecialtyFilterSchema,
  languages: staffLanguageFilterSchema,
  baseCity: z
    .string({ error: 'Please name the city to narrow by.' })
    .trim()
    .max(MAX_STAFF_LOCALITY_LENGTH, {
      error: 'Please keep the city to 120 characters or fewer.',
    })
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
  baseRegion: z
    .string({ error: 'Please name the province or territory to narrow by.' })
    .trim()
    .max(MAX_STAFF_LOCALITY_LENGTH, {
      error:
        'Please keep the province or territory to 120 characters or fewer.',
    })
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
  baseCountry: countryCodeSchema.optional(),
  minHourlyRateCents: withNumericCoercion(hourlyRateCentsSchema.optional()),
  maxHourlyRateCents: withNumericCoercion(hourlyRateCentsSchema.optional()),
  minYearsExperience: withNumericCoercion(yearsExperienceSchema.optional()),
  maxServiceRadiusKm: withNumericCoercion(serviceRadiusKmSchema.optional()),
} as const

/** The message both filters attach to an inverted rate window. */
const INVERTED_RATE_WINDOW_MESSAGE =
  'The lowest rate must not exceed the highest one.'

/**
 * The rate window, shared by the public directory and the admin roster.
 *
 * Attached with `.check(crossField(...))` rather than `.refine(...)`. Both
 * bounds are `withNumericCoercion(hourlyRateCentsSchema.optional())`, which is
 * a `z.ZodPipe`: a bound that fails does not abort the object's own checks, so
 * `?minHourlyRateCents=foo` used to reach the comparison holding a raw string
 * and quietly report an inverted window on top of the real error. The guard
 * makes the rule total — an absent *or* malformed bound skips it, which is what
 * the `=== undefined ||` chain this replaced was reaching for.
 */
const ORDERED_RATE_WINDOW_CONFIG = {
  deps: ['minHourlyRateCents', 'maxHourlyRateCents'],
  as: 'number',
  error: INVERTED_RATE_WINDOW_MESSAGE,
  path: ['maxHourlyRateCents'],
} as const

/** The predicate half of {@link ORDERED_RATE_WINDOW_CONFIG}. */
function hasOrderedRateWindow(value: {
  minHourlyRateCents: number
  maxHourlyRateCents: number
}): boolean {
  return value.minHourlyRateCents <= value.maxHourlyRateCents
}

// =============================================================================
// 3. The public chef directory
// =============================================================================

/** How the public directory is ordered; direction comes from `sortDirection`. */
export const staffDirectorySortBySchema = z
  .enum(['CURATED', 'EXPERIENCE', 'HOURLY_RATE', 'CREATED'], {
    error: 'Please choose how the chefs should be ordered.',
  })
  .default('CURATED')
export type StaffDirectorySortBy = z.infer<typeof staffDirectorySortBySchema>

/**
 * The public chef directory on the marketing site.
 *
 * There is no `isPubliclyListed` key, and its absence is a security property
 * rather than an oversight: the action pins that column to `true`, so no
 * arrangement of query parameters can surface a chef we have hidden. The admin
 * roster below is where that column becomes answerable, behind a role check.
 *
 * `acceptingClientsOnly` defaults to `true` for the same reason a restaurant
 * does not list the tables it cannot seat — a visitor browsing the directory is
 * looking for someone who can cook for them.
 */
export const staffDirectoryFilterSchema = paginationSchema
  .extend({
    ...staffSharedFilterShape,
    acceptingClientsOnly: queryFlag(
      true,
      'Please say whether to show only chefs taking on new households.'
    ),
    sortBy: staffDirectorySortBySchema,
  })
  .check(
    crossField(ORDERED_RATE_WINDOW_CONFIG, (value) =>
      hasOrderedRateWindow(value)
    )
  )
export type StaffDirectoryFilterInput = z.infer<
  typeof staffDirectoryFilterSchema
>
export type StaffDirectoryFilterRawInput = z.input<
  typeof staffDirectoryFilterSchema
>

// =============================================================================
// 4. The admin roster
// =============================================================================

/** How the admin roster is ordered; direction comes from `sortDirection`. */
export const staffRosterSortBySchema = z
  .enum(
    ['CURATED', 'CREATED', 'UPDATED', 'EXPERIENCE', 'HOURLY_RATE', 'TITLE'],
    { error: 'Please choose how the roster should be ordered.' }
  )
  .default('CREATED')
export type StaffRosterSortBy = z.infer<typeof staffRosterSortBySchema>

/**
 * The admin roster in the business OS.
 *
 * Everything the public directory can ask, plus the three questions only staff
 * may ask: whether a chef is listed, whether they are taking work, and when
 * their record was created. The action still gates the whole route on
 * `hasRoleAtLeast(role, 'ADMIN')` — a filter schema is not an authorization
 * check (`mannachef/CONTRACT.md` §5).
 */
export const staffRosterFilterSchema = paginationSchema
  .extend({
    ...staffSharedFilterShape,
    /** Narrow to one account's profile, when an admin arrives from a user page. */
    userId: cuidSchema.optional(),
    isAcceptingClients: staffFlagFilterSchema,
    isPubliclyListed: staffFlagFilterSchema,
    /** Narrows to the chefs still missing a portrait. */
    missingAvatarOnly: queryFlag(
      false,
      'Please say whether to show only chefs without a portrait.'
    ),
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: staffRosterSortBySchema,
  })
  .check(
    crossField(ORDERED_RATE_WINDOW_CONFIG, (value) =>
      hasOrderedRateWindow(value)
    ),
    crossField(
      {
        deps: ['createdFrom', 'createdTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['createdTo'],
      },
      ({ createdFrom, createdTo }) =>
        createdFrom.getTime() <= createdTo.getTime()
    )
  )
export type StaffRosterFilterInput = z.infer<typeof staffRosterFilterSchema>
export type StaffRosterFilterRawInput = z.input<typeof staffRosterFilterSchema>
