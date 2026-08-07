// mannachef/packages/validators/src/menu.ts

/**
 * Menu domain validation — categories, subcategories, dishes, tags, ingredients,
 * seasonality, gallery ordering, and bulk curation.
 *
 * Mirrors `MenuCategory`, `MenuSubcategory`, `MenuItem`, `Tag`, `MenuItemTag`,
 * `Ingredient`, `MenuItemIngredient` and `MenuItemMedia` in
 * `mannachef/packages/db/prisma/schema.prisma`.
 *
 * Rules that govern this file (see `mannachef/CONTRACT.md`):
 *
 *  1. No runtime dependency on `@prisma/client` — enum values arrive from
 *     `./enums`, which re-declares them as Zod enums.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *     `hasUniqueValues`, `withoutDefaults`, `hasSomethingToSave`,
 *     `NOTHING_TO_SAVE_MESSAGE`, `queryFlag`, `optionalProse` and
 *     `MAX_SEARCH_LENGTH` were all declared locally here — and in five sibling
 *     modules — until MCV-004 gave each of them a single home.
 *  3. Every constraint carries a human message. These strings are rendered
 *     verbatim beneath inputs in the admin OS and on the public menu — they must
 *     read like the brand wrote them.
 *  4. Filter bounds are read from a query string. Every numeric and temporal
 *     bound in an `xFilterSchema` therefore goes through the coercion helpers in
 *     `./common`; the create and update schemas stay strict, because a string
 *     where a number belongs in a request body is a bug in the caller rather
 *     than an artefact of the transport.
 */

import { z } from 'zod'

import {
  MAX_SEARCH_LENGTH,
  NOTHING_TO_SAVE_MESSAGE,
  cuidSchema,
  currencySchema,
  durationMinutesSchema,
  hasSomethingToSave,
  hasUniqueValues,
  moneyCentsSchema,
  optionalProse,
  paginationSchema,
  queryFlag,
  slugSchema,
  withNumericCoercion,
  withoutDefaults,
} from './common'
import { measurementUnitSchema, spiceLevelSchema, tagKindSchema } from './enums'

// =============================================================================
// Limits & shared vocabulary
// =============================================================================

/** Matches `MenuCategory.name` / `MenuItem.name` — `@db.VarChar(200)`. */
const MAX_NAME_LENGTH = 200

/** Matches `Tag.name` — `@db.VarChar(160)`. */
const MAX_TAG_NAME_LENGTH = 160

/** Matches `MenuCategory.tagline` and `MenuItemMedia.caption` — `@db.VarChar(280)`. */
const MAX_TAGLINE_LENGTH = 280

/** Matches `MenuItem.servingSize` — `@db.VarChar(120)`. */
const MAX_SERVING_SIZE_LENGTH = 120

/** Matches `MenuItemIngredient.preparation` — `@db.VarChar(200)`. */
const MAX_PREPARATION_LENGTH = 200

/** Generous ceiling for `@db.Text` prose so a paste-bomb cannot reach the database. */
const MAX_SHORT_PROSE_LENGTH = 2_000

/** Ceiling for the long-form narrative fields on a dish. */
const MAX_LONG_PROSE_LENGTH = 8_000

/** Highest manual sort position we accept. Comfortably beyond any real menu. */
const MAX_SORT_ORDER = 10_000

/** $250,000.00 — a guard rail against a mistyped price, not a business rule. */
export const MAX_MENU_PRICE_CENTS = 25_000_000

/** `MenuItemIngredient.quantity` is `@db.Decimal(10, 3)`. */
export const MAX_INGREDIENT_QUANTITY = 9_999_999.999

/** Decimal places permitted by `@db.Decimal(10, 3)`. */
const INGREDIENT_QUANTITY_DECIMAL_PLACES = 3

/** How many images a single dish gallery may hold. */
export const MAX_MENU_ITEM_MEDIA = 24

/** How many ingredients a single recipe may list. */
export const MAX_MENU_ITEM_INGREDIENTS = 60

/** How many tags may be pinned to a single dish. */
export const MAX_MENU_ITEM_TAGS = 24

/** How many dishes one bulk action may touch. */
export const MAX_BULK_MENU_ITEMS = 100

/** How many tag handles a single filter may combine. */
const MAX_FILTER_TAGS = 20

/**
 * The MannaChef palette, per `mannachef/CONTRACT.md` §3.
 *
 * `Tag.colorToken` stores a token name rather than a hex value so a tag chip can
 * never introduce a colour that lives outside the design system.
 */
export const DESIGN_COLOR_TOKENS = [
  'obsidian',
  'charcoal',
  'slate-warm',
  'ash',
  'linen',
  'parchment',
  'stone',
  'champagne',
  'gold',
  'terracotta',
  'sage',
  'claret',
] as const

export type DesignColorToken = (typeof DESIGN_COLOR_TOKENS)[number]

// =============================================================================
// Local helpers
// =============================================================================

