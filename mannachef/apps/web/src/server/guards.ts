// mannachef/apps/web/src/server/guards.ts

/**
 * Authorization for every Server Action and route handler on the platform.
 *
 * `mannachef/CONTRACT.md` §5 states the rules; this file is where they are
 * actually enforced. Nothing in `src/app/**` may decide access on its own — a
 * hidden button is not a permission check, and neither is a redirect in a
 * layout. Access is decided here, on the server, against the database.
 *
 * ## What lives here
 *
 *  1. **{@link requireUser}** — is there a live, active session?
 *  2. **{@link requireRole}** — is that session privileged enough?
 *  3. **Ownership guards** — does *this row* belong to *this caller*? Seven of
 *     them, one per client-scoped entity, each doing a real `SELECT`. An id
 *     arriving from a browser is a claim, never a fact.
 *  4. **{@link withAction}** — the wrapper that runs 1–3 in the right order,
 *     validates the payload, calls the handler, converts anything the handler
 *     throws into a guest-safe `ActionResult`, and revalidates on success only.
 *  5. **{@link rateLimit}** — a token bucket for the three public-facing
 *     actions that a stranger can reach.
 *  6. **{@link readAsGuest}** — the opt-in that lets a `'PUBLIC'` action run
 *     without resolving a session, so a page built entirely from public reads
 *     can actually be prerendered instead of only claiming to be.
 *
 * ## Failure vocabulary
 *
 * Guards **return**, they do not throw. A signed-out caller, an insufficient
 * role, and somebody else's invoice are all expected outcomes of a hostile or
 * merely stale client, and each has a code in `ActionErrorCode`. The only thing
 * that throws is a bug, and `withAction` catches those.
 *
 * ## Existence is a secret
 *
 * A caller who asks about a row they do not own gets `NOT_FOUND`, not
 * `FORBIDDEN` — the same answer they get for an id that never existed. The
 * distinction matters: `FORBIDDEN` confirms the row is real, which turns any
 * ownership guard into an oracle for enumerating cuids. Call sites that
 * genuinely want the sharper answer (an admin screen where the operator is
 * meant to learn that the row exists) opt in with `denyWith: 'FORBIDDEN'`.
 * Role checks are the exception — `requireRole` returns `FORBIDDEN`, because a
 * role failure reveals nothing about any particular row.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { headers } from 'next/headers'
import { revalidatePath, revalidateTag, updateTag } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { z } from 'zod'
import {
  hasRoleAtLeast,
  ROLE_HIERARCHY,
  type AppointmentStatus,
  type InvoiceStatus,
  type NoteVisibility,
  type ReviewStatus,
  type Role,
  type SubscriptionStatus,
} from '@mannachef/validators'

import { getSessionUser, type AuthenticatedUser } from '@/server/auth'
import { Prisma, prisma } from '@/server/db'
import {
  fail,
  isActionError,
  ok,
  zodFail,
  type ActionFailure,
  type ActionResult,
} from '@/server/actions/types'

export type { AuthenticatedUser }

// =============================================================================
// 1. Session and role
// =============================================================================

/**
 * Resolve the caller.
 *
 * Returns the fully typed, guaranteed-active session user, or an
 * `UNAUTHENTICATED` failure. Never throws.
 *
 * The user it returns already carries `role`, `isActive`, `clientProfileId` and
 * `staffProfileId` — the session callback in `@/server/auth` put them there —
 * so an ownership check that compares against `clientProfileId` costs one query
 * for the row and nothing for the caller.
 *
 * ```ts
 * const caller = await requireUser()
 * if (!caller.ok) return caller
 * // caller.data.role is `Role`, not `string`
 * ```
 */
export async function requireUser(): Promise<ActionResult<AuthenticatedUser>> {
  const user = await getSessionUser()

  if (user === null) {
    return fail('UNAUTHENTICATED')
  }

  return ok(user)
}

/**
 * Resolve the caller and assert a minimum role.
 *
 * Uses `hasRoleAtLeast` / `ROLE_HIERARCHY` from `@mannachef/validators`, which
 * is the single definition of `SUPER_ADMIN > ADMIN > CHEF_STAFF > CLIENT` and
 * is shared with the Expo client so both surfaces rank roles identically.
 *
 * Returns `UNAUTHENTICATED` when there is no session and `FORBIDDEN` when there
 * is one but it does not reach `minimum`. Both are ordinary return values.
 *
 * ```ts
 * const caller = await requireRole('ADMIN')
 * if (!caller.ok) return caller
 * ```
 */
export async function requireRole(
  minimum: Role
): Promise<ActionResult<AuthenticatedUser>> {
  const caller = await requireUser()

  if (!caller.ok) {
    return caller
  }

  if (!hasRoleAtLeast(caller.data.role, minimum)) {
    return fail('FORBIDDEN')
  }

  return ok(caller.data)
}

/**
 * Rank a role without a session round-trip.
 *
 * Exported because admin *rendering* legitimately needs to compare roles — a
 * table hiding a column a CHEF_STAFF may not read — and re-deriving the ranking
 * inline is how hierarchies drift apart. This is a presentation helper: it is
 * not, and must never be, the only check in front of a mutation.
 */
export function rankOf(role: Role): number {
  return ROLE_HIERARCHY[role]
}

// =============================================================================
// 2. Ownership
// =============================================================================

