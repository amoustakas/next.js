// mannachef/packages/validators/src/intake.ts

/**
 * Onboarding domain — the questionnaire a household completes before we cook for
 * them, the consultation that follows, and the payload that turns a prospect into
 * a client.
 *
 * Mirrors `ClientIntakeForm`, `ClientIntakeFormTag`, and `ConsultationInterview`
 * in `mannachef/packages/db/prisma/schema.prisma`. Field names, optionality, and
 * enum values are taken from that file verbatim — nothing here is invented.
 *
 * Two rules govern this package (see `common.ts`):
 *
 *  1. No runtime dependency on `@prisma/client`; enums come from `./enums`.
 *  2. Every constraint carries a human message. These strings are rendered
 *     verbatim beneath inputs in a luxury interface — they must sound like the
 *     brand, not like a validator.
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
  emailSchema,
  freeTextList,
  hasUniqueValues,
  isoDateTimeSchema,
  moneyCentsSchema,
  paginationSchema,
  percentSchema,
  phoneSchema,
  urlSchema,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'
import type { Address } from './common'
import {
  clientSourceSchema,
  clientStatusSchema,
  consultationOutcomeSchema,
  contactMethodSchema,
  deliveryFrequencySchema,
  onboardingStageSchema,
} from './enums'
import type {
  ClientStatus,
  ConsultationOutcome,
  OnboardingStage,
} from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Nobody we cook for has ever needed more places at the table than this. */
export const MAX_HOUSEHOLD_SIZE = 30

/** Free-text list caps. Generous, but a questionnaire is not a database. */
export const MAX_ALLERGIES = 30
export const MAX_DISLIKES = 40
export const MAX_CUISINE_PREFERENCES = 20
export const MAX_KITCHEN_EQUIPMENT = 40
export const MAX_FAVOURITE_DISHES = 25

/** Dietary / allergen `Tag` rows attached to one intake form. */
export const MAX_DIETARY_PREFERENCE_TAGS = 25

/** Longest single entry inside any of the free-text lists above. */
export const MAX_LIST_ENTRY_LENGTH = 120

/** `ClientIntakeForm.petsNote` is `VarChar(280)`. */
export const MAX_PETS_NOTE_LENGTH = 280

/** Long-form note columns are `@db.Text`; we still refuse an essay. */
export const MAX_NOTES_LENGTH = 2000

/** Budget guard rails, in cents. $5.00 through $1,000.00 per meal. */
export const MIN_BUDGET_PER_MEAL_CENTS = 500
export const MAX_BUDGET_PER_MEAL_CENTS = 100_000

/** A consultation runs from a quarter of an hour to half a day. */
export const MIN_CONSULTATION_MINUTES = 15
export const MAX_CONSULTATION_MINUTES = 240

/** How many candidate dates a prospect may offer when requesting a consultation. */
export const MAX_PREFERRED_CONSULTATION_DATES = 3

/** `ConsultationInterview.location` is `VarChar(200)`. */
export const MAX_CONSULTATION_LOCATION_LENGTH = 200

/** `ClientProfile.sourceDetail` is `VarChar(200)`. */
export const MAX_SOURCE_DETAIL_LENGTH = 200

/** `ReferralCode.code` is `VarChar(40)`. */
export const MAX_REFERRAL_CODE_LENGTH = 40

/** Referral codes are typed by hand, so we accept letters, digits, and hyphens. */
const REFERRAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/

/**
 * The epoch milliseconds of a value that really is a usable `Date`, or
 * `undefined` for anything else.
 *
 * The array-level rules on `preferredDates` go through this instead of calling
 * `date.getTime()` directly. In zod 4 an element that fails a `z.ZodPipe` — and
 * `isoDateTimeSchema` is one — does not abort its array, so those rules can be
 * handed the caller's raw string. Skipping such an element loses nothing: it
 * has already produced its own, more precise issue.
 */
function parsedInstant(value: unknown): number | undefined {
  if (!(value instanceof Date)) {
    return undefined
  }

  const instant = value.getTime()

  return Number.isNaN(instant) ? undefined : instant
}

// =============================================================================
// Free-text lists (MCV-004 / MCV-005)
// =============================================================================

/**
 * `dedupeCaseInsensitive` and `freeTextList` used to live here, with the comment
 * "not a redefinition of a shared primitive". They were both, and both now come
 * from `common.ts` — the messages were always per-call-site configuration, which
 * is exactly what `FreeTextListConfig` carries.
 *
 * The move is not cosmetic. The copy in this file built its lists as
 * `.default([]).transform(dedupeCaseInsensitive)`, which leaves a `z.ZodPipe` as
 * the outermost wrapper with the default buried inside it. `withoutDefaults`
 * only inspects the outermost wrapper, so it could not see that default and
 * could not strip it; the fields escaped the injection bug only by accident,
 * because `z.ZodOptional` short-circuits on `undefined` over a `ZodPipe` while it
 * does *not* over a `ZodDefault`. The shared version transforms first and
 * defaults last, so every default in a shape is visible to `withoutDefaults` and
 * the ordering is deterministic rather than lucky.
 *
 * `MAX_LIST_ENTRY_LENGTH` is passed explicitly rather than left to the shared
 * `MAX_FREE_TEXT_ENTRY_LENGTH` fallback, because the messages below quote it and
 * the two constants must be seen to agree.
 */

// =============================================================================
// Cook days
// =============================================================================

/**
 * `ClientIntakeForm.preferredCookDays` is a `String[]`. We constrain it to these
 * seven tokens so the portal, the admin OS, and the Expo client all read the same
 * values back out of the column.
 */
export const cookDaySchema = z.enum(
  [
    'SUNDAY',
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
  ],
  { error: 'Please choose a day of the week.' }
)
export type CookDay = z.infer<typeof cookDaySchema>

// =============================================================================
// Step 1 — the household
// =============================================================================

