// mannachef/apps/web/scripts/fixtures/intake-legacy.ts

/**
 * The pre-MCV-040 source of `actions/intake.ts`, reproduced so the "before"
 * column of each transcript is produced by **running the defect** rather than
 * by asserting a comment.
 *
 * ## Why a copy, and not a switch
 *
 * `verify-superadmin-race.ts` produces its two columns from one source file,
 * because the defect there was a *transaction option* and `fixtures/racing-db.ts`
 * can drop it on the way to Prisma. MCV-040's three defects are in application
 * logic, and the only lever that would let the shipped file run both ways is a
 * flag inside the shipped file — which is a worse thing to have in a codebase
 * than a fixture is.
 *
 * So the fragments below are transcribed from
 * `git show 5c2894d8:mannachef/apps/web/src/server/actions/intake.ts`, verbatim,
 * comments included. Three of them are what the fix changed; three more
 * (`validateDietaryTags`, `intakeColumns`, `writeIntakeForm`) the fix did **not**
 * touch and are copied only because the branch that called them needs them.
 *
 * ## The copies are checked, not trusted
 *
 * A transcription is evidence only for as long as it still matches. Each
 * harness therefore asserts the legacy path and the shipped action agree where
 * they are *supposed* to agree — the referral harnesses compare the redemption
 * row each writes for a freshly created household, and the allergen harness
 * compares the intake columns each writes for one. If a future edit changes
 * what the real code writes and nobody updates these copies, that assertion
 * fails and says so, rather than leaving three harnesses quietly measuring a
 * codebase that no longer exists.
 *
 * Nothing under `src/` imports this file, and nothing here is reachable from
 * the application.
 */

import {
  clientIntakeSchema,
  serviceAddressToColumns,
  type ClientIntake,
  type ClientIntakeInput,
  type ClientSource,
  type ContactMethod,
  type DeliveryFrequency,
} from '@mannachef/validators'

import { ActionError } from '@/server/actions/types'
import { Prisma, prisma } from '@/server/db'

/** Dietary joins are only ever these two kinds of `Tag`. (line 137) */
const DIETARY_TAG_KINDS = ['DIETARY', 'ALLERGEN'] as const

// =============================================================================
// 1. Identity — pre-fix (lines 492–608)
//
// The whole of the difference is the return type: `{ userId, clientProfileId }`
// with no discriminant, so no caller could tell a household this call opened
// from one it merely matched on an unproved email address.
// =============================================================================

interface ProspectContact {
  readonly fullName: string
  readonly email: string
  readonly phone?: string | undefined
  readonly preferredContactMethod: ContactMethod
  readonly source: ClientSource
  readonly sourceDetail?: string | undefined
}

interface ResolvedIdentity {
  readonly userId: string
  readonly clientProfileId: string
}

async function legacyResolveIdentity(
  tx: Prisma.TransactionClient,
  sessionUserId: string | null,
  contact: ProspectContact
): Promise<ResolvedIdentity> {
  const existingUser =
    sessionUserId !== null
      ? await tx.user.findUnique({
          where: { id: sessionUserId },
          select: { id: true, clientProfile: { select: { id: true } } },
        })
      : await tx.user.findUnique({
          where: { email: contact.email },
          select: { id: true, clientProfile: { select: { id: true } } },
        })

  let userId: string

  if (existingUser !== null) {
    // Deliberately no update. The name, phone, role and locale on an account
    // that already exists belong to that account; a public form does not edit
    // them, and a stranger who guessed the address must not be able to.
    userId = existingUser.id

    if (existingUser.clientProfile !== null) {
      return { userId, clientProfileId: existingUser.clientProfile.id }
    }
  } else {
    userId = await legacyCreateProspectUser(tx, contact)
  }

  const profile = await tx.clientProfile.upsert({
    where: { userId },
    create: {
      userId,
      displayName: contact.fullName,
      preferredName: contact.fullName,
      status: 'PROSPECT',
      source: contact.source,
      sourceDetail: contact.sourceDetail ?? null,
      phone: contact.phone ?? null,
      preferredContactMethod: contact.preferredContactMethod,
    },
    update: {},
    select: { id: true },
  })

  return { userId, clientProfileId: profile.id }
}

async function legacyCreateProspectUser(
  tx: Prisma.TransactionClient,
  contact: ProspectContact
): Promise<string> {
  try {
    const created = await tx.user.create({
      data: {
        name: contact.fullName,
        email: contact.email,
        role: 'CLIENT',
        phone: contact.phone ?? null,
      },
      select: { id: true },
    })

    return created.id
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const raced = await tx.user.findUnique({
        where: { email: contact.email },
        select: { id: true },
      })

      if (raced !== null) {
        return raced.id
      }
    }

    throw error
  }
}

