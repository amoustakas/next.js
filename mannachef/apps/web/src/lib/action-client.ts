// mannachef/apps/web/src/lib/action-client.ts
'use client'

/**
 * The one way a client component calls a Server Action.
 *
 * Every mutation in the app goes through {@link useAction}. It exists because
 * the same six things have to happen on every single submit, and getting any
 * one of them wrong is invisible until a guest hits it:
 *
 *  1. **Pending** has to be a real transition, so React keeps the current UI
 *     interactive and the router does not tear while the action runs.
 *  2. **`fieldErrors`** have to land back on the inputs that caused them —
 *     under the input, not in a toast.
 *  3. **Non-field failures** have to be announced, and each `ActionErrorCode`
 *     has to read as itself. A `FORBIDDEN` that renders as "Something went
 *     wrong" tells the guest to retry an action that will never succeed.
 *  4. **Success** has to be typed. `result.data` is `TData`, narrowed by `ok`.
 *  5. **Screen readers** have to hear all three, which means a live region
 *     driven by a string this hook owns rather than by whatever the form
 *     happens to render.
 *  6. **Stale results** have to be dropped. A double-submit that resolves out
 *     of order must not paint the first response over the second.
 *
 * ## The shape of a call
 *
 * ```tsx
 * 'use client'
 * import { useForm } from 'react-hook-form'
 * import { menuItemCreateSchema, type MenuItemCreateInput } from '@mannachef/validators'
 * import { zodResolver } from '@/lib/zod-resolver'
 * import { useAction } from '@/lib/action-client'
 * import { createMenuItem } from '@/server/actions/menu'
 *
 * export function NewDishForm() {
 *   const form = useForm<MenuItemCreateInput>({
 *     resolver: zodResolver(menuItemCreateSchema),
 *     defaultValues: { name: '', priceCents: 0 },
 *   })
 *
 *   const { execute, isPending, statusMessage } = useAction(createMenuItem, {
 *     form,
 *     successMessage: (data) => `${data.name} is on the menu.`,
 *     onSuccess: (data) => router.push(`/admin/menu/${data.id}`),
 *   })
 *
 *   return (
 *     <Form {...form}>
 *       <form onSubmit={form.handleSubmit((values) => execute(values))} noValidate>
 *         …
 *         <Button type="submit" loading={isPending}>Add dish</Button>
 *         <FormStatus>{statusMessage}</FormStatus>
 *       </form>
 *     </Form>
 *   )
 * }
 * ```
 *
 * `execute` returns the `ActionResult` as well as applying it, so a caller that
 * needs to branch further (navigate, close a dialog, refetch) can `await` it
 * instead of using the callbacks. Both styles are supported on purpose: the
 * callbacks keep the common case declarative, the return value keeps the
 * uncommon case possible.
 *
 * ## Why the types come from `@/server/actions/types` as `import type`
 *
 * `ActionResult` is the contract, and it is declared there. The import below is
 * `import type`, which `verbatimModuleSyntax` erases *entirely* — no runtime
 * edge is created from this client module into the server tree, and nothing
 * from `src/server/**` reaches the browser bundle. `src/server/actions/types.ts`
 * is in any case a pure module: it imports `zod` and nothing else, it carries no
 * `'use server'` directive, and it touches neither Prisma nor Stripe nor the
 * session.
 *
 * The types are **re-exported from here** so that no client component ever has
 * to write `from '@/server/...'` itself. Import `ActionResult`, `ActionFailure`
 * and `ActionErrorCode` from `@/lib/action-client`; import everything else —
 * schemas, inferred input types, enums — from `@mannachef/validators`.
 *
 * A value import from `@/server/actions/types` (for `DEFAULT_ERROR_MESSAGES`,
 * say) is deliberately *not* made here. Guest-facing copy for a failure already
 * arrives on the wire in `result.error`; what this module adds is the short
 * title beside it, which is a presentation decision and belongs on the client.
 */

import * as React from 'react'
import type { FieldPath, FieldValues, UseFormSetError } from 'react-hook-form'
import { toast } from 'sonner'

import type {
  ActionErrorCode,
  ActionFailure,
  ActionResult,
  FieldErrors as ActionFieldErrors,
  FORM_ERROR_KEY as ServerFormErrorKey,
} from '@/server/actions/types'

