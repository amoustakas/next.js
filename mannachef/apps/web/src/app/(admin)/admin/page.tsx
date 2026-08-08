// mannachef/apps/web/src/app/(admin)/admin/page.tsx
import { cache, Suspense, type ReactNode } from 'react'
import Link from 'next/link'
import type { Metadata, Route } from 'next'
import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  Hourglass,
  LogIn,
  ShieldAlert,
  TrendingDown,
  UserRoundSearch,
  Users,
  type LucideIcon,
} from 'lucide-react'

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

import { getBillingDashboard } from '@/server/actions/billing'
import { readChurnRate, queryClientPipeline } from '@/server/actions/crm'
import { listModerationQueue } from '@/server/actions/review'
import { getDispatchQueue } from '@/server/actions/booking'

export const metadata: Metadata = {
  title: 'Overview',
}

/**
 * Where each tile's call to action goes.
 *
 * Every entry is a route that exists. Three of them used to name screens that
 * were never built (`/admin/billing`, `/admin/crm`, `/admin/appointments`),
 * which made the dashboard's primary drill-downs dead ends; they now point at
 * the screens that actually hold the figures:
 *
 *  - `billing` → the Billing OS, which is what `/admin/subscriptions` renders:
 *    MRR, the subscriber base by status, and money collected against owed.
 *  - `churn` → the client pipeline. The tile states a *rate*; the pipeline is
 *    where the households behind it stand, in a `CHURNED` column. The old
 *    `?tab=churn` is dropped rather than carried, because `/admin/clients`
 *    reads no `tab` key and a query the destination ignores is a promise the
 *    interface does not keep.
 *  - `appointments` → the calendar, which is the diary this tile counts from.
 *
 * `pipeline` keeps its query: `?followUpDue=true` is read by
 * `/admin/clients` through `clientPipelineFilterSchema`, whose `followUpDue`
 * is a `queryFlag` — so the link lands on the filtered board, not the whole of
 * it. That is the one query string here that the destination honours, and the
 * reason it survives while `?tab=churn` did not.
 */
const ROUTES = {
  billing: '/admin/subscriptions',
  churn: '/admin/clients',
  appointments: '/admin/calendar',
  moderation: '/admin/reviews?awaitingModeration=true',
  pipeline: '/admin/clients?followUpDue=true',
} as const

const CHURN_WINDOW_MONTHS = 3

function churnRange(): { start: Date; end: Date } {
  const end = new Date()
  const start = new Date(end)
  start.setMonth(start.getMonth() - CHURN_WINDOW_MONTHS)
  return { start, end }
}

// =============================================================================
// Cached fetchers.
//
// `cache()` gives each of these a single call per request. `MrrTile` and
// `ActiveSubscribersTile` both read the same billing dashboard aggregate —
// without this they would issue the query twice for one page render. It does
// not stop `readChurnRate`, `listModerationQueue`, `queryClientPipeline`, or
// `getDispatchQueue` from resolving independently: each keeps its own
// `<Suspense>` boundary below, so a slow one never blocks the rest of the page.
// =============================================================================

const getBillingSnapshot = cache(() => getBillingDashboard({}))

const getChurnSnapshot = cache(() =>
  readChurnRate({ range: churnRange(), granularity: 'MONTH' })
)

const getDispatchSnapshot = cache(() => getDispatchQueue({}))

const getModerationSnapshot = cache(() =>
  listModerationQueue({
    awaitingModeration: true,
    pageSize: 3,
    sortDirection: 'asc',
  })
)

const getFollowUpSnapshot = cache(() =>
  queryClientPipeline({
    followUpDue: true,
    pageSize: 3,
    sortBy: 'FOLLOW_UP',
    sortDirection: 'asc',
  })
)

// =============================================================================
// Shell — every tile is a labelled article with an icon, a figure, and (when
// there is somewhere useful to send the reader) a link to the screen that
// explains the number. Error states never sit inside that outer link: one of
// them renders its own "Sign in" button, and a link cannot nest inside a link.
// =============================================================================

function TileIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-ash bg-charcoal text-stone"
    >
      <Icon className="size-4" />
    </span>
  )
}

function TileShell({
  icon,
  label,
  href,
  cta,
  children,
}: {
  icon: LucideIcon
  label: string
  href?: Route
  cta?: string
  children: ReactNode
}) {
  const body = (
    <Card
      as="article"
      variant={href === undefined ? 'default' : 'interactive'}
      className="h-full"
    >
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle level={3}>{label}</CardTitle>
        <TileIcon icon={icon} />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">{children}</CardContent>
      {href !== undefined && cta !== undefined ? (
        <CardFooter className="justify-between text-xs text-stone">
          <span>{cta}</span>
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </CardFooter>
      ) : null}
    </Card>
  )

  if (href === undefined) {
    return body
  }

  return (
    <Link href={href} className="block h-full rounded-lg">
      {body}
    </Link>
  )
}

