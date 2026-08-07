// mannachef/apps/web/src/server/actions/crm.ts

'use server'

/**
 * The CRM — the notes, the exchanges, the lifecycle, the pipeline, and the
 * three numbers the business is actually run on.
 *
 * ## Notes are not all readable by the same people
 *
 * `NoteVisibility` exists precisely so that some things written about a
 * household are unreadable by people who can otherwise read that household —
 * and, above all, by the household itself. The matrix is stated once, in
 * `requireClientNoteOwnership` in `@/server/guards`, and this file agrees with
 * it in two places that must never drift:
 *
 *  - {@link updateClientNote} and {@link deleteClientNote} call the guard, so a
 *    single note is reached only through the matrix.
 *  - {@link listClientNotes} cannot call a per-row guard without fetching rows
 *    it may not be allowed to see, so {@link noteVisibilityScope} expresses the
 *    same matrix as a `WHERE` clause. The two are deliberately written to the
 *    same shape: author always, then `PRIVATE` → `SUPER_ADMIN`, `ADMIN_ONLY` →
 *    `ADMIN`, `STAFF` → `CHEF_STAFF`, `CLIENT_VISIBLE` → staff *or* the
 *    household it is about.
 *
 * A `CLIENT` is additionally pinned to their own `clientProfileId` before the
 * visibility clause is even applied, so the worst a mistake in the visibility
 * half could do is show a household one of its own notes.
 *
 * ## The analytics aggregate in SQL
 *
 * Lifetime value, churn and cohort retention are computed by PostgreSQL and
 * arrive as a handful of grouped rows. None of the three pulls a per-client or
 * per-invoice row set into JavaScript to reduce it there: on a book of any size
 * that is the difference between a query and an outage, and `SUM`, `COUNT
 * FILTER`, `width_bucket` and `generate_series` are what a relational database
 * is for.
 *
 * Every value interpolated into those statements goes through Prisma's tagged
 * template or `Prisma.join`, so it is a bound parameter and not string
 * concatenation. The only fragments assembled as SQL text are chosen from
 * closed maps declared in this file — {@link PERIOD_INTERVALS} — and never
 * touch caller input.
 *
 * **Lifetime value is computed from real paid invoices**, not from
 * `ClientProfile.lifetimeValueCents`. That column is a cache;
 * {@link recalculateLifetimeValues} is what refills it, and the analytics read
 * `Invoice.amountPaidCents` where `status = 'PAID'` so a stale cache can never
 * quietly become a wrong report.
 */

import {
  buildLtvBuckets,
  canTransitionClientStatus,
  clientFollowUpSchema,
  clientLtvBucketingSchema,
  clientNoteCreateSchema,
  clientNoteFilterSchema,
  clientNoteUpdateSchema,
  clientPipelineFilterSchema,
  clientStatusTransitionSchema,
  cuidSchema,
  dateRangeSchema,
  hasRoleAtLeast,
  intSchema,
  interactionLogCreateSchema,
  interactionLogFilterSchema,
  paginationToSkipTake,
  type ClientPipelineSortBy,
  type ClientSource,
  type ClientStatus,
  type InteractionChannel,
  type InteractionDirection,
  type LtvBucket,
  type NoteVisibility,
  type SortDirection,
} from '@mannachef/validators'
import { emptyInputSchema, type PageMeta } from '@mannachef/api-contract'
import { z } from 'zod'

import { fail, ok, type ActionResult } from '@/server/actions/types'
import { Prisma } from '@/server/db'
import {
  requireClientNoteOwnership,
  withAction,
  type AuthenticatedUser,
} from '@/server/guards'

// =============================================================================
// 0. Constants
// =============================================================================

const CRM_PATHS = [
  '/admin/clients',
  '/admin/pipeline',
  '/admin/analytics',
  '/portal',
] as const

const CRM_TAGS = ['clients', 'pipeline', 'crm-notes', 'analytics'] as const

/** How many households the lifetime-value report names individually. */
const LTV_LEADERBOARD_SIZE = 50

/** The largest value `ClientProfile.lifetimeValueCents` (an `Int`) can hold. */
const MAX_INT4 = 2_147_483_647

// =============================================================================
// 1. Local input schemas
//
// Composed from `@mannachef/validators`, never restating a rule the package
// owns. `dateRangeSchema` already carries "the end falls after the start" and
// `intSchema` already carries bounded-integer messages; the two enums below are
// new vocabulary rather than a second spelling of an existing one.
// =============================================================================

const clientNoteIdSchema = z.object({ clientNoteId: cuidSchema }).strict()

const churnQuerySchema = z
  .object({
    range: dateRangeSchema,
    granularity: z
      .enum(['WEEK', 'MONTH', 'QUARTER'], {
        error: 'Please choose how the periods should be grouped.',
      })
      .default('MONTH'),
  })
  .strict()

type ChurnGranularity = z.infer<typeof churnQuerySchema>['granularity']

const cohortQuerySchema = z
  .object({
    range: dateRangeSchema,
    /** How many months after signup each cohort is followed for. */
    horizonMonths: intSchema(1, 36, {
      notAnInteger: 'Please give the horizon in whole months.',
      tooSmall: 'Follow a cohort for at least one month.',
      tooLarge: 'Three years is as far as a cohort is worth following.',
    }).default(12),
  })
  .strict()

/**
 * The period step, as SQL.
 *
 * A closed map of literal fragments. The *key* comes from a validated enum and
 * the *value* is written here, so no caller input reaches the statement as
 * text — which is what makes interpolating a `Prisma.Sql` fragment safe when
 * interpolating a string would not be.
 */
const PERIOD_INTERVALS: Record<ChurnGranularity, Prisma.Sql> = {
  WEEK: Prisma.sql`interval '1 week'`,
  MONTH: Prisma.sql`interval '1 month'`,
  QUARTER: Prisma.sql`interval '3 months'`,
}

// =============================================================================
// 2. Projections
// =============================================================================

const CLIENT_NOTE_SELECT = {
  id: true,
  clientProfileId: true,
  authorId: true,
  body: true,
  pinned: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { name: true } },
} satisfies Prisma.ClientNoteSelect

type ClientNoteRow = Prisma.ClientNoteGetPayload<{
  select: typeof CLIENT_NOTE_SELECT
}>

const INTERACTION_SELECT = {
  id: true,
  clientProfileId: true,
  loggedById: true,
  channel: true,
  direction: true,
  subject: true,
  body: true,
  occurredAt: true,
  durationMinutes: true,
  externalRef: true,
  createdAt: true,
  loggedBy: { select: { name: true } },
} satisfies Prisma.InteractionLogSelect

type InteractionRow = Prisma.InteractionLogGetPayload<{
  select: typeof INTERACTION_SELECT
}>

