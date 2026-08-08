// mannachef/apps/web/src/components/admin/calendar/dispatch-list.tsx

/**
 * The day's dispatch run — every engagement a chef has to physically show up
 * for, in the order they happen.
 *
 * ## What this is, and is not
 *
 * Props only, the same discipline as `calendar-grid.tsx` in this directory:
 * this component fetches nothing, calls no Server Action, and decides no
 * scheduling question. Its parent — a Server Component — loads the day's
 * rows (`getDispatchQueue`, or an equivalent single-day read), resolves each
 * stop's menu, and runs `findConflicts` from `@/server/scheduling` to learn
 * which adjacent pairs leave less slack than their combined travel buffers.
 * That verdict arrives on `DispatchEngagement.bufferConflictWithNext` as the
 * exact `AppointmentOverlapConflict` the engine produced for the gap between
 * this stop and the next one; this file only renders its `kind` and
 * `message`. It never re-derives a gap from `startsAt` / `endsAt` / the
 * buffer minutes — "is this gap tight" has time-zone and multi-chef-brigade
 * subtleties (see `scheduling.ts`) this component has no business
 * re-deciding. The one number this file *does* compute is the sum of every
 * stop's travel buffers, which is arithmetic, not scheduling — it does not
 * say whether any two stops fit together.
 *
 * ## Audience
 *
 * A chef standing in the kitchen doorway, phone in one hand, car keys in the
 * other, or a printed run sheet on the passenger seat. That reader wants the
 * next stop's time and address in one glance, not a dashboard — so the list
 * is dense, high-contrast, chronological, and every clock reading is
 * `tabular-nums` so a column of times does not ripple as it is skimmed.
 * `Card` / `Badge` / `DateTime` / `EmptyState` / `Separator` are the only
 * primitives it borrows; nothing here is a hand-rolled button, table, or date
 * formatter.
 *
 * Chronological order is the caller's contract, not something re-checked
 * here — `calendar-grid.tsx` trusts its caller's timing the same way.
 *
 * ## Print
 *
 * "Luxury Culinary" is dark-first and `globals.css` defines no print/light
 * tokens, so a plain `next dev` render taped to a clipboard would ask an
 * inkjet to reproduce pale `--color-linen` text on `--color-charcoal` —
 * unreadable, and wasteful if the household's printer skips backgrounds. The
 * `print:` utilities below flip every descendant to plain black text with
 * transparent backgrounds on a white sheet instead, and mark each stop
 * `print:break-inside-avoid` so a stop never splits across a page edge.
 */

import {
  Car,
  ChefHat,
  CircleAlert,
  Clock3,
  MapPin,
  Users,
  UtensilsCrossed,
} from 'lucide-react'

import type {
  AppointmentLike,
  AppointmentOverlapConflict,
} from '@/server/scheduling'
import type { AppointmentStatus } from '@mannachef/validators'

import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

// =============================================================================
// 1. Public shapes
// =============================================================================

/** A postal address, or enough of one to be worth printing. */
export interface DispatchAddress {
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
}

/**
 * One stop on the run, in the exact timing shape the conflict engine
 * consumes (`AppointmentLike` — `id`, `status`, `startsAt`, `endsAt`,
 * `prepStartsAt`, and both travel buffers) plus what a chef needs to find
 * the door and know what is being cooked.
 */
export interface DispatchEngagement extends AppointmentLike {
  readonly clientName: string | null
  readonly guestCount: number
  readonly address: DispatchAddress | null
  /** e.g. "3-course tasting — heirloom tomato, duck breast, cherry clafoutis". */
  readonly menuSummary: string | null
  /**
   * The `findConflicts` verdict for the gap between this stop and the next
   * one chronologically — omitted when the caller has not run the check
   * (e.g. a single-stop board), `null` when it has and found nothing.
   * Rendered verbatim; never recomputed here.
   */
  readonly bufferConflictWithNext?: AppointmentOverlapConflict | null
}

export interface DispatchListProps {
  /** The calendar day this run covers. Rendered in the heading only. */
  readonly date: Date | string
  readonly chefName?: string | null
  /** Chronological — the caller sorts; this component never re-orders. */
  readonly engagements: readonly DispatchEngagement[]
  readonly className?: string
}

// =============================================================================
// 2. Presentation-only lookups
//
// Every function below turns already-decided data into text or a colour. None
// of it decides anything: no gap arithmetic, no overlap arithmetic, nothing
// that could disagree with `@/server/scheduling`.
// =============================================================================

