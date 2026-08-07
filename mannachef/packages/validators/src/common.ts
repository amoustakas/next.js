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
 *
 * A third rule was added after the MCV-004 audit found six helpers copy-pasted
 * across as many as six domain modules apiece:
 *
 *  3. Anything used by more than one domain module lives here and only here.
 *     The domain modules import it; they never re-declare it. See the
 *     "Shared helpers" section at the foot of this file.
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

// -----------------------------------------------------------------------------
// Cross-domain limits (MCV-010)
//
// Each of these was declared independently in two domain modules with the same
// value and the same intent, which is exactly what rule 3 at the head of this
// file forbids. They live here now; the domain modules import them.
//
// A limit that merely *happens* to share a number with another is not a
// duplicate and stays where it is — `MAX_TAGLINE_LENGTH`, `MAX_REASON_LENGTH`
// and `REFERRAL_CODE_PATTERN` were each confirmed to be a distinct concept and
// were deliberately left in their own modules.
// -----------------------------------------------------------------------------

/**
 * Matches every Stripe identifier column in the schema — all are
 * `@db.VarChar(255)`. Previously declared in both `billing.ts` and `payment.ts`.
 */
export const MAX_STRIPE_ID_LENGTH = 255

/**
 * Highest manual sort position any ladder accepts — plans in `billing.ts`,
 * dishes and categories in `menu.ts`. Comfortably beyond any real list.
 */
export const MAX_SORT_ORDER = 10_000

/**
 * How many tag handles a single filter may combine. Shared by the media library
 * and the menu, which filter over the same `Tag` table.
 */
export const MAX_FILTER_TAGS = 20

/**
 * Generous ceiling for a `@db.Text` note, memo or reason.
 *
 * `booking.ts` exported this and `referral.ts` shadowed it with an identical
 * local copy, so the barrel published one of two constants that had to be kept
 * in step by hand. Both now import it from here, and the barrel's
 * `MAX_NOTE_LENGTH` is this declaration.
 */
export const MAX_NOTE_LENGTH = 2_000

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
      error: 'Please provide a complete web address, beginning with https://.',
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
// Cross-field refinement (MCV-008)
// =============================================================================

/**
 * Object-level refinements that dereference more than one field, made
 * structurally incapable of throwing.
 *
 * ## The bug this replaces
 *
 * In zod 4 an object-level `.refine()` / `.superRefine()` runs against the
 * **raw, un-narrowed** value, and it still runs when a *nested field* has
 * already failed. Whether the parent aborts depends on the wrapper kind of the
 * field that failed:
 *
 *  - A plain field (`z.number()`) that fails records an issue with
 *    `continue: undefined`. `util.aborted(payload)` is then `true` and the
 *    object's own checks are skipped. Safe by accident.
 *  - A `z.ZodPipe` field — which is what every `.transform(...).refine(...)`
 *    chain produces, including {@link isoDateTimeSchema},
 *    {@link phoneSchema}, {@link urlSchema}, and
 *    {@link canadianPostalCodeSchema} — records its issue with
 *    `continue: true`. `util.aborted(payload)` stays `false`, the object's
 *    checks run anyway, and the refinement receives the original string.
 *
 * So this, which reads perfectly innocently:
 *
 * ```ts
 * z.object({ start: isoDateTimeSchema, end: isoDateTimeSchema })
 *   .refine(({ start, end }) => end.getTime() > start.getTime(), { … })
 * ```
 *
 * does not return `{ success: false }` for `{ start: 'foo', end: 'bar' }`. It
 * throws `TypeError: end.getTime is not a function` straight out of
 * `safeParse` — which, for a filter schema fed from a query string, is an
 * HTTP 500 where an HTTP 400 belongs.
 *
 * ## What zod 4 does and does not offer
 *
 * It offers exactly one supported hook, and this file uses it.
 * `$ZodSuperRefineParams.when` is public, documented in the shipped `.d.ts`
 * ("If provided, the refinement runs only when this returns `true`"), and
 * receives the public `ParsePayload`, whose `issues: $ZodRawIssue[]` field is
 * likewise public — no `@internal` marker, no `_zod` prefix. At the moment an
 * object's checks run, `payload.issues` already holds every issue its own
 * properties produced, each carrying a `path` relative to the object. That is
 * enough to answer "did *this* field already fail?" without touching an
 * internal.
 *
 * There is no supported way to receive an object-level refinement's value
 * *narrowed*, so the helpers below pair the `when` gate with explicit runtime
 * type guards. The two are deliberately redundant:
 *
 *  - `when` is the *precise* half. It suppresses the check when a declared
 *    dependency produced an issue even if that value happens to still be the
 *    right runtime type — `z.string().min(5)` failing leaves a string behind,
 *    and firing a range error on top of "too short" is noise.
 *  - The guards are the *total* half. They cannot be defeated by a future zod
 *    changing when checks run, by a `continue` flag flipping, or by an author
 *    forgetting a dependency: if a value is not the declared runtime type, the
 *    predicate is never invoked, so it cannot throw.
 *
 * Note that supplying `when` also opts out of zod's default abort behaviour —
 * the check now runs even when an *unrelated* field failed hard. That is the
 * better reading: an invalid `staffProfileId` should not hide a genuinely
 * inverted date range, and the dependency guards make running safe.
 *
 * ## Using them
 *
 * These return a `z.core.$ZodCheck`, so they attach with `.check(...)` rather
 * than `.refine(...)`. That is an upgrade in its own right: `.check()` returns
 * `this`, so a `ZodObject` stays a `ZodObject` and remains `.extend()`-able,
 * and several checks can be attached in one call.
 *
 * ```ts
 * // Before — throws on { start: 'foo', end: 'bar' }
 * z.object({ start: isoDateTimeSchema, end: isoDateTimeSchema })
 *   .strict()
 *   .refine(({ start, end }) => end.getTime() > start.getTime(), {
 *     error: 'The end of the window must fall after its start.',
 *     path: ['end'],
 *   })
 *
 * // After — returns { success: false } naming `start` and `end`
 * z.object({ start: isoDateTimeSchema, end: isoDateTimeSchema })
 *   .strict()
 *   .check(
 *     crossField(
 *       {
 *         deps: ['start', 'end'],
 *         as: 'date',
 *         error: 'The end of the window must fall after its start.',
 *         path: ['end'],
 *       },
 *       ({ start, end }) => end.getTime() > start.getTime()
 *     )
 *   )
 * ```
 *
 * `deps` is constrained to the keys of the object being refined, so a
 * misspelled dependency is a compile error rather than a check that silently
 * never runs. The predicate receives only those keys, already narrowed —
 * `start` and `end` are `Date`, not `Date | undefined` and not `unknown` —
 * which is why the body needs no guard clause of its own.
 */