const householdStepShape = {
  householdSize: z
    .int({ error: 'Please tell us how many people live in the home.' })
    .min(1, { error: 'There is at least one of you — we hope.' })
    .max(MAX_HOUSEHOLD_SIZE, {
      error: `For a household larger than ${MAX_HOUSEHOLD_SIZE}, speak with us about private events instead.`,
    }),
  adults: z
    .int({ error: 'Please tell us how many adults are in the household.' })
    .min(1, { error: 'At least one adult must be present for us to cook.' })
    .max(MAX_HOUSEHOLD_SIZE, {
      error: `Please keep the number of adults to ${MAX_HOUSEHOLD_SIZE} or fewer.`,
    }),
  children: z
    .int({ error: 'Please tell us how many children are in the household.' })
    .min(0, { error: 'The number of children cannot be less than none.' })
    .max(MAX_HOUSEHOLD_SIZE, {
      error: `Please keep the number of children to ${MAX_HOUSEHOLD_SIZE} or fewer.`,
    }),
} as const

function householdAddsUp(value: {
  readonly householdSize: number
  readonly adults: number
  readonly children: number
}): boolean {
  return value.adults + value.children === value.householdSize
}

const HOUSEHOLD_SUM_ERROR =
  'The adults and children should add up to the size of the household.'

/**
 * ## Why the cross-field rules in this file are attached with `.check(…)`
 *
 * A zod 4 object-level `.refine()` still runs when one of the object's own
 * fields has already failed, and it receives that field's *raw* value. Every
 * date here is an `isoDateTimeSchema`, which is a `z.ZodPipe` and therefore
 * does not abort its parent object on failure — so
 * `clientIntakeUpdateSchema.safeParse({ clientProfileId: …, submittedAt: 'foo' })`
 * threw `TypeError: value.submittedAt.getTime is not a function` rather than
 * returning `{ success: false }`.
 *
 * `crossField` / `crossFieldMixed` (see `common.ts`) declare which fields a rule
 * reads, skip the rule when one of them has already produced an issue, and hand
 * the predicate values that are guaranteed present and of the declared runtime
 * type. Rules that only test *presence* — "a follow-up outcome needs a
 * follow-up date" — stay plain `.refine()`s: they must fire precisely when a
 * field is missing, which is the one thing a declared dependency suppresses.
 */
export const intakeHouseholdStepSchema = z
  .object(householdStepShape)
  .strict()
  .check(
    crossField(
      {
        deps: ['householdSize', 'adults', 'children'],
        as: 'number',
        error: HOUSEHOLD_SUM_ERROR,
        path: ['householdSize'],
      },
      (values) => householdAddsUp(values)
    )
  )
export type IntakeHouseholdStep = z.infer<typeof intakeHouseholdStepSchema>
export type IntakeHouseholdStepInput = z.input<typeof intakeHouseholdStepSchema>

// =============================================================================
// Step 2 — what the table can and cannot eat
// =============================================================================

const dietaryStepShape = {
  /**
   * Written by the guest, in their words. The structured counterpart is
   * `dietaryPreferenceTagIds` below.
   */
  allergies: freeTextList({
    maxEntries: MAX_ALLERGIES,
    maxEntryLength: MAX_LIST_ENTRY_LENGTH,
    missingError: 'Please list any allergies, or leave the list empty.',
    emptyEntryError: 'Please name the allergy, or remove the empty line.',
    longEntryError: `Please keep each allergy to ${MAX_LIST_ENTRY_LENGTH} characters or fewer.`,
    tooManyError: `We can record up to ${MAX_ALLERGIES} allergies here — tell us the rest in the notes.`,
  }),
  dislikes: freeTextList({
    maxEntries: MAX_DISLIKES,
    maxEntryLength: MAX_LIST_ENTRY_LENGTH,
    missingError:
      'Please list anything you would rather not see, or leave it empty.',
    emptyEntryError:
      'Please name the dish or ingredient, or remove the empty line.',
    longEntryError: `Please keep each dislike to ${MAX_LIST_ENTRY_LENGTH} characters or fewer.`,
    tooManyError: `We can record up to ${MAX_DISLIKES} dislikes here — tell us the rest in the notes.`,
  }),
  cuisinePreferences: freeTextList({
    maxEntries: MAX_CUISINE_PREFERENCES,
    maxEntryLength: MAX_LIST_ENTRY_LENGTH,
    missingError:
      'Please choose the cuisines you love, or leave the list empty.',
    emptyEntryError: 'Please name the cuisine, or remove the empty line.',
    longEntryError: `Please keep each cuisine to ${MAX_LIST_ENTRY_LENGTH} characters or fewer.`,
    tooManyError: `Choose up to ${MAX_CUISINE_PREFERENCES} cuisines so we can cook them properly.`,
  }),
  /** Join rows on `ClientIntakeFormTag`; each id is a `Tag` of kind DIETARY or ALLERGEN. */
  dietaryPreferenceTagIds: z
    .array(cuidSchema, {
      error: 'Please choose your dietary preferences from the list.',
    })
    .max(MAX_DIETARY_PREFERENCE_TAGS, {
      error: `Please choose up to ${MAX_DIETARY_PREFERENCE_TAGS} dietary preferences.`,
    })
    /**
     * Attached before `.default([])`, not after.
     *
     * A check added on top of a default lands on the `z.ZodDefault` wrapper, and
     * `withoutDefaults` strips that wrapper with `.unwrap()` — which would carry
     * the uniqueness rule away with it. Ordered like this, `.unwrap()` yields the
     * array with the rule intact, and an empty default needs no checking.
     */
    .refine(hasUniqueValues, {
      error: 'Each dietary preference may only be chosen once.',
    })
    .default([]),
} as const

export const intakeDietaryStepSchema = z.object(dietaryStepShape).strict()
export type IntakeDietaryStep = z.infer<typeof intakeDietaryStepSchema>
export type IntakeDietaryStepInput = z.input<typeof intakeDietaryStepSchema>

