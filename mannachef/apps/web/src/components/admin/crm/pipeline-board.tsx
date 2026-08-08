// mannachef/apps/web/src/components/admin/crm/pipeline-board.tsx
'use client'

/**
 * The CRM pipeline board.
 *
 * Five columns, one per `ClientStatus`, each carrying its own count and total
 * lifetime value. State lives in the URL — `@mannachef/validators`'
 * `clientPipelineFilterSchema` says so explicitly — so every filter here
 * writes a query string and the Server Component at
 * `app/(admin)/admin/clients/page.tsx` re-fetches and re-maps the columns.
 * This file never calls `queryClientPipeline` itself.
 *
 * Moving a client between stages has two paths that both end at the same
 * handler:
 *
 *  - **Drag.** Native HTML5 drag-and-drop, a mouse/trackpad convenience only.
 *  - **The "Move to" menu**, on every card. This is the real interface: it is
 *    keyboard-operable (arrow keys, Enter), it is what a screen reader
 *    exposes, and it is the *only* path for a stage that requires a reason
 *    (`CHURNED`) since that opens a dialog instead of moving immediately.
 *
 * Both paths call `transitionClientStatus`, which re-validates the move
 * against the live row server-side — a `CONFLICT` there ("something changed
 * first") is surfaced exactly as the server worded it, not swallowed into a
 * generic failure, via `useAction`'s existing per-code handling plus the
 * inline banner below the board header.
 */

import * as React from 'react'
import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CalendarIcon,
  CheckCircle2,
  Clock,
  Filter as FilterIcon,
  MoreVertical,
  Search,
  Undo2,
  Users,
  X,
} from 'lucide-react'

import {
  allowedClientStatusTransitions,
  clientFollowUpSchema,
  clientStatusTransitionSchema,
  type ClientFollowUpInput,
  type ClientPipelineSortBy,
  type ClientSource,
  type ClientStatus,
  type ClientStatusTransitionInput,
  type SortDirection,
} from '@mannachef/validators'

import { transitionClientStatus, flagClientFollowUp } from '@/server/actions/crm'
import { describeActionError, useAction } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'
import { cn } from '@/lib/utils'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  CheckboxField,
} from '@/components/ui/checkbox'
import { DateTime } from '@/components/ui/date-time'
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
import { EmptyState } from '@/components/ui/empty-state'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
  FormStatus,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Money } from '@/components/ui/money'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

// =============================================================================
// 1. Vocabulary
// =============================================================================

/** Column order. Fixed — this is the lifecycle, not an alphabetical list. */
export const PIPELINE_STATUSES: readonly ClientStatus[] = [
  'PROSPECT',
  'LEAD_QUALIFIED',
  'ACTIVE_SUBSCRIBER',
  'PAUSED',
  'CHURNED',
]

export const STATUS_LABELS: Readonly<Record<ClientStatus, string>> = {
  PROSPECT: 'Prospect',
  LEAD_QUALIFIED: 'Lead qualified',
  ACTIVE_SUBSCRIBER: 'Active subscriber',
  PAUSED: 'Paused',
  CHURNED: 'Churned',
}

const STATUS_BADGE_VARIANT: Readonly<Record<ClientStatus, BadgeProps['variant']>> = {
  PROSPECT: 'outline',
  LEAD_QUALIFIED: 'default',
  ACTIVE_SUBSCRIBER: 'success',
  PAUSED: 'warning',
  CHURNED: 'destructive',
}

const SOURCE_LABELS: Readonly<Record<ClientSource, string>> = {
  ORGANIC_SEARCH: 'Organic search',
  PAID_SEARCH: 'Paid search',
  SOCIAL: 'Social',
  REFERRAL: 'Referral',
  PARTNER: 'Partner',
  EVENT: 'Event',
  WORD_OF_MOUTH: 'Word of mouth',
  DIRECT: 'Direct',
  OTHER: 'Other',
}

const ALL_SOURCES: readonly ClientSource[] = [
  'ORGANIC_SEARCH',
  'PAID_SEARCH',
  'SOCIAL',
  'REFERRAL',
  'PARTNER',
  'EVENT',
  'WORD_OF_MOUTH',
  'DIRECT',
  'OTHER',
]

