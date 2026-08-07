// mannachef/apps/web/src/server/stripe.ts

/**
 * The Stripe client singleton, plus customer resolution.
 *
 * ## Why the key is read lazily
 *
 * `new Stripe(key)` throws when `key` is empty. If that call sat at module
 * scope, importing this file anywhere — a route handler, a server action, a
 * type-only import that the bundler decided to keep — would crash a build or a
 * preview deployment that has no `STRIPE_SECRET_KEY`. Billing is one slice of
 * this platform; the marketing site and the menu must build without it.
 *
 * So the constructor runs on first use inside {@link getStripe}, the instance
 * is memoised on `globalThis` (the dev server re-evaluates modules on every
 * HMR pass and we do not want a new HTTP agent each time), and callers that can
 * degrade gracefully ask {@link isStripeConfigured} first.
 *
 * ## Never log
 *
 * `CONTRACT.md` §5: no secrets, no full card data, no raw webhook payloads.
 * Nothing in this file logs a key, and `getOrCreateStripeCustomer` logs only
 * ids.
 */

import Stripe from 'stripe'

import { prisma } from '@/server/db'

// =============================================================================
// 1. The client
// =============================================================================

/**
 * Pinned API version.
 *
 * Stripe's SDK types are generated against exactly one version, so this must
 * stay equal to `Stripe.LatestApiVersion` for the installed `stripe` package —
 * TypeScript enforces that, because `apiVersion` is typed as that literal. When
 * the SDK is upgraded this line moves with it, deliberately and in one place,
 * rather than the account's dashboard default silently changing the shape of
 * every webhook the platform receives.
 */
export const STRIPE_API_VERSION = '2025-02-24.acacia' as const

/**
 * How the platform identifies itself in Stripe's request logs. Makes it
 * possible to tell MannaChef traffic apart from anything else on the account.
 */
const STRIPE_APP_INFO: Stripe.AppInfo = {
  name: 'MannaChef Platform',
  version: '0.1.0',
}

const globalForStripe = globalThis as unknown as {
  mannachefStripe: Stripe | undefined
}

/** `true` when `STRIPE_SECRET_KEY` is present and non-empty. */
export function isStripeConfigured(): boolean {
  return readStripeSecretKey() !== undefined
}

function readStripeSecretKey(): string | undefined {
  const raw = process.env['STRIPE_SECRET_KEY']

  if (raw === undefined) {
    return undefined
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The memoised Stripe client.
 *
 * Throws when `STRIPE_SECRET_KEY` is missing. That is the correct behaviour for
 * a *call* — a billing action with no key configured is a deployment fault, not
 * a user error — and it is safe because the throw happens at call time rather
 * than at import time. Server actions run inside `withAction`, which turns any
 * throw into a generic `INTERNAL` failure and logs the real cause, so the key's
 * absence never reaches a guest.
 */
export function getStripe(): Stripe {
  const existing = globalForStripe.mannachefStripe

  if (existing !== undefined) {
    return existing
  }

  const secretKey = readStripeSecretKey()

  if (secretKey === undefined) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured. Billing features are unavailable in this environment.'
    )
  }

  const client = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: STRIPE_APP_INFO,
    typescript: true,
    // Two retries with Stripe's own idempotency handling. Anything that mutates
    // money must additionally pass its own `idempotencyKey`.
    maxNetworkRetries: 2,
  })

  globalForStripe.mannachefStripe = client

  return client
}

// =============================================================================
// 2. Customer resolution
// =============================================================================

/**
 * The metadata key under which a Stripe customer records which MannaChef user
 * it belongs to. This is the join key described in
 * {@link getOrCreateStripeCustomer}.
 */
export const STRIPE_CUSTOMER_USER_ID_KEY = 'mannachefUserId'

/** What {@link getOrCreateStripeCustomer} resolved, and how. */
export interface StripeCustomerResolution {
  readonly customerId: string
  /**
   * Where the id came from:
   *
   *  - `subscription` — the local `UserSubscription.stripeCustomerId` column;
   *  - `stripe` — an existing customer found on the Stripe account;
   *  - `created` — no customer existed, so one was created.
   */
  readonly source: 'subscription' | 'stripe' | 'created'
}

