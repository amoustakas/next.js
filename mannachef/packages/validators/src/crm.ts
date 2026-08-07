// mannachef/packages/validators/src/crm.ts

/**
 * CRM domain validation — the notes, the exchanges, the lifecycle, and the
 * pipeline view the business OS is built around.
 *
 * Mirrors `ClientNote`, `InteractionLog` and the CRM-facing columns of
 * `ClientProfile` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * Rules that govern this file (see `mannachef/CONTRACT.md`):
 *
 *  1. No runtime dependency on `@prisma/client` — enum values arrive from
 *     `./enums`, which re-declares them as Zod enums.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *  3. `authorId` and `loggedById` are taken from the session inside the server
 *     action and are never accepted from the browser. Every schema here is
 *     scoped to a `clientProfileId`, and the action re-checks that the caller is
 *     entitled to that client before it writes (`mannachef/CONTRACT.md` §5).
 *  4. A note is written for colleagues. `visibility` decides who may read it,
 *     and `CLIENT_VISIBLE` is the only value the client portal ever queries.
 */

import { z } from 'zod'

import {
  cuidSchema,
  durationMinutesSchema,
  isoDateTimeSchema,
  moneyCentsSchema,
  paginationSchema,
} from './common'
import {
  clientSourceSchema,
  clientStatusSchema,
  interactionChannelSchema,
  interactionDirectionSchema,
  noteVisibilitySchema,
  type ClientStatus,
} from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Generous ceiling for the `@db.Text` body of a note. */
export const MAX_NOTE_BODY_LENGTH = 5_000

/** A note shorter than this is a keystroke, not a note. */
const MIN_NOTE_BODY_LENGTH = 2

/** Matches `InteractionLog.subject` — `@db.VarChar(280)`. */
const MAX_INTERACTION_SUBJECT_LENGTH = 280

/** Generous ceiling for the `@db.Text` body of a logged exchange. */
export const MAX_INTERACTION_BODY_LENGTH = 10_000

/** Matches `InteractionLog.externalRef` — `@db.VarChar(255)`. */
const MAX_EXTERNAL_REF_LENGTH = 255

/** Generous ceiling for a `@db.Text` reason. */
const MAX_REASON_LENGTH = 2_000

/** A churn reason is always given, and this is the shortest we accept. */
const MIN_REASON_LENGTH = 4

/** Longest accepted free-text search phrase. */
const MAX_SEARCH_LENGTH = 120

/** $1,000,000.00 — the ceiling on a lifetime-value filter bound. */
export const MAX_LIFETIME_VALUE_CENTS = 100_000_000

/** How far ahead a follow-up may be scheduled: two years. */
export const MAX_FOLLOW_UP_DAYS = 730

/** Milliseconds in a day, used by the follow-up window refinement. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The house lifetime-value tiers, in cents: $500, $1,500, $5,000 and $15,000.
 *
 * Each boundary opens a bucket, so four boundaries make five buckets — the
 * lowest running from nothing up to the first boundary, the highest running from
 * the last boundary upwards.
 */
export const DEFAULT_LTV_BOUNDARIES_CENTS: readonly number[] = [
  50_000, 150_000, 500_000, 1_500_000,
]

/** More than eight tiers stops being a distribution and starts being a table. */
export const MAX_LTV_BOUNDARIES = 8

// =============================================================================
// Local helpers
// =============================================================================

/** True when no value in the list repeats. */
function hasUniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}

/** True when every value is strictly larger than the one before it. */
function isStrictlyAscending(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]

    if (previous === undefined || current === undefined) {
      return false
    }

    if (current <= previous) {
      return false
    }
  }

  return true
}

/** Every update schema rejects a payload that carries an id and nothing else. */
const NOTHING_TO_SAVE_MESSAGE =
  'Nothing has changed yet — adjust a field before saving.'

function hasSomethingToSave(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 1
}

/**
 * A boolean that survives the trip through a URL search-parameter object, where
 * `true` arrives as the string `"true"`. A transport concern of list filters
 * rather than a domain primitive, which is why it is not in `./common`.
 */
function queryFlag(defaultValue: boolean, error: string) {
  return z
    .union([z.boolean({ error }), z.stringbool({ error })], { error })
    .default(defaultValue)
}

