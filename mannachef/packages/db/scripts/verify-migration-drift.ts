// mannachef/packages/db/scripts/verify-migration-drift.ts

/**
 * The MCV-042 guardrail: `prisma/migrations` must reproduce `prisma/schema.prisma`.
 *
 * ```bash
 * DATABASE_URL=postgresql://…/mannachef_harness \
 *   pnpm --filter @mannachef/db verify:drift
 * ```
 *
 * Exits 0 when the migration history and the datamodel agree, and non-zero —
 * printing the exact steps that are missing — when they do not. Nothing is
 * written to `DATABASE_URL`; it is read only to derive the throwaway shadow
 * database this check needs, and to reach the server the shadow lives on.
 *
 * ## Why this exists
 *
 * Prisma has two schemas, not one, and only pretends otherwise.
 *
 *  - **Prisma Client is generated from `schema.prisma`.** An `@@unique` there
 *    is what makes a compound key appear in `WhereUniqueInput`, and what makes
 *    `upsert` emit `INSERT … ON CONFLICT (<those columns>) DO UPDATE`.
 *  - **The database is built from `prisma/migrations`.** An `@@unique` that no
 *    migration ever creates exists nowhere a query can reach it.
 *
 * When those two drift apart, every type still checks, every unit test still
 * passes, and the generated client confidently emits SQL for an index that is
 * not there. MCV-042 was exactly that: `MediaAsset.@@unique([provider,
 * providerFileKey])` in the datamodel, a *partial* unique index
 * (`WHERE "providerFileKey" IS NOT NULL`) in `0000_init`, and PostgreSQL
 * refusing every `completeMediaUpload` with
 *
 *   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
 *          specification
 *
 * — a 100% failure rate on media upload, against a green test suite, because
 * nothing in that suite touched `mediaAsset.upsert` on a real database.
 *
 * A drift check is the only thing that catches this class of defect *before*
 * production, because the defect is invisible to every layer above the wire:
 * the type is right, the query builder is right, and the row simply is not
 * insertable. `scripts/verify-conflict-targets.ts` is the companion check that
 * proves the specific queries the application issues still work; this one
 * proves the general invariant that produced them.
 *
 * ## What "no drift" does and does not mean
 *
 * `prisma migrate diff` compares things the Prisma datamodel can express.
 * `CHECK` constraints and partial (`WHERE`-scoped) unique indexes have no DSL
 * syntax, so the hand-written block in `0000_init` is invisible to this
 * comparison in both directions: a partial index in SQL is not reported as an
 * extra, and it cannot stand in for a plain `@@unique` in the datamodel
 * either. That asymmetry is the whole reason MCV-042 survived — swapping a
 * plain unique index for a partial one in SQL registers as the datamodel index
 * having gone *missing*, which is precisely what this check now reports.
 *
 * So: a clean run means every index, column, table and enum the datamodel
 * declares is created by some migration. It does not mean the hand-written
 * constraints are present. Those are covered by
 * `scripts/verify-conflict-targets.ts` and by the harnesses under
 * `apps/web/scripts`.
 *
 * ## The shadow database
 *
 * `--from-migrations` has to *execute* the migration history somewhere to know
 * what it produces, so Prisma needs a scratch database it is allowed to drop
 * and recreate. It is created here if it does not exist, is never the database
 * `DATABASE_URL` points at, and holds nothing between runs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { SpawnSyncReturns } from 'node:child_process'

// =============================================================================
// 1. Locating the Prisma CLI and the schema
// =============================================================================

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')
const SCHEMA_PATH = path.join(PACKAGE_ROOT, 'prisma', 'schema.prisma')
const MIGRATIONS_PATH = path.join(PACKAGE_ROOT, 'prisma', 'migrations')

/**
 * The `prisma` binary this package installed.
 *
 * Resolved from the package's own `node_modules` rather than trusting `PATH`,
 * so the version doing the comparison is the version in `devDependencies` —
 * the same one that generated the client the application runs against.
 */
function resolvePrismaCli(): string {
  const candidates = [
    path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'prisma'),
    path.join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', 'prisma'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    'Could not find the `prisma` CLI. Run `pnpm install` in mannachef/ first.\n' +
      `Looked in:\n${candidates.map((entry) => `  ${entry}`).join('\n')}`
  )
}

const PRISMA_CLI = resolvePrismaCli()

// =============================================================================
// 2. The shadow database
// =============================================================================

/**
 * Where the migration history gets replayed.
 *
 * `PRISMA_SHADOW_DATABASE_URL` wins if it is set. Otherwise the name is
 * derived from `DATABASE_URL` by suffixing the database, so a developer who
 * has already pointed the workspace at a local PostgreSQL needs no second
 * variable — and so the derived name can never accidentally *be* the
 * development database, which this check would otherwise wipe.
 */
