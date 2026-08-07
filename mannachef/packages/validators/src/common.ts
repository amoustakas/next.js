// mannachef/packages/validators/src/common.ts

/**
 * Shared validation primitives for the MannaChef platform.
 *
 * Every domain schema in this package composes from here so that a rule is
 * written once and reads identically in the marketing site, the client portal,
 * the admin OS, and the Expo client.
 *
 * Two rules govern this file:
 *
 *  1. No runtime dependency on `@prisma/client`. These schemas describe input
 *     that has not yet reached the database.
 *  2. Every constraint carries a human message. These strings are rendered
 *     verbatim under inputs in a luxury interface — they must sound like the
 *     brand, not like a validator.
 */

import { z } from 'zod'

// =============================================================================
// Patterns & limits
// =============================================================================

/** Lowercase kebab-case: `chef-tasting-menu`, `sunday-roast-2026`. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** E.164: a leading `+`, a non-zero country code, 8–15 digits in total. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/

/** ISO 4217 alphabetic currency code. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/

/** ISO 3166-1 alpha-2 country code. */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/

/**
 * Canadian postal code with the separator already stripped and the value
 * upper-cased. Excludes the letters Canada Post never uses (D, F, I, O, Q, U in
 * any position; W and Z in the first position).
 */
const CANADIAN_POSTAL_CODE_PATTERN =
  /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/

/**
 * ISO 8601 calendar date, optionally with a time, optional seconds, optional
 * milliseconds, and an optional `Z`/offset suffix.
 */
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** Minutes in a day. `1440` is midnight at the *end* of the day. */
export const MINUTES_PER_DAY = 1440

/** Inclusive upper bound for a wall-clock minute inside a single day. */
export const MAX_MINUTE_OF_DAY = MINUTES_PER_DAY - 1

/** No single engagement may be scheduled for longer than one full day. */
export const MAX_DURATION_MINUTES = MINUTES_PER_DAY

/** Default page size for every paginated list in the OS. */
export const DEFAULT_PAGE_SIZE = 20

/** Hard cap on rows a single request may pull. */
export const MAX_PAGE_SIZE = 100

/** Guards against absurd offsets being fabricated in a query string. */
export const MAX_PAGE = 10_000

/** Longest accepted email address (RFC 5321 path limit). */
const MAX_EMAIL_LENGTH = 320

/** Longest accepted URL. Comfortably above anything UploadThing or Stripe returns. */
const MAX_URL_LENGTH = 2048

/** Address line / locality limits, matched to the Prisma column widths. */
const MAX_ADDRESS_LINE_LENGTH = 200
const MAX_LOCALITY_LENGTH = 120

// =============================================================================
// Identifiers
// =============================================================================

/**
 * A Prisma `@default(cuid())` primary key.
 *
 * Never trust one of these from the client without re-checking ownership —
 * see `mannachef/CONTRACT.md` §5.
 */
export const cuidSchema = z.cuid({
  error: 'That reference is not one of ours. Please refresh and try again.',
})
export type Cuid = z.infer<typeof cuidSchema>

/**
 * A URL-safe handle. Input is trimmed and lower-cased before the shape is
 * checked, so a stray capital is corrected rather than rejected.
 */
export const slugSchema = z
  .string({ error: 'Please provide a web address handle.' })
  .trim()
  .toLowerCase()
  .min(2, { error: 'A handle needs at least two characters.' })
  .max(64, { error: 'Please keep the handle to 64 characters or fewer.' })
  .regex(SLUG_PATTERN, {
    error:
      'Use lowercase letters, numbers and single hyphens only — for example, chef-tasting-menu.',
  })
export type Slug = z.infer<typeof slugSchema>

// =============================================================================
// Contact details
// =============================================================================

/** Trimmed, lower-cased, and validated as a deliverable address. */
export const emailSchema = z
  .string({ error: 'Please share an email address so we can reach you.' })
  .trim()
  .toLowerCase()
  .min(1, { error: 'Please share an email address so we can reach you.' })
  .max(MAX_EMAIL_LENGTH, {
    error: 'That email address is longer than our records allow.',
  })
  .pipe(
    z.email({
      error:
        'That address does not look quite right — please check it, for example name@example.com.',
    })
  )
export type Email = z.infer<typeof emailSchema>

/**
 * Normalises common North American input to E.164.
 *
 * `(416) 555-0134` → `+14165550134`
 * `1-416-555-0134` → `+14165550134`
 * `+33 1 42 60 30 30` → `+33142603030`
 *
 * Anything already carrying a `+` keeps its country code; a bare ten-digit
 * number is assumed to be NANP and given `+1`.
 */
function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')

  if (digits.length === 0) {
    return ''
  }

  if (trimmed.startsWith('+')) {
    return `+${digits}`
  }

  if (digits.length === 10) {
    return `+1${digits}`
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }

  return `+${digits}`
}