/** Shared options for every ownership guard. */
export interface OwnershipOptions {
  /**
   * The role at or above which the caller may reach a row that is not theirs.
   *
   * Every guard has a documented default, and `null` disables the bypass
   * entirely (strict self-only — appropriate for "delete my account" style
   * actions where not even a SUPER_ADMIN should act through the client path).
   * The bypass is always an explicit, ranked role: there is no "staff can see
   * everything" rule hidden inside any of these functions.
   */
  readonly bypassRole?: Role | null

  /**
   * What a denial looks like.
   *
   * `NOT_FOUND` (the default) makes an unowned row indistinguishable from a
   * nonexistent one. `FORBIDDEN` is for screens where the caller is entitled to
   * know the row exists.
   */
  readonly denyWith?: 'NOT_FOUND' | 'FORBIDDEN'
}

function resolveBypassRole(
  options: OwnershipOptions | undefined,
  fallback: Role | null
): Role | null {
  const configured = options?.bypassRole
  return configured === undefined ? fallback : configured
}

function callerBypasses(
  user: AuthenticatedUser,
  bypassRole: Role | null
): boolean {
  return bypassRole !== null && hasRoleAtLeast(user.role, bypassRole)
}

function denial(options: OwnershipOptions | undefined): ActionFailure {
  return fail(options?.denyWith === 'FORBIDDEN' ? 'FORBIDDEN' : 'NOT_FOUND')
}

/** What {@link requireAppointmentOwnership} proves. */
export interface AppointmentOwnership {
  readonly id: string
  readonly clientProfileId: string
  readonly staffProfileId: string
  readonly status: AppointmentStatus
}

/** What {@link requireIntakeFormOwnership} proves. */
export interface IntakeFormOwnership {
  readonly id: string
  readonly clientProfileId: string
  readonly submittedAt: Date | null
}

/** What {@link requireInvoiceOwnership} proves. */
export interface InvoiceOwnership {
  readonly id: string
  readonly userId: string
  readonly status: InvoiceStatus
}

/** What {@link requireSubscriptionOwnership} proves. */
export interface SubscriptionOwnership {
  readonly id: string
  readonly userId: string
  readonly status: SubscriptionStatus
  readonly stripeCustomerId: string
  readonly stripeSubscriptionId: string
}

/** What {@link requireReviewOwnership} proves. */
export interface ReviewOwnership {
  readonly id: string
  readonly authorId: string
  readonly status: ReviewStatus
}

/** What {@link requireReferralCodeOwnership} proves. */
export interface ReferralCodeOwnership {
  readonly id: string
  readonly ownerId: string
  readonly code: string
  readonly isActive: boolean
}

/** What {@link requireClientNoteOwnership} proves. */
export interface ClientNoteOwnership {
  readonly id: string
  readonly clientProfileId: string
  readonly authorId: string | null
  readonly visibility: NoteVisibility
}

/**
 * `ChefAppointment` — the caller's own engagement.
 *
 * Two kinds of owner, because an appointment has two sides: the household
 * (`clientProfileId` matches the caller's `ClientProfile`) and the chef who is
 * booked to cook it (`staffProfileId` matches the caller's `StaffProfile`).
 * Neither is a bypass; both are ownership.
 *
 * Bypass defaults to `ADMIN`. `CHEF_STAFF` is deliberately *not* the default: a
 * chef reaches their own bookings through `staffProfileId`, and a chef who is
 * not on the booking has no business reading the client's address.
 */
export async function requireAppointmentOwnership(
  user: AuthenticatedUser,
  appointmentId: string,
  options?: OwnershipOptions
): Promise<ActionResult<AppointmentOwnership>> {
  const row = await prisma.chefAppointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      clientProfileId: true,
      staffProfileId: true,
      status: true,
    },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, 'ADMIN'))) {
    return ok(row)
  }

  const isClient =
    user.clientProfileId !== null &&
    row.clientProfileId === user.clientProfileId

  const isAssignedChef =
    user.staffProfileId !== null && row.staffProfileId === user.staffProfileId

  if (isClient || isAssignedChef) {
    return ok(row)
  }

  return denial(options)
}

/**
 * `ClientIntakeForm` — the caller's own household questionnaire.
 *
 * Bypass defaults to `CHEF_STAFF`, and this one is deliberate rather than lax:
 * allergies and dislikes are the whole point of the form, and a chef who cannot
 * read them cannot cook safely. The row is still scoped — a chef reaches it
 * through the role check, not by guessing ids, and the denial is `NOT_FOUND`.
 */
export async function requireIntakeFormOwnership(
  user: AuthenticatedUser,
  intakeFormId: string,
  options?: OwnershipOptions
): Promise<ActionResult<IntakeFormOwnership>> {
  const row = await prisma.clientIntakeForm.findUnique({
    where: { id: intakeFormId },
    select: { id: true, clientProfileId: true, submittedAt: true },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, 'CHEF_STAFF'))) {
    return ok(row)
  }

  if (
    user.clientProfileId !== null &&
    row.clientProfileId === user.clientProfileId
  ) {
    return ok(row)
  }

  return denial(options)
}

/**
 * `Invoice` — the caller's own bill.
 *
 * Owned via `Invoice.userId`, which points at `User`, not at `ClientProfile`.
 * Bypass defaults to `ADMIN`: money is not a `CHEF_STAFF` concern.
 */
export async function requireInvoiceOwnership(
  user: AuthenticatedUser,
  invoiceId: string,
  options?: OwnershipOptions
): Promise<ActionResult<InvoiceOwnership>> {
  const row = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, userId: true, status: true },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, 'ADMIN'))) {
    return ok(row)
  }

  return row.userId === user.id ? ok(row) : denial(options)
}