/** The runtime types a cross-field dependency may be narrowed to. */
export type CrossFieldKind =
  'date' | 'number' | 'string' | 'array' | 'boolean' | 'present'

/**
 * Maps a {@link CrossFieldKind} to the TypeScript type its guard proves.
 *
 * `'present'` is the escape hatch for a dependency whose type the helper has no
 * opinion about — an enum member, a nested object, a discriminant. It proves
 * only that the value is neither `undefined` nor `null`, which is still enough
 * to stop the common "read a property of an absent field" crash.
 */
export interface CrossFieldRuntimeType {
  readonly date: Date
  readonly number: number
  readonly string: string
  readonly array: readonly unknown[]
  readonly boolean: boolean
  readonly present: NonNullable<unknown>
}

/**
 * The declared field type intersected with the guarded runtime type.
 *
 * `Date | undefined` narrowed by `'date'` is `Date`. A field the shape types as
 * `unknown` — or as something with no overlap at all — falls back to the
 * guarded type, so the predicate is never handed `never`.
 */
type NarrowedTo<Value, Runtime> = [Extract<Value, Runtime>] extends [never]
  ? Runtime
  : Extract<Value, Runtime>

/** What a {@link crossField} predicate receives: the deps, already narrowed. */
export type CrossFieldValues<
  Shape,
  Key extends keyof Shape,
  Kind extends CrossFieldKind,
> = {
  readonly [P in Key]-?: NarrowedTo<Shape[P], CrossFieldRuntimeType[Kind]>
}

/** A per-key runtime type declaration, for {@link crossFieldMixed}. */
export type CrossFieldKindMap<Shape> = {
  readonly [P in keyof Shape]?: CrossFieldKind
}

/** What a {@link crossFieldMixed} predicate receives. */
export type CrossFieldMixedValues<
  Shape,
  Kinds extends CrossFieldKindMap<Shape>,
> = {
  readonly [P in keyof Kinds & keyof Shape]-?: Kinds[P] extends CrossFieldKind
    ? NarrowedTo<Shape[P], CrossFieldRuntimeType[Kinds[P]]>
    : never
}

/**
 * The whole object under refinement, offered to the predicate as a second
 * argument for the rare check that also consults a field it cannot declare as
 * a dependency.
 *
 * Every value is `unknown` on purpose. At the moment an object-level check
 * runs, a field that parsed cleanly holds its output type but a field that
 * failed still holds whatever the caller sent, so `Partial<Shape>` would be a
 * lie. Anything read from here has to be guarded by hand — which is the nudge
 * to declare it in `deps` instead.
 */
export type CrossFieldRaw<Shape> = {
  readonly [P in keyof Shape]?: unknown
}

/** The runtime half. One total predicate per {@link CrossFieldKind}. */
const CROSS_FIELD_GUARDS: {
  readonly [Kind in CrossFieldKind]: (
    value: unknown
  ) => value is CrossFieldRuntimeType[Kind]
} = {
  // An `Invalid Date` is a `Date`, and `NaN` comparisons quietly evaluate to
  // `false` — which would *fire* a "must fall after" message rather than skip
  // it. Both kinds screen out their non-finite member for that reason.
  date: (value): value is Date =>
    value instanceof Date && !Number.isNaN(value.getTime()),
  number: (value): value is number =>
    typeof value === 'number' && Number.isFinite(value),
  string: (value): value is string => typeof value === 'string',
  array: (value): value is readonly unknown[] => Array.isArray(value),
  boolean: (value): value is boolean => typeof value === 'boolean',
  present: (value): value is NonNullable<unknown> =>
    value !== undefined && value !== null,
}

