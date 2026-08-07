// mannachef/apps/web/scripts/fixtures/auth-stub.ts

/**
 * Stands in for `@/server/auth` at runtime.
 *
 * The real module reaches Auth.js, which reaches a database and a set of
 * providers; none of that is what the referral privilege regression is about.
 * What the actions actually consume from it is one function, so that is what
 * this exports. `guards.ts` also imports `AuthenticatedUser` from here, but as
 * a `type` — `verbatimModuleSyntax` erases it, so there is nothing to stub.
 */

import { currentUser, type HarnessUser } from './harness-state'

export async function getSessionUser(): Promise<HarnessUser | null> {
  return currentUser()
}
