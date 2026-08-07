// mannachef/apps/web/src/server/actions/menu.ts

'use server'

/**
 * Menu domain Server Actions — the public catalogue and the curation OS behind
 * it.
 *
 * Every exported function in this module is produced by {@link withAction}, so
 * each one performs the six steps `mannachef/CONTRACT.md` §5 prescribes before
 * a single row is read or written: resolve the session, enforce the minimum
 * role, rate limit, `safeParse` the raw payload, run, translate anything thrown
 * into a guest-safe `ActionResult`, and revalidate on success only.
 *
 * ## Ownership in a domain that has no owners
 *
 * §5 step 4 asks for an ownership check "for anything scoped to a client". The
 * menu is deliberately *not* scoped to a client: a `MenuCategory`, a `MenuItem`,
 * a `Tag` and an `Ingredient` are one shared catalogue that every household sees
 * the same way. There is therefore no `require*Ownership` guard for any of them,
 * and inventing one would be theatre.
 *
 * What replaces it is threefold, and every write below does all three:
 *
 *  1. **Role.** Every mutation is `auth: 'ADMIN'`. Curation is not a
 *     `CHEF_STAFF` power — a chef reads the catalogue, an administrator shapes
 *     it.
 *  2. **Existence.** Every id that arrives from a browser is re-read from the
 *     database before it is used, including the ones inside a bulk payload. An
 *     id is a claim, never a fact, even when the caller is an administrator:
 *     a stale admin tab must produce `NOT_FOUND`, not a foreign-key error.
 *  3. **Projection.** Public reads select only the columns a guest may see. The
 *     `MenuItem.chefNote` column — the kitchen's private working note — is
 *     absent from every select in the public read path, which is enforced by the
 *     return types being `MenuItemSummary` / `MenuItemDetail` from
 *     `@mannachef/api-contract`: neither carries `chefNote`, so adding it to a
 *     select would fail to compile as an excess property. Reviews are filtered
 *     to the two published statuses, so a `PENDING` or `REJECTED` review — and
 *     `Review.moderationNote` with it — never leaves the server.
 *
 * ## Two privilege thresholds, and why they differ
 *
 *  - **`includeInactive` is `ADMIN` and above.** An unpublished dish is an
 *    editorial draft. A guest may never see one, and neither may a chef who is
 *    reading the catalogue to cook from it. A caller below `ADMIN` who passes
 *    the flag is *silently narrowed* rather than rejected: the flag is a
 *    view preference carried in a URL, and a stale bookmark should render the
 *    public menu, not an error page.
 *  - **Out-of-season dishes are visible from `CHEF_STAFF` and above.** The
 *    kitchen plans next season from this table; a guest browsing in January must
 *    not be offered July's heirloom tomatoes. This is the "respects seasonality"
 *    half of the public query.
 *
 * Both thresholds narrow silently and neither ever widens. That is the single
 * rule this module follows for every privileged filter: a filter the caller may
 * not use is dropped, never honoured and never turned into a `FORBIDDEN` that
 * would tell a stranger the privileged view exists.
 *
 * ## Seasonality across the turn of the year
 *
 * `MenuItem.seasonStart` and `MenuItem.seasonEnd` are months, 1–12, and the
 * window may wrap: `seasonStart: 11, seasonEnd: 2` reads as November through
 * February, and such a dish **is** in season in January. Expressing that in SQL
 * needs a column-to-column comparison (`seasonStart > seasonEnd`), which is
 * exactly what Prisma's field references provide — see {@link inSeasonFilter}.
 * The same rule is available to callers as a pure predicate,
 * {@link isMonthInSeason}, and the two are written to agree case for case.
 */

import { z } from 'zod'

import type {
  MediaSummary,
  MenuItemDetail,
  MenuItemIngredientView,
  MenuItemSummary,
  PageMeta,
} from '@mannachef/api-contract'
import { menuDetailInputSchema } from '@mannachef/api-contract'
import {
  cuidSchema,
  hasRoleAtLeast,
  hasUniqueValues,
  ingredientCreateSchema,
  ingredientFilterSchema,
  ingredientUpdateSchema,
  menuCategoryCreateSchema,
  menuCategoryFilterSchema,
  menuCategoryUpdateSchema,
  menuItemBulkActionSchema,
  menuItemCreateSchema,
  menuItemFilterSchema,
  menuItemIngredientSetSchema,
  menuItemMediaAssociationSchema,
  menuItemSeasonalToggleSchema,
  menuItemTagAssignmentSchema,
  menuItemUpdateSchema,
  menuSubcategoryCreateSchema,
  menuSubcategoryFilterSchema,
  menuSubcategoryUpdateSchema,
  paginationToSkipTake,
  sortOrderSchema,
  tagCreateSchema,
  tagFilterSchema,
  tagUpdateSchema,
  type MeasurementUnit,
  type MediaKind,
  type MenuItemBulkAction,
  type MenuItemSortBy,
  type Role,
  type SortDirection,
  type TagKind,
} from '@mannachef/validators'

import {
  ActionError,
  fail,
  ok,
  type ActionResult,
} from '@/server/actions/types'
import { Prisma, prisma } from '@/server/db'
import { withAction, type RevalidatePathTarget } from '@/server/guards'

// =============================================================================
// 0. Cache invalidation targets
// =============================================================================

/**
 * Everything a catalogue mutation invalidates.
 *
 * The marketing menu, every dish page, the home page (which carries the
 * signature dishes), and the admin table. `'/menu/[slug]'` is passed in the
 * object form because a dynamic segment needs Next's `'page'` selector to
 * expand across every rendered slug.
 */
const MENU_REVALIDATE_PATHS: readonly RevalidatePathTarget[] = [
  '/',
  '/menu',
  { path: '/menu/[slug]', type: 'page' },
  '/admin/menu',
]

/**
 * Read-your-own-writes for anything reading the catalogue through
 * `cacheTag('menu')`. The bare-string form calls `updateTag`, which expires
 * immediately — the admin table re-reads the row it just saved.
 */
const MENU_REVALIDATE_TAGS: readonly string[] = ['menu']

// =============================================================================
// 1. Seasonality
// =============================================================================

/**
 * The zone the seasons are read in.
 *
 * `MenuItem` has no time zone of its own, and the platform's own defaults —
 * `User.timeZone`, `StaffProfile.calendarTimeZone`, `ChefAvailability.timeZone`
 * — all say `America/Toronto`. Reading the month in UTC instead would put the
 * menu five hours ahead of the kitchen for the last evening of every month, so
 * on the 31st of October a Toronto guest would be shown November's dishes.
 */
const MENU_SEASON_TIME_ZONE = 'America/Toronto'

/**
 * The calendar month, 1–12, that "in season" is judged against.
 *
 * Falls back to the UTC month if the runtime was built without the IANA time
 * zone database, which is the only way `Intl` can fail here.
 */
function currentSeasonMonth(now: Date = new Date()): number {
  try {
    const rendered = new Intl.DateTimeFormat('en-CA', {
      timeZone: MENU_SEASON_TIME_ZONE,
      month: 'numeric',
    }).format(now)

    const month = Number.parseInt(rendered, 10)

    if (Number.isInteger(month) && month >= 1 && month <= 12) {
      return month
    }
  } catch {
    // A runtime with no time zone data. The UTC fallback below is correct to
    // within one day, which is the best available answer.
  }

  return now.getUTCMonth() + 1
}

/**
 * Is `month` inside the window `[seasonStart, seasonEnd]`?
 *
 * A window with either end missing is treated as "always", matching
 * {@link inSeasonFilter} and matching the schema, where an item that is not
 * seasonal carries no months at all.
 *
 * The wrapping case is the one worth stating plainly: when `seasonStart` is
 * greater than `seasonEnd` the window crosses the new year, so November (11)
 * through February (2) contains December, January **and** February, and
 * contains nothing between March and October.
 */
function isMonthInSeason(
  seasonStart: number | null,
  seasonEnd: number | null,
  month: number
): boolean {
  if (seasonStart === null || seasonEnd === null) {
    return true
  }

  if (seasonStart <= seasonEnd) {
    return month >= seasonStart && month <= seasonEnd
  }

  return month >= seasonStart || month <= seasonEnd
}

/**
 * The SQL half of {@link isMonthInSeason}: rows a guest may be shown in `month`.
 *
 * Four disjuncts, in the order they are written:
 *
 *  1. the dish does not follow the seasons at all;
 *  2. / 3. it is marked seasonal but has no complete window, which the Zod layer
 *     forbids on the way in and which older rows may still carry — such a dish
 *     stays on the menu rather than vanishing from it;
 *  4. a window inside one calendar year: `start <= month <= end`. No column
 *     comparison is needed, because those two bounds already imply
 *     `start <= end`;
 *  5. a window that wraps: `start > end`, and the month is at or after the start
 *     **or** at or before the end.
 *
 * The fifth is why `prisma.menuItem.fields.seasonEnd` appears here. Comparing
 * two columns of the same row is not expressible with a literal, and the
 * alternative — enumerating the twelve possible starts with their matching end
 * ranges — is the same predicate written twelve times.
 */
function inSeasonFilter(month: number): Prisma.MenuItemWhereInput {
  return {
    OR: [
      { isSeasonal: false },
      { seasonStart: null },
      { seasonEnd: null },
      { seasonStart: { lte: month }, seasonEnd: { gte: month } },
      {
        seasonStart: { gt: prisma.menuItem.fields.seasonEnd },
        OR: [{ seasonStart: { lte: month } }, { seasonEnd: { gte: month } }],
      },
    ],
  }
}

/**
 * The `seasonalOnly` filter: dishes that both follow the seasons **and** are in
 * season right now. Wrapping windows are handled exactly as above.
 */
function seasonalRightNowFilter(month: number): Prisma.MenuItemWhereInput {
  return {
    isSeasonal: true,
    AND: [
      { seasonStart: { not: null } },
      { seasonEnd: { not: null } },
      {
        OR: [
          { seasonStart: { lte: month }, seasonEnd: { gte: month } },
          {
            seasonStart: { gt: prisma.menuItem.fields.seasonEnd },
            OR: [
              { seasonStart: { lte: month } },
              { seasonEnd: { gte: month } },
            ],
          },
        ],
      },
    ],
  }
}

// =============================================================================
// 2. Projections
//
// Each select is built through `Prisma.validator`, which keeps the literal
// `true`s that Prisma's payload inference needs while still checking the object
// against the model's select type. A misspelled column is a compile error, and
// the row type is derived from the select rather than restated.
// =============================================================================

