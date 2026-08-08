// mannachef/apps/web/src/components/marketing/menu-filters.tsx
'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Search, X } from 'lucide-react'

import type { TagKind } from '@mannachef/validators'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CheckboxField } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  activeFilterCount,
  menuFilterHref,
  withMenuFilters,
  type MenuFilterState,
} from '@/components/marketing/menu-filter-state'

/**
 * The menu's filter controls — the one client island on `/menu`.
 *
 * ## What it is allowed to own
 *
 * Almost nothing. It holds the search box's uncommitted keystrokes and a
 * `useTransition` pending flag, and that is the entire extent of its state.
 * Every applied filter lives in the URL: this component *reads* the current
 * filter from props (parsed on the server) and *writes* a new one by calling
 * `router.push`. The server then re-renders the dish grid for the new query.
 *
 * That is why there is no `useSearchParams()` here. The page has already parsed
 * the query and passes the result down, so the island needs no second, possibly
 * disagreeing copy — and no `<Suspense>` boundary of its own to satisfy the
 * hook's static-rendering requirement.
 *
 * ## Radix Select has no empty value
 *
 * `<SelectItem value="">` is invalid — Radix reserves the empty string for
 * "nothing selected". So "Every collection" is a real option under the
 * {@link ALL_VALUE} sentinel, translated back to `null` on the way into the
 * filter. A disabled placeholder would have been the alternative and is worse:
 * it would leave a guest who has chosen a collection with no way back to all of
 * them.
 *
 * ## Announcing the result
 *
 * Filtering is an asynchronous navigation, and to a screen-reader user an
 * asynchronous navigation with no announcement is silence. The `role="status"`
 * region below says "Applying filters…" while the transition is in flight and
 * then goes quiet — the *outcome* ("18 dishes on the menu") is announced by the
 * results header, which is server-rendered and is the element that actually
 * knows the number. Two live regions both reporting the same navigation would
 * be read twice. `aria-busy` on the panel says the same thing to assistive
 * technology that reads state rather than text.
 *
 * ## Accent budget
 *
 * The panel's one champagne element is *the checked state of its filters* — the
 * checkboxes share a single accent, exactly as `checkbox.tsx` documents. The
 * clear button is therefore `ghost`, and the search submit is `outline`.
 */
const ALL_VALUE = '__all'

export interface MenuFilterOption {
  readonly slug: string
  readonly name: string
}

export interface MenuSubcategoryOption extends MenuFilterOption {
  readonly categorySlug: string
}

export interface MenuTagGroup {
  readonly kind: TagKind
  readonly label: string
  readonly tags: readonly MenuFilterOption[]
}

export interface MenuFiltersProps {
  /** The filter the server rendered this page with. */
  readonly filters: MenuFilterState
  readonly categories: readonly MenuFilterOption[]
  readonly subcategories: readonly MenuSubcategoryOption[]
  readonly tagGroups: readonly MenuTagGroup[]
  readonly className?: string
}

