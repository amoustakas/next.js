// mannachef/apps/web/src/app/(admin)/admin/menu/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ServerCrash, ShieldAlert } from 'lucide-react'

import {
  MAX_PAGE_SIZE,
  menuItemFilterSchema,
  type MenuItemFilterInput,
  type TagKind,
} from '@mannachef/validators'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { MenuTable } from '@/components/admin/menu/menu-table'
import {
  listMenuCategories,
  listMenuItems,
  listTags,
} from '@/server/actions/menu'

export const metadata: Metadata = {
  title: 'Menu Engine',
}

/** The shape Next hands every server component under `app/`: strings, or an
 *  array when a key is repeated (`?tagSlugs=vegan&tagSlugs=nut-free`). */
type RawSearchParams = Record<string, string | string[] | undefined>

interface MenuEnginePageProps {
  readonly searchParams: Promise<RawSearchParams>
}

/** A collection, offered as a filter choice. */
interface MenuCategoryOption {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly isActive: boolean
}

/** A tag, offered as a filter choice. */
interface MenuTagOption {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: TagKind
  readonly isActive: boolean
}

/** Always the first of a possibly-repeated query key. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** `undefined` stays `undefined` (no filter); a lone string becomes a
 *  one-element array, so a single `?tagSlugs=vegan` parses the same way a
 *  repeated key would. */
