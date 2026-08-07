// mannachef/apps/web/src/server/actions/onboarding.ts

'use server'

/**
 * The onboarding ladder — where a household stands on the journey from an
 * invitation to a table we cook at, and the moves it is allowed to make.
 *
 * ## The ladder is not re-implemented here
 *
 * `@mannachef/validators/onboarding` owns it: `ONBOARDING_STAGE_ORDER` is the
 * order, `canAdvanceTo` is the rule, `onboardingProgressPercent` is the
 * arithmetic, and `allowedOnboardingStages` is the picker. This file calls
 * them. Nothing below re-states a stage relationship, because two copies of a
 * state machine is how a household ends up `ACTIVATED` without an intake form.
 *
 * ## Why `from` travels with the payload
 *
 * `onboardingStageAdvanceSchema` carries the stage the caller *believes* the
 * flow is standing at. That is validated as a transition rather than as a
 * destination, and — more importantly — it is used here as a compare-and-swap:
 * {@link advanceOnboardingStage} writes with `updateMany({ where: { id,
 * currentStage: from } })`, so when two administrators press "advance" on the
 * same household at the same moment, exactly one of them wins and the other is
 * told the household moved underneath them. Reading the row and then updating
 * it by id would let both succeed, and the loser's step-completion row would
 * describe a rung the household never stood on.
 *
 * ## Who may do what
 *
 * Advancing, recording a step and opening a flow are `CHEF_STAFF` — the
 * concierge drives the journey. Amending a flow's columns directly is `ADMIN`,
 * because it is the escape hatch that goes *around* `canAdvanceTo`. Reading is
 * `SESSION`, with a household pinned to its own flow: {@link readMyOnboarding}
 * takes no id at all, and {@link listOnboardingFlows} discards a
 * `clientProfileId` sent by anybody below `CHEF_STAFF`.
 */

import {
  ONBOARDING_ABANDONED_STAGE,
  allowedOnboardingStages,
  canAdvanceTo,
  hasRoleAtLeast,
  onboardingFlowCreateSchema,
  onboardingFlowFilterSchema,
  onboardingFlowUpdateSchema,
  onboardingProgressPercent,
  onboardingStageAdvanceSchema,
  onboardingStepCompletionSchema,
  paginationToSkipTake,
  type OnboardingFlowSortBy,
  type SortDirection,
} from '@mannachef/validators'
import {
  emptyInputSchema,
  type OnboardingFlowView,
  type OnboardingStepView,
  type PageMeta,
} from '@mannachef/api-contract'

import { fail, ok, type ActionResult } from '@/server/actions/types'
import { Prisma } from '@/server/db'
import { withAction, type AuthenticatedUser } from '@/server/guards'

// =============================================================================
// 0. Constants
// =============================================================================

const ONBOARDING_PATHS = [
  '/portal/onboarding',
  '/admin/onboarding',
  '/admin/clients',
  '/admin/pipeline',
] as const

const ONBOARDING_TAGS = ['onboarding', 'pipeline'] as const

// =============================================================================
// 1. Projections
// =============================================================================

const ONBOARDING_FLOW_SELECT = {
  id: true,
  clientProfileId: true,
  currentStage: true,
  progressPercent: true,
  startedAt: true,
  completedAt: true,
  abandonedAt: true,
  abandonedReason: true,
  lastAdvancedAt: true,
  createdAt: true,
  steps: {
    orderBy: { completedAt: 'asc' },
    select: { id: true, stage: true, completedAt: true, note: true },
  },
} satisfies Prisma.OnboardingFlowSelect

type OnboardingFlowRow = Prisma.OnboardingFlowGetPayload<{
  select: typeof ONBOARDING_FLOW_SELECT
}>

/** A page of journeys for the pipeline board. */
interface OnboardingListView {
  readonly items: readonly OnboardingFlowView[]
  readonly meta: PageMeta
}

