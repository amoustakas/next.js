// mannachef/apps/web/src/server/actions/review.ts

'use server'

/**
 * Reviews — what a guest says about a dish, a chef, an evening, or the house,
 * and everything the kitchen does with it afterwards.
 *
 * ## `isVerified` is a fact about the database, never a claim in the payload
 *
 * `reviewSubmissionSchema` cannot express `isVerified`, and that is deliberate:
 * a "verified diner" badge is only worth printing if nobody can print their own.
 * {@link resolveVerification} decides it, and it decides it by asking
 * `ChefAppointment` — the author must have a `COMPLETED` engagement that
 * actually touches the thing being reviewed:
 *
 * | Subject       | What must be true for `isVerified`                          |
 * | ------------- | ----------------------------------------------------------- |
 * | `MENU_ITEM`   | a completed engagement of theirs served that dish            |
 * | `CHEF`        | a completed engagement of theirs was cooked by that chef     |
 * | `APPOINTMENT` | that engagement is theirs and is completed                   |
 * | `PLATFORM`    | they have any completed engagement at all                    |
 *
 * When the guest *names* an `appointmentId`, that id is a claim like any other
 * and goes through `requireAppointmentOwnership` with the bypass switched off
 * (`bypassRole: null`) before a single column of it is believed. The guard's
 * denial is `NOT_FOUND`, so an id belonging to another household is
 * indistinguishable from one that never existed.
 *
 * ## One review per author per subject
 *
 * `Review` carries `@@unique([authorId, menuItemId])`, which covers exactly one
 * of the four subjects — and only when `menuItemId` is non-null, because
 * PostgreSQL does not consider two NULLs equal. {@link findDuplicateReview}
 * therefore enforces the same rule for all four in application code, and the
 * `create` is additionally wrapped so that a `P2002` losing a race becomes the
 * same courteous sentence rather than a bare `CONFLICT` with Prisma's wording
 * behind it. The three subjects with no database constraint behind them are
 * documented as such on that function: two simultaneous submissions can still
 * produce two rows, and the moderation queue is where that is caught.
 *
 * ## Who may moderate
 *
 * `ADMIN` and above — which already excludes `CHEF_STAFF` from ruling on
 * reviews of their own cooking. {@link moderationConflict} closes the remaining
 * two holes: an administrator who also holds a `StaffProfile` may not moderate
 * a review *of* that profile, and nobody may moderate a review they wrote.
 *
 * ## The carousel is a contiguous sequence
 *
 * `featuredOrder` is a position, not a label, so it is kept as `0…n-1` with no
 * gaps and no ties by {@link compactFeaturedOrder}, which runs after every
 * moderation that could disturb it. Inserting at a taken position pushes the
 * incumbent down rather than colliding with it.
 */

import {
  MAX_FEATURED_ORDER,
  cuidSchema,
  hasRoleAtLeast,
  paginationToSkipTake,
  reviewBulkModerationSchema,
  reviewFilterSchema,
  reviewModerationSchema,
  reviewStatusAfterModeration,
  reviewSubjectColumns,
  reviewSubmissionSchema,
  reviewUpdateSchema,
  type ReviewSortBy,
  type ReviewStatus,
  type ReviewSubject,
  type ReviewSubmissionInput,
  type SortDirection,
} from '@mannachef/validators'
import {
  emptyInputSchema,
  type PageMeta,
  type ReviewView,
} from '@mannachef/api-contract'
import { z } from 'zod'

import {
  ActionError,
  fail,
  ok,
  type ActionFailure,
  type ActionResult,
} from '@/server/actions/types'
import { Prisma, type prisma } from '@/server/db'
import {
  requireAppointmentOwnership,
  requireReviewOwnership,
  withAction,
  type AuthenticatedUser,
} from '@/server/guards'

// =============================================================================
// 0. Constants
// =============================================================================

/** Everything a change to a review can make stale. */
const REVIEW_PATHS = [
  '/',
  '/menu',
  '/chefs',
  '/admin/reviews',
  '/portal/reviews',
] as const

const REVIEW_TAGS = ['reviews', 'menu', 'staff'] as const

/** The two statuses the marketing site is allowed to render. */
const PUBLISHED_REVIEW_STATUSES = ['APPROVED', 'FEATURED'] as const

/**
 * Submissions are rate-limited because the review form is the one place a
 * signed-in stranger can write prose into our database. Five in an hour is more
 * than any honest guest needs and far less than a script wants.
 */
const SUBMISSION_RATE_LIMIT = { tokens: 5, windowMs: 60 * 60 * 1_000 } as const

