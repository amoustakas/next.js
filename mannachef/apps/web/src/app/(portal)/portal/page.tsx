// mannachef/apps/web/src/app/(portal)/portal/page.tsx

/**
 * The portal overview: the next appointment, the state of the subscription, and
 * what the reward balance stands at.
 *
 * A **Server Component**, and it has no client boundary at all. Everything on
 * this page is read once on the server and rendered as HTML; the only
 * interactive elements are links, which need no JavaScript. That is the default
 * this codebase works to, and a dashboard that merely reports is exactly the
 * case it was chosen for.
 *
 * The reads are issued together rather than in sequence. They are
 * independent — different tables, different actions — so awaiting them one
 * after another would make the page as slow as their sum for no reason.
 *
 * Each read is allowed to fail on its own. A rate-limited referral read must
 * not blank out the appointment that a household is trying to check the time
 * of, so every section renders either its data or its own named failure.
 *
 * The pending-referral-claim read is the exception: it has no section of its
 * own, no `ActionError` panel, and renders nothing at all on failure or on
 * "no claim standing" alike. See `ReferralClaimBanner` for why an optional
 * consent prompt is allowed to fail quietly where the sections above it are
 * not.
 */

import type * as React from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarDays, CreditCard, Gift } from 'lucide-react'

import { ActionError } from '@/components/portal/action-error'
import { ReferralClaimBanner } from '@/components/portal/referral-claim-banner'
import {
  AppointmentStatusBadge,
  SubscriptionStatusBadge,
} from '@/components/portal/status-badges'
import {
  describeBillingInterval,
  pickCurrentSubscription,
} from '@/components/portal/subscription-state'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime, DateTimeRange } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { listAppointments } from '@/server/actions/booking'
import { listSubscriptions } from '@/server/actions/billing'
import { readReferralOverview } from '@/server/actions/referral'
import { readPendingReferralClaim } from '@/server/actions/referral-claim'

export const metadata = {
  title: 'Overview',
}