/** The two statuses a review has to reach before a guest may read it. */
const PUBLISHED_REVIEW_STATUSES = ['APPROVED', 'FEATURED'] as const

/** How many reviews the dish page carries before the "read more" fold. */
const MAX_DETAIL_REVIEWS = 20

const MEDIA_SUMMARY_SELECT = Prisma.validator<Prisma.MediaAssetSelect>()({
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
})

const TAG_SUMMARY_SELECT = Prisma.validator<Prisma.TagSelect>()({
  id: true,
  slug: true,
  name: true,
  kind: true,
  colorToken: true,
})

/**
 * A dish as a card.
 *
 * `tags` is filtered to active tags for every caller, including administrators:
 * `Tag.isActive === false` means the tag has been retired from the vocabulary,
 * and a retired tag is never rendered as a chip anywhere in the product.
 *
 * `media` takes one row, ordered so that the lead photograph wins and the first
 * of the running order stands in when no lead has been chosen.
 */
const MENU_ITEM_SUMMARY_SELECT = Prisma.validator<Prisma.MenuItemSelect>()({
  id: true,
  slug: true,
  name: true,
  description: true,
  categoryId: true,
  basePriceCents: true,
  currency: true,
  spiceLevel: true,
  isSeasonal: true,
  seasonStart: true,
  seasonEnd: true,
  isSignature: true,
  isActive: true,
  sortOrder: true,
  category: { select: { slug: true, name: true } },
  subcategory: { select: { slug: true } },
  tags: {
    where: { tag: { isActive: true } },
    orderBy: [{ tag: { sortOrder: 'asc' } }, { tag: { name: 'asc' } }],
    select: { tag: { select: TAG_SUMMARY_SELECT } },
  },
  media: {
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    take: 1,
    select: { mediaAsset: { select: MEDIA_SUMMARY_SELECT } },
  },
})

/**
 * A dish on its own page.
 *
 * `chefNote` is absent, and that absence is load-bearing: it is the kitchen's
 * private note on a dish, and this select is the public read path.
 */
const MENU_ITEM_DETAIL_SELECT = Prisma.validator<Prisma.MenuItemSelect>()({
  id: true,
  slug: true,
  name: true,
  description: true,
  story: true,
  tastingNote: true,
  pairingNote: true,
  categoryId: true,
  basePriceCents: true,
  currency: true,
  servingSize: true,
  servingsPerUnit: true,
  prepTimeMinutes: true,
  cookTimeMinutes: true,
  calories: true,
  proteinGram: true,
  carbGram: true,
  fatGram: true,
  spiceLevel: true,
  isSeasonal: true,
  seasonStart: true,
  seasonEnd: true,
  isSignature: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { slug: true, name: true, isActive: true } },
  subcategory: { select: { slug: true } },
  tags: {
    where: { tag: { isActive: true } },
    orderBy: [{ tag: { sortOrder: 'asc' } }, { tag: { name: 'asc' } }],
    select: { tag: { select: TAG_SUMMARY_SELECT } },
  },
  media: {
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    select: { mediaAsset: { select: MEDIA_SUMMARY_SELECT } },
  },
  ingredients: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      ingredientId: true,
      quantity: true,
      unit: true,
      preparation: true,
      isOptional: true,
      isGarnish: true,
      sortOrder: true,
      ingredient: { select: { slug: true, name: true, isAllergen: true } },
    },
  },
})

const MENU_CATEGORY_VIEW_SELECT = Prisma.validator<Prisma.MenuCategorySelect>()(
  {
    id: true,
    slug: true,
    name: true,
    tagline: true,
    description: true,
    sortOrder: true,
    isActive: true,
    heroMedia: { select: MEDIA_SUMMARY_SELECT },
  }
)

const MENU_SUBCATEGORY_VIEW_SELECT =
  Prisma.validator<Prisma.MenuSubcategorySelect>()({
    id: true,
    categoryId: true,
    slug: true,
    name: true,
    description: true,
    sortOrder: true,
    isActive: true,
    category: { select: { slug: true, name: true } },
  })

const TAG_VIEW_SELECT = Prisma.validator<Prisma.TagSelect>()({
  id: true,
  slug: true,
  name: true,
  kind: true,
  description: true,
  colorToken: true,
  sortOrder: true,
  isActive: true,
  _count: { select: { menuItems: true, media: true } },
})

const INGREDIENT_VIEW_SELECT = Prisma.validator<Prisma.IngredientSelect>()({
  id: true,
  slug: true,
  name: true,
  description: true,
  sourcingNote: true,
  isAllergen: true,
  isActive: true,
  defaultUnit: true,
  unitCostCents: true,
  currency: true,
  _count: { select: { menuItems: true } },
})

type MenuItemSummaryRow = Prisma.MenuItemGetPayload<{
  select: typeof MENU_ITEM_SUMMARY_SELECT
}>

type MenuItemDetailRow = Prisma.MenuItemGetPayload<{
  select: typeof MENU_ITEM_DETAIL_SELECT
}>

type MenuCategoryRow = Prisma.MenuCategoryGetPayload<{
  select: typeof MENU_CATEGORY_VIEW_SELECT
}>

type MenuSubcategoryRow = Prisma.MenuSubcategoryGetPayload<{
  select: typeof MENU_SUBCATEGORY_VIEW_SELECT
}>

type TagRow = Prisma.TagGetPayload<{ select: typeof TAG_VIEW_SELECT }>

type IngredientRow = Prisma.IngredientGetPayload<{
  select: typeof INGREDIENT_VIEW_SELECT
}>

// =============================================================================
// 3. Return shapes
// =============================================================================

/** A page of dishes, shaped exactly like `paginated(menuItemSummarySchema)`. */
export interface MenuItemListView {
  readonly items: readonly MenuItemSummary[]
  readonly meta: PageMeta
}

/** One published review, as it appears beneath a dish. */
export interface MenuItemReviewView {
  readonly id: string
  readonly rating: number
  readonly title: string | null
  readonly body: string
  /** True when the review is tied to a fulfilled booking. */
  readonly isVerified: boolean
  /** The author's display name. Their email address is never exposed. */
  readonly authorName: string | null
  readonly createdAt: Date
}

/**
 * A dish page.
 *
 * Every field of `MenuItemDetail` from `@mannachef/api-contract`, plus the two
 * this surface adds: the published reviews the contract's list route carries
 * separately, and the computed seasonality verdict a card renders as an
 * "in season" mark. Stripping those two leaves a payload that
 * `menuItemDetailSchema.parse` accepts unchanged, which is what keeps this
 * action and the `menu.detail` HTTP route the same read.
 */
export interface MenuItemDetailView extends MenuItemDetail {
  readonly reviews: readonly MenuItemReviewView[]
  readonly isInSeason: boolean
}

/** A collection, with the size of what it holds. */
export interface MenuCategoryView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly tagline: string | null
  readonly description: string | null
  readonly sortOrder: number
  readonly isActive: boolean
  readonly heroMedia: MediaSummary | null
  /** Courses visible to this caller. */
  readonly subcategoryCount: number
  /** Dishes visible to this caller, under the same rules as the menu list. */
  readonly menuItemCount: number
}

/** A page of collections. */
export interface MenuCategoryListView {
  readonly items: readonly MenuCategoryView[]
  readonly meta: PageMeta
}

/** A course within a collection. */
export interface MenuSubcategoryView {
  readonly id: string
  readonly categoryId: string
  readonly categorySlug: string
  readonly categoryName: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly sortOrder: number
  readonly isActive: boolean
  readonly menuItemCount: number
}

/** A page of courses. */
export interface MenuSubcategoryListView {
  readonly items: readonly MenuSubcategoryView[]
  readonly meta: PageMeta
}

/** A tag, with how widely it is used. */
export interface TagView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: TagKind
  readonly description: string | null
  readonly colorToken: string | null
  readonly sortOrder: number
  readonly isActive: boolean
  readonly menuItemCount: number
  readonly mediaCount: number
}

/** A page of tags. */
export interface TagListView {
  readonly items: readonly TagView[]
  readonly meta: PageMeta
}

/**
 * A pantry entry.
 *
 * `unitCostCents` is `null` for every caller below `ADMIN`. What a supplier
 * charges is commercial information; what the dish contains is not, and a chef
 * needs the second without the first.
 */
export interface IngredientView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly sourcingNote: string | null
  readonly isAllergen: boolean
  readonly isActive: boolean
  readonly defaultUnit: MeasurementUnit
  readonly unitCostCents: number | null
  readonly currency: string
  readonly menuItemCount: number
}

/** A page of pantry entries. */
export interface IngredientListView {
  readonly items: readonly IngredientView[]
  readonly meta: PageMeta
}

/** What a collection mutation acknowledges. */
export interface MenuCategoryMutationView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly isActive: boolean
  readonly sortOrder: number
}

/** What a course mutation acknowledges. */
export interface MenuSubcategoryMutationView {
  readonly id: string
  readonly categoryId: string
  readonly slug: string
  readonly name: string
  readonly isActive: boolean
  readonly sortOrder: number
}

/** What a dish mutation acknowledges. */
export interface MenuItemMutationView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly isActive: boolean
  readonly isSignature: boolean
  readonly sortOrder: number
}

/** What a tag mutation acknowledges. */
export interface TagMutationView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: TagKind
  readonly isActive: boolean
}

/** What a pantry mutation acknowledges. */
export interface IngredientMutationView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly isAllergen: boolean
  readonly isActive: boolean
}

/** What a deletion acknowledges, with the collateral it caused. */
export interface MenuDeletionView {
  readonly id: string
  readonly name: string
  /** Rows removed alongside the target by a cascade, or detached by a set-null. */
  readonly cascaded: number
}

/** The seasonal toggle's verdict, already evaluated against today's month. */
export interface MenuItemSeasonView {
  readonly id: string
  readonly isSeasonal: boolean
  readonly seasonStart: number | null
  readonly seasonEnd: number | null
  readonly isInSeason: boolean
}

/** What replacing a dish's tag set changed. */
export interface MenuItemTagSetView {
  readonly menuItemId: string
  readonly tagCount: number
  readonly attached: number
  readonly detached: number
}

/** What replacing a dish's recipe changed. */
export interface MenuItemIngredientSetView {
  readonly menuItemId: string
  readonly ingredientCount: number
}

/** What replacing a dish's gallery changed. */
export interface MenuItemMediaSetView {
  readonly menuItemId: string
  readonly mediaCount: number
  readonly primaryMediaAssetId: string
}

