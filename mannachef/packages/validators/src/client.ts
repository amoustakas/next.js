// mannachef/packages/validators/src/client.ts

/**
 * Client profile validation — the household's own record: what to call them,
 * how to reach them, how they found us, and what the chef needs to remember
 * before walking through the door.
 *
 * Mirrors `ClientProfile` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * ## Why this file exists, and what it deliberately does not cover (MCV-005)
 *
 * `ClientProfile` is written by five different places and had no create or
 * update schema anywhere. The seven columns below are the ones a person edits:
 * `displayName`, `preferredName`, `phone`, `source`, `sourceDetail`,
 * `preferredContactMethod` and `vipNotes`.
 *
 * **Status transitions live in `./crm`, not here.** `ClientProfile.status` is
 * governed by `clientStatusTransitionSchema`, `CLIENT_STATUS_TRANSITIONS`,
 * `allowedClientStatusTransitions` and `canTransitionClientStatus` in that
 * module, which encode the legal moves through the lifecycle
 * (`PROSPECT → LEAD_QUALIFIED → ACTIVE_SUBSCRIBER → PAUSED → CHURNED`) together
 * with the reason and the churn bookkeeping each move requires. Accepting
 * `status` on a general-purpose update schema would route every one of those
 * moves around that check, so `status` is absent from
 * {@link clientProfileUpdateSchema} on purpose. It appears on
 * {@link clientProfileCreateSchema} only as the fixed opening position, which
 * is the one value it may take before there is anything to transition from.
 *
 * The rest of the table is owned elsewhere too, and for the same reason:
 *
 *  - `lastContactedAt`, `followUpAt` — `clientFollowUpSchema` in `./crm`.
 *  - `churnedAt`, `churnReason` — written by the status transition in `./crm`.
 *  - `lifetimeValueCents`, `currency` — derived from `./billing`; a figure that
 *    is the sum of other rows is never typed into a form.
 *  - `userId` — set once, at creation, and never re-parented.
 *  - The roster filter is `clientPipelineFilterSchema`, in `./crm`. There is no
 *    second one here; two filters over one table is how they drift.
 *
 * ## Rules that govern this file (see `mannachef/CONTRACT.md`)
 *
 *  1. No runtime dependency on `@prisma/client` — enums arrive from `./enums`.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *  3. Both schemas are request bodies and stay strict.
 */

import { z } from 'zod'

import {
  buildUpdateSchema,
  cuidSchema,
  optionalProse,
  phoneSchema,
} from './common'
import {
  type ClientSource,
  clientSourceSchema,
  contactMethodSchema,
} from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Matches `ClientProfile.displayName` — `@db.VarChar(200)`. */
export const MAX_CLIENT_DISPLAY_NAME_LENGTH = 200

/** Matches `ClientProfile.preferredName` — `@db.VarChar(120)`. */
export const MAX_PREFERRED_NAME_LENGTH = 120

/** Matches `ClientProfile.sourceDetail` — `@db.VarChar(200)`. */
export const MAX_CLIENT_SOURCE_DETAIL_LENGTH = 200

/** Generous ceiling for the `@db.Text` standing notes on a household. */
export const MAX_VIP_NOTES_LENGTH = 5_000

/**
 * The sources that mean nothing on their own.
 *
 * `OTHER` is the whole point of the list: a household recorded as having found
 * us by "other" and nothing else is a lead-source report with a hole in it.
 * `REFERRAL` and `PARTNER` are here because the detail is the referrer's name,
 * which is the only thing that makes a referral actionable.
 */
export const CLIENT_SOURCES_REQUIRING_DETAIL: readonly ClientSource[] = [
  'REFERRAL',
  'PARTNER',
  'OTHER',
]

/** True when this source is one that must be qualified by a detail. */
export function clientSourceRequiresDetail(source: ClientSource): boolean {
  return CLIENT_SOURCES_REQUIRING_DETAIL.includes(source)
}

// =============================================================================
// Field schemas
// =============================================================================

/**
 * How the household appears in the OS — usually a surname and an honorific,
 * "The Okonkwo Household". `null` falls back to the account's own name.
 */
export const clientDisplayNameSchema = optionalProse(
  MAX_CLIENT_DISPLAY_NAME_LENGTH,
  'Please keep the household name to 200 characters or fewer.'
)

