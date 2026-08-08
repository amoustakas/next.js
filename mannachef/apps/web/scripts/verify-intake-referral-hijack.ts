// mannachef/apps/web/scripts/verify-intake-referral-hijack.ts

/**
 * The MCV-040 finding A regression: a referral may not be attached to an
 * account the caller did not just open.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma db push
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:intake-hijack
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable — see `assertDisposableDatabase` in
 * `fixtures/intake-harness.ts`.
 *
 * ## The exploit this exists to keep dead
 *
 * `requestConsultation` and `submitProspectIntake` are both `auth: 'PUBLIC'`.
 * Both resolved the enquiry's subject through `resolveIdentity`, whose
 * anonymous branch is a lookup by the payload's own email address —
 * `tx.user.findUnique({ where: { email: contact.email } })` — and both then
 * handed the resulting `userId` to `attachReferral` as a bare string.
 *
 * So:
 *
 *  1. an ordinary `CLIENT` mints one programme-priced invitation code, which
 *     `createReferralCode` is happy to give them;
 *  2. with **no session, no password and no access to the mailbox**, they post
 *     the public consultation form carrying `email: <a paying household's
 *     address>` and `referralCode: <their own>`;
 *  3. `resolveIdentity` matches the victim's real `User` and returns it;
 *  4. `attachReferral` writes a `PENDING` `ReferralRedemption` naming the victim
 *     as the referred party;
 *  5. the victim pays a genuine `PAID` invoice clearing the programme's floor —
 *     they are a subscriber, so this is simply their next bill — and
 *     `findQualifyingInvoice` succeeds on the following sweep, crediting the
 *     attacker.
 *
 * Nothing in that sequence needs the victim to do anything they were not
 * already going to do.
 *
 * ## Step 5 used to need even less than that (MCV-051)
 *
 * As originally found, step 5 did not wait for a new bill: the victim's
 * *existing* invoice, paid months before the attacker had ever heard of them,
 * qualified the redemption, because `findQualifyingInvoice` searched the whole
 * of a household's billing history with no lower bound. MCV-051 put that bound
 * in — `ReferralRedemption.qualifyingFromAt` — so scenario 1 now seeds the
 * victim's *next* invoice to reach the payout, and asserts first that the
 * historical one alone no longer does.
 *
 * That is defence in depth and not a reason to relax anything here. MCV-051
 * refuses the *money*; finding A is about the *row*, which a stranger could
 * still cause to be written against somebody else's household, and which would
 * still be paid the moment that household paid us again.
 *
 * ## Why the file docblock did not catch it
 *
 * It enumerated the protections an anonymous email claim runs into, and
 * promised that of a matched household "not one of their columns is written".
 * `attachReferral` writes no column. It writes a **row**, in another table, and
 * that row is money. The fix restates the enumeration over rows as well as
 * columns, and — so that the restatement is enforced rather than merely
 * written down — gives `resolveIdentity` a `'created' | 'matched'` discriminant
 * and makes `attachReferral` take the whole identity, so there is no way to
 * spell a call to it that does not carry the provenance along.
 *
 * ## What MCV-050 then did to the same door
 *
 * The `created` discriminant turned out to answer the wrong question — see
 * `verify-referral-preemption.ts`, which is the regression for that — so the
 * public path no longer writes a `ReferralRedemption` under **any**
 * discriminant. It records `ClientProfile.claimedReferralCode`, a string, and
 * `acceptReferralClaim` writes the redemption when the household — signed in,
 * holding the mailbox — says the invitation is theirs. Settling automatically at
 * the first sign-in, which is what this said before MCV-052, paid a sprayer off
 * a victim's own organic sign-in.
 *
 * ## What MCV-054 finding 2 did to *this file*
 *
 * Nothing about the claim changed. What changed is that this harness had stopped
 * being able to see it, in three ways at once, and the three compounded into a
 * false green:
 *
 *  1. **It stopped short.** Scenarios 2 and 3 posted the enquiry and then
 *     declined to perform the two steps their contrasting scenario performs —
 *     the victim proving their mailbox, and the victim pressing *accept*. The
 *     shipped path does not pay at enquiry time under any circumstances, so a
 *     scenario that stops at the enquiry is asserting a tautology. What decides
 *     the money is whether a claim was standing when somebody accepted, and
 *     nobody accepted.
 *  2. **The contrast was a string.** Scenario 2 differed from scenario 4 only in
 *     which `const` email literal it passed. The server has never seen those
 *     literals as anything but bytes; what it keys on is whether a `User`
 *     already holds the address and whether `User.unclaimedSince` is still
 *     stamped on it. So the harness's premise lived in its own vocabulary
 *     instead of in the database.
 *  3. **It read the wrong rows.** "Not one column of the patron's account moved"
 *     was checked against an `accountSnapshot` whose select omitted
 *     `claimedReferralCode` and `claimedReferralCodeAt` — the only two columns
 *     the attack writes. The reader that would have seen them, `referralClaimOf`,
 *     was called in scenario 4 and nowhere else.
 *
 * Measured: deleting the `isUnprovedPlaceholder` guard from
 * `attachReferralClaim`, so that any anonymous caller may stamp a claim onto any
 * existing household including a paying `ACTIVE_SUBSCRIBER`, left the previous
 * version of this file printing `PASS — 24 assertions, 0 failures` and a summary
 * table reading "redemptions written 0 / credited $0.00", with a stranger's code
 * standing on the victim's file.
 *
 * All three are fixed below, and the shape of the fix is the point: scenarios 2,
 * 3, 4 and 5 now run **one** sequence, {@link runEnquiry}, which always performs
 * every step — post, prove the mailbox, accept, pay, sweep. The only things that
 * differ between them are server-side properties of the world the enquiry
 * arrives in, and what each expects is *derived from that property* by
 * {@link expectedFor} rather than written down per scenario. Swap the addresses
 * and the expectations swap with them; delete the guard and the established
 * household's row stops matching.
 *
 * ## How the two columns of the report are produced
 *
 * The "after" column is the **real** `requestConsultation`, the **real**
 * `submitProspectIntake` and the **real** `acceptReferralClaim`, driven through
 * the real `withAction` wrapper, the real zod schemas and the real rate limiter,
 * against a real PostgreSQL. The money figures come from the **real**
 * `settleReferralRedemptions`.
 *
 * The "before" column is the pre-fix source, reproduced in
 * `fixtures/intake-legacy.ts` and running against the same database — see that
 * file for why the defect is transcribed rather than switched, and scenario 4
 * for the assertion that keeps the transcription honest.
 *
 * ## The seven scenarios
 *
 * | # | Door           | Poster    | Address provenance             | Proves                                |
 * | - | -------------- | --------- | ------------------------------ | ------------------------------------- |
 * | 0 | —              | —         | —                              | the snapshot can see the two columns  |
 * | 1 | pre-fix source | stranger  | `established-and-paying`       | $50.00 to an unauthenticated stranger |
 * | 2 | consultation   | stranger  | `established-and-paying`       | no claim, no redemption, no credit    |
 * | 3 | questionnaire  | stranger  | `established-and-paying`       | the second entry point is closed too  |
 * | 4 | consultation   | stranger  | `unknown`                      | the programme still pays, end to end  |
 * | 5 | consultation   | household | `established-and-paying`       | a session is not a licence either     |
 * | 6 | consultation   | stranger  | `established-and-owed-nothing` | the guard alone stops $50.00          |
 *
 * Read the table by columns rather than by rows. 2 and 3 differ from each other
 * only in which shipped action ran; 2 and 4 differ only in what the database
 * already held for the address; 2 and 5 differ only in whether a session was
 * resolved when the enquiry was posted; 2 and 6 differ only in whether that
 * household had ever paid us. Every one of those is something the server can
 * observe, and each is asserted rather than assumed —
 * {@link establishedTarget} finds its household by the properties that make it
 * one, and {@link unknownTarget} refuses to proceed unless the address really is
 * held by nobody.
 *
 * Scenario 0 asserts nothing about the application at all. It checks that the
 * instrument the rest of the file reads through can see the columns the attack
 * writes, because for three rounds it could not. Scenario 6 is the other half of
 * the same worry: see {@link EstablishedProvenance} for why proving the guard
 * against the *paying* patron proves the wrong lock.
 *
 * ## Which lock answers which door, measured rather than assumed
 *
 * The two public doors are not closed by the same thing, and saying otherwise
 * was the last piece of this file that was not true. Established by running each
 * scenario against a build with `isUnprovedPlaceholder` deleted from
 * `attachReferralClaim`:
 *
 *  - **`requestConsultation`** reaches `attachReferralClaim` for a `matched`
 *    identity, and `isUnprovedPlaceholder` is what refuses the write. Scenarios
 *    2, 5 and 6 go red when it is deleted.
 *  - **`submitProspectIntake`** never gets that far. For an anonymous caller
 *    naming a household we already hold it takes the `withheld` branch and
 *    returns *before* `input.contact.referralCode` is looked at, so the referral
 *    code is moot on that path. Scenario 3 stays green under the same mutation,
 *    and that is a fact about the code rather than a weakness in the scenario —
 *    so scenario 3 asserts the lock that does answer it, the `withheld`
 *    branch's own line on the concierge's timeline. Delete *that* branch and
 *    scenario 3 goes red; the door then falls through to
 *    `attachReferralClaim`, where the guard catches it and scenario 3's claim
 *    assertion is waiting.
 *  - Scenario 6 is the only one where `isUnprovedPlaceholder` is the sole lock
 *    between the sprayed code and the money. Deleting it there credits the
 *    attacker $50.00.
 *
 * A scenario whose assertions cannot fail is not a regression, and the way to
 * find out which ones those are is to break the thing on purpose and watch. Do
 * that again before trusting anything added to this file.
 */

