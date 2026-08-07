// mannachef/apps/web/scripts/verify-media-upload.ts

/**
 * The MCV-042 regression, driven through the real Server Action.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL=postgresql://…/mannachef_harness \
 *   pnpm --filter @mannachef/web verify:media
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table this touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable — `fixtures/database.ts`, shared with the MCV-031, MCV-040
 * and MCV-041 harnesses.
 *
 * ## The defect
 *
 * `completeMediaUpload` is the only way an asset enters the library, and it ends
 * in an upsert keyed on the storage identity:
 *
 * ```ts
 * tx.mediaAsset.upsert({
 *   where: { provider_providerFileKey: { provider, providerFileKey } },
 *   …
 * })
 * ```
 *
 * `@@unique([provider, providerFileKey])` in `schema.prisma` is what puts
 * `provider_providerFileKey` in `MediaAssetWhereUniqueInput`, and it is also
 * what makes that call compile to `INSERT … ON CONFLICT ("provider",
 * "providerFileKey") DO UPDATE`. But `0000_init` did not create that index. It
 * created a **partial** one, scoped to `WHERE "providerFileKey" IS NOT NULL`,
 * and PostgreSQL will not infer an `ON CONFLICT` target from a bare column list
 * to a partial index. Every call therefore ended in
 *
 *   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
 *          specification
 *
 * on every database built from the migration history — which is every database
 * that was not hand-made with `prisma db push`. Media upload was dead on
 * arrival, platform-wide, with a green test suite behind it, because nothing in
 * that suite drove this action against a real PostgreSQL.
 *
 * ## Why a real PostgreSQL, and why the whole action
 *
 * Both halves matter here, and neither is optional.
 *
 * A fake database cannot see this defect *at all*: the defect is not that the
 * application asks for the wrong thing, it is that PostgreSQL refuses what the
 * application asks for. A hand-written store's `upsert` is a map lookup, and it
 * would have happily returned a row.
 *
 * And a raw `prisma.mediaAsset.upsert(…)` written by the harness would only
 * prove that *some* upsert works. What is under test is the one the action
 * issues — inside `ctx.db.$transaction`, after the guard, after the zod
 * transform decides `provider` and `providerFileKey`. So the harness calls
 * `completeMediaUpload` with the payload an UploadThing client callback
 * produces and reads the `ActionResult` back. `packages/db`'s
 * `verify:conflict-targets` covers the same key at the schema level, from the
 * other side; this file covers the path an administrator actually takes.
 *
 * ## What is substituted
 *
 * `scripts/action-resolver.mjs`'s four specifiers: the session, and the three
 * request-scoped Next.js modules `guards.ts` imports at module scope.
 * `@/server/db` is **not** among them — the action gets the ordinary
 * `PrismaClient` on the ordinary connection. The action, the `withAction`
 * wrapper, the zod schemas, the guards, the rate limiter, the transaction and
 * the SQL are all real.
 */

import { completeMediaUpload } from '@/server/actions/media'
import { prisma } from '@/server/db'

import { assertDisposableDatabase, clearRateLimits } from './fixtures/database'
import { check, checkCount, note, printTable, section } from './fixtures/report'
import { signInAs, type HarnessUser } from './fixtures/harness-state'

// =============================================================================
// 1. The cast
// =============================================================================

const CURATOR: HarnessUser = {
  id: 'media-harness-curator',
  name: 'Ines Okonkwo',
  email: 'ines@harness.invalid',
  image: null,
  role: 'ADMIN',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: null,
  staffProfileId: null,
}

const GUEST: HarnessUser = {
  id: 'media-harness-guest',
  name: 'A signed-in client',
  email: 'guest@harness.invalid',
  image: null,
  role: 'CLIENT',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: null,
  staffProfileId: null,
}

/** The storage key the provider handed back. The whole defect turns on this pair. */
const FILE_KEY = 'ut-harness-3f9c1a7e-scallop-crudo'

// =============================================================================
// 2. Database plumbing
// =============================================================================

async function resetDatabase(): Promise<void> {
  // `MediaAsset.uploadedBy` is `onDelete: SetNull`, not a cascade, so deleting
  // the users would leave the assets behind with a null uploader — which is
  // exactly the state a later scenario must not be able to read as "the
  // original uploader was preserved". Assets go first, explicitly.
  await prisma.mediaTag.deleteMany({})
  await prisma.mediaAsset.deleteMany({})
  await prisma.tag.deleteMany({})
  await prisma.user.deleteMany({})
}

