// mannachef/packages/validators/src/referral.ts

/**
 * Growth domain validation — invitation codes, their redemptions, and the
 * append-only reward ledger that sits behind a subscriber's credit balance.
 *
 * Mirrors `ReferralProgram`, `ReferralCode`, `ReferralRedemption`,
 * `RewardBalance` and `RewardLedgerEntry` in
 * `mannachef/packages/db/prisma/schema.prisma`.
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
 *     cannot carry a percentage. The database allows both to be null on
 *     `ReferralCode`; this layer is where that pairing is actually enforced.
 *     `ReferralProgram` is the exception — it is new enough to carry a
 *     `CHECK` for it as well, in the `0001_referral_program` migration.
 *  4. `redemptionCount`, `balanceAfterCents` and `balanceId` are computed inside
 *     the transaction that writes them and are never accepted from a caller.
 *     `ReferralProgram` extends that list to the *reward figures themselves*
 *     for anybody below `ADMIN`: what a client-minted code is worth is read
 *     from the standing programme rather than from the payload (MCV-030), so
 *     the schemas here describe what an administrator may state, not what a
 *     subscriber may choose.
 *  5. `referral.codes` is a `GET` route in `@mannachef/api-contract`, and the
 *     redemption and ledger lists are read the same way, so every numeric and
 *     temporal bound in an `xFilterSchema` goes through the coercion helpers in
 *     `./common`. The create, update, redemption and ledger-write schemas stay
 *     strict: a string where a number belongs in a request body is a bug in the
 *     caller rather than an artefact of the transport.
 */

import { z } from 'zod'

