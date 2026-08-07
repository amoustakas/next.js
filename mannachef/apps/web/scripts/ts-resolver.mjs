// mannachef/apps/web/scripts/ts-resolver.mjs

// The workspace compiles under `moduleResolution: "Bundler"`, so its relative
// imports carry no file extension and `@/…` resolves against `src/`. Node's ESM
// resolver understands neither. This hook supplies both, letting
// `node --experimental-strip-types` run the TypeScript sources directly — no
// build step, so `pnpm --filter @mannachef/web test` can never be checking a
// stale artefact.
//
// A copy of `packages/validators/scripts/ts-resolver.mjs` with the `@/` alias
// added; the two packages are deliberately independent of each other's scripts.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const sourceRoot = path.join(projectRoot, 'src')

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