/** A dependency reduced to the pair the runtime actually needs. */
type CrossFieldDependency = readonly [key: PropertyKey, kind: CrossFieldKind]

/**
 * Collects the declared dependencies, or reports that the check must be
 * skipped.
 *
 * Returns `undefined` — meaning "skip, silently" — when the value is not an
 * object at all, or when any single dependency is absent or of the wrong
 * runtime type. That field has already produced its own precise issue; a second
 * object-level issue about it would only bury the first.
 */
function collectCrossFieldDependencies(
  value: unknown,
  dependencies: readonly CrossFieldDependency[]
): Record<PropertyKey, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const source = value as Record<PropertyKey, unknown>
  const collected: Record<PropertyKey, unknown> = {}

  for (const [key, kind] of dependencies) {
    const candidate = source[key]

    if (!CROSS_FIELD_GUARDS[kind](candidate)) {
      return undefined
    }

    collected[key] = candidate
  }

  return collected
}

/**
 * True when one of the declared dependencies has already recorded an issue.
 *
 * Issue paths at this point are relative to the object being refined, so the
 * head of the path is the field name. A nested failure inside a dependency —
 * `['address', 'postalCode']` for a dependency named `address` — counts, which
 * is correct: the dependency as a whole is not trustworthy.
 */
function crossFieldDependencyFailed(
  dependencies: readonly CrossFieldDependency[],
  issues: readonly z.core.$ZodRawIssue[]
): boolean {
  for (const issue of issues) {
    const head = issue.path?.[0]

    if (head === undefined) {
      continue
    }

    for (const [key] of dependencies) {
      if (key === head) {
        return true
      }
    }
  }

  return false
}

/** The message and issue placement shared by both public helpers. */
interface CrossFieldIssueConfig {
  /** Rendered verbatim under the input. Write it in the brand's voice. */
  readonly error: string
  /**
   * Where the issue is attached, relative to the object being refined. Omit it
   * and the issue lands on the object itself, exactly as a bare `.refine()`
   * would place it — but a cross-field rule almost always has one field it can
   * sensibly blame, and naming it is what lets a form highlight an input.
   */
  readonly path?: readonly PropertyKey[]
}

/**
 * Which fields each built check reads, keyed by the check object itself.
 *
 * A `$ZodCheck` is an opaque closure once built: the `deps` array is captured
 * by `when` and by the predicate wrapper, and nothing about it survives into a
 * shape anything else can read. That is fine for parsing and useless for
 * *testing*, because the one payload most likely to crash an object-level
 * refinement is the one where two fields it dereferences are both garbage —
 * `?startsFrom=foo&startsUntil=bar` — and a harness cannot generate that pair
 * unless it can discover the pair.
 *
 * The dependency list is therefore recorded here as the check is built. A
 * `WeakMap` rather than a property on the check, so nothing observable is added
 * to the object zod stores in `def.checks`, and so a discarded schema is not
 * held alive by the registry.
 */
const crossFieldDependencyRegistry = new WeakMap<object, readonly string[]>()

/**
 * The field names a cross-field check declared as dependencies, or `undefined`
 * for anything that is not one of ours.
 *
 * Read it off the entries of a `ZodObject`'s `_zod.def.checks`:
 *
 * ```ts
 * for (const check of schema._zod.def.checks ?? []) {
 *   const deps = crossFieldDependencyKeys(check)
 *   // deps === ['startsFrom', 'startsUntil'] for the booking-window rule
 * }
 * ```
 *
 * `scripts/fuzz-schemas.ts` uses it to aim: every unordered pair drawn from a
 * returned list becomes a payload in which *both* fields are hostile, which is
 * the exact shape that used to reach a refinement's body with two strings and
 * throw `TypeError: end.getTime is not a function` out of `safeParse`.
 */
export function crossFieldDependencyKeys(
  check: unknown
): readonly string[] | undefined {
  if (typeof check !== 'object' || check === null) {
    return undefined
  }

  return crossFieldDependencyRegistry.get(check)
}

/**
 * The single place a cross-field check is actually built. Both public helpers
 * are thin, well-typed doors onto this.
 */
function buildCrossFieldCheck<Shape>(
  dependencies: readonly CrossFieldDependency[],
  config: CrossFieldIssueConfig,
  predicate: (
    values: Record<PropertyKey, unknown>,
    raw: Record<PropertyKey, unknown>
  ) => boolean
): z.core.$ZodCheck<Shape> {
  const check = z.superRefine<Shape>(
    (value, ctx) => {
      // `value` is typed as `Shape` by zod but is the *raw* input whenever a
      // field failed — which is the entire premise of this section. Nothing
      // below trusts that type.
      const raw: unknown = value
      const values = collectCrossFieldDependencies(raw, dependencies)

      if (values === undefined) {
        return
      }

      if (predicate(values, raw as Record<PropertyKey, unknown>)) {
        return
      }

      const issue: {
        code: 'custom'
        message: string
        input: unknown
        path?: PropertyKey[]
      } = { code: 'custom', message: config.error, input: raw }

      if (config.path !== undefined) {
        issue.path = [...config.path]
      }

      ctx.addIssue(issue)
    },
    {
      when: (payload) =>
        !crossFieldDependencyFailed(dependencies, payload.issues),
    }
  )

  // `PropertyKey` covers symbols; only the string keys are addressable from a
  // JSON body or a query string, which is all the harness can synthesise.
  crossFieldDependencyRegistry.set(
    check,
    dependencies
      .map(([key]) => key)
      .filter((key): key is string => typeof key === 'string')
  )

  return check
}

