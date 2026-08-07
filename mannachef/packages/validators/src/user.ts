// mannachef/packages/validators/src/user.ts

/**
 * Identity domain validation — the account itself, and the one field on it that
 * decides what its owner is allowed to do.
 *
 * Mirrors `User` in `mannachef/packages/db/prisma/schema.prisma`.
 *
 * ## Why this file exists (MCV-005)
 *
 * `mannachef/CONTRACT.md` §5 puts `Role` at the centre of the security model,
 * and `./enums` already ships `ROLE_HIERARCHY`, `ROLES_BY_PRIVILEGE`, `isRole`
 * and `hasRoleAtLeast` so that the web guards and the Expo client answer
 * "may they?" identically. What nothing did was validate the *change*: there
 * was no schema anywhere in this package for the one mutation that grants
 * somebody else the power to do everything, and no schema for the profile
 * fields a person edits about themselves.
 *
 * ## Rules that govern this file (see `mannachef/CONTRACT.md`)
 *
 *  1. No runtime dependency on `@prisma/client` — `Role` arrives from `./enums`.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *  3. `timeZoneSchema` is imported from `./booking` rather than restated —
 *     `User.timeZone` and `ChefAvailability.timeZone` are the same `VarChar(64)`
 *     IANA identifier, validated against the same `Intl` authority.
 *  4. There is **no** `userCreateSchema`. `User` rows are written by the Auth.js
 *     v5 Prisma adapter during sign-in, from an OAuth profile or a verified
 *     email — not by a form in this application. A create schema here would be
 *     a schema for a code path that does not exist, and the first person to
 *     find it would assume one did.
 *  5. `email`, `emailVerified`, `lastLoginAt` and `deactivatedAt` are not
 *     writable through these schemas. Email identity belongs to the adapter and
 *     its verification flow; changing it through a profile form would silently
 *     re-key the account. `deactivatedAt` is a *derived* stamp — see
 *     {@link userActivationSchema}, which is the schema that causes it to be
 *     written without accepting it from the caller.
 *  6. `userFilterSchema` is reachable over GET, so its bounds coerce. The
 *     profile update and the role assignment stay strict — they are request
 *     bodies, and a role arriving as something other than a `Role` is a bug in
 *     the caller rather than an artefact of the transport.
 *
 * ## `User.isActive` (MCV-010)
 *
 * The MCV-005 pass added the role assignment and the profile update and then
 * stopped, which left `User.isActive` in an odd position: read everywhere and
 * written nowhere. `sessionUserSchema` in `@mannachef/api-contract` publishes
 * it to every client, `userFilterSchema` below narrows by it through
 * `activeOnly`, `@@index([role, isActive])` exists to make that narrowing fast
 * — and no schema in this package would validate a change to it. It was not in
 * rule 4's or rule 5's exclusion list either, so the gap read as an oversight
 * rather than a decision, which is what it was.
 *
 * {@link userActivationSchema} closes it. Deactivation is the second of the two
 * admin-only mutations on an account, alongside the role change, and it is
 * treated the same way: a target, the new state, and a reason for the audit
 * trail that is required and required to say something.
 */

import { z } from 'zod'

import { timeZoneSchema } from './booking'
import {
  MAX_SEARCH_LENGTH,
  buildUpdateSchema,
  crossField,
  crossFieldMixed,
  cuidSchema,
  hasUniqueValues,
  isoDateTimeSchema,
  optionalProse,
  paginationSchema,
  phoneSchema,
  queryFlag,
  urlSchema,
  withTemporalCoercion,
} from './common'
import { ROLE_HIERARCHY, type Role, roleSchema } from './enums'

// =============================================================================
// Limits
// =============================================================================

/** Matches `User.name` — `@db.VarChar(200)`. */
export const MAX_USER_NAME_LENGTH = 200

/** Matches `User.locale` — `@db.VarChar(12)`. Room for `en-CA`, `fr-CA`, `zh-Hant`. */
export const MAX_LOCALE_LENGTH = 12

/** Where the whole platform reads until we publish a second language. */
export const DEFAULT_LOCALE = 'en-CA'

/**
 * An admin-only change to somebody's account is never recorded without an
 * explanation this long at least.
 *
 * There are two such changes — the role assignment and the activation toggle —
 * and they write the same kind of artefact to the same audit trail, so they
 * share one pair of bounds rather than each declaring their own. That is the
 * MCV-010 rule applied prospectively: the second copy is never written.
 */
