// mannachef/apps/web/scripts/fixtures/racing-db.ts

/**
 * Stands in for `@/server/db` in the MCV-031 race harness.
 *
 * Unlike `db-stub.ts`, **this is a real database**. There is no fake, no
 * in-memory store and no hand-written query engine: `prisma` below is the
 * genuine `PrismaClient` from `@mannachef/db`, talking to a genuine PostgreSQL
 * over a genuine connection pool. It has to be. The defect under test is a
 * property of PostgreSQL's isolation levels — write skew that `READ COMMITTED`
 * permits and Serializable Snapshot Isolation refuses — and no fake can be
 * evidence about it, because a fake's concurrency is whatever its author
 * believed PostgreSQL's to be.
 *
 * Two things are layered on top of the real client, and neither changes a
 * single statement the code under test issues:
 *
 *  1. **`$transaction` may have its options discarded**, when
 *     {@link isolationMode} says `legacy`. That reproduces the pre-MCV-031
 *     source exactly — `ctx.db.$transaction(fn)`, one argument — rather than
 *     approximating it, so the "before" column of the transcript is produced by
 *     the same handler body as the "after" column.
 *  2. **`User.findUnique` and `User.count` trip the rendezvous**, via Prisma
 *     client extensions, so the harness rather than luck decides how the two
 *     transactions interleave. Those two statements are the two points at which
 *     an action has read something and not yet acted on it, which is the whole
 *     of the vulnerability. See `race-state.ts` for the two shapes this is used
 *     in.
 *
 * The extensions fire on those two model methods and nothing else, and
 * {@link reachRendezvous} returns immediately unless a rendezvous is armed for
 * that exact trigger — so the harness's own bookkeeping queries run at full
 * speed and are never held.
 *
 * `Prisma` and `PrismaClient` are re-exported straight from `@mannachef/db`,
 * for the reason `db-stub.ts` gives: `withAction`'s error mapper does
 * `error instanceof Prisma.PrismaClientKnownRequestError`, and `P2034` reaching
 * a home-made class of that name would make {@link runSerializable}'s retry
 * silently dead.
 */

import { prisma as realPrisma, type PrismaClient } from '@mannachef/db'

import { isolationMode, reachRendezvous } from './race-state'

export { Prisma, PrismaClient } from '@mannachef/db'

/**
 * The real client, with a query hook on each of the two statements a
 * transaction can be usefully frozen at.
 *
 * Both actions under test open with `tx.user.findUnique` on the subject, and
 * `wouldStrandTheKingdom` is the only `tx.user.count` either of them issues. So
 * these two hooks between them cover every point where a decision has been read
 * and not yet written — and nothing else is touched.
 */
const instrumented = realPrisma.$extends({
  query: {
    user: {
      async findUnique({ args, query }) {
        const subject: unknown = await query(args)

        await reachRendezvous('user.findUnique', describeSubject(subject))

        return subject
      },
      async count({ args, query }) {
        const peers: unknown = await query(args)

        await reachRendezvous(
          'user.count',
          typeof peers === 'number' ? `${peers} live peer(s)` : 'a non-number'
        )

        return peers
      },
    },
  },
})

/**
 * Render a subject row for the transcript.
 *
 * Role and activation only — the two columns every refusal in `actions/user.ts`
 * turns on. Deliberately never the email address: `CONTRACT.md` §5 forbids
 * logging one, and a harness that prints what production may not is a harness
 * whose output nobody can paste into a ticket.
 */
function describeSubject(subject: unknown): string {
  if (subject === null || typeof subject !== 'object') {
    return 'no such account'
  }

  const row = subject as {
    readonly role?: unknown
    readonly isActive?: unknown
  }
  const role = typeof row.role === 'string' ? row.role : 'unknown role'

  return row.isActive === false ? `${role}, closed` : `${role}, active`
}

type TransactionArgument = Parameters<PrismaClient['$transaction']>[0]
type TransactionOptions = Parameters<PrismaClient['$transaction']>[1]

/**
 * The client the code under test is handed.
 *
 * A `Proxy` rather than a subclass because `PrismaClient` is itself a proxy
 * over a generated engine: everything but `$transaction` must reach the real
 * implementation untouched, and forwarding by hand would mean enumerating a
 * surface that changes with the schema.
 */
export const prisma = new Proxy(instrumented, {
  get(target, property, receiver): unknown {
    if (property !== '$transaction') {
      const value: unknown = Reflect.get(target, property, receiver)

      // Bound to the target: the engine reads private fields off `this`, and a
      // method invoked with the proxy as its receiver would not find them.
      return typeof value === 'function' ? value.bind(target) : value
    }

    return (argument: TransactionArgument, options?: TransactionOptions) => {
      // `legacy` passes no second argument at all, which is the literal shape
      // of the call this task exists to fix — not a downgraded imitation of it.
      const effective = isolationMode() === 'legacy' ? undefined : options

      return target.$transaction(
        argument as Parameters<typeof target.$transaction>[0],
        effective
      )
    }
  },
}) as unknown as PrismaClient