function resolveShadowDatabaseUrl(): { url: string; name: string } {
  const explicit = process.env.PRISMA_SHADOW_DATABASE_URL

  if (explicit !== undefined && explicit !== '') {
    return { url: explicit, name: databaseName(explicit) }
  }

  const base = process.env.DATABASE_URL

  if (base === undefined || base === '') {
    throw new Error(
      'Neither PRISMA_SHADOW_DATABASE_URL nor DATABASE_URL is set.\n' +
        'This check replays the migration history against a real PostgreSQL. Point\n' +
        'DATABASE_URL at any reachable server — the database it names is only read\n' +
        'to derive a scratch database next to it. See the docblock in this file.'
    )
  }

  const parsed = parseUrl(base)
  const derived = `${parsed.pathname.replace(/^\//, '') || 'mannachef'}_migrate_shadow`

  parsed.pathname = `/${derived}`

  return { url: parsed.toString(), name: derived }
}

function parseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new Error(
      `DATABASE_URL is not a parseable URL, so no shadow database can be derived from it. Set PRISMA_SHADOW_DATABASE_URL explicitly.`
    )
  }
}

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '(none)'
  } catch {
    return '(unparseable)'
  }
}

/**
 * The same server, but the always-present `postgres` database.
 *
 * `CREATE DATABASE` has to be issued from a connection to some *other*
 * database, and by definition the shadow is not connectable yet.
 */
function adminUrlFor(shadowUrl: string): string {
  const parsed = parseUrl(shadowUrl)

  parsed.pathname = '/postgres'
  parsed.search = ''

  return parsed.toString()
}

/**
 * Create the shadow database if it is not there yet.
 *
 * Idempotent: a second run finds it and moves on. `prisma migrate diff` empties
 * it before and after each use, so nothing accumulates. Uses `prisma db
 * execute`, which is already a devDependency, rather than adding a PostgreSQL
 * driver to a package that only needs one for this line.
 */
function ensureShadowDatabase(shadowUrl: string, shadowName: string): boolean {
  const probe = run(
    ['db', 'execute', '--url', shadowUrl, '--stdin'],
    'SELECT 1;'
  )

  if (probe.status === 0) {
    return false
  }

  const created = run(
    ['db', 'execute', '--url', adminUrlFor(shadowUrl), '--stdin'],
    `CREATE DATABASE "${shadowName}";`
  )

  if (created.status !== 0) {
    throw new Error(
      `Could not reach or create the shadow database "${shadowName}".\n\n` +
        `While connecting:\n${indent(output(probe))}\n\n` +
        `While creating:\n${indent(output(created))}\n\n` +
        'Start PostgreSQL, or create the database yourself and re-run:\n' +
        `  createdb ${shadowName}`
    )
  }

  return true
}

// =============================================================================
// 3. Running the CLI
// =============================================================================

function run(
  args: readonly string[],
  stdin?: string
): SpawnSyncReturns<string> {
  return spawnSync(PRISMA_CLI, [...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    ...(stdin === undefined ? {} : { input: stdin }),
    env: { ...process.env },
  })
}

function output(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || '(no output)'
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

// =============================================================================
// 4. The check
// =============================================================================

function main(): void {
  const shadow = resolveShadowDatabaseUrl()

  console.log(`schema:     ${path.relative(PACKAGE_ROOT, SCHEMA_PATH)}`)
  console.log(`migrations: ${path.relative(PACKAGE_ROOT, MIGRATIONS_PATH)}`)
  console.log(`shadow:     ${shadow.name}`)

  const wasCreated = ensureShadowDatabase(shadow.url, shadow.name)

  if (wasCreated) {
    console.log(`            (created — it did not exist yet)`)
  }

  const diff = run([
    'migrate',
    'diff',
    '--from-migrations',
    MIGRATIONS_PATH,
    '--to-schema-datamodel',
    SCHEMA_PATH,
    '--shadow-database-url',
    shadow.url,
    '--exit-code',
  ])

  console.log(`\n${'-'.repeat(72)}`)

  // `--exit-code` overloads the status: 0 = the two agree, 2 = they differ,
  // anything else (1, or a signal) is the CLI itself having failed. Treating a
  // CLI failure as "no drift" is how a guardrail becomes decorative, so the
  // three cases are separated explicitly.
  if (diff.status === 0) {
    console.log(output(diff))
    console.log(
      '\nPASS — every table, column, index and enum in schema.prisma is created by prisma/migrations.'
    )

    return
  }

  if (diff.status === 2) {
    console.error(
      'DRIFT — prisma/migrations does not reproduce schema.prisma.\n\n' +
        indent(output(diff)) +
        '\n\nA `[+] Added …` step is something schema.prisma declares that no migration\n' +
        'creates. Prisma Client is generated from schema.prisma, so it will emit SQL\n' +
        'for that object against databases where it does not exist — an `@@unique`\n' +
        'missing from the history makes every `upsert` on that key fail with\n' +
        'PostgreSQL 42P10 at runtime, with nothing failing at build time.\n\n' +
        'Fix it by adding a migration, not by deleting this check. If the object\n' +
        'genuinely cannot be expressed in SQL the way the DSL describes it (a\n' +
        'partial unique index, say), then the declaration in schema.prisma is the\n' +
        'thing that is wrong — see packages/db/README.md, "Reconciling a\n' +
        'hand-written index with the datamodel".'
    )

    process.exit(1)
  }

  console.error(
    `The \`prisma migrate diff\` CLI failed (exit ${String(diff.status)}${
      diff.signal === null ? '' : `, signal ${diff.signal}`
    }).\n\n${indent(output(diff))}`
  )

  process.exit(1)
}

try {
  main()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
