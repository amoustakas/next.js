// mannachef/apps/web/src/server/referral-claim.ts

/**
 * A referral typed into a public form is a **claim**, not a redemption
 * (MCV-050).
 *
 * ## The class of defect this module exists to end
 *
 * Three consecutive audit rounds produced the same money hole from the same
 * door, each time with a narrower guard bolted onto it:
 *
 *  1. **MCV-030** — a `CLIENT` set their own reward amount. Fixed by taking the
 *     terms from the standing offer (`@/server/referral-program`).
 *  2. **MCV-040 finding A** — an anonymous caller staked a redemption against an
 *     *existing* household by typing its address. Fixed by making
 *     `resolveIdentity` report `created | matched` and refusing `matched`.
 *  3. **MCV-041 finding F** — three call sites had three different definitions
 *     of "valid redemption". Fixed by `@/server/referral-eligibility`.
 *
 * Round three of the review then walked through all of it: post the public
 * consultation form, signed out, naming an address that **does not exist yet**.
 * `resolveIdentity` creates the `User`, reports `created`, the MCV-040 guard is
 * satisfied — and a `PENDING ReferralRedemption` is written against a mailbox
 * the caller has never touched. Weeks later the genuine owner of that address
 * signs in by magic link (Auth.js `database` strategy binds to the existing row
 * for that email), subscribes, pays, and the settlement sweep credits the
 * stranger. Measured against a live database: `{examined: 1, qualified: 1,
 * rewarded: 1, creditedCents: 5000}`.
 *
 * **The discriminant was wrong.** `created` answers "did *this call* insert the
 * `User` row?". The property that decides whether a caller may cause money to
 * move is "has this caller **proved control of this mailbox**?" — and an address
 * nobody has registered is not one anybody has proved. The `ResolvedIdentity`
 * docblock stated the false premise outright ("Nobody else has ever held this
 * account, so there is nothing of anybody's to damage"). Nobody had held it
 * *yet*.
 *
 * ## What replaces it
 *
 * A referral is **accepted only by an authenticated session**. The public path
 * writes no row that carries money, under any discriminant:
 *
 *  - {@link recordReferralClaim} stores the code as
 *    `ClientProfile.claimedReferralCode` — a string beside `source` and
 *    `sourceDetail`, with no ledger row, no redemption and no counter movement.
 *    Writing it costs nobody anything, so a caller who has proved nothing cannot
 *    make it cost anybody anything.
 *  - {@link settleFirstAuthenticatedSession} turns that string into a
 *    `ReferralRedemption` at the first sign-in that proves the mailbox, and only
 *    then. It re-runs `resolveRedemptionEligibility` **at that moment** and
 *    writes through `createReferralRedemption`, so there is exactly one writer of
 *    that table and one definition of "valid" — the same pair
 *    `redeemReferralCode` and the Stripe webhook go through.
 *
 * Because eligibility is decided at settlement rather than at claim time, the
 * public path has no cap check, no expiry check and no owner-identity check of
 * its own. Those were deleted rather than left in place: MCV-040 finding B was
 * caused by exactly that shape — a comparison against a counter nobody moved,
 * which read as a control for two audits — and a check whose result is discarded
 * is worse than no check, because it is why nobody looks.
 *
 * ## What this does and does not buy
 *
 * Stated plainly, because the previous three rounds were each made possible by a
 * docblock that claimed more than its code delivered.
 *
 *  - **Dead:** staking a money-bearing row against an address by typing it. No
 *    `ReferralRedemption`, no counter movement, no ledger entry is reachable
 *    without a session. The reviewer's reproduction now measures
 *    `{examined: 0, rewarded: 0, creditedCents: 0}`.
 *  - **Dead:** touching a household that was already ours. A claim is recorded
 *    only on a profile the same call opened, so the public form still writes not
 *    one column — nor one row — of an existing household's.
 *  - **Dead:** burning a third party's redemption cap, or poisoning their
 *    referral records, by quoting a code that is not yours. The cap moves in
 *    `createReferralRedemption` and nowhere else, and nothing anonymous reaches
 *    it.
 *  - **Dead:** an unbounded attribution. A claim lapses after
 *    {@link CLAIM_WINDOW_DAYS}, so "spray a million addresses and wait" has a
 *    horizon.
 *  - **Not dead, and it cannot be, by any server-side test:** if a stranger
 *    claims a code against `you@example.org` and *you* then sign in within the
 *    window, the attribution is yours-by-address and the claim settles. The
 *    server cannot distinguish "the prospect who typed the code then signed in"
 *    from "somebody else typed it and the prospect signed in", because both are
 *    the same two HTTP requests. What it *can* do is require that a mailbox be
 *    proved before a cent moves, bound how long an unproved attribution lives,
 *    and re-check every rule at the moment it settles. That is what this does.
 *    The complete answer is an explicit acceptance by the signed-in household —
 *    {@link readPendingReferralClaim} is the reader a portal would use to offer
 *    it, and `redeemReferralCode` is the action that would take it.
 *
 * ## Why this is not in `actions/`
 *
 * Same reason as `@/server/referral-eligibility` and `@/server/referral-program`:
 * a `'use server'` module may only export async functions, and two of this
 * module's consumers are not action modules at all — `server/auth.ts`, which
 * fires it from the Auth.js `signIn` event, and the intake actions. The actions
 * are thin authorised entry points; the rule lives here.
 *
 * `server/auth.ts` cannot be imported outside a Next.js runtime (it pulls in
 * `next/server` through `next-auth`), so it holds no logic of its own: both
 * callbacks are three lines that map Auth.js's arguments onto the two functions
 * below. That seam is deliberate — it is what lets
 * `scripts/verify-referral-preemption.ts` drive the real settlement against a
 * real PostgreSQL rather than assert against a mock of it.
 */