type BadgeVariant = NonNullable<BadgeProps['variant']>

const STATUS_META: Record<
  AppointmentStatus,
  { readonly label: string; readonly variant: BadgeVariant }
> = {
  REQUESTED: { label: 'Awaiting confirmation', variant: 'warning' },
  CONFIRMED: { label: 'Confirmed', variant: 'success' },
  IN_PROGRESS: { label: 'In progress', variant: 'champagne' },
  COMPLETED: { label: 'Completed', variant: 'muted' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
  NO_SHOW: { label: 'No-show', variant: 'destructive' },
}

const CONFLICT_META: Record<
  AppointmentOverlapConflict['kind'],
  { readonly label: string; readonly variant: BadgeVariant }
> = {
  // The rarer, more serious case: the engagements themselves overlap.
  CORE_OVERLAP: { label: 'Double-booked', variant: 'destructive' },
  // The expected case this list is built to surface: the stops do not
  // overlap, but the drive between them does not fit in what is left.
  BUFFER_OVERLAP: { label: 'Tight turnaround', variant: 'warning' },
}

function isNonEmpty(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0
}

/** Joins the non-empty parts of an address the way a chef would read it aloud. */
function formatAddress(address: DispatchAddress | null): string | null {
  if (address === null) {
    return null
  }

  const street = [address.line1, address.line2].filter(isNonEmpty).join(', ')
  const locality = [address.city, address.region].filter(isNonEmpty).join(', ')
  const parts = [street, locality, address.postalCode, address.country].filter(
    isNonEmpty
  )

  return parts.length > 0 ? parts.join(' · ') : null
}

/** "1h 45m" / "45m" / "0m" — never negative, never a decimal. */
function formatMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  if (hours === 0) {
    return `${String(rest)}m`
  }

  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`
}

/**
 * The day's total drive time: every stop's before-buffer plus its
 * after-buffer, summed. Deliberately not "time between stops" — that would
 * require deciding how much of a gap is drive versus slack, which is the
 * scheduling engine's call, not a display total's.
 */
function totalTravelMinutes(
  engagements: readonly DispatchEngagement[]
): number {
  return engagements.reduce(
    (sum, engagement) =>
      sum +
      engagement.travelBufferBeforeMinutes +
      engagement.travelBufferAfterMinutes,
    0
  )
}

function headingIdFor(date: Date | string): string {
  const key = typeof date === 'string' ? date : date.toISOString()
  return `dispatch-run-${key.replace(/[^a-zA-Z0-9]/g, '-')}`
}

// =============================================================================
// 3. Component
// =============================================================================

/**
 * The dispatch run: a chronological, print-friendly list of a day's
 * engagements.
 *
 * ```tsx
 * <DispatchList
 *   date={day}
 *   chefName={staff.user.name}
 *   engagements={rows.map(toDispatchListEngagement)}
 * />
 * ```
 */
export function DispatchList({
  date,
  chefName,
  engagements,
  className,
}: DispatchListProps) {
  const headingId = headingIdFor(date)
  const travelTotal = totalTravelMinutes(engagements)
  const warningCount = engagements.filter(
    (engagement) => engagement.bufferConflictWithNext != null
  ).length

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'space-y-5 text-linen',
        // Print flips the whole board to black-on-white: the champagne/dark
        // palette exists for a screen read before the drive, not a page
        // taped to a clipboard. `!` beats the on-screen colour utilities
        // regardless of Tailwind's own internal rule order.
        'print:space-y-3 print:bg-white print:text-black',
        'print:[&_*]:!bg-transparent print:[&_*]:!text-black print:[&_*]:!shadow-none',
        className
      )}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2
            id={headingId}
            className="font-display text-2xl leading-tight font-medium tracking-tight text-linen"
          >
            Dispatch run
          </h2>
          <p className="mt-0.5 text-sm text-parchment">
            <DateTime value={date} format="date" tone="muted" />
            {chefName != null && chefName !== '' ? <> · {chefName}</> : null}
          </p>
        </div>

        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
          <div className="flex items-center gap-1.5">
            <dt className="text-stone">Stops</dt>
            <dd className="font-medium tabular-nums text-linen">
              {engagements.length}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <Car aria-hidden="true" className="size-4 text-stone" />
            <dt className="text-stone">Total travel</dt>
            <dd className="font-medium tabular-nums text-linen">
              {formatMinutes(travelTotal)}
            </dd>
          </div>
          {warningCount > 0 ? (
            <Badge variant="warning" numeric>
              {warningCount} tight{' '}
              {warningCount === 1 ? 'turnaround' : 'turnarounds'}
            </Badge>
          ) : null}
        </dl>
      </header>

      <Separator variant="hairline" />

      {engagements.length === 0 ? (
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={3}
          title="Nothing on the run"
          description="No engagements are scheduled for this day."
        />
      ) : (
        <ol className="space-y-3 print:space-y-2">
          {engagements.map((engagement) => (
            <DispatchStop key={engagement.id} engagement={engagement} />
          ))}
        </ol>
      )}
    </section>
  )
}

// =============================================================================
// 4. One stop
// =============================================================================

function DispatchStop({
  engagement,
}: {
  readonly engagement: DispatchEngagement
}) {
  const statusMeta = STATUS_META[engagement.status]
  const address = formatAddress(engagement.address)
  const conflict = engagement.bufferConflictWithNext ?? null
  const conflictMeta = conflict === null ? null : CONFLICT_META[conflict.kind]
  const isCriticalConflict = conflict?.kind === 'CORE_OVERLAP'

  return (
    <Card
      as="li"
      variant="quiet"
      className="p-4 print:break-inside-avoid print:border-black print:p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="flex items-baseline gap-2 font-display text-lg leading-none font-medium tabular-nums text-linen">
          <Clock3 aria-hidden="true" className="size-4 shrink-0 text-stone" />
          <span>
            <DateTime
              value={engagement.startsAt}
              format="time"
              showTitle={false}
            />
            <span aria-hidden="true" className="mx-1 text-stone">
              –
            </span>
            <span className="sr-only"> until </span>
            <DateTime
              value={engagement.endsAt}
              format="time"
              tone="muted"
              showTitle={false}
            />
          </span>
        </p>
        <Badge variant={statusMeta.variant} srPrefix="Status: ">
          {statusMeta.label}
        </Badge>
      </div>

      <h3 className="mt-2 text-base font-semibold text-linen">
        {engagement.clientName ?? 'Unnamed client'}
      </h3>

      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm text-parchment sm:grid-cols-2">
        <div className="flex items-start gap-1.5">
          <MapPin
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-stone"
          />
          <div>
            <dt className="sr-only">Address</dt>
            <dd>{address ?? 'No address on file'}</dd>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Users aria-hidden="true" className="size-4 shrink-0 text-stone" />
          <dt className="sr-only">Guest count</dt>
          <dd className="tabular-nums">
            {engagement.guestCount}{' '}
            {engagement.guestCount === 1 ? 'guest' : 'guests'}
          </dd>
        </div>

        <div className="flex items-center gap-1.5">
          <ChefHat aria-hidden="true" className="size-4 shrink-0 text-stone" />
          <dt className="sr-only">Prep start</dt>
          <dd className="tabular-nums">
            Prep{' '}
            <DateTime
              value={engagement.prepStartsAt ?? engagement.startsAt}
              format="time"
              showTitle={false}
            />
          </dd>
        </div>

        <div className="flex items-center gap-1.5">
          <Car aria-hidden="true" className="size-4 shrink-0 text-stone" />
          <dt className="sr-only">Travel buffer</dt>
          <dd className="tabular-nums">
            {formatMinutes(engagement.travelBufferBeforeMinutes)} before ·{' '}
            {formatMinutes(engagement.travelBufferAfterMinutes)} after
          </dd>
        </div>
      </dl>

      {isNonEmpty(engagement.menuSummary) ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-parchment">
          <UtensilsCrossed
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-stone"
          />
          <span>{engagement.menuSummary}</span>
        </p>
      ) : null}

      {conflict !== null && conflictMeta !== null ? (
        <div
          className={cn(
            'mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
            isCriticalConflict
              ? 'border-claret/50 bg-claret/10 text-linen'
              : 'border-terracotta/40 bg-terracotta/8 text-linen',
            'print:border-black print:bg-transparent'
          )}
        >
          <CircleAlert
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-4 shrink-0',
              isCriticalConflict ? 'text-claret' : 'text-terracotta'
            )}
          />
          <p>
            <span className="sr-only">Warning: </span>
            <Badge
              variant={conflictMeta.variant}
              className="mr-1.5 align-middle"
            >
              {conflictMeta.label}
            </Badge>
            {conflict.message}
          </p>
        </div>
      ) : null}
    </Card>
  )
}