/** The outcome of a bulk curation pass. */
export interface MenuItemBulkResultView {
  readonly action: MenuItemBulkAction
  /** Dishes the action actually touched. */
  readonly affected: number
  /** Join rows created or removed, for the tag actions. Zero elsewhere. */
  readonly links: number
}

/** What a reorder moved. */
export interface MenuReorderView {
  readonly scope: MenuReorderScope
  readonly moved: number
}

/** The four curated ladders {@link reorderMenuEntries} can renumber. */
export type MenuReorderScope = 'CATEGORY' | 'SUBCATEGORY' | 'MENU_ITEM' | 'TAG'

// =============================================================================
// 4. Locally composed input schemas
//
// `@mannachef/validators` owns every domain schema this module validates
// against, and none of them is restated here. The two below have no counterpart
// in that package because they describe an *operation* rather than an entity —
// "delete the row with this id", "renumber this ladder" — and both are
// assembled entirely from the shared primitives (`cuidSchema`,
// `sortOrderSchema`, `hasUniqueValues`) rather than from new rules.
// =============================================================================

/** The identifier of the row a delete acts on. */
const entityIdSchema = z.strictObject({ id: cuidSchema })

/** How many positions one drag-and-drop save may renumber. */
const MAX_REORDER_ENTRIES = 200

const menuReorderSchema = z
  .object({
    scope: z.enum(['CATEGORY', 'SUBCATEGORY', 'MENU_ITEM', 'TAG'], {
      error: 'Please say which list is being reordered.',
    }),
    entries: z
      .array(z.strictObject({ id: cuidSchema, sortOrder: sortOrderSchema }), {
        error: 'Please give the new running order.',
      })
      .min(1, { error: 'Nothing has moved yet.' })
      .max(MAX_REORDER_ENTRIES, {
        error: 'Please renumber two hundred positions at a time or fewer.',
      })
      .refine((entries) => hasUniqueValues(entries.map((entry) => entry.id)), {
        error: 'That item appears twice in the new running order.',
      }),
  })
  .strict()

// =============================================================================
// 5. Shared helpers
// =============================================================================

/**
 * The standard list envelope.
 *
 * Duplicated in `media.ts` rather than shared: a `'use server'` module may only
 * export async functions, so a helper cannot cross between two of them.
 */
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

/** `true` when the caller may read the catalogue as the kitchen sees it. */
function isCurator(role: Role | null): boolean {
  return hasRoleAtLeast(role, 'CHEF_STAFF')
}

/** `true` when the caller may shape the catalogue and see unpublished rows. */
function isEditor(role: Role | null): boolean {
  return hasRoleAtLeast(role, 'ADMIN')
}

/**
 * The visibility clauses every dish read is subject to.
 *
 * One function, called from the menu list *and* from the collection and course
 * counters, so a category can never advertise a dish the list would not show.
 */
function menuItemVisibilityFilters(
  role: Role | null,
  includeInactive: boolean,
  month: number
): Prisma.MenuItemWhereInput[] {
  const filters: Prisma.MenuItemWhereInput[] = []

  if (!(isEditor(role) && includeInactive)) {
    filters.push({ isActive: true, category: { isActive: true } })
  }

  if (!isCurator(role)) {
    filters.push(inSeasonFilter(month))
  }

  return filters
}

/** Mean rating and count over the published reviews of a set of dishes. */
interface RatingSummary {
  readonly averageRating: number | null
  readonly reviewCount: number
}

async function readRatingSummaries(
  db: typeof prisma,
  menuItemIds: readonly string[]
): Promise<Map<string, RatingSummary>> {
  const summaries = new Map<string, RatingSummary>()

  if (menuItemIds.length === 0) {
    return summaries
  }

  const grouped = await db.review.groupBy({
    by: ['menuItemId'],
    where: {
      menuItemId: { in: [...menuItemIds] },
      status: { in: [...PUBLISHED_REVIEW_STATUSES] },
    },
    _avg: { rating: true },
    _count: { _all: true },
  })

  for (const group of grouped) {
    if (group.menuItemId === null) {
      continue
    }

    const average = group._avg.rating

    summaries.set(group.menuItemId, {
      averageRating: average === null ? null : Math.round(average * 10) / 10,
      reviewCount: group._count._all,
    })
  }

  return summaries
}

/** Counts of visible dishes, keyed by the column they were grouped on. */
async function countMenuItemsBy(
  db: typeof prisma,
  groupBy: 'categoryId' | 'subcategoryId',
  scopeFilter: Prisma.MenuItemWhereInput,
  visibility: readonly Prisma.MenuItemWhereInput[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()

  const grouped =
    groupBy === 'categoryId'
      ? await db.menuItem.groupBy({
          by: ['categoryId'],
          where: { AND: [scopeFilter, ...visibility] },
          _count: { _all: true },
        })
      : await db.menuItem.groupBy({
          by: ['subcategoryId'],
          where: { AND: [scopeFilter, ...visibility] },
          _count: { _all: true },
        })

  for (const group of grouped) {
    const key =
      'categoryId' in group ? group.categoryId : (group.subcategoryId ?? null)

    if (key === null) {
      continue
    }

    counts.set(key, group._count._all)
  }

  return counts
}

function toMenuItemSummary(
  row: MenuItemSummaryRow,
  ratings: ReadonlyMap<string, RatingSummary>
): MenuItemSummary {
  const rating = ratings.get(row.id)
  const lead = row.media[0]

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    categoryId: row.categoryId,
    categorySlug: row.category.slug,
    categoryName: row.category.name,
    subcategorySlug: row.subcategory?.slug ?? null,
    basePriceCents: row.basePriceCents,
    currency: row.currency,
    spiceLevel: row.spiceLevel,
    isSeasonal: row.isSeasonal,
    seasonStart: row.seasonStart,
    seasonEnd: row.seasonEnd,
    isSignature: row.isSignature,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    tags: row.tags.map((edge) => edge.tag),
    primaryMedia: lead === undefined ? null : lead.mediaAsset,
    averageRating: rating?.averageRating ?? null,
    reviewCount: rating?.reviewCount ?? 0,
  }
}

function toIngredientViews(row: MenuItemDetailRow): MenuItemIngredientView[] {
  return row.ingredients.map((edge) => ({
    id: edge.id,
    ingredientId: edge.ingredientId,
    slug: edge.ingredient.slug,
    name: edge.ingredient.name,
    // `Decimal(10,3)` — serialised as a string so the exact quantity survives
    // the trip to the client rather than being rounded through a float.
    quantity: edge.quantity.toString(),
    unit: edge.unit,
    preparation: edge.preparation,
    isAllergen: edge.ingredient.isAllergen,
    isOptional: edge.isOptional,
    isGarnish: edge.isGarnish,
    sortOrder: edge.sortOrder,
  }))
}

function toMenuCategoryView(
  row: MenuCategoryRow,
  menuItemCount: number,
  subcategoryCount: number
): MenuCategoryView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    heroMedia: row.heroMedia,
    subcategoryCount,
    menuItemCount,
  }
}

function toMenuSubcategoryView(
  row: MenuSubcategoryRow,
  menuItemCount: number
): MenuSubcategoryView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categorySlug: row.category.slug,
    categoryName: row.category.name,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    menuItemCount,
  }
}

function toTagView(row: TagRow): TagView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    description: row.description,
    colorToken: row.colorToken,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    menuItemCount: row._count.menuItems,
    mediaCount: row._count.media,
  }
}

function toIngredientView(
  row: IngredientRow,
  mayReadCost: boolean
): IngredientView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sourcingNote: row.sourcingNote,
    isAllergen: row.isAllergen,
    isActive: row.isActive,
    defaultUnit: row.defaultUnit,
    unitCostCents: mayReadCost ? row.unitCostCents : null,
    currency: row.currency,
    menuItemCount: row._count.menuItems,
  }
}

/**
 * Confirms every id in `requested` exists in `found`, and names the first that
 * does not.
 *
 * Every bulk write funnels through this. A payload naming one id that has been
 * deleted since the page rendered fails as a whole rather than half-applying.
 */
function missingIds(
  requested: readonly string[],
  found: readonly { readonly id: string }[]
): string[] {
  const present = new Set(found.map((row) => row.id))
  return requested.filter((id) => !present.has(id))
}

/** Confirms a set of `MediaAsset` ids all resolve, and returns their kinds. */
async function readMediaAssetKinds(
  db: typeof prisma,
  mediaAssetIds: readonly string[]
): Promise<Map<string, MediaKind>> {
  const rows = await db.mediaAsset.findMany({
    where: { id: { in: [...mediaAssetIds] } },
    select: { id: true, kind: true },
  })

  return new Map(rows.map((row) => [row.id, row.kind]))
}

/** `a`, `a and b`, `a, b and c`. */
function formatList(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? ''
  }

  const head = parts.slice(0, -1).join(', ')
  const tail = parts[parts.length - 1] ?? ''

  return `${head} and ${tail}`
}

// =============================================================================
// 6. Public reads
// =============================================================================

/**
 * Browse the menu.
 *
 * Public. What a caller is shown narrows by role, never widens:
 *
 *  - below `CHEF_STAFF`: published dishes in published collections, and only
 *    those in season this month;
 *  - `CHEF_STAFF`: the same published dishes, whatever the month;
 *  - `ADMIN` and above: everything, once `includeInactive` is asked for.
 *
 * There is deliberately no rate limit. This action is called during static
 * generation and from server components, where `headers()` yields no address and
 * every anonymous render would collapse onto a single bucket — a limiter that
 * throttles the build rather than an abuser.
 */