/** True when the moment is still ahead of us. */
function isInTheFuture(value: Date): boolean {
  return value.getTime() > Date.now()
}

/** True when the moment has already passed (or is this very instant). */
function isNotInTheFuture(value: Date): boolean {
  return value.getTime() <= Date.now()
}

// =============================================================================
// 1. Client notes
// =============================================================================

/** The body of a note. Kept plain text; the OS renders it as written. */
export const clientNoteBodySchema = z
  .string({ error: 'Please write the note before saving it.' })
  .trim()
  .min(MIN_NOTE_BODY_LENGTH, {
    error: 'Please write the note before saving it.',
  })
  .max(MAX_NOTE_BODY_LENGTH, {
    error: 'Please keep the note to 5,000 characters or fewer.',
  })
export type ClientNoteBody = z.infer<typeof clientNoteBodySchema>

/**
 * Writing a note against a client.
 *
 * `authorId` is absent by design: the author is the session, and a note that
 * claims to be by someone else is not a note we would keep.
 */
export const clientNoteCreateSchema = z
  .object({
    clientProfileId: cuidSchema,
    body: clientNoteBodySchema,
    /** Pinned notes sit at the head of the client record. */
    pinned: z
      .boolean({ error: 'Please say whether to pin this note to the record.' })
      .default(false),
    visibility: noteVisibilitySchema.default('STAFF'),
  })
  .strict()
export type ClientNoteCreateInput = z.infer<typeof clientNoteCreateSchema>
export type ClientNoteCreateRawInput = z.input<typeof clientNoteCreateSchema>

/**
 * Amending a note.
 *
 * `clientProfileId` is absent: a note does not move between clients. To record
 * something about a different household, write it there.
 */
export const clientNoteUpdateSchema = z
  .object({
    id: cuidSchema,
    body: clientNoteBodySchema.optional(),
    pinned: z
      .boolean({ error: 'Please say whether to pin this note to the record.' })
      .optional(),
    visibility: noteVisibilitySchema.optional(),
  })
  .strict()
  .refine(hasSomethingToSave, {
    error: NOTHING_TO_SAVE_MESSAGE,
    path: ['id'],
  })
export type ClientNoteUpdateInput = z.infer<typeof clientNoteUpdateSchema>
export type ClientNoteUpdateRawInput = z.input<typeof clientNoteUpdateSchema>

export const clientNoteFilterSchema = paginationSchema.extend({
  clientProfileId: cuidSchema.optional(),
  authorId: cuidSchema.optional(),
  visibilities: z
    .array(noteVisibilitySchema, {
      error: 'Please choose which notes to show.',
    })
    .max(4, { error: 'There are only four levels of visibility.' })
    .refine(hasUniqueValues, {
      error: 'That level of visibility is already part of your search.',
    })
    .default([]),
  pinnedOnly: queryFlag(false, 'Please say whether to show only pinned notes.'),
  search: z
    .string({ error: 'Please type something to search the notes for.' })
    .trim()
    .max(MAX_SEARCH_LENGTH, {
      error: 'Please shorten your search to 120 characters or fewer.',
    })
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
})
export type ClientNoteFilterInput = z.infer<typeof clientNoteFilterSchema>
export type ClientNoteFilterRawInput = z.input<typeof clientNoteFilterSchema>

// =============================================================================
// 2. Interaction log
// =============================================================================

/**
 * Recording an exchange with a client — a call, an email, a note passed at the
 * door.
 *
 * `occurredAt` defaults to now and may be back-dated when someone writes up a
 * conversation afterwards, but never post-dated: the log is a record of what has
 * happened, and a planned call belongs in `clientFollowUpSchema`.
 *
 * `loggedById` comes from the session. `externalRef` is the provider's message
 * id (Resend, Twilio, …) and is what makes an automated write idempotent.
 */
