// mannachef/apps/web/scripts/stub-resolver.mjs

// `ts-resolver.mjs` plus five substitutions, for `verify-referral-privilege.ts`.
//
// The regression drives the real Server Actions, the real `withAction` wrapper
// and the real zod schemas. What it cannot bring with it is a session, a
// PostgreSQL instance, and a Next.js request scope — so those three, and only
// those three, are swapped for the fixtures in `./fixtures/`.
//
// Substituting at the loader means the *code under test is unmodified*: nothing
// in `src/` knows a harness exists, there is no injection seam widening the
// production surface, and an action that reached for a sixth thing would fail
// to resolve rather than quietly find a mock.
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
  ['@/server/db', path.join(fixtureRoot, 'db-stub.ts')],
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
    // The fixtures themselves import `@mannachef/db` for the real `Prisma`
    // namespace; letting a fixture resolve its own substitution would be a
    // cycle, so the swap is skipped for anything already inside `fixtures/`.
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