/**
 * `UserSubscription` — the caller's own plan.
 *
 * The Stripe ids are selected because the actions that use this guard
 * (pause, resume, change plan, cancel) need them immediately, and re-reading
 * the row to get them would be a second chance to read the wrong one.
 *
 * Bypass defaults to `ADMIN`.
 */
export async function requireSubscriptionOwnership(
  user: AuthenticatedUser,
  subscriptionId: string,
  options?: OwnershipOptions
): Promise<ActionResult<SubscriptionOwnership>> {
  const row = await prisma.userSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      userId: true,
      status: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, 'ADMIN'))) {
    return ok(row)
  }

  return row.userId === user.id ? ok(row) : denial(options)
}

/**
 * `Review` — the caller's own review.
 *
 * Owned via `Review.authorId`. Bypass defaults to `ADMIN`, which is the
 * moderation path: `Review.moderatedById` is an admin action, and a `CHEF_STAFF`
 * must not be able to edit or approve a review of their own cooking.
 */
export async function requireReviewOwnership(
  user: AuthenticatedUser,
  reviewId: string,
  options?: OwnershipOptions
): Promise<ActionResult<ReviewOwnership>> {
  const row = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, authorId: true, status: true },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, 'ADMIN'))) {
    return ok(row)
  }

  return row.authorId === user.id ? ok(row) : denial(options)
}

/**
 * `ReferralCode` — the caller's own invitation code.
 *
 * Owned via `ReferralCode.ownerId`. Bypass defaults to `ADMIN`, since a code
 * carries a reward value and editing somebody else's is editing their money.
 */
export async function requireReferralCodeOwnership(
  user: AuthenticatedUser,
  referralCodeId: string,
  options?: OwnershipOptions
): Promise<ActionResult<ReferralCodeOwnership>> {
  const row = await prisma.referralCode.findUnique({
    where: { id: referralCodeId },
    select: { id: true, ownerId: true, code: true, isActive: true },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, 'ADMIN'))) {
    return ok(row)
  }

  return row.ownerId === user.id ? ok(row) : denial(options)
}

/**
 * `ClientNote` — a CRM note about a household.
 *
 * The only guard whose answer depends on the row's *content*, because
 * `NoteVisibility` exists precisely to make some notes unreadable by people who
 * can read the household. The matrix, checked in this order:
 *
 * | Condition                        | Who may reach the row                    |
 * | -------------------------------- | ---------------------------------------- |
 * | `authorId === caller`            | always — you can read what you wrote     |
 * | `PRIVATE`                        | the author, and `SUPER_ADMIN`            |
 * | `ADMIN_ONLY`                     | `ADMIN` and above                        |
 * | `STAFF`                          | `CHEF_STAFF` and above                   |
 * | `CLIENT_VISIBLE`                 | `CHEF_STAFF` and above, **and** the      |
 * |                                  | household the note is about              |
 *
 * `bypassRole` is honoured *before* the matrix, so a caller who passes it skips
 * the visibility rules entirely. It therefore defaults to `null` — no bypass —
 * because a blanket bypass would defeat `PRIVATE` and `ADMIN_ONLY`, which is
 * the one thing this guard exists to prevent. Pass it explicitly if an admin
 * tool genuinely needs to override.
 */
export async function requireClientNoteOwnership(
  user: AuthenticatedUser,
  clientNoteId: string,
  options?: OwnershipOptions
): Promise<ActionResult<ClientNoteOwnership>> {
  const row = await prisma.clientNote.findUnique({
    where: { id: clientNoteId },
    select: {
      id: true,
      clientProfileId: true,
      authorId: true,
      visibility: true,
    },
  })

  if (row === null) {
    return fail('NOT_FOUND')
  }

  if (callerBypasses(user, resolveBypassRole(options, null))) {
    return ok(row)
  }

  if (row.authorId !== null && row.authorId === user.id) {
    return ok(row)
  }

  return mayReadClientNote(user, row) ? ok(row) : denial(options)
}

function mayReadClientNote(
  user: AuthenticatedUser,
  note: Pick<ClientNoteOwnership, 'clientProfileId' | 'visibility'>
): boolean {
  switch (note.visibility) {
    case 'PRIVATE':
      return hasRoleAtLeast(user.role, 'SUPER_ADMIN')

    case 'ADMIN_ONLY':
      return hasRoleAtLeast(user.role, 'ADMIN')

    case 'STAFF':
      return hasRoleAtLeast(user.role, 'CHEF_STAFF')

    case 'CLIENT_VISIBLE':
      return (
        hasRoleAtLeast(user.role, 'CHEF_STAFF') ||
        (user.clientProfileId !== null &&
          note.clientProfileId === user.clientProfileId)
      )

    default: {
      // Adding a member to `NoteVisibility` without deciding who may read it
      // is a compile error here rather than an accidental grant.
      const exhaustive: never = note.visibility
      return exhaustive
    }
  }
}

/**
 * The client-scoped entities an ownership guard exists for, mapped to what that
 * guard proves.
 */
export interface OwnershipByEntity {
  appointment: AppointmentOwnership
  intakeForm: IntakeFormOwnership
  invoice: InvoiceOwnership
  subscription: SubscriptionOwnership
  review: ReviewOwnership
  referralCode: ReferralCodeOwnership
  clientNote: ClientNoteOwnership
}

/** Keys of {@link OwnershipByEntity}. */
export type OwnedEntity = keyof OwnershipByEntity

