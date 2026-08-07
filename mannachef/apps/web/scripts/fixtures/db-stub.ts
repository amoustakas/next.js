// mannachef/apps/web/scripts/fixtures/db-stub.ts

/**
 * Stands in for `@/server/db` at runtime.
 *
 * `prisma` is the in-memory fake from `./fake-db`, created as this module loads
 * because `guards.ts` and every action module bind the export at import time.
 * It is registered with `harness-state` in the same breath so the assertions
 * can read back what the actions wrote without importing this file — which they
 * must not do, or they would get a second copy.
 *
 * `Prisma` is the **real** namespace from `@mannachef/db`, not a stub. Two
 * places in the code under test do `error instanceof
 * Prisma.PrismaClientKnownRequestError`, and a home-made class of that name
 * would make both comparisons trivially false without anybody noticing.
 * Importing it constructs a `PrismaClient` that is never queried; the harness
 * sets a syntactically valid `DATABASE_URL` so that construction succeeds, and
 * no connection is ever opened.
 */

import { createFakeDatabase, emptyStore } from './fake-db'
import { registerDatabase } from './harness-state'

export { Prisma, PrismaClient } from '@mannachef/db'

const database = createFakeDatabase(emptyStore())

registerDatabase(database)

export const prisma = database.client