/** What {@link completeOnboardingStep} reports. */
interface OnboardingStepResultView {
  readonly onboardingFlowId: string
  readonly step: OnboardingStepView
  /** The stage the flow is standing at. Recording a step does not move it. */
  readonly currentStage: OnboardingFlowView['currentStage']
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

function isStaff(user: AuthenticatedUser): boolean {
  return hasRoleAtLeast(user.role, 'CHEF_STAFF')
}

/**
 * Render a flow.
 *
 * `allowedNextStages` is computed here rather than on the client so a stage
 * picker cannot drift from the ladder the server will actually enforce. It is a
 * *convenience*, not a permission: {@link advanceOnboardingStage} re-checks
 * every move against `canAdvanceTo` regardless of what this list said
 * (`mannachef/CONTRACT.md` §5).
 */
function toOnboardingFlowView(row: OnboardingFlowRow): OnboardingFlowView {
  return {
    id: row.id,
    clientProfileId: row.clientProfileId,
    currentStage: row.currentStage,
    progressPercent: row.progressPercent,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    abandonedAt: row.abandonedAt,
    abandonedReason: row.abandonedReason,
    lastAdvancedAt: row.lastAdvancedAt,
    allowedNextStages: [...allowedOnboardingStages(row.currentStage)],
    steps: row.steps.map((step) => ({
      id: step.id,
      stage: step.stage,
      completedAt: step.completedAt,
      note: step.note,
    })),
    createdAt: row.createdAt,
  }
}

function onboardingOrderBy(
  sortBy: OnboardingFlowSortBy,
  direction: SortDirection
): Prisma.OnboardingFlowOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'STARTED':
      return [{ startedAt: direction }, { id: 'asc' }]

    case 'LAST_ADVANCED':
      return [{ lastAdvancedAt: direction }, { id: 'asc' }]

    case 'PROGRESS':
      return [{ progressPercent: direction }, { id: 'asc' }]

    case 'STAGE':
      return [{ currentStage: direction }, { id: 'asc' }]

    case 'COMPLETED':
      return [{ completedAt: direction }, { id: 'asc' }]