/**
 * What follows is genuinely local to the menu: the seasonality rules, and the
 * handful of field schemas no other domain has a use for. Everything that was
 * merely copy-pasted now lives in `./common` (see the file docblock above).
 */

/** Free-text search across the menu. Blank input is treated as "no filter". */
const menuSearchSchema = z
  .string({ error: 'Please type something to search the menu for.' })
  .trim()
  .max(MAX_SEARCH_LENGTH, {
    error: 'Please shorten your search to 120 characters or fewer.',
  })
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional()

/** A manual position within a curated list. */
export const sortOrderSchema = z
  .int({ error: 'Please give a whole number for the running order.' })
  .min(0, { error: 'The running order begins at zero.' })
  .max(MAX_SORT_ORDER, {
    error: 'That position sits far beyond the end of the menu.',
  })
export type SortOrder = z.infer<typeof sortOrderSchema>

/** A calendar month, 1 (January) through 12 (December). */
export const seasonMonthSchema = z
  .int({ error: 'Please choose a month of the year.' })
  .min(1, { error: 'Months run from January (1) through December (12).' })
  .max(12, { error: 'Months run from January (1) through December (12).' })
export type SeasonMonth = z.infer<typeof seasonMonthSchema>

/**
 * The shape the seasonality refinements inspect. Written structurally so the
 * same rules can guard the create form, the partial update, and the dedicated
 * seasonal toggle without being written three times.
 */
type SeasonalWindow = {
  isSeasonal?: boolean | undefined
  seasonStart?: number | null | undefined
  seasonEnd?: number | null | undefined
}

/** A seasonal dish must declare both ends of its window. */
function seasonalWindowIsComplete(value: SeasonalWindow): boolean {
  if (value.isSeasonal !== true) {
    return true
  }

  return value.seasonStart != null && value.seasonEnd != null
}

/**
 * A dish that is not seasonal must not carry a window, and a half-declared
 * window (a first month with no last month) is always a mistake.
 */
function seasonalWindowIsConsistent(value: SeasonalWindow): boolean {
  const hasStart = value.seasonStart != null
  const hasEnd = value.seasonEnd != null

  if (value.isSeasonal === false) {
    return !hasStart && !hasEnd
  }

  if (value.isSeasonal === undefined) {
    return hasStart === hasEnd
  }

  return true
}

const SEASON_INCOMPLETE_MESSAGE =
  'A seasonal dish needs both a first month and a last month on the menu.'

const SEASON_INCONSISTENT_MESSAGE =
  'Either mark this dish as seasonal, or clear its months from the calendar.'

// =============================================================================
// Shared field schemas
// =============================================================================

/**
 * A short single-line field that may be cleared by sending `null`.
 *
 * The same construction as `optionalProse` from `./common`; the separate name
 * records at the call site that the column behind it is a `VarChar`, not a
 * `Text`.
 */
function optionalLine(maxLength: number, tooLongMessage: string) {
  return optionalProse(maxLength, tooLongMessage)
}

/**
 * A reference to a `MediaAsset`, which may be detached by sending `null`.
 * Ownership of the referenced asset is re-checked server-side.
 */
const optionalMediaIdSchema = cuidSchema.nullable().optional()

// =============================================================================
// Menu categories
// =============================================================================

const menuCategoryBaseSchema = z
  .object({
    slug: slugSchema,
    name: z
      .string({ error: 'Every collection needs a name.' })
      .trim()
      .min(2, { error: 'A collection name needs at least two characters.' })
      .max(MAX_NAME_LENGTH, {
        error: 'Please keep the collection name to 200 characters or fewer.',
      }),
    tagline: optionalLine(
      MAX_TAGLINE_LENGTH,
      'A tagline is at its best under 280 characters.'
    ),
    description: optionalProse(
      MAX_LONG_PROSE_LENGTH,
      'This description is longer than our pages can carry gracefully.'
    ),
    sortOrder: sortOrderSchema.default(0),
    isActive: z
      .boolean({ error: 'Please say whether this collection is published.' })
      .default(true),
    heroMediaId: optionalMediaIdSchema,
  })
  .strict()

export const menuCategoryCreateSchema = menuCategoryBaseSchema
export type MenuCategoryCreateInput = z.infer<typeof menuCategoryCreateSchema>
export type MenuCategoryCreateRawInput = z.input<
  typeof menuCategoryCreateSchema
>

