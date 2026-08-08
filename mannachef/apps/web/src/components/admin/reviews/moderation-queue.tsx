// mannachef/apps/web/src/components/admin/reviews/moderation-queue.tsx
'use client'

import * as React from 'react'
import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import {
  ArrowDown,
  ArrowUp,
  ChefHat,
  MoreHorizontal,
  Sparkles,
  Star,
  UtensilsCrossed,
} from 'lucide-react'

import type { PageMeta } from '@mannachef/api-contract'
import {
  MAX_FEATURED_ORDER,
  reviewModerationSchema,
  reviewBulkModerationSchema,
  type Pagination,
  type ReviewBulkModerationInput,
  type ReviewSubject,
} from '@mannachef/validators'

import { useAction } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'
import { cn } from '@/lib/utils'
import { bulkModerateReviews, moderateReview } from '@/server/actions/review'
import type { AdminModeratedReviewView as ModeratedReviewView } from '@/components/admin/view-models'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DataTable,
  type DataTableColumn,
  type DataTableSelection,
} from '@/components/ui/data-table'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
  FormStatus,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupField } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Hint } from '@/components/ui/tooltip'

/**
 * The moderation hub's one client island.
 *
 * The Server Component above hands this exactly one page of one tab, already
 * filtered and sorted server-side — every control here that changes *what* is
 * shown (the tab, the search, the subject filter, the verified toggle, the
 * page) writes to the URL and lets the server re-render, the same convention
 * `MenuEnginePage`/`MenuTable` use. Every control that changes a *review* —
 * approve, reject, feature, unfeature, and the featured-carousel reorder —
 * calls a Server Action through `useAction` and then asks the router to
 * refresh, so the list re-fetches without a full navigation.
 */

const TAB_VALUES = ['PENDING', 'APPROVED', 'REJECTED', 'FEATURED'] as const
type TabValue = (typeof TAB_VALUES)[number]

const TAB_LABEL: Record<TabValue, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  FEATURED: 'Featured',
}

const SUBJECT_LABEL: Record<ReviewSubject, string> = {
  MENU_ITEM: 'Dish',
  CHEF: 'Chef',
  APPOINTMENT: 'Appointment',
  PLATFORM: 'Platform',
}

const SUBJECT_ICON: Record<
  ReviewSubject,
  React.ComponentType<{ className?: string }>
> = {
  MENU_ITEM: UtensilsCrossed,
  CHEF: ChefHat,
  APPOINTMENT: Star,
  PLATFORM: Sparkles,
}

export interface ModerationQueueProps {
  readonly rows: readonly ModeratedReviewView[]
  readonly meta: PageMeta
  readonly activeTab: TabValue
  readonly search: string
  readonly subject: ReviewSubject | 'ALL'
  readonly verifiedOnly: boolean
  readonly pagination: Pagination
}

/** Builds `/admin/reviews?…` for the next state, dropping empty params. */
function buildQuery(next: {
  readonly tab: TabValue
  readonly search: string
  readonly subject: ReviewSubject | 'ALL'
  readonly verifiedOnly: boolean
  readonly page: number
  readonly pageSize: number
}): Route {
  const params = new URLSearchParams()
  params.set('tab', next.tab)

  if (next.search.length > 0) {
    params.set('search', next.search)
  }
  if (next.subject !== 'ALL') {
    params.set('subject', next.subject)
  }
  if (next.verifiedOnly) {
    params.set('verifiedOnly', 'true')
  }
  if (next.page !== 1) {
    params.set('page', String(next.page))
  }
  if (next.pageSize !== 20) {
    params.set('pageSize', String(next.pageSize))
  }

  return `/admin/reviews?${params.toString()}`
}