/**
 * Resolve — creating if necessary — the Stripe customer for a MannaChef user.
 *
 * ## The problem the schema poses
 *
 * `stripeCustomerId` lives on `UserSubscription`, not on `User`
 * (`packages/db/prisma/schema.prisma`, model `UserSubscription`), and it is a
 * **non-null** column on that model. That is the right normalisation for a
 * subscriber — the id is a property of the billing relationship — but it means
 * there is nowhere in the database to put the customer id for a client who has
 * *never subscribed*. And that is precisely the client this function exists to
 * serve: you need a customer before you can open a Checkout session, and you
 * open a Checkout session before there is any subscription.
 *
 * Adding a nullable `User.stripeCustomerId` would solve it, but it would also
 * fork the source of truth: two columns that must agree, and a migration.
 * Instead:
 *
 * ## The approach
 *
 * **Stripe itself is the system of record before the first subscription
 * exists**, and the join is `metadata.mannachefUserId` on the customer object.
 * The lookup is three steps, cheapest first:
 *
 *  1. **Local.** The newest `UserSubscription` for the user. Any subscriber —
 *     including a churned one — resolves here, with one indexed query and no
 *     network call. This is the steady-state path.
 *  2. **Stripe, by email.** For a user with no subscription row, list customers
 *     with that email address and take the one whose
 *     `metadata.mannachefUserId` matches. Listing (rather than
 *     `customers.search`) is used because it is strongly consistent: a customer
 *     created seconds ago is visible immediately, whereas the search index lags
 *     by up to a minute and would happily mint a duplicate in the meantime.
 *     Two users may legitimately share an email across environments, hence the
 *     metadata match rather than trusting the email alone.
 *  3. **Stripe, by metadata.** A user with no email on file — the schema allows
 *     `User.email` to be null — cannot be found by step 2, so
 *     `customers.search` is used instead. Its lag is accepted here because the
 *     case is rare and the alternative is no lookup at all; the search is
 *     wrapped so that an index miss degrades to "create" rather than throwing.
 *
 * If none of the three finds a customer, one is created carrying the metadata
 * that makes step 2 and step 3 work next time. Once the first subscription is
 * written, step 1 takes over permanently.
 *
 * @throws when `STRIPE_SECRET_KEY` is missing, when the user does not exist, or
 * when Stripe rejects the call. `withAction` converts all three into a generic
 * `INTERNAL` failure with the real cause logged server-side.
 */
export async function getOrCreateStripeCustomer(
  userId: string
): Promise<StripeCustomerResolution> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, isActive: true },
  })

  if (user === null) {
    throw new Error(`No user with id ${userId}`)
  }

  if (!user.isActive) {
    throw new Error(`Refusing to bill deactivated user ${userId}`)
  }

  // --- 1. Local: the newest subscription already knows the customer ---------
  const existingSubscription = await prisma.userSubscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { stripeCustomerId: true },
  })

  if (
    existingSubscription !== null &&
    existingSubscription.stripeCustomerId.length > 0
  ) {
    return {
      customerId: existingSubscription.stripeCustomerId,
      source: 'subscription',
    }
  }

  const stripe = getStripe()

  // --- 2. Stripe, by email (strongly consistent) ----------------------------
  if (user.email !== null && user.email.length > 0) {
    const byEmail = await stripe.customers.list({
      email: user.email,
      limit: 100,
    })

    const matched = byEmail.data.find(
      (candidate) => candidate.metadata[STRIPE_CUSTOMER_USER_ID_KEY] === user.id
    )

    if (matched !== undefined) {
      return { customerId: matched.id, source: 'stripe' }
    }
  }

  // --- 3. Stripe, by metadata (eventually consistent) -----------------------
  else {
    const found = await findCustomerByMetadata(stripe, user.id)

    if (found !== null) {
      return { customerId: found, source: 'stripe' }
    }
  }

  // --- 4. Create ------------------------------------------------------------
  const created = await stripe.customers.create(
    {
      // `email` is optional on Stripe's side; omit rather than send null so the
      // customer record simply has no email instead of an empty one.
      ...(user.email !== null && user.email.length > 0
        ? { email: user.email }
        : {}),
      ...(user.name !== null && user.name.length > 0
        ? { name: user.name }
        : {}),
      metadata: { [STRIPE_CUSTOMER_USER_ID_KEY]: user.id },
    },
    {
      // Two concurrent checkouts for the same brand-new client must not create
      // two customers. Stripe replays the first response for 24 hours.
      idempotencyKey: `mannachef-customer-${user.id}`,
    }
  )

  return { customerId: created.id, source: 'created' }
}

/**
 * Search Stripe for a customer carrying this user's id in metadata.
 *
 * Returns `null` both when there is genuinely no such customer and when the
 * search index is unavailable or has not caught up. The caller treats both the
 * same way — create — which is safe because creation is idempotency-keyed on
 * the user id, so a lagging index costs a replayed response rather than a
 * duplicate customer.
 */
async function findCustomerByMetadata(
  stripe: Stripe,
  userId: string
): Promise<string | null> {
  // The query language is quoted-string based; a value containing a quote or a
  // backslash would break out of the literal. Prisma ids are cuids, so this can
  // only fire if an id ever arrives from somewhere it should not have.
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    return null
  }

  try {
    const results = await stripe.customers.search({
      query: `metadata['${STRIPE_CUSTOMER_USER_ID_KEY}']:'${userId}'`,
      limit: 1,
    })

    return results.data[0]?.id ?? null
  } catch (error) {
    console.error('[stripe] customer metadata search failed', {
      userId,
      // Stripe error text never reaches the client; this is the server log.
      error: error instanceof Error ? error.message : 'unknown',
    })

    return null
  }
}
