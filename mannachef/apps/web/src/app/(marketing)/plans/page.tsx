// mannachef/apps/web/src/app/(marketing)/plans/page.tsx

/**
 * The public plan collection — what a household may subscribe to, and at what
 * price.
 *
 * A **Server Component** with no client boundary at all. The one read it
 * performs happens here, so the page arrives as finished markup: a price list
 * that needed JavaScript to show its prices would be a strange thing to hand a
 * search engine, and this is the page the portal sends anybody who is not yet
 * on a plan.
 *
 * ## Why the read cannot fail the page
 *
 * `listSubscriptionPlans` is `auth: 'PUBLIC'` and returns an `ActionResult`
 * rather than throwing (`CONTRACT.md` §4). It also pins `isActive` to `true`
 * for every caller below `ADMIN`, so what comes back is exactly the ladder a
 * visitor may actually join — a plan withdrawn from sale cannot appear here by
 * accident, whatever this page asks for.
 *
 * A failure is therefore a degradation, not an outage, and is rendered as one:
 * the prose above the list still stands, and the consultation route out of the
 * page still works, because a household that cannot see the prices can still
 * ask to talk to somebody. Falling back to hardcoded prices would be worse than
 * showing none — a stale price on a public page is a quotation the house did
 * not make.
 *
 * ## `SORT_ORDER`, not `PRICE`
 *
 * The collection is ordered by the `sortOrder` column, which is the house's own
 * arrangement, rather than cheapest-first. The ladder is a curatorial statement
 * and the ordering is part of it; sorting by price would silently reorder the
 * collection every time a figure changed.
 */

import type * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { UtensilsCrossed } from 'lucide-react'

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
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { describeBillingInterval } from '@/components/portal/subscription-state'
import { listSubscriptionPlans } from '@/server/actions/billing'

export const metadata: Metadata = {
  title: 'Plans',
  description:
    'Standing arrangements for a household that would rather not think about dinner: how many meals a week, how many at the table, and what it costs.',
  alternates: { canonical: '/plans' },
  openGraph: {
    title: 'Plans · MannaChef',
    description:
      'Standing arrangements for a household that would rather not think about dinner.',
    url: '/plans',
  },
}

/** How many plans a collection may reasonably hold. Well above the real count. */
const MAX_PLANS = 24

/**
 * One plan.
 *
 * Accent discipline (`CONTRACT.md` §3): each card is one visual group and gets
 * exactly one champagne element. On an ordinary card that is the price; on the
 * featured card the gold hairline of `variant="accent"` is already spending the
 * group's accent, so the badge is `outline` and the price drops to `text-linen`
 * rather than stacking a third gold thing on top.
 */
