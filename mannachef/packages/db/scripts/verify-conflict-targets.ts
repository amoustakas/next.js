// mannachef/packages/db/scripts/verify-conflict-targets.ts

/**
 * The MCV-042 regression: every compound unique key Prisma Client addresses
 * must be a key PostgreSQL can actually resolve.
 *
 * ```bash
 * DATABASE_URL=postgresql://…/mannachef_harness \
 *   pnpm --filter @mannachef/db verify:conflict-targets
 * ```
 *
 * Builds a scratch database next to whatever `DATABASE_URL` names, applies the
 * **full migration history** to it with `prisma migrate deploy`, regenerates
 * the client from `schema.prisma`, and then issues the real queries. Every
 * assertion runs — a missing index breaks several of them and reading only the
 * first would misattribute the cause — and the run exits non-zero at the end if
 * any failed. `DATABASE_URL`'s own database is never written to, never read
 * from, and never dropped — see {@link resolveScratchDatabase}.
 *
 * ## The defect this reproduces
 *
 * `MediaAsset.@@unique([provider, providerFileKey])` makes Prisma Client emit
 *
 *   INSERT INTO "MediaAsset" (…) VALUES (…)
 *   ON CONFLICT ("provider", "providerFileKey") DO UPDATE SET …
 *
 * for `mediaAsset.upsert({ where: { provider_providerFileKey: … } })`.
 * `0000_init` created a **partial** index for that pair
 * (`WHERE "providerFileKey" IS NOT NULL`), and PostgreSQL will not infer an
 * `ON CONFLICT` target from a bare column list to a partial index. So on every
 * database built from the migration history, that upsert failed
 * unconditionally:
 *
 *   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
 *          specification
 *
 * `completeMediaUpload` (`apps/web/src/server/actions/media.ts`) is the only
 * way an asset enters the library and it ends in that upsert, so media upload
 * was dead in every environment — with a fully green test suite, because
 * nothing in the suite reached `mediaAsset.upsert` on a real database. That is
 * the gap this file closes.
 *
 * ## Why the assertions are shaped the way they are
 *
 * Proving the upsert now succeeds is necessary and nowhere near sufficient. The
 * fix — replacing the partial index with a plain one — is only correct if it
 * changed *nothing else*, and the two things it could plausibly have broken are
 * the two things the partial index was introduced (MCV-007) to be careful
 * about. So the `MediaAsset` block asserts all three:
 *
 *  1. the upsert resolves its conflict target, in both the insert and the
 *     update direction, and is idempotent across a repeated callback;
 *  2. a genuine duplicate `(provider, providerFileKey)` is still **rejected**
 *     — the plain index enforces everything the partial one did;
 *  3. any number of rows may still carry `providerFileKey = NULL` — the plain
 *     index does not start rejecting `EXTERNAL` assets that have no file key,
 *     because Postgres's NULLS DISTINCT means two such tuples are never equal.
 *
 * The `ChefAvailability` block guards the opposite reconciliation. There the
 * `@@unique` was **removed** from `schema.prisma` and the two partial indexes
 * kept, because they encode two genuinely different constraints — one per
 * `kind` discriminator branch — that no single tuple can express. Deleting a
 * constraint from the datamodel is the kind of change that silences a drift
 * check by deleting the thing it was checking, so the enforcement is asserted
 * directly against the database instead: duplicates are rejected within each
 * branch, and rows in *different* branches that happen to share a time window
 * do not collide.
 *
 * ## Why a real PostgreSQL
 *
 * For the same reason `apps/web/scripts/verify-superadmin-race.ts` needs one.
 * The claim under test is not about what the application does — it is about
 * what PostgreSQL accepts. A fake database's `ON CONFLICT` support is whatever
 * its author believed PostgreSQL's to be, and the entire defect is that the
 * belief was wrong.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { SpawnSyncReturns } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'

// =============================================================================
// 1. Locating the Prisma CLI
// =============================================================================

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')
const SCRATCH_SUFFIX = '_conflict_harness'

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

function run(
  args: readonly string[],
  options: { readonly stdin?: string; readonly databaseUrl?: string } = {}
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }

  if (options.databaseUrl !== undefined) {
    env.DATABASE_URL = options.databaseUrl
  }

  return spawnSync(PRISMA_CLI, [...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    env,
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

function expectOk(result: SpawnSyncReturns<string>, what: string): void {
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${String(result.status)}).\n\n${indent(output(result))}`
    )
  }
}

// =============================================================================
// 2. The scratch database
// =============================================================================

interface Scratch {
  readonly name: string
  readonly url: string
  readonly adminUrl: string
}

/**
 * A disposable database beside the one `DATABASE_URL` names.
 *
 * The name is always the configured database plus {@link SCRATCH_SUFFIX}, and
 * {@link recreateScratchDatabase} refuses to drop anything whose name does not
 * end in that suffix. There is deliberately no environment variable that lets
 * a caller aim this at an arbitrary database: the harness drops and recreates
 * its target on every run, and the only safe target is one it named itself.
 */
