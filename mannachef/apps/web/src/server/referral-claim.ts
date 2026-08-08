// mannachef/apps/web/src/server/referral-claim.ts

/**
 * A referral typed into a public form is a **claim**, and a claim becomes money
 * only when the household itself accepts it (MCV-050, superseded by MCV-052).
 *
 * ## Four rounds of one defect
 *
 * Each round closed the hole it was shown and left the same shape one step
 * earlier:
 *
 *  1. **MCV-030** — a `CLIENT` set their own reward amount. Fixed by taking the
 *     terms from the standing offer (`@/server/referral-program`).
 *  2. **MCV-040 finding A** — an anonymous caller staked a redemption against an
 *     *existing* household by typing its address. Fixed by making
 *     `resolveIdentity` report `created | matched` and refusing `matched`.
 *  3. **MCV-041 finding F** — three call sites had three different definitions
 *     of "valid redemption". Fixed by `@/server/referral-eligibility`.
 *  4. **MCV-050** — an anonymous caller named an address that *did not exist
 *     yet*, `resolveIdentity` reported `created`, and a `PENDING
 *     ReferralRedemption` was written against a mailbox the caller had never
 *     touched. Fixed by writing a string here instead of a redemption, and
 *     settling it from the Auth.js `signIn` event, once the mailbox was proved.
 *
 * Round four then walked through MCV-050 and produced two findings, which are
 * one finding:
 *
 *  - **Precedence.** {@link recordReferralClaim}'s docblock promised
 *    last-writer-wins ("a sprayer's guess must not outrank a genuine invitation
 *    the household typed afterwards"). The replacement was **unreachable**:
 *    after the first public submission the `ClientProfile` exists, so
 *    `resolveIdentity` reports `matched` for ever and `attachReferralClaim`
 *    returns before this module's writer runs. A sprayed `HARVEST24` therefore
 *    stood, the household's later `GENUINE24` was dropped on the floor, the
 *    sprayer was credited 5000 cents at the household's first sign-in, and the
 *    genuine inviter was then locked out permanently by `ALREADY_REFERRED`.
 *    Theft plus denial, deterministic rather than racy.
 *  - **The pre-emption still paid.** One anonymous HTTP call, then the victim's
 *    own organic magic-link sign-in and payment, measured `{examined: 1,
 *    rewarded: 1, creditedCents: 5000}`. The claim that MCV-050 had closed it
 *    rested on a harness artefact: in `verify-referral-preemption.ts`, scenario 2
 *    ("the pre-emption") never called `firstSignIn` while scenario 5 ("a genuine
 *    prospect") did, and the two are byte-identical in mechanism. **There was no
 *    server-side property separating them.** The mitigation the docblock below
 *    named — an explicit acceptance, offered through
 *    {@link readPendingReferralClaim} — had exactly two callers, both inside that
 *    same test file. It was a function nobody called.
 *
 * ## Why every round produced the same shape
 *
 * Because settlement was **automatic**. In all four designs the last act that
 * moved money was performed by the server on a schedule of its own — a form
 * submission, a sweep, a sign-in event — and the only question left was *which
 * unauthenticated input the server should trust to aim it*. `created` vs
 * `matched`, "does the address exist", "has a mailbox been proved": every one of
 * those is a guess at intent made from two HTTP requests that look identical.
 * The server genuinely cannot tell "the prospect typed the code, then signed in"
 * from "a stranger typed the code, and the prospect signed in", so any automatic
 * rule built on that distinction is a rule that can be aimed by whoever sends
 * the first request.
 *
 * ## What replaces it: consent
 *
 * The automation is removed. Nothing turns a claim into money except a
 * deliberate act by the authenticated household:
 *
 *  - {@link recordReferralClaim} stores the code as
 *    `ClientProfile.claimedReferralCode` — a string beside `source` and
 *    `sourceDetail`, with no ledger row, no redemption and no counter movement.
 *    It is a **suggestion to show the household later**, and nothing else reads
 *    it as authority.
 *  - {@link readPendingReferralClaim} shows that suggestion to the signed-in
 *    household. It has a real caller now: the consent surface.
 *  - {@link settleAcceptedClaim} is the only path from that string to a
 *    `ReferralRedemption`, and it runs only when the household names the code it
 *    is accepting. It re-runs `resolveRedemptionEligibility` at that moment and
 *    writes through `createReferralRedemption`, so there is still exactly one
 *    writer of that table and one definition of "valid" — the same pair
 *    `redeemReferralCode` and the Stripe webhook go through.
 *  - {@link declineReferralClaim} is the other half of the choice. A household
 *    that did not send that enquiry can clear the suggestion instead of waiting
 *    {@link CLAIM_WINDOW_DAYS} for it to lapse.
 *  - {@link markMailboxProved} is what is left of the `signIn` event: it clears
 *    `User.unclaimedSince` and touches nothing that carries money. It is reached
 *    through {@link ensureMailboxProved}, which retries it, reports a failure as
 *    a value rather than swallowing one, and is called again on every
 *    authenticated request so a failed clear repairs itself. That column is a
 *    capability boundary rather than bookkeeping — see the bullet below — and
 *    the previous version of this module treated a failed write to it as free.
 *
 * Because eligibility is decided at acceptance rather than at claim time, the
 * public path has no cap check, no expiry check and no owner-identity check of
 * its own. Those were deleted rather than left in place: MCV-040 finding B was
 * caused by exactly that shape — a comparison against a counter nobody moved,
 * which read as a control for two audits — and a check whose result is discarded
 * is worse than no check, because it is why nobody looks.
 *
 * ## What this buys, and what it does not
 *
 * Stated plainly, because each of the previous four rounds was made possible by
 * a docblock that claimed more than its code delivered. The immediately previous
 * version of this list asserted the pre-emption was "Dead" while it still paid
 * 5000 cents; that sentence is why round four was needed.
 *
 *  - **Closed:** the pre-emption paying anything. A stranger's claim against
 *    `you@example.org` credits nobody, however you subsequently sign in, pay or
 *    subscribe, because no sign-in and no payment settles a claim. Only your own
 *    authenticated acceptance does, and you never sent one. This is the finding
 *    that survived three previous fixes; it is closed by removing the automatic
 *    act, not by sharpening a guess about who sent the HTTP request.
 *  - **Closed:** the precedence hole, by making precedence irrelevant rather
 *    than by reordering writes. Whatever string the column holds — sprayed,
 *    genuine, or stale — it is offered to the household and refused or accepted
 *    by the household. A guess cannot outrank a choice.
 *  - **Closed:** the `ALREADY_REFERRED` lockout. No redemption exists until the
 *    household writes one, so a sprayer cannot spend the household's one-time
 *    eligibility on a code the household never chose, and the genuine inviter
 *    stays redeemable through `redeemReferralCode`.
 *  - **Closed:** staking a money-bearing row against an address by typing it. No
 *    `ReferralRedemption`, no counter movement, no ledger entry is reachable
 *    without a session *and* an explicit acceptance.
 *  - **Narrowed, and stated as narrowed:** touching a household that was already
 *    ours. The bullet that stood here said a claim is recorded "only on a profile
 *    the same intake call opened". That is not what `attachReferralClaim`
 *    (`actions/intake.ts`) does. It admits the write for an identity of kind
 *    `created`, *and* for a `matched` identity while `User.unclaimedSince` is
 *    still stamped — a `ClientProfile` some **earlier** public call opened for an
 *    address nobody has ever authenticated as. So two successive anonymous
 *    consultation requests at one address both write these two columns, and the
 *    second overwrites the first; that refresh is deliberate and is argued at
 *    {@link recordReferralClaim}. What is actually closed is narrower and is the
 *    thing worth having: a household that has ever proved its mailbox is
 *    untouchable from the public path, because {@link markMailboxProved} clears
 *    `unclaimedSince` at the first sign-in, and from that moment the public form
 *    writes not one column — nor one row — of that household's. No column other
 *    than these two is reachable from the public path at any point, and neither
 *    of these two carries money.
 *
 *    That promise is only as good as the clear, which is why the clear is no
 *    longer allowed to fail quietly. `unclaimedSince` is the boundary itself,
 *    not a record of it, so a swallowed failure to clear it does not cost a
 *    stale column — it leaves the public form writing on a household that has a
 *    session. {@link ensureMailboxProved} retries, reports, and re-attempts on
 *    the next authenticated request.
 *  - **Closed:** an unbounded attribution. A claim lapses after
 *    {@link CLAIM_WINDOW_DAYS} and can be declined before that.
 *  - **Residual, and named rather than dismissed:** a sprayer can still cause a
 *    household to be *shown* an invitation it did not request, and a household
 *    that accepts it anyway pays the sprayer the reward. That is a phishing
 *    surface, not a server hole: it requires the human holding the mailbox to
 *    choose. The consent surface must therefore present the code as
 *    "your enquiry mentioned X — is that right?", never as an accomplished fact
 *    with a confirm button.
 *  - **Residual:** the claim's timestamp still backdates
 *    `RedemptionEligibilityOptions.establishedAt` when the accepted code is the
 *    standing one. That decides *when* the invitation counts from, never
 *    *whether* it counts or *who* is paid, and it is bounded by
 *    {@link CLAIM_WINDOW_DAYS} and clamped again by `createReferralRedemption`.
 *
 * ## What a harness has to prove now
 *
 * Round four's mistake was reproducible only because the harness distinguished
 * "the pre-emption" from "a genuine prospect" by the choice of email literal.
 * Under consent there **is** a server-side property separating them, and it is
 * the only one worth asserting: a scenario that never calls
 * {@link settleAcceptedClaim} must measure `{rewarded: 0, creditedCents: 0}` no
 * matter how many sign-ins, subscriptions and paid invoices it performs.
 * `scripts/verify-referral-preemption.ts` has to be rewritten against that
 * property; until it is, it is asserting against a function that no longer
 * exists.
 *
 * ## Why this is not in `actions/`
 *
 * Same reason as `@/server/referral-eligibility` and `@/server/referral-program`:
 * a `'use server'` module may only export async functions, and one of this
 * module's consumers is not an action module at all — `server/auth.ts`, which
 * calls {@link markMailboxProved} and {@link adoptUnclaimedAccount} from the
 * Auth.js callbacks. The actions are thin authorised entry points; the rule
 * lives here.
 *
 * `server/auth.ts` cannot be imported outside a Next.js runtime (it pulls in
 * `next/server` through `next-auth`), so it holds no logic of its own: its
 * callbacks are three lines that map Auth.js's arguments onto the functions
 * below. That seam is deliberate — it is what lets the verification scripts
 * drive the real writers against a real PostgreSQL rather than assert against a
 * mock of them.
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
 * Record the invitation code somebody typed, as a suggestion to show the
 * household later and nothing else.
 *
 * ## Why there is no validation here
 *
 * Not "is the code live", not "has the cap room", not "does the owner exist".
 * None of those questions has a stable answer between now and the moment the
 * household might accept this — a code can be withdrawn, filled or expire in
 * between — so asking them here would be asking at the wrong time, and *acting*
 * on them here would be the MCV-040 finding B shape all over again: a comparison
 * whose result changes nothing, sitting where a reader will mistake it for a
 * control. {@link settleAcceptedClaim} asks, once, at the only moment the answer
 * binds.
 *
 * The one thing that is enforced is the shape of the string, by
 * `consultationRequestSchema` / `prospectIntakeSchema` at the boundary. A column
 * is not a place to put arbitrary caller text.
 *
 * ## Which profiles the caller may pass
 *
 * `claimedReferralCode` is a column on a `ClientProfile`, and the rule at the
 * head of `actions/intake.ts` bounds what a public submission may write. The
 * bound this function relies on is enforced by its only caller,
 * `attachReferralClaim`, and it is **not** "a profile this call opened". It is:
 * an identity of kind `created`, *or* a `matched` identity whose `User` still
 * carries `unclaimedSince` — a row the public path itself opened for an address
 * nobody has ever authenticated as. {@link markMailboxProved} clears that stamp
 * at the first sign-in, so every signed-in caller, every real client and every
 * member is out of reach from here; their audited door is `redeemReferralCode`.
 *
 * State the bound that way round, because the weaker one is the true one and the
 * stronger one was in this docblock for a round while the code did the weaker
 * thing. What it buys is unchanged: it keeps a stranger from scribbling on a
 * real client's file. That is not what makes the money safe — nothing here is
 * money — it is a different promise, and one this codebase has broken before.
 *
 * ## There is no precedence rule, and there is deliberately no longer one
 *
 * Earlier versions of this docblock promised last-writer-wins, on the reasoning
 * that "first claim wins would let a sprayer's guess outrank a genuine
 * invitation the household typed afterwards". That prose described a rule the
 * code could not implement. The `update` below has always been last-writer-wins,
 * but the public path could not reach it twice: after the first submission the
 * `ClientProfile` existed, `resolveIdentity` reported `matched` for ever, and
 * `attachReferralClaim` returned before this function was called. The documented
 * rule and the reachable behaviour disagreed for a whole audit round, and the
 * sprayer the prose warned about was winning the entire time.
 *
 * Under consent the disagreement is settled from both ends. **Write order no
 * longer decides anything**, because whatever string this column ends up holding
 * is merely *offered* to the signed-in household by
 * {@link readPendingReferralClaim}, and only the household's own
 * {@link settleAcceptedClaim} turns it into money. A sprayer's guess cannot
 * outrank a genuine invitation because the two are not ranked against each
 * other — a household shown a code it does not recognise declines it, and a
 * household whose column holds the wrong code still has `redeemReferralCode`.
 *
 * And because write order no longer decides anything, `attachReferralClaim` may
 * now safely reach this a second time: it admits a public submission for an
 * account still marked `User.unclaimedSince`, so a household that types their
 * own code after a sprayer typed theirs can be *shown their own*.
 *
 * That remedy is partial, and saying so is the point of this paragraph. It is
 * reachable through `requestConsultation` only. `submitProspectIntake` returns
 * `withheld` for an anonymous caller whose identity is `matched`, several
 * statements before its own call to `attachReferralClaim`, so a household that
 * types their genuine code into the *questionnaire* form after a sprayer typed
 * theirs is still shown the sprayer's. What they have then is the same thing
 * every household has: decline it, and use `redeemReferralCode`.
 *
 * That refresh and this column's lack of authority are only jointly safe. Do not
 * give this column authority again without also removing the refresh, and do not
 * remove the consent gate while the refresh stands.
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
 * This is the read the consent surface performs: show the signed-in household
 * the code their enquiry carried, and let them {@link settleAcceptedClaim} or
 * {@link declineReferralClaim} it. It is no longer a reader written for a portal
 * that might one day exist — round four found that its only two callers were
 * inside a test file while the docblock cited it as the mitigation for a live
 * money hole. A named mitigation with no production caller is not a mitigation.
 *
 * The caller must be the household itself. Nothing on the public path may call
 * this — a claim read back to an anonymous caller would turn the enquiry form
 * into an oracle over which addresses we hold, which is the property the null
 * receipt ids in `actions/intake.ts` exist to protect.
 *
 * `lapsed` is reported rather than hidden so the surface can say "this expired"
 * instead of silently showing nothing; {@link settleAcceptedClaim} refuses a
 * lapsed claim regardless of what was displayed.
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
// 4. Adoption, at the session that proves the mailbox
// =============================================================================

/** What {@link markMailboxProved} did. */
export type MailboxProofOutcome =
  /** The row was a placeholder and is now an ordinary account. */
  | { readonly kind: 'newly-proved' }
  /** Nothing to clear: already proved, gone, or deactivated. */
  | { readonly kind: 'not-applicable' }

