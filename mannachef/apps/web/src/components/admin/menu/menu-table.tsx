// mannachef/apps/web/src/components/admin/menu/menu-table.tsx
'use client'

/**
 * The Menu Engine grid.
 *
 * `rows`/`meta`/`filters` come from the Server Component at
 * `app/(admin)/admin/menu/page.tsx`, which parses `menuItemFilterSchema`
 * straight out of the address bar and calls `listMenuItems`. Search, the
 * category and tag filters, sort, and pagination therefore all *navigate* —
 * every one of them rewrites the query string and lets the Server Component
 * refetch, so a filtered, sorted, paged view of the menu is a real, linkable
 * address rather than client state that evaporates on refresh. `<DataTable>`
 * is told about that with its **controlled** `sort` and `pagination` props;
 * its own per-column filter row stays uncontrolled and narrows only the page
 * already on screen, which is the one part of "filtering" this file leaves to
 * the primitive rather than the URL.
 *
 * The item sheet and the media selector are deliberately not rendered here —
 * a caller supplies them through `renderRowActions` / `toolbarActions` so this
 * file stays a grid, not a screen.
 *
 * ## The inline seasonal toggle
 *
 * Flipping the switch updates the row immediately (optimistic), then calls
 * `toggleMenuItemSeasonal`. A failure — `FORBIDDEN`, a `CONFLICT` from a row
 * edited elsewhere, a `VALIDATION` when turning a dish "on" before it has ever
 * carried a season — rolls the switch back to whatever it showed before the
 * click and announces the server's own sentence in a toast, titled by
 * `ActionErrorCode` via `describeActionError`. Nothing here renders `FORBIDDEN`
 * as a generic failure.
 */

import * as React from 'react'
import type { Route } from 'next'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Check, ImageOff, Search as SearchIcon } from 'lucide-react'
import { toast } from 'sonner'

import type { MenuItemSummary, PageMeta } from '@mannachef/api-contract'
import {
  MENU_ITEM_BULK_ACTIONS,
  type MenuItemBulkAction,
  type MenuItemFilterInput,
  type MenuItemSortBy,
  type SpiceLevel,
  type TagKind,
} from '@mannachef/validators'

import {
  runMenuItemBulkAction,
  toggleMenuItemSeasonal,
} from '@/server/actions/menu'
import { describeActionError, useAction } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckboxField } from '@/components/ui/checkbox'
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort,
} from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Money } from '@/components/ui/money'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch, SwitchField } from '@/components/ui/switch'
import { Hint } from '@/components/ui/tooltip'

// =============================================================================
// 1. Local vocabulary
//
// Nothing here is imported from a server-action module, per CONTRACT.md §4 —
// the bulk-outcome field this file reads (`affected`, off
// `runMenuItemBulkAction`'s `MenuItemBulkResultView`) is read structurally,
// never through an imported type name.
// =============================================================================

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const MONTH_OPTIONS = MONTH_LABELS.map((label, index) => ({
  value: index + 1,
  label,
}))