// =============================================================================
// Step 3 — the kitchen we will be working in
// =============================================================================

const kitchenStepShape = {
  kitchenEquipment: freeTextList({
    maxEntries: MAX_KITCHEN_EQUIPMENT,
    maxEntryLength: MAX_LIST_ENTRY_LENGTH,
    missingError:
      'Please tell us what the kitchen holds, or leave the list empty.',
    emptyEntryError:
      'Please name the piece of equipment, or remove the empty line.',
    longEntryError: `Please keep each entry to ${MAX_LIST_ENTRY_LENGTH} characters or fewer.`,
    tooManyError: `We can note up to ${MAX_KITCHEN_EQUIPMENT} pieces of equipment — the chef will see the rest on the day.`,
  }),
  favouriteDishes: freeTextList({
    maxEntries: MAX_FAVOURITE_DISHES,
    maxEntryLength: MAX_LIST_ENTRY_LENGTH,
    missingError: 'Please name a few favourites, or leave the list empty.',
    emptyEntryError: 'Please name the dish, or remove the empty line.',
    longEntryError: `Please keep each dish to ${MAX_LIST_ENTRY_LENGTH} characters or fewer.`,
    tooManyError: `Give us your ${MAX_FAVOURITE_DISHES} favourites — that is more than enough to begin.`,
  }),
  hasPets: z
    .boolean({
      error: 'Please let us know whether there are pets in the home.',
    })
    .default(false),
  petsNote: z
    .string({ error: 'Please tell us about the pets in a sentence or two.' })
    .trim()
    .max(MAX_PETS_NOTE_LENGTH, {
      error: `Please keep the note about your pets to ${MAX_PETS_NOTE_LENGTH} characters or fewer.`,
    })
    .optional(),
} as const

function petsNoteIsConsistent(value: {
  readonly hasPets: boolean
  readonly petsNote?: string | undefined
}): boolean {
  if (value.petsNote === undefined || value.petsNote.length === 0) {
    return true
  }

  return value.hasPets
}

const PETS_NOTE_ERROR =
  'Let us know there are pets in the home before telling us about them.'

export const intakeKitchenStepSchema = z
  .object(kitchenStepShape)
  .strict()
  .check(
    crossFieldMixed(
      {
        deps: { hasPets: 'boolean', petsNote: 'string' },
        error: PETS_NOTE_ERROR,
        path: ['hasPets'],
      },
      (values) => petsNoteIsConsistent(values)
    )
  )
export type IntakeKitchenStep = z.infer<typeof intakeKitchenStepSchema>
export type IntakeKitchenStepInput = z.input<typeof intakeKitchenStepSchema>

// =============================================================================
// Step 4 — service, cadence, and where we are cooking
// =============================================================================

const serviceStepShape = {
  deliveryFrequency: deliveryFrequencySchema.default('WEEKLY'),
  budgetPerMealCents: moneyCentsSchema
    .min(MIN_BUDGET_PER_MEAL_CENTS, {
      error: 'Our smallest engagements begin at $5.00 per meal.',
    })
    .max(MAX_BUDGET_PER_MEAL_CENTS, {
      error:
        'For a budget above $1,000.00 a meal, please speak with us directly — we will design it with you.',
    })
    .optional(),
  currency: currencySchema,
  /**
   * Flattened onto `ClientIntakeForm.serviceAddressLine1 … serviceCountry` by
   * `serviceAddressToColumns` below. Optional here because the questionnaire may
   * be completed before a home has been chosen.
   */
  serviceAddress: addressSchema.optional(),
  serviceAccessNotes: z
    .string({ error: 'Please tell us how to reach your door.' })
    .trim()
    .max(MAX_NOTES_LENGTH, {
      error: `Please keep the access notes to ${MAX_NOTES_LENGTH} characters or fewer.`,
    })
    .optional(),
} as const

export const intakeServiceStepSchema = z.object(serviceStepShape).strict()
export type IntakeServiceStep = z.infer<typeof intakeServiceStepSchema>
export type IntakeServiceStepInput = z.input<typeof intakeServiceStepSchema>

// =============================================================================
// Step 5 — how we should stay in touch
// =============================================================================

const preferencesStepShape = {
  preferredContactMethod: contactMethodSchema.default('EMAIL'),
  preferredCookDays: z
    .array(cookDaySchema, {
      error:
        'Please choose the days that suit you, or leave them all unchosen.',
    })
    .max(7, { error: 'There are only seven days in the week.' })
    /** Before the default, for the reason spelled out on `dietaryPreferenceTagIds`. */
    .refine(hasUniqueValues, {
      error: 'Each day may only be chosen once.',
    })
    .default([]),
  notes: z
    .string({ error: 'Please add anything else we should know.' })
    .trim()
    .max(MAX_NOTES_LENGTH, {
      error: `Please keep your notes to ${MAX_NOTES_LENGTH} characters or fewer.`,
    })
    .optional(),
} as const

export const intakePreferencesStepSchema = z
  .object(preferencesStepShape)
  .strict()
export type IntakePreferencesStep = z.infer<typeof intakePreferencesStepSchema>
export type IntakePreferencesStepInput = z.input<
  typeof intakePreferencesStepSchema
>

// =============================================================================
// The questionnaire wizard
// =============================================================================

/**
 * The five steps of the intake questionnaire, in the order they are presented.
 *
 * The wizard validates one entry at a time — `intakeStepSchemas[index]` — and
 * only assembles the whole answer through `clientIntakeSchema` on submission.
 * The union of the five step shapes is exactly the shape of `clientIntakeSchema`,
 * so a step can never collect a field the final submission would reject.
 */