// =============================================================================
// 2. `attachReferral` — pre-fix (lines 942–998)
//
// Findings A and B, both of them, in fifty lines: it takes a bare
// `referredUserId` and asks nothing about where it came from, and it compares
// `redemptionCount` to `maxRedemptions` without ever moving the counter.
// =============================================================================

async function legacyAttachReferral(
  tx: Prisma.TransactionClient,
  referredUserId: string,
  code: string,
  now: Date
): Promise<void> {
  const referral = await tx.referralCode.findFirst({
    where: {
      code,
      isActive: true,
      ownerId: { not: referredUserId },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, maxRedemptions: true, redemptionCount: true },
  })

  if (referral === null) {
    return
  }

  if (
    referral.maxRedemptions !== null &&
    referral.redemptionCount >= referral.maxRedemptions
  ) {
    return
  }

  const existing = await tx.referralRedemption.findUnique({
    where: {
      referralCodeId_referredUserId: {
        referralCodeId: referral.id,
        referredUserId,
      },
    },
    select: { id: true },
  })

  if (existing !== null) {
    return
  }

  await tx.referralRedemption.create({
    data: { referralCodeId: referral.id, referredUserId, status: 'PENDING' },
    select: { id: true },
  })
}

// =============================================================================
// 3. The questionnaire write — unchanged by the fix (lines 678–816)
//
// Copied because section 4 calls it, not because it is the defect. The defect
// is the *condition* section 4 puts in front of it.
// =============================================================================

async function validateDietaryTags(
  tx: Prisma.TransactionClient,
  tagIds: readonly string[]
): Promise<string[]> {
  if (tagIds.length === 0) {
    return []
  }

  const rows = await tx.tag.findMany({
    where: {
      id: { in: [...tagIds] },
      kind: { in: [...DIETARY_TAG_KINDS] },
      isActive: true,
    },
    select: { id: true },
  })

  if (rows.length !== new Set(tagIds).size) {
    throw new ActionError(
      'VALIDATION',
      'One of the dietary preferences you chose is no longer on our list.',
      {
        dietaryPreferenceTagIds: [
          'Please choose your dietary preferences from the list again.',
        ],
      }
    )
  }

  return rows.map((row) => row.id)
}

interface IntakeColumns {
  householdSize: number
  adults: number
  children: number
  allergies: string[]
  dislikes: string[]
  cuisinePreferences: string[]
  kitchenEquipment: string[]
  favouriteDishes: string[]
  hasPets: boolean
  petsNote: string | null
  deliveryFrequency: DeliveryFrequency
  budgetPerMealCents: number | null
  currency: string
  serviceAddressLine1: string | null
  serviceAddressLine2: string | null
  serviceCity: string | null
  serviceRegion: string | null
  servicePostalCode: string | null
  serviceCountry: string | null
  serviceAccessNotes: string | null
  preferredContactMethod: ContactMethod
  preferredCookDays: string[]
  notes: string | null
}

function intakeColumns(answers: ClientIntake): IntakeColumns {
  return {
    householdSize: answers.householdSize,
    adults: answers.adults,
    children: answers.children,
    allergies: [...answers.allergies],
    dislikes: [...answers.dislikes],
    cuisinePreferences: [...answers.cuisinePreferences],
    kitchenEquipment: [...answers.kitchenEquipment],
    favouriteDishes: [...answers.favouriteDishes],
    hasPets: answers.hasPets,
    petsNote: answers.petsNote ?? null,
    deliveryFrequency: answers.deliveryFrequency,
    budgetPerMealCents: answers.budgetPerMealCents ?? null,
    currency: answers.currency,
    ...serviceAddressToColumns(answers.serviceAddress),
    serviceAccessNotes: answers.serviceAccessNotes ?? null,
    preferredContactMethod: answers.preferredContactMethod,
    preferredCookDays: [...answers.preferredCookDays],
    notes: answers.notes ?? null,
  }
}

interface WrittenIntakeForm {
  readonly id: string
  readonly submittedAt: Date | null
  readonly deliveryFrequency: DeliveryFrequency
}