/** Options for {@link crossField}. */
export interface CrossFieldConfig<
  Shape,
  Key extends keyof Shape,
  Kind extends CrossFieldKind,
> extends CrossFieldIssueConfig {
  /**
   * The fields this check reads. At least one, all of them real keys of the
   * object being refined — a typo will not compile.
   */
  readonly deps: readonly [Key, ...Key[]]
  /** The runtime type every dependency must have for the check to run. */
  readonly as: Kind
}

/**
 * A cross-field check whose dependencies all share one runtime type.
 *
 * Attach it with `.check(...)`:
 *
 * ```ts
 * export const bookingWindowSchema = z
 *   .object({ startsAt: isoDateTimeSchema, endsAt: isoDateTimeSchema })
 *   .strict()
 *   .check(
 *     crossField(
 *       {
 *         deps: ['startsAt', 'endsAt'],
 *         as: 'date',
 *         error: 'The service must end after it begins.',
 *         path: ['endsAt'],
 *       },
 *       ({ startsAt, endsAt }) => endsAt.getTime() > startsAt.getTime()
 *     )
 *   )
 * ```
 *
 * The predicate returns `true` when the input is **acceptable**, matching
 * `.refine()`. It is never called unless every dependency is present and of
 * the declared runtime type, so it needs no `=== undefined` guards and cannot
 * throw on a bad input.
 *
 * Optional dependencies are handled by that same rule: a filter whose
 * `startsFrom` was simply not supplied skips the check rather than failing it,
 * which is the behaviour every hand-written `value.x === undefined || …` chain
 * was reaching for.
 */
export function crossField<
  Shape,
  Key extends keyof Shape,
  Kind extends CrossFieldKind,
>(
  config: CrossFieldConfig<Shape, Key, Kind>,
  predicate: (
    values: CrossFieldValues<Shape, Key, Kind>,
    raw: CrossFieldRaw<Shape>
  ) => boolean
): z.core.$ZodCheck<Shape> {
  const dependencies: CrossFieldDependency[] = config.deps.map((key) => [
    key,
    config.as,
  ])

  return buildCrossFieldCheck<Shape>(dependencies, config, (values, raw) =>
    predicate(
      values as CrossFieldValues<Shape, Key, Kind>,
      raw as CrossFieldRaw<Shape>
    )
  )
}

/** Options for {@link crossFieldMixed}. */
export interface CrossFieldMixedConfig<
  Shape,
  Kinds extends CrossFieldKindMap<Shape>,
> extends CrossFieldIssueConfig {
  /**
   * The fields this check reads, each with its own runtime type. Keys are
   * constrained to the object's own keys, so a typo will not compile.
   */
  readonly deps: Kinds
}

/**
 * The heterogeneous variant: one runtime type per dependency.
 *
 * ```ts
 * .check(
 *   crossFieldMixed(
 *     {
 *       deps: { isBlackout: 'boolean', reason: 'string' },
 *       error: 'Please say why this window is closed.',
 *       path: ['reason'],
 *     },
 *     ({ isBlackout, reason }) => !isBlackout || reason.trim().length > 0
 *   )
 * )
 * ```
 *
 * Everything true of {@link crossField} is true here: the predicate sees only
 * the declared dependencies, each narrowed to its declared type, and it is not
 * called at all unless every one of them is present and correctly typed.
 */
export function crossFieldMixed<Shape, Kinds extends CrossFieldKindMap<Shape>>(
  config: CrossFieldMixedConfig<Shape, Kinds>,
  predicate: (
    values: CrossFieldMixedValues<Shape, Kinds>,
    raw: CrossFieldRaw<Shape>
  ) => boolean
): z.core.$ZodCheck<Shape> {
  const dependencies: CrossFieldDependency[] = []

  // `Object.entries` over an unresolved generic widens the value side to
  // `{} | null`, so the map is read through its declared shape instead.
  const declared: Readonly<Record<string, CrossFieldKind | undefined>> =
    config.deps

  for (const key of Object.keys(declared)) {
    const kind = declared[key]

    if (kind !== undefined) {
      dependencies.push([key, kind])
    }
  }

  return buildCrossFieldCheck<Shape>(dependencies, config, (values, raw) =>
    predicate(
      values as CrossFieldMixedValues<Shape, Kinds>,
      raw as CrossFieldRaw<Shape>
    )
  )
}

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
  // 1, not 0: a window that closes at 00:00 has no duration. This mirrors the
  // `CHECK ("endMinute" >= 1 AND "endMinute" <= 1440)` constraint on
  // `ChefAvailability` — the database rejects 0, so the parser must too.
  .min(1, { error: 'A closing time must fall after midnight.' })
  .max(MINUTES_PER_DAY, {
    error: 'A closing time must fall between 00:01 and midnight.',
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
 *
 * The ordering rule goes through {@link crossField} rather than `.refine()`.
 * `isoDateTimeSchema` is a `z.ZodPipe`, so a field that fails does *not* abort
 * the parent object, and the plain refinement this replaced reached
 * `end.getTime()` on the string `'bar'` — `dateRangeSchema.safeParse({ start:
 * 'foo', end: 'bar' })` threw a `TypeError` instead of returning
 * `{ success: false }`. See the "Cross-field refinement" section above.
 */
export const dateRangeSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['start', 'end'],
        as: 'date',
        error: 'The end of the window must fall after its start.',
        path: ['end'],
      },
      ({ start, end }) => end.getTime() > start.getTime()
    )
  )
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
        error:
          'Please keep the second address line to 200 characters or fewer.',
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
        error:
          'Please keep the province or territory to 120 characters or fewer.',
      }),
    postalCode: canadianPostalCodeSchema,
    country: countryCodeSchema.default('CA'),
  })
  .strict()