import { Prisma, prisma } from '@/server/db'
import {
  createReferralRedemption,
  resolveRedemptionEligibility,
  type RedemptionRefusal,
} from '@/server/referral-eligibility'

// =============================================================================
// 1. How long an unproved attribution lives
// =============================================================================

/**
 * How long a claimed code stays settleable, in days.
 *
 * An invitation typed into an enquiry form is an intent expressed *now*: the
 * person meant to sign up, and the ordinary gap between "I asked for a
 * consultation" and "I signed in" is days, not seasons. Thirty gives a household
 * that took a fortnight to reply to the concierge plenty of room.
 *
 * It is here because it is the one bound on the residual named in the module
 * docblock. An attribution that never lapses is precisely what an address
 * sprayer would be waiting on: claim a million mailboxes, wait however long it
 * takes for any of them to become a customer, collect. A horizon turns that from
 * a standing bet into one that expires.
 *
 * The code's own `expiresAt` is *also* honoured, by
 * `resolveRedemptionEligibility` at settlement time. This is the floor under
 * codes that carry no expiry at all.
 */
export const CLAIM_WINDOW_DAYS = 30

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

function claimHasLapsed(claimedAt: Date, now: Date): boolean {
  return (
    now.getTime() - claimedAt.getTime() >
    CLAIM_WINDOW_DAYS * MILLISECONDS_PER_DAY
  )
}

// =============================================================================
// 2. The claim, written by the public path
// =============================================================================