export const MIN_ACCOUNT_AUDIT_REASON_LENGTH = 8

/** Generous ceiling for the audit-trail reason on an admin-only account change. */
export const MAX_ACCOUNT_AUDIT_REASON_LENGTH = 500

/**
 * The role-change spellings, kept because they are part of the published
 * surface of `@mannachef/validators` and removing an exported name is a
 * breaking change dressed up as a tidy-up. They are the same two numbers, by
 * construction rather than by coincidence.
 */
export const MIN_ROLE_CHANGE_REASON_LENGTH = MIN_ACCOUNT_AUDIT_REASON_LENGTH
export const MAX_ROLE_CHANGE_REASON_LENGTH = MAX_ACCOUNT_AUDIT_REASON_LENGTH

/** How many roles one query may narrow by — there are only four. */
const ROLE_COUNT = 4

// =============================================================================
// Field schemas
// =============================================================================

/**
 * True when the runtime recognises the tag as a well-formed BCP 47 locale.
 *
 * `Intl.getCanonicalLocales` throws a `RangeError` for anything structurally
 * invalid, which is a better authority than a regular expression — the same
 * reasoning `timeZoneSchema` applies to `Intl.DateTimeFormat` in `./booking`.
 *
 * It validates *shape*, not availability: `xx-YY` is a legal tag for a language
 * nobody speaks, and that is fine. We are storing a preference, not promising a
 * translation.
 */
function isWellFormedLocale(value: string): boolean {
  try {
    Intl.getCanonicalLocales(value)
    return true
  } catch {
    return false
  }
}

/**
 * A BCP 47 language tag. Trimmed; the case is left as the caller wrote it,
 * because `Intl` treats `en-ca` and `en-CA` as the same tag and rewriting a
 * person's stated preference to a canonical form is the sort of tidiness that
 * shows up in a diff nobody asked for.
 */
export const localeSchema = z
  .string({ error: 'Please choose a language.' })
  .trim()
  .min(2, { error: 'Please choose a language.' })
  .max(MAX_LOCALE_LENGTH, {
    error: 'That language tag is longer than our records allow.',
  })
  .refine(isWellFormedLocale, {
    error:
      'We do not recognise that language — please choose one such as en-CA.',
  })
  .default(DEFAULT_LOCALE)
export type Locale = z.infer<typeof localeSchema>

/**
 * The audit-trail reason attached to an admin-only account change.
 *
 * Required, trimmed, and required to say something: `MIN_ACCOUNT_AUDIT_REASON_LENGTH`
 * is checked *after* the trim, so eight spaces is not an explanation. Each call
 * site supplies its own copy because "why is this access level changing" and
 * "why is this account being closed" are different questions, and a shared
 * message would have to be vague enough to answer neither well.
 */
function accountAuditReasonSchema(messages: {
  readonly missing: string
  readonly tooShort: string
  readonly tooLong: string
}) {
  return z
    .string({ error: messages.missing })
    .trim()
    .min(MIN_ACCOUNT_AUDIT_REASON_LENGTH, { error: messages.tooShort })
    .max(MAX_ACCOUNT_AUDIT_REASON_LENGTH, { error: messages.tooLong })
}

// =============================================================================
// 1. The profile a person edits about themselves
// =============================================================================

/**
 * The five columns a person may change about their own account.
 *
 * Two of them carry a `.default(...)` — `timeZone` and `locale` — which is what
 * makes routing the update through `buildUpdateSchema` load-bearing rather than
 * ceremonial. A hand-rolled `.partial()` leaves both defaults in place beneath
 * the `ZodOptional`, so somebody in Vancouver correcting the spelling of their
 * own name would be moved to Toronto and switched to Canadian English by the
 * act of saving. See the worked example on `buildUpdateSchema` in `./common`.
 */
export const userProfileWritableShape = {
  /** `null` clears the display name and falls back to the email local part. */
  name: optionalProse(
    MAX_USER_NAME_LENGTH,
    'Please keep the name to 200 characters or fewer.'
  ),
  /** `null` removes the number entirely. */
  phone: phoneSchema.nullable().optional(),
  timeZone: timeZoneSchema,
  locale: localeSchema,
  /**
   * The avatar. `User.image` is `@db.Text` and is written by the OAuth provider
   * on first sign-in, so it must accept any absolute `http(s)` address rather
   * than only our own media host. `null` falls back to the generated monogram.
   */
  image: urlSchema.nullable().optional(),
} as const