export type Address = z.infer<typeof addressSchema>
export type AddressInput = z.input<typeof addressSchema>

// =============================================================================
// Shared helpers — the canonical home (MCV-004)
// =============================================================================

/**
 * Everything below this line was previously copy-pasted into the domain
 * modules. Each helper now has exactly one definition; where the copies
 * disagreed, the note above the helper records which reading won and why.
 *
 * Import them, do not re-declare them:
 *
 * ```ts
 * import { buildUpdateSchema, optionalProse, queryFlag } from './common'
 * ```
 */

// -----------------------------------------------------------------------------
// Small predicates
// -----------------------------------------------------------------------------

/**
 * True when no value in the list repeats.
 *
 * Identity comparison via `Set`, which is what all six copies did. It is exact
 * for the primitives we actually de-duplicate (cuids, slugs, tag handles) and
 * deliberately does *not* try to compare objects structurally — a caller that
 * needs that should map to a key first, as `menu.ts` does with
 * `hasUniqueValues(ingredients.map((entry) => entry.ingredientId))`.
 */
export function hasUniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}

/** Milliseconds in a day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * True when the moment is still ahead of us.
 *
 * Strictly ahead: `isInTheFuture(new Date())` is `false`. All three copies
 * agreed on `>` rather than `>=`, which is also the stricter reading — a
 * follow-up scheduled for "now" is not scheduled.
 */
export function isInTheFuture(value: Date): boolean {
  return value.getTime() > Date.now()
}

/** True when the moment has already passed, or is this very instant. */
export function isNotInTheFuture(value: Date): boolean {
  return value.getTime() <= Date.now()
}

/**
 * Keeps the first spelling of each entry and drops later case-insensitive
 * repeats, so "Peanuts" and "peanuts" never both reach the kitchen.
 */
export function dedupeCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of values) {
    const key = value.toLocaleLowerCase()

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    unique.push(value)
  }

  return unique
}

// -----------------------------------------------------------------------------
// Update-payload guard
// -----------------------------------------------------------------------------

/** Every update schema rejects a payload that carries an id and nothing else. */
export const NOTHING_TO_SAVE_MESSAGE =
  'Nothing has changed yet — adjust a field before saving.'

/**
 * True when an update payload carries something beyond its single identifier.
 *
 * All six copies were `Object.keys(value).length > 1`, which silently assumes
 * the payload has exactly one required key. That assumption is now explicit:
 * `buildUpdateSchema` computes the threshold from the keys it was told to keep
 * required, and this function is the one-required-key special case kept for
 * schemas that are still assembled by hand.
 */
export function hasSomethingToSave(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 1
}

/**
 * The generalised form: a guard that passes only when the payload carries more
 * than `requiredKeyCount` keys.
 */
export function hasSomethingToSaveBeyond(
  requiredKeyCount: number
): (value: Record<string, unknown>) => boolean {
  return (value) => Object.keys(value).length > requiredKeyCount
}

// -----------------------------------------------------------------------------
// Default stripping
// -----------------------------------------------------------------------------

/**
 * The shape `withoutDefaults` produces: every `z.ZodDefault<Inner>` replaced by
 * its `Inner`, every other field left alone.
 *
 * The `infer Inner extends z.ZodType` constraint is what retires the
 * `as unknown as` bridge the three copied versions carried. Without it the
 * conditional resolves to `SomeType | T[K]`, and `SomeType` is only
 * `{ _zod: ... }` — it lacks `"~standard"`, so the mapped type is *not*
 * assignable to `z.ZodRawShape`:
 *
 * ```
 * Type 'SomeType | T[K]' is not assignable to type '$ZodType<...>'.
 *   Property '"~standard"' is missing in type 'SomeType'.
 * ```
 *
 * That failure is what pushed the original authors through `unknown`. With the
 * constraint both branches are `z.ZodType`, the whole mapped type is a
 * `z.ZodRawShape` by construction, and the cast below is a direct narrowing
 * between two shape types.
 */
export type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner extends z.ZodType>
    ? Inner
    : T[K]
}

/**
 * Strips `.default(...)` from every field of a shape.
 *
 * A default belongs on a create form, where an omitted field honestly means
 * "use the house setting". On a partial update it is actively harmful: zod
 * still applies the default underneath `.partial()`, so a payload that only
 * renamed a dish would quietly reset its currency, its running order, and
 * whether it is on the menu at all.
 *
 * Only the *outermost* wrapper is inspected, which is a real constraint on how
 * field schemas are built — see the note on `freeTextList` below.
 */
