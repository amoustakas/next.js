// mannachef/apps/web/src/lib/zod-resolver.ts

/**
 * The React Hook Form resolver every form on the platform uses.
 *
 * ## Why this exists rather than `@hookform/resolvers/zod`
 *
 * The workspace is pinned to `@hookform/resolvers@3.10` and `zod@4`, and the
 * shipped `zodResolver` does not work across that pair. Its guard is
 *
 * ```ts
 * const isZodError = (error: any): error is ZodError => Array.isArray(error?.errors)
 * ```
 *
 * and zod 4 renamed that property: a `ZodError` carries `issues`, and `errors`
 * is gone. The guard therefore returns `false` for a genuine validation
 * failure, the `catch` block re-throws, and the rejection surfaces as an
 * unhandled promise rejection out of `handleSubmit` instead of as field errors
 * under the inputs. Verified against the installed versions — a
 * `z.object({ a: z.string().min(3) })` failing `{ a: 'x' }` produces an error
 * for which `Array.isArray(error.errors)` is `false`.
 *
 * That failure is silent in the worst way: the form simply never shows a
 * message. So the mapping is done here, against zod 4's actual surface, and
 * every form imports `zodResolver` from `@/lib/zod-resolver`.
 *
 * ## Path spelling is the whole point
 *
 * Field errors are keyed with `z.core.toDotPath(issue.path)` — `guestCount`,
 * `address.city`, `menuItems[0].quantity`. That is deliberately the **same**
 * spelling `zodFail()` in `src/server/actions/types.ts` uses to build the
 * `fieldErrors` map an action returns. One spelling for client-side validation
 * and server-side validation means `useAction` can hand a server `fieldErrors`
 * map straight to `setError` with no re-keying, and a field highlighted by the
 * browser is highlighted identically when the server rejects the same payload.
 *
 * Issues with an empty path (object-level `.check()` / `.refine()` rules, of
 * which the validators package has several) are filed under `root`, which is
 * RHF's own name for a form-level error and what `<FormRootError>` renders.
 *
 * ## Two schemas, one form
 *
 * `Schema` is generic over both of zod's ends. `z.input<Schema>` is what the
 * form's fields hold (a `guestCount` text input yields a string that
 * `z.coerce.number()` will narrow); `z.output<Schema>` is what a successful
 * parse yields and what the action wants. `zodResolver` is typed so
 * `useForm<z.input<S>, unknown, z.output<S>>` lines up — `handleSubmit` then
 * hands the *parsed* values to its callback, which is exactly the value the
 * action's own `input` schema expects.
 */

import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers'
import type {
  FieldError,
  FieldErrors,
  FieldValues,
  Resolver,
  ResolverOptions,
  ResolverResult,
} from 'react-hook-form'
import { z } from 'zod'

/** RHF's name for the form-level error bucket. */
export const ROOT_ERROR_KEY = 'root'

/**
 * Flatten a `ZodError` into the flat `{ [dotPath]: FieldError }` map
 * `toNestErrors` expects.
 *
 * `criteriaMode: 'all'` asks RHF for *every* message per field rather than the
 * first, so when it is on each additional issue on a path is accumulated into
 * `types` — that is the shape `<FormMessage>` reads when it lists more than one
 * rule broken by a single value.
 */
function issuesToFieldErrors(
  issues: readonly z.core.$ZodIssue[],
  collectAllCriteria: boolean
): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {}

  for (const issue of issues) {
    const dotPath = z.core.toDotPath(issue.path)
    const key = dotPath.length > 0 ? dotPath : ROOT_ERROR_KEY
    const existing = errors[key]

    if (existing === undefined) {
      errors[key] = { type: issue.code ?? 'validate', message: issue.message }
      continue
    }

    if (!collectAllCriteria) {
      continue
    }

    const type = issue.code ?? 'validate'
    const types = existing.types ?? {}
    const previous = types[type]

    existing.types = {
      ...types,
      [type]:
        previous === undefined
          ? issue.message
          : ([] as string[]).concat(previous as string | string[], issue.message),
    }
  }

  return errors
}

/** Options accepted alongside the schema. */
export interface ZodResolverOptions {
  /**
   * Hand RHF the raw field values rather than zod's parsed output.
   *
   * Leave this off. The default — parsed output — is what makes a
   * `z.coerce.number()` field arrive at the action as a number and a
   * `.trim()`ed string arrive trimmed, which is the entire reason the form and
   * the action share one schema.
   */
  readonly raw?: boolean
}

/**
 * Build a React Hook Form resolver from any zod schema.
 *
 * ```ts
 * const form = useForm<
 *   z.input<typeof menuItemCreateSchema>,
 *   unknown,
 *   MenuItemCreateInput
 * >({
 *   resolver: zodResolver(menuItemCreateSchema),
 *   defaultValues: { name: '', priceCents: 0 },
 * })
 * ```
 */
export function zodResolver<
  TInput extends FieldValues,
  TOutput extends FieldValues,
>(
  schema: z.ZodType<TOutput, TInput>,
  options: ZodResolverOptions = {}
): Resolver<TInput, unknown, TOutput> {
  const resolver = async (
    values: TInput,
    _context: unknown,
    resolverOptions: ResolverOptions<TInput>
  ): Promise<ResolverResult<TOutput>> => {
    const parsed = await schema.safeParseAsync(values)

    if (parsed.success) {
      if (resolverOptions.shouldUseNativeValidation) {
        validateFieldsNatively({}, resolverOptions)
      }

      return {
        errors: {},
        values: (options.raw === true
          ? (values as unknown as TOutput)
          : parsed.data) as TOutput,
      }
    }

    const collectAllCriteria =
      !resolverOptions.shouldUseNativeValidation &&
      resolverOptions.criteriaMode === 'all'

    const flat = issuesToFieldErrors(parsed.error.issues, collectAllCriteria)
    const nested = toNestErrors<TInput>(flat as FieldErrors, resolverOptions)

    return {
      values: {},
      errors: nested as unknown as FieldErrors<TOutput>,
    }
  }

  return resolver as Resolver<TInput, unknown, TOutput>
}
