// mannachef/apps/web/src/app/(portal)/portal/menu-selection/page.tsx

/**
 * Composing this week's menu: the dishes a subscriber picks, within the number
 * their plan pays for.
 *
 * A **Server Component**. Both reads happen here — the plan, which sets the
 * allowance, and the dish catalogue it is spent on — so the board mounts with
 * its dishes and its count already in place. The only client boundary is
 * `<MenuSelectionBoard>`, which needs one: choosing is local state, and the
 * count has to answer on every tap.
 *
 * ## Where the allowance comes from
 *
 * `mealsPerWeek` on the household's own `SubscriptionPlan`, read through
 * `listSubscriptions` — never a constant here. `pickCurrentSubscription` is the
 * same helper `/portal/subscription` uses, so both pages agree on which
 * subscription is "the" one when a household has more than one row.
 *
 * A household with no live plan is not shown a board with an invented number on
 * it. There is no allowance to spend, so the page says so and points at the
 * plans instead.
 *
 * ## What this page does not do
 *
 * It does not persist the selection, and it does not pretend to. There is no
 * model for a weekly menu choice in the schema — no table, and so no action in
 * `ACTIONS-INDEX.md` to call — and inventing a Save button that wrote nowhere
 * would be a worse failure than the missing feature: the household would
 * believe the kitchen had been told.
 *
 * So the board is honest about its own boundary. It composes the week and
 * enforces the allowance, and hands the result to the place where dishes really
 * do attach to a service — the engagement itself, via `AppointmentMenuItem`,
 * which is booked from `/portal/appointments`. When a `menuSelection.*` action
 * exists, the board's `onConfirm` is the one place that has to change.
 */

import type * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CreditCard, UtensilsCrossed } from 'lucide-react'

import { ActionError } from '@/components/portal/action-error'
import { MenuSelectionBoard } from '@/components/portal/menu-selection-board'
import { pickCurrentSubscription } from '@/components/portal/subscription-state'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { listSubscriptions } from '@/server/actions/billing'
import { listMenuItems } from '@/server/actions/menu'

export const metadata: Metadata = {
  title: 'This week’s menu',
}

/**
 * How much of the catalogue the board holds.
 *
 * The whole active catalogue, in practice — a subscriber choosing four dishes
 * from a list wants to see the list, not page through it. `listMenuItems` pins
 * `isActive` for callers below `ADMIN`, so a withdrawn dish cannot appear.
 */
const CATALOGUE_PAGE_SIZE = 60

export default async function PortalMenuSelectionPage(): Promise<React.JSX.Element> {
  const [subscriptions, dishes] = await Promise.all([
    listSubscriptions({ pageSize: 10 }),
    listMenuItems({
      pageSize: CATALOGUE_PAGE_SIZE,
      // The house's own arrangement of the catalogue, which is what a guest
      // should meet first — not alphabetical, and not cheapest-first.
      sortBy: 'CURATED',
      sortDirection: 'asc',
    }),
  ])

  const header = (
    <header className="flex flex-col gap-2">
      <h2 className="font-display text-3xl leading-tight font-light text-linen">
        This week&rsquo;s menu
      </h2>
      <p className="font-sans text-sm leading-relaxed text-parchment">
        Choose the dishes you would like cooked, and we will bring them to your
        next engagement.
      </p>
    </header>
  )

  if (!subscriptions.ok) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ActionError
          code={subscriptions.code}
          error={subscriptions.error}
          subject="your plan"
          headingLevel={3}
        />
      </div>
    )
  }

  const subscription = pickCurrentSubscription(subscriptions.data.items)

  // No plan means no allowance, and an allowance is the whole premise of this
  // page. Guessing one would be inventing terms the household never bought.
  if (subscription === null) {
    return (
      <div className="flex flex-col gap-8">
        {header}

        <EmptyState
          icon={CreditCard}
          headingLevel={3}
          title="You are not on a plan."
          description="A plan is what sets how many dishes we cook for you each week, so there is no weekly allowance to spend yet. If you would rather book us evening by evening, that is perfectly possible — the dishes are chosen when you book."
          action={
            <Button asChild variant="champagne">
              <Link href="/plans">See the plans</Link>
            </Button>
          }
          secondaryAction={
            <Button asChild variant="ghost">
              <Link href="/portal/appointments">Book a single engagement</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (!dishes.ok) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ActionError
          code={dishes.code}
          error={dishes.error}
          subject="the dishes"
          headingLevel={3}
        />
      </div>
    )
  }

  if (dishes.data.items.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        {header}

        <EmptyState
          icon={UtensilsCrossed}
          headingLevel={3}
          title="The catalogue is between seasons."
          description="No dish is on the list at the moment. This is usually brief — your chef will be in touch with the new season's menu, and your plan is unaffected in the meantime."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {header}

      <MenuSelectionBoard
        planName={subscription.plan.name}
        mealsPerWeek={subscription.plan.mealsPerWeek}
        servingsPerMeal={subscription.plan.servingsPerMeal}
        dishes={dishes.data.items.map((dish) => ({
          id: dish.id,
          slug: dish.slug,
          name: dish.name,
          description: dish.description,
          categoryName: dish.categoryName,
          basePriceCents: dish.basePriceCents,
          currency: dish.currency,
          spiceLevel: dish.spiceLevel,
          isSeasonal: dish.isSeasonal,
          isSignature: dish.isSignature,
        }))}
      />
    </div>
  )
}
