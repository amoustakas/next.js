// mannachef/apps/web/scripts/action-resolver.mjs

// TypeScript path resolution for a harness, plus the four substitutions every
// harness that drives the **real** server actions against a **real** PostgreSQL
// needs. Used by `intake-register.mjs` (MCV-040) and `billing-register.mjs`
// (MCV-041); it was `intake-resolver.mjs` until the second pair of harnesses
// needed exactly the same four and the alternative was a second copy.
//
// **`@/server/db` is not substituted.** That module is a two-line re-export of
// the `@mannachef/db` singleton, and these harnesses want the genuine
// PrismaClient on a genuine PostgreSQL — there is no isolation level to
// reproduce and no in-memory store to register, so there is nothing for a
// fixture to add. Neither is `@/server/stripe`: `fixtures/stripe-recorder.ts`
// installs itself through the `globalThis` slot that module already memoises
// its client into, which is a seam the shipped code has for its own reasons.
//
// What is stubbed is what has nothing to do with any finding: the session, and
// the three request-scoped Next.js modules that `guards.ts` imports at module
// scope. Nothing under `src/` knows this file exists — the seam is at module
// resolution, so it is not a seam any caller of the real actions could reach.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const sourceRoot = path.join(projectRoot, 'src')
const fixtureRoot = path.join(projectRoot, 'scripts', 'fixtures')

/** Specifier → the fixture that stands in for it. */
const SUBSTITUTIONS = new Map([
  ['@/server/auth', path.join(fixtureRoot, 'auth-stub.ts')],
  ['next/cache', path.join(fixtureRoot, 'next-stub.ts')],
  ['next/headers', path.join(fixtureRoot, 'next-stub.ts')],
  ['next/navigation', path.join(fixtureRoot, 'next-stub.ts')],
])

function firstExisting(base) {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (path.extname(candidate) !== '' && existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export async function resolve(specifier, context, nextResolve) {
  const substitute = SUBSTITUTIONS.get(specifier)

  if (substitute !== undefined) {
    return { url: pathToFileURL(substitute).href, shortCircuit: true }
  }

  if (specifier.startsWith('@/')) {
    const resolved = firstExisting(path.join(sourceRoot, specifier.slice(2)))

    if (resolved !== null) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
  }

  if (specifier.startsWith('.') && path.extname(specifier) === '') {
    const parent = context.parentURL
      ? fileURLToPath(context.parentURL)
      : process.cwd()
    const resolved = firstExisting(
      path.resolve(path.dirname(parent), specifier)
    )

    if (resolved !== null) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
  }

  return nextResolve(specifier, context)
}
