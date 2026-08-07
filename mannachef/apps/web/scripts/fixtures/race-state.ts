// mannachef/apps/web/scripts/fixtures/race-state.ts

/**
 * The dials `verify-superadmin-race.ts` turns, and the window `racing-db.ts`
 * opens for it.
 *
 * Kept in its own module for the same reason as `harness-state.ts`: the thing
 * that reads these values is the substituted `@/server/db`, and the thing that
 * writes them is the harness, and the two must be looking at one instance.
 *
 * ## The isolation dial
 *
 * {@link isolationMode} decides whether the transaction options an action asks
 * for are honoured or discarded. Discarding them is not a *simulation* of the
 * vulnerable code — it **is** the vulnerable code. The whole of MCV-031's
 * defect was `ctx.db.$transaction(fn)` with no second argument, and Prisma with
 * no second argument is exactly PostgreSQL's default `READ COMMITTED`. Same
 * handler body, same statements, same order; one argument's difference. That is
 * what lets the "before" and "after" columns of the transcript be produced by
 * the same source file in the same process.
 *
 * ## The rendezvous
 *
 * Two transactions left to their own devices will usually miss each other —
 * each is a couple of milliseconds long — and a race that reproduces one run in
 * a thousand is not evidence of anything. The rendezvous holds a transaction at
 * a chosen statement so the interleaving is decided by the harness rather than
 * by luck. It changes *when* statements run, never *which*.
 *
 * Two shapes are needed, so the primitive covers both:
 *
 *  - **Symmetric** (`hold: 2, autoRelease: true`) — both parties are held at
 *    the same statement and released together the instant the second arrives.
 *    This is the last-super-admin race: both must have counted their peers
 *    before either writes.
 *  - **Asymmetric** (`hold: 1, autoRelease: false`) — the first arrival is
 *    parked and the harness decides when it may continue, so a second actor can
 *    be run to completion in the gap. This is the rank-check race: one
 *    administrator's view of an account must go stale *while they are looking
 *    at it*.
 *
 * Arrivals beyond `hold` pass straight through, and so does everything once the
 * held parties are released. That is what makes `runSerializable`'s retry work:
 * the loser's second attempt has to be free to run to completion alone.
 */

// =============================================================================
// 0. Isolation
// =============================================================================

/** Whether an action's transaction options survive the trip to Prisma. */
export type IsolationMode =
  /** Options discarded — `READ COMMITTED`. The behaviour MCV-031 reported. */
  | 'legacy'
  /** Options honoured — `Serializable`. The behaviour MCV-031 asks for. */
  | 'fixed'

let isolation: IsolationMode = 'fixed'

export function setIsolationMode(mode: IsolationMode): void {
  isolation = mode
}

export function isolationMode(): IsolationMode {
  return isolation
}

// =============================================================================
// 1. The rendezvous
// =============================================================================

/**
 * The statement a transaction is held at.
 *
 * Named after the Prisma call rather than after its meaning, because that is
 * what `racing-db.ts` can actually observe. What each one means to the code
 * under test:
 *
 *  - `user.findUnique` — the subject row has been read and no decision has been
 *    taken on it yet. Both actions open with this.
 *  - `user.count` — `wouldStrandTheKingdom` has counted the live peers and is
 *    about to return its verdict. Only reached when the subject is an active
 *    `SUPER_ADMIN`.
 */
export type RendezvousTrigger = 'user.findUnique' | 'user.count'

export interface RendezvousConfig {
  readonly trigger: RendezvousTrigger
  /** How many arrivals are parked. Later ones pass straight through. */
  readonly hold: number
  /** Release the parked parties as soon as `hold` of them are waiting. */
  readonly autoRelease: boolean
}

/** One arrival, in the order it happened. */
export interface Arrival {
  readonly trigger: RendezvousTrigger
  /** What the statement returned, rendered for the transcript. */
  readonly saw: string
  /** Milliseconds since the rendezvous opened. */
  readonly atMs: number
  /** `false` when the arrival passed straight through unheld. */
  readonly held: boolean
}

