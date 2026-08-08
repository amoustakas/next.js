// mannachef/apps/web/scripts/fixtures/intake-harness.ts

/**
 * The plumbing the three MCV-040 regressions share.
 *
 * `verify-intake-referral-hijack.ts`, `verify-intake-referral-cap.ts` and
 * `verify-intake-allergen-write.ts` are three separate claims about the
 * anonymous intake path, and each is legible on its own. What they have in
 * common is entirely mechanical — a disposable database, a cast, a reporting
 * format — so it lives here rather than three times over.
 *
 * ## Why a real PostgreSQL, and not `fake-db.ts`
 *
 * `verify-referral-privilege.ts` runs against an in-memory fake because the
 * question it asks is answered by the application: does this action write the
 * number the payload asked for? Two of the three questions here are not like
 * that.
 *
 *  - Finding B is a claim about a **compare-and-swap under concurrency**. A
 *    fake's `updateMany` is whatever its author believed `UPDATE … WHERE
 *    redemption_count = $1` does, and asserting that back at itself would prove
 *    nothing about the cap.
 *  - Finding D is a claim about `ClientIntakeForm.allergies`, an `upsert`, a
 *    unique constraint on `clientProfileId`, and four tables joined by
 *    cascading foreign keys. The fake models five tables, none of them these.
 *
 * Finding A could be shown against a fake, but it shares its cast and its
 * settlement sweep with finding B, and one database for the three is simpler
 * than two mechanisms.
 *
 * ## What is substituted, and what is not
 *
 * `scripts/intake-resolver.mjs` substitutes exactly four specifiers: the
 * session, and the three request-scoped Next.js modules `guards.ts` imports at
 * module scope. **`@/server/db` is not among them** — unlike the MCV-031
 * harness there is nothing to instrument, so the actions get the ordinary
 * `PrismaClient` by the ordinary import. The actions, the `withAction` wrapper,
 * the zod schemas, the guards, the rate limiter and the SQL are all real, and
 * nothing under `src/` knows this file exists.
 */

import type {
  requestConsultation,
  submitProspectIntake,
} from '@/server/actions/intake'
import { prisma } from '@/server/db'
import { markMailboxProved } from '@/server/referral-claim'

import { clearRateLimits } from './database'
import { signInAs, type HarnessUser } from './harness-state'

// =============================================================================
// 1. Reporting, and the shared database rules
//
// Both moved out for MCV-041, which needed the same functions and would
// otherwise have carried a second copy of them. Re-exported rather than
// re-imported at each call site so the three MCV-040 harnesses below import
// exactly the names they always did.
// =============================================================================

export { check, checkCount, money, note, printTable, section } from './report'

export { assertDisposableDatabase, clearRateLimits } from './database'

// =============================================================================
// 2. The database
// =============================================================================

/**
 * Empty every table these harnesses write to.
 *
 * `User` cascades to `ClientProfile`, and `ClientProfile` cascades on to the
 * intake form, the onboarding flow, the consultations and the interaction log;
 * `User` also cascades to the invoices, the referral codes it owns, the
 * redemptions it received, its reward balance and its ledger entries. So one
 * delete would do — but `ReferralProgram` is a singleton nothing cascades from,
 * and `Tag` is referenced by the intake join rather than owned by it, so those
 * two are cleared explicitly.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.user.deleteMany({})
  await prisma.referralProgram.deleteMany({})
  await prisma.tag.deleteMany({})

  clearRateLimits()
  signInAs(null)
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}

// =============================================================================
// 3. The cast
// =============================================================================

/**
 * Ids are literal cuids because several of them travel through `cuidSchema`
 * before an action body is reached; a readable placeholder would be rejected by
 * validation and the scenario would prove nothing.
 */
export const ATTACKER: HarnessUser = {
  id: 'cuserattacker00000000001',
  name: 'Mallory Quist',
  email: 'mallory.quist@example.net',
  image: null,
  role: 'CLIENT',
  isActive: true,
  timeZone: 'America/Toronto',
  locale: 'en-CA',
  clientProfileId: 'cclientattacker000000001',
  staffProfileId: null,
}

