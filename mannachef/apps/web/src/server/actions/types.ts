// mannachef/apps/web/src/server/actions/types.ts

/**
 * The Server Action result contract — `mannachef/CONTRACT.md` §4.
 *
 * Every exported Server Action in `src/server/actions/*` returns
 * `ActionResult<T>`. Actions never throw for an *expected* failure (a signed-out
 * caller, a role that is too low, a body that does not validate, a row that is
 * not the caller's) and they never let Prisma or Stripe text reach the browser.
 * The wrapper in `src/server/guards.ts` is what enforces both halves of that
 * sentence; this module is the vocabulary it speaks.
 *
 * ## Why a union rather than throwing
 *
 * A thrown error crossing the Server Action boundary is serialised by React
 * into an opaque digest in production — the client learns nothing actionable
 * and the user sees the error overlay. A discriminated union survives the
 * boundary intact, so a form can render `fieldErrors` inline and a screen can
 * branch on `code` without string-matching a message.
 *
 * `code` is deliberately the same seven-member union as `ApiErrorCode` in
 * `@mannachef/api-contract`, so an Expo screen calling the HTTP route and a web
 * component calling the action directly branch on identical values.
 */

import { z } from 'zod'

// =============================================================================
// 1. The union
// =============================================================================

/**
 * Machine-readable failure classification.
 *
 * Mirrors `apiErrorCodeSchema` in `@mannachef/api-contract`. Keep the two in
 * step: a code added here without a matching member there will not survive the
 * trip to the Expo client.
 */
export type ActionErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'

/**
 * Validation messages keyed by field path.
 *
 * The key is the dotted/bracketed path produced by `z.core.toDotPath` —
 * `guestCount`, `address.city`, `menuItems[0].quantity`. That is exactly the
 * spelling React Hook Form's `setError` and `getFieldState` expect, so a form
 * can hand the map straight to RHF with no re-keying:
 *
 * ```ts
 * const result = await submitIntake(values)
 * if (!result.ok) {
 *   for (const [field, messages] of Object.entries(result.fieldErrors ?? {})) {
 *     form.setError(field as FieldPath<IntakeFormValues>, {
 *       message: messages.join(' '),
 *     })
 *   }
 * }
 * ```
 *
 * Issues with an empty path (object-level refinements, cross-field rules) are
 * collected under {@link FORM_ERROR_KEY} rather than being dropped.
 */
export type FieldErrors = Record<string, string[]>

/** The successful arm of {@link ActionResult}. */
export type ActionSuccess<T> = { ok: true; data: T }

/**
 * The failed arm of {@link ActionResult}.
 *
 * `error` is always a sentence written for a guest. It is never a Prisma
 * message, never a Stripe message, and never a stack frame.
 */
export type ActionFailure = {
  ok: false
  error: string
  code: ActionErrorCode
  fieldErrors?: FieldErrors
}

/**
 * The exact union from `CONTRACT.md` §4.
 *
 * Narrow on `ok`:
 *
 * ```ts
 * const result = await createAppointment(input)
 * if (!result.ok) {
 *   toast.error(result.error)
 *   return
 * }
 * router.push(`/portal/appointments/${result.data.id}`)
 * ```
 */
export type ActionResult<T> = ActionSuccess<T> | ActionFailure

// =============================================================================
// 2. Messages
// =============================================================================

/**
 * The key under which object-level (pathless) zod issues are filed.
 *
 * Chosen to be a name no Prisma column and no form field can collide with:
 * every field in the schema is `camelCase`, and a leading underscore is not
 * produced by `z.core.toDotPath` for any real path.
 */
export const FORM_ERROR_KEY = '_form'

/**
 * The default guest-facing sentence for each code.
 *
 * A call site is free to pass something more specific to {@link fail}; these
 * are what the wrapper falls back to, and what every unmapped internal error
 * collapses to. They are the *only* strings that a thrown Prisma or Stripe
 * error can turn into.
 */
export const DEFAULT_ERROR_MESSAGES: Readonly<Record<ActionErrorCode, string>> =
  {
    UNAUTHENTICATED: 'Please sign in to continue.',
    FORBIDDEN: 'You do not have access to this.',
    VALIDATION: 'Please check the highlighted fields and try again.',
    NOT_FOUND: 'We could not find what you were looking for.',
    CONFLICT: 'That change conflicts with something already saved.',
    RATE_LIMITED: 'That was a little too quick. Please try again in a moment.',
    INTERNAL: 'Something went wrong on our end. Please try again.',
  }

// =============================================================================
// 3. Constructors
// =============================================================================

/**
 * Wrap a value as a success.
 *
 * ```ts
 * return ok({ appointmentId: appointment.id })
 * ```
 */
export function ok<T>(data: T): ActionSuccess<T> {
  return { ok: true, data }
}

/**
 * Build a failure.
 *
 * `error` is the guest-facing sentence; pass `undefined` (or omit it) to take
 * the default for `code` from {@link DEFAULT_ERROR_MESSAGES}.
 *
 * `fieldErrors` is omitted from the returned object entirely when absent rather
 * than set to `undefined`, because `exactOptionalPropertyTypes` is on and an
 * explicit `undefined` is not assignable to an optional property.
 */
