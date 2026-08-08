// mannachef/apps/web/src/server/actions/referral-claim.ts

'use server'

/**
 * The consent surface for a referral attribution (MCV-052).
 *
 * A code typed into a public form is a **claim** — a string somebody who may or
 * may not be this household asserted about this household. These three actions
 * are the only place a claim becomes anything: the signed-in owner of the
 * mailbox is shown it, and says yes or no.
 *
 * ## Why this file exists, in one paragraph
 *
 * Four audit rounds closed four different automatic settlements and each one
 * left the same shape a step earlier, because in every design the last act that
 * moved money was performed by the server on a schedule of its own — a form
 * submission, a sweep, a sign-in event — and the only question left was which
 * unauthenticated input the server should trust to aim it. Round four measured
 * the residue twice over:
 *
 *  1. **Claim precedence was first-writer-wins** while `recordReferralClaim`'s
 *     docblock promised the opposite. A sprayed `HARVEST24` stood, the
 *     household's later genuine `GENUINE24` was dropped because
 *     `attachReferralClaim` returns before the writer for a `matched` identity,
 *     the sprayer was credited 5000 cents, and the genuine inviter was then
 *     locked out for ever by `ALREADY_REFERRED`. Theft plus denial,
 *     deterministic rather than racy. Both halves are answered below — the
 *     lockout by consent, the dropped write by `attachReferralClaim` now
 *     admitting a `matched` identity while `User.unclaimedSince` stands. That
 *     second repair reaches through `requestConsultation` only; see
 *     `recordReferralClaim` in `@/server/referral-claim` for where it does not.
 *  2. **The unauthenticated pre-emption still paid.** One anonymous HTTP call,
 *     then the victim's own organic magic-link sign-in and payment, measured
 *     `examined=1 rewarded=1 creditedCents=5000`. The belief that MCV-050 had
 *     closed it rested on a harness artefact — in `verify-referral-preemption.ts`
 *     the "pre-emption" scenario never called `firstSignIn` and the "genuine
 *     prospect" scenario, byte-identical in mechanism, did. There was no
 *     server-side property separating them, and the mitigation the code named,
 *     `readPendingReferralClaim`, had two callers, both inside that test file.
 *
 * Consent removes the question rather than answering it better. A sprayer's
 * guess cannot outrank a genuine invitation because it is no longer *ranked*
 * against anything — the household chooses, and a household that was never
 * invited declines. A pre-emption yields nothing because nobody consented. The
 * server stops guessing which of two identical HTTP requests carried intent,
 * because the party who holds the mailbox states it.
 *
 * ## The rules these three actions keep
 *
 *  - **`auth: 'SESSION'`, and the profile is always the caller's own.** No
 *    action here reads a profile id, user id or household id from the payload.
 *    `settleAcceptedClaim` and `declineReferralClaim` in `@/server/referral-claim`
 *    cannot check a session — they are plain modules — so their contract is that
 *    the caller passes the resolved session's own id, and this file is the
 *    caller. An id from the payload would hand the whole of MCV-052 straight
 *    back: the one thing standing between a sprayed claim and a payout is that
 *    the party consenting is the party who holds the mailbox.
 *  - **The full canonical predicate runs at acceptance, not at claim time.**
 *    `resolveRedemptionEligibility` is re-asked inside `settleAcceptedClaim`'s
 *    transaction. A claim carries a string and a date and no privilege: between
 *    the enquiry and the click the code may have been withdrawn, expired, filled
 *    its cap, or this household may have become a paying customer.
 *  - **The code is a parameter, never read from the column.** The household is
 *    accepting the *specific* invitation it was shown. A claim overwritten
 *    between render and click is a `superseded` result that consumes nothing —
 *    an acceptance that bound whatever the column happened to hold would be an
 *    automatic settlement wearing a consent button.
 *  - **Nothing here vouches for the claim.** Every read states its provenance
 *    (an anonymous public form) and its assurance (none), and names the party
 *    claiming the credit, so a human can tell an invitation from their friend
 *    apart from a stranger's guess. Accepting a code you were never given is
 *    your mistake to make; being told the business stands behind it would be
 *    ours.
 *
 * ## Why the inviter's name may be shown, and nothing else about them
 *
 * The view carries a display name and never an email, a phone number or a user
 * id. A name is what makes the choice a real one; the rest is somebody else's
 * contact details and no part of this decision.
 *
 * Disclosing even the name is a disclosure, so it is made only when the standing
 * claim is *currently acceptable by this caller* — exactly the state a completed
 * `redeemReferralCode` would have revealed anyway. Every refusal returns no name
 * at all, and the *sentence* it returns is the guest one from
 * `REDEMPTION_REFUSALS`, which deliberately cannot tell "no such code" from
 * "withdrawn".
 *
 * The refusal *reason* is a different matter and is not obscured — see the next
 * section, which does not claim it is.
 *
 * ## Is this read an oracle over the code space?
 *
 * It has to be asked, because a refusal here is more informative than the guest
 * message suggests: `ReferralClaimRefusalView` carries the machine-readable
 * `RedemptionRefusal`, and `EXPIRED`, `FULLY_REDEEMED`, `OWN_CODE` and
 * `SAME_HOUSEHOLD` all distinguish a code that **exists** from one that does
 * not. Only `UNKNOWN_CODE` collapses "no such code" with "withdrawn". So one
 * successful read is worth roughly one probe, and the whole question is how many
 * probes a caller can buy.
 *
 * The answer starts where it did: the caller cannot choose what it reads. There
 * is no code parameter — the string comes from the caller's own
 * `ClientProfile.claimedReferralCode`. What has to be corrected is the next
 * clause. This docblock used to say the column's only writer is
 * `attachReferralClaim`, "which writes it once, for an identity of kind
 * `created` — a household that did not exist a statement earlier". That is false
 * and was the load-bearing sentence of this whole argument.
 * `attachReferralClaim` (`actions/intake.ts`) also admits the write for a
 * `matched` identity while `User.unclaimedSince` is still stamped, so a second
 * anonymous `requestConsultation` at the same address overwrites the column a
 * first one wrote. The real bound is not **written once**; it is **written only
 * while `unclaimedSince` stands**.
 *
 * Re-derived from that weaker property, the conclusion survives — but it now
 * rests on a different fact, and one worth naming because it is not a database
 * constraint:
 *
 *  - This action is `auth: 'SESSION'`, so a caller who reads has signed in.
 *  - `authConfig.events.signIn` calls `markMailboxProved`, which clears
 *    `unclaimedSince` at that first sign-in.
 *  - `attachReferralClaim` refuses a `matched` identity once that stamp is gone.
 *
 * So for any account that can reach this door, the public writer was shut off at
 * the moment the reader was opened. The code standing at first sign-in is the
 * one and only code that account can ever read here. A second guess still costs
 * a second address, a second account and a second proved mailbox — a far worse
 * trade than the ten-an-hour `redeemReferralCode` already offers. The bound
 * holds; it is just held by `markMailboxProved` rather than by the writer.
 *
 * ## The residual that the weaker property creates, named rather than dismissed
 *
 * `markMailboxProved` is called inside a `try`/`catch` in the `signIn` event and
 * a failure is logged and swallowed, correctly — a bookkeeping write must not
 * read to a household as a rejected sign-in. But a sign-in whose call failed
 * leaves `unclaimedSince` standing on an account that now holds a session, and
 * for as long as it stands the two ends are no longer separated: the attacker
 * posts a fresh guess at their own address through `requestConsultation`, then
 * re-reads it here, without a new mailbox each time.
 *
 * In that window the bound is the rate limits and nothing else — five public
 * form posts an hour per IP (`PUBLIC_FORM_RATE_LIMIT`, `scope: 'ip'`, and IP is
 * rotatable) against {@link CLAIM_READ_RATE_LIMIT}'s 120 reads an hour for the
 * one signed-in user. So the sentence that used to close this paragraph —
 * "the rate limits below are defence in depth on top of that bound, not the
 * bound itself" — is wrong in exactly the case that matters. They are defence in
 * depth on the ordinary path and they are the *whole* bound in the degenerate
 * one. The window is one failed database write wide and self-heals at the next
 * sign-in, which re-runs `markMailboxProved`; that is why this is a residual and
 * not a finding. Making it structural would mean giving the claim columns a
 * write condition the database enforces, which is a migration.
 *
 * ## What is recorded, and why a decline leaves a mark
 *
 * A settled acceptance writes a `ReferralRedemption`, which is its own record. A
 * decline writes nothing anywhere — a claim is a string, and clearing it is a
 * compare-and-swap back to `NULL` — so without a mark, "this household said no"
 * would be indistinguishable from "this household was never asked", and the only
 * evidence would be an absence.
 *
 * So every answer that consumes a claim also writes one `InteractionLog` row
 * against the household, keyed by a deterministic `externalRef`. The row is the
 * CRM record an operator needs, and it is also a **tombstone**: a claim for a
 * code this household has already answered is never offered again and can never
 * be accepted, whatever the column later says.
 *
 * That last clause is not hypothetical, and the version of this paragraph that
 * said "today the public path cannot rewrite that column at all —
 * `attachReferralClaim` returns early for a `matched` identity" was simply
 * wrong. The public path *can* rewrite it: `attachReferralClaim` admits a
 * `matched` identity while `User.unclaimedSince` stands. What makes the
 * tombstone hold anyway is that it does not consult the column. A household that
 * has answered for `HARVEST24` has an `InteractionLog` row saying so, and
 * {@link readPendingReferralClaim} and {@link acceptReferralClaim} both check
 * that row *before* the column and clear the column when the two disagree — so a
 * resurrected claim is discarded on sight whether it arrived by a route that
 * exists today or one that does not. The tombstone was written not to depend on
 * the writer's guard, and that turned out to be the right decision rather than a
 * cautious one.
 */

