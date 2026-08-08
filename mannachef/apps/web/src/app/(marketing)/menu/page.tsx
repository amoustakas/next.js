// mannachef/apps/web/src/app/(marketing)/menu/page.tsx
import * as React from 'react'
import { Suspense } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, SearchX } from 'lucide-react'

import type { MenuItemFilterRawInput, TagKind } from '@mannachef/validators'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { DishCard } from '@/components/marketing/dish-card'
import {
  activeFilterCount,
  menuFilterHref,
  MENU_PAGE_SIZE,
  parseMenuFilters,
  type MenuFilterState,
  type RawSearchParams,
} from '@/components/marketing/menu-filter-state'
import {
  MenuFilters,
  type MenuFilterOption,
  type MenuSubcategoryOption,
  type MenuTagGroup,
} from '@/components/marketing/menu-filters'
import { TAG_KIND_LABELS } from '@/components/marketing/menu-format'
import {
  DishGridSkeleton,
  FilterPanelSkeleton,
} from '@/components/marketing/menu-skeletons'
import { ReadFailure } from '@/components/marketing/read-failure'
import {
  listMenuCategories,
  listMenuItems,
  listMenuSubcategories,
  listTags,
} from '@/server/actions/menu'

/**
 * The menu.
 *
 * A Server Component. The filter lives in `searchParams`, which means every
 * filtered view is a real address: `/menu?category=mains&tag=vegetarian&season=1`
 * can be bookmarked, sent to the person you are cooking for, opened in a second
 * tab, and reached with the back button. Filter state in `useState` can do none
 * of those things, and would additionally require the dish grid to be fetched
 * again on the client after hydration.
 *
 * The one client island is `<MenuFilters>`, and its entire job is to write a new
 * URL. It never fetches, never renders a dish, and holds no copy of the applied
 * filter.
 *
 * ## Streaming
 *
 * Three boundaries, in the order the guest needs them:
 *
 *  1. The page header is static markup and flushes immediately.
 *  2. `<Suspense>` around the filter panel, which needs the collections, courses
 *     and dietary tags — three reads that are unrelated to the dish query.
 *  3. `<Suspense>` around the grid, keyed on the serialised filter so a new
 *     filter genuinely re-suspends rather than showing the previous page's
 *     dishes under the new heading.
 *
 * Neither boundary blocks the other, so a slow tag query cannot delay the
 * dishes.
 *
 * ## Revalidation
 *
 * Fifteen minutes. The menu is the most volatile public page — a dish is
 * published, a price moves, a season closes — and every one of those mutations
 * already invalidates `/menu` through `MENU_REVALIDATE_PATHS` in
 * `server/actions/menu.ts`. Fifteen minutes is the ceiling on how stale a
 * *missed* invalidation can leave it, chosen short because a guest reading a
 * price we no longer charge is a conversation we would rather not have, and
 * chosen no shorter because seasonality turns over monthly, not by the minute.
 */
export const revalidate = 900

export const metadata: Metadata = {
  title: 'The menu',
  description:
    'Every dish MannaChef is cooking this season, filterable by collection, course, dietary requirement and what is in season right now.',
  alternates: { canonical: '/menu' },
  openGraph: {
    title: 'The menu · MannaChef',
    description:
      'Every dish MannaChef is cooking this season — filter by collection, course, dietary requirement and seasonality.',
    url: '/menu',
  },
}

/** Which kinds of tag a guest may filter by. */
const FILTERABLE_TAG_KINDS: readonly TagKind[] = ['DIETARY']

interface MenuPageProps {
  readonly searchParams: Promise<RawSearchParams>
}