export function withoutDefaults<T extends z.ZodRawShape>(
  shape: T
): WithoutDefaults<T> {
  const stripped: Record<string, z.core.$ZodType> = {}

  for (const [key, field] of Object.entries(shape)) {
    stripped[key] = field instanceof z.ZodDefault ? field.unwrap() : field
  }

  // One direct assertion, and it is unavoidable: the loop reproduces the mapped
  // type one key at a time, but TypeScript cannot connect a runtime
  // `instanceof` test to a type-level conditional over an unresolved generic.
  // Both sides are shapes of `$ZodType` — thanks to the `infer Inner extends
  // z.ZodType` constraint above — so this is a narrowing cast between related
  // types, not the `as unknown as` bridge the domain modules used to carry.
  return stripped as WithoutDefaults<T>
}

/** Options for {@link buildUpdateSchema}. */
export interface BuildUpdateSchemaOptions<
  RequiredShape extends z.core.$ZodLooseShape,
> {
  /**
   * The fields that stay required on an update — in practice `{ id: cuidSchema }`.
   *
   * They are named as a shape rather than as bare key strings because the
   * identifier is virtually never part of the create shape: an update carries
   * `id` precisely because a create does not.
   */
  readonly requireKeys: RequiredShape
  /** Overrides {@link NOTHING_TO_SAVE_MESSAGE} for this schema. */
  readonly nothingToSaveMessage?: string
  /**
   * Where the "nothing to save" issue is attached. Defaults to the first
   * required key, which is what every hand-written update schema did.
   */
  readonly path?: PropertyKey[]
}

/**
 * Builds an update schema from a create shape, performing all three steps that
 * an update schema must perform, in the one order that is correct.
 *
 * 1. `withoutDefaults(shape)` — remove every `.default(...)`.
 * 2. `.partial()` — make what remains optional.
 * 3. `.extend(requireKeys).strict()` — put the identifier back, reject strays.
 * 4. `.refine(hasSomethingToSaveBeyond(n))` — reject an identifier on its own.
 *
 * ## Why `.partial()` alone is unsafe
 *
 * In zod 4 a default survives `.partial()`. `z.ZodOptional` wrapping a
 * `z.ZodDefault` does not short-circuit on `undefined`; it delegates, and the
 * default fires:
 *
 * ```ts
 * z.object({ b: z.boolean().default(true) }).partial().parse({}) // → { b: true }
 * ```
 *
 * The caller sent `{}`. The schema returned `{ b: true }`. Handed to
 * `prisma.update`, that writes a value nobody asked for — this is how a rename
 * silently re-published a hidden menu item. Step 1 is therefore not a nicety,
 * and routing every update schema through this function is how a future one
 * avoids forgetting it.
 *
 * Step 4 is separate from step 2 for the same class of reason: `.partial()`
 * happily accepts `{ id }` with no edits at all, which would issue a pointless
 * write and, worse, a pointless `revalidatePath`.
 */
export function buildUpdateSchema<
  BaseShape extends z.ZodRawShape,
  RequiredShape extends z.core.$ZodLooseShape,
>(shape: BaseShape, options: BuildUpdateSchemaOptions<RequiredShape>) {
  const requiredKeys = Object.keys(options.requireKeys)
  const firstRequiredKey = requiredKeys[0]

  const errorPath =
    options.path ??
    (firstRequiredKey === undefined ? undefined : [firstRequiredKey])

  const refineParams: { error: string; path?: PropertyKey[] } = {
    error: options.nothingToSaveMessage ?? NOTHING_TO_SAVE_MESSAGE,
  }

  if (errorPath !== undefined) {
    refineParams.path = errorPath
  }

  return z
    .object(withoutDefaults(shape))
    .partial()
    .extend(options.requireKeys)
    .strict()
    .refine(hasSomethingToSaveBeyond(requiredKeys.length), refineParams)
}

// -----------------------------------------------------------------------------
// Free text
// -----------------------------------------------------------------------------

/** Longest accepted free-text search phrase. All six copies said 120. */
export const MAX_SEARCH_LENGTH = 120

/** Longest accepted entry inside a {@link freeTextList}. */
export const MAX_FREE_TEXT_ENTRY_LENGTH = 120

/**
 * `@db.Text` prose that may be cleared by sending `null`.
 *
 * Blank input collapses to `null` rather than `''`, so "cleared" has exactly
 * one representation in the column. Omitting the key entirely still means
 * "leave it alone".
 */
export function optionalProse(maxLength: number, tooLongMessage: string) {
  return z
    .string({ error: 'Please provide text, or leave the field empty.' })
    .trim()
    .max(maxLength, { error: tooLongMessage })
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()
    .optional()
}

/** Configuration for {@link freeTextList}. */
export interface FreeTextListConfig {
  readonly maxEntries: number
  /** Defaults to {@link MAX_FREE_TEXT_ENTRY_LENGTH}. */
  readonly maxEntryLength?: number
  readonly missingError: string
  readonly emptyEntryError: string
  readonly longEntryError: string
  readonly tooManyError: string
}

