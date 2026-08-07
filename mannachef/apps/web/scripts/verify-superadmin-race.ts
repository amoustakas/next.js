// mannachef/apps/web/scripts/verify-superadmin-race.ts

/**
 * The MCV-031 regression: two administrators acting at the same instant may not
 * between them leave the platform with nobody in charge.
 *
 * ```bash
 * createdb mannachef_race
 * DATABASE_URL=postgresql://…/mannachef_race \
 *   pnpm --filter @mannachef/web verify:superadmin
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table this touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable — see {@link assertDisposableDatabase}.
 *
 * ## Why this one needs a real PostgreSQL
 *
 * `verify-referral-privilege.ts` can run against an in-memory fake because the
 * question it asks — does this action write the number the payload asked for —
 * is answered by the application. The question here is not. MCV-031 is a claim
 * about **what PostgreSQL permits when two transactions overlap**, and a fake
 * database's concurrency is only ever whatever its author believed
 * PostgreSQL's to be. Asserting write skew against a hand-written store would
 * be asserting the author's assumption back at itself.
 *
 * So `scripts/race-resolver.mjs` substitutes `@/server/db` for
 * `fixtures/racing-db.ts`, which is the genuine `PrismaClient` on a genuine
 * connection pool. Only the session and the three request-scoped Next.js
 * modules are stubbed. The actions, the `withAction` wrapper, the zod schemas,
 * the guards and the SQL are all real.
 *
 * ## The defect
 *
 * `wouldStrandTheKingdom` counts the *other* live super administrators and
 * refuses the change if there are none. Both callers wrapped that count and the
 * `UPDATE` it guards in `ctx.db.$transaction(fn)` — one argument, therefore
 * PostgreSQL's default `READ COMMITTED` — and the old docblock argued that
 * sharing a transaction with the write was enough to make double demotion
 * impossible. It is not. A transaction buys atomicity; it buys no mutual
 * exclusion. With two super administrators stepping down at once:
 *
 *  1. each counts the other, uncommitted, and sees one live peer;
 *  2. each updates a **different row**, so no row lock ever brings them into
 *     contact and neither blocks;
 *  3. both commit, and nobody holds `SUPER_ADMIN`.
 *
 * There is no way back from inside the application: `assignUserRole` refuses to
 * *grant* `SUPER_ADMIN` by design, so recovery means direct database access.
 *
 * ## How the two columns are produced
 *
 * By the same source file, in the same process, on the same rows. The only
 * difference is `fixtures/racing-db.ts` discarding the transaction options on
 * their way to Prisma when {@link setIsolationMode} says `legacy` — which
 * reconstitutes `$transaction(fn)` exactly, rather than approximating it. If
 * the fix were reverted, the `fixed` column would print the `legacy` one.
 *
 * ## The six scenarios
 *
 * | # | Shape                                       | Proves                             |
 * | - | ------------------------------------------- | ---------------------------------- |
 * | 1 | two self-demotions, **sequentially**        | the guard works when nothing races |
 * | 2 | two self-demotions, concurrent, `legacy`    | the exploit, against real Postgres |
 * | 3 | two self-demotions, concurrent, `fixed`     | exactly one survives               |
 * | 4 | three super admins, two concurrent          | the fix refuses nothing legitimate |
 * | 5 | a stale rank check, `legacy`                | an ADMIN closes a peer's account   |
 * | 6 | the same stale rank check, `fixed`          | the retry refuses it               |
 *
 * Scenarios 1–4 are the last-super-admin rule, which lives in
 * {@link assignUserRole}. Scenarios 5 and 6 leave that rule and take on the
 * *other* stale read in these two actions — the rank check — because that is
 * the one place `setUserActive` can be made to act on a subject whose role
 * changed underneath it. See {@link scenarioStaleRankCheck} for why the
 * last-super-admin rule itself is currently unreachable from `setUserActive`,
 * and why the isolation level there is still not optional.
 */

import assert from 'node:assert/strict'