import {
  REFERRAL_PROGRAM_KEY,
  referralCodeSchema,
  type ReferralRedemptionStatus,
} from '@mannachef/validators'
import { emptyInputSchema } from '@mannachef/api-contract'
import { z } from 'zod'

import { fail, ok, type ActionResult } from '@/server/actions/types'
import { Prisma } from '@/server/db'
import { withAction } from '@/server/guards'
import {
  CLAIM_WINDOW_DAYS,
  declineReferralClaim as clearStandingClaim,
  readPendingReferralClaim as readStandingClaim,
  settleAcceptedClaim,
} from '@/server/referral-claim'
import {
  resolveRedemptionEligibility,
  REDEMPTION_REFUSALS,
  type RedemptionRefusal,
} from '@/server/referral-eligibility'
import { readReferralProgramRow } from '@/server/referral-program'

// =============================================================================
// 0. Constants
// =============================================================================

/**
 * Screens whose content changes when a claim is answered.
 *
 * `/portal` is included because the prompt itself lives on the portal shell —
 * a household that has just declined must not find the same banner waiting on
 * the next navigation.
 */
const CLAIM_PATHS = ['/portal', '/portal/referrals', '/portal/rewards'] as const

const CLAIM_TAGS = ['referrals', 'rewards', 'reward-ledger'] as const

