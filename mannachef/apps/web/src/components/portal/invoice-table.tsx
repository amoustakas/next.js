// mannachef/apps/web/src/components/portal/invoice-table.tsx
'use client'

/**
 * A household's invoices, as a `<DataTable>`.
 *
 * ## Why this is a client component when the page around it is not
 *
 * Not because the data is fetched here — it is not; the page reads it on the
 * server and hands it down as plain rows. It is because a `DataTableColumn`
 * carries `cell` and `value` **functions**, and a function cannot cross the
 * Server/Client boundary. The column definitions therefore have to be built
 * inside the client component that uses them.
 *
 * So the split is: the server does the reading and the authorisation, and this
 * component does the sorting, the filtering and the paging — all of it locally,
 * over rows that have already been scoped to the caller by `listInvoices`.
 *
 * ## The two links
 *
 * `hostedInvoiceUrl` and `pdfUrl` are Stripe's, and both are `null` on an
 * invoice Stripe has not published — a draft, or one raised by hand. The cell
 * renders only the links that exist and says so when neither does, rather than
 * offering a dead anchor.
 *
 * Both open in a new tab, which is announced: an anchor that silently steals
 * the tab is disorienting, and one that silently opens a new one is worse.
 */

import * as React from 'react'
import { ExternalLink, FileText } from 'lucide-react'

import type { InvoiceStatus } from '@mannachef/validators'

import { InvoiceStatusBadge } from '@/components/portal/status-badges'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DateTime } from '@/components/ui/date-time'
import { Money } from '@/components/ui/money'
import { cn } from '@/lib/utils'

/** One invoice, flattened to what the table renders. Serialisable. */
export interface InvoiceRow {
  readonly id: string
  readonly number: string | null
  readonly status: InvoiceStatus
  readonly amountDueCents: number
  readonly amountRemainingCents: number
  readonly currency: string
  /** ISO 8601, or `null`. */
  readonly issuedAt: string | null
  readonly dueAt: string | null
  readonly paidAt: string | null
  readonly description: string | null
  readonly hostedInvoiceUrl: string | null
  readonly pdfUrl: string | null
}

const LINK_CLASS = cn(
  'inline-flex items-center gap-1.5 rounded-sm font-sans text-xs',
  'text-champagne underline-offset-4 hover:underline'
)

export interface InvoiceTableProps {
  readonly rows: readonly InvoiceRow[]
}

export function InvoiceTable({ rows }: InvoiceTableProps): React.JSX.Element {
  const columns = React.useMemo<readonly DataTableColumn<InvoiceRow>[]>(
    () => [
      {
        id: 'number',
        header: 'Invoice',
        sortable: true,
        filterable: true,
        filterPlaceholder: 'Search by number',
        value: (row) => row.number ?? '',
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-sans text-sm text-linen tabular-nums">
              {row.number ?? 'Not yet numbered'}
            </span>
            {row.description === null ? null : (
              <span className="font-sans text-xs text-stone">
                {row.description}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        value: (row) => row.status,
        cell: (row) => <InvoiceStatusBadge status={row.status} />,
      },
      {
        id: 'issuedAt',
        header: 'Issued',
        sortable: true,
        value: (row) => (row.issuedAt === null ? null : new Date(row.issuedAt)),
        cell: (row) => (
          <DateTime value={row.issuedAt} fallback="—" tone="muted" nowrap />
        ),
      },
      {
        id: 'dueAt',
        header: 'Due',
        sortable: true,
        value: (row) => (row.dueAt === null ? null : new Date(row.dueAt)),
        cell: (row) => (
          <DateTime value={row.dueAt} fallback="—" tone="muted" nowrap />
        ),
      },
      {
        id: 'amountDueCents',
        header: 'Amount',
        numeric: true,
        sortable: true,
        value: (row) => row.amountDueCents,
        cell: (row) => (
          <Money
            cents={row.amountDueCents}
            currency={row.currency}
            weight="medium"
          />
        ),
      },
      {
        id: 'amountRemainingCents',
        header: 'Outstanding',
        numeric: true,
        sortable: true,
        value: (row) => row.amountRemainingCents,
        cell: (row) =>
          row.amountRemainingCents === 0 ? (
            <span className="font-sans text-xs text-stone">Settled</span>
          ) : (
            <Money
              cents={row.amountRemainingCents}
              currency={row.currency}
              tone="negative"
              weight="medium"
            />
          ),
      },
      {
        id: 'links',
        header: 'Open',
        headerSrOnly: true,
        cell: (row) => {
          if (row.hostedInvoiceUrl === null && row.pdfUrl === null) {
            return (
              <span className="font-sans text-xs text-stone">
                Not published
              </span>
            )
          }

          const label = row.number ?? 'this invoice'

          return (
            <div className="flex flex-col items-end gap-1">
              {row.hostedInvoiceUrl === null ? null : (
                <a
                  href={row.hostedInvoiceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK_CLASS}
                >
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  View
                  <span className="sr-only">
                    {` invoice ${label} on the payment page, opens in a new tab`}
                  </span>
                </a>
              )}
              {row.pdfUrl === null ? null : (
                <a
                  href={row.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK_CLASS}
                >
                  <FileText aria-hidden="true" className="size-3.5" />
                  PDF
                  <span className="sr-only">
                    {` of invoice ${label}, opens in a new tab`}
                  </span>
                </a>
              )}
            </div>
          )
        },
      },
    ],
    []
  )

  return (
    <DataTable
      caption="Your invoices, newest first. Sortable by number, status, date and amount."
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      density="comfortable"
      empty={{
        title: 'No invoices yet.',
        description:
          'Once we have cooked for you, or your plan has renewed, the bill and its receipt appear here.',
      }}
      emptyFiltered={{
        title: 'No invoice matches that search.',
        description: 'Clear the filter to see the rest.',
      }}
    />
  )
}