/**
 * A person amending their own account, or an admin amending someone else's.
 *
 * `id` is the target account. The action resolves the session first and permits
 * the write only when the id is the caller's own or the caller is at least
 * `ADMIN` — the schema cannot know which, and must not be mistaken for the
 * check (`mannachef/CONTRACT.md` §5).
 *
 * `buildUpdateSchema` strips both defaults before the `.partial()`, restores
 * `id` as the single required key, applies `.strict()`, and refuses a bare
 * `{ id }` through `hasSomethingToSaveBeyond(1)`.
 */
export const userProfileUpdateSchema = buildUpdateSchema(
  userProfileWritableShape,
  { requireKeys: { id: cuidSchema } }
)
export type UserProfileUpdateInput = z.infer<typeof userProfileUpdateSchema>
export type UserProfileUpdateRawInput = z.input<typeof userProfileUpdateSchema>

// =============================================================================
// 2. Role assignment
// =============================================================================

/**
 * True when this payload is somebody handing themselves more power than they
 * already have.
 *
 * Both actor fields are optional on the wire, because the trustworthy source of
 * the actor's identity is the session, not the request body — an action that
 * has resolved a session should pass its own values rather than believe these.
 * When they *are* supplied the schema uses them, so the refusal happens at
 * validation time and the client can render it under the control:
 *
 *  - a different actor and target is somebody else's promotion, judged by
 *    {@link canAssignRole} inside the action;
 *  - the same actor and target at or below their current rank is a demotion or
 *    a no-op, and is allowed — stepping down is not an escalation;
 *  - the same actor and target *above* their current rank is the one case this
 *    predicate exists for.
 */
export function isSelfRoleEscalation(input: {
  readonly userId: string
  readonly role: Role
  readonly actorUserId?: string | undefined
  readonly actorRole?: Role | undefined
}): boolean {
  const { actorUserId, actorRole } = input

  if (actorUserId === undefined || actorRole === undefined) {
    return false
  }

  if (actorUserId !== input.userId) {
    return false
  }

  return ROLE_HIERARCHY[input.role] > ROLE_HIERARCHY[actorRole]
}

/**
 * True when an actor may grant a target role to somebody else.
 *
 * Two rules, both from `mannachef/CONTRACT.md` §5: only `ADMIN` and above may
 * assign roles at all, and nobody may grant a role above their own — an admin
 * cannot mint a super-admin, because that is a promotion of themselves by one
 * step of indirection.
 *
 * This is the check the *action* performs, using the role from the session. It
 * is not a refinement on the schema because the schema cannot be trusted with
 * the actor's role: a payload that simply omits `actorRole` would otherwise
 * pass every rule in this file.
 */
export function canAssignRole(
  actorRole: Role | null | undefined,
  targetRole: Role
): boolean {
  if (actorRole == null) {
    return false
  }

  if (ROLE_HIERARCHY[actorRole] < ROLE_HIERARCHY.ADMIN) {
    return false
  }

  return ROLE_HIERARCHY[targetRole] <= ROLE_HIERARCHY[actorRole]
}

/**
 * Changing what somebody is allowed to do.
 *
 * The three fields that matter are the target account, the new role, and the
 * reason — the last of which is required, and required to say something. A role
 * change is the single most consequential write in the application and the
 * audit trail is the only artefact that survives the person who made it.
 *
 * The refinement rejects self-escalation whenever the actor's own role is
 * supplied. The broader rule — nobody grants a role above their own, to anyone —
 * lives in {@link canAssignRole} and is enforced in the action against the
 * session, because a body that omits `actorRole` must not thereby escape it.
 */
export const roleAssignmentSchema = z
  .object({
    /** The account whose role is changing. */
    userId: cuidSchema,
    /** The role it is changing to. */
    role: roleSchema,
    /** Written to the audit trail verbatim. */
    reason: accountAuditReasonSchema({
      missing: 'Please record why this access level is changing.',
      tooShort:
        'Please record why this access level is changing — a few words at least.',
      tooLong: 'Please keep the reason to 500 characters or fewer.',
    }),
    /**
     * Who is making the change. Optional on the wire; the action prefers the
     * session and passes these only so the refusal can be rendered client-side.
     */
    actorUserId: cuidSchema.optional(),
    actorRole: roleSchema.optional(),
  })
  .strict()
  .check(
    // All four fields the predicate reads are declared dependencies, which
    // reproduces its own opening guard exactly: `isSelfRoleEscalation` returns
    // `false` — no escalation — the moment either actor field is absent, and a
    // declared dependency that is absent skips the check. What the guard adds
    // is the case the hand-written clause could not cover: an `actorRole` the
    // enum rejected now produces that one issue rather than being compared
    // against `ROLE_HIERARCHY` as though it were a role.
    crossFieldMixed(
      {
        deps: {
          userId: 'string',
          role: 'present',
          actorUserId: 'string',
          actorRole: 'present',
        },
        error:
          'You cannot raise your own access level — ask someone above you to make this change.',
        path: ['role'],
      },
      (value) => !isSelfRoleEscalation(value)
    )
  )