export type {
  ActionErrorCode,
  ActionFailure,
  ActionResult,
  ActionFieldErrors,
}

// =============================================================================
// 1. Vocabulary
// =============================================================================

/**
 * The shape `withAction()` produces, restated structurally.
 *
 * Written out rather than imported from `@/server/guards` so this module has no
 * reference at all — not even a type reference — to a file that imports Prisma.
 * It is the same type: `Action<TRaw, TData>`.
 */
export type ServerAction<TRaw, TData> = (
  raw: TRaw
) => Promise<ActionResult<TData>>

/** Where a call currently stands. Drives both the UI and the live region. */
export type ActionStatus = 'idle' | 'pending' | 'success' | 'error'

/**
 * The key `zodFail()` files object-level (pathless) issues under, and the key
 * this hook translates into RHF's own form-level bucket.
 *
 * Restated here rather than imported as a value, for the reason given at the
 * head of the file — this module must create no runtime edge into `src/server`.
 *
 * A restated constant is a constant that can drift, so the drift is made a
 * compile error immediately below by {@link _FormErrorKeyMatchesServer}. Left
 * unguarded, a rename on the server would not break the build: object-level
 * messages would simply stop being recognised and would start appearing in the
 * toast instead of above the form. Quiet, and wrong.
 */
export const FORM_ERROR_KEY = '_form'

/**
 * Fails to compile if this module's {@link FORM_ERROR_KEY} ever stops matching
 * the `FORM_ERROR_KEY` that `zodFail()` files pathless issues under.
 *
 * `import type { FORM_ERROR_KEY as ServerFormErrorKey }` binds the server's
 * constant in *type space only*, so `typeof ServerFormErrorKey` is readable
 * here while the import itself is erased by `verbatimModuleSyntax` — the guard
 * costs nothing at runtime and creates no bundle edge.
 */
type _FormErrorKeyMatchesServer =
  typeof FORM_ERROR_KEY extends typeof ServerFormErrorKey
    ? typeof ServerFormErrorKey extends typeof FORM_ERROR_KEY
      ? true
      : never
    : never

// Instantiating the alias is what makes it load-bearing; an unused type alias
// is not checked for satisfiability on its own.
const _formErrorKeyGuard: _FormErrorKeyMatchesServer = true
void _formErrorKeyGuard

/** RHF's name for a form-level error. `setError('root', …)`. */
export const ROOT_ERROR_KEY = 'root'

/**
 * A short title per failure code.
 *
 * This is the half of rule 3 that stops a `FORBIDDEN` reading as a generic
 * fault. The *sentence* under the title is always `result.error`, which the
 * server wrote for a guest; these are the four-or-five words above it that say
 * what kind of thing went wrong, so the guest knows whether to retry, to sign
 * in, or to stop.
 */
export const ACTION_ERROR_TITLES: Readonly<Record<ActionErrorCode, string>> = {
  UNAUTHENTICATED: 'Please sign in',
  FORBIDDEN: 'Not available to you',
  VALIDATION: 'Check the highlighted fields',
  NOT_FOUND: 'No longer there',
  CONFLICT: 'Something changed first',
  RATE_LIMITED: 'One moment',
  INTERNAL: 'That did not go through',
}

/**
 * How loudly each code is announced.
 *
 * `VALIDATION` is the odd one out and deliberately so: its detail is already
 * rendered under the offending inputs, so raising a second, redder copy of it
 * over the form is noise. It gets a quiet `warning` — or, when the failure
 * carried field errors at all, no toast whatsoever (see
 * {@link shouldToastFailure}).
 */
const ACTION_ERROR_SEVERITY: Readonly<
  Record<ActionErrorCode, 'error' | 'warning'>
> = {
  UNAUTHENTICATED: 'warning',
  FORBIDDEN: 'error',
  VALIDATION: 'warning',
  NOT_FOUND: 'warning',
  CONFLICT: 'warning',
  RATE_LIMITED: 'warning',
  INTERNAL: 'error',
}

/**
 * A failure, reduced to what a UI needs to render it.
 *
 * Exported because a screen that shows failures inline rather than as a toast
 * — a settings panel, a bulk-action drawer — should use the same words as the
 * toast would have used.
 */
