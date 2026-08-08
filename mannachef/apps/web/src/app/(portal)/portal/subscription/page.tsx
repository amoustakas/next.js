// mannachef/apps/web/src/app/(portal)/portal/subscription/page.tsx

/**
 * The plan a household is on, and the four things they may do to it.
 *
 * A **Server Component**. Both reads run here; the only client code is
 * `<SubscriptionControls>`, which is four forms and therefore genuinely
 * interactive.
 *
 * ## The terms are stated, not offered
 *
 * `changeSubscription` discards `prorationBehavior`, `effectiveAt` and
 * `quantity` for every caller below `ADMIN` and substitutes the house's own
 * terms. This page therefore *describes* those terms in prose and offers no
 * control over any of them — see the docblock on `<SubscriptionControls>` for
 * why a switch that flips nothing is worse than no switch.
 *
 * ## Why the plan list is read here
 *
 * `listSubscriptionPlans` is `auth: 'PUBLIC'` and pins `isActive` to `true` for
 * anybody below `ADMIN`, so what comes back is exactly the ladder a subscriber
 * may move to. Reading it on the server means the change-plan dialog opens with
 * its options already in it, and a household that has no other plan available
 * never sees the button at all.
 */

import type * as React from 'react'
import Link from 'next/link'
import { CreditCard } from 'lucide-react'

import { ActionError } from '@/components/portal/action-error'
import { SubscriptionStatusBadge } from '@/components/portal/status-badges'
import {
  SubscriptionControls,
  type PlanOption,
} from '@/components/portal/subscription-controls'
import {
  describeBillingInterval,
  isLiveSubscription,
  pickCurrentSubscription,
} from '@/components/portal/subscription-state'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import {
  listSubscriptionPlans,
  listSubscriptions,
} from '@/server/actions/billing'

export const metadata = {
  title: 'Subscription',
}

