// mannachef/apps/web/src/components/ui/data-table.tsx
'use client'

import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Inbox,
  SearchX,
} from 'lucide-react'
import {
  DEFAULT_PAGE_SIZE,
  type Pagination,
  type SortDirection,
} from '@mannachef/validators'

import { cn, FOCUS_RING } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * The reusable table.
 *
 * ## Generic over the row, with no `any`
 *
 * `DataTable<TRow>` never inspects a row: it is handed `columns`, each of which
 * knows how to pull a display node and — optionally — a comparable value out of
 * one. So a table of `AppointmentView` and a table of `InvoiceView` share every
 * line of this file and neither one widens to `unknown` at a call site.
 *
 * The comparable value is deliberately narrowed to {@link DataTableCellValue}
 * rather than `unknown`. Sorting and filtering have to *do* something with a
 * value, and a union of the five things a cell can meaningfully be is what lets
 * `compareCellValues` be total and honest instead of a pile of `typeof` guesses
 * over `unknown`.
 *
 * ## Controlled and uncontrolled, per concern
 *
 * Sorting, filtering, and pagination are each independently either yours or
 * ours:
 *
 *  - Pass `sort` (even as `null`) **and** `onSortChange` and the table asks you
 *    to re-fetch. Pass neither and it sorts the rows it was given.
 *  - Same for `filters`/`onFiltersChange` and for
 *    `pagination`/`onPaginationChange`.
 *
 * A server-paginated table therefore looks like this — note that `pagination`
 * is precisely the `paginationSchema` shape, so it round-trips through a query
 * string and into an action's filter schema untouched:
 *
 * ```tsx
 * <DataTable
 *   caption="Appointments"
 *   columns={columns}
 *   rows={result.items}
 *   getRowId={(row) => row.id}
 *   pagination={{ page, pageSize, sortDirection }}
 *   rowCount={result.total}
 *   onPaginationChange={(next) => router.push(`?${toSearchParams(next)}`)}
 * />
 * ```
 *
 * ## Accessibility
 *
 * `caption` is required and rendered as a visually-hidden `<caption>`. Sortable
 * headers are `<button>`s inside `<th>` carrying `aria-sort` on the header
 * itself, which is what a screen reader reads. The loading state is a single
 * `aria-busy` region announcing once rather than a dozen empty rows. Row
 * selection is a real checkbox column with a tri-state select-all whose label
 * says how many rows it covers.
 */

// =============================================================================
// 1. Column definitions
// =============================================================================

/**
 * What a cell can be reduced to for sorting and filtering.
 *
 * Not `unknown`: a comparator over `unknown` cannot be written without lying,
 * and this union covers every column any screen in this app actually sorts by.
 */
export type DataCellValue = string | number | boolean | Date | null | undefined

export interface DataTableColumn<TRow> {
  /** Stable identity. Used by `sort`, by `filters`, and as the React key. */
  readonly id: string

  /** The visible header. Keep it short; the caption carries the context. */
  readonly header: React.ReactNode

  /** Renders the cell. Compose `<Money>`, `<DateTime>`, `<Badge>` here. */
  readonly cell: (row: TRow, rowIndex: number) => React.ReactNode

  /**
   * The comparable value behind the cell.
   *
   * Required to sort or filter this column locally. A column that only exists
   * to hold a row-action menu omits it and is neither sortable nor filterable.
   */
  readonly value?: (row: TRow) => DataCellValue

  /** Offer a sort control on this header. Needs `value` when sorting locally. */
  readonly sortable?: boolean

  /** Offer a filter box under this header. Needs `value` when filtering locally. */
  readonly filterable?: boolean

  /** Placeholder for the filter box. Defaults to "Filter". */
  readonly filterPlaceholder?: string

  /** Right-align and apply `tabular-nums`. Every money and count column. */
  readonly numeric?: boolean

  /** A CSS width for the column, e.g. `'12rem'` or `'1%'`. */
  readonly width?: string

  /** Hide the header text visually — for a checkbox or actions column. */
  readonly headerSrOnly?: boolean