async function writeIntakeForm(
  tx: Prisma.TransactionClient,
  clientProfileId: string,
  answers: ClientIntake,
  submittedAt: Date | null
): Promise<WrittenIntakeForm> {
  const tagIds = await validateDietaryTags(tx, answers.dietaryPreferenceTagIds)
  const columns = intakeColumns(answers)

  const form = await tx.clientIntakeForm.upsert({
    where: { clientProfileId },
    create: { clientProfileId, ...columns, submittedAt },
    update: { ...columns, ...(submittedAt === null ? {} : { submittedAt }) },
    select: { id: true, submittedAt: true, deliveryFrequency: true },
  })

  await tx.clientIntakeFormTag.deleteMany({
    where: { clientIntakeFormId: form.id },
  })

  if (tagIds.length > 0) {
    await tx.clientIntakeFormTag.createMany({
      data: tagIds.map((tagId) => ({ clientIntakeFormId: form.id, tagId })),
      skipDuplicates: true,
    })
  }

  return form
}

// =============================================================================
// 4. The two entry points, as the harnesses drive them
// =============================================================================

/** What the pre-fix `submitProspectIntake` decided to do with the answers. */
export type LegacyIntakeOutcome = 'duplicate' | 'written'

export interface LegacyEnquiry {
  readonly sessionUserId: string | null
  readonly fullName: string
  readonly email: string
  readonly preferredContactMethod: ContactMethod
  readonly source: ClientSource
  readonly referralCode?: string | undefined
}

export interface LegacyEnquiryResult {
  readonly userId: string
  readonly clientProfileId: string
}

/**
 * The pre-fix `requestConsultation`, reduced to the two statements finding A
 * and finding B are about: resolve the identity from an unproved email address,
 * then hand the resulting `userId` — a bare string — to `attachReferral`.
 *
 * The consultation row, the onboarding move and the interaction log are left
 * out. They are unchanged by the fix, and none of them is money.
 */
export async function legacyRequestConsultation(
  enquiry: LegacyEnquiry
): Promise<LegacyEnquiryResult> {
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    const identity = await legacyResolveIdentity(tx, enquiry.sessionUserId, {
      fullName: enquiry.fullName,
      email: enquiry.email,
      preferredContactMethod: enquiry.preferredContactMethod,
      source: enquiry.source,
    })

    if (enquiry.referralCode !== undefined) {
      // Line 1129 of the pre-fix file. `identity.userId` is whoever owns the
      // address in the payload, and this function has no way to ask whether
      // the caller had any right to it.
      await legacyAttachReferral(tx, identity.userId, enquiry.referralCode, now)
    }

    return identity
  })
}

export interface LegacyProspectIntakeResult extends LegacyEnquiryResult {
  readonly outcome: LegacyIntakeOutcome
}

/**
 * The pre-fix `submitProspectIntake`, reduced to the branch finding D is about.
 *
 * ```ts
 * if (onFile !== null && onFile.submittedAt !== null) { …log a duplicate, return… }
 *
 * const form = await writeIntakeForm(tx, identity.clientProfileId, input.answers, now)
 * ```
 *
 * A household that exists but has never returned its questionnaire has
 * `onFile === null`, so the guard does not engage and execution falls through
 * to the write — for an anonymous caller, against a real household, stamping
 * `submittedAt`.
 */
export async function legacyProspectIntake(
  enquiry: LegacyEnquiry,
  raw: ClientIntakeInput
): Promise<LegacyProspectIntakeResult> {
  const now = new Date()

  // `withAction` is what parsed the payload before the pre-fix handler saw it,
  // and this fixture does not go through the wrapper — so the parse happens
  // here instead, with the same schema. The handler body below therefore
  // receives exactly what it used to receive: defaults applied, rules checked.
  const answers = clientIntakeSchema.parse(raw)

  return prisma.$transaction(async (tx) => {
    const identity = await legacyResolveIdentity(tx, enquiry.sessionUserId, {
      fullName: enquiry.fullName,
      email: enquiry.email,
      preferredContactMethod: enquiry.preferredContactMethod,
      source: enquiry.source,
    })

    const onFile = await tx.clientIntakeForm.findUnique({
      where: { clientProfileId: identity.clientProfileId },
      select: { id: true, submittedAt: true },
    })

    if (onFile !== null && onFile.submittedAt !== null) {
      return { ...identity, outcome: 'duplicate' as const }
    }

    await writeIntakeForm(tx, identity.clientProfileId, answers, now)

    if (enquiry.referralCode !== undefined) {
      await legacyAttachReferral(tx, identity.userId, enquiry.referralCode, now)
    }

    return { ...identity, outcome: 'written' as const }
  })
}
