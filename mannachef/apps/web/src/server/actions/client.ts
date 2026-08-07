// mannachef/apps/web/src/server/actions/client.ts

'use server'

/**
 * The household's own record — what to call them, how to reach them, how they
 * found us, and what the chef needs to remember before walking through the
 * door.
 *
 * ## Ownership
 *
 * A `CLIENT` may read and edit exactly one `ClientProfile`: the one the session
 * already names. `ADMIN` and above may act on any. `CHEF_STAFF` sits in
 * between and deliberately gets *read* access only — a chef needs the standing
 * notes and the preferred name before an engagement, and has no business
 * rewriting how a household was attributed to a lead source.
 *
 * Every entry point that takes an id re-checks it against the caller before a
 * column is read or written, and denies with `NOT_FOUND` rather than
 * `FORBIDDEN` so the actions cannot be used to enumerate which household ids
 * are real (`mannachef/CONTRACT.md` §5, and the note at the head of
 * `@/server/guards`).
 *
 * ## What this file deliberately does not do
 *
 * `status` is not editable here. It is governed by
 * `clientStatusTransitionSchema` and `canTransitionClientStatus` in
 * `@mannachef/validators/crm`, and moved by `transitionClientStatus` in
 * `crm.ts`, which knows the legal moves and the churn bookkeeping each one
 * requires. Accepting `status` on a general-purpose update would route every
 * lifecycle move around that check — which is why
 * {@link clientProfileUpdateSchema} has no such field, and why
 * {@link createClientProfile} pins a new household to `PROSPECT` rather than
 * reading one from the payload.
 *
 * `lastContactedAt`, `followUpAt`, `churnedAt`, `churnReason` and
 * `lifetimeValueCents` are all owned elsewhere for the same reason: a figure
 * that is the sum of other rows is never typed into a form.
 */

import {
  clientProfileCreateSchema,
  clientProfileUpdateSchema,
  clientSourceRequiresDetail,
  cuidSchema,
  hasRoleAtLeast,
  type ClientSource,
  type ClientStatus,
  type ContactMethod,
} from '@mannachef/validators'
import { emptyInputSchema } from '@mannachef/api-contract'
import { z } from 'zod'

import { fail, ok, type ActionResult } from '@/server/actions/types'
import { Prisma } from '@/server/db'
import { withAction, type AuthenticatedUser } from '@/server/guards'

// =============================================================================
// 0. Constants
// =============================================================================

const CLIENT_PATHS = [
  '/portal',
  '/portal/profile',
  '/admin/clients',
  '/admin/pipeline',
] as const

const CLIENT_TAGS = ['clients', 'pipeline'] as const

// =============================================================================
// 1. Local input schemas
// =============================================================================

const clientProfileIdSchema = z.object({ clientProfileId: cuidSchema }).strict()

// =============================================================================
// 2. Projections
// =============================================================================

const CLIENT_PROFILE_SELECT = {
  id: true,
  userId: true,
  displayName: true,
  preferredName: true,
  phone: true,
  status: true,
  source: true,
  sourceDetail: true,
  preferredContactMethod: true,
  lifetimeValueCents: true,
  currency: true,
  lastContactedAt: true,
  followUpAt: true,
  churnedAt: true,
  churnReason: true,
  vipNotes: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { name: true, email: true, timeZone: true, locale: true } },
} satisfies Prisma.ClientProfileSelect

type ClientProfileRow = Prisma.ClientProfileGetPayload<{
  select: typeof CLIENT_PROFILE_SELECT
}>

/**
 * A household's record.
 *
 * `vipNotes` and `churnReason` are staff commentary — "the dog must be shut
 * in", "left because the Tuesday slot never worked" — and are nulled rather
 * than omitted for a household reading its own file, so one shape serves both
 * the portal and the OS.
 */
