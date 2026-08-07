// mannachef/packages/validators/src/review.ts

/**
 * Review domain validation — what guests say about a dish, a chef, an evening,
 * or the house itself, and how the kitchen moderates it.
 *
 * Mirrors `Review` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * Rules that govern this file (see `mannachef/CONTRACT.md`):
 *
 *  1. No runtime dependency on `@prisma/client` — enum values arrive from
 *     `./enums`, which re-declares them as Zod enums.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *     `hasUniqueValues`, `hasSomethingToSave`, `NOTHING_TO_SAVE_MESSAGE`,
 *     `queryFlag` and `MAX_SEARCH_LENGTH` were all declared locally here — and
 *     in as many as five sibling modules — until MCV-004 gave each of them a
 *     single home.
 *  3. `Review` carries three nullable subject columns and only one of them is
 *     ever meant to be set. The schema is therefore a discriminated union over
 *     `subject`, so a review of a dish cannot arrive carrying a chef, and a
 *     review of the platform cannot arrive carrying anything at all.
 *  4. `authorId`, `moderatedById`, `moderatedAt`, `isVerified` and `status` are
 *     decided by the server. A guest states an opinion; the house decides whose
 *     it is, whether it is verified, and whether it is published.
 *  5. The review list is read from a query string, so every numeric and temporal
 *     bound in `reviewFilterSchema` goes through the coercion helpers in
 *     `./common`. The submission, update and moderation schemas stay strict —
 *     they are request bodies, where a string in place of a number is a bug in
 *     the caller rather than an artefact of the transport.
 */

import { z } from 'zod'

