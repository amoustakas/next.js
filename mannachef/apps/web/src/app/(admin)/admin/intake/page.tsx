// mannachef/apps/web/src/app/(admin)/admin/intake/page.tsx
import * as React from 'react'
import type { Metadata, Route } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  ClipboardList,
  ServerCrash,
  ShieldAlert,
} from 'lucide-react'

import type { PageMeta } from '@mannachef/api-contract'
import type {
  ClientStatus,
  ConsultationOutcome,
  ContactMethod,
  DeliveryFrequency,
} from '@mannachef/validators'

import { cn, FOCUS_RING } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
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
  ClientStatusBadge,
  ConsultationReview,
} from '@/components/admin/intake/consultation-review'
import { readClientProfile } from '@/server/actions/client'
import {
  getIntakeSubmission,
  listConsultations,
  listIntakeSubmissions,
} from '@/server/actions/intake'

export const metadata: Metadata = {
  title: 'Client Intake & Interviewing',
}

const QUEUE_PAGE_SIZE = 20
const CONSULTATION_PAGE_SIZE = 20

// =============================================================================
// `IntakeFormView`, `ClientProfileView` and `ConsultationView` are internal
// types of `server/actions/intake.ts` and `server/actions/client.ts` — not
// exported, and those files are off limits beyond a targeted grep. These
// mirror them structurally, the same way `app/(admin)/admin/clients/page.tsx`
// mirrors `PipelineClientView` as `PipelineRowShape`.
// =============================================================================

interface IntakeFormRowShape {
  readonly id: string
  readonly clientProfileId: string
  readonly householdSize: number
  readonly adults: number
  readonly children: number
  readonly allergies: readonly string[]
  readonly dislikes: readonly string[]
  readonly cuisinePreferences: readonly string[]
  readonly kitchenEquipment: readonly string[]
  readonly favouriteDishes: readonly string[]
  readonly hasPets: boolean
  readonly petsNote: string | null
  readonly deliveryFrequency: DeliveryFrequency
  readonly budgetPerMealCents: number | null
  readonly currency: string
  readonly serviceAddress: {
    readonly line1: string | null
    readonly line2: string | null
    readonly city: string | null
    readonly region: string | null
    readonly postalCode: string | null
    readonly country: string | null
  } | null
  readonly serviceAccessNotes: string | null
  readonly preferredContactMethod: ContactMethod
  readonly preferredCookDays: readonly string[]
  readonly notes: string | null
  readonly dietaryPreferences: readonly {
    readonly tagId: string
    readonly slug: string
    readonly name: string
    readonly kind: string
  }[]
  readonly submittedAt: Date | null
}

interface ClientProfileRowShape {
  readonly id: string
  readonly accountName: string | null
  readonly accountEmail: string | null
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly phone: string | null
  readonly status: ClientStatus
}

interface ConsultationRowShape {
  readonly id: string
  readonly clientProfileId: string
  readonly staffProfileId: string | null
  readonly scheduledFor: Date
  readonly durationMinutes: number
  readonly location: string | null
  readonly meetingUrl: string | null
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly compatibilityScore: number | null
  readonly notes: string | null
  readonly chefSummary: string | null
  readonly outcome: ConsultationOutcome
  readonly followUpAt: Date | null
  readonly convertedToClientAt: Date | null
}

/** The shape Next hands every Server Component under `app/`: strings, or an
 *  array when a key is repeated. Nothing here repeats a key, but the type is
 *  the honest one. */
type RawSearchParams = Record<string, string | string[] | undefined>

interface IntakePageProps {
  readonly searchParams: Promise<RawSearchParams>
}

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parsePage(raw: string | undefined): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
}

function buildQueueHref(params: {
  readonly page?: number
  readonly allergiesOnly?: boolean
  readonly intakeFormId?: string
}): Route {
  const query = new URLSearchParams()

  if (params.page !== undefined && params.page > 1) {
    query.set('page', String(params.page))
  }
  if (params.allergiesOnly === true) {
    query.set('allergiesOnly', '1')
  }
  if (params.intakeFormId !== undefined) {
    query.set('intakeFormId', params.intakeFormId)
  }

  const qs = query.toString()
  return qs.length > 0 ? `/admin/intake?${qs}` : '/admin/intake'
}

function resolveHouseholdName(
  household: ClientProfileRowShape | null,
  fallback: string
): string {
  if (household === null) {
    return fallback
  }
  return (
    household.preferredName ??
    household.displayName ??
    household.accountName ??
    household.accountEmail ??
    fallback
  )
}

function PageHeader({
  allergiesOnly,
}: {
  readonly allergiesOnly: boolean
}): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl leading-tight font-medium tracking-tight text-linen">
          Client intake &amp; interviewing
        </h1>
        <p className="max-w-prose font-sans text-sm leading-relaxed text-parchment">
          Review a household&rsquo;s questionnaire, write up their consultation,
          score the fit, and bring them on as a client.
        </p>
      </div>
      <Button
        asChild
        variant="outline"
        size="sm"
        className={cn(allergiesOnly && 'border-champagne/60 text-champagne')}
      >
        <Link href={buildQueueHref({ page: 1, allergiesOnly: !allergiesOnly })}>
          <AlertTriangle aria-hidden="true" className="size-4" />
          {allergiesOnly ? 'Showing allergies only' : 'Show allergies only'}
        </Link>
      </Button>
    </header>
  )
}

