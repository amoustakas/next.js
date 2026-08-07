// mannachef/apps/web/scripts/fixtures/database.ts

/**
 * The two things every harness that empties tables has to agree about: which
 * databases are disposable, and how to put `guards.ts`'s rate limiter back.
 *
 * Extracted from `intake-harness.ts` for MCV-041, unchanged. Two harnesses
 * disagreeing about which databases may be emptied would be worse than either
 * rule on its own, and MCV-041 adds a second reason to care about the limiter:
 * `subscription.change` is rate limited now, at twelve an hour per identity,
 * and the proration harness makes more calls than that.
 */

/**
 * Refuse to run anywhere that might be somebody's data.
 *
 * A harness that empties tables should be loud about where. The escape hatch is
 * deliberate and deliberately awkward to type.
 */
export function assertDisposableDatabase(): string {
  const url = process.env.DATABASE_URL

  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. These regressions need a real PostgreSQL — see the harness docblock.'
    )
  }

  if (process.env.MANNACHEF_RACE_ALLOW_ANY_DATABASE === '1') {
    return url
  }

  const name = databaseName(url)

  if (!/race|test|harness/i.test(name)) {
    throw new Error(
      `Refusing to empty the tables of a database named "${name}". ` +
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
 * Empty `guards.ts`'s token buckets.
 *
 * Outside a request scope every signed-out caller collapses onto one bucket
 * keyed `…:ip:unknown`, and a signed-in one onto `…:user:<id>`. Rate limiting is
 * not what any of these harnesses is about, so a scenario needing one call more
 * than the bucket holds empties it rather than sleeping for an hour.
 *
 * The map is the real one: `guards.ts` parks it on `globalThis` so it survives
 * HMR, and reading it back from there is how this reaches the same instance the
 * wrapper consults. Nothing is replaced or wrapped, so the limiter the actions
 * run through is the limiter that ships.
 */
export function clearRateLimits(): void {
  const global = globalThis as unknown as {
    mannachefRateLimitBuckets?: Map<string, unknown> | undefined
  }

  global.mannachefRateLimitBuckets?.clear()
}