/** A real, paying household. The victim of finding A. */
export const PATRON: HarnessUser = {
  ...ATTACKER,
  id: 'cuserpatron0000000000002',
  name: 'Eleanor Whitcombe',
  email: 'eleanor.whitcombe@example.com',
  clientProfileId: 'cclientpatron00000000002',
}

/**
 * A household the concierge opened over the telephone. The victim of finding D:
 * real, `LEAD_QUALIFIED`, and with no questionnaire returned yet.
 */
export const UNANSWERED: HarnessUser = {
  ...ATTACKER,
  id: 'cuserunanswered000000003',
  name: 'Rupert Ashgrove',
  email: 'rupert.ashgrove@example.com',
  clientProfileId: 'cclientunanswered0000003',
}

/** A household that has already returned its questionnaire, allergies and all. */
export const ANSWERED: HarnessUser = {
  ...ATTACKER,
  id: 'cuseranswered00000000004',
  name: 'Beatrice Fenn',
  email: 'beatrice.fenn@example.com',
  clientProfileId: 'cclientanswered000000004',
}

/** Runs the settlement sweep. `settleReferralRedemptions` is `auth: 'ADMIN'`. */
export const OVERSEER: HarnessUser = {
  ...ATTACKER,
  id: 'cuseroverseer00000000005',
  name: 'The Concierge',
  email: 'concierge@mannachef.test',
  role: 'ADMIN',
  clientProfileId: null,
}

// =============================================================================
// 4. Seeding
// =============================================================================

/** How a seeded household sits in the pipeline. */
export interface SeedHousehold {
  readonly person: HarnessUser
  readonly status:
    'PROSPECT' | 'LEAD_QUALIFIED' | 'ACTIVE_SUBSCRIBER' | 'PAUSED' | 'CHURNED'
  /** Omit for a household that has never returned its questionnaire. */
  readonly allergies?: readonly string[] | undefined
  /** Cents of a `PAID` invoice, stamped `paidAt`. Omit for a household that owes us nothing. */
  readonly paidInvoiceCents?: number | undefined
}

/**
 * Insert one household: the `User`, its `ClientProfile`, and optionally the
 * questionnaire and the paid invoice that make it a real customer.
 *
 * Written with the raw client on purpose. This is the *world the actions find*,
 * not a thing under test, and building it through the actions would make each
 * scenario's premise depend on several other actions being correct.
 */
export async function seedHousehold(seed: SeedHousehold): Promise<void> {
  const { person } = seed

  await prisma.user.create({
    data: {
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role,
      isActive: person.isActive,
      timeZone: person.timeZone,
      locale: person.locale,
      ...(person.clientProfileId === null
        ? {}
        : {
            clientProfile: {
              create: {
                id: person.clientProfileId,
                displayName: person.name,
                preferredName: person.name,
                status: seed.status,
                source: 'DIRECT',
                phone: '+14165550188',
                preferredContactMethod: 'EMAIL',
              },
            },
          }),
    },
    select: { id: true },
  })

  if (seed.allergies !== undefined && person.clientProfileId !== null) {
    await prisma.clientIntakeForm.create({
      data: {
        clientProfileId: person.clientProfileId,
        householdSize: 2,
        adults: 2,
        children: 0,
        allergies: [...seed.allergies],
        dislikes: [],
        cuisinePreferences: ['Provençal'],
        kitchenEquipment: [],
        favouriteDishes: [],
        hasPets: false,
        deliveryFrequency: 'WEEKLY',
        currency: 'CAD',
        preferredContactMethod: 'EMAIL',
        preferredCookDays: ['tuesday'],
        submittedAt: new Date('2026-01-04T12:00:00.000Z'),
      },
      select: { id: true },
    })
  }

  if (seed.paidInvoiceCents !== undefined) {
    await prisma.invoice.create({
      data: {
        userId: person.id,
        amountDueCents: seed.paidInvoiceCents,
        amountPaidCents: seed.paidInvoiceCents,
        amountRemainingCents: 0,
        subtotalCents: seed.paidInvoiceCents,
        currency: 'CAD',
        status: 'PAID',
        issuedAt: new Date('2026-02-01T12:00:00.000Z'),
        paidAt: new Date('2026-02-03T12:00:00.000Z'),
      },
      select: { id: true },
    })
  }
}