/**
 * Record the invitation code somebody typed, as attribution and nothing else.
 *
 * ## Why there is no validation here
 *
 * Not "is the code live", not "has the cap room", not "does the owner exist".
 * None of those questions has a stable answer between now and the moment this
 * claim would settle — a code can be withdrawn, filled or expire in between — so
 * asking them here would be asking at the wrong time, and *acting* on them here
 * would be the MCV-040 finding B shape all over again: a comparison whose result
 * changes nothing, sitting where a reader will mistake it for a control.
 * {@link settleFirstAuthenticatedSession} asks, once, at the only moment the
 * answer binds.
 *
 * The one thing that is enforced is the shape of the string, by
 * `consultationRequestSchema` / `prospectIntakeSchema` at the boundary. A column
 * is not a place to put arbitrary caller text.
 *
 * ## Why the caller must pass a profile it opened
 *
 * `claimedReferralCode` is a column on a `ClientProfile`, and the rule at the
 * head of `actions/intake.ts` is that a public submission writes neither a row
 * nor a column of a household that was already ours. So the intake path calls
 * this only for an identity of kind `created`. That is not what makes the money
 * safe — nothing here is money — it is what keeps a stranger from scribbling on
 * a real client's file, which is a different promise and one this codebase has
 * broken before.
 *
 * A second claim from the same prospect replaces the first, and re-stamps the
 * date. The most recent thing a household told us about where it came from is
 * the one worth keeping, and the alternative — first claim wins — would let a
 * sprayer's guess outrank a genuine invitation the household typed afterwards.
 */
export async function recordReferralClaim(
  tx: Prisma.TransactionClient,
  clientProfileId: string,
  code: string,
  now: Date
): Promise<void> {
  await tx.clientProfile.update({
    where: { id: clientProfileId },
    data: { claimedReferralCode: code, claimedReferralCodeAt: now },
    select: { id: true },
  })
}

// =============================================================================
// 3. Reading a claim back
// =============================================================================

/** An attribution waiting on a proved mailbox. */
export interface PendingReferralClaim {
  readonly code: string
  readonly claimedAt: Date
  /** `true` once the claim is past {@link CLAIM_WINDOW_DAYS}. */
  readonly lapsed: boolean
}

/**
 * The claim standing against a household, if any.
 *
 * Written for a portal that wants the *stronger* shape the module docblock
 * describes: show the signed-in household the code their enquiry carried and let
 * them accept it through `redeemReferralCode`, rather than settling it for them.
 * Nothing on the public path may call this — a claim read back to an anonymous
 * caller would turn the enquiry form into an oracle over which addresses we
 * hold, which is the property the null receipt ids in `actions/intake.ts` exist
 * to protect.
 */
export async function readPendingReferralClaim(
  userId: string,
  now: Date = new Date()
): Promise<PendingReferralClaim | null> {
  const profile = await prisma.clientProfile.findUnique({
    where: { userId },
    select: { claimedReferralCode: true, claimedReferralCodeAt: true },
  })

  if (
    profile === null ||
    profile.claimedReferralCode === null ||
    profile.claimedReferralCodeAt === null
  ) {
    return null
  }

  return {
    code: profile.claimedReferralCode,
    claimedAt: profile.claimedReferralCodeAt,
    lapsed: claimHasLapsed(profile.claimedReferralCodeAt, now),
  }
}

// =============================================================================
// 4. Settlement, at the first session that proves the mailbox
// =============================================================================

/**
 * What {@link settleFirstAuthenticatedSession} did with the claim.
 *
 * Every outcome is named rather than collapsed into a boolean, because this runs
 * from an Auth.js event where nothing is returned to a caller: the union *is* the
 * record of what happened, and it is what `verify-referral-preemption.ts`
 * asserts against.
 */
export type ReferralClaimOutcome =
  /** The account is gone or deactivated between sign-in and this call. */
  | { readonly kind: 'no-account' }
  /** No `ClientProfile`, or no claim on it. The ordinary case. */
  | { readonly kind: 'nothing-claimed' }
  /** A concurrent first session consumed the claim; that one settles it. */
  | { readonly kind: 'raced' }
  /** Older than {@link CLAIM_WINDOW_DAYS}. Consumed and discarded. */
  | { readonly kind: 'lapsed'; readonly code: string; readonly claimedAt: Date }
  /** The canonical predicate refused it *now*, whatever it would have said then. */
  | {
      readonly kind: 'refused'
      readonly code: string
      readonly reason: RedemptionRefusal
    }
  /** A `PENDING` redemption exists, written by the one canonical writer. */
  | {
      readonly kind: 'settled'
      readonly code: string
      readonly redemptionId: string
    }