import assert from 'node:assert/strict'

import {
  requestConsultation,
  submitProspectIntake,
} from '@/server/actions/intake'
import {
  createReferralCode,
  settleReferralRedemptions,
} from '@/server/actions/referral'
import { acceptReferralClaim } from '@/server/actions/referral-claim'
import type { ActionResult } from '@/server/actions/types'
import { prisma } from '@/server/db'

import { legacyRequestConsultation } from './fixtures/intake-legacy'
import { signInAs, type HarnessUser } from './fixtures/harness-state'
import {
  ATTACKER,
  OVERSEER,
  PATRON,
  UNANSWERED,
  type AccountSnapshot,
  type RedemptionRow,
  type ReferralClaimSnapshot,
  accountSnapshot,
  assertDisposableDatabase,
  balanceCentsOf,
  check,
  checkCount,
  clearRateLimits,
  consultationCountOf,
  consultationPayload,
  disconnect,
  interactionSubjectsOf,
  money,
  note,
  printTable,
  profileIdForEmail,
  prospectPayload,
  provedSessionFor,
  redemptionsForCode,
  referralClaimOf,
  resetDatabase,
  section,
  seedBareUser,
  seedHousehold,
  seedProgram,
  userIdForEmail,
} from './fixtures/intake-harness'

// =============================================================================
// 1. The figures
// =============================================================================

/** What the programme pays an inviter. The finding's `$50.00`. */
const REWARD_CENTS = 5_000

/** The floor a referred household's invoice must clear to qualify. */
const FLOOR_CENTS = 10_000

/** What the patron has genuinely already paid us. Well over the floor. */
const PATRON_INVOICE_CENTS = 24_000

/**
 * The next bill a household pays after the enquiry, in every scenario.
 *
 * One figure rather than one per scenario, because "the household paid us" must
 * not be a way for two scenarios to differ. For the established household this
 * is their next subscription bill; for the newcomer it is their first. Both
 * clear {@link FLOOR_CENTS}, which is the only thing the sweep asks.
 */
const NEXT_INVOICE_CENTS = 18_000

const CODE = 'HARVEST24'

// =============================================================================
// 2. Staging
// =============================================================================

/**
 * The world every scenario starts from: a standing offer, an attacker with a
 * `ClientProfile`, a patron who has paid, and a concierge to run the sweep.
 *
 * The code itself is minted through the **real** `createReferralCode` as the
 * attacker, because "an ordinary CLIENT mints one programme-priced code" is
 * step one of the exploit and it should be the action that proves it rather
 * than an `INSERT`.
 */
