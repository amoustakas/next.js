// mannachef/apps/web/src/app/(admin)/admin/subscriptions/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  Coins,
  Receipt,
  ServerCrash,
  ShieldAlert,
  TrendingDown,
  Users,
} from 'lucide-react'

import { MAX_PAGE_SIZE } from '@mannachef/validators'

import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  PlanEditor,
  type PlanLadderRow,
} from '@/components/admin/billing/plan-editor'
import {
  getBillingDashboard,
  listInvoices,
  listSubscriptionPlans,
} from '@/server/actions/billing'

export const metadata: Metadata = {
  title: 'Billing OS',
}

// =============================================================================
// Failure copy — every `ActionErrorCode` a read can come back with
// =============================================================================

/**
 * `getBillingDashboard` is the definitive `ADMIN` check for this whole
 * screen. A user can reach `/admin/subscriptions` by address bar even though
 * the sidebar hides it below `ADMIN`, so a `FORBIDDEN` here has to read as a
 * permissions problem the viewer can act on, never as a generic fault
 * (`CONTRACT.md`'s rule on `ActionErrorCode`).
 */
function dashboardFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to the Billing OS.",
        description:
          'This account is signed in, but its role is too low to see revenue or manage the plan ladder. Ask a house admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to keep managing billing.',
        isAccessIssue: true,
      }
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests, too quickly.',
        description: 'Wait a moment and refresh the page.',
        isAccessIssue: false,
      }
    default:
      return {
        title: 'The Billing OS could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

// =============================================================================
// Small view helpers
// =============================================================================

/** The first currency bucket a section leads with; a house with one currency
 *  never has to scroll to see its own number. */
function leadBucket<T>(buckets: readonly T[]): T | undefined {
  return buckets[0]
}

const SUBSCRIPTION_STATUS_ORDER = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'PAUSED',
  'CANCELED',
  'UNPAID',
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
] as const

const SUBSCRIPTION_STATUS_LABELS: Record<
  (typeof SUBSCRIPTION_STATUS_ORDER)[number],
  string
> = {
  ACTIVE: 'Active',
  TRIALING: 'Trialing',
  PAST_DUE: 'Past due',
  PAUSED: 'Paused',
  CANCELED: 'Canceled',
  UNPAID: 'Unpaid',
  INCOMPLETE: 'Incomplete',
  INCOMPLETE_EXPIRED: 'Incomplete (expired)',
}

const SUBSCRIPTION_STATUS_TONE: Record<
  (typeof SUBSCRIPTION_STATUS_ORDER)[number],
  BadgeProps['variant']
> = {
  ACTIVE: 'success',
  TRIALING: 'champagne',
  PAST_DUE: 'warning',
  PAUSED: 'outline',
  CANCELED: 'muted',
  UNPAID: 'destructive',
  INCOMPLETE: 'muted',
  INCOMPLETE_EXPIRED: 'muted',
}

const INVOICE_STATUS_TONE: Record<string, BadgeProps['variant']> = {
  DRAFT: 'muted',
  OPEN: 'warning',
  PAID: 'success',
  UNCOLLECTIBLE: 'destructive',
  VOID: 'muted',
}

// =============================================================================
// The page
// =============================================================================

/**
 * The Billing OS — the plan ladder, and the Stripe sync dashboard beside it.
 *
 * A Server Component. Four reads run together: the dashboard aggregate (the
 * house's `ADMIN` gate for this screen), the plan ladder in two passes — one
 * per value of `isActive`, because `subscriptionPlanFilterSchema` filters on
 * it rather than offering an "all" tri-state — and the outstanding invoices a
 * human needs to chase.
 *
 * Every interactive control on the plan side — create, edit, delete — lives
 * inside `<PlanEditor>`, a client component. This page itself renders nothing
 * that needs `'use client'`.
 */
