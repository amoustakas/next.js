// mannachef/apps/web/src/server/actions/user.ts

'use server'

/**
 * Accounts — the profile a person keeps about themselves, and the two
 * administrative levers that decide what they may do and whether they may do
 * anything at all.
 *
 * ## Three actions, three completely different answers to "who may"
 *
 *  - {@link updateUserProfile} — **self only**. Not "self or admin": there is
 *    no supported path by which one person edits another's display name,
 *    avatar, telephone number, time zone or language. Those are statements a
 *    person makes about themselves, and a concierge who needs to correct one
 *    asks the person. The two things an administrator legitimately changes
 *    about somebody else's account are the two below, and both demand a
 *    recorded reason.
 *  - {@link assignUserRole} — `SUPER_ADMIN`, with four separate refusals.
 *  - {@link setUserActive} — `ADMIN`, with the rank rule and the last-super-admin
 *    rule.
 *
 * ## The four refusals on a role change
 *
 * `roleAssignmentSchema` catches self-escalation *when the payload names the
 * actor*, which a browser has no reason to do honestly. The action therefore
 * re-derives the actor from the session and applies all four rules against it:
 *
 * | Refusal                                            | Code        |
 * | -------------------------------------------------- | ----------- |
 * | granting a role **at or above** the actor's own     | `FORBIDDEN` |
 * | changing an account **at or above** the actor's own | `FORBIDDEN` |
 * | removing the **last active `SUPER_ADMIN`**          | `CONFLICT`  |
 * | assigning the role the account already holds        | `CONFLICT`  |
 *
 * The first is stricter than `canAssignRole` in `@mannachef/validators`, which
 * permits an actor to grant their own rank. That is the right general rule for
 * a hierarchy and the wrong rule for this platform: an actor who may mint a
 * peer may mint an unbounded number of peers, and every one of them may then
 * demote the original. `canAssignRole` is still consulted first, so the
 * platform's rule is visibly a *tightening* of the shared one rather than a
 * competing definition of it.
 *
 * Self-demotion is the one place the second rule yields — you may step down
 * from `SUPER_ADMIN` — which is precisely why the third rule exists.
 *
 * ## Where the audit reason goes
 *
 * There is no `AuditLog` model in `packages/db/prisma/schema.prisma`, and
 * inventing a column is not on the table. `reason` is therefore recorded in the
 * two places the schema does offer, by {@link recordAccountAudit}:
 *
 *  1. **On the household record**, as a `ClientNote` with
 *     `visibility: 'ADMIN_ONLY'`, whenever the account has a `ClientProfile`.
 *     That is a real, queryable, permanently-stored artefact attached to the
 *     person it concerns, and `ADMIN_ONLY` keeps it away from the household
 *     itself — `requireClientNoteOwnership` enforces that matrix.
 *  2. **In the server audit log**, always, as a single structured line naming
 *     the actor, the subject, the change and the reason. Ids and the reason
 *     only; nothing that could carry a secret.
 *
 * An account with no `ClientProfile` — a staff account, most obviously — leaves
 * only the log line. That is a real gap and it is named here rather than
 * papered over: closing it properly means an `AuditLog` table, which is a
 * schema change and therefore somebody else's task. The reason is also returned
 * in the action's result so the surface that requested the change can display
 * what was recorded.
 */

import {
  ROLE_HIERARCHY,
  canAssignRole,
  cuidSchema,
  hasRoleAtLeast,
  isSelfDeactivation,
  isSelfRoleEscalation,
  paginationToSkipTake,
  roleAssignmentSchema,
  userActivationSchema,
  userFilterSchema,
  userProfileUpdateSchema,
  type Role,
  type SortDirection,
  type UserSortBy,
} from '@mannachef/validators'
import { emptyInputSchema, type PageMeta } from '@mannachef/api-contract'
import { z } from 'zod'

import { fail, ok, type ActionResult } from '@/server/actions/types'
import { Prisma } from '@/server/db'
import { withAction, type AuthenticatedUser } from '@/server/guards'

// =============================================================================
// 0. Constants
// =============================================================================

const ACCOUNT_PATHS = [
  '/admin/users',
  '/admin/staff',
  '/portal/account',
  '/portal',
] as const