/**
 * What the chef actually calls them at the door. Distinct from `displayName`
 * because "Mrs Okonkwo" belongs on an invoice and "Ada" belongs in the kitchen.
 */
export const preferredNameSchema = optionalProse(
  MAX_PREFERRED_NAME_LENGTH,
  'Please keep the preferred name to 120 characters or fewer.'
)

/** Who referred them, which event we met them at, what "other" meant. */
export const clientSourceDetailSchema = optionalProse(
  MAX_CLIENT_SOURCE_DETAIL_LENGTH,
  'Please keep the source detail to 200 characters or fewer.'
)

/**
 * Standing notes the chef reads before every engagement — the dog that must be
 * shut in, the anniversary, the father-in-law who does not eat fish.
 *
 * Staff-facing, never rendered to the household. `null` clears it.
 */
export const vipNotesSchema = optionalProse(
  MAX_VIP_NOTES_LENGTH,
  'Please keep the notes to 5,000 characters or fewer.'
)

// =============================================================================
// Create & update
// =============================================================================

/**
 * The seven columns a person edits on a household's record.
 *
 * Two carry a `.default(...)` — `source` and `preferredContactMethod` — which
 * is what makes the builder below load-bearing. A hand-rolled `.partial()`
 * leaves both defaults live: adding a line to `vipNotes` on a household we won
 * through a partner would re-record them as `DIRECT`, and a household that asks
 * to be phoned would quietly go back to email. Both are silent, both survive
 * the code review, and both show up months later as a lead-source report that
 * says everybody found us on their own.
 */
export const clientProfileWritableShape = {
  displayName: clientDisplayNameSchema,
  preferredName: preferredNameSchema,
  /** `null` removes the number. The account's own `phone` is separate. */
  phone: phoneSchema.nullable().optional(),
  source: clientSourceSchema.default('DIRECT'),
  sourceDetail: clientSourceDetailSchema,
  preferredContactMethod: contactMethodSchema.default('EMAIL'),
  vipNotes: vipNotesSchema,
} as const

/**
 * Opening a household's record.
 *
 * `userId` is `@unique` on the table and appears only here: a profile is
 * attached to its account once, because every consultation, appointment, note
 * and interaction already hanging off it would otherwise change hands. The
 * action re-checks that the account exists and has no profile already
 * (`mannachef/CONTRACT.md` §5).
 *
 * `status` is not accepted. A new household is a `PROSPECT` — that is the
 * column default in Prisma and the opening position of the lifecycle in
 * `./crm`. Everything after it is a transition, and transitions are validated
 * by `clientStatusTransitionSchema`, which needs to know where the household
 * was standing.
 */
export const clientProfileCreateSchema = z
  .object({
    userId: cuidSchema,
    ...clientProfileWritableShape,
  })
  .strict()
  .refine(
    (value) =>
      !clientSourceRequiresDetail(value.source) || value.sourceDetail != null,
    {
      error:
        'Please say a little more — who referred them, which partner, or what "other" means.',
      path: ['sourceDetail'],
    }
  )
export type ClientProfileCreateInput = z.infer<typeof clientProfileCreateSchema>
export type ClientProfileCreateRawInput = z.input<
  typeof clientProfileCreateSchema
>

/**
 * Amending a household's record.
 *
 * Built by `buildUpdateSchema`, which strips both `.default(...)`s before the
 * `.partial()`, restores `id` as the single required key, applies `.strict()`,
 * and refuses a bare `{ id }` through `hasSomethingToSaveBeyond(1)`.
 *
 * The create schema's source-detail rule is not repeated here, and cannot be: a
 * partial payload that changes only `sourceDetail` has no `source` to judge it
 * against, and one that changes only `source` has no detail to look at. The
 * action re-reads the row and applies {@link clientSourceRequiresDetail} to the
 * merged result, which is the only place both halves are known.
 */
export const clientProfileUpdateSchema = buildUpdateSchema(
  clientProfileWritableShape,
  { requireKeys: { id: cuidSchema } }
)
export type ClientProfileUpdateInput = z.infer<typeof clientProfileUpdateSchema>
export type ClientProfileUpdateRawInput = z.input<
  typeof clientProfileUpdateSchema
>
