// mannachef/apps/web/src/app/(admin)/admin/reviews/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ServerCrash, ShieldAlert } from 'lucide-react'

import {
  reviewFilterSchema,
  type ReviewFilterInput,
} from '@mannachef/validators'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ModerationQueue } from '@/components/admin/reviews/moderation-queue'
import { listModerationQueue } from '@/server/actions/review'

export const metadata: Metadata = {
  title: 'Review Moderation',
}

/** The four moderation states the hub has a tab for. Featured is a status in
 *  its own right (`Review.status`), not merely "approved and featured". */
const TAB_VALUES = ['PENDING', 'APPROVED', 'REJECTED', 'FEATURED'] as const
type TabValue = (typeof TAB_VALUES)[number]

function isTabValue(value: string | undefined): value is TabValue {
  return TAB_VALUES.includes(value as TabValue)
}

/** The shape Next hands every server component under `app/`: strings, or an
 *  array when a key is repeated. */
type RawSearchParams = Record<string, string | string[] | undefined>

interface ReviewsPageProps {
  readonly searchParams: Promise<RawSearchParams>
}

/** Always the first of a possibly-repeated query key. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Turns the address bar into `ReviewFilterInput`, scoped to one tab.
 *
 * The Featured tab is ordered by carousel position rather than by recency —
 * that ordering *is* the reorder UI, so it is not something the reader can
 * override. Every other tab defaults to newest-first, which is what a
 * moderator working the queue wants to see.
 *
 * A malformed or tampered query string degrades to the default view of the
 * tab rather than failing the page — the address bar is not a trusted input.
 */
function parseReviewFilters(
  raw: RawSearchParams,
  tab: TabValue
): ReviewFilterInput {
  const isFeatured = tab === 'FEATURED'

  const candidate: Record<string, unknown> = {
    page: firstOf(raw.page),
    pageSize: firstOf(raw.pageSize),
    search: firstOf(raw.search),
    subjects: firstOf(raw.subject) === undefined ? [] : [firstOf(raw.subject)],
    statuses: [tab],
    verifiedOnly: firstOf(raw.verifiedOnly),
    sortBy: isFeatured ? 'FEATURED_ORDER' : 'CREATED',
    sortDirection: isFeatured ? 'asc' : 'desc',
  }

  const parsed = reviewFilterSchema.safeParse(candidate)
  if (parsed.success) {
    return parsed.data
  }

  return reviewFilterSchema.parse({
    statuses: [tab],
    sortBy: isFeatured ? 'FEATURED_ORDER' : 'CREATED',
    sortDirection: isFeatured ? 'asc' : 'desc',
  })
}

/**
 * Copy for every `ActionErrorCode` a read can come back with, so a denied
 * request never falls through to a generic "something went wrong" —
 * `FORBIDDEN` in particular reads as a permissions problem the moderator can
 * act on rather than as a fault in the moderation hub itself.
 */
function moderationQueueFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to moderate reviews.",
        description:
          'This account is signed in, but its role is too low for the moderation hub. Ask an admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to keep moderating reviews.',
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
        title: 'That view of the queue could not be found.',
        description: 'Clear the filters and try again.',
        isAccessIssue: false,
      }
    case 'CONFLICT':
      return {
        title: 'The queue changed while this loaded.',
        description: 'Refresh the page to see the latest.',
        isAccessIssue: false,
      }
    default:
      return {
        title: 'The moderation queue could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

/**
 * The moderation hub.
 *
 * A Server Component. The active tab, search, subject and verified-only
 * filter, and page all live in `searchParams`, so a moderator's exact view of
 * the queue is a real, linkable address rather than client state that
 * evaporates on refresh — the same convention the Menu Engine list uses.
 *
 * Every interactive control — the tab switch, the filters, approve/reject/
 * feature, and the featured-carousel reorder — lives inside
 * `<ModerationQueue>`, a client component. This page itself renders nothing
 * that needs `'use client'`.
 */
export default async function ReviewsPage({
  searchParams,
}: ReviewsPageProps): Promise<React.JSX.Element> {
  const raw = await searchParams
  const tab: TabValue = isTabValue(firstOf(raw.tab))
    ? (firstOf(raw.tab) as TabValue)
    : 'PENDING'
  const filters = parseReviewFilters(raw, tab)

  const result = await listModerationQueue(filters)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          Reviews
        </p>
        <h1
          id="reviews-heading"
          className="font-display text-3xl font-light tracking-tight text-linen"
        >
          What guests are saying
        </h1>
        <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          Read, approve, and curate reviews of a dish, a chef, an evening, or
          the house itself — and choose which ones greet a visitor on the
          homepage.
        </p>
      </header>

      <section aria-labelledby="reviews-heading">
        {result.ok ? (
          <ModerationQueue
            rows={result.data.items}
            meta={result.data.meta}
            activeTab={tab}
            search={filters.search ?? ''}
            subject={filters.subjects[0] ?? 'ALL'}
            verifiedOnly={filters.verifiedOnly}
            pagination={{
              page: filters.page,
              pageSize: filters.pageSize,
              sortDirection: filters.sortDirection,
            }}
          />
        ) : (
          <ModerationQueueFailure code={result.code} message={result.error} />
        )}
      </section>
    </div>
  )
}

function ModerationQueueFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}): React.JSX.Element {
  const copy = moderationQueueFailureCopy(code)

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
            <Link href="/admin/reviews">Try again</Link>
          </Button>
        )
      }
    />
  )
}
