// mannachef/packages/validators/scripts/ts-resolver.mjs

// The workspace compiles under `moduleResolution: "Bundler"`, so its relative
// imports carry no file extension. Node's ESM resolver requires one. This hook
// supplies it, letting `node --experimental-strip-types` run the TypeScript
// sources directly — no build step, so a verification script can never be
// checking a stale `dist/`.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && path.extname(specifier) === '') {
    const parent = context.parentURL
      ? fileURLToPath(context.parentURL)
      : process.cwd()
    const base = path.resolve(path.dirname(parent), specifier)

    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
  }

  return nextResolve(specifier, context)
}