interface ClientProfileView {
  readonly id: string
  readonly userId: string
  readonly accountName: string | null
  readonly accountEmail: string | null
  readonly timeZone: string
  readonly locale: string
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly phone: string | null
  readonly status: ClientStatus
  readonly source: ClientSource
  readonly sourceDetail: string | null
  readonly preferredContactMethod: ContactMethod
  readonly lifetimeValueCents: number
  readonly currency: string
  readonly lastContactedAt: Date | null
  readonly followUpAt: Date | null
  readonly churnedAt: Date | null
  readonly churnReason: string | null
  readonly vipNotes: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

function isStaff(user: AuthenticatedUser): boolean {
  return hasRoleAtLeast(user.role, 'CHEF_STAFF')
}

function toClientProfileView(
  row: ClientProfileRow,
  forStaff: boolean
): ClientProfileView {
  return {
    id: row.id,
    userId: row.userId,
    accountName: row.user.name,
    accountEmail: row.user.email,
    timeZone: row.user.timeZone,
    locale: row.user.locale,
    displayName: row.displayName,
    preferredName: row.preferredName,
    phone: row.phone,
    status: row.status,
    source: row.source,
    sourceDetail: row.sourceDetail,
    preferredContactMethod: row.preferredContactMethod,
    lifetimeValueCents: row.lifetimeValueCents,
    currency: row.currency,
    lastContactedAt: row.lastContactedAt,
    followUpAt: row.followUpAt,
    churnedAt: row.churnedAt,
    churnReason: forStaff ? row.churnReason : null,
    vipNotes: forStaff ? row.vipNotes : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// =============================================================================
// 3. Ownership
// =============================================================================

/**
 * May this caller *write* to this household's record?
 *
 * The `ClientProfile` counterpart of the ownership guards in `@/server/guards`.
 * There is no `requireClientProfileOwnership` there because the session already
 * carries `clientProfileId`, so the comparison needs no second query — but the
 * shape is the same, down to the `NOT_FOUND` denial.
 *
 * The bypass is `ADMIN`, not `CHEF_STAFF`: see the note at the head of this
 * file. Reading goes through {@link canReadHousehold}, which is one rung lower.
 */
async function requireHouseholdWriteAccess(
  db: Prisma.TransactionClient,
  user: AuthenticatedUser,
  clientProfileId: string
): Promise<ActionResult<ClientProfileRow>> {
  const row = await db.clientProfile.findUnique({
    where: { id: clientProfileId },
    select: CLIENT_PROFILE_SELECT,
  })

  if (row === null) {
    return fail('NOT_FOUND', 'We could not find that household.')
  }

  if (hasRoleAtLeast(user.role, 'ADMIN')) {
    return ok(row)
  }

  return user.clientProfileId !== null && user.clientProfileId === row.id
    ? ok(row)
    : fail('NOT_FOUND', 'We could not find that household.')
}

/** May this caller *read* this household's record? `CHEF_STAFF` and above may. */
function canReadHousehold(
  user: AuthenticatedUser,
  clientProfileId: string
): boolean {
  if (isStaff(user)) {
    return true
  }

  return (
    user.clientProfileId !== null && user.clientProfileId === clientProfileId
  )
}

/**
 * The merged source rule.
 *
 * `clientProfileCreateSchema` enforces "a `REFERRAL`, `PARTNER` or `OTHER`
 * source carries a detail" on a complete payload, and
 * `clientProfileUpdateSchema` cannot: a partial that changes only
 * `sourceDetail` has no `source` to judge it against, and one that changes only
 * `source` has no detail to look at. `client.ts` in the validators package says
 * so explicitly and points here — the action re-reads the row and applies the
 * rule to the *merged* result, which is the only place both halves are known.
 */
function sourceDetailIsSatisfied(
  source: ClientSource,
  sourceDetail: string | null
): boolean {
  if (!clientSourceRequiresDetail(source)) {
    return true
  }

  return sourceDetail !== null && sourceDetail.length > 0
}

// =============================================================================
// 4. Create
// =============================================================================

/**
 * Open a household's record against an account.
 *
 * ## Who may
 *
 * A `CLIENT` may open exactly one profile, and only against their own account:
 * `userId` is compared with the session's id, and a mismatch is refused before
 * any row is read, so the payload cannot be used to attach a profile to
 * somebody else's account. `ADMIN` and above may open one for anybody, which is
 * the concierge creating a household from a telephone call.
 *
 * ## Why `userId` appears only here
 *
 * `ClientProfile.userId` is `@unique` and is set once. Every consultation,
 * appointment, note and interaction hangs off the profile, so re-parenting one
 * would silently move a household's entire history to a different account.
 * There is no update path for it, and the `P2002` branch below turns a second
 * attempt into a plain `CONFLICT` rather than a Prisma message.
 *
 * ## What it refuses to accept
 *
 * `status`. A new household is a `PROSPECT` — the column default in Prisma and
 * the opening position of the lifecycle in `crm.ts`. Everything after it is a
 * transition, and transitions need to know where the household was standing.
 */
export const createClientProfile = withAction(
  {
    name: 'client.profile.create',
    auth: 'SESSION',
    input: clientProfileCreateSchema,
    revalidatePaths: CLIENT_PATHS,
    revalidateTags: CLIENT_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ClientProfileView>> => {
    const staffCaller = isStaff(ctx.user)
    const privileged = hasRoleAtLeast(ctx.user.role, 'ADMIN')

    if (!privileged && input.userId !== ctx.user.id) {
      return fail(
        'FORBIDDEN',
        'You may only open a household record on your own account.'
      )
    }

    if (!sourceDetailIsSatisfied(input.source, input.sourceDetail ?? null)) {
      return fail(
        'VALIDATION',
        'Please say a little more about how this household came to us.',
        {
          sourceDetail: [
            'Please say a little more — who referred them, which partner, or what "other" means.',
          ],
        }
      )
    }

    const account = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: { id: true, clientProfile: { select: { id: true } } },
    })

    if (account === null) {
      return fail('NOT_FOUND', 'We could not find that account.')
    }

    if (account.clientProfile !== null) {
      return fail('CONFLICT', 'This account already has a household record.', {
        userId: ['A household record is already open on this account.'],
      })
    }

    const created = await ctx.db.clientProfile.create({
      data: {
        userId: account.id,
        displayName: input.displayName ?? null,
        preferredName: input.preferredName ?? null,
        phone: input.phone ?? null,
        source: input.source,
        sourceDetail: input.sourceDetail ?? null,
        preferredContactMethod: input.preferredContactMethod,
        // Staff commentary. A household opening its own record cannot write
        // into the column it is not allowed to read.
        vipNotes: staffCaller ? (input.vipNotes ?? null) : null,
        status: 'PROSPECT',
      },
      select: CLIENT_PROFILE_SELECT,
    })

    return ok(toClientProfileView(created, staffCaller))
  }
)

// =============================================================================
// 5. Update
// =============================================================================

/**
 * Amend a household's record.
 *
 * `clientProfileUpdateSchema` is built by `buildUpdateSchema`, which strips the
 * two `.default(...)`s — `source` and `preferredContactMethod` — *before* the
 * `.partial()`. That strip is load-bearing rather than tidy: a hand-rolled
 * partial leaves both defaults live, so adding a line to `vipNotes` on a
 * household we won through a partner would re-record them as `DIRECT`, and a
 * household that asked to be telephoned would quietly go back to email. Both
 * are silent, both survive review, and both surface months later as a
 * lead-source report saying everybody found us on their own.
 *
 * The conditional spreads below carry that property to the column: a key the
 * caller did not send is not written at all. Under `exactOptionalPropertyTypes`
 * handing Prisma an explicit `undefined` is not even expressible, which is what
 * makes the pattern checkable rather than merely conventional.
 *
 * `vipNotes` is dropped for a caller below `CHEF_STAFF` rather than refused: a
 * household editing its own preferred name should not be told off for a field
 * its form never rendered.
 */
export const updateClientProfile = withAction(
  {
    name: 'client.profile.update',
    auth: 'SESSION',
    input: clientProfileUpdateSchema,
    revalidatePaths: CLIENT_PATHS,
    revalidateTags: CLIENT_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ClientProfileView>> => {
    const staffCaller = isStaff(ctx.user)

    const owned = await requireHouseholdWriteAccess(ctx.db, ctx.user, input.id)

    if (!owned.ok) {
      return owned
    }

    // The merged source rule — see {@link sourceDetailIsSatisfied}.
    const mergedSource = input.source ?? owned.data.source
    const mergedDetail =
      input.sourceDetail === undefined
        ? owned.data.sourceDetail
        : input.sourceDetail

    if (!sourceDetailIsSatisfied(mergedSource, mergedDetail)) {
      return fail(
        'VALIDATION',
        'Please say a little more about how this household came to us.',
        {
          sourceDetail: [
            'Please say a little more — who referred them, which partner, or what "other" means.',
          ],
        }
      )
    }

    const updated = await ctx.db.clientProfile.update({
      where: { id: owned.data.id },
      data: {
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        ...(input.preferredName === undefined
          ? {}
          : { preferredName: input.preferredName }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.sourceDetail === undefined
          ? {}
          : { sourceDetail: input.sourceDetail }),
        ...(input.preferredContactMethod === undefined
          ? {}
          : { preferredContactMethod: input.preferredContactMethod }),
        ...(staffCaller && input.vipNotes !== undefined
          ? { vipNotes: input.vipNotes }
          : {}),
      },
      select: CLIENT_PROFILE_SELECT,
    })

    return ok(toClientProfileView(updated, staffCaller))
  }
)

// =============================================================================
// 6. Read
// =============================================================================

/**
 * One household's record.
 *
 * Readable by the household itself and by `CHEF_STAFF` and above; anybody else
 * asking gets `NOT_FOUND`, the same answer an id that never existed gets.
 * `vipNotes` and `churnReason` are withheld from the household by
 * {@link toClientProfileView}.
 */
export const readClientProfile = withAction(
  {
    name: 'client.profile.read',
    auth: 'SESSION',
    input: clientProfileIdSchema,
  },
  async (ctx, input): Promise<ActionResult<ClientProfileView>> => {
    if (!canReadHousehold(ctx.user, input.clientProfileId)) {
      return fail('NOT_FOUND', 'We could not find that household.')
    }

    const row = await ctx.db.clientProfile.findUnique({
      where: { id: input.clientProfileId },
      select: CLIENT_PROFILE_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that household.')
    }

    return ok(toClientProfileView(row, isStaff(ctx.user)))
  }
)

/**
 * The caller's own household record.
 *
 * Takes no input — `emptyInputSchema` is `z.strictObject({})`, so a stray
 * `clientProfileId` is a validation failure rather than something this action
 * has to remember to ignore. With no id in the payload there is nothing to
 * check ownership of: the household is whichever one the session names.
 */
export const readMyClientProfile = withAction(
  {
    name: 'client.profile.read.mine',
    auth: 'SESSION',
    input: emptyInputSchema,
  },
  async (ctx): Promise<ActionResult<ClientProfileView>> => {
    const clientProfileId = ctx.user.clientProfileId

    if (clientProfileId === null) {
      return fail(
        'NOT_FOUND',
        'There is no household record on this account yet.'
      )
    }

    const row = await ctx.db.clientProfile.findUnique({
      where: { id: clientProfileId },
      select: CLIENT_PROFILE_SELECT,
    })

    if (row === null) {
      return fail(
        'NOT_FOUND',
        'There is no household record on this account yet.'
      )
    }

    return ok(toClientProfileView(row, isStaff(ctx.user)))
  }
)