export const menuCategoryUpdateSchema = z
  .object(withoutDefaults(menuCategoryBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
export type MenuCategoryUpdateInput = z.infer<typeof menuCategoryUpdateSchema>
export type MenuCategoryUpdateRawInput = z.input<
  typeof menuCategoryUpdateSchema
>

export const menuCategoryFilterSchema = paginationSchema.extend({
  search: menuSearchSchema,
  /**
   * Admin-only. A server action must confirm the caller is at least
   * `CHEF_STAFF` before honouring this — see `mannachef/CONTRACT.md` §5.
   */
  includeInactive: queryFlag(
    false,
    'Please say whether unpublished collections should be included.'
  ),
  sortBy: z
    .enum(['CURATED', 'NAME', 'CREATED', 'UPDATED'], {
      error: 'Please choose how the collections should be ordered.',
    })
    .default('CURATED'),
})
export type MenuCategoryFilterInput = z.infer<typeof menuCategoryFilterSchema>
export type MenuCategoryFilterRawInput = z.input<
  typeof menuCategoryFilterSchema
>

// =============================================================================
// Menu subcategories
// =============================================================================

const menuSubcategoryBaseSchema = z
  .object({
    categoryId: cuidSchema,
    slug: slugSchema,
    name: z
      .string({ error: 'Every course needs a name.' })
      .trim()
      .min(2, { error: 'A course name needs at least two characters.' })
      .max(MAX_NAME_LENGTH, {
        error: 'Please keep the course name to 200 characters or fewer.',
      }),
    description: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'This description is longer than our pages can carry gracefully.'
    ),
    sortOrder: sortOrderSchema.default(0),
    isActive: z
      .boolean({ error: 'Please say whether this course is published.' })
      .default(true),
  })
  .strict()

export const menuSubcategoryCreateSchema = menuSubcategoryBaseSchema
export type MenuSubcategoryCreateInput = z.infer<
  typeof menuSubcategoryCreateSchema
>
export type MenuSubcategoryCreateRawInput = z.input<
  typeof menuSubcategoryCreateSchema
>

export const menuSubcategoryUpdateSchema = z
  .object(withoutDefaults(menuSubcategoryBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
export type MenuSubcategoryUpdateInput = z.infer<
  typeof menuSubcategoryUpdateSchema
>
export type MenuSubcategoryUpdateRawInput = z.input<
  typeof menuSubcategoryUpdateSchema
>

export const menuSubcategoryFilterSchema = paginationSchema.extend({
  search: menuSearchSchema,
  categoryId: cuidSchema.optional(),
  categorySlug: slugSchema.optional(),
  /** Admin-only. Verify the caller's role before honouring this. */
  includeInactive: queryFlag(
    false,
    'Please say whether unpublished courses should be included.'
  ),
  sortBy: z
    .enum(['CURATED', 'NAME', 'CREATED', 'UPDATED'], {
      error: 'Please choose how the courses should be ordered.',
    })
    .default('CURATED'),
})
export type MenuSubcategoryFilterInput = z.infer<
  typeof menuSubcategoryFilterSchema
>
export type MenuSubcategoryFilterRawInput = z.input<
  typeof menuSubcategoryFilterSchema
>

// =============================================================================
// Menu items
// =============================================================================

const menuItemBaseSchema = z
  .object({
    slug: slugSchema,
    categoryId: cuidSchema,
    subcategoryId: cuidSchema.nullable().optional(),

    name: z
      .string({ error: 'Every dish needs a name.' })
      .trim()
      .min(2, { error: 'A dish name needs at least two characters.' })
      .max(MAX_NAME_LENGTH, {
        error: 'Please keep the dish name to 200 characters or fewer.',
      }),
    description: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'This description is longer than a menu card can hold — please trim it.'
    ),
    story: optionalProse(
      MAX_LONG_PROSE_LENGTH,
      'This story runs longer than the dish page can carry. Please trim it.'
    ),
    tastingNote: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'Please keep the tasting note to 2,000 characters or fewer.'
    ),
    pairingNote: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'Please keep the pairing note to 2,000 characters or fewer.'
    ),
    chefNote: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      "Please keep the chef's note to 2,000 characters or fewer."
    ),

    basePriceCents: moneyCentsSchema.max(MAX_MENU_PRICE_CENTS, {
      error: 'That price looks higher than intended. Please check the amount.',
    }),
    currency: currencySchema,

    servingSize: optionalLine(
      MAX_SERVING_SIZE_LENGTH,
      'Please describe the serving in 120 characters or fewer.'
    ),
    servingsPerUnit: z
      .int({ error: 'Please give the number of servings as a whole number.' })
      .min(1, { error: 'A dish serves at least one guest.' })
      .max(64, { error: 'Please divide larger formats into separate dishes.' })
      .nullable()
      .optional(),
    prepTimeMinutes: durationMinutesSchema.nullable().optional(),
    cookTimeMinutes: durationMinutesSchema.nullable().optional(),

    calories: z
      .int({ error: 'Please give calories as a whole number.' })
      .min(0, { error: 'Calories cannot fall below zero.' })
      .max(20_000, { error: 'That calorie count looks higher than intended.' })
      .nullable()
      .optional(),
    proteinGram: z
      .int({ error: 'Please give protein in whole grams.' })
      .min(0, { error: 'Protein cannot fall below zero grams.' })
      .max(2_000, { error: 'That protein figure looks higher than intended.' })
      .nullable()
      .optional(),
    carbGram: z
      .int({ error: 'Please give carbohydrates in whole grams.' })
      .min(0, { error: 'Carbohydrates cannot fall below zero grams.' })
      .max(2_000, {
        error: 'That carbohydrate figure looks higher than intended.',
      })
      .nullable()
      .optional(),
    fatGram: z
      .int({ error: 'Please give fat in whole grams.' })
      .min(0, { error: 'Fat cannot fall below zero grams.' })
      .max(2_000, { error: 'That fat figure looks higher than intended.' })
      .nullable()
      .optional(),

    spiceLevel: spiceLevelSchema.default('NONE'),

    isSeasonal: z
      .boolean({ error: 'Please say whether this dish follows the seasons.' })
      .default(false),
    /** 1–12 inclusive. A window may wrap the new year, so `start > end` is valid. */
    seasonStart: seasonMonthSchema.nullable().optional(),
    seasonEnd: seasonMonthSchema.nullable().optional(),

    isActive: z
      .boolean({ error: 'Please say whether this dish is on the menu.' })
      .default(true),
    isSignature: z
      .boolean({ error: 'Please say whether this is a signature dish.' })
      .default(false),
    sortOrder: sortOrderSchema.default(0),
  })
  .strict()