import { assignUserRole, setUserActive } from '@/server/actions/user'
import type { ActionResult } from '@/server/actions/types'
import { prisma } from '@/server/db'

import { asUser, type HarnessUser } from './fixtures/harness-state'
import {
  arrivals,
  closeRendezvous,
  openRendezvous,
  releaseRendezvous,
  setIsolationMode,
  whenHeld,
  type IsolationMode,
} from './fixtures/race-state'

// =============================================================================
// 0. Reporting
// =============================================================================

let checks = 0
let scenario = ''

function section(title: string): void {
  scenario = title
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

/** Run one assertion block. Throws on failure, naming the scenario. */
function check(label: string, run: () => void): void {
  try {
    run()
    checks += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}`)
    console.error(`  in:  ${scenario}\n`)
    throw error
  }
}

function note(line: string): void {
  console.log(`       ${line}`)
}

/** Print what each party saw at the rendezvous, as evidence of overlap. */
function printArrivals(): void {
  for (const arrival of arrivals()) {
    note(
      `${arrival.atMs.toString().padStart(4)}ms  ${arrival.trigger}` +
        ` saw ${arrival.saw}${arrival.held ? ' — held' : ''}`
    )
  }
}

// =============================================================================
// 1. The cast
// =============================================================================

/**
 * Two super administrators, and nobody else who could appoint one.
 *
 * Ids are literal cuids because `roleAssignmentSchema` runs `cuidSchema` over
 * them before the action body is reached; a readable placeholder would be
 * rejected by validation and the scenario would prove nothing.
 */
const REGENT: HarnessUser = {
  id: 'cuserregent00000000000001',
  name: 'The Regent',
  email: 'regent@mannachef.test',
  image: null,
  role: 'SUPER_ADMIN',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: null,
  staffProfileId: null,
}

const STEWARD: HarnessUser = {
  ...REGENT,
  id: 'cusersteward0000000000002',
  name: 'The Steward',
  email: 'steward@mannachef.test',
}

const CHANCELLOR: HarnessUser = {
  ...REGENT,
  id: 'cuserchancellor000000003',
  name: 'The Chancellor',
  email: 'chancellor@mannachef.test',
}

/** An ordinary administrator — the actor in the rank-check scenario. */
const CONCIERGE: HarnessUser = {
  ...REGENT,
  id: 'cuserconcierge0000000004',
  name: 'The Concierge',
  email: 'concierge@mannachef.test',
  role: 'ADMIN',
}

/** The account whose role changes under the concierge's feet. */
const COOK: HarnessUser = {
  ...REGENT,
  id: 'cusercook000000000000005',
  name: 'A Cook',
  email: 'cook@mannachef.test',
  role: 'CHEF_STAFF',
  clientProfileId: 'cclientcook00000000000005',
}

const REASON = 'Recorded for the MCV-031 concurrency regression.'

// =============================================================================
// 2. Database plumbing
// =============================================================================

/**
 * Refuse to run anywhere that might be somebody's data.
 *
 * {@link resetDatabase} truncates the identity tables, and a harness that will
 * do that should be loud about where. Anything with `race`, `test` or
 * `harness` in the database name is taken as disposable; anything else needs
 * `MANNACHEF_RACE_ALLOW_ANY_DATABASE=1` said out loud.
 */
function assertDisposableDatabase(): string {
  const url = process.env.DATABASE_URL

  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. This regression needs a real PostgreSQL — see the file docblock.'
    )
  }

  if (process.env.MANNACHEF_RACE_ALLOW_ANY_DATABASE === '1') {
    return url
  }

  const name = databaseName(url)

  if (!/race|test|harness/i.test(name)) {
    throw new Error(
      `Refusing to empty the identity tables of a database named "${name}". ` +
        'Point DATABASE_URL at a disposable database, or set ' +
        'MANNACHEF_RACE_ALLOW_ANY_DATABASE=1 if you meant it.'
    )
  }

  return name
}

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '(none)'
  } catch {
    return '(unparseable)'
  }
}

/**
 * Empty every table this harness writes to.
 *
 * `User` cascades to `ClientProfile`, `StaffProfile` and `Session`, and
 * `ClientProfile` cascades on to `ClientNote`, so one delete is enough — but
 * the notes are cleared first anyway so that a schema change which loosened a
 * cascade would fail here rather than leave the audit assertions reading rows
 * from the previous scenario.
 */
async function resetDatabase(): Promise<void> {
  await prisma.clientNote.deleteMany({})
  await prisma.user.deleteMany({})
}

/** Insert the cast, with a `ClientProfile` where the audit trail needs one. */
async function seed(...people: readonly HarnessUser[]): Promise<void> {
  await resetDatabase()

  for (const person of people) {
    await prisma.user.create({
      data: {
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        isActive: person.isActive,
        timeZone: person.timeZone,
        locale: person.locale,
        ...(person.clientProfileId === null
          ? {}
          : {
              clientProfile: {
                create: {
                  id: person.clientProfileId,
                  displayName: person.name,
                },
              },
            }),
      },
      select: { id: true },
    })
  }
}

/** How many accounts still hold live `SUPER_ADMIN`. The invariant, in one number. */
async function liveSuperAdmins(): Promise<number> {
  const rows = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', isActive: true },
    select: { id: true },
  })

  return rows.length
}

async function roleOf(userId: string): Promise<string> {
  const rows = await prisma.user.findMany({
    where: { id: userId },
    select: { role: true, isActive: true },
  })

  const row = rows[0]

  return row === undefined
    ? 'missing'
    : `${row.role}${row.isActive ? '' : ' (closed)'}`
}

// =============================================================================
// 3. Driving the actions
// =============================================================================

type RoleResult = Awaited<ReturnType<typeof assignUserRole>>
type ActiveResult = Awaited<ReturnType<typeof setUserActive>>

/** `actor` steps down from `SUPER_ADMIN` to `ADMIN`, as themselves. */
function selfDemote(actor: HarnessUser): Promise<RoleResult> {
  return asUser(actor, () =>
    assignUserRole({
      userId: actor.id,
      role: 'ADMIN',
      reason: REASON,
    })
  )
}

/** `actor` raises `subject` to `ADMIN`. */
function promoteToAdmin(
  actor: HarnessUser,
  subject: HarnessUser
): Promise<RoleResult> {
  return asUser(actor, () =>
    assignUserRole({
      userId: subject.id,
      role: 'ADMIN',
      reason: REASON,
    })
  )
}

/** `actor` closes `subject`'s account. */
function closeAccount(
  actor: HarnessUser,
  subject: HarnessUser
): Promise<ActiveResult> {
  return asUser(actor, () =>
    setUserActive({
      userId: subject.id,
      isActive: false,
      reason: REASON,
    })
  )
}

function codeOf(result: ActionResult<unknown>): string {
  return result.ok ? 'ok' : result.code
}

function describe(results: readonly ActionResult<unknown>[]): string {
  return results.map(codeOf).join(' / ')
}

// =============================================================================
// 4. Scenario 1 — the guard works when nothing races
// =============================================================================

/**
 * The control.
 *
 * If the second sequential demotion were *not* refused, every later scenario
 * would be measuring a broken guard rather than a broken isolation level, and
 * the concurrent results would mean nothing. Run at `fixed`, because a control
 * is only useful against the code that ships.
 */
async function scenarioSequential(): Promise<void> {
  section('1. two self-demotions, one after the other — the control')

  setIsolationMode('fixed')
  await seed(REGENT, STEWARD)

  const first = await selfDemote(REGENT)
  const second = await selfDemote(STEWARD)
  const remaining = await liveSuperAdmins()

  check('the first super administrator may step down', () => {
    assert.equal(codeOf(first), 'ok')
  })

  check('the second is refused, and told why', () => {
    assert.equal(second.ok, false)
    assert.equal(codeOf(second), 'CONFLICT')
    assert.match(
      second.ok ? '' : second.error,
      /last super administrator/i,
      'the refusal should name the rule it is enforcing'
    )
  })

  check('one super administrator remains', () => {
    assert.equal(remaining, 1)
  })

  note(`outcome: ${describe([first, second])}, ${remaining} left in charge`)
}

// =============================================================================
// 5. Scenarios 2 and 3 — the same race at both isolation levels
// =============================================================================

interface RaceOutcome {
  readonly first: RoleResult
  readonly second: RoleResult
  readonly remaining: number
  /** What the two racing accounts actually hold, read back after the dust settles. */
  readonly roles: readonly string[]
}

/**
 * Both super administrators step down at the same instant.
 *
 * The rendezvous is armed on `user.count`, which is the statement inside
 * `wouldStrandTheKingdom`, and holds both parties there. So both have counted
 * their peers before either writes — the precise interleaving the old docblock
 * claimed a shared transaction ruled out.
 *
 * `Promise.all` is not merely concurrent-looking: each demotion runs in its own
 * `asUser` scope with its own session, and Prisma checks out a separate pooled
 * connection per interactive transaction, so these are two PostgreSQL backends
 * holding two open transactions at the same wall-clock moment.
 */
async function runConcurrentDemotion(
  mode: IsolationMode,
  cast: readonly [HarnessUser, HarnessUser, ...HarnessUser[]]
): Promise<RaceOutcome> {
  setIsolationMode(mode)
  await seed(...cast)
  openRendezvous({ trigger: 'user.count', hold: 2, autoRelease: true })

  const [first, second] = await Promise.all([
    selfDemote(cast[0]),
    selfDemote(cast[1]),
  ])

  closeRendezvous()

  return {
    first,
    second,
    remaining: await liveSuperAdmins(),
    roles: [await roleOf(cast[0].id), await roleOf(cast[1].id)],
  }
}

async function scenarioExploit(): Promise<RaceOutcome> {
  section('2. the same two, simultaneously, at READ COMMITTED — the exploit')

  const outcome = await runConcurrentDemotion('legacy', [REGENT, STEWARD])

  printArrivals()

  check('both demotions are accepted', () => {
    assert.equal(codeOf(outcome.first), 'ok')
    assert.equal(codeOf(outcome.second), 'ok')
  })

  check('and the platform is left with no super administrator at all', () => {
    assert.equal(outcome.remaining, 0)
  })

  check('both accounts really are ADMIN in the committed rows', () => {
    // Read back from the database rather than trusting the returned view: the
    // claim is about what committed, not about what the action said it did.
    assert.equal(outcome.roles.join(' / '), 'ADMIN / ADMIN')
  })

  note(
    `outcome: ${describe([outcome.first, outcome.second])}, ` +
      `${outcome.remaining} left in charge — the platform is locked out`
  )
  note(
    'assignUserRole refuses to grant SUPER_ADMIN, so this needs psql to undo.'
  )

  return outcome
}

async function scenarioFixed(): Promise<RaceOutcome> {
  section('3. the same two, simultaneously, at Serializable — the fix')

  const outcome = await runConcurrentDemotion('fixed', [REGENT, STEWARD])

  printArrivals()

  const codes = [codeOf(outcome.first), codeOf(outcome.second)]
  const accepted = codes.filter((code) => code === 'ok')
  const refused = codes.filter((code) => code === 'CONFLICT')

  check('exactly one demotion is accepted', () => {
    assert.equal(accepted.length, 1, `codes were ${codes.join(' / ')}`)
  })

  check('the loser is refused as a CONFLICT, not an INTERNAL', () => {
    assert.equal(refused.length, 1, `codes were ${codes.join(' / ')}`)
  })

  check('the loser is told the real reason, not "please try again"', () => {
    const loser = outcome.first.ok ? outcome.second : outcome.first

    assert.equal(loser.ok, false)
    assert.match(
      loser.ok ? '' : loser.error,
      /last super administrator/i,
      'the retry should re-read and refuse for the domain reason'
    )
  })

  check('one super administrator remains', () => {
    assert.equal(outcome.remaining, 1)
  })

  note(
    `outcome: ${describe([outcome.first, outcome.second])}, ` +
      `${outcome.remaining} left in charge`
  )

  return outcome
}

// =============================================================================
// 6. Scenario 4 — the fix must not refuse legitimate work
// =============================================================================

/**
 * Three super administrators, two of them stepping down at once.
 *
 * A fix that turned every concurrent demotion into a refusal would pass
 * scenario 3 and be useless. Serializable *does* abort one of these two — they
 * read each other's rows and write into the range each other read, exactly as
 * in scenario 3 — and the point of {@link runSerializable}'s retry is that the
 * loser's second attempt runs against a world with the winner's commit in it,
 * finds a peer still standing, and succeeds.
 *
 * So the assertion is not "no aborts happened". It is "the abort was invisible
 * to both callers", which is the only thing an administrator cares about.
 */
async function scenarioNoFalseRefusal(): Promise<void> {
  section('4. three in charge, two stepping down at once — no false refusal')

  const outcome = await runConcurrentDemotion('fixed', [
    REGENT,
    STEWARD,
    CHANCELLOR,
  ])

  printArrivals()

  check('both demotions succeed', () => {
    assert.equal(codeOf(outcome.first), 'ok')
    assert.equal(codeOf(outcome.second), 'ok')
  })

  check('the third is still in charge', () => {
    assert.equal(outcome.remaining, 1)
  })

  note(
    `outcome: ${describe([outcome.first, outcome.second])}, ` +
      `${outcome.remaining} left in charge`
  )
  note(
    'a Serializable abort happened here and was retried away — the callers ' +
      'never saw it.'
  )
}

// =============================================================================
// 7. Scenario 5 — the rank check, which is why setUserActive needs this too
// =============================================================================

/**
 * An `ADMIN` decides an account is junior to them, and it stops being junior
 * before they act on it.
 *
 * ## Why this scenario exists
 *
 * `setUserActive` also calls `wouldStrandTheKingdom`, and that call is — today
 * — unreachable. To get to it the subject must be an active `SUPER_ADMIN`, and
 * every route there is closed first: `isSelfDeactivation` blocks closing your
 * own account, and the rank rule blocks closing a peer's or a superior's, which
 * is every other `SUPER_ADMIN` since the role is the top of the hierarchy. It
 * is defence in depth, and it should stay.
 *
 * That leaves a fair question: if the last-super-admin rule cannot fire there,
 * does `setUserActive` need `Serializable` at all? It does, for the *other*
 * read it makes a decision on — the rank check — and this scenario is the
 * demonstration:
 *
 *  1. an `ADMIN` moves to close a `CHEF_STAFF` account, and reads it as
 *     `CHEF_STAFF`: junior, therefore permitted;
 *  2. held right there, a `SUPER_ADMIN` promotes that same account to `ADMIN`,
 *     and commits;
 *  3. released, the concierge writes.
 *
 * At `READ COMMITTED` step 3 succeeds and an `ADMIN` has closed a peer's
 * account — the exact privilege boundary the rank rule exists to hold. Note
 * that this is *one row*, written by both transactions, so the row lock people
 * reach for as the answer does not help: PostgreSQL simply blocks the second
 * writer, then lets it apply a decision taken against a row that no longer
 * exists in that form.
 *
 * At `Serializable` the second writer cannot update a row that changed after
 * its snapshot: `40001`, surfaced as `P2034`, retried, and the retry reads
 * `ADMIN` and refuses with `FORBIDDEN`. That is the same guard the sequential
 * case applies, restored under concurrency.
 */
async function scenarioStaleRankCheck(mode: IsolationMode): Promise<{
  readonly closure: ActiveResult
  readonly promotion: RoleResult
  readonly finalRole: string
}> {
  setIsolationMode(mode)
  await seed(REGENT, CONCIERGE, COOK)

  // Hold the *first* arrival only, and do not release it automatically: the
  // promotion that follows must be able to run to completion in the gap, and it
  // reads the same row through the same statement.
  openRendezvous({ trigger: 'user.findUnique', hold: 1, autoRelease: false })

  const closure = closeAccount(CONCIERGE, COOK)

  await whenHeld(1)

  // The concierge is now frozen holding "COOK is CHEF_STAFF, therefore junior".
  const promotion = await promoteToAdmin(REGENT, COOK)

  releaseRendezvous()

  const settled = await closure

  closeRendezvous()

  return {
    closure: settled,
    promotion,
    finalRole: await roleOf(COOK.id),
  }
}

async function scenarioStaleRankLegacy(): Promise<void> {
  section('5. a stale rank check at READ COMMITTED — an ADMIN closes a peer')

  const outcome = await scenarioStaleRankCheck('legacy')

  printArrivals()

  check('the promotion to ADMIN commits', () => {
    assert.equal(codeOf(outcome.promotion), 'ok')
  })

  check('the concierge closes the account anyway', () => {
    assert.equal(codeOf(outcome.closure), 'ok')
  })

  check('an ADMIN has closed an ADMIN — the rank rule did not hold', () => {
    assert.equal(outcome.finalRole, 'ADMIN (closed)')
  })

  note(
    `outcome: closure ${codeOf(outcome.closure)}, account ${outcome.finalRole}`
  )
}

async function scenarioStaleRankFixed(): Promise<void> {
  section('6. the same stale rank check at Serializable — refused')

  const outcome = await scenarioStaleRankCheck('fixed')

  printArrivals()

  check('the promotion to ADMIN still commits', () => {
    assert.equal(codeOf(outcome.promotion), 'ok')
  })

  check('the closure is refused as FORBIDDEN', () => {
    assert.equal(outcome.closure.ok, false)
    assert.equal(codeOf(outcome.closure), 'FORBIDDEN')
  })

  check('the refusal names the rank rule', () => {
    assert.match(
      outcome.closure.ok ? '' : outcome.closure.error,
      /at or above your own/i
    )
  })

  check('the account is an open ADMIN', () => {
    assert.equal(outcome.finalRole, 'ADMIN')
  })

  note(
    `outcome: closure ${codeOf(outcome.closure)}, account ${outcome.finalRole}`
  )
}

// =============================================================================
// 8. The report
// =============================================================================

function printReport(before: RaceOutcome, after: RaceOutcome): void {
  const rows: readonly (readonly [string, string, string])[] = [
    ['', 'READ COMMITTED', 'Serializable'],
    ['first demotion', codeOf(before.first), codeOf(after.first)],
    ['second demotion', codeOf(before.second), codeOf(after.second)],
    ['super admins left', String(before.remaining), String(after.remaining)],
    [
      'platform state',
      before.remaining === 0 ? 'locked out' : 'intact',
      after.remaining === 0 ? 'locked out' : 'intact',
    ],
  ]

  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length))
  )

  console.log('\nTwo self-demotions at the same instant\n')

  for (const [index, row] of rows.entries()) {
    console.log(
      `  ${[0, 1, 2].map((column) => (row[column] ?? '').padEnd(widths[column] ?? 0)).join('  ')}`
    )

    if (index === 0) {
      console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`)
    }
  }

  console.log(
    '\n  Both columns are the same source file, the same rows and the same' +
      '\n  PostgreSQL. The only difference is whether the transaction options' +
      '\n  the action asked for reached Prisma.'
  )
}

// =============================================================================
// 9. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log('MCV-031 — the last super administrator may not be raced away')
  console.log(`database: ${name}`)

  await scenarioSequential()

  const before = await scenarioExploit()
  const after = await scenarioFixed()

  await scenarioNoFalseRefusal()
  await scenarioStaleRankLegacy()
  await scenarioStaleRankFixed()

  printReport(before, after)

  console.log(`\nPASS — ${checks} assertions, 0 failures.`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    closeRendezvous()
    void prisma.$disconnect()
  })