const ACCOUNT_TAGS = ['users', 'session'] as const

// =============================================================================
// 1. Local input schemas
// =============================================================================

const userIdSchema = z.object({ userId: cuidSchema }).strict()

// =============================================================================
// 2. Projections
// =============================================================================

/**
 * What an administrator, or the account holder themselves, may read.
 *
 * `email` is on it, which is why every action using it is either `ADMIN` or
 * pinned to the caller's own id. There is no third projection for a wider
 * audience because no wider audience reads accounts: a chef's public identity
 * comes from `StaffProfile` through `staff.ts`, and a household's from
 * `ClientProfile` through `client.ts`.
 */
const ACCOUNT_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  role: true,
  phone: true,
  timeZone: true,
  locale: true,
  isActive: true,
  lastLoginAt: true,
  deactivatedAt: true,
  createdAt: true,
  updatedAt: true,
  clientProfile: { select: { id: true } },
  staffProfile: { select: { id: true } },
} satisfies Prisma.UserSelect

type AccountPayload = Prisma.UserGetPayload<{ select: typeof ACCOUNT_SELECT }>

export interface AccountView {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  readonly emailVerified: Date | null
  readonly image: string | null
  readonly role: Role
  readonly phone: string | null
  readonly timeZone: string
  readonly locale: string
  readonly isActive: boolean
  readonly lastLoginAt: Date | null
  readonly deactivatedAt: Date | null
  readonly clientProfileId: string | null
  readonly staffProfileId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface AccountListView {
  readonly items: readonly AccountView[]
  readonly meta: PageMeta
}

/** An administrative change to an account, with what was recorded about it. */
export interface AccountChangeView {
  readonly account: AccountView
  /** The reason, exactly as it was recorded. */
  readonly reason: string
  /**
   * Whether the reason reached a durable row as well as the server log — see
   * the file docblock. `false` means the account has no `ClientProfile`, so the
   * log line is the only record.
   */
  readonly reasonPersisted: boolean
}

function buildPageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0

  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  }
}

function toAccountView(row: AccountPayload): AccountView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    role: row.role,
    phone: row.phone,
    timeZone: row.timeZone,
    locale: row.locale,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt,
    deactivatedAt: row.deactivatedAt,
    clientProfileId: row.clientProfile?.id ?? null,
    staffProfileId: row.staffProfile?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// =============================================================================
// 3. The audit trail
// =============================================================================

/**
 * Record why an account was changed.
 *
 * See the file docblock for why this writes a `ClientNote` rather than an
 * `AuditLog` row. Two properties are worth stating at the call site:
 *
 *  - The note is `ADMIN_ONLY` and pinned. `requireClientNoteOwnership` and
 *    `noteVisibilityScope` in `crm.ts` both read that visibility as "`ADMIN`
 *    and above", so the household never sees the internal wording of a decision
 *    about their own account — which is the whole reason the enum has four
 *    members rather than two.
 *  - It runs inside the caller's transaction, so a failure to record the reason
 *    rolls back the change it was recording. An unexplained role change is
 *    worse than a role change that did not happen.
 *
 * The log line carries ids and the operator's own words. It never carries an
 * email address, a token, or anything else from `CONTRACT.md` §5's list.
 */
async function recordAccountAudit(
  tx: Prisma.TransactionClient,
  audit: {
    readonly actor: AuthenticatedUser
    readonly subjectUserId: string
    readonly subjectClientProfileId: string | null
    readonly change: string
    readonly reason: string
  }
): Promise<boolean> {
  console.info(
    `[account-audit] actor=${audit.actor.id} subject=${audit.subjectUserId} change=${audit.change} reason=${JSON.stringify(audit.reason)}`
  )

  if (audit.subjectClientProfileId === null) {
    return false
  }

  await tx.clientNote.create({
    data: {
      clientProfileId: audit.subjectClientProfileId,
      authorId: audit.actor.id,
      body: `${audit.change} ${audit.reason}`,
      visibility: 'ADMIN_ONLY',
      pinned: true,
    },
    select: { id: true },
  })

  return true
}

