// mannachef/apps/web/src/app/(marketing)/contact/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { ConsultationRequestForm } from '@/components/marketing/consultation-request-form'
import {
  CONTACT,
  OFFICE_HOURS,
  SERVICE_AREA,
  formattedAddress,
} from '@/components/marketing/site-config'

/**
 * Contact.
 *
 * A Server Component that renders one client island: the enquiry form. The
 * address, the hours and the service area are static markup and ship no
 * JavaScript, which is the right split — a guest who only wants the phone
 * number should not have to download a form to read it, and it should be
 * legible before hydration.
 *
 * ## Revalidation
 *
 * Twenty-four hours. Nothing on this page is derived from the database, so no
 * mutation invalidates it; the daily ceiling exists so an edited phone number
 * or a changed opening hour reaches production predictably.
 *
 * The form itself is a *mutation*, and mutations are never cached — the
 * `requestConsultation` action runs at request time whatever this page's
 * revalidation window says, and it carries its own rate limit.
 */
export const revalidate = 86400

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Ask MannaChef for a consultation, or reach the kitchen office in Toronto directly by phone or email. Half an hour, no charge, no obligation.',
  alternates: { canonical: '/contact' },
  openGraph: {
    title: 'Contact · MannaChef',
    description:
      'Ask for a consultation, or reach the kitchen office in Toronto directly.',
    url: '/contact',
  },
}

export default function ContactPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <header className="max-w-3xl">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          Contact
        </p>
        <h1 className="mt-4 font-display text-4xl leading-[1.1] font-light tracking-tight text-linen text-balance sm:text-5xl">
          Start with half an hour.
        </h1>
        <p className="mt-8 font-sans text-base leading-relaxed text-parchment sm:text-lg">
          A consultation costs nothing and commits you to nothing. We ask who
          eats at your table, what is off the list, and what a week actually
          looks like — and we tell you honestly whether a standing arrangement
          with this kitchen is what you want.
        </p>
      </header>

      <div aria-hidden="true" className="hairline mt-14" />

      <div className="mt-14 grid gap-14 lg:grid-cols-[1fr_20rem] lg:gap-20">
        <section aria-labelledby="enquiry-heading">
          <h2 id="enquiry-heading" className="sr-only">
            Request a consultation
          </h2>
          <ConsultationRequestForm />
        </section>

        <aside
          aria-labelledby="kitchen-heading"
          className="flex flex-col gap-8 lg:sticky lg:top-24 lg:self-start"
        >
          <Card variant="quiet">
            <CardContent className="flex flex-col gap-6 p-6 pt-6">
              <h2
                id="kitchen-heading"
                className="font-display text-xl leading-tight font-medium tracking-tight text-linen"
              >
                The kitchen office
              </h2>

              <address className="flex flex-col gap-4 font-sans text-sm leading-relaxed text-parchment not-italic">
                <span className="block">{formattedAddress()}</span>

                <span className="flex flex-col gap-1">
                  <span className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
                    Email
                  </span>
                  <a
                    href={`mailto:${CONTACT.email}`}
                    className="rounded-sm text-linen underline-offset-4 transition-colors duration-200 ease-luxe hover:underline"
                  >
                    {CONTACT.email}
                  </a>
                </span>

                <span className="flex flex-col gap-1">
                  <span className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
                    Telephone
                  </span>
                  <a
                    href={`tel:${CONTACT.phoneE164}`}
                    className="rounded-sm text-linen tabular-nums underline-offset-4 transition-colors duration-200 ease-luxe hover:underline"
                  >
                    {CONTACT.phoneDisplay}
                  </a>
                </span>
              </address>

              <Separator variant="subtle" />

              <div>
                <h3 className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
                  When the phone is answered
                </h3>
                <dl className="mt-3 flex flex-col gap-2">
                  {OFFICE_HOURS.map((entry) => (
                    <div
                      key={entry.days}
                      className="flex flex-wrap justify-between gap-x-4"
                    >
                      <dt className="font-sans text-sm text-parchment">
                        {entry.days}
                      </dt>
                      <dd className="font-sans text-sm text-stone tabular-nums">
                        {entry.hours}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </CardContent>
          </Card>

          <section aria-labelledby="expect-heading">
            <h2
              id="expect-heading"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              What happens next
            </h2>
            <ol className="mt-4 flex flex-col gap-3">
              <li className="font-sans text-sm leading-relaxed text-parchment">
                We reply within one working day with a confirmed time, or with
                an alternative if none of yours work.
              </li>
              <li className="font-sans text-sm leading-relaxed text-parchment">
                The consultation runs for as long as you booked — in your
                kitchen if you are inside our service area, otherwise by call.
              </li>
              <li className="font-sans text-sm leading-relaxed text-parchment">
                A written first menu follows within a week, with prices per
                serving and the reasoning behind each dish.
              </li>
            </ol>
          </section>

          <section aria-labelledby="area-heading">
            <h2
              id="area-heading"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              Where we cook
            </h2>
            <ul className="mt-4 flex flex-col gap-2">
              {SERVICE_AREA.map((area) => (
                <li key={area} className="font-sans text-sm text-parchment">
                  {area}
                </li>
              ))}
            </ul>
            <p className="mt-4 font-sans text-xs leading-relaxed text-stone">
              Outside that, tell us where and we will quote the travel before
              you commit to anything.
            </p>
          </section>

          <p className="font-sans text-sm leading-relaxed text-stone">
            Not ready to talk yet?{' '}
            <Link
              href="/menu"
              className="rounded-sm text-parchment underline underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen"
            >
              Read what we are cooking this season
            </Link>
            .
          </p>
        </aside>
      </div>
    </div>
  )
}