export const intakeStepSchemas = [
  intakeHouseholdStepSchema,
  intakeDietaryStepSchema,
  intakeKitchenStepSchema,
  intakeServiceStepSchema,
  intakePreferencesStepSchema,
] as const
export type IntakeStepSchema = (typeof intakeStepSchemas)[number]
export type IntakeStepValues = z.infer<IntakeStepSchema>
export type IntakeStepInput = z.input<IntakeStepSchema>

/** Number of steps in the questionnaire. Drives the progress rule in the UI. */
export const INTAKE_STEP_COUNT = intakeStepSchemas.length

/** Stable identifiers for each step — safe to put in a URL or a saved draft. */
export const INTAKE_STEP_IDS = [
  'household',
  'dietary',
  'kitchen',
  'service',
  'preferences',
] as const
export type IntakeStepId = (typeof INTAKE_STEP_IDS)[number]

/**
 * Presentation metadata for the wizard: the copy above each step and the exact
 * field names that step owns, so React Hook Form can `trigger(fields)` without a
 * second hand-maintained list.
 */
export const INTAKE_STEPS = [
  {
    id: 'household',
    title: 'Your table',
    description: 'Who are we cooking for?',
    fields: Object.keys(householdStepShape),
    schema: intakeHouseholdStepSchema,
  },
  {
    id: 'dietary',
    title: 'Your palate',
    description: 'Allergies, aversions, and the flavours you return to.',
    fields: Object.keys(dietaryStepShape),
    schema: intakeDietaryStepSchema,
  },
  {
    id: 'kitchen',
    title: 'Your kitchen',
    description: 'What we will be working with, and who else is home.',
    fields: Object.keys(kitchenStepShape),
    schema: intakeKitchenStepSchema,
  },
  {
    id: 'service',
    title: 'Your service',
    description: 'How often we cook, what you would like to invest, and where.',
    fields: Object.keys(serviceStepShape),
    schema: intakeServiceStepSchema,
  },
  {
    id: 'preferences',
    title: 'Staying in touch',
    description: 'The days that suit you and the way you like to hear from us.',
    fields: Object.keys(preferencesStepShape),
    schema: intakePreferencesStepSchema,
  },
] as const satisfies readonly {
  readonly id: IntakeStepId
  readonly title: string
  readonly description: string
  readonly fields: readonly string[]
  readonly schema: IntakeStepSchema
}[]

/**
 * The schema for a given step index, or `undefined` when the wizard has walked
 * off the end of the questionnaire.
 */
export function intakeStepSchemaAt(
  index: number
): IntakeStepSchema | undefined {
  return intakeStepSchemas[index]
}

// =============================================================================
// The complete intake form
// =============================================================================

const clientIntakeShape = {
  ...householdStepShape,
  ...dietaryStepShape,
  ...kitchenStepShape,
  ...serviceStepShape,
  ...preferencesStepShape,
} as const

/**
 * Everything a household tells us, as submitted by the client themselves.
 *
 * `submittedAt` is deliberately absent: it is stamped by the server action when
 * the wizard completes and is never accepted from the browser. Staff completing a
 * form on a client's behalf use `clientIntakeCreateSchema`, which does carry it.
 */
export const clientIntakeSchema = z
  .object(clientIntakeShape)
  .strict()
  .check(
    crossField(
      {
        deps: ['householdSize', 'adults', 'children'],
        as: 'number',
        error: HOUSEHOLD_SUM_ERROR,
        path: ['householdSize'],
      },
      (values) => householdAddsUp(values)
    ),
    crossFieldMixed(
      {
        deps: { hasPets: 'boolean', petsNote: 'string' },
        error: PETS_NOTE_ERROR,
        path: ['hasPets'],
      },
      (values) => petsNoteIsConsistent(values)
    )
  )
export type ClientIntake = z.infer<typeof clientIntakeSchema>
export type ClientIntakeInput = z.input<typeof clientIntakeSchema>

/**
 * The staff-facing create payload: the same answers, attributed to a client and
 * optionally back-dated to when the household actually gave them to us.
 *
 * `clientProfileId` is never trusted on its own — the action must confirm the
 * caller may act for that household (see `mannachef/CONTRACT.md` §5).
 */
export const clientIntakeCreateSchema = z
  .object({
    clientProfileId: cuidSchema,
    submittedAt: isoDateTimeSchema.optional(),
    ...clientIntakeShape,
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['householdSize', 'adults', 'children'],
        as: 'number',
        error: HOUSEHOLD_SUM_ERROR,
        path: ['householdSize'],
      },
      (values) => householdAddsUp(values)
    ),
    crossFieldMixed(
      {
        deps: { hasPets: 'boolean', petsNote: 'string' },
        error: PETS_NOTE_ERROR,
        path: ['hasPets'],
      },
      (values) => petsNoteIsConsistent(values)
    ),
    crossField(
      {
        deps: ['submittedAt'],
        as: 'date',
        error: 'An intake form cannot have been submitted in the future.',
        path: ['submittedAt'],
      },
      ({ submittedAt }) => submittedAt.getTime() <= Date.now()
    )
  )
export type ClientIntakeCreateInput = z.infer<typeof clientIntakeCreateSchema>
export type ClientIntakeCreateRawInput = z.input<
  typeof clientIntakeCreateSchema
>

/**
 * A partial edit of an existing intake form. Every answer is optional, so the
 * household-sum rule is checked only once all three numbers are on the table —
 * changing the number of children alone still has to balance against whatever is
 * already stored, which the action verifies after merging.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * `.partial()` does not stop a `.default(...)` from firing, so
 * `{ clientProfileId, notes: 'gate code changed' }` used to parse to a payload
 * that also carried `dietaryPreferenceTagIds: []`. Written through
 * `prisma.update`, that deletes every `ClientIntakeFormTag` join row on the
 * form — which in a private-chef product is the household's allergen record.
 * The same edit reset `hasPets`, `deliveryFrequency`, `preferredContactMethod`,
 * `preferredCookDays`, `currency`, and all five free-text lists.
 *
 * `submittedAt` is carried in the shape rather than in `requireKeys` so it stays
 * an editable field: putting it among the required keys would raise the
 * "something to save" threshold to two and let a bare `{ clientProfileId,
 * submittedAt }` through as if it were an edit.
 */