/** Insert a plain `User` with no `ClientProfile` — the settlement sweep's operator. */
export async function seedBareUser(person: HarnessUser): Promise<void> {
  await prisma.user.create({
    data: {
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role,
      isActive: person.isActive,
      timeZone: person.timeZone,
      locale: person.locale,
    },
    select: { id: true },
  })
}

/** The terms a `CLIENT`-minted code carries. @see `@/server/referral-program` */
export interface SeedProgram {
  readonly rewardValueCents: number
  readonly minimumQualifyingInvoiceCents: number
  readonly defaultMaxRedemptions: number | null
}

export async function seedProgram(seed: SeedProgram): Promise<void> {
  await prisma.referralProgram.create({
    data: {
      key: 'default',
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: seed.rewardValueCents,
      rewardValuePercent: null,
      currency: 'CAD',
      refereeRewardCents: null,
      defaultMaxRedemptions: seed.defaultMaxRedemptions,
      defaultExpiryDays: null,
      minimumQualifyingInvoiceCents: seed.minimumQualifyingInvoiceCents,
      isActive: true,
    },
    select: { id: true },
  })
}

/**
 * The session a household holds once it has clicked the magic link in its own
 * inbox, whoever it is.
 *
 * `markMailboxProved` is what `authConfig.events.signIn` calls; the
 * `HarnessUser` is what the `auth: 'SESSION'` actions read through the stubbed
 * `getSessionUser`. Both are needed, because since MCV-052 proving the mailbox
 * and accepting an invitation are two separate acts by the same person.
 *
 * Deliberately indifferent to *which* household this is. A harness scenario
 * that wanted to sign in "the victim" and one that wanted to sign in "the
 * genuine newcomer" would otherwise reach for two different helpers, and the
 * difference between the two scenarios would live in the harness's vocabulary
 * rather than in the database. It is the row this reads back — placeholder or
 * not, the very thing `isUnprovedPlaceholder` asks about — that differs.
 */
export async function provedSessionFor(email: string): Promise<HarnessUser> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      clientProfile: { select: { id: true } },
    },
  })

  await markMailboxProved(row.id)

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: null,
    role: row.role,
    isActive: true,
    timeZone: 'America/Toronto',
    locale: 'en-CA',
    clientProfileId: row.clientProfile?.id ?? null,
    staffProfileId: null,
  }
}

// =============================================================================
// 5. Reading the world back
// =============================================================================

/** One redemption, flattened for an assertion. */
export interface RedemptionRow {
  readonly referredUserId: string
  readonly status: string
  readonly rewardCents: number | null
}