/**
 * Thrown to roll the settlement transaction back when the code's counter moved
 * under us, and caught immediately outside it.
 *
 * `createReferralRedemption` **inserts the row and then** compare-and-swaps the
 * counter, and its contract is explicit that "the loser's `create` is rolled
 * back with the caller's transaction, which is why this must be called inside
 * one". `redeemReferralCode` honours that by throwing an `ActionError`; the
 * Stripe webhook by letting the delivery fail. Returning `raced` from the
 * transaction callback instead would **commit** the orphan redemption, and the
 * cap would stop binding under concurrency — which is precisely what
 * `verify-intake-referral-cap.ts` scenario 3 caught when this function first
 * did exactly that: four simultaneous sign-ins wrote four redemptions against a
 * code capped at two.
 *
 * A private class rather than a returned discriminant because the rollback is
 * the point: nothing else in this module may catch it, and nothing outside it
 * can see it.
 */
class RedemptionRacedError extends Error {
  constructor() {
    super('the referral code was taken by a concurrent settlement')
    this.name = 'RedemptionRacedError'
  }
}

/**
 * Adopt the account and settle whatever attribution it is carrying.
 *
 * Called from `authConfig.events.signIn`, which fires after Auth.js has verified
 * a magic link or completed an OAuth exchange — that is, after the caller has
 * proved control of the mailbox, which is the property the whole module is
 * about. It is *not* called from anywhere a request can reach directly.
 *
 * Two things happen, in one transaction:
 *
 *  1. **Adoption.** `User.unclaimedSince` is cleared. Non-null meant "opened by
 *     the public intake path for an address nobody had proved"; a real sign-in
 *     has now proved it, so the placeholder becomes an ordinary account. The
 *     update is `updateMany` guarded on `unclaimedSince: { not: null }`, so
 *     running twice is a no-op rather than a write.
 *  2. **Settlement.** The claim is *consumed* — both columns compare-and-swapped
 *     back to `NULL`, guarded on the exact code that was read — and then, and
 *     only then, offered to `resolveRedemptionEligibility`. Consuming first is
 *     what makes two concurrent first sessions produce one redemption and one
 *     `raced`, in the same shape `createReferralRedemption` uses for the counter.
 *
 * ## Why the full predicate is re-run here rather than trusted from claim time
 *
 * Because everything it asks can have changed, and every one of the changes
 * matters: the code may have been withdrawn or expired, its cap may have filled,
 * the household may have accepted a different invitation in the meantime, and —
 * the case that made MCV-041 finding F a finding — the owner may share a mailbox
 * with the account now settling. A claim carries no privilege forward. It carries
 * a string.
 *
 * ## Losing the race rolls the whole thing back
 *
 * See {@link RedemptionRacedError}. `createReferralRedemption` writes the row
 * *before* it swaps the counter, so a caller that merely reports the loss
 * commits an orphan redemption and the cap stops binding. Rolling back takes the
 * claim's consumption with it, which is the outcome worth having: nothing was
 * written, so the household's next sign-in may try again.
 *
 * ## Failure is swallowed, deliberately
 *
 * A sign-in that has otherwise succeeded must not be turned into an error page
 * because a referral could not be settled — the household would read "try again"
 * as a rejection of their sign-in. The same reasoning, and the same shape, as the
 * `lastLoginAt` stamp this runs beside. The claim has already been consumed by
 * then only if the transaction committed, so a failure leaves it settleable on
 * the next sign-in rather than silently spent.
 */
export async function settleFirstAuthenticatedSession(
  userId: string,
  now: Date = new Date()
): Promise<ReferralClaimOutcome> {
  try {
    return await settleInTransaction(userId, now)
  } catch (error) {
    if (error instanceof RedemptionRacedError) {
      return { kind: 'raced' }
    }

    throw error
  }
}