/**
 * Clear `User.unclaimedSince`, because a sign-in has just proved the mailbox.
 *
 * This is everything that is left of what the Auth.js `signIn` event used to do,
 * and the whole point of the MCV-052 change is what is *not* here: signing in no
 * longer settles a referral claim, because signing in is not consent to an
 * attribution somebody else may have typed. See the module docblock.
 *
 * What remains is not money and cannot become money. `unclaimedSince` non-null
 * means "opened by the public intake path for an address nobody had proved"; a
 * verified magic link or completed OAuth exchange has now proved it, so the
 * placeholder becomes an ordinary account. Leaving the stamp on a real
 * household's row would be wrong three times over: `adoptUnclaimedAccount` reads
 * it as a licence to link an OAuth identity without the usual check, the CRM
 * reads it as "this household never showed up", and — the one that is not
 * bookkeeping — `attachReferralClaim` reads it as a licence for an anonymous
 * form to overwrite `ClientProfile.claimedReferralCode` on a row that now has a
 * session behind it.
 *
 * That last one is load-bearing and is argued at length in
 * `actions/referral-claim.ts`. This call is what separates the anonymous writer
 * of that column from the authenticated reader of it: once it has run, the
 * account's claim can no longer be re-aimed from the public path, which is what
 * bounds `readPendingReferralClaim` to one code per proved mailbox rather than
 * one per public POST. It is a runtime fact, not a database constraint.
 *
 * This function **throws** on a fault, and deliberately keeps throwing. Its
 * resilience lives one level up, in {@link ensureMailboxProved}, so that the
 * write and the policy about what a failed write means are not the same piece
 * of code — see that function for what the policy is and why it changed.
 *
 * `updateMany` guarded on the prior value, so a household's fiftieth sign-in
 * costs a `WHERE` and no `UPDATE`, and running twice is a no-op rather than a
 * write. The `isActive` guard is belt-and-braces: `authConfig.callbacks.signIn`
 * has already refused a deactivated user before the event fires.
 */