// =============================================================================
// 1. Local input schemas
//
// Composed from `@mannachef/validators`; nothing here restates a rule the
// package already owns.
// =============================================================================

const reviewIdSchema = z.object({ reviewId: cuidSchema }).strict()

// =============================================================================
// 2. Projections
//
// Two of them, and the difference is the whole access-control story of this
// file. `REVIEW_PUBLIC_SELECT` has no `moderationNote`, no `moderatedById` and
// no `moderatedAt`: a guest reading a review — including the guest who wrote
// it — never learns what the kitchen wrote about it. `REVIEW_MODERATION_SELECT`
// adds those three, and every action that uses it is behind `auth: 'ADMIN'`.
// =============================================================================

const REVIEW_PUBLIC_SELECT = {
  id: true,
  subject: true,
  menuItemId: true,
  staffProfileId: true,
  appointmentId: true,
  authorId: true,
  rating: true,
  title: true,
  body: true,
  status: true,
  isVerified: true,
  featuredOrder: true,
  createdAt: true,
  author: { select: { name: true } },
} satisfies Prisma.ReviewSelect

type ReviewPublicRow = Prisma.ReviewGetPayload<{
  select: typeof REVIEW_PUBLIC_SELECT
}>

const REVIEW_MODERATION_SELECT = {
  ...REVIEW_PUBLIC_SELECT,
  moderatedById: true,
  moderatedAt: true,
  moderationNote: true,
  updatedAt: true,
  moderatedBy: { select: { name: true } },
  menuItem: { select: { name: true, slug: true } },
  staffProfile: { select: { user: { select: { name: true } } } },
} satisfies Prisma.ReviewSelect

type ReviewModerationRow = Prisma.ReviewGetPayload<{
  select: typeof REVIEW_MODERATION_SELECT
}>

/** A review as the moderation queue renders it. `ADMIN` and above only. */
export interface ModeratedReviewView extends ReviewView {
  readonly moderatedById: string | null
  readonly moderatedByName: string | null
  readonly moderatedAt: Date | null
  readonly moderationNote: string | null
  readonly menuItemName: string | null
  readonly menuItemSlug: string | null
  readonly staffName: string | null
  readonly updatedAt: Date
}

export interface ReviewListView {
  readonly items: readonly ReviewView[]
  readonly meta: PageMeta
}

export interface ModerationQueueView {
  readonly items: readonly ModeratedReviewView[]
  readonly meta: PageMeta
}