/**
 * Would removing this account's `SUPER_ADMIN` standing leave nobody holding it?
 *
 * Counts the *other* active super administrators. An account that is not an
 * active `SUPER_ADMIN` cannot be the last one, so the question short-circuits
 * to `false` and costs one query rather than two.
 *
 * Read inside the same transaction as the write it guards, so two
 * simultaneous demotions of the last two super administrators cannot both see a
 * peer and both proceed.
 */
async function wouldStrandTheKingdom(
  tx: Prisma.TransactionClient,
  subject: {
    readonly id: string
    readonly role: Role
    readonly isActive: boolean
  }
): Promise<boolean> {
  if (subject.role !== 'SUPER_ADMIN' || !subject.isActive) {
    return false
  }

  const peers = await tx.user.count({
    where: { role: 'SUPER_ADMIN', isActive: true, id: { not: subject.id } },
  })

  return peers === 0
}

// =============================================================================
// 4. The profile a person keeps about themselves
// =============================================================================

/**
 * Amend your own account.
 *
 * `userProfileUpdateSchema` carries an `id` because it is an update schema, and
 * that id is checked against the session rather than trusted: anything but the
 * caller's own is `FORBIDDEN`. Self only — see the file docblock for why an
 * `ADMIN` branch is deliberately absent, even though the schema's own docblock
 * contemplates one.
 *
 * The schema is built by `buildUpdateSchema`, which strips the `.default(...)`
 * on `timeZone` and `locale` before making the shape partial. That strip is the
 * difference between correcting the spelling of your name and being silently
 * relocated to Toronto and switched to Canadian English, and the conditional
 * spreads below carry the same property into the `UPDATE`: a key the caller did
 * not send is not written.
 *
 * `email`, `role` and `isActive` are not on the schema at all. Email identity
 * belongs to the Auth.js adapter and its verification flow; the other two are
 * the actions below.
 */
export const updateUserProfile = withAction(
  {
    name: 'user.profile.update',
    auth: 'SESSION',
    input: userProfileUpdateSchema,
    revalidatePaths: ACCOUNT_PATHS,
    revalidateTags: ACCOUNT_TAGS,
  },
  async (ctx, input): Promise<ActionResult<AccountView>> => {
    if (input.id !== ctx.user.id) {
      return fail(
        'FORBIDDEN',
        'You may only change the details on your own account.'
      )
    }

    const updated = await ctx.db.user.update({
      where: { id: ctx.user.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.image === undefined ? {} : { image: input.image }),
      },
      select: ACCOUNT_SELECT,
    })

    return ok(toAccountView(updated))
  }
)

// =============================================================================
// 5. Role assignment
// =============================================================================

/**
 * Change what somebody is allowed to do.
 *
 * `SUPER_ADMIN`, and the single most consequential write in the application.
 * The four refusals are tabulated in the file docblock; this is where each one
 * is applied, in that order, inside one transaction against freshly-read rows.
 *
 * ## The actor is the session, never the payload
 *
 * `roleAssignmentSchema` accepts `actorUserId` and `actorRole` so that a form
 * can render the refusal before the click. Both are ignored here: the values
 * handed to `isSelfRoleEscalation` and `canAssignRole` come from `ctx.user`. A
 * payload that omits them — or lies in them — therefore changes nothing about
 * the verdict, which is exactly what the schema's own docblock asks the action
 * to guarantee.
 *
 * ## Demotion out of the kitchen unlists the chef
 *
 * An account dropping below `CHEF_STAFF` keeps its `StaffProfile` — the
 * bookings hanging off it are history and must not vanish — but stops being
 * listed and stops accepting new households in the same transaction. Leaving a
 * demoted chef bookable on the marketing site is the kind of gap that is only
 * noticed by the household who books them.
 */
