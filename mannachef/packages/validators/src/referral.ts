// mannachef/packages/validators/src/referral.ts

/**
 * Growth domain validation — invitation codes, their redemptions, and the
 * append-only reward ledger that sits behind a subscriber's credit balance.
 *
 * Mirrors `ReferralCode`, `ReferralRedemption`, `RewardBalance` and
 * `RewardLedgerEntry` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * Rules that govern this file (see `mannachef/CONTRACT.md`):
 *
 *  1. No runtime dependency on `@prisma/client` — enum values arrive from
 *     `./enums`, which re-declares them as Zod enums.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *     `hasUniqueValues`, `hasSomethingToSave`, `NOTHING_TO_SAVE_MESSAGE`,
 *     `queryFlag`, `optionalProse`, `isInTheFuture`, `isNotInTheFuture` and
 *     `MAX_SEARCH_LENGTH` were all declared locally here — and in as many as
 *     five sibling modules — until MCV-004 gave each of them a single home.
 *  3. The reward a code grants is a discriminated union, not a bag of nullable
 *     columns: a percentage code cannot carry a cash value and a credit code
 *     cannot carry a percentage. The database allows both to be null; this layer
 *     is where the pairing is actually enforced.
 *  4. `redemptionCount`, `balanceAfterCents` and `balanceId` are computed inside
 *     the transaction that writes them and are never accepted from a caller.
 *  5. `referral.codes` is a `GET` route in `@mannachef/api-contract`, and the
 *     redemption and ledger lists are read the same way, so every numeric and
 *     temporal bound in an `xFilterSchema` goes through the coercion helpers in
 *     `./common`. The create, update, redemption and ledger-write schemas stay
 *     strict: a string where a number belongs in a request body is a bug in the
 *     caller rather than an artefact of the transport.
 */

import { z } from 'zod'

import {
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  cuidSchema,
  currencySchema,
  hasUniqueValues,
  isInTheFuture,
  isNotInTheFuture,
  isoDateTimeSchema,
  moneyCentsSchema,
  optionalProse,
  paginationSchema,
  percentSchema,
  queryFlag,
  withNumericCoercion,
  withTemporalCoercion,
} from './common'
import {
  referralRedemptionStatusSchema,
  rewardLedgerDirectionSchema,
  rewardLedgerReasonSchema,
  rewardTypeSchema,
  type RewardType,
} from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Short enough to say over dinner. */
export const MIN_REFERRAL_CODE_LENGTH = 6

/** Long enough to stay unguessable. `ReferralCode.code` is `@db.VarChar(40)`. */
export const MAX_REFERRAL_CODE_LENGTH = 12

/** The length `generateReferralCode` produces when it is not told otherwise. */
export const DEFAULT_REFERRAL_CODE_LENGTH = 8

/** Matches `ReferralCode.label` — `@db.VarChar(160)`. */
const MAX_LABEL_LENGTH = 160

/** Generous ceiling for a `@db.Text` note or reason. */
const MAX_NOTE_LENGTH = 2_000

/** $10,000.00 — the ceiling on a single reward or adjustment. */
export const MAX_REWARD_CENTS = 1_000_000

/** A code that can be redeemed more times than this is a public promotion. */
export const MAX_REDEMPTIONS = 10_000

/** The shape a stored code takes: capitals and numerals only. */
const REFERRAL_CODE_PATTERN = new RegExp(
  `^[A-Z0-9]{${MIN_REFERRAL_CODE_LENGTH},${MAX_REFERRAL_CODE_LENGTH}}$`
)

/**
 * The alphabet new codes are drawn from.
 *
 * `I`, `O`, `0` and `1` are left out on purpose: a code is read aloud across a
 * table and written down on the back of a card, and those four are where that
 * goes wrong. Codes already in circulation are still accepted with the full
 * alphanumeric range — this alphabet governs generation, not validation.
 */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// =============================================================================
// The code itself
// =============================================================================

/**
 * An invitation code.
 *
 * Guests type these from memory, so the input is forgiving: spacing, hyphens
 * and lower case are all normalised away before the shape is checked. What is
 * stored — and what this yields — is always plain capitals and numerals.
 */