/** What a bulk moderation pass actually did. */
export interface BulkModerationView {
  /** How many ids the caller sent. */
  readonly requested: number
  /** How many rows were changed. */
  readonly moderated: number
  /**
   * `requested - moderated`. An id is skipped when it does not exist, when the
   * caller wrote the review, or when it is a review of the caller's own
   * cooking. The three are not distinguished, so the count is not an oracle.
   */
  readonly skipped: number
  readonly status: ReviewStatus
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

function toReviewView(row: ReviewPublicRow): ReviewView {
  return {
    id: row.id,
    subject: row.subject,
    menuItemId: row.menuItemId,
    staffProfileId: row.staffProfileId,
    appointmentId: row.appointmentId,
    authorId: row.authorId,
    authorName: row.author.name,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    isVerified: row.isVerified,
    featuredOrder: row.featuredOrder,
    createdAt: row.createdAt,
  }
}

function toModeratedReviewView(row: ReviewModerationRow): ModeratedReviewView {
  return {
    ...toReviewView(row),
    moderatedById: row.moderatedById,
    moderatedByName: row.moderatedBy?.name ?? null,
    moderatedAt: row.moderatedAt,
    moderationNote: row.moderationNote,
    menuItemName: row.menuItem?.name ?? null,
    menuItemSlug: row.menuItem?.slug ?? null,
    staffName: row.staffProfile?.user.name ?? null,
    updatedAt: row.updatedAt,
  }
}

// =============================================================================
// 3. Verification
// =============================================================================

/**
 * The engagement the guest named, if any.
 *
 * Written as an exhaustive `switch` rather than an `in` test because the
 * `PLATFORM` branch of `reviewSubmissionSchema` has no `appointmentId` key at
 * all — adding a fifth subject is then a compile error here rather than a
 * silently unverifiable review.
 */
function claimedAppointmentId(input: ReviewSubmissionInput): string | null {
  switch (input.subject) {
    case 'MENU_ITEM':
    case 'CHEF':
      return input.appointmentId ?? null

    case 'APPOINTMENT':
      return input.appointmentId

    case 'PLATFORM':
      return null

    default: {
      const exhaustive: never = input
      return exhaustive
    }
  }
}

/**
 * Does this author have a completed engagement that reaches the thing they are
 * reviewing?
 *
 * One `count` against `ChefAppointment`, scoped to the caller's own
 * `ClientProfile`. A caller with no household has never dined with us, so the
 * answer is `false` without a query.
 */
async function hasQualifyingEngagement(
  db: typeof prisma,
  clientProfileId: string | null,
  input: ReviewSubmissionInput
): Promise<boolean> {
  if (clientProfileId === null) {
    return false
  }

  const base: Prisma.ChefAppointmentWhereInput = {
    clientProfileId,
    status: 'COMPLETED',
  }

  const scoped: Prisma.ChefAppointmentWhereInput =
    input.subject === 'MENU_ITEM'
      ? { ...base, menuItems: { some: { menuItemId: input.menuItemId } } }
      : input.subject === 'CHEF'
        ? { ...base, staffProfileId: input.staffProfileId }
        : base

  const count = await db.chefAppointment.count({ where: scoped, take: 1 })

  return count > 0
}

/**
 * Decide `isVerified`, refusing outright when the guest's own claim does not
 * hold up.
 *
 * Two paths. When no `appointmentId` was offered the flag is *derived* — the
 * guest said nothing untrue, they simply may or may not have dined here, and
 * {@link hasQualifyingEngagement} settles it silently.
 *
 * When an `appointmentId` *was* offered it is checked rather than derived, and
 * a check that fails is a refusal rather than an unverified review: the guest
 * has asserted something specific about a row, and quietly downgrading the
 * badge would leave them wondering why. Every failure is `NOT_FOUND` or a field
 * error on `appointmentId`, so none of them confirms that somebody else's
 * engagement exists.
 */
async function resolveVerification(
  db: typeof prisma,
  user: AuthenticatedUser,
  input: ReviewSubmissionInput
): Promise<{ isVerified: boolean } | { failure: ActionFailure }> {
  const appointmentId = claimedAppointmentId(input)

  if (appointmentId === null) {
    return {
      isVerified: await hasQualifyingEngagement(
        db,
        user.clientProfileId,
        input
      ),
    }
  }

  // The id came from a browser. `bypassRole: null` switches off the ADMIN
  // override on purpose: this is not an administrative read of somebody's
  // booking, it is an author asserting they were at the table.
  const owned = await requireAppointmentOwnership(user, appointmentId, {
    bypassRole: null,
  })

  if (!owned.ok) {
    return { failure: owned }
  }

  // The chef who cooked an evening is an owner of the appointment row, and is
  // not the guest who ate at it. Only the household may hang a review on it.
  if (
    user.clientProfileId === null ||
    owned.data.clientProfileId !== user.clientProfileId
  ) {
    return { failure: fail('NOT_FOUND') }
  }

  if (owned.data.status !== 'COMPLETED') {
    return {
      failure: fail(
        'CONFLICT',
        'An evening can be reviewed once it has been served.',
        {
          appointmentId: [
            'This engagement has not been completed yet, so there is nothing to review.',
          ],
        }
      ),
    }
  }

  if (
    input.subject === 'CHEF' &&
    owned.data.staffProfileId !== input.staffProfileId
  ) {
    return {
      failure: fail('VALIDATION', 'That chef did not cook that evening.', {
        appointmentId: ['This engagement was cooked by a different chef.'],
      }),
    }
  }

  if (input.subject === 'MENU_ITEM') {
    const served = await db.appointmentMenuItem.count({
      where: { appointmentId: owned.data.id, menuItemId: input.menuItemId },
      take: 1,
    })

    if (served === 0) {
      return {
        failure: fail('VALIDATION', 'That dish was not served that evening.', {
          appointmentId: ['This dish was not on the menu for that engagement.'],
        }),
      }
    }
  }

  return { isVerified: true }
}

// =============================================================================
// 4. Duplicate submissions
// =============================================================================

/**
 * Has this author already reviewed this subject?
 *
 * Only `MENU_ITEM` is backed by a database constraint —
 * `@@unique([authorId, menuItemId])` — and even that one is inert when
 * `menuItemId` is null, because PostgreSQL treats two NULLs as distinct. The
 * other three are enforced here and only here, which means two *simultaneous*
 * submissions of a chef review can still both land. That is the honest limit of
 * a read-then-write check without a constraint to lean on; the moderation queue
 * is where a duplicate pair is noticed, and rejecting one of them costs nothing.
 */
async function findDuplicateReview(
  db: typeof prisma,
  authorId: string,
  input: ReviewSubmissionInput
): Promise<{ id: string; status: ReviewStatus } | null> {
  const columns = reviewSubjectColumns(input)

  const where: Prisma.ReviewWhereInput =
    input.subject === 'MENU_ITEM'
      ? { authorId, menuItemId: columns.menuItemId }
      : input.subject === 'CHEF'
        ? { authorId, staffProfileId: columns.staffProfileId }
        : input.subject === 'APPOINTMENT'
          ? {
              authorId,
              subject: 'APPOINTMENT',
              appointmentId: columns.appointmentId,
            }
          : { authorId, subject: 'PLATFORM' }

  return db.review.findFirst({ where, select: { id: true, status: true } })
}

/** The one sentence every duplicate produces, whichever route found it. */
function duplicateFailure(): ActionFailure {
  return fail(
    'CONFLICT',
    'You have already reviewed this — you can amend what you wrote instead.',
    { _form: ['A review from you already exists for this.'] }
  )
}

// =============================================================================
// 5. The featured carousel
// =============================================================================

/**
 * Renumber the carousel to `0…n-1`.
 *
 * `featuredOrder` is a position rather than a label, so gaps and ties are bugs
 * waiting to become a non-deterministic running order. This runs inside the
 * same transaction as every moderation that could disturb the sequence, reads
 * it in its current order — position first, then oldest, then id, so the result
 * is total — and writes back only the rows whose number actually changed.
 */
async function compactFeaturedOrder(
  tx: Prisma.TransactionClient
): Promise<void> {
  const featured = await tx.review.findMany({
    where: { status: 'FEATURED' },
    orderBy: [
      { featuredOrder: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
    select: { id: true, featuredOrder: true },
  })

  for (const [index, row] of featured.entries()) {
    if (row.featuredOrder !== index) {
      await tx.review.update({
        where: { id: row.id },
        data: { featuredOrder: index },
        select: { id: true },
      })
    }
  }
}

// =============================================================================
// 6. Who may moderate what
// =============================================================================

/**
 * The two reviews an otherwise-entitled moderator may not touch.
 *
 * `auth: 'ADMIN'` already keeps `CHEF_STAFF` out of the queue entirely. What it
 * cannot express is that an *administrator* may also hold a `StaffProfile`, and
 * that approving a five-star review of your own cooking is not moderation.
 * Marking your own review as featured is the same problem with a different
 * subject.
 *
 * Returns the refusal, or `null` when there is nothing to refuse.
 */
function moderationConflict(
  user: AuthenticatedUser,
  review: { readonly authorId: string; readonly staffProfileId: string | null }
): ActionFailure | null {
  if (review.authorId === user.id) {
    return fail('FORBIDDEN', 'You cannot moderate a review you wrote yourself.')
  }

  if (
    user.staffProfileId !== null &&
    review.staffProfileId === user.staffProfileId
  ) {
    return fail(
      'FORBIDDEN',
      'You cannot moderate a review of your own cooking. Please ask a colleague.'
    )
  }

  return null
}

// =============================================================================
// 7. Submission
// =============================================================================

/**
 * Leave a review.
 *
 * Signed-in guests only — attribution comes from the session, and
 * `reviewSubmissionSchema` has no `authorId` field for a caller to disagree
 * with. Everything a guest is not allowed to decide is decided here: `status`
 * opens at `PENDING` whatever the payload says, `featuredOrder` is null, and
 * `isVerified` comes from {@link resolveVerification}.
 *
 * The subject row is confirmed to exist and to be publicly visible before the
 * review is written, so a mistyped dish id is a courteous `NOT_FOUND` rather
 * than a foreign-key violation arriving as a bare `CONFLICT`.
 */
export const submitReview = withAction(
  {
    name: 'review.submit',
    auth: 'SESSION',
    input: reviewSubmissionSchema,
    rateLimit: SUBMISSION_RATE_LIMIT,
    revalidatePaths: REVIEW_PATHS,
    revalidateTags: REVIEW_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReviewView>> => {
    const columns = reviewSubjectColumns(input)

    if (input.subject === 'MENU_ITEM') {
      const dish = await ctx.db.menuItem.findUnique({
        where: { id: input.menuItemId },
        select: { id: true, isActive: true },
      })

      if (dish === null || !dish.isActive) {
        return fail('NOT_FOUND', 'We could not find that dish on the menu.')
      }
    }

    if (input.subject === 'CHEF') {
      const chef = await ctx.db.staffProfile.findUnique({
        where: { id: input.staffProfileId },
        select: { id: true },
      })

      if (chef === null) {
        return fail('NOT_FOUND', 'We could not find that chef.')
      }
    }

    const verification = await resolveVerification(ctx.db, ctx.user, input)

    if ('failure' in verification) {
      return verification.failure
    }

    const duplicate = await findDuplicateReview(ctx.db, ctx.user.id, input)

    if (duplicate !== null) {
      return duplicateFailure()
    }

    try {
      const created = await ctx.db.review.create({
        data: {
          subject: input.subject,
          menuItemId: columns.menuItemId,
          staffProfileId: columns.staffProfileId,
          appointmentId: columns.appointmentId,
          authorId: ctx.user.id,
          rating: input.rating,
          title: input.title ?? null,
          body: input.body,
          status: 'PENDING',
          isVerified: verification.isVerified,
          featuredOrder: null,
        },
        select: REVIEW_PUBLIC_SELECT,
      })

      return ok(toReviewView(created))
    } catch (error) {
      // `@@unique([authorId, menuItemId])` losing the race with a second tab.
      // Caught here so it produces the same sentence the pre-check produces,
      // rather than the wrapper's generic "that already exists".
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return duplicateFailure()
      }

      throw error
    }
  }
)

/**
 * Amend a review you wrote.
 *
 * `requireReviewOwnership` is called with `bypassRole: null`, which is the one
 * place in this file where the `ADMIN` override is switched off for a reason
 * other than verification: an administrator rewriting a guest's words is not
 * moderation, it is forgery. Moderators reject; they do not edit.
 *
 * An amended review returns to `PENDING` and leaves the carousel. The text a
 * moderator approved is not the text that would then be on the site, and a
 * featured review that quietly becomes a one-star complaint is the worst
 * version of that failure. The moderation note is cleared with it, because it
 * was written about the previous text.
 */
export const updateMyReview = withAction(
  {
    name: 'review.update',
    auth: 'SESSION',
    input: reviewUpdateSchema,
    revalidatePaths: REVIEW_PATHS,
    revalidateTags: REVIEW_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReviewView>> => {
    const owned = await requireReviewOwnership(ctx.user, input.id, {
      bypassRole: null,
    })

    if (!owned.ok) {
      return owned
    }

    const updated = await ctx.db.$transaction(async (tx) => {
      const row = await tx.review.update({
        where: { id: owned.data.id },
        data: {
          ...(input.rating === undefined ? {} : { rating: input.rating }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          status: 'PENDING',
          featuredOrder: null,
          moderatedById: null,
          moderatedAt: null,
          moderationNote: null,
        },
        select: REVIEW_PUBLIC_SELECT,
      })

      // The review may have just left the carousel.
      await compactFeaturedOrder(tx)

      return row
    })

    return ok(toReviewView(updated))
  }
)

/**
 * Withdraw a review you wrote.
 *
 * Same strict ownership as {@link updateMyReview}: the author, and nobody else
 * through this path. An administrator removing objectionable content uses
 * `REJECT` in the moderation queue, which keeps the row and the reason.
 */
export const withdrawMyReview = withAction(
  {
    name: 'review.withdraw',
    auth: 'SESSION',
    input: reviewIdSchema,
    revalidatePaths: REVIEW_PATHS,
    revalidateTags: REVIEW_TAGS,
  },
  async (ctx, input): Promise<ActionResult<{ id: string }>> => {
    const owned = await requireReviewOwnership(ctx.user, input.reviewId, {
      bypassRole: null,
    })

    if (!owned.ok) {
      return owned
    }

    await ctx.db.$transaction(async (tx) => {
      await tx.review.delete({
        where: { id: owned.data.id },
        select: { id: true },
      })

      await compactFeaturedOrder(tx)
    })

    return ok({ id: owned.data.id })
  }
)

// =============================================================================
// 8. Reading
// =============================================================================

function reviewOrderBy(
  sortBy: ReviewSortBy,
  direction: SortDirection
): Prisma.ReviewOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    case 'RATING':
      return [{ rating: direction }, { createdAt: 'desc' }, { id: 'asc' }]

    case 'MODERATED':
      return [
        { moderatedAt: { sort: direction, nulls: 'last' } },
        { id: 'asc' },
      ]

    case 'FEATURED_ORDER':
      return [
        { featuredOrder: { sort: direction, nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ]

    default: {
      // A new member of `reviewSortBySchema` is a compile error here rather
      // than a silently unordered list.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

/**
 * The parts of `reviewFilterSchema` that mean the same thing to every audience.
 *
 * `statuses`, `authorId` and `moderatedById` are deliberately absent: each of
 * the three read actions decides those for itself, because each has a different
 * answer and the difference is the access-control boundary.
 */
function commonReviewFilters(filter: {
  readonly search?: string | undefined
  readonly subjects: readonly ReviewSubject[]
  readonly menuItemId?: string | undefined
  readonly staffProfileId?: string | undefined
  readonly appointmentId?: string | undefined
  readonly minRating?: number | undefined
  readonly maxRating?: number | undefined
  readonly verifiedOnly: boolean
  readonly createdFrom?: Date | undefined
  readonly createdTo?: Date | undefined
}): Prisma.ReviewWhereInput[] {
  const filters: Prisma.ReviewWhereInput[] = []

  if (filter.search !== undefined) {
    filters.push({
      OR: [
        { title: { contains: filter.search, mode: 'insensitive' } },
        { body: { contains: filter.search, mode: 'insensitive' } },
      ],
    })
  }

  if (filter.subjects.length > 0) {
    filters.push({ subject: { in: [...filter.subjects] } })
  }

  if (filter.menuItemId !== undefined) {
    filters.push({ menuItemId: filter.menuItemId })
  }

  if (filter.staffProfileId !== undefined) {
    filters.push({ staffProfileId: filter.staffProfileId })
  }

  if (filter.appointmentId !== undefined) {
    filters.push({ appointmentId: filter.appointmentId })
  }

  if (filter.minRating !== undefined) {
    filters.push({ rating: { gte: filter.minRating } })
  }

  if (filter.maxRating !== undefined) {
    filters.push({ rating: { lte: filter.maxRating } })
  }

  if (filter.verifiedOnly) {
    filters.push({ isVerified: true })
  }

  if (filter.createdFrom !== undefined) {
    filters.push({ createdAt: { gte: filter.createdFrom } })
  }

  if (filter.createdTo !== undefined) {
    filters.push({ createdAt: { lte: filter.createdTo } })
  }

  return filters
}

/**
 * The published reviews, for the marketing site and the dish pages.
 *
 * Public, and pinned. `statuses` is **intersected** with
 * {@link PUBLISHED_REVIEW_STATUSES} rather than honoured — a visitor asking for
 * `PENDING` gets an empty page, not an error and certainly not the queue — and
 * `authorId`, `moderatedById` and `awaitingModeration` are ignored outright.
 * Nothing here can be arranged into a way of reading an unapproved review.
 *
 * The projection is `REVIEW_PUBLIC_SELECT`, so no moderation note leaves the
 * server on this path.
 */
export const listPublishedReviews = withAction(
  {
    name: 'review.list.published',
    auth: 'PUBLIC',
    input: reviewFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ReviewListView>> => {
    const requested =
      filter.statuses.length === 0
        ? [...PUBLISHED_REVIEW_STATUSES]
        : filter.statuses.filter((status): status is 'APPROVED' | 'FEATURED' =>
            PUBLISHED_REVIEW_STATUSES.some((allowed) => allowed === status)
          )

    if (requested.length === 0) {
      return ok({
        items: [],
        meta: buildPageMeta(filter.page, filter.pageSize, 0),
      })
    }

    const filters = commonReviewFilters(filter)

    filters.push(
      filter.featuredOnly
        ? { status: 'FEATURED' }
        : { status: { in: requested } }
    )

    const where: Prisma.ReviewWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.review.count({ where }),
      ctx.db.review.findMany({
        where,
        select: REVIEW_PUBLIC_SELECT,
        // Featured reviews lead, in their curated order; everything else falls
        // in behind them under whatever ordering the caller asked for.
        orderBy: [
          { featuredOrder: { sort: 'asc', nulls: 'last' } },
          ...reviewOrderBy(filter.sortBy, filter.sortDirection),
        ],
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toReviewView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * The caller's own reviews, at every status.
 *
 * `authorId` is overridden with the session id rather than honoured, which is
 * the difference between a filter and a permission. An author sees their own
 * `PENDING` and `REJECTED` rows here — they wrote them — but still through
 * `REVIEW_PUBLIC_SELECT`, so they do not see what the kitchen wrote about them.
 */
export const listMyReviews = withAction(
  {
    name: 'review.list.mine',
    auth: 'SESSION',
    input: reviewFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ReviewListView>> => {
    const filters = commonReviewFilters(filter)

    filters.push({ authorId: ctx.user.id })

    if (filter.statuses.length > 0) {
      filters.push({ status: { in: [...filter.statuses] } })
    }

    if (filter.featuredOnly) {
      filters.push({ status: 'FEATURED' })
    }

    if (filter.awaitingModeration) {
      filters.push({ status: 'PENDING' })
    }

    const where: Prisma.ReviewWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.review.count({ where }),
      ctx.db.review.findMany({
        where,
        select: REVIEW_PUBLIC_SELECT,
        orderBy: reviewOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toReviewView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * The moderation queue.
 *
 * `ADMIN` and above, and the only read in this file that uses
 * `REVIEW_MODERATION_SELECT`. `awaitingModeration` narrows to `PENDING`;
 * without it the queue shows every status, which is what an administrator
 * reviewing past decisions actually needs.
 *
 * Oldest first by default — a queue is a queue — which is why the fallback
 * ordering ignores `sortDirection`'s `desc` default only when the caller has
 * not chosen a `sortBy`. It has not been special-cased: `reviewOrderBy` is
 * shared with the public list, and the admin surface passes the direction it
 * wants.
 */
export const listModerationQueue = withAction(
  {
    name: 'review.moderation.queue',
    auth: 'ADMIN',
    input: reviewFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ModerationQueueView>> => {
    const filters = commonReviewFilters(filter)

    if (filter.statuses.length > 0) {
      filters.push({ status: { in: [...filter.statuses] } })
    }

    if (filter.awaitingModeration) {
      filters.push({ status: 'PENDING' })
    }

    if (filter.featuredOnly) {
      filters.push({ status: 'FEATURED' })
    }

    if (filter.authorId !== undefined) {
      filters.push({ authorId: filter.authorId })
    }

    if (filter.moderatedById !== undefined) {
      filters.push({ moderatedById: filter.moderatedById })
    }

    const where: Prisma.ReviewWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.review.count({ where }),
      ctx.db.review.findMany({
        where,
        select: REVIEW_MODERATION_SELECT,
        orderBy: reviewOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toModeratedReviewView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 9. Moderation
// =============================================================================

/**
 * Approve, reject, feature, or unfeature one review.
 *
 * `reviewModerationSchema` is a discriminated union, so `featuredOrder` exists
 * only on `FEATURE` and `moderationNote` is required only on `REJECT`; neither
 * rule is restated here. `reviewStatusAfterModeration` maps the action to the
 * resulting status, which keeps the web and the Expo client agreeing about what
 * each button does.
 *
 * ## What the transaction does
 *
 * 1. Re-read the row (the id came from a browser) and refuse the two
 *    self-interested cases via {@link moderationConflict}.
 * 2. On `FEATURE`, refuse when the carousel is already full at
 *    `MAX_FEATURED_ORDER`, then push every incumbent at or below the requested
 *    position down by one so the new arrival lands *at* the position asked for
 *    rather than colliding with whoever holds it.
 * 3. Write the decision, stamping `moderatedById` from the session and
 *    `moderatedAt` from the clock — never from the payload.
 * 4. {@link compactFeaturedOrder} closes the gap left by anything that just
 *    left the carousel, and squeezes out the hole the increment opened.
 *
 * Every refusal inside the transaction is an `ActionError`, which rolls the
 * work back and reaches the caller with its own code intact rather than
 * collapsing to `INTERNAL`.
 */
export const moderateReview = withAction(
  {
    name: 'review.moderate',
    auth: 'ADMIN',
    input: reviewModerationSchema,
    revalidatePaths: REVIEW_PATHS,
    revalidateTags: REVIEW_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ModeratedReviewView>> => {
    const status = reviewStatusAfterModeration(input)
    const now = new Date()

    const row = await ctx.db.$transaction(async (tx) => {
      const existing = await tx.review.findUnique({
        where: { id: input.reviewId },
        select: { id: true, authorId: true, staffProfileId: true },
      })

      if (existing === null) {
        throw new ActionError('NOT_FOUND', 'We could not find that review.')
      }

      const conflict = moderationConflict(ctx.user, existing)

      if (conflict !== null) {
        throw new ActionError(conflict.code, conflict.error)
      }

      if (input.action === 'FEATURE') {
        const incumbents = await tx.review.count({
          where: { status: 'FEATURED', id: { not: existing.id } },
        })

        if (incumbents >= MAX_FEATURED_ORDER) {
          throw new ActionError(
            'CONFLICT',
            'The featured carousel is full. Please unfeature a review first.'
          )
        }

        await tx.review.updateMany({
          where: {
            status: 'FEATURED',
            id: { not: existing.id },
            featuredOrder: { gte: input.featuredOrder },
          },
          data: { featuredOrder: { increment: 1 } },
        })
      }

      const moderationNote =
        input.action === 'UNFEATURE'
          ? undefined
          : (input.moderationNote ?? null)

      await tx.review.update({
        where: { id: existing.id },
        data: {
          status,
          featuredOrder:
            input.action === 'FEATURE' ? input.featuredOrder : null,
          moderatedById: ctx.user.id,
          moderatedAt: now,
          ...(moderationNote === undefined ? {} : { moderationNote }),
        },
        select: { id: true },
      })

      await compactFeaturedOrder(tx)

      // Re-read so the returned `featuredOrder` is the compacted one rather
      // than the position that was asked for.
      return tx.review.findUniqueOrThrow({
        where: { id: existing.id },
        select: REVIEW_MODERATION_SELECT,
      })
    })

    return ok(toModeratedReviewView(row))
  }
)

/**
 * Clear a stretch of the queue in one gesture.
 *
 * Only `APPROVE` and `REJECT` are offered in bulk —
 * `reviewBulkModerationSchema` says so, and the reason is that featuring is
 * curatorial and needs a position per review.
 *
 * The two self-interested cases are excluded in the `WHERE` clause rather than
 * refused, so an administrator who happens to have written one of the hundred
 * selected reviews still clears the other ninety-nine. The returned `skipped`
 * count does not say *why* anything was skipped, which keeps it from being an
 * oracle for whether a given id exists.
 *
 * Every touched review leaves the carousel — a rejected review certainly must,
 * and an approved one is being re-decided — so the sequence is compacted
 * afterwards.
 */
export const bulkModerateReviews = withAction(
  {
    name: 'review.moderate.bulk',
    auth: 'ADMIN',
    input: reviewBulkModerationSchema,
    revalidatePaths: REVIEW_PATHS,
    revalidateTags: REVIEW_TAGS,
  },
  async (ctx, input): Promise<ActionResult<BulkModerationView>> => {
    const status: ReviewStatus =
      input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
    const now = new Date()

    const ownStaffProfileId = ctx.user.staffProfileId

    const where: Prisma.ReviewWhereInput = {
      AND: [
        { id: { in: [...input.reviewIds] } },
        { authorId: { not: ctx.user.id } },
        ownStaffProfileId === null
          ? {}
          : {
              OR: [
                { staffProfileId: null },
                { staffProfileId: { not: ownStaffProfileId } },
              ],
            },
      ],
    }

    const moderated = await ctx.db.$transaction(async (tx) => {
      const result = await tx.review.updateMany({
        where,
        data: {
          status,
          featuredOrder: null,
          moderatedById: ctx.user.id,
          moderatedAt: now,
          moderationNote: input.moderationNote ?? null,
        },
      })

      await compactFeaturedOrder(tx)

      return result.count
    })

    return ok({
      requested: input.reviewIds.length,
      moderated,
      skipped: input.reviewIds.length - moderated,
      status,
    })
  }
)

/**
 * A single review, in full, for an administrator.
 *
 * `ADMIN` and above, so `REVIEW_MODERATION_SELECT` is the right projection.
 * A guest reading one review reads it through {@link listPublishedReviews} or
 * through the dish page, both of which use the public projection.
 *
 * `hasRoleAtLeast` is not re-checked here — `auth: 'ADMIN'` already did it in
 * the wrapper, and a second check in the handler would be a second place for
 * the rule to drift.
 */
export const getReviewForModeration = withAction(
  {
    name: 'review.moderation.read',
    auth: 'ADMIN',
    input: reviewIdSchema,
  },
  async (ctx, input): Promise<ActionResult<ModeratedReviewView>> => {
    const row = await ctx.db.review.findUnique({
      where: { id: input.reviewId },
      select: REVIEW_MODERATION_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that review.')
    }

    return ok(toModeratedReviewView(row))
  }
)

/**
 * Whether the caller may reach the moderation surfaces at all.
 *
 * A one-line read used by the admin shell to decide whether to render the queue
 * at all. It is a *rendering* helper and nothing more: every action above
 * enforces its own requirement, and a `true` from here grants nothing.
 */
export const canModerateReviews = withAction(
  {
    name: 'review.moderation.permitted',
    auth: 'SESSION',
    input: emptyInputSchema,
  },
  async (ctx): Promise<ActionResult<{ permitted: boolean }>> =>
    ok({ permitted: hasRoleAtLeast(ctx.user.role, 'ADMIN') })
)