export async function markMailboxProved(
  userId: string
): Promise<MailboxProofOutcome> {
  const cleared = await prisma.user.updateMany({
    where: { id: userId, isActive: true, unclaimedSince: { not: null } },
    data: { unclaimedSince: null },
  })

  return cleared.count === 1
    ? { kind: 'newly-proved' }
    : { kind: 'not-applicable' }
}

/**
 * How many times {@link ensureMailboxProved} will try before reporting a
 * failure.
 *
 * Two, with no delay between them, and both halves of that are deliberate.
 *
 * Two rather than one because the failure this is guarding against is
 * overwhelmingly a dropped pooled connection, and Prisma's next call
 * re-establishes one; a second immediate attempt converts most of this
 * function's failures into successes for the price of one round trip on a path
 * that is already doing several.
 *
 * No delay, and no third attempt, because this runs inside a sign-in and inside
 * a session read — a human is waiting behind both, and a backoff loop on a
 * request path trades one degraded state for a slower one. The real backoff is
 * structural rather than temporal: the caller of record is
 * `authConfig.callbacks.session`, which runs on **every authenticated request**,
 * so an account that survives both attempts is retried within seconds by the
 * household's own next page load. Sleeping here would only be racing that.
 */
const MAILBOX_PROOF_ATTEMPTS = 2