export const referralCodeSchema = z
  .string({ error: 'Please enter an invitation code.' })
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/[\s-]+/g, ''))
  .refine((value) => value.length > 0, {
    error: 'Please enter an invitation code.',
  })
  .refine((value) => REFERRAL_CODE_PATTERN.test(value), {
    error:
      'An invitation code is between six and twelve letters and numbers — for example, TABLE24.',
  })
export type ReferralCode = z.infer<typeof referralCodeSchema>

/**
 * Draws `length` characters from `REFERRAL_CODE_ALPHABET`.
 *
 * Uses the Web Crypto API where it exists — browsers, Node 18+, edge runtimes —
 * and rejection-samples so every character in the alphabet is equally likely.
 * Where no cryptographic source is available the code still generates, because a
 * referral code guards a discount rather than an account; uniqueness is enforced
 * by the `@unique` constraint on `ReferralCode.code`, and the action retries on
 * collision.
 */
export function generateReferralCode(
  length: number = DEFAULT_REFERRAL_CODE_LENGTH
): string {
  const size = Math.min(
    Math.max(Math.trunc(length), MIN_REFERRAL_CODE_LENGTH),
    MAX_REFERRAL_CODE_LENGTH
  )

  const alphabetLength = REFERRAL_CODE_ALPHABET.length
  /** The largest multiple of the alphabet that fits in a byte, for rejection sampling. */
  const ceiling = Math.floor(256 / alphabetLength) * alphabetLength

  const cryptoSource =
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
      ? globalThis.crypto
      : null

  let code = ''

  while (code.length < size) {
    const remaining = size - code.length
    /** Over-draw so rejected bytes rarely cost a second round trip. */
    const draw = remaining * 2

    let bytes: Uint8Array

    if (cryptoSource === null) {
      bytes = new Uint8Array(draw)
      for (let index = 0; index < draw; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256)
      }
    } else {
      bytes = cryptoSource.getRandomValues(new Uint8Array(draw))
    }

    for (const byte of bytes) {
      if (code.length >= size) {
        break
      }

      if (byte >= ceiling) {
        continue
      }

      code += REFERRAL_CODE_ALPHABET.charAt(byte % alphabetLength)
    }
  }

  return code
}

/** Whether a reward type is measured in money or in percent. */
export function referralRewardValueKind(
  rewardType: RewardType
): 'CENTS' | 'PERCENT' {
  return rewardType === 'PERCENT_DISCOUNT' ? 'PERCENT' : 'CENTS'
}

// =============================================================================
// Shared reward field schemas
// =============================================================================

/** A reward paid in money. Zero is not a reward. */
export const rewardCentsSchema = moneyCentsSchema
  .min(1, { error: 'A reward has to be worth something.' })
  .max(MAX_REWARD_CENTS, {
    error:
      'A single reward tops out at $10,000. Please arrange larger gestures by hand.',
  })
export type RewardCents = z.infer<typeof rewardCentsSchema>

/** A reward paid as a share of the bill, 1–100. */
export const rewardPercentSchema = percentSchema.min(1, {
  error: 'A percentage reward has to be at least one percent.',
})
export type RewardPercent = z.infer<typeof rewardPercentSchema>

/** The fields every invitation code carries, whatever it rewards. */
const referralCodeCommonShape = {
  /**
   * Omit to have the house generate one with `generateReferralCode`. A code the
   * owner chooses is normalised to capitals before the uniqueness check.
   */
  code: referralCodeSchema.optional(),
  /**
   * Whose code this is. Re-checked inside the action: a subscriber may only
   * create codes for themselves, an admin may create them for anyone
   * (`mannachef/CONTRACT.md` §5).
   */
  ownerId: cuidSchema,
  label: optionalProse(
    MAX_LABEL_LENGTH,
    'Please keep the label to 160 characters or fewer.'
  ),
  currency: currencySchema,
  /** What the invited guest receives, when it differs from the owner's reward. */
  refereeRewardCents: rewardCentsSchema.nullable().optional(),
  /** `null` leaves the code open-ended. */
  maxRedemptions: z
    .int({ error: 'Please give the redemption limit as a whole number.' })
    .min(1, { error: 'A code that cannot be redeemed once is no code at all.' })
    .max(MAX_REDEMPTIONS, {
      error: 'Beyond ten thousand redemptions, please run this as a campaign.',
    })
    .nullable()
    .optional(),
  /** `null` leaves the code open until it is withdrawn. */
  expiresAt: isoDateTimeSchema.nullable().optional(),
  isActive: z
    .boolean({ error: 'Please say whether this code may be redeemed.' })
    .default(true),
} as const