type OwnershipResolver<TRow> = (
  user: AuthenticatedUser,
  id: string,
  options?: OwnershipOptions
) => Promise<ActionResult<TRow>>

const OWNERSHIP_RESOLVERS: {
  [E in OwnedEntity]: OwnershipResolver<OwnershipByEntity[E]>
} = {
  appointment: requireAppointmentOwnership,
  intakeForm: requireIntakeFormOwnership,
  invoice: requireInvoiceOwnership,
  subscription: requireSubscriptionOwnership,
  review: requireReviewOwnership,
  referralCode: requireReferralCodeOwnership,
  clientNote: requireClientNoteOwnership,
}

/**
 * Ownership check by entity name.
 *
 * Equivalent to calling the corresponding `require*Ownership` function; useful
 * where the entity is data — a generic "delete this thing" action, or a table
 * that renders several kinds of row. Prefer the named functions when the entity
 * is known at the call site: the argument list is the same length and the
 * result type needs no explanation.
 *
 * ```ts
 * const owned = await requireOwnership(caller, 'invoice', input.invoiceId)
 * if (!owned.ok) return owned
 * // owned.data is InvoiceOwnership
 * ```
 */
export function requireOwnership<E extends OwnedEntity>(
  user: AuthenticatedUser,
  entity: E,
  id: string,
  options?: OwnershipOptions
): Promise<ActionResult<OwnershipByEntity[E]>> {
  // `OWNERSHIP_RESOLVERS` is a mapped type, so indexing it with the *generic*
  // `E` yields a union of the seven signatures rather than the single one this
  // call selects; TypeScript cannot correlate the two through an index it
  // cannot evaluate. The assertion re-states the relationship the mapped type
  // has already proved: the table's declared type forces every entry to be a
  // resolver for exactly its own key, so this cannot be wrong without the table
  // itself failing to compile.
  const resolve = OWNERSHIP_RESOLVERS[entity] as OwnershipResolver<
    OwnershipByEntity[E]
  >

  return resolve(user, id, options)
}

// =============================================================================
// 3. Rate limiting
//
// An in-memory token bucket. See the note on {@link rateLimit} about swapping
// in Redis before this runs on more than one instance.
// =============================================================================

/** How a rate-limit key is derived. */
export type RateLimitScope =
  /** The signed-in user, falling back to the caller's IP when signed out. */
  | 'identity'
  /** Always the caller's IP, even when signed in. */
  | 'ip'
  /** One bucket for the whole action, shared by every caller. */
  | 'global'

/** A bucket's size and how fast it refills. */
export interface RateLimitRule {
  /** Bucket capacity — the largest burst a single caller may make. */
  readonly tokens: number
  /** Milliseconds for an empty bucket to refill completely. */
  readonly windowMs: number
  /** Defaults to `'identity'`. */
  readonly scope?: RateLimitScope
}

/** The outcome of consuming one token. */
export interface RateLimitVerdict {
  readonly allowed: boolean
  /** Whole tokens left after this call. */
  readonly remaining: number
  /** Milliseconds until one token is available. `0` when allowed. */
  readonly retryAfterMs: number
  /** The bucket that was consulted. Useful in logs; never shown to a guest. */
  readonly key: string
}

interface TokenBucket {
  tokens: number
  updatedAt: number
  windowMs: number
}

/**
 * Buckets survive HMR by living on `globalThis`, exactly as the Prisma client
 * does. Without this, every edit in dev would hand a scraper a fresh quota.
 */
const globalForRateLimit = globalThis as unknown as {
  mannachefRateLimitBuckets: Map<string, TokenBucket> | undefined
}

const rateLimitBuckets: Map<string, TokenBucket> =
  globalForRateLimit.mannachefRateLimitBuckets ?? new Map<string, TokenBucket>()

globalForRateLimit.mannachefRateLimitBuckets = rateLimitBuckets

/**
 * Above this many live buckets, a sweep runs before the next insert.
 *
 * A bucket that has been idle for longer than its own window has necessarily
 * refilled to capacity, which makes it indistinguishable from a bucket that
 * does not exist — so dropping it is free. The threshold exists only to keep
 * the sweep off the hot path.
 */
const RATE_LIMIT_SWEEP_THRESHOLD = 5_000

function sweepRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.updatedAt >= bucket.windowMs) {
      rateLimitBuckets.delete(key)
    }
  }
}

/**
 * Take one token from `key`'s bucket.
 *
 * Pure apart from the module-level map, and `now` is injectable, so the
 * refill arithmetic is testable without waiting for wall-clock time.
 */
export function consumeToken(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now()
): RateLimitVerdict {
  const capacity = Math.max(1, Math.floor(rule.tokens))
  const windowMs = Math.max(1, Math.floor(rule.windowMs))
  const refillPerMs = capacity / windowMs

  const existing = rateLimitBuckets.get(key)

  const available =
    existing === undefined
      ? capacity
      : Math.min(
          capacity,
          existing.tokens + (now - existing.updatedAt) * refillPerMs
        )

  if (
    existing === undefined &&
    rateLimitBuckets.size >= RATE_LIMIT_SWEEP_THRESHOLD
  ) {
    sweepRateLimitBuckets(now)
  }

  if (available < 1) {
    // Persist the refilled figure so the wait shortens as time passes rather
    // than restarting on every rejected attempt.
    rateLimitBuckets.set(key, { tokens: available, updatedAt: now, windowMs })

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(1, Math.ceil((1 - available) / refillPerMs)),
      key,
    }
  }

  const remaining = available - 1
  rateLimitBuckets.set(key, { tokens: remaining, updatedAt: now, windowMs })

  return {
    allowed: true,
    remaining: Math.floor(remaining),
    retryAfterMs: 0,
    key,
  }
}