/**
 * Copy for every `ActionErrorCode` a Server-Component read can come back
 * with, so a denied or malformed request never falls through to a generic
 * "something went wrong" — `useAction` gives the interactive mutations this
 * treatment automatically; the plain `await`ed reads on this page do it here.
 */
function describeReadFailure(code: string): {
  readonly title: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to the intake queue.",
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return { title: 'Your session has expired.', isAccessIssue: true }
    case 'NOT_FOUND':
      return { title: 'That could not be found.', isAccessIssue: false }
    case 'VALIDATION':
      return {
        title: "Something in that request wasn't valid.",
        isAccessIssue: false,
      }
    case 'RATE_LIMITED':
      return { title: 'Too many requests, too quickly.', isAccessIssue: false }
    case 'CONFLICT':
      return { title: 'Something changed first.', isAccessIssue: false }
    default:
      return {
        title: 'The intake queue could not be loaded.',
        isAccessIssue: false,
      }
  }
}

function IntakePageFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}): React.JSX.Element {
  const copy = describeReadFailure(code)

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-3xl leading-tight font-medium tracking-tight text-linen">
        Client intake &amp; interviewing
      </h1>
      <EmptyState
        tone="error"
        icon={copy.isAccessIssue ? ShieldAlert : ServerCrash}
        headingLevel={2}
        title={copy.title}
        description={message}
        action={
          copy.isAccessIssue ? (
            <Button asChild variant="outline">
              <Link href="/admin">Return to the dashboard</Link>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/admin/intake">Try again</Link>
            </Button>
          )
        }
      />
    </div>
  )
}

function DetailErrorState({
  error,
  page,
  allergiesOnly,
}: {
  readonly error: { readonly code: string; readonly message: string }
  readonly page: number
  readonly allergiesOnly: boolean
}): React.JSX.Element {
  const copy = describeReadFailure(error.code)

  return (
    <EmptyState
      tone="error"
      icon={copy.isAccessIssue ? ShieldAlert : ServerCrash}
      headingLevel={2}
      title={
        copy.isAccessIssue
          ? "You don't have access to that submission."
          : 'That submission could not be opened.'
      }
      description={error.message}
      action={
        <Button asChild variant="outline">
          <Link href={buildQueueHref({ page, allergiesOnly })}>
            Back to the queue
          </Link>
        </Button>
      }
    />
  )
}