/** What {@link ensureMailboxProved} did, including the ways it did not. */
export type MailboxProofRepair =
  /** Cleared. The account is no longer an unproved placeholder. */
  | { readonly kind: 'newly-proved' }
  /** Nothing to clear: already proved, gone, or deactivated. */
  | { readonly kind: 'not-applicable' }
  /**
   * Every attempt faulted. The stamp is **still set** and the public path can
   * therefore still overwrite this household's `claimedReferralCode`.
   *
   * Reported rather than thrown, and carrying the message rather than the
   * error, because the two callers must both keep going — one is a sign-in that
   * has otherwise succeeded, the other is a session read — and because a Prisma
   * error object is not a thing to hand to a logger. Neither caller may treat
   * this as fatal, and neither may treat it as nothing.
   */
  | {
      readonly kind: 'failed'
      readonly attempts: number
      readonly message: string
    }

/**
 * Clear `User.unclaimedSince`, and say plainly when that did not happen.
 *
 * ## The defect this replaces
 *
 * `authConfig.events.signIn` used to call {@link markMailboxProved} inside a
 * `try`/`catch` that logged and dropped the error, and the comment above it
 * argued the drop was safe because "neither write carries money, so losing one
 * costs a stale column and not a cent". That reasoning is wrong about which
 * column. `lastLoginAt` is bookkeeping and losing it costs a CRM sort order.
 * `unclaimedSince` is a **capability boundary**: while it is stamped,
 * `attachReferralClaim` will let an anonymous POST overwrite this household's
 * `ClientProfile.claimedReferralCode`, and clearing it at the first sign-in is
 * the entire reason a proved household is out of reach from the public form.
 * A reviewer reproduced the degraded state directly — a live session, the stamp
 * still set — and nothing anywhere reported it or fixed it. The old code's own
 * next sentence admitted the window and then left it open until the household
 * happened to sign in again, which for a magic-link household can be never.
 *
 * A silently swallowed failure of a security-relevant state transition is not
 * acceptable, so this function exists to make that transition three things it
 * was not: **retried**, **observable**, and **recoverable**.
 *
 *  - *Retried* — {@link MAILBOX_PROOF_ATTEMPTS}, which argues its own numbers.
 *  - *Observable* — a `failed` arm that a caller cannot receive by accident.
 *    It is a distinct variant of a discriminated union, so a caller that stops
 *    handling it stops compiling. That is the part the previous design could
 *    never have: a `catch` block is invisible to the type system, and the way
 *    to notice one had been left empty was to read it.
 *  - *Recoverable* — because `authConfig.callbacks.session` calls this too, on
 *    every authenticated request, and it already reads the row that says
 *    whether there is anything to do. A live session is itself proof that Auth.js
 *    verified a magic link or completed an OAuth exchange for this address, so
 *    "a session exists **and** the stamp is set" is not an ambiguous state that
 *    needs interpreting — it is exactly the degraded state, and repairing it
 *    there is not a new policy, it is the sign-in event's own policy applied at
 *    the next opportunity.
 *
 * ## Why this is not simply "let the sign-in fail"
 *
 * Because the household would be shown "try again", which reads as a rejected
 * sign-in, for a write that has nothing to do with whether they may come in.
 * That was the right call in the old code and it stays the right call; what was
 * wrong was everything after it. Refusing to fail the sign-in obliges the code
 * to do something *else* about the failure, and previously it did nothing.
 *
 * ## Why this does not throw
 *
 * Both callers are non-transactional side paths that must complete regardless.
 * Contrast {@link settleAcceptedClaim}, which deliberately does not swallow:
 * there a household is waiting on an answer to something they just clicked, so
 * the error belongs to the caller to report. Here nobody asked for this write —
 * it is the platform's own bookkeeping about its own capability boundary — so
 * the obligation is to report it to an operator, not to a household.
 */
