// mannachef/apps/web/scripts/gen-action-index.mjs
//
// Regenerates ACTIONS-INDEX.md — a one-line-per-action signature table.
//
// It exists so that UI code (and agents writing UI code) can look up an
// action's name, auth level, input schema and return type without opening a
// 2,000-line action module. The index is derived, never hand-edited; if it
// disagrees with the source, the source wins and this script is the fix.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const actionsDir = join(here, '..', 'src', 'server', 'actions')
const outFile = join(here, '..', 'ACTIONS-INDEX.md')

// Anchor only on the export itself, then parse the config object by matching
// braces. A single regex spanning the whole call silently dropped 21 of 136
// actions because return types are sometimes wrapped across lines — and an
// index that omits an action is worse than no index, since a caller will
// invent one instead.
const EXPORT = /export const (\w+) = withAction\(/g

const field = (config, key) =>
  new RegExp(`${key}:\\s*'([^']+)'`).exec(config)?.[1] ?? null

/** Reads the balanced `{...}` config object starting at or after `from`. */
function readConfig(source, from) {
  const open = source.indexOf('{', from)
  if (open === -1) return { config: '', end: from }
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) {
      return { config: source.slice(open + 1, i), end: i }
    }
  }
  return { config: '', end: from }
}

/** Pulls the `ActionResult<...>` payload out of the handler's return type. */
function readReturns(source, from) {
  const slice = source.slice(from, from + 600)
  const at = slice.indexOf('ActionResult<')
  // No explicit annotation on the handler — TypeScript infers it. Say so
  // rather than printing `unknown`, which reads like a parse failure.
  if (at === -1) return '_(inferred)_'
  let depth = 0
  const start = at + 'ActionResult'.length
  for (let i = start; i < slice.length; i++) {
    if (slice[i] === '<') depth++
    else if (slice[i] === '>' && --depth === 0) {
      return slice.slice(start + 1, i).replace(/\s+/g, ' ').trim()
    }
  }
  return 'unknown'
}

const lines = [
  '# Server Action Index (generated)',
  '',
  'Signature reference so UI code never has to open a 2,000-line action module.',
  '',
  'Regenerate with `pnpm gen:action-index`. Do not hand-edit — it is derived from',
  '`src/server/actions/*.ts` and will be overwritten.',
]

let total = 0

for (const file of readdirSync(actionsDir).sort()) {
  if (!file.endsWith('.ts') || file === 'types.ts') continue

  const source = readFileSync(join(actionsDir, file), 'utf8')
  const rows = []

  for (const match of source.matchAll(EXPORT)) {
    const { config, end } = readConfig(source, match.index + match[0].length)
    rows.push({
      exportName: match[1],
      action: field(config, 'name') ?? '?',
      auth: field(config, 'auth') ?? '?',
      input: /input:\s*([\w.]+)/.exec(config)?.[1] ?? 'none',
      returns: readReturns(source, end),
      rateLimited: config.includes('rateLimit') ? 'yes' : '',
    })
  }

  if (rows.length === 0) continue
  total += rows.length

  lines.push('', `## \`server/actions/${file}\``, '')
  lines.push('| export | action | auth | input schema | returns | rate-limited |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(
      `| \`${r.exportName}\` | \`${r.action}\` | ${r.auth} | \`${r.input}\` | \`${r.returns}\` | ${r.rateLimited} |`
    )
  }
}

writeFileSync(outFile, lines.join('\n') + '\n')
console.log(`ACTIONS-INDEX.md: ${total} actions indexed`)