export const assignUserRole = withAction(
  {
    name: 'user.role.assign',
    auth: 'SUPER_ADMIN',
    input: roleAssignmentSchema,
    revalidatePaths: ACCOUNT_PATHS,
    revalidateTags: ACCOUNT_TAGS,
  },
  async (ctx, input): Promise<ActionResult<AccountChangeView>> => {
    const actorRank = ROLE_HIERARCHY[ctx.user.role]

    // The shared rule first, so the platform's stricter one below reads as the
    // tightening it is rather than as a second, competing definition.
    if (!canAssignRole(ctx.user.role, input.role)) {
      return fail(
        'FORBIDDEN',
        'You cannot grant an access level above your own.',
        { role: ['Please choose a level below your own.'] }
      )
    }

    if (ROLE_HIERARCHY[input.role] >= actorRank) {
      return fail(
        'FORBIDDEN',
        'You cannot grant an access level at or above your own.',
        {
          role: [
            'A super administrator is appointed outside the application, not from within it.',
          ],
        }
      )
    }

    // Defence in depth. With the rule above in place this is unreachable, and
    // it is kept because "unreachable" is a property of the current ordering
    // rather than of the domain: reorder the checks and this is the one that
    // still refuses somebody promoting themselves.
    if (
      isSelfRoleEscalation({
        userId: input.userId,
        role: input.role,
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
      })
    ) {
      return fail(
        'FORBIDDEN',
        'You cannot raise your own access level — ask someone above you to make this change.',
        { role: ['This would raise your own access level.'] }
      )
    }

    const outcome = await ctx.db.$transaction(async (tx) => {
      const subject = await tx.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          role: true,
          isActive: true,
          clientProfile: { select: { id: true } },
          staffProfile: { select: { id: true } },
        },
      })

      if (subject === null) {
        return { kind: 'notFound' as const }
      }

      // Peers and superiors are out of reach — except yourself, because
      // stepping down is not an attack on the hierarchy. The last-super-admin
      // rule below is what stops it from being an attack on the platform.
      if (
        subject.id !== ctx.user.id &&
        ROLE_HIERARCHY[subject.role] >= actorRank
      ) {
        return { kind: 'peer' as const }
      }

      if (subject.role === input.role) {
        return { kind: 'noop' as const }
      }

      if (
        input.role !== 'SUPER_ADMIN' &&
        (await wouldStrandTheKingdom(tx, subject))
      ) {
        return { kind: 'lastSuperAdmin' as const }
      }

      const updated = await tx.user.update({
        where: { id: subject.id },
        data: { role: input.role },
        select: ACCOUNT_SELECT,
      })

      if (
        subject.staffProfile !== null &&
        !hasRoleAtLeast(input.role, 'CHEF_STAFF')
      ) {
        await tx.staffProfile.update({
          where: { id: subject.staffProfile.id },
          data: { isPubliclyListed: false, isAcceptingClients: false },
          select: { id: true },
        })
      }

      const reasonPersisted = await recordAccountAudit(tx, {
        actor: ctx.user,
        subjectUserId: subject.id,
        subjectClientProfileId: subject.clientProfile?.id ?? null,
        change: `Access level changed from ${subject.role} to ${input.role}.`,
        reason: input.reason,
      })

      return { kind: 'changed' as const, row: updated, reasonPersisted }
    })

    switch (outcome.kind) {
      case 'changed':
        return ok({
          account: toAccountView(outcome.row),
          reason: input.reason,
          reasonPersisted: outcome.reasonPersisted,
        })

      case 'notFound':
        return fail('NOT_FOUND', 'We could not find that account.')

      case 'peer':
        return fail(
          'FORBIDDEN',
          'You cannot change the access level of an account at or above your own.'
        )

      case 'noop':
        return fail(
          'CONFLICT',
          'That account already holds this access level.',
          { role: ['Nothing would change.'] }
        )

      case 'lastSuperAdmin':
        return fail(
          'CONFLICT',
          'This is the last super administrator. Appoint another one before stepping down.',
          {
            userId: [
              'The platform must keep at least one active super administrator.',
            ],
          }
        )

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

// =============================================================================
// 6. Activation
// =============================================================================

/**
 * Close an account, or reopen one.
 *
 * `ADMIN`. Withdrawing access is operational work — a departing colleague, a
 * household that asked to be forgotten — whereas *granting* it is
 * {@link assignUserRole}'s `SUPER_ADMIN`. The asymmetry is deliberate: the
 * dangerous direction of an access change is upward.
 *
 * ## What is enforced here
 *
 *  - **Not yourself.** `isSelfDeactivation` from `@mannachef/validators`, given
 *    the actor from the session rather than from the payload, so a body that
 *    omits `actorUserId` does not escape the rule the schema applies when it is
 *    present. Locking yourself out is an accident nobody can undo alone.
 *  - **Not a peer or a superior.** The same rank rule the role change applies,
 *    for the same reason: `ADMIN` closing a `SUPER_ADMIN`'s account is a
 *    privilege escalation with extra steps.
 *  - **Not the last super administrator**, whoever is asking.
 *  - **Not a no-op**, so the audit trail contains only real changes.
 *
 * ## What the write does
 *
 * `deactivatedAt` is stamped from the clock when `isActive` becomes `false` and
 * cleared to `null` when it becomes `true`, so the column can never disagree
 * with the flag — `userActivationSchema` does not accept it from the caller,
 * for exactly this reason.
 *
 * Sessions are deleted on deactivation. The `session` callback in
 * `@/server/auth` already revokes them on the next read, so this is belt and
 * braces rather than the mechanism; what it buys is that access ends at the
 * moment of the decision instead of at the closed account's next request.
 *
 * A deactivated chef is unlisted and stops accepting households, matching the
 * demotion path above.
 */
export const setUserActive = withAction(
  {
    name: 'user.activation.set',
    auth: 'ADMIN',
    input: userActivationSchema,
    revalidatePaths: ACCOUNT_PATHS,
    revalidateTags: ACCOUNT_TAGS,
  },
  async (ctx, input): Promise<ActionResult<AccountChangeView>> => {
    if (
      isSelfDeactivation({
        userId: input.userId,
        isActive: input.isActive,
        actorUserId: ctx.user.id,
      })
    ) {
      return fail(
        'FORBIDDEN',
        'You cannot close your own account — ask another administrator to do it.',
        { userId: ['This is your own account.'] }
      )
    }

    const actorRank = ROLE_HIERARCHY[ctx.user.role]
    const now = new Date()

    const outcome = await ctx.db.$transaction(async (tx) => {
      const subject = await tx.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          role: true,
          isActive: true,
          clientProfile: { select: { id: true } },
          staffProfile: { select: { id: true } },
        },
      })

      if (subject === null) {
        return { kind: 'notFound' as const }
      }

      if (
        subject.id !== ctx.user.id &&
        ROLE_HIERARCHY[subject.role] >= actorRank
      ) {
        return { kind: 'peer' as const }
      }

      if (subject.isActive === input.isActive) {
        return { kind: 'noop' as const }
      }

      if (!input.isActive && (await wouldStrandTheKingdom(tx, subject))) {
        return { kind: 'lastSuperAdmin' as const }
      }

      const updated = await tx.user.update({
        where: { id: subject.id },
        data: {
          isActive: input.isActive,
          deactivatedAt: input.isActive ? null : now,
        },
        select: ACCOUNT_SELECT,
      })

      if (!input.isActive) {
        await tx.session.deleteMany({ where: { userId: subject.id } })

        if (subject.staffProfile !== null) {
          await tx.staffProfile.update({
            where: { id: subject.staffProfile.id },
            data: { isPubliclyListed: false, isAcceptingClients: false },
            select: { id: true },
          })
        }
      }

      const reasonPersisted = await recordAccountAudit(tx, {
        actor: ctx.user,
        subjectUserId: subject.id,
        subjectClientProfileId: subject.clientProfile?.id ?? null,
        change: input.isActive
          ? 'Account reopened.'
          : 'Account closed and sessions revoked.',
        reason: input.reason,
      })

      return { kind: 'changed' as const, row: updated, reasonPersisted }
    })

    switch (outcome.kind) {
      case 'changed':
        return ok({
          account: toAccountView(outcome.row),
          reason: input.reason,
          reasonPersisted: outcome.reasonPersisted,
        })

      case 'notFound':
        return fail('NOT_FOUND', 'We could not find that account.')

      case 'peer':
        return fail(
          'FORBIDDEN',
          'You cannot close or reopen an account at or above your own access level.'
        )

      case 'noop':
        return fail(
          'CONFLICT',
          input.isActive
            ? 'That account is already open.'
            : 'That account is already closed.',
          { isActive: ['Nothing would change.'] }
        )

      case 'lastSuperAdmin':
        return fail(
          'CONFLICT',
          'This is the last super administrator. Appoint another one before closing this account.',
          {
            userId: [
              'The platform must keep at least one active super administrator.',
            ],
          }
        )

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

// =============================================================================
// 7. Reading
// =============================================================================

function userOrderBy(
  sortBy: UserSortBy,
  direction: SortDirection
): Prisma.UserOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    case 'NAME':
      return [{ name: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'EMAIL':
      return [{ email: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'LAST_LOGIN':
      return [
        { lastLoginAt: { sort: direction, nulls: 'last' } },
        { id: 'asc' },
      ]

    case 'ROLE':
      return [{ role: direction }, { createdAt: 'desc' }, { id: 'asc' }]

    default: {
      // A new member of `userSortBySchema` is a compile error here rather than
      // a silently unordered list.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * The account list.
 *
 * `ADMIN`. There is no client-facing account list and there is no narrower
 * variant of this action, because `ACCOUNT_SELECT` reads `email` and a filter
 * over every account is exactly the shape of query that turns into a mailing
 * list.
 *
 * `activeOnly` defaults to `true` in `userFilterSchema` — a closed account is a
 * tombstone — so seeing former colleagues takes an explicit `activeOnly=false`.
 */
export const listUsers = withAction(
  {
    name: 'user.list',
    auth: 'ADMIN',
    input: userFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<AccountListView>> => {
    const filters: Prisma.UserWhereInput[] = []

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { email: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    if (filter.roles.length > 0) {
      filters.push({ role: { in: [...filter.roles] } })
    }

    if (filter.activeOnly) {
      filters.push({ isActive: true })
    }

    if (filter.neverSignedInOnly) {
      filters.push({ lastLoginAt: null })
    }

    if (filter.verifiedEmailOnly) {
      filters.push({ emailVerified: { not: null } })
    }

    if (filter.createdFrom !== undefined) {
      filters.push({ createdAt: { gte: filter.createdFrom } })
    }

    if (filter.createdTo !== undefined) {
      filters.push({ createdAt: { lte: filter.createdTo } })
    }

    if (filter.lastLoginFrom !== undefined) {
      filters.push({ lastLoginAt: { gte: filter.lastLoginFrom } })
    }

    if (filter.lastLoginTo !== undefined) {
      filters.push({ lastLoginAt: { lte: filter.lastLoginTo } })
    }

    const where: Prisma.UserWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.user.count({ where }),
      ctx.db.user.findMany({
        where,
        select: ACCOUNT_SELECT,
        orderBy: userOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toAccountView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * One account, for an administrator.
 *
 * `ADMIN`, for the same reason the list is. A person reading their *own*
 * account uses {@link readMyAccount}, which needs no id and therefore has
 * nothing to check ownership of.
 */
export const readUserAccount = withAction(
  {
    name: 'user.read',
    auth: 'ADMIN',
    input: userIdSchema,
  },
  async (ctx, input): Promise<ActionResult<AccountView>> => {
    const row = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: ACCOUNT_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that account.')
    }

    return ok(toAccountView(row))
  }
)

/**
 * Your own account.
 *
 * `emptyInputSchema` is `z.strictObject({})`, so a stray `userId` is a
 * validation failure rather than something this action has to remember to
 * ignore. With no id in the payload there is nothing to check ownership of —
 * the account is whichever one the session names, which is the strongest form
 * the check can take.
 */
export const readMyAccount = withAction(
  {
    name: 'user.read.mine',
    auth: 'SESSION',
    input: emptyInputSchema,
  },
  async (ctx): Promise<ActionResult<AccountView>> => {
    const row = await ctx.db.user.findUnique({
      where: { id: ctx.user.id },
      select: ACCOUNT_SELECT,
    })

    if (row === null) {
      // The session resolved a moment ago, so this is the account having been
      // deleted underneath it rather than a bad id.
      return fail('NOT_FOUND', 'We could not find your account.')
    }

    return ok(toAccountView(row))
  }
)