function resolveScratchDatabase(): Scratch {
  const base = process.env.DATABASE_URL

  if (base === undefined || base === '') {
    throw new Error(
      'DATABASE_URL is not set. This regression needs a real PostgreSQL — see the\n' +
        'docblock in this file. The database it names is never touched; it only\n' +
        'supplies the server, credentials and a name to derive the scratch database\n' +
        'from.'
    )
  }

  let parsed: URL

  try {
    parsed = new URL(base)
  } catch {
    throw new Error('DATABASE_URL is not a parseable URL.')
  }

  const configured = parsed.pathname.replace(/^\//, '') || 'mannachef'
  const name = `${configured}${SCRATCH_SUFFIX}`

  const scratchUrl = new URL(base)
  scratchUrl.pathname = `/${name}`

  const adminUrl = new URL(base)
  adminUrl.pathname = '/postgres'
  adminUrl.search = ''

  return { name, url: scratchUrl.toString(), adminUrl: adminUrl.toString() }
}

/**
 * Drop and recreate the scratch database, so the migration history is always
 * applied to genuinely empty storage.
 *
 * "Fresh" is the point: a defect that only shows up on a database *built from
 * the migrations* cannot be reproduced against a database that was built once
 * by `prisma db push` and has been carried forward ever since. That is how
 * MCV-042 stayed invisible locally.
 */
function recreateScratchDatabase(scratch: Scratch): void {
  if (!scratch.name.endsWith(SCRATCH_SUFFIX)) {
    throw new Error(
      `Refusing to drop a database named "${scratch.name}": it is not a scratch database.`
    )
  }

  const dropped = run(['db', 'execute', '--url', scratch.adminUrl, '--stdin'], {
    stdin: `DROP DATABASE IF EXISTS "${scratch.name}" WITH (FORCE);`,
  })

  if (dropped.status !== 0) {
    throw new Error(
      `Could not reach PostgreSQL to prepare the scratch database "${scratch.name}".\n\n` +
        `${indent(output(dropped))}\n\n` +
        'Start PostgreSQL and point DATABASE_URL at it.'
    )
  }

  expectOk(
    run(['db', 'execute', '--url', scratch.adminUrl, '--stdin'], {
      stdin: `CREATE DATABASE "${scratch.name}";`,
    }),
    `CREATE DATABASE "${scratch.name}"`
  )
}

// =============================================================================
// 3. Assertions
// =============================================================================

interface Failure {
  readonly area: string
  readonly label: string
  readonly detail: string
}

const failures: Failure[] = []
let checksRun = 0

function pass(area: string, label: string): void {
  checksRun += 1
  console.log(`  ✓ ${area} — ${label}`)
}

function fail(area: string, label: string, detail: string): void {
  checksRun += 1
  failures.push({ area, label, detail })
  console.log(`  ✗ ${area} — ${label}`)
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code

    return typeof code === 'string'
      ? `${code}: ${error.message.split('\n').slice(0, 6).join('\n')}`
      : error.message.split('\n').slice(0, 8).join('\n')
  }

  return String(error)
}