import {
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  cuidSchema,
  hasUniqueValues,
  isoDateTimeSchema,
  paginationSchema,
  queryFlag,
  ratingSchema,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'
import { reviewStatusSchema, reviewSubjectSchema } from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Matches `Review.title` — `@db.VarChar(200)`. */
const MAX_TITLE_LENGTH = 200

/** A headline shorter than this is not a headline. */
const MIN_TITLE_LENGTH = 3

/** Enough to say something, so a review is worth reading. */
export const MIN_REVIEW_BODY_LENGTH = 20

/** Generous ceiling for the `@db.Text` body. */
export const MAX_REVIEW_BODY_LENGTH = 5_000

/** Generous ceiling for a `@db.Text` moderation note. */
const MAX_MODERATION_NOTE_LENGTH = 2_000

/** A rejection is explained, and this is the shortest explanation we accept. */
const MIN_MODERATION_NOTE_LENGTH = 4

/** How many reviews may sit in the featured carousel. */
export const MAX_FEATURED_ORDER = 100

/** How many reviews one moderation queue action may touch. */
export const MAX_BULK_REVIEWS = 100

// =============================================================================
// Shared field schemas
// =============================================================================

/** An optional headline above the review. */
export const reviewTitleSchema = z
  .string({ error: 'Please give your review a headline, or leave it blank.' })
  .trim()
  .min(MIN_TITLE_LENGTH, {
    error: 'A headline needs at least three characters.',
  })
  .max(MAX_TITLE_LENGTH, {
    error: 'Please keep the headline to 200 characters or fewer.',
  })
export type ReviewTitle = z.infer<typeof reviewTitleSchema>

/**
 * The review itself.
 *
 * The lower bound is deliberate: a single word tells the next guest nothing, and
 * the message says why rather than simply refusing.
 */
export const reviewBodySchema = z
  .string({ error: 'Please tell us how it was.' })
  .trim()
  .min(MIN_REVIEW_BODY_LENGTH, {
    error:
      'A sentence or two, please — the next guest reads this before they book.',
  })
  .max(MAX_REVIEW_BODY_LENGTH, {
    error: 'Please keep your review to 5,000 characters or fewer.',
  })
export type ReviewBody = z.infer<typeof reviewBodySchema>

/** A position within the featured carousel on the marketing site. */
export const featuredOrderSchema = z
  .int({ error: 'Please give a whole number for the featured position.' })
  .min(0, { error: 'The featured order begins at zero.' })
  .max(MAX_FEATURED_ORDER, {
    error:
      'We feature a hundred reviews at most — please choose a lower position.',
  })
export type FeaturedOrder = z.infer<typeof featuredOrderSchema>

/** What a guest says, whatever they are saying it about. */
const reviewContentShape = {
  rating: ratingSchema,
  title: reviewTitleSchema.optional(),
  body: reviewBodySchema,
} as const

// =============================================================================
// 1. Submission
// =============================================================================

/**
 * Submitting a review.
 *
 * A discriminated union over `ReviewSubject` so the subject and its reference
 * travel together:
 *
 *  - `MENU_ITEM` requires `menuItemId`;
 *  - `CHEF` requires `staffProfileId`;
 *  - `APPOINTMENT` requires `appointmentId`;
 *  - `PLATFORM` carries no reference at all.
 *
 * `appointmentId` is additionally accepted on a dish or chef review, because an
 * evening is what makes a review verified — the action looks the engagement up,
 * confirms it belongs to the author and was completed, and only then sets
 * `isVerified`. A guest can never set that flag themselves.
 */
export const reviewSubmissionSchema = z.discriminatedUnion(
  'subject',
  [
    z
      .object({
        subject: z.literal('MENU_ITEM'),
        /** The dish being reviewed. */
        menuItemId: cuidSchema,
        /** The evening it was served at, when there was one. */
        appointmentId: cuidSchema.optional(),
        ...reviewContentShape,
      })
      .strict(),
    z
      .object({
        subject: z.literal('CHEF'),
        /** The chef being reviewed. */
        staffProfileId: cuidSchema,
        /** The engagement they cooked, when there was one. */
        appointmentId: cuidSchema.optional(),
        ...reviewContentShape,
      })
      .strict(),
    z
      .object({
        subject: z.literal('APPOINTMENT'),
        /** The engagement being reviewed. */
        appointmentId: cuidSchema,
        ...reviewContentShape,
      })
      .strict(),
    z
      .object({
        subject: z.literal('PLATFORM'),
        ...reviewContentShape,
      })
      .strict(),
  ],
  { error: 'Please tell us what this review is about.' }
)
export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionSchema>
export type ReviewSubmissionRawInput = z.input<typeof reviewSubmissionSchema>

/**
 * The three fields a guest may revise, before `buildUpdateSchema` makes them
 * optional. `title` is nullable here rather than optional: sending `null`
 * removes the headline, whereas omitting the key leaves it alone.
 */
const reviewAmendableShape = {
  rating: ratingSchema,
  /** `null` removes the headline. */
  title: reviewTitleSchema.nullable(),
  body: reviewBodySchema,
} as const

/**
 * A guest amending their own review.
 *
 * The subject is not editable: a review of one dish does not become a review of
 * another. The action re-checks authorship, and returns the review to `PENDING`
 * so an edited review is read again before it is published.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * None of the three fields carries a `.default(...)` today, so this schema was
 * never exposed to the injection bug that `withoutDefaults` exists to prevent.
 * It is routed through the shared builder anyway, because the safety here was
 * incidental rather than designed: the day somebody gives `rating` a house
 * default, a hand-rolled `.partial()` would silently re-score every review that
 * was edited for a typo. Going through the builder means the strip happens
 * before the `.partial()` whether or not anyone remembers it needs to.
 *
 * The "nothing to save" guard comes from the builder as
 * `hasSomethingToSaveBeyond(1)` — the generalised form of `hasSomethingToSave`,
 * with the threshold computed from the single key kept required — so a bare
 * `{ id }` is still refused, on the `id` path, with the same message.
 */
export const reviewUpdateSchema = buildUpdateSchema(reviewAmendableShape, {
  requireKeys: { id: cuidSchema },
})
export type ReviewUpdateInput = z.infer<typeof reviewUpdateSchema>
export type ReviewUpdateRawInput = z.input<typeof reviewUpdateSchema>

/**
 * Reads the subject reference out of a parsed submission, so the action can hand
 * Prisma the three nullable columns without a second `switch`.
 */
export function reviewSubjectColumns(input: ReviewSubmissionInput): {
  menuItemId: string | null
  staffProfileId: string | null
  appointmentId: string | null
} {
  switch (input.subject) {
    case 'MENU_ITEM':
      return {
        menuItemId: input.menuItemId,
        staffProfileId: null,
        appointmentId: input.appointmentId ?? null,
      }
    case 'CHEF':
      return {
        menuItemId: null,
        staffProfileId: input.staffProfileId,
        appointmentId: input.appointmentId ?? null,
      }
    case 'APPOINTMENT':
      return {
        menuItemId: null,
        staffProfileId: null,
        appointmentId: input.appointmentId,
      }
    case 'PLATFORM':
      return {
        menuItemId: null,
        staffProfileId: null,
        appointmentId: null,
      }
  }
}

// =============================================================================
// 2. Moderation
// =============================================================================

/**
 * A moderator's decision.
 *
 * A discriminated union so `featuredOrder` exists only where it means
 * something — on `FEATURE` — and is required there rather than optional.
 * `moderationNote` is likewise required on `REJECT`: a review is never turned
 * away without a recorded reason, because the author may ask, and because the
 * next moderator deserves the context.
 *
 * `moderatedById` and `moderatedAt` are set from the session and the clock
 * inside the action (`mannachef/CONTRACT.md` §5).
 */
export const reviewModerationSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('APPROVE'),
        reviewId: cuidSchema,
        /** Optional context for the next moderator. Never shown to the guest. */
        moderationNote: z
          .string({ error: 'Please keep the note to plain text.' })
          .trim()
          .max(MAX_MODERATION_NOTE_LENGTH, {
            error: 'Please keep the note to 2,000 characters or fewer.',
          })
          .transform((value) => (value.length > 0 ? value : null))
          .nullable()
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('REJECT'),
        reviewId: cuidSchema,
        /** Required. A review is never turned away without a reason on record. */
        moderationNote: z
          .string({ error: 'Please record why this review was not published.' })
          .trim()
          .min(MIN_MODERATION_NOTE_LENGTH, {
            error: 'Please record why this review was not published.',
          })
          .max(MAX_MODERATION_NOTE_LENGTH, {
            error: 'Please keep the note to 2,000 characters or fewer.',
          }),
      })
      .strict(),
    z
      .object({
        action: z.literal('FEATURE'),
        reviewId: cuidSchema,
        /**
         * Required, and only here. Featuring is a curatorial act — the position
         * in the carousel is the whole point of it.
         */
        featuredOrder: featuredOrderSchema,
        moderationNote: z
          .string({ error: 'Please keep the note to plain text.' })
          .trim()
          .max(MAX_MODERATION_NOTE_LENGTH, {
            error: 'Please keep the note to 2,000 characters or fewer.',
          })
          .transform((value) => (value.length > 0 ? value : null))
          .nullable()
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('UNFEATURE'),
        reviewId: cuidSchema,
        /**
         * Where the review lands once it leaves the carousel. It stays published
         * unless the moderator says otherwise.
         */
        returnTo: z
          .enum(['APPROVED', 'PENDING'], {
            error:
              'Please choose where this review should sit once unfeatured.',
          })
          .default('APPROVED'),
      })
      .strict(),
  ],
  { error: 'Please choose what should happen to this review.' }
)
export type ReviewModerationInput = z.infer<typeof reviewModerationSchema>
export type ReviewModerationRawInput = z.input<typeof reviewModerationSchema>