const SORT_BY_LABELS: Readonly<Record<ClientPipelineSortBy, string>> = {
  CREATED: 'Date added',
  UPDATED: 'Last updated',
  LAST_CONTACTED: 'Last contacted',
  FOLLOW_UP: 'Follow-up date',
  LIFETIME_VALUE: 'Lifetime value',
  NAME: 'Name',
  STATUS: 'Stage',
}

const ALL_SORT_BY: readonly ClientPipelineSortBy[] = [
  'UPDATED',
  'CREATED',
  'LAST_CONTACTED',
  'FOLLOW_UP',
  'LIFETIME_VALUE',
  'NAME',
  'STATUS',
]

// =============================================================================
// 2. View models — the whole browser-side vocabulary for this board
// =============================================================================

/** The four name fields every client row carries. Never all `null` at once. */
export interface ClientNameFields {
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly accountName: string | null
  readonly accountEmail: string | null
}

/**
 * The name to show for a client, in order of what a person would actually
 * call them: the name they chose to display, the name they go by, the name on
 * the account, and — failing all three — their email rather than a blank.
 */
export function resolveClientName(fields: ClientNameFields): string {
  return (
    fields.displayName ??
    fields.preferredName ??
    fields.accountName ??
    fields.accountEmail ??
    'Unnamed client'
  )
}

/** One card on the board. Mapped from `PipelineClientView` in the page. */
export interface PipelineCardView extends ClientNameFields {
  readonly id: string
  readonly status: ClientStatus
  readonly source: ClientSource
  readonly sourceDetail: string | null
  readonly lifetimeValueCents: number
  readonly currency: string
  readonly lastContactedAt: Date | null
  readonly followUpAt: Date | null
  readonly churnReason: string | null
  readonly updatedAt: Date
}

/** One column. `totalCount` is the real count; `cards` may be a prefix of it. */
export interface PipelineColumnData {
  readonly status: ClientStatus
  readonly cards: readonly PipelineCardView[]
  readonly totalCount: number
  readonly hasMore: boolean
}

/** The filter bar's state, in the plain, URL-round-trippable shape. */
export interface PipelineFilterDraft {
  readonly search: string
  readonly sources: readonly ClientSource[]
  readonly minValueDollars: string
  readonly maxValueDollars: string
  readonly lastContactedBefore: string
  readonly neverContacted: boolean
  readonly followUpDue: boolean
  readonly sortBy: ClientPipelineSortBy
  readonly sortDirection: SortDirection
}

export const EMPTY_PIPELINE_FILTERS: PipelineFilterDraft = {
  search: '',
  sources: [],
  minValueDollars: '',
  maxValueDollars: '',
  lastContactedBefore: '',
  neverContacted: false,
  followUpDue: false,
  sortBy: 'UPDATED',
  sortDirection: 'desc',
}

/** True when any filter narrows the board beyond "everything". */
export function hasActiveFilters(filters: PipelineFilterDraft): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.sources.length > 0 ||
    filters.minValueDollars !== '' ||
    filters.maxValueDollars !== '' ||
    filters.lastContactedBefore !== '' ||
    filters.neverContacted ||
    filters.followUpDue
  )
}

// =============================================================================
// 3. Small pure helpers
// =============================================================================