export default async function SubscriptionsPage(): Promise<React.JSX.Element> {
  const [
    dashboardResult,
    activePlansResult,
    closedPlansResult,
    attentionResult,
  ] = await Promise.all([
    getBillingDashboard({}),
    listSubscriptionPlans({
      pageSize: MAX_PAGE_SIZE,
      sortBy: 'SORT_ORDER',
      sortDirection: 'asc',
      isActive: true,
    }),
    listSubscriptionPlans({
      pageSize: MAX_PAGE_SIZE,
      sortBy: 'SORT_ORDER',
      sortDirection: 'asc',
      isActive: false,
    }),
    listInvoices({
      outstandingOnly: true,
      sortBy: 'DUE',
      sortDirection: 'asc',
      pageSize: 8,
    }),
  ])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          Billing OS
        </p>
        <h1
          id="billing-os-heading"
          className="font-display text-3xl font-light tracking-tight text-linen"
        >
          The ladder, and what Stripe says about it
        </h1>
        <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          Every plan a guest can subscribe to, and the recurring revenue,
          subscriber movement and outstanding balances Stripe reports back for
          it.
        </p>
      </header>

      {dashboardResult.ok ? (
        <BillingDashboardSection
          dashboard={dashboardResult.data}
          attentionResult={attentionResult}
        />
      ) : (
        <DashboardFailure
          code={dashboardResult.code}
          message={dashboardResult.error}
        />
      )}

      {dashboardResult.ok ? (
        <section
          aria-labelledby="plan-ladder-heading"
          className="flex flex-col gap-4"
        >
          <div>
            <h2
              id="plan-ladder-heading"
              className="font-display text-2xl font-light tracking-tight text-linen"
            >
              Plan ladder
            </h2>
            <p className="mt-1 max-w-2xl font-sans text-sm leading-relaxed text-parchment">
              Priced, staged, and mirrored to Stripe. Closed plans stay listed
              here so their history remains legible even once they stop taking
              new guests.
            </p>
          </div>
          <PlanLadderSection
            activePlansResult={activePlansResult}
            closedPlansResult={closedPlansResult}
          />
        </section>
      ) : null}
    </div>
  )
}

function DashboardFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}) {
  const copy = dashboardFailureCopy(code)

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
            <Link href="/admin/subscriptions">Try again</Link>
          </Button>
        )
      }
    />
  )
}

// =============================================================================
// Stripe sync dashboard
// =============================================================================

/**
 * The success payload of an `ActionResult`-returning action.
 *
 * `Extract<T, U>` is itself generic, so substituting the action's resolved
 * `ActionResult` union for its own `T` is what makes the conditional check
 * inside `Extract` distribute over that union — writing the same
 * `... extends { ok: true; data: infer TData } ? TData : never` check
 * directly against an already-resolved union (rather than through a second
 * layer of generics) does not distribute, because the checked type is no
 * longer a *naked* type parameter at that point.
 */
type ActionSuccessData<TAction extends (...args: never[]) => Promise<unknown>> =
  Extract<Awaited<ReturnType<TAction>>, { ok: true }>['data']

interface BillingDashboardSectionProps {
  readonly dashboard: ActionSuccessData<typeof getBillingDashboard>
  readonly attentionResult: Awaited<ReturnType<typeof listInvoices>>
}

