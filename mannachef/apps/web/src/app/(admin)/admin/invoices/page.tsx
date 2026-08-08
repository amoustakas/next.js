// mannachef/apps/web/src/app/(admin)/admin/invoices/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FileText, Receipt, ServerCrash, ShieldAlert } from 'lucide-react'

import type { PageMeta } from '@mannachef/api-contract'
import {
  invoiceFilterSchema,
  type InvoiceFilterInput,
  type InvoiceSortBy,
  type InvoiceStatus,
} from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Money } from '@/components/ui/money'
import { ManualInvoiceForm } from '@/components/admin/billing/manual-invoice-form'
import { listInvoices } from '@/server/actions/billing'

export const metadata: Metadata = {
  title: 'Invoices',
}

/** The shape Next hands every server component under `app/`: strings, or an
 *  array when a key is repeated (`?status=OPEN&status=PAID`). */
type RawSearchParams = Record<string, string | string[] | undefined>

interface InvoicesPageProps {
  readonly searchParams: Promise<RawSearchParams>
}

// =============================================================================
// 1. Reading the address bar
// =============================================================================

const STATUS_OPTIONS: ReadonlyArray<{ value: InvoiceStatus; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PAID', label: 'Paid' },
  { value: 'UNCOLLECTIBLE', label: 'Uncollectible' },
  { value: 'VOID', label: 'Void' },
]

const SORT_BY_OPTIONS: ReadonlyArray<{ value: InvoiceSortBy; label: string }> = [
  { value: 'CREATED', label: 'Created' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'DUE', label: 'Due date' },
  { value: 'AMOUNT', label: 'Amount due' },
  { value: 'NUMBER', label: 'Invoice number' },
  { value: 'STATUS', label: 'Status' },
]

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const

/** Always the first of a possibly-repeated query key. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** `undefined` stays `undefined`; a lone string becomes a one-element array. */
function listOf(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Dollars, as an admin types them into a filter box, to the integer cents
 * `invoiceFilterSchema` actually validates.
 *
 * A blank or unparsable amount becomes `undefined` — "no filter" — rather than
 * `0`, which would silently narrow the list to invoices billed for nothing.
 */
function dollarsToCents(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined
  }
  return Math.round(parsed * 100)
}

/** The inverse of {@link dollarsToCents}, for pre-filling a filter box. */
function centsToDollarsValue(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2)
}

/** A `Date` as the value an `<input type="date">` expects, or `''`. */
function toDateInputValue(value: Date | undefined): string {
  if (value === undefined || Number.isNaN(value.getTime())) {
    return ''
  }
  return value.toISOString().slice(0, 10)
}

/**
 * Turns the address bar into `InvoiceFilterInput`.
 *
 * Every field name here is `invoiceFilterSchema`'s own, with two deliberate
 * exceptions: `minAmountDue`/`maxAmountDue` are read and written in dollars —
 * what an admin actually types — and converted to the cents the schema wants.
 * A malformed or tampered query string degrades to the schema's own defaults
 * (every invoice, newest first) rather than failing the page.
 */
function parseInvoiceFilters(raw: RawSearchParams): InvoiceFilterInput {
  const candidate: Record<string, unknown> = {
    page: firstOf(raw.page),
    pageSize: firstOf(raw.pageSize),
    sortBy: firstOf(raw.sortBy),
    sortDirection: firstOf(raw.sortDirection),
    search: firstOf(raw.search),
    statuses: listOf(raw.status),
    manualOnly: raw.manualOnly === undefined ? undefined : 'true',
    outstandingOnly: raw.outstandingOnly === undefined ? undefined : 'true',
    overdueOnly: raw.overdueOnly === undefined ? undefined : 'true',
    minAmountDueCents: dollarsToCents(firstOf(raw.minAmountDue)),
    maxAmountDueCents: dollarsToCents(firstOf(raw.maxAmountDue)),
    issuedFrom: firstOf(raw.issuedFrom),
    issuedTo: firstOf(raw.issuedTo),
    dueFrom: firstOf(raw.dueFrom),
    dueTo: firstOf(raw.dueTo),
  }

  const parsed = invoiceFilterSchema.safeParse(candidate)
  if (parsed.success) {
    return parsed.data
  }

  return invoiceFilterSchema.parse({})
}

/** Rebuilds the current query string with `overrides` applied — used by the
 *  pager, which sits outside the filter `<form>` and so cannot rely on the
 *  browser to carry the rest of the filters forward on its own. */
function buildInvoicesHref(
  raw: RawSearchParams,
  overrides: Readonly<Record<string, string>>
): string {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        params.append(key, entry)
      }
    } else {
      params.append(key, value)
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    params.set(key, value)
  }

  return `/admin/invoices?${params.toString()}`
}

