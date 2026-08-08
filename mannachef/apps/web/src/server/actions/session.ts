// mannachef/apps/web/src/server/actions/session.ts

'use server'

/**
 * Ending a session.
 *
 * The one action on the platform that deliberately does **not** return an
 * `ActionResult`, and the reason is structural rather than stylistic: Auth.js's
 * `signOut` finishes by throwing Next's redirect sentinel, so control never
 * reaches a `return`. Wrapping it in `withAction` would put `unstable_rethrow`
 * in the path of that sentinel — which is exactly what `toActionFailure` already
 * does, correctly — and then hand the caller a promise that resolves to
 * nothing. A signature that promises a value it can never produce is worse than
 * one that promises `void`.
 *
 * There is no authorization check here on purpose. Signing out is the one thing
 * every caller may do, including a caller whose session has already expired: the
 * cookie is cleared either way, and refusing would strand somebody at a menu
 * they can no longer use.
 *
 * `redirectTo` sends the operator to the public site rather than back to
 * `/admin`, which would immediately bounce them to the sign-in page and read as
 * a failed sign-out.
 */

import { signOut } from '@/server/auth'

/** Clear the session cookie and land on the public site. */
export async function endSession(): Promise<void> {
  await signOut({ redirectTo: '/' })
}