export const clientIntakeUpdateSchema = buildUpdateSchema(
  { ...clientIntakeShape, submittedAt: isoDateTimeSchema },
  { requireKeys: { clientProfileId: cuidSchema } }
)
  /**
   * The hand-written `=== undefined` chains these three rules used to open with
   * are gone: `crossField` does not call a predicate until every declared
   * dependency is present, so an edit that names only some of the fields skips
   * the rule instead of having to opt out of it.
   */
  .check(
    crossField(
      {
        deps: ['householdSize', 'adults', 'children'],
        as: 'number',
        error: HOUSEHOLD_SUM_ERROR,
        path: ['householdSize'],
      },
      (values) => householdAddsUp(values)
    ),
    crossFieldMixed(
      {
        deps: { hasPets: 'boolean', petsNote: 'string' },
        error: PETS_NOTE_ERROR,
        path: ['hasPets'],
      },
      (values) => petsNoteIsConsistent(values)
    ),
    crossField(
      {
        deps: ['submittedAt'],
        as: 'date',
        error: 'An intake form cannot have been submitted in the future.',
        path: ['submittedAt'],
      },
      ({ submittedAt }) => submittedAt.getTime() <= Date.now()
    )
  )
export type ClientIntakeUpdateInput = z.infer<typeof clientIntakeUpdateSchema>
export type ClientIntakeUpdateRawInput = z.input<
  typeof clientIntakeUpdateSchema
>

/** The six flat service-address columns on `ClientIntakeForm`. */
export interface ServiceAddressColumns {
  serviceAddressLine1: string | null
  serviceAddressLine2: string | null
  serviceCity: string | null
  serviceRegion: string | null
  servicePostalCode: string | null
  serviceCountry: string | null
}

/**
 * Flattens the composed `addressSchema` value onto the column names Prisma
 * expects. Absent parts become `null` so a cleared address clears the row rather
 * than leaving a stale fragment behind.
 */
export function serviceAddressToColumns(
  address: Address | undefined
): ServiceAddressColumns {
  if (address === undefined) {
    return {
      serviceAddressLine1: null,
      serviceAddressLine2: null,
      serviceCity: null,
      serviceRegion: null,
      servicePostalCode: null,
      serviceCountry: null,
    }
  }

  return {
    serviceAddressLine1: address.line1,
    serviceAddressLine2: address.line2 ?? null,
    serviceCity: address.city,
    serviceRegion: address.region,
    servicePostalCode: address.postalCode,
    serviceCountry: address.country,
  }
}

/**
 * Admin list filter for submitted and in-progress questionnaires.
 *
 * Reachable over GET, so both date bounds coerce: `withTemporalCoercion` sits
 * *outside* the `.optional()` so a rendered-but-empty `?submittedFrom=` reads as
 * "no bound" instead of failing as an invalid date.
 *
 * The two flags are three-state — set, cleared, or absent — so `queryFlag` is
 * not what they want: its default would collapse "show everything" into "show
 * only the false side". They take `queryFlag`'s union without its default, which
 * is what lets `?isSubmitted=true` arrive as the string it really is.
 */
export const clientIntakeFilterSchema = paginationSchema.extend({
  deliveryFrequency: deliveryFrequencySchema.optional(),
  /** `true` keeps only submitted forms, `false` keeps only drafts. */
  isSubmitted: z
    .union(
      [
        z.boolean({
          error: 'Please choose whether to show submitted forms.',
        }),
        z.stringbool({
          error: 'Please choose whether to show submitted forms.',
        }),
      ],
      { error: 'Please choose whether to show submitted forms.' }
    )
    .optional(),
  hasAllergies: z
    .union(
      [
        z.boolean({
          error: 'Please choose whether to show households with allergies.',
        }),
        z.stringbool({
          error: 'Please choose whether to show households with allergies.',
        }),
      ],
      {
        error: 'Please choose whether to show households with allergies.',
      }
    )
    .optional(),
  submittedFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
  submittedUntil: withTemporalCoercion(isoDateTimeSchema.optional()),
})
export type ClientIntakeFilter = z.infer<typeof clientIntakeFilterSchema>
export type ClientIntakeFilterInput = z.input<typeof clientIntakeFilterSchema>

// =============================================================================
// Consultation request — the public-facing enquiry
// =============================================================================

/**
 * What a prospect sends from the marketing site to ask for a consultation.
 *
 * This one payload seeds three rows: the `User` (name, email, phone), the
 * `ClientProfile` (source, sourceDetail, preferredContactMethod, phone), and the
 * first `ConsultationInterview` (scheduledFor, durationMinutes, staffProfileId).
 *
 * `consentToContact` is form-only — it gates submission and is never persisted as
 * a column; the acceptance itself is recorded as an `InteractionLog` by the action.
 */
