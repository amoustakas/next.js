// mannachef/apps/web/src/server/auth.ts

/**
 * Auth.js v5 (`next-auth@beta`) configuration — the root of every
 * authorization decision the platform makes.
 *
 * ## Shape
 *
 *  - **Adapter:** `@auth/prisma-adapter` over the `@mannachef/db` singleton.
 *    The schema already carries the four adapter models (`Account`, `Session`,
 *    `VerificationToken`, `Authenticator`), so no shim is needed.
 *  - **Strategy:** `database`. Sessions are rows in `Session`, which means a
 *    session can be *revoked server-side* — the single most important property
 *    for a platform that can deactivate a household mid-flight. A JWT cannot be
 *    withdrawn before it expires; a row can be deleted.
 *  - **Providers:** deliberately credentials-free. There is no password column
 *    in the schema and there should never be one. Sign-in is an emailed magic
 *    link (Resend) or Google OAuth, and each provider is registered only when
 *    its environment variables are present, so a developer with neither can
 *    still boot the app and run the build.
 *
 * ## The session callback is a security boundary, not a decoration
 *
 * It does three things, in this order:
 *
 *  1. Re-reads the user from the database. The adapter hands us the row it
 *     already fetched, but its *static* type is `AdapterUser` — `id`, `email`,
 *     `emailVerified`, `name`, `image` and nothing else. The domain columns the
 *     guards need (`role`, `isActive`, `timeZone`, `locale`) and the two
 *     profile ids do not live on that type, and one of the profile ids does not
 *     live on the `User` row at all. One `findUnique` with a narrow `select`
 *     and an `include` of two `id` columns settles all of it.
 *  2. **Refuses a deactivated user.** `isActive === false` does not merely hide
 *     buttons — the session rows for that user are deleted and the callback
 *     returns an anonymous, already-expired session. The next request has no
 *     session at all. See {@link revokeSessionsFor}.
 *  3. Copies the result onto `session.user`, so `requireUser()` and every
 *     ownership guard downstream answer from the session with **no second
 *     query**.
 *
 * The cost is one indexed primary-key lookup per session read, which is the
 * same order as the lookup the adapter already performs, and it buys freshness:
 * a role change or a deactivation takes effect on the very next request rather
 * than whenever the session happens to expire.
 *
 * ## Signing in is the platform's only proof that a mailbox is somebody's
 *
 * Every other module treats an email address as a *claim*: `actions/intake.ts`
 * takes one from an anonymous form, and `@/server/referral-eligibility` reasons
 * about the mailbox two accounts appear to share. This file is where that claim
 * is settled — a verified magic link or a completed OAuth exchange is the one
 * event on the platform that says the caller controls the address.
 *
 * Two consequences hang off the `signIn` callback and the `signIn` event, and
 * both are MCV-050 (see `@/server/referral-claim`):
 *
 *  - A `User` opened by the public intake path is marked `unclaimedSince` and has
 *    no `Account`. Since `allowDangerousEmailAccountLinking` is `false`, Google
 *    sign-in for that address would fail with `OAuthAccountNotLinked` for ever —
 *    so an anonymous enquiry could deny registration to any mailbox. The `signIn`
 *    **callback** adopts such a placeholder instead, and only such a placeholder.
 *  - The `signIn` **event** clears `unclaimedSince`, because the placeholder is
 *    now a real account. That clearing is bookkeeping in what it writes and not
 *    in what it decides: `attachReferralClaim` in `actions/intake.ts` treats a
 *    standing `unclaimedSince` as a licence for an anonymous form to write
 *    `ClientProfile.claimedReferralCode`, so this event is what shuts the public
 *    writer off once an account has a session behind it. See
 *    `markMailboxProved` in `@/server/referral-claim` and the oracle argument in
 *    `actions/referral-claim.ts` for what depends on it.
 *
 * ## What this file deliberately does *not* do (MCV-052)
 *
 * It does not settle referral claims. Until the fourth audit round the `signIn`
 * event turned `ClientProfile.claimedReferralCode` into a `ReferralRedemption`,
 * on the reasoning that a proved mailbox is the earliest safe moment. It is not
 * a safe moment, because it is not the household's decision: an anonymous caller
 * sprayed a code at an address, the genuine owner later signed in organically,
 * and the sprayer was credited 5000 cents by this event. Proving a mailbox says
 * "I am this person"; it does not say "and I accept that attribution". Only the
 * household's explicit acceptance does, through
 * `settleAcceptedClaim` / `declineReferralClaim`. Signing in must never again
 * create a `ReferralRedemption`, however narrow the guard around it looks.
 *
 * ## Environment
 *
 * | Variable              | Effect                                            |
 * | --------------------- | ------------------------------------------------- |
 * | `AUTH_SECRET`         | Required. Signs/encrypts the session cookie.       |
 * | `AUTH_RESEND_KEY`     | With `AUTH_EMAIL_FROM`, enables the magic link.    |
 * | `AUTH_EMAIL_FROM`     | e.g. `MannaChef <hello@mannachef.example>`.        |
 * | `AUTH_GOOGLE_ID`      | With `AUTH_GOOGLE_SECRET`, enables Google OAuth.   |
 * | `AUTH_GOOGLE_SECRET`  | —                                                  |
 *
 * `AUTH_SECRET` is read by Auth.js itself and is intentionally not touched
 * here; nothing in this file ever reads, logs, or interpolates a secret value.
 */