function listOf(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Turns the address bar into `MenuItemFilterInput`.
 *
 * The query keys are the filter schema's own field names, so a linked view
 * (`/admin/menu?categorySlug=mains&sortBy=PRICE`) is legible on its own and
 * `menuItemFilterSchema` never has to be shadowed by a second mapping layer.
 *
 * `includeInactive` defaults to `true` here rather than the schema's own
 * `false` — this is the Menu Engine, not the public menu, and an admin who
 * has taken a dish off the menu still needs to find it. The action re-checks
 * the caller's role before honouring the flag either way, so this default
 * can never widen what a lower-privileged viewer of this same route sees.
 *
 * A malformed or tampered query string degrades to the default admin view
 * instead of failing the page — the address bar is not a trusted input.
 */
function parseMenuItemFilters(raw: RawSearchParams): MenuItemFilterInput {
  const candidate: Record<string, unknown> = {
    page: firstOf(raw.page),
    pageSize: firstOf(raw.pageSize),
    sortDirection: firstOf(raw.sortDirection),
    sortBy: firstOf(raw.sortBy),
    search: firstOf(raw.search),
    categorySlug: firstOf(raw.categorySlug),
    subcategorySlug: firstOf(raw.subcategorySlug),
    tagSlugs: listOf(raw.tagSlugs),
    tagMatchMode: firstOf(raw.tagMatchMode),
    priceCentsMin: firstOf(raw.priceCentsMin),
    priceCentsMax: firstOf(raw.priceCentsMax),
    seasonalOnly: firstOf(raw.seasonalOnly),
    signatureOnly: firstOf(raw.signatureOnly),
    includeInactive:
      raw.includeInactive === undefined ? 'true' : firstOf(raw.includeInactive),
  }

  const parsed = menuItemFilterSchema.safeParse(candidate)
  if (parsed.success) {
    return parsed.data
  }

  return menuItemFilterSchema.parse({ includeInactive: 'true' })
}

/**
 * Copy for every `ActionErrorCode` a read can come back with, so a denied
 * request never falls through to a generic "something went wrong" — in
 * particular `FORBIDDEN`, which reads as a permissions problem the viewer can
 * act on rather than as a fault in the Menu Engine itself.
 */
function menuListFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to manage the menu.",
        description:
          'This account is signed in, but its role is too low for the Menu Engine. Ask an admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to keep managing the menu.',
        isAccessIssue: true,
      }
    case 'VALIDATION':
      return {
        title: "Those filters don't add up.",
        description:
          'Something in the address bar is not a valid filter. Clear the filters and try again.',
        isAccessIssue: false,
      }
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests, too quickly.',
        description: 'Wait a moment and refresh the page.',
        isAccessIssue: false,
      }
    case 'NOT_FOUND':
      return {
        title: 'That view of the menu could not be found.',
        description: 'Clear the filters and try again.',
        isAccessIssue: false,
      }
    case 'CONFLICT':
      return {
        title: 'The menu changed while this loaded.',
        description: 'Refresh the page to see the latest.',
        isAccessIssue: false,
      }
    default:
      return {
        title: 'The menu could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

/**
 * The Menu Engine list.
 *
 * A Server Component. The filter, sort and page live in `searchParams`, so
 * any view — a search term, a collection, a page two dishes deep — is a real,
 * linkable address rather than client state that evaporates on refresh.
 *
 * Three reads run together: the dishes themselves, and the two option lists
 * (`listMenuCategories`, `listTags`) the client `<MenuTable>` needs for its
 * own filter controls. `includeInactive: true` on both option reads is
 * deliberate — a dish still tagged with a collection or tag that has since
 * been retired must keep resolving to a real name in the filter UI, not a
 * blank.
 *
 * Every interactive control — the filter inputs, sorting, pagination,
 * mutations — lives inside `<MenuTable>`, a client component. This page
 * itself renders nothing that needs `'use client'`.
 */
export default async function MenuEnginePage({
  searchParams,
}: MenuEnginePageProps): Promise<React.JSX.Element> {
  const filters = parseMenuItemFilters(await searchParams)

  const [itemsResult, categoriesResult, tagsResult] = await Promise.all([
    listMenuItems(filters),
    listMenuCategories({
      page: 1,
      pageSize: MAX_PAGE_SIZE,
      sortBy: 'NAME',
      sortDirection: 'asc',
      includeInactive: true,
    }),
    listTags({
      page: 1,
      pageSize: MAX_PAGE_SIZE,
      sortBy: 'NAME',
      sortDirection: 'asc',
      includeInactive: true,
    }),
  ])

  // Category and tag options are conveniences for the filter rail, not the
  // point of the page — a failed read degrades to an empty option list
  // rather than blocking the dish table.
  const categoryOptions: readonly MenuCategoryOption[] = categoriesResult.ok
    ? categoriesResult.data.items.map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        isActive: category.isActive,
      }))
    : []

  const tagOptions: readonly MenuTagOption[] = tagsResult.ok
    ? tagsResult.data.items.map((tag) => ({
        id: tag.id,
        slug: tag.slug,
        name: tag.name,
        kind: tag.kind,
        isActive: tag.isActive,
      }))
    : []

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          Menu Engine
        </p>
        <h1
          id="menu-engine-heading"
          className="font-display text-3xl font-light tracking-tight text-linen"
        >
          Every dish, one ledger
        </h1>
        <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          Collections, dishes, tags and seasonality — the single record the
          public menu, the client portal and the kitchen all read from.
        </p>
      </header>

      <section aria-labelledby="menu-engine-heading">
        {itemsResult.ok ? (
          <MenuTable
            rows={itemsResult.data.items}
            meta={itemsResult.data.meta}
            filters={filters}
            categoryOptions={categoryOptions}
            tagOptions={tagOptions}
          />
        ) : (
          <MenuListFailure
            code={itemsResult.code}
            message={itemsResult.error}
          />
        )}
      </section>
    </div>
  )
}

function MenuListFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}): React.JSX.Element {
  const copy = menuListFailureCopy(code)

  return (
    <EmptyState
      tone="error"
      icon={copy.isAccessIssue ? ShieldAlert : ServerCrash}
      headingLevel={2}
      title={copy.title}
      description={
        <>
          {copy.description}
          {message.length > 0 && message !== copy.description ? (
            <span className="mt-2 block text-xs text-stone">{message}</span>
          ) : null}
        </>
      }
      action={
        copy.isAccessIssue ? (
          <Button asChild variant="outline">
            <Link href="/admin">Return to the dashboard</Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/admin/menu">Try again</Link>
          </Button>
        )
      }
    />
  )
}