async function stage(): Promise<string> {
  await resetDatabase()

  await seedProgram({
    rewardValueCents: REWARD_CENTS,
    minimumQualifyingInvoiceCents: FLOOR_CENTS,
    defaultMaxRedemptions: null,
  })

  await seedHousehold({ person: ATTACKER, status: 'PROSPECT' })
  await seedHousehold({
    person: PATRON,
    status: 'ACTIVE_SUBSCRIBER',
    allergies: ['peanuts'],
    paidInvoiceCents: PATRON_INVOICE_CENTS,
  })
  // A household the concierge opened over the telephone: real, proved by nobody,
  // and owing us nothing yet. See {@link EstablishedProvenance} for why the
  // world has to contain one — it is the household for which
  // `isUnprovedPlaceholder` is the only thing standing between a sprayed code
  // and $50.00.
  await seedHousehold({ person: UNANSWERED, status: 'LEAD_QUALIFIED' })
  await seedBareUser(OVERSEER)

  signInAs(ATTACKER)

  const minted = await createReferralCode({
    rewardType: 'FIXED_CREDIT',
    // Stated, and discarded: below `ADMIN` the terms are the programme's
    // (MCV-030). The figure that reaches the row is `REWARD_CENTS`.
    rewardValueCents: 1_000_000,
    ownerId: ATTACKER.id,
    code: CODE,
    isActive: true,
  })

  signInAs(null)
  clearRateLimits()

  assert.equal(
    minted.ok,
    true,
    `the attacker could not mint a code: ${minted.ok ? '' : minted.error}`
  )

  const row = await prisma.referralCode.findUniqueOrThrow({
    where: { code: CODE },
    select: { id: true, rewardValueCents: true },
  })

  assert.equal(
    row.rewardValueCents,
    REWARD_CENTS,
    'the minted code should carry the programme figure, not the payload one'
  )

  return row.id
}

/** Run the real sweep as the concierge and report what it moved. */
async function sweep(): Promise<number> {
  signInAs(OVERSEER)

  const settled = await settleReferralRedemptions({ limit: 50 })

  signInAs(null)

  assert.equal(
    settled.ok,
    true,
    `the sweep failed: ${settled.ok ? '' : settled.error}`
  )

  return settled.ok ? settled.data.creditedCents : -1
}

function codeOf(result: ActionResult<unknown>): string {
  return result.ok ? 'ok' : result.code
}

// =============================================================================
// 3. The property the scenarios actually differ by
// =============================================================================

/**
 * What the database already holds for the address an enquiry carries.
 *
 * These are the two answers `isUnprovedPlaceholder` can give, named. The public
 * path may write `ClientProfile.claimedReferralCode` for an identity it
 * `created`, and for a `matched` one **only** while `User.unclaimedSince` is
 * still stamped — so from the guard's point of view there are exactly two kinds
 * of address in the world, and this is them.
 *
 * `'established'` is the finding-A victim: a row exists and no anonymous caller
 * may touch it. `'unknown'` is the genuine newcomer: no row exists, so the
 * enquiry opens one and everything it writes is its own.
 */
type Provenance = EstablishedProvenance | 'unknown'

/**
 * The two shapes an established household comes in, and why both are run.
 *
 * The guard does not distinguish them — `isUnprovedPlaceholder` asks one
 * question and both answer it the same way — but the *second* lock downstream
 * does, and that is exactly why the harness must. `settleAcceptedClaim` consults
 * `resolveRedemptionEligibility`, which refuses `ALREADY_A_CUSTOMER`: a
 * household that had paid us before the invitation was accepted cannot be
 * referred at all, whoever typed the code.
 *
 * So if this file only ever pointed the exploit at the paying patron, deleting
 * `isUnprovedPlaceholder` would still move no money — the existing-customer rule
 * would stop it — and every money assertion here would pass for a reason that
 * has nothing to do with the finding. Measured: it does. The claim assertions
 * catch that mutation, the money assertions do not.
 *
 * `'established-and-owed-nothing'` is the household for which the guard is the
 * **only** lock: the concierge opened it over the telephone, it is real, it has
 * proved nothing to nobody, and it has never paid us — so nothing downstream
 * objects, and the invoice it pays next is a qualifying one. That is where a
 * hijacked claim becomes $50.00, and running it is what makes the money column
 * of this transcript mean something.
 */
type EstablishedProvenance =
  'established-and-paying' | 'established-and-owed-nothing'

interface EnquiryTarget {
  readonly email: string
  readonly provenance: Provenance
  /** `null` exactly when {@link provenance} is `'unknown'`. */
  readonly userId: string | null
  /** `null` exactly when {@link provenance} is `'unknown'`. */
  readonly clientProfileId: string | null
}

/**
 * The household this staged world holds that is *established*: an account
 * exists, it is active, `unclaimedSince` is `NULL` — nobody's placeholder — it
 * is subscribing, and it has paid us.
 *
 * Found by those properties rather than by name, and that is the whole point of
 * the function. The previous version of this file said `PATRON.email` and the
 * contrasting scenario said `NEWCOMER_EMAIL`, so the difference between "the
 * attack" and "the feature" was a choice of string constant that the server
 * cannot see and no assertion checked. Here the scenario states the property it
 * needs and the database answers; if the seeded world ever stopped containing
 * exactly one such household — or if `PATRON` were seeded as a placeholder by
 * mistake — this throws rather than quietly testing something else.
 */
