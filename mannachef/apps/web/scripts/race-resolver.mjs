// mannachef/apps/web/scripts/race-resolver.mjs

// `ts-resolver.mjs` plus four substitutions, for `verify-superadmin-race.ts`.
//
// The same technique as `stub-resolver.mjs` and, deliberately, one fewer
// substitution: `@/server/db` is swapped for `fixtures/racing-db.ts`, which is
// a *real* PrismaClient against a *real* PostgreSQL rather than the in-memory
// fake. MCV-031 is a claim about what PostgreSQL does when two transactions
// interleave, and only PostgreSQL can settle it.
//
// What is stubbed is what has nothing to do with the question: the session, and
// the three request-scoped Next.js modules that `guards.ts` imports at module
// scope. As with the referral harness, nothing under `src/` knows this file
// exists.
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
  ['@/server/db', path.join(fixtureRoot, 'racing-db.ts')],
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
    // `racing-db.ts` imports `@mannachef/db` for the real client, and would
    // otherwise resolve its own substitution into a cycle.
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : ''

    if (!parent.startsWith(fixtureRoot)) {
      return { url: pathToFileURL(substitute).href, shortCircuit: true }
    }
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