/** True when the failure is PostgreSQL refusing to resolve an ON CONFLICT target. */
function isConflictTargetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('42P10') ||
      error.message.includes(
        'no unique or exclusion constraint matching the ON CONFLICT'
      ))
  )
}

/** True when the failure is a unique-constraint violation (Prisma `P2002`). */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    (error as { code?: unknown }).code === 'P2002' ||
    error.message.includes('23505') ||
    error.message.includes('Unique constraint failed')
  )
}

/**
 * Run `body`, expecting it to succeed.
 *
 * A thrown 42P10 is reported as the MCV-042 regression by name rather than as a
 * generic failure, because that is the one error whose meaning is "the index
 * this query names is not in the database".
 */
async function expectSucceeds(
  area: string,
  label: string,
  body: () => Promise<void>
): Promise<void> {
  try {
    await body()
    pass(area, label)
  } catch (error) {
    fail(
      area,
      label,
      isConflictTargetError(error)
        ? 'MCV-042 regression: PostgreSQL could not match the ON CONFLICT target to any\n' +
            'index. The @@unique in schema.prisma is not created as a plain unique index by\n' +
            `prisma/migrations.\n\n${describeError(error)}`
        : describeError(error)
    )
  }
}

/** Run `body`, expecting the database to reject it with a unique violation. */
async function expectRejectedAsDuplicate(
  area: string,
  label: string,
  body: () => Promise<void>
): Promise<void> {
  try {
    await body()
    fail(
      area,
      label,
      'The database ACCEPTED a duplicate. The unique index that is supposed to reject\n' +
        'this row is missing from prisma/migrations, so the constraint exists only in\n' +
        'documentation.'
    )
  } catch (error) {
    if (isUniqueViolation(error)) {
      pass(area, label)

      return
    }

    fail(
      area,
      label,
      `Expected a unique-constraint violation, got:\n${describeError(error)}`
    )
  }
}

// =============================================================================
// 4. The MediaAsset scenarios
// =============================================================================

const UPLOADER_ID = 'harness-uploader'
const OTHER_UPLOADER_ID = 'harness-uploader-2'

async function seedUsers(db: PrismaClient): Promise<void> {
  await db.user.createMany({
    data: [
      {
        id: UPLOADER_ID,
        name: 'Harness Uploader',
        email: 'uploader@harness.invalid',
        role: 'ADMIN',
      },
      {
        id: OTHER_UPLOADER_ID,
        name: 'Second Harness Uploader',
        email: 'uploader-2@harness.invalid',
        role: 'ADMIN',
      },
    ],
  })
}

/**
 * The exact call `completeMediaUpload` makes, with the exact `where` shape.
 *
 * Kept as one function so the insert direction and the update direction are
 * provably the same statement — an upsert whose two directions were spelled
 * differently could pass here and still fail in the action.
 */
function uploadCallback(
  db: PrismaClient,
  args: {
    readonly providerFileKey: string
    readonly alt: string
    readonly uploadedById: string
  }
): Promise<{ id: string; alt: string; uploadedById: string | null }> {
  return db.mediaAsset.upsert({
    where: {
      provider_providerFileKey: {
        provider: 'UPLOADTHING',
        providerFileKey: args.providerFileKey,
      },
    },
    create: {
      url: `https://utfs.io/f/${args.providerFileKey}`,
      thumbnailUrl: null,
      alt: args.alt,
      caption: null,
      credit: null,
      kind: 'IMAGE',
      provider: 'UPLOADTHING',
      providerFileKey: args.providerFileKey,
      width: 1200,
      height: 800,
      bytes: 412_000,
      mimeType: 'image/webp',
      blurData: null,
      checksum: null,
      uploadedById: args.uploadedById,
    },
    update: {
      url: `https://utfs.io/f/${args.providerFileKey}`,
      thumbnailUrl: null,
      alt: args.alt,
      caption: null,
      credit: null,
      kind: 'IMAGE',
      width: 1200,
      height: 800,
      bytes: 412_000,
      mimeType: 'image/webp',
      blurData: null,
      checksum: null,
    },
    select: { id: true, alt: true, uploadedById: true },
  })
}