import NextAuth, { type DefaultSession, type NextAuthConfig } from 'next-auth'
import Google from 'next-auth/providers/google'
import Resend from 'next-auth/providers/resend'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { roleSchema, type Role } from '@mannachef/validators'
import { z } from 'zod'

import { prisma } from '@/server/db'
import {
  adoptUnclaimedAccount,
  ensureMailboxProved,
  type MailboxProofRepair,
  type OAuthAccountLink,
} from '@/server/referral-claim'

// =============================================================================
// 1. The session user
// =============================================================================

/**
 * The runtime shape of `session.user`.
 *
 * Declared as a zod schema rather than a bare interface because the value
 * crossing back out of `auth()` is, statically, whatever the module
 * augmentation below claims — and the deactivation branch deliberately returns
 * a session with **no** user at all. Parsing rather than asserting is what
 * makes that branch safe: `getSessionUser()` cannot be fooled into handing a
 * guard a half-populated user.
 *
 * `clientProfileId` / `staffProfileId` are `null`, never absent, matching
 * `sessionSchema` in `@mannachef/api-contract` so the web session and the
 * `/api/session` payload describe the same thing.
 */
export const sessionUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  role: roleSchema,
  isActive: z.boolean(),
  timeZone: z.string(),
  locale: z.string(),
  /** The caller's own `ClientProfile.id`, or `null` if they have no household. */
  clientProfileId: z.string().nullable(),
  /** The caller's own `StaffProfile.id`, or `null` if they are not a chef. */
  staffProfileId: z.string().nullable(),
})

/** What `session.user` carries. See {@link sessionUserSchema}. */
export type SessionUser = z.infer<typeof sessionUserSchema>

/**
 * A session user that has been proven to exist *and* to be active.
 *
 * The only difference from {@link SessionUser} is the literal `true`, which is
 * what stops a guard from being written against a user it never checked. Every
 * `ActionContext` carries this type, not `SessionUser`.
 */
export type AuthenticatedUser = SessionUser & { isActive: true }

// =============================================================================
// 2. Module augmentation
//
// `session.user.role` is the `Role` union, not `string`. A `switch` over it is
// exhaustive, and a typo in a role name is a compile error rather than a
// permission hole that silently never matches.
// =============================================================================

