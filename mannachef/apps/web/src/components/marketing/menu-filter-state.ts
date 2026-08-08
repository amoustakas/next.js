// mannachef/apps/web/src/components/marketing/menu-filter-state.ts

import type { Route } from 'next'

import { MAX_FILTER_TAGS } from '@mannachef/validators'

/**
 * The menu's filter state, which lives in the URL and nowhere else.
 *
 * This is the single most consequential decision on the public site, so it is
 * worth stating plainly: a filtered menu is a *page*, not a component state.
 * Holding "vegetarian starters, in season" in `useState` would mean the view a
 * guest wants to send to the person they are cooking for cannot be sent, the
 * back button would not undo a filter, a refresh would discard the selection,
 * and the server could not render the result — every dish card would have to be
 * fetched again on the client after hydration.
 *
 * So: the URL is the state. The page is a Server Component that reads
 * `searchParams`, the island below only ever *writes* to the URL, and the
 * router re-renders the server tree with the new query. Nothing is duplicated
 * into a store.
 *
 * No `'use client'` — these helpers parse on the server and serialise on the
 * client, and both halves must agree exactly or a round trip would lose a
 * filter.
 */

/** The query-string keys. Short, because guests see and share these. */
export const MENU_QUERY_KEYS = {
  category: 'category',
  subcategory: 'subcategory',
  /** Repeated once per selected tag: `?tag=vegetarian&tag=nut-free`. */
  tag: 'tag',
  season: 'season',
  search: 'q',
  page: 'page',
} as const

/** How many dishes one page of the menu shows. */
export const MENU_PAGE_SIZE = 12

/** The parsed, normalised filter. Every field is present; absence is `null`. */
export interface MenuFilterState {
  readonly categorySlug: string | null
  readonly subcategorySlug: string | null
  readonly tagSlugs: readonly string[]
  readonly seasonalOnly: boolean
  readonly search: string | null
  readonly page: number
}

/** The empty menu — everything the kitchen is cooking, page one. */
export const EMPTY_MENU_FILTERS: MenuFilterState = {
  categorySlug: null,
  subcategorySlug: null,
  tagSlugs: [],
  seasonalOnly: false,
  search: null,
  page: 1,
}

/** What Next hands a page as `searchParams`, once awaited. */
export type RawSearchParams = Record<string, string | string[] | undefined>

/** First value for a key that may have been repeated. */
function firstValue(raw: string | string[] | undefined): string | null {
  if (raw === undefined) {
    return null
  }

  if (Array.isArray(raw)) {
    const head = raw[0]
    return head === undefined || head.length === 0 ? null : head
  }

  return raw.length === 0 ? null : raw
}

/** Every value for a key, flattened and de-duplicated in first-seen order. */
function allValues(raw: string | string[] | undefined): string[] {
  if (raw === undefined) {
    return []
  }

  const list = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  const result: string[] = []

  for (const entry of list) {
    const trimmed = entry.trim()

    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

/**
 * Read a filter out of `searchParams`.
 *
 * Deliberately forgiving. A query string is user-editable and crawler-editable,
 * so `?page=banana` must render page one rather than a validation error — the
 * *action* is where a bad value is rejected, and `menuItemFilterSchema` is what
 * rejects it. This function's job is only to stop obvious nonsense reaching it.
 *
 * `tagSlugs` is capped at `MAX_FILTER_TAGS`, the same ceiling
 * `menuItemFilterSchema` enforces, so a hand-crafted URL with fifty tags
 * renders twenty rather than failing the whole read.
 */
export function parseMenuFilters(
  searchParams: RawSearchParams
): MenuFilterState {
  const rawPage = firstValue(searchParams[MENU_QUERY_KEYS.page])
  const parsedPage = rawPage === null ? Number.NaN : Number.parseInt(rawPage, 10)
  const page =
    Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.trunc(parsedPage) : 1

  const season = firstValue(searchParams[MENU_QUERY_KEYS.season])
  const search = firstValue(searchParams[MENU_QUERY_KEYS.search])

  return {
    categorySlug: firstValue(searchParams[MENU_QUERY_KEYS.category]),
    subcategorySlug: firstValue(searchParams[MENU_QUERY_KEYS.subcategory]),
    tagSlugs: allValues(searchParams[MENU_QUERY_KEYS.tag]).slice(
      0,
      MAX_FILTER_TAGS
    ),
    seasonalOnly: season === '1' || season === 'true',
    search: search === null ? null : search.trim().slice(0, 120),
    page,
  }
}

/**
 * Serialise a filter back into a shareable `/menu` address.
 *
 * Page one is written as *no* `page` key rather than `page=1`, so the canonical
 * menu address stays `/menu` and a crawler is not handed two URLs for one page.
 * The keys are emitted in a fixed order for the same reason: two identical
 * filters must produce one identical string.
 */
export function menuFilterHref(state: MenuFilterState): Route {
  const params = new URLSearchParams()

  if (state.categorySlug !== null) {
    params.set(MENU_QUERY_KEYS.category, state.categorySlug)
  }

  if (state.subcategorySlug !== null) {
    params.set(MENU_QUERY_KEYS.subcategory, state.subcategorySlug)
  }

  for (const slug of state.tagSlugs) {
    params.append(MENU_QUERY_KEYS.tag, slug)
  }

  if (state.seasonalOnly) {
    params.set(MENU_QUERY_KEYS.season, '1')
  }

  if (state.search !== null && state.search.length > 0) {
    params.set(MENU_QUERY_KEYS.search, state.search)
  }

  if (state.page > 1) {
    params.set(MENU_QUERY_KEYS.page, String(state.page))
  }

  const query = params.toString()

  return query.length === 0 ? '/menu' : `/menu?${query}`
}

/**
 * Apply a partial change and return to page one.
 *
 * Every filter change resets pagination, because "page 4 of everything" and
 * "page 4 of the six vegetarian starters" are not the same page, and landing on
 * an empty page four is the classic way a filtered list appears broken.
 */
export function withMenuFilters(
  state: MenuFilterState,
  patch: Partial<MenuFilterState>
): MenuFilterState {
  return { ...state, ...patch, page: patch.page ?? 1 }
}

/** How many filters are switched on — for the "Clear" button and the count. */
export function activeFilterCount(state: MenuFilterState): number {
  return (
    (state.categorySlug === null ? 0 : 1) +
    (state.subcategorySlug === null ? 0 : 1) +
    state.tagSlugs.length +
    (state.seasonalOnly ? 1 : 0) +
    (state.search === null || state.search.length === 0 ? 0 : 1)
  )
}