export default async function MenuPage({
  searchParams,
}: MenuPageProps): Promise<React.JSX.Element> {
  const filters = parseMenuFilters(await searchParams)
  const filterKey = menuFilterHref(filters)

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <header className="max-w-2xl">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          Cooking now
        </p>
        <h1 className="mt-4 font-display text-4xl leading-tight font-light tracking-tight text-linen text-balance sm:text-5xl">
          The menu
        </h1>
        <p className="mt-6 font-sans text-base leading-relaxed text-parchment">
          These are the dishes we are cooking this season. Nothing here is a
          fixed package — a menu for your household is drawn from this list and
          from what is good the week we shop for you.
        </p>
      </header>

      <div aria-hidden="true" className="hairline mt-12" />

      <div className="mt-12 grid gap-10 lg:grid-cols-[18rem_1fr] lg:gap-14">
        <Suspense fallback={<FilterPanelSkeleton />}>
          <FilterPanel filters={filters} />
        </Suspense>

        <div>
          <Suspense key={filterKey} fallback={<DishGridSkeleton count={6} />}>
            <MenuResults filters={filters} />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

/**
 * The filter rail's data.
 *
 * Three public reads, issued together rather than in sequence — they do not
 * depend on one another and running them serially would cost three round trips
 * for no reason. All three are `auth: 'PUBLIC'` and all three already exclude
 * unpublished rows for a caller below `CHEF_STAFF`, so nothing here filters for
 * visibility and nothing here could widen it.
 *
 * A failure in any one of them degrades to a rail without that control rather
 * than a page without a menu: the dishes are the point, and the filters are a
 * convenience. That is the one place on this page where a silent partial result
 * is the right answer.
 */
async function FilterPanel({
  filters,
}: {
  readonly filters: MenuFilterState
}): Promise<React.JSX.Element> {
  const [categoriesResult, subcategoriesResult, tagsResult] = await Promise.all([
    listMenuCategories({
      page: 1,
      pageSize: 100,
      sortBy: 'CURATED',
      sortDirection: 'asc',
    }),
    listMenuSubcategories({
      page: 1,
      pageSize: 100,
      sortBy: 'CURATED',
      sortDirection: 'asc',
    }),
    listTags({
      page: 1,
      pageSize: 100,
      kinds: [...FILTERABLE_TAG_KINDS],
      sortBy: 'CURATED',
      sortDirection: 'asc',
    }),
  ])

  const categories: MenuFilterOption[] = categoriesResult.ok
    ? categoriesResult.data.items.map((category) => ({
        slug: category.slug,
        name: category.name,
      }))
    : []

  const subcategories: MenuSubcategoryOption[] = subcategoriesResult.ok
    ? subcategoriesResult.data.items.map((subcategory) => ({
        slug: subcategory.slug,
        name: subcategory.name,
        categorySlug: subcategory.categorySlug,
      }))
    : []

  const tagGroups: MenuTagGroup[] = tagsResult.ok
    ? FILTERABLE_TAG_KINDS.map((kind) => ({
        kind,
        label: TAG_KIND_LABELS[kind],
        tags: tagsResult.data.items
          .filter((tag) => tag.kind === kind)
          .map((tag) => ({ slug: tag.slug, name: tag.name })),
      })).filter((group) => group.tags.length > 0)
    : []

  return (
    <MenuFilters
      filters={filters}
      categories={categories}
      subcategories={subcategories}
      tagGroups={tagGroups}
    />
  )
}

/**
 * The dishes themselves.
 *
 * The raw filter is assembled with conditional spreads rather than by assigning
 * `undefined`: `exactOptionalPropertyTypes` is on, and `{ categorySlug:
 * undefined }` is not the same type as `{}` — nor the same value, since
 * `menuItemFilterSchema` is `.strict()` about the keys it accepts.
 */
async function MenuResults({
  filters,
}: {
  readonly filters: MenuFilterState
}): Promise<React.JSX.Element> {
  const raw: MenuItemFilterRawInput = {
    page: filters.page,
    pageSize: MENU_PAGE_SIZE,
    sortBy: 'CURATED',
    sortDirection: 'asc',
    tagMatchMode: 'ALL',
    tagSlugs: [...filters.tagSlugs],
    seasonalOnly: filters.seasonalOnly,
    ...(filters.categorySlug === null
      ? {}
      : { categorySlug: filters.categorySlug }),
    ...(filters.subcategorySlug === null
      ? {}
      : { subcategorySlug: filters.subcategorySlug }),
    ...(filters.search === null ? {} : { search: filters.search }),
  }

  const result = await listMenuItems(raw)

  if (!result.ok) {
    return (
      <ReadFailure failure={result} subject="this season's menu" headingLevel={2} />
    )
  }

  const { items, meta } = result.data
  const isFiltered = activeFilterCount(filters) > 0

  if (items.length === 0) {
    return isFiltered ? (
      <EmptyState
        tone="filtered"
        icon={SearchX}
        headingLevel={2}
        title="Nothing on the menu matches all of that."
        description="Every tag you choose has to be on the dish, so a narrow combination can come back empty. Try removing one, or clear the filters to see the whole menu."
        action={
          <Button asChild variant="outline">
            <Link href="/menu">Clear the filters</Link>
          </Button>
        }
      />
    ) : (
      <EmptyState
        headingLevel={2}
        title="The menu is between seasons."
        description="Nothing is published right now. Ask for a consultation and we will tell you what the kitchen is working on."
        action={
          <Button asChild variant="champagne">
            <Link href="/contact">Request a consultation</Link>
          </Button>
        }
      />
    )
  }

  const firstOnPage = (meta.page - 1) * meta.pageSize + 1
  const lastOnPage = Math.min(meta.page * meta.pageSize, meta.total)

  return (
    <div className="flex flex-col gap-10">
      {/*
        `aria-live` sits on the wrapper rather than on the heading itself. A
        `role="status"` on an `<h2>` *replaces* its heading semantics — the
        element would vanish from the document outline and stop being reachable
        by heading navigation, which is a poor trade for an announcement. On the
        wrapper, the count is announced when a filter changes it and the heading
        stays a heading.
      */}
      <div aria-live="polite" aria-atomic="true">
        <h2 className="font-sans text-sm text-parchment">
          <span className="tabular-nums">
            {String(firstOnPage)}–{String(lastOnPage)}
          </span>{' '}
          of{' '}
          <span className="tabular-nums text-linen">{String(meta.total)}</span>{' '}
          {meta.total === 1 ? 'dish' : 'dishes'}
          {isFiltered ? ' matching your filters' : ' on the menu'}.
        </h2>
      </div>

      <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((dish, index) => (
          <li key={dish.id}>
            <DishCard
              dish={dish}
              headingLevel={3}
              priority={meta.page === 1 && index < 3}
              imageSizes="(min-width: 1280px) 20rem, (min-width: 640px) 40vw, 92vw"
            />
          </li>
        ))}
      </ul>

      {meta.pageCount > 1 ? (
        <MenuPagination
          filters={filters}
          page={meta.page}
          pageCount={meta.pageCount}
          hasNextPage={meta.hasNextPage}
          hasPreviousPage={meta.hasPreviousPage}
        />
      ) : null}
    </div>
  )
}