/**
 * A phone number stored in E.164. Tolerant of the way North Americans actually
 * type: brackets, spaces, dots, dashes, and a leading `1` are all accepted.
 */
export const phoneSchema = z
  .string({ error: 'Please share a number where we can reach you.' })
  .trim()
  .min(1, { error: 'Please share a number where we can reach you.' })
  .max(32, { error: 'That number is longer than we can store.' })
  .transform(normalizePhoneNumber)
  .refine((value) => E164_PATTERN.test(value), {
    error:
      'Please enter a reachable phone number, for example (416) 555-0134 or +1 416 555 0134.',
  })
export type Phone = z.infer<typeof phoneSchema>

/** An absolute `http(s)` address. */
export const urlSchema = z
  .string({ error: 'Please provide a web address.' })
  .trim()
  .min(1, { error: 'Please provide a web address.' })
  .max(MAX_URL_LENGTH, {
    error: 'That web address is longer than our records allow.',
  })
  .pipe(
    z.url({
      error:
        'Please provide a complete web address, beginning with https://.',
    })
  )
  .refine((value) => /^https?:\/\//i.test(value), {
    error: 'Web addresses must begin with http:// or https://.',
  })
export type Url = z.infer<typeof urlSchema>

// =============================================================================
// Money & numbers
// =============================================================================

/**
 * Money, always as a whole count of minor units (cents). Never a float —
 * see `mannachef/CONTRACT.md` §4.
 */
export const moneyCentsSchema = z
  .int({ error: 'Please enter an amount in whole cents.' })
  .min(0, { error: 'An amount cannot be less than nothing.' })
export type MoneyCents = z.infer<typeof moneyCentsSchema>

/** ISO 4217 code. Trimmed and upper-cased; defaults to Canadian dollars. */
export const currencySchema = z
  .string({ error: 'Please choose a currency.' })
  .trim()
  .toUpperCase()
  .regex(CURRENCY_PATTERN, {
    error: 'Use a three-letter currency code, such as CAD.',
  })
  .default('CAD')
export type Currency = z.infer<typeof currencySchema>

/** A whole percentage, 0–100. */
export const percentSchema = z
  .int({ error: 'Please enter a whole percentage.' })
  .min(0, { error: 'A percentage cannot fall below 0.' })
  .max(100, { error: 'A percentage cannot rise above 100.' })
export type Percent = z.infer<typeof percentSchema>

/** A guest rating: one star through five. */
export const ratingSchema = z
  .int({ error: 'Please choose a rating from one to five stars.' })
  .min(1, { error: 'Please award at least one star.' })
  .max(5, { error: 'Five stars is the highest praise we accept.' })
export type Rating = z.infer<typeof ratingSchema>

// =============================================================================
// Time
// =============================================================================

/**
 * Accepts a `Date` or an ISO 8601 string and always yields a `Date`.
 *
 * Server actions receive dates as strings across the network boundary and as
 * `Date` instances when called from server components — this absorbs both.
 */
export const isoDateTimeSchema = z
  .union(
    [
      z.date({ error: 'Please choose a valid date and time.' }),
      z
        .string({ error: 'Please choose a valid date and time.' })
        .trim()
        .regex(ISO_DATE_TIME_PATTERN, {
          error:
            'Please give the date in ISO 8601 form, such as 2026-02-14T19:30:00Z.',
        }),
    ],
    { error: 'Please choose a valid date and time.' }
  )
  .transform((value) => (value instanceof Date ? value : new Date(value)))
  .refine((value) => !Number.isNaN(value.getTime()), {
    error: 'That moment is not on the calendar. Please choose another.',
  })
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>

/**
 * A wall-clock time expressed as minutes elapsed since local midnight.
 * `0` is 00:00 and `1439` is 23:59.
 */
export const minutesFromMidnightSchema = z
  .int({ error: 'Please choose a time of day.' })
  .min(0, { error: 'A time of day cannot begin before midnight.' })
  .max(MAX_MINUTE_OF_DAY, {
    error: 'A time of day must fall between 00:00 and 23:59.',
  })
export type MinutesFromMidnight = z.infer<typeof minutesFromMidnightSchema>

/**
 * The same measure, but allowing `1440` so an availability window may close at
 * midnight rather than 23:59 (see `ChefAvailability.endMinute`).
 */
export const endMinutesFromMidnightSchema = z
  .int({ error: 'Please choose a closing time.' })
  .min(0, { error: 'A closing time cannot fall before midnight.' })
  .max(MINUTES_PER_DAY, {
    error: 'A closing time must fall between 00:00 and midnight.',
  })
export type EndMinutesFromMidnight = z.infer<
  typeof endMinutesFromMidnightSchema
>

/** A span of time in whole minutes, from one minute up to a full day. */
export const durationMinutesSchema = z
  .int({ error: 'Please give the duration in whole minutes.' })
  .min(1, { error: 'A duration needs to be at least one minute.' })
  .max(MAX_DURATION_MINUTES, {
    error: 'A single engagement cannot run longer than twenty-four hours.',
  })
