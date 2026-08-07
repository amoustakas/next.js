// mannachef/apps/web/scripts/fixtures/harness-state.ts

/**
 * The mutable bits the runtime stubs and the harness share.
 *
 * Kept in its own module so that the stubs — which the loader substitutes for
 * `@/server/auth` and `@/server/db`, and which the harness therefore must never
 * import by path — and the assertions are talking to one instance.
 *
 * The database is registered here by `db-stub.ts` as it loads, because
 * `guards.ts` and the action modules bind `prisma` at import time and cannot be
 * handed one later.
 *
 * ## Two ways to say who is calling
 *
 * {@link signInAs} sets one caller for the whole process, which is all a
 * sequential harness needs and is how `verify-referral-privilege.ts` works.
 * {@link asUser} scopes a caller to one `await` tree instead, which is what a
 * harness driving two actions *concurrently* needs —
 * `verify-superadmin-race.ts` runs two administrators against one database at
 * the same instant, and a single process-wide slot could only ever name one of
 * them. {@link currentUser} prefers the scope when there is one, so the two
 * mechanisms coexist without either harness knowing about the other.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { clearRateLimits } from './database'
import type { FakeDatabase } from './fake-db'

/** The shape `sessionUserSchema` in `@/server/auth` parses to. */
export interface HarnessUser {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  readonly image: string | null
  readonly role: 'SUPER_ADMIN' | 'ADMIN' | 'CHEF_STAFF' | 'CLIENT'
  readonly isActive: true
  readonly timeZone: string
  readonly locale: string
  readonly clientProfileId: string | null
  readonly staffProfileId: string | null
}

interface HarnessState {
  user: HarnessUser | null
  database: FakeDatabase | null
}

const state: HarnessState = { user: null, database: null }

/**
 * The caller for one `await` tree, when {@link asUser} has established one.
 *
 * `undefined` — the store being absent entirely — is distinct from a stored
 * `null`, which is a deliberately signed-out scoped caller.
 */
const scopedUser = new AsyncLocalStorage<HarnessUser | null>()

/** Who the next action call runs as, process-wide. `null` is signed out. */
export function signInAs(user: HarnessUser | null): void {
  state.user = user
}

/**
 * Run `body` with `user` as the caller, for that call tree only.
 *
 * Concurrent invocations do not see each other's caller, which is the whole
 * point: two administrators acting simultaneously are two sessions, and a
 * harness that had to funnel them through one process-wide slot would be
 * testing something the application never does.
 */
export function asUser<T>(
  user: HarnessUser | null,
  body: () => Promise<T>
): Promise<T> {
  return scopedUser.run(user, body)
}

export function currentUser(): HarnessUser | null {
  const scoped = scopedUser.getStore()

  return scoped === undefined ? state.user : scoped
}

export function registerDatabase(database: FakeDatabase): void {
  state.database = database
}

export function harnessDatabase(): FakeDatabase {
  if (state.database === null) {
    throw new Error(
      'harness: the @/server/db stub has not loaded — is the resolver installed?'
    )
  }

  return state.database
}

/**
 * Empty every table and forget every recorded query, in place.
 *
 * The token buckets go with them, as they do in `intake-harness.ts` and
 * `billing-harness.ts`. They are process-global state an action's outcome
 * depends on, so a scenario inheriting the previous scenario's spent quota is
 * the same class of bug as one inheriting its rows. `referral.code.create` is
 * limited to five an hour per identity since MCV-043 and this harness mints
 * more than that as one attacker; without this line the later scenarios would
 * report `RATE_LIMITED` and prove nothing about privilege.
 */
export function resetDatabase(): void {
  const { store, calls } = harnessDatabase()

  store.users.length = 0
  store.referralPrograms.length = 0
  store.referralCodes.length = 0
  store.referralRedemptions.length = 0
  store.invoices.length = 0
  calls.length = 0

  clearRateLimits()
}