/**
 * Answering a claim is a once-in-a-household act, so twelve an hour is already
 * far past any honest use.
 *
 * It is not the defence — see the module docblock on why this door cannot be
 * aimed — it is the bound on how fast a compromised session can churn the
 * `InteractionLog` and the eligibility predicate.
 */
const CLAIM_DECISION_RATE_LIMIT = {
  tokens: 12,
  windowMs: 60 * 60 * 1_000,
} as const

/**
 * The read runs the full eligibility predicate and two extra lookups, so it is
 * bounded too — generously, because a portal page may legitimately re-read it
 * on every navigation.
 */
const CLAIM_READ_RATE_LIMIT = {
  tokens: 120,
  windowMs: 60 * 60 * 1_000,
} as const

/**
 * The sentence the UI is obliged to be able to say.
 *
 * Returned as data rather than left to the component, so that a screen cannot
 * render the inviter's name without also having the disclaimer in hand. The
 * business does not vouch for a claim: anybody at all can type a code into the
 * public enquiry form.
 */
const CLAIM_DISCLOSURE =
  'This invitation code was typed into our enquiry form. We have not verified who typed it, and we are not vouching for it — please accept it only if you recognise the invitation.'

// =============================================================================
// 1. Input schemas
// =============================================================================

/**
 * Both decisions take the code that was rendered, and nothing else.
 *
 * Composed from `referralCodeSchema` so the household's spacing, hyphens and
 * lower case are normalised the same way `redeemReferralCode` normalises them —
 * the string compared against the column has to be the string the column holds.
 *
 * `.strict()` for the reason every other action is strict, and with one extra
 * edge here: a `clientProfileId` or `userId` smuggled into this payload must be
 * a validation failure rather than a field somebody later reads.
 */
const referralClaimDecisionSchema = z
  .object({ code: referralCodeSchema })
  .strict()

// =============================================================================
// 2. Views
// =============================================================================

/** Why a standing claim cannot be turned into a redemption right now. */
export interface ReferralClaimRefusalView {
  /**
   * The machine-readable refusal, so a screen can branch on it.
   *
   * More informative than {@link message}: `EXPIRED`, `FULLY_REDEEMED`,
   * `OWN_CODE` and `SAME_HOUSEHOLD` each imply the code exists. That is
   * deliberate and it is what the module docblock's oracle section is bounding —
   * the caller cannot choose which code is examined, so a reason is worth one
   * probe and a probe costs a proved mailbox.
   */
  readonly reason: RedemptionRefusal
  /** The guest sentence from `REDEMPTION_REFUSALS`. Never a Prisma message. */
  readonly message: string
}

