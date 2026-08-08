// mannachef/apps/web/src/app/(admin)/admin/clients/[id]/page.tsx
import * as React from 'react'
import { cache } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  Globe,
  Mail,
  MapPin,
  Phone,
  Receipt,
  Repeat,
  ServerCrash,
  ShieldAlert,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react'

import { MAX_PAGE_SIZE } from '@mannachef/validators'
import type {
  AppointmentStatus,
  ClientSource,
  ClientStatus,
  ContactMethod,
  InvoiceStatus,
  ServiceType,
  SubscriptionStatus,
} from '@mannachef/validators'

import { readClientProfile } from '@/server/actions/client'
import { listClientNotes, listInteractions } from '@/server/actions/crm'
import { listInvoices, listSubscriptions } from '@/server/actions/billing'
import { listAppointments } from '@/server/actions/booking'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ClientTimeline,
  type ClientNoteEntry,
  type InteractionEntry,
} from '@/components/admin/crm/client-timeline'

// =============================================================================
// 1. Reading the client, once
// =============================================================================

interface ClientDetailPageProps {
  readonly params: Promise<{ readonly id: string }>
}

/**
 * One read of the profile, however many times this render asks for it.
 *
 * Nothing else on this page needs `generateMetadata`, but keeping the fetch
 * behind `React.cache` costs nothing and means a future metadata function
 * shares this exact call rather than issuing a second one — see the same
 * pattern on `app/(marketing)/menu/[slug]/page.tsx`.
 */
const loadClient = cache(async (id: string) =>
  readClientProfile({ clientProfileId: id })
)

export const metadata: Metadata = {
  title: 'Client detail',
}

/**
 * The success payload of an `ActionResult`-returning action.
 *
 * `Extract<T, U>` is itself generic, so substituting the action's resolved
 * `ActionResult` union for its own `T` is what makes the conditional check
 * inside `Extract` distribute over that union — writing the same
 * `... extends { ok: true; data: infer TData } ? TData : never` check
 * directly against an already-resolved union (rather than through a second
 * layer of generics) does not distribute, because the checked type is no
 * longer a *naked* type parameter at that point. Same helper as
 * `app/(admin)/admin/subscriptions/page.tsx`.
 */
type ActionSuccessData<TAction extends (...args: never[]) => Promise<unknown>> =
  Extract<Awaited<ReturnType<TAction>>, { ok: true }>['data']

/** The household record itself, exactly as `readClientProfile` returns it. */
type ClientProfile = ActionSuccessData<typeof loadClient>

/** One row of `listAppointments`'s `items` array. */
type AppointmentRow = ActionSuccessData<
  typeof listAppointments
>['items'][number]

// =============================================================================
// 2. Vocabulary — labels and badge tones local to this page
// =============================================================================

function resolveClientDisplayName(profile: {
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly accountName: string | null
  readonly accountEmail: string | null
}): string {
  return (
    profile.displayName ??
    profile.preferredName ??
    profile.accountName ??
    profile.accountEmail ??
    'Unnamed client'
  )
}

const CLIENT_STATUS_LABELS: Readonly<Record<ClientStatus, string>> = {
  PROSPECT: 'Prospect',
  LEAD_QUALIFIED: 'Lead qualified',
  ACTIVE_SUBSCRIBER: 'Active subscriber',
  PAUSED: 'Paused',
  CHURNED: 'Churned',
}

const CLIENT_STATUS_BADGE: Readonly<
  Record<ClientStatus, BadgeProps['variant']>
> = {
  PROSPECT: 'outline',
  LEAD_QUALIFIED: 'default',
  ACTIVE_SUBSCRIBER: 'success',
  PAUSED: 'warning',
  CHURNED: 'destructive',
}

const CLIENT_SOURCE_LABELS: Readonly<Record<ClientSource, string>> = {
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

const CONTACT_METHOD_LABELS: Readonly<Record<ContactMethod, string>> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  SMS: 'Text message',
  IN_APP: 'In-app message',
}

