// mannachef/apps/web/src/app/(marketing)/page.tsx
import * as React from 'react'
import { Suspense } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarRange, Leaf, NotebookPen, UtensilsCrossed } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { DishCard } from '@/components/marketing/dish-card'
import {
  DishGridSkeleton,
  ReviewStripSkeleton,
} from '@/components/marketing/menu-skeletons'
import { ReadFailure } from '@/components/marketing/read-failure'
import { Entrance, Reveal } from '@/components/marketing/reveal'
import { ReviewCard } from '@/components/marketing/review-card'
import { CONSULTATION_CTA, SERVICE_AREA } from '@/components/marketing/site-config'
import { listMenuItems } from '@/server/actions/menu'
import { listPublishedReviews } from '@/server/actions/review'

/**
 * The home page.
 *
 * A Server Component that renders four reads' worth of real data and ships no
 * page-level JavaScript of its own. The only client code below this file is
 * `<Entrance>`/`<Reveal>` — two motion wrappers — and the header in the layout.
 *
 * ## Streaming
 *
 * The hero, the proposition and the closing call to action are static markup
 * and go out on the first flush. The two database-backed strips — signature
 * dishes and featured reviews — each sit behind their own `<Suspense>`
 * boundary, so a slow query on one does not hold the other, and neither holds
 * the hero. That is the whole reason the two reads live in async child
 * components rather than at the top of `Home()`: awaiting them here would make
 * the entire page wait on both.
 *
 * ## Revalidation
 *
 * One hour. The signature list and the featured reviews are *curated* — they
 * change when someone in the admin OS marks a dish signature or features a
 * review, not on a schedule — and both of those mutations already call
 * `revalidatePath('/')` through `MENU_REVALIDATE_PATHS` and `REVIEW_PATHS` in
 * their action modules. The hour is therefore a backstop against a missed
 * invalidation rather than the primary freshness mechanism.
 */
export const revalidate = 3600

export const metadata: Metadata = {
  description:
    'MannaChef is a personal-chef service in Toronto. We plan a seasonal menu around how your household actually eats, shop it that week, and cook it in your kitchen.',
  alternates: { canonical: '/' },
}

const PROPOSITION = [
  {
    icon: NotebookPen,
    title: 'We start with a conversation',
    body: 'A consultation, in your kitchen or over a call. Who eats at your table, what they will not touch, which allergies are serious, how late you get home on a Wednesday. Every menu we write begins in that notebook.',
  },
  {
    icon: Leaf,
    title: 'We shop the week, not the recipe',
    body: 'Menus are drafted against what is genuinely good that week — Ontario growers, Lake Erie fishers, millers in the Ottawa Valley. A dish comes off the list when its season closes rather than being flown in out of it.',
  },
  {
    icon: UtensilsCrossed,
    title: 'We cook in your kitchen',
    body: 'The chef arrives with the shopping done and the prep started, cooks the service, plates it, and leaves the kitchen cleaner than it was found. Portions for the rest of the week go into the fridge labelled and dated.',
  },
] as const

export default function HomePage(): React.JSX.Element {
  return (
    <>
      <Hero />
      <Proposition />
      <SignatureStrip />
      <ReviewStrip />
      <ClosingCta />
    </>
  )
}

/**
 * The hero.
 *
 * `-mt-16` cancels the layout's header offset so the ground runs to the very
 * top of the viewport and the fixed, transparent header sits on top of it —
 * the `pt-16` inside puts the copy back where it belongs.
 *
 * One champagne element: the consultation button. The serif is used for the
 * headline and nowhere else on the screen.
 */