/**
 * What the standing claim is worth and who is claiming the credit for it.
 *
 * Present only when the claim is acceptable *at this moment*. See the module
 * docblock: a name is disclosed exactly when a completed redemption would have
 * disclosed it anyway.
 */
export interface ReferralClaimAttributionView {
  /**
   * The inviter as they are known to us, or `null` when we hold no name for
   * them.
   *
   * Never an email address, a phone number or a user id. `null` is a real
   * answer and the screen should say so plainly ("a member who has not given us
   * a name") rather than inventing one — an unnamed inviter is exactly the case
   * a household should look at twice.
   */
  readonly inviterDisplayName: string | null
  /**
   * What this household would receive, in whole cents, or `null` when neither
   * the code nor the standing programme names a figure for the referred party.
   *
   * Taken from the code, falling back to `ReferralProgram.refereeRewardCents`,
   * because a code is minted from the standing offer and a code that carries no
   * referee figure of its own is offering the standing one.
   */
  readonly refereeRewardCents: number | null
  readonly currency: string
  /** The code's own expiry, when it states one. */
  readonly codeExpiresAt: Date | null
}

/** Whether the standing claim can be acted on, and on what terms. */
export type ReferralClaimStanding =
  /** Acceptable now. The only arm that carries an attribution. */
  | {
      readonly kind: 'acceptable'
      readonly attribution: ReferralClaimAttributionView
    }
  /** Older than {@link CLAIM_WINDOW_DAYS}. Only declining is left. */
  | { readonly kind: 'lapsed' }
  /** The canonical predicate refuses it as things stand. */
  | {
      readonly kind: 'unacceptable'
      readonly refusal: ReferralClaimRefusalView
    }

/** The standing claim, as a consent prompt renders it. */
export interface PendingReferralClaimView {
  readonly code: string
  readonly claimedAt: Date
  /**
   * The last moment this claim may be accepted — `claimedAt` plus
   * {@link CLAIM_WINDOW_DAYS}.
   *
   * Distinct from `attribution.codeExpiresAt`, which is the code's own expiry.
   * Both bind; this one is the floor under codes that carry no expiry at all,
   * and it is what stops a sprayed attribution from being a standing bet on any
   * mailbox ever becoming a customer.
   */
  readonly expiresAt: Date
  readonly standing: ReferralClaimStanding
  /**
   * Where the claim came from.
   *
   * A constant, and it is honest as one: `recordReferralClaim` is the only
   * writer of a non-null value into that column, and it is reachable only
   * through the two public intake actions. A *signed-in* caller of those actions
   * never reaches it, because `resolveIdentity` reports `matched` for a session
   * and `attachReferralClaim` then requires `User.unclaimedSince`, which that
   * caller's own sign-in cleared. So every claim this view can describe was
   * typed by somebody who had proved nothing.
   */
  readonly provenance: 'public-enquiry-form'
  /** Nobody has verified that the party who typed this knows this household. */
  readonly assurance: 'unverified'
  /** @see CLAIM_DISCLOSURE */
  readonly disclosure: string
}

/** What {@link acceptReferralClaim} did. */
export type ReferralClaimAcceptanceView =
  /** A `PENDING` redemption now exists, written by the one canonical writer. */
  | {
      readonly kind: 'accepted'
      readonly code: string
      readonly redemptionId: string
      readonly status: ReferralRedemptionStatus
      readonly refereeRewardCents: number | null
      readonly currency: string
    }
  /** Past {@link CLAIM_WINDOW_DAYS}. Consumed and discarded. */
  | {
      readonly kind: 'expired'
      readonly code: string
      readonly claimedAt: Date
    }
  /** The canonical predicate refused it now. Consumed and discarded. */
  | {
      readonly kind: 'refused'
      readonly code: string
      readonly refusal: ReferralClaimRefusalView
    }
  /** Nothing is standing for this household. Re-read; there is nothing to show. */
  | { readonly kind: 'nothing-standing' }
  /**
   * This household has already answered for this code — here, in another tab,
   * or in an earlier session. Idempotent no-op.
   */
  | { readonly kind: 'already-answered'; readonly code: string }
  /**
   * A different claim is standing than the one that was rendered. Nothing was
   * consumed; re-read and ask again.
   */
  | { readonly kind: 'superseded'; readonly standing: string }