export type RoleAssignmentInput = z.infer<typeof roleAssignmentSchema>
export type RoleAssignmentRawInput = z.input<typeof roleAssignmentSchema>

// =============================================================================
// 3. Activation (MCV-010)
// =============================================================================

/**
 * True when this payload is somebody closing their own account.
 *
 * As with {@link isSelfRoleEscalation}, the actor is optional on the wire and
 * the trustworthy source is the session — an action that has resolved one
 * should pass its own id rather than believe this field. When it *is* supplied
 * the schema uses it, so the refusal renders under the control instead of
 * arriving as a server error after the click.
 *
 * Reactivating yourself is not this case and is not blocked: it is unreachable
 * anyway, because a deactivated account cannot hold a session to act with.
 */
export function isSelfDeactivation(input: {
  readonly userId: string
  readonly isActive: boolean
  readonly actorUserId?: string | undefined
}): boolean {
  if (input.actorUserId === undefined) {
    return false
  }

  return !input.isActive && input.actorUserId === input.userId
}

/**
 * Deactivating an account, or bringing one back.
 *
 * This is the schema `User.isActive` did not have. The column is read by
 * `sessionUserSchema` in `@mannachef/api-contract`, narrowed by `activeOnly`
 * below, and indexed by `@@index([role, isActive])`; until now nothing in this
 * package validated a write to it.
 *
 * ## Why it is not part of `userProfileUpdateSchema`
 *
 * Because it is not a profile field. Everything in
 * {@link userProfileWritableShape} is something a person may change about their
 * own account, and the action permits the write when the id is the caller's own
 * *or* the caller is at least `ADMIN`. Deactivation admits only the second
 * half of that rule, and folding it in would have widened a self-service form
 * into an account-closure control. Keeping it separate also keeps the reason
 * mandatory, which a `.partial()` update shape could not do.
 *
 * ## Why `isActive` carries no default
 *
 * A default here would decide the one thing the payload exists to state, and
 * would let `{ userId, reason }` parse into a deactivation nobody asked for.
 * The caller says which way the switch is moving. This is the same rule MCV-010
 * applied to `reverseLedgerEntry` in `./referral`.
 *
 * ## What the action does with it
 *
 * `deactivatedAt` is not accepted from the caller — rule 5 at the head of this
 * file. The action stamps it `now()` when `isActive` is `false` and clears it to
 * `null` when `isActive` is `true`, so the column can never disagree with the
 * flag. `reason` goes to the audit trail, not to a `User` column.
 *
 * The action still performs the checks a schema cannot: that the caller is at
 * least `ADMIN`, and — per `mannachef/CONTRACT.md` §5 — that they are not
 * closing an account ranked above their own, which is {@link canAssignRole}'s
 * rule read in the other direction.
 */
export const userActivationSchema = z
  .object({
    /** The account whose access is being withdrawn or restored. */
    userId: cuidSchema,
    /** `false` closes the account; `true` reopens it. Never defaulted. */
    isActive: z.boolean({
      error: 'Please say whether this account should be active.',
    }),
    /** Written to the audit trail verbatim. */
    reason: accountAuditReasonSchema({
      missing: 'Please record why this account is being closed or reopened.',
      tooShort:
        'Please record why this account is being closed or reopened — a few words at least.',
      tooLong: 'Please keep the reason to 500 characters or fewer.',
    }),
    /**
     * Who is making the change. Optional on the wire; the action prefers the
     * session and passes this only so the refusal can be rendered client-side.
     */
    actorUserId: cuidSchema.optional(),
  })
  .strict()
  .check(
    // Both fields the predicate reads beyond `isActive` are declared, so the
    // check is skipped entirely when `actorUserId` is absent — which reproduces
    // `isSelfDeactivation`'s own opening guard — and when either id failed
    // `cuidSchema`, which is the case a hand-written clause would have compared
    // as though it were an id.
    crossFieldMixed(
      {
        deps: {
          userId: 'string',
          isActive: 'boolean',
          actorUserId: 'string',
        },
        error:
          'You cannot close your own account — ask another administrator to do it.',
        path: ['userId'],
      },
      (value) => !isSelfDeactivation(value)
    )
  )