/**
 * A capped, trimmed, case-insensitively de-duplicated list of short free-text
 * entries — the shape every `String[]` column takes.
 *
 * ## Ordering is load-bearing
 *
 * The transform runs *before* the default, so the outermost wrapper is a
 * `z.ZodDefault`. That is the whole point, and it is the opposite of what
 * `intake.ts` does today.
 *
 * `intake.ts` writes `.default([]).transform(dedupe)`, which leaves a
 * `z.ZodPipe` on the outside with the default buried inside it. Two things
 * follow, and the audit saw both:
 *
 *  - `withoutDefaults` tests `field instanceof z.ZodDefault` on the outermost
 *    wrapper only, so it cannot see that default and cannot strip it.
 *  - Those fields nevertheless escaped the injection bug, because
 *    `z.ZodOptional` wrapping a `z.ZodPipe` *does* short-circuit on
 *    `undefined`, unlike `z.ZodOptional` wrapping a `z.ZodDefault`.
 *
 * So the old ordering was safe by accident, through a zod internal that differs
 * per wrapper kind, while the neighbouring plain `.default(...)` fields were
 * not. Putting the default on the outside makes the behaviour uniform: every
 * default in a shape is visible to `withoutDefaults`, and every update schema
 * built by `buildUpdateSchema` strips all of them deliberately.
 *
 * Skipping the dedupe for the default value costs nothing — `[]` has no
 * duplicates.
 */
export function freeTextList(config: FreeTextListConfig) {
  const maxEntryLength = config.maxEntryLength ?? MAX_FREE_TEXT_ENTRY_LENGTH

  return z
    .array(
      z
        .string({ error: config.emptyEntryError })
        .trim()
        .min(1, { error: config.emptyEntryError })
        .max(maxEntryLength, { error: config.longEntryError }),
      { error: config.missingError }
    )
    .max(config.maxEntries, { error: config.tooManyError })
    .transform(dedupeCaseInsensitive)
    .default([])
}

// -----------------------------------------------------------------------------
// Query-string transport
// -----------------------------------------------------------------------------

/**
 * A boolean that survives the trip through a URL search-parameter object.
 *
 * Filters are routinely built from `searchParams`, where `true` arrives as the
 * string `"true"`. This accepts a real boolean or its string spelling.
 */
export function queryFlag(defaultValue: boolean, error: string) {
  return z
    .union([z.boolean({ error }), z.stringbool({ error })], { error })
    .default(defaultValue)
}

/**
 * Turns the string form a `URLSearchParams` round trip produces back into a
 * number, and leaves every other input exactly as it found it.
 *
 * The pass-through is the important half. Anything that is not a string reaches
 * the strict schema untouched, so a JSON body carrying a real `number` is
 * validated by the same bounds and reports the same message. And anything that
 * *is* a string but is not numeric is handed on verbatim rather than turned
 * into `NaN`, so the failure is reported with the schema's own boutique copy
 * instead of a generic "expected number".
 *
 * This is deliberately narrower than `z.coerce.number()`, which would quietly
 * turn `null` into `0`, `true` into `1`, and `[]` into `0`. Those are not
 * things a query string can produce and not things a filter should accept.
 *
 * A blank string becomes `undefined`: `?minCents=` means the filter was
 * rendered but left empty, which is "no filter", not "zero".
 */
function coerceNumericInput(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  const parsed = Number(trimmed)

  return Number.isNaN(parsed) ? value : parsed
}

/** Digits enough to be an epoch-millisecond stamp rather than a bare year. */
const EPOCH_MILLIS_PATTERN = /^-?\d{11,}$/

/**
 * The temporal counterpart of `coerceNumericInput`.
 *
 * Recognised, in order: a `Date` (a server component calling an action
 * directly); an ISO 8601 string, which is handed on untouched so
 * `isoDateTimeSchema` owns the verdict and the message; an epoch-millisecond
 * number or its string spelling; and finally any other string the platform
 * `Date` parser understands — notably `Date.prototype.toString()` output, which
 * is what `new URLSearchParams({ at: someDate })` actually writes.
 *
 * A string that parses to nothing is passed through unchanged so the ISO 8601
 * message fires rather than a bare "invalid date".
 */
function coerceTemporalInput(value: unknown): unknown {
  if (value instanceof Date) {
    return value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : value
  }

  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  if (ISO_DATE_TIME_PATTERN.test(trimmed)) {
    return trimmed
  }

  if (EPOCH_MILLIS_PATTERN.test(trimmed)) {
    const epochMillis = Number(trimmed)
    const fromEpoch = new Date(epochMillis)

    return Number.isNaN(fromEpoch.getTime()) ? value : fromEpoch
  }

  const parsed = new Date(trimmed)

  return Number.isNaN(parsed.getTime()) ? value : parsed
}

/**
 * Wraps any numeric schema in the query-string coercion above, keeping that
 * schema's bounds and its messages.
 *
 * ## Making a filter bound optional
 *
 * Reach for this rather than calling `.optional()` on one of the ready-made
 * `coerced…Schema` constants. `.optional()` wraps the preprocessing step from
 * the *outside*, and `z.ZodOptional` only short-circuits when the input is
 * already `undefined` — a blank `?minCents=` is the string `''`, so it sails
 * past the optional check and lands on the integer schema, which rejects it:
 *
 * ```ts
 * coercedMoneyCentsSchema.optional().parse('')          // ✗ throws
 * withNumericCoercion(moneyCentsSchema.optional()).parse('') // ✓ undefined
 * ```
 *
 * The optionality has to sit inside the coercion, because turning `''` into
 * "absent" is itself part of reading a query string.
 */
