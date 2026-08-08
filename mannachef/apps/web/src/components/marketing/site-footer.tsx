// mannachef/apps/web/src/components/marketing/site-footer.tsx
import * as React from 'react'
import Link from 'next/link'

import {
  BRAND_NAME,
  CONTACT,
  OFFICE_HOURS,
  OPERATING_FACTS,
  PRIMARY_NAV,
  SERVICE_AREA,
  SOCIAL_LINKS,
} from '@/components/marketing/site-config'

/**
 * The public site's footer.
 *
 * A Server Component with no state, no handlers and no client bundle. It is
 * where the business actually says who it is: an address a courier could find,
 * a number that rings the kitchen office, the hours that number is answered,
 * and the boroughs we drive to without a travel arrangement.
 *
 * The single gold element is the hairline rule across the top — so no link, no
 * heading and no button below it may be champagne.
 *
 * The `<address>` element is used for its real purpose (contact details for the
 * page's owner) and carries `not-italic`, because browsers italicise it by
 * default and a postal address in italics reads as an aside.
 */
export function SiteFooter(): React.JSX.Element {
  const year = new Date().getFullYear()

  return (
    <footer className="mt-24 bg-charcoal">
      <div aria-hidden="true" className="hairline" />

      <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
        <div className="grid gap-12 md:grid-cols-12">
          <div className="md:col-span-4">
            <p className="font-display text-2xl leading-none font-medium tracking-[0.14em] text-linen uppercase">
              {BRAND_NAME}
            </p>
            <p className="mt-4 max-w-xs font-sans text-sm leading-relaxed text-parchment">
              An artisanal personal-chef service working out of a small prep
              kitchen on Ossington. We plan a menu around how a household
              actually eats, shop it that week, and cook it in your kitchen.
            </p>

            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
              {SOCIAL_LINKS.map((social) => (
                <li key={social.href}>
                  <a
                    href={social.href}
                    rel="noreferrer noopener"
                    target="_blank"
                    className="rounded-sm font-sans text-sm text-parchment underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen hover:underline"
                  >
                    {social.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <nav aria-labelledby="footer-explore" className="md:col-span-2">
            <h2
              id="footer-explore"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              Explore
            </h2>
            <ul className="mt-4 flex flex-col gap-3">
              <li>
                <Link
                  href="/"
                  className="rounded-sm font-sans text-sm text-parchment underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen hover:underline"
                >
                  Home
                </Link>
              </li>
              {PRIMARY_NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="rounded-sm font-sans text-sm text-parchment underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen hover:underline"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <section aria-labelledby="footer-contact" className="md:col-span-3">
            <h2
              id="footer-contact"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              The kitchen
            </h2>
            <address className="mt-4 flex flex-col gap-3 font-sans text-sm leading-relaxed text-parchment not-italic">
              <span className="block">
                {CONTACT.street}
                <br />
                {CONTACT.locality}, {CONTACT.regionCode} {CONTACT.postalCode}
                <br />
                {CONTACT.country}
              </span>
              <a
                href={`mailto:${CONTACT.email}`}
                className="rounded-sm underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen hover:underline"
              >
                {CONTACT.email}
              </a>
              <a
                href={`tel:${CONTACT.phoneE164}`}
                className="rounded-sm tabular-nums underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen hover:underline"
              >
                {CONTACT.phoneDisplay}
              </a>
            </address>

            <h3 className="mt-6 font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase">
              Office hours
            </h3>
            <dl className="mt-3 flex flex-col gap-1.5">
              {OFFICE_HOURS.map((entry) => (
                <div key={entry.days} className="flex flex-col">
                  <dt className="font-sans text-sm text-parchment">
                    {entry.days}
                  </dt>
                  <dd className="font-sans text-sm text-stone tabular-nums">
                    {entry.hours}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="footer-area" className="md:col-span-3">
            <h2
              id="footer-area"
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
            <p className="mt-4 font-sans text-sm leading-relaxed text-stone">
              Farther afield — Prince Edward County, Muskoka, the Eastern
              Townships — by arrangement, with travel quoted before you commit.
            </p>
          </section>
        </div>

        <ul className="mt-12 grid gap-2 border-t border-ash/70 pt-8 sm:grid-cols-2">
          {OPERATING_FACTS.map((fact) => (
            <li key={fact} className="font-sans text-xs leading-relaxed text-stone">
              {fact}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-col gap-2 border-t border-ash/70 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-sans text-xs text-stone">
            © {year} {BRAND_NAME}. Cooked in {CONTACT.locality},{' '}
            {CONTACT.region}.
          </p>
          <p className="font-sans text-xs text-stone">
            Menus change with the season; prices shown are per serving and
            exclude HST.
          </p>
        </div>
      </div>
    </footer>
  )
}