export const menuItemCreateSchema = menuItemBaseSchema
  .refine(seasonalWindowIsComplete, {
    error: SEASON_INCOMPLETE_MESSAGE,
    path: ['seasonStart'],
  })
  .refine(seasonalWindowIsConsistent, {
    error: SEASON_INCONSISTENT_MESSAGE,
    path: ['seasonStart'],
  })
export type MenuItemCreateInput = z.infer<typeof menuItemCreateSchema>
export type MenuItemCreateRawInput = z.input<typeof menuItemCreateSchema>

export const menuItemUpdateSchema = z
  .object(withoutDefaults(menuItemBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
  .refine(seasonalWindowIsComplete, {
    error: SEASON_INCOMPLETE_MESSAGE,
    path: ['seasonStart'],
  })
  .refine(seasonalWindowIsConsistent, {
    error: SEASON_INCONSISTENT_MESSAGE,
    path: ['seasonStart'],
  })
export type MenuItemUpdateInput = z.infer<typeof menuItemUpdateSchema>
export type MenuItemUpdateRawInput = z.input<typeof menuItemUpdateSchema>

/**
 * How a list of dishes is ordered. The direction itself comes from
 * `paginationSchema.sortDirection`, so `CREATED` + `desc` is "newest first".
 */
export const menuItemSortBySchema = z
  .enum(['CURATED', 'NAME', 'PRICE', 'CREATED', 'UPDATED', 'SIGNATURE'], {
    error: 'Please choose how the menu should be ordered.',
  })
  .default('CURATED')
export type MenuItemSortBy = z.infer<typeof menuItemSortBySchema>

/**
 * Whether a dish must carry **every** selected tag or merely **one** of them.
 * `ALL` is the honest default for dietary work: a guest who filters for
 * vegetarian *and* nut-free must not be shown a dish that is only one of the two.
 */
export const tagMatchModeSchema = z
  .enum(['ALL', 'ANY'], {
    error: 'Please choose whether dishes must match every tag or any of them.',
  })
  .default('ALL')
export type TagMatchMode = z.infer<typeof tagMatchModeSchema>

export const menuItemFilterSchema = paginationSchema
  .extend({
    search: menuSearchSchema,
    categorySlug: slugSchema.optional(),
    subcategorySlug: slugSchema.optional(),
    tagSlugs: z
      .array(slugSchema, {
        error: 'Please choose tags from the list.',
      })
      .max(MAX_FILTER_TAGS, {
        error: 'Please narrow your search to twenty tags or fewer.',
      })
      .refine(hasUniqueValues, {
        error: 'That tag is already part of your search.',
      })
      .default([]),
    /** Applies to `tagSlugs`: match every tag (`ALL`) or any of them (`ANY`). */
    tagMatchMode: tagMatchModeSchema,
    /**
     * A GET filter bound, so it is wrapped in the query-string coercion from
     * `./common`: `?priceCentsMin=1500` arrives as the string `"1500"` and must
     * parse, while a JSON body carrying a real `1500` is held to the very same
     * bounds and reports the very same messages.
     *
     * The `.optional()` sits *inside* the coercion deliberately. Wrapped the
     * other way round, a rendered-but-empty `?priceCentsMin=` is the string
     * `''`, which sails past `z.ZodOptional` and is then rejected by the integer
     * schema; inside, it is read as "no filter" and becomes `undefined`.
     */
    priceCentsMin: withNumericCoercion(
      moneyCentsSchema
        .max(MAX_MENU_PRICE_CENTS, {
          error: 'That lower price looks higher than intended.',
        })
        .optional()
    ),
    priceCentsMax: withNumericCoercion(
      moneyCentsSchema
        .max(MAX_MENU_PRICE_CENTS, {
          error: 'That upper price looks higher than intended.',
        })
        .optional()
    ),
    seasonalOnly: queryFlag(
      false,
      'Please say whether to show only dishes in season.'
    ),
    signatureOnly: queryFlag(
      false,
      'Please say whether to show only signature dishes.'
    ),
    /**
     * Admin-only. A server action must confirm the caller is at least
     * `CHEF_STAFF` before honouring this — a guest may never see a dish that has
     * been taken off the menu. See `mannachef/CONTRACT.md` §5.
     */
    includeInactive: queryFlag(
      false,
      'Please say whether dishes that are off the menu should be included.'
    ),
    sortBy: menuItemSortBySchema,
  })
  .refine(
    ({ priceCentsMin, priceCentsMax }) =>
      priceCentsMin === undefined ||
      priceCentsMax === undefined ||
      priceCentsMin <= priceCentsMax,
    {
      error: 'The lowest price must sit at or below the highest.',
      path: ['priceCentsMax'],
    }
  )
export type MenuItemFilterInput = z.infer<typeof menuItemFilterSchema>
export type MenuItemFilterRawInput = z.input<typeof menuItemFilterSchema>

// =============================================================================
// Seasonality
// =============================================================================

/**
 * The dedicated seasonal toggle used by the dish list and the dish header.
 *
 * A window may wrap the turn of the year — `seasonStart: 11, seasonEnd: 2` reads
 * as November through February — so the months are deliberately not compared.
 *
 * The parsed payload always names both months, `null` when the dish has been
 * taken off the seasonal calendar, so switching seasonality off can never leave
 * a stale window behind in the database.
 */
export const menuItemSeasonalToggleSchema = z
  .object({
    id: cuidSchema,
    isSeasonal: z.boolean({
      error: 'Please say whether this dish follows the seasons.',
    }),
    seasonStart: seasonMonthSchema.nullable().optional(),
    seasonEnd: seasonMonthSchema.nullable().optional(),
  })
  .strict()
  .refine(seasonalWindowIsComplete, {
    error: SEASON_INCOMPLETE_MESSAGE,
    path: ['seasonStart'],
  })
  .refine(seasonalWindowIsConsistent, {
    error: SEASON_INCONSISTENT_MESSAGE,
    path: ['seasonStart'],
  })
  .transform(({ id, isSeasonal, seasonStart, seasonEnd }) => ({
    id,
    isSeasonal,
    seasonStart: isSeasonal ? (seasonStart ?? null) : null,
    seasonEnd: isSeasonal ? (seasonEnd ?? null) : null,
  }))
export type MenuItemSeasonalToggleInput = z.infer<
  typeof menuItemSeasonalToggleSchema
>
export type MenuItemSeasonalToggleRawInput = z.input<
  typeof menuItemSeasonalToggleSchema
>

// =============================================================================
// Tags
// =============================================================================

/**
 * A palette token from the design system. A leading `--color-` is accepted and
 * stripped, so both `champagne` and `--color-champagne` resolve to `champagne`.
 */
export const designColorTokenSchema = z
  .string({ error: 'Please choose a colour from the MannaChef palette.' })
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^--color-/, ''))
  .pipe(
    z.enum(DESIGN_COLOR_TOKENS, {
      error:
        'Please choose a colour from the MannaChef palette — champagne, gold, sage, terracotta, claret, parchment, stone, linen, ash, slate-warm, charcoal or obsidian.',
    })
  )
