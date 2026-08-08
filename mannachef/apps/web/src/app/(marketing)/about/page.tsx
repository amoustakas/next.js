// mannachef/apps/web/src/app/(marketing)/about/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Reveal } from '@/components/marketing/reveal'
import {
  CONSULTATION_CTA,
  CONTACT,
  OPERATING_FACTS,
  SERVICE_AREA,
} from '@/components/marketing/site-config'

/**
 * About.
 *
 * A Server Component with no data reads at all — every word on it is editorial
 * copy that belongs to the brand rather than to the database, so there is
 * nothing to await, nothing to stream, and no `<Suspense>` boundary to justify.
 * The only client code it loads is the `<Reveal>` wrapper.
 *
 * ## Revalidation
 *
 * Twenty-four hours. Nothing here is derived from a mutation, so no action
 * revalidates this path; the daily rebuild exists so an edit to this file
 * reaches production on the next deploy rather than waiting for a cache to age
 * out. Anything shorter would re-render a page that cannot have changed.
 */
export const revalidate = 86400

export const metadata: Metadata = {
  title: 'About',
  description:
    'MannaChef is a small Toronto kitchen cooking for a small number of households. How we work, what we source, and the things we deliberately do not do.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About · MannaChef',
    description:
      'A small Toronto kitchen cooking for a small number of households — how we work, what we source, and what we do not do.',
    url: '/about',
  },
}

const ENGAGEMENT_STEPS = [
  {
    title: 'The consultation',
    body: 'Half an hour, no charge. We ask who eats at the table, what nobody will touch, which allergies are medical rather than preference, how many nights a week you actually cook, and what your kitchen has in it. We take notes. If what you want is not what we do, we say so then rather than three weeks later.',
  },
  {
    title: 'The first menu',
    body: 'You get a written menu for the first service — dishes, the reasoning behind each one, and the price per serving. Nothing is locked. Most households change two or three things on the first draft and one thing on the second, and after that we stop needing to ask.',
  },
  {
    title: 'The shop',
    body: 'We buy for your household ourselves, the week we cook. That is why the menu is written against the season rather than against a catalogue: if the brassicas are better than the roots that week, the menu says so before the shopping does.',
  },
  {
    title: 'The service',
    body: 'A chef arrives with prep done, cooks in your kitchen, plates what is eaten that night, and packs and labels the rest for the week. The kitchen is left cleaner than it was found. That is not a courtesy — it is the part of the job that makes the arrangement liveable.',
  },
  {
    title: 'The standing arrangement',
    body: 'Most households settle into weekly or fortnightly service. The menu keeps moving with the season and with what you tell us after each one. You can pause it for a month; you can end it with a fortnight’s notice; there is no annual commitment to sign.',
  },
] as const

const LIMITS = [
  {
    title: 'We do not cater large events',
    body: 'Above about sixteen covers a private chef becomes a catering company with different equipment, different insurance and a different kind of attention. We will happily recommend someone who does that work properly.',
  },
  {
    title: 'We do not ship food',
    body: 'Everything is cooked in your kitchen on the day. There is no cold chain, no reheating instructions on a card, and no courier — which is also why our service area ends where a sensible drive does.',
  },
  {
    title: 'We do not write a menu we cannot source',
    body: 'If a dish depends on something that is not good this month, it comes off the list until it is. A menu that promises a tomato in February is a menu written by a supplier, not a chef.',
  },
] as const