export interface DescribedActionFailure {
  readonly code: ActionErrorCode
  readonly title: string
  readonly description: string
  readonly severity: 'error' | 'warning'
  /** True when at least one message was filed against a named field. */
  readonly hasFieldErrors: boolean
}

/** Render-ready title, sentence, and severity for a failure. */
export function describeActionError(
  failure: ActionFailure
): DescribedActionFailure {
  const fieldErrors = failure.fieldErrors ?? {}
  const namedFields = Object.keys(fieldErrors).filter(
    (key) => key !== FORM_ERROR_KEY
  )

  return {
    code: failure.code,
    title: ACTION_ERROR_TITLES[failure.code],
    description: failure.error,
    severity: ACTION_ERROR_SEVERITY[failure.code],
    hasFieldErrors: namedFields.length > 0,
  }
}

/**
 * True when a failure deserves a toast.
 *
 * A `VALIDATION` failure whose messages all landed on named inputs is already
 * fully reported where the guest is looking. Everything else — a role refusal,
 * a vanished row, a rate limit, an internal fault — has no other home, so it is
 * always announced.
 */
function shouldToastFailure(failure: ActionFailure): boolean {
  if (failure.code !== 'VALIDATION') {
    return true
  }

  return !describeActionError(failure).hasFieldErrors
}

// =============================================================================
// 2. Field-error mapping
// =============================================================================

/**
 * The slice of `UseFormReturn` this hook needs.
 *
 * Structural on purpose: a `UseFormReturn<TValues>`, a
 * `UseFormReturn<TInput, unknown, TOutput>`, and a hand-rolled test double all
 * satisfy it, so `useAction` never has to be told a form's three type
 * parameters.
 */
export interface ActionFormBinding<TFieldValues extends FieldValues> {
  readonly setError: UseFormSetError<TFieldValues>
  readonly clearErrors: (name?: never) => void
  readonly reset: () => void
}

/**
 * Copy an action's `fieldErrors` onto a form.
 *
 * Keys arrive as `z.core.toDotPath` output — `guestCount`, `address.city`,
 * `menuItems[0].quantity` — which is exactly what `setError` addresses fields
 * by, so no re-keying happens here and none should happen at a call site.
 *
 * Two keys are special:
 *
 *  - `_form` ({@link FORM_ERROR_KEY}) is where `zodFail()` files object-level
 *    issues — the cross-field rules in `@mannachef/validators`, such as "the
 *    service must end after it begins". It becomes RHF's `root`, which
 *    `<FormRootError>` renders above the fields.
 *  - Anything the form has no matching input for would otherwise vanish. RHF
 *    accepts `setError` on an unknown path without complaint and simply never
 *    displays it, so those are folded into `root` as well. A message the server
 *    took the trouble to write is never dropped on the floor.
 *
 * Returns the paths that were actually applied to named fields, so the caller
 * can decide whether a toast is still warranted.
 */
export function applyFieldErrors<TFieldValues extends FieldValues>(
  form: ActionFormBinding<TFieldValues>,
  fieldErrors: ActionFieldErrors,
  options: {
    /** Move focus to the first offending input. Default `true`. */
    readonly focusFirst?: boolean
    /** Paths the form actually owns. When omitted, every path is trusted. */
    readonly knownPaths?: ReadonlySet<string>
  } = {}
): string[] {
  const focusFirst = options.focusFirst ?? true
  const applied: string[] = []
  const formLevel: string[] = []

  for (const [path, messages] of Object.entries(fieldErrors)) {
    const message = messages.join(' ')

    if (message.length === 0) {
      continue
    }

    const isFormLevel =
      path === FORM_ERROR_KEY ||
      (options.knownPaths !== undefined && !options.knownPaths.has(path))

    if (isFormLevel) {
      formLevel.push(message)
      continue
    }

    form.setError(
      path as FieldPath<TFieldValues>,
      { type: 'server', message },
      { shouldFocus: focusFirst && applied.length === 0 }
    )
    applied.push(path)
  }

  if (formLevel.length > 0) {
    form.setError(ROOT_ERROR_KEY as FieldPath<TFieldValues>, {
      type: 'server',
      message: formLevel.join(' '),
    })
  }

  return applied
}