const SUBSCRIPTION_STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> =
  {
    INCOMPLETE: 'Incomplete',
    INCOMPLETE_EXPIRED: 'Incomplete (expired)',
    TRIALING: 'Trialing',
    ACTIVE: 'Active',
    PAST_DUE: 'Past due',
    CANCELED: 'Canceled',
    UNPAID: 'Unpaid',
    PAUSED: 'Paused',
  }

const SUBSCRIPTION_STATUS_BADGE: Readonly<
  Record<SubscriptionStatus, BadgeProps['variant']>
> = {
  INCOMPLETE: 'muted',
  INCOMPLETE_EXPIRED: 'muted',
  TRIALING: 'champagne',
  ACTIVE: 'success',
  PAST_DUE: 'warning',
  CANCELED: 'muted',
  UNPAID: 'destructive',
  PAUSED: 'outline',
}

const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  PAID: 'Paid',
  UNCOLLECTIBLE: 'Uncollectible',
  VOID: 'Void',
}

const INVOICE_STATUS_BADGE: Readonly<
  Record<InvoiceStatus, BadgeProps['variant']>
> = {
  DRAFT: 'muted',
  OPEN: 'warning',
  PAID: 'success',
  UNCOLLECTIBLE: 'destructive',
  VOID: 'outline',
}

const SERVICE_TYPE_LABELS: Readonly<Record<ServiceType, string>> = {
  IN_HOME_DINNER: 'In-home dinner',
  MEAL_PREP: 'Meal prep',
  PRIVATE_EVENT: 'Private event',
  COOKING_CLASS: 'Cooking class',
  TASTING: 'Tasting',
  CATERING: 'Catering',
  CONSULTATION: 'Consultation',
  DELIVERY_DROP_OFF: 'Delivery drop-off',
}

const APPOINTMENT_STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
}

const APPOINTMENT_STATUS_BADGE: Readonly<
  Record<AppointmentStatus, BadgeProps['variant']>
> = {
  REQUESTED: 'outline',
  CONFIRMED: 'default',
  IN_PROGRESS: 'champagne',
  COMPLETED: 'success',
  CANCELLED: 'destructive',
  NO_SHOW: 'muted',
}

// =============================================================================
// 3. Failure presentation
// =============================================================================

function clientProfileFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to this client's record.",
        description:
          'This account is signed in, but its role is too low to view this household. Ask an admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to view this client.',
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
        title: 'This client could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

function ClientDetailFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}): React.JSX.Element {
  const copy = clientProfileFailureCopy(code)

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      <EmptyState
        tone="error"
        icon={copy.isAccessIssue ? ShieldAlert : ServerCrash}
        headingLevel={1}
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
              <Link href="/admin/clients">Back to the pipeline</Link>
            </Button>
          )
        }
      />
    </div>
  )
}

function BackLink(): React.JSX.Element {
  return (
    <Link
      href="/admin/clients"
      className="inline-flex w-fit items-center gap-1.5 font-sans text-sm text-parchment transition-colors duration-150 ease-luxe hover:text-linen"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back to the pipeline
    </Link>
  )
}

/** A short inline notice for a secondary read that failed — the page itself
 *  still rendered, so this stays a line, not a full-page takeover. */
function SectionFailureNotice({ message }: { readonly message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-claret/50 bg-claret/10 px-3 py-2 font-sans text-sm leading-relaxed text-linen"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {message.length > 0
        ? message
        : 'This section could not be loaded. Refresh the page to try again.'}
    </p>
  )
}

// =============================================================================
// 4. The page
// =============================================================================

