// mannachef/apps/web/src/components/portal/subscription-state.ts

/**
 * The two questions both the overview and the subscription page ask about a
 * page of subscriptions, answered once.
 *
 * `listSubscriptions` returns every subscription the caller has ever held,
 * newest first, and a household that cancelled once and rejoined has two rows
 * of which only one matters. {@link pickCurrentSubscription} is the rule for
 * which one that is, written down in a single place so the overview card and
 * the subscription page can never disagree about which subscription a guest is
 * looking at.
 *
 * No `'use client'`, no React: this is data, used from Server Components.
 */

import type { SubscriptionStatus } from '@mannachef/validators'

/**
 * The statuses that describe a subscription which is still ours to manage.
 *
 * `PAUSED` is here because a resting subscription is one you can resume;
 * `INCOMPLETE` because a first payment Stripe has not taken yet is a
 * subscription with something to do about it. `CANCELED`, `UNPAID` and
 * `INCOMPLETE_EXPIRED` are over, and a page that offered a Pause button on one
 * of them would be offering a refusal.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'INCOMPLETE',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAUSED',
]

/** True when a subscription can still be paused, resumed, or cancelled. */
export function isLiveSubscription(status: SubscriptionStatus): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.includes(status)
}

/**
 * The subscription a household is actually on.
 *
 * The first live one in the list, or — when every one of them has ended — the
 * most recent, so the page can say "this is what you had" rather than showing
 * nothing to somebody who plainly used to be a subscriber.
 *
 * Generic over the row so it works against whatever projection the caller has,
 * as long as it carries a status.
 */
export function pickCurrentSubscription<
  TRow extends { readonly status: SubscriptionStatus },
>(rows: readonly TRow[]): TRow | null {
  for (const row of rows) {
    if (isLiveSubscription(row.status)) {
      return row
    }
  }

  return rows[0] ?? null
}

/**
 * "a month", "every 3 months" — the renewal cadence as a person would say it.
 *
 * `intervalCount` of 1 is the overwhelming case and reads badly as "every 1
 * month", so it gets the article instead.
 */
export function describeBillingInterval(
  interval: string,
  intervalCount: number
): string {
  const unit = interval.toLowerCase()

  if (intervalCount === 1) {
    return `a ${unit}`
  }

  return `every ${String(intervalCount)} ${unit}s`
}