export type UserActivationInput = z.infer<typeof userActivationSchema>
export type UserActivationRawInput = z.input<typeof userActivationSchema>

// =============================================================================
// 4. Filtering
// =============================================================================

/** How the account list is ordered; direction comes from `sortDirection`. */
export const userSortBySchema = z
  .enum(['CREATED', 'UPDATED', 'NAME', 'EMAIL', 'LAST_LOGIN', 'ROLE'], {
    error: 'Please choose how the accounts should be ordered.',
  })
  .default('CREATED')
export type UserSortBy = z.infer<typeof userSortBySchema>

/**
 * The admin account list.
 *
 * Reachable over GET, so both date windows go through `withTemporalCoercion`
 * and both booleans through `queryFlag`. There are no numeric bounds to coerce
 * beyond the ones `paginationSchema` already handles.
 *
 * `activeOnly` defaults to `true`: a deactivated account is a tombstone, and an
 * administrator looking at "the people who work here" should not have to filter
 * out everyone who ever left.
 */
export const userFilterSchema = paginationSchema
  .extend({
    /** Matches the name and the email address. */
    search: z
      .string({ error: 'Please type something to search the accounts for.' })
      .trim()
      .max(MAX_SEARCH_LENGTH, {
        error: 'Please shorten your search to 120 characters or fewer.',
      })
      .transform((value) => (value.length > 0 ? value : undefined))
      .optional(),
    roles: z
      .array(roleSchema, { error: 'Please choose the access levels to show.' })
      .max(ROLE_COUNT, {
        error: 'There are only four access levels to choose from.',
      })
      .refine(hasUniqueValues, {
        error: 'That access level is already part of your search.',
      })
      .default([]),
    activeOnly: queryFlag(
      true,
      'Please say whether to show only accounts that are still active.'
    ),
    /** Narrows to accounts that have never signed in. */
    neverSignedInOnly: queryFlag(
      false,
      'Please say whether to show only accounts that have never signed in.'
    ),
    /** Narrows to accounts whose email address has been verified. */
    verifiedEmailOnly: queryFlag(
      false,
      'Please say whether to show only accounts with a verified email address.'
    ),
    createdFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    createdTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    lastLoginFrom: withTemporalCoercion(isoDateTimeSchema.optional()),
    lastLoginTo: withTemporalCoercion(isoDateTimeSchema.optional()),
    sortBy: userSortBySchema,
  })
  .check(
    // Both date windows are the crash site: every bound is
    // `withTemporalCoercion(isoDateTimeSchema.optional())`, a `z.ZodPipe`,
    // whose failure does not abort the object's checks, so `?createdFrom=foo`
    // reached `.getTime()` on the raw string. The third rule keeps reading the
    // two sign-in bounds from the raw object, because what it asks of them is
    // whether they were supplied at all — a malformed bound was supplied, and
    // still contradicts `neverSignedInOnly`.
    crossField(
      {
        deps: ['createdFrom', 'createdTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['createdTo'],
      },
      ({ createdFrom, createdTo }) =>
        createdFrom.getTime() <= createdTo.getTime()
    ),
    crossField(
      {
        deps: ['lastLoginFrom', 'lastLoginTo'],
        as: 'date',
        error: 'The earlier date must fall on or before the later one.',
        path: ['lastLoginTo'],
      },
      ({ lastLoginFrom, lastLoginTo }) =>
        lastLoginFrom.getTime() <= lastLoginTo.getTime()
    ),
    crossField(
      {
        deps: ['neverSignedInOnly'],
        as: 'boolean',
        error:
          'An account that has never signed in has no sign-in date to narrow by.',
        path: ['neverSignedInOnly'],
      },
      ({ neverSignedInOnly }, raw) =>
        !neverSignedInOnly ||
        (raw.lastLoginFrom === undefined && raw.lastLoginTo === undefined)
    )
  )
export type UserFilterInput = z.infer<typeof userFilterSchema>
export type UserFilterRawInput = z.input<typeof userFilterSchema>