function TileSkeleton({ label }: { label: string }) {
  return (
    <Card as="article" className="h-full">
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <Skeleton shape="text" className="h-6 w-36" />
        <Skeleton shape="circle" className="size-9" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <Skeleton shape="text" className="h-8 w-28" />
        <SkeletonText lines={2} label={`Loading ${label}…`} />
      </CardContent>
      <CardFooter>
        <Skeleton shape="text" className="h-4 w-32" />
      </CardFooter>
    </Card>
  )
}

/**
 * Every `ActionErrorCode` from `CONTRACT.md` §4, given a distinct read. A
 * `FORBIDDEN` tile never looks like a broken one — it says whose call it is to
 * fix, not "an error occurred."
 */
function TileErrorState({
  code,
  error,
  subject,
}: {
  code: string
  error: string
  subject: string
}) {
  switch (code) {
    case 'FORBIDDEN':
      return (
        <EmptyState
          tone="filtered"
          size="sm"
          headingLevel={4}
          icon={ShieldAlert}
          title="Not visible to your role"
          description={`Your account can't see ${subject}. Ask an administrator to widen your access.`}
        />
      )
    case 'UNAUTHENTICATED':
      return (
        <EmptyState
          tone="filtered"
          size="sm"
          headingLevel={4}
          icon={LogIn}
          title="Sign in again"
          description="Your session ended before this could load."
          action={
            <Button asChild size="sm" variant="outline">
              {/*
                Auth.js v5 mounts its own sign-in page under the handler's base
                path, and `auth.ts` sets no `pages.signIn` override — so this is
                the real door, not `/sign-in`, which was never built. The portal
                layout's `SIGN_IN_PATH` is the same string for the same reason.
                `callbackUrl` returns the admin here rather than to the site root
                once the session is renewed.
              */}
              <Link href="/api/auth/signin?callbackUrl=%2Fadmin">Sign in</Link>
            </Button>
          }
        />
      )
    case 'RATE_LIMITED':
      return (
        <EmptyState
          tone="filtered"
          size="sm"
          headingLevel={4}
          icon={Hourglass}
          title="Give it a moment"
          description="This figure hit a rate limit. It will load again on your next visit."
        />
      )
    default:
      return (
        <EmptyState
          tone="error"
          size="sm"
          headingLevel={4}
          icon={AlertTriangle}
          title="Couldn't load this figure"
          description={error}
        />
      )
  }
}

// =============================================================================
// Tiles.
// =============================================================================

async function MrrTile() {
  const result = await getBillingSnapshot()

  if (!result.ok) {
    return (
      <TileShell icon={Banknote} label="Monthly recurring revenue">
        <TileErrorState
          code={result.code}
          error={result.error}
          subject="monthly recurring revenue"
        />
      </TileShell>
    )
  }

  const view = result.data
  const primary =
    view.mrr.find((bucket) => bucket.currency === 'CAD') ?? view.mrr[0]

  if (primary === undefined || primary.mrrCents === 0) {
    return (
      <TileShell
        icon={Banknote}
        label="Monthly recurring revenue"
        href={ROUTES.billing}
        cta="Open billing dashboard"
      >
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={4}
          title="No recurring revenue yet"
          description="No active or trialing subscription is contributing to MRR this window."
        />
      </TileShell>
    )
  }

  const otherCurrencies = view.mrr.filter(
    (bucket) => bucket.currency !== primary.currency
  )

  return (
    <TileShell
      icon={Banknote}
      label="Monthly recurring revenue"
      href={ROUTES.billing}
      cta="Open billing dashboard"
    >
      <Money
        cents={primary.mrrCents}
        currency={primary.currency}
        tone="accent"
        weight="semibold"
        className="text-3xl"
      />
      <p className="text-sm text-parchment">
        {primary.subscriberCount}{' '}
        {primary.subscriberCount === 1 ? 'subscriber' : 'subscribers'}
        {' · '}
        {primary.subscriptionCount}{' '}
        {primary.subscriptionCount === 1 ? 'subscription' : 'subscriptions'}
      </p>
      {otherCurrencies.length > 0 ? (
        <p className="text-xs text-stone">
          +{otherCurrencies.length} more currenc
          {otherCurrencies.length === 1 ? 'y' : 'ies'} on the full dashboard
        </p>
      ) : null}
    </TileShell>
  )
}