export function fail(
  code: ActionErrorCode,
  error?: string,
  fieldErrors?: FieldErrors
): ActionFailure {
  const message =
    error !== undefined && error.length > 0
      ? error
      : DEFAULT_ERROR_MESSAGES[code]

  if (fieldErrors === undefined) {
    return { ok: false, code, error: message }
  }

  return { ok: false, code, error: message, fieldErrors }
}

/**
 * Convert a `z.ZodError` into a `VALIDATION` failure.
 *
 * ## How the field map is built
 *
 * Zod 4 offers two shapes for a failed parse and neither one is what React Hook
 * Form wants on its own:
 *
 *  - `z.flattenError(error)` returns `{ formErrors, fieldErrors }`, but its
 *    `fieldErrors` is keyed by *top-level* property only. Everything nested —
 *    `address.city`, `menuItems[0].quantity` — is silently collapsed onto the
 *    root key, which is precisely the case our booking and intake forms hit.
 *  - `z.treeifyError(error)` keeps the depth, but as a nested
 *    `{ errors, properties, items }` tree. RHF addresses fields by flat path
 *    string, so the tree would have to be walked and re-flattened at every call
 *    site.
 *
 * So this helper takes the form-level bucket from `z.flattenError` — that is
 * exactly what `formErrors` is for — and builds the field map itself from
 * `error.issues`, keying each issue by `z.core.toDotPath(issue.path)`. That is
 * the same path spelling zod uses in `z.prettifyError`, and the same spelling
 * RHF's `setError` accepts, so the result drops straight into a form.
 *
 * Multiple issues on one path accumulate into that path's array in the order
 * zod reported them.
 */
export function zodFail<T>(error: z.ZodError<T>): ActionFailure {
  const fieldErrors: FieldErrors = {}

  for (const issue of error.issues) {
    const path = z.core.toDotPath(issue.path)
    const key = path.length > 0 ? path : FORM_ERROR_KEY
    const bucket = fieldErrors[key]

    if (bucket === undefined) {
      fieldErrors[key] = [issue.message]
    } else {
      bucket.push(issue.message)
    }
  }

  // `formErrors` is the pathless bucket. It is already represented above under
  // FORM_ERROR_KEY; it is read here so the summary sentence can prefer a real
  // object-level message ("The end time must come after the start time.") over
  // the generic "check the highlighted fields".
  const { formErrors } = z.flattenError(error)
  const summary =
    formErrors[0] ??
    error.issues[0]?.message ??
    DEFAULT_ERROR_MESSAGES.VALIDATION

  return fail('VALIDATION', summary, fieldErrors)
}

// =============================================================================
// 4. Narrowing
// =============================================================================

/** Type guard for the success arm. Handy in `.filter()` and in tests. */
export function isOk<T>(result: ActionResult<T>): result is ActionSuccess<T> {
  return result.ok
}

/** Type guard for the failure arm. */
export function isFail<T>(result: ActionResult<T>): result is ActionFailure {
  return !result.ok
}

/**
 * Read `data` out of a result, substituting a fallback on failure.
 *
 * For read paths where a degraded render beats an error state — an empty
 * sidebar rather than a crashed page.
 */
export function unwrapOr<T>(result: ActionResult<T>, fallback: T): T {
  return result.ok ? result.data : fallback
}

// =============================================================================
// 5. Deliberate throwing
// =============================================================================

/**
 * The one error a handler is *allowed* to throw.
 *
 * Expected failures should be returned, not thrown — but deep inside a
 * `prisma.$transaction` callback there is no way to return, because returning
 * would commit the transaction. Throwing an `ActionError` rolls the transaction
 * back and still produces a precise, guest-safe `ActionResult`: the wrapper in
 * `guards.ts` recognises this class and forwards its `code`, `message`, and
 * `fieldErrors` verbatim instead of collapsing them to `INTERNAL`.
 *
 * ```ts
 * await prisma.$transaction(async (tx) => {
 *   const slot = await tx.bookingSlot.findUnique({ where: { id } })
 *   if (slot === null || slot.bookedCount >= slot.capacity) {
 *     throw new ActionError('CONFLICT', 'That sitting has just been taken.')
 *   }
 *   // …
 * })
 * ```
 *
 * Anything else a handler throws is treated as a bug: it is logged in full on
 * the server and reported to the client as a generic `INTERNAL` failure.
 */
export class ActionError extends Error {
  readonly code: ActionErrorCode
  readonly fieldErrors: FieldErrors | undefined

  constructor(
    code: ActionErrorCode,
    message?: string,
    fieldErrors?: FieldErrors
  ) {
    super(
      message !== undefined && message.length > 0
        ? message
        : DEFAULT_ERROR_MESSAGES[code]
    )
    this.name = 'ActionError'
    this.code = code
    this.fieldErrors = fieldErrors
  }

  /** Render this error as the `ActionResult` failure it stands for. */
  toActionFailure(): ActionFailure {
    return this.fieldErrors === undefined
      ? fail(this.code, this.message)
      : fail(this.code, this.message, this.fieldErrors)
  }
}

/** Narrowing guard for {@link ActionError}, safe across bundle boundaries. */
export function isActionError(value: unknown): value is ActionError {
  return value instanceof ActionError
}