async function establishedTarget(
  provenance: EstablishedProvenance
): Promise<EnquiryTarget> {
  const rows = await prisma.user.findMany({
    where: {
      isActive: true,
      unclaimedSince: null,
      clientProfile: { is: {} },
      // The attacker also has a `ClientProfile` and has also never paid us, so
      // "owns the invitation" is what tells the two apart — a fact about a row
      // in `ReferralCode`, not about which constant the scenario reached for.
      referralCodesOwned: { none: {} },
      ...(provenance === 'established-and-paying'
        ? { invoices: { some: { status: 'PAID' } } }
        : { invoices: { none: { status: 'PAID' } } }),
    },
    orderBy: [{ id: 'asc' }],
    select: { id: true, email: true, clientProfile: { select: { id: true } } },
  })

  assert.equal(
    rows.length,
    1,
    `the staged world should hold exactly one ${provenance} household; it holds ${String(rows.length)}`
  )

  const row = rows[0]

  if (row === undefined || row.email === null || row.clientProfile === null) {
    throw new Error(
      'the established household has no address or no ClientProfile — the world is not staged'
    )
  }

  return {
    email: row.email,
    provenance,
    userId: row.id,
    clientProfileId: row.clientProfile.id,
  }
}

/**
 * An address no `User` holds.
 *
 * The literal is unavoidable — there is no way to name a row that does not
 * exist — but the *premise* is not taken on trust: the absence is read back out
 * of the database before the scenario is allowed to proceed. That is the half of
 * the contrast that can be checked, and it is checked.
 */
async function unknownTarget(email: string): Promise<EnquiryTarget> {
  const holders = await prisma.user.count({ where: { email } })

  assert.equal(
    holders,
    0,
    `${email} was meant to be held by nobody, and is held by ${String(holders)} account(s)`
  )

  return { email, provenance: 'unknown', userId: null, clientProfileId: null }
}

/**
 * What the world must look like after {@link runEnquiry}, given only the
 * provenance of the address the enquiry carried.
 *
 * Two rows, because the guard has two answers. Deriving the expectation from the
 * property rather than writing it out per scenario is what stops a scenario from
 * being able to assert "nothing happened" merely because its author believed
 * nothing should: an assertion here is a statement about `isUnprovedPlaceholder`
 * that both the attack scenarios and the feature scenario are measured against.
 */
interface Expectation {
  /** Does the anonymous enquiry leave a claim on the household's file? */
  readonly claimRecorded: boolean
  /** What the household's own press of *accept* comes back with. */
  readonly consent: 'accepted' | 'nothing-standing'
  /** `ReferralRedemption` rows against the minted code, afterwards. */
  readonly redemptions: number
  /** What the sweep moves once that household has paid a qualifying bill. */
  readonly creditedCents: number
}

function expectedFor(provenance: Provenance): Expectation {
  // Both established shapes collapse to one row here, and deliberately: the
  // guard asks one question of them. What differs is what would happen *if the
  // guard let them through*, which is why both are run and neither is assumed.
  return provenance === 'unknown'
    ? {
        claimRecorded: true,
        consent: 'accepted',
        redemptions: 1,
        creditedCents: REWARD_CENTS,
      }
    : {
        claimRecorded: false,
        consent: 'nothing-standing',
        redemptions: 0,
        creditedCents: 0,
      }
}

// =============================================================================
// 4. One sequence, run by every shipped-path scenario
// =============================================================================

/** Which `auth: 'PUBLIC'` door the enquiry goes through. */
type PublicDoor = 'consultation' | 'questionnaire'

/** The part of both receipts this harness reads. */
interface Receipt {
  readonly consultationInterviewId: string | null
}

/**
 * How a run names the address it is about to post.
 *
 * The established household is **found**, by the properties that make it one, so
 * there is nothing here to name. The unknown address has to be spelled out —
 * a row that does not exist cannot be queried for — and {@link unknownTarget}
 * proves the absence before the run proceeds. A discriminated union rather than
 * an optional field, so there is no way to ask for `'established'` and pass an
 * address anyway.
 */
type AddressSpec =
  | { readonly provenance: EstablishedProvenance }
  | { readonly provenance: 'unknown'; readonly email: string }

interface EnquiryRunOptions {
  readonly door: PublicDoor
  readonly address: AddressSpec
  /**
   * Is a session resolved **when the enquiry is posted**?
   *
   * `false` is the stranger of the finding. `true` is scenario 5's identified
   * caller — the household that holds the address, posting about itself, which
   * is the only signed-in caller this form could plausibly have. Derived from
   * the resolved target rather than named, for the same reason the target is:
   * "who is signed in" must be a fact about the world, not a constant.
   *
   * Whoever posts, the *acceptance* later in the sequence is always made by the
   * household that holds the address. There is no other session that could make
   * it.
   */
  readonly postedByTheHousehold: boolean
}

async function resolveTarget(spec: AddressSpec): Promise<EnquiryTarget> {
  return spec.provenance === 'unknown'
    ? unknownTarget(spec.email)
    : establishedTarget(spec.provenance)
}

/** Everything one full pass of the sequence left behind. */
interface EnquiryRun {
  readonly target: EnquiryTarget
  readonly door: PublicDoor
  readonly enquiryCode: string
  readonly receiptId: string | null
  readonly claim: ReferralClaimSnapshot | null
  readonly consentKind: string
  /**
   * The rows standing the instant the household finished pressing *accept*, and
   * before anybody has paid us. `PENDING` if there are any.
   */
  readonly redemptionsAtConsent: readonly RedemptionRow[]
  /** The same rows after the sweep has run over a qualifying invoice. */
  readonly redemptions: readonly RedemptionRow[]
  readonly creditedCents: number
  readonly attackerBalanceCents: number
  readonly householdUserId: string
  readonly accountBefore: AccountSnapshot | null
  /**
   * The account the instant the enquiry returned, before anybody has signed in
   * or accepted anything.
   *
   * This is the snapshot that has to be compared, and the reason is worth
   * stating: `settleAcceptedClaim` **consumes** the claim columns — it clears
   * them whether it settles, refuses or expires the claim — so by the end of the
   * sequence a hijacked file looks exactly like an untouched one. Comparing only
   * the end state would restore the round-four blindness by a different route.
   */
  readonly accountAtClaim: AccountSnapshot | null
  readonly accountAfter: AccountSnapshot
  readonly consultations: number
  /** The concierge's timeline for that household. @see interactionSubjectsOf */
  readonly timeline: readonly string[]
}

async function postEnquiry(
  door: PublicDoor,
  email: string
): Promise<ActionResult<Receipt>> {
  return door === 'consultation'
    ? requestConsultation(consultationPayload({ email, referralCode: CODE }))
    : submitProspectIntake(prospectPayload({ email, referralCode: CODE }))
}

