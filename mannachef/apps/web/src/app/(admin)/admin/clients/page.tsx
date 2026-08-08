// mannachef/apps/web/src/app/(admin)/admin/clients/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ServerCrash, ShieldAlert } from 'lucide-react'

import {
  clientPipelineFilterSchema,
  type ClientPipelineFilterInput,
  type ClientSource,
  type ClientStatus,
} from '@mannachef/validators'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  PIPELINE_STATUSES,
  PipelineBoard,
  type PipelineCardView,
  type PipelineColumnData,
  type PipelineFilterDraft,
} from '@/components/admin/crm/pipeline-board'
import { queryClientPipeline } from '@/server/actions/crm'

export const metadata: Metadata = {
  title: 'Client Pipeline',
}

/** How many cards a single column loads. The board shows "of N shown" past this. */
const COLUMN_PAGE_SIZE = 25

/** The shape Next hands every server component under `app/`: strings, or an
 *  array when a key is repeated (the filter bar's `sources` checkboxes). */
type RawSearchParams = Record<string, string | string[] | undefined>

interface ClientsPageProps {
  readonly searchParams: Promise<RawSearchParams>
}

/** Always the first of a possibly-repeated query key. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Every value of a possibly-repeated query key, or none. */
function allOf(value: string | string[] | undefined): readonly string[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Turns the address bar into the one set of filters every pipeline column
 * shares — `pipeline-board.tsx`'s `buildPipelineQuery` is the writer, this is
 * the reader. `statuses` is left off the candidate on purpose: this page
 * queries each stage separately below so every column carries its own count.
 *
 * A malformed or tampered query string degrades to the unfiltered pipeline
 * rather than failing the page — the address bar is not a trusted input.
 */
function parseSharedFilters(raw: RawSearchParams): ClientPipelineFilterInput {
  const candidate: Record<string, unknown> = {
    search: firstOf(raw.search),
    sources: allOf(raw.sources),
    minLifetimeValueCents: firstOf(raw.minLifetimeValueCents),
    maxLifetimeValueCents: firstOf(raw.maxLifetimeValueCents),
    lastContactedBefore: firstOf(raw.lastContactedBefore),
    neverContacted: firstOf(raw.neverContacted),
    followUpDue: firstOf(raw.followUpDue),
    sortBy: firstOf(raw.sortBy),
    sortDirection: firstOf(raw.sortDirection),
    statuses: [],
  }

  const parsed = clientPipelineFilterSchema.safeParse(candidate)
  if (parsed.success) {
    return parsed.data
  }

  return clientPipelineFilterSchema.parse({})
}

/** The inverse of `buildPipelineQuery`: validated filters back into the
 *  filter bar's plain, input-friendly draft shape. */
function toFilterDraft(shared: ClientPipelineFilterInput): PipelineFilterDraft {
  return {
    search: shared.search ?? '',
    sources: shared.sources,
    minValueDollars:
      shared.minLifetimeValueCents === undefined
        ? ''
        : String(shared.minLifetimeValueCents / 100),
    maxValueDollars:
      shared.maxLifetimeValueCents === undefined
        ? ''
        : String(shared.maxLifetimeValueCents / 100),
    lastContactedBefore:
      shared.lastContactedBefore === undefined
        ? ''
        : shared.lastContactedBefore.toISOString().slice(0, 10),
    neverContacted: shared.neverContacted,
    followUpDue: shared.followUpDue,
    sortBy: shared.sortBy,
    sortDirection: shared.sortDirection,
  }
}

/** One row as `queryClientPipeline` returns it — named locally because
 *  `PipelineClientView` is an internal type of `server/actions/crm.ts`, not
 *  part of its public surface. Structurally identical to the real thing. */
interface PipelineRowShape {
  readonly id: string
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly accountName: string | null
  readonly accountEmail: string | null
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

/** Same reasoning as `PipelineRowShape`, for the page envelope. */
interface PipelinePageShape {
  readonly items: readonly PipelineRowShape[]
  readonly meta: {
    readonly total: number
    readonly hasNextPage: boolean
  }
}

function toCardView(row: PipelineRowShape): PipelineCardView {
  return {
    id: row.id,
    displayName: row.displayName,
    preferredName: row.preferredName,
    accountName: row.accountName,
    accountEmail: row.accountEmail,
    status: row.status,
    source: row.source,
    sourceDetail: row.sourceDetail,
    lifetimeValueCents: row.lifetimeValueCents,
    currency: row.currency,
    lastContactedAt: row.lastContactedAt,
    followUpAt: row.followUpAt,
    churnReason: row.churnReason,
    updatedAt: row.updatedAt,
  }
}

function toColumnData(
  status: ClientStatus,
  page: PipelinePageShape
): PipelineColumnData {
  return {
    status,
    cards: page.items.map(toCardView),
    totalCount: page.meta.total,
    hasMore: page.meta.hasNextPage,
  }
}

/**
 * One `crm.pipeline.query` call per stage, scoped to page one of
 * `COLUMN_PAGE_SIZE` cards. `clientPipelineFilterSchema.statuses` can narrow a
 * single call to several stages at once, but that collapses their counts into
 * one total — this board needs each column's own count and its own "of N
 * shown", so each stage is its own request. All five run together rather than
 * in sequence.
 */
function fetchColumn(shared: ClientPipelineFilterInput, status: ClientStatus) {
  return queryClientPipeline({
    ...shared,
    statuses: [status],
    page: 1,
    pageSize: COLUMN_PAGE_SIZE,
  })
}

/**
 * Copy for every `ActionErrorCode` a pipeline read can come back with, so a
 * denied request never falls through to a generic "something went wrong" —
 * `FORBIDDEN` in particular reads as a permissions problem the reader can act
 * on rather than as a fault in the pipeline itself.
 */
function pipelineFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to the client pipeline.",
        description:
          'This account is signed in, but its role is too low to view the pipeline. Ask an admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to view the client pipeline.',
        isAccessIssue: true,
      }
    case 'VALIDATION':
      return {
        title: "Those filters don't add up.",
        description:
          'Something in the address bar is not a valid filter. Clear the filters and try again.',
        isAccessIssue: false,
      }
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests, too quickly.',
        description: 'Wait a moment and refresh the page.',
        isAccessIssue: false,
      }
    case 'NOT_FOUND':
      return {
        title: 'That view of the pipeline could not be found.',
        description: 'Clear the filters and try again.',
        isAccessIssue: false,
      }
    case 'CONFLICT':
      return {
        title: 'The pipeline changed while this loaded.',
        description: 'Refresh the page to see the latest.',
        isAccessIssue: false,
      }
    default:
      return {
        title: 'The client pipeline could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

function ClientsPageFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}): React.JSX.Element {
  const copy = pipelineFailureCopy(code)

  return (
    <section aria-labelledby="pipeline-heading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1
          id="pipeline-heading"
          className="font-display text-3xl leading-tight font-medium tracking-tight text-linen"
        >
          Client pipeline
        </h1>
      </div>

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
              <Link href="/admin/clients">Try again</Link>
            </Button>
          )
        }
      />
    </section>
  )
}