export const consultationRequestSchema = z
  .object({
    fullName: z
      .string({ error: 'Please tell us your name.' })
      .trim()
      .min(2, { error: 'Please give us your full name.' })
      .max(200, { error: 'Please keep your name to 200 characters or fewer.' }),
    email: emailSchema,
    phone: phoneSchema.optional(),
    preferredContactMethod: contactMethodSchema.default('EMAIL'),
    source: clientSourceSchema.default('DIRECT'),
    sourceDetail: z
      .string({ error: 'Please tell us a little more about how you found us.' })
      .trim()
      .max(MAX_SOURCE_DETAIL_LENGTH, {
        error: `Please keep that to ${MAX_SOURCE_DETAIL_LENGTH} characters or fewer.`,
      })
      .optional(),
    householdSize: z
      .int({ error: 'Please tell us how many people live in the home.' })
      .min(1, { error: 'There is at least one of you — we hope.' })
      .max(MAX_HOUSEHOLD_SIZE, {
        error: `For a household larger than ${MAX_HOUSEHOLD_SIZE}, speak with us about private events instead.`,
      })
      .optional(),
    /** A chef the prospect has asked for by name. */
    staffProfileId: cuidSchema.optional(),
    /** Candidate times, best first. The concierge confirms exactly one of them. */
    preferredDates: z
      .array(isoDateTimeSchema, {
        error: 'Please offer at least one time that suits you.',
      })
      .min(1, { error: 'Please offer at least one time that suits you.' })
      .max(MAX_PREFERRED_CONSULTATION_DATES, {
        error: `Please offer up to ${MAX_PREFERRED_CONSULTATION_DATES} times and we will confirm one of them.`,
      })
      /**
       * Both rules below read each element through {@link parsedInstant}
       * rather than calling `date.getTime()` directly.
       *
       * `isoDateTimeSchema` is a `z.ZodPipe`, and in zod 4 a failing pipe
       * *element* does not abort its array the way a failing plain schema does
       * — the array's own checks run anyway, holding whatever the caller sent.
       * `safeParse({ …, preferredDates: ['foo'] })` therefore threw
       * `TypeError: date.getTime is not a function` instead of reporting the
       * malformed date. Elements that did not survive parsing are skipped here;
       * each has already produced its own, more precise issue.
       */
      .refine(
        (dates) =>
          dates.every((date) => {
            const instant = parsedInstant(date)
            return instant === undefined || instant > Date.now()
          }),
        {
          error: 'Every time you offer must fall in the future.',
        }
      )
      /**
       * Mapped to epoch milliseconds first: `hasUniqueValues` compares by
       * identity, and two `Date` objects for the same instant are not the same
       * object. This is the pattern `common.ts` documents for structural values.
       */
      .refine(
        (dates) =>
          hasUniqueValues(
            dates
              .map((date) => parsedInstant(date))
              .filter((instant): instant is number => instant !== undefined)
          ),
        {
          error: 'Please offer times that differ from one another.',
        }
      ),
    durationMinutes: durationMinutesSchema
      .min(MIN_CONSULTATION_MINUTES, {
        error: 'A consultation needs at least a quarter of an hour.',
      })
      .max(MAX_CONSULTATION_MINUTES, {
        error: 'A consultation runs no longer than four hours.',
      })
      .default(30),
    message: z
      .string({ error: 'Tell us what you have in mind.' })
      .trim()
      .max(MAX_NOTES_LENGTH, {
        error: `Please keep your message to ${MAX_NOTES_LENGTH} characters or fewer.`,
      })
      .optional(),
    referralCode: z
      .string({ error: 'Please enter the referral code you were given.' })
      .trim()
      .toUpperCase()
      .max(MAX_REFERRAL_CODE_LENGTH, {
        error: `A referral code is ${MAX_REFERRAL_CODE_LENGTH} characters or fewer.`,
      })
      .regex(REFERRAL_CODE_PATTERN, {
        error: 'Referral codes use letters, numbers, and hyphens only.',
      })
      .optional(),
    consentToContact: z.literal(true, {
      error: 'Please agree to let us contact you about your enquiry.',
    }),
  })
  .strict()
  .refine(
    (value) =>
      value.preferredContactMethod === 'EMAIL' || value.phone !== undefined,
    {
      error:
        'Please share a phone number if you would like us to reach you by phone or text.',
      path: ['phone'],
    }
  )
  .refine(
    (value) => value.source !== 'OTHER' || value.sourceDetail !== undefined,
    {
      error: 'Please tell us how you came to find us.',
      path: ['sourceDetail'],
    }
  )
  .refine(
    (value) => value.source !== 'REFERRAL' || value.referralCode !== undefined,
    {
      error: 'Please enter the referral code from the person who sent you.',
      path: ['referralCode'],
    }
  )
export type ConsultationRequestInput = z.infer<typeof consultationRequestSchema>
export type ConsultationRequestRawInput = z.input<
  typeof consultationRequestSchema
>

// =============================================================================
// Consultation interview — the record staff keep
// =============================================================================

/**
 * Everything about an interview that may be edited after it is written.
 *
 * Split out from `consultationInterviewShape` so `consultationInterviewUpdateSchema`
 * can be built from a shape rather than by `.omit()`-ing `clientProfileId` off an
 * assembled object: `buildUpdateSchema` needs the raw shape in order to strip the
 * `.default(...)`s before `.partial()` makes the fields optional.
 */
const consultationInterviewEditableShape = {
  /** The `User` who ran the interview. */
  conductedById: cuidSchema.optional(),
  /** The chef being matched, when a specific one is in the room. */
  staffProfileId: cuidSchema.optional(),
  scheduledFor: isoDateTimeSchema,
  durationMinutes: durationMinutesSchema
    .min(MIN_CONSULTATION_MINUTES, {
      error: 'A consultation needs at least a quarter of an hour.',
    })
    .max(MAX_CONSULTATION_MINUTES, {
      error: 'A consultation runs no longer than four hours.',
    })
    .default(30),
  location: z
    .string({ error: 'Please say where the consultation takes place.' })
    .trim()
    .max(MAX_CONSULTATION_LOCATION_LENGTH, {
      error: `Please keep the location to ${MAX_CONSULTATION_LOCATION_LENGTH} characters or fewer.`,
    })
    .optional(),
  meetingUrl: urlSchema.optional(),
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  /** 0–100 fit score produced by the consultation rubric. */
  compatibilityScore: percentSchema.optional(),
  notes: z
    .string({ error: 'Please record what was said.' })
    .trim()
    .max(MAX_NOTES_LENGTH, {
      error: `Please keep the notes to ${MAX_NOTES_LENGTH} characters or fewer.`,
    })
    .optional(),
  chefSummary: z
    .string({ error: 'Please summarise the fit for the chef.' })
    .trim()
    .max(MAX_NOTES_LENGTH, {
      error: `Please keep the summary to ${MAX_NOTES_LENGTH} characters or fewer.`,
    })
    .optional(),
  outcome: consultationOutcomeSchema.default('PENDING'),
  followUpAt: isoDateTimeSchema.optional(),
  convertedToClientAt: isoDateTimeSchema.optional(),
} as const