export function ModerationQueue({
  rows,
  meta,
  activeTab,
  search,
  subject,
  verifiedOnly,
  pagination,
}: ModerationQueueProps): React.JSX.Element {
  const router = useRouter()
  const [searchDraft, setSearchDraft] = React.useState(search)
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])

  // The server hands us a new `search` every navigation; keep the draft input
  // in step with it rather than trusting stale local state after a tab
  // switch clears the query.
  React.useEffect(() => {
    setSearchDraft(search)
  }, [search])

  const goTo = React.useCallback(
    (
      partial: Partial<{
        tab: TabValue
        search: string
        subject: ReviewSubject | 'ALL'
        verifiedOnly: boolean
        page: number
        pageSize: number
      }>
    ) => {
      router.push(
        buildQuery({
          tab: activeTab,
          search,
          subject,
          verifiedOnly,
          page: pagination.page,
          pageSize: pagination.pageSize,
          ...partial,
        })
      )
    },
    [
      activeTab,
      pagination.page,
      pagination.pageSize,
      router,
      search,
      subject,
      verifiedOnly,
    ]
  )

  const refresh = React.useCallback(() => {
    setSelectedIds([])
    router.refresh()
  }, [router])

  const canBulkAct = activeTab === 'PENDING' || activeTab === 'APPROVED'

  const columns = React.useMemo<
    ReadonlyArray<DataTableColumn<ModeratedReviewView>>
  >(() => buildColumns(activeTab, refresh), [activeTab, refresh])

  const selection: DataTableSelection | undefined = canBulkAct
    ? {
        selectedIds,
        onSelectionChange: setSelectedIds,
      }
    : undefined

  return (
    <div className="flex flex-col gap-6">
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setSelectedIds([])
          goTo({ tab: value as TabValue, page: 1 })
        }}
      >
        <TabsList aria-label="Moderation status">
          {TAB_VALUES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {TAB_LABEL[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <form
        role="search"
        aria-label="Filter reviews"
        onSubmit={(event) => {
          event.preventDefault()
          goTo({ search: searchDraft.trim(), page: 1 })
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <label
            htmlFor="review-search"
            className="font-sans text-xs text-stone"
          >
            Search
          </label>
          <Input
            id="review-search"
            type="search"
            placeholder="Headline or body…"
            value={searchDraft}
            onChange={(event) => {
              setSearchDraft(event.target.value)
            }}
          />
        </div>

        <div className="flex min-w-40 flex-col gap-1.5">
          <label
            htmlFor="review-subject"
            className="font-sans text-xs text-stone"
          >
            Subject
          </label>
          <Select
            value={subject}
            onValueChange={(value) => {
              goTo({ subject: value as ReviewSubject | 'ALL', page: 1 })
            }}
          >
            <SelectTrigger id="review-subject">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Every subject</SelectItem>
              {(Object.keys(SUBJECT_LABEL) as ReviewSubject[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {SUBJECT_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="review-verified-only"
            checked={verifiedOnly}
            onCheckedChange={(checked) => {
              goTo({ verifiedOnly: checked, page: 1 })
            }}
          />
          <label
            htmlFor="review-verified-only"
            className="font-sans text-sm text-parchment"
          >
            Verified only
          </label>
        </div>

        <Button type="submit" variant="outline" size="md">
          Apply
        </Button>
      </form>

      {canBulkAct && selectedIds.length > 0 ? (
        <BulkActionsBar
          activeTab={activeTab}
          selectedIds={selectedIds}
          onDone={refresh}
        />
      ) : null}

      <DataTable
        caption={`${TAB_LABEL[activeTab]} reviews`}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        {...(selection === undefined ? {} : { selection })}
        pagination={pagination}
        rowCount={meta.total}
        onPaginationChange={(next) => {
          goTo({ page: next.page, pageSize: next.pageSize })
        }}
        empty={{
          title: 'No reviews here yet',
          description: `Nothing is currently ${TAB_LABEL[activeTab].toLowerCase()}.`,
        }}
      />
    </div>
  )
}

// =============================================================================
// Columns
// =============================================================================

function buildColumns(
  activeTab: TabValue,
  onDone: () => void
): ReadonlyArray<DataTableColumn<ModeratedReviewView>> {
  const base: Array<DataTableColumn<ModeratedReviewView>> = [
    {
      id: 'subject',
      header: 'Attached to',
      width: '13rem',
      cell: (row) => <SubjectCell row={row} />,
    },
    {
      id: 'review',
      header: 'Review',
      cell: (row) => <ReviewCell row={row} />,
    },
    {
      id: 'author',
      header: 'Guest',
      width: '10rem',
      cell: (row) => (
        <span className="text-parchment">
          {row.authorName ?? 'Deleted guest'}
        </span>
      ),
    },
    {
      id: 'verified',
      header: 'Verified',
      width: '7rem',
      cell: (row) => (
        <Badge variant={row.isVerified ? 'success' : 'muted'}>
          {row.isVerified ? 'Verified' : 'Unverified'}
        </Badge>
      ),
    },
    {
      id: 'submitted',
      header: 'Submitted',
      width: '9rem',
      cell: (row) => (
        <DateTime value={row.createdAt} format="relative" tone="subtle" />
      ),
    },
  ]

  const statusColumn: DataTableColumn<ModeratedReviewView> | null =
    activeTab === 'FEATURED'
      ? {
          id: 'order',
          header: 'Homepage position',
          width: '11rem',
          cell: (row) => <FeaturedOrderControl row={row} onDone={onDone} />,
        }
      : activeTab === 'APPROVED'
        ? {
            id: 'moderated',
            header: 'Approved',
            width: '11rem',
            cell: (row) => <ModeratedCell row={row} />,
          }
        : activeTab === 'REJECTED'
          ? {
              id: 'moderated',
              header: 'Rejected',
              width: '11rem',
              cell: (row) => <ModeratedCell row={row} />,
            }
          : null

  const actionsColumn: DataTableColumn<ModeratedReviewView> = {
    id: 'actions',
    header: 'Actions',
    headerSrOnly: true,
    width: '3rem',
    cell: (row) => (
      <RowActions row={row} activeTab={activeTab} onDone={onDone} />
    ),
  }

  return statusColumn === null
    ? [...base, actionsColumn]
    : [...base, statusColumn, actionsColumn]
}

function SubjectCell({
  row,
}: {
  readonly row: ModeratedReviewView
}): React.JSX.Element {
  const Icon = SUBJECT_ICON[row.subject]
  const detail =
    row.subject === 'MENU_ITEM'
      ? (row.menuItemName ?? 'Deleted dish')
      : row.subject === 'CHEF'
        ? (row.staffName ?? 'Deleted staff profile')
        : row.subject === 'APPOINTMENT'
          ? `Engagement #${row.appointmentId?.slice(-8) ?? '—'}`
          : 'The house, overall'

  return (
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5 font-sans text-xs tracking-wide text-stone uppercase">
        <Icon className="size-3.5" />
        {SUBJECT_LABEL[row.subject]}
      </span>
      <span className="truncate font-sans text-sm text-linen">{detail}</span>
      {row.subject !== 'APPOINTMENT' && row.appointmentId !== null ? (
        <span className="font-sans text-xs text-stone">
          Served engagement #{row.appointmentId.slice(-8)}
        </span>
      ) : null}
    </div>
  )
}

function ReviewCell({
  row,
}: {
  readonly row: ModeratedReviewView
}): React.JSX.Element {
  return (
    <div className="flex max-w-md flex-col gap-1">
      <div className="flex items-center gap-2">
        <RatingStars rating={row.rating} />
        {row.title !== null && row.title.length > 0 ? (
          <span className="truncate font-sans text-sm font-medium text-linen">
            {row.title}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 font-sans text-sm leading-relaxed text-parchment">
        {row.body}
      </p>
    </div>
  )
}

function RatingStars({
  rating,
}: {
  readonly rating: number
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <Star
          key={index}
          className={cn(
            'size-3.5',
            index < rating ? 'fill-champagne text-champagne' : 'text-ash'
          )}
        />
      ))}
      <span className="sr-only">{`${String(rating)} out of 5 stars`}</span>
    </span>
  )
}

function ModeratedCell({
  row,
}: {
  readonly row: ModeratedReviewView
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <DateTime value={row.moderatedAt} format="date" tone="muted" />
      <span className="font-sans text-xs text-stone">
        {row.moderatedByName ?? 'A moderator'}
      </span>
      {row.moderationNote !== null && row.moderationNote.length > 0 ? (
        <Hint label={row.moderationNote}>
          <button
            type="button"
            className="w-fit rounded-sm font-sans text-xs text-parchment underline-offset-4 hover:text-linen hover:underline"
          >
            View note
          </button>
        </Hint>
      ) : null}
    </div>
  )
}

// =============================================================================
// Featured-carousel reorder
// =============================================================================

function FeaturedOrderControl({
  row,
  onDone,
}: {
  readonly row: ModeratedReviewView
  readonly onDone: () => void
}): React.JSX.Element {
  const currentOrder = row.featuredOrder ?? 0
  const [draft, setDraft] = React.useState(String(currentOrder))

  React.useEffect(() => {
    setDraft(String(currentOrder))
  }, [currentOrder])

  // No success toast — a nudge to the featured order is visible in the table
  // itself. Failures (a stale row, a lost permission) still need to be heard,
  // so this deliberately does not pass `silent`.
  const { execute, isPending } = useAction(moderateReview, {
    onSuccess: onDone,
  })

  const move = React.useCallback(
    (delta: number) => {
      const next = Math.min(
        Math.max(0, currentOrder + delta),
        MAX_FEATURED_ORDER
      )
      if (next === currentOrder) {
        return
      }
      void execute({ action: 'FEATURE', reviewId: row.id, featuredOrder: next })
    },
    [currentOrder, execute, row.id]
  )

  const commitDraft = React.useCallback(() => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed) || parsed === currentOrder) {
      setDraft(String(currentOrder))
      return
    }
    const clamped = Math.min(Math.max(0, parsed), MAX_FEATURED_ORDER)
    void execute({
      action: 'FEATURE',
      reviewId: row.id,
      featuredOrder: clamped,
    })
  }, [currentOrder, draft, execute, row.id])

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={isPending || currentOrder <= 0}
        onClick={() => {
          move(-1)
        }}
      >
        <ArrowUp aria-hidden="true" className="size-4" />
        <span className="sr-only">Move earlier in the carousel</span>
      </Button>
      <label className="sr-only" htmlFor={`featured-order-${row.id}`}>
        Homepage position
      </label>
      <Input
        id={`featured-order-${row.id}`}
        type="number"
        inputSize="sm"
        numeric
        min={0}
        max={MAX_FEATURED_ORDER}
        className="w-16 text-center"
        value={draft}
        disabled={isPending}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitDraft()
          }
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={isPending || currentOrder >= MAX_FEATURED_ORDER}
        onClick={() => {
          move(1)
        }}
      >
        <ArrowDown aria-hidden="true" className="size-4" />
        <span className="sr-only">Move later in the carousel</span>
      </Button>
    </div>
  )
}

// =============================================================================
// Row actions
// =============================================================================

type DialogKind = 'reject' | 'feature' | 'unfeature' | null

function RowActions({
  row,
  activeTab,
  onDone,
}: {
  readonly row: ModeratedReviewView
  readonly activeTab: TabValue
  readonly onDone: () => void
}): React.JSX.Element {
  const [dialogKind, setDialogKind] = React.useState<DialogKind>(null)

  const { execute: executeApprove, isPending: isApproving } = useAction(
    moderateReview,
    {
      successMessage: 'Review approved.',
      onSuccess: onDone,
    }
  )

  const canApprove = activeTab === 'PENDING' || activeTab === 'REJECTED'
  const canReject = activeTab === 'PENDING' || activeTab === 'APPROVED'
  const canFeature = activeTab !== 'FEATURED'
  const canUnfeature = activeTab === 'FEATURED'

  const guestLabel = row.authorName ?? 'a guest'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Actions for the review from ${guestLabel}`}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canApprove ? (
            <DropdownMenuItem
              disabled={isApproving}
              onSelect={() => {
                void executeApprove({ action: 'APPROVE', reviewId: row.id })
              }}
            >
              Approve
            </DropdownMenuItem>
          ) : null}
          {canFeature ? (
            <DropdownMenuItem
              onSelect={() => {
                setDialogKind('feature')
              }}
            >
              Feature…
            </DropdownMenuItem>
          ) : null}
          {canReject ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                setDialogKind('reject')
              }}
            >
              Reject…
            </DropdownMenuItem>
          ) : null}
          {canUnfeature ? (
            <DropdownMenuItem
              onSelect={() => {
                setDialogKind('unfeature')
              }}
            >
              Remove from homepage…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={dialogKind !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogKind(null)
          }
        }}
      >
        <DialogContent>
          {dialogKind === 'reject' ? (
            <RejectForm
              reviewId={row.id}
              onCancel={() => {
                setDialogKind(null)
              }}
              onDone={() => {
                setDialogKind(null)
                onDone()
              }}
            />
          ) : dialogKind === 'feature' ? (
            <FeatureForm
              reviewId={row.id}
              defaultOrder={row.featuredOrder}
              onCancel={() => {
                setDialogKind(null)
              }}
              onDone={() => {
                setDialogKind(null)
                onDone()
              }}
            />
          ) : dialogKind === 'unfeature' ? (
            <UnfeatureForm
              reviewId={row.id}
              onCancel={() => {
                setDialogKind(null)
              }}
              onDone={() => {
                setDialogKind(null)
                onDone()
              }}
            />
          ) : (
            <DialogTitle className="sr-only">Moderate review</DialogTitle>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// =============================================================================
// Single-review dialogs
// =============================================================================

interface RejectFormValues {
  readonly action: 'REJECT'
  readonly reviewId: string
  readonly moderationNote: string
}

const rejectFormSchema = reviewModerationSchema.options[1]

function RejectForm({
  reviewId,
  onCancel,
  onDone,
}: {
  readonly reviewId: string
  readonly onCancel: () => void
  readonly onDone: () => void
}): React.JSX.Element {
  const form = useForm<RejectFormValues>({
    resolver: zodResolver(rejectFormSchema),
    defaultValues: { action: 'REJECT', reviewId, moderationNote: '' },
  })

  const { execute, isPending, statusMessage } = useAction(moderateReview, {
    form,
    successMessage: 'Review turned away.',
    onSuccess: onDone,
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          void execute(values)
        })}
        noValidate
        className="flex flex-col gap-5"
      >
        <DialogHeader>
          <DialogTitle>Reject this review</DialogTitle>
          <DialogDescription>
            The guest never sees this note — the next moderator will.
          </DialogDescription>
        </DialogHeader>

        <FormField
          control={form.control}
          name="moderationNote"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Reason</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Why this review is not being published…"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />
        <FormStatus>{statusMessage}</FormStatus>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive" loading={isPending}>
            Reject review
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

interface FeatureFormValues {
  readonly action: 'FEATURE'
  readonly reviewId: string
  readonly featuredOrder: number
  readonly moderationNote?: string | null | undefined
}

const featureFormSchema = reviewModerationSchema.options[2]

function FeatureForm({
  reviewId,
  defaultOrder,
  onCancel,
  onDone,
}: {
  readonly reviewId: string
  readonly defaultOrder: number | null
  readonly onCancel: () => void
  readonly onDone: () => void
}): React.JSX.Element {
  const form = useForm<FeatureFormValues>({
    resolver: zodResolver(featureFormSchema),
    defaultValues: {
      action: 'FEATURE',
      reviewId,
      featuredOrder: defaultOrder ?? 0,
      moderationNote: '',
    },
  })

  const { execute, isPending, statusMessage } = useAction(moderateReview, {
    form,
    successMessage: 'Added to the homepage carousel.',
    onSuccess: onDone,
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          void execute(values)
        })}
        noValidate
        className="flex flex-col gap-5"
      >
        <DialogHeader>
          <DialogTitle>Feature this review</DialogTitle>
          <DialogDescription>
            Featuring is what puts a review in the homepage carousel. A lower
            position shows first.
          </DialogDescription>
        </DialogHeader>

        <FormField
          control={form.control}
          name="featuredOrder"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Homepage position</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  numeric
                  inputMode="numeric"
                  min={0}
                  max={MAX_FEATURED_ORDER}
                  name={field.name}
                  ref={field.ref}
                  disabled={field.disabled}
                  value={field.value}
                  onBlur={field.onBlur}
                  onChange={(event) => {
                    field.onChange(event.target.valueAsNumber)
                  }}
                />
              </FormControl>
              <FormDescription>0 is the leading position.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="moderationNote"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Note (optional)</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Context for the next moderator…"
                  name={field.name}
                  ref={field.ref}
                  disabled={field.disabled}
                  value={field.value ?? ''}
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />
        <FormStatus>{statusMessage}</FormStatus>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="champagne" loading={isPending}>
            Feature review
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

interface UnfeatureFormValues {
  readonly action: 'UNFEATURE'
  readonly reviewId: string
  readonly returnTo?: 'APPROVED' | 'PENDING' | undefined
}

const unfeatureFormSchema = reviewModerationSchema.options[3]

function UnfeatureForm({
  reviewId,
  onCancel,
  onDone,
}: {
  readonly reviewId: string
  readonly onCancel: () => void
  readonly onDone: () => void
}): React.JSX.Element {
  const form = useForm<UnfeatureFormValues>({
    resolver: zodResolver(unfeatureFormSchema),
    defaultValues: { action: 'UNFEATURE', reviewId, returnTo: 'APPROVED' },
  })
  const labelId = React.useId()

  const { execute, isPending, statusMessage } = useAction(moderateReview, {
    form,
    successMessage: 'Removed from the homepage carousel.',
    onSuccess: onDone,
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          void execute(values)
        })}
        noValidate
        className="flex flex-col gap-5"
      >
        <DialogHeader>
          <DialogTitle>Remove from the homepage</DialogTitle>
          <DialogDescription>
            Choose where this review should sit once it leaves the carousel.
          </DialogDescription>
        </DialogHeader>

        <FormField
          control={form.control}
          name="returnTo"
          render={({ field, fieldState }) => (
            <div className="flex flex-col gap-2">
              <span
                id={labelId}
                className="font-sans text-sm font-medium text-linen"
              >
                After removing
              </span>
              <RadioGroup
                value={field.value ?? 'APPROVED'}
                onValueChange={field.onChange}
                aria-labelledby={labelId}
              >
                <RadioGroupField
                  value="APPROVED"
                  label="Keep it published"
                  description="Stays visible on the reviews page."
                />
                <RadioGroupField
                  value="PENDING"
                  label="Send back to pending"
                  description="Removed from public view until reviewed again."
                />
              </RadioGroup>
              {fieldState.error?.message !== undefined ? (
                <p
                  role="alert"
                  className="font-sans text-xs leading-relaxed text-claret-ink"
                >
                  {fieldState.error.message}
                </p>
              ) : null}
            </div>
          )}
        />

        <FormRootError />
        <FormStatus>{statusMessage}</FormStatus>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="outline" loading={isPending}>
            Remove from homepage
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

// =============================================================================
// Bulk actions
// =============================================================================

function BulkActionsBar({
  activeTab,
  selectedIds,
  onDone,
}: {
  readonly activeTab: TabValue
  readonly selectedIds: readonly string[]
  readonly onDone: () => void
}): React.JSX.Element {
  const [rejectOpen, setRejectOpen] = React.useState(false)

  const { execute: executeApprove, isPending: isApproving } = useAction(
    bulkModerateReviews,
    {
      successMessage: (data) => `Approved ${String(data.moderated)} review(s).`,
      onSuccess: onDone,
    }
  )

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ash bg-charcoal/60 px-4 py-3">
      <p className="font-sans text-sm text-parchment">
        {selectedIds.length} review{selectedIds.length === 1 ? '' : 's'}{' '}
        selected
      </p>
      <div className="ml-auto flex items-center gap-2">
        {activeTab === 'PENDING' ? (
          <Button
            type="button"
            variant="champagne"
            size="sm"
            loading={isApproving}
            onClick={() => {
              void executeApprove({
                action: 'APPROVE',
                reviewIds: [...selectedIds],
              })
            }}
          >
            Approve selected
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setRejectOpen(true)
          }}
        >
          Reject selected
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <BulkRejectForm
            reviewIds={selectedIds}
            onCancel={() => {
              setRejectOpen(false)
            }}
            onDone={() => {
              setRejectOpen(false)
              onDone()
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BulkRejectForm({
  reviewIds,
  onCancel,
  onDone,
}: {
  readonly reviewIds: readonly string[]
  readonly onCancel: () => void
  readonly onDone: () => void
}): React.JSX.Element {
  const form = useForm<ReviewBulkModerationInput>({
    resolver: zodResolver(reviewBulkModerationSchema),
    defaultValues: {
      action: 'REJECT',
      reviewIds: [...reviewIds],
      moderationNote: '',
    },
  })

  const { execute, isPending, statusMessage } = useAction(bulkModerateReviews, {
    form,
    successMessage: (data) =>
      `Turned away ${String(data.moderated)} review(s).`,
    onSuccess: onDone,
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          void execute(values)
        })}
        noValidate
        className="flex flex-col gap-5"
      >
        <DialogHeader>
          <DialogTitle>
            Reject {reviewIds.length} review{reviewIds.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            One reason is recorded against every review selected. The guests
            never see it; the next moderator will.
          </DialogDescription>
        </DialogHeader>

        <FormField
          control={form.control}
          name="moderationNote"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Reason</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Why these reviews are not being published…"
                  name={field.name}
                  ref={field.ref}
                  disabled={field.disabled}
                  value={field.value ?? ''}
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />
        <FormStatus>{statusMessage}</FormStatus>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive" loading={isPending}>
            Reject reviews
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