/** The discriminator values, handy for rendering the moderation controls. */
export const REVIEW_MODERATION_ACTIONS = [
  'APPROVE',
  'REJECT',
  'FEATURE',
  'UNFEATURE',
] as const

export type ReviewModerationAction = (typeof REVIEW_MODERATION_ACTIONS)[number]

/** The status a moderation action leaves the review in. */
export function reviewStatusAfterModeration(
  input: ReviewModerationInput
): 'APPROVED' | 'REJECTED' | 'FEATURED' | 'PENDING' {
  switch (input.action) {
    case 'APPROVE':
      return 'APPROVED'
    case 'REJECT':
      return 'REJECTED'
    case 'FEATURE':
      return 'FEATURED'
    case 'UNFEATURE':
      return input.returnTo
  }
}

/**
 * Clearing the moderation queue in one gesture.
 *
 * Only the two decisions that need no per-review argument are offered in bulk —
 * featuring is curatorial and is done one review at a time.
 */
export const reviewBulkModerationSchema = z
  .object({
    reviewIds: z
      .array(cuidSchema, { error: 'Please choose the reviews to act on.' })
      .min(1, { error: 'Choose at least one review first.' })
      .max(MAX_BULK_REVIEWS, {
        error: 'Please act on a hundred reviews at a time or fewer.',
      })
      .refine(hasUniqueValues, {
        error: 'That review has already been chosen.',
      }),
    action: z.enum(['APPROVE', 'REJECT'], {
      error: 'Please choose whether to publish or turn away these reviews.',
    }),
    moderationNote: z
      .string({ error: 'Please keep the note to plain text.' })
      .trim()
      .max(MAX_MODERATION_NOTE_LENGTH, {
        error: 'Please keep the note to 2,000 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.action !== 'REJECT' ||
      (value.moderationNote != null &&
        value.moderationNote.length >= MIN_MODERATION_NOTE_LENGTH),
    {
      error: 'Please record why these reviews were not published.',
      path: ['moderationNote'],
    }
  )
export type ReviewBulkModerationInput = z.infer<
  typeof reviewBulkModerationSchema
>
export type ReviewBulkModerationRawInput = z.input<
  typeof reviewBulkModerationSchema
>

// =============================================================================
// 3. Filtering
// =============================================================================

/** How a page of reviews is ordered; direction comes from `sortDirection`. */
export const reviewSortBySchema = z
  .enum(['CREATED', 'UPDATED', 'RATING', 'MODERATED', 'FEATURED_ORDER'], {
    error: 'Please choose how the reviews should be ordered.',
  })
  .default('CREATED')
export type ReviewSortBy = z.infer<typeof reviewSortBySchema>

export const reviewFilterSchema = paginationSchema
  .extend({
    /** Matches the headline and the body. */
    search: z
      .string({ error: 'Please type something to search the reviews for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    subjects: z
      .array(reviewSubjectSchema, {
        error: 'Please choose what the reviews should be about.',
      })
      .max(4, { error: 'There are only four subjects to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That subject is already part of your search.',
      })
      .default([]),
    statuses: z
      .array(reviewStatusSchema, {
        error: 'Please choose the moderation statuses to show.',
      })
      .max(4, { error: 'There are only four statuses to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That status is already part of your search.',
      })
      .default([]),
    menuItemId: cuidSchema.optional(),
    staffProfileId: cuidSchema.optional(),
    appointmentId: cuidSchema.optional(),
    /** Server actions confirm the caller may see another person's reviews. */
    authorId: cuidSchema.optional(),
    moderatedById: cuidSchema.optional(),
    /**
     * The two bounds the MCV-005 audit proved broken.
     *
     * The star-rating control on the review list renders as a pair of query
     * parameters, so `?minRating=4` arrives as the string `"4"`. `ratingSchema`
     * is `z.int()` and does not coerce, which meant the one filter guests and
     * moderators actually reach for rejected its own output with "Please choose
     * a rating from one to five stars" — for the value `4`.
     *
     * `withNumericCoercion` wraps `ratingSchema` rather than restating it, so
     * the one-to-five bounds and all three messages are unchanged, and a request
     * body carrying a real `4` is validated by exactly the same schema. The
     * `.optional()` sits inside the coercion so a rendered-but-empty
     * `?minRating=` reads as "no filter" instead of failing on `''`.
     */
    minRating: withNumericCoercion(ratingSchema.optional()),
    maxRating: withNumericCoercion(ratingSchema.optional()),
    /** Narrows to reviews tied to an engagement we know took place. */
    verifiedOnly: queryFlag(
      false,
      'Please say whether to show only reviews from a served engagement.'
    ),
    /** Narrows to the reviews in the carousel. */
    featuredOnly: queryFlag(
      false,
      'Please say whether to show only featured reviews.'
    ),
    /** Narrows to reviews still waiting to be read. */
    awaitingModeration: queryFlag(
      false,
      'Please say whether to show only reviews awaiting moderation.'
    ),
    /** Reachable over GET on the same list, so both date bounds coerce too. */
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: reviewSortBySchema,
  })
  .refine(
    ({ minRating, maxRating }) =>
      minRating === undefined ||
      maxRating === undefined ||
      minRating <= maxRating,
    {
      error: 'The lowest rating must not exceed the highest one.',
      path: ['maxRating'],
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
export type ReviewFilterInput = z.infer<typeof reviewFilterSchema>
export type ReviewFilterRawInput = z.input<typeof reviewFilterSchema>