/**
 * Post the enquiry, prove the mailbox, accept, pay, sweep — in that order, every
 * time, whoever the address belongs to.
 *
 * Every step is unconditional. That is the correction to MCV-054 finding 2(i):
 * the previous scenarios 2 and 3 stopped after the post, and stopping after the
 * post cannot distinguish "the claim was refused" from "the claim was recorded
 * and has not been settled yet", because the shipped path never settles at
 * enquiry time for anybody. The step that turns a claim into money is the
 * household's own acceptance, so a scenario that never accepts is measuring
 * nothing about the money — and a scenario whose contrast accepts and whose
 * subject does not is not a contrast at all.
 *
 * Running it against the victim is not a fiction, either. It is exactly the
 * MCV-052 story: the victim gets on with their life — clicks a magic link,
 * looks at whatever the application offers them, presses the button, pays their
 * next bill — and the question is whether any of that pays a stranger. Here it
 * is asked rather than assumed.
 */
async function runEnquiry(options: EnquiryRunOptions): Promise<EnquiryRun> {
  const { door, address, postedByTheHousehold } = options

  const codeId = await stage()

  // Resolved from the freshly staged world, so the property each scenario says
  // it needs is re-read out of PostgreSQL on every pass rather than carried in
  // from a constant.
  const staged = await resolveTarget(address)

  const accountBefore =
    staged.userId === null ? null : await accountSnapshot(staged.userId)

  const poster: HarnessUser | null = postedByTheHousehold
    ? await provedSessionFor(staged.email)
    : null

  clearRateLimits()

  signInAs(poster)
  const posted = await postEnquiry(door, staged.email)
  signInAs(null)
  clearRateLimits()

  // The address now has a household behind it in both cases: matched for
  // `established`, opened by the enquiry for `unknown`.
  const householdUserId = await userIdForEmail(staged.email)
  const householdProfileId = await profileIdForEmail(staged.email)

  if (householdUserId === null || householdProfileId === null) {
    throw new Error(`no household stands behind ${staged.email} after the post`)
  }

  const claim = await referralClaimOf(householdProfileId)
  const accountAtClaim = await accountSnapshot(householdUserId)

  // The household clicks the magic link in its own inbox — `events.signIn` calls
  // exactly `markMailboxProved` — and then answers whatever it is shown. Since
  // MCV-052 those are two acts, and only the second one can move money.
  const session = await provedSessionFor(staged.email)

  signInAs(session)
  clearRateLimits()
  const consented = await acceptReferralClaim({ code: CODE })
  signInAs(null)
  clearRateLimits()

  const redemptionsAtConsent = await redemptionsForCode(codeId)

  // ...and then pays us, over the floor. For the established household this is
  // their next subscription bill; for the newcomer it is their first.
  await prisma.invoice.create({
    data: {
      userId: householdUserId,
      amountDueCents: NEXT_INVOICE_CENTS,
      amountPaidCents: NEXT_INVOICE_CENTS,
      amountRemainingCents: 0,
      subtotalCents: NEXT_INVOICE_CENTS,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: new Date(),
      paidAt: new Date(),
    },
    select: { id: true },
  })

  const creditedCents = await sweep()

  return {
    target: staged,
    door,
    enquiryCode: codeOf(posted),
    receiptId: posted.ok ? posted.data.consultationInterviewId : null,
    claim,
    consentKind: consented.ok ? consented.data.kind : consented.code,
    redemptionsAtConsent,
    redemptions: await redemptionsForCode(codeId),
    creditedCents,
    attackerBalanceCents: await balanceCentsOf(ATTACKER.id),
    householdUserId,
    accountBefore,
    accountAtClaim,
    accountAfter: await accountSnapshot(householdUserId),
    consultations: await consultationCountOf(householdProfileId),
    timeline: await interactionSubjectsOf(householdProfileId),
  }
}

/**
 * The assertions every shipped-path scenario makes, against the expectation its
 * own provenance implies.
 *
 * Note what is *not* parameterised: there is no "expected" flag a scenario can
 * set. A scenario chooses a door, a poster and an address; the address's
 * provenance is read out of the database; the expectation follows from that.
 */
function assertRun(run: EnquiryRun): void {
  const expected = expectedFor(run.target.provenance)
  const where = `${run.door}, ${run.target.provenance} address`

  check(
    `the enquiry is accepted (${where}) — the form is not an oracle`,
    () => {
      assert.equal(run.enquiryCode, 'ok')
    }
  )

  check(
    expected.claimRecorded
      ? 'the code IS recorded on the household’s file as attribution'
      : 'NO claim is stamped on the household’s file — the two columns the attack writes',
    () => {
      assert.equal(
        run.claim?.code ?? null,
        expected.claimRecorded ? CODE : null
      )
    }
  )

  check(
    expected.consent === 'accepted'
      ? 'the household is offered the invitation and accepts it'
      : 'the household is offered nothing to accept',
    () => {
      assert.equal(run.consentKind, expected.consent)
    }
  )

  check(
    expected.redemptions === 0
      ? 'no ReferralRedemption exists against the code, at consent'
      : 'exactly one PENDING ReferralRedemption was written, by the household’s own consent',
    () => {
      assert.equal(run.redemptionsAtConsent.length, expected.redemptions)

      if (expected.redemptions > 0) {
        assert.equal(run.redemptionsAtConsent[0]?.status, 'PENDING')
        assert.equal(
          run.redemptionsAtConsent[0]?.referredUserId,
          run.householdUserId
        )
      }
    }
  )

  check('the sweep neither invents a redemption nor loses one', () => {
    assert.equal(run.redemptions.length, run.redemptionsAtConsent.length)
  })

  check(
    `the sweep moves ${money(expected.creditedCents)} after that household pays ${money(NEXT_INVOICE_CENTS)}`,
    () => {
      assert.equal(run.creditedCents, expected.creditedCents)
      assert.equal(run.attackerBalanceCents, expected.creditedCents)
    }
  )

  check('the concierge still gets the enquiry to telephone about', () => {
    assert.equal(run.consultations, 1)
  })
}