export function MenuFilters({
  filters,
  categories,
  subcategories,
  tagGroups,
  className,
}: MenuFiltersProps): React.JSX.Element {
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()
  const [searchDraft, setSearchDraft] = React.useState(filters.search ?? '')

  // The URL is the source of truth, so a back/forward navigation — which
  // changes `filters` without going through this component — must be reflected
  // in the box. Comparing against the last committed value keeps a guest's
  // half-typed word from being overwritten by their own in-flight navigation.
  const committedSearch = filters.search ?? ''
  const previousCommittedRef = React.useRef(committedSearch)

  React.useEffect(() => {
    if (previousCommittedRef.current !== committedSearch) {
      previousCommittedRef.current = committedSearch
      setSearchDraft(committedSearch)
    }
  }, [committedSearch])

  const navigate = React.useCallback(
    (next: MenuFilterState): void => {
      startTransition(() => {
        router.push(menuFilterHref(next), { scroll: true })
      })
    },
    [router]
  )

  const apply = React.useCallback(
    (patch: Partial<MenuFilterState>): void => {
      navigate(withMenuFilters(filters, patch))
    },
    [filters, navigate]
  )

  const activeCount = activeFilterCount(filters)

  const availableSubcategories = React.useMemo(
    () =>
      filters.categorySlug === null
        ? subcategories
        : subcategories.filter(
            (entry) => entry.categorySlug === filters.categorySlug
          ),
    [filters.categorySlug, subcategories]
  )

  const toggleTag = (slug: string, checked: boolean): void => {
    const next = checked
      ? [...filters.tagSlugs, slug]
      : filters.tagSlugs.filter((entry) => entry !== slug)

    apply({ tagSlugs: next })
  }

  const handleSearchSubmit = (
    event: React.FormEvent<HTMLFormElement>
  ): void => {
    event.preventDefault()
    const trimmed = searchDraft.trim()
    apply({ search: trimmed.length === 0 ? null : trimmed })
  }

  const statusMessage = isPending ? 'Applying filters…' : ''

  return (
    <aside
      aria-labelledby="menu-filters-heading"
      aria-busy={isPending || undefined}
      className={cn(
        'flex flex-col gap-6 rounded-lg border border-ash bg-charcoal/50 p-5',
        'transition-opacity duration-200 ease-luxe',
        isPending && 'opacity-70',
        className
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="menu-filters-heading"
          className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
        >
          Refine
        </h2>
        {activeCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchDraft('')
              navigate({
                categorySlug: null,
                subcategorySlug: null,
                tagSlugs: [],
                seasonalOnly: false,
                search: null,
                page: 1,
              })
            }}
          >
            <X aria-hidden="true" />
            Clear {String(activeCount)}
          </Button>
        ) : null}
      </div>

      <form onSubmit={handleSearchSubmit} className="flex flex-col gap-2">
        <Label htmlFor="menu-search">Search the menu</Label>
        <div className="flex gap-2">
          <Input
            id="menu-search"
            type="search"
            name="q"
            value={searchDraft}
            placeholder="Scallops, brassica, braise…"
            maxLength={120}
            onChange={(event) => {
              setSearchDraft(event.target.value)
            }}
          />
          <Button type="submit" variant="outline" size="icon" loading={isPending}>
            <Search aria-hidden="true" />
            <span className="sr-only">Search the menu</span>
          </Button>
        </div>
      </form>

      <Separator variant="subtle" />

      <div className="flex flex-col gap-2">
        <Label htmlFor="menu-category">Collection</Label>
        <Select
          value={filters.categorySlug ?? ALL_VALUE}
          onValueChange={(value) => {
            // Changing the collection invalidates the course beneath it: a
            // subcategory from another collection would match nothing.
            apply({
              categorySlug: value === ALL_VALUE ? null : value,
              subcategorySlug: null,
            })
          }}
        >
          <SelectTrigger id="menu-category">
            <SelectValue placeholder="Every collection" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Every collection</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.slug} value={category.slug}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="menu-subcategory">Course</Label>
        <Select
          value={filters.subcategorySlug ?? ALL_VALUE}
          disabled={availableSubcategories.length === 0}
          onValueChange={(value) => {
            apply({ subcategorySlug: value === ALL_VALUE ? null : value })
          }}
        >
          <SelectTrigger id="menu-subcategory">
            <SelectValue placeholder="Every course" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Every course</SelectItem>
            {availableSubcategories.map((subcategory) => (
              <SelectItem key={subcategory.slug} value={subcategory.slug}>
                {subcategory.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {availableSubcategories.length === 0 ? (
          <p className="font-sans text-xs leading-relaxed text-stone">
            This collection is not divided into courses.
          </p>
        ) : null}
      </div>

      <Separator variant="subtle" />

      <fieldset className="flex flex-col gap-3">
        <legend className="font-sans text-sm font-medium text-linen">
          Seasonality
        </legend>
        <CheckboxField
          label="Only what is in season now"
          description="Dishes whose season includes this month."
          checked={filters.seasonalOnly}
          onCheckedChange={(checked) => {
            apply({ seasonalOnly: checked === true })
          }}
        />
      </fieldset>

      {tagGroups.map((group) => (
        <fieldset key={group.kind} className="flex flex-col gap-3">
          <legend className="font-sans text-sm font-medium text-linen">
            {group.label}
          </legend>
          <p className="font-sans text-xs leading-relaxed text-stone">
            A dish must carry every tag you choose here.
          </p>
          {group.tags.map((tag) => (
            <CheckboxField
              key={tag.slug}
              label={tag.name}
              checked={filters.tagSlugs.includes(tag.slug)}
              onCheckedChange={(checked) => {
                toggleTag(tag.slug, checked === true)
              }}
            />
          ))}
        </fieldset>
      ))}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusMessage}
      </p>
    </aside>
  )
}