/** What {@link declineReferralClaim} did. */
export type ReferralClaimDeclineView =
  /** Cleared and tombstoned. It will not be offered again. */
  | { readonly kind: 'declined'; readonly code: string }
  | { readonly kind: 'nothing-standing' }
  | { readonly kind: 'already-answered'; readonly code: string }
  | { readonly kind: 'superseded'; readonly standing: string }

// =============================================================================
// 3. The tombstone
// =============================================================================

/**
 * Every way a household can finish with a claim.
 *
 * `expired` and `refused` are recorded alongside `accepted` and `declined`
 * because all four **consume** the claim, and a consumed claim that left no
 * trace is the state this file exists to stop being possible.
 */
type ClaimAnswer = 'accepted' | 'declined' | 'expired' | 'refused'

const CLAIM_ANSWERS = [
  'accepted',
  'declined',
  'expired',
  'refused',
] as const satisfies readonly ClaimAnswer[]

/**
 * The `InteractionLog.externalRef` that stands for "this household answered for
 * this code".
 *
 * `externalRef` is documented as a provider message id for deduplication, and
 * this is the same job done for a different producer: a stable string that makes
 * a second write of the same fact recognisable. It is `@db.VarChar(255)` and an
 * invitation code is at most twelve characters, so the key cannot overflow.
 */
function claimAnswerRef(answer: ClaimAnswer, code: string): string {
  return `referral-claim:${answer}:${code}`
}

/** Every ref that would mean this household has already answered for `code`. */
function claimAnswerRefs(code: string): string[] {
  return CLAIM_ANSWERS.map((answer) => claimAnswerRef(answer, code))
}

/**
 * Has this household already finished with this code?
 *
 * Consulted before anything is offered and before anything is settled. A `true`
 * here outranks the column: a claim that reappears against a code already
 * answered is not a second invitation, it is a resurrection, and the only way
 * one could arise is a writer that should not exist.
 */
async function claimAlreadyAnswered(
  db: Prisma.TransactionClient,
  clientProfileId: string,
  code: string
): Promise<boolean> {
  const answered = await db.interactionLog.findFirst({
    where: { clientProfileId, externalRef: { in: claimAnswerRefs(code) } },
    select: { id: true },
  })

  return answered !== null
}

/** The line an operator reads in the household's timeline. */
function claimAnswerSubject(answer: ClaimAnswer, code: string): string {
  switch (answer) {
    case 'accepted':
      return `Invitation ${code} accepted by the household`
    case 'declined':
      return `Invitation ${code} declined by the household`
    case 'expired':
      return `Invitation ${code} had lapsed when the household accepted it`
    case 'refused':
      return `Invitation ${code} could not be accepted by the household`
  }
}

/**
 * Write the tombstone.
 *
 * `INBOUND` and `IN_APP`: the household told us this, through the portal.
 * `loggedById` is the household's own user, because they are the author of the
 * decision — an operator reading the timeline must not be able to mistake this
 * for something the concierge did on their behalf.
 *
 * The existence check and the insert are not one statement, because
 * `externalRef` carries no unique constraint. Two simultaneous declines can
 * therefore write two rows, which costs a duplicate line in a timeline and
 * changes nothing else: the tombstone is read by presence, so one row and two
 * rows mean the same thing. A unique index would be the tidier answer and it is
 * a migration, which this change is not.
 *
 * Failure to write is not allowed to fail the action. The claim has already been
 * consumed by the time this runs; turning a completed decision into an error the
 * household is invited to retry would be strictly worse than a missing timeline
 * entry, and the retry could not undo the consumption anyway.
 */
async function recordClaimAnswer(
  db: Prisma.TransactionClient,
  clientProfileId: string,
  userId: string,
  answer: ClaimAnswer,
  code: string,
  detail: string,
  now: Date
): Promise<void> {
  const externalRef = claimAnswerRef(answer, code)

  try {
    const existing = await db.interactionLog.findFirst({
      where: { clientProfileId, externalRef },
      select: { id: true },
    })

    if (existing !== null) {
      return
    }

    await db.interactionLog.create({
      data: {
        clientProfileId,
        loggedById: userId,
        channel: 'IN_APP',
        direction: 'INBOUND',
        subject: claimAnswerSubject(answer, code),
        body: detail,
        occurredAt: now,
        externalRef,
      },
      select: { id: true },
    })
  } catch (error) {
    console.error(
      '[action:referral.claim] failed to record claim answer',
      error
    )
  }
}

// =============================================================================
// 4. Shared lookups
// =============================================================================

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

/** The last moment a claim taken at `claimedAt` may be accepted. */
function claimExpiresAt(claimedAt: Date): Date {
  return new Date(
    claimedAt.getTime() + CLAIM_WINDOW_DAYS * MILLISECONDS_PER_DAY
  )
}