async function checkMediaAsset(db: PrismaClient): Promise<void> {
  const area = 'MediaAsset(provider, providerFileKey)'

  console.log(`\n${area}`)

  let firstId: string | null = null

  // 1. The literal MCV-042 repro: the insert direction of the upsert.
  await expectSucceeds(area, 'upsert inserts a new asset', async () => {
    const row = await uploadCallback(db, {
      providerFileKey: 'ut-file-key-alpha',
      alt: 'A plated scallop crudo',
      uploadedById: UPLOADER_ID,
    })

    firstId = row.id
  })

  // 2. The update direction, which is also the idempotency contract the action
  //    documents: a callback that fires twice must not be an error, must not
  //    make a second row, and must not reassign the original uploader.
  await expectSucceeds(
    area,
    'a repeated callback updates the same row and keeps the uploader',
    async () => {
      const row = await uploadCallback(db, {
        providerFileKey: 'ut-file-key-alpha',
        alt: 'A plated scallop crudo, revised',
        uploadedById: OTHER_UPLOADER_ID,
      })

      if (firstId !== null && row.id !== firstId) {
        throw new Error(
          `the second callback created a new row (${row.id}) instead of updating ${firstId}`
        )
      }

      if (row.alt !== 'A plated scallop crudo, revised') {
        throw new Error(`alt was not refreshed: ${row.alt}`)
      }

      if (row.uploadedById !== UPLOADER_ID) {
        throw new Error(
          `the update direction reassigned uploadedById to ${String(row.uploadedById)}`
        )
      }

      const count = await db.mediaAsset.count({
        where: { providerFileKey: 'ut-file-key-alpha' },
      })

      if (count !== 1) {
        throw new Error(
          `expected exactly 1 row for the key, found ${String(count)}`
        )
      }
    }
  )

  // Checks 3 and 4 seed their own row with a plain `create` rather than
  // reusing the upsert's. If they leaned on check 1, a broken conflict target
  // would fail all three and only one of the failures would mean anything;
  // seeding independently keeps "the read side resolves" and "enforcement did
  // not weaken" as claims that stand or fall on their own.
  await db.mediaAsset.create({
    data: {
      url: 'https://utfs.io/f/ut-file-key-beta',
      alt: 'A whole turbot on the pass',
      mimeType: 'image/webp',
      provider: 'UPLOADTHING',
      providerFileKey: 'ut-file-key-beta',
      uploadedById: UPLOADER_ID,
    },
    select: { id: true },
  })

  // 3. The read side of the same compound key (media.ts:647 and :759).
  await expectSucceeds(
    area,
    'findUnique resolves the compound key',
    async () => {
      const row = await db.mediaAsset.findUnique({
        where: {
          provider_providerFileKey: {
            provider: 'UPLOADTHING',
            providerFileKey: 'ut-file-key-beta',
          },
        },
        select: { id: true },
      })

      if (row === null) {
        throw new Error('findUnique returned null for a row that exists')
      }
    }
  )

  // 4. Enforcement is not weaker than the partial index it replaced.
  await expectRejectedAsDuplicate(
    area,
    'a duplicate (provider, providerFileKey) is still rejected',
    async () => {
      await db.mediaAsset.create({
        data: {
          url: 'https://utfs.io/f/ut-file-key-beta',
          alt: 'A duplicate of an existing storage object',
          mimeType: 'image/webp',
          provider: 'UPLOADTHING',
          providerFileKey: 'ut-file-key-beta',
        },
        select: { id: true },
      })
    }
  )

  // 5. …and not stronger, either. This is the case MCV-007 was protecting when
  //    it reached for a partial index: EXTERNAL assets have no file key at all,
  //    and there may be any number of them. A plain unique index still admits
  //    them, because Postgres's default NULLS DISTINCT means no two NULL tuples
  //    are ever equal — which is exactly why the partial index was buying no
  //    additional enforcement here in the first place.
  await expectSucceeds(
    area,
    'many assets may still have no provider file key',
    async () => {
      for (const alt of [
        'An externally hosted hero',
        'A second external hero',
      ]) {
        await db.mediaAsset.create({
          data: {
            url: 'https://images.example.invalid/hero.jpg',
            alt,
            mimeType: 'image/jpeg',
            provider: 'EXTERNAL',
            providerFileKey: null,
          },
          select: { id: true },
        })
      }

      const count = await db.mediaAsset.count({
        where: { provider: 'EXTERNAL', providerFileKey: null },
      })

      if (count !== 2) {
        throw new Error(
          `expected 2 keyless EXTERNAL assets, found ${String(count)} — the index is rejecting NULL file keys`
        )
      }
    }
  )

  // 6. The key is genuinely compound: the same storage key under a different
  //    provider is a different object.
  await expectSucceeds(
    area,
    'the same file key under a different provider is a different asset',
    async () => {
      await db.mediaAsset.create({
        data: {
          url: 'https://s3.example.invalid/ut-file-key-beta',
          alt: 'The same key, a different provider',
          mimeType: 'image/webp',
          provider: 'S3',
          providerFileKey: 'ut-file-key-beta',
        },
        select: { id: true },
      })
    }
  )
}

