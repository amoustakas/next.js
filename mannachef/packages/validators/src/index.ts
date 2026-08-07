// mannachef/packages/validators/src/index.ts

/**
 * Public surface of `@mannachef/validators`.
 *
 * Every domain module in this directory is re-exported from here so that the
 * marketing site, the client portal, the admin OS, the API contract, and the
 * Expo client all import validation from a single specifier:
 *
 * ```ts
 * import { menuItemFilterSchema, type MenuItemFilterInput } from '@mannachef/validators'
 * ```
 *
 * ## The fifteen modules
 *
 * `common` and `enums` hold the shared vocabulary; the other thirteen are one
 * domain each. `staff`, `user`, `payment`, `onboarding` and `client` joined in
 * MCV-005, when the audit found five Prisma tables being written to with no
 * schema in front of them at all.
 *
 * ## Collision policy
 *
 * The export sets of all fifteen modules were enumerated with the TypeScript
 * compiler API (`checker.getExportsOfModule`) rather than by reading them, and
 * diffed for duplicate names. Across the 794 module-level exports counted at
 * the time of writing there is exactly **one** collision, and it is a genuine
 * difference of meaning rather than an accident: `intake.ts` and `referral.ts`
 * both declare `MAX_REFERRAL_CODE_LENGTH`.
 *
 * The figure is a measurement, not a promise — it moves whenever a module gains
 * a declaration. What must not move is the *count of collisions*, and that is
 * not left to the comment: two `export *` declarations publishing one name make
 * it ambiguous, so the compiler reports it (see "How the collision is resolved"
 * below) rather than picking a winner.
 *
 *  - `referral.ts` → `12`. The longest code `generateReferralCode` will mint,
 *    and the ceiling `referralCodeSchema` enforces. This is the referral
 *    domain's own rule, so it keeps the unqualified name.
 *  - `intake.ts` → `40`. The width of the `ReferralCode.code` column
 *    (`@db.VarChar(40)`), used to bound the free-text "how did you hear about
 *    us" field on the prospect-conversion form, which must tolerate a code
 *    typed from memory rather than one we generated. It is re-exported as
 *    `MAX_INTAKE_REFERRAL_CODE_LENGTH`.
 *
 * ## How the collision is resolved
 *
 * A name exported by two `export *` declarations is *ambiguous*: ECMAScript
 * makes it inaccessible through the re-exporting module rather than picking a
 * winner. TypeScript refuses to guess either, and reports `TS2308: Module
 * './intake' has already exported a member named 'MAX_REFERRAL_CODE_LENGTH'.
 * Consider explicitly re-exporting to resolve the ambiguity.` Deleting the
 * *plain* re-export below therefore fails the build rather than quietly
 * changing which constant callers receive.
 *
 * An **explicit** re-export outranks a star re-export. `ResolveExport` consults
 * the module's own export entries before it walks `export *`, so the two named
 * declarations at the bottom of this file settle the ambiguity in both
 * directions: the plain name resolves to referral's `12`, and intake's `40`
 * arrives under its qualified alias.
 *
 * The *alias* has no such natural protection, and this is the direction that
 * used to be unguarded. Deleting `MAX_INTAKE_REFERRAL_CODE_LENGTH` does not
 * reintroduce an ambiguity — it simply removes a name — so the barrel went on
 * compiling perfectly while the constant disappeared from the public surface,
 * and the only symptom was a "has no exported member" at some unrelated call
 * site. The earlier guard did not catch it because it asserted on
 * `IntakeModule.MAX_REFERRAL_CODE_LENGTH`, which is the *source module's*
 * constant and stays `40` whether or not this file re-exports it.
 *
 * The assertions at the foot of this file therefore read the barrel's own
 * export surface through a self-referential `import type * as Barrel from
 * './index'`. That is what makes them load-bearing in both directions: they
 * fail if either constant changes value, and they fail if either name stops
 * being exported from *here*. Both directions are mutation-tested — removing
 * each declaration in turn is verified to break the build.
 *
 * This is why the barrel is fifteen star exports rather than 794 enumerated
 * names. The enumerated form had to be edited every time any module gained a
 * declaration, and an omission was invisible until something failed to import.
 *
 * ## Names that changed module in MCV-010
 *
 * Four constants and one helper were hoisted into `common.ts`, which is the one
 * kind of refactor the star-export form does *not* protect against. Moving a
 * name from one starred module to another leaves this file untouched and leaves
 * the build green, so nothing here would have noticed if the hoist had dropped
 * a name on the way.
 *
 * Only one of the five was previously public: `MAX_NOTE_LENGTH`, exported by
 * `booking.ts` and shadowed by an unexported twin in `referral.ts`. It now has
 * a single declaration in `common.ts` and reaches this barrel through
 * `export * from './common'` instead of `export * from './booking'` — the same
 * name, the same value, a different route. The other four —
 * `MAX_STRIPE_ID_LENGTH`, `MAX_SORT_ORDER`, `MAX_FILTER_TAGS` and
 * `stripeIdSchema` — were module-local in both of their homes, so they are
 * *additions* to the public surface rather than relocations within it, and no
 * alias was needed to keep anything working. `payment.ts`'s spelling of the
 * helper, `stripeReferenceSchema`, is simply gone; it was never exported, so
 * nothing could have been importing it.
 *
 * `userActivationSchema` and its two inferred types are new in the same pass,
 * closing the `User.isActive` coverage gap documented at the head of `user.ts`.
 *
 * The assertions at the foot of this file cover all of it, in the same
 * self-referential style as the collision guards: they read `Barrel.X`, so they
 * fail if a hoisted name stops being published from *here*, and they pin the
 * values, so they fail if a future edit re-declares one of them somewhere else
 * with a different number.
 *
 * `verbatimModuleSyntax` is on, so type-only re-exports use `export type`.
 */