function QueueTable({
  items,
  meta,
  householdByClientId,
  selectedFormId,
  page,
  allergiesOnly,
}: {
  readonly items: readonly IntakeFormRowShape[]
  readonly meta: PageMeta
  readonly householdByClientId: ReadonlyMap<string, ClientProfileRowShape>
  readonly selectedFormId: string | null
  readonly page: number
  readonly allergiesOnly: boolean
}): React.JSX.Element {
  return (
    <Card variant="default" className="xl:sticky xl:top-20">
      <CardHeader>
        <CardTitle level={2}>Queue</CardTitle>
        <CardDescription>
          {meta.total} submitted questionnaire{meta.total === 1 ? '' : 's'}
          {allergiesOnly ? ' with allergies' : ''}.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              tone={allergiesOnly ? 'filtered' : 'empty'}
              size="sm"
              title="No submissions here"
              description={
                allergiesOnly
                  ? 'No household in the queue has reported an allergy.'
                  : 'Nothing has been submitted yet.'
              }
              action={
                allergiesOnly ? (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={buildQueueHref({ page: 1, allergiesOnly: false })}
                    >
                      Clear filter
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <Table containerClassName="rounded-none border-x-0 border-b-0 border-t border-ash">
            <TableCaption>
              Households whose intake questionnaire is submitted and awaiting
              review.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Household</TableHead>
                <TableHead numeric>Allergies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const household =
                  householdByClientId.get(item.clientProfileId) ?? null
                const name = resolveHouseholdName(
                  household,
                  item.clientProfileId
                )
                const isSelected = item.id === selectedFormId

                return (
                  <TableRow key={item.id} selected={isSelected}>
                    <TableCell>
                      <Link
                        href={buildQueueHref({
                          page,
                          allergiesOnly,
                          intakeFormId: item.id,
                        })}
                        aria-current={isSelected ? 'true' : undefined}
                        className={cn(
                          'flex flex-col gap-1 rounded-sm',
                          FOCUS_RING
                        )}
                      >
                        <span className="font-sans text-sm font-medium text-linen">
                          {name}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-xs text-stone">
                          <DateTime
                            value={item.submittedAt}
                            format="relative"
                            tone="subtle"
                          />
                          {household === null ? null : (
                            <ClientStatusBadge status={household.status} />
                          )}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell numeric>
                      {item.allergies.length === 0 ? (
                        <Badge variant="muted">None</Badge>
                      ) : (
                        <Badge variant="destructive" srPrefix="Allergy count: ">
                          {item.allergies.length}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {meta.pageCount > 1 ? (
        <CardFooter className="justify-between">
          {meta.hasPreviousPage ? (
            <Button asChild variant="outline" size="sm">
              <Link href={buildQueueHref({ page: page - 1, allergiesOnly })}>
                Previous
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
          )}
          <span className="font-sans text-xs text-stone">
            Page {meta.page} of {meta.pageCount}
          </span>
          {meta.hasNextPage ? (
            <Button asChild variant="outline" size="sm">
              <Link href={buildQueueHref({ page: page + 1, allergiesOnly })}>
                Next
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          )}
        </CardFooter>
      ) : null}
    </Card>
  )
}

/**
 * The Client Intake & Interviewing module.
 *
 * A Server Component. The queue and the selected household's detail are both
 * read here — `listIntakeSubmissions`, `getIntakeSubmission`,
 * `readClientProfile`, `listConsultations` — and handed down as plain data.
 * `<ConsultationReview>` (a Client Component) owns everything that mutates:
 * recording interview notes, running the compatibility rubric, and the
 * one-click, idempotent prospect conversion.
 */
export default async function IntakePage({
  searchParams,
}: IntakePageProps): Promise<React.JSX.Element> {
  const raw = await searchParams
  const page = parsePage(firstOf(raw.page))
  const allergiesOnly = firstOf(raw.allergiesOnly) === '1'
  const selectedFormId = firstOf(raw.intakeFormId) ?? null

  const queueResult = await listIntakeSubmissions({
    page,
    pageSize: QUEUE_PAGE_SIZE,
    isSubmitted: true,
    ...(allergiesOnly ? { hasAllergies: true } : {}),
  })

  if (!queueResult.ok) {
    return (
      <IntakePageFailure code={queueResult.code} message={queueResult.error} />
    )
  }

  // `queueResult.data` is `IntakeListView` — an internal, unexported type of
  // `server/actions/intake.ts` — but it is structurally identical to
  // `{ items: readonly IntakeFormRowShape[]; meta: PageMeta }`, so no cast is
  // needed to treat it as one.
  const queue: {
    readonly items: readonly IntakeFormRowShape[]
    readonly meta: PageMeta
  } = queueResult.data

  const householdResults = await Promise.all(
    queue.items.map((item) =>
      readClientProfile({ clientProfileId: item.clientProfileId })
    )
  )

  const householdByClientId = new Map<string, ClientProfileRowShape>()
  queue.items.forEach((item, index) => {
    const result = householdResults[index]
    if (result?.ok === true) {
      householdByClientId.set(item.clientProfileId, result.data)
    }
  })

  let detail: {
    readonly form: IntakeFormRowShape
    readonly household: ClientProfileRowShape
    readonly consultations: readonly ConsultationRowShape[]
  } | null = null
  let detailError: { readonly code: string; readonly message: string } | null =
    null

  if (selectedFormId !== null) {
    const formResult = await getIntakeSubmission({
      intakeFormId: selectedFormId,
    })

    if (!formResult.ok) {
      detailError = { code: formResult.code, message: formResult.error }
    } else {
      const form: IntakeFormRowShape = formResult.data

      const [householdResult, consultationsResult] = await Promise.all([
        readClientProfile({ clientProfileId: form.clientProfileId }),
        listConsultations({
          clientProfileId: form.clientProfileId,
          page: 1,
          pageSize: CONSULTATION_PAGE_SIZE,
        }),
      ])

      if (!householdResult.ok) {
        detailError = {
          code: householdResult.code,
          message: householdResult.error,
        }
      } else if (!consultationsResult.ok) {
        detailError = {
          code: consultationsResult.code,
          message: consultationsResult.error,
        }
      } else {
        const consultations: {
          readonly items: readonly ConsultationRowShape[]
        } = consultationsResult.data

        detail = {
          form,
          household: householdResult.data,
          consultations: consultations.items,
        }
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader allergiesOnly={allergiesOnly} />

      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)] xl:items-start">
        <QueueTable
          items={queue.items}
          meta={queue.meta}
          householdByClientId={householdByClientId}
          selectedFormId={selectedFormId}
          page={page}
          allergiesOnly={allergiesOnly}
        />

        <div className="min-w-0">
          {selectedFormId === null ? (
            <EmptyState
              tone="empty"
              icon={ClipboardList}
              headingLevel={2}
              title="Choose a submission to review"
              description="Select a household from the queue to see its questionnaire, record interview notes, score compatibility, or convert them to a client."
            />
          ) : detailError !== null ? (
            <DetailErrorState
              error={detailError}
              page={page}
              allergiesOnly={allergiesOnly}
            />
          ) : detail === null ? null : (
            <ConsultationReview
              key={detail.form.id}
              form={detail.form}
              household={detail.household}
              consultations={detail.consultations}
            />
          )}
        </div>
      </div>
    </div>
  )
}