// =============================================================================
// 5. The ChefAvailability scenarios
// =============================================================================

const STAFF_USER_ID = 'harness-chef'
const STAFF_PROFILE_ID = 'harness-chef-profile'

async function seedStaffProfile(db: PrismaClient): Promise<void> {
  await db.user.create({
    data: {
      id: STAFF_USER_ID,
      name: 'Harness Chef',
      email: 'chef@harness.invalid',
      role: 'CHEF_STAFF',
      staffProfile: {
        create: { id: STAFF_PROFILE_ID, title: 'Chef de cuisine' },
      },
    },
    select: { id: true },
  })
}

async function checkChefAvailability(db: PrismaClient): Promise<void> {
  const area = 'ChefAvailability (partial indexes)'

  console.log(`\n${area}`)

  await expectSucceeds(area, 'a RECURRING_WEEKLY rule inserts', async () => {
    await db.chefAvailability.create({
      data: {
        staffProfileId: STAFF_PROFILE_ID,
        kind: 'RECURRING_WEEKLY',
        dayOfWeek: 3,
        specificDate: null,
        startMinute: 600,
        endMinute: 960,
      },
      select: { id: true },
    })
  })

  await expectRejectedAsDuplicate(
    area,
    'a second identical RECURRING_WEEKLY rule is rejected',
    async () => {
      await db.chefAvailability.create({
        data: {
          staffProfileId: STAFF_PROFILE_ID,
          kind: 'RECURRING_WEEKLY',
          dayOfWeek: 3,
          specificDate: null,
          startMinute: 600,
          endMinute: 960,
        },
        select: { id: true },
      })
    }
  )

  await expectSucceeds(area, 'a DATE_OVERRIDE rule inserts', async () => {
    await db.chefAvailability.create({
      data: {
        staffProfileId: STAFF_PROFILE_ID,
        kind: 'DATE_OVERRIDE',
        dayOfWeek: null,
        specificDate: new Date('2026-03-14T00:00:00.000Z'),
        startMinute: 600,
        endMinute: 960,
      },
      select: { id: true },
    })
  })

  await expectRejectedAsDuplicate(
    area,
    'a second identical DATE_OVERRIDE rule is rejected',
    async () => {
      await db.chefAvailability.create({
        data: {
          staffProfileId: STAFF_PROFILE_ID,
          kind: 'DATE_OVERRIDE',
          dayOfWeek: null,
          specificDate: new Date('2026-03-14T00:00:00.000Z'),
          startMinute: 600,
          endMinute: 960,
        },
        select: { id: true },
      })
    }
  )

  // The two indexes are branch-scoped, and that is the whole reason a single
  // @@unique could not replace them: the RECURRING_WEEKLY and DATE_OVERRIDE
  // rows above share a staff member and a time window, and must not collide.
  await expectSucceeds(
    area,
    'the two branches do not collide on a shared time window',
    async () => {
      const rules = await db.chefAvailability.count({
        where: {
          staffProfileId: STAFF_PROFILE_ID,
          startMinute: 600,
          endMinute: 960,
        },
      })

      if (rules !== 2) {
        throw new Error(
          `expected the RECURRING_WEEKLY and DATE_OVERRIDE rules to coexist, found ${String(rules)}`
        )
      }
    }
  )

  // The discriminator CHECK is what makes the two partial indexes mutually
  // exclusive and exhaustive. Without it a row could carry both columns and be
  // covered by both indexes, or neither.
  await expectSucceeds(
    area,
    'the kind discriminator CHECK still rejects a malformed row',
    async () => {
      try {
        await db.chefAvailability.create({
          data: {
            staffProfileId: STAFF_PROFILE_ID,
            kind: 'RECURRING_WEEKLY',
            dayOfWeek: null,
            specificDate: new Date('2026-04-01T00:00:00.000Z'),
            startMinute: 60,
            endMinute: 120,
          },
          select: { id: true },
        })
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('ChefAvailability_kind_discriminator_check')
        ) {
          return
        }

        throw error
      }

      throw new Error(
        'a RECURRING_WEEKLY row with no dayOfWeek and a specificDate was accepted; the ' +
          'discriminator CHECK from 0000_init is missing, and neither partial index covers ' +
          'that row'
      )
    }
  )
}