const SPICE_LEVEL_OPTIONS: ReadonlyArray<{ value: SpiceLevel; label: string }> =
  [
    { value: 'NONE', label: 'None' },
    { value: 'MILD', label: 'Mild' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HOT', label: 'Hot' },
    { value: 'FIERY', label: 'Fiery' },
  ]

const BULK_ACTION_LABELS: Readonly<Record<MenuItemBulkAction, string>> = {
  PUBLISH: 'Publish',
  UNPUBLISH: 'Unpublish',
  MARK_SIGNATURE: 'Mark as signature',
  UNMARK_SIGNATURE: 'Remove signature mark',
  MOVE_TO_CATEGORY: 'Move to category…',
  ADD_TAGS: 'Add tags…',
  REMOVE_TAGS: 'Remove tags…',
  SET_SPICE_LEVEL: 'Set spice level…',
  SET_SEASONAL: 'Set seasonal window…',
  DELETE: 'Delete…',
}

/** Actions that need no extra input and run the moment they are chosen. */
const DIRECT_BULK_ACTIONS = new Set<MenuItemBulkAction>([
  'PUBLISH',
  'UNPUBLISH',
  'MARK_SIGNATURE',
  'UNMARK_SIGNATURE',
])

/** The columns whose header can drive server-side `sortBy`, both ways. */
const COLUMN_TO_SORT_BY: Readonly<Record<string, MenuItemSortBy>> = {
  name: 'NAME',
  price: 'PRICE',
  sortOrder: 'CURATED',
}
const SORT_BY_TO_COLUMN: Readonly<Partial<Record<MenuItemSortBy, string>>> = {
  NAME: 'name',
  PRICE: 'price',
  CURATED: 'sortOrder',
}

const ALL_CATEGORIES_VALUE = '__all__'

function describeBulkOutcome(
  action: MenuItemBulkAction,
  affected: number
): string {
  const noun = affected === 1 ? 'dish' : 'dishes'

  switch (action) {
    case 'PUBLISH':
      return `${String(affected)} ${noun} published.`
    case 'UNPUBLISH':
      return `${String(affected)} ${noun} unpublished.`
    case 'MARK_SIGNATURE':
      return `${String(affected)} ${noun} marked as signature.`
    case 'UNMARK_SIGNATURE':
      return `${String(affected)} ${noun} no longer marked as signature.`
    case 'MOVE_TO_CATEGORY':
      return `${String(affected)} ${noun} moved.`
    case 'ADD_TAGS':
      return `Tags added to ${String(affected)} ${noun}.`
    case 'REMOVE_TAGS':
      return `Tags removed from ${String(affected)} ${noun}.`
    case 'SET_SPICE_LEVEL':
      return `Spice level updated for ${String(affected)} ${noun}.`
    case 'SET_SEASONAL':
      return `Seasonal calendar updated for ${String(affected)} ${noun}.`
    case 'DELETE':
      return `${String(affected)} ${noun} deleted.`
    default:
      return 'Done.'
  }
}

function announceFailure(
  failure: Parameters<typeof describeActionError>[0]
): void {
  const described = describeActionError(failure)

  if (described.severity === 'error') {
    toast.error(described.title, { description: described.description })
  } else {
    toast.warning(described.title, { description: described.description })
  }
}

function tagBadgeVariant(kind: TagKind): 'destructive' | 'success' | 'outline' {
  if (kind === 'ALLERGEN') {
    return 'destructive'
  }

  if (kind === 'DIETARY') {
    return 'success'
  }

  return 'outline'
}

/**
 * What this table shows for a dish's seasonal window, independent of the row
 * it started from — the shape a toggle can move without a refetch.
 */
interface SeasonState {
  readonly isSeasonal: boolean
  readonly seasonStart: number | null
  readonly seasonEnd: number | null
  /** `null` until a toggle in this session has confirmed the current verdict. */
  readonly isInSeason: boolean | null
}

function baselineSeason(item: MenuItemSummary): SeasonState {
  return {
    isSeasonal: item.isSeasonal,
    seasonStart: item.seasonStart,
    seasonEnd: item.seasonEnd,
    isInSeason: null,
  }
}

/** A patch to the current query string. `undefined` deletes the key. */
type SearchParamPatch = Readonly<Record<string, string | string[] | undefined>>

// =============================================================================
// 2. Props
// =============================================================================

/** A collection, as offered by the filter rail and the "move" bulk action. */
export interface MenuTableCategoryOption {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly isActive: boolean
}

/** A tag, as offered by the filter rail and the tag bulk actions. */
export interface MenuTableTagOption {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: TagKind
  readonly isActive: boolean
}

export interface MenuTableProps {
  /** The current page of dishes, exactly as `listMenuItems` returned it. */
  readonly rows: readonly MenuItemSummary[]

  /** The page counters alongside `rows`. */
  readonly meta: PageMeta

  /** The filter this page rendered with — the address bar, parsed. */
  readonly filters: MenuItemFilterInput

  /** Every collection, for the category filter and the "move" bulk action. */
  readonly categoryOptions: readonly MenuTableCategoryOption[]

  /** Every tag, for the tag filter and the "add"/"remove tags" bulk actions. */
  readonly tagOptions: readonly MenuTableTagOption[]

  readonly isLoading?: boolean

  /**
   * Row-level triggers this table does not own — typically a button that
   * opens the item sheet in edit mode and one that opens the media selector.
   */
  readonly renderRowActions?: (item: MenuItemSummary) => React.ReactNode

  /** Toolbar-level content this table does not own — e.g. "New dish". */
  readonly toolbarActions?: React.ReactNode

  readonly className?: string
}

// =============================================================================
// 3. The component
// =============================================================================

export function MenuTable({
  rows,
  meta,
  filters,
  categoryOptions,
  tagOptions,
  isLoading = false,
  renderRowActions,
  toolbarActions,
  className,
}: MenuTableProps): React.JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const rawSearchParams = useSearchParams()
  const instanceId = React.useId()
  const searchId = `${instanceId}-search`

  const navigate = React.useCallback(
    (patch: SearchParamPatch) => {
      const next = new URLSearchParams(rawSearchParams.toString())

      for (const [key, value] of Object.entries(patch)) {
        next.delete(key)

        if (value === undefined) {
          continue
        }

        if (Array.isArray(value)) {
          for (const entry of value) {
            next.append(key, entry)
          }
        } else {
          next.set(key, value)
        }
      }

      const query = next.toString()
      // `usePathname()` is typed `string`, so the typed-routes checker cannot
      // narrow it. The value is the router's own current path, so it is a real
      // route by construction.
      router.push(
        (query.length > 0 ? `${pathname}?${query}` : pathname) as Route
      )
    },
    [pathname, rawSearchParams, router]
  )

  // --- Search, debounced ------------------------------------------------------

  const [searchValue, setSearchValue] = React.useState(filters.search ?? '')
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  React.useEffect(() => {
    setSearchValue(filters.search ?? '')
  }, [filters.search])

  React.useEffect(
    () => () => {
      if (searchDebounceRef.current !== null) {
        clearTimeout(searchDebounceRef.current)
      }
    },
    []
  )

  const handleSearchChange = React.useCallback(
    (value: string) => {
      setSearchValue(value)

      if (searchDebounceRef.current !== null) {
        clearTimeout(searchDebounceRef.current)
      }

      searchDebounceRef.current = setTimeout(() => {
        const trimmed = value.trim()
        navigate({
          search: trimmed.length > 0 ? trimmed : undefined,
          page: '1',
        })
      }, 400)
    },
    [navigate]
  )

  // --- Category / tag / quick filters ----------------------------------------

  const handleCategoryChange = React.useCallback(
    (value: string) => {
      navigate({
        categorySlug: value === ALL_CATEGORIES_VALUE ? undefined : value,
        subcategorySlug: undefined,
        page: '1',
      })
    },
    [navigate]
  )

  const handleTagFilterToggle = React.useCallback(
    (slug: string, checked: boolean) => {
      const next = new Set(filters.tagSlugs)

      if (checked) {
        next.add(slug)
      } else {
        next.delete(slug)
      }

      navigate({
        tagSlugs: next.size > 0 ? [...next] : undefined,
        page: '1',
      })
    },
    [filters.tagSlugs, navigate]
  )

  const toggleSeasonalOnly = React.useCallback(() => {
    navigate({
      seasonalOnly: filters.seasonalOnly ? undefined : 'true',
      page: '1',
    })
  }, [filters.seasonalOnly, navigate])

  const toggleSignatureOnly = React.useCallback(() => {
    navigate({
      signatureOnly: filters.signatureOnly ? undefined : 'true',
      page: '1',
    })
  }, [filters.signatureOnly, navigate])

  // --- Server-controlled sort and pagination ----------------------------------

  const currentSort: DataTableSort | null = React.useMemo(() => {
    const columnId = SORT_BY_TO_COLUMN[filters.sortBy]
    return columnId === undefined
      ? null
      : { columnId, direction: filters.sortDirection }
  }, [filters.sortBy, filters.sortDirection])

  const handleSortChange = React.useCallback(
    (sort: DataTableSort | null) => {
      if (sort === null) {
        navigate({ sortBy: 'CURATED', sortDirection: 'desc', page: '1' })
        return
      }

      const sortBy = COLUMN_TO_SORT_BY[sort.columnId]

      if (sortBy === undefined) {
        return
      }

      navigate({ sortBy, sortDirection: sort.direction, page: '1' })
    },
    [navigate]
  )

  const handlePaginationChange = React.useCallback(
    (pagination: {
      page: number
      pageSize: number
      sortDirection: 'asc' | 'desc'
    }) => {
      navigate({
        page: String(pagination.page),
        pageSize: String(pagination.pageSize),
        sortDirection: pagination.sortDirection,
      })
    },
    [navigate]
  )

  // --- Selection -------------------------------------------------------------

  const [selectedIds, setSelectedIds] = React.useState<string[]>([])

  React.useEffect(() => {
    const validIds = new Set(rows.map((row) => row.id))
    setSelectedIds((current) => {
      const next = current.filter((id) => validIds.has(id))
      return next.length === current.length ? current : next
    })
  }, [rows])

  // --- Inline seasonal toggle, with optimistic rollback ----------------------

  const seasonalAction = useAction(toggleMenuItemSeasonal, { silent: true })
  const [seasonOverrides, setSeasonOverrides] = React.useState<
    Record<string, SeasonState>
  >({})
  const [pendingSeasonalIds, setPendingSeasonalIds] = React.useState<
    ReadonlySet<string>
  >(new Set())

  const effectiveSeason = React.useCallback(
    (item: MenuItemSummary): SeasonState =>
      seasonOverrides[item.id] ?? baselineSeason(item),
    [seasonOverrides]
  )

  const handleSeasonalToggle = React.useCallback(
    (item: MenuItemSummary, nextIsSeasonal: boolean) => {
      const previous = seasonOverrides[item.id]
      const baseline = previous ?? baselineSeason(item)

      const optimistic: SeasonState = nextIsSeasonal
        ? {
            isSeasonal: true,
            seasonStart: baseline.seasonStart,
            seasonEnd: baseline.seasonEnd,
            isInSeason: baseline.isInSeason,
          }
        : {
            isSeasonal: false,
            seasonStart: null,
            seasonEnd: null,
            isInSeason: null,
          }

      setSeasonOverrides((state) => ({ ...state, [item.id]: optimistic }))
      setPendingSeasonalIds((ids) => new Set(ids).add(item.id))

      void seasonalAction
        .execute({
          id: item.id,
          isSeasonal: nextIsSeasonal,
          seasonStart: nextIsSeasonal ? baseline.seasonStart : null,
          seasonEnd: nextIsSeasonal ? baseline.seasonEnd : null,
        })
        .then((result) => {
          setPendingSeasonalIds((ids) => {
            const next = new Set(ids)
            next.delete(item.id)
            return next
          })

          if (result.ok) {
            setSeasonOverrides((state) => ({
              ...state,
              [item.id]: {
                isSeasonal: result.data.isSeasonal,
                seasonStart: result.data.seasonStart,
                seasonEnd: result.data.seasonEnd,
                isInSeason: result.data.isInSeason,
              },
            }))
            toast.success(
              result.data.isSeasonal
                ? `${item.name} now follows the seasonal calendar.`
                : `${item.name} is now available year-round.`
            )
            router.refresh()
            return
          }

          // Roll back to exactly what this row showed before the click.
          setSeasonOverrides((state) => {
            const next = { ...state }

            if (previous === undefined) {
              delete next[item.id]
            } else {
              next[item.id] = previous
            }

            return next
          })

          announceFailure(result)
        })
    },
    [router, seasonOverrides, seasonalAction]
  )

  // --- Bulk actions ------------------------------------------------------

  const bulkAction = useAction(runMenuItemBulkAction, { silent: true })
  const [bulkDialogAction, setBulkDialogAction] =
    React.useState<MenuItemBulkAction | null>(null)
  const [seasonalDraft, setSeasonalDraft] = React.useState<{
    isSeasonal: boolean
    seasonStart: number
    seasonEnd: number
  }>({ isSeasonal: true, seasonStart: 1, seasonEnd: 3 })
  const [spiceDraft, setSpiceDraft] = React.useState<SpiceLevel>('MEDIUM')
  const [categoryDraft, setCategoryDraft] = React.useState('')
  const [tagsDraft, setTagsDraft] = React.useState<ReadonlySet<string>>(
    new Set()
  )
  const [deleteConfirmed, setDeleteConfirmed] = React.useState(false)

  const closeBulkDialog = React.useCallback(() => {
    setBulkDialogAction(null)
  }, [])

  type BulkActionRaw = Parameters<typeof runMenuItemBulkAction>[0]

  const runBulk = React.useCallback(
    async (input: BulkActionRaw): Promise<void> => {
      const result = await bulkAction.execute(input)

      if (result.ok) {
        toast.success(
          describeBulkOutcome(result.data.action, result.data.affected)
        )
        setSelectedIds([])
        closeBulkDialog()
        router.refresh()
        return
      }

      announceFailure(result)
    },
    [bulkAction, closeBulkDialog, router]
  )

  const handleBulkMenuSelect = React.useCallback(
    (action: MenuItemBulkAction) => {
      if (DIRECT_BULK_ACTIONS.has(action)) {
        void runBulk({ action, menuItemIds: selectedIds } as BulkActionRaw)
        return
      }

      if (action === 'SET_SEASONAL') {
        setSeasonalDraft({ isSeasonal: true, seasonStart: 1, seasonEnd: 3 })
      } else if (action === 'SET_SPICE_LEVEL') {
        setSpiceDraft('MEDIUM')
      } else if (action === 'MOVE_TO_CATEGORY') {
        setCategoryDraft(categoryOptions[0]?.id ?? '')
      } else if (action === 'ADD_TAGS' || action === 'REMOVE_TAGS') {
        setTagsDraft(new Set())
      } else if (action === 'DELETE') {
        setDeleteConfirmed(false)
      }

      setBulkDialogAction(action)
    },
    [categoryOptions, runBulk, selectedIds]
  )

  const isBulkDialogSubmitDisabled = React.useMemo(() => {
    if (bulkDialogAction === 'MOVE_TO_CATEGORY') {
      return categoryDraft === ''
    }

    if (bulkDialogAction === 'ADD_TAGS' || bulkDialogAction === 'REMOVE_TAGS') {
      return tagsDraft.size === 0
    }

    if (bulkDialogAction === 'DELETE') {
      return !deleteConfirmed
    }

    return false
  }, [bulkDialogAction, categoryDraft, deleteConfirmed, tagsDraft])

  const handleBulkDialogSubmit = React.useCallback(() => {
    if (bulkDialogAction === null || isBulkDialogSubmitDisabled) {
      return
    }

    const menuItemIds = selectedIds

    switch (bulkDialogAction) {
      case 'SET_SEASONAL': {
        void runBulk({
          action: 'SET_SEASONAL',
          menuItemIds,
          isSeasonal: seasonalDraft.isSeasonal,
          seasonStart: seasonalDraft.isSeasonal
            ? seasonalDraft.seasonStart
            : null,
          seasonEnd: seasonalDraft.isSeasonal ? seasonalDraft.seasonEnd : null,
        } as BulkActionRaw)
        return
      }
      case 'SET_SPICE_LEVEL': {
        void runBulk({
          action: 'SET_SPICE_LEVEL',
          menuItemIds,
          spiceLevel: spiceDraft,
        } as BulkActionRaw)
        return
      }
      case 'MOVE_TO_CATEGORY': {
        void runBulk({
          action: 'MOVE_TO_CATEGORY',
          menuItemIds,
          categoryId: categoryDraft,
        } as BulkActionRaw)
        return
      }
      case 'ADD_TAGS': {
        void runBulk({
          action: 'ADD_TAGS',
          menuItemIds,
          tagIds: [...tagsDraft],
        } as BulkActionRaw)
        return
      }
      case 'REMOVE_TAGS': {
        void runBulk({
          action: 'REMOVE_TAGS',
          menuItemIds,
          tagIds: [...tagsDraft],
        } as BulkActionRaw)
        return
      }
      case 'DELETE': {
        void runBulk({
          action: 'DELETE',
          menuItemIds,
          confirm: true,
        } as BulkActionRaw)
        return
      }
      default:
        return
    }
  }, [
    bulkDialogAction,
    categoryDraft,
    isBulkDialogSubmitDisabled,
    runBulk,
    seasonalDraft,
    selectedIds,
    spiceDraft,
    tagsDraft,
  ])

  // --- Columns ---------------------------------------------------------------

  const columns = React.useMemo<
    ReadonlyArray<DataTableColumn<MenuItemSummary>>
  >(
    () => [
      {
        id: 'thumb',
        header: 'Image',
        headerSrOnly: true,
        width: '4rem',
        cell: (row) =>
          row.primaryMedia === null ? (
            <span
              className="flex size-10 items-center justify-center rounded-sm border border-ash bg-charcoal text-stone"
              aria-hidden="true"
            >
              <ImageOff className="size-4" />
            </span>
          ) : (
            <img
              src={row.primaryMedia.thumbnailUrl ?? row.primaryMedia.url}
              alt={row.primaryMedia.alt}
              width={40}
              height={40}
              loading="lazy"
              className="size-10 rounded-sm border border-ash object-cover"
            />
          ),
      },
      {
        id: 'name',
        header: 'Dish',
        sortable: true,
        filterable: true,
        filterPlaceholder: 'Filter this page',
        value: (row) => row.name,
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm font-medium text-linen">
                {row.name}
              </span>
              {row.isSignature ? (
                <Badge variant="champagne" srPrefix="Status: ">
                  Signature
                </Badge>
              ) : null}
            </div>
            <span className="font-sans text-xs text-stone">{row.slug}</span>
          </div>
        ),
      },
      {
        id: 'category',
        header: 'Category',
        filterable: true,
        filterPlaceholder: 'Filter this page',
        value: (row) => row.categoryName,
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-sans text-sm text-linen">
              {row.categoryName}
            </span>
            {row.subcategorySlug === null ? null : (
              <span className="font-sans text-xs text-stone capitalize">
                {row.subcategorySlug.replace(/-/g, ' ')}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'price',
        header: 'Price',
        numeric: true,
        sortable: true,
        value: (row) => row.basePriceCents,
        cell: (row) => (
          <Money
            cents={row.basePriceCents}
            currency={row.currency}
            weight="medium"
          />
        ),
      },
      {
        id: 'tags',
        header: 'Dietary',
        filterable: true,
        filterPlaceholder: 'Filter this page',
        value: (row) => row.tags.map((tag) => tag.name).join(' '),
        cell: (row) => {
          if (row.tags.length === 0) {
            return <span className="font-sans text-xs text-stone">—</span>
          }

          const visible = row.tags.slice(0, 3)
          const overflow = row.tags.slice(3)

          return (
            <div className="flex flex-wrap items-center gap-1.5">
              {visible.map((tag) => (
                <Badge key={tag.id} variant={tagBadgeVariant(tag.kind)}>
                  {tag.name}
                </Badge>
              ))}
              {overflow.length === 0 ? null : (
                <Hint label={overflow.map((tag) => tag.name).join(', ')}>
                  <Badge variant="muted" tabIndex={0}>
                    +{overflow.length}
                  </Badge>
                </Hint>
              )}
            </div>
          )
        },
      },
      {
        id: 'seasonal',
        header: 'Seasonal',
        cell: (row) => {
          const state = effectiveSeason(row)
          const isPendingRow = pendingSeasonalIds.has(row.id)
          const switchId = `${instanceId}-seasonal-${row.id}`

          return (
            <div className="flex items-center gap-3">
              <Switch
                id={switchId}
                checked={state.isSeasonal}
                disabled={isPendingRow}
                onCheckedChange={(checked) => {
                  handleSeasonalToggle(row, checked)
                }}
                aria-label={`Follow the seasonal calendar for ${row.name}`}
              />
              <div className="flex flex-col">
                {state.isSeasonal ? (
                  <>
                    <span className="font-sans text-xs text-parchment">
                      {state.seasonStart !== null && state.seasonEnd !== null
                        ? `${MONTH_LABELS[state.seasonStart - 1]}–${MONTH_LABELS[state.seasonEnd - 1]}`
                        : 'Awaiting window'}
                    </span>
                    {state.isInSeason === null ? null : (
                      <Badge
                        variant={state.isInSeason ? 'success' : 'muted'}
                        className="mt-0.5 w-fit"
                      >
                        {state.isInSeason ? 'In season' : 'Out of season'}
                      </Badge>
                    )}
                  </>
                ) : (
                  <span className="font-sans text-xs text-stone">
                    Year-round
                  </span>
                )}
              </div>
            </div>
          )
        },
      },
      {
        id: 'active',
        header: 'Active',
        cell: (row) => (
          <Badge variant={row.isActive ? 'success' : 'muted'}>
            {row.isActive ? 'Active' : 'Inactive'}
          </Badge>
        ),
      },
      {
        id: 'sortOrder',
        header: 'Order',
        numeric: true,
        sortable: true,
        filterable: true,
        filterPlaceholder: 'Filter this page',
        value: (row) => row.sortOrder,
        cell: (row) => <span className="tabular-nums">{row.sortOrder}</span>,
      },
      ...(renderRowActions === undefined
        ? []
        : [
            {
              id: 'actions',
              header: 'Actions',
              headerSrOnly: true,
              width: '1%',
              cell: (row: MenuItemSummary) => (
                <div className="flex items-center justify-end gap-2">
                  {renderRowActions(row)}
                </div>
              ),
            } satisfies DataTableColumn<MenuItemSummary>,
          ]),
    ],
    [
      effectiveSeason,
      handleSeasonalToggle,
      instanceId,
      pendingSeasonalIds,
      renderRowActions,
    ]
  )

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <label htmlFor={searchId} className="sr-only">
              Search dishes
            </label>
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone"
            />
            <Input
              id={searchId}
              type="search"
              value={searchValue}
              onChange={(event) => {
                handleSearchChange(event.target.value)
              }}
              placeholder="Search dishes…"
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectedIds.length === 0 ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" loading={bulkAction.isPending}>
                    Bulk actions ({selectedIds.length})
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    {selectedIds.length} dish
                    {selectedIds.length === 1 ? '' : 'es'} selected
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {MENU_ITEM_BULK_ACTIONS.filter(
                    (action) => action !== 'DELETE'
                  ).map((action) => (
                    <DropdownMenuItem
                      key={action}
                      onSelect={() => {
                        handleBulkMenuSelect(action)
                      }}
                    >
                      {BULK_ACTION_LABELS[action]}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      handleBulkMenuSelect('DELETE')
                    }}
                  >
                    {BULK_ACTION_LABELS.DELETE}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {toolbarActions}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filters.categorySlug ?? ALL_CATEGORIES_VALUE}
            onValueChange={handleCategoryChange}
          >
            <SelectTrigger triggerSize="sm" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES_VALUE}>
                All categories
              </SelectItem>
              {categoryOptions.map((category) => (
                <SelectItem key={category.id} value={category.slug}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                Tags
                {filters.tagSlugs.length > 0
                  ? ` (${String(filters.tagSlugs.length)})`
                  : ''}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" aria-label="Filter by tag">
              {tagOptions.length === 0 ? (
                <p className="font-sans text-sm text-stone">No tags yet.</p>
              ) : (
                <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                  {tagOptions.map((tag) => (
                    <CheckboxField
                      key={tag.id}
                      label={tag.name}
                      checked={filters.tagSlugs.includes(tag.slug)}
                      onCheckedChange={(checked) => {
                        handleTagFilterToggle(tag.slug, checked === true)
                      }}
                    />
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={filters.seasonalOnly}
            onClick={toggleSeasonalOnly}
            className={
              filters.seasonalOnly ? 'border-sage/60 text-sage-ink' : undefined
            }
          >
            {filters.seasonalOnly ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : null}
            Seasonal only
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={filters.signatureOnly}
            onClick={toggleSignatureOnly}
            className={
              filters.signatureOnly ? 'border-sage/60 text-sage-ink' : undefined
            }
          >
            {filters.signatureOnly ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : null}
            Signature only
          </Button>
        </div>
      </div>

      <DataTable
        caption="Menu items"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        selection={{ selectedIds, onSelectionChange: setSelectedIds }}
        sort={currentSort}
        onSortChange={handleSortChange}
        pagination={{
          page: filters.page,
          pageSize: filters.pageSize,
          sortDirection: filters.sortDirection,
        }}
        onPaginationChange={handlePaginationChange}
        rowCount={meta.total}
        empty={{
          title: 'No dishes yet',
          description: 'Add a dish to start building the menu.',
        }}
        emptyFiltered={{
          title: 'Nothing matches those filters',
          description: 'Try clearing a filter or the search box.',
        }}
      />

      <Dialog
        open={bulkDialogAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeBulkDialog()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {bulkDialogAction === null
                ? ''
                : BULK_ACTION_LABELS[bulkDialogAction].replace('…', '')}
            </DialogTitle>
            <DialogDescription>
              Applies to {selectedIds.length} selected dish
              {selectedIds.length === 1 ? '' : 'es'}.
            </DialogDescription>
          </DialogHeader>

          {bulkDialogAction === 'SET_SEASONAL' ? (
            <div className="flex flex-col gap-4">
              <SwitchField
                label="Follows the seasonal calendar"
                description="Turn off to make these dishes available year-round."
                checked={seasonalDraft.isSeasonal}
                onCheckedChange={(checked) => {
                  setSeasonalDraft((draft) => ({
                    ...draft,
                    isSeasonal: checked,
                  }))
                }}
              />
              {seasonalDraft.isSeasonal ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${instanceId}-bulk-season-start`}>
                      From
                    </Label>
                    <Select
                      value={String(seasonalDraft.seasonStart)}
                      onValueChange={(value) => {
                        setSeasonalDraft((draft) => ({
                          ...draft,
                          seasonStart: Number.parseInt(value, 10),
                        }))
                      }}
                    >
                      <SelectTrigger id={`${instanceId}-bulk-season-start`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MONTH_OPTIONS.map((month) => (
                          <SelectItem
                            key={month.value}
                            value={String(month.value)}
                          >
                            {month.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${instanceId}-bulk-season-end`}>
                      Through
                    </Label>
                    <Select
                      value={String(seasonalDraft.seasonEnd)}
                      onValueChange={(value) => {
                        setSeasonalDraft((draft) => ({
                          ...draft,
                          seasonEnd: Number.parseInt(value, 10),
                        }))
                      }}
                    >
                      <SelectTrigger id={`${instanceId}-bulk-season-end`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MONTH_OPTIONS.map((month) => (
                          <SelectItem
                            key={month.value}
                            value={String(month.value)}
                          >
                            {month.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {bulkDialogAction === 'SET_SPICE_LEVEL' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${instanceId}-bulk-spice`}>Spice level</Label>
              <Select
                value={spiceDraft}
                onValueChange={(value) => {
                  setSpiceDraft(value as SpiceLevel)
                }}
              >
                <SelectTrigger id={`${instanceId}-bulk-spice`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPICE_LEVEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {bulkDialogAction === 'MOVE_TO_CATEGORY' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${instanceId}-bulk-category`}>Category</Label>
              {categoryOptions.length === 0 ? (
                <p className="font-sans text-sm text-stone">
                  No collections exist yet.
                </p>
              ) : (
                <Select value={categoryDraft} onValueChange={setCategoryDraft}>
                  <SelectTrigger id={`${instanceId}-bulk-category`}>
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          {bulkDialogAction === 'ADD_TAGS' ||
          bulkDialogAction === 'REMOVE_TAGS' ? (
            <div className="flex flex-col gap-2">
              <Label>Tags</Label>
              {tagOptions.length === 0 ? (
                <p className="font-sans text-sm text-stone">
                  No tags exist yet.
                </p>
              ) : (
                <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-ash p-2">
                  {tagOptions.map((tag) => (
                    <CheckboxField
                      key={tag.id}
                      label={tag.name}
                      checked={tagsDraft.has(tag.id)}
                      onCheckedChange={(checked) => {
                        setTagsDraft((current) => {
                          const next = new Set(current)

                          if (checked === true) {
                            next.add(tag.id)
                          } else {
                            next.delete(tag.id)
                          }

                          return next
                        })
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {bulkDialogAction === 'DELETE' ? (
            <div className="flex flex-col gap-3">
              <DialogDescription className="text-claret-ink">
                Removing a dish cannot be undone once it is gone.
              </DialogDescription>
              <CheckboxField
                label="I understand this cannot be undone"
                checked={deleteConfirmed}
                onCheckedChange={(checked) => {
                  setDeleteConfirmed(checked === true)
                }}
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={closeBulkDialog}>
              Cancel
            </Button>
            <Button
              variant={
                bulkDialogAction === 'DELETE' ? 'destructive' : 'champagne'
              }
              loading={bulkAction.isPending}
              disabled={isBulkDialogSubmitDisabled}
              onClick={handleBulkDialogSubmit}
            >
              {bulkDialogAction === null
                ? ''
                : BULK_ACTION_LABELS[bulkDialogAction].replace('…', '')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