interface Rendezvous {
  readonly config: RendezvousConfig
  readonly openedAt: number
  readonly arrivals: Arrival[]
  readonly waiting: Array<() => void>
  readonly heldWatchers: Array<{
    readonly count: number
    readonly ready: () => void
  }>
  released: boolean
  timer: NodeJS.Timeout | null
}

let current: Rendezvous | null = null

/**
 * The arrivals of the most recently closed rendezvous.
 *
 * Closing has to release anybody still parked, but the transcript is printed
 * *after* the scenario has settled — so the record outlives the window it was
 * collected through.
 */
let lastArrivals: readonly Arrival[] = []

/**
 * How long a parked transaction waits before giving up and continuing.
 *
 * A safety net, not a mechanism. If it fires, the run is telling you that a
 * party never reached the statement it was expected at — better surfaced as a
 * failed assertion downstream than as a harness that hangs forever.
 */
const RENDEZVOUS_TIMEOUT_MS = 10_000

/** Arm the rendezvous. Replaces and releases any open one. */
export function openRendezvous(config: RendezvousConfig): void {
  closeRendezvous()

  current = {
    config,
    openedAt: Date.now(),
    arrivals: [],
    waiting: [],
    heldWatchers: [],
    released: false,
    timer: null,
  }
}

/** Let the parked parties continue. The rendezvous stays open but spent. */
export function releaseRendezvous(): void {
  if (current !== null) {
    release(current)
  }
}

/** Disarm entirely, releasing anybody still parked. */
export function closeRendezvous(): void {
  if (current === null) {
    return
  }

  release(current)
  lastArrivals = [...current.arrivals]
  current = null
}

/** Every arrival at the open rendezvous, or at the last one to be closed. */
export function arrivals(): readonly Arrival[] {
  return current?.arrivals ?? lastArrivals
}

/**
 * Resolve once `count` parties are parked.
 *
 * The asymmetric shape needs this: the harness cannot start the second actor
 * until the first is demonstrably frozen mid-decision, and sleeping for a
 * plausible-looking interval would put the timing back in the hands of luck.
 */
export function whenHeld(count: number): Promise<void> {
  const open = current

  if (open === null || open.released || open.waiting.length >= count) {
    return Promise.resolve()
  }

  return new Promise<void>((ready) => {
    open.heldWatchers.push({ count, ready })
  })
}

/**
 * Called by `racing-db.ts` the instant an instrumented statement has resolved.
 *
 * Records the arrival, then parks the caller if the rendezvous is armed for
 * this trigger and has not yet taken its full complement.
 */
export async function reachRendezvous(
  trigger: RendezvousTrigger,
  saw: string
): Promise<void> {
  const open = current

  if (open === null || open.config.trigger !== trigger) {
    return
  }

  const atMs = Date.now() - open.openedAt
  const parkable = !open.released && open.waiting.length < open.config.hold

  open.arrivals.push({ trigger, saw, atMs, held: parkable })

  if (!parkable) {
    return
  }

  await new Promise<void>((resume) => {
    open.waiting.push(resume)

    open.timer ??= setTimeout(() => {
      release(open)
    }, RENDEZVOUS_TIMEOUT_MS)

    notifyWatchers(open)

    if (open.config.autoRelease && open.waiting.length >= open.config.hold) {
      release(open)
    }
  })
}

function notifyWatchers(open: Rendezvous): void {
  const parked = open.waiting.length

  for (let index = open.heldWatchers.length - 1; index >= 0; index -= 1) {
    const watcher = open.heldWatchers[index]

    if (watcher !== undefined && parked >= watcher.count) {
      open.heldWatchers.splice(index, 1)
      watcher.ready()
    }
  }
}

function release(open: Rendezvous): void {
  if (open.released) {
    return
  }

  open.released = true

  if (open.timer !== null) {
    clearTimeout(open.timer)
    open.timer = null
  }

  for (const watcher of open.heldWatchers.splice(0)) {
    watcher.ready()
  }

  for (const resume of open.waiting.splice(0)) {
    resume()
  }
}
