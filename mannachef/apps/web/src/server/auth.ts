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
// 5. Configuration
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
     */
    async signIn({ user }) {
      const userId = typeof user.id === 'string' ? user.id : null

      if (userId !== null) {
        const byId = await prisma.user.findUnique({
          where: { id: userId },
          select: { isActive: true },
        })

        // `null` is the sign-up path — no row yet.
        return byId === null ? true : byId.isActive
      }

      const email = typeof user.email === 'string' ? user.email : null

      if (email === null) {
        return true
      }

      const byEmail = await prisma.user.findUnique({
        where: { email },
        select: { isActive: true },
      })

      return byEmail === null ? true : byEmail.isActive
    },

    /**
     * Second gate, and the one that runs on *every* session read.
     *
     * `signIn` only fires at the door; this fires continuously, which is why
     * the deactivation check has to live here as well. A household deactivated
     * while signed in loses access on its next request, not at cookie expiry.
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
          clientProfile: { select: { id: true } },
          staffProfile: { select: { id: true } },
        },
      })

      if (record === null || !record.isActive) {
        await revokeSessionsFor(user.id)
        return anonymousExpiredSession()
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
     * Stamp `User.lastLoginAt`. Purely informational — the CRM sorts dormant
     * households by it — so a failure is logged and swallowed rather than
     * allowed to break a sign-in that has otherwise succeeded.
     */
    async signIn({ user }) {
      if (typeof user.id !== 'string') {
        return
      }

      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        })
      } catch (error) {
        console.error('[auth] failed to stamp lastLoginAt', {
          userId: user.id,
          error: error instanceof Error ? error.message : 'unknown',
        })
      }
    },
  },

  // Auth.js's own error page leaks nothing, but its default `debug` output
  // does. Keep it off unless a developer opts in explicitly.
  debug: readEnv('AUTH_DEBUG') === 'true',
} satisfies NextAuthConfig

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

// =============================================================================
// 6. Reading the session
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