export async function ensureMailboxProved(
  userId: string
): Promise<MailboxProofRepair> {
  let lastMessage = 'unknown'

  for (let attempt = 1; attempt <= MAILBOX_PROOF_ATTEMPTS; attempt += 1) {
    try {
      return await markMailboxProved(userId)
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : 'unknown'
    }
  }

  return {
    kind: 'failed',
    attempts: MAILBOX_PROOF_ATTEMPTS,
    message: lastMessage,
  }
}

// =============================================================================
// 5. Settlement, at the household's explicit acceptance
// =============================================================================

/**
 * What {@link settleAcceptedClaim} did with the claim.
 *
 * Every outcome is named rather than collapsed into a boolean, because the
 * consent action has to tell the household which of these happened — "that
 * invitation expired" and "that code has already been fully redeemed" are
 * different sentences, and a household that just clicked *accept* is owed the
 * right one.
 */
export type ReferralClaimOutcome =
  /** The account is gone or deactivated between the read and this call. */
  | { readonly kind: 'no-account' }
  /** No `ClientProfile`, or no claim on it. Nothing was offered to accept. */
  | { readonly kind: 'nothing-claimed' }
  /**
   * A claim stands, but not for the code the household named.
   *
   * The prompt they answered is stale — the claim was declined, settled or
   * overwritten between the render and the click. Nothing is consumed, so the
   * surface can re-read and ask again. Carrying `standing` is safe because the
   * only caller is the household that owns the profile.
   */
  | { readonly kind: 'mismatch'; readonly standing: string }
  /** A concurrent acceptance consumed the claim; that one settles it. */
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
 * Turn the claim standing against a household into a redemption, because the
 * household said to.
 *
 * ## Who may call this, and why the answer is only ever one person
 *
 * The consent action, on behalf of the authenticated owner of `userId`, and
 * nobody else. This function does not check the session — a plain server module
 * cannot — so its caller must, exactly as CONTRACT.md §5 requires: resolve the
 * session, then pass that session's own user id. Passing an id taken from client
 * input would hand an attacker the whole of MCV-052 back, because the one thing
 * standing between a sprayed claim and a payout is that the party consenting is
 * the party who holds the mailbox.
 *
 * It is deliberately **not** called from `authConfig.events.signIn` any more.
 * That call was the automatic settlement round four measured paying 5000 cents
 * to a stranger against a victim's organic sign-in, and no narrowing of it
 * helps: the server cannot tell which of two identical HTTP requests was the
 * genuine prospect. Consent is not a stronger guess, it is the absence of a
 * guess.
 *
 * ## Why the code is a parameter rather than read from the column
 *
 * Because the household is accepting a *specific* invitation, the one it was
 * shown. If this read the column itself, an acceptance rendered against
 * `GENUINE24` would bind whatever the column happened to hold at click time, and
 * a claim overwritten in between would be settled without anybody having agreed
 * to it — an automatic settlement wearing a consent button. A mismatch is
 * therefore `mismatch` and consumes nothing; the surface re-reads and asks
 * again.
 *
 * This is also why the accepted code must equal the standing claim rather than
 * being free-form. A household that wants to redeem a code it was given
 * privately has `redeemReferralCode`, which is separately audited and rate
 * limited. This door is narrower on purpose: it converts an attribution the
 * platform is already holding, and nothing else.
 *
 * ## What happens, in one transaction
 *
 * The claim is *consumed* — both columns compare-and-swapped back to `NULL`,
 * guarded on the exact code that was read — and then, and only then, offered to
 * `resolveRedemptionEligibility`. Consuming first is what makes two concurrent
 * acceptances produce one redemption and one `raced`, in the same shape
 * `createReferralRedemption` uses for the counter.
 *
 * ## Why the full predicate is re-run here rather than trusted from claim time
 *
 * Because everything it asks can have changed, and every one of the changes
 * matters: the code may have been withdrawn or expired, its cap may have filled,
 * the household may have redeemed a different invitation in the meantime, and —
 * the case that made MCV-041 finding F a finding — the owner may share a mailbox
 * with the account now accepting. A claim carries no privilege forward. It
 * carries a string and a date.
 *
 * ## Losing the race rolls the whole thing back
 *
 * See {@link RedemptionRacedError}. `createReferralRedemption` writes the row
 * *before* it swaps the counter, so a caller that merely reports the loss
 * commits an orphan redemption and the cap stops binding. Rolling back takes the
 * claim's consumption with it, which is the outcome worth having: nothing was
 * written, so the household may try again.
 *
 * ## Failure is *not* swallowed here
 *
 * Unlike the sign-in event this replaces, where an error would have read to the
 * household as a rejected sign-in, this runs inside an action the household
 * deliberately invoked. Somebody is waiting on the answer, so a thrown error
 * belongs to the caller to report. Only `RedemptionRacedError` is caught, and
 * only because it is this module's own rollback signal rather than a fault.
 */