/**
 * The caller's own `ClientProfile` id, or `null` when they have none.
 *
 * Keyed on `userId` — the session's, never a payload's. This is the ownership
 * check CONTRACT.md §5 step 4 asks for, expressed as the only way these actions
 * can name a household at all: there is no code path here that accepts a
 * profile id, so there is none that could fail to check one.
 */
async function readOwnClientProfileId(
  db: Prisma.TransactionClient,
  userId: string
): Promise<string | null> {
  const profile = await db.clientProfile.findUnique({
    where: { userId },
    select: { id: true },
  })

  return profile === null ? null : profile.id
}

/** Turn a refusal into the pair the client renders. */
function toRefusalView(reason: RedemptionRefusal): ReferralClaimRefusalView {
  return { reason, message: REDEMPTION_REFUSALS[reason].message }
}

/**
 * Drop a claim the household has already answered for.
 *
 * Called by the read when the tombstone and the column disagree. The column is
 * the thing that could have been written by somebody else, so the column is the
 * thing that gives way — and it is cleared rather than merely hidden, so the
 * disagreement does not survive to be found again on the next read.
 *
 * Guarded on the exact code, so a claim that changed between the tombstone check
 * and this statement is left alone for the next read to judge on its own terms.
 */
async function discardAnsweredClaim(
  db: Prisma.TransactionClient,
  clientProfileId: string,
  code: string
): Promise<void> {
  await db.clientProfile.updateMany({
    where: { id: clientProfileId, claimedReferralCode: code },
    data: { claimedReferralCode: null, claimedReferralCodeAt: null },
  })
}

// =============================================================================
// 5. Read
// =============================================================================

/**
 * The claim standing against the caller's own household, if any.
 *
 * `null` covers every shape of nothing — no `ClientProfile`, no claim on it, or
 * a claim this household has already answered for — because a consent prompt has
 * exactly one question to ask of this result: is there something to show.
 *
 * The `standing` arm is what makes the prompt honest. A lapsed or refused claim
 * is still returned, with the reason, so the screen can say "that invitation has
 * expired" instead of silently showing nothing and leaving a household wondering
 * where the code their friend gave them went. Only the `acceptable` arm carries
 * the inviter's name and the figure — see the module docblock on why disclosure
 * is tied to acceptability.
 *
 * Nothing on the public path may reach this. A claim read back to an anonymous
 * caller would turn the enquiry form into an oracle over which addresses we
 * hold, which is the property the null receipt ids in `actions/intake.ts` exist
 * to protect. `auth: 'SESSION'` is what enforces that here.
 */
export const readPendingReferralClaim = withAction(
  {
    name: 'referral.claim.read',
    auth: 'SESSION',
    input: emptyInputSchema,
    rateLimit: CLAIM_READ_RATE_LIMIT,
  },
  async (ctx): Promise<ActionResult<PendingReferralClaimView | null>> => {
    const now = new Date()
    const claim = await readStandingClaim(ctx.user.id, now)

    if (claim === null) {
      return ok(null)
    }

    const clientProfileId = await readOwnClientProfileId(ctx.db, ctx.user.id)

    if (clientProfileId === null) {
      // `readStandingClaim` reads the claim through the profile, so this is
      // only reachable if the profile was deleted between the two statements.
      return ok(null)
    }

    if (await claimAlreadyAnswered(ctx.db, clientProfileId, claim.code)) {
      await discardAnsweredClaim(ctx.db, clientProfileId, claim.code)
      return ok(null)
    }

    const standing = await resolveStanding(ctx.db, ctx.user.id, claim)

    return ok({
      code: claim.code,
      claimedAt: claim.claimedAt,
      expiresAt: claimExpiresAt(claim.claimedAt),
      standing,
      provenance: 'public-enquiry-form',
      assurance: 'unverified',
      disclosure: CLAIM_DISCLOSURE,
    })
  }
)

/**
 * Ask the canonical predicate what this claim is worth to this household today.
 *
 * A preview, and named as one: nothing here binds, and {@link acceptReferralClaim}
 * asks the same questions again inside the transaction that writes. The two can
 * legitimately disagree if the code fills its cap in between, which is why the
 * acceptance reports its own outcome rather than trusting what was rendered.
 *
 * `applyHouseholdHeuristic` is `true` and is not parameterised. The escape hatch
 * belongs to an `ADMIN` acting deliberately through `redeemReferralCode`; a
 * client consenting on their own behalf is not an administrator.
 *
 * `establishedAt` is the moment the code was *typed*, not the moment of this
 * read — the same instant the acceptance will anchor on, so the preview answers
 * the question the settlement will answer. Dating it to now would let a bill
 * paid in the meantime read as prior custom and show `ALREADY_A_CUSTOMER` for a
 * perfectly genuine acquisition.
 */