/**
 * Best-effort caller IP.
 *
 * `x-forwarded-for` is client-controlled unless a trusted proxy overwrites it,
 * and Vercel does overwrite it. Behind anything else, treat the value as a hint
 * rather than an identity — which is why IP is only ever the *fallback* scope,
 * and why nothing in this file makes an authorization decision from it.
 *
 * Returns `'unknown'` outside a request scope (a script, a test), which
 * collapses every such caller onto one bucket. That is the safe direction.
 */
async function callerIpAddress(): Promise<string> {
  try {
    const requestHeaders = await headers()

    const forwardedFor = requestHeaders.get('x-forwarded-for')

    if (forwardedFor !== null) {
      const first = forwardedFor.split(',')[0]?.trim()

      if (first !== undefined && first.length > 0) {
        return first
      }
    }

    const realIp = requestHeaders.get('x-real-ip')?.trim()

    if (realIp !== undefined && realIp.length > 0) {
      return realIp
    }
  } catch {
    // `headers()` throws outside a request scope. Fall through.
  }

  return 'unknown'
}

async function resolveRateLimitKey(
  name: string,
  scope: RateLimitScope,
  user: AuthenticatedUser | null
): Promise<string> {
  if (scope === 'global') {
    return `${name}:global`
  }

  if (scope === 'identity' && user !== null) {
    return `${name}:user:${user.id}`
  }

  return `${name}:ip:${await callerIpAddress()}`
}

/**
 * The rate-limit hook point.
 *
 * Intended for the three actions a stranger can reach — **intake submission**,
 * **review submission**, and **consultation request** — where the cost of an
 * abusive caller is a table full of junk rows and a mailbox full of
 * notifications. `withAction` calls it for you when `rateLimit` is present in
 * the config; call it directly from a route handler that does not go through
 * the wrapper.
 *
 * ```ts
 * const allowed = await rateLimit('intake.submit', {
 *   tokens: 3,
 *   windowMs: 60 * 60 * 1000,
 * }, caller)
 * if (!allowed.ok) return allowed
 * ```
 *
 * ## Production note — swap this for Redis
 *
 * The bucket map lives in the process. That is correct for a single Node
 * instance and *wrong* for any deployment that scales horizontally or runs on
 * serverless functions: N instances multiply the effective limit by N, and a
 * cold start resets a caller's quota. It is a speed bump against casual abuse,
 * not a defence against a determined one.
 *
 * Before this platform serves real traffic, replace {@link consumeToken} with a
 * shared store — Upstash Redis and `@upstash/ratelimit` are the smallest change
 * — keeping this function's signature so no call site moves. The signature is
 * already `async` for exactly that reason, even though the current
 * implementation needs no await beyond the header read.
 */
export async function rateLimit(
  name: string,
  rule: RateLimitRule,
  user?: AuthenticatedUser | null
): Promise<ActionResult<RateLimitVerdict>> {
  const key = await resolveRateLimitKey(
    name,
    rule.scope ?? 'identity',
    user ?? null
  )

  const verdict = consumeToken(key, rule)

  if (!verdict.allowed) {
    const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))

    return fail(
      'RATE_LIMITED',
      seconds < 60
        ? `That was a little too quick. Please try again in ${seconds} seconds.`
        : `That was a little too quick. Please try again in ${Math.ceil(seconds / 60)} minutes.`
    )
  }

  return ok(verdict)
}

// =============================================================================
// 4. Error translation
// =============================================================================

/**
 * Prisma error codes this platform knows how to explain.
 *
 * Everything else collapses to `INTERNAL`. The mapping is deliberately short:
 * a code that is not listed is a code nobody has decided a guest-facing
 * sentence for, and inventing one at the catch site is how Prisma text leaks.
 *
 * @see https://www.prisma.io/docs/orm/reference/error-reference
 */
const PRISMA_ERROR_MAP: Readonly<
  Record<
    string,
    { code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION'; message: string }
  >
> = {
  /** Unique constraint failed. */
  P2002: {
    code: 'CONFLICT',
    message: 'That already exists. Please adjust the details and try again.',
  },
  /** An operation depended on a record that was required but not found. */
  P2025: {
    code: 'NOT_FOUND',
    message: 'We could not find what you were looking for.',
  },
  /** Foreign key constraint failed. */
  P2003: {
    code: 'CONFLICT',
    message: 'Something this depends on is missing or still in use.',
  },
  /** Value too long for the column. */
  P2000: {
    code: 'VALIDATION',
    message: 'One of the values is too long. Please shorten it and try again.',
  },
}

/**
 * Structural test for a Stripe SDK error.
 *
 * Done by shape rather than `instanceof Stripe.errors.StripeError` on purpose:
 * importing the Stripe SDK here would drag it into the module graph of every
 * action, including the ones that never touch billing. The properties checked
 * are the two every `StripeError` carries.
 */
function isStripeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  if (!('type' in error) || !('rawType' in error)) {
    return false
  }

  return (
    typeof error.type === 'string' &&
    error.type.startsWith('Stripe') &&
    typeof error.rawType === 'string'
  )
}