async function seed(): Promise<string> {
  await resetDatabase()

  for (const person of [CURATOR, GUEST]) {
    await prisma.user.create({
      data: {
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        isActive: person.isActive,
        timeZone: person.timeZone,
        locale: person.locale,
      },
      select: { id: true },
    })
  }

  const tag = await prisma.tag.create({
    data: {
      slug: 'harness-shellfish',
      name: 'Shellfish',
      kind: 'ALLERGEN',
    },
    select: { id: true },
  })

  return tag.id
}

// =============================================================================
// 3. Driving the action
// =============================================================================

type UploadResult = Awaited<ReturnType<typeof completeMediaUpload>>

/**
 * One UploadThing client callback, forwarded verbatim.
 *
 * `mediaAssetFromUploadSchema` is what turns this into the `provider` /
 * `providerFileKey` pair the upsert keys on, so the payload is given in the
 * shape the browser sends rather than the shape the handler consumes — a
 * harness that pre-computed the compound key would be skipping the code that
 * decides it.
 */
function uploadCallback(args: {
  readonly alt: string
  readonly tagIds: readonly string[]
}): Promise<UploadResult> {
  return completeMediaUpload({
    upload: {
      key: FILE_KEY,
      url: `https://utfs.io/f/${FILE_KEY}`,
      name: 'scallop-crudo.webp',
      size: 412_004,
      type: 'image/webp',
    },
    alt: args.alt,
    width: 1600,
    height: 1067,
    tagIds: [...args.tagIds],
  })
}

function describe(result: UploadResult): string {
  return result.ok
    ? `ok (created: ${String(result.data.created)}, tags: ${String(result.data.tagCount)})`
    : `${result.code}: ${result.error}`
}

// =============================================================================
// 4. The scenarios
// =============================================================================