/**
 * The additional promise made only about an address somebody else already held:
 * the enquiry moved **nothing** on it.
 *
 * Since MCV-054 the snapshot on both sides of this includes
 * `claimedReferralCode`, `claimedReferralCodeAt` and `unclaimedSince`. Without
 * them this assertion passed while a stranger's code stood on the file, which is
 * how the round-four artefact came to print a green transcript over a live
 * exploit.
 */
function assertAccountUntouched(run: EnquiryRun): void {
  check('not one column of the established household’s account moved', () => {
    assert.notEqual(
      run.accountBefore,
      null,
      'there was no account to compare — this is not the established case'
    )
    // At claim time first, and that ordering is the whole assertion: the
    // settlement consumes the claim columns on every branch it takes, so an end-
    // state comparison would be satisfied by a file that had been hijacked and
    // then tidied up.
    assert.deepEqual(run.accountAtClaim, run.accountBefore)
    assert.deepEqual(run.accountAfter, run.accountBefore)
  })
}

// =============================================================================
// 5. Scenario 0 — calibrating the instrument
// =============================================================================

/**
 * Before anything is measured, prove the instrument is not blind.
 *
 * This scenario asserts nothing about the application. It writes the two
 * attribution columns directly, behind every action's back, and insists that
 * {@link accountSnapshot} and `referralClaimOf` both *see* the write — that
 * `assert.deepEqual(after, before)` would have failed.
 *
 * It exists because for three rounds it would have failed. `accountSnapshot`'s
 * select omitted `claimedReferralCode` and `claimedReferralCodeAt`, so scenario
 * 2's "not one column of the patron's account moved" was a true statement about
 * five columns and silent about the only two the attack writes. Every other
 * check in this file is a claim about the server; this one is a claim about the
 * checks, and it is the cheapest possible defence against the whole file going
 * quietly green over a live exploit again.
 *
 * A narrowed select, a renamed column, a snapshot that stopped joining
 * `ClientProfile` — each fails here, loudly, in the first section of the
 * transcript, rather than being absorbed as a pass somewhere below.
 */
async function scenarioCalibration(): Promise<void> {
  section('0. calibration — the snapshot can see the columns under attack')

  await stage()

  const victim = await establishedTarget('established-and-paying')

  if (victim.userId === null || victim.clientProfileId === null) {
    throw new Error('the established household has no account')
  }

  const before = await accountSnapshot(victim.userId)
  const claimBefore = await referralClaimOf(victim.clientProfileId)

  const stampedAt = new Date('2026-03-01T09:30:00.000Z')

  // Deliberately raw. The point is to move the columns without going through
  // anything that could also be broken, so that a failure below is unambiguously
  // the reader's fault and not the writer's.
  await prisma.clientProfile.update({
    where: { id: victim.clientProfileId },
    data: { claimedReferralCode: CODE, claimedReferralCodeAt: stampedAt },
    select: { id: true },
  })

  const after = await accountSnapshot(victim.userId)
  const claimAfter = await referralClaimOf(victim.clientProfileId)

  check('the account snapshot starts with no attribution on it', () => {
    assert.equal(before.claimedReferralCode, null)
    assert.equal(before.claimedReferralCodeAt, null)
    assert.equal(claimBefore, null)
  })

  check('accountSnapshot reports a claim written behind its back', () => {
    assert.equal(after.claimedReferralCode, CODE)
    assert.deepEqual(after.claimedReferralCodeAt, stampedAt)
  })

  check(
    'so “not one column moved” is a statement about those columns too',
    () => {
      assert.notDeepEqual(after, before)
    }
  )

  check('and referralClaimOf agrees with the snapshot', () => {
    assert.equal(claimAfter?.code, CODE)
    assert.deepEqual(claimAfter?.claimedAt, stampedAt)
  })

  note('every assertion below is only worth what this section is worth.')
}

// =============================================================================
// 6. Scenario 1 — the exploit, against the pre-fix source
// =============================================================================

interface ExploitOutcome {
  readonly redeemedFor: readonly string[]
  readonly victimUserId: string
  /**
   * What `ClientProfile.claimedReferralCode` says on the victim's file
   * afterwards, rendered for the report.
   *
   * The pre-fix source is `n/a` rather than `no` and the distinction matters:
   * that source predates the column entirely and staked the `ReferralRedemption`
   * itself, so "no claim" would read as a protection it never had. What the two
   * columns of the table share is the *outcome* rows below.
   */
  readonly claimOnFile: string
  readonly attackerBalanceCents: number
  readonly creditedCents: number
}