export type DurationMinutes = z.infer<typeof durationMinutesSchema>

/**
 * A window of time. Deliberately exclusive: an engagement that ends at the very
 * moment it begins is not an engagement.
 */
export const dateRangeSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
  })
  .strict()
  .refine(({ start, end }) => end.getTime() > start.getTime(), {
    error: 'The end of the window must fall after its start.',
    path: ['end'],
  })
export type DateRange = z.infer<typeof dateRangeSchema>
export type DateRangeInput = z.input<typeof dateRangeSchema>

// =============================================================================
// Pagination
// =============================================================================

/** Ascending or descending. Lists default to newest first. */
export const sortDirectionSchema = z
  .enum(['asc', 'desc'], {
    error: 'Please sort either ascending or descending.',
  })
  .default('desc')
export type SortDirection = z.infer<typeof sortDirectionSchema>

/**
 * Page-based pagination. Values are coerced because they usually arrive as
 * strings from a URL search-parameter object.
 *
 * Left non-strict on purpose: domain filter schemas extend it with their own
 * keys, and callers routinely hand it a wider search-param bag.
 */
export const paginationSchema = z.object({
  page: z.coerce
    .number({ error: 'Please choose a page number.' })
    .int({ error: 'Page numbers are whole numbers.' })
    .min(1, { error: 'Pages begin at one.' })
    .max(MAX_PAGE, { error: 'That page is beyond the end of the list.' })
    .default(1),
  pageSize: z.coerce
    .number({ error: 'Please choose how many results to show.' })
    .int({ error: 'The page size is a whole number.' })
    .min(1, { error: 'Please show at least one result per page.' })
    .max(MAX_PAGE_SIZE, {
      error: `We serve up to ${MAX_PAGE_SIZE} results at a time.`,
    })
    .default(DEFAULT_PAGE_SIZE),
  sortDirection: sortDirectionSchema,
})
export type Pagination = z.infer<typeof paginationSchema>
export type PaginationInput = z.input<typeof paginationSchema>

/** Translates a parsed `Pagination` into Prisma's `skip` / `take` arguments. */
export function paginationToSkipTake(pagination: Pagination): {
  skip: number
  take: number
} {
  return {
    skip: (pagination.page - 1) * pagination.pageSize,
    take: pagination.pageSize,
  }
}

// =============================================================================
// Location
// =============================================================================

/** ISO 3166-1 alpha-2. Trimmed and upper-cased; defaults to Canada. */
export const countryCodeSchema = z
  .string({ error: 'Please choose a country.' })
  .trim()
  .toUpperCase()
  .regex(COUNTRY_CODE_PATTERN, {
    error: 'Use a two-letter country code, such as CA.',
  })
export type CountryCode = z.infer<typeof countryCodeSchema>

/**
 * A Canadian postal code. Any spacing or hyphenation is stripped on the way in
 * and the canonical `A1A 1A1` form is produced on the way out.
 */
export const canadianPostalCodeSchema = z
  .string({ error: 'Please provide a postal code.' })
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/[\s-]+/g, ''))
  .refine((value) => CANADIAN_POSTAL_CODE_PATTERN.test(value), {
    error: 'Please enter a Canadian postal code, such as M5V 2T6.',
  })
  .transform((value) => `${value.slice(0, 3)} ${value.slice(3)}`)
export type CanadianPostalCode = z.infer<typeof canadianPostalCodeSchema>

/** A service address, as captured by intake, booking, and profile forms. */
export const addressSchema = z
  .object({
    line1: z
      .string({ error: 'Please give us a street address.' })
      .trim()
      .min(1, { error: 'Please give us a street address.' })
      .max(MAX_ADDRESS_LINE_LENGTH, {
        error: 'Please keep the street address to 200 characters or fewer.',
      }),
    line2: z
      .string()
      .trim()
      .max(MAX_ADDRESS_LINE_LENGTH, {
        error: 'Please keep the second address line to 200 characters or fewer.',
      })
      .optional(),
    city: z
      .string({ error: 'Please tell us which city we are cooking in.' })
      .trim()
      .min(1, { error: 'Please tell us which city we are cooking in.' })
      .max(MAX_LOCALITY_LENGTH, {
        error: 'Please keep the city to 120 characters or fewer.',
      }),
    region: z
      .string({ error: 'Please choose a province or territory.' })
      .trim()
      .min(1, { error: 'Please choose a province or territory.' })
      .max(MAX_LOCALITY_LENGTH, {
        error: 'Please keep the province or territory to 120 characters or fewer.',
      }),
    postalCode: canadianPostalCodeSchema,
    country: countryCodeSchema.default('CA'),
  })
  .strict()
export type Address = z.infer<typeof addressSchema>
export type AddressInput = z.input<typeof addressSchema>
