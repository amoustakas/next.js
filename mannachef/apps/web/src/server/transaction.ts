// mannachef/apps/web/src/server/transaction.ts

/**
 * Serializable transaction plumbing, shared by every action that guards a
 * decision it made from a read.
 *
 * ## What this is for
 *
 * A transaction is not, on its own, a mutual exclusion device. PostgreSQL's
 * default isolation level is `READ COMMITTED`, and at that level two concurrent
 * transactions may each run the *same* `SELECT`, each see a world in which
 * their write is safe, each then `UPDATE` a *different* row — so no row lock
 * ever brings them into contact — and both commit. Every constraint that lives
 * in the gap between a count and an update is invisible to the database and is
 * therefore not enforced by the transaction at all. Wrapping such a check in
 * `$transaction` with no options buys atomicity and buys nothing else.
 *
 * `Serializable` is what closes that gap. PostgreSQL's SSI takes predicate
 * locks over the *ranges* a transaction reads, notices the read-write
 * dependency cycle between two transactions that each read what the other was
 * about to write, and aborts one of them with `40001` — which Prisma surfaces
 * as `P2034`. The loser never commits, so the invariant the `SELECT` was
 * checking survives.
 *
 * ## Why the abort is retried rather than reported
 *
 * A serialization failure is not a fault. It is the isolation level doing the
 * job it was chosen for, and the documented remedy is to run the whole
 * transaction again. The retry re-reads a world that now contains the winner's
 * commit, so the second attempt either succeeds honestly or refuses for a real
 * domain reason — the last-super-admin refusal, the taken booking slot — rather
 * than showing somebody "something went wrong on our end" for being a fraction
 * of a second late.
 *
 * Only once the retries are spent does the caller's own `conflictMessage`
 * surface, as a `CONFLICT` and never an `INTERNAL`, because nothing internal
 * went wrong.
 *
 * ## Why it lives here rather than in an action module
 *
 * It was written for `actions/booking.ts` and is now also the mechanism behind
 * the last-super-admin rule in `actions/user.ts`. Two callers means one
 * definition: an action file carries `'use server'`, which makes every export a
 * remotely-callable endpoint, so a helper shared between two of them cannot
 * live in either. This module is a plain server module — a peer of `db.ts`,
 * `guards.ts` and `scheduling.ts` — and exports no Server Action.
 */

import { ActionError } from '@/server/actions/types'
import { Prisma, type PrismaClient } from '@/server/db'

// =============================================================================
// 0. Defaults
// =============================================================================

/** How many times a `Serializable` abort is retried before the caller is told. */
const SERIALIZATION_RETRIES = 3

/** Backoff between those retries. Short: the winner has already committed. */
const SERIALIZATION_BACKOFF_MS = 25

/**
 * How long one attempt may hold its snapshot open.
 *
 * Fixed rather than a parameter, because no caller has wanted a different one
 * and an option nobody passes is an option nobody has tested. `availability.ts`
 * opens its own `Serializable` transaction with a 30-second budget for a bulk
 * slot-generation pass; if that is ever folded in here, this becomes an
 * argument at that point and not before.
 */
const SERIALIZATION_TIMEOUT_MS = 15_000

// =============================================================================
// 1. The runner
// =============================================================================

/**
 * Run `run` in a `Serializable` transaction, retrying it if PostgreSQL aborts
 * it for serialization.
 *
 * `conflictMessage` is what the caller sees if every attempt aborts, and it is
 * a required argument rather than a default because the sentence belongs to the
 * domain, not to the plumbing: a guest who lost a race for a Saturday sitting
 * and an administrator who lost a race to step down are owed different
 * apologies, and a shared default would silently give one of them the other's.
 *
 * Anything `run` throws that is *not* a serialization failure — an
 * {@link ActionError} raised deliberately to roll the transaction back, a
 * genuine database fault — propagates unchanged and unretried on the first
 * attempt.
 */
export async function runSerializable<T>(
  db: PrismaClient,
  conflictMessage: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      // The parameter is the *root* client rather than `Prisma.TransactionClient`
      // on purpose: `$transaction` is denied on an interactive client, so
      // asking for the root type is what makes an accidental nested
      // transaction a compile error instead of a runtime one.
      return await db.$transaction(run, {
        isolationLevel: 'Serializable',
        timeout: SERIALIZATION_TIMEOUT_MS,
      })
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === SERIALIZATION_RETRIES) {
        lastError = error
        break
      }

      await sleep(SERIALIZATION_BACKOFF_MS * (attempt + 1))
    }
  }

  if (isSerializationFailure(lastError)) {
    throw new ActionError('CONFLICT', conflictMessage)
  }

  throw lastError
}

/** Is this the isolation level talking, rather than a fault? */
function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034 is Prisma's "write conflict or deadlock"; P2028 is a transaction
    // that expired while the retry was waiting for its turn.
    return error.code === 'P2034' || error.code === 'P2028'
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