export const interactionLogCreateSchema = z
  .object({
    clientProfileId: cuidSchema,
    channel: interactionChannelSchema,
    direction: interactionDirectionSchema.default('OUTBOUND'),
    subject: z
      .string({ error: 'Please summarise the exchange, or leave it blank.' })
      .trim()
      .max(MAX_INTERACTION_SUBJECT_LENGTH, {
        error: 'Please keep the summary to 280 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
    body: z
      .string({ error: 'Please record the exchange, or leave it blank.' })
      .trim()
      .max(MAX_INTERACTION_BODY_LENGTH, {
        error: 'Please keep the record to 10,000 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
    /** Defaults to now in the action when the caller does not back-date it. */
    occurredAt: isoDateTimeSchema.optional(),
    /** How long the call or visit ran. Meaningless on an email. */
    durationMinutes: durationMinutesSchema.nullable().optional(),
    externalRef: z
      .string({ error: 'Please provide the provider reference.' })
      .trim()
      .max(MAX_EXTERNAL_REF_LENGTH, {
        error: 'That provider reference is longer than our records allow.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
    /**
     * Whether this exchange also counts as contact, moving the client's
     * `lastContactedAt` forward. An automated newsletter should not.
     */
    markAsContacted: z
      .boolean({
        error: 'Please say whether this counts as contact with the client.',
      })
      .default(true),
  })
  .strict()
  .refine(
    ({ occurredAt }) =>
      occurredAt === undefined || isNotInTheFuture(occurredAt),
    {
      error:
        'An exchange cannot be logged for a moment still to come. Schedule a follow-up instead.',
      path: ['occurredAt'],
    }
  )
  .refine(
    ({ channel, durationMinutes }) =>
      durationMinutes == null || channel === 'PHONE' || channel === 'IN_PERSON',
    {
      error:
        'A duration belongs on a call or a visit, not on a written message.',
      path: ['durationMinutes'],
    }
  )
  .refine(({ subject, body }) => subject != null || body != null, {
    error: 'Please give this exchange a summary or a record — ideally both.',
    path: ['subject'],
  })
export type InteractionLogCreateInput = z.infer<
  typeof interactionLogCreateSchema
>
export type InteractionLogCreateRawInput = z.input<
  typeof interactionLogCreateSchema
>

export const interactionLogFilterSchema = paginationSchema
  .extend({
    clientProfileId: cuidSchema.optional(),
    loggedById: cuidSchema.optional(),
    channels: z
      .array(interactionChannelSchema, {
        error: 'Please choose the channels to show.',
      })
      .max(5, { error: 'There are only five channels to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That channel is already part of your search.',
      })
      .default([]),
    direction: interactionDirectionSchema.optional(),
    search: z
      .string({ error: 'Please type something to search the log for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    occurredFrom: isoDateTimeSchema.optional(),
    occurredTo: isoDateTimeSchema.optional(),
  })
  .refine(
    ({ occurredFrom, occurredTo }) =>
      occurredFrom === undefined ||
      occurredTo === undefined ||
      occurredFrom.getTime() <= occurredTo.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['occurredTo'],
    }
  )
export type InteractionLogFilterInput = z.infer<
  typeof interactionLogFilterSchema
>
export type InteractionLogFilterRawInput = z.input<
  typeof interactionLogFilterSchema
>

// =============================================================================
// 3. The client lifecycle
// =============================================================================

/**
 * Where a client may go next.
 *
 * A prospect is qualified before they subscribe; a subscriber may rest before
 * they leave; and anyone who has left may be won back — to `LEAD_QUALIFIED`
 * while the conversation is reopening, or straight to `ACTIVE_SUBSCRIBER` if
 * they simply resubscribe.
 */
export const CLIENT_STATUS_TRANSITIONS: Record<
  ClientStatus,
  readonly ClientStatus[]
> = {
  PROSPECT: ['LEAD_QUALIFIED', 'ACTIVE_SUBSCRIBER', 'CHURNED'],
  LEAD_QUALIFIED: ['ACTIVE_SUBSCRIBER', 'PROSPECT', 'CHURNED'],
  ACTIVE_SUBSCRIBER: ['PAUSED', 'CHURNED'],
  PAUSED: ['ACTIVE_SUBSCRIBER', 'CHURNED'],
  CHURNED: ['LEAD_QUALIFIED', 'ACTIVE_SUBSCRIBER'],
}

/** Every status this client could legally move to next. */
export function allowedClientStatusTransitions(
  from: ClientStatus
): readonly ClientStatus[] {
  return CLIENT_STATUS_TRANSITIONS[from]
}

/**
 * Whether a client may move from one status to another.
 *
 * This is the authority for the lifecycle — the server action calls it before
 * writing, and the UI calls it to decide which options to offer. The UI copy is
 * a convenience; the action's call is the enforcement.
 */
export function canTransitionClientStatus(
  from: ClientStatus,
  to: ClientStatus
): boolean {
  return CLIENT_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * Moving a client through the lifecycle.
 *
 * `from` is sent by the caller and compared against the stored row by the
 * action, so two people pressing the same button at once cannot both win.
 * Churn always carries a reason: it is written to `ClientProfile.churnReason`,
 * and it is the single most useful field in the whole CRM.
 */
export const clientStatusTransitionSchema = z
  .object({
    clientProfileId: cuidSchema,
    /** The status the caller believes the client is currently in. */
    from: clientStatusSchema,
    to: clientStatusSchema,
    /** Defaults to now in the action when the caller does not back-date it. */
    occurredAt: isoDateTimeSchema.optional(),
    /** Required when moving to `CHURNED`; written to `churnReason`. */
    reason: z
      .string({ error: 'Please record why.' })
      .trim()
      .min(MIN_REASON_LENGTH, { error: 'Please record why.' })
      .max(MAX_REASON_LENGTH, {
        error: 'Please keep the reason to 2,000 characters or fewer.',
      })
      .optional(),
    /** Schedules the next conversation as part of the same gesture. */
    followUpAt: isoDateTimeSchema.nullable().optional(),
  })
  .strict()
  .refine(({ from, to }) => from !== to, {
    error: 'This client is already at that stage.',
    path: ['to'],
  })
  .refine(({ from, to }) => canTransitionClientStatus(from, to), {
    error:
      'A client cannot make that move — a prospect is qualified before they subscribe, and a subscriber rests before they leave.',
    path: ['to'],
  })
  .refine(
    ({ to, reason }) =>
      to !== 'CHURNED' || (reason !== undefined && reason.length > 0),
    {
      error:
        'Please record why this client is leaving. Nothing teaches us more than this field.',
      path: ['reason'],
    }
  )
  .refine(
    ({ occurredAt }) =>
      occurredAt === undefined || isNotInTheFuture(occurredAt),
    {
      error: 'A change of stage cannot be recorded for a moment still to come.',
      path: ['occurredAt'],
    }
  )
  .refine(({ followUpAt }) => followUpAt == null || isInTheFuture(followUpAt), {
    error: 'Please choose a follow-up date in the future.',
    path: ['followUpAt'],
  })
export type ClientStatusTransitionInput = z.infer<
  typeof clientStatusTransitionSchema
>
export type ClientStatusTransitionRawInput = z.input<
  typeof clientStatusTransitionSchema
>

// =============================================================================
// 4. Follow-up flag
// =============================================================================

/**
 * Flagging a client for a follow-up, or clearing the flag.
 *
 * Sending `null` for `followUpAt` is how a follow-up is marked done — the flag
 * comes off the record and the client drops out of the "due" column of the
 * pipeline. A date, on the other hand, is always ahead of us: a follow-up in the
 * past is a follow-up that was missed, not one that was scheduled.
 *
 * When `note` is given, the action writes it as a `ClientNote` against the same
 * client so the reason for the flag survives the flag itself.
 */
export const clientFollowUpSchema = z
  .object({
    clientProfileId: cuidSchema,
    /** `null` clears the flag. */
    followUpAt: isoDateTimeSchema.nullable(),
    note: z
      .string({ error: 'Please keep the note to plain text.' })
      .trim()
      .max(MAX_NOTE_BODY_LENGTH, {
        error: 'Please keep the note to 5,000 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
    /** Visibility of the note the flag writes, when it writes one. */
    noteVisibility: noteVisibilitySchema.default('STAFF'),
    /**
     * Whether flagging also moves `lastContactedAt` forward — true when the
     * follow-up is being scheduled at the end of a conversation just had.
     */
    markAsContacted: z
      .boolean({
        error: 'Please say whether you have just spoken with this client.',
      })
      .default(false),
  })
  .strict()
  .refine(
    ({ followUpAt }) => followUpAt === null || isInTheFuture(followUpAt),
    {
      error: 'Please choose a follow-up date in the future.',
      path: ['followUpAt'],
    }
  )
  .refine(
    ({ followUpAt }) =>
      followUpAt === null ||
      followUpAt.getTime() - Date.now() <= MAX_FOLLOW_UP_DAYS * MS_PER_DAY,
    {
      error: 'Please choose a follow-up within the next two years.',
      path: ['followUpAt'],
    }
  )
  .refine(({ followUpAt, note }) => followUpAt !== null || note == null, {
    error:
      'Clearing a follow-up does not carry a note. Write it against the client instead.',
    path: ['note'],
  })
export type ClientFollowUpInput = z.infer<typeof clientFollowUpSchema>
export type ClientFollowUpRawInput = z.input<typeof clientFollowUpSchema>

// =============================================================================
// 5. The pipeline
// =============================================================================

/** How a page of the pipeline is ordered; direction comes from `sortDirection`. */
export const clientPipelineSortBySchema = z
  .enum(
    [
      'CREATED',
      'UPDATED',
      'LAST_CONTACTED',
      'FOLLOW_UP',
      'LIFETIME_VALUE',
      'NAME',
      'STATUS',
    ],
    { error: 'Please choose how the pipeline should be ordered.' }
  )
  .default('UPDATED')
export type ClientPipelineSortBy = z.infer<typeof clientPipelineSortBySchema>

/** A lifetime-value bound, in whole cents. */
const lifetimeValueCentsSchema = moneyCentsSchema.max(
  MAX_LIFETIME_VALUE_CENTS,
  { error: 'That figure is beyond anything in our records.' }
)

/**
 * The pipeline view: every client, narrowed by where they are, where they came
 * from, what they are worth, and whether they are owed a conversation.
 *
 * `followUpDue` is the flag the morning briefing is built on — it selects the
 * clients whose `followUpAt` has arrived. `lastContactedBefore` is its quieter
 * sibling: the clients nobody has spoken to in a while, who have not been
 * flagged because nobody noticed.
 */
export const clientPipelineFilterSchema = paginationSchema
  .extend({
    /** Matches the display name, preferred name, and the client's email. */
    search: z
      .string({ error: 'Please type something to search the pipeline for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    statuses: z
      .array(clientStatusSchema, {
        error: 'Please choose the stages to show.',
      })
      .max(5, { error: 'There are only five stages in the lifecycle.' })
      .refine(hasUniqueValues, {
        error: 'That stage is already part of your search.',
      })
      .default([]),
    sources: z
      .array(clientSourceSchema, {
        error: 'Please choose where these clients came from.',
      })
      .max(9, { error: 'There are only nine sources to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That source is already part of your search.',
      })
      .default([]),
    minLifetimeValueCents: lifetimeValueCentsSchema.optional(),
    maxLifetimeValueCents: lifetimeValueCentsSchema.optional(),
    /** Clients nobody has spoken to since this moment. */
    lastContactedBefore: isoDateTimeSchema.optional(),
    /** Clients who have never been contacted at all. */
    neverContacted: queryFlag(
      false,
      'Please say whether to show only clients nobody has spoken to yet.'
    ),
    /** Clients whose follow-up date has arrived. */
    followUpDue: queryFlag(
      false,
      'Please say whether to show only clients due a follow-up.'
    ),
    /** Clients with a follow-up scheduled before this moment. */
    followUpBefore: isoDateTimeSchema.optional(),
    createdFrom: isoDateTimeSchema.optional(),
    createdTo: isoDateTimeSchema.optional(),
    sortBy: clientPipelineSortBySchema,
  })
  .refine(
    ({ minLifetimeValueCents, maxLifetimeValueCents }) =>
      minLifetimeValueCents === undefined ||
      maxLifetimeValueCents === undefined ||
      minLifetimeValueCents <= maxLifetimeValueCents,
    {
      error: 'The lower figure must not exceed the higher one.',
      path: ['maxLifetimeValueCents'],
    }
  )
  .refine(
    ({ createdFrom, createdTo }) =>
      createdFrom === undefined ||
      createdTo === undefined ||
      createdFrom.getTime() <= createdTo.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['createdTo'],
    }
  )
  .refine(
    ({ neverContacted, lastContactedBefore }) =>
      !neverContacted || lastContactedBefore === undefined,
    {
      error:
        'A client nobody has spoken to has no date of last contact. Please choose one filter or the other.',
      path: ['lastContactedBefore'],
    }
  )
export type ClientPipelineFilterInput = z.infer<
  typeof clientPipelineFilterSchema
>
export type ClientPipelineFilterRawInput = z.input<
  typeof clientPipelineFilterSchema
>

// =============================================================================
// 6. Lifetime-value bucketing
// =============================================================================

/**
 * Asking the OS to group clients by what they are worth.
 *
 * `boundariesCents` is the list of cut points, ascending and without repeats;
 * `n` boundaries make `n + 1` buckets. The defaults are the house tiers, so the
 * common case is `clientLtvBucketingSchema.parse({})`.
 */
export const clientLtvBucketingSchema = z
  .object({
    boundariesCents: z
      .array(
        moneyCentsSchema.max(MAX_LIFETIME_VALUE_CENTS, {
          error: 'That figure is beyond anything in our records.',
        }),
        { error: 'Please give the tier boundaries in whole cents.' }
      )
      .min(1, { error: 'Please give at least one boundary to divide on.' })
      .max(MAX_LTV_BOUNDARIES, {
        error:
          'Eight boundaries is plenty — beyond that it is a table, not a shape.',
      })
      .default([...DEFAULT_LTV_BOUNDARIES_CENTS]),
    /** Narrows the population being bucketed. Empty means every stage. */
    statuses: z
      .array(clientStatusSchema, {
        error: 'Please choose the stages to include.',
      })
      .max(5, { error: 'There are only five stages in the lifecycle.' })
      .refine(hasUniqueValues, {
        error: 'That stage is already part of your selection.',
      })
      .default([]),
    sources: z
      .array(clientSourceSchema, {
        error: 'Please choose the sources to include.',
      })
      .max(9, { error: 'There are only nine sources to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That source is already part of your selection.',
      })
      .default([]),
    /**
     * Whether clients who have not yet spent anything are counted. Leaving them
     * in shows the size of the top of the funnel; taking them out shows the
     * shape of the paying book.
     */
    includeZeroValue: z
      .boolean({
        error: 'Please say whether to include clients who have not yet spent.',
      })
      .default(true),
    createdFrom: isoDateTimeSchema.optional(),
    createdTo: isoDateTimeSchema.optional(),
  })
  .strict()
  .refine(({ boundariesCents }) => isStrictlyAscending(boundariesCents), {
    error:
      'Please list the boundaries from lowest to highest, without repeats.',
    path: ['boundariesCents'],
  })
  .refine(
    ({ createdFrom, createdTo }) =>
      createdFrom === undefined ||
      createdTo === undefined ||
      createdFrom.getTime() <= createdTo.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['createdTo'],
    }
  )
export type ClientLtvBucketingInput = z.infer<typeof clientLtvBucketingSchema>
export type ClientLtvBucketingRawInput = z.input<
  typeof clientLtvBucketingSchema
>

/** One tier of the lifetime-value distribution. */
export interface LtvBucket {
  /** Position in the distribution, lowest tier first. */
  index: number
  /** Inclusive lower bound, in cents. */
  minCents: number
  /** Exclusive upper bound, in cents. `null` on the open-ended top tier. */
  maxCents: number | null
}

/**
 * Expands a list of boundaries into the tiers themselves.
 *
 * Each bucket runs from its lower bound inclusive to its upper bound exclusive,
 * so a client sitting exactly on a boundary belongs to the tier it opens.
 */
export function buildLtvBuckets(
  boundariesCents: readonly number[]
): LtvBucket[] {
  const buckets: LtvBucket[] = []
  let lowerBound = 0

  for (const [index, boundary] of boundariesCents.entries()) {
    buckets.push({ index, minCents: lowerBound, maxCents: boundary })
    lowerBound = boundary
  }

  buckets.push({
    index: boundariesCents.length,
    minCents: lowerBound,
    maxCents: null,
  })

  return buckets
}

/**
 * Which tier a single figure falls into.
 *
 * Shared by the server aggregation and the chart legend so a client is never
 * counted in one tier and coloured as another.
 */
export function ltvBucketIndex(
  valueCents: number,
  boundariesCents: readonly number[]
): number {
  for (const [index, boundary] of boundariesCents.entries()) {
    if (valueCents < boundary) {
      return index
    }
  }

  return boundariesCents.length
}
