// mannachef/apps/web/src/server/db.ts

/**
 * Ergonomic re-export of the Prisma singleton.
 *
 * `packages/db` owns the client: it is the module that survives HMR by parking
 * the instance on `globalThis`, and it is the module that decides the log
 * level. Nothing in `apps/web` should ever call `new PrismaClient()`.
 *
 * This file exists purely so that server code can write
 *
 * ```ts
 * import { prisma } from '@/server/db'
 * ```
 *
 * next to its other `@/server/*` imports instead of reaching across to the
 * workspace package specifier. Both spellings resolve to the same instance —
 * `@mannachef/db` is transpiled by Next (see `next.config.ts`
 * `transpilePackages`) and is evaluated exactly once per process.
 *
 * `verbatimModuleSyntax` is on, so the type-only names are re-exported with
 * `export type`. `Prisma` is a namespace carrying both values (the error
 * classes, `Prisma.sql`, the enum objects) and types, so it is re-exported as a
 * value.
 */

export { prisma, Prisma, PrismaClient } from '@mannachef/db'