async function settleInTransaction(
  userId: string,
  now: Date
): Promise<ReferralClaimOutcome> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isActive: true,
        clientProfile: {
          select: {
            id: true,
            claimedReferralCode: true,
            claimedReferralCodeAt: true,
          },
        },
      },
    })

    if (account === null || !account.isActive) {
      return { kind: 'no-account' as const }
    }

    // Adoption. Guarded on the prior value so a household's fiftieth sign-in
    // costs a `WHERE` and no `UPDATE`.
    await tx.user.updateMany({
      where: { id: userId, unclaimedSince: { not: null } },
      data: { unclaimedSince: null },
    })

    const profile = account.clientProfile

    if (
      profile === null ||
      profile.claimedReferralCode === null ||
      profile.claimedReferralCodeAt === null
    ) {
      return { kind: 'nothing-claimed' as const }
    }

    const code = profile.claimedReferralCode
    const claimedAt = profile.claimedReferralCodeAt

    // Consume before deciding. A claim is a one-shot token, and the swap is what
    // says so to a second transaction rather than to a reader.
    const consumed = await tx.clientProfile.updateMany({
      where: { id: profile.id, claimedReferralCode: code },
      data: { claimedReferralCode: null, claimedReferralCodeAt: null },
    })

    if (consumed.count !== 1) {
      return { kind: 'raced' as const }
    }

    if (claimHasLapsed(claimedAt, now)) {
      return { kind: 'lapsed' as const, code, claimedAt }
    }

    const eligibility = await resolveRedemptionEligibility(
      tx,
      { kind: 'code', code },
      userId,
      {
        // The household heuristic applies. This settlement is nobody's escape
        // hatch: the only caller who may switch it off is an `ADMIN` acting
        // deliberately through `redeemReferralCode`, and an Auth.js event is not
        // an administrator.
        applyHouseholdHeuristic: true,
        // The moment the code was typed into the enquiry form, not the moment
        // this sign-in proved the mailbox (MCV-051). Those are the same
        // intention separated by up to `CLAIM_WINDOW_DAYS`, and the claim is
        // what the household actually did; dating the referral to the sign-in
        // would let a bill paid in between count as prior custom and refuse a
        // perfectly genuine acquisition. `claimHasLapsed` above has already
        // bounded how far back this can reach.
        establishedAt: claimedAt,
      }
    )

    if (eligibility.kind === 'refused') {
      return { kind: 'refused' as const, code, reason: eligibility.reason }
    }

    const written = await createReferralRedemption(tx, eligibility, userId)

    if (written.kind === 'raced') {
      // Throw, do not return: the row `createReferralRedemption` inserted a
      // statement ago must go with it. See {@link RedemptionRacedError}.
      throw new RedemptionRacedError()
    }

    return {
      kind: 'settled' as const,
      code,
      redemptionId: written.redemption.id,
    }
  })
}

// =============================================================================
// 5. Adoption at an OAuth door
// =============================================================================

/**
 * The columns Auth.js hands `signIn` for an OAuth account, narrowed to what is
 * written.
 *
 * Declared here rather than imported from `next-auth` so that this module has no
 * dependency on the Auth.js runtime, which is what lets a harness exercise it.
 * `server/auth.ts` does the mapping, and `exactOptionalPropertyTypes` is why the
 * optional token columns are spelled `| undefined` rather than left bare.
 */
export interface OAuthAccountLink {
  readonly provider: string
  readonly providerAccountId: string
  readonly type: string
  readonly access_token?: string | undefined
  readonly refresh_token?: string | undefined
  readonly expires_at?: number | undefined
  readonly token_type?: string | undefined
  readonly scope?: string | undefined
  readonly id_token?: string | undefined
  readonly session_state?: string | undefined
}

/** What {@link adoptUnclaimedAccount} did. */
export type AccountAdoptionOutcome =
  /** No placeholder for that address; Auth.js's ordinary handling applies. */
  | { readonly kind: 'not-applicable' }
  /** The `Account` row now exists, so Auth.js will sign in as the adopted user. */
  | { readonly kind: 'adopted'; readonly userId: string }