/** A short, non-sensitive token that ties a guest's report to a server log. */
function newIncidentRef(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Turn anything a handler threw into a guest-safe {@link ActionFailure}.
 *
 * The contract this upholds (`CONTRACT.md` §5): no Prisma text, no Stripe text,
 * no stack, no column names, no ids the caller did not already have. The real
 * error is written to the server log alongside an incident ref that also
 * appears in the returned sentence, so a support conversation can find it
 * without the guest ever having seen the cause.
 *
 * The action's *input* is never logged. Intake forms carry allergies and home
 * addresses; a log line is not the place for them.
 */
function toActionFailure(error: unknown, actionName: string): ActionFailure {
  // A handler that called `redirect()` or `notFound()` signals through a thrown
  // sentinel that Next.js must see. Swallowing it would turn a navigation into
  // a silent failure, so it is rethrown before anything else looks at it.
  unstable_rethrow(error)

  if (isActionError(error)) {
    return error.toActionFailure()
  }

  if (error instanceof z.ZodError) {
    // A handler that parsed a nested payload itself and let the error escape.
    return zodFail(error)
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = PRISMA_ERROR_MAP[error.code]

    if (mapped !== undefined) {
      console.error(`[action:${actionName}] prisma ${error.code}`)
      return fail(mapped.code, mapped.message)
    }
  }

  const ref = newIncidentRef()

  if (isStripeError(error)) {
    console.error(`[action:${actionName}] stripe failure (ref ${ref})`, error)
  } else {
    console.error(
      `[action:${actionName}] unhandled failure (ref ${ref})`,
      error
    )
  }

  return fail(
    'INTERNAL',
    `Something went wrong on our end. Please try again. (ref ${ref})`
  )
}

// =============================================================================
// 5. withAction
// =============================================================================

/**
 * The access requirement of an action.
 *
 *  - `'PUBLIC'` — anyone, signed in or not. `context.user` may be `null`.
 *  - `'SESSION'` — any signed-in, active user, whatever their role.
 *  - a `Role` — that role or higher, per `ROLE_HIERARCHY`.
 */
export type ActionAuth = 'PUBLIC' | 'SESSION' | Role

/** What a `'PUBLIC'` handler receives. */
export interface PublicActionContext {
  /** `null` when the caller is not signed in. */
  readonly user: AuthenticatedUser | null
  readonly db: typeof prisma
  /** The action's configured name, for logging inside the handler. */
  readonly actionName: string
}

/** What every other handler receives. */
export interface AuthenticatedActionContext {
  readonly user: AuthenticatedUser
  readonly db: typeof prisma
  readonly actionName: string
}

/**
 * Selects the context shape from the declared auth requirement, so a handler
 * behind `auth: 'ADMIN'` never has to null-check `context.user` and a handler
 * behind `auth: 'PUBLIC'` cannot forget to.
 */
export type ActionContextFor<TAuth extends ActionAuth> = TAuth extends 'PUBLIC'
  ? PublicActionContext
  : AuthenticatedActionContext

/**
 * A path to revalidate. The bare string form is `revalidatePath(path)`; the
 * object form passes Next's `'page' | 'layout'` selector.
 */
export type RevalidatePathTarget =
  string | { readonly path: string; readonly type: 'page' | 'layout' }

/** A `cacheLife` profile name, or an inline expiry. */
export type CacheProfile = string | { readonly expire?: number }

/**
 * A tag to invalidate.
 *
 * The bare string form calls `updateTag(tag)`, which expires immediately and
 * gives the caller read-your-own-writes semantics — the right default inside a
 * Server Action, where the component that rendered the form is about to re-read
 * the data it just changed. The object form calls
 * `revalidateTag(tag, profile)`, for tags that may go stale lazily.
 */
export type RevalidateTagTarget =
  string | { readonly tag: string; readonly profile: CacheProfile }

/** Everything `withAction` needs to know that is not the handler itself. */
export interface ActionConfig<TParsed, TRaw, TAuth extends ActionAuth> {
  /**
   * A stable identifier, `'<domain>.<verb>'` — `'appointment.cancel'`. It
   * appears in server logs and is the default rate-limit bucket name, so it
   * should match the route key in `@mannachef/api-contract` where one exists.
   */
  readonly name: string

  /** @see ActionAuth */
  readonly auth: TAuth

  /**
   * The zod schema the raw payload is `safeParse`d against. Its output type
   * becomes the handler's `input` parameter and its input type becomes the
   * action's own parameter, so callers get inference in both directions with
   * no casts.
   */
  readonly input: z.ZodType<TParsed, TRaw>

  /** Omit for actions a stranger cannot reach. @see rateLimit */
  readonly rateLimit?: RateLimitRule

  /** Applied on success only. @see RevalidatePathTarget */
  readonly revalidatePaths?: readonly RevalidatePathTarget[]

  /** Applied on success only. @see RevalidateTagTarget */
  readonly revalidateTags?: readonly RevalidateTagTarget[]
}

/** The function `withAction` wraps. */
export type ActionHandler<TParsed, TAuth extends ActionAuth, TData> = (
  context: ActionContextFor<TAuth>,
  input: TParsed
) => Promise<ActionResult<TData>>

/** The function `withAction` returns — this is what a component imports. */
export type Action<TRaw, TData> = (raw: TRaw) => Promise<ActionResult<TData>>

// -----------------------------------------------------------------------------
// 5a. The guest-viewer scope (MCV-072)
// -----------------------------------------------------------------------------

/**
 * Set for the duration of a {@link readAsGuest} call.
 *
 * `AsyncLocalStorage` propagates through `await`, so the flag covers the whole
 * of the wrapped action — including everything the handler awaits — and covers
 * *only* that. Two concurrent renders, or a `Promise.all` where one branch is a
 * guest read and another is a privileged one, do not see each other's store.
 */
const guestViewerScope = new AsyncLocalStorage<true>()

/**
 * Run a `'PUBLIC'` action with **no viewer**, without reading cookies.
 *
 * ## The problem this solves
 *
 * `withAction` resolves the session before it does anything else, and
 * `getSessionUser()` calls Auth.js `auth()`, which reads the session cookie.
 * Reading a cookie is a dynamic API: it opts the surrounding render out of
 * static generation for good. So *any* page that called *any* action — even a
 * `'PUBLIC'` one that only ever wanted the published menu — was silently forced
 * to render per-request, and its `export const revalidate` was inert. The whole
 * marketing site was dynamic for the sake of a session none of it displayed.
 *
 * Inside this scope, a `'PUBLIC'` action skips session resolution entirely and
 * its handler sees `ctx.user === null` — the same context a genuinely
 * signed-out visitor produces. No cookie is read, so the render stays
 * static/ISR-eligible and `revalidate` means something again.
 *
 * ## Why per call site rather than per action
 *
 * The obvious alternative is a flag on `ActionConfig` — mark an action
 * "anonymous" once, at its definition. That is the wrong granularity here, and
 * `listMenuItems` is the proof: the public menu page needs the guest view of it
 * (published, in-season, no cost prices) so the page can be prerendered, while
 * `/admin/menu` needs the *viewer-aware* view of the very same action, because
 * an `ADMIN` passing `includeInactive` is exactly how the kitchen sees its
 * drafts. Viewer-sensitivity is therefore a property of the **call**, not of
 * the action, and a per-action flag could only serve one of those two callers.
 *
 * The trade-off that buys: the decision is not made once, it is made at every
 * call site, and a call site that forgets simply gets today's behaviour — a
 * session read and a dynamic page. That is the right default. The failure mode
 * of forgetting is a slow page; the failure mode of the opposite default
 * (anonymous unless told otherwise) would be an admin screen quietly losing the
 * rows it is meant to show, which is worse and much harder to notice.
 *
 * ## Why this is safe
 *
 * The scope can only ever *narrow* what an action returns. `ctx.user === null`
 * is the least privileged context that exists, and every `'PUBLIC'` handler
 * already treats it as the visibility floor — `const role = ctx.user?.role ??
 * null` is the first line of all five menu reads. Wrapping the wrong call
 * cannot widen access; at worst it hides a row from someone entitled to see it.
 *
 * Two deliberate non-effects:
 *
 *  - **Non-`'PUBLIC'` actions are unaffected.** A `'SESSION'` or `Role` action
 *    called inside the scope still resolves its session and still enforces its
 *    check, because skipping it would turn an authorization requirement into a
 *    caller-supplied option. Such a call keeps the page dynamic, correctly:
 *    its answer really does depend on who is asking.
 *  - **Rate limiting is unaffected.** A `'PUBLIC'` action carrying a
 *    `rateLimit` still falls back to the IP bucket, and `callerIpAddress()`
 *    reads `headers()` — also a dynamic API. No read on the public site is
 *    rate limited (see the note on {@link rateLimit}: the three that are are
 *    all submissions), so this does not cost the marketing pages anything; it
 *    does mean `readAsGuest` around a rate-limited action would not make it
 *    prerenderable.
 *
 * ## Use
 *
 * ```ts
 * const result = await readAsGuest(listMenuItems, {
 *   signatureOnly: true,
 *   page: 1,
 *   pageSize: 3,
 *   sortBy: 'CURATED',
 *   sortDirection: 'asc',
 * })
 * ```
 *
 * One call, one action, one explicit decision — including inside
 * `generateStaticParams`, where there is no request scope at all and this is
 * the difference between enumerating the menu and giving up on it.
 */
export async function readAsGuest<TRaw, TData>(
  action: Action<TRaw, TData>,
  raw: TRaw
): Promise<ActionResult<TData>> {
  return guestViewerScope.run(true, () => action(raw))
}

/**
 * Revalidate, ignoring failures.
 *
 * The mutation has already committed. A cache invalidation that throws — a tag
 * that is not in use, a call made outside a Server Action scope — must not turn
 * a successful save into an error the guest is asked to retry, because retrying
 * would apply the change twice.
 */
function applyRevalidation<TParsed, TRaw, TAuth extends ActionAuth>(
  config: ActionConfig<TParsed, TRaw, TAuth>
): void {
  for (const target of config.revalidatePaths ?? []) {
    try {
      if (typeof target === 'string') {
        revalidatePath(target)
      } else {
        revalidatePath(target.path, target.type)
      }
    } catch (error) {
      console.error(`[action:${config.name}] revalidatePath failed`, error)
    }
  }

  for (const target of config.revalidateTags ?? []) {
    try {
      if (typeof target === 'string') {
        updateTag(target)
      } else {
        revalidateTag(target.tag, target.profile)
      }
    } catch (error) {
      console.error(`[action:${config.name}] revalidateTag failed`, error)
    }
  }
}

/**
 * The wrapper every Server Action uses.
 *
 * ## Order of operations
 *
 * Exactly the sequence `CONTRACT.md` §5 prescribes:
 *
 *  1. **Resolve the session.** For every requirement except one: a `'PUBLIC'`
 *     action running inside {@link readAsGuest} skips it and gets
 *     `ctx.user === null`, so a page that only wants the published menu never
 *     touches a cookie and stays prerenderable. Everywhere else the session is
 *     resolved unconditionally — even for `'PUBLIC'`, because a signed-in
 *     guest's review should be attributed to them.
 *  2. **Enforce the minimum role.** `'SESSION'` requires only a live session;
 *     a `Role` is compared with `hasRoleAtLeast`.
 *  3. **Rate limit**, when configured. Placed after the identity is known so
 *     the bucket can be per-user rather than per-IP, and before validation so a
 *     flood costs a map lookup instead of a parse.
 *  4. **`safeParse` the raw input.** The handler never sees an unvalidated
 *     value. A failure becomes a `VALIDATION` result whose `fieldErrors` are
 *     keyed for React Hook Form.
 *  5. **Run the handler.**
 *  6. **Catch everything.** Prisma `P2002` → `CONFLICT`, `P2025` → `NOT_FOUND`;
 *     an `ActionError` keeps its own code; a `redirect()` sentinel is rethrown;
 *     anything else is logged in full server-side and returned as a generic
 *     `INTERNAL`. No Prisma or Stripe text ever reaches the browser.
 *  7. **Revalidate — on success only.** A failed mutation changed nothing, so
 *     busting the cache would only cost a re-render.
 *
 * Ownership (§5 step 4) is intentionally *not* automated here. It needs the row
 * the handler is about to touch, it differs per action, and the guards above
 * return the row, so folding it into the wrapper would mean fetching twice.
 * Call the matching `require*Ownership` guard as the handler's first statement.
 *
 * ## Example
 *
 * ```ts
 * 'use server'
 *
 * export const cancelAppointment = withAction(
 *   {
 *     name: 'appointment.cancel',
 *     auth: 'SESSION',
 *     input: appointmentCancelSchema,
 *     revalidatePaths: ['/portal/appointments'],
 *   },
 *   async (ctx, input) => {
 *     const owned = await requireAppointmentOwnership(ctx.user, input.appointmentId)
 *     if (!owned.ok) return owned
 *
 *     const appointment = await ctx.db.chefAppointment.update({
 *       where: { id: owned.data.id },
 *       data: {
 *         status: 'CANCELLED',
 *         cancelledAt: new Date(),
 *         cancelledById: ctx.user.id,
 *         cancellationReason: input.reason,
 *       },
 *     })
 *
 *     return ok({ id: appointment.id, status: appointment.status })
 *   }
 * )
 * ```
 *
 * `cancelAppointment` is typed `(raw: AppointmentCancelInput) =>
 * Promise<ActionResult<{ id: string; status: AppointmentStatus }>>` — both ends
 * inferred, neither annotated.
 */
export function withAction<TParsed, TRaw, TAuth extends ActionAuth, TData>(
  config: ActionConfig<TParsed, TRaw, TAuth>,
  handler: ActionHandler<TParsed, TAuth, TData>
): Action<TRaw, TData> {
  return async (raw: TRaw): Promise<ActionResult<TData>> => {
    // Widened out of the generic so the comparisons below narrow. `TAuth` is a
    // type parameter, and TypeScript will not narrow a value by its type
    // parameter's constituents.
    const requirement: ActionAuth = config.auth

    // --- 1. Session --------------------------------------------------------
    // The one path that does not resolve a session. `auth()` reads the session
    // cookie, and a cookie read is a dynamic API — so resolving here is what
    // made every page that called any action render per-request. A `'PUBLIC'`
    // action inside a `readAsGuest` scope is asking for the signed-out view by
    // name, and the signed-out view needs no cookie to compute. See
    // {@link readAsGuest} for why the opt-in is per call site and why it can
    // only narrow.
    const asGuest =
      requirement === 'PUBLIC' && guestViewerScope.getStore() === true

    const sessionUser = asGuest ? null : await getSessionUser()

    // --- 2. Role -----------------------------------------------------------
    if (requirement !== 'PUBLIC') {
      if (sessionUser === null) {
        return fail('UNAUTHENTICATED')
      }

      if (
        requirement !== 'SESSION' &&
        !hasRoleAtLeast(sessionUser.role, requirement)
      ) {
        return fail('FORBIDDEN')
      }
    }

    // --- 3. Rate limit -----------------------------------------------------
    if (config.rateLimit !== undefined) {
      const allowance = await rateLimit(
        config.name,
        config.rateLimit,
        sessionUser
      )

      if (!allowance.ok) {
        return allowance
      }
    }

    // --- 4. Validate -------------------------------------------------------
    const parsed = config.input.safeParse(raw)

    if (!parsed.success) {
      return zodFail(parsed.error)
    }

    // --- 5. Handle ---------------------------------------------------------
    let result: ActionResult<TData>

    try {
      // The two context shapes differ only in whether `user` may be `null`, and
      // step 2 has already ruled that out for every non-`PUBLIC` requirement.
      // `ActionContextFor<TAuth>` is a conditional type over an unresolved type
      // parameter, so it stays deferred and cannot be satisfied by a value; the
      // assertion states the invariant the branch above enforces.
      const context = {
        user: sessionUser,
        db: prisma,
        actionName: config.name,
      } as ActionContextFor<TAuth>

      result = await handler(context, parsed.data)
    } catch (error) {
      // --- 6. Translate ----------------------------------------------------
      return toActionFailure(error, config.name)
    }

    // --- 7. Revalidate, success only ---------------------------------------
    if (result.ok) {
      applyRevalidation(config)
    }

    return result
  }
}