export async function settleAcceptedClaim(
  userId: string,
  code: string,
  now: Date = new Date()
): Promise<ReferralClaimOutcome> {
  try {
    return await settleInTransaction(userId, code, now)
  } catch (error) {
    if (error instanceof RedemptionRacedError) {
      return { kind: 'raced' }
    }

    throw error
  }
}

async function settleInTransaction(
  userId: string,
  acceptedCode: string,
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

    if (code !== acceptedCode) {
      return { kind: 'mismatch' as const, standing: code }
    }

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
        // The household heuristic applies. This acceptance is nobody's escape
        // hatch: the only caller who may switch it off is an `ADMIN` acting
        // deliberately through `redeemReferralCode`, and a client consenting on
        // their own behalf is not an administrator.
        applyHouseholdHeuristic: true,
        // The moment the code was typed into the enquiry form, not the moment
        // the household clicked accept (MCV-051). Those are the same intention
        // separated by up to `CLAIM_WINDOW_DAYS`, and the claim is what the
        // household actually did; dating the referral to the acceptance would
        // let a bill paid in between count as prior custom and refuse a
        // perfectly genuine acquisition. `claimHasLapsed` above has already
        // bounded how far back this can reach, and `createReferralRedemption`
        // clamps it again. This backdating is the one thing the column carries
        // forward, and it decides *when* an invitation counts from — never
        // whether it counts, and never who is paid.
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
// 6. The other half of the choice
// =============================================================================

/** What {@link declineReferralClaim} did. */
export type ReferralClaimDismissal =
  /** The claim is gone. Nothing was ever written that needed reversing. */
  | { readonly kind: 'declined'; readonly code: string }
  /** No `ClientProfile`, or no claim on it. */
  | { readonly kind: 'nothing-claimed' }
  /** A claim stands, but not the one the household was shown. */
  | { readonly kind: 'mismatch'; readonly standing: string }

/**
 * Clear the claim, because the household says it is not theirs.
 *
 * Consent is a choice, and a choice needs both answers. Without this the only
 * way to be rid of an invitation a stranger sprayed at your address is to wait
 * {@link CLAIM_WINDOW_DAYS} for it to lapse, which leaves the prompt in front of
 * the household for a month — and a prompt that cannot be dismissed is one
 * people eventually click through.
 *
 * Nothing is reversed because nothing was written: a claim is a string. Declining
 * is a plain compare-and-swap on the same two columns, guarded on the code the
 * household was shown for the same reason {@link settleAcceptedClaim} is — a
 * decline rendered against one code must not silently discard another.
 *
 * Same caller contract as {@link settleAcceptedClaim}: `userId` is the resolved
 * session's own id, never an id from client input.
 */
export async function declineReferralClaim(
  userId: string,
  code: string
): Promise<ReferralClaimDismissal> {
  const profile = await prisma.clientProfile.findUnique({
    where: { userId },
    select: { id: true, claimedReferralCode: true },
  })

  if (profile === null || profile.claimedReferralCode === null) {
    return { kind: 'nothing-claimed' }
  }

  if (profile.claimedReferralCode !== code) {
    return { kind: 'mismatch', standing: profile.claimedReferralCode }
  }

  const cleared = await prisma.clientProfile.updateMany({
    where: { id: profile.id, claimedReferralCode: code },
    data: { claimedReferralCode: null, claimedReferralCodeAt: null },
  })

  // A concurrent decline or acceptance got there first. Either way the claim is
  // no longer standing, which is what the household asked for.
  return cleared.count === 1
    ? { kind: 'declined', code }
    : { kind: 'nothing-claimed' }
}

// =============================================================================
// 7. Adoption at an OAuth door
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
 * The claim on that profile is untouched here, and adopting the row does not
 * settle it. Proving a mailbox is not consenting to an attribution: the claim
 * keeps standing until the household accepts it through
 * {@link settleAcceptedClaim} or clears it through
 * {@link declineReferralClaim}. Nothing on this path may shortcut that, however
 * convincing the proof of the mailbox is — that shortcut is exactly what round
 * four measured paying 5000 cents to a stranger.
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