export async function redemptionsForCode(
  referralCodeId: string
): Promise<readonly RedemptionRow[]> {
  const rows = await prisma.referralRedemption.findMany({
    where: { referralCodeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { referredUserId: true, status: true, rewardCents: true },
  })

  return rows
}

export async function redemptionCountOf(
  referralCodeId: string
): Promise<number> {
  const row = await prisma.referralCode.findUnique({
    where: { id: referralCodeId },
    select: { redemptionCount: true },
  })

  return row?.redemptionCount ?? -1
}

/** Whole cents on a user's `RewardBalance`. `0` when they have never had one. */
export async function balanceCentsOf(userId: string): Promise<number> {
  const row = await prisma.rewardBalance.findUnique({
    where: { userId },
    select: { balanceCents: true },
  })

  return row?.balanceCents ?? 0
}

/** The questionnaire on file for a household, or `null` when there is none. */
export interface IntakeSnapshot {
  readonly allergies: readonly string[]
  readonly dislikes: readonly string[]
  readonly householdSize: number
  readonly submittedAt: Date | null
  readonly notes: string | null
}

export async function intakeSnapshot(
  clientProfileId: string
): Promise<IntakeSnapshot | null> {
  const row = await prisma.clientIntakeForm.findUnique({
    where: { clientProfileId },
    select: {
      allergies: true,
      dislikes: true,
      householdSize: true,
      submittedAt: true,
      notes: true,
    },
  })

  return row
}

/**
 * The columns a public form must never move on an account it did not open.
 *
 * ## Why the attribution columns are in here
 *
 * They were not, for three rounds, and that omission is MCV-054 finding 2. The
 * anonymous intake path writes exactly **one** thing to a household it merely
 * matched: `ClientProfile.claimedReferralCode` and its timestamp. Those were the
 * two columns this select did not ask for, so an assertion phrased "not one
 * column of the household's account moved" was true of every column except the
 * two the attack moves — and deleting the guard in `attachReferralClaim` left
 * `verify-intake-referral-hijack.ts` printing a pass with a stranger's code
 * standing on a paying household's file.
 *
 * A snapshot whose select omits the column under attack is not a weaker
 * assertion than none. It is worse than none, because it reads like one.
 *
 * `User.unclaimedSince` is here for the same reason at one remove: it is the
 * column {@link ReferralClaimSnapshot}'s guard consults, so a change that made a
 * real household look like a placeholder again would be a way back in, and
 * nothing else in the snapshot would notice.
 */
export interface AccountSnapshot {
  readonly name: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly role: string
  readonly status: string | null
  readonly displayName: string | null
  readonly source: string | null
  /** @see referralClaimOf — the column the public path can write. */
  readonly claimedReferralCode: string | null
  readonly claimedReferralCodeAt: Date | null
  /** Non-null only while the row is a placeholder nobody has signed into. */
  readonly unclaimedSince: Date | null
}

export async function accountSnapshot(
  userId: string
): Promise<AccountSnapshot> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      name: true,
      email: true,
      phone: true,
      role: true,
      unclaimedSince: true,
      clientProfile: {
        select: {
          status: true,
          displayName: true,
          source: true,
          claimedReferralCode: true,
          claimedReferralCodeAt: true,
        },
      },
    },
  })

  return {
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.clientProfile?.status ?? null,
    displayName: row.clientProfile?.displayName ?? null,
    source: row.clientProfile?.source ?? null,
    claimedReferralCode: row.clientProfile?.claimedReferralCode ?? null,
    claimedReferralCodeAt: row.clientProfile?.claimedReferralCodeAt ?? null,
    unclaimedSince: row.unclaimedSince,
  }
}

/**
 * The referral attribution standing on a household's file, if any.
 *
 * Read straight off the columns rather than through
 * `readPendingReferralClaim`, because a harness asserting that the public path
 * wrote *a string and nothing else* should look at the string.
 */
export interface ReferralClaimSnapshot {
  readonly code: string
  readonly claimedAt: Date
}

export async function referralClaimOf(
  clientProfileId: string
): Promise<ReferralClaimSnapshot | null> {
  const row = await prisma.clientProfile.findUnique({
    where: { id: clientProfileId },
    select: { claimedReferralCode: true, claimedReferralCodeAt: true },
  })

  if (
    row === null ||
    row.claimedReferralCode === null ||
    row.claimedReferralCodeAt === null
  ) {
    return null
  }

  return { code: row.claimedReferralCode, claimedAt: row.claimedReferralCodeAt }
}

/** The `ClientProfile.id` of the household holding an address, or `null`. */
export async function profileIdForEmail(email: string): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { email },
    select: { clientProfile: { select: { id: true } } },
  })

  return row?.clientProfile?.id ?? null
}

/** The `User.id` behind an address, or `null` when no account was opened. */
export async function userIdForEmail(email: string): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  return row?.id ?? null
}

/**
 * `User.unclaimedSince` — non-null while an account is a placeholder nobody has
 * ever signed into.
 */
export async function unclaimedSinceOf(userId: string): Promise<Date | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { unclaimedSince: true },
  })

  return row?.unclaimedSince ?? null
}

/**
 * Age a claim, so the lapse window can be crossed without waiting a month.
 *
 * The column is moved rather than the clock, because `settleAcceptedClaim` takes
 * `now` as an argument and a harness that passed a future date would be testing
 * its own arithmetic. This moves the *data* into the past and lets the real
 * default `now` decide.
 */
export async function backdateReferralClaim(
  clientProfileId: string,
  claimedAt: Date
): Promise<void> {
  await prisma.clientProfile.update({
    where: { id: clientProfileId },
    data: { claimedReferralCodeAt: claimedAt },
    select: { id: true },
  })
}

