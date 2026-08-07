// mannachef/packages/validators/src/onboarding.ts

/**
 * Onboarding domain validation — the journey from an invitation to a household
 * we are cooking for, and the rungs it is allowed to move between.
 *
 * Mirrors `OnboardingFlow` and `OnboardingStepCompletion` in
 * `mannachef/packages/db/prisma/schema.prisma`.
 *
 * ## Why this file exists (MCV-005)
 *
 * Both tables were reachable from exactly one field in the whole package:
 * `prospectConversionSchema.advanceOnboardingTo` in `./intake`, which validates
 * that a conversion lands on one of five stages and says nothing whatsoever
 * about where the flow was standing beforehand. Nothing else could create a
 * flow, advance one, abandon one, record a completed step, or read a list of
 * them. The stage ladder existed only as an ordering in the Prisma enum — a
 * convention no code enforced, which meant a household could go from `INVITED`
 * to `ACTIVATED` without an intake form, or back from `ACTIVATED` to `INVITED`
 * and lose its entire history.
 *
 * ## The ladder is data, not a `switch`
 *
 * `ONBOARDING_STAGE_ORDER` is the single source of truth, and every rule below
 * is derived from it by index arithmetic. `ONBOARDING_STAGE_TRANSITIONS` is
 * that derivation materialised, so a role picker or a state diagram can read
 * the legal moves without calling a predicate ten times — the same shape
 * `CLIENT_STATUS_TRANSITIONS` in `./crm` and `APPOINTMENT_TRANSITIONS` in
 * `./booking` already take.
 *
 * ## Rules that govern this file (see `mannachef/CONTRACT.md`)
 *
 *  1. No runtime dependency on `@prisma/client` — stages arrive from `./enums`.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *  3. `onboardingFlowFilterSchema` is reachable over GET, so its numeric and
 *     temporal bounds coerce. The write payloads stay strict.
 */

import { z } from 'zod'