// =============================================================================
// Domain modules
//
// Provably disjoint apart from the single documented collision, which the
// explicit re-exports at the foot of this file resolve.
// =============================================================================

export * from './common'
export * from './enums'

export * from './billing'
export * from './booking'
export * from './client'
export * from './crm'
export * from './intake'
export * from './media'
export * from './menu'
export * from './onboarding'
export * from './payment'
export * from './referral'
export * from './review'
export * from './staff'
export * from './user'

// =============================================================================
// Collision resolution
//
// These two declarations must stay below the `export *` block for the sake of
// the reader; ECMAScript itself is order-independent here, because explicit
// export entries are resolved before star exports regardless of position.
// =============================================================================

/**
 * The longest code `generateReferralCode` mints and `referralCodeSchema`
 * accepts — `12`. The referral domain owns the concept, so it keeps the plain
 * name.
 */
export { MAX_REFERRAL_CODE_LENGTH } from './referral'

/**
 * `ReferralCode.code` is `@db.VarChar(40)`, so the intake form accepts up to
 * forty characters from a guest typing a code they were given. Renamed to keep
 * it distinct from `MAX_REFERRAL_CODE_LENGTH` (12), which is the longest code
 * we ourselves generate.
 */
export { MAX_REFERRAL_CODE_LENGTH as MAX_INTAKE_REFERRAL_CODE_LENGTH } from './intake'

// =============================================================================
// Compile-time guard on the collision
//
// Type-only imports, so nothing below survives to the emitted module.
//
// `Barrel` is this module, imported into itself. A self-referential type import
// is legal and costs nothing at runtime, and it is the only way to assert on
// what this file *publishes* rather than on what its dependencies happen to
// declare. Reading `Barrel.X` fails to compile when `X` is not exported from
// here, which is precisely the regression the source-module form could not see.
//
// `Intake` and `Referral` are kept alongside it so a failure distinguishes the
// two ways this can break: a constant that changed value, and a constant that
// stopped being re-exported.
// =============================================================================

import type * as Barrel from './index'
import type * as BookingModule from './booking'
import type * as CommonModule from './common'
import type * as IntakeModule from './intake'
import type * as ReferralModule from './referral'
import type * as UserModule from './user'

/** Fails to instantiate unless `T` is exactly `true`. */
type Assert<T extends true> = T

// --- The source constants still mean what the policy above says they mean ---

/** `referral.ts` owns the concept and mints codes no longer than 12. */
export type _ReferralSourceIsTwelve = Assert<
  typeof ReferralModule.MAX_REFERRAL_CODE_LENGTH extends 12 ? true : false
>