    default: {
      // A new member of `onboardingFlowSortBySchema` is a compile error here
      // rather than a silently unordered board.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

// =============================================================================
// 2. Advancing
// =============================================================================

/**
 * Move a household one or more rungs along the journey.
 *
 * ## What is checked, and in what order
 *
 * 1. `withAction` has already resolved the session, enforced `CHEF_STAFF`, and
 *    parsed the payload — which means `canAdvanceTo(from, to)` has already been
 *    applied to the *claimed* origin, and `abandonedReason` is present exactly
 *    when `to` is `ABANDONED`.
 * 2. The flow is read. A missing one is `NOT_FOUND`.
 * 3. The move is re-checked against the **stored** `currentStage`, not the
 *    claimed one. A payload asserting `from: 'INVITED'` for a household that
 *    has actually paid must not be allowed to walk it backwards.
 * 4. The write is a conditional `updateMany` guarded on `currentStage`, so a
 *    stage that changed between step 2 and step 4 matches zero rows and the
 *    caller is told to reload rather than both administrators succeeding.
 *
 * ## What each destination does to the row
 *
 *  - **A ladder rung.** `progressPercent` is recomputed from the ladder,
 *    `lastAdvancedAt` is stamped, and a step-completion row is upserted — the
 *    table is `@@unique([onboardingFlowId, stage])`, so a household that
 *    re-reaches a rung keeps one row for it rather than gaining a second.
 *  - **`ACTIVATED`.** Additionally stamps `completedAt`. The journey is over;
 *    what happens next is `ClientStatus`, in `crm.ts`.
 *  - **`ABANDONED`.** Stamps `abandonedAt` and the required reason, and
 *    **leaves `progressPercent` alone**. `onboardingProgressPercent` returns 0
 *    for `ABANDONED` because it has no position on the ladder; writing that
 *    zero would erase how far the household actually got, which is the one
 *    figure a post-mortem needs. No step-completion row is written either —
 *    leaving is not an achievement.
 *  - **A revival off `ABANDONED`.** Clears `abandonedAt` and
 *    `abandonedReason`, so a household that came back is not counted as lost.
 */
export const advanceOnboardingStage = withAction(
  {
    name: 'onboarding.advance',
    auth: 'CHEF_STAFF',
    input: onboardingStageAdvanceSchema,
    revalidatePaths: ONBOARDING_PATHS,
    revalidateTags: ONBOARDING_TAGS,
  },
  async (ctx, input): Promise<ActionResult<OnboardingFlowView>> => {
    const occurredAt = input.occurredAt ?? new Date()

    const outcome = await ctx.db.$transaction(async (tx) => {
      const flow = await tx.onboardingFlow.findUnique({
        where: { id: input.onboardingFlowId },
        select: { id: true, currentStage: true, progressPercent: true },
      })

      if (flow === null) {
        return { kind: 'notFound' as const }
      }

      if (flow.currentStage !== input.from) {
        return { kind: 'stale' as const, actual: flow.currentStage }
      }

      // Re-checked against the stored stage. The parser checked the claim; this
      // checks the fact.
      if (!canAdvanceTo(flow.currentStage, input.to)) {
        return { kind: 'illegal' as const, actual: flow.currentStage }
      }

      const abandoning = input.to === ONBOARDING_ABANDONED_STAGE
      const reviving = flow.currentStage === ONBOARDING_ABANDONED_STAGE

      const moved = await tx.onboardingFlow.updateMany({
        where: { id: flow.id, currentStage: input.from },
        data: {
          currentStage: input.to,
          lastAdvancedAt: occurredAt,
          // Leaving is not a position on the ladder, so the progress the
          // household had reached is preserved rather than reset to zero.
          ...(abandoning
            ? {
                abandonedAt: occurredAt,
                abandonedReason: input.abandonedReason ?? null,
              }
            : {
                progressPercent: onboardingProgressPercent(input.to),
                ...(input.to === 'ACTIVATED'
                  ? { completedAt: occurredAt }
                  : {}),
                ...(reviving
                  ? { abandonedAt: null, abandonedReason: null }
                  : {}),
              }),
        },
      })

      if (moved.count !== 1) {
        return { kind: 'raced' as const }
      }

      if (!abandoning) {
        await tx.onboardingStepCompletion.upsert({
          where: {
            onboardingFlowId_stage: {
              onboardingFlowId: flow.id,
              stage: input.to,
            },
          },
          create: {
            onboardingFlowId: flow.id,
            stage: input.to,
            completedAt: occurredAt,
            ...(input.note === undefined ? {} : { note: input.note }),
          },
          // A rung already recorded keeps the moment it was first reached.
          update: {},
          select: { id: true },
        })
      }

      const refreshed = await tx.onboardingFlow.findUniqueOrThrow({
        where: { id: flow.id },
        select: ONBOARDING_FLOW_SELECT,
      })

      return { kind: 'advanced' as const, row: refreshed }
    })

    switch (outcome.kind) {
      case 'advanced':
        return ok(toOnboardingFlowView(outcome.row))

      case 'notFound':
        return fail('NOT_FOUND', 'We could not find that journey.')

      case 'stale':
        return fail(
          'CONFLICT',
          'This household has already moved on. Please reload and try again.',
          {
            from: [
              `The journey is standing at ${outcome.actual.toLowerCase().replace(/_/g, ' ')}.`,
            ],
          }
        )

      case 'illegal':
        return fail(
          'CONFLICT',
          'A household cannot move between those two stages.',
          {
            to: [
              `From ${outcome.actual.toLowerCase().replace(/_/g, ' ')}, that is not a move the journey allows.`,
            ],
          }
        )

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

// =============================================================================
// 3. Recording a rung
// =============================================================================

/**
 * Record that a rung of the ladder was reached, without moving the flow.
 *
 * This is the audit trail rather than the state machine: back-filling the
 * moment a household actually returned their questionnaire, months after
 * somebody clicked past it. `onboardingStepCompletionSchema` refuses
 * `ABANDONED` — leaving is not a step anybody completes — and refuses a
 * completion timestamp in the future.
 *
 * `OnboardingStepCompletion` is `@@unique([onboardingFlowId, stage])`, so this
 * upserts. The update branch *does* write, unlike the one inside
 * {@link advanceOnboardingStage}: an operator explicitly correcting a rung's
 * timestamp means to correct it.
 */
export const completeOnboardingStep = withAction(
  {
    name: 'onboarding.step.complete',
    auth: 'CHEF_STAFF',
    input: onboardingStepCompletionSchema,
    revalidatePaths: ONBOARDING_PATHS,
    revalidateTags: ONBOARDING_TAGS,
  },
  async (ctx, input): Promise<ActionResult<OnboardingStepResultView>> => {
    const completedAt = input.completedAt ?? new Date()

    const flow = await ctx.db.onboardingFlow.findUnique({
      where: { id: input.onboardingFlowId },
      select: { id: true, currentStage: true },
    })

    if (flow === null) {
      return fail('NOT_FOUND', 'We could not find that journey.')
    }

    const step = await ctx.db.onboardingStepCompletion.upsert({
      where: {
        onboardingFlowId_stage: {
          onboardingFlowId: flow.id,
          stage: input.stage,
        },
      },
      create: {
        onboardingFlowId: flow.id,
        stage: input.stage,
        completedAt,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      update: {
        completedAt,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      select: { id: true, stage: true, completedAt: true, note: true },
    })

    return ok({
      onboardingFlowId: flow.id,
      step: {
        id: step.id,
        stage: step.stage,
        completedAt: step.completedAt,
        note: step.note,
      },
      currentStage: flow.currentStage,
    })
  }
)

// =============================================================================
// 4. Opening and correcting a flow
// =============================================================================

/**
 * Open a journey for a household.
 *
 * `OnboardingFlow.clientProfileId` is `@unique`, so a household has exactly one
 * flow and this upserts rather than inserts. The update branch is empty: a
 * household that already has a journey keeps the one it has, because re-opening
 * it would reset the stage and orphan every step-completion row from the
 * timeline they belong to. To *correct* an existing flow, use
 * {@link amendOnboardingFlow}; to move it, use {@link advanceOnboardingStage}.
 */
export const startOnboardingFlow = withAction(
  {
    name: 'onboarding.start',
    auth: 'CHEF_STAFF',
    input: onboardingFlowCreateSchema,
    revalidatePaths: ONBOARDING_PATHS,
    revalidateTags: ONBOARDING_TAGS,
  },
  async (ctx, input): Promise<ActionResult<OnboardingFlowView>> => {
    const startedAt = input.startedAt ?? new Date()

    const household = await ctx.db.clientProfile.findUnique({
      where: { id: input.clientProfileId },
      select: { id: true },
    })

    if (household === null) {
      return fail('NOT_FOUND', 'We could not find that household.')
    }

    const flow = await ctx.db.onboardingFlow.upsert({
      where: { clientProfileId: household.id },
      create: {
        clientProfileId: household.id,
        currentStage: input.currentStage,
        progressPercent: onboardingProgressPercent(input.currentStage),
        startedAt,
      },
      update: {},
      select: ONBOARDING_FLOW_SELECT,
    })

    return ok(toOnboardingFlowView(flow))
  }
)

/**
 * Correct a flow's columns directly.
 *
 * `ADMIN`, and deliberately so: this is the one path that goes *around*
 * `canAdvanceTo`. It exists for repairing a row — a completion timestamp that
 * was never stamped, a progress figure that drifted after the ladder gained a
 * rung, an `abandonedAt` set by mistake — and it is not how ordinary progress
 * is recorded.
 *
 * `onboardingFlowUpdateSchema` is built by `buildUpdateSchema`, which strips
 * the two `.default(...)`s before making the shape partial. Without that,
 * clearing a stray `abandonedAt` on a household sitting at `PAYMENT_CONFIRMED`
 * would carry `currentStage: 'INVITED'` and `progressPercent: 0` along with it,
 * and a household that had already paid would reappear at the top of the
 * pipeline as a fresh invitation. The conditional spreads below preserve that:
 * a key the caller did not send is not written.
 */
export const amendOnboardingFlow = withAction(
  {
    name: 'onboarding.amend',
    auth: 'ADMIN',
    input: onboardingFlowUpdateSchema,
    revalidatePaths: ONBOARDING_PATHS,
    revalidateTags: ONBOARDING_TAGS,
  },
  async (ctx, input): Promise<ActionResult<OnboardingFlowView>> => {
    const existing = await ctx.db.onboardingFlow.findUnique({
      where: { id: input.id },
      select: { id: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'We could not find that journey.')
    }

    const updated = await ctx.db.onboardingFlow.update({
      where: { id: existing.id },
      data: {
        ...(input.currentStage === undefined
          ? {}
          : { currentStage: input.currentStage }),
        ...(input.progressPercent === undefined
          ? {}
          : { progressPercent: input.progressPercent }),
        ...(input.completedAt === undefined
          ? {}
          : { completedAt: input.completedAt }),
        ...(input.abandonedAt === undefined
          ? {}
          : { abandonedAt: input.abandonedAt }),
        ...(input.abandonedReason === undefined
          ? {}
          : { abandonedReason: input.abandonedReason }),
        ...(input.lastAdvancedAt === undefined
          ? {}
          : { lastAdvancedAt: input.lastAdvancedAt }),
      },
      select: ONBOARDING_FLOW_SELECT,
    })

    return ok(toOnboardingFlowView(updated))
  }
)

// =============================================================================
// 5. Reading
// =============================================================================

/**
 * The client's own onboarding status.
 *
 * Takes **no input at all** — `emptyInputSchema` is `z.strictObject({})`, so a
 * stray `clientProfileId` in the payload is a validation failure rather than
 * something this action has to remember to ignore. The household is the
 * session's, read from `ctx.user.clientProfileId`, which the session callback
 * in `@/server/auth` populated from the database. There is no id to check
 * ownership of, because there is no id to send.
 *
 * A signed-in account with no household — a member of staff, or a client whose
 * profile has not been opened yet — gets `NOT_FOUND`.
 */
export const readMyOnboarding = withAction(
  {
    name: 'onboarding.read.mine',
    auth: 'SESSION',
    input: emptyInputSchema,
  },
  async (ctx): Promise<ActionResult<OnboardingFlowView>> => {
    const clientProfileId = ctx.user.clientProfileId

    if (clientProfileId === null) {
      return fail(
        'NOT_FOUND',
        'There is no household journey on this account yet.'
      )
    }

    const flow = await ctx.db.onboardingFlow.findUnique({
      where: { clientProfileId },
      select: ONBOARDING_FLOW_SELECT,
    })

    if (flow === null) {
      return fail(
        'NOT_FOUND',
        'There is no household journey on this account yet.'
      )
    }

    return ok(toOnboardingFlowView(flow))
  }
)

/**
 * The onboarding pipeline.
 *
 * A caller below `CHEF_STAFF` is pinned to their own household — the filter's
 * `clientProfileId` is discarded rather than merged, and every staff-only
 * narrowing (the free-text search across household names, the progress bounds)
 * is skipped for them, because a filter a client can drive is a filter a client
 * can use to probe other households' rows.
 *
 * The three mutually exclusive flags are already refused in combination by
 * `onboardingFlowFilterSchema`; each simply adds its clause here.
 */
export const listOnboardingFlows = withAction(
  {
    name: 'onboarding.read',
    auth: 'SESSION',
    input: onboardingFlowFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<OnboardingListView>> => {
    const staffCaller = isStaff(ctx.user)
    const filters: Prisma.OnboardingFlowWhereInput[] = []

    if (staffCaller) {
      if (filter.clientProfileId !== undefined) {
        filters.push({ clientProfileId: filter.clientProfileId })
      }

      if (filter.search !== undefined) {
        filters.push({
          OR: [
            {
              clientProfile: {
                displayName: { contains: filter.search, mode: 'insensitive' },
              },
            },
            {
              clientProfile: {
                preferredName: { contains: filter.search, mode: 'insensitive' },
              },
            },
            {
              abandonedReason: { contains: filter.search, mode: 'insensitive' },
            },
          ],
        })
      }

      if (filter.minProgressPercent !== undefined) {
        filters.push({ progressPercent: { gte: filter.minProgressPercent } })
      }

      if (filter.maxProgressPercent !== undefined) {
        filters.push({ progressPercent: { lte: filter.maxProgressPercent } })
      }
    } else {
      const ownProfileId = ctx.user.clientProfileId

      if (ownProfileId === null) {
        return ok({
          items: [],
          meta: buildPageMeta(filter.page, filter.pageSize, 0),
        })
      }

      filters.push({ clientProfileId: ownProfileId })
    }

    if (filter.stages.length > 0) {
      filters.push({ currentStage: { in: [...filter.stages] } })
    }

    if (filter.completedOnly) {
      filters.push({ completedAt: { not: null } })
    }

    if (filter.abandonedOnly) {
      filters.push({ abandonedAt: { not: null } })
    }

    if (filter.inProgressOnly) {
      filters.push({ completedAt: null, abandonedAt: null })
    }

    if (filter.startedFrom !== undefined) {
      filters.push({ startedAt: { gte: filter.startedFrom } })
    }

    if (filter.startedTo !== undefined) {
      filters.push({ startedAt: { lte: filter.startedTo } })
    }

    if (filter.lastAdvancedFrom !== undefined) {
      filters.push({ lastAdvancedAt: { gte: filter.lastAdvancedFrom } })
    }

    if (filter.lastAdvancedTo !== undefined) {
      filters.push({ lastAdvancedAt: { lte: filter.lastAdvancedTo } })
    }

    const where: Prisma.OnboardingFlowWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.onboardingFlow.count({ where }),
      ctx.db.onboardingFlow.findMany({
        where,
        select: ONBOARDING_FLOW_SELECT,
        orderBy: onboardingOrderBy(filter.sortBy, filter.sortDirection),
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toOnboardingFlowView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)