const EXPIRY_IN_PAST_MESSAGE =
  'Please choose an expiry in the future, or leave the code open-ended.'

function expiryIsAhead(value: {
  expiresAt?: Date | null | undefined
}): boolean {
  return value.expiresAt == null || isInTheFuture(value.expiresAt)
}

// =============================================================================
// 1. Invitation codes
// =============================================================================

/**
 * Creating an invitation code.
 *
 * A discriminated union over `rewardType` so the reward and its measure travel
 * together: `PERCENT_DISCOUNT` carries `rewardValuePercent`, and every other
 * kind carries `rewardValueCents`. The strict objects mean the wrong pairing is
 * rejected rather than quietly ignored.
 */
export const referralCodeCreateSchema = z.discriminatedUnion(
  'rewardType',
  [
    z
      .object({
        rewardType: z.literal('FIXED_CREDIT'),
        /** Credit added to the owner's balance once the referral qualifies. */
        rewardValueCents: rewardCentsSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .refine(expiryIsAhead, {
        error: EXPIRY_IN_PAST_MESSAGE,
        path: ['expiresAt'],
      }),
    z
      .object({
        rewardType: z.literal('PERCENT_DISCOUNT'),
        /** Whole percent off the next invoice, 1–100. */
        rewardValuePercent: rewardPercentSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .refine(expiryIsAhead, {
        error: EXPIRY_IN_PAST_MESSAGE,
        path: ['expiresAt'],
      }),
    z
      .object({
        rewardType: z.literal('FREE_MEAL'),
        /** What the complimentary meal is worth, so the ledger balances. */
        rewardValueCents: rewardCentsSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .refine(expiryIsAhead, {
        error: EXPIRY_IN_PAST_MESSAGE,
        path: ['expiresAt'],
      }),
    z
      .object({
        rewardType: z.literal('FREE_DELIVERY'),
        /** What the waived delivery is worth, so the ledger balances. */
        rewardValueCents: rewardCentsSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .refine(expiryIsAhead, {
        error: EXPIRY_IN_PAST_MESSAGE,
        path: ['expiresAt'],
      }),
  ],
  { error: 'Please choose the reward this code should grant.' }
)
export type ReferralCodeCreateInput = z.infer<typeof referralCodeCreateSchema>
export type ReferralCodeCreateRawInput = z.input<
  typeof referralCodeCreateSchema
>

/**
 * Everything about a code in circulation that may still be changed, before
 * `buildUpdateSchema` makes it optional.
 *
 * Six of the nine fields are taken straight from `referralCodeCommonShape` so
 * the create path and the amend path cannot drift: same ceilings, same wording,
 * one definition. `code` and `ownerId` are the two members of that shape which
 * are deliberately *not* here — an invitation already printed on a card is not
 * rewritten, and a code does not change hands.
 *
 * `currency` and `isActive` arrive carrying their `.default(...)`, which is
 * exactly right: `withoutDefaults` strips them on the way into `.partial()`,
 * and the create schema keeps them.
 */
const referralCodeUpdatableShape = {
  label: referralCodeCommonShape.label,
  currency: referralCodeCommonShape.currency,
  refereeRewardCents: referralCodeCommonShape.refereeRewardCents,
  maxRedemptions: referralCodeCommonShape.maxRedemptions,
  expiresAt: referralCodeCommonShape.expiresAt,
  isActive: referralCodeCommonShape.isActive,
  /** Flat, not discriminated — see the note on the schema below. */
  rewardType: rewardTypeSchema,
  rewardValueCents: rewardCentsSchema.nullable(),
  rewardValuePercent: rewardPercentSchema.nullable(),
} as const

/**
 * Amending a code already in circulation.
 *
 * Not a discriminated union, because a partial update may leave `rewardType`
 * untouched while changing only a label or an expiry. The pairing rule is
 * therefore enforced in a `superRefine`, which can raise one message about the
 * measure that is missing and another about the one that does not belong.
 * `referralCodeCreateSchema` keeps its union — a code being minted always states
 * what it rewards — and nothing about that behaviour changes here.
 *
 * `code` is absent on purpose: an invitation already printed on a card is not
 * rewritten. Withdraw it with `isActive: false` and issue another.
 *
 * ## Why this goes through `buildUpdateSchema` (MCV-005)
 *
 * This schema was already stripping one default, by hand and in a way that
 * hid what it was doing: `currency: currencySchema.unwrap().optional()`. That
 * `.unwrap()` is `withoutDefaults` performed manually on a single field, and it
 * only worked because whoever wrote it happened to know `currencySchema` ends in
 * `.default('CAD')`. `isActive` got no such treatment, because it was re-declared
 * from scratch rather than reused — which is precisely the drift the shared
 * builder exists to stop. Had either been reused with its default intact under a
 * plain `.partial()`, correcting a code's label would have re-activated a
 * withdrawn invitation and reset a US-dollar code to CAD.
 *
 * The builder now performs the strip for every field at once, before
 * `.partial()`, and supplies the "nothing to save" guard as
 * `hasSomethingToSaveBeyond(1)` — the generalised form of `hasSomethingToSave`.
 * Both refinements that follow are unchanged.
 */
export const referralCodeUpdateSchema = buildUpdateSchema(
  referralCodeUpdatableShape,
  { requireKeys: { id: cuidSchema } }
)
  .refine(expiryIsAhead, {
    error: EXPIRY_IN_PAST_MESSAGE,
    path: ['expiresAt'],
  })
  .superRefine((value, ctx) => {
    if (value.rewardType === undefined) {
      /**
       * The reward kind is unchanged, so only a contradiction is worth
       * flagging: no single code is worth both a sum and a share.
       */
      if (value.rewardValueCents != null && value.rewardValuePercent != null) {
        ctx.addIssue({
          code: 'custom',
          message:
            'A code rewards either a sum or a share of the bill, not both. Please clear one.',
          path: ['rewardValuePercent'],
        })
      }

      return
    }

    if (referralRewardValueKind(value.rewardType) === 'PERCENT') {
      if (value.rewardValuePercent == null) {
        ctx.addIssue({
          code: 'custom',
          message:
            'A percentage code needs the share it takes off — please set it between 1 and 100.',
          path: ['rewardValuePercent'],
        })
      }

      if (value.rewardValueCents != null) {
        ctx.addIssue({
          code: 'custom',
          message:
            'A percentage code has no cash value. Please clear the amount.',
          path: ['rewardValueCents'],
        })
      }

      return
    }

    if (value.rewardValueCents == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Please set what this code is worth.',
        path: ['rewardValueCents'],
      })
    }

    if (value.rewardValuePercent != null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'This code rewards a sum rather than a share. Please clear the percentage.',
        path: ['rewardValuePercent'],
      })
    }
  })
export type ReferralCodeUpdateInput = z.infer<typeof referralCodeUpdateSchema>
export type ReferralCodeUpdateRawInput = z.input<
  typeof referralCodeUpdateSchema
>

/** How a page of codes is ordered; direction comes from `sortDirection`. */
export const referralCodeSortBySchema = z
  .enum(['CREATED', 'REDEMPTIONS', 'EXPIRES', 'CODE'], {
    error: 'Please choose how the codes should be ordered.',
  })
  .default('CREATED')
export type ReferralCodeSortBy = z.infer<typeof referralCodeSortBySchema>

export const referralCodeFilterSchema = paginationSchema
  .extend({
    /** Matches the code and its label. */
    search: z
      .string({ error: 'Please type something to search the codes for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    /** Server actions confirm the caller may see another person's codes. */
    ownerId: cuidSchema.optional(),
    rewardTypes: z
      .array(rewardTypeSchema, {
        error: 'Please choose the kinds of reward to show.',
      })
      .max(4, { error: 'There are only four kinds of reward to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That reward is already part of your search.',
      })
      .default([]),
    isActive: queryFlag(
      true,
      'Please say whether to show codes that may still be redeemed.'
    ),
    /** Surfaces codes whose expiry has already passed. */
    expiredOnly: queryFlag(
      false,
      'Please say whether to show only codes that have expired.'
    ),
    /** Surfaces codes that have reached their redemption limit. */
    exhaustedOnly: queryFlag(
      false,
      'Please say whether to show only codes that have been fully redeemed.'
    ),
    /**
     * `referral.codes` is a `GET` route in `@mannachef/api-contract`, so both
     * bounds coerce. Beyond the epoch-millisecond form, this is what absorbs
     * `Date.prototype.toString()` output — which is what
     * `new URLSearchParams({ createdFrom: someDate })` actually writes, and
     * which the strict `isoDateTimeSchema` rightly refuses.
     *
     * The `.optional()` sits inside the coercion so a rendered-but-empty
     * `?createdFrom=` reads as "no filter" rather than as a malformed date.
     */
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: referralCodeSortBySchema,
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
export type ReferralCodeFilterInput = z.infer<typeof referralCodeFilterSchema>
export type ReferralCodeFilterRawInput = z.input<
  typeof referralCodeFilterSchema
>

// =============================================================================
// 2. Redemption
// =============================================================================

/**
 * Redeeming an invitation.
 *
 * The invited guest is normally the signed-in caller, so `referredUserId` is
 * optional and the action falls back to the session. When an admin records a
 * redemption on someone's behalf the id is stated, and the action confirms the
 * caller is entitled to act for them.
 *
 * The action additionally checks — inside the same transaction as the write —
 * that the code is active, unexpired, has redemptions left, and does not belong
 * to the guest redeeming it. None of those can be settled here.
 */
export const referralRedemptionCreateSchema = z
  .object({
    code: referralCodeSchema,
    referredUserId: cuidSchema.optional(),
  })
  .strict()
export type ReferralRedemptionCreateInput = z.infer<
  typeof referralRedemptionCreateSchema
>
export type ReferralRedemptionCreateRawInput = z.input<
  typeof referralRedemptionCreateSchema
>

/**
 * Moving a redemption through its lifecycle.
 *
 * `PENDING → QUALIFIED` once the invited guest's first invoice is paid,
 * `QUALIFIED → REWARDED` once the ledger entry lands, and `REVOKED` when a
 * chargeback or an abuse review takes it back. Each step records its own moment
 * so the ledger and the redemption never disagree about when something happened.
 */
export const referralRedemptionStatusUpdateSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('QUALIFY'),
        redemptionId: cuidSchema,
        /** Defaults to now in the action when the caller does not back-date it. */
        qualifiedAt: isoDateTimeSchema.optional(),
      })
      .strict()
      .refine(
        ({ qualifiedAt }) =>
          qualifiedAt === undefined || isNotInTheFuture(qualifiedAt),
        {
          error:
            'A qualification cannot be recorded for a moment still to come.',
          path: ['qualifiedAt'],
        }
      ),
    z
      .object({
        action: z.literal('REWARD'),
        redemptionId: cuidSchema,
        /**
         * The snapshot written to `ReferralRedemption.rewardCents`. Omit to let
         * the action take the figure from the code itself.
         */
        rewardCents: rewardCentsSchema.optional(),
        rewardedAt: isoDateTimeSchema.optional(),
      })
      .strict()
      .refine(
        ({ rewardedAt }) =>
          rewardedAt === undefined || isNotInTheFuture(rewardedAt),
        {
          error: 'A reward cannot be recorded for a moment still to come.',
          path: ['rewardedAt'],
        }
      ),
    z
      .object({
        action: z.literal('EXPIRE'),
        redemptionId: cuidSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('REVOKE'),
        redemptionId: cuidSchema,
        /** Revoking takes something back, so the reason is never optional. */
        revokedReason: z
          .string({
            error: 'Please record why this reward is being withdrawn.',
          })
          .trim()
          .min(4, {
            error: 'Please record why this reward is being withdrawn.',
          })
          .max(MAX_NOTE_LENGTH, {
            error: 'Please keep the reason to 2,000 characters or fewer.',
          }),
        revokedAt: isoDateTimeSchema.optional(),
        /**
         * Whether a compensating `REVERSAL` entry should be written against the
         * balance. Only meaningful once the reward has actually been paid.
         */
        reverseLedgerEntry: z
          .boolean({
            error:
              'Please say whether the credit already paid should be taken back.',
          })
          .default(true),
      })
      .strict()
      .refine(
        ({ revokedAt }) =>
          revokedAt === undefined || isNotInTheFuture(revokedAt),
        {
          error: 'A withdrawal cannot be recorded for a moment still to come.',
          path: ['revokedAt'],
        }
      ),
  ],
  { error: 'Please choose what should happen to this redemption.' }
)
export type ReferralRedemptionStatusUpdateInput = z.infer<
  typeof referralRedemptionStatusUpdateSchema
>
export type ReferralRedemptionStatusUpdateRawInput = z.input<
  typeof referralRedemptionStatusUpdateSchema
>

/** The discriminator values, handy for rendering the redemption controls. */
export const REFERRAL_REDEMPTION_ACTIONS = [
  'QUALIFY',
  'REWARD',
  'EXPIRE',
  'REVOKE',
] as const

export type ReferralRedemptionAction =
  (typeof REFERRAL_REDEMPTION_ACTIONS)[number]

export const referralRedemptionFilterSchema = paginationSchema
  .extend({
    referralCodeId: cuidSchema.optional(),
    referredUserId: cuidSchema.optional(),
    /** Narrows to the redemptions of one owner's codes. */
    ownerId: cuidSchema.optional(),
    statuses: z
      .array(referralRedemptionStatusSchema, {
        error: 'Please choose the redemption statuses to show.',
      })
      .max(5, { error: 'There are only five statuses to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That status is already part of your search.',
      })
      .default([]),
    /** Read from a query string on the same admin surface, so both coerce. */
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
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
export type ReferralRedemptionFilterInput = z.infer<
  typeof referralRedemptionFilterSchema
>
export type ReferralRedemptionFilterRawInput = z.input<
  typeof referralRedemptionFilterSchema
>

// =============================================================================
// 3. The reward ledger
// =============================================================================

/**
 * Paying out a referral reward.
 *
 * This is the happy path of the ledger: a `CREDIT` raised because an invitation
 * did its work. `balanceAfterCents`, `balanceId` and `createdById` are supplied
 * by the action — the first two because only the transaction knows the balance,
 * the third because attribution comes from the session, never the browser.
 */
export const rewardPayoutSchema = z
  .object({
    /** Whose balance is being credited. */
    userId: cuidSchema,
    /** The redemption this payment settles. */
    referralRedemptionId: cuidSchema,
    amountCents: rewardCentsSchema,
    currency: currencySchema,
    /**
     * Only the two referral reasons are payable here. Promotional credit and
     * corrections go through `rewardAdjustmentSchema`, which asks for a note.
     */
    reason: z
      .enum(['REFERRAL_REWARD', 'REFERRAL_SIGNUP_BONUS'], {
        error:
          'Please choose whether this is a referral reward or a welcome bonus.',
      })
      .default('REFERRAL_REWARD'),
    note: optionalProse(
      MAX_NOTE_LENGTH,
      'Please keep the note to 2,000 characters or fewer.'
    ),
  })
  .strict()
export type RewardPayoutInput = z.infer<typeof rewardPayoutSchema>
export type RewardPayoutRawInput = z.input<typeof rewardPayoutSchema>

/**
 * A hand-written movement on the ledger.
 *
 * Everything that is not a referral payout lands here: a gesture of goodwill, a
 * correction, credit spent against an invoice, an expiry sweep, a reversal.
 * Because the ledger is append-only, a mistake is corrected by writing the
 * opposite entry — which is exactly what this schema is for — and never by
 * editing what is already recorded.
 */
export const rewardAdjustmentSchema = z
  .object({
    /** Whose balance is moving. */
    userId: cuidSchema,
    direction: rewardLedgerDirectionSchema,
    amountCents: rewardCentsSchema,
    currency: currencySchema,
    reason: z.enum(
      [
        'PROMOTIONAL_GRANT',
        'MANUAL_ADJUSTMENT',
        'INVOICE_REDEMPTION',
        'EXPIRATION',
        'REVERSAL',
      ],
      { error: 'Please choose a reason for this adjustment.' }
    ),
    /** Required when credit is being spent against a bill. */
    invoiceId: cuidSchema.nullable().optional(),
    /** Set when the adjustment reverses or completes a referral. */
    referralRedemptionId: cuidSchema.nullable().optional(),
    /**
     * Never optional. Every hand-written movement on the ledger is explained to
     * whoever reads it next — including the guest, if they ask.
     */
    note: z
      .string({ error: 'Please record why this adjustment is being made.' })
      .trim()
      .min(4, { error: 'Please record why this adjustment is being made.' })
      .max(MAX_NOTE_LENGTH, {
        error: 'Please keep the note to 2,000 characters or fewer.',
      }),
  })
  .strict()
  .refine(
    (value) => value.reason !== 'INVOICE_REDEMPTION' || value.invoiceId != null,
    {
      error: 'Please say which invoice this credit was spent against.',
      path: ['invoiceId'],
    }
  )
  .refine(
    (value) =>
      value.reason !== 'INVOICE_REDEMPTION' || value.direction === 'DEBIT',
    {
      error:
        'Credit spent against an invoice leaves the balance — record it as a debit.',
      path: ['direction'],
    }
  )
  .refine(
    (value) => value.reason !== 'EXPIRATION' || value.direction === 'DEBIT',
    {
      error:
        'Credit that has expired leaves the balance — record it as a debit.',
      path: ['direction'],
    }
  )
  .refine(
    (value) =>
      value.reason !== 'PROMOTIONAL_GRANT' || value.direction === 'CREDIT',
    {
      error:
        'A gesture of goodwill adds to the balance — record it as a credit.',
      path: ['direction'],
    }
  )
  .refine(
    (value) =>
      value.reason !== 'REVERSAL' || value.referralRedemptionId != null,
    {
      error: 'Please say which redemption is being reversed.',
      path: ['referralRedemptionId'],
    }
  )
export type RewardAdjustmentInput = z.infer<typeof rewardAdjustmentSchema>
export type RewardAdjustmentRawInput = z.input<typeof rewardAdjustmentSchema>

/**
 * The effect an entry has on a balance: credits add, debits subtract.
 *
 * The ledger stores `amountCents` unsigned and carries the sign in `direction`,
 * so this is the one place the two are combined. The running total the action
 * writes to `balanceAfterCents` is built from it.
 */
export function signedLedgerAmountCents(entry: {
  direction: 'CREDIT' | 'DEBIT'
  amountCents: number
}): number {
  return entry.direction === 'CREDIT' ? entry.amountCents : -entry.amountCents
}

export const rewardLedgerFilterSchema = paginationSchema
  .extend({
    /** Server actions confirm the caller may read another person's ledger. */
    userId: cuidSchema.optional(),
    referralRedemptionId: cuidSchema.optional(),
    invoiceId: cuidSchema.optional(),
    directions: z
      .array(rewardLedgerDirectionSchema, {
        error: 'Please choose whether to show credits, debits, or both.',
      })
      .max(2, { error: 'There are only credits and debits to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That direction is already part of your search.',
      })
      .default([]),
    reasons: z
      .array(rewardLedgerReasonSchema, {
        error: 'Please choose the reasons to show.',
      })
      .max(7, { error: 'There are only seven reasons to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That reason is already part of your search.',
      })
      .default([]),
    /**
     * The same defect as `invoiceFilterSchema.minAmountDueCents`, found by the
     * MCV-005 sweep rather than reported: the ledger's amount filter is rendered
     * into the query string, comes back as `"2500"`, and `moneyCentsSchema` is
     * `z.int()`, which does not coerce. The bounds and the messages are
     * untouched — `withNumericCoercion` wraps the schema, it does not restate
     * it — and the `.optional()` sits inside so an empty `?minAmountCents=`
     * reads as "no filter".
     */
    minAmountCents: withNumericCoercion(moneyCentsSchema.optional()),
    maxAmountCents: withNumericCoercion(moneyCentsSchema.optional()),
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
  })
  .refine(
    ({ minAmountCents, maxAmountCents }) =>
      minAmountCents === undefined ||
      maxAmountCents === undefined ||
      minAmountCents <= maxAmountCents,
    {
      error: 'The lower amount must not exceed the higher one.',
      path: ['maxAmountCents'],
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
export type RewardLedgerFilterInput = z.infer<typeof rewardLedgerFilterSchema>
export type RewardLedgerFilterRawInput = z.input<
  typeof rewardLedgerFilterSchema
>