const PIPELINE_SELECT = {
  id: true,
  userId: true,
  displayName: true,
  preferredName: true,
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
  createdAt: true,
  updatedAt: true,
  user: { select: { name: true, email: true } },
  onboardingFlow: { select: { currentStage: true, progressPercent: true } },
} satisfies Prisma.ClientProfileSelect

type PipelineRow = Prisma.ClientProfileGetPayload<{
  select: typeof PIPELINE_SELECT
}>

interface ClientNoteView {
  readonly id: string
  readonly clientProfileId: string
  readonly authorId: string | null
  readonly authorName: string | null
  readonly body: string
  readonly pinned: boolean
  readonly visibility: NoteVisibility
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface InteractionView {
  readonly id: string
  readonly clientProfileId: string
  readonly loggedById: string | null
  readonly loggedByName: string | null
  readonly channel: InteractionChannel
  readonly direction: InteractionDirection
  readonly subject: string | null
  readonly body: string | null
  readonly occurredAt: Date
  readonly durationMinutes: number | null
  readonly externalRef: string | null
  readonly createdAt: Date
}

interface PipelineClientView {
  readonly id: string
  readonly userId: string
  readonly accountName: string | null
  readonly accountEmail: string | null
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly status: ClientStatus
  readonly source: ClientSource
  readonly sourceDetail: string | null
  readonly lifetimeValueCents: number
  readonly currency: string
  readonly lastContactedAt: Date | null
  readonly followUpAt: Date | null
  readonly churnedAt: Date | null
  readonly churnReason: string | null
  readonly onboardingStage: string | null
  readonly onboardingProgressPercent: number | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ClientNoteListView {
  readonly items: readonly ClientNoteView[]
  readonly meta: PageMeta
}

interface InteractionListView {
  readonly items: readonly InteractionView[]
  readonly meta: PageMeta
}

interface PipelineView {
  readonly items: readonly PipelineClientView[]
  readonly meta: PageMeta
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

function toClientNoteView(row: ClientNoteRow): ClientNoteView {
  return {
    id: row.id,
    clientProfileId: row.clientProfileId,
    authorId: row.authorId,
    authorName: row.author?.name ?? null,
    body: row.body,
    pinned: row.pinned,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toInteractionView(row: InteractionRow): InteractionView {
  return {
    id: row.id,
    clientProfileId: row.clientProfileId,
    loggedById: row.loggedById,
    loggedByName: row.loggedBy?.name ?? null,
    channel: row.channel,
    direction: row.direction,
    subject: row.subject,
    body: row.body,
    occurredAt: row.occurredAt,
    durationMinutes: row.durationMinutes,
    externalRef: row.externalRef,
    createdAt: row.createdAt,
  }
}

function toPipelineView(row: PipelineRow): PipelineClientView {
  return {
    id: row.id,
    userId: row.userId,
    accountName: row.user.name,
    accountEmail: row.user.email,
    displayName: row.displayName,
    preferredName: row.preferredName,
    status: row.status,
    source: row.source,
    sourceDetail: row.sourceDetail,
    lifetimeValueCents: row.lifetimeValueCents,
    currency: row.currency,
    lastContactedAt: row.lastContactedAt,
    followUpAt: row.followUpAt,
    churnedAt: row.churnedAt,
    churnReason: row.churnReason,
    onboardingStage: row.onboardingFlow?.currentStage ?? null,
    onboardingProgressPercent: row.onboardingFlow?.progressPercent ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * PostgreSQL returns `bigint` for `SUM` over an integer column and Prisma hands
 * it back as a JavaScript `BigInt`; `::int` casts come back as `number`. Both
 * are normalised here rather than at twenty call sites.
 *
 * Money on this platform is whole cents and a `SUM` of them stays comfortably
 * inside `Number.MAX_SAFE_INTEGER` — ninety trillion dollars — so the narrowing
 * loses nothing real.
 */
function toNumber(value: bigint | number | null): number {
  if (value === null) {
    return 0
  }

  return typeof value === 'bigint' ? Number(value) : value
}

// =============================================================================
// 3. Note visibility, as a WHERE clause
// =============================================================================

/**
 * The `requireClientNoteOwnership` matrix, expressed for a list query.
 *
 * A per-row guard is the right shape for one note and the wrong shape for a
 * page of them — it would have to fetch rows the caller may not read in order
 * to decide they may not read them. So the same rules are pushed into the
 * query, and they are written in the same order as the guard's `switch` so the
 * two can be compared line by line:
 *
 * | Visibility       | Who the clause admits                              |
 * | ---------------- | -------------------------------------------------- |
 * | *any*            | the author of the note                             |
 * | `PRIVATE`        | `SUPER_ADMIN`                                      |
 * | `ADMIN_ONLY`     | `ADMIN` and above                                  |
 * | `STAFF`          | `CHEF_STAFF` and above                             |
 * | `CLIENT_VISIBLE` | `CHEF_STAFF` and above, or the household concerned |
 *
 * Returns `null` when the caller can see nothing at all — a signed-in account
 * with no household and no staff rank — which the caller renders as an empty
 * page rather than as an unscoped query.
 */
function noteVisibilityScope(
  user: AuthenticatedUser
): Prisma.ClientNoteWhereInput | null {
  // A note you wrote is always yours to read, at every rank.
  const authored: Prisma.ClientNoteWhereInput = { authorId: user.id }

  if (hasRoleAtLeast(user.role, 'SUPER_ADMIN')) {
    return {}
  }

  if (hasRoleAtLeast(user.role, 'ADMIN')) {
    return {
      OR: [
        authored,
        { visibility: { in: ['ADMIN_ONLY', 'STAFF', 'CLIENT_VISIBLE'] } },
      ],
    }
  }

  if (hasRoleAtLeast(user.role, 'CHEF_STAFF')) {
    return {
      OR: [authored, { visibility: { in: ['STAFF', 'CLIENT_VISIBLE'] } }],
    }
  }

  const ownProfileId = user.clientProfileId

  if (ownProfileId === null) {
    return null
  }

  // A household is pinned to its own record *and* to the one visibility that
  // was written for it. Both clauses, not either.
  return {
    AND: [
      { clientProfileId: ownProfileId },
      { OR: [authored, { visibility: 'CLIENT_VISIBLE' }] },
    ],
  }
}

/** Editing and deleting are tighter than reading: the author, or an `ADMIN`. */
function mayAmendNote(
  user: AuthenticatedUser,
  authorId: string | null
): boolean {
  if (hasRoleAtLeast(user.role, 'ADMIN')) {
    return true
  }

  return authorId !== null && authorId === user.id
}

// =============================================================================
// 4. Notes
// =============================================================================

/**
 * Write a note against a household.
 *
 * `CHEF_STAFF` and above. `authorId` comes from the session and is never
 * accepted from the payload — `clientNoteCreateSchema` has no such field, for
 * the reason its own docblock gives: a note that claims to be by somebody else
 * is not a note we would keep.
 *
 * The household is confirmed to exist first, so a mistyped id is `NOT_FOUND`
 * rather than a foreign-key violation surfacing as a bare `CONFLICT`.
 */
export const createClientNote = withAction(
  {
    name: 'crm.note.create',
    auth: 'CHEF_STAFF',
    input: clientNoteCreateSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ClientNoteView>> => {
    const household = await ctx.db.clientProfile.findUnique({
      where: { id: input.clientProfileId },
      select: { id: true },
    })

    if (household === null) {
      return fail('NOT_FOUND', 'We could not find that household.')
    }

    const created = await ctx.db.clientNote.create({
      data: {
        clientProfileId: household.id,
        authorId: ctx.user.id,
        body: input.body,
        pinned: input.pinned,
        visibility: input.visibility,
      },
      select: CLIENT_NOTE_SELECT,
    })

    return ok(toClientNoteView(created))
  }
)

/**
 * Amend a note.
 *
 * Two checks, and both are needed. `requireClientNoteOwnership` decides whether
 * the caller may *reach* the row at all — that is the visibility matrix, and
 * its denial is `NOT_FOUND` so a note somebody may not read is
 * indistinguishable from one that does not exist. {@link mayAmendNote} then
 * decides whether they may *change* it, which is a narrower question: a
 * `CHEF_STAFF` may read a colleague's `STAFF` note and may not rewrite it.
 *
 * `clientNoteUpdateSchema` is built by `buildUpdateSchema`, which strips
 * `pinned`'s `false` and `visibility`'s `'STAFF'` before making the shape
 * partial. Correcting a typo therefore cannot unpin a note, and a note written
 * for the household's eyes cannot be quietly returned to staff-only by an edit
 * that never mentioned visibility.
 */
export const updateClientNote = withAction(
  {
    name: 'crm.note.update',
    auth: 'SESSION',
    input: clientNoteUpdateSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ClientNoteView>> => {
    const owned = await requireClientNoteOwnership(ctx.user, input.id)

    if (!owned.ok) {
      return owned
    }

    if (!mayAmendNote(ctx.user, owned.data.authorId)) {
      return fail('FORBIDDEN', 'Only the author may change this note.')
    }

    const updated = await ctx.db.clientNote.update({
      where: { id: owned.data.id },
      data: {
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.visibility === undefined
          ? {}
          : { visibility: input.visibility }),
      },
      select: CLIENT_NOTE_SELECT,
    })

    return ok(toClientNoteView(updated))
  }
)

/** Remove a note. Same two checks as {@link updateClientNote}. */
export const deleteClientNote = withAction(
  {
    name: 'crm.note.delete',
    auth: 'SESSION',
    input: clientNoteIdSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<{ id: string }>> => {
    const owned = await requireClientNoteOwnership(ctx.user, input.clientNoteId)

    if (!owned.ok) {
      return owned
    }

    if (!mayAmendNote(ctx.user, owned.data.authorId)) {
      return fail('FORBIDDEN', 'Only the author may remove this note.')
    }

    await ctx.db.clientNote.delete({
      where: { id: owned.data.id },
      select: { id: true },
    })

    return ok({ id: owned.data.id })
  }
)

/**
 * A page of notes.
 *
 * The visibility matrix is applied as a `WHERE` clause by
 * {@link noteVisibilityScope} — see the note above it for why a per-row guard
 * is the wrong instrument here — and it is applied *in addition to* whatever
 * the filter asked for, never instead of it. A `CLIENT` who sends
 * `visibilities: ['ADMIN_ONLY']` gets an empty page, because the intersection
 * of what they asked for and what they may see is empty; they do not get an
 * error that would tell them such notes exist.
 */
export const listClientNotes = withAction(
  {
    name: 'crm.note.list',
    auth: 'SESSION',
    input: clientNoteFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ClientNoteListView>> => {
    const scope = noteVisibilityScope(ctx.user)

    if (scope === null) {
      return ok({
        items: [],
        meta: buildPageMeta(filter.page, filter.pageSize, 0),
      })
    }

    const filters: Prisma.ClientNoteWhereInput[] = [scope]

    if (filter.clientProfileId !== undefined) {
      filters.push({ clientProfileId: filter.clientProfileId })
    }

    if (filter.authorId !== undefined) {
      filters.push({ authorId: filter.authorId })
    }

    if (filter.visibilities.length > 0) {
      filters.push({ visibility: { in: [...filter.visibilities] } })
    }

    if (filter.pinnedOnly) {
      filters.push({ pinned: true })
    }

    if (filter.search !== undefined) {
      filters.push({ body: { contains: filter.search, mode: 'insensitive' } })
    }

    const where: Prisma.ClientNoteWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.clientNote.count({ where }),
      ctx.db.clientNote.findMany({
        where,
        select: CLIENT_NOTE_SELECT,
        orderBy: [
          { pinned: 'desc' },
          { createdAt: filter.sortDirection },
          { id: 'asc' },
        ],
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toClientNoteView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 5. The interaction log
// =============================================================================

/**
 * Record an exchange with a household — a call, an email, a note passed at the
 * door.
 *
 * Staff-only in both directions. The log is internal: it names colleagues,
 * quotes what was said internally about the conversation, and is not a thing a
 * household reads. There is deliberately no client-facing counterpart.
 *
 * ## Idempotency
 *
 * `externalRef` is the provider's message id (Resend, Twilio, …). When one is
 * given and a row already carries it for this household, the existing row is
 * returned unchanged — a webhook redelivery must not double the household's
 * timeline, and `markAsContacted` must not push `lastContactedAt` forward a
 * second time.
 *
 * `loggedById` comes from the session; `occurredAt` may be back-dated when
 * somebody writes up a conversation afterwards, and `interactionLogCreateSchema`
 * already refuses to post-date it — a planned call is a follow-up, which is
 * {@link flagClientFollowUp}.
 */
export const logInteraction = withAction(
  {
    name: 'crm.interaction.log',
    auth: 'CHEF_STAFF',
    input: interactionLogCreateSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<InteractionView>> => {
    const occurredAt = input.occurredAt ?? new Date()

    const outcome = await ctx.db.$transaction(async (tx) => {
      const household = await tx.clientProfile.findUnique({
        where: { id: input.clientProfileId },
        select: { id: true, lastContactedAt: true },
      })

      if (household === null) {
        return { kind: 'notFound' as const }
      }

      if (input.externalRef !== undefined && input.externalRef !== null) {
        const replayed = await tx.interactionLog.findFirst({
          where: {
            clientProfileId: household.id,
            externalRef: input.externalRef,
          },
          select: INTERACTION_SELECT,
        })

        if (replayed !== null) {
          return { kind: 'replayed' as const, row: replayed }
        }
      }

      const created = await tx.interactionLog.create({
        data: {
          clientProfileId: household.id,
          loggedById: ctx.user.id,
          channel: input.channel,
          direction: input.direction,
          subject: input.subject ?? null,
          body: input.body ?? null,
          occurredAt,
          durationMinutes: input.durationMinutes ?? null,
          externalRef: input.externalRef ?? null,
        },
        select: INTERACTION_SELECT,
      })

      // `lastContactedAt` only ever moves forward. Writing up a call from last
      // month must not make a household look freshly spoken to.
      if (
        input.markAsContacted &&
        (household.lastContactedAt === null ||
          household.lastContactedAt.getTime() < occurredAt.getTime())
      ) {
        await tx.clientProfile.update({
          where: { id: household.id },
          data: { lastContactedAt: occurredAt },
          select: { id: true },
        })
      }

      return { kind: 'logged' as const, row: created }
    })

    switch (outcome.kind) {
      case 'logged':
      case 'replayed':
        return ok(toInteractionView(outcome.row))

      case 'notFound':
        return fail('NOT_FOUND', 'We could not find that household.')

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

/** The internal timeline of exchanges. Staff-only, for the reasons above. */
export const listInteractions = withAction(
  {
    name: 'crm.interaction.list',
    auth: 'CHEF_STAFF',
    input: interactionLogFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<InteractionListView>> => {
    const filters: Prisma.InteractionLogWhereInput[] = []

    if (filter.clientProfileId !== undefined) {
      filters.push({ clientProfileId: filter.clientProfileId })
    }

    if (filter.loggedById !== undefined) {
      filters.push({ loggedById: filter.loggedById })
    }

    if (filter.channels.length > 0) {
      filters.push({ channel: { in: [...filter.channels] } })
    }

    if (filter.direction !== undefined) {
      filters.push({ direction: filter.direction })
    }

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { subject: { contains: filter.search, mode: 'insensitive' } },
          { body: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    if (filter.occurredFrom !== undefined) {
      filters.push({ occurredAt: { gte: filter.occurredFrom } })
    }

    if (filter.occurredTo !== undefined) {
      filters.push({ occurredAt: { lte: filter.occurredTo } })
    }

    const where: Prisma.InteractionLogWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.interactionLog.count({ where }),
      ctx.db.interactionLog.findMany({
        where,
        select: INTERACTION_SELECT,
        orderBy: [{ occurredAt: filter.sortDirection }, { id: 'asc' }],
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toInteractionView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 6. The lifecycle
// =============================================================================

/**
 * Move a household through the lifecycle.
 *
 * ## Compare-and-swap, not read-then-write
 *
 * `from` is the status the caller believes the household is in.
 * `clientStatusTransitionSchema` validates the *move* against
 * `CLIENT_STATUS_TRANSITIONS`; this action then re-checks it against the
 * **stored** status and writes with a conditional `updateMany` guarded on that
 * status. Two people pressing the same button at the same moment therefore
 * produce one transition and one refusal, rather than two writes where the
 * second silently overwrites the first.
 *
 * ## Churn bookkeeping
 *
 * A move *to* `CHURNED` stamps `churnedAt` and stores the reason —
 * `clientStatusTransitionSchema` requires one, and it is the single most useful
 * field in the CRM. A move *off* `CHURNED` clears both, because a household
 * that came back is not a household we lost, and every churn figure
 * {@link readChurnRate} reports is computed from that column.
 *
 * ## `ADMIN`
 *
 * The lifecycle drives billing, the pipeline and every retention number in the
 * business. Recording a conversation is `CHEF_STAFF`; deciding a household has
 * left is not.
 */
export const transitionClientStatus = withAction(
  {
    name: 'crm.client.transition',
    auth: 'ADMIN',
    input: clientStatusTransitionSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<PipelineClientView>> => {
    const occurredAt = input.occurredAt ?? new Date()

    const outcome = await ctx.db.$transaction(async (tx) => {
      const household = await tx.clientProfile.findUnique({
        where: { id: input.clientProfileId },
        select: { id: true, status: true },
      })

      if (household === null) {
        return { kind: 'notFound' as const }
      }

      if (household.status !== input.from) {
        return { kind: 'stale' as const, actual: household.status }
      }

      // The parser checked the claimed move; this checks the real one.
      if (!canTransitionClientStatus(household.status, input.to)) {
        return { kind: 'illegal' as const, actual: household.status }
      }

      const leavingChurn =
        household.status === 'CHURNED' && input.to !== 'CHURNED'

      const moved = await tx.clientProfile.updateMany({
        where: { id: household.id, status: input.from },
        data: {
          status: input.to,
          lastContactedAt: occurredAt,
          ...(input.followUpAt === undefined
            ? {}
            : { followUpAt: input.followUpAt }),
          ...(input.to === 'CHURNED'
            ? { churnedAt: occurredAt, churnReason: input.reason ?? null }
            : {}),
          ...(leavingChurn ? { churnedAt: null, churnReason: null } : {}),
        },
      })

      if (moved.count !== 1) {
        return { kind: 'raced' as const }
      }

      // The move is recorded on the household's own timeline, with the reason
      // attached, so the pipeline board is never the only place it exists.
      await tx.clientNote.create({
        data: {
          clientProfileId: household.id,
          authorId: ctx.user.id,
          body:
            input.reason === undefined
              ? `Moved from ${input.from.toLowerCase().replace(/_/g, ' ')} to ${input.to.toLowerCase().replace(/_/g, ' ')}.`
              : `Moved from ${input.from.toLowerCase().replace(/_/g, ' ')} to ${input.to.toLowerCase().replace(/_/g, ' ')}. ${input.reason}`,
          visibility: 'STAFF',
          pinned: input.to === 'CHURNED',
        },
        select: { id: true },
      })

      const refreshed = await tx.clientProfile.findUniqueOrThrow({
        where: { id: household.id },
        select: PIPELINE_SELECT,
      })

      return { kind: 'moved' as const, row: refreshed }
    })

    switch (outcome.kind) {
      case 'moved':
        return ok(toPipelineView(outcome.row))

      case 'notFound':
        return fail('NOT_FOUND', 'We could not find that household.')

      case 'stale':
        return fail(
          'CONFLICT',
          'This household has already moved on. Please reload and try again.',
          {
            from: [
              `This household is at ${outcome.actual.toLowerCase().replace(/_/g, ' ')}.`,
            ],
          }
        )

      case 'illegal':
        return fail('CONFLICT', 'A household cannot make that move.', {
          to: [
            `From ${outcome.actual.toLowerCase().replace(/_/g, ' ')}, that is not a move the lifecycle allows.`,
          ],
        })

      case 'raced':
        return fail(
          'CONFLICT',
          'Somebody else moved this household at the same moment. Please reload and try again.'
        )

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

/**
 * Flag a household for a follow-up, or clear the flag.
 *
 * Sending `null` for `followUpAt` is how a follow-up is marked done: the flag
 * comes off the record and the household drops out of the "due" column of the
 * pipeline. A date is always ahead of us — `clientFollowUpSchema` enforces
 * that, and bounds it to two years — because a follow-up in the past is one
 * that was missed rather than one that was scheduled.
 *
 * When a note is given it is written as a `ClientNote` against the same
 * household with the visibility the caller chose, so the *reason* for the flag
 * survives the flag itself. Clearing a flag carries no note; the schema refuses
 * that combination rather than dropping the text silently.
 */
export const flagClientFollowUp = withAction(
  {
    name: 'crm.client.followUp',
    auth: 'CHEF_STAFF',
    input: clientFollowUpSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<PipelineClientView>> => {
    const now = new Date()

    const outcome = await ctx.db.$transaction(async (tx) => {
      const household = await tx.clientProfile.findUnique({
        where: { id: input.clientProfileId },
        select: { id: true, lastContactedAt: true },
      })

      if (household === null) {
        return { kind: 'notFound' as const }
      }

      const shouldStampContact =
        input.markAsContacted &&
        (household.lastContactedAt === null ||
          household.lastContactedAt.getTime() < now.getTime())

      const updated = await tx.clientProfile.update({
        where: { id: household.id },
        data: {
          followUpAt: input.followUpAt,
          ...(shouldStampContact ? { lastContactedAt: now } : {}),
        },
        select: PIPELINE_SELECT,
      })

      if (input.note !== undefined && input.note !== null) {
        await tx.clientNote.create({
          data: {
            clientProfileId: household.id,
            authorId: ctx.user.id,
            body: input.note,
            visibility: input.noteVisibility,
            pinned: false,
          },
          select: { id: true },
        })
      }

      return { kind: 'flagged' as const, row: updated }
    })

    return outcome.kind === 'notFound'
      ? fail('NOT_FOUND', 'We could not find that household.')
      : ok(toPipelineView(outcome.row))
  }
)

// =============================================================================
// 7. The pipeline
// =============================================================================

function pipelineOrderBy(
  sortBy: ClientPipelineSortBy,
  direction: SortDirection
): Prisma.ClientProfileOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    case 'LAST_CONTACTED':
      return [{ lastContactedAt: direction }, { id: 'asc' }]

    case 'FOLLOW_UP':
      return [{ followUpAt: direction }, { id: 'asc' }]

    case 'LIFETIME_VALUE':
      return [{ lifetimeValueCents: direction }, { id: 'asc' }]

    case 'NAME':
      return [{ displayName: direction }, { id: 'asc' }]

    case 'STATUS':
      return [{ status: direction }, { updatedAt: 'desc' }, { id: 'asc' }]

    default: {
      // A new member of `clientPipelineSortBySchema` is a compile error here
      // rather than a silently unordered board.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * The pipeline: every household, narrowed by where they are, where they came
 * from, what they are worth, and whether they are owed a conversation.
 *
 * `followUpDue` is the flag the morning briefing is built on — households whose
 * `followUpAt` has arrived. `lastContactedBefore` is its quieter sibling: the
 * households nobody has spoken to in a while, who were never flagged because
 * nobody noticed.
 *
 * Staff-only. There is no client-facing pipeline, and a client-facing *filter*
 * over every household is the shape of query that leaks one household's details
 * into another's screen.
 */
export const queryClientPipeline = withAction(
  {
    name: 'crm.pipeline.query',
    auth: 'CHEF_STAFF',
    input: clientPipelineFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<PipelineView>> => {
    const now = new Date()
    const filters: Prisma.ClientProfileWhereInput[] = []

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { displayName: { contains: filter.search, mode: 'insensitive' } },
          { preferredName: { contains: filter.search, mode: 'insensitive' } },
          {
            user: {
              email: { contains: filter.search, mode: 'insensitive' },
            },
          },
        ],
      })
    }

    if (filter.statuses.length > 0) {
      filters.push({ status: { in: [...filter.statuses] } })
    }

    if (filter.sources.length > 0) {
      filters.push({ source: { in: [...filter.sources] } })
    }

    if (filter.minLifetimeValueCents !== undefined) {
      filters.push({
        lifetimeValueCents: { gte: filter.minLifetimeValueCents },
      })
    }

    if (filter.maxLifetimeValueCents !== undefined) {
      filters.push({
        lifetimeValueCents: { lte: filter.maxLifetimeValueCents },
      })
    }

    if (filter.neverContacted) {
      filters.push({ lastContactedAt: null })
    }

    if (filter.lastContactedBefore !== undefined) {
      filters.push({ lastContactedAt: { lt: filter.lastContactedBefore } })
    }

    if (filter.followUpDue) {
      filters.push({ followUpAt: { not: null, lte: now } })
    }

    if (filter.followUpBefore !== undefined) {
      filters.push({ followUpAt: { not: null, lt: filter.followUpBefore } })
    }

    if (filter.createdFrom !== undefined) {
      filters.push({ createdAt: { gte: filter.createdFrom } })
    }

    if (filter.createdTo !== undefined) {
      filters.push({ createdAt: { lte: filter.createdTo } })
    }

    const where: Prisma.ClientProfileWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.clientProfile.count({ where }),
      ctx.db.clientProfile.findMany({
        where,
        select: PIPELINE_SELECT,
        orderBy: pipelineOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toPipelineView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 8. Analytics — lifetime value
// =============================================================================

/** One household's realised lifetime value. */
interface ClientLifetimeValueRow {
  readonly clientProfileId: string
  readonly displayName: string | null
  readonly status: ClientStatus
  readonly source: ClientSource
  readonly currency: string
  readonly paidCents: number
  readonly paidInvoiceCount: number
  readonly firstPaidAt: Date | null
  readonly lastPaidAt: Date | null
}

/** One tier of the distribution, with the population that fell into it. */
interface LifetimeValueBucketRow extends LtvBucket {
  readonly clientCount: number
  readonly totalCents: number
}

interface LifetimeValueReport {
  readonly populationSize: number
  readonly totalPaidCents: number
  readonly meanPaidCents: number
  readonly medianPaidCents: number
  readonly buckets: readonly LifetimeValueBucketRow[]
  readonly topClients: readonly ClientLifetimeValueRow[]
}

interface RawLtvClientRow {
  clientProfileId: string
  displayName: string | null
  status: ClientStatus
  source: ClientSource
  currency: string
  paidCents: bigint | number | null
  paidInvoiceCount: number
  firstPaidAt: Date | null
  lastPaidAt: Date | null
}

interface RawLtvBucketRow {
  bucketIndex: number
  clientCount: number
  totalCents: bigint | number | null
}

interface RawLtvSummaryRow {
  populationSize: number
  totalCents: bigint | number | null
  medianCents: bigint | number | null
}

/**
 * The `WHERE` fragment shared by all three lifetime-value statements.
 *
 * Every value is interpolated through the tagged template or `Prisma.join`, so
 * each one is a bound parameter. `Prisma.join` is also why the two array
 * filters are expressed as `IN (…)` rather than `= ANY($1)`: it is the form
 * Prisma documents for a list, and it keeps every element a parameter of its
 * own.
 */
function ltvPopulationClause(narrowing: {
  readonly statuses: readonly ClientStatus[]
  readonly sources: readonly ClientSource[]
  readonly createdFrom?: Date | undefined
  readonly createdTo?: Date | undefined
}): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`]

  if (narrowing.statuses.length > 0) {
    conditions.push(
      Prisma.sql`cp."status"::text IN (${Prisma.join([...narrowing.statuses])})`
    )
  }

  if (narrowing.sources.length > 0) {
    conditions.push(
      Prisma.sql`cp."source"::text IN (${Prisma.join([...narrowing.sources])})`
    )
  }

  if (narrowing.createdFrom !== undefined) {
    conditions.push(Prisma.sql`cp."createdAt" >= ${narrowing.createdFrom}`)
  }

  if (narrowing.createdTo !== undefined) {
    conditions.push(Prisma.sql`cp."createdAt" <= ${narrowing.createdTo}`)
  }

  return Prisma.join(conditions, ' AND ')
}

/**
 * Lifetime value, computed from real paid invoices.
 *
 * ## Where the number comes from
 *
 * `SUM(Invoice.amountPaidCents) WHERE Invoice.status = 'PAID'`, joined to the
 * household through `Invoice.userId → ClientProfile.userId`. Not
 * `ClientProfile.lifetimeValueCents`: that column is a cache maintained by
 * {@link recalculateLifetimeValues}, and a report that reads a cache is a
 * report that is wrong the first time a webhook is missed.
 *
 * `amountPaidCents` rather than `amountDueCents` is the point of the word
 * "real" — an invoice that was issued and never settled is revenue we did not
 * receive, and a `VOID` or `UNCOLLECTIBLE` one is revenue we never will.
 *
 * ## Why the whole thing is three statements and no row loop
 *
 * The per-household sums are grouped by PostgreSQL; the distribution is bucketed
 * by `width_bucket` over the same grouped set; the mean and median come from
 * `AVG` and `percentile_cont` over it. JavaScript receives at most
 * {@link LTV_LEADERBOARD_SIZE} named households plus one row per tier — never
 * the book, and never the invoices.
 *
 * `width_bucket(value, thresholds[])` returns `0` for anything below the first
 * threshold and `n` for anything at or above the last, which is exactly the
 * indexing `buildLtvBuckets` produces in `@mannachef/validators`. The two are
 * paired on purpose, so a household is never counted in one tier and coloured
 * as another.
 */
export const readLifetimeValueReport = withAction(
  {
    name: 'crm.analytics.ltv',
    auth: 'ADMIN',
    input: clientLtvBucketingSchema,
  },
  async (ctx, input): Promise<ActionResult<LifetimeValueReport>> => {
    const boundaries = [...input.boundariesCents]

    const population = ltvPopulationClause({
      statuses: input.statuses,
      sources: input.sources,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    })

    // Households with nothing paid are kept or dropped here rather than in JS,
    // so "the shape of the paying book" and "the size of the funnel" are two
    // queries over the same statement and not two different reductions.
    const havingClause = input.includeZeroValue
      ? Prisma.empty
      : Prisma.sql`HAVING COALESCE(SUM(i."amountPaidCents"), 0) > 0`

    const scoped = Prisma.sql`
      SELECT
        cp."id"                                          AS "clientProfileId",
        cp."displayName"                                 AS "displayName",
        cp."status"                                      AS "status",
        cp."source"                                      AS "source",
        cp."currency"                                    AS "currency",
        COALESCE(SUM(i."amountPaidCents"), 0)::bigint    AS "paidCents",
        COUNT(i."id")::int                               AS "paidInvoiceCount",
        MIN(i."paidAt")                                  AS "firstPaidAt",
        MAX(i."paidAt")                                  AS "lastPaidAt"
      FROM "ClientProfile" cp
      LEFT JOIN "Invoice" i
        ON i."userId" = cp."userId"
       AND i."status" = 'PAID'
      WHERE ${population}
      GROUP BY cp."id", cp."displayName", cp."status", cp."source", cp."currency"
      ${havingClause}
    `

    const [summaryRows, bucketRows, clientRows] = await Promise.all([
      ctx.db.$queryRaw<RawLtvSummaryRow[]>(Prisma.sql`
        WITH scoped AS (${scoped})
        SELECT
          COUNT(*)::int                                                    AS "populationSize",
          COALESCE(SUM(scoped."paidCents"), 0)::bigint                     AS "totalCents",
          COALESCE(
            percentile_cont(0.5) WITHIN GROUP (ORDER BY scoped."paidCents"),
            0
          )::bigint                                                        AS "medianCents"
        FROM scoped
      `),
      ctx.db.$queryRaw<RawLtvBucketRow[]>(Prisma.sql`
        WITH scoped AS (${scoped})
        SELECT
          width_bucket(
            scoped."paidCents"::numeric,
            ARRAY[${Prisma.join(boundaries)}]::numeric[]
          )                                              AS "bucketIndex",
          COUNT(*)::int                                  AS "clientCount",
          COALESCE(SUM(scoped."paidCents"), 0)::bigint   AS "totalCents"
        FROM scoped
        GROUP BY 1
        ORDER BY 1
      `),
      ctx.db.$queryRaw<RawLtvClientRow[]>(Prisma.sql`
        WITH scoped AS (${scoped})
        SELECT *
        FROM scoped
        ORDER BY scoped."paidCents" DESC, scoped."clientProfileId" ASC
        LIMIT ${LTV_LEADERBOARD_SIZE}
      `),
    ])

    const summary = summaryRows[0]
    const populationSize = summary === undefined ? 0 : summary.populationSize
    const totalPaidCents =
      summary === undefined ? 0 : toNumber(summary.totalCents)
    const medianPaidCents =
      summary === undefined ? 0 : toNumber(summary.medianCents)

    const countsByBucket = new Map<number, RawLtvBucketRow>(
      bucketRows.map((row) => [row.bucketIndex, row])
    )

    const buckets: LifetimeValueBucketRow[] = buildLtvBuckets(boundaries).map(
      (bucket) => {
        const counted = countsByBucket.get(bucket.index)

        return {
          index: bucket.index,
          minCents: bucket.minCents,
          maxCents: bucket.maxCents,
          clientCount: counted === undefined ? 0 : counted.clientCount,
          totalCents: counted === undefined ? 0 : toNumber(counted.totalCents),
        }
      }
    )

    return ok({
      populationSize,
      totalPaidCents,
      meanPaidCents:
        populationSize === 0 ? 0 : Math.round(totalPaidCents / populationSize),
      medianPaidCents,
      buckets,
      topClients: clientRows.map((row) => ({
        clientProfileId: row.clientProfileId,
        displayName: row.displayName,
        status: row.status,
        source: row.source,
        currency: row.currency,
        paidCents: toNumber(row.paidCents),
        paidInvoiceCount: row.paidInvoiceCount,
        firstPaidAt: row.firstPaidAt,
        lastPaidAt: row.lastPaidAt,
      })),
    })
  }
)

/**
 * Refill the `ClientProfile.lifetimeValueCents` cache from the invoice ledger.
 *
 * One statement. The aggregate is computed in a subquery and joined back with
 * `UPDATE … FROM`, so the whole book is reconciled without a row ever reaching
 * this process — the alternative, reading every household and issuing an update
 * each, is a query per client and a transaction that never ends.
 *
 * `WHERE cp."lifetimeValueCents" <> agg.total` means an already-correct row is
 * not written at all, so `updatedAt` does not churn and the returned count is
 * the number of households that were genuinely out of date. The column is an
 * `Int`, so the sum is clamped to {@link MAX_INT4} rather than being allowed to
 * overflow the write.
 *
 * `updatedAt` is set explicitly because Prisma's `@updatedAt` is applied by the
 * client, and raw SQL does not go through it.
 */
export const recalculateLifetimeValues = withAction(
  {
    name: 'crm.analytics.ltv.recalculate',
    auth: 'ADMIN',
    input: emptyInputSchema,
    revalidatePaths: CRM_PATHS,
    revalidateTags: CRM_TAGS,
  },
  async (ctx): Promise<ActionResult<{ updatedClients: number }>> => {
    const updated = await ctx.db.$executeRaw(Prisma.sql`
      UPDATE "ClientProfile" AS cp
      SET "lifetimeValueCents" = agg."total",
          "updatedAt"          = NOW()
      FROM (
        SELECT
          inner_cp."id" AS "profileId",
          LEAST(
            COALESCE(SUM(i."amountPaidCents"), 0),
            ${MAX_INT4}
          )::int AS "total"
        FROM "ClientProfile" inner_cp
        LEFT JOIN "Invoice" i
          ON i."userId" = inner_cp."userId"
         AND i."status" = 'PAID'
        GROUP BY inner_cp."id"
      ) AS agg
      WHERE cp."id" = agg."profileId"
        AND cp."lifetimeValueCents" <> agg."total"
    `)

    return ok({ updatedClients: updated })
  }
)

// =============================================================================
// 9. Analytics — churn
// =============================================================================

interface ChurnPeriod {
  readonly periodStart: Date
  readonly periodEnd: Date
  /** Households present at any point in the period — the denominator. */
  readonly atRisk: number
  /** Households whose `churnedAt` falls inside the period. */
  readonly churned: number
  /** `churned / atRisk`, rounded to four places. `0` when nobody was at risk. */
  readonly churnRate: number
}

interface ChurnReport {
  readonly granularity: ChurnGranularity
  readonly periods: readonly ChurnPeriod[]
  readonly totalChurned: number
  /** Churn across the whole window, not the mean of the per-period rates. */
  readonly overallChurnRate: number
}

interface RawChurnRow {
  periodStart: Date
  periodEnd: Date
  atRisk: number
  churned: number
}

/**
 * Churn, period by period.
 *
 * ## The definition, stated plainly
 *
 * For each period, the **denominator** is every household that existed before
 * the period ended and had not already left before it began — the population
 * that was *at risk* of churning during it. The **numerator** is every
 * household whose `churnedAt` falls inside the period. A household that joined
 * and left inside the same period counts in both, which is correct: they
 * churned, and they were at risk.
 *
 * The alternative denominator — "households active on the first day" — quietly
 * excludes everybody who joined mid-period, which flatters the number in every
 * month the business grows.
 *
 * ## Computed in SQL
 *
 * `generate_series` materialises the periods and two `COUNT(*) FILTER` clauses
 * do the counting, so one grouped row per period crosses the boundary and the
 * households never do. `overallChurnRate` is recomputed over the window rather
 * than averaged from the periods, because a mean of ratios is not the ratio of
 * the sums and the difference is exactly the months with the fewest customers.
 *
 * The interval fragment comes from {@link PERIOD_INTERVALS}, a closed map keyed
 * by a validated enum — the one piece of these statements that is SQL text
 * rather than a bound parameter, and it never touches caller input.
 */
export const readChurnRate = withAction(
  {
    name: 'crm.analytics.churn',
    auth: 'ADMIN',
    input: churnQuerySchema,
  },
  async (ctx, input): Promise<ActionResult<ChurnReport>> => {
    const step = PERIOD_INTERVALS[input.granularity]

    const rows = await ctx.db.$queryRaw<RawChurnRow[]>(Prisma.sql`
      WITH periods AS (
        SELECT
          gs                AS "periodStart",
          gs + ${step}      AS "periodEnd"
        FROM generate_series(
          ${input.range.start}::timestamptz,
          ${input.range.end}::timestamptz,
          ${step}
        ) AS gs
      )
      SELECT
        p."periodStart",
        p."periodEnd",
        COUNT(cp."id") FILTER (
          WHERE cp."createdAt" < p."periodEnd"
            AND (cp."churnedAt" IS NULL OR cp."churnedAt" >= p."periodStart")
        )::int AS "atRisk",
        COUNT(cp."id") FILTER (
          WHERE cp."churnedAt" >= p."periodStart"
            AND cp."churnedAt" <  p."periodEnd"
        )::int AS "churned"
      FROM periods p
      LEFT JOIN "ClientProfile" cp ON TRUE
      GROUP BY p."periodStart", p."periodEnd"
      ORDER BY p."periodStart" ASC
    `)

    const periods: ChurnPeriod[] = rows.map((row) => ({
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      atRisk: row.atRisk,
      churned: row.churned,
      churnRate: row.atRisk === 0 ? 0 : round4(row.churned / row.atRisk),
    }))

    const totalChurned = periods.reduce(
      (total, period) => total + period.churned,
      0
    )

    const windowRows = await ctx.db.$queryRaw<
      { atRisk: number; churned: number }[]
    >(Prisma.sql`
      SELECT
        COUNT(*) FILTER (
          WHERE cp."createdAt" < ${input.range.end}
            AND (cp."churnedAt" IS NULL OR cp."churnedAt" >= ${input.range.start})
        )::int AS "atRisk",
        COUNT(*) FILTER (
          WHERE cp."churnedAt" >= ${input.range.start}
            AND cp."churnedAt" <  ${input.range.end}
        )::int AS "churned"
      FROM "ClientProfile" cp
    `)

    const windowTotals = windowRows[0]

    return ok({
      granularity: input.granularity,
      periods,
      totalChurned,
      overallChurnRate:
        windowTotals === undefined || windowTotals.atRisk === 0
          ? 0
          : round4(windowTotals.churned / windowTotals.atRisk),
    })
  }
)

/** Rates are reported to four decimal places — 0.0834 is 8.34 per cent. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

// =============================================================================
// 10. Analytics — cohort retention
// =============================================================================

interface CohortCell {
  /** Whole months since the cohort's signup month. `0` is the signup month. */
  readonly monthOffset: number
  /** Households from the cohort with a paid invoice in that month. */
  readonly retained: number
  /** `retained / cohortSize`, to four places. */
  readonly retentionRate: number
}

interface CohortRow {
  readonly cohortMonth: Date
  readonly cohortSize: number
  readonly cells: readonly CohortCell[]
}

interface CohortRetentionReport {
  readonly horizonMonths: number
  readonly cohorts: readonly CohortRow[]
}

interface RawCohortRow {
  cohortMonth: Date
  cohortSize: number
  monthOffset: number | null
  retained: number
}

/**
 * Cohort retention.
 *
 * Households are grouped by the calendar month their `ClientProfile` was
 * opened, and a household counts as *retained* in month `k` if it has at least
 * one `PAID` invoice whose `paidAt` falls in the `k`th month after that. Paid
 * invoices rather than subscription status on purpose: a status column records
 * what we believe today, and a paid invoice records what actually happened in
 * that month — which is the only thing a retention curve can honestly be built
 * from.
 *
 * ## Computed in SQL
 *
 * Three CTEs and one grouped select. The offset arithmetic is
 * `age(paid_month, cohort_month)` in whole months, `COUNT(DISTINCT profile)`
 * does the counting, and the horizon bounds the join — so the result set is one
 * row per (cohort, offset) that has any activity at all, not one row per
 * invoice. JavaScript's only job is to pivot those rows into a grid and fill in
 * the empty cells, which is presentation rather than aggregation.
 *
 * A cohort with no paid invoices at all still appears, with `monthOffset` null
 * on its single row; it becomes a cohort with a size and a row of zeroes rather
 * than disappearing from the report.
 */
export const readCohortRetention = withAction(
  {
    name: 'crm.analytics.cohorts',
    auth: 'ADMIN',
    input: cohortQuerySchema,
  },
  async (ctx, input): Promise<ActionResult<CohortRetentionReport>> => {
    const horizon = input.horizonMonths

    const rows = await ctx.db.$queryRaw<RawCohortRow[]>(Prisma.sql`
      WITH cohorts AS (
        SELECT
          cp."id"                                   AS "profileId",
          cp."userId"                               AS "userId",
          date_trunc('month', cp."createdAt")       AS "cohortMonth"
        FROM "ClientProfile" cp
        WHERE cp."createdAt" >= ${input.range.start}
          AND cp."createdAt" <  ${input.range.end}
      ),
      sizes AS (
        SELECT
          c."cohortMonth"        AS "cohortMonth",
          COUNT(*)::int          AS "cohortSize"
        FROM cohorts c
        GROUP BY c."cohortMonth"
      ),
      activity AS (
        SELECT
          c."cohortMonth"  AS "cohortMonth",
          c."profileId"    AS "profileId",
          (
            EXTRACT(YEAR FROM age(
              date_trunc('month', i."paidAt"), c."cohortMonth"
            )) * 12
            + EXTRACT(MONTH FROM age(
              date_trunc('month', i."paidAt"), c."cohortMonth"
            ))
          )::int AS "monthOffset"
        FROM cohorts c
        JOIN "Invoice" i
          ON i."userId" = c."userId"
         AND i."status"  = 'PAID'
         AND i."paidAt" IS NOT NULL
      )
      SELECT
        s."cohortMonth"                        AS "cohortMonth",
        s."cohortSize"                         AS "cohortSize",
        a."monthOffset"                        AS "monthOffset",
        COUNT(DISTINCT a."profileId")::int     AS "retained"
      FROM sizes s
      LEFT JOIN activity a
        ON a."cohortMonth" = s."cohortMonth"
       AND a."monthOffset" >= 0
       AND a."monthOffset" <= ${horizon}
      GROUP BY s."cohortMonth", s."cohortSize", a."monthOffset"
      ORDER BY s."cohortMonth" ASC, a."monthOffset" ASC
    `)

    interface Accumulator {
      cohortMonth: Date
      cohortSize: number
      retainedByOffset: Map<number, number>
    }

    const byCohort = new Map<number, Accumulator>()

    for (const row of rows) {
      const key = row.cohortMonth.getTime()
      let entry = byCohort.get(key)

      if (entry === undefined) {
        entry = {
          cohortMonth: row.cohortMonth,
          cohortSize: row.cohortSize,
          retainedByOffset: new Map<number, number>(),
        }
        byCohort.set(key, entry)
      }

      if (row.monthOffset !== null) {
        entry.retainedByOffset.set(row.monthOffset, row.retained)
      }
    }

    const cohorts: CohortRow[] = [...byCohort.values()]
      .sort(
        (left, right) =>
          left.cohortMonth.getTime() - right.cohortMonth.getTime()
      )
      .map((entry) => {
        const cells: CohortCell[] = []

        for (let offset = 0; offset <= horizon; offset += 1) {
          const retained = entry.retainedByOffset.get(offset) ?? 0

          cells.push({
            monthOffset: offset,
            retained,
            retentionRate:
              entry.cohortSize === 0 ? 0 : round4(retained / entry.cohortSize),
          })
        }

        return {
          cohortMonth: entry.cohortMonth,
          cohortSize: entry.cohortSize,
          cells,
        }
      })

    return ok({ horizonMonths: horizon, cohorts })
  }
)