function Hero(): React.JSX.Element {
  return (
    <section
      aria-labelledby="hero-heading"
      className="-mt-16 border-b border-ash/60 bg-gradient-to-b from-charcoal via-charcoal to-obsidian"
    >
      <div className="mx-auto w-full max-w-6xl px-5 pt-40 pb-24 sm:px-8 sm:pt-48 sm:pb-32">
        <Entrance className="max-w-3xl">
          <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
            Personal chef · Toronto &amp; the Golden Horseshoe
          </p>

          <h1
            id="hero-heading"
            className="mt-6 font-display text-4xl leading-[1.08] font-light tracking-tight text-linen text-balance sm:text-5xl lg:text-6xl"
          >
            Dinner, written for your household and cooked in your kitchen.
          </h1>

          <div aria-hidden="true" className="hairline mt-10 max-w-xs" />

          <p className="mt-10 max-w-xl font-sans text-base leading-relaxed text-parchment sm:text-lg">
            MannaChef is a small kitchen that cooks for a small number of
            households. We learn how you eat, build a seasonal menu around it,
            shop it ourselves, and cook it at your table — weekly, fortnightly,
            or for one evening that has to be right.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Button asChild variant="champagne" size="lg">
              <Link href={CONSULTATION_CTA.href}>{CONSULTATION_CTA.label}</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/menu">See this season&rsquo;s menu</Link>
            </Button>
          </div>
        </Entrance>
      </div>
    </section>
  )
}

/** What the service actually is, in three plain statements. */
function Proposition(): React.JSX.Element {
  return (
    <section
      aria-labelledby="proposition-heading"
      className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8"
    >
      <Reveal>
        <h2
          id="proposition-heading"
          className="max-w-2xl font-display text-3xl leading-tight font-light tracking-tight text-linen text-balance sm:text-4xl"
        >
          A private chef is a standing arrangement, not a single dinner.
        </h2>
        <p className="mt-6 max-w-2xl font-sans text-base leading-relaxed text-parchment">
          Most of our work is the ordinary week: the food a family eats on a
          Tuesday, cooked properly, without anybody having to think about it at
          six o&rsquo;clock. The occasion menus grow out of that relationship
          rather than replacing it.
        </p>
      </Reveal>

      <ul className="mt-14 grid gap-6 md:grid-cols-3">
        {PROPOSITION.map((item, index) => {
          const Icon = item.icon

          return (
            <Reveal as="li" key={item.title} delay={index * 0.06}>
              <Card variant="quiet" className="h-full">
                <CardContent className="flex h-full flex-col gap-4 p-7">
                  <span
                    aria-hidden="true"
                    className="flex size-10 items-center justify-center rounded-full border border-ash text-stone"
                  >
                    <Icon className="size-5" />
                  </span>
                  <CardTitle level={3} className="text-lg">
                    {item.title}
                  </CardTitle>
                  <p className="font-sans text-sm leading-relaxed text-parchment">
                    {item.body}
                  </p>
                </CardContent>
              </Card>
            </Reveal>
          )
        })}
      </ul>

      <Reveal className="mt-12">
        <p className="font-sans text-sm leading-relaxed text-stone">
          We cook across {SERVICE_AREA.slice(0, 3).join(', ')} and the rest of
          the Golden Horseshoe.
        </p>
      </Reveal>
    </section>
  )
}

/** The signature dishes, streamed. */
function SignatureStrip(): React.JSX.Element {
  return (
    <section
      aria-labelledby="signature-heading"
      className="border-y border-ash/60 bg-charcoal/40"
    >
      <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <Reveal className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-xl">
            <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
              From the current menu
            </p>
            <h2
              id="signature-heading"
              className="mt-4 font-display text-3xl leading-tight font-light tracking-tight text-linen sm:text-4xl"
            >
              Signature dishes
            </h2>
          </div>
          <Button asChild variant="outline">
            <Link href="/menu">Browse the full menu</Link>
          </Button>
        </Reveal>

        <div aria-hidden="true" className="hairline mt-10" />

        <div className="mt-10">
          <Suspense fallback={<DishGridSkeleton count={3} />}>
            <SignatureDishes />
          </Suspense>
        </div>
      </div>
    </section>
  )
}

/**
 * Reads the curated signature list.
 *
 * `listMenuItems` is `auth: 'PUBLIC'`, and for a caller below `CHEF_STAFF` it
 * already narrows to published dishes in published collections that are in
 * season this month — so nothing here has to filter for visibility, and nothing
 * here is permitted to widen it.
 */