// =============================================================================
// 3. The hook
// =============================================================================

/** How `useAction` should behave for one particular action. */
export interface UseActionOptions<
  TData,
  TFieldValues extends FieldValues = FieldValues,
> {
  /**
   * The form whose fields this action validates.
   *
   * Supplying it is what turns `fieldErrors` into inline messages. Omit it for
   * a mutation with no form behind it — a row action, a toggle, a bulk verb —
   * and every failure is reported as a toast instead.
   */
  readonly form?: ActionFormBinding<TFieldValues>

  /** Ran after a successful call, before the success toast. */
  readonly onSuccess?: (data: TData) => void | Promise<void>

  /** Ran after a failed call, before any toast. */
  readonly onError?: (failure: ActionFailure) => void | Promise<void>

  /**
   * The success toast. Omit it for a mutation whose result is already visible
   * on screen — a toast that repeats what the guest can plainly see is clutter.
   */
  readonly successMessage?: string | ((data: TData) => string)

  /**
   * Override the sentence shown for particular failure codes.
   *
   * The server's `result.error` is the default and is usually right. Reach for
   * this when a screen has genuinely better words — a `CONFLICT` on a booking
   * slot means "that sitting has just been taken", which the generic sentence
   * cannot say.
   */
  readonly errorMessages?: Partial<Record<ActionErrorCode, string>>

  /** Suppress every toast and report through `status`/`error` alone. */
  readonly silent?: boolean

  /** Call `form.reset()` after a success. Default `false`. */
  readonly resetFormOnSuccess?: boolean

  /** Move focus to the first field the server rejected. Default `true`. */
  readonly focusFirstFieldError?: boolean

  /**
   * The field paths this form owns. Any `fieldErrors` key outside the set is
   * promoted to a form-level error rather than being set on a field that does
   * not exist. Optional; supply it when a form is a subset of an action's
   * input.
   */
  readonly knownFieldPaths?: readonly string[]
}

/** Everything `useAction` hands back. */
export interface UseActionResult<TRaw, TData> {
  /**
   * Call the action. Resolves with the `ActionResult` once every side effect
   * — field errors, callbacks, toasts, state — has been applied.
   */
  readonly execute: (raw: TRaw) => Promise<ActionResult<TData>>

  /** True from the moment `execute` is called until its transition settles. */
  readonly isPending: boolean

  /** `idle` → `pending` → `success` | `error`. */
  readonly status: ActionStatus

  /** The last successful payload, or `null`. */
  readonly data: TData | null

  /** The last failure, or `null`. Narrow on `error.code`. */
  readonly error: ActionFailure | null

  /** The last failure, described for rendering, or `null`. */
  readonly failure: DescribedActionFailure | null

  /**
   * A sentence for an `aria-live` region: what is happening, or what happened.
   * Empty while idle. Feed it to `<FormStatus>`.
   */
  readonly statusMessage: string

  /** Return to `idle` and forget the last result. */
  readonly reset: () => void
}

interface ActionState<TData> {
  readonly status: ActionStatus
  readonly data: TData | null
  readonly error: ActionFailure | null
}

const IDLE_STATE = { status: 'idle', data: null, error: null } as const

/**
 * Bind a Server Action to a component.
 *
 * @param action the action itself, imported from `@/server/actions/<domain>`
 * @param options how to report its outcome
 */
export function useAction<
  TRaw,
  TData,
  TFieldValues extends FieldValues = FieldValues,