export default async function ClientDetailPage({
  params,
}: ClientDetailPageProps): Promise<React.JSX.Element> {
  const { id } = await params
  const profileResult = await loadClient(id)

  if (!profileResult.ok) {
    if (profileResult.code === 'NOT_FOUND') {
      notFound()
    }

    return (
      <ClientDetailFailure
        code={profileResult.code}
        message={profileResult.error}
      />
    )
  }

  const profile = profileResult.data
  const displayName = resolveClientDisplayName(profile)

  const [
    subscriptionsResult,
    invoicesResult,
    appointmentsResult,
    notesResult,
    interactionsResult,
  ] = await Promise.all([
    listSubscriptions({
      userId: profile.userId,
      pageSize: MAX_PAGE_SIZE,
      sortDirection: 'desc',
    }),
    listInvoices({
      userId: profile.userId,
      pageSize: MAX_PAGE_SIZE,
      sortBy: 'ISSUED',
      sortDirection: 'desc',
    }),
    listAppointments({
      clientProfileId: id,
      pageSize: MAX_PAGE_SIZE,
      sortDirection: 'desc',
    }),
    listClientNotes({
      clientProfileId: id,
      pageSize: MAX_PAGE_SIZE,
      sortDirection: 'desc',
    }),
    listInteractions({
      clientProfileId: id,
      pageSize: MAX_PAGE_SIZE,
      sortDirection: 'desc',
    }),
  ])

  const noteEntries: readonly ClientNoteEntry[] = notesResult.ok
    ? notesResult.data.items.map((note): ClientNoteEntry => ({
        id: note.id,
        authorName: note.authorName,
        body: note.body,
        pinned: note.pinned,
        visibility: note.visibility,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      }))
    : []

  const interactionEntries: readonly InteractionEntry[] = interactionsResult.ok
    ? interactionsResult.data.items.map((interaction): InteractionEntry => ({
        id: interaction.id,
        loggedByName: interaction.loggedByName,
        channel: interaction.channel,
        direction: interaction.direction,
        subject: interaction.subject,
        body: interaction.body,
        occurredAt: interaction.occurredAt,
        durationMinutes: interaction.durationMinutes,
      }))
    : []

  const followUpDue =
    profile.followUpAt !== null && profile.followUpAt.getTime() <= Date.now()

  const activeSubscriptionCount = subscriptionsResult.ok
    ? subscriptionsResult.data.items.filter(
        (subscription) =>
          subscription.status === 'ACTIVE' || subscription.status === 'TRIALING'
      ).length
    : null

  const outstandingInvoiceCents = invoicesResult.ok
    ? invoicesResult.data.items.reduce(
        (total, invoice) => total + invoice.amountRemainingCents,
        0
      )
    : null

  const nextAppointment = appointmentsResult.ok
    ? appointmentsResult.data.items
        .filter(
          (appointment) =>
            appointment.startsAt.getTime() >= Date.now() &&
            appointment.status !== 'CANCELLED' &&
            appointment.status !== 'NO_SHOW'
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]
    : undefined

  return (
    <div className="flex flex-col gap-8">
      <BackLink />

      <ProfileHeader
        profile={profile}
        displayName={displayName}
        followUpDue={followUpDue}
      />

      <Tabs defaultValue="overview">
        <TabsList aria-label="Client sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab
            profile={profile}
            activeSubscriptionCount={activeSubscriptionCount}
            outstandingInvoiceCents={outstandingInvoiceCents}
            invoiceCurrency={
              invoicesResult.ok
                ? (invoicesResult.data.items[0]?.currency ?? profile.currency)
                : profile.currency
            }
            appointmentCount={
              appointmentsResult.ok ? appointmentsResult.data.meta.total : null
            }
            nextAppointment={nextAppointment}
          />
        </TabsContent>

        <TabsContent value="billing">
          <div className="flex flex-col gap-8">
            <SubscriptionsSection result={subscriptionsResult} />
            <InvoicesSection result={invoicesResult} />
          </div>
        </TabsContent>

        <TabsContent value="appointments">
          <AppointmentsSection result={appointmentsResult} />
        </TabsContent>

        <TabsContent value="timeline">
          <ClientTimeline
            clientProfileId={id}
            clientName={displayName}
            notes={noteEntries}
            interactions={interactionEntries}
          />
          {notesResult.ok ? null : (
            <div className="mt-4">
              <SectionFailureNotice message={notesResult.error} />
            </div>
          )}
          {interactionsResult.ok ? null : (
            <div className="mt-4">
              <SectionFailureNotice message={interactionsResult.error} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

// =============================================================================
// 5. Profile header
// =============================================================================

interface ProfileHeaderProps {
  readonly profile: ClientProfile
  readonly displayName: string
  readonly followUpDue: boolean
}

function ProfileHeader({
  profile,
  displayName,
  followUpDue,
}: ProfileHeaderProps) {
  return (
    <Card variant="elevated" padded>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
              Client record
            </p>
            <h1 className="font-display text-3xl leading-tight font-medium tracking-tight text-linen">
              {displayName}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={CLIENT_STATUS_BADGE[profile.status]}>
                {CLIENT_STATUS_LABELS[profile.status]}
              </Badge>
              <Badge variant="outline">
                {CLIENT_SOURCE_LABELS[profile.source]}
              </Badge>
              {profile.sourceDetail === null ? null : (
                <span className="font-sans text-xs text-stone">
                  {profile.sourceDetail}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1">
            <p className="font-sans text-xs tracking-wide text-stone uppercase">
              Lifetime value
            </p>
            <Money
              cents={profile.lifetimeValueCents}
              currency={profile.currency}
              tone="accent"
              weight="semibold"
              className="font-display text-3xl"
            />
          </div>
        </div>

        <div className="hairline" />

        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <ProfileFact
            icon={Mail}
            label="Email"
            value={profile.accountEmail ?? '—'}
          />
          <ProfileFact
            icon={Phone}
            label="Phone"
            value={profile.phone ?? '—'}
          />
          <ProfileFact
            icon={Sparkles}
            label="Preferred contact"
            value={CONTACT_METHOD_LABELS[profile.preferredContactMethod]}
          />
          <ProfileFact
            icon={Globe}
            label="Time zone"
            value={`${profile.timeZone} · ${profile.locale}`}
          />

          <div className="flex flex-col gap-1">
            <dt className="flex items-center gap-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase">
              <Clock aria-hidden="true" className="size-3.5" />
              Last contacted
            </dt>
            <dd className="font-sans text-sm text-linen">
              <DateTime
                value={profile.lastContactedAt}
                format="relative"
                fallback="Never"
              />
            </dd>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="flex items-center gap-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase">
              <CalendarClock aria-hidden="true" className="size-3.5" />
              Follow-up
            </dt>
            <dd className="flex items-center gap-2 font-sans text-sm text-linen">
              {profile.followUpAt === null ? (
                <span className="text-stone">None scheduled</span>
              ) : (
                <>
                  <DateTime value={profile.followUpAt} format="date" />
                  <Badge
                    variant={followUpDue ? 'warning' : 'outline'}
                    className="gap-1"
                  >
                    {followUpDue ? (
                      <AlertCircle aria-hidden="true" className="size-3" />
                    ) : (
                      <CheckCircle2 aria-hidden="true" className="size-3" />
                    )}
                    {followUpDue ? 'Due' : 'Scheduled'}
                  </Badge>
                </>
              )}
            </dd>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
              Client since
            </dt>
            <dd className="font-sans text-sm text-linen">
              <DateTime value={profile.createdAt} format="date" />
            </dd>
          </div>
        </dl>

        {profile.status === 'CHURNED' && profile.churnReason !== null ? (
          <div className="rounded-md border border-claret/50 bg-claret/10 p-4">
            <p className="font-sans text-xs font-medium tracking-wide text-claret uppercase">
              Churned{' '}
              {profile.churnedAt === null ? null : (
                <DateTime
                  value={profile.churnedAt}
                  format="date"
                  tone="subtle"
                />
              )}
            </p>
            <p className="mt-1 font-sans text-sm leading-relaxed text-parchment">
              {profile.churnReason}
            </p>
          </div>
        ) : null}

        {profile.vipNotes === null ? null : (
          <div className="rounded-md border border-ash bg-charcoal/60 p-4">
            <p className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
              House notes — staff only
            </p>
            <p className="mt-1 font-sans text-sm leading-relaxed whitespace-pre-wrap text-parchment">
              {profile.vipNotes}
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}

function ProfileFact({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly value: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase">
        <Icon aria-hidden="true" className="size-3.5" />
        {label}
      </dt>
      <dd className="font-sans text-sm text-linen">{value}</dd>
    </div>
  )
}

// =============================================================================
// 6. Overview tab
// =============================================================================

interface OverviewTabProps {
  readonly profile: ClientProfile
  readonly activeSubscriptionCount: number | null
  readonly outstandingInvoiceCents: number | null
  readonly invoiceCurrency: string
  readonly appointmentCount: number | null
  readonly nextAppointment: AppointmentRow | undefined
}

function OverviewTab({
  profile,
  activeSubscriptionCount,
  outstandingInvoiceCents,
  invoiceCurrency,
  appointmentCount,
  nextAppointment,
}: OverviewTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Repeat}
          label="Active subscriptions"
          value={
            activeSubscriptionCount === null
              ? '—'
              : String(activeSubscriptionCount)
          }
        />
        <StatCard
          icon={Receipt}
          label="Outstanding balance"
          valueNode={
            outstandingInvoiceCents === null ? (
              <span className="font-display text-2xl text-stone">—</span>
            ) : (
              <Money
                cents={outstandingInvoiceCents}
                currency={invoiceCurrency}
                weight="semibold"
                colorBySign
                className="font-display text-2xl"
              />
            )
          }
        />
        <StatCard
          icon={Users}
          label="Total engagements"
          value={appointmentCount === null ? '—' : String(appointmentCount)}
        />
        <StatCard
          icon={CalendarClock}
          label="Next engagement"
          valueNode={
            nextAppointment === undefined ? (
              <span className="font-display text-lg text-stone">
                None scheduled
              </span>
            ) : (
              <DateTime
                value={nextAppointment.startsAt}
                format="datetime"
                className="font-display text-lg font-medium text-linen"
              />
            )
          }
        />
      </div>

      <Card padded>
        <CardHeader className="p-0 pb-4">
          <CardTitle level={2}>Household details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 p-0 sm:grid-cols-2">
          <ProfileFact
            icon={MapPin}
            label="Account name"
            value={profile.accountName ?? '—'}
          />
          <ProfileFact
            icon={Sparkles}
            label="Preferred name"
            value={profile.preferredName ?? '—'}
          />
          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
              Record updated
            </dt>
            <dd className="font-sans text-sm text-linen">
              <DateTime value={profile.updatedAt} format="relative" />
            </dd>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  valueNode,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly value?: string
  readonly valueNode?: React.ReactNode
}) {
  return (
    <Card padded>
      <div className="flex items-center gap-2 text-stone">
        <Icon aria-hidden="true" className="size-4" />
        <p className="font-sans text-xs font-medium tracking-wide uppercase">
          {label}
        </p>
      </div>
      <div className="mt-2">
        {valueNode ?? (
          <p className="font-display text-2xl text-linen">{value}</p>
        )}
      </div>
    </Card>
  )
}

// =============================================================================
// 7. Billing — subscriptions
// =============================================================================

function SubscriptionsSection({
  result,
}: {
  readonly result: Awaited<ReturnType<typeof listSubscriptions>>
}) {
  return (
    <Card padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={2}>Subscription history</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!result.ok ? (
          <SectionFailureNotice message={result.error} />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Repeat}
            title="No subscriptions"
            description="This client has never held a subscription plan."
          />
        ) : (
          <Table>
            <TableCaption>Every subscription on this account.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Price</TableHead>
                <TableHead>Current period</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((subscription) => (
                <TableRow key={subscription.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm text-linen">
                        {subscription.plan.name}
                      </span>
                      <span className="text-xs text-stone">
                        {subscription.quantity} × every{' '}
                        {subscription.plan.intervalCount}{' '}
                        {subscription.plan.interval.toLowerCase()}
                        {subscription.plan.intervalCount === 1 ? '' : 's'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={SUBSCRIPTION_STATUS_BADGE[subscription.status]}
                      >
                        {SUBSCRIPTION_STATUS_LABELS[subscription.status]}
                      </Badge>
                      {subscription.cancelAtPeriodEnd ? (
                        <Badge variant="outline">Ends at period end</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    <Money
                      cents={subscription.plan.priceCents}
                      currency={subscription.currency}
                      weight="medium"
                    />
                  </TableCell>
                  <TableCell>
                    <DateTime
                      value={subscription.currentPeriodStart}
                      format="date"
                      tone="muted"
                    />
                    <span className="mx-1 text-stone">–</span>
                    <DateTime
                      value={subscription.currentPeriodEnd}
                      format="date"
                      tone="muted"
                    />
                  </TableCell>
                  <TableCell>
                    <DateTime
                      value={subscription.startedAt}
                      format="date"
                      tone="muted"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 8. Billing — invoices
// =============================================================================

function InvoicesSection({
  result,
}: {
  readonly result: Awaited<ReturnType<typeof listInvoices>>
}) {
  return (
    <Card padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={2}>Invoice history</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!result.ok ? (
          <SectionFailureNotice message={result.error} />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Receipt}
            title="No invoices"
            description="Nothing has been billed to this client yet."
          />
        ) : (
          <Table>
            <TableCaption>
              Every invoice raised against this client.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
                <TableHead numeric>Amount due</TableHead>
                <TableHead numeric>Balance</TableHead>
                <TableHead>
                  <span className="sr-only">Links</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((invoice) => {
                const isOverdue =
                  invoice.dueAt !== null &&
                  invoice.dueAt.getTime() < Date.now() &&
                  invoice.status !== 'PAID' &&
                  invoice.status !== 'VOID'

                return (
                  <TableRow key={invoice.id}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-linen">
                          {invoice.number ?? 'Draft'}
                        </span>
                        {invoice.isManual ? (
                          <span className="text-xs text-stone">Bespoke</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={INVOICE_STATUS_BADGE[invoice.status]}>
                          {INVOICE_STATUS_LABELS[invoice.status]}
                        </Badge>
                        {isOverdue ? (
                          <Badge variant="destructive">Overdue</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DateTime
                        value={invoice.issuedAt}
                        format="date"
                        tone="muted"
                      />
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
                        cents={invoice.amountDueCents}
                        currency={invoice.currency}
                        weight="medium"
                      />
                    </TableCell>
                    <TableCell numeric>
                      <Money
                        cents={invoice.amountRemainingCents}
                        currency={invoice.currency}
                        tone={
                          invoice.amountRemainingCents > 0 ? 'accent' : 'subtle'
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {invoice.hostedInvoiceUrl === null ? (
                        <span className="text-xs text-stone">—</span>
                      ) : (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-sans text-xs text-champagne underline-offset-4 hover:underline"
                        >
                          View
                        </a>
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
// 9. Appointments
// =============================================================================

function AppointmentsSection({
  result,
}: {
  readonly result: Awaited<ReturnType<typeof listAppointments>>
}) {
  return (
    <Card padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={2}>Appointment history</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!result.ok ? (
          <SectionFailureNotice message={result.error} />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Users}
            title="No appointments"
            description="Nothing has been booked with this client yet."
          />
        ) : (
          <Table>
            <TableCaption>
              Every engagement booked with this client.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Staff</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Guests</TableHead>
                <TableHead numeric>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((appointment) => (
                <TableRow key={appointment.id}>
                  <TableCell>
                    <DateTime value={appointment.startsAt} format="datetime" />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-linen">
                      {SERVICE_TYPE_LABELS[appointment.serviceType]}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-parchment">
                      {appointment.staffName ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={APPOINTMENT_STATUS_BADGE[appointment.status]}
                    >
                      {APPOINTMENT_STATUS_LABELS[appointment.status]}
                    </Badge>
                    {appointment.requiresRequote ? (
                      <Badge variant="warning" className="ml-1.5">
                        Needs re-quote
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell numeric>{appointment.guestCount}</TableCell>
                  <TableCell numeric>
                    <Money
                      cents={appointment.totalCents}
                      currency={appointment.currency}
                      weight="medium"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