async function SignatureDishes(): Promise<React.JSX.Element> {
  const result = await listMenuItems({
    signatureOnly: true,
    page: 1,
    pageSize: 3,
    sortBy: 'CURATED',
    sortDirection: 'asc',
  })

  if (!result.ok) {
    return <ReadFailure failure={result} subject="the signature dishes" />
  }

  if (result.data.items.length === 0) {
    return (
      <EmptyState
        icon={CalendarRange}
        title="This season&rsquo;s signatures are being written."
        description="The kitchen is between menus. The full list of what we are cooking right now is on the menu page."
        action={
          <Button asChild variant="outline">
            <Link href="/menu">See the menu</Link>
          </Button>
        }
      />
    )
  }

  return (
    <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {result.data.items.map((dish, index) => (
        <Reveal as="li" key={dish.id} delay={index * 0.06}>
          <DishCard
            dish={dish}
            headingLevel={3}
            imageSizes="(min-width: 1024px) 22rem, (min-width: 640px) 45vw, 92vw"
          />
        </Reveal>
      ))}
    </ul>
  )
}

/** The featured reviews, streamed. */
function ReviewStrip(): React.JSX.Element {
  return (
    <section
      aria-labelledby="reviews-heading"
      className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8"
    >
      <Reveal className="max-w-xl">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          In our guests&rsquo; words
        </p>
        <h2
          id="reviews-heading"
          className="mt-4 font-display text-3xl leading-tight font-light tracking-tight text-linen sm:text-4xl"
        >
          What the table said
        </h2>
        <p className="mt-6 font-sans text-base leading-relaxed text-parchment">
          Every review below was written by a household we cook for and read by
          a person before it was published.
        </p>
      </Reveal>

      <div className="mt-12">
        <Suspense fallback={<ReviewStripSkeleton />}>
          <FeaturedReviews />
        </Suspense>
      </div>
    </section>
  )
}

/**
 * Reads the reviews the kitchen has *featured*.
 *
 * `featuredOnly` narrows `listPublishedReviews` to `status: 'FEATURED'`
 * specifically, and `sortBy: 'FEATURED_ORDER'` ascending honours the curated
 * running order rather than showing whichever three are newest. The action
 * refuses to return anything outside `APPROVED | FEATURED` whatever it is
 * asked for, so there is no path from this component to an unmoderated review.
 */
async function FeaturedReviews(): Promise<React.JSX.Element> {
  const result = await listPublishedReviews({
    featuredOnly: true,
    page: 1,
    pageSize: 3,
    sortBy: 'FEATURED_ORDER',
    sortDirection: 'asc',
  })

  if (!result.ok) {
    return <ReadFailure failure={result} subject="our featured reviews" />
  }

  if (result.data.items.length === 0) {
    return (
      <EmptyState
        title="No reviews are featured just now."
        description="Reviews appear here once a guest has written one and the kitchen has read it."
      />
    )
  }

  return (
    <ul className="grid gap-6 md:grid-cols-3">
      {result.data.items.map((review, index) => (
        <Reveal as="li" key={review.id} delay={index * 0.06}>
          <ReviewCard review={review} headingLevel={3} />
        </Reveal>
      ))}
    </ul>
  )
}

/** The closing invitation. One champagne element, and it is the button. */
function ClosingCta(): React.JSX.Element {
  return (
    <section
      aria-labelledby="closing-heading"
      className="border-t border-ash/60 bg-charcoal/40"
    >
      <div className="mx-auto w-full max-w-3xl px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2
            id="closing-heading"
            className="font-display text-3xl leading-tight font-light tracking-tight text-linen text-balance sm:text-4xl"
          >
            Start with a consultation.
          </h2>
          <p className="mx-auto mt-6 max-w-xl font-sans text-base leading-relaxed text-parchment">
            Half an hour, no charge, no obligation: who eats at your table, what
            a week looks like, and whether what we do is what you actually want.
            We will tell you honestly if it is not.
          </p>

          <div aria-hidden="true" className="hairline mx-auto mt-10 max-w-xs" />

          <div className="mt-10">
            <Button asChild variant="champagne" size="lg">
              <Link href={CONSULTATION_CTA.href}>{CONSULTATION_CTA.label}</Link>
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
