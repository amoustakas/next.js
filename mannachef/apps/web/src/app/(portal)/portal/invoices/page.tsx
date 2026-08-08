// mannachef/apps/web/src/app/(portal)/portal/invoices/page.tsx

/**
 * Every bill, with the link that pays it and the link that files it.
 *
 * A **Server Component**. `listInvoices` pins the query to `userId:
 * ctx.user.id` for anybody below `ADMIN` — the `userId` and `issuedById`
 * filters on `invoiceFilterSchema` are *discarded* rather than honoured — so
 * this page cannot be made to return another household's bills by any
 * arrangement of parameters, and it passes none.
 *
 * The rows are flattened to plain, serialisable values before they cross into
 * `<InvoiceTable>`; the two Stripe links go with them exactly as the action
 * returned them, and `memo` — which the projection withholds from a household
 * anyway — is nowhere in the payload.
 *
 * The outstanding total above the table is computed here rather than in the
 * browser, from the same rows the table shows, so the two can never disagree.
 */

import type * as React from 'react'

import { ActionError } from '@/components/portal/action-error'
import { InvoiceTable, type InvoiceRow } from '@/components/portal/invoice-table'
import { Card, CardContent } from '@/components/ui/card'
import { Money } from '@/components/ui/money'
import { listInvoices } from '@/server/actions/billing'

export const metadata = {
  title: 'Invoices',
}

export default async function PortalInvoicesPage(): Promise<React.JSX.Element> {
  const invoices = await listInvoices({ pageSize: 100 })

  if (!invoices.ok) {
    return (
      <ActionError
        code={invoices.code}
        error={invoices.error}
        subject="your invoices"
        headingLevel={2}
      />
    )
  }

  const rows: readonly InvoiceRow[] = invoices.data.items.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    amountDueCents: invoice.amountDueCents,
    amountRemainingCents: invoice.amountRemainingCents,
    currency: invoice.currency,
    issuedAt: invoice.issuedAt === null ? null : invoice.issuedAt.toISOString(),
    dueAt: invoice.dueAt === null ? null : invoice.dueAt.toISOString(),
    paidAt: invoice.paidAt === null ? null : invoice.paidAt.toISOString(),
    description: invoice.description,
    hostedInvoiceUrl: invoice.hostedInvoiceUrl,
    pdfUrl: invoice.pdfUrl,
  }))

  const outstandingCents = rows.reduce(
    (total, row) => total + row.amountRemainingCents,
    0
  )
  const currency = rows[0]?.currency ?? 'CAD'

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-3xl leading-tight font-light text-linen">
          Invoices
        </h2>
        <p className="font-sans text-sm leading-relaxed text-parchment">
          Every bill we have raised, with the page that settles it and the PDF
          for your records.
        </p>
      </header>

      {rows.length === 0 ? null : (
        <Card as="section" variant="quiet">
          <CardContent className="flex flex-wrap items-baseline justify-between gap-4 p-6">
            <div className="flex flex-col gap-1">
              <p className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                Outstanding
              </p>
              <p className="font-display text-3xl font-light">
                <Money
                  cents={outstandingCents}
                  currency={currency}
                  tone={outstandingCents === 0 ? 'muted' : 'accent'}
                />
              </p>
            </div>
            <p className="max-w-md font-sans text-xs leading-relaxed text-stone">
              {outstandingCents === 0
                ? 'Nothing is owing. Every invoice on your account has been settled.'
                : 'Open any invoice below to settle it. Payment is taken on our processor’s own page — we never handle your card details.'}
            </p>
          </CardContent>
        </Card>
      )}

      <InvoiceTable rows={rows} />
    </div>
  )
}