/**
 * The interview, plus the household it was arranged for. Only a create payload
 * names the household — a consultation is never moved between them.
 */
const consultationInterviewShape = {
  clientProfileId: cuidSchema,
  ...consultationInterviewEditableShape,
} as const

interface ConsultationTimingShape {
  readonly scheduledFor?: Date | undefined
  readonly startedAt?: Date | undefined
  readonly completedAt?: Date | undefined
  readonly followUpAt?: Date | undefined
}

function completionFollowsStart(value: ConsultationTimingShape): boolean {
  if (value.startedAt === undefined || value.completedAt === undefined) {
    return true
  }

  return value.completedAt.getTime() > value.startedAt.getTime()
}

function followUpFollowsSchedule(value: ConsultationTimingShape): boolean {
  if (value.followUpAt === undefined || value.scheduledFor === undefined) {
    return true
  }

  return value.followUpAt.getTime() > value.scheduledFor.getTime()
}

const COMPLETION_AFTER_START_ERROR =
  'A consultation must finish after it begins — set the finish time later than the start.'
const FOLLOW_UP_AFTER_SCHEDULE_ERROR =
  'A follow-up must be arranged for after the consultation itself.'
const FOLLOW_UP_REQUIRED_ERROR =
  'Choose the date you will follow up on before marking this as needing one.'
const CONVERSION_OUTCOME_ERROR =
  'Only a converted consultation carries the moment the household became a client.'

export const consultationInterviewSchema = z
  .object(consultationInterviewShape)
  .strict()
  .check(
    crossField(
      {
        deps: ['startedAt', 'completedAt'],
        as: 'date',
        error: COMPLETION_AFTER_START_ERROR,
        path: ['completedAt'],
      },
      (values) => completionFollowsStart(values)
    ),
    crossField(
      {
        deps: ['scheduledFor', 'followUpAt'],
        as: 'date',
        error: FOLLOW_UP_AFTER_SCHEDULE_ERROR,
        path: ['followUpAt'],
      },
      (values) => followUpFollowsSchedule(values)
    )
  )
  /** Presence-only rules: nothing is dereferenced, and both must fire on absence. */
  .refine(
    (value) =>
      value.outcome !== 'FOLLOW_UP_REQUIRED' || value.followUpAt !== undefined,
    { error: FOLLOW_UP_REQUIRED_ERROR, path: ['followUpAt'] }
  )
  .refine(
    (value) =>
      value.convertedToClientAt === undefined || value.outcome === 'CONVERTED',
    { error: CONVERSION_OUTCOME_ERROR, path: ['convertedToClientAt'] }
  )
export type ConsultationInterviewInput = z.infer<
  typeof consultationInterviewSchema
>
export type ConsultationInterviewRawInput = z.input<
  typeof consultationInterviewSchema
>

/** Alias kept for the `xCreateSchema` convention in `mannachef/CONTRACT.md` §4. */
export const consultationInterviewCreateSchema = consultationInterviewSchema
export type ConsultationInterviewCreateInput = ConsultationInterviewInput

/**
 * Editing an interview after the fact — rescheduling it, scoring it, or recording
 * how it ended. `clientProfileId` is not editable: a consultation belongs to the
 * household it was arranged for.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * A default still fires underneath `.partial()`, so
 * `{ consultationInterviewId, notes: 'sent the menu' }` used to parse with
 * `outcome: 'PENDING'` and `durationMinutes: 30` attached. Writing that back
 * clobbers a `CONVERTED` outcome — the household drops out of the pipeline board
 * and back into the follow-up queue because somebody typed up their notes — and
 * quietly rewrites the length of an interview that ran for an hour.
 *
 * Worse, `outcome: 'PENDING'` slipping in is invisible to the two refinements
 * below: both are satisfied by `PENDING`, so nothing objected. Stripping the
 * default first is the only fix; a guard after the fact cannot tell an injected
 * `PENDING` from one the caller meant.
 */
export const consultationInterviewUpdateSchema = buildUpdateSchema(
  consultationInterviewEditableShape,
  { requireKeys: { consultationInterviewId: cuidSchema } }
)
  .check(
    crossField(
      {
        deps: ['startedAt', 'completedAt'],
        as: 'date',
        error: COMPLETION_AFTER_START_ERROR,
        path: ['completedAt'],
      },
      (values) => completionFollowsStart(values)
    ),
    crossField(
      {
        deps: ['scheduledFor', 'followUpAt'],
        as: 'date',
        error: FOLLOW_UP_AFTER_SCHEDULE_ERROR,
        path: ['followUpAt'],
      },
      (values) => followUpFollowsSchedule(values)
    )
  )
  /** Presence-only rules: nothing is dereferenced, and both must fire on absence. */
  .refine(
    (value) =>
      value.outcome !== 'FOLLOW_UP_REQUIRED' || value.followUpAt !== undefined,
    { error: FOLLOW_UP_REQUIRED_ERROR, path: ['followUpAt'] }
  )
  .refine(
    (value) =>
      value.convertedToClientAt === undefined || value.outcome === 'CONVERTED',
    { error: CONVERSION_OUTCOME_ERROR, path: ['convertedToClientAt'] }
  )
export type ConsultationInterviewUpdateInput = z.infer<
  typeof consultationInterviewUpdateSchema
>
export type ConsultationInterviewUpdateRawInput = z.input<
  typeof consultationInterviewUpdateSchema
>

