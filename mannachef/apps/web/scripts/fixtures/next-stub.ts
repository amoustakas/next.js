// mannachef/apps/web/scripts/fixtures/next-stub.ts

/**
 * Stands in for `next/cache`, `next/headers` and `next/navigation` at runtime.
 *
 * All three are request-scoped: outside a Next.js render or Server Action they
 * either throw or read an async-local store that does not exist. `guards.ts`
 * imports all three at module scope, so they have to resolve to *something* for
 * the action modules to load at all.
 *
 * One module serves all three specifiers because ESM named imports only need
 * the names to be present. Nothing here does any work:
 *
 *  - the revalidation trio is called by `applyRevalidation` on success, which
 *    already swallows failures and is not what this regression is about;
 *  - `headers()` is reached only from `rateLimit`, which none of the four
 *    actions under test configures — it returns an empty header set rather than
 *    throwing so that a future harness case can use a rate-limited action
 *    without discovering this the hard way;
 *  - `unstable_rethrow` exists to let `redirect()` sentinels through
 *    `withAction`'s catch. No action under test redirects, so re-throwing
 *    nothing is exactly right.
 */

export function revalidatePath(_path: string, _type?: string): void {}

export function revalidateTag(_tag: string, _profile?: unknown): void {}

export function updateTag(_tag: string): void {}

export async function headers(): Promise<Headers> {
  return new Headers()
}

export function unstable_rethrow(_error: unknown): void {}