import {
  MAX_NOTE_LENGTH,
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  crossField,
  crossFieldMixed,
  cuidSchema,
  currencySchema,
  hasUniqueValues,
  intSchema,
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

/**
 * `MAX_NOTE_LENGTH` was declared here as a local shadow of the constant
 * `booking.ts` exported under the same name and with the same value. MCV-010
 * moved the one declaration to `./common`; the import at the head of this file
 * is that declaration, so the shadow is gone rather than merely renamed.
 */

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

/**
 * The expiry rule, shared by the four create branches and the update schema.
 *
 * Attached with `.check(crossField(...))` rather than `.refine(...)` because
 * `expiresAt` is an `isoDateTimeSchema`, which is a `z.ZodPipe`: a field of that
 * kind failing does **not** abort the object's own checks, so the plain
 * refinement this replaced reached `isInTheFuture('foo')` and threw a
 * `TypeError` out of `safeParse`. The guard makes the check total — an
 * `expiresAt` that is absent, `null`, or not a valid `Date` skips it, exactly as
 * the old `value.expiresAt == null ||` clause intended for the first two cases
 * and failed to cover for the third. See the cross-field section of `./common`.
 */
const EXPIRY_AHEAD_CONFIG = {
  deps: ['expiresAt'],
  as: 'date',
  error: EXPIRY_IN_PAST_MESSAGE,
  path: ['expiresAt'],
} as const

/** The predicate half of {@link EXPIRY_AHEAD_CONFIG}. Never sees a non-`Date`. */
function expiryIsAhead(value: { expiresAt: Date }): boolean {
  return isInTheFuture(value.expiresAt)
}

/**
 * The `createdFrom` / `createdTo` window, shared by all three filter schemas in
 * this file.
 *
 * Same reasoning as {@link EXPIRY_AHEAD_CONFIG}: both bounds are
 * `withTemporalCoercion(isoDateTimeSchema.optional())`, so a `?createdFrom=foo`
 * in a query string leaves the raw string on the object while the object's own
 * checks still run. The `=== undefined ||` chain this replaced guarded against
 * an *absent* bound and not against a *malformed* one, and
 * `referralCodeFilterSchema.safeParse({ createdFrom: 'foo', createdTo: 'bar' })`
 * threw rather than returning `{ success: false }`.
 */
const CREATED_WINDOW_CONFIG = {
  deps: ['createdFrom', 'createdTo'],
  as: 'date',
  error: 'The earlier date must fall on or before the later one.',
  path: ['createdTo'],
} as const

/** The predicate half of {@link CREATED_WINDOW_CONFIG}. */
function createdWindowIsOrdered(value: {
  createdFrom: Date
  createdTo: Date
}): boolean {
  return value.createdFrom.getTime() <= value.createdTo.getTime()
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
      .check(crossField(EXPIRY_AHEAD_CONFIG, (value) => expiryIsAhead(value))),
    z
      .object({
        rewardType: z.literal('PERCENT_DISCOUNT'),
        /** Whole percent off the next invoice, 1–100. */
        rewardValuePercent: rewardPercentSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .check(crossField(EXPIRY_AHEAD_CONFIG, (value) => expiryIsAhead(value))),
    z
      .object({
        rewardType: z.literal('FREE_MEAL'),
        /** What the complimentary meal is worth, so the ledger balances. */
        rewardValueCents: rewardCentsSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .check(crossField(EXPIRY_AHEAD_CONFIG, (value) => expiryIsAhead(value))),
    z
      .object({
        rewardType: z.literal('FREE_DELIVERY'),
        /** What the waived delivery is worth, so the ledger balances. */
        rewardValueCents: rewardCentsSchema,
        ...referralCodeCommonShape,
      })
      .strict()
      .check(crossField(EXPIRY_AHEAD_CONFIG, (value) => expiryIsAhead(value))),
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
 *
 * ## The two checks that follow
 *
 * The expiry rule is {@link EXPIRY_AHEAD_CONFIG}, attached with `.check()` so a
 * malformed `expiresAt` skips it rather than throwing out of `safeParse`.
 *
 * The pairing rule stays a `superRefine`, and deliberately so: it raises up to
 * two issues at two different paths, which no single-message cross-field check
 * can express. It is safe as written — every field it touches is compared, none
 * is dereferenced — and zod's default abort already keeps it from running when
 * `rewardType`, `rewardValueCents` or `rewardValuePercent` failed its own
 * parse.
 */
export const referralCodeUpdateSchema = buildUpdateSchema(
  referralCodeUpdatableShape,
  { requireKeys: { id: cuidSchema } }
)
  .check(crossField(EXPIRY_AHEAD_CONFIG, (value) => expiryIsAhead(value)))
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
  .check(
    crossField(CREATED_WINDOW_CONFIG, (value) => createdWindowIsOrdered(value))
  )
export type ReferralCodeFilterInput = z.infer<typeof referralCodeFilterSchema>
export type ReferralCodeFilterRawInput = z.input<
  typeof referralCodeFilterSchema
>

// =============================================================================
// 2. The standing programme
// =============================================================================

/**
 * The singleton discriminator on `ReferralProgram.key`.
 *
 * There is one standing offer, and this is the row that holds it. The column
 * exists rather than the table simply being constrained to a single row because
 * `@unique` on a named key is an invariant Postgres enforces, whereas "only
 * ever insert one row" is a habit — and this is the row every client-minted
 * invitation copies its money from.
 */
export const REFERRAL_PROGRAM_KEY = 'default'

/** Matches `ReferralProgram.key` — `@db.VarChar(40)`. */
const MAX_PROGRAM_KEY_LENGTH = 40

/**
 * Ten years, in days — the ceiling on `ReferralProgram.defaultExpiryDays`.
 *
 * Not a business rule so much as a guard against a fat-fingered figure that is
 * indistinguishable from "never expires"; leaving the field `null` is how an
 * open-ended offer is actually expressed.
 */
export const MAX_PROGRAM_EXPIRY_DAYS = 3_650

/**
 * Which programme is being addressed.
 *
 * Lower-cased on the way in so `Default` and `default` are the same row rather
 * than two, and defaulted to {@link REFERRAL_PROGRAM_KEY} so every present-day
 * caller — all of which want the singleton — can omit it entirely.
 */
export const referralProgramKeySchema = z
  .string({ error: 'Please say which referral programme you mean.' })
  .trim()
  .toLowerCase()
  .min(1, { error: 'Please say which referral programme you mean.' })
  .max(MAX_PROGRAM_KEY_LENGTH, {
    error: 'Please keep the programme key to 40 characters or fewer.',
  })
  .default(REFERRAL_PROGRAM_KEY)
export type ReferralProgramKey = z.infer<typeof referralProgramKeySchema>

/** Reading the standing offer. */
export const referralProgramReadSchema = z
  .object({ key: referralProgramKeySchema })
  .strict()
export type ReferralProgramReadInput = z.infer<typeof referralProgramReadSchema>
export type ReferralProgramReadRawInput = z.input<
  typeof referralProgramReadSchema
>

/**
 * The terms every standing offer carries, whatever it rewards.
 *
 * `defaultMaxRedemptions` reuses `referralCodeCommonShape.maxRedemptions`
 * rather than restating its bounds, because a programme code's cap and a
 * hand-issued code's cap are the same quantity with the same ceiling: one
 * definition, one wording, no drift.
 */
const referralProgramCommonShape = {
  key: referralProgramKeySchema,
  currency: currencySchema,
  /** What the invited guest receives, when the offer rewards them too. */
  refereeRewardCents: rewardCentsSchema.nullable().optional(),
  /** The cap a programme code carries. `null` leaves them open-ended. */
  defaultMaxRedemptions: referralCodeCommonShape.maxRedemptions,
  /**
   * How long a programme code stays redeemable, in days from the moment it is
   * minted. `null` leaves it open until the code is withdrawn.
   */
  defaultExpiryDays: intSchema(1, MAX_PROGRAM_EXPIRY_DAYS, {
    notAnInteger: 'Please give the expiry as a whole number of days.',
    tooSmall: 'A code that expires the moment it is minted is no code at all.',
    tooLarge: 'Beyond ten years, please leave the offer open-ended instead.',
  })
    .nullable()
    .optional(),
  /**
   * The floor a referred household's first paid invoice has to clear before the
   * referral is earned. `0` means any paid invoice qualifies.
   *
   * ## Required, not defaulted
   *
   * Same reasoning as `reverseLedgerEntry` on the revocation branch below: `0`
   * is the *permissive* reading, and a default that silently picks the
   * permissive branch is a default that is doing the deciding. Without a floor,
   * a one-dollar invoice earns a full referral reward, which is the second half
   * of the abuse MCV-030 closed. Whoever sets the offer says what the floor is.
   */
  minimumQualifyingInvoiceCents: moneyCentsSchema.max(MAX_REWARD_CENTS, {
    error:
      'A qualifying invoice tops out at $10,000. Please arrange larger thresholds by hand.',
  }),
  /**
   * Whether the offer is being made at all.
   *
   * Required for the same reason, and it is the more consequential of the two:
   * `true` is what lets an ordinary subscriber mint a code that will eventually
   * cost the business money. `referralCodeCommonShape.isActive` defaults to
   * `true` because withdrawing one code is cheap; switching the whole programme
   * on is not the sort of thing a missing key should decide.
   */
  isActive: z.boolean({
    error: 'Please say whether this offer is being made.',
  }),
} as const

/**
 * Setting the standing offer.
 *
 * A discriminated union over `rewardType`, exactly as
 * {@link referralCodeCreateSchema} is and for the same reason: the reward and
 * its measure travel together, so a percentage programme cannot carry a cash
 * value and a credit programme cannot carry a percentage. The database says the
 * same thing — `ReferralProgram_reward_pairing_check`, added in the
 * `0001_referral_program` migration — because this is the row a code minted by
 * somebody who is not an administrator copies its figures from.
 *
 * ## Why "upsert" rather than `buildUpdateSchema`
 *
 * This is not a patch. The programme is a singleton whose every field is stated
 * together on one admin form, and a partial update of a discriminated reward
 * triple is precisely the shape `referralCodeUpdateSchema` needs a `superRefine`
 * to police. Writing the whole offer at once means the coherence rule is the
 * union's, enforced at the boundary, and the action can write the row without
 * merging anything against what is already there.
 */
export const referralProgramUpsertSchema = z.discriminatedUnion(
  'rewardType',
  [
    z
      .object({
        rewardType: z.literal('FIXED_CREDIT'),
        /** Credit added to the inviter's balance once the referral qualifies. */
        rewardValueCents: rewardCentsSchema,
        ...referralProgramCommonShape,
      })
      .strict(),
    z
      .object({
        rewardType: z.literal('PERCENT_DISCOUNT'),
        /** Whole percent of the qualifying invoice, 1–100. */
        rewardValuePercent: rewardPercentSchema,
        ...referralProgramCommonShape,
      })
      .strict(),
    z
      .object({
        rewardType: z.literal('FREE_MEAL'),
        /** What the complimentary meal is worth, so the ledger balances. */
        rewardValueCents: rewardCentsSchema,
        ...referralProgramCommonShape,
      })
      .strict(),
    z
      .object({
        rewardType: z.literal('FREE_DELIVERY'),
        /** What the waived delivery is worth, so the ledger balances. */
        rewardValueCents: rewardCentsSchema,
        ...referralProgramCommonShape,
      })
      .strict(),
  ],
  { error: 'Please choose the reward this programme should grant.' }
)
export type ReferralProgramUpsertInput = z.infer<
  typeof referralProgramUpsertSchema
>
export type ReferralProgramUpsertRawInput = z.input<
  typeof referralProgramUpsertSchema
>

// =============================================================================
// 3. Redemption
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
      .check(
        crossField(
          {
            deps: ['qualifiedAt'],
            as: 'date',
            error:
              'A qualification cannot be recorded for a moment still to come.',
            path: ['qualifiedAt'],
          },
          ({ qualifiedAt }) => isNotInTheFuture(qualifiedAt)
        )
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
      .check(
        crossField(
          {
            deps: ['rewardedAt'],
            as: 'date',
            error: 'A reward cannot be recorded for a moment still to come.',
            path: ['rewardedAt'],
          },
          ({ rewardedAt }) => isNotInTheFuture(rewardedAt)
        )
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
         *
         * ## Required, not defaulted (MCV-010)
         *
         * This carried `.default(true)`. That was the last default injection in
         * the package: a four-key `{ action, redemptionId, revokedReason }`
         * payload parsed to five keys, and the fifth was one the caller never
         * wrote.
         *
         * It was the *mildest* instance, and the reason is worth recording so
         * nobody re-adds the default thinking it was harmless. This is a command
         * union rather than an `{ id, patch }` update schema, and
         * `reverseLedgerEntry` is not a column on `ReferralRedemption` — it is
         * an instruction to the action about whether to write a *second* row, in
         * `RewardLedgerEntry`. A fabricated value therefore could not reach
         * `prisma.update` as a phantom field write, which is what made the same
         * pattern dangerous everywhere else it was found.
         *
         * It is required anyway, because "harmless" is the wrong bar for this
         * particular flag. `true` means claw back credit the guest has already
         * been paid, which is the more destructive of the two readings and the
         * one that touches money. A default that silently picks the destructive
         * branch is a default that is doing the deciding, and the deciding
         * belongs to the administrator filling in the revocation form — who is
         * already being made to type a reason for exactly this sort of reason.
         *
         * Making it required is also a change zod enforces at the boundary
         * rather than a convention: an existing caller that omitted the key now
         * fails to parse with the message below, instead of quietly getting the
         * behaviour it used to get by accident. The admin UI renders it as a
         * checkbox that starts checked — a *presentation* default, which is
         * where a default of this kind belongs.
         */
        reverseLedgerEntry: z.boolean({
          error:
            'Please say whether the credit already paid should be taken back.',
        }),
      })
      .strict()
      .check(
        crossField(
          {
            deps: ['revokedAt'],
            as: 'date',
            error:
              'A withdrawal cannot be recorded for a moment still to come.',
            path: ['revokedAt'],
          },
          ({ revokedAt }) => isNotInTheFuture(revokedAt)
        )
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
  .check(
    crossField(CREATED_WINDOW_CONFIG, (value) => createdWindowIsOrdered(value))
  )
export type ReferralRedemptionFilterInput = z.infer<
  typeof referralRedemptionFilterSchema
>
export type ReferralRedemptionFilterRawInput = z.input<
  typeof referralRedemptionFilterSchema
>

// =============================================================================
// 4. The reward ledger
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
  .check(
    // Five rules, all keyed on `reason`, so all five declare it as a
    // dependency: a `reason` the enum rejected produces its own precise issue
    // and must not also produce four contradictory ones about the direction.
    // `invoiceId` and `referralRedemptionId` are read from the raw object
    // rather than declared, because their *absence* is the thing being caught
    // and a declared dependency that is absent skips the check.
    crossFieldMixed(
      {
        deps: { reason: 'present' },
        error: 'Please say which invoice this credit was spent against.',
        path: ['invoiceId'],
      },
      ({ reason }, raw) =>
        reason !== 'INVOICE_REDEMPTION' || raw.invoiceId != null
    ),
    crossFieldMixed(
      {
        deps: { reason: 'present', direction: 'present' },
        error:
          'Credit spent against an invoice leaves the balance — record it as a debit.',
        path: ['direction'],
      },
      ({ reason, direction }) =>
        reason !== 'INVOICE_REDEMPTION' || direction === 'DEBIT'
    ),
    crossFieldMixed(
      {
        deps: { reason: 'present', direction: 'present' },
        error:
          'Credit that has expired leaves the balance — record it as a debit.',
        path: ['direction'],
      },
      ({ reason, direction }) =>
        reason !== 'EXPIRATION' || direction === 'DEBIT'
    ),
    crossFieldMixed(
      {
        deps: { reason: 'present', direction: 'present' },
        error:
          'A gesture of goodwill adds to the balance — record it as a credit.',
        path: ['direction'],
      },
      ({ reason, direction }) =>
        reason !== 'PROMOTIONAL_GRANT' || direction === 'CREDIT'
    ),
    crossFieldMixed(
      {
        deps: { reason: 'present' },
        error: 'Please say which redemption is being reversed.',
        path: ['referralRedemptionId'],
      },
      ({ reason }, raw) =>
        reason !== 'REVERSAL' || raw.referralRedemptionId != null
    )
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
  .check(
    crossField(
      {
        deps: ['minAmountCents', 'maxAmountCents'],
        as: 'number',
        error: 'The lower amount must not exceed the higher one.',
        path: ['maxAmountCents'],
      },
      ({ minAmountCents, maxAmountCents }) => minAmountCents <= maxAmountCents
    )
  )
  .check(
    crossField(CREATED_WINDOW_CONFIG, (value) => createdWindowIsOrdered(value))
  )
export type RewardLedgerFilterInput = z.infer<typeof rewardLedgerFilterSchema>
export type RewardLedgerFilterRawInput = z.input<
  typeof rewardLedgerFilterSchema
>