// =============================================================================
// 2. Presentation
// =============================================================================

const STATUS_BADGE_VARIANT: Readonly<
  Record<InvoiceStatus, 'muted' | 'warning' | 'success' | 'destructive' | 'outline'>
> = {
  DRAFT: 'muted',
  OPEN: 'warning',
  PAID: 'success',
  UNCOLLECTIBLE: 'destructive',
  VOID: 'outline',
}

const STATUS_LABEL: Readonly<Record<InvoiceStatus, string>> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  PAID: 'Paid',
  UNCOLLECTIBLE: 'Uncollectible',
  VOID: 'Void',
}

/**
 * The fields this table reads off an invoice.
 *
 * Deliberately narrower than `listInvoices`'s own return type rather than
 * imported from it — this table only reads a handful of an invoice's fields,
 * and `result.data.items` (a `readonly InvoiceView[]` from the server action)
 * is a structural superset of this shape, so it is accepted here without ever
 * naming a type from `src/server/actions/**`.
 */
interface InvoiceRow {
  readonly id: string
  readonly userId: string
  readonly number: string | null
  readonly status: InvoiceStatus
  readonly isManual: boolean
  readonly issuedAt: Date | null
  readonly dueAt: Date | null
  readonly amountDueCents: number
  readonly amountRemainingCents: number
  readonly currency: string
  readonly hostedInvoiceUrl: string | null
  readonly pdfUrl: string | null
}

function isOverdue(row: InvoiceRow): boolean {
  return (
    row.dueAt !== null &&
    row.dueAt.getTime() < Date.now() &&
    row.amountRemainingCents > 0 &&
    row.status !== 'PAID' &&
    row.status !== 'VOID'
  )
}

/** The classes shared by every native `<select>` in the filter form — the
 *  Radix `<Select>` primitive does not participate in a plain GET submit, so
 *  the filter row uses real `<select>`/`<input>` elements, hand-styled to the
 *  same tokens, rather than the client-only combobox primitive. */
const NATIVE_CONTROL_CLASS =
  'h-10 w-full rounded-md border border-ash bg-charcoal px-3 font-sans text-sm text-linen ' +
  'transition-colors duration-200 ease-luxe hover:border-stone/60 ' +
  'focus-visible:border-champagne/60 outline-none focus-visible:ring-2 focus-visible:ring-champagne/40'

function FilterCheckbox({
  name,
  label,
  defaultChecked,
}: {
  readonly name: string
  readonly label: string
  readonly defaultChecked: boolean
}): React.JSX.Element {
  const id = `invoice-filter-${name}`

  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id={id}
        name={name}
        value="true"
        defaultChecked={defaultChecked}
        className="size-4 rounded-sm border border-ash bg-charcoal accent-champagne focus-visible:ring-2 focus-visible:ring-champagne/40 focus-visible:outline-none"
      />
      <Label htmlFor={id} tone="muted" className="text-xs font-normal">
        {label}
      </Label>
    </div>
  )
}

/**
 * Copy for every `ActionErrorCode` a read can come back with, so a denied
 * request never falls through to a generic "something went wrong" —
 * `FORBIDDEN` in particular reads as a permissions problem, not a bug.
 */
function invoiceListFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to billing.",
        description:
          'This account is signed in, but its role is too low to see invoices. Ask an admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to see the invoice ledger.',
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
    default:
      return {
        title: 'The invoice list could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

function InvoiceListFailure({
  code,
  message,
}: {
  readonly code: string
  readonly message: string
}): React.JSX.Element {
  const copy = invoiceListFailureCopy(code)

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
            <Link href="/admin/invoices">Try again</Link>
          </Button>
        )
      }
    />
  )
}

function InvoicePager({
  raw,
  meta,
}: {
  readonly raw: RawSearchParams
  readonly meta: PageMeta
}): React.JSX.Element {
  const firstRow = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1
  const lastRow = Math.min(meta.page * meta.pageSize, meta.total)

  return (
    <nav
      aria-label="Invoice pages"
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p aria-live="polite" className="font-sans text-xs text-stone tabular-nums">
        {meta.total === 0
          ? 'No results'
          : `Showing ${String(firstRow)}–${String(lastRow)} of ${String(meta.total)}`}
      </p>
      <div className="flex items-center gap-2">
        {meta.hasPreviousPage ? (
          <Button asChild variant="outline" size="sm">
            <Link href={buildInvoicesHref(raw, { page: String(meta.page - 1) })}>
              Previous
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Previous
          </Button>
        )}
        <span className="px-1 font-sans text-xs text-parchment tabular-nums">
          {meta.page} / {Math.max(1, meta.pageCount)}
        </span>
        {meta.hasNextPage ? (
          <Button asChild variant="outline" size="sm">
            <Link href={buildInvoicesHref(raw, { page: String(meta.page + 1) })}>
              Next
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Next
          </Button>
        )}
      </div>
    </nav>
  )
}