/**
 * Admin list filter for the consultation calendar and pipeline board.
 *
 * Reachable over GET, so every bound coerces. `minCompatibilityScore` in
 * particular arrives from the board's score slider as `?minCompatibilityScore=70`
 * — the string `'70'`, which `percentSchema` is right to reject in a request body
 * and wrong to reject here. `withNumericCoercion` keeps `percentSchema`'s bounds
 * and its messages, and wrapping the `.optional()` from the outside is what makes
 * a rendered-but-empty `?minCompatibilityScore=` read as "no bound" rather than
 * as zero.
 */
export const consultationInterviewFilterSchema = paginationSchema.extend({
  clientProfileId: cuidSchema.optional(),
  conductedById: cuidSchema.optional(),
  staffProfileId: cuidSchema.optional(),
  outcome: consultationOutcomeSchema.optional(),
  scheduledFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
  scheduledUntil: withTemporalCoercion(isoDateTimeSchema.optional()),
  minCompatibilityScore: withNumericCoercion(percentSchema.optional()),
})
export type ConsultationInterviewFilter = z.infer<
  typeof consultationInterviewFilterSchema
>
export type ConsultationInterviewFilterInput = z.input<
  typeof consultationInterviewFilterSchema
>

// =============================================================================
// Prospect conversion
// =============================================================================

/**
 * The only two lifecycle states a prospect may be promoted into. Anything else —
 * pausing, churning — is a separate, deliberate action.
 */
export const PROSPECT_CONVERSION_STATUSES: readonly ClientStatus[] = [
  'LEAD_QUALIFIED',
  'ACTIVE_SUBSCRIBER',
]

/**
 * How a conversion may close the consultation. A decline or a no-show is
 * recorded on the interview itself with `consultationInterviewUpdateSchema` —
 * this payload only ever moves a household forward.
 */
export const PROSPECT_CONVERSION_OUTCOMES: readonly ConsultationOutcome[] = [
  'CONVERTED',
  'FOLLOW_UP_REQUIRED',
]

/** The onboarding stages a conversion may advance the flow to. */
export const PROSPECT_CONVERSION_STAGES: readonly OnboardingStage[] = [
  'CONSULTATION_COMPLETED',
  'PLAN_SELECTED',
  'PAYMENT_CONFIRMED',
  'FIRST_APPOINTMENT_BOOKED',
  'ACTIVATED',
]

/**
 * Turns a prospect into a client: closes the consultation, moves
 * `ClientProfile.status`, and advances `OnboardingFlow.currentStage`.
 *
 * The action performs all three inside one transaction so a half-converted
 * household can never exist.
 */
export const prospectConversionSchema = z
  .object({
    clientProfileId: cuidSchema,
    /** The consultation that closed the deal, when there was one. */
    consultationInterviewId: cuidSchema.optional(),
    status: clientStatusSchema.refine(
      (status) => PROSPECT_CONVERSION_STATUSES.includes(status),
      {
        error:
          'A prospect may be qualified or made an active subscriber — nothing else.',
      }
    ),
    outcome: consultationOutcomeSchema
      .refine((outcome) => PROSPECT_CONVERSION_OUTCOMES.includes(outcome), {
        error:
          'A conversion either wins the household or leaves a follow-up — record a decline on the consultation itself.',
      })
      .default('CONVERTED'),
    advanceOnboardingTo: onboardingStageSchema
      .refine((stage) => PROSPECT_CONVERSION_STAGES.includes(stage), {
        error: 'That stage is not one a conversion can move a household to.',
      })
      .optional(),
    /** Defaults to now in the action when the caller does not back-date it. */
    convertedAt: isoDateTimeSchema.optional(),
    followUpAt: isoDateTimeSchema.optional(),
    compatibilityScore: percentSchema.optional(),
    chefSummary: z
      .string({ error: 'Please summarise the fit for the chef.' })
      .trim()
      .max(MAX_NOTES_LENGTH, {
        error: `Please keep the summary to ${MAX_NOTES_LENGTH} characters or fewer.`,
      })
      .optional(),
    notes: z
      .string({ error: 'Please record why this household is joining us.' })
      .trim()
      .max(MAX_NOTES_LENGTH, {
        error: `Please keep the notes to ${MAX_NOTES_LENGTH} characters or fewer.`,
      })
      .optional(),
  })
  .strict()
  .check(
    crossField(
      {
        deps: ['convertedAt'],
        as: 'date',
        error: 'A household cannot have joined us at a moment still to come.',
        path: ['convertedAt'],
      },
      ({ convertedAt }) => convertedAt.getTime() <= Date.now()
    ),
    crossField(
      {
        deps: ['followUpAt'],
        as: 'date',
        error: 'A follow-up must be arranged for a moment still ahead of us.',
        path: ['followUpAt'],
      },
      ({ followUpAt }) => followUpAt.getTime() > Date.now()
    )
  )
  /** Presence-only from here down; see the note above `intakeHouseholdStepSchema`. */
  .refine(
    (value) =>
      value.outcome !== 'FOLLOW_UP_REQUIRED' || value.followUpAt !== undefined,
    { error: FOLLOW_UP_REQUIRED_ERROR, path: ['followUpAt'] }
  )
  .refine(
    (value) =>
      value.outcome !== 'FOLLOW_UP_REQUIRED' ||
      value.status === 'LEAD_QUALIFIED',
    {
      error:
        'A household we still owe a follow-up is qualified, not yet an active subscriber.',
      path: ['status'],
    }
  )
  .refine(
    (value) =>
      value.status !== 'ACTIVE_SUBSCRIBER' ||
      value.advanceOnboardingTo === undefined ||
      value.advanceOnboardingTo !== 'CONSULTATION_COMPLETED',
    {
      error:
        'An active subscriber has moved past the consultation — choose a later stage.',
      path: ['advanceOnboardingTo'],
    }
  )
export type ProspectConversionInput = z.infer<typeof prospectConversionSchema>
export type ProspectConversionRawInput = z.input<
  typeof prospectConversionSchema
>