>(
  action: ServerAction<TRaw, TData>,
  options: UseActionOptions<TData, TFieldValues> = {}
): UseActionResult<TRaw, TData> {
  const [isPending, startTransition] = React.useTransition()
  const [state, setState] = React.useState<ActionState<TData>>(IDLE_STATE)

  // Options are read through a ref so that `execute` is stable across renders.
  // A form's `onSuccess` closure is rebuilt every render; without this, every
  // `useEffect` depending on `execute` would re-run on every keystroke.
  const optionsRef = React.useRef(options)
  optionsRef.current = options

  // Monotonic call id. Only the newest call is allowed to write state, so a
  // slow first submit cannot paint over a fast second one (rule 6).
  const callIdRef = React.useRef(0)

  // Set on unmount so a late resolution neither warns nor toasts.
  const mountedRef = React.useRef(true)
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reset = React.useCallback(() => {
    callIdRef.current += 1
    setState(IDLE_STATE)
  }, [])

  const execute = React.useCallback(
    (raw: TRaw): Promise<ActionResult<TData>> => {
      const settings = optionsRef.current
      const callId = callIdRef.current + 1
      callIdRef.current = callId

      // Clear anything the previous attempt left behind, so a field that now
      // validates does not keep yesterday's server message.
      settings.form?.clearErrors()
      setState({ status: 'pending', data: null, error: null })

      return new Promise<ActionResult<TData>>((resolve) => {
        startTransition(async () => {
          let result: ActionResult<TData>

          try {
            result = await action(raw)
          } catch (thrown) {
            // `withAction` returns rather than throws, so reaching here means
            // the network dropped or the deployment moved underneath us —
            // neither of which the server got a chance to describe.
            if (process.env.NODE_ENV !== 'production') {
              // eslint-disable-next-line no-console
              console.error('[action-client] transport failure', thrown)
            }

            result = {
              ok: false,
              code: 'INTERNAL',
              error:
                'We could not reach the kitchen just now. Please check your connection and try again.',
            }
          }

          const isCurrent = callId === callIdRef.current && mountedRef.current

          if (result.ok) {
            if (isCurrent) {
              setState({ status: 'success', data: result.data, error: null })

              if (settings.resetFormOnSuccess === true) {
                settings.form?.reset()
              }
            }

            await settings.onSuccess?.(result.data)

            if (isCurrent && settings.silent !== true) {
              const message =
                typeof settings.successMessage === 'function'
                  ? settings.successMessage(result.data)
                  : settings.successMessage

              if (message !== undefined && message.length > 0) {
                toast.success(message)
              }
            }

            resolve(result)
            return
          }

          const override = settings.errorMessages?.[result.code]
          const failure: ActionFailure =
            override === undefined ? result : { ...result, error: override }

          if (isCurrent) {
            setState({ status: 'error', data: null, error: failure })

            if (settings.form !== undefined && failure.fieldErrors !== undefined) {
              applyFieldErrors(settings.form, failure.fieldErrors, {
                focusFirst: settings.focusFirstFieldError ?? true,
                ...(settings.knownFieldPaths === undefined
                  ? {}
                  : { knownPaths: new Set(settings.knownFieldPaths) }),
              })
            } else if (settings.form !== undefined) {
              // No field map at all — a FORBIDDEN, a CONFLICT, an INTERNAL.
              // Put it above the form too, so it survives the toast timing out.
              settings.form.setError(
                ROOT_ERROR_KEY as FieldPath<TFieldValues>,
                { type: 'server', message: failure.error }
              )
            }
          }

          await settings.onError?.(failure)

          if (isCurrent && settings.silent !== true && shouldToastFailure(failure)) {
            const described = describeActionError(failure)
            const payload = { description: described.description }

            if (described.severity === 'error') {
              toast.error(described.title, payload)
            } else {
              toast.warning(described.title, payload)
            }
          }

          resolve(failure)
        })
      })
    },
    [action]
  )

  const statusMessage = React.useMemo((): string => {
    if (isPending || state.status === 'pending') {
      return 'Saving…'
    }

    if (state.status === 'error' && state.error !== null) {
      const described = describeActionError(state.error)
      return `${described.title}. ${described.description}`
    }

    if (state.status === 'success') {
      const settings = optionsRef.current
      const message =
        typeof settings.successMessage === 'function'
          ? state.data === null
            ? undefined
            : settings.successMessage(state.data)
          : settings.successMessage

      return message !== undefined && message.length > 0 ? message : 'Saved.'
    }

    return ''
  }, [isPending, state])

  const failure = React.useMemo(
    () => (state.error === null ? null : describeActionError(state.error)),
    [state.error]
  )

  return {
    execute,
    isPending: isPending || state.status === 'pending',
    status: isPending && state.status !== 'pending' ? 'pending' : state.status,
    data: state.data,
    error: state.error,
    failure,
    statusMessage,
    reset,
  }
}