async function main(): Promise<void> {
  const database = assertDisposableDatabase()

  console.log(`MCV-042 — completeMediaUpload against PostgreSQL "${database}"`)

  const tagId = await seed()
  const rows: string[][] = [['scenario', 'result', 'assets in library']]

  // ---------------------------------------------------------------------------
  section('1. The upload the whole library depends on')
  // ---------------------------------------------------------------------------

  clearRateLimits()
  signInAs(CURATOR)

  const first = await uploadCallback({
    alt: 'A scallop crudo, dressed at the pass',
    tagIds: [tagId],
  })

  note(`first callback: ${describe(first)}`)

  check('the action succeeds', () => {
    if (!first.ok) {
      throw new Error(
        first.code === 'INTERNAL'
          ? 'MCV-042: the upsert could not resolve its ON CONFLICT target. ' +
              '@@unique([provider, providerFileKey]) in schema.prisma is not created as a ' +
              'plain unique index by prisma/migrations — check packages/db verify:drift.'
          : `expected ok, got ${first.code}: ${first.error}`
      )
    }
  })

  check('it reports the asset as newly created', () => {
    if (!first.ok || !first.data.created) {
      throw new Error('expected created: true on the first callback')
    }
  })

  const firstId = first.ok ? first.data.id : null

  const stored = await prisma.mediaAsset.findMany({
    where: { providerFileKey: FILE_KEY },
    select: { id: true, alt: true, uploadedById: true, provider: true },
  })

  check('exactly one row carries the storage key', () => {
    if (stored.length !== 1) {
      throw new Error(`expected 1 row, found ${String(stored.length)}`)
    }
  })

  check('it is filed under the provider that issued the key', () => {
    if (stored[0]?.provider !== 'UPLOADTHING') {
      throw new Error(`provider is ${String(stored[0]?.provider)}`)
    }
  })

  check('the uploader is recorded', () => {
    if (stored[0]?.uploadedById !== CURATOR.id) {
      throw new Error(`uploadedById is ${String(stored[0]?.uploadedById)}`)
    }
  })

  const attachedTags = await prisma.mediaTag.count({
    where: { mediaAsset: { providerFileKey: FILE_KEY } },
  })

  check('the tag was attached to the new asset', () => {
    if (!first.ok || first.data.tagCount !== 1) {
      throw new Error('the action did not report a tag')
    }

    if (attachedTags !== 1) {
      throw new Error(`expected 1 MediaTag row, found ${String(attachedTags)}`)
    }
  })

  rows.push([
    'first callback',
    describe(first),
    String(await prisma.mediaAsset.count({})),
  ])

  // ---------------------------------------------------------------------------
  section('2. The same callback again — the reason it is an upsert')
  // ---------------------------------------------------------------------------

  clearRateLimits()
  signInAs(CURATOR)

  const second = await uploadCallback({
    alt: 'A scallop crudo, dressed at the pass — revised description',
    tagIds: [tagId],
  })

  note(`second callback: ${describe(second)}`)

  check('a repeated callback is not an error', () => {
    if (!second.ok) {
      throw new Error(
        `a retried upload was reported as ${second.code}: ${second.error}`
      )
    }
  })

  check('it reports the asset as pre-existing', () => {
    if (!second.ok || second.data.created) {
      throw new Error('expected created: false on the second callback')
    }
  })

  check('it updated the same row rather than making a second', () => {
    if (!second.ok || second.data.id !== firstId) {
      throw new Error(
        `expected id ${String(firstId)}, got ${second.ok ? second.data.id : 'n/a'}`
      )
    }
  })

  const afterSecond = await prisma.mediaAsset.findMany({
    where: { providerFileKey: FILE_KEY },
    select: { id: true, alt: true, uploadedById: true },
  })

  check('the library still holds one asset for that key', () => {
    if (afterSecond.length !== 1) {
      throw new Error(`expected 1 row, found ${String(afterSecond.length)}`)
    }
  })

  check('the description was refreshed', () => {
    if (
      afterSecond[0]?.alt !==
      'A scallop crudo, dressed at the pass — revised description'
    ) {
      throw new Error(`alt is ${String(afterSecond[0]?.alt)}`)
    }
  })

  check('the original uploader was kept, not reassigned', () => {
    if (afterSecond[0]?.uploadedById !== CURATOR.id) {
      throw new Error(`uploadedById is ${String(afterSecond[0]?.uploadedById)}`)
    }
  })

  rows.push([
    'second callback',
    describe(second),
    String(await prisma.mediaAsset.count({})),
  ])

  // ---------------------------------------------------------------------------
  section('3. The role gate is still the role gate')
  // ---------------------------------------------------------------------------

  // The two scenarios above are the ones MCV-042 is about, and both of them
  // pass trivially if the guard were removed and the handler simply ran. This
  // scenario is what keeps them honest: the action under test is still the
  // guarded one.
  clearRateLimits()
  signInAs(GUEST)

  const refused = await uploadCallback({
    alt: 'A client trying to file an asset',
    tagIds: [],
  })

  note(`as CLIENT: ${describe(refused)}`)

  check('a CLIENT cannot file an asset', () => {
    if (refused.ok) {
      throw new Error('a CLIENT was allowed to write to the media library')
    }

    if (refused.code !== 'FORBIDDEN') {
      throw new Error(`expected FORBIDDEN, got ${refused.code}`)
    }
  })

  clearRateLimits()
  signInAs(null)

  const anonymous = await uploadCallback({
    alt: 'A stranger trying to file an asset',
    tagIds: [],
  })

  note(`signed out: ${describe(anonymous)}`)

  check('a signed-out caller cannot file an asset', () => {
    if (anonymous.ok) {
      throw new Error('a signed-out caller was allowed to write to the library')
    }

    if (anonymous.code !== 'UNAUTHENTICATED') {
      throw new Error(`expected UNAUTHENTICATED, got ${anonymous.code}`)
    }
  })

  rows.push([
    'as CLIENT',
    describe(refused),
    String(await prisma.mediaAsset.count({})),
  ])
  rows.push([
    'signed out',
    describe(anonymous),
    String(await prisma.mediaAsset.count({})),
  ])

  printTable(
    'completeMediaUpload against a database built from prisma/migrations',
    rows,
    'Before MCV-042 every row in the first column read\n' +
      '  INTERNAL: 42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification.'
  )

  console.log(`\n${'-'.repeat(72)}`)
  console.log(`assertions: ${String(checkCount())}   failures: 0`)
  console.log(
    '\nPASS — completeMediaUpload files an asset, is idempotent across a repeated callback,\nand is still refused to everyone below ADMIN.'
  )
}

try {
  await main()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