import {
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  crossField,
  crossFieldMixed,
  cuidSchema,
  hasUniqueValues,
  isNotInTheFuture,
  isoDateTimeSchema,
  optionalProse,
  paginationSchema,
  percentSchema,
  queryFlag,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'
import { type OnboardingStage, onboardingStageSchema } from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Generous ceiling for the `@db.Text` note on a completed step. */
export const MAX_ONBOARDING_NOTE_LENGTH = 2_000

/** Generous ceiling for the `@db.Text` reason a household was let go. */
export const MAX_ABANDON_REASON_LENGTH = 2_000

/** An abandonment is never recorded without an explanation this long at least. */
export const MIN_ABANDON_REASON_LENGTH = 4

/** How many stages one query may narrow by. */
const ONBOARDING_STAGE_COUNT = 10

// =============================================================================
// 1. The ladder
// =============================================================================

/**
 * The onboarding journey, in order, from invitation to activation.
 *
 * **`ABANDONED` is deliberately not in this array.** It is not a rung; it is
 * the way off the ladder, reachable from any live stage and ordered relative to
 * none of them. Putting it at the end would make it look like the step after
 * `ACTIVATED`, and `onboardingStageIndex` would then happily report that
 * abandoning a household is forward progress. It is handled explicitly by
 * {@link canAdvanceTo} instead, and named by
 * {@link ONBOARDING_ABANDONED_STAGE}.
 */
export const ONBOARDING_STAGE_ORDER: readonly OnboardingStage[] = [
  'INVITED',
  'ACCOUNT_CREATED',
  'INTAKE_SUBMITTED',
  'CONSULTATION_SCHEDULED',
  'CONSULTATION_COMPLETED',
  'PLAN_SELECTED',
  'PAYMENT_CONFIRMED',
  'FIRST_APPOINTMENT_BOOKED',
  'ACTIVATED',
]

/** The stage that means the household did not join us. Off-ladder by design. */
export const ONBOARDING_ABANDONED_STAGE: OnboardingStage = 'ABANDONED'

/** The last rung. A household here has been onboarded and is done. */
export const ONBOARDING_FINAL_STAGE: OnboardingStage = 'ACTIVATED'

/**
 * Stages nothing moves out of.
 *
 * `ACTIVATED` is terminal because the flow's job is finished — an active
 * household's lifecycle is `ClientStatus`, in `./crm`, not this ladder.
 * `ABANDONED` is terminal only in the sense that it is not a rung; a household
 * may be revived from it, which is why it is not simply refused below.
 */
export const ONBOARDING_TERMINAL_STAGES: readonly OnboardingStage[] = [
  'ACTIVATED',
  'ABANDONED',
]

/**
 * How far back a flow may be moved in one correction.
 *
 * One rung. A step back is somebody fixing a mis-click; three steps back is
 * somebody rewriting history, and the step-completion rows would no longer
 * agree with the stage the flow claims to be at.
 */
export const MAX_ONBOARDING_REWIND_STEPS = 1

/** Every stage the enum declares, ladder and off-ladder alike. */
const ALL_ONBOARDING_STAGES: readonly OnboardingStage[] =
  onboardingStageSchema.options

/**
 * Position on the ladder, or `-1` for a stage that is not on it.
 *
 * The `-1` is `Array.prototype.indexOf`'s, kept rather than translated so the
 * arithmetic below reads the way index arithmetic normally does.
 */
export function onboardingStageIndex(stage: OnboardingStage): number {
  return ONBOARDING_STAGE_ORDER.indexOf(stage)
}

/** True when the stage is a rung rather than the way off the ladder. */
export function isOnboardingLadderStage(stage: OnboardingStage): boolean {
  return onboardingStageIndex(stage) >= 0
}

/**
 * How far along the ladder a stage sits, as a whole percentage — the figure
 * `OnboardingFlow.progressPercent` holds.
 *
 * `INVITED` is 0 and `ACTIVATED` is 100. `ABANDONED` returns `0` because it has
 * no position; an action that wants to preserve the progress a household had
 * reached before it left should keep the previous value rather than ask this.
 */
export function onboardingProgressPercent(stage: OnboardingStage): number {
  const index = onboardingStageIndex(stage)

  if (index < 0) {
    return 0
  }

  const lastIndex = ONBOARDING_STAGE_ORDER.length - 1

  if (lastIndex <= 0) {
    return 100
  }

  return Math.round((index / lastIndex) * 100)
}

/**
 * True when a flow standing at `current` may be moved to `next`.
 *
 * Five rules, in the order they are tested:
 *
 *  1. A stage does not advance to itself. Re-recording the stage a flow is
 *     already at is a no-op that would still stamp `lastAdvancedAt` and write a
 *     duplicate step row.
 *  2. Nothing moves out of `ACTIVATED`. The journey is over; what happens next
 *     is `ClientStatus`, in `./crm`.
 *  3. Any live stage may be abandoned. A household can stop replying at any
 *     point, and pretending otherwise puts stale flows at the top of the
 *     pipeline for ever.
 *  4. A revival from `ABANDONED` returns to any rung except `ACTIVATED` — the
 *     conversation resumes where it left off, and reviving a household must
 *     never be the act that activates it.
 *  5. Otherwise it is ladder arithmetic: forward by any distance, because a
 *     household that signs at the tasting genuinely does leap from
 *     `CONSULTATION_COMPLETED` to `PAYMENT_CONFIRMED`; backward by at most
 *     {@link MAX_ONBOARDING_REWIND_STEPS}.
 */
export function canAdvanceTo(
  current: OnboardingStage,
  next: OnboardingStage
): boolean {
  if (current === next) {
    return false
  }

  if (current === ONBOARDING_FINAL_STAGE) {
    return false
  }

  if (next === ONBOARDING_ABANDONED_STAGE) {
    return true
  }

  if (current === ONBOARDING_ABANDONED_STAGE) {
    return isOnboardingLadderStage(next) && next !== ONBOARDING_FINAL_STAGE
  }

  const from = onboardingStageIndex(current)
  const to = onboardingStageIndex(next)

  if (from < 0 || to < 0) {
    return false
  }

  if (to > from) {
    return true
  }

  return from - to <= MAX_ONBOARDING_REWIND_STEPS
}

/** Every stage reachable from `current`, in ladder order. */
function stagesReachableFrom(
  current: OnboardingStage
): readonly OnboardingStage[] {
  return ALL_ONBOARDING_STAGES.filter((next) => canAdvanceTo(current, next))
}

/**
 * The legal moves, materialised.
 *
 * Written out key by key rather than assembled with `Object.fromEntries` so
 * that TypeScript checks the record is total — adding a stage to the Prisma
 * enum and to `./enums` will fail this file to compile until the new stage is
 * placed on the ladder deliberately, which is the only moment anybody will
 * think about where it belongs.
 */
export const ONBOARDING_STAGE_TRANSITIONS: Record<
  OnboardingStage,
  readonly OnboardingStage[]
> = {
  INVITED: stagesReachableFrom('INVITED'),
  ACCOUNT_CREATED: stagesReachableFrom('ACCOUNT_CREATED'),
  INTAKE_SUBMITTED: stagesReachableFrom('INTAKE_SUBMITTED'),
  CONSULTATION_SCHEDULED: stagesReachableFrom('CONSULTATION_SCHEDULED'),
  CONSULTATION_COMPLETED: stagesReachableFrom('CONSULTATION_COMPLETED'),
  PLAN_SELECTED: stagesReachableFrom('PLAN_SELECTED'),
  PAYMENT_CONFIRMED: stagesReachableFrom('PAYMENT_CONFIRMED'),
  FIRST_APPOINTMENT_BOOKED: stagesReachableFrom('FIRST_APPOINTMENT_BOOKED'),
  ACTIVATED: stagesReachableFrom('ACTIVATED'),
  ABANDONED: stagesReachableFrom('ABANDONED'),
}

/** The stages a flow at `current` may be moved to. Handy for rendering a picker. */
export function allowedOnboardingStages(
  current: OnboardingStage
): readonly OnboardingStage[] {
  return ONBOARDING_STAGE_TRANSITIONS[current]
}

// =============================================================================
// 2. Advancing a flow
// =============================================================================

/** The note recorded against a move, or against a completed step. */
const onboardingNoteSchema = optionalProse(
  MAX_ONBOARDING_NOTE_LENGTH,
  'Please keep the note to 2,000 characters or fewer.'
)

/** A moment that has already happened. Progress is not recorded in advance. */
const pastMomentSchema = isoDateTimeSchema.refine(isNotInTheFuture, {
  error:
    'That moment is still ahead of us — please choose one that has passed.',
})

/**
 * Moving a household along the journey.
 *
 * `from` travels with the payload so the move is validated as a *transition*
 * rather than as a destination, which is exactly what
 * `prospectConversionSchema.advanceOnboardingTo` cannot do — it knows only
 * where the flow is going. The action re-reads `OnboardingFlow.currentStage`
 * and compares it with `from` before writing, so two administrators advancing
 * the same household at once cannot both succeed
 * (`mannachef/CONTRACT.md` §5).
 *
 * `abandonedReason` is required when, and permitted only when, the flow is
 * being abandoned. A household that stops replying is the one outcome somebody
 * will be asked about six months later.
 */
export const onboardingStageAdvanceSchema = z
  .object({
    onboardingFlowId: cuidSchema,
    /** Where the caller believes the flow is standing. */
    from: onboardingStageSchema,
    /** Where it should stand afterwards. */
    to: onboardingStageSchema,
    note: onboardingNoteSchema,
    /** Required on an abandonment, refused on anything else. */
    abandonedReason: z
      .string({ error: 'Please record why this household did not join us.' })
      .trim()
      .min(MIN_ABANDON_REASON_LENGTH, {
        error: 'Please record why this household did not join us.',
      })
      .max(MAX_ABANDON_REASON_LENGTH, {
        error: 'Please keep the reason to 2,000 characters or fewer.',
      })
      .optional(),
    /** Defaults to now in the action when the caller does not back-date it. */
    occurredAt: pastMomentSchema.optional(),
  })
  .strict()
  .check(
    // `from` and `to` are declared dependencies so a stage the enum rejected
    // produces its own issue and not also "cannot move between those two
    // stages", which would be a second complaint about the same typo.
    // `abandonedReason` is read from the raw object rather than declared,
    // because both rules below turn on whether it is there at all.
    crossFieldMixed(
      {
        deps: { from: 'present', to: 'present' },
        error: 'A household cannot move between those two stages.',
        path: ['to'],
      },
      ({ from, to }) => canAdvanceTo(from, to)
    ),
    crossFieldMixed(
      {
        deps: { to: 'present' },
        error: 'Please record why this household did not join us.',
        path: ['abandonedReason'],
      },
      ({ to }, raw) =>
        to !== ONBOARDING_ABANDONED_STAGE || raw.abandonedReason !== undefined
    ),
    crossFieldMixed(
      {
        deps: { to: 'present' },
        error:
          'A reason for leaving belongs only on a household that is being let go.',
        path: ['abandonedReason'],
      },
      ({ to }, raw) =>
        to === ONBOARDING_ABANDONED_STAGE || raw.abandonedReason === undefined
    )
  )
export type OnboardingStageAdvanceInput = z.infer<
  typeof onboardingStageAdvanceSchema
>
export type OnboardingStageAdvanceRawInput = z.input<
  typeof onboardingStageAdvanceSchema
>

// =============================================================================
// 3. Recording a completed step
// =============================================================================

/**
 * Recording that a rung of the ladder was reached.
 *
 * `OnboardingStepCompletion` is `@@unique([onboardingFlowId, stage])`, so this
 * is written once per stage per household and the action upserts rather than
 * inserts. `ABANDONED` is refused: it is not a step anybody completes, and a
 * completion row for it would put the way off the ladder into the household's
 * timeline as though it were an achievement.
 *
 * `completedAt` defaults to now in the action; when it is supplied it must
 * already have happened, because a step completed in the future is a step that
 * has not been completed.
 */
export const onboardingStepCompletionSchema = z
  .object({
    onboardingFlowId: cuidSchema,
    stage: onboardingStageSchema.refine(isOnboardingLadderStage, {
      error: 'Leaving us is not a step in the journey.',
    }),
    completedAt: pastMomentSchema.optional(),
    note: onboardingNoteSchema,
  })
  .strict()
export type OnboardingStepCompletionInput = z.infer<
  typeof onboardingStepCompletionSchema
>
export type OnboardingStepCompletionRawInput = z.input<
  typeof onboardingStepCompletionSchema
>

// =============================================================================
// 4. The flow record itself
// =============================================================================

/**
 * Opening a journey for a household.
 *
 * `clientProfileId` is `@unique` on the table, so a household has exactly one
 * flow and the action upserts. A flow does not begin off the ladder, which is
 * why `currentStage` is refined even though it defaults to `INVITED`.
 */
export const onboardingFlowCreateSchema = z
  .object({
    clientProfileId: cuidSchema,
    currentStage: onboardingStageSchema
      .refine(isOnboardingLadderStage, {
        error: 'A journey does not begin with the household having left.',
      })
      .default('INVITED'),
    /** Defaults to now in the action when the caller does not back-date it. */
    startedAt: pastMomentSchema.optional(),
  })
  .strict()
export type OnboardingFlowCreateInput = z.infer<
  typeof onboardingFlowCreateSchema
>
export type OnboardingFlowCreateRawInput = z.input<
  typeof onboardingFlowCreateSchema
>

/**
 * The columns an administrator may correct directly on a flow.
 *
 * Ordinary progress goes through {@link onboardingStageAdvanceSchema}, which
 * checks the move. This is the escape hatch for repairing a row — a completion
 * timestamp that was never stamped, a progress figure that drifted after the
 * ladder gained a rung.
 */
export const onboardingFlowAmendableShape = {
  currentStage: onboardingStageSchema.default('INVITED'),
  progressPercent: percentSchema.default(0),
  /** `null` re-opens a journey that was closed by mistake. */
  completedAt: isoDateTimeSchema.nullable().optional(),
  /** `null` un-abandons a household. */
  abandonedAt: isoDateTimeSchema.nullable().optional(),
  abandonedReason: optionalProse(
    MAX_ABANDON_REASON_LENGTH,
    'Please keep the reason to 2,000 characters or fewer.'
  ),
  lastAdvancedAt: isoDateTimeSchema.nullable().optional(),
} as const

/**
 * Correcting a flow.
 *
 * Built by `buildUpdateSchema`, which strips the two `.default(...)`s —
 * `currentStage` and `progressPercent` — *before* the `.partial()`. That strip
 * is the whole reason this goes through the builder: without it, clearing a
 * stray `abandonedAt` on a household sitting at `PAYMENT_CONFIRMED` would send
 * `currentStage: 'INVITED'` and `progressPercent: 0` alongside it, and a
 * household that had already paid would reappear at the top of the pipeline as
 * a fresh invitation.
 */
export const onboardingFlowUpdateSchema = buildUpdateSchema(
  onboardingFlowAmendableShape,
  { requireKeys: { id: cuidSchema } }
)
export type OnboardingFlowUpdateInput = z.infer<
  typeof onboardingFlowUpdateSchema
>
export type OnboardingFlowUpdateRawInput = z.input<
  typeof onboardingFlowUpdateSchema
>

// =============================================================================
// 5. Filtering
// =============================================================================

/** How the onboarding pipeline is ordered; direction comes from `sortDirection`. */
export const onboardingFlowSortBySchema = z
  .enum(['STARTED', 'LAST_ADVANCED', 'PROGRESS', 'STAGE', 'COMPLETED'], {
    error: 'Please choose how the journeys should be ordered.',
  })
  .default('LAST_ADVANCED')
export type OnboardingFlowSortBy = z.infer<typeof onboardingFlowSortBySchema>

/**
 * The onboarding pipeline in the admin OS.
 *
 * Read from a query string, so the two progress bounds go through
 * `withNumericCoercion` and all three date windows through
 * `withTemporalCoercion`. `percentSchema` is `z.int()` and does not coerce, so
 * `?minProgressPercent=50` would otherwise be rejected by the very control that
 * produced it — the same defect the MCV-005 audit found on `minRating` in
 * `./review`.
 */
export const onboardingFlowFilterSchema = paginationSchema
  .extend({
    /** Matches the household's display name and the abandonment reason. */
    search: z
      .string({ error: 'Please type something to search the journeys for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    clientProfileId: cuidSchema.optional(),
    stages: z
      .array(onboardingStageSchema, {
        error: 'Please choose the stages to show.',
      })
      .max(ONBOARDING_STAGE_COUNT, {
        error: 'There are only ten stages to choose from.',
      })
      .refine(hasUniqueValues, {
        error: 'That stage is already part of your search.',
      })
      .default([]),
    minProgressPercent: withNumericCoercion(percentSchema.optional()),
    maxProgressPercent: withNumericCoercion(percentSchema.optional()),
    /** Narrows to households that finished the journey. */
    completedOnly: queryFlag(
      false,
      'Please say whether to show only journeys that were completed.'
    ),
    /** Narrows to households that did not join us. */
    abandonedOnly: queryFlag(
      false,
      'Please say whether to show only journeys that were abandoned.'
    ),
    /** Narrows to households still somewhere on the ladder. */
    inProgressOnly: queryFlag(
      false,
      'Please say whether to show only journeys still under way.'
    ),
    startedFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    startedTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    lastAdvancedFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    lastAdvancedTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: onboardingFlowSortBySchema,
  })
  .check(
    // The two date windows are the crash sites: both bounds are
    // `withTemporalCoercion(isoDateTimeSchema.optional())`, a `z.ZodPipe`, so
    // `?startedFrom=foo` left the raw string on the object and the old
    // `=== undefined ||` chain walked straight into `.getTime()` on it. The
    // other two rules are guarded for the same reason in reverse: a rejected
    // bound or flag should produce its own issue and no second one.
    crossField(
      {
        deps: ['minProgressPercent', 'maxProgressPercent'],
        as: 'number',
        error: 'The lowest progress must not exceed the highest one.',
        path: ['maxProgressPercent'],
      },
      ({ minProgressPercent, maxProgressPercent }) =>
        minProgressPercent <= maxProgressPercent
    ),
    crossField(
      {
        deps: ['startedFrom', 'startedTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['startedTo'],
      },
      ({ startedFrom, startedTo }) =>
        startedFrom.getTime() <= startedTo.getTime()
    ),
    crossField(
      {
        deps: ['lastAdvancedFrom', 'lastAdvancedTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['lastAdvancedTo'],
      },
      ({ lastAdvancedFrom, lastAdvancedTo }) =>
        lastAdvancedFrom.getTime() <= lastAdvancedTo.getTime()
    ),
    crossField(
      {
        deps: ['completedOnly', 'abandonedOnly', 'inProgressOnly'],
        as: 'boolean',
        error:
          'A journey is either under way, completed, or abandoned — please choose one.',
        path: ['inProgressOnly'],
      },
      ({ completedOnly, abandonedOnly, inProgressOnly }) =>
        [completedOnly, abandonedOnly, inProgressOnly].filter(Boolean).length <=
        1
    )
  )
export type OnboardingFlowFilterInput = z.infer<
  typeof onboardingFlowFilterSchema
>
export type OnboardingFlowFilterRawInput = z.input<
  typeof onboardingFlowFilterSchema
>