async function resolveStanding(
  db: Prisma.TransactionClient,
  userId: string,
  claim: {
    readonly code: string
    readonly claimedAt: Date
    readonly lapsed: boolean
  }
): Promise<ReferralClaimStanding> {
  if (claim.lapsed) {
    return { kind: 'lapsed' }
  }

  const eligibility = await resolveRedemptionEligibility(
    db,
    { kind: 'code', code: claim.code },
    userId,
    { applyHouseholdHeuristic: true, establishedAt: claim.claimedAt }
  )

  if (eligibility.kind === 'refused') {
    return { kind: 'unacceptable', refusal: toRefusalView(eligibility.reason) }
  }

  const [inviter, program] = await Promise.all([
    db.user.findUnique({
      // `ownerId` is used here and never returned. The view carries a name or
      // nothing.
      where: { id: eligibility.code.ownerId },
      select: { name: true },
    }),
    readReferralProgramRow(db, REFERRAL_PROGRAM_KEY),
  ])

  return {
    kind: 'acceptable',
    attribution: {
      inviterDisplayName: inviter === null ? null : inviter.name,
      refereeRewardCents:
        eligibility.code.refereeRewardCents ??
        (program === null ? null : program.refereeRewardCents),
      currency: eligibility.code.currency,
      codeExpiresAt: eligibility.code.expiresAt,
    },
  }
}

// =============================================================================
// 6. Accept
// =============================================================================

/**
 * The household affirms the attribution, and only then does it become money.
 *
 * This is the single consent gate the whole of MCV-052 turns on. Everything it
 * does is delegated to `settleAcceptedClaim`, which re-runs the full canonical
 * eligibility predicate at this moment and settles through the one canonical
 * writer inside one transaction; this action's job is the part a plain module
 * cannot do — establish that the party consenting is the party who holds the
 * mailbox, and pass *that* id.
 *
 * ## Idempotent, and consuming either way
 *
 * `settleAcceptedClaim` compare-and-swaps both claim columns back to `NULL`
 * before it decides anything, so a claim is a one-shot token: a second click, a
 * duplicated form post or a replayed request meets `nothing-standing` or
 * `already-answered` and writes nothing. Expiry and refusal consume the claim
 * too — a refused invitation that stayed on the profile would be a prompt the
 * household is asked to answer again every time the page renders.
 *
 * The one outcome that does *not* consume is `superseded`: a different code is
 * standing than the one the household was shown, so the answer belongs to a
 * question nobody asked. Nothing is taken and the surface re-reads.
 *
 * A lost race rolls the whole transaction back inside `settleAcceptedClaim`,
 * taking the claim's consumption with it, and surfaces here as
 * `already-answered` — the concurrent acceptance is the one that settles it.
 */