declare module 'next-auth' {
  /**
   * `Session.user` is widened from Auth.js's `{ name?, email?, image? }` to the
   * full MannaChef session user. The override is legal because
   * {@link SessionUser} is assignable to the `DefaultSession['user']` it
   * replaces.
   *
   * It is declared **required** here even though the deactivation branch of the
   * session callback returns a session without one. That is deliberate: the
   * ordinary path always populates it, and the one path that does not is
   * reached exclusively through {@link getSessionUser}, which validates at
   * runtime instead of trusting this declaration.
   */
  interface Session {
    user: SessionUser
  }
}

// =============================================================================
// 3. Providers
// =============================================================================

/**
 * Read an environment variable, treating empty and whitespace-only as absent.
 *
 * `.env` files routinely carry `AUTH_GOOGLE_ID=` placeholders; a provider
 * configured from one of those fails at sign-in with an opaque OAuth error
 * rather than being cleanly absent from the sign-in page.
 */
function readEnv(name: string): string | undefined {
  const raw = process.env[name]

  if (raw === undefined) {
    return undefined
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function buildProviders(): NextAuthConfig['providers'] {
  const providers: NextAuthConfig['providers'] = []

  const resendApiKey = readEnv('AUTH_RESEND_KEY')
  const emailFrom = readEnv('AUTH_EMAIL_FROM')

  if (resendApiKey !== undefined && emailFrom !== undefined) {
    // Resend's provider is a plain `fetch` against their HTTP API — no SMTP
    // transport and no extra dependency, which is why it is preferred over
    // `next-auth/providers/nodemailer` here.
    providers.push(
      Resend({
        apiKey: resendApiKey,
        from: emailFrom,
        // A magic link is a bearer credential in an inbox. Fifteen minutes is
        // long enough to switch to a mail app and back, short enough that a
        // forwarded or logged link is worthless by the time anyone finds it.
        maxAge: 15 * 60,
      })
    )
  }

  const googleClientId = readEnv('AUTH_GOOGLE_ID')
  const googleClientSecret = readEnv('AUTH_GOOGLE_SECRET')

  if (googleClientId !== undefined && googleClientSecret !== undefined) {
    providers.push(
      Google({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        // Left at its default of `false` on purpose, and stated rather than
        // implied: enabling it would let anyone who can obtain a Google account
        // bearing an existing user's email address take over that account
        // without ever proving control of the mailbox.
        allowDangerousEmailAccountLinking: false,
      })
    )
  }

  return providers
}

/**
 * The provider ids that are actually live in this environment.
 *
 * A sign-in page should render buttons from this list rather than hard-coding
 * both providers, otherwise a deployment without Google credentials shows a
 * button that leads to an error page.
 */
export const enabledAuthProviderIds: readonly string[] = buildProviders().map(
  (provider) => (typeof provider === 'function' ? provider().id : provider.id)
)

// =============================================================================
// 4. Deactivation
// =============================================================================

/**
 * Delete every database session belonging to a user.
 *
 * This is what makes "deactivated" mean something. Clearing the cookie would
 * only log out the browser that happened to ask; deleting the rows invalidates
 * every device at once, including ones that are mid-request.
 *
 * Failures are swallowed on purpose. The caller is on the *refusal* path — the
 * session it is about to return is already anonymous and already expired, so a
 * database hiccup here must not turn a denial into a thrown error that some
 * error boundary renders as "try again", which a deactivated user would read as
 * an invitation.
 */
async function revokeSessionsFor(userId: string): Promise<void> {
  try {
    await prisma.session.deleteMany({ where: { userId } })
  } catch (error) {
    console.error(
      '[auth] failed to revoke sessions for a deactivated user',
      // The user id is not a secret and is the only way to follow this up.
      { userId, error: error instanceof Error ? error.message : 'unknown' }
    )
  }
}

/**
 * The value the session callback returns for a refused user.
 *
 * Typed as `DefaultSession`, whose `user` is optional, so the absence is
 * expressible. `expires` is the epoch, which every client-side helper treats as
 * "already gone".
 */
function anonymousExpiredSession(): DefaultSession {
  return { expires: new Date(0).toISOString() }
}

// =============================================================================
// 5. Accounts opened for addresses nobody had proved (MCV-050)
//
// Both helpers are three lines of mapping onto `@/server/referral-claim`, and
// that is on purpose. This module cannot be imported outside a Next.js runtime —
// `next-auth` reaches `next/server` — so nothing testable may live here. The
// decisions are in the plain server module, where `verify-referral-preemption.ts`
// drives them against a real PostgreSQL.
// =============================================================================

/**
 * Narrow Auth.js's `account` to the columns {@link adoptUnclaimedAccount} writes.
 *
 * Auth.js types `Account`'s OAuth columns as `unknown`-ish optionals carrying
 * whatever the provider returned, so each is checked rather than asserted;
 * anything that is not the expected primitive is simply not stored, which is the
 * same thing the adapter would have done with it.
 */
function toOAuthAccountLink(account: {
  provider: string
  providerAccountId: string
  type: string
  access_token?: unknown
  refresh_token?: unknown
  expires_at?: unknown
  token_type?: unknown
  scope?: unknown
  id_token?: unknown
  session_state?: unknown
}): OAuthAccountLink {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined

  return {
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    type: account.type,
    access_token: text(account.access_token),
    refresh_token: text(account.refresh_token),
    expires_at:
      typeof account.expires_at === 'number' ? account.expires_at : undefined,
    token_type: text(account.token_type),
    scope: text(account.scope),
    id_token: text(account.id_token),
    session_state: text(account.session_state),
  }
}

/**
 * Adopt an unclaimed placeholder instead of refusing the sign-in, when the
 * caller is arriving by OAuth at an address the public intake path opened.
 *
 * See {@link adoptUnclaimedAccount} for what "unclaimed" has to mean before this
 * is safe, and why it is narrower than `allowDangerousEmailAccountLinking`.
 * Failures are swallowed: the worst case of *not* adopting is the
 * `OAuthAccountNotLinked` page the caller would have seen anyway.
 */
async function adoptForOAuthSignIn(
  email: string | null,
  account: Parameters<typeof toOAuthAccountLink>[0] | null | undefined
): Promise<void> {
  if (email === null || account === null || account === undefined) {
    return
  }

  if (account.type !== 'oauth' && account.type !== 'oidc') {
    return
  }

  try {
    await adoptUnclaimedAccount(email, toOAuthAccountLink(account))
  } catch (error) {
    console.error('[auth] failed to adopt an unclaimed account', {
      email,
      provider: account.provider,
      error: error instanceof Error ? error.message : 'unknown',
    })
  }
}

/**
 * Where an operator finds out that `User.unclaimedSince` is still stamped on an
 * account that has a session.
 *
 * ## Why this is a function rather than a `catch` block
 *
 * Because the thing it is replacing was a `catch` block, and a `catch` block is
 * the wrong shape for this. `ensureMailboxProved` returns a discriminated union
 * with a `failed` arm, so the failure is a value that has to be passed
 * somewhere; routing every caller through one reporter means there is exactly
 * one sentence describing this fault on the platform, and adding a third caller
 * cannot accidentally reintroduce silence. That is the property the previous
 * design lacked: two call sites of a `try`/`catch` can disagree about whether a
 * failure matters, and nothing notices.
 *
 * ## The three levels, and why they are not all the same
 *
 *  - `failed` is an **error**. It is a live security-relevant degradation: the
 *    public enquiry form can still overwrite this household's
 *    `ClientProfile.claimedReferralCode`, so a sprayer can still re-aim the
 *    consent prompt of an account that already has a session. The line names
 *    that consequence rather than the Prisma call, because an operator reading
 *    it at 3am needs to know what is exposed, not which statement threw. It
 *    carries the `userId` and no other identifier — CONTRACT.md §5 forbids
 *    logging secrets, and an email address in a log is a worse trade here than
 *    a cuid an operator can look up.
 *  - `newly-proved` from a *session read* is a **warning**, and it is the most
 *    informative line this function emits: it means an earlier sign-in's clear
 *    did not happen, the repair has just run, and the account was exposed for
 *    the interval between the two. `origin` is what makes that visible — the
 *    same outcome from `sign-in` is the ordinary first sign-in of every
 *    household the intake path ever opened, and is merely `info`.
 *  - `not-applicable` is silent. It is the outcome of essentially every
 *    authenticated request on the platform, and a line printed on all of them
 *    is one nobody reads — which is how the previous failure went unnoticed for
 *    a whole audit round.
 */
function reportMailboxProof(
  userId: string,
  outcome: MailboxProofRepair,
  origin: 'sign-in' | 'session'
): void {
  if (outcome.kind === 'failed') {
    console.error(
      '[auth] unclaimedSince could not be cleared — the public enquiry form can still overwrite this household’s referral claim',
      {
        userId,
        origin,
        attempts: outcome.attempts,
        error: outcome.message,
      }
    )
    return
  }

  if (outcome.kind !== 'newly-proved') {
    return
  }

  if (origin === 'session') {
    console.warn(
      '[auth] unclaimedSince was still set on an account with a live session — repaired now, so an earlier sign-in failed to clear it',
      { userId }
    )
    return
  }

  console.info('[auth] unclaimed account proved by sign-in', { userId })
}

// =============================================================================
// 6. Configuration
// =============================================================================

export const authConfig = {
  adapter: PrismaAdapter(prisma),
  providers: buildProviders(),

  session: {
    // See the module docblock: a row can be revoked, a JWT cannot.
    strategy: 'database',
    maxAge: 30 * 24 * 60 * 60,
    // Slide the expiry at most once a day so an active session stays alive
    // without one `UPDATE` per request.
    updateAge: 24 * 60 * 60,
  },

  callbacks: {
    /**
     * First gate. Refuses a deactivated user before a session row is ever
     * created, so the deactivation is felt at the door rather than one request
     * later.
     *
     * Returning `true` for an unknown user is correct and not a hole: it is the
     * sign-up path, and the adapter creates the row immediately afterwards with
     * the schema default of `isActive = true`.
     *
     * It is also where an unclaimed placeholder is adopted (MCV-050). This
     * callback runs *before* Auth.js's own account-linking check, so writing the
     * `Account` row here is what turns a permanent `OAuthAccountNotLinked` — the
     * denial of Google registration an anonymous enquiry could otherwise inflict
     * on any address — into an ordinary sign-in. It happens after the
     * deactivation check, so a deactivated placeholder is refused rather than
     * adopted.
     */
    async signIn({ user, account }) {
      const userId = typeof user.id === 'string' ? user.id : null
      const email = typeof user.email === 'string' ? user.email : null

      if (userId !== null) {
        const byId = await prisma.user.findUnique({
          where: { id: userId },
          select: { isActive: true },
        })

        // `null` is the sign-up path — no row yet. An OAuth caller reaching it
        // may still be arriving at a placeholder somebody else's enquiry opened,
        // which is exactly the case `adoptForOAuthSignIn` answers.
        if (byId === null) {
          await adoptForOAuthSignIn(email, account)
          return true
        }

        return byId.isActive
      }

      if (email === null) {
        return true
      }

      const byEmail = await prisma.user.findUnique({
        where: { email },
        select: { isActive: true },
      })

      if (byEmail === null) {
        return true
      }

      if (!byEmail.isActive) {
        return false
      }

      await adoptForOAuthSignIn(email, account)

      return true
    },

    /**
     * Second gate, and the one that runs on *every* session read.
     *
     * `signIn` only fires at the door; this fires continuously, which is why
     * the deactivation check has to live here as well. A household deactivated
     * while signed in loses access on its next request, not at cookie expiry.
     *
     * ## And why the placeholder repair lives here too
     *
     * "Fires continuously" is exactly what a state transition that must not be
     * lost needs behind it. The `signIn` event gets one attempt at clearing
     * `User.unclaimedSince`; this gets one on every authenticated request the
     * household ever makes, so a clear that faulted at the door is repaired at
     * the household's next page load rather than at their next sign-in — which,
     * for a magic-link household, may never come.
     *
     * The repair costs **no extra query in the ordinary case**. This callback
     * already reads the row, so `unclaimedSince` is one more column on a
     * `SELECT` that was happening anyway, and `ensureMailboxProved` is called
     * only when that column is non-null — which, for every household that has
     * ever signed in successfully, it is not.
     *
     * A live session is not a hint that the mailbox was proved, it is the
     * proof: Auth.js issued it only after verifying a magic link or completing
     * an OAuth exchange. So "there is a session **and** the stamp is set" is
     * unambiguous — it is the degraded state and nothing else — and clearing it
     * here is not a new policy, it is the sign-in event's policy applied at the
     * next opportunity. Nothing about money is decided here or anywhere near
     * here; see `@/server/referral-claim`.
     */
    async session({ session, user }) {
      const record = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          isActive: true,
          timeZone: true,
          locale: true,
          // Read for the repair below, never surfaced on `session.user`. It is
          // a server-side capability marker and no client has business seeing
          // whether an account was opened by the intake path.
          unclaimedSince: true,
          clientProfile: { select: { id: true } },
          staffProfile: { select: { id: true } },
        },
      })

      if (record === null || !record.isActive) {
        await revokeSessionsFor(user.id)
        return anonymousExpiredSession()
      }

      // The session is live and active, so the mailbox is proved. If the stamp
      // survived the sign-in event, that event's write failed and this is the
      // re-attempt. Awaited rather than fired and forgotten: an unawaited
      // promise in a serverless invocation is a promise that may never run, and
      // this is the code path that is supposed to be the reliable one.
      if (record.unclaimedSince !== null) {
        reportMailboxProof(
          record.id,
          await ensureMailboxProved(record.id),
          'session'
        )
      }

      const sessionUser: SessionUser = {
        id: record.id,
        name: record.name,
        email: record.email,
        image: record.image,
        role: record.role,
        isActive: record.isActive,
        timeZone: record.timeZone,
        locale: record.locale,
        clientProfileId: record.clientProfile?.id ?? null,
        staffProfileId: record.staffProfile?.id ?? null,
      }

      // `session.user` is statically `AdapterUser & SessionUser`, so a whole-
      // object assignment would also have to restate `emailVerified` and the
      // rest of the adapter's surface. Patching keeps the domain fields fully
      // type-checked (via the `SessionUser` annotation above) without inventing
      // values for columns that are none of this callback's business.
      Object.assign(session.user, sessionUser)

      return session
    },
  },

  events: {
    /**
     * The moment a mailbox has been proved.
     *
     * This event fires after Auth.js has verified a magic link or completed an
     * OAuth exchange, which makes it the earliest point at which the platform
     * knows the caller controls the address. Two things happen, and both are
     * bookkeeping:
     *
     *  1. `User.lastLoginAt` is stamped. Purely informational — the CRM sorts
     *     dormant households by it.
     *  2. {@link ensureMailboxProved} clears `User.unclaimedSince`, so a row the
     *     public intake path opened for an unproved address stops being a
     *     placeholder.
     *
     * The two are **not** the same kind of write and are no longer handled as
     * though they were. See {@link reportMailboxProof}.
     *
     * ## No referral is settled here (MCV-052)
     *
     * This event used to call `settleFirstAuthenticatedSession`, which wrote a
     * `ReferralRedemption` from whatever code the household's public enquiry had
     * carried. That call is gone, and it must not come back in any form.
     *
     * The reason is not that the guard around it was too loose. It is that a
     * sign-in cannot carry the information the decision needs. "A stranger typed
     * a code against your address, then you signed in" and "you typed a code,
     * then you signed in" are the same two HTTP requests from the server's side,
     * so any rule that settles automatically at this point is a rule an
     * unauthenticated party can aim. Round four measured exactly that: one
     * anonymous call, then the victim's own organic magic-link sign-in and
     * payment, `{examined: 1, rewarded: 1, creditedCents: 5000}` to the stranger.
     *
     * A claim now becomes money only in `settleAcceptedClaim`, called by the
     * consent action on behalf of the signed-in household. Nothing in this file
     * has a use for it: an Auth.js event has no household in front of it to ask.
     *
     * ## Neither write may fail the sign-in; only one of them may fail quietly
     *
     * A household must never be shown "try again", which reads as a rejected
     * sign-in, because a write behind the scenes failed. That part is unchanged.
     * What has changed is what happens instead, because the previous version of
     * this comment justified swallowing *both* failures on the ground that
     * "neither write carries money, so losing one costs a stale column and not a
     * cent" — and that is true of `lastLoginAt` and false of `unclaimedSince`.
     * The first is a record; the second is a capability boundary, and while it
     * stands the public enquiry form may still overwrite this household's
     * `ClientProfile.claimedReferralCode`. See {@link reportMailboxProof} and
     * `ensureMailboxProved`.
     */
    async signIn({ user }) {
      if (typeof user.id !== 'string') {
        return
      }

      const userId = user.id

      try {
        await prisma.user.update({
          where: { id: userId },
          data: { lastLoginAt: new Date() },
        })
      } catch (error) {
        console.error('[auth] failed to stamp lastLoginAt', {
          userId,
          error: error instanceof Error ? error.message : 'unknown',
        })
      }

      // No `try`/`catch`: `ensureMailboxProved` reports its own failure as a
      // value, which is the whole point of it existing. A `catch` here would
      // put the swallow back exactly where it was.
      reportMailboxProof(userId, await ensureMailboxProved(userId), 'sign-in')
    },
  },

  // Auth.js's own error page leaks nothing, but its default `debug` output
  // does. Keep it off unless a developer opts in explicitly.
  debug: readEnv('AUTH_DEBUG') === 'true',
} satisfies NextAuthConfig

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