export const listMenuItems = withAction(
  { name: 'menu.list', auth: 'PUBLIC', input: menuItemFilterSchema },
  async (ctx, filter): Promise<ActionResult<MenuItemListView>> => {
    const role = ctx.user?.role ?? null
    const month = currentSeasonMonth()

    const filters = menuItemVisibilityFilters(
      role,
      filter.includeInactive,
      month
    )

    if (filter.seasonalOnly) {
      filters.push(seasonalRightNowFilter(month))
    }

    if (filter.signatureOnly) {
      filters.push({ isSignature: true })
    }

    if (filter.categorySlug !== undefined) {
      filters.push({ category: { slug: filter.categorySlug } })
    }

    if (filter.subcategorySlug !== undefined) {
      filters.push({ subcategory: { slug: filter.subcategorySlug } })
    }

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { description: { contains: filter.search, mode: 'insensitive' } },
          { slug: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    if (filter.priceCentsMin !== undefined) {
      filters.push({ basePriceCents: { gte: filter.priceCentsMin } })
    }

    if (filter.priceCentsMax !== undefined) {
      filters.push({ basePriceCents: { lte: filter.priceCentsMax } })
    }

    if (filter.tagSlugs.length > 0) {
      if (filter.tagMatchMode === 'ANY') {
        filters.push({
          tags: { some: { tag: { slug: { in: [...filter.tagSlugs] } } } },
        })
      } else {
        // `ALL` is a conjunction of independent `some` clauses. A single
        // `every` would be wrong: it also matches a dish with no tags at all.
        for (const slug of filter.tagSlugs) {
          filters.push({ tags: { some: { tag: { slug } } } })
        }
      }
    }

    const where: Prisma.MenuItemWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.menuItem.count({ where }),
      ctx.db.menuItem.findMany({
        where,
        select: MENU_ITEM_SUMMARY_SELECT,
        orderBy: menuItemOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    const ratings = await readRatingSummaries(
      ctx.db,
      rows.map((row) => row.id)
    )

    return ok({
      items: rows.map((row) => toMenuItemSummary(row, ratings)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

function menuItemOrderBy(
  sortBy: MenuItemSortBy,
  direction: SortDirection
): Prisma.MenuItemOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'NAME':
      return [{ name: direction }, { id: 'asc' }]

    case 'PRICE':
      return [{ basePriceCents: direction }, { name: 'asc' }, { id: 'asc' }]

    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    case 'SIGNATURE':
      return [{ isSignature: direction }, { sortOrder: 'asc' }, { id: 'asc' }]

    case 'CURATED':
      return [{ sortOrder: direction }, { name: 'asc' }, { id: 'asc' }]

    default: {
      // A new member of `menuItemSortBySchema` is a compile error here rather
      // than a silently unordered list.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * One dish, with its story, gallery, pantry and published reviews.
 *
 * Public, and the same visibility rules apply — with one deliberate difference
 * from the list. A dish that is *out of season* is still readable here: a guest
 * may hold a link to the winter truffle from last year, and answering that link
 * with `NOT_FOUND` would be a lie. `isInSeason` is returned instead, so the page
 * can say "back in November" rather than pretending the dish never existed. A
 * dish that is *unpublished* is genuinely not found for anyone below `ADMIN`.
 */
export const getMenuItem = withAction(
  { name: 'menu.detail', auth: 'PUBLIC', input: menuDetailInputSchema },
  async (ctx, input): Promise<ActionResult<MenuItemDetailView>> => {
    const role = ctx.user?.role ?? null
    const mayReadDrafts = isEditor(role) && input.includeInactive

    const row = await ctx.db.menuItem.findUnique({
      where: { slug: input.slug },
      select: MENU_ITEM_DETAIL_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that dish on the menu.')
    }

    if (!mayReadDrafts && (!row.isActive || !row.category.isActive)) {
      return fail('NOT_FOUND', 'We could not find that dish on the menu.')
    }

    const [ratings, reviews] = await Promise.all([
      readRatingSummaries(ctx.db, [row.id]),
      ctx.db.review.findMany({
        where: {
          menuItemId: row.id,
          status: { in: [...PUBLISHED_REVIEW_STATUSES] },
        },
        // Featured reviews carry a `featuredOrder`; everything else falls in
        // behind them, newest first.
        orderBy: [
          { featuredOrder: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        take: MAX_DETAIL_REVIEWS,
        select: {
          id: true,
          rating: true,
          title: true,
          body: true,
          isVerified: true,
          createdAt: true,
          author: { select: { name: true } },
        },
      }),
    ])

    const month = currentSeasonMonth()

    return ok({
      ...toMenuItemSummary(row, ratings),
      story: row.story,
      tastingNote: row.tastingNote,
      pairingNote: row.pairingNote,
      servingSize: row.servingSize,
      servingsPerUnit: row.servingsPerUnit,
      prepTimeMinutes: row.prepTimeMinutes,
      cookTimeMinutes: row.cookTimeMinutes,
      calories: row.calories,
      proteinGram: row.proteinGram,
      carbGram: row.carbGram,
      fatGram: row.fatGram,
      media: row.media.map((edge) => edge.mediaAsset),
      ingredients: toIngredientViews(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      reviews: reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        title: review.title,
        body: review.body,
        isVerified: review.isVerified,
        authorName: review.author.name,
        createdAt: review.createdAt,
      })),
      isInSeason:
        !row.isSeasonal ||
        isMonthInSeason(row.seasonStart, row.seasonEnd, month),
    })
  }
)

/**
 * The collections, with a truthful count of what each one holds.
 *
 * The counts come from a `groupBy` that reuses {@link menuItemVisibilityFilters}
 * verbatim, so a collection can never promise a guest twelve dishes and then
 * show them four.
 */
export const listMenuCategories = withAction(
  {
    name: 'menu.categories.list',
    auth: 'PUBLIC',
    input: menuCategoryFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<MenuCategoryListView>> => {
    const role = ctx.user?.role ?? null
    const month = currentSeasonMonth()
    const mayReadDrafts = isEditor(role) && filter.includeInactive

    const filters: Prisma.MenuCategoryWhereInput[] = []

    if (!mayReadDrafts) {
      filters.push({ isActive: true })
    }

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { tagline: { contains: filter.search, mode: 'insensitive' } },
          { slug: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    const where: Prisma.MenuCategoryWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)
    const direction = filter.sortDirection

    const orderBy: Prisma.MenuCategoryOrderByWithRelationInput[] =
      filter.sortBy === 'NAME'
        ? [{ name: direction }, { id: 'asc' }]
        : filter.sortBy === 'CREATED'
          ? [{ createdAt: direction }, { id: 'asc' }]
          : filter.sortBy === 'UPDATED'
            ? [{ updatedAt: direction }, { id: 'asc' }]
            : [{ sortOrder: direction }, { name: 'asc' }, { id: 'asc' }]

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.menuCategory.count({ where }),
      ctx.db.menuCategory.findMany({
        where,
        select: MENU_CATEGORY_VIEW_SELECT,
        orderBy,
        skip,
        take,
      }),
    ])

    const categoryIds = rows.map((row) => row.id)

    const [menuItemCounts, subcategoryGroups] = await Promise.all([
      countMenuItemsBy(
        ctx.db,
        'categoryId',
        { categoryId: { in: categoryIds } },
        menuItemVisibilityFilters(role, filter.includeInactive, month)
      ),
      ctx.db.menuSubcategory.groupBy({
        by: ['categoryId'],
        where: mayReadDrafts
          ? { categoryId: { in: categoryIds } }
          : { categoryId: { in: categoryIds }, isActive: true },
        _count: { _all: true },
      }),
    ])

    const subcategoryCounts = new Map<string, number>(
      subcategoryGroups.map((group) => [group.categoryId, group._count._all])
    )

    return ok({
      items: rows.map((row) =>
        toMenuCategoryView(
          row,
          menuItemCounts.get(row.id) ?? 0,
          subcategoryCounts.get(row.id) ?? 0
        )
      ),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/** The courses within a collection, counted under the same visibility rules. */
export const listMenuSubcategories = withAction(
  {
    name: 'menu.subcategories.list',
    auth: 'PUBLIC',
    input: menuSubcategoryFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<MenuSubcategoryListView>> => {
    const role = ctx.user?.role ?? null
    const month = currentSeasonMonth()
    const mayReadDrafts = isEditor(role) && filter.includeInactive

    const filters: Prisma.MenuSubcategoryWhereInput[] = []

    if (!mayReadDrafts) {
      filters.push({ isActive: true, category: { isActive: true } })
    }

    if (filter.categoryId !== undefined) {
      filters.push({ categoryId: filter.categoryId })
    }

    if (filter.categorySlug !== undefined) {
      filters.push({ category: { slug: filter.categorySlug } })
    }

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { slug: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    const where: Prisma.MenuSubcategoryWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)
    const direction = filter.sortDirection

    const orderBy: Prisma.MenuSubcategoryOrderByWithRelationInput[] =
      filter.sortBy === 'NAME'
        ? [{ name: direction }, { id: 'asc' }]
        : filter.sortBy === 'CREATED'
          ? [{ createdAt: direction }, { id: 'asc' }]
          : filter.sortBy === 'UPDATED'
            ? [{ updatedAt: direction }, { id: 'asc' }]
            : [{ sortOrder: direction }, { name: 'asc' }, { id: 'asc' }]

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.menuSubcategory.count({ where }),
      ctx.db.menuSubcategory.findMany({
        where,
        select: MENU_SUBCATEGORY_VIEW_SELECT,
        orderBy,
        skip,
        take,
      }),
    ])

    const counts = await countMenuItemsBy(
      ctx.db,
      'subcategoryId',
      { subcategoryId: { in: rows.map((row) => row.id) } },
      menuItemVisibilityFilters(role, filter.includeInactive, month)
    )

    return ok({
      items: rows.map((row) =>
        toMenuSubcategoryView(row, counts.get(row.id) ?? 0)
      ),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/** The tag vocabulary, with how widely each tag is used. */
export const listTags = withAction(
  { name: 'menu.tags.list', auth: 'PUBLIC', input: tagFilterSchema },
  async (ctx, filter): Promise<ActionResult<TagListView>> => {
    const role = ctx.user?.role ?? null
    const mayReadRetired = isEditor(role) && filter.includeInactive

    const filters: Prisma.TagWhereInput[] = []

    if (!mayReadRetired) {
      filters.push({ isActive: true })
    }

    if (filter.kinds.length > 0) {
      filters.push({ kind: { in: [...filter.kinds] } })
    }

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { slug: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    const where: Prisma.TagWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)
    const direction = filter.sortDirection

    const orderBy: Prisma.TagOrderByWithRelationInput[] =
      filter.sortBy === 'NAME'
        ? [{ name: direction }, { id: 'asc' }]
        : filter.sortBy === 'KIND'
          ? [{ kind: direction }, { sortOrder: 'asc' }, { id: 'asc' }]
          : filter.sortBy === 'CREATED'
            ? [{ createdAt: direction }, { id: 'asc' }]
            : filter.sortBy === 'USAGE'
              ? [{ menuItems: { _count: direction } }, { id: 'asc' }]
              : [{ sortOrder: direction }, { name: 'asc' }, { id: 'asc' }]

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.tag.count({ where }),
      ctx.db.tag.findMany({
        where,
        select: TAG_VIEW_SELECT,
        orderBy,
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toTagView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * The pantry.
 *
 * `CHEF_STAFF` and above, because `sourcingNote` names suppliers and
 * `unitCostCents` is what they charge. The cost itself is narrowed further —
 * `null` below `ADMIN` — and a `COST` sort is quietly downgraded to a name sort
 * for the same caller, since ordering by a hidden column leaks its ordering.
 */
export const listIngredients = withAction(
  {
    name: 'menu.ingredients.list',
    auth: 'CHEF_STAFF',
    input: ingredientFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<IngredientListView>> => {
    const mayReadCost = isEditor(ctx.user.role)
    const mayReadRetired = isEditor(ctx.user.role) && filter.includeInactive

    const filters: Prisma.IngredientWhereInput[] = []

    if (!mayReadRetired) {
      filters.push({ isActive: true })
    }

    if (filter.allergensOnly) {
      filters.push({ isAllergen: true })
    }

    if (filter.units.length > 0) {
      filters.push({ defaultUnit: { in: [...filter.units] } })
    }

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { slug: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    const where: Prisma.IngredientWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)
    const direction = filter.sortDirection
    const sortBy =
      filter.sortBy === 'COST' && !mayReadCost ? 'NAME' : filter.sortBy

    const orderBy: Prisma.IngredientOrderByWithRelationInput[] =
      sortBy === 'CREATED'
        ? [{ createdAt: direction }, { id: 'asc' }]
        : sortBy === 'UPDATED'
          ? [{ updatedAt: direction }, { id: 'asc' }]
          : sortBy === 'COST'
            ? [
                { unitCostCents: { sort: direction, nulls: 'last' } },
                { name: 'asc' },
              ]
            : sortBy === 'USAGE'
              ? [{ menuItems: { _count: direction } }, { id: 'asc' }]
              : [{ name: direction }, { id: 'asc' }]

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.ingredient.count({ where }),
      ctx.db.ingredient.findMany({
        where,
        select: INGREDIENT_VIEW_SELECT,
        orderBy,
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map((row) => toIngredientView(row, mayReadCost)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 7. Collections
// =============================================================================

/** Create a collection. `ADMIN` and above. */
export const createMenuCategory = withAction(
  {
    name: 'menu.categories.create',
    auth: 'ADMIN',
    input: menuCategoryCreateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuCategoryMutationView>> => {
    const clash = await ctx.db.menuCategory.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    })

    if (clash !== null) {
      return fail(
        'CONFLICT',
        'Another collection already uses that handle. Please choose another.',
        { slug: ['Another collection already uses that handle.'] }
      )
    }

    if (input.heroMediaId != null) {
      const hero = await ctx.db.mediaAsset.findUnique({
        where: { id: input.heroMediaId },
        select: { id: true },
      })

      if (hero === null) {
        return fail(
          'NOT_FOUND',
          'That hero image is no longer in the library.',
          {
            heroMediaId: ['That hero image is no longer in the library.'],
          }
        )
      }
    }

    const created = await ctx.db.menuCategory.create({
      data: {
        slug: input.slug,
        name: input.name,
        tagline: input.tagline ?? null,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        heroMediaId: input.heroMediaId ?? null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
        sortOrder: true,
      },
    })

    return ok(created)
  }
)

/** Edit a collection. `ADMIN` and above. */
export const updateMenuCategory = withAction(
  {
    name: 'menu.categories.update',
    auth: 'ADMIN',
    input: menuCategoryUpdateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuCategoryMutationView>> => {
    const existing = await ctx.db.menuCategory.findUnique({
      where: { id: input.id },
      select: { id: true, slug: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That collection is no longer on the menu.')
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const clash = await ctx.db.menuCategory.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      })

      if (clash !== null) {
        return fail(
          'CONFLICT',
          'Another collection already uses that handle. Please choose another.',
          { slug: ['Another collection already uses that handle.'] }
        )
      }
    }

    if (input.heroMediaId != null) {
      const hero = await ctx.db.mediaAsset.findUnique({
        where: { id: input.heroMediaId },
        select: { id: true },
      })

      if (hero === null) {
        return fail(
          'NOT_FOUND',
          'That hero image is no longer in the library.',
          {
            heroMediaId: ['That hero image is no longer in the library.'],
          }
        )
      }
    }

    const updated = await ctx.db.menuCategory.update({
      where: { id: existing.id },
      data: {
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.tagline !== undefined && { tagline: input.tagline }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.heroMediaId !== undefined && {
          heroMediaId: input.heroMediaId,
        }),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
        sortOrder: true,
      },
    })

    return ok(updated)
  }
)

/**
 * Remove a collection. `ADMIN` and above.
 *
 * `MenuItem.category` is `onDelete: Restrict`, so a collection that still holds
 * a dish cannot be removed — and the database would answer that with a foreign
 * key violation rather than a sentence. The count is read first so the refusal
 * can say how many dishes are in the way.
 *
 * Its courses cascade, which is intended: a course has no meaning outside its
 * collection. The number removed is reported.
 */
export const deleteMenuCategory = withAction(
  {
    name: 'menu.categories.delete',
    auth: 'ADMIN',
    input: entityIdSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuDeletionView>> => {
    const existing = await ctx.db.menuCategory.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        _count: { select: { items: true, subcategories: true } },
      },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That collection is no longer on the menu.')
    }

    if (existing._count.items > 0) {
      const noun = existing._count.items === 1 ? 'dish' : 'dishes'

      return fail(
        'CONFLICT',
        `“${existing.name}” still holds ${existing._count.items} ${noun}. Move them to another collection first, or unpublish this one instead.`
      )
    }

    await ctx.db.menuCategory.delete({ where: { id: existing.id } })

    return ok({
      id: existing.id,
      name: existing.name,
      cascaded: existing._count.subcategories,
    })
  }
)

// =============================================================================
// 8. Courses
// =============================================================================

/** Create a course within a collection. `ADMIN` and above. */
export const createMenuSubcategory = withAction(
  {
    name: 'menu.subcategories.create',
    auth: 'ADMIN',
    input: menuSubcategoryCreateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuSubcategoryMutationView>> => {
    const category = await ctx.db.menuCategory.findUnique({
      where: { id: input.categoryId },
      select: { id: true },
    })

    if (category === null) {
      return fail('NOT_FOUND', 'That collection is no longer on the menu.', {
        categoryId: ['That collection is no longer on the menu.'],
      })
    }

    const clash = await ctx.db.menuSubcategory.findUnique({
      where: {
        categoryId_slug: { categoryId: category.id, slug: input.slug },
      },
      select: { id: true },
    })

    if (clash !== null) {
      return fail(
        'CONFLICT',
        'Another course in this collection already uses that handle.',
        {
          slug: ['Another course in this collection already uses that handle.'],
        }
      )
    }

    const created = await ctx.db.menuSubcategory.create({
      data: {
        categoryId: category.id,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
      select: {
        id: true,
        categoryId: true,
        slug: true,
        name: true,
        isActive: true,
        sortOrder: true,
      },
    })

    return ok(created)
  }
)

/** Edit a course. `ADMIN` and above. */
export const updateMenuSubcategory = withAction(
  {
    name: 'menu.subcategories.update',
    auth: 'ADMIN',
    input: menuSubcategoryUpdateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuSubcategoryMutationView>> => {
    const existing = await ctx.db.menuSubcategory.findUnique({
      where: { id: input.id },
      select: { id: true, slug: true, categoryId: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That course is no longer on the menu.')
    }

    const categoryId = input.categoryId ?? existing.categoryId
    const slug = input.slug ?? existing.slug

    if (
      input.categoryId !== undefined &&
      input.categoryId !== existing.categoryId
    ) {
      const category = await ctx.db.menuCategory.findUnique({
        where: { id: input.categoryId },
        select: { id: true },
      })

      if (category === null) {
        return fail('NOT_FOUND', 'That collection is no longer on the menu.', {
          categoryId: ['That collection is no longer on the menu.'],
        })
      }
    }

    if (categoryId !== existing.categoryId || slug !== existing.slug) {
      const clash = await ctx.db.menuSubcategory.findUnique({
        where: { categoryId_slug: { categoryId, slug } },
        select: { id: true },
      })

      if (clash !== null && clash.id !== existing.id) {
        return fail(
          'CONFLICT',
          'Another course in this collection already uses that handle.',
          {
            slug: [
              'Another course in this collection already uses that handle.',
            ],
          }
        )
      }
    }

    const updated = await ctx.db.menuSubcategory.update({
      where: { id: existing.id },
      data: {
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
      select: {
        id: true,
        categoryId: true,
        slug: true,
        name: true,
        isActive: true,
        sortOrder: true,
      },
    })

    return ok(updated)
  }
)

/**
 * Remove a course. `ADMIN` and above.
 *
 * `MenuItem.subcategory` is `onDelete: SetNull`, so the dishes survive and are
 * simply detached from the course. The number detached is reported rather than
 * left as a surprise.
 */
export const deleteMenuSubcategory = withAction(
  {
    name: 'menu.subcategories.delete',
    auth: 'ADMIN',
    input: entityIdSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuDeletionView>> => {
    const existing = await ctx.db.menuSubcategory.findUnique({
      where: { id: input.id },
      select: { id: true, name: true, _count: { select: { items: true } } },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That course is no longer on the menu.')
    }

    await ctx.db.menuSubcategory.delete({ where: { id: existing.id } })

    return ok({
      id: existing.id,
      name: existing.name,
      cascaded: existing._count.items,
    })
  }
)

// =============================================================================
// 9. Dishes
// =============================================================================

/**
 * Both ends of a seasonal window, normalised.
 *
 * A dish that is not seasonal carries no months at all, so switching seasonality
 * off can never leave a stale November behind in the database.
 */
function normalizedSeason(
  isSeasonal: boolean,
  seasonStart: number | null | undefined,
  seasonEnd: number | null | undefined
): { seasonStart: number | null; seasonEnd: number | null } {
  if (!isSeasonal) {
    return { seasonStart: null, seasonEnd: null }
  }

  return { seasonStart: seasonStart ?? null, seasonEnd: seasonEnd ?? null }
}

/** Confirms a course, when named, really sits inside the named collection. */
async function validateCategoryPair(
  db: typeof prisma,
  categoryId: string,
  subcategoryId: string | null
): Promise<ActionResult<null>> {
  const category = await db.menuCategory.findUnique({
    where: { id: categoryId },
    select: { id: true },
  })

  if (category === null) {
    return fail('NOT_FOUND', 'That collection is no longer on the menu.', {
      categoryId: ['That collection is no longer on the menu.'],
    })
  }

  if (subcategoryId === null) {
    return ok(null)
  }

  const subcategory = await db.menuSubcategory.findUnique({
    where: { id: subcategoryId },
    select: { id: true, categoryId: true },
  })

  if (subcategory === null) {
    return fail('NOT_FOUND', 'That course is no longer on the menu.', {
      subcategoryId: ['That course is no longer on the menu.'],
    })
  }

  if (subcategory.categoryId !== categoryId) {
    return fail(
      'VALIDATION',
      'That course belongs to a different collection. Please choose one from the collection you selected.',
      { subcategoryId: ['That course belongs to a different collection.'] }
    )
  }

  return ok(null)
}

const MENU_ITEM_MUTATION_SELECT = Prisma.validator<Prisma.MenuItemSelect>()({
  id: true,
  slug: true,
  name: true,
  isActive: true,
  isSignature: true,
  sortOrder: true,
})

/** Create a dish. `ADMIN` and above. */
export const createMenuItem = withAction(
  {
    name: 'menu.items.create',
    auth: 'ADMIN',
    input: menuItemCreateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemMutationView>> => {
    const clash = await ctx.db.menuItem.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    })

    if (clash !== null) {
      return fail(
        'CONFLICT',
        'Another dish already uses that handle. Please choose another.',
        { slug: ['Another dish already uses that handle.'] }
      )
    }

    const pair = await validateCategoryPair(
      ctx.db,
      input.categoryId,
      input.subcategoryId ?? null
    )

    if (!pair.ok) {
      return pair
    }

    const season = normalizedSeason(
      input.isSeasonal,
      input.seasonStart,
      input.seasonEnd
    )

    const created = await ctx.db.menuItem.create({
      data: {
        slug: input.slug,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId ?? null,
        name: input.name,
        description: input.description ?? null,
        story: input.story ?? null,
        tastingNote: input.tastingNote ?? null,
        pairingNote: input.pairingNote ?? null,
        chefNote: input.chefNote ?? null,
        basePriceCents: input.basePriceCents,
        currency: input.currency,
        servingSize: input.servingSize ?? null,
        servingsPerUnit: input.servingsPerUnit ?? null,
        prepTimeMinutes: input.prepTimeMinutes ?? null,
        cookTimeMinutes: input.cookTimeMinutes ?? null,
        calories: input.calories ?? null,
        proteinGram: input.proteinGram ?? null,
        carbGram: input.carbGram ?? null,
        fatGram: input.fatGram ?? null,
        spiceLevel: input.spiceLevel,
        isSeasonal: input.isSeasonal,
        seasonStart: season.seasonStart,
        seasonEnd: season.seasonEnd,
        isActive: input.isActive,
        isSignature: input.isSignature,
        sortOrder: input.sortOrder,
      },
      select: MENU_ITEM_MUTATION_SELECT,
    })

    return ok(created)
  }
)

/**
 * Edit a dish. `ADMIN` and above.
 *
 * Turning seasonality off clears both months even when the payload did not
 * mention them, so an unchecked box and a stale window cannot disagree.
 */
export const updateMenuItem = withAction(
  {
    name: 'menu.items.update',
    auth: 'ADMIN',
    input: menuItemUpdateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemMutationView>> => {
    const existing = await ctx.db.menuItem.findUnique({
      where: { id: input.id },
      select: { id: true, slug: true, categoryId: true, subcategoryId: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That dish is no longer on the menu.')
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const clash = await ctx.db.menuItem.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      })

      if (clash !== null) {
        return fail(
          'CONFLICT',
          'Another dish already uses that handle. Please choose another.',
          { slug: ['Another dish already uses that handle.'] }
        )
      }
    }

    const movesCategory =
      input.categoryId !== undefined || input.subcategoryId !== undefined

    if (movesCategory) {
      const pair = await validateCategoryPair(
        ctx.db,
        input.categoryId ?? existing.categoryId,
        input.subcategoryId === undefined
          ? existing.subcategoryId
          : input.subcategoryId
      )

      if (!pair.ok) {
        return pair
      }
    }

    // `isSeasonal: false` clears the window even when the payload is silent
    // about the months; `isSeasonal: true` or an untouched flag lets the months
    // through exactly as sent.
    const clearsSeason = input.isSeasonal === false

    const updated = await ctx.db.menuItem.update({
      where: { id: existing.id },
      data: {
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.subcategoryId !== undefined && {
          subcategoryId: input.subcategoryId,
        }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.story !== undefined && { story: input.story }),
        ...(input.tastingNote !== undefined && {
          tastingNote: input.tastingNote,
        }),
        ...(input.pairingNote !== undefined && {
          pairingNote: input.pairingNote,
        }),
        ...(input.chefNote !== undefined && { chefNote: input.chefNote }),
        ...(input.basePriceCents !== undefined && {
          basePriceCents: input.basePriceCents,
        }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.servingSize !== undefined && {
          servingSize: input.servingSize,
        }),
        ...(input.servingsPerUnit !== undefined && {
          servingsPerUnit: input.servingsPerUnit,
        }),
        ...(input.prepTimeMinutes !== undefined && {
          prepTimeMinutes: input.prepTimeMinutes,
        }),
        ...(input.cookTimeMinutes !== undefined && {
          cookTimeMinutes: input.cookTimeMinutes,
        }),
        ...(input.calories !== undefined && { calories: input.calories }),
        ...(input.proteinGram !== undefined && {
          proteinGram: input.proteinGram,
        }),
        ...(input.carbGram !== undefined && { carbGram: input.carbGram }),
        ...(input.fatGram !== undefined && { fatGram: input.fatGram }),
        ...(input.spiceLevel !== undefined && { spiceLevel: input.spiceLevel }),
        ...(input.isSeasonal !== undefined && { isSeasonal: input.isSeasonal }),
        ...(clearsSeason
          ? { seasonStart: null, seasonEnd: null }
          : {
              ...(input.seasonStart !== undefined && {
                seasonStart: input.seasonStart,
              }),
              ...(input.seasonEnd !== undefined && {
                seasonEnd: input.seasonEnd,
              }),
            }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.isSignature !== undefined && {
          isSignature: input.isSignature,
        }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
      select: MENU_ITEM_MUTATION_SELECT,
    })

    return ok(updated)
  }
)

/**
 * Remove a dish. `ADMIN` and above.
 *
 * `AppointmentMenuItem.menuItem` is `onDelete: Restrict`, so a dish that has
 * been cooked for somebody cannot be deleted — the engagement's course list is
 * history and must not lose a row. The refusal says how many engagements are in
 * the way and points at unpublishing instead.
 *
 * Its tags, recipe lines, gallery rows and reviews all cascade.
 */
export const deleteMenuItem = withAction(
  {
    name: 'menu.items.delete',
    auth: 'ADMIN',
    input: entityIdSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuDeletionView>> => {
    const existing = await ctx.db.menuItem.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            appointments: true,
            tags: true,
            ingredients: true,
            media: true,
            reviews: true,
          },
        },
      },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That dish is no longer on the menu.')
    }

    if (existing._count.appointments > 0) {
      const noun =
        existing._count.appointments === 1 ? 'engagement' : 'engagements'

      return fail(
        'CONFLICT',
        `“${existing.name}” has been served at ${existing._count.appointments} ${noun}, so its history cannot be removed. Take it off the menu instead.`
      )
    }

    await ctx.db.menuItem.delete({ where: { id: existing.id } })

    return ok({
      id: existing.id,
      name: existing.name,
      cascaded:
        existing._count.tags +
        existing._count.ingredients +
        existing._count.media +
        existing._count.reviews,
    })
  }
)

/**
 * The one-click seasonal toggle used by the dish list and the dish header.
 * `ADMIN` and above.
 *
 * The payload has already been normalised by
 * `menuItemSeasonalToggleSchema.transform`, which names both months explicitly —
 * `null` when the dish comes off the calendar — so the write can never leave a
 * half-cleared window behind. The verdict returned is evaluated against today's
 * month with the wrapping rule applied, so a November-to-February dish switched
 * on in January comes back `isInSeason: true`.
 */
export const toggleMenuItemSeasonal = withAction(
  {
    name: 'menu.items.seasonal',
    auth: 'ADMIN',
    input: menuItemSeasonalToggleSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemSeasonView>> => {
    const existing = await ctx.db.menuItem.findUnique({
      where: { id: input.id },
      select: { id: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That dish is no longer on the menu.')
    }

    const updated = await ctx.db.menuItem.update({
      where: { id: existing.id },
      data: {
        isSeasonal: input.isSeasonal,
        seasonStart: input.seasonStart,
        seasonEnd: input.seasonEnd,
      },
      select: {
        id: true,
        isSeasonal: true,
        seasonStart: true,
        seasonEnd: true,
      },
    })

    return ok({
      id: updated.id,
      isSeasonal: updated.isSeasonal,
      seasonStart: updated.seasonStart,
      seasonEnd: updated.seasonEnd,
      isInSeason:
        !updated.isSeasonal ||
        isMonthInSeason(
          updated.seasonStart,
          updated.seasonEnd,
          currentSeasonMonth()
        ),
    })
  }
)

// =============================================================================
// 10. Tags
// =============================================================================

/** Create a tag. `ADMIN` and above. */
export const createTag = withAction(
  {
    name: 'menu.tags.create',
    auth: 'ADMIN',
    input: tagCreateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<TagMutationView>> => {
    const clash = await ctx.db.tag.findFirst({
      where: {
        OR: [{ slug: input.slug }, { kind: input.kind, name: input.name }],
      },
      select: { id: true, slug: true },
    })

    if (clash !== null) {
      return clash.slug === input.slug
        ? fail('CONFLICT', 'Another tag already uses that handle.', {
            slug: ['Another tag already uses that handle.'],
          })
        : fail('CONFLICT', 'A tag of this kind already carries that name.', {
            name: ['A tag of this kind already carries that name.'],
          })
    }

    const created = await ctx.db.tag.create({
      data: {
        slug: input.slug,
        name: input.name,
        kind: input.kind,
        description: input.description ?? null,
        colorToken: input.colorToken ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        kind: true,
        isActive: true,
      },
    })

    return ok(created)
  }
)

/** Edit a tag. `ADMIN` and above. */
export const updateTag = withAction(
  {
    name: 'menu.tags.update',
    auth: 'ADMIN',
    input: tagUpdateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<TagMutationView>> => {
    const existing = await ctx.db.tag.findUnique({
      where: { id: input.id },
      select: { id: true, slug: true, name: true, kind: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That tag is no longer in the vocabulary.')
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const clash = await ctx.db.tag.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      })

      if (clash !== null) {
        return fail('CONFLICT', 'Another tag already uses that handle.', {
          slug: ['Another tag already uses that handle.'],
        })
      }
    }

    const kind = input.kind ?? existing.kind
    const name = input.name ?? existing.name

    if (kind !== existing.kind || name !== existing.name) {
      const clash = await ctx.db.tag.findUnique({
        where: { kind_name: { kind, name } },
        select: { id: true },
      })

      if (clash !== null && clash.id !== existing.id) {
        return fail(
          'CONFLICT',
          'A tag of this kind already carries that name.',
          {
            name: ['A tag of this kind already carries that name.'],
          }
        )
      }
    }

    const updated = await ctx.db.tag.update({
      where: { id: existing.id },
      data: {
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.kind !== undefined && { kind: input.kind }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.colorToken !== undefined && { colorToken: input.colorToken }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        kind: true,
        isActive: true,
      },
    })

    return ok(updated)
  }
)

/**
 * Remove a tag. `ADMIN` and above.
 *
 * Every join onto `Tag` cascades — `MenuItemTag`, `MediaTag`, and
 * `ClientIntakeFormTag`. That last one is the reason this refuses rather than
 * reports: a household's dietary and allergen preferences are stored as tag
 * links, and deleting the "Tree nuts" tag would silently erase an allergy from
 * every intake form that declared it.
 *
 * A tag in use is therefore never deleted. Retire it with
 * {@link updateTag} and `isActive: false`, which keeps every link intact while
 * removing the tag from every picker and every chip.
 */
export const deleteTag = withAction(
  {
    name: 'menu.tags.delete',
    auth: 'ADMIN',
    input: entityIdSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuDeletionView>> => {
    const existing = await ctx.db.tag.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        _count: {
          select: { menuItems: true, media: true, intakePreferences: true },
        },
      },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That tag is no longer in the vocabulary.')
    }

    const inUse =
      existing._count.menuItems +
      existing._count.media +
      existing._count.intakePreferences

    if (inUse > 0) {
      const where: string[] = []

      if (existing._count.menuItems > 0) {
        where.push(`${existing._count.menuItems} dishes`)
      }

      if (existing._count.media > 0) {
        where.push(`${existing._count.media} photographs`)
      }

      if (existing._count.intakePreferences > 0) {
        where.push(
          `${existing._count.intakePreferences} household questionnaires`
        )
      }

      return fail(
        'CONFLICT',
        `“${existing.name}” is still in use on ${formatList(where)}. Retire it instead — a retired tag disappears from every picker while the records that carry it stay intact.`,
        { _references: where }
      )
    }

    await ctx.db.tag.delete({ where: { id: existing.id } })

    return ok({ id: existing.id, name: existing.name, cascaded: 0 })
  }
)

/**
 * Replace the full set of tags on a dish. `ADMIN` and above.
 *
 * An empty list is meaningful and strips every tag. The write is a single
 * transaction so a dish is never briefly untagged, and every tag id is
 * re-read before it is trusted.
 */
export const setMenuItemTags = withAction(
  {
    name: 'menu.items.tags.set',
    auth: 'ADMIN',
    input: menuItemTagAssignmentSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemTagSetView>> => {
    const menuItem = await ctx.db.menuItem.findUnique({
      where: { id: input.menuItemId },
      select: { id: true },
    })

    if (menuItem === null) {
      return fail('NOT_FOUND', 'That dish is no longer on the menu.')
    }

    if (input.tagIds.length > 0) {
      const tags = await ctx.db.tag.findMany({
        where: { id: { in: [...input.tagIds] } },
        select: { id: true },
      })

      if (missingIds(input.tagIds, tags).length > 0) {
        return fail(
          'NOT_FOUND',
          'One of those tags is no longer in the vocabulary. Please refresh and try again.',
          { tagIds: ['One of those tags is no longer in the vocabulary.'] }
        )
      }
    }

    const { attached, detached } = await ctx.db.$transaction(async (tx) => {
      const removed = await tx.menuItemTag.deleteMany({
        where: {
          menuItemId: menuItem.id,
          tagId: { notIn: [...input.tagIds] },
        },
      })

      const added =
        input.tagIds.length === 0
          ? { count: 0 }
          : await tx.menuItemTag.createMany({
              data: input.tagIds.map((tagId) => ({
                menuItemId: menuItem.id,
                tagId,
              })),
              skipDuplicates: true,
            })

      return { attached: added.count, detached: removed.count }
    })

    return ok({
      menuItemId: menuItem.id,
      tagCount: input.tagIds.length,
      attached,
      detached,
    })
  }
)

// =============================================================================
// 11. Pantry
// =============================================================================

/** Create a pantry entry. `ADMIN` and above. */
export const createIngredient = withAction(
  {
    name: 'menu.ingredients.create',
    auth: 'ADMIN',
    input: ingredientCreateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<IngredientMutationView>> => {
    const clash = await ctx.db.ingredient.findFirst({
      where: { OR: [{ slug: input.slug }, { name: input.name }] },
      select: { id: true, slug: true },
    })

    if (clash !== null) {
      return clash.slug === input.slug
        ? fail('CONFLICT', 'Another ingredient already uses that handle.', {
            slug: ['Another ingredient already uses that handle.'],
          })
        : fail(
            'CONFLICT',
            'The pantry already carries an ingredient by that name.',
            {
              name: ['The pantry already carries an ingredient by that name.'],
            }
          )
    }

    const created = await ctx.db.ingredient.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        sourcingNote: input.sourcingNote ?? null,
        isAllergen: input.isAllergen,
        isActive: input.isActive,
        defaultUnit: input.defaultUnit,
        unitCostCents: input.unitCostCents ?? null,
        currency: input.currency,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isAllergen: true,
        isActive: true,
      },
    })

    return ok(created)
  }
)

/** Edit a pantry entry. `ADMIN` and above. */
export const updateIngredient = withAction(
  {
    name: 'menu.ingredients.update',
    auth: 'ADMIN',
    input: ingredientUpdateSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<IngredientMutationView>> => {
    const existing = await ctx.db.ingredient.findUnique({
      where: { id: input.id },
      select: { id: true, slug: true, name: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That ingredient is no longer in the pantry.')
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      const clash = await ctx.db.ingredient.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      })

      if (clash !== null) {
        return fail(
          'CONFLICT',
          'Another ingredient already uses that handle.',
          {
            slug: ['Another ingredient already uses that handle.'],
          }
        )
      }
    }

    if (input.name !== undefined && input.name !== existing.name) {
      const clash = await ctx.db.ingredient.findUnique({
        where: { name: input.name },
        select: { id: true },
      })

      if (clash !== null) {
        return fail(
          'CONFLICT',
          'The pantry already carries an ingredient by that name.',
          { name: ['The pantry already carries an ingredient by that name.'] }
        )
      }
    }

    const updated = await ctx.db.ingredient.update({
      where: { id: existing.id },
      data: {
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.sourcingNote !== undefined && {
          sourcingNote: input.sourcingNote,
        }),
        ...(input.isAllergen !== undefined && { isAllergen: input.isAllergen }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.defaultUnit !== undefined && {
          defaultUnit: input.defaultUnit,
        }),
        ...(input.unitCostCents !== undefined && {
          unitCostCents: input.unitCostCents,
        }),
        ...(input.currency !== undefined && { currency: input.currency }),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isAllergen: true,
        isActive: true,
      },
    })

    return ok(updated)
  }
)

/**
 * Remove a pantry entry. `ADMIN` and above.
 *
 * `MenuItemIngredient.ingredient` is `onDelete: Restrict`. An ingredient that
 * appears in a recipe is refused rather than allowed to break the recipe, and
 * the refusal says how many dishes use it.
 */
export const deleteIngredient = withAction(
  {
    name: 'menu.ingredients.delete',
    auth: 'ADMIN',
    input: entityIdSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuDeletionView>> => {
    const existing = await ctx.db.ingredient.findUnique({
      where: { id: input.id },
      select: { id: true, name: true, _count: { select: { menuItems: true } } },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That ingredient is no longer in the pantry.')
    }

    if (existing._count.menuItems > 0) {
      const noun = existing._count.menuItems === 1 ? 'recipe' : 'recipes'

      return fail(
        'CONFLICT',
        `“${existing.name}” is still listed in ${existing._count.menuItems} ${noun}. Remove it from those first, or retire it instead.`
      )
    }

    await ctx.db.ingredient.delete({ where: { id: existing.id } })

    return ok({ id: existing.id, name: existing.name, cascaded: 0 })
  }
)

/**
 * Replace a dish's entire recipe in one call. `ADMIN` and above.
 *
 * The array order is the reading order; `menuItemIngredientSetSchema` has
 * already filled `sortOrder` from each line's position where it was not given,
 * and has already refused a recipe that lists the same ingredient twice.
 */
export const setMenuItemIngredients = withAction(
  {
    name: 'menu.items.ingredients.set',
    auth: 'ADMIN',
    input: menuItemIngredientSetSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemIngredientSetView>> => {
    const menuItem = await ctx.db.menuItem.findUnique({
      where: { id: input.menuItemId },
      select: { id: true },
    })

    if (menuItem === null) {
      return fail('NOT_FOUND', 'That dish is no longer on the menu.')
    }

    const ingredientIds = input.ingredients.map((line) => line.ingredientId)

    if (ingredientIds.length > 0) {
      const ingredients = await ctx.db.ingredient.findMany({
        where: { id: { in: ingredientIds } },
        select: { id: true },
      })

      if (missingIds(ingredientIds, ingredients).length > 0) {
        return fail(
          'NOT_FOUND',
          'One of those ingredients is no longer in the pantry. Please refresh and try again.',
          {
            ingredients: [
              'One of those ingredients is no longer in the pantry.',
            ],
          }
        )
      }
    }

    await ctx.db.$transaction(async (tx) => {
      await tx.menuItemIngredient.deleteMany({
        where: { menuItemId: menuItem.id },
      })

      if (input.ingredients.length === 0) {
        return
      }

      await tx.menuItemIngredient.createMany({
        data: input.ingredients.map((line) => ({
          menuItemId: menuItem.id,
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          unit: line.unit,
          preparation: line.preparation ?? null,
          isOptional: line.isOptional,
          isGarnish: line.isGarnish,
          sortOrder: line.sortOrder,
        })),
      })
    })

    return ok({
      menuItemId: menuItem.id,
      ingredientCount: input.ingredients.length,
    })
  }
)

// =============================================================================
// 12. Gallery
// =============================================================================

/**
 * Set the full gallery for a dish, in order, with exactly one lead image.
 * `ADMIN` and above.
 *
 * "Exactly one" is enforced three times over, and deliberately so:
 *
 *  1. `menuItemMediaAssociationSchema` refuses a payload with zero or two lead
 *     photographs before the handler is ever entered;
 *  2. the lead is required to be an `IMAGE` — a video may sit in a gallery, but
 *     it is not the still a dish is remembered by, and every card and Open Graph
 *     tag renders the lead as an image;
 *  3. the count is re-read *inside* the transaction after the rows are written,
 *     and a disagreement throws an `ActionError`, which rolls the whole
 *     replacement back rather than leaving a gallery with no lead.
 *
 * The third looks redundant next to the first, and it is — right up until
 * somebody adds a second writer, or relaxes the schema. It costs one `count`
 * inside a transaction that is already open.
 */
export const setMenuItemMedia = withAction(
  {
    name: 'menu.items.media.set',
    auth: 'ADMIN',
    input: menuItemMediaAssociationSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemMediaSetView>> => {
    const menuItem = await ctx.db.menuItem.findUnique({
      where: { id: input.menuItemId },
      select: { id: true },
    })

    if (menuItem === null) {
      return fail('NOT_FOUND', 'That dish is no longer on the menu.')
    }

    const mediaAssetIds = input.media.map((entry) => entry.mediaAssetId)
    const kinds = await readMediaAssetKinds(ctx.db, mediaAssetIds)

    const missing = mediaAssetIds.filter((id) => !kinds.has(id))

    if (missing.length > 0) {
      return fail(
        'NOT_FOUND',
        'One of those photographs is no longer in the library. Please refresh and try again.',
        { media: ['One of those photographs is no longer in the library.'] }
      )
    }

    const lead = input.media.find((entry) => entry.isPrimary)

    if (lead === undefined) {
      return fail(
        'VALIDATION',
        'Choose exactly one lead photograph — it is the image the dish is remembered by.',
        {
          media: [
            'Choose exactly one lead photograph — it is the image the dish is remembered by.',
          ],
        }
      )
    }

    if (kinds.get(lead.mediaAssetId) !== 'IMAGE') {
      return fail(
        'VALIDATION',
        'The lead photograph has to be a still image. Choose one, and keep the film alongside it.',
        {
          media: ['The lead photograph has to be a still image.'],
        }
      )
    }

    await ctx.db.$transaction(async (tx) => {
      await tx.menuItemMedia.deleteMany({ where: { menuItemId: menuItem.id } })

      await tx.menuItemMedia.createMany({
        data: input.media.map((entry) => ({
          menuItemId: menuItem.id,
          mediaAssetId: entry.mediaAssetId,
          sortOrder: entry.sortOrder,
          isPrimary: entry.isPrimary,
          caption: entry.caption ?? null,
        })),
      })

      const leadCount = await tx.menuItemMedia.count({
        where: { menuItemId: menuItem.id, isPrimary: true },
      })

      if (leadCount !== 1) {
        // Rolls the replacement back. `ActionError` is the one throw a handler
        // is allowed, and `withAction` forwards its code and sentence verbatim.
        throw new ActionError(
          'CONFLICT',
          'This gallery ended up without exactly one lead photograph, so nothing was saved. Please try again.'
        )
      }
    })

    return ok({
      menuItemId: menuItem.id,
      mediaCount: input.media.length,
      primaryMediaAssetId: lead.mediaAssetId,
    })
  }
)

// =============================================================================
// 13. Bulk curation
// =============================================================================

/**
 * Apply one bulk action to a selection of dishes. `ADMIN` and above.
 *
 * `menuItemBulkActionSchema` is a discriminated union, so each branch below
 * receives exactly the arguments its action needs and nothing more — and the
 * `default` clause is a compile error if a new action is added to the union
 * without being handled here.
 *
 * Every branch begins the same way: the selected ids are re-read, and a
 * selection naming even one dish that has since been deleted fails as a whole.
 * A bulk write that half-applies is worse than one that does not apply.
 */
export const runMenuItemBulkAction = withAction(
  {
    name: 'menu.items.bulk',
    auth: 'ADMIN',
    input: menuItemBulkActionSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuItemBulkResultView>> => {
    const selected = await ctx.db.menuItem.findMany({
      where: { id: { in: [...input.menuItemIds] } },
      select: { id: true },
    })

    if (missingIds(input.menuItemIds, selected).length > 0) {
      return fail(
        'NOT_FOUND',
        'One of the selected dishes is no longer on the menu. Please refresh and try again.'
      )
    }

    const ids = selected.map((row) => row.id)
    const scope: Prisma.MenuItemWhereInput = { id: { in: ids } }

    switch (input.action) {
      case 'PUBLISH': {
        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: { isActive: true },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'UNPUBLISH': {
        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: { isActive: false },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'MARK_SIGNATURE': {
        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: { isSignature: true },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'UNMARK_SIGNATURE': {
        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: { isSignature: false },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'SET_SPICE_LEVEL': {
        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: { spiceLevel: input.spiceLevel },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'SET_SEASONAL': {
        const season = normalizedSeason(
          input.isSeasonal,
          input.seasonStart,
          input.seasonEnd
        )

        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: {
            isSeasonal: input.isSeasonal,
            seasonStart: season.seasonStart,
            seasonEnd: season.seasonEnd,
          },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'MOVE_TO_CATEGORY': {
        const pair = await validateCategoryPair(
          ctx.db,
          input.categoryId,
          input.subcategoryId ?? null
        )

        if (!pair.ok) {
          return pair
        }

        const result = await ctx.db.menuItem.updateMany({
          where: scope,
          data: {
            categoryId: input.categoryId,
            subcategoryId: input.subcategoryId ?? null,
          },
        })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      case 'ADD_TAGS': {
        const tags = await ctx.db.tag.findMany({
          where: { id: { in: [...input.tagIds] } },
          select: { id: true },
        })

        if (missingIds(input.tagIds, tags).length > 0) {
          return fail(
            'NOT_FOUND',
            'One of those tags is no longer in the vocabulary. Please refresh and try again.',
            { tagIds: ['One of those tags is no longer in the vocabulary.'] }
          )
        }

        const links = await ctx.db.menuItemTag.createMany({
          data: ids.flatMap((menuItemId) =>
            input.tagIds.map((tagId) => ({ menuItemId, tagId }))
          ),
          skipDuplicates: true,
        })

        return ok({
          action: input.action,
          affected: ids.length,
          links: links.count,
        })
      }

      case 'REMOVE_TAGS': {
        const links = await ctx.db.menuItemTag.deleteMany({
          where: {
            menuItemId: { in: ids },
            tagId: { in: [...input.tagIds] },
          },
        })

        return ok({
          action: input.action,
          affected: ids.length,
          links: links.count,
        })
      }

      case 'DELETE': {
        // `confirm: true` has already been proved by the schema. What it cannot
        // prove is that none of these dishes has been served — that is
        // `onDelete: Restrict` on `AppointmentMenuItem`, and it is read here so
        // the refusal is a sentence rather than a foreign key violation.
        const served = await ctx.db.appointmentMenuItem.findMany({
          where: { menuItemId: { in: ids } },
          distinct: ['menuItemId'],
          select: { menuItem: { select: { name: true } } },
          take: 5,
        })

        if (served.length > 0) {
          const names = served.map((row) => `“${row.menuItem.name}”`)

          return fail(
            'CONFLICT',
            `${formatList(names)} ${served.length === 1 ? 'has' : 'have'} been served at a past engagement, so nothing was removed. Take those dishes off the menu instead and try again with the rest.`,
            { _references: names }
          )
        }

        const result = await ctx.db.menuItem.deleteMany({ where: scope })

        return ok({ action: input.action, affected: result.count, links: 0 })
      }

      default: {
        // A new member of `menuItemBulkActionSchema` is a compile error here
        // rather than a silently ignored bulk request.
        const exhaustive: never = input
        return exhaustive
      }
    }
  }
)

// =============================================================================
// 14. Reordering
// =============================================================================

/**
 * Renumber one curated ladder. `ADMIN` and above.
 *
 * A drag-and-drop save hands back every position it touched, and all of them are
 * written inside a single transaction so the list is never briefly ambiguous.
 * Ids are re-read first: a payload naming a row that has been deleted since the
 * page rendered fails as a whole rather than renumbering the survivors into an
 * order nobody chose.
 */
export const reorderMenuEntries = withAction(
  {
    name: 'menu.reorder',
    auth: 'ADMIN',
    input: menuReorderSchema,
    revalidatePaths: MENU_REVALIDATE_PATHS,
    revalidateTags: MENU_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MenuReorderView>> => {
    const ids = input.entries.map((entry) => entry.id)

    const found =
      input.scope === 'CATEGORY'
        ? await ctx.db.menuCategory.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
        : input.scope === 'SUBCATEGORY'
          ? await ctx.db.menuSubcategory.findMany({
              where: { id: { in: ids } },
              select: { id: true },
            })
          : input.scope === 'MENU_ITEM'
            ? await ctx.db.menuItem.findMany({
                where: { id: { in: ids } },
                select: { id: true },
              })
            : await ctx.db.tag.findMany({
                where: { id: { in: ids } },
                select: { id: true },
              })

    if (missingIds(ids, found).length > 0) {
      return fail(
        'NOT_FOUND',
        'Part of that list has changed since the page loaded, so nothing was moved. Please refresh and try again.'
      )
    }

    await ctx.db.$transaction(
      input.entries.map((entry) => {
        const where = { id: entry.id }
        const data = { sortOrder: entry.sortOrder }

        switch (input.scope) {
          case 'CATEGORY':
            return ctx.db.menuCategory.update({ where, data })

          case 'SUBCATEGORY':
            return ctx.db.menuSubcategory.update({ where, data })

          case 'MENU_ITEM':
            return ctx.db.menuItem.update({ where, data })

          case 'TAG':
            return ctx.db.tag.update({ where, data })

          default: {
            const exhaustive: never = input.scope
            return exhaustive
          }
        }
      })
    )

    return ok({ scope: input.scope, moved: input.entries.length })
  }
)