/** `intake.ts` bounds its free-text field by the `VarChar(40)` column width. */
export type _IntakeSourceIsForty = Assert<
  typeof IntakeModule.MAX_REFERRAL_CODE_LENGTH extends 40 ? true : false
>

// --- ...and this barrel actually re-exports each of them, under the right name

/**
 * The unqualified `MAX_REFERRAL_CODE_LENGTH` must be exported from here and
 * must be referral's ceiling of 12 — not intake's 40.
 */
export type _BarrelPlainNameIsReferrals = Assert<
  typeof Barrel.MAX_REFERRAL_CODE_LENGTH extends 12 ? true : false
>

/**
 * `MAX_INTAKE_REFERRAL_CODE_LENGTH` must be exported from here and must be
 * intake's column width of 40. Deleting the alias re-export above makes this
 * line a compile error rather than a silent removal from the public surface.
 */
export type _BarrelAliasIsIntakes = Assert<
  typeof Barrel.MAX_INTAKE_REFERRAL_CODE_LENGTH extends 40 ? true : false
>

/**
 * The two names must not have collapsed onto the same constant. A single
 * `export *` surviving on its own would satisfy each assertion above
 * individually while making both names mean the same thing.
 */
export type _BarrelNamesAreDistinct = Assert<
  typeof Barrel.MAX_REFERRAL_CODE_LENGTH extends typeof Barrel.MAX_INTAKE_REFERRAL_CODE_LENGTH
    ? false
    : true
>

// =============================================================================
// Compile-time guard on the MCV-010 hoists
//
// Same technique, different failure mode. The collision guards above protect a
// name that two modules want; these protect a name that changed which module
// owns it. Both are invisible to `export *` on its own.
// =============================================================================

/**
 * `MAX_NOTE_LENGTH` is the only one of the hoisted names that was already
 * public, so it is the only one that could regress rather than simply fail to
 * appear. It must still be on the barrel and must still be 2,000 — a caller
 * that bounded a textarea by it should not notice the move at all.
 */
export type _BarrelNoteLengthIsTwoThousand = Assert<
  typeof Barrel.MAX_NOTE_LENGTH extends 2_000 ? true : false
>

/**
 * ...and it must reach the barrel from `common.ts`. `booking.ts` re-declaring
 * or re-exporting it would make this fail, which is the regression the value
 * check above cannot see: two declarations agreeing on 2,000 today is exactly
 * the state MCV-010 removed, and it satisfies every assertion about the number.
 */
export type _NoteLengthLeftBooking = Assert<
  'MAX_NOTE_LENGTH' extends keyof typeof BookingModule ? false : true
>

export type _NoteLengthLivesInCommon = Assert<
  typeof CommonModule.MAX_NOTE_LENGTH extends 2_000 ? true : false
>

/** The three limits that were module-local in two homes apiece. */
export type _BarrelStripeIdLengthIs255 = Assert<
  typeof Barrel.MAX_STRIPE_ID_LENGTH extends 255 ? true : false
>

export type _BarrelSortOrderIsTenThousand = Assert<
  typeof Barrel.MAX_SORT_ORDER extends 10_000 ? true : false
>

export type _BarrelFilterTagsIsTwenty = Assert<
  typeof Barrel.MAX_FILTER_TAGS extends 20 ? true : false
>

/**
 * The hoisted helper. Comparing against `CommonModule`'s own declaration rather
 * than against a structural shape means this fails if the barrel ever publishes
 * a *different* `stripeIdSchema` — which is what a re-declaration in `billing`
 * or `payment` would amount to.
 */
export type _BarrelStripeIdSchemaIsCommons = Assert<
  typeof Barrel.stripeIdSchema extends typeof CommonModule.stripeIdSchema
    ? true
    : false
>

/**
 * The `User.isActive` coverage gap is closed and stays closed. Reading these
 * through `Barrel` is what makes them load-bearing: `user.ts` could keep the
 * declarations while something here stopped publishing them.
 */
export type _BarrelPublishesUserActivation = Assert<
  typeof Barrel.userActivationSchema extends typeof UserModule.userActivationSchema
    ? true
    : false
>

export type _BarrelPublishesSelfDeactivationGuard = Assert<
  typeof Barrel.isSelfDeactivation extends typeof UserModule.isSelfDeactivation
    ? true
    : false
>