/**
 * Let the genuine owner of a pre-emptively opened address register with Google.
 *
 * ## The harm this closes
 *
 * `resolveIdentity` opens a `User` for an address a public form named. That row
 * has no `Account`, and `allowDangerousEmailAccountLinking` is `false` on the
 * Google provider — correctly, since enabling it globally would let anyone with a
 * Google account bearing an existing user's address take that account over. So
 * Auth.js refuses the OAuth sign-in with `OAuthAccountNotLinked`, permanently:
 * an anonymous caller can deny Google registration to **any address on earth** by
 * typing it into the enquiry form. That is a second, quieter harm of the same
 * call as the referral pre-emption, and it does not go away by fixing the money.
 *
 * ## Why linking here is not the dangerous linking
 *
 * The dangerous version links an OAuth identity to an account **somebody has
 * been using**. This one applies only where all four of these hold:
 *
 *  - `User.unclaimedSince` is non-null, so the row was opened by the intake path
 *    for an unproved address;
 *  - the row has **no** `Account` — nobody has ever linked a provider to it;
 *  - the row has **no** `Session` — nobody has ever been signed in as it;
 *  - the row has **no** `lastLoginAt` — nobody has ever signed in as it, by the
 *    other record of the same fact.
 *
 * A row satisfying all four holds nothing of anybody's: it has never
 * authenticated, so no human has ever exercised it, and Google has just proved
 * the mailbox it names. Adopting it is strictly better than refusing, and it is
 * strictly narrower than the provider flag, which would apply to every account on
 * the platform.
 *
 * `emailVerified` is stamped at the same moment, because it now is.
 *
 * ## Where it runs
 *
 * From `authConfig.callbacks.signIn`, which fires *before* Auth.js's own
 * account-linking check. Writing the `Account` row there means
 * `getUserByAccount` finds it a moment later and the sign-in proceeds normally,
 * rather than the callback having to return some verdict Auth.js has no way to
 * act on.
 *
 * The claim on that profile is untouched here. It settles in
 * {@link settleFirstAuthenticatedSession}, from the `signIn` *event*, which is
 * the one place that decision is made.
 */
export async function adoptUnclaimedAccount(
  email: string,
  link: OAuthAccountLink,
  now: Date = new Date()
): Promise<AccountAdoptionOutcome> {
  return prisma.$transaction(async (tx) => {
    const existingLink = await tx.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: link.provider,
          providerAccountId: link.providerAccountId,
        },
      },
      select: { id: true },
    })

    // Already linked to somebody. Auth.js will sign that somebody in; adopting
    // anything on top of that would be the takeover this function exists to
    // avoid being.
    if (existingLink !== null) {
      return { kind: 'not-applicable' as const }
    }

    const candidate = await tx.user.findUnique({
      where: { email },
      select: {
        id: true,
        isActive: true,
        lastLoginAt: true,
        unclaimedSince: true,
        _count: { select: { accounts: true, sessions: true } },
      },
    })

    if (
      candidate === null ||
      !candidate.isActive ||
      candidate.unclaimedSince === null ||
      candidate.lastLoginAt !== null ||
      candidate._count.accounts !== 0 ||
      candidate._count.sessions !== 0
    ) {
      return { kind: 'not-applicable' as const }
    }

    await tx.account.create({
      data: {
        userId: candidate.id,
        type: link.type,
        provider: link.provider,
        providerAccountId: link.providerAccountId,
        access_token: link.access_token ?? null,
        refresh_token: link.refresh_token ?? null,
        expires_at: link.expires_at ?? null,
        token_type: link.token_type ?? null,
        scope: link.scope ?? null,
        id_token: link.id_token ?? null,
        session_state: link.session_state ?? null,
      },
      select: { id: true },
    })

    await tx.user.update({
      where: { id: candidate.id },
      data: { emailVerified: now },
      select: { id: true },
    })

    return { kind: 'adopted' as const, userId: candidate.id }
  })
}