  /** Extra classes for every body cell in this column. */
  readonly cellClassName?: string
}

/** Which column a table is sorted by, and which way. */
export interface DataTableSort {
  readonly columnId: string
  readonly direction: SortDirection
}

/** How rows are chosen. Ids come from `getRowId`. */
export interface DataTableSelection {
  readonly selectedIds: readonly string[]
  readonly onSelectionChange: (selectedIds: string[]) => void
  /** Refuse selection for particular rows — a settled invoice, say. */
  readonly isRowSelectable?: (rowId: string) => boolean
}

export interface DataTableEmptyContent {
  readonly title: React.ReactNode
  readonly description?: React.ReactNode
  readonly action?: React.ReactNode
}

export interface DataTableProps<TRow> {
  /** Names the grid for assistive technology. Required. */
  readonly caption: string

  readonly columns: ReadonlyArray<DataTableColumn<TRow>>

  /**
   * The rows to show. When `pagination` is supplied these are already the
   * current page; otherwise they are the whole set and this component pages
   * them.
   */
  readonly rows: readonly TRow[]

  /** Stable identity per row. Used for keys and for selection. */
  readonly getRowId: (row: TRow) => string

  /** Replace the body with a skeleton and announce "Loading…". */
  readonly isLoading?: boolean

  /** How many skeleton rows to draw. Defaults to the page size. */
  readonly skeletonRows?: number

  /** What to say when there are no rows at all. */
  readonly empty?: DataTableEmptyContent

  /** What to say when a filter has excluded everything. */
  readonly emptyFiltered?: DataTableEmptyContent

  /** Controlled sort. Supply `onSortChange` beside it. */
  readonly sort?: DataTableSort | null
  readonly onSortChange?: (sort: DataTableSort | null) => void

  /** Controlled per-column filters, keyed by column id. */
  readonly filters?: Readonly<Record<string, string>>
  readonly onFiltersChange?: (filters: Record<string, string>) => void

  /** Controlled pagination — exactly the `paginationSchema` shape. */
  readonly pagination?: Pagination
  readonly onPaginationChange?: (pagination: Pagination) => void

  /** Total rows across every page. Required with server-side `pagination`. */
  readonly rowCount?: number

  /** Page sizes offered in the footer. */
  readonly pageSizeOptions?: readonly number[]

  /** Row selection. Omit for a read-only table. */
  readonly selection?: DataTableSelection

  /** Invoked on click and on Enter/Space over a row. Makes rows interactive. */
  readonly onRowActivate?: (row: TRow) => void

  /** Tighter rows. Wire this to the persisted admin table preference. */
  readonly density?: 'comfortable' | 'compact'

  /** Hide the footer entirely — for a short, complete list. */
  readonly hidePagination?: boolean

  readonly className?: string
}

// =============================================================================
// 2. Comparison and matching
// =============================================================================

/**
 * A total order over {@link DataCellValue}.
 *
 * Absent values sort last in both directions, which is what a reader expects:
 * "no invoice date" belongs at the bottom of a list sorted by invoice date,
 * ascending or descending. Strings compare with `localeCompare` so accented
 * names file where a Canadian reader looks for them.
 */
export function compareCellValues(a: DataCellValue, b: DataCellValue): number {
  const aMissing = a === null || a === undefined
  const bMissing = b === null || b === undefined

  if (aMissing && bMissing) {
    return 0
  }

  if (aMissing) {
    return 1
  }

  if (bMissing) {
    return -1
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime()
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  }

  return String(a).localeCompare(String(b), 'en-CA', { numeric: true })
}

/** Case-insensitive substring match against a cell's comparable value. */
function matchesFilter(value: DataCellValue, query: string): boolean {
  if (query.length === 0) {
    return true
  }

  if (value === null || value === undefined) {
    return false
  }

  const haystack =
    value instanceof Date ? value.toISOString() : String(value)

  return haystack.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}

// =============================================================================
// 3. The component
// =============================================================================

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const

