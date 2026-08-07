// mannachef/apps/web/scripts/fixtures/stripe-recorder.ts

/**
 * A Stripe client that records what it was asked to do instead of doing it.
 *
 * MCV-041 finding C is a claim about **the payload the action builds** —
 * "`proration_behavior` is `create_prorations` on every `CLIENT` upgrade,
 * whatever the caller sent" — so the payload is the thing that has to be read
 * back. Nothing about the claim needs Stripe to answer.
 *
 * ## The seam is `globalThis`, not the module loader
 *
 * The other harnesses in this directory swap modules out at resolution time.
 * This one does not have to. `getStripe()` in `@/server/stripe` memoises its
 * client on `globalThis.mannachefStripe` and returns it **on every call
 * thereafter without looking at `STRIPE_SECRET_KEY`**, so installing a client
 * there before the first action call is enough — and it is a seam the shipped
 * code already has, for its own reasons, rather than one the harness invents.
 *
 * What that buys is that `@/server/stripe` itself stays real:
 * `getOrCreateStripeCustomer`'s three-step lookup, the `mannachefUserId`
 * metadata join, and `STRIPE_CUSTOMER_USER_ID_KEY` are the shipped ones, and the
 * only thing standing in is the HTTP.
 *
 * ## `webhooks` is genuinely Stripe's
 *
 * The recorder *is* a real `Stripe` instance, constructed with a dummy key, with
 * three resource namespaces overwritten. Signature verification therefore runs
 * Stripe's own `constructEvent` against Stripe's own
 * `generateTestHeaderString` — the one property of the webhook route that a
 * hand-written fake would be worthless for.
 */

import Stripe from 'stripe'

import { STRIPE_API_VERSION } from '@/server/stripe'

// =============================================================================
// 1. Synthetic Stripe objects
// =============================================================================

/** The parts of a `Stripe.Subscription` this platform reads back. */
export interface SyntheticSubscriptionSeed {
  readonly id: string
  readonly customerId: string
  readonly itemId: string
  readonly priceId: string
  readonly quantity: number
  readonly currency: string
  readonly status: Stripe.Subscription.Status
  readonly currentPeriodStart: Date
  readonly currentPeriodEnd: Date
}

/**
 * Build the object `subscriptions.retrieve` and `subscriptions.update` answer
 * with.
 *
 * Cast rather than constructed field-by-field: `Stripe.Subscription` carries
 * some seventy properties, `writeStripeSubscription` in `actions/billing.ts`
 * reads twelve of them, and a literal listing the other fifty-eight would be
 * fifty-eight more opportunities to write something Stripe never sends. The
 * twelve that are read are all here, spelled as Stripe spells them.
 */
export function syntheticSubscription(
  seed: SyntheticSubscriptionSeed
): Stripe.Subscription {
  return {
    id: seed.id,
    object: 'subscription',
    customer: seed.customerId,
    currency: seed.currency,
    status: seed.status,
    current_period_start: Math.floor(seed.currentPeriodStart.getTime() / 1000),
    current_period_end: Math.floor(seed.currentPeriodEnd.getTime() / 1000),
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_end: null,
    pause_collection: null,
    metadata: {},
    items: {
      object: 'list',
      has_more: false,
      url: `/v1/subscription_items?subscription=${seed.id}`,
      data: [
        {
          id: seed.itemId,
          object: 'subscription_item',
          quantity: seed.quantity,
          price: { id: seed.priceId, object: 'price' },
          subscription: seed.id,
        },
      ],
    },
  } as unknown as Stripe.Subscription
}

// =============================================================================
// 2. What was recorded
// =============================================================================

export interface RecordedSubscriptionUpdate {
  readonly subscriptionId: string
  readonly params: Stripe.SubscriptionUpdateParams
}

export interface RecordedCheckoutSession {
  readonly params: Stripe.Checkout.SessionCreateParams
}

export interface StripeRecorder {
  /** Every `subscriptions.update` the actions made, in order. */
  readonly subscriptionUpdates: readonly RecordedSubscriptionUpdate[]
  /** Every `checkout.sessions.create` the actions made, in order. */
  readonly checkoutSessions: readonly RecordedCheckoutSession[]
  /** The most recent `subscriptions.update`, or `undefined` when there was none. */
  lastSubscriptionUpdate(): RecordedSubscriptionUpdate | undefined
  /** What `subscriptions.retrieve` answers with from now on. */
  setSubscription(subscription: Stripe.Subscription): void
  /** The subscription as the recorder currently holds it, updates applied. */
  currentSubscription(): Stripe.Subscription
  /** Forget every recorded call. Does not forget the subscription. */
  reset(): void
  /** Sign a payload the way Stripe would, for the webhook route. */
  signPayload(payload: string, secret: string): string
}

// =============================================================================
// 3. Installation
// =============================================================================

interface StripeGlobal {
  mannachefStripe: Stripe | undefined
}