export default async function PortalOverviewPage(): Promise<React.JSX.Element> {
  const now = new Date()

  const [appointments, subscriptions, referrals, pendingReferralClaim] =
    await Promise.all([
      listAppointments({ startsFrom: now, sortDirection: 'asc', pageSize: 3 }),
      listSubscriptions({ pageSize: 5 }),
      readReferralOverview({ pageSize: 1 }),
      readPendingReferralClaim({}),
    ])

  const upcoming = appointments.ok ? appointments.data.items : []
  const nextAppointment = upcoming[0] ?? null
  const subscription = subscriptions.ok
    ? pickCurrentSubscription(subscriptions.data.items)
    : null
  const pendingClaim = pendingReferralClaim.ok
    ? pendingReferralClaim.data
    : null

  return (
    <div className="flex flex-col gap-10">
      <ReferralClaimBanner claim={pendingClaim} />

      {/* ---- The next appointment ------------------------------------- */}
      <section aria-labelledby="next-appointment-heading">
        <Card variant="elevated" as="article">
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <CalendarDays aria-hidden="true" className="size-4" />
              Your next engagement
            </CardDescription>
            <CardTitle id="next-appointment-heading" level={2}>
              {nextAppointment === null
                ? 'Nothing in the diary'
                : 'A chef is coming'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            {!appointments.ok ? (
              <ActionError
                code={appointments.code}
                error={appointments.error}
                subject="your engagements"
              />
            ) : nextAppointment === null ? (
              <EmptyState
                size="sm"
                icon={CalendarDays}
                title="No engagement is booked."
                description="Choose this week's dishes and a window that suits you, and we will send it to the kitchen."
                action={
                  <Button asChild variant="champagne">
                    <Link href="/portal/menu-selection">
                      Compose this week&rsquo;s menu
                    </Link>
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="font-sans text-lg text-linen">
                    <DateTimeRange
                      start={nextAppointment.startsAt}
                      end={nextAppointment.endsAt}
                    />
                  </p>
                  <AppointmentStatusBadge status={nextAppointment.status} />
                </div>

                <dl className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      Chef
                    </dt>
                    <dd className="mt-1 font-sans text-sm text-parchment">
                      {nextAppointment.staffName ?? 'To be assigned'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      At the table
                    </dt>
                    <dd className="mt-1 font-sans text-sm text-parchment tabular-nums">
                      {String(nextAppointment.guestCount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      Dishes chosen
                    </dt>
                    <dd className="mt-1 font-sans text-sm text-parchment tabular-nums">
                      {String(nextAppointment.menuItems.length)}
                    </dd>
                  </div>
                </dl>

                {nextAppointment.menuItems.length === 0 ? null : (
                  <>
                    <Separator variant="hairline" decorative />
                    <ul className="flex flex-col gap-1.5">
                      {nextAppointment.menuItems.map((dish) => (
                        <li
                          key={dish.id}
                          className="font-sans text-sm text-parchment"
                        >
                          {dish.name}
                          {dish.quantity > 1 ? (
                            <span className="text-stone tabular-nums">
                              {` × ${String(dish.quantity)}`}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {upcoming.length > 1 ? (
                  <p className="font-sans text-xs text-stone">
                    {`${String(upcoming.length - 1)} more ${
                      upcoming.length === 2 ? 'engagement is' : 'engagements are'
                    } in the diary after this one.`}
                  </p>
                ) : null}
              </div>
            )}
          </CardContent>

          <CardFooter>
            <Button asChild variant="ghost">
              <Link href="/portal/appointments">
                All appointments
                <ArrowRight aria-hidden="true" className="ml-2 size-4" />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* ---- Subscription -------------------------------------------- */}
        <section aria-labelledby="subscription-heading">
          <Card as="article" className="h-full">
            <CardHeader>
              <CardDescription className="flex items-center gap-2">
                <CreditCard aria-hidden="true" className="size-4" />
                Your plan
              </CardDescription>
              <CardTitle id="subscription-heading" level={2}>
                {subscription === null ? 'No plan yet' : subscription.plan.name}
              </CardTitle>
            </CardHeader>

            <CardContent>
              {!subscriptions.ok ? (
                <ActionError
                  code={subscriptions.code}
                  error={subscriptions.error}
                  subject="your subscription"
                />
              ) : subscription === null ? (
                <EmptyState
                  size="sm"
                  icon={CreditCard}
                  title="You are not on a plan."
                  description="A plan sets how many dishes we cook for you each week and what they cost. You can also book us engagement by engagement."
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <SubscriptionStatusBadge status={subscription.status} />
                    {subscription.cancelAtPeriodEnd ? (
                      <span className="font-sans text-xs text-terracotta">
                        Closing at the end of this period
                      </span>
                    ) : null}
                  </div>

                  <p className="font-sans text-sm text-parchment">
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
                  </p>

                  <p className="font-sans text-sm text-parchment">
                    {`${String(subscription.plan.mealsPerWeek)} meals a week, ${String(
                      subscription.plan.servingsPerMeal
                    )} servings each.`}
                  </p>

                  <p className="font-sans text-xs text-stone">
                    {subscription.status === 'PAUSED' &&
                    subscription.pausedUntil !== null ? (
                      <>
                        Resting until{' '}
                        <DateTime value={subscription.pausedUntil} />.
                      </>
                    ) : (
                      <>
                        This period runs to{' '}
                        <DateTime value={subscription.currentPeriodEnd} />.
                      </>
                    )}
                  </p>
                </div>
              )}
            </CardContent>

            <CardFooter>
              <Button asChild variant="ghost">
                <Link href="/portal/subscription">
                  Manage your plan
                  <ArrowRight aria-hidden="true" className="ml-2 size-4" />
                </Link>
              </Button>
            </CardFooter>
          </Card>
        </section>

        {/* ---- Rewards -------------------------------------------------- */}
        <section aria-labelledby="rewards-heading">
          <Card as="article" className="h-full">
            <CardHeader>
              <CardDescription className="flex items-center gap-2">
                <Gift aria-hidden="true" className="size-4" />
                Your rewards
              </CardDescription>
              <CardTitle id="rewards-heading" level={2}>
                Referral balance
              </CardTitle>
            </CardHeader>

            <CardContent>
              {!referrals.ok ? (
                <ActionError
                  code={referrals.code}
                  error={referrals.error}
                  subject="your rewards"
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <p className="font-display text-4xl font-light">
                    <Money
                      cents={referrals.data.balance.balanceCents}
                      currency={referrals.data.balance.currency}
                      tone="accent"
                    />
                  </p>

                  <dl className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="font-sans text-xs text-stone">
                        Earned in all
                      </dt>
                      <dd className="font-sans text-sm text-parchment">
                        <Money
                          cents={referrals.data.balance.lifetimeEarnedCents}
                          currency={referrals.data.balance.currency}
                        />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="font-sans text-xs text-stone">
                        Invitations still to qualify
                      </dt>
                      <dd className="font-sans text-sm text-parchment tabular-nums">
                        {String(referrals.data.pendingRedemptions)}
                      </dd>
                    </div>
                  </dl>

                  <p className="font-sans text-xs leading-relaxed text-stone">
                    A reward is credited once the household you invited has
                    actually dined with us and settled a bill — not when they
                    sign up.
                  </p>
                </div>
              )}
            </CardContent>

            <CardFooter>
              <Button asChild variant="ghost">
                <Link href="/portal/referrals">
                  Your invitation code
                  <ArrowRight aria-hidden="true" className="ml-2 size-4" />
                </Link>
              </Button>
            </CardFooter>
          </Card>
        </section>
      </div>
    </div>
  )
}