export type DesignColorTokenInput = z.infer<typeof designColorTokenSchema>

const tagBaseSchema = z
  .object({
    slug: slugSchema,
    name: z
      .string({ error: 'Every tag needs a name.' })
      .trim()
      .min(2, { error: 'A tag name needs at least two characters.' })
      .max(MAX_TAG_NAME_LENGTH, {
        error: 'Please keep the tag name to 160 characters or fewer.',
      }),
    kind: tagKindSchema,
    description: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'Please keep the tag description to 2,000 characters or fewer.'
    ),
    colorToken: designColorTokenSchema.nullable().optional(),
    sortOrder: sortOrderSchema.default(0),
    isActive: z
      .boolean({ error: 'Please say whether this tag is in use.' })
      .default(true),
  })
  .strict()

export const tagCreateSchema = tagBaseSchema
export type TagCreateInput = z.infer<typeof tagCreateSchema>
export type TagCreateRawInput = z.input<typeof tagCreateSchema>

export const tagUpdateSchema = z
  .object(withoutDefaults(tagBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>
export type TagUpdateRawInput = z.input<typeof tagUpdateSchema>

export const tagFilterSchema = paginationSchema.extend({
  search: menuSearchSchema,
  kinds: z
    .array(tagKindSchema, { error: 'Please choose tag kinds from the list.' })
    .max(5, { error: 'There are only five kinds of tag to choose from.' })
    .refine(hasUniqueValues, {
      error: 'That kind of tag is already part of your search.',
    })
    .default([]),
  /** Admin-only. Verify the caller's role before honouring this. */
  includeInactive: queryFlag(
    false,
    'Please say whether retired tags should be included.'
  ),
  sortBy: z
    .enum(['CURATED', 'NAME', 'KIND', 'CREATED', 'USAGE'], {
      error: 'Please choose how the tags should be ordered.',
    })
    .default('CURATED'),
})
export type TagFilterInput = z.infer<typeof tagFilterSchema>
export type TagFilterRawInput = z.input<typeof tagFilterSchema>

/**
 * Replaces the full set of tags on a dish (`MenuItemTag`). An empty list is
 * meaningful: it strips every tag from the dish.
 */
export const menuItemTagAssignmentSchema = z
  .object({
    menuItemId: cuidSchema,
    tagIds: z
      .array(cuidSchema, { error: 'Please choose tags from the list.' })
      .max(MAX_MENU_ITEM_TAGS, {
        error: 'A dish reads best with twenty-four tags or fewer.',
      })
      .refine(hasUniqueValues, {
        error: 'That tag has already been added to this dish.',
      }),
  })
  .strict()
export type MenuItemTagAssignmentInput = z.infer<
  typeof menuItemTagAssignmentSchema
>
export type MenuItemTagAssignmentRawInput = z.input<
  typeof menuItemTagAssignmentSchema
>

// =============================================================================
// Ingredients
// =============================================================================

const ingredientBaseSchema = z
  .object({
    slug: slugSchema,
    name: z
      .string({ error: 'Every ingredient needs a name.' })
      .trim()
      .min(2, { error: 'An ingredient name needs at least two characters.' })
      .max(MAX_NAME_LENGTH, {
        error: 'Please keep the ingredient name to 200 characters or fewer.',
      }),
    description: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'Please keep the ingredient description to 2,000 characters or fewer.'
    ),
    sourcingNote: optionalProse(
      MAX_SHORT_PROSE_LENGTH,
      'Please keep the sourcing note to 2,000 characters or fewer.'
    ),
    isAllergen: z
      .boolean({
        error: 'Please say whether this ingredient is a common allergen.',
      })
      .default(false),
    isActive: z
      .boolean({ error: 'Please say whether this ingredient is in use.' })
      .default(true),
    defaultUnit: measurementUnitSchema.default('GRAM'),
    unitCostCents: moneyCentsSchema
      .max(MAX_MENU_PRICE_CENTS, {
        error: 'That unit cost looks higher than intended.',
      })
      .nullable()
      .optional(),
    currency: currencySchema,
  })
  .strict()

export const ingredientCreateSchema = ingredientBaseSchema
export type IngredientCreateInput = z.infer<typeof ingredientCreateSchema>
export type IngredientCreateRawInput = z.input<typeof ingredientCreateSchema>

export const ingredientUpdateSchema = z
  .object(withoutDefaults(ingredientBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
export type IngredientUpdateInput = z.infer<typeof ingredientUpdateSchema>
export type IngredientUpdateRawInput = z.input<typeof ingredientUpdateSchema>

export const ingredientFilterSchema = paginationSchema.extend({
  search: menuSearchSchema,
  allergensOnly: queryFlag(false, 'Please say whether to show only allergens.'),
  units: z
    .array(measurementUnitSchema, {
      error: 'Please choose units of measure from the list.',
    })
    .max(15, { error: 'There are only fifteen units to choose from.' })
    .refine(hasUniqueValues, {
      error: 'That unit is already part of your search.',
    })
    .default([]),
  /** Admin-only. Verify the caller's role before honouring this. */
  includeInactive: queryFlag(
    false,
    'Please say whether retired ingredients should be included.'
  ),
  sortBy: z
    .enum(['NAME', 'CREATED', 'UPDATED', 'COST', 'USAGE'], {
      error: 'Please choose how the pantry should be ordered.',
    })
    .default('NAME'),
})
export type IngredientFilterInput = z.infer<typeof ingredientFilterSchema>
export type IngredientFilterRawInput = z.input<typeof ingredientFilterSchema>

/**
 * A quantity on a recipe line. Stored as `@db.Decimal(10, 3)`, so three decimal
 * places is the limit. Coerced because a number input hands us a string.
 */
export const ingredientQuantitySchema = z.coerce
  .number({ error: 'Please give a quantity for this ingredient.' })
  .gt(0, { error: 'A quantity needs to be greater than nothing.' })
  .max(MAX_INGREDIENT_QUANTITY, {
    error: 'That quantity is larger than a single recipe can hold.',
  })
  .refine((value) => Number.isFinite(value), {
    error: 'Please give the quantity as a number.',
  })
  .refine(
    (value) => {
      const decimals = value.toString().split('.')[1]
      return (decimals?.length ?? 0) <= INGREDIENT_QUANTITY_DECIMAL_PLACES
    },
    {
      error: 'Please round the quantity to three decimal places.',
    }
  )
export type IngredientQuantity = z.infer<typeof ingredientQuantitySchema>

const menuItemIngredientEntryBaseSchema = z
  .object({
    ingredientId: cuidSchema,
    quantity: ingredientQuantitySchema,
    unit: measurementUnitSchema.default('GRAM'),
    preparation: optionalLine(
      MAX_PREPARATION_LENGTH,
      'Please keep the preparation note to 200 characters or fewer — for example, finely chopped.'
    ),
    isOptional: z
      .boolean({ error: 'Please say whether this ingredient is optional.' })
      .default(false),
    isGarnish: z
      .boolean({ error: 'Please say whether this ingredient is a garnish.' })
      .default(false),
    sortOrder: sortOrderSchema.default(0),
  })
  .strict()

/** A single recipe line, attached to a dish. */
export const menuItemIngredientCreateSchema = menuItemIngredientEntryBaseSchema
  .extend({ menuItemId: cuidSchema })
  .strict()
export type MenuItemIngredientCreateInput = z.infer<
  typeof menuItemIngredientCreateSchema
>
export type MenuItemIngredientCreateRawInput = z.input<
  typeof menuItemIngredientCreateSchema
>

export const menuItemIngredientUpdateSchema = z
  .object(withoutDefaults(menuItemIngredientEntryBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
export type MenuItemIngredientUpdateInput = z.infer<
  typeof menuItemIngredientUpdateSchema
>
export type MenuItemIngredientUpdateRawInput = z.input<
  typeof menuItemIngredientUpdateSchema
>

/**
 * Replaces a dish's entire recipe in one call. The array order is the order the
 * ingredients are read in; `sortOrder` is filled from the position of each line
 * when it is not given explicitly.
 */
export const menuItemIngredientSetSchema = z
  .object({
    menuItemId: cuidSchema,
    ingredients: z
      .array(
        menuItemIngredientEntryBaseSchema.extend({
          sortOrder: sortOrderSchema.optional(),
        }),
        { error: 'Please list the ingredients for this dish.' }
      )
      .max(MAX_MENU_ITEM_INGREDIENTS, {
        error: 'A single recipe may list up to sixty ingredients.',
      }),
  })
  .strict()
  .refine(
    ({ ingredients }) =>
      hasUniqueValues(ingredients.map((entry) => entry.ingredientId)),
    {
      error:
        'That ingredient is already in this recipe — adjust its quantity instead of listing it twice.',
      path: ['ingredients'],
    }
  )
  .transform(({ menuItemId, ingredients }) => ({
    menuItemId,
    ingredients: ingredients.map((entry, index) => ({
      ...entry,
      sortOrder: entry.sortOrder ?? index,
    })),
  }))
export type MenuItemIngredientSetInput = z.infer<
  typeof menuItemIngredientSetSchema
>
export type MenuItemIngredientSetRawInput = z.input<
  typeof menuItemIngredientSetSchema
>

// =============================================================================
// Gallery — media association
// =============================================================================

const menuItemMediaEntrySchema = z
  .object({
    mediaAssetId: cuidSchema,
    /** Filled from the position in the array when omitted. */
    sortOrder: sortOrderSchema.optional(),
    isPrimary: z
      .boolean({ error: 'Please say whether this is the lead photograph.' })
      .default(false),
    caption: optionalLine(
      MAX_TAGLINE_LENGTH,
      'Please keep the caption to 280 characters or fewer.'
    ),
  })
  .strict()
export type MenuItemMediaEntryInput = z.infer<typeof menuItemMediaEntrySchema>
export type MenuItemMediaEntryRawInput = z.input<
  typeof menuItemMediaEntrySchema
>

/**
 * Sets the full gallery for a dish, in order, with exactly one lead image.
 *
 * The array position is the running order. `sortOrder` may be given explicitly —
 * for a drag-and-drop reorder that already knows its indices — and is otherwise
 * derived from the position, so the payload is always unambiguous by the time it
 * reaches Prisma.
 */
export const menuItemMediaAssociationSchema = z
  .object({
    menuItemId: cuidSchema,
    media: z
      .array(menuItemMediaEntrySchema, {
        error: 'Please choose the photographs for this dish.',
      })
      .min(1, {
        error:
          'A dish needs at least one photograph before it can be published.',
      })
      .max(MAX_MENU_ITEM_MEDIA, {
        error: 'A gallery holds up to twenty-four photographs.',
      }),
  })
  .strict()
  .refine(
    ({ media }) => hasUniqueValues(media.map((entry) => entry.mediaAssetId)),
    {
      error: 'That photograph already appears in this gallery.',
      path: ['media'],
    }
  )
  .refine(
    ({ media }) => media.filter((entry) => entry.isPrimary).length === 1,
    {
      error:
        'Choose exactly one lead photograph — it is the image the dish is remembered by.',
      path: ['media'],
    }
  )
  .refine(
    ({ media }) => {
      const declared = media
        .map((entry) => entry.sortOrder)
        .filter((value): value is number => value !== undefined)
      return hasUniqueValues(declared)
    },
    {
      error: 'Two photographs cannot share the same position in the gallery.',
      path: ['media'],
    }
  )
  .transform(({ menuItemId, media }) => ({
    menuItemId,
    media: media.map((entry, index) => ({
      ...entry,
      sortOrder: entry.sortOrder ?? index,
    })),
  }))
export type MenuItemMediaAssociationInput = z.infer<
  typeof menuItemMediaAssociationSchema
>
export type MenuItemMediaAssociationRawInput = z.input<
  typeof menuItemMediaAssociationSchema
>

// =============================================================================
// Bulk curation
// =============================================================================

/** The dishes a bulk action applies to. Re-checked server-side before it runs. */
export const menuItemIdsSchema = z
  .array(cuidSchema, { error: 'Please choose the dishes to act on.' })
  .min(1, { error: 'Choose at least one dish first.' })
  .max(MAX_BULK_MENU_ITEMS, {
    error: 'Please act on a hundred dishes at a time or fewer.',
  })
  .refine(hasUniqueValues, {
    error: 'That dish has already been chosen.',
  })
export type MenuItemIds = z.infer<typeof menuItemIdsSchema>

const bulkTagIdsSchema = z
  .array(cuidSchema, { error: 'Please choose the tags to apply.' })
  .min(1, { error: 'Choose at least one tag first.' })
  .max(MAX_MENU_ITEM_TAGS, {
    error: 'Please apply twenty-four tags at a time or fewer.',
  })
  .refine(hasUniqueValues, { error: 'That tag has already been chosen.' })

/**
 * Every bulk operation the menu list offers, as a discriminated union so each
 * action carries exactly the arguments it needs and nothing more.
 */
export const menuItemBulkActionSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('PUBLISH'),
        menuItemIds: menuItemIdsSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('UNPUBLISH'),
        menuItemIds: menuItemIdsSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('MARK_SIGNATURE'),
        menuItemIds: menuItemIdsSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('UNMARK_SIGNATURE'),
        menuItemIds: menuItemIdsSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('MOVE_TO_CATEGORY'),
        menuItemIds: menuItemIdsSchema,
        categoryId: cuidSchema,
        /** `null` detaches the dishes from any course within the collection. */
        subcategoryId: cuidSchema.nullable().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('ADD_TAGS'),
        menuItemIds: menuItemIdsSchema,
        tagIds: bulkTagIdsSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('REMOVE_TAGS'),
        menuItemIds: menuItemIdsSchema,
        tagIds: bulkTagIdsSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('SET_SPICE_LEVEL'),
        menuItemIds: menuItemIdsSchema,
        spiceLevel: spiceLevelSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('SET_SEASONAL'),
        menuItemIds: menuItemIdsSchema,
        isSeasonal: z.boolean({
          error: 'Please say whether these dishes follow the seasons.',
        }),
        seasonStart: seasonMonthSchema.nullable().optional(),
        seasonEnd: seasonMonthSchema.nullable().optional(),
      })
      .strict()
      .refine(seasonalWindowIsComplete, {
        error: SEASON_INCOMPLETE_MESSAGE,
        path: ['seasonStart'],
      })
      .refine(seasonalWindowIsConsistent, {
        error: SEASON_INCONSISTENT_MESSAGE,
        path: ['seasonStart'],
      }),
    z
      .object({
        action: z.literal('DELETE'),
        menuItemIds: menuItemIdsSchema,
        /**
         * Deleting a dish is irreversible and is blocked by referential
         * integrity wherever it appears on a past engagement, so the intent is
         * confirmed explicitly.
         */
        confirm: z.literal(true, {
          error:
            'Please confirm — removing a dish cannot be undone once it is gone.',
        }),
      })
      .strict(),
  ],
  { error: 'Please choose an action to apply to the selected dishes.' }
)
export type MenuItemBulkActionInput = z.infer<typeof menuItemBulkActionSchema>
export type MenuItemBulkActionRawInput = z.input<
  typeof menuItemBulkActionSchema
>

/** The discriminator values, handy for rendering the bulk-action menu. */
export const MENU_ITEM_BULK_ACTIONS = [
  'PUBLISH',
  'UNPUBLISH',
  'MARK_SIGNATURE',
  'UNMARK_SIGNATURE',
  'MOVE_TO_CATEGORY',
  'ADD_TAGS',
  'REMOVE_TAGS',
  'SET_SPICE_LEVEL',
  'SET_SEASONAL',
  'DELETE',
] as const

export type MenuItemBulkAction = (typeof MENU_ITEM_BULK_ACTIONS)[number]