// =============================================================================
// 6. Entry point
// =============================================================================

async function main(): Promise<void> {
  const scratch = resolveScratchDatabase()

  console.log(`scratch database: ${scratch.name}`)

  recreateScratchDatabase(scratch)
  console.log('  dropped and recreated')

  expectOk(
    run(['migrate', 'deploy'], { databaseUrl: scratch.url }),
    'prisma migrate deploy'
  )
  console.log('  full migration history applied')

  // Generate from schema.prisma every run, so this harness can never be
  // checking a stale client against a fresh database — which is the exact
  // pairing that hides a drift defect.
  expectOk(run(['generate']), 'prisma generate')
  console.log('  client regenerated from schema.prisma')

  const { PrismaClient: Client } = await import('@prisma/client')
  const db: PrismaClient = new Client({
    datasources: { db: { url: scratch.url } },
    log: [],
  })

  try {
    await seedUsers(db)
    await seedStaffProfile(db)

    await checkMediaAsset(db)
    await checkChefAvailability(db)
  } finally {
    await db.$disconnect()
  }

  console.log(`\n${'-'.repeat(72)}`)
  console.log(
    `checks: ${String(checksRun)}   failures: ${String(failures.length)}`
  )

  if (failures.length > 0) {
    console.error('\nFAILURES\n')

    for (const failure of failures) {
      console.error(
        `  ✗ ${failure.area} [${failure.label}]\n${indent(indent(failure.detail))}\n`
      )
    }

    console.error('Fix the migration or the datamodel, not the harness.')
    process.exit(1)
  }

  console.log(
    '\nPASS — every compound unique key the client addresses resolves against a database\nbuilt from prisma/migrations, and every index that is supposed to reject a duplicate\nstill does.'
  )
}

try {
  await main()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