async function ActiveSubscribersTile() {
  const result = await getBillingSnapshot()

  if (!result.ok) {
    return (
      <TileShell icon={Users} label="Active subscribers">
        <TileErrorState
          code={result.code}
          error={result.error}
          subject="active subscribers"
        />
      </TileShell>
    )
  }

  const view = result.data

  if (view.activeSubscribers === 0) {
    return (
      <TileShell
        icon={Users}
        label="Active subscribers"
        href={ROUTES.billing}
        cta="Open billing dashboard"
      >
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={4}
          title="No active subscribers"
          description="Nobody holds a trialing or active subscription right now."
        />
      </TileShell>
    )
  }

  const trialing = view.subscriptionsByStatus.TRIALING ?? 0
  const pastDue = view.subscriptionsByStatus.PAST_DUE ?? 0

  return (
    <TileShell
      icon={Users}
      label="Active subscribers"
      href={ROUTES.billing}
      cta="Open billing dashboard"
    >
      <span className="text-3xl font-semibold text-champagne tabular-nums">
        {view.activeSubscribers}
      </span>
      {trialing > 0 || pastDue > 0 ? (
        <div className="flex flex-wrap gap-2">
          {trialing > 0 ? (
            <Badge variant="outline" numeric>
              {trialing} trialing
            </Badge>
          ) : null}
          {pastDue > 0 ? (
            <Badge variant="warning" numeric>
              {pastDue} past due
            </Badge>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-parchment">All in good standing.</p>
      )}
    </TileShell>
  )
}

async function ChurnTile() {
  const result = await getChurnSnapshot()

  if (!result.ok) {
    return (
      <TileShell icon={TrendingDown} label="Churn">
        <TileErrorState
          code={result.code}
          error={result.error}
          subject="the churn rate"
        />
      </TileShell>
    )
  }

  const report = result.data

  if (report.overallChurnRate === null) {
    return (
      <TileShell
        icon={TrendingDown}
        label="Churn"
        href={ROUTES.churn}
        cta="Open the client pipeline"
      >
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={4}
          title="Nothing to churn from"
          description={`There were no subscribers at the start of the last ${CHURN_WINDOW_MONTHS} months.`}
        />
      </TileShell>
    )
  }

  return (
    <TileShell
      icon={TrendingDown}
      label="Churn"
      href={ROUTES.churn}
      cta="Open the client pipeline"
    >
      <span className="text-3xl font-semibold text-champagne tabular-nums">
        {report.overallChurnRate.toFixed(1)}%
      </span>
      <p className="text-sm text-parchment">
        {report.totalChurned}{' '}
        {report.totalChurned === 1 ? 'household' : 'households'} lost over the
        last {CHURN_WINDOW_MONTHS} months
      </p>
    </TileShell>
  )
}

async function UpcomingAppointmentsTile() {
  const result = await getDispatchSnapshot()

  if (!result.ok) {
    return (
      <TileShell icon={CalendarClock} label="Upcoming appointments">
        <TileErrorState
          code={result.code}
          error={result.error}
          subject="the dispatch board"
        />
      </TileShell>
    )
  }

  const board = result.data

  if (board.counts.upcoming === 0 && board.counts.awaitingConfirmation === 0) {
    return (
      <TileShell
        icon={CalendarClock}
        label="Upcoming appointments"
        href={ROUTES.appointments}
        cta="Open the calendar"
      >
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={4}
          title="Nothing on the board"
          description="No confirmed or requested engagements in the next 7 days."
        />
      </TileShell>
    )
  }

  const next = board.upcoming[0]

  return (
    <TileShell
      icon={CalendarClock}
      label="Upcoming appointments"
      href={ROUTES.appointments}
      cta="Open the calendar"
    >
      <span className="text-3xl font-semibold text-champagne tabular-nums">
        {board.counts.upcoming}
      </span>
      {board.counts.awaitingConfirmation > 0 || board.counts.overdue > 0 ? (
        <div className="flex flex-wrap gap-2">
          {board.counts.awaitingConfirmation > 0 ? (
            <Badge variant="warning" numeric>
              {board.counts.awaitingConfirmation} awaiting confirmation
            </Badge>
          ) : null}
          {board.counts.overdue > 0 ? (
            <Badge variant="destructive" numeric>
              {board.counts.overdue} overdue
            </Badge>
          ) : null}
        </div>
      ) : null}
      {next !== undefined ? (
        <p className="text-xs text-stone">
          Next: {next.clientName ?? 'Unnamed client'} ·{' '}
          <DateTime value={next.startsAt} format="relative" tone="subtle" />
        </p>
      ) : null}
    </TileShell>
  )
}

async function ModerationQueueTile() {
  const result = await getModerationSnapshot()

  if (!result.ok) {
    return (
      <TileShell icon={ShieldAlert} label="Moderation queue">
        <TileErrorState
          code={result.code}
          error={result.error}
          subject="the moderation queue"
        />
      </TileShell>
    )
  }

  const queue = result.data

  if (queue.meta.total === 0) {
    return (
      <TileShell
        icon={ShieldAlert}
        label="Moderation queue"
        href={ROUTES.moderation}
        cta="Open review moderation"
      >
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={4}
          title="Queue is clear"
          description="Every submitted review has been moderated."
        />
      </TileShell>
    )
  }

  const longestWaiting = queue.items[0]

  return (
    <TileShell
      icon={ShieldAlert}
      label="Moderation queue"
      href={ROUTES.moderation}
      cta="Open review moderation"
    >
      <span className="text-3xl font-semibold text-champagne tabular-nums">
        {queue.meta.total}
      </span>
      <p className="text-sm text-parchment">
        {queue.meta.total === 1
          ? 'review awaiting moderation'
          : 'reviews awaiting moderation'}
      </p>
      {longestWaiting !== undefined ? (
        <p className="text-xs text-stone">
          Longest waiting: {longestWaiting.authorName ?? 'A guest'} ·{' '}
          <DateTime
            value={longestWaiting.createdAt}
            format="relative"
            tone="subtle"
          />
        </p>
      ) : null}
    </TileShell>
  )
}

async function FollowUpTile() {
  const result = await getFollowUpSnapshot()

  if (!result.ok) {
    return (
      <TileShell icon={UserRoundSearch} label="Prospects needing follow-up">
        <TileErrorState
          code={result.code}
          error={result.error}
          subject="the follow-up queue"
        />
      </TileShell>
    )
  }

  const pipeline = result.data

  if (pipeline.meta.total === 0) {
    return (
      <TileShell
        icon={UserRoundSearch}
        label="Prospects needing follow-up"
        href={ROUTES.pipeline}
        cta="Open CRM pipeline"
      >
        <EmptyState
          tone="empty"
          size="sm"
          headingLevel={4}
          title="Everyone's been reached"
          description="No prospect has a follow-up due right now."
        />
      </TileShell>
    )
  }

  const mostOverdue = pipeline.items[0]

  return (
    <TileShell
      icon={UserRoundSearch}
      label="Prospects needing follow-up"
      href={ROUTES.pipeline}
      cta="Open CRM pipeline"
    >
      <span className="text-3xl font-semibold text-champagne tabular-nums">
        {pipeline.meta.total}
      </span>
      <p className="text-sm text-parchment">
        {pipeline.meta.total === 1
          ? 'prospect due a follow-up'
          : 'prospects due a follow-up'}
      </p>
      {mostOverdue !== undefined ? (
        <p className="text-xs text-stone">
          Longest waiting:{' '}
          {mostOverdue.preferredName ??
            mostOverdue.displayName ??
            mostOverdue.accountName ??
            'Unnamed prospect'}{' '}
          ·{' '}
          <DateTime
            value={mostOverdue.followUpAt}
            format="relative"
            tone="subtle"
          />
        </p>
      ) : null}
    </TileShell>
  )
}

// =============================================================================
// Page.
// =============================================================================

export default function AdminOverviewPage() {
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-medium text-linen">
          Overview
        </h1>
        <p className="max-w-2xl text-sm text-parchment">
          The state of the business, at a glance. Every figure below opens the
          screen that explains it.
        </p>
      </header>

      <section
        aria-labelledby="overview-metrics-heading"
        className="flex flex-col gap-4"
      >
        <h2 id="overview-metrics-heading" className="sr-only">
          Key metrics
        </h2>
        <ul
          role="list"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          <li>
            <Suspense
              fallback={<TileSkeleton label="monthly recurring revenue" />}
            >
              <MrrTile />
            </Suspense>
          </li>
          <li>
            <Suspense fallback={<TileSkeleton label="active subscribers" />}>
              <ActiveSubscribersTile />
            </Suspense>
          </li>
          <li>
            <Suspense fallback={<TileSkeleton label="churn" />}>
              <ChurnTile />
            </Suspense>
          </li>
          <li>
            <Suspense fallback={<TileSkeleton label="upcoming appointments" />}>
              <UpcomingAppointmentsTile />
            </Suspense>
          </li>
          <li>
            <Suspense fallback={<TileSkeleton label="the moderation queue" />}>
              <ModerationQueueTile />
            </Suspense>
          </li>
          <li>
            <Suspense
              fallback={<TileSkeleton label="prospects needing follow-up" />}
            >
              <FollowUpTile />
            </Suspense>
          </li>
        </ul>
      </section>
    </div>
  )
}