export const acceptReferralClaim = withAction(
  {
    name: 'referral.claim.accept',
    auth: 'SESSION',
    input: referralClaimDecisionSchema,
    rateLimit: CLAIM_DECISION_RATE_LIMIT,
    revalidatePaths: CLAIM_PATHS,
    revalidateTags: CLAIM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralClaimAcceptanceView>> => {
    const now = new Date()
    const clientProfileId = await readOwnClientProfileId(ctx.db, ctx.user.id)

    if (clientProfileId === null) {
      return ok({ kind: 'nothing-standing' })
    }

    // Before anything is consumed: a code this household has already finished
    // with is finished with, whatever the column now says.
    if (await claimAlreadyAnswered(ctx.db, clientProfileId, input.code)) {
      await discardAnsweredClaim(ctx.db, clientProfileId, input.code)
      return ok({ kind: 'already-answered', code: input.code })
    }

    // `ctx.user.id` — the resolved session's own id. There is no branch here in
    // which this is anything else.
    const outcome = await settleAcceptedClaim(ctx.user.id, input.code, now)

    switch (outcome.kind) {
      case 'no-account':
        // Deactivated between the read and this call. The session is stale.
        return fail(
          'NOT_FOUND',
          'We could not find that account. Please sign in again.'
        )

      case 'nothing-claimed':
        return ok({ kind: 'nothing-standing' })

      case 'mismatch':
        return ok({ kind: 'superseded', standing: outcome.standing })

      case 'raced':
        return ok({ kind: 'already-answered', code: input.code })

      case 'lapsed':
        await recordClaimAnswer(
          ctx.db,
          clientProfileId,
          ctx.user.id,
          'expired',
          outcome.code,
          `The household accepted this invitation, but it had been claimed on ${outcome.claimedAt.toISOString()}, more than ${CLAIM_WINDOW_DAYS} days earlier. The claim was discarded and nothing was credited.`,
          now
        )

        return ok({
          kind: 'expired',
          code: outcome.code,
          claimedAt: outcome.claimedAt,
        })

      case 'refused': {
        const refusal = toRefusalView(outcome.reason)

        await recordClaimAnswer(
          ctx.db,
          clientProfileId,
          ctx.user.id,
          'refused',
          outcome.code,
          `The household accepted this invitation and it was refused (${outcome.reason}). The claim was discarded and nothing was credited.`,
          now
        )

        return ok({ kind: 'refused', code: outcome.code, refusal })
      }

      case 'settled': {
        const settled = await ctx.db.referralRedemption.findUnique({
          where: { id: outcome.redemptionId },
          select: {
            status: true,
            currency: true,
            referralCode: { select: { refereeRewardCents: true } },
          },
        })

        await recordClaimAnswer(
          ctx.db,
          clientProfileId,
          ctx.user.id,
          'accepted',
          outcome.code,
          `The household accepted this invitation. Redemption ${outcome.redemptionId} was written and awaits qualification.`,
          now
        )

        return ok({
          kind: 'accepted',
          code: outcome.code,
          redemptionId: outcome.redemptionId,
          // The row was written a statement ago inside a committed
          // transaction, so `null` here means it has been deleted from under
          // us. Report the state the writer produced rather than guessing.
          status: settled === null ? 'PENDING' : settled.status,
          refereeRewardCents:
            settled === null ? null : settled.referralCode.refereeRewardCents,
          currency: settled === null ? 'CAD' : settled.currency,
        })
      }
    }
  }
)

// =============================================================================
// 7. Decline
// =============================================================================

/**
 * The household rejects the attribution.
 *
 * Consent is a choice and a choice needs both answers. Without this, the only
 * way to be rid of an invitation a stranger sprayed at your address would be to
 * wait {@link CLAIM_WINDOW_DAYS} for it to lapse — which leaves the prompt in
 * front of the household for a month, and a prompt that cannot be dismissed is
 * one people eventually click through.
 *
 * Nothing is reversed, because nothing was written: a claim is a string, and
 * declining is a compare-and-swap on the two columns holding it, guarded on the
 * code that was shown for the same reason the acceptance is guarded on it.
 *
 * ## Why the decline outlives the claim
 *
 * A tombstone is written, and {@link readPendingReferralClaim} and
 * {@link acceptReferralClaim} both consult it before the column. So a claim that
 * reappears against a declined code — by any route, including one that does not
 * exist today — is discarded on sight rather than offered a second time. "No"
 * said once is said for good, which is the difference between consent and a
 * prompt that keeps asking.
 *
 * The tombstone is written *after* the swap, and only when the swap took the
 * claim. Recording a decline that did not happen would be worse than recording
 * nothing: it would suppress a genuine invitation the household never saw.
 */
export const declineReferralClaim = withAction(
  {
    name: 'referral.claim.decline',
    auth: 'SESSION',
    input: referralClaimDecisionSchema,
    rateLimit: CLAIM_DECISION_RATE_LIMIT,
    revalidatePaths: CLAIM_PATHS,
    revalidateTags: CLAIM_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ReferralClaimDeclineView>> => {
    const now = new Date()
    const clientProfileId = await readOwnClientProfileId(ctx.db, ctx.user.id)

    if (clientProfileId === null) {
      return ok({ kind: 'nothing-standing' })
    }

    if (await claimAlreadyAnswered(ctx.db, clientProfileId, input.code)) {
      await discardAnsweredClaim(ctx.db, clientProfileId, input.code)
      return ok({ kind: 'already-answered', code: input.code })
    }

    // `ctx.user.id` — the resolved session's own id, as the module's caller
    // contract requires.
    const dismissal = await clearStandingClaim(ctx.user.id, input.code)

    switch (dismissal.kind) {
      case 'nothing-claimed':
        return ok({ kind: 'nothing-standing' })

      case 'mismatch':
        return ok({ kind: 'superseded', standing: dismissal.standing })

      case 'declined':
        await recordClaimAnswer(
          ctx.db,
          clientProfileId,
          ctx.user.id,
          'declined',
          dismissal.code,
          'The household declined this invitation. The claim was cleared and will not be offered again.',
          now
        )

        return ok({ kind: 'declined', code: dismissal.code })
    }
  }
)