export default async function PortalSubscriptionPage(): Promise<React.JSX.Element> {
  const [subscriptions, plans] = await Promise.all([
    listSubscriptions({ pageSize: 10 }),
    listSubscriptionPlans({
      pageSize: 25,
      sortBy: 'PRICE',
      sortDirection: 'asc',
    }),
  ])

  if (!subscriptions.ok) {
    return (
      <ActionError
        code={subscriptions.code}
        error={subscriptions.error}
        subject="your subscription"
        headingLevel={2}
      />
    )
  }

  const subscription = pickCurrentSubscription(subscriptions.data.items)

  if (subscription === null) {
    return (
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h2 className="font-display text-3xl leading-tight font-light text-linen">
            Subscription
          </h2>
        </header>

        <EmptyState
          icon={CreditCard}
          title="You are not on a plan."
          description="A plan sets how many meals we cook for you each week and what they cost. If you would rather book us evening by evening, that is perfectly possible too — nothing here is required."
          action={
            <Button asChild variant="champagne">
              <Link href="/plans">See the plans</Link>
            </Button>
          }
          secondaryAction={
            /*
             * This said "Book a single engagement" while pointing at
             * `/portal/menu-selection`, which is the weekly menu composer, not
             * the diary. Booking an engagement is `/portal/appointments`, so
             * the label now matches where it goes — the other three
             * `menu-selection` links in the portal really do mean the composer
             * and were left pointing at it.
             */
            <Button asChild variant="ghost">
              <Link href="/portal/appointments">Book a single engagement</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const planOptions: readonly PlanOption[] = plans.ok
    ? plans.data.items
        .filter(
          (plan) =>
            plan.id !== subscription.planId &&
            plan.currency === subscription.plan.currency
        )
        .map((plan) => ({
          id: plan.id,
          name: plan.name,
          priceCents: plan.priceCents,
          currency: plan.currency,
          mealsPerWeek: plan.mealsPerWeek,
          servingsPerMeal: plan.servingsPerMeal,
        }))
    : []

  const live = isLiveSubscription(subscription.status)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-3xl leading-tight font-light text-linen">
          Subscription
        </h2>
        <p className="font-sans text-sm leading-relaxed text-parchment">
          Your plan, when it renews, and how to change or rest it.
        </p>
      </header>

      <Card as="article" variant="elevated">
        <CardHeader>
          <CardDescription>Your plan</CardDescription>
          <CardTitle level={3} className="text-3xl">
            {subscription.plan.name}
          </CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <SubscriptionStatusBadge status={subscription.status} />
            {subscription.cancelAtPeriodEnd ? (
              <span className="font-sans text-xs text-terracotta-ink">
                Closing at the end of this period
              </span>
            ) : null}
          </div>

          {subscription.plan.tagline === null ? null : (
            <p className="font-sans text-sm leading-relaxed text-parchment">
              {subscription.plan.tagline}
            </p>
          )}

          <dl className="grid gap-5 sm:grid-cols-2">
            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                Price
              </dt>
              <dd className="mt-1 font-sans text-sm text-linen">
                <Money
                  cents={subscription.plan.priceCents}
                  currency={subscription.currency}
                  weight="medium"
                  tone="accent"
                />
                <span className="text-stone">
                  {` · ${describeBillingInterval(
                    subscription.plan.interval,
                    subscription.plan.intervalCount
                  )}`}
                </span>
              </dd>
            </div>

            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                What it includes
              </dt>
              <dd className="mt-1 font-sans text-sm text-parchment">
                {`${String(subscription.plan.mealsPerWeek)} meals a week, ${String(
                  subscription.plan.servingsPerMeal
                )} servings each`}
              </dd>
            </div>

            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                This period
              </dt>
              <dd className="mt-1 font-sans text-sm text-parchment">
                <DateTime value={subscription.currentPeriodStart} /> —{' '}
                <DateTime value={subscription.currentPeriodEnd} />
              </dd>
            </div>

            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                {subscription.status === 'PAUSED' ? 'Resting until' : 'Renews'}
              </dt>
              <dd className="mt-1 font-sans text-sm text-parchment">
                {subscription.status === 'PAUSED' ? (
                  subscription.pausedUntil === null ? (
                    'Until you resume it'
                  ) : (
                    <DateTime value={subscription.pausedUntil} />
                  )
                ) : subscription.cancelAtPeriodEnd ? (
                  'It will not renew'
                ) : (
                  <DateTime value={subscription.currentPeriodEnd} />
                )}
              </dd>
            </div>
          </dl>

          {subscription.trialEndsAt === null ? null : (
            <p className="font-sans text-xs text-stone">
              Your trial runs to <DateTime value={subscription.trialEndsAt} />.
            </p>
          )}

          {subscription.plan.features.length === 0 ? null : (
            <>
              <Separator variant="hairline" decorative />
              <ul className="flex flex-col gap-1.5">
                {subscription.plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="font-sans text-sm text-parchment"
                  >
                    {feature}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {live ? (
        <section
          aria-labelledby="subscription-changes-heading"
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <h3
              id="subscription-changes-heading"
              className="font-display text-2xl font-light text-linen"
            >
              Changing your plan
            </h3>
            <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
              A step up takes effect at once, and the difference for the rest of
              this period is charged. A step down waits for the end of the
              period you have already paid for, so nothing you have bought is
              taken away early. Those terms are the house&rsquo;s and are the
              same for everybody — there is nothing here to choose, only to
              know.
            </p>
          </div>

          <SubscriptionControls
            subscriptionId={subscription.id}
            status={subscription.status}
            currentPlanId={subscription.planId}
            currentPlanPriceCents={subscription.plan.priceCents}
            cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
            planOptions={planOptions}
          />

          <p className="font-sans text-xs leading-relaxed text-stone">
            Your card and your billing address are held by our payment
            processor, not by us. To change either, open any invoice and use the
            payment page it links to.
          </p>
        </section>
      ) : (
        <p className="font-sans text-sm leading-relaxed text-parchment">
          This subscription has ended, so there is nothing left to change on it.
          Starting again is a matter of choosing a plan — the concierge will be
          glad to help.
        </p>
      )}
    </div>
  )
}