function BillingDashboardSection({
  dashboard,
  attentionResult,
}: BillingDashboardSectionProps) {
  const mrr = leadBucket(dashboard.mrr)
  const collected = leadBucket(dashboard.collected)
  const outstanding = leadBucket(dashboard.outstanding)

  return (
    <section
      aria-labelledby="stripe-sync-heading"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="stripe-sync-heading"
          className="font-display text-2xl font-light tracking-tight text-linen"
        >
          Stripe sync
        </h2>
        <p className="font-sans text-xs text-stone">
          <DateTime value={dashboard.windowFrom} format="date" tone="subtle" />{' '}
          – <DateTime value={dashboard.windowTo} format="date" tone="subtle" />
          {dashboard.truncated ? ' · some totals were capped' : ''}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card variant="accent" padded>
          <CardHeader className="gap-1 p-0 pb-3">
            <div className="flex items-center gap-2 text-stone">
              <Coins aria-hidden="true" className="size-4" />
              <CardTitle level={3} className="text-sm font-medium text-stone">
                Recurring revenue
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {mrr === undefined ? (
              <p className="font-sans text-sm text-stone">
                No active recurring revenue in this window.
              </p>
            ) : (
              <>
                <Money
                  cents={mrr.mrrCents}
                  currency={mrr.currency}
                  weight="semibold"
                  className="font-display text-3xl"
                />
                <p className="mt-1 font-sans text-xs text-stone">
                  {mrr.subscriberCount} subscriber
                  {mrr.subscriberCount === 1 ? '' : 's'} ·{' '}
                  {mrr.subscriptionCount} subscription
                  {mrr.subscriptionCount === 1 ? '' : 's'}
                </p>
                {dashboard.mrr.length > 1 ? (
                  <p className="mt-1 font-sans text-xs text-stone">
                    +{dashboard.mrr.length - 1} other currenc
                    {dashboard.mrr.length - 1 === 1 ? 'y' : 'ies'}
                  </p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card padded>
          <CardHeader className="gap-1 p-0 pb-3">
            <div className="flex items-center gap-2 text-stone">
              <Users aria-hidden="true" className="size-4" />
              <CardTitle level={3} className="text-sm font-medium text-stone">
                Active subscribers
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <p className="font-display text-3xl font-semibold text-linen tabular-nums">
              {dashboard.activeSubscribers}
            </p>
            <p className="mt-1 font-sans text-xs text-stone">
              {dashboard.churn.startedInWindow} started ·{' '}
              {dashboard.churn.cancelledInWindow} cancelled this window
            </p>
          </CardContent>
        </Card>

        <Card padded>
          <CardHeader className="gap-1 p-0 pb-3">
            <div className="flex items-center gap-2 text-stone">
              <Receipt aria-hidden="true" className="size-4" />
              <CardTitle level={3} className="text-sm font-medium text-stone">
                Collected (net)
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {collected === undefined ? (
              <p className="font-sans text-sm text-stone">
                Nothing collected in this window.
              </p>
            ) : (
              <>
                <Money
                  cents={collected.netCents}
                  currency={collected.currency}
                  weight="semibold"
                  className="font-display text-3xl"
                />
                <p className="mt-1 font-sans text-xs text-stone">
                  {collected.paymentCount} payment
                  {collected.paymentCount === 1 ? '' : 's'}
                  {collected.refundedCents > 0 ? (
                    <>
                      {' '}
                      ·{' '}
                      <Money
                        cents={collected.refundedCents}
                        currency={collected.currency}
                        tone="subtle"
                      />{' '}
                      refunded
                    </>
                  ) : null}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card padded>
          <CardHeader className="gap-1 p-0 pb-3">
            <div className="flex items-center gap-2 text-stone">
              <AlertTriangle aria-hidden="true" className="size-4" />
              <CardTitle level={3} className="text-sm font-medium text-stone">
                Needing attention
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {outstanding === undefined ? (
              <p className="font-sans text-sm text-stone">
                Nothing outstanding right now.
              </p>
            ) : (
              <>
                <Money
                  cents={outstanding.amountRemainingCents}
                  currency={outstanding.currency}
                  weight="semibold"
                  colorBySign
                  className="font-display text-3xl"
                />
                <p className="mt-1 font-sans text-xs text-stone">
                  {outstanding.invoiceCount} outstanding
                  {outstanding.overdueInvoiceCount > 0 ? (
                    <span className="text-claret-ink">
                      {' '}
                      · {outstanding.overdueInvoiceCount} overdue
                    </span>
                  ) : null}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card padded>
        <CardHeader className="p-0 pb-4">
          <CardTitle level={3}>Subscriptions by status</CardTitle>
          <CardDescription>
            {dashboard.churn.subscribersAtWindowStart} subscriber
            {dashboard.churn.subscribersAtWindowStart === 1 ? '' : 's'} at the
            start of the window, a net change of{' '}
            {dashboard.churn.netChange >= 0 ? '+' : ''}
            {dashboard.churn.netChange}
            {dashboard.churn.churnRatePercent === null
              ? '.'
              : ` — a ${dashboard.churn.churnRatePercent}% churn rate.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-0">
          {SUBSCRIPTION_STATUS_ORDER.map((status) => (
            <Badge
              key={status}
              variant={SUBSCRIPTION_STATUS_TONE[status]}
              numeric
            >
              {SUBSCRIPTION_STATUS_LABELS[status]}:{' '}
              {dashboard.subscriptionsByStatus[status]}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <PaymentsNeedingAttention attentionResult={attentionResult} />
    </section>
  )
}

// =============================================================================
// Payments needing attention
// =============================================================================

function PaymentsNeedingAttention({
  attentionResult,
}: {
  readonly attentionResult: Awaited<ReturnType<typeof listInvoices>>
}) {
  return (
    <Card padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={3}>Payments needing attention</CardTitle>
        <CardDescription>
          Invoices with a balance still owed, soonest due date first.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!attentionResult.ok ? (
          <p className="font-sans text-sm text-stone">
            {attentionResult.error.length > 0
              ? attentionResult.error
              : 'This list could not be loaded.'}
          </p>
        ) : attentionResult.data.items.length === 0 ? (
          <p className="font-sans text-sm text-parchment">
            Nothing outstanding — every invoice in the ledger is settled.
          </p>
        ) : (
          <Table>
            <TableCaption>
              Outstanding invoices, ordered by due date.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Due</TableHead>
                <TableHead numeric>Balance</TableHead>
                <TableHead>
                  <span className="sr-only">Stripe</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attentionResult.data.items.map((invoice) => {
                const isOverdue =
                  invoice.dueAt !== null &&
                  invoice.dueAt.getTime() < Date.now() &&
                  invoice.status !== 'PAID' &&
                  invoice.status !== 'VOID'

                return (
                  <TableRow key={invoice.id}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-sans text-sm text-linen">
                          {invoice.number ?? 'Draft'}
                        </span>
                        <code
                          className="font-sans text-xs text-stone"
                          title={invoice.userId}
                        >
                          {invoice.userId.slice(0, 10)}…
                        </code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge
                          variant={
                            INVOICE_STATUS_TONE[invoice.status] ?? 'default'
                          }
                        >
                          {invoice.status}
                        </Badge>
                        {isOverdue ? (
                          <Badge variant="destructive">
                            <TrendingDown aria-hidden="true" />
                            Overdue
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DateTime
                        value={invoice.dueAt}
                        format="date"
                        tone={isOverdue ? 'default' : 'muted'}
                      />
                    </TableCell>
                    <TableCell numeric>
                      <Money
                        cents={invoice.amountRemainingCents}
                        currency={invoice.currency}
                        weight="medium"
                        tone={isOverdue ? 'negative' : 'default'}
                      />
                    </TableCell>
                    <TableCell>
                      {invoice.hostedInvoiceUrl === null ? (
                        <span className="text-stone">—</span>
                      ) : (
                        <Button asChild variant="ghost" size="sm">
                          <a
                            href={invoice.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View on Stripe
                          </a>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Plan ladder
// =============================================================================

function PlanLadderSection({
  activePlansResult,
  closedPlansResult,
}: {
  readonly activePlansResult: Awaited<ReturnType<typeof listSubscriptionPlans>>
  readonly closedPlansResult: Awaited<ReturnType<typeof listSubscriptionPlans>>
}) {
  if (!activePlansResult.ok) {
    return (
      <EmptyState
        tone="error"
        icon={ServerCrash}
        headingLevel={3}
        title="The plan ladder could not be loaded."
        description={
          activePlansResult.error.length > 0
            ? activePlansResult.error
            : 'Something went wrong on our end. Refresh the page, or try again shortly.'
        }
        action={
          <Button asChild variant="outline">
            <Link href="/admin/subscriptions">Try again</Link>
          </Button>
        }
      />
    )
  }

  const plans: PlanLadderRow[] = [
    ...activePlansResult.data.items,
    ...(closedPlansResult.ok ? closedPlansResult.data.items : []),
  ].map((plan) => ({
    id: plan.id,
    slug: plan.slug,
    name: plan.name,
    tagline: plan.tagline,
    description: plan.description,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    priceCents: plan.priceCents,
    currency: plan.currency,
    setupFeeCents: plan.setupFeeCents,
    trialDays: plan.trialDays,
    mealsPerWeek: plan.mealsPerWeek,
    servingsPerMeal: plan.servingsPerMeal,
    features: plan.features,
    isActive: plan.isActive,
    isFeatured: plan.isFeatured,
    sortOrder: plan.sortOrder,
    stripePriceId: plan.admin?.stripePriceId ?? null,
    stripeProductId: plan.admin?.stripeProductId ?? null,
    subscriptionCount: plan.admin?.subscriptionCount ?? null,
    updatedAt: plan.admin?.updatedAt ?? null,
  }))

  return (
    <div className="flex flex-col gap-3">
      {closedPlansResult.ok ? null : (
        <p className="font-sans text-xs text-stone">
          Closed plans could not be loaded this time — only open plans are shown
          below.
        </p>
      )}
      <PlanEditor plans={plans} />
    </div>
  )
}