function PlanCard({
  plan,
}: {
  readonly plan: {
    readonly id: string
    readonly name: string
    readonly tagline: string | null
    readonly description: string | null
    readonly priceCents: number
    readonly currency: string
    readonly interval: string
    readonly intervalCount: number
    readonly setupFeeCents: number | null
    readonly trialDays: number | null
    readonly mealsPerWeek: number
    readonly servingsPerMeal: number
    readonly features: readonly string[]
    readonly isFeatured: boolean
  }
}): React.JSX.Element {
  const headingId = `plan-${plan.id}-name`

  return (
    <Card
      as="li"
      variant={plan.isFeatured ? 'accent' : 'default'}
      className="flex h-full flex-col"
      aria-labelledby={headingId}
    >
      <CardHeader className="gap-3">
        {plan.isFeatured ? (
          <Badge variant="outline" className="self-start">
            Most chosen
          </Badge>
        ) : null}

        <CardTitle id={headingId} level={3} className="text-2xl">
          {plan.name}
        </CardTitle>

        {plan.tagline === null ? null : (
          <CardDescription>{plan.tagline}</CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-6">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <Money
            cents={plan.priceCents}
            currency={plan.currency}
            className="text-3xl"
            weight="medium"
            tone={plan.isFeatured ? 'default' : 'accent'}
          />
          <span className="font-sans text-sm text-stone">
            {describeBillingInterval(plan.interval, plan.intervalCount)}
          </span>
        </p>

        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              Each week
            </dt>
            <dd className="mt-1 font-sans text-sm text-linen tabular-nums">
              {`${String(plan.mealsPerWeek)} meal${
                plan.mealsPerWeek === 1 ? '' : 's'
              }`}
            </dd>
          </div>

          <div>
            <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              At the table
            </dt>
            <dd className="mt-1 font-sans text-sm text-linen tabular-nums">
              {`${String(plan.servingsPerMeal)} serving${
                plan.servingsPerMeal === 1 ? '' : 's'
              } a meal`}
            </dd>
          </div>
        </dl>

        {plan.description === null ? null : (
          <p className="font-sans text-sm leading-relaxed text-parchment">
            {plan.description}
          </p>
        )}

        {plan.features.length === 0 ? null : (
          <>
            <Separator variant="hairline" decorative />
            <ul className="flex flex-col gap-1.5">
              {plan.features.map((feature) => (
                <li key={feature} className="font-sans text-sm text-parchment">
                  {feature}
                </li>
              ))}
            </ul>
          </>
        )}

        {plan.setupFeeCents === null && plan.trialDays === null ? null : (
          <p className="mt-auto font-sans text-xs leading-relaxed text-stone">
            {plan.trialDays === null ? null : (
              <>{`The first ${String(plan.trialDays)} days are a trial. `}</>
            )}
            {plan.setupFeeCents === null ? null : (
              <>
                {'A one-off setup of '}
                <Money
                  cents={plan.setupFeeCents}
                  currency={plan.currency}
                  tone="subtle"
                />
                {' covers the first visit and the pantry audit.'}
              </>
            )}
          </p>
        )}
      </CardContent>

      <CardFooter>
        {/*
          Every plan's route in is the consultation, not a checkout. A standing
          arrangement starts with a chef reading the household's questionnaire —
          `createCheckoutSession` is reached from the portal once there is a
          household record to attach a subscription to.
        */}
        <Button
          asChild
          variant={plan.isFeatured ? 'champagne' : 'outline'}
          fullWidth
        >
          <Link href="/consultation">{`Enquire about ${plan.name}`}</Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

export default async function PlansPage(): Promise<React.JSX.Element> {
  const plans = await listSubscriptionPlans({
    pageSize: MAX_PLANS,
    sortBy: 'SORT_ORDER',
    sortDirection: 'asc',
  })

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-16 lg:py-24">
      <header className="flex max-w-2xl flex-col gap-4">
        <p className="font-sans text-xs tracking-[0.24em] text-champagne uppercase">
          Standing arrangements
        </p>
        <h1 className="font-display text-4xl leading-tight font-light text-linen sm:text-5xl">
          Plans
        </h1>
        <p className="font-sans text-base leading-relaxed text-parchment">
          A plan settles two questions once — how many meals arrive each week,
          and how many the table seats — so that neither has to be asked again.
          Everything else stays yours to choose: the dishes each week, the
          window, the chef.
        </p>
        <p className="font-sans text-sm leading-relaxed text-stone">
          Nothing here is a commitment you cannot leave. A plan may be changed,
          rested or closed from your portal, and a household that would rather
          book us evening by evening is welcome to do exactly that instead.
        </p>
      </header>

      <div className="mt-14">
        {!plans.ok ? (
          <EmptyState
            tone="error"
            icon={UtensilsCrossed}
            headingLevel={2}
            title="The plans are not loading just now."
            description={`${plans.error} Rather than show you figures we cannot vouch for, we would sooner you spoke to a chef — the consultation is free and the terms will be quoted to you directly.`}
            action={
              <Button asChild variant="champagne">
                <Link href="/consultation">Request a consultation</Link>
              </Button>
            }
          />
        ) : plans.data.items.length === 0 ? (
          <EmptyState
            icon={UtensilsCrossed}
            headingLevel={2}
            title="The collection is being revised."
            description="No plan is open for enrolment at the moment. This is usually brief — a consultation is the surest way to hear when it reopens, and to be quoted properly in the meantime."
            action={
              <Button asChild variant="champagne">
                <Link href="/consultation">Request a consultation</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {plans.data.items.map((plan) => (
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </ul>
        )}
      </div>

      <Separator variant="hairline" decorative className="mt-16" />

      <section
        aria-labelledby="plans-footnote-heading"
        className="mt-10 flex max-w-2xl flex-col gap-3"
      >
        <h2
          id="plans-footnote-heading"
          className="font-display text-2xl font-light text-linen"
        >
          What the price does not decide
        </h2>
        <p className="font-sans text-sm leading-relaxed text-parchment">
          Allergies, aversions and the shape of your kitchen are read by a chef
          before a single menu is written, and they are not a tier. A household
          on the smallest plan is cooked for as carefully as one on the largest
          — the plan sets the quantity, never the attention.
        </p>
      </section>
    </div>
  )
}