/** How many `Account` rows a user has, and which providers they name. */
export async function linkedProvidersOf(
  userId: string
): Promise<readonly string[]> {
  const rows = await prisma.account.findMany({
    where: { userId },
    orderBy: [{ provider: 'asc' }],
    select: { provider: true },
  })

  return rows.map((row) => row.provider)
}

/** The stage a household's onboarding ladder is standing on. */
export async function onboardingStageOf(
  clientProfileId: string
): Promise<string | null> {
  const row = await prisma.onboardingFlow.findUnique({
    where: { clientProfileId },
    select: { currentStage: true },
  })

  return row?.currentStage ?? null
}

export async function consultationCountOf(
  clientProfileId: string
): Promise<number> {
  return prisma.consultationInterview.count({ where: { clientProfileId } })
}

/**
 * The subjects on a household's timeline, oldest first.
 *
 * `InteractionLog.subject` is nullable in the schema, so a row written without
 * one reads back as the literal `'(no subject)'` rather than being dropped —
 * an assertion counting the concierge's timeline should notice a blank line,
 * not silently skip it.
 */
export async function interactionSubjectsOf(
  clientProfileId: string
): Promise<readonly string[]> {
  const rows = await prisma.interactionLog.findMany({
    where: { clientProfileId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { subject: true },
  })

  return rows.map((row) => row.subject ?? '(no subject)')
}

// =============================================================================
// 6. Payloads
//
// Typed as the actions' own parameters, for the reason
// `verify-referral-privilege.ts` gives: a schema that stopped accepting one of
// these would fail `tsc` here rather than quietly leave a harness testing
// nothing.
// =============================================================================

export type ConsultationPayload = Parameters<typeof requestConsultation>[0]
export type ProspectPayload = Parameters<typeof submitProspectIntake>[0]

/** Two candidate times, well clear of `preferredDates`'s "must be future" rule. */
function futureTimes(): string[] {
  const base = Date.now() + 30 * 24 * 60 * 60 * 1_000

  return [
    new Date(base).toISOString(),
    new Date(base + 24 * 60 * 60 * 1_000).toISOString(),
  ]
}

export interface EnquiryPayloadOptions {
  readonly email: string
  readonly fullName?: string | undefined
  /**
   * Supplying one also flips `source` to `REFERRAL`, because
   * `consultationRequestSchema` refuses that pairing in either direction.
   */
  readonly referralCode?: string | undefined
}

/** The public consultation form, as a stranger with a browser would post it. */
export function consultationPayload(
  options: EnquiryPayloadOptions
): ConsultationPayload {
  const base = {
    fullName: options.fullName ?? 'M. Quist',
    email: options.email,
    preferredContactMethod: 'EMAIL',
    preferredDates: futureTimes(),
    durationMinutes: 30,
    consentToContact: true,
  } as const

  return options.referralCode === undefined
    ? { ...base, source: 'DIRECT' }
    : { ...base, source: 'REFERRAL', referralCode: options.referralCode }
}

export interface QuestionnairePayloadOptions extends EnquiryPayloadOptions {
  /** Defaults to an **empty** list — the shape finding D was demonstrated with. */
  readonly allergies?: readonly string[] | undefined
  readonly dislikes?: readonly string[] | undefined
}

/** The public questionnaire. The answers are deliberately unremarkable. */
export function prospectPayload(
  options: QuestionnairePayloadOptions
): ProspectPayload {
  return {
    contact: consultationPayload(options),
    answers: questionnaireAnswers(options),
  }
}

/** The five wizard steps, as `clientIntakeSchema` takes them. */
export function questionnaireAnswers(options: {
  readonly allergies?: readonly string[] | undefined
  readonly dislikes?: readonly string[] | undefined
}): ProspectPayload['answers'] {
  return {
    householdSize: 2,
    adults: 2,
    children: 0,
    allergies: [...(options.allergies ?? [])],
    dislikes: [...(options.dislikes ?? [])],
    cuisinePreferences: [],
    dietaryPreferenceTagIds: [],
    kitchenEquipment: [],
    favouriteDishes: [],
    hasPets: false,
    deliveryFrequency: 'WEEKLY',
    currency: 'CAD',
    preferredContactMethod: 'EMAIL',
    preferredCookDays: [],
  }
}