export default function AboutPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
      <header className="max-w-3xl">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          About MannaChef
        </p>
        <h1 className="mt-4 font-display text-4xl leading-[1.1] font-light tracking-tight text-linen text-balance sm:text-5xl">
          A small kitchen, cooking for a small number of households.
        </h1>
        <p className="mt-8 font-sans text-base leading-relaxed text-parchment sm:text-lg">
          MannaChef works out of a prep kitchen on Ossington and cooks in other
          people&rsquo;s homes across {CONTACT.locality} and the Golden
          Horseshoe. We take on a limited number of households at a time —
          limited by what one kitchen can shop for and cook properly in a week,
          not by an idea about exclusivity.
        </p>
      </header>

      <div aria-hidden="true" className="hairline mt-14" />

      <section aria-labelledby="story-heading" className="mt-14 max-w-3xl">
        <h2
          id="story-heading"
          className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
        >
          Why the service is shaped this way
        </h2>
        <div className="mt-6 flex flex-col gap-5 font-sans text-base leading-relaxed text-parchment">
          <p>
            Most people who look for a private chef are not looking for a
            dinner party. They are looking for the ordinary week to stop being a
            negotiation — a household where somebody has a nut allergy, somebody
            is training, somebody has stopped eating meat, and everybody gets
            home at a different hour.
          </p>
          <p>
            That problem is not solved by a set menu. It is solved by somebody
            learning the household properly once, then shopping and cooking for
            it repeatedly, and adjusting as the seasons and the household both
            move. So the service is built around a standing arrangement and a
            written menu that changes, rather than around an à la carte list you
            order from.
          </p>
          <p>
            The occasion cooking — a birthday, an anniversary, the dinner that
            has to be right — grows out of that. By the time we cook it we
            already know what your table likes, which is the only reason it is
            worth asking us rather than booking a restaurant.
          </p>
        </div>
      </section>

      <section aria-labelledby="engagement-heading" className="mt-20">
        <Reveal>
          <h2
            id="engagement-heading"
            className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
          >
            How an engagement runs
          </h2>
        </Reveal>

        <ol className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {ENGAGEMENT_STEPS.map((step, index) => (
            <Reveal as="li" key={step.title} delay={index * 0.05}>
              <Card variant="quiet" className="h-full">
                <CardContent className="flex h-full flex-col gap-3 p-7">
                  <p
                    aria-hidden="true"
                    className="font-sans text-xs text-stone tabular-nums"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </p>
                  <CardTitle level={3} className="text-lg">
                    {step.title}
                  </CardTitle>
                  <p className="font-sans text-sm leading-relaxed text-parchment">
                    {step.body}
                  </p>
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </ol>
      </section>

      <section aria-labelledby="sourcing-heading" className="mt-20 max-w-3xl">
        <Reveal>
          <h2
            id="sourcing-heading"
            className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
          >
            What we buy, and where
          </h2>
          <div className="mt-6 flex flex-col gap-5 font-sans text-base leading-relaxed text-parchment">
            <p>
              Vegetables and fruit come from Ontario growers for as much of the
              year as the province allows, which in practice is late April to
              the middle of November, plus whatever comes out of cold storage
              honestly after that. Grain and flour come from mills in the Ottawa
              Valley and Grey County. Freshwater fish comes off Lake Erie and
              Lake Huron; anything from salt water is bought whole and broken
              down in our kitchen rather than arriving portioned.
            </p>
            <p>
              Where the province genuinely cannot supply something — citrus,
              coffee, most spice — we buy it from importers who will tell us
              where it came from, and we do not pretend otherwise on the menu.
            </p>
          </div>
        </Reveal>
      </section>

      <section aria-labelledby="limits-heading" className="mt-20">
        <Reveal>
          <h2
            id="limits-heading"
            className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
          >
            Things we do not do
          </h2>
          <p className="mt-4 max-w-2xl font-sans text-base leading-relaxed text-parchment">
            Worth saying plainly, because finding out at the consultation wastes
            your afternoon and ours.
          </p>
        </Reveal>

        <ul className="mt-10 grid gap-6 md:grid-cols-3">
          {LIMITS.map((limit, index) => (
            <Reveal as="li" key={limit.title} delay={index * 0.05}>
              <Card variant="quiet" className="h-full">
                <CardContent className="flex h-full flex-col gap-3 p-7">
                  <CardTitle level={3} className="text-lg">
                    {limit.title}
                  </CardTitle>
                  <p className="font-sans text-sm leading-relaxed text-parchment">
                    {limit.body}
                  </p>
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </ul>
      </section>

      <section aria-labelledby="practical-heading" className="mt-20">
        <Reveal>
          <h2
            id="practical-heading"
            className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
          >
            The practical facts
          </h2>
        </Reveal>

        <Separator variant="subtle" className="mt-6" />

        <div className="mt-8 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase">
              How we operate
            </h3>
            <ul className="mt-4 flex flex-col gap-3">
              {OPERATING_FACTS.map((fact) => (
                <li
                  key={fact}
                  className="font-sans text-sm leading-relaxed text-parchment"
                >
                  {fact}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase">
              Where we cook
            </h3>
            <ul className="mt-4 flex flex-col gap-3">
              {SERVICE_AREA.map((area) => (
                <li key={area} className="font-sans text-sm text-parchment">
                  {area}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="about-cta-heading"
        className="mt-20 border-t border-ash/70 pt-16 text-center"
      >
        <Reveal>
          <h2
            id="about-cta-heading"
            className="font-display text-3xl leading-tight font-light tracking-tight text-linen text-balance"
          >
            The next step is a conversation.
          </h2>
          <p className="mx-auto mt-6 max-w-xl font-sans text-base leading-relaxed text-parchment">
            Tell us who eats at your table and when a half hour suits you. We
            will come back with times and, if we are not the right kitchen for
            what you need, with the name of someone who is.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Button asChild variant="champagne" size="lg">
              <Link href={CONSULTATION_CTA.href}>{CONSULTATION_CTA.label}</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/menu">Read the menu first</Link>
            </Button>
          </div>
        </Reveal>
      </section>
    </div>
  )
}