function centsFromDollars(raw: string): number | undefined {
  const trimmed = raw.trim()

  if (trimmed === '') {
    return undefined
  }

  const parsed = Number(trimmed)

  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined
  }

  return Math.round(parsed * 100)
}

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Builds the query string the filter bar navigates to. Omits every default. */
export function buildPipelineQuery(filters: PipelineFilterDraft): string {
  const params = new URLSearchParams()

  const search = filters.search.trim()
  if (search !== '') {
    params.set('search', search)
  }

  for (const source of filters.sources) {
    params.append('sources', source)
  }

  const minCents = centsFromDollars(filters.minValueDollars)
  if (minCents !== undefined) {
    params.set('minLifetimeValueCents', String(minCents))
  }

  const maxCents = centsFromDollars(filters.maxValueDollars)
  if (maxCents !== undefined) {
    params.set('maxLifetimeValueCents', String(maxCents))
  }

  if (filters.neverContacted) {
    params.set('neverContacted', 'true')
  } else if (filters.lastContactedBefore !== '') {
    params.set(
      'lastContactedBefore',
      new Date(`${filters.lastContactedBefore}T00:00:00.000Z`).toISOString()
    )
  }

  if (filters.followUpDue) {
    params.set('followUpDue', 'true')
  }

  if (filters.sortBy !== EMPTY_PIPELINE_FILTERS.sortBy) {
    params.set('sortBy', filters.sortBy)
  }

  if (filters.sortDirection !== EMPTY_PIPELINE_FILTERS.sortDirection) {
    params.set('sortDirection', filters.sortDirection)
  }

  return params.toString()
}

function isFollowUpDue(followUpAt: Date | null, now: number): boolean {
  return followUpAt !== null && followUpAt.getTime() <= now
}

// =============================================================================
// 4. The board
// =============================================================================

export interface PipelineBoardProps {
  readonly columns: readonly PipelineColumnData[]
  readonly filters: PipelineFilterDraft
  /** Base pathname the filter bar navigates against. */
  readonly basePath: Route
}

interface PendingTransition {
  readonly card: PipelineCardView
  readonly to: ClientStatus
}

export function PipelineBoard({ columns, filters, basePath }: PipelineBoardProps) {
  const router = useRouter()
  const [isNavigating, startNavigation] = React.useTransition()
  const [draft, setDraft] = React.useState<PipelineFilterDraft>(filters)
  const [pendingTransition, setPendingTransition] =
    React.useState<PendingTransition | null>(null)
  const [followUpTarget, setFollowUpTarget] = React.useState<PipelineCardView | null>(
    null
  )
  const [dragOverStatus, setDragOverStatus] = React.useState<ClientStatus | null>(null)

  // Keep the draft in step when the URL changes from elsewhere (back/forward).
  React.useEffect(() => {
    setDraft(filters)
  }, [filters])

  const cardsById = React.useMemo(() => {
    const map = new Map<string, PipelineCardView>()
    for (const column of columns) {
      for (const card of column.cards) {
        map.set(card.id, card)
      }
    }
    return map
  }, [columns])

  const navigateWithFilters = React.useCallback(
    (next: PipelineFilterDraft) => {
      const query = buildPipelineQuery(next)
      startNavigation(() => {
        // `basePath` is itself a checked `Route`; appending a query string
        // keeps it one, but the template literal widens to `string`.
        router.push(
          (query.length > 0 ? `${basePath}?${query}` : basePath) as Route
        )
      })
    },
    [basePath, router]
  )

  const handleApply = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      navigateWithFilters(draft)
    },
    [draft, navigateWithFilters]
  )

  const handleClear = React.useCallback(() => {
    setDraft(EMPTY_PIPELINE_FILTERS)
    navigateWithFilters(EMPTY_PIPELINE_FILTERS)
  }, [navigateWithFilters])

  const quickTransition = useAction(transitionClientStatus, {
    successMessage: (data) => `Moved ${resolveClientName(data)} to ${STATUS_LABELS[data.status]}.`,
  })

  const clearFollowUp = useAction(flagClientFollowUp, {
    successMessage: (data) => `Cleared the follow-up for ${resolveClientName(data)}.`,
  })

  const requestMove = React.useCallback(
    (card: PipelineCardView, to: ClientStatus) => {
      if (to === card.status) {
        return
      }

      if (to === 'CHURNED') {
        setPendingTransition({ card, to })
        return
      }

      void quickTransition.execute({
        clientProfileId: card.id,
        from: card.status,
        to,
      })
    },
    [quickTransition]
  )

  const handleDrop = React.useCallback(
    (status: ClientStatus) => (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragOverStatus(null)

      const raw = event.dataTransfer.getData('application/json')
      if (raw === '') {
        return
      }

      let payload: unknown

      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }

      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('id' in payload) ||
        typeof (payload as { id: unknown }).id !== 'string'
      ) {
        return
      }

      const card = cardsById.get((payload as { id: string }).id)
      if (card !== undefined) {
        requestMove(card, status)
      }
    },
    [cardsById, requestMove]
  )

  const filtersActive = hasActiveFilters(filters)

  return (
    <section aria-labelledby="pipeline-heading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1
          id="pipeline-heading"
          className="font-display text-3xl leading-tight font-medium tracking-tight text-linen"
        >
          Client pipeline
        </h1>
        <p className="font-sans text-sm leading-relaxed text-parchment">
          Every client, grouped by where they stand. Drag a card between
          columns, or use its <span className="text-linen">Move to</span> menu
          — the menu is the one every keyboard and screen-reader user has.
        </p>
      </div>

      <FailureBanner failure={quickTransition.failure} onDismiss={quickTransition.reset} />
      <FailureBanner failure={clearFollowUp.failure} onDismiss={clearFollowUp.reset} />
      <FormStatus>{quickTransition.statusMessage}</FormStatus>
      <FormStatus>{clearFollowUp.statusMessage}</FormStatus>

      <FilterBar
        draft={draft}
        onChange={setDraft}
        onSubmit={handleApply}
        onClear={handleClear}
        isPending={isNavigating}
        hasActiveFilters={filtersActive}
      />

      <div className="-mx-1 overflow-x-auto pb-2">
        <div
          role="list"
          aria-label="Pipeline stages"
          className="flex min-w-full gap-4 px-1"
        >
          {columns.map((column) => (
            <PipelineColumn
              key={column.status}
              column={column}
              filtersActive={filtersActive}
              isDragTarget={dragOverStatus === column.status}
              onDragOver={(event) => {
                event.preventDefault()
                setDragOverStatus(column.status)
              }}
              onDragLeave={() => {
                setDragOverStatus((current) =>
                  current === column.status ? null : current
                )
              }}
              onDrop={handleDrop(column.status)}
              onRequestMove={requestMove}
              onRequestFollowUp={setFollowUpTarget}
              onClearFollowUp={(card) =>
                void clearFollowUp.execute({
                  clientProfileId: card.id,
                  followUpAt: null,
                })
              }
              clearFollowUpPending={clearFollowUp.isPending}
            />
          ))}
        </div>
      </div>

      <ChurnDialog
        pending={pendingTransition}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTransition(null)
          }
        }}
      />

      <FollowUpDialog
        card={followUpTarget}
        onOpenChange={(open) => {
          if (!open) {
            setFollowUpTarget(null)
          }
        }}
      />
    </section>
  )
}