/**
 * The CRM pipeline page.
 *
 * A Server Component. Every filter lives in `searchParams`, so a chef's exact
 * view of the pipeline — a search term, a value range, "due a follow-up" — is
 * a real, linkable address rather than client state that evaporates on
 * refresh. The five stage columns are five parallel `crm.pipeline.query`
 * calls sharing those filters; `<PipelineBoard>` (a client component) owns
 * every interactive control — the filter form, drag-and-drop, the "Move to"
 * menu, and the churn/follow-up dialogs — and writes back to the URL itself.
 */
export default async function ClientsPage({
  searchParams,
}: ClientsPageProps): Promise<React.JSX.Element> {
  const raw = await searchParams
  const shared = parseSharedFilters(raw)

  const fetched = await Promise.all(
    PIPELINE_STATUSES.map(async (status) => ({
      status,
      result: await fetchColumn(shared, status),
    }))
  )

  const failed = fetched.find((entry) => !entry.result.ok)
  if (failed !== undefined && !failed.result.ok) {
    return (
      <ClientsPageFailure
        code={failed.result.code}
        message={failed.result.error}
      />
    )
  }

  const columns: readonly PipelineColumnData[] = fetched.map(
    ({ status, result }) => {
      if (!result.ok) {
        throw new Error(
          'Unreachable: every pipeline column query was checked to have succeeded.'
        )
      }
      return toColumnData(status, result.data)
    }
  )

  return (
    <PipelineBoard
      columns={columns}
      filters={toFilterDraft(shared)}
      basePath="/admin/clients"
    />
  )
}