async function scenarioLegacy(): Promise<ExploitOutcome> {
  section('1. the exploit against the pre-fix source — $50.00 to a stranger')

  const codeId = await stage()
  const victim = await establishedTarget('established-and-paying')

  if (victim.userId === null || victim.clientProfileId === null) {
    throw new Error('the established household has no account')
  }

  // No session. No password. No mailbox. One HTTP request.
  await legacyRequestConsultation({
    sessionUserId: null,
    fullName: 'M. Quist',
    email: victim.email,
    preferredContactMethod: 'EMAIL',
    source: 'REFERRAL',
    referralCode: CODE,
  })

  const attached = await redemptionsForCode(codeId)

  check('a PENDING redemption is written naming the patron', () => {
    assert.equal(attached.length, 1)
    assert.equal(attached[0]?.referredUserId, victim.userId)
    assert.equal(attached[0]?.status, 'PENDING')
  })

  // MCV-051. The patron's historical invoice — `PATRON_INVOICE_CENTS`, well
  // over the floor, paid long before this hijack — no longer qualifies
  // anything, because `findQualifyingInvoice` will not look at an invoice paid
  // before the redemption's own `qualifyingFromAt`. Asserted before the payout
  // rather than instead of it: this is the second lock, and finding A is about
  // the row rather than the money.
  const staleSweepCents = await sweep()
  const balanceOnStaleRevenue = await balanceCentsOf(ATTACKER.id)

  check('the household’s existing revenue does not pay the attacker', () => {
    assert.equal(staleSweepCents, 0)
    assert.equal(balanceOnStaleRevenue, 0)
  })

  // The patron does the one thing a subscriber does: they pay their next bill.
  await prisma.invoice.create({
    data: {
      userId: victim.userId,
      amountDueCents: NEXT_INVOICE_CENTS,
      amountPaidCents: NEXT_INVOICE_CENTS,
      amountRemainingCents: 0,
      subtotalCents: NEXT_INVOICE_CENTS,
      currency: 'CAD',
      status: 'PAID',
      issuedAt: new Date(),
      paidAt: new Date(),
    },
    select: { id: true },
  })

  const creditedCents = await sweep()
  const attackerBalanceCents = await balanceCentsOf(ATTACKER.id)

  check('the sweep qualifies it on the patron’s next invoice', () => {
    assert.equal(creditedCents, REWARD_CENTS)
  })

  check('the attacker’s reward balance is credited', () => {
    assert.equal(attackerBalanceCents, REWARD_CENTS)
  })

  const entries = await prisma.rewardLedgerEntry.findMany({
    where: { userId: ATTACKER.id },
    select: { reason: true, direction: true, amountCents: true },
  })

  check(
    'the ledger entry is indistinguishable from one that was earned',
    () => {
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.reason, 'REFERRAL_REWARD')
      assert.equal(entries[0]?.direction, 'CREDIT')
      assert.equal(entries[0]?.amountCents, REWARD_CENTS)
    }
  )

  note(
    `outcome: ${money(attackerBalanceCents)} credited to an unauthenticated caller`
  )
  note(
    'the patron never saw a form, never clicked a link, and had already paid.'
  )

  return {
    redeemedFor: attached.map((row) => row.referredUserId),
    victimUserId: victim.userId,
    claimOnFile: 'n/a (predates the column)',
    attackerBalanceCents,
    creditedCents,
  }
}

// =============================================================================
// 7. Scenarios 2 and 3 — the exploit against the shipped actions
// =============================================================================

async function scenarioFixedConsultation(): Promise<ExploitOutcome> {
  section('2. the same exploit against the shipped requestConsultation')

  const run = await runEnquiry({
    door: 'consultation',
    address: { provenance: 'established-and-paying' },
    postedByTheHousehold: false,
  })

  assertRun(run)
  assertAccountUntouched(run)

  check('the receipt withholds every row identifier', () => {
    assert.equal(run.receiptId, null)
  })

  note(
    `outcome: ${money(run.attackerBalanceCents)} credited, ${String(run.redemptions.length)} redemptions written,`
  )
  note(
    `claim on the victim’s file: ${run.claim === null ? 'none' : run.claim.code}. The victim proved their`
  )
  note('mailbox, pressed accept, and paid us — and none of it paid a stranger.')

  return {
    redeemedFor: run.redemptions.map((row) => row.referredUserId),
    victimUserId: run.householdUserId,
    claimOnFile: run.claim === null ? 'none' : run.claim.code,
    attackerBalanceCents: run.attackerBalanceCents,
    creditedCents: run.creditedCents,
  }
}

async function scenarioFixedProspectIntake(): Promise<void> {
  section('3. the same exploit against the shipped submitProspectIntake')

  const run = await runEnquiry({
    door: 'questionnaire',
    address: { provenance: 'established-and-paying' },
    postedByTheHousehold: false,
  })

  assertRun(run)
  assertAccountUntouched(run)

  check('the withheld branch is what closed this door, and it ran', () => {
    assert.equal(run.timeline.length, 1)
    assert.match(run.timeline[0] ?? '', /household we already hold/i)
  })

  note('the only difference from scenario 2 is which shipped action ran — but')
  note('the lock that answers is a different one. See the docblock: this door')
  note('returns before it reads the referral code at all.')
}

// =============================================================================
// 8. Scenario 4 — the fix must refuse nothing legitimate
// =============================================================================

/** An address the seeded world does not contain. Asserted, not assumed. */
const NEWCOMER_EMAIL = 'iris.calloway@example.org'

/**
 * A genuine invitation, accepted by a genuine newcomer.
 *
 * A fix that closed finding A by never attaching a referral at all would pass
 * scenarios 2 and 3 and would have quietly removed the feature. So this asks
 * for the opposite result and insists on it — through the **same sequence**,
 * with the same steps in the same order, so that "the opposite result" is a
 * property of the world and not of which function the author happened to write.
 *
 * It also does the transcription check the legacy fixture's docblock promises:
 * the same enquiry is put through the pre-fix path, and the row it writes at
 * claim time is compared with the row the shipped path writes at acceptance.
 * If the legacy path ever stops staking one, the "before" column of scenario 1
 * has stopped describing the defect.
 */
async function scenarioNoFalseRefusal(): Promise<void> {
  section('4. an unknown address — the programme still works')

  const run = await runEnquiry({
    door: 'consultation',
    address: { provenance: 'unknown', email: NEWCOMER_EMAIL },
    postedByTheHousehold: false,
  })

  assertRun(run)

  check(
    'the enquiry opened the household itself — there was none before',
    () => {
      assert.equal(run.accountBefore, null)
      assert.equal(run.accountAfter.email, NEWCOMER_EMAIL)
    }
  )

  check('the claim stood on their file until they answered it', () => {
    assert.equal(run.accountAtClaim?.claimedReferralCode, CODE)
    assert.notEqual(run.accountAtClaim?.claimedReferralCodeAt, null)
  })

  check(
    'and the settlement consumed it rather than leaving it standing',
    () => {
      assert.equal(run.accountAfter.claimedReferralCode, null)
      assert.equal(run.accountAfter.claimedReferralCodeAt, null)
    }
  )

  // --- the transcription check -------------------------------------------
  const legacyCodeId = await stage()

  await legacyRequestConsultation({
    sessionUserId: null,
    fullName: 'M. Quist',
    email: NEWCOMER_EMAIL,
    preferredContactMethod: 'EMAIL',
    source: 'REFERRAL',
    referralCode: CODE,
  })

  const legacy = await redemptionsForCode(legacyCodeId)
  const legacyUserId = await userIdForEmail(NEWCOMER_EMAIL)

  check(
    'the pre-fix transcription still stakes the row at claim time, unprompted',
    () => {
      assert.equal(legacy.length, run.redemptionsAtConsent.length)
      assert.equal(legacy[0]?.status, run.redemptionsAtConsent[0]?.status)
      assert.equal(
        legacy[0]?.rewardCents,
        run.redemptionsAtConsent[0]?.rewardCents
      )
      assert.equal(legacy[0]?.referredUserId, legacyUserId)
    }
  )

  note(
    'the same row, from one anonymous request and with no mailbox proved — so'
  )
  note(
    'scenario 1 is measuring the defect, not a fixture that has drifted away from it.'
  )
}