export function withNumericCoercion<Schema extends z.core.SomeType>(
  schema: Schema
) {
  return z.preprocess(coerceNumericInput, schema)
}

/**
 * Money for a **GET filter bound**, accepting `"1500"` as readily as `1500`.
 *
 * `moneyCentsSchema` is `z.int()` and does not coerce, so every numeric filter
 * bound rejected the very strings the contract's own serializer produces. Use
 * this one in `xFilterSchema`; keep `moneyCentsSchema` in request bodies, where
 * a string where a number belongs is a bug in the caller, not a transport
 * artefact.
 *
 * For an optional bound use `withNumericCoercion(moneyCentsSchema.optional())`.
 */
export const coercedMoneyCentsSchema = withNumericCoercion(moneyCentsSchema)
export type CoercedMoneyCents = z.infer<typeof coercedMoneyCentsSchema>

/** {@link ratingSchema} for a GET filter bound. One star through five. */
export const coercedRatingSchema = withNumericCoercion(ratingSchema)
export type CoercedRating = z.infer<typeof coercedRatingSchema>

/** Message overrides for {@link intSchema} and {@link coercedIntSchema}. */
export interface BoundedIntMessages {
  readonly notAnInteger?: string
  readonly tooSmall?: string
  readonly tooLarge?: string
}

/**
 * A whole number within an inclusive range — the strict twin, for request
 * bodies.
 *
 * Both bounds are required rather than optional: an unbounded integer arriving
 * from a browser is a denial-of-service waiting to happen, and every existing
 * call site had a ceiling in mind already.
 */
export function intSchema(
  min: number,
  max: number,
  messages: BoundedIntMessages = {}
) {
  return z
    .int({ error: messages.notAnInteger ?? 'Please enter a whole number.' })
    .min(min, {
      error:
        messages.tooSmall ?? `Please choose a number no lower than ${min}.`,
    })
    .max(max, {
      error:
        messages.tooLarge ?? `Please choose a number no higher than ${max}.`,
    })
}

/**
 * The same bounds and the same messages as {@link intSchema}, for a GET filter
 * bound. It composes the strict twin rather than restating it, so the two can
 * never drift apart.
 */
export function coercedIntSchema(
  min: number,
  max: number,
  messages: BoundedIntMessages = {}
) {
  return withNumericCoercion(intSchema(min, max, messages))
}

/**
 * The temporal counterpart of {@link withNumericCoercion}, with the same
 * guidance about where `.optional()` belongs:
 * `withTemporalCoercion(isoDateTimeSchema.optional())`.
 */
export function withTemporalCoercion<Schema extends z.core.SomeType>(
  schema: Schema
) {
  return z.preprocess(coerceTemporalInput, schema)
}

/**
 * {@link isoDateTimeSchema} for a GET filter bound: still yields a `Date`, but
 * additionally absorbs epoch milliseconds and the non-ISO string a `Date`
 * stringifies to when it is pushed through `URLSearchParams` — which is
 * `Date.prototype.toString()` output, not `toISOString()`, and which the strict
 * twin rightly rejects.
 */
export const coercedIsoDateTimeSchema = withTemporalCoercion(isoDateTimeSchema)
export type CoercedIsoDateTime = z.infer<typeof coercedIsoDateTimeSchema>

// -----------------------------------------------------------------------------
// Stripe references (MCV-010)
// -----------------------------------------------------------------------------

/**
 * A Stripe identifier of a known shape, bounded by the column width.
 *
 * `billing.ts` called this `stripeIdSchema` and `payment.ts` called it
 * `stripeReferenceSchema`; the two bodies were byte-identical down to the
 * over-long message, so this is the one definition of both. Neither copy was
 * exported, so nothing needed an alias to keep the barrel's surface intact —
 * this is a *new* public name rather than a replacement for an old one.
 *
 * The *patterns* stay in the domain modules. A `price_` prefix is a fact about
 * billing and a `pi_` prefix is a fact about payments; what is shared is the
 * envelope around them — trim, reject blank, bound by `MAX_STRIPE_ID_LENGTH`,
 * then match.
 *
 * The body is the two copies unchanged, including the `.refine(...)` rather
 * than a `.regex(...)`: the former lets each call site state its own boutique
 * "begins with price_" message, which is the whole reason the helper takes a
 * `shapeMessage` at all. Pass a stateless pattern — a `/g` or `/y` flag would
 * carry `lastIndex` across parses, and neither existing caller uses one.
 */
export function stripeIdSchema(
  pattern: RegExp,
  missingMessage: string,
  shapeMessage: string
) {
  return z
    .string({ error: missingMessage })
    .trim()
    .min(1, { error: missingMessage })
    .max(MAX_STRIPE_ID_LENGTH, {
      error: 'That Stripe reference is longer than our records allow.',
    })
    .refine((value) => pattern.test(value), { error: shapeMessage })
}