// =============================================================================
// 3. The page
// =============================================================================

/**
 * The invoice ledger.
 *
 * A Server Component. Every filter lives in `searchParams` — a plain HTML
 * `<form method="get">`, no client JavaScript required — so a filtered, sorted,
 * paged view of the invoices is a real, linkable address rather than client
 * state that evaporates on refresh. Sorting and paging are genuinely server
 * side: the form submits to this same route and the server re-fetches.
 *
 * The manual invoice generator (`<ManualInvoiceForm>`) is a self-contained
 * client component — its own trigger, its own dialog, its own submit — so this
 * page stays a Server Component throughout; it never needs to hand the form a
 * callback, because a successful save calls `router.refresh()` itself.
 */
export default async function InvoicesPage({
  searchParams,
}: InvoicesPageProps): Promise<React.JSX.Element> {
  const raw = await searchParams
  const filters = parseInvoiceFilters(raw)
  const result = await listInvoices(filters)

  const selectedStatuses = new Set(filters.statuses)

  const columns: ReadonlyArray<DataTableColumn<InvoiceRow>> = [
    {
      id: 'number',
      header: 'Invoice #',
      cell: (row) =>
        row.number ?? <span className="text-xs text-stone italic">Draft</span>,
      value: (row) => row.number,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_BADGE_VARIANT[row.status]}>
            {STATUS_LABEL[row.status]}
          </Badge>
          {isOverdue(row) ? <Badge variant="destructive">Overdue</Badge> : null}
        </div>
      ),
      value: (row) => row.status,
    },
    {
      id: 'type',
      header: 'Type',
      cell: (row) =>
        row.isManual ? (
          <Badge variant="outline">Bespoke</Badge>
        ) : (
          <span className="font-sans text-xs text-stone">Subscription</span>
        ),
      value: (row) => row.isManual,
    },
    {
      id: 'client',
      header: 'Client',
      cell: (row) => (
        <code
          title={row.userId}
          className="rounded-sm border border-ash bg-charcoal px-1.5 py-0.5 font-sans text-xs text-parchment"
        >
          {row.userId.slice(0, 10)}…
        </code>
      ),
      value: (row) => row.userId,
    },
    {
      id: 'issued',
      header: 'Issued',
      cell: (row) => <DateTime value={row.issuedAt} format="date" tone="muted" />,
      value: (row) => row.issuedAt,
    },
    {
      id: 'due',
      header: 'Due',
      cell: (row) => (
        <DateTime
          value={row.dueAt}
          format="date"
          tone={isOverdue(row) ? 'accent' : 'muted'}
        />
      ),
      value: (row) => row.dueAt,
    },
    {
      id: 'amountDue',
      header: 'Amount due',
      numeric: true,
      cell: (row) => (
        <Money cents={row.amountDueCents} currency={row.currency} weight="medium" />
      ),
      value: (row) => row.amountDueCents,
    },
    {
      id: 'balance',
      header: 'Balance',
      numeric: true,
      cell: (row) => (
        <Money
          cents={row.amountRemainingCents}
          currency={row.currency}
          tone={row.amountRemainingCents > 0 ? 'accent' : 'subtle'}
        />
      ),
      value: (row) => row.amountRemainingCents,
    },
    {
      id: 'links',
      header: 'Links',
      headerSrOnly: true,
      cell: (row) => (
        <div className="flex items-center gap-3">
          {row.hostedInvoiceUrl === null ? null : (
            <a
              href={row.hostedInvoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-sans text-xs text-champagne underline-offset-4 hover:underline"
            >
              <Receipt aria-hidden="true" className="size-3.5" />
              Hosted
            </a>
          )}
          {row.pdfUrl === null ? null : (
            <a
              href={row.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-sans text-xs text-champagne underline-offset-4 hover:underline"
            >
              <FileText aria-hidden="true" className="size-3.5" />
              PDF
            </a>
          )}
          {row.hostedInvoiceUrl === null && row.pdfUrl === null ? (
            <span className="text-xs text-stone">—</span>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
            Billing
          </p>
          <h1
            id="invoices-heading"
            className="font-display text-3xl font-light tracking-tight text-linen"
          >
            Invoices
          </h1>
          <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
            Every invoice raised against a subscription, a booked engagement, or
            a bespoke culinary event — one ledger, and the one place a new
            bespoke invoice is written.
          </p>
        </div>
        <ManualInvoiceForm />
      </header>

      <section
        aria-labelledby="invoices-filters-heading"
        className="rounded-lg border border-ash bg-charcoal/40 p-5"
      >
        <h2 id="invoices-filters-heading" className="sr-only">
          Filter invoices
        </h2>
        <form
          method="get"
          action="/admin/invoices"
          className="flex flex-col gap-5"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2 lg:col-span-2">
              <Label htmlFor="invoice-filter-search">Search</Label>
              <Input
                id="invoice-filter-search"
                type="search"
                name="search"
                placeholder="Invoice number, description, memo…"
                defaultValue={filters.search ?? ''}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-sortBy">Sort by</Label>
              <select
                id="invoice-filter-sortBy"
                name="sortBy"
                defaultValue={filters.sortBy}
                className={NATIVE_CONTROL_CLASS}
              >
                {SORT_BY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-sortDirection">Direction</Label>
              <select
                id="invoice-filter-sortDirection"
                name="sortDirection"
                defaultValue={filters.sortDirection}
                className={NATIVE_CONTROL_CLASS}
              >
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-issuedFrom">Issued from</Label>
              <Input
                id="invoice-filter-issuedFrom"
                type="date"
                name="issuedFrom"
                defaultValue={toDateInputValue(filters.issuedFrom)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-issuedTo">Issued to</Label>
              <Input
                id="invoice-filter-issuedTo"
                type="date"
                name="issuedTo"
                defaultValue={toDateInputValue(filters.issuedTo)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-dueFrom">Due from</Label>
              <Input
                id="invoice-filter-dueFrom"
                type="date"
                name="dueFrom"
                defaultValue={toDateInputValue(filters.dueFrom)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-dueTo">Due to</Label>
              <Input
                id="invoice-filter-dueTo"
                type="date"
                name="dueTo"
                defaultValue={toDateInputValue(filters.dueTo)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-minAmountDue">
                Amount due — minimum
              </Label>
              <Input
                id="invoice-filter-minAmountDue"
                type="text"
                inputMode="decimal"
                name="minAmountDue"
                placeholder="0.00"
                defaultValue={centsToDollarsValue(filters.minAmountDueCents)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-maxAmountDue">
                Amount due — maximum
              </Label>
              <Input
                id="invoice-filter-maxAmountDue"
                type="text"
                inputMode="decimal"
                name="maxAmountDue"
                placeholder="0.00"
                defaultValue={centsToDollarsValue(filters.maxAmountDueCents)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invoice-filter-pageSize">Rows per page</Label>
              <select
                id="invoice-filter-pageSize"
                name="pageSize"
                defaultValue={String(filters.pageSize)}
                className={NATIVE_CONTROL_CLASS}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="font-sans text-xs font-medium text-stone uppercase tracking-wide">
              Status
            </legend>
            <div className="flex flex-wrap gap-4">
              {STATUS_OPTIONS.map((option) => (
                <FilterCheckbox
                  key={option.value}
                  name="status"
                  label={option.label}
                  defaultChecked={selectedStatuses.has(option.value)}
                />
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-x-6 gap-y-3 border-t border-ash pt-4">
            <FilterCheckbox
              name="manualOnly"
              label="Bespoke invoices only"
              defaultChecked={filters.manualOnly}
            />
            <FilterCheckbox
              name="outstandingOnly"
              label="With a balance owing"
              defaultChecked={filters.outstandingOnly}
            />
            <FilterCheckbox
              name="overdueOnly"
              label="Past due, unpaid"
              defaultChecked={filters.overdueOnly}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" variant="outline">
              Apply filters
            </Button>
            <Button asChild variant="ghost">
              <Link href="/admin/invoices">Clear filters</Link>
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="invoices-heading" className="flex flex-col gap-4">
        {result.ok ? (
          <>
            <DataTable
              caption="Invoices"
              columns={columns}
              rows={result.data.items}
              getRowId={(row) => row.id}
              hidePagination
              empty={{
                title: 'No invoices yet',
                description:
                  'Subscription invoices and bespoke invoices will both appear here once there are some to show.',
              }}
              emptyFiltered={{
                title: 'Nothing matches those filters',
                description:
                  'Try widening the date range or clearing a filter to see the rest of the ledger.',
                action: (
                  <Button asChild variant="outline">
                    <Link href="/admin/invoices">Clear filters</Link>
                  </Button>
                ),
              }}
            />
            <InvoicePager raw={raw} meta={result.data.meta} />
          </>
        ) : (
          <InvoiceListFailure code={result.code} message={result.error} />
        )}
      </section>
    </div>
  )
}