// =============================================================================
// 9. Scenario 5 — a signed-in caller
// =============================================================================

/**
 * A signed-in caller quoting a code on the public form is refused too, and is
 * meant to be.
 *
 * Their identity is `matched` — a session proves they own the account, not that
 * it is new — and the audited way for an account that already exists to accept
 * an invitation is `redeemReferralCode`, which applies the expiry message, the
 * owner-identity check, `sharesEmailIdentity`, and the one-live-redemption rule.
 *
 * This is scenario 2 with exactly one server-side property changed: a session is
 * resolved when the enquiry is posted. Everything downstream — the mailbox
 * proof, the acceptance, the invoice, the sweep — is byte-for-byte the same
 * sequence, so the transcript's two rows can be read against each other.
 */
async function scenarioSignedInCaller(): Promise<void> {
  section('5. a signed-in caller quoting a code on the public form')

  const run = await runEnquiry({
    door: 'consultation',
    address: { provenance: 'established-and-paying' },
    postedByTheHousehold: true,
  })

  assertRun(run)
  assertAccountUntouched(run)

  check('the identified caller does get their row identifiers back', () => {
    assert.notEqual(run.receiptId, null)
  })

  note('the audited door — redeemReferralCode — is the one that stays open.')
}

// =============================================================================
// 10. Scenario 6 — the household for which this guard is the only lock
// =============================================================================

/**
 * The same exploit, against a household that has never paid us.
 *
 * Scenarios 2, 3 and 5 point it at the paying patron because that is the
 * household the finding was written about. But the patron is protected twice
 * over: even with `isUnprovedPlaceholder` deleted, `resolveRedemptionEligibility`
 * refuses `ALREADY_A_CUSTOMER` and the sweep moves nothing. Their money
 * assertions are therefore true for a reason that is not this guard, and a
 * harness that stopped there would be reporting the strength of a different
 * lock.
 *
 * This household — real, `LEAD_QUALIFIED`, opened by the concierge over the
 * telephone, owing us nothing — trips no other rule. Nobody has proved its
 * mailbox, so `unclaimedSince` is `NULL` and it is not a placeholder; it has
 * paid nothing, so it is not already a customer; its address shares nothing with
 * the attacker's, so the household heuristic is silent. The only thing between a
 * stranger's sprayed code and a `PENDING` redemption on its file is the guard.
 *
 * Measured, with the guard deleted: the claim is stamped, the household is shown
 * an invitation it never asked for, its acceptance is admitted, its first
 * invoice qualifies it, and the sweep pays the stranger {@link REWARD_CENTS}.
 * That is the assertion this scenario exists to make, and it is the one the
 * money column of the report is standing on.
 */
async function scenarioOnlyLock(): Promise<void> {
  section('6. the same exploit against a household that has never paid us')

  const run = await runEnquiry({
    door: 'consultation',
    address: { provenance: 'established-and-owed-nothing' },
    postedByTheHousehold: false,
  })

  assertRun(run)
  assertAccountUntouched(run)

  const paidInvoices = await prisma.invoice.count({
    where: { userId: run.householdUserId, status: 'PAID' },
  })

  check('the household really was one no other rule would have saved', () => {
    // Not a placeholder — so `isUnprovedPlaceholder` is the rule that refused
    // the write, rather than the rule being moot.
    assert.equal(run.accountAtClaim?.unclaimedSince, null)
    // Exactly one `PAID` invoice, and the sequence created it *after* the
    // acceptance — so this household had paid us nothing at the moment the
    // invitation would have been accepted, and `ALREADY_A_CUSTOMER` was not what
    // stopped the money either.
    assert.equal(paidInvoices, 1)
  })

  note('delete isUnprovedPlaceholder and this scenario pays $50.00. That is')
  note('what the guard is for, and nothing else in the stack repeats it.')
}

// =============================================================================
// 11. The report
// =============================================================================

function printReport(before: ExploitOutcome, after: ExploitOutcome): void {
  printTable(
    'An unauthenticated stranger posts a paying household’s address with their own code',
    [
      ['', 'pre-fix', 'shipped'],
      ['claim stamped on their file', before.claimOnFile, after.claimOnFile],
      [
        'redemptions written',
        String(before.redeemedFor.length),
        String(after.redeemedFor.length),
      ],
      [
        'named as referee',
        before.redeemedFor.includes(before.victimUserId) ? 'the patron' : '—',
        after.redeemedFor.includes(after.victimUserId) ? 'the patron' : '—',
      ],
      [
        'credited by the sweep',
        money(before.creditedCents),
        money(after.creditedCents),
      ],
      [
        'attacker’s balance',
        money(before.attackerBalanceCents),
        money(after.attackerBalanceCents),
      ],
    ],
    '  Both columns are the same database, the same seeded rows, the same\n' +
      '  settlement sweep and the same minted code — and in the shipped column\n' +
      '  the victim went on to prove their mailbox, press accept and pay their\n' +
      '  next bill. The only difference is whether the code that resolved the\n' +
      '  identity reported where it came from.'
  )
}

// =============================================================================
// 12. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log(
    'MCV-040 finding A — a referral may not name a household you merely guessed'
  )
  console.log(`database: ${name}`)

  await scenarioCalibration()

  const before = await scenarioLegacy()
  const after = await scenarioFixedConsultation()

  await scenarioFixedProspectIntake()
  await scenarioNoFalseRefusal()
  await scenarioSignedInCaller()
  await scenarioOnlyLock()

  printReport(before, after)

  console.log(`\nPASS — ${String(checkCount())} assertions, 0 failures.`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void disconnect()
  })