/**
 * The dummy key. `new Stripe(key)` refuses an empty string and makes no network
 * call on construction, so any non-empty string does; this one is shaped like a
 * test key so that a stray log line reads as obviously synthetic. It is not a
 * secret and there is nothing behind it.
 */
const DUMMY_KEY = 'sk_test_mannachef_harness_not_a_real_key'

/**
 * Install the recorder as the process's Stripe client and return the tape.
 *
 * Call it before the first action call. Import order does not matter:
 * `getStripe()` reads the global when it is *called*, not when `@/server/stripe`
 * is imported.
 */
export function installStripeRecorder(): StripeRecorder {
  const client = new Stripe(DUMMY_KEY, { apiVersion: STRIPE_API_VERSION })

  const subscriptionUpdates: RecordedSubscriptionUpdate[] = []
  const checkoutSessions: RecordedCheckoutSession[] = []

  let subscription: Stripe.Subscription | null = null
  let customerSequence = 0
  let sessionSequence = 0

  const held = (): Stripe.Subscription => {
    if (subscription === null) {
      throw new Error(
        'stripe-recorder: no subscription has been staged — call setSubscription first.'
      )
    }

    return subscription
  }

  /**
   * Apply an update to the held subscription the way Stripe would apply the
   * parts of it this platform sends: the first item's price and quantity.
   *
   * Everything else on the object is left alone, which is the honest model —
   * `proration_behavior` produces invoice lines, not subscription fields, and
   * the point of the harness is that the *request* carried the right one.
   */
  const applyUpdate = (
    params: Stripe.SubscriptionUpdateParams
  ): Stripe.Subscription => {
    const current = held()
    const item = params.items?.[0]

    if (item === undefined) {
      return current
    }

    const existing = current.items.data[0]

    if (existing === undefined) {
      return current
    }

    const price =
      typeof item.price === 'string' ? item.price : existing.price.id
    const quantity = item.quantity ?? existing.quantity

    const next = syntheticSubscription({
      id: current.id,
      customerId:
        typeof current.customer === 'string'
          ? current.customer
          : current.customer.id,
      itemId: existing.id,
      priceId: price,
      quantity: quantity ?? 1,
      currency: current.currency,
      status: current.status,
      currentPeriodStart: new Date(current.current_period_start * 1000),
      currentPeriodEnd: new Date(current.current_period_end * 1000),
    })

    subscription = next

    return next
  }

  const overrides = {
    subscriptions: {
      retrieve: async (_id: string): Promise<Stripe.Subscription> => held(),
      update: async (
        id: string,
        params: Stripe.SubscriptionUpdateParams
      ): Promise<Stripe.Subscription> => {
        subscriptionUpdates.push({ subscriptionId: id, params })

        return applyUpdate(params)
      },
      cancel: async (id: string): Promise<Stripe.Subscription> => {
        subscriptionUpdates.push({ subscriptionId: id, params: {} })

        return held()
      },
    },
    customers: {
      list: async (): Promise<{ data: Stripe.Customer[] }> => ({ data: [] }),
      create: async (
        params: Stripe.CustomerCreateParams
      ): Promise<Stripe.Customer> => {
        customerSequence += 1

        return {
          id: `cus_harness${customerSequence.toString().padStart(6, '0')}`,
          object: 'customer',
          email: params.email ?? null,
          metadata: params.metadata ?? {},
          deleted: undefined,
        } as unknown as Stripe.Customer
      },
      retrieve: async (id: string): Promise<Stripe.Customer> =>
        ({
          id,
          object: 'customer',
          email: null,
          metadata: {},
        }) as unknown as Stripe.Customer,
    },
    checkout: {
      sessions: {
        create: async (
          params: Stripe.Checkout.SessionCreateParams
        ): Promise<Stripe.Checkout.Session> => {
          checkoutSessions.push({ params })
          sessionSequence += 1

          const id = `cs_harness${sessionSequence.toString().padStart(6, '0')}`

          return {
            id,
            object: 'checkout.session',
            url: `https://checkout.stripe.test/${id}`,
            metadata: params.metadata ?? {},
            payment_status: 'paid',
          } as unknown as Stripe.Checkout.Session
        },
      },
    },
  }

  // Three namespaces replaced; `webhooks` and everything else stay Stripe's.
  Object.assign(client, overrides)

  const global = globalThis as unknown as StripeGlobal
  global.mannachefStripe = client

  return {
    subscriptionUpdates,
    checkoutSessions,
    lastSubscriptionUpdate: () =>
      subscriptionUpdates[subscriptionUpdates.length - 1],
    setSubscription: (next) => {
      subscription = next
    },
    currentSubscription: () => held(),
    reset: () => {
      subscriptionUpdates.length = 0
      checkoutSessions.length = 0
    },
    signPayload: (payload, secret) =>
      client.webhooks.generateTestHeaderString({ payload, secret }),
  }
}