export function DataTable<TRow>({
  caption,
  columns,
  rows,
  getRowId,
  isLoading = false,
  skeletonRows,
  empty,
  emptyFiltered,
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  pagination,
  onPaginationChange,
  rowCount,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  selection,
  onRowActivate,
  density = 'comfortable',
  hidePagination = false,
  className,
}: DataTableProps<TRow>): React.JSX.Element {
  const isSortControlled = sort !== undefined
  const isFilterControlled = filters !== undefined
  const isPaginationControlled = pagination !== undefined

  // Every id this table mints is namespaced by a `useId` prefix. Two tables on
  // one screen would otherwise both render `filter-name`, and a `<label
  // htmlFor>` matches the *first* such id in the document — so clicking the
  // second table's filter label would focus the first table's input. The
  // caption cannot serve as the namespace: it is prose and may contain spaces.
  const instanceId = React.useId()
  const pageSizeId = `${instanceId}-page-size`

  const [internalSort, setInternalSort] = React.useState<DataTableSort | null>(
    null
  )
  const [internalFilters, setInternalFilters] = React.useState<
    Record<string, string>
  >({})
  const [internalPagination, setInternalPagination] = React.useState<Pagination>(
    { page: 1, pageSize: DEFAULT_PAGE_SIZE, sortDirection: 'desc' }
  )

  const activeSort = isSortControlled ? sort : internalSort
  const activeFilters = isFilterControlled ? filters : internalFilters
  const activePagination = isPaginationControlled
    ? pagination
    : internalPagination

  const columnsById = React.useMemo(() => {
    const map = new Map<string, DataTableColumn<TRow>>()

    for (const column of columns) {
      map.set(column.id, column)
    }

    return map
  }, [columns])

  // --- Local filtering ------------------------------------------------------

  const filteredRows = React.useMemo(() => {
    if (isFilterControlled) {
      return rows
    }

    const active = Object.entries(activeFilters).filter(
      ([, query]) => query.trim().length > 0
    )

    if (active.length === 0) {
      return rows
    }

    return rows.filter((row) =>
      active.every(([columnId, query]) => {
        const column = columnsById.get(columnId)

        if (column?.value === undefined) {
          return true
        }

        return matchesFilter(column.value(row), query.trim())
      })
    )
  }, [activeFilters, columnsById, isFilterControlled, rows])

  // --- Local sorting --------------------------------------------------------

  const sortedRows = React.useMemo(() => {
    if (isSortControlled || activeSort === null) {
      return filteredRows
    }

    const column = columnsById.get(activeSort.columnId)

    if (column?.value === undefined) {
      return filteredRows
    }

    const accessor = column.value
    const factor = activeSort.direction === 'asc' ? 1 : -1

    return [...filteredRows].sort(
      (left, right) => compareCellValues(accessor(left), accessor(right)) * factor
    )
  }, [activeSort, columnsById, filteredRows, isSortControlled])

  // --- Local pagination -----------------------------------------------------

  const totalRows = isPaginationControlled
    ? (rowCount ?? sortedRows.length)
    : sortedRows.length

  const pageCount = Math.max(1, Math.ceil(totalRows / activePagination.pageSize))
  const currentPage = Math.min(Math.max(1, activePagination.page), pageCount)

  const visibleRows = React.useMemo(() => {
    if (isPaginationControlled) {
      return sortedRows
    }

    const start = (currentPage - 1) * activePagination.pageSize

    return sortedRows.slice(start, start + activePagination.pageSize)
  }, [activePagination.pageSize, currentPage, isPaginationControlled, sortedRows])

  // --- Mutators -------------------------------------------------------------

  const commitSort = React.useCallback(
    (next: DataTableSort | null) => {
      if (isSortControlled) {
        onSortChange?.(next)
        return
      }

      setInternalSort(next)
      onSortChange?.(next)
    },
    [isSortControlled, onSortChange]
  )

  const commitFilters = React.useCallback(
    (next: Record<string, string>) => {
      if (isFilterControlled) {
        onFiltersChange?.(next)
        return
      }

      setInternalFilters(next)
      onFiltersChange?.(next)
    },
    [isFilterControlled, onFiltersChange]
  )

  const commitPagination = React.useCallback(
    (next: Pagination) => {
      if (isPaginationControlled) {
        onPaginationChange?.(next)
        return
      }

      setInternalPagination(next)
      onPaginationChange?.(next)
    },
    [isPaginationControlled, onPaginationChange]
  )

  const toggleSort = React.useCallback(
    (columnId: string) => {
      if (activeSort === null || activeSort.columnId !== columnId) {
        commitSort({ columnId, direction: 'asc' })
        return
      }

      if (activeSort.direction === 'asc') {
        commitSort({ columnId, direction: 'desc' })
        return
      }

      // Third press clears the sort and restores the natural order.
      commitSort(null)
    },
    [activeSort, commitSort]
  )

  const setFilter = React.useCallback(
    (columnId: string, query: string) => {
      const next: Record<string, string> = { ...activeFilters }

      if (query.length === 0) {
        delete next[columnId]
      } else {
        next[columnId] = query
      }

      commitFilters(next)

      // A filter that changes the result set makes page 4 meaningless.
      if (activePagination.page !== 1) {
        commitPagination({ ...activePagination, page: 1 })
      }
    },
    [activeFilters, activePagination, commitFilters, commitPagination]
  )

  const goToPage = React.useCallback(
    (page: number) => {
      const clamped = Math.min(Math.max(1, page), pageCount)

      if (clamped !== activePagination.page) {
        commitPagination({ ...activePagination, page: clamped })
      }
    },
    [activePagination, commitPagination, pageCount]
  )

  const changePageSize = React.useCallback(
    (pageSize: number) => {
      commitPagination({ ...activePagination, page: 1, pageSize })
    },
    [activePagination, commitPagination]
  )

  // --- Selection ------------------------------------------------------------

  const selectableIds = React.useMemo(() => {
    if (selection === undefined) {
      return [] as string[]
    }

    const isSelectable = selection.isRowSelectable

    return visibleRows
      .map((row) => getRowId(row))
      .filter((id) => isSelectable === undefined || isSelectable(id))
  }, [getRowId, selection, visibleRows])

  const selectedSet = React.useMemo(
    () => new Set(selection?.selectedIds ?? []),
    [selection?.selectedIds]
  )

  const selectedOnPage = selectableIds.filter((id) => selectedSet.has(id)).length
  const allOnPageSelected =
    selectableIds.length > 0 && selectedOnPage === selectableIds.length
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected

  const toggleRowSelection = React.useCallback(
    (rowId: string, checked: boolean) => {
      if (selection === undefined) {
        return
      }

      const next = new Set(selection.selectedIds)

      if (checked) {
        next.add(rowId)
      } else {
        next.delete(rowId)
      }

      selection.onSelectionChange([...next])
    },
    [selection]
  )

  const toggleAllOnPage = React.useCallback(
    (checked: boolean) => {
      if (selection === undefined) {
        return
      }

      const next = new Set(selection.selectedIds)

      for (const id of selectableIds) {
        if (checked) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }

      selection.onSelectionChange([...next])
    },
    [selectableIds, selection]
  )

  // --- Derived flags --------------------------------------------------------

  const hasActiveFilter = Object.values(activeFilters).some(
    (query) => query.trim().length > 0
  )
  const showFilterRow = columns.some((column) => column.filterable === true)
  const columnCount = columns.length + (selection === undefined ? 0 : 1)
  const skeletonRowCount =
    skeletonRows ?? Math.min(activePagination.pageSize, 8)

  const firstRowOnPage =
    totalRows === 0 ? 0 : (currentPage - 1) * activePagination.pageSize + 1
  const lastRowOnPage = Math.min(
    currentPage * activePagination.pageSize,
    totalRows
  )

  const emptyContent: DataTableEmptyContent =
    hasActiveFilter
      ? (emptyFiltered ?? {
          title: 'Nothing matches those filters',
          description:
            'Try relaxing or clearing a filter to see the rest of the list.',
        })
      : (empty ?? {
          title: 'Nothing here yet',
          description: 'Records will appear here once there are some to show.',
        })

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <Table density={density} aria-busy={isLoading || undefined}>
        <TableCaption>
          {caption}
          {isLoading ? ' — loading' : null}
        </TableCaption>

        <TableHeader>
          <TableRow>
            {selection === undefined ? null : (
              <TableHead className="w-10 pr-0">
                <Checkbox
                  checked={
                    allOnPageSelected
                      ? true
                      : someOnPageSelected
                        ? 'indeterminate'
                        : false
                  }
                  disabled={selectableIds.length === 0}
                  onCheckedChange={(checked) => {
                    toggleAllOnPage(checked === true)
                  }}
                  aria-label={`Select all ${String(selectableIds.length)} rows on this page`}
                />
              </TableHead>
            )}

            {columns.map((column) => {
              const isSorted = activeSort?.columnId === column.id
              const ariaSort = isSorted
                ? activeSort.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'

              return (
                <TableHead
                  key={column.id}
                  numeric={column.numeric === true}
                  aria-sort={column.sortable === true ? ariaSort : undefined}
                  style={
                    column.width === undefined
                      ? undefined
                      : { width: column.width }
                  }
                >
                  {column.sortable === true ? (
                    <button
                      type="button"
                      onClick={() => {
                        toggleSort(column.id)
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-sm py-1',
                        'text-xs font-medium tracking-wide uppercase',
                        'transition-colors duration-150 ease-luxe',
                        isSorted ? 'text-champagne' : 'text-stone hover:text-parchment',
                        column.numeric === true && 'flex-row-reverse',
                        FOCUS_RING
                      )}
                    >
                      <span className={column.headerSrOnly === true ? 'sr-only' : undefined}>
                        {column.header}
                      </span>
                      {isSorted ? (
                        activeSort.direction === 'asc' ? (
                          <ArrowUp aria-hidden="true" className="size-3" />
                        ) : (
                          <ArrowDown aria-hidden="true" className="size-3" />
                        )
                      ) : (
                        <ChevronsUpDown
                          aria-hidden="true"
                          className="size-3 opacity-50"
                        />
                      )}
                    </button>
                  ) : (
                    <span className={column.headerSrOnly === true ? 'sr-only' : undefined}>
                      {column.header}
                    </span>
                  )}
                </TableHead>
              )
            })}
          </TableRow>

          {showFilterRow ? (
            <TableRow className="border-b border-ash">
              {selection === undefined ? null : <TableHead className="pr-0" />}
              {columns.map((column) => (
                <TableHead key={column.id} className="pt-0 pb-3">
                  {column.filterable === true ? (
                    <>
                      <label
                        className="sr-only"
                        htmlFor={`${instanceId}-filter-${column.id}`}
                      >
                        Filter by{' '}
                        {typeof column.header === 'string'
                          ? column.header
                          : column.id}
                      </label>
                      <Input
                        id={`${instanceId}-filter-${column.id}`}
                        inputSize="sm"
                        type="search"
                        value={activeFilters[column.id] ?? ''}
                        placeholder={column.filterPlaceholder ?? 'Filter'}
                        onChange={(event) => {
                          setFilter(column.id, event.target.value)
                        }}
                        className="font-normal normal-case"
                      />
                    </>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          ) : null}
        </TableHeader>

        <TableBody>
          {isLoading ? (
            Array.from({ length: skeletonRowCount }, (_, index) => (
              <TableRow key={`skeleton-${String(index)}`}>
                {selection === undefined ? null : (
                  <TableCell className="pr-0">
                    <Skeleton className="size-4" />
                  </TableCell>
                )}
                {columns.map((column) => (
                  <TableCell key={column.id} numeric={column.numeric === true}>
                    <Skeleton
                      shape="text"
                      className={cn(
                        column.numeric === true ? 'ml-auto w-16' : 'w-full max-w-40'
                      )}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : visibleRows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="p-0">
                <EmptyState
                  tone={hasActiveFilter ? 'filtered' : 'empty'}
                  icon={hasActiveFilter ? SearchX : Inbox}
                  title={emptyContent.title}
                  {...(emptyContent.description === undefined
                    ? {}
                    : { description: emptyContent.description })}
                  {...(emptyContent.action === undefined
                    ? {}
                    : { action: emptyContent.action })}
                  className="rounded-none border-0 bg-transparent"
                />
              </TableCell>
            </TableRow>
          ) : (
            visibleRows.map((row, rowIndex) => {
              const rowId = getRowId(row)
              const isSelected = selectedSet.has(rowId)
              const canSelect =
                selection !== undefined &&
                (selection.isRowSelectable === undefined ||
                  selection.isRowSelectable(rowId))

              return (
                <TableRow
                  key={rowId}
                  selected={selection === undefined ? undefined : isSelected}
                  interactive={onRowActivate !== undefined}
                  tabIndex={onRowActivate === undefined ? undefined : 0}
                  onClick={
                    onRowActivate === undefined
                      ? undefined
                      : () => {
                          onRowActivate(row)
                        }
                  }
                  onKeyDown={
                    onRowActivate === undefined
                      ? undefined
                      : (event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') {
                            return
                          }

                          // Let a control inside the row keep its own keys.
                          if (event.target !== event.currentTarget) {
                            return
                          }

                          event.preventDefault()
                          onRowActivate(row)
                        }
                  }
                  className={onRowActivate === undefined ? undefined : FOCUS_RING}
                >
                  {selection === undefined ? null : (
                    <TableCell className="pr-0">
                      <Checkbox
                        checked={isSelected}
                        disabled={!canSelect}
                        onCheckedChange={(checked) => {
                          toggleRowSelection(rowId, checked === true)
                        }}
                        onClick={(event) => {
                          // Selecting must not also activate the row.
                          event.stopPropagation()
                        }}
                        aria-label={`Select row ${String(rowIndex + 1)}`}
                      />
                    </TableCell>
                  )}
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      numeric={column.numeric === true}
                      className={column.cellClassName}
                    >
                      {column.cell(row, rowIndex)}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      {hidePagination ? null : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p
            aria-live="polite"
            className="font-sans text-xs text-stone tabular-nums"
          >
            {isLoading
              ? 'Loading…'
              : totalRows === 0
                ? 'No results'
                : `Showing ${String(firstRowOnPage)}–${String(lastRowOnPage)} of ${String(totalRows)}`}
            {selection === undefined || selectedSet.size === 0
              ? null
              : ` · ${String(selectedSet.size)} selected`}
          </p>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label
                htmlFor={pageSizeId}
                className="font-sans text-xs whitespace-nowrap text-stone"
              >
                Rows
              </label>
              <Select
                value={String(activePagination.pageSize)}
                onValueChange={(next) => {
                  const parsed = Number.parseInt(next, 10)

                  if (Number.isFinite(parsed)) {
                    changePageSize(parsed)
                  }
                }}
              >
                <SelectTrigger
                  id={pageSizeId}
                  triggerSize="sm"
                  className="w-20"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={currentPage <= 1 || isLoading}
                onClick={() => {
                  goToPage(1)
                }}
              >
                <ChevronsLeft aria-hidden="true" className="size-4" />
                <span className="sr-only">First page</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={currentPage <= 1 || isLoading}
                onClick={() => {
                  goToPage(currentPage - 1)
                }}
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
                <span className="sr-only">Previous page</span>
              </Button>
              <span className="px-2 font-sans text-xs text-parchment tabular-nums">
                {currentPage} / {pageCount}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={currentPage >= pageCount || isLoading}
                onClick={() => {
                  goToPage(currentPage + 1)
                }}
              >
                <ChevronRight aria-hidden="true" className="size-4" />
                <span className="sr-only">Next page</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={currentPage >= pageCount || isLoading}
                onClick={() => {
                  goToPage(pageCount)
                }}
              >
                <ChevronsRight aria-hidden="true" className="size-4" />
                <span className="sr-only">Last page</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