// =============================================================================
// 5. The failure banner
// =============================================================================

function FailureBanner({
  failure,
  onDismiss,
}: {
  readonly failure: ReturnType<typeof describeActionError> | null
  readonly onDismiss: () => void
}) {
  if (failure === null) {
    return null
  }

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-md border border-claret/60 bg-claret/12 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-linen" />
        <p className="font-sans text-sm leading-relaxed text-linen">
          <span className="font-medium">{failure.title}.</span>{' '}
          {failure.description}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-4" />
        <span className="sr-only">Dismiss</span>
      </Button>
    </div>
  )
}

// =============================================================================
// 6. Filter bar
// =============================================================================

function FilterBar({
  draft,
  onChange,
  onSubmit,
  onClear,
  isPending,
  hasActiveFilters: filtersActive,
}: {
  readonly draft: PipelineFilterDraft
  readonly onChange: (next: PipelineFilterDraft) => void
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  readonly onClear: () => void
  readonly isPending: boolean
  readonly hasActiveFilters: boolean
}) {
  const searchId = React.useId()
  const minId = React.useId()
  const maxId = React.useId()

  return (
    <Card variant="quiet" padded>
      <form
        role="search"
        aria-label="Filter the client pipeline"
        onSubmit={onSubmit}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-1 flex-col gap-2">
            <Label htmlFor={searchId}>Search</Label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone"
              />
              <Input
                id={searchId}
                type="search"
                placeholder="Name or email"
                className="pl-9"
                value={draft.search}
                onChange={(event) =>
                  onChange({ ...draft, search: event.target.value })
                }
              />
            </div>
          </div>

          <SourceFilter
            selected={draft.sources}
            onChange={(sources) => onChange({ ...draft, sources })}
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor={minId}>Min value</Label>
            <Input
              id={minId}
              type="number"
              min={0}
              step={1}
              inputMode="decimal"
              placeholder="$0"
              numeric
              className="w-28"
              value={draft.minValueDollars}
              onChange={(event) =>
                onChange({ ...draft, minValueDollars: event.target.value })
              }
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={maxId}>Max value</Label>
            <Input
              id={maxId}
              type="number"
              min={0}
              step={1}
              inputMode="decimal"
              placeholder="Any"
              numeric
              className="w-28"
              value={draft.maxValueDollars}
              onChange={(event) =>
                onChange({ ...draft, maxValueDollars: event.target.value })
              }
            />
          </div>

          <LastContactedFilter
            value={draft.lastContactedBefore}
            neverContacted={draft.neverContacted}
            onChange={(lastContactedBefore, neverContacted) =>
              onChange({ ...draft, lastContactedBefore, neverContacted })
            }
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor="pipeline-sort-by">Sort by</Label>
            <div className="flex gap-1.5">
              <Select
                value={draft.sortBy}
                onValueChange={(value) =>
                  onChange({ ...draft, sortBy: value as ClientPipelineSortBy })
                }
              >
                <SelectTrigger id="pipeline-sort-by" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_SORT_BY.map((option) => (
                    <SelectItem key={option} value={option}>
                      {SORT_BY_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-pressed={draft.sortDirection === 'asc'}
                onClick={() =>
                  onChange({
                    ...draft,
                    sortDirection: draft.sortDirection === 'asc' ? 'desc' : 'asc',
                  })
                }
              >
                <span aria-hidden="true">
                  {draft.sortDirection === 'asc' ? '↑' : '↓'}
                </span>
                <span className="sr-only">
                  {draft.sortDirection === 'asc'
                    ? 'Ascending. Activate for descending.'
                    : 'Descending. Activate for ascending.'}
                </span>
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-ash/70 pt-4">
          <CheckboxField
            label="Only clients due a follow-up"
            checked={draft.followUpDue}
            onCheckedChange={(checked) =>
              onChange({ ...draft, followUpDue: checked === true })
            }
          />

          <div className="ml-auto flex items-center gap-2">
            {filtersActive ? (
              <Button type="button" variant="ghost" onClick={onClear}>
                <X aria-hidden="true" />
                Clear filters
              </Button>
            ) : null}
            <Button type="submit" variant="champagne" loading={isPending}>
              <FilterIcon aria-hidden="true" />
              Apply filters
            </Button>
          </div>
        </div>
      </form>
    </Card>
  )
}

function SourceFilter({
  selected,
  onChange,
}: {
  readonly selected: readonly ClientSource[]
  readonly onChange: (sources: readonly ClientSource[]) => void
}) {
  const toggle = (source: ClientSource) => {
    onChange(
      selected.includes(source)
        ? selected.filter((entry) => entry !== source)
        : [...selected, source]
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Label id="pipeline-source-label">Source</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-labelledby="pipeline-source-label"
            className="justify-between"
          >
            Source
            {selected.length > 0 ? (
              <Badge variant="outline" numeric>
                {selected.length}
              </Badge>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Choose sources to show">
          <div className="flex flex-col gap-3">
            {ALL_SOURCES.map((source) => (
              <CheckboxField
                key={source}
                label={SOURCE_LABELS[source]}
                checked={selected.includes(source)}
                onCheckedChange={() => toggle(source)}
              />
            ))}
            {selected.length > 0 ? (
              <>
                <div className="hairline" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange([])}
                >
                  Clear sources
                </Button>
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function LastContactedFilter({
  value,
  neverContacted,
  onChange,
}: {
  readonly value: string
  readonly neverContacted: boolean
  readonly onChange: (value: string, neverContacted: boolean) => void
}) {
  const selectedDate = value === '' ? null : new Date(`${value}T00:00:00.000Z`)

  return (
    <div className="flex flex-col gap-2">
      <Label id="pipeline-last-contacted-label">Last contacted before</Label>
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={neverContacted}
              aria-labelledby="pipeline-last-contacted-label"
              className="justify-start"
            >
              <CalendarIcon aria-hidden="true" />
              {selectedDate === null ? 'Any time' : isoDateOnly(selectedDate)}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto">
            <Calendar
              label="Choose the cutoff date"
              selected={selectedDate}
              toDate={new Date()}
              onSelect={(date) => onChange(isoDateOnly(date), false)}
            />
            {value !== '' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => onChange('', neverContacted)}
              >
                Clear date
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
      <CheckboxField
        label="Never contacted"
        checked={neverContacted}
        onCheckedChange={(checked) => onChange('', checked === true)}
      />
    </div>
  )
}

// =============================================================================
// 7. A column
// =============================================================================

function PipelineColumn({
  column,
  filtersActive,
  isDragTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onRequestMove,
  onRequestFollowUp,
  onClearFollowUp,
  clearFollowUpPending,
}: {
  readonly column: PipelineColumnData
  readonly filtersActive: boolean
  readonly isDragTarget: boolean
  readonly onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  readonly onDragLeave: () => void
  readonly onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  readonly onRequestMove: (card: PipelineCardView, to: ClientStatus) => void
  readonly onRequestFollowUp: (card: PipelineCardView) => void
  readonly onClearFollowUp: (card: PipelineCardView) => void
  readonly clearFollowUpPending: boolean
}) {
  const totalsByCurrency = React.useMemo(() => {
    const totals = new Map<string, number>()
    for (const card of column.cards) {
      totals.set(
        card.currency,
        (totals.get(card.currency) ?? 0) + card.lifetimeValueCents
      )
    }
    return totals
  }, [column.cards])

  const headingId = `pipeline-column-${column.status}-heading`

  return (
    <div
      role="listitem"
      className="w-80 shrink-0"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Card
        as="section"
        variant={isDragTarget ? 'accent' : 'elevated'}
        className={cn(
          'flex h-full flex-col',
          isDragTarget && 'border-champagne/60'
        )}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle id={headingId} level={2} className="text-lg">
              {STATUS_LABELS[column.status]}
            </CardTitle>
            <Badge variant={STATUS_BADGE_VARIANT[column.status]} numeric>
              {column.totalCount}
            </Badge>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {totalsByCurrency.size === 0 ? (
              <Money cents={0} tone="accent" weight="semibold" />
            ) : (
              [...totalsByCurrency.entries()].map(([currency, cents]) => (
                <Money
                  key={currency}
                  cents={cents}
                  currency={currency}
                  tone="accent"
                  weight="semibold"
                />
              ))
            )}
            {column.hasMore ? (
              <span className="font-sans text-xs text-stone">
                of {column.totalCount} shown
              </span>
            ) : null}
          </div>
        </CardHeader>
        <CardContent
          className="flex-1 overflow-y-auto pt-0"
          style={{ maxHeight: '70vh' }}
        >
          {column.cards.length === 0 ? (
            <EmptyState
              size="sm"
              tone={filtersActive ? 'filtered' : 'empty'}
              icon={Users}
              title="No clients here"
              description={
                filtersActive
                  ? 'No client in this stage matches the current filters.'
                  : 'Nobody is at this stage right now.'
              }
              headingLevel={3}
            />
          ) : (
            <ul aria-labelledby={headingId} className="flex flex-col gap-3">
              {column.cards.map((card) => (
                <PipelineClientCard
                  key={card.id}
                  card={card}
                  onRequestMove={onRequestMove}
                  onRequestFollowUp={onRequestFollowUp}
                  onClearFollowUp={onClearFollowUp}
                  clearFollowUpPending={clearFollowUpPending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// =============================================================================
// 8. A card
// =============================================================================

function PipelineClientCard({
  card,
  onRequestMove,
  onRequestFollowUp,
  onClearFollowUp,
  clearFollowUpPending,
}: {
  readonly card: PipelineCardView
  readonly onRequestMove: (card: PipelineCardView, to: ClientStatus) => void
  readonly onRequestFollowUp: (card: PipelineCardView) => void
  readonly onClearFollowUp: (card: PipelineCardView) => void
  readonly clearFollowUpPending: boolean
}) {
  const name = resolveClientName(card)
  const targets = allowedClientStatusTransitions(card.status)
  const [now] = React.useState(() => Date.now())
  const followUpDue = isFollowUpDue(card.followUpAt, now)

  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          'application/json',
          JSON.stringify({ id: card.id, from: card.status })
        )
        event.dataTransfer.effectAllowed = 'move'
      }}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-ash bg-charcoal p-3',
        'transition-[border-color] duration-150 ease-luxe hover:border-stone/50'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-sans text-sm font-medium text-linen">{name}</span>
          {card.accountEmail !== null ? (
            <span className="font-sans text-xs text-stone">{card.accountEmail}</span>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
            >
              <MoreVertical aria-hidden="true" className="size-4" />
              <span className="sr-only">Actions for {name}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {targets.map((target) => (
              <DropdownMenuItem
                key={target}
                onSelect={() => onRequestMove(card, target)}
              >
                {STATUS_LABELS[target]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onRequestFollowUp(card)}>
              <Clock aria-hidden="true" />
              Flag follow-up…
            </DropdownMenuItem>
            {card.followUpAt !== null ? (
              <DropdownMenuItem
                disabled={clearFollowUpPending}
                onSelect={() => onClearFollowUp(card)}
              >
                <Undo2 aria-hidden="true" />
                Clear follow-up
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Money cents={card.lifetimeValueCents} currency={card.currency} tone="muted" />
        <Badge variant="muted">{SOURCE_LABELS[card.source]}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-xs text-stone">
        <span className="flex items-center gap-1">
          <Clock aria-hidden="true" className="size-3" />
          Last contact:{' '}
          <DateTime value={card.lastContactedAt} format="relative" tone="subtle" />
        </span>
        {card.followUpAt !== null ? (
          <Badge variant={followUpDue ? 'warning' : 'outline'} className="gap-1">
            {followUpDue ? (
              <AlertCircle aria-hidden="true" className="size-3" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="size-3" />
            )}
            Follow-up <DateTime value={card.followUpAt} format="date" tone="subtle" />
          </Badge>
        ) : null}
      </div>

      {card.status === 'CHURNED' && card.churnReason !== null ? (
        <p className="rounded-sm border border-ash/70 bg-obsidian/40 p-2 font-sans text-xs leading-relaxed text-parchment">
          {card.churnReason}
        </p>
      ) : null}
    </li>
  )
}

// =============================================================================
// 9. Churn dialog — the one transition that requires a reason
// =============================================================================

function ChurnDialog({
  pending,
  onOpenChange,
}: {
  readonly pending: PendingTransition | null
  readonly onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      {pending === null ? null : (
        <ChurnDialogForm
          key={pending.card.id}
          pending={pending}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  )
}

function ChurnDialogForm({
  pending,
  onDone,
}: {
  readonly pending: PendingTransition
  readonly onDone: () => void
}) {
  const name = resolveClientName(pending.card)

  const rhfForm = useFormForTransition(pending)

  const action = useAction(transitionClientStatus, {
    form: rhfForm,
    resetFormOnSuccess: false,
    successMessage: `Moved ${name} to churned.`,
    onSuccess: onDone,
  })

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Move {name} to churned</DialogTitle>
        <DialogDescription>
          This is recorded as the reason this client left. A win-back
          follow-up can be scheduled at the same time.
        </DialogDescription>
      </DialogHeader>

      <Form {...rhfForm}>
        <form
          noValidate
          onSubmit={rhfForm.handleSubmit((values) => action.execute(values))}
          className="flex flex-col gap-4"
        >
          <FormField
            control={rhfForm.control}
            name="reason"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Reason</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ''}
                    placeholder="What led to this?"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={rhfForm.control}
            name="followUpAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Win-back follow-up (optional)</FormLabel>
                <Popover>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button type="button" variant="outline" className="justify-start">
                        <CalendarIcon aria-hidden="true" />
                        {field.value == null
                          ? 'No follow-up scheduled'
                          : isoDateOnly(new Date(field.value))}
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-auto">
                    <Calendar
                      label="Choose a follow-up date"
                      selected={field.value == null ? null : new Date(field.value)}
                      fromDate={new Date()}
                      onSelect={(date) => field.onChange(date.toISOString())}
                    />
                    {field.value == null ? null : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-2"
                        onClick={() => field.onChange(null)}
                      >
                        Clear
                      </Button>
                    )}
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormRootError />
          <FormStatus>{action.statusMessage}</FormStatus>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" variant="champagne" loading={action.isPending}>
              Move to churned
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  )
}

/**
 * `clientStatusTransitionSchema` validates `clientProfileId`, `from` and `to`
 * as well as `reason` and `followUpAt` — but this dialog only ever shows
 * inputs for the latter two. The first three are seeded as default values and
 * never re-rendered as fields, so the shared schema still runs in full on
 * submit without the dialog growing three hidden `<input>`s.
 */
function useFormForTransition(pending: PendingTransition) {
  return useRHFTransitionForm(pending)
}

import { useForm } from 'react-hook-form'

function useRHFTransitionForm(pending: PendingTransition) {
  return useForm<
    z.input<typeof clientStatusTransitionSchema>,
    unknown,
    ClientStatusTransitionInput
  >({
    resolver: zodResolver(clientStatusTransitionSchema),
    defaultValues: {
      clientProfileId: pending.card.id,
      from: pending.card.status,
      to: pending.to,
      reason: '',
      followUpAt: null,
    },
  })
}

import { z } from 'zod'

// =============================================================================
// 10. Follow-up dialog
// =============================================================================

function FollowUpDialog({
  card,
  onOpenChange,
}: {
  readonly card: PipelineCardView | null
  readonly onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={card !== null} onOpenChange={onOpenChange}>
      {card === null ? null : (
        <FollowUpDialogForm
          key={card.id}
          card={card}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  )
}

function FollowUpDialogForm({
  card,
  onDone,
}: {
  readonly card: PipelineCardView
  readonly onDone: () => void
}) {
  const name = resolveClientName(card)

  const rhfForm = useForm<
    z.input<typeof clientFollowUpSchema>,
    unknown,
    ClientFollowUpInput
  >({
    resolver: zodResolver(clientFollowUpSchema),
    defaultValues: {
      clientProfileId: card.id,
      followUpAt: card.followUpAt?.toISOString() ?? null,
      note: '',
      markAsContacted: false,
    },
  })

  const action = useAction(flagClientFollowUp, {
    form: rhfForm,
    successMessage: `Flagged a follow-up for ${name}.`,
    onSuccess: onDone,
  })

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Flag a follow-up for {name}</DialogTitle>
        <DialogDescription>
          This client will appear under "due a follow-up" once the date
          arrives.
        </DialogDescription>
      </DialogHeader>

      <Form {...rhfForm}>
        <form
          noValidate
          onSubmit={rhfForm.handleSubmit((values) => action.execute(values))}
          className="flex flex-col gap-4"
        >
          <FormField
            control={rhfForm.control}
            name="followUpAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Follow-up date</FormLabel>
                <Popover>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button type="button" variant="outline" className="justify-start">
                        <CalendarIcon aria-hidden="true" />
                        {field.value == null
                          ? 'Choose a date'
                          : isoDateOnly(new Date(field.value))}
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-auto">
                    <Calendar
                      label="Choose a follow-up date"
                      selected={field.value == null ? null : new Date(field.value)}
                      fromDate={new Date()}
                      onSelect={(date) => field.onChange(date.toISOString())}
                    />
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={rhfForm.control}
            name="note"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Note (optional)</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ''}
                    placeholder="Why this follow-up matters"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={rhfForm.control}
            name="markAsContacted"
            render={({ field }) => (
              <FormItem>
                <CheckboxField
                  label="I just spoke with this client"
                  checked={field.value === true}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
                <FormMessage />
              </FormItem>
            )}
          />

          <FormRootError />
          <FormStatus>{action.statusMessage}</FormStatus>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" variant="champagne" loading={action.isPending}>
              Save follow-up
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  )
}