// =============================================================================
// 7. Reading the session
// =============================================================================

/**
 * Resolve the current caller, or `null`.
 *
 * This is the single door between Auth.js and the rest of the server. It
 * returns `null` — never a partially populated user — when any of the following
 * holds:
 *
 *  - there is no session cookie, or it does not match a live `Session` row;
 *  - the session callback refused the user, so `session.user` is absent;
 *  - the session user does not satisfy {@link sessionUserSchema}, which would
 *    mean the augmentation and the callback have drifted apart;
 *  - `isActive` is `false`, which the callback should already have caught. The
 *    check is repeated here rather than trusted, because this function is the
 *    last thing standing between a deactivated household and a mutation.
 *
 * Callers in `guards.ts` turn the `null` into an `UNAUTHENTICATED`
 * `ActionResult`; nothing else should call `auth()` directly.
 */
export async function getSessionUser(): Promise<AuthenticatedUser | null> {
  const session = await auth()

  if (session === null) {
    return null
  }

  // `session.user` is declared required by the augmentation above, but the
  // refusal path really does omit it. Parse, do not assert.
  const parsed = sessionUserSchema.safeParse(session.user)

  if (!parsed.success) {
    return null
  }

  const user = parsed.data

  if (!user.isActive) {
    return null
  }

  return { ...user, isActive: true }
}

/**
 * `true` when the caller is signed in and active.
 *
 * A convenience for layouts that only need to choose between a marketing header
 * and a portal header. Never use it as an authorization check — see
 * `CONTRACT.md` §5: a hidden button is not a permission check.
 */
export async function isSignedIn(): Promise<boolean> {
  return (await getSessionUser()) !== null
}

/**
 * The caller's role, or `null` when signed out.
 *
 * Pairs with `hasRoleAtLeast` from `@mannachef/validators`, which accepts
 * `null` precisely so this can be passed straight through.
 */
export async function getSessionRole(): Promise<Role | null> {
  return (await getSessionUser())?.role ?? null
}