/**
 * Page-to-page navigation, as real links.
 *
 * Anchors rather than buttons, because each one genuinely addresses a different
 * page: a guest can open page three in a new tab, and a crawler can walk the
 * whole menu. A `<button onClick={router.push}>` would forfeit both and would
 * require a client component to render a static list.
 */
function MenuPagination({
  filters,
  page,
  pageCount,
  hasNextPage,
  hasPreviousPage,
}: {
  readonly filters: MenuFilterState
  readonly page: number
  readonly pageCount: number
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
}): React.JSX.Element {
  return (
    <nav
      aria-label="Menu pages"
      className="flex items-center justify-between gap-4 border-t border-ash/70 pt-8"
    >
      {hasPreviousPage ? (
        <Button asChild variant="outline">
          <Link
            href={menuFilterHref({ ...filters, page: page - 1 })}
            rel="prev"
          >
            <ChevronLeft aria-hidden="true" />
            Previous
          </Link>
        </Button>
      ) : (
        <span />
      )}

      <p className="font-sans text-sm text-stone tabular-nums">
        Page {String(page)} of {String(pageCount)}
      </p>

      {hasNextPage ? (
        <Button asChild variant="outline">
          <Link
            href={menuFilterHref({ ...filters, page: page + 1 })}
            rel="next"
          >
            Next
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <span />
      )}
    </nav>
  )
}
