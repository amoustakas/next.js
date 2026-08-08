// mannachef/apps/web/src/server/actions/intake.ts

'use server'

/**
 * Intake — the road from a stranger on the marketing site to a household we
 * cook for.
 *
 * Five things happen in this file, in the order a household experiences them:
 *
 *  1. **A consultation is requested** from the public site by somebody with no
 *     account ({@link requestConsultation}).
 *  2. **The questionnaire is answered** — either by that same prospect, still
 *     signed out ({@link submitProspectIntake}), or by a household that already
 *     has an account, or by a concierge on the telephone ({@link submitIntake}).
 *  3. **The concierge reads the submissions** ({@link listIntakeSubmissions},
 *     {@link getIntakeSubmission}) and arranges an interview
 *     ({@link scheduleConsultation}, {@link listConsultations}).
 *  4. **The interview is written up** ({@link recordConsultationNotes}) and
 *     scored against the household's own answers
 *     ({@link scoreConsultationCompatibility}).
 *  5. **The prospect becomes a client**, in one transactional, idempotent
 *     gesture ({@link convertProspect}).
 *
 * ## The rule the first two exist to obey
 *
 * **A public submission never writes to an existing household's record.**
 *
 * The prospect entry points are reachable by anyone with a browser, and the one
 * piece of identity they carry is an email address the sender has not proved
 * they own. Everything downstream follows from treating that address as a
 * *claim*, and from {@link resolveIdentity} reporting, as a typed discriminant,
 * whether it `created` the `User` it returned or merely `matched` one that was
 * already ours.
 *
 * The enumeration below is deliberately phrased over **rows and columns both**,
 * and over **every household, including one this call opened**. Getting either
 * of those halves wrong has cost an audit round apiece:
 *
 *  - An early version promised only that "not one of their columns is written".
 *    `attachReferral` walked straight through that by inserting a *new row* — a
 *    `ReferralRedemption` naming the matched household as somebody's referee,
 *    which is money — aimed at any address a caller could guess (MCV-040 finding
 *    A). A protection stated over the wrong noun is not a protection.
 *  - The repair narrowed that row to households the same call had *created*, and
 *    the enumeration went on describing the danger as belonging to households
 *    that were "already ours". It does not. An address that is not ours **yet**
 *    is somebody's mailbox all the same, and its owner may register tomorrow by
 *    magic link and bind to the very row a stranger's enquiry opened. That is how
 *    an anonymous caller was paid $50 for a household they had never met
 *    (MCV-050). No public write is protected by the fact that the account is new.
 *
 * So the enumeration is now over what a public caller may write **at all**,
 * whether the household is old or a second old, and the only thing that opens
 * the door to money is a session.
 *
 *  - When the caller is signed in, the payload's email is ignored entirely for
 *    identity and the session's own `User` is used. A signed-in caller can
 *    therefore never open or touch a record belonging to a different address.
 *  - When the caller is anonymous and the address is already ours — an identity
 *    of kind `matched` — the existing `User` and `ClientProfile` are read and
 *    **not one of their columns is written**. No name, no phone, no source, no
 *    status. The enquiry is recorded *alongside* them as a
 *    `ConsultationInterview` and an `InteractionLog`, which is what the
 *    concierge needs and what a stranger cannot use to vandalise a real
 *    client's file.
 *  - When the caller is anonymous and the identity is `matched`, **no
 *    `ClientIntakeForm` is written either** — not amended, and not created. It
 *    makes no difference whether the household has already returned its
 *    questionnaire: a household that has not (one the concierge opened, or one
 *    {@link convertProspect} promoted) is the *more* fragile case, because a
 *    stranger's answers would arrive stamped `submittedAt` and would then be
 *    the allergen list a chef cooks against (MCV-040 finding D).
 *  - **No anonymous caller may cause a row that carries money to be written at
 *    all** — not against a household that was already ours, and not against one
 *    this call opened a moment ago. There is no `ReferralRedemption` on this
 *    path any more, under any discriminant. {@link attachReferralClaim} writes
 *    the code the prospect typed as a *string* on their own `ClientProfile`, and
 *    `@/server/referral-claim` turns that string into a redemption at the first
 *    sign-in that proves the mailbox, through the same canonical writer
 *    `redeemReferralCode` uses. It still takes the whole
 *    {@link ResolvedIdentity} rather than a bare id, because the *column* is
 *    still somebody's and a call site must not be able to forget whose.
 *  - Row identifiers are withheld from anonymous callers — {@link
 *    ConsultationReceipt} and {@link ProspectIntakeReceipt} both carry `null`
 *    ids for them — and neither the response shape *nor its values* vary with
 *    whether the address was already known. The form is therefore not an oracle
 *    for who our clients are.
 *
 * ## What a household may read
 *
 * `ConsultationInterview.notes` and `.chefSummary` are written for colleagues —
 * "the husband is difficult about the wine" belongs in exactly this column —
 * and {@link toConsultationView} nulls both for anybody below `CHEF_STAFF`. The
 * compatibility score goes with them: a household should not be shown a number
 * out of a hundred describing how much we want their custom.
 */

import {
  MAX_NOTES_LENGTH,
  canAdvanceTo,
  clientIntakeCreateSchema,
  clientIntakeFilterSchema,
  clientIntakeSchema,
  consultationInterviewCreateSchema,
  consultationInterviewFilterSchema,
  consultationInterviewUpdateSchema,
  consultationRequestSchema,
  cuidSchema,
  hasRoleAtLeast,
  onboardingProgressPercent,
  paginationToSkipTake,
  prospectConversionSchema,
  serviceAddressToColumns,
  type ClientIntake,
  type ClientSource,
  type ClientStatus,
  type ConsultationOutcome,
  type ContactMethod,
  type DeliveryFrequency,
  type OnboardingStage,
} from '@mannachef/validators'
import type { IntakeSubmissionView, PageMeta } from '@mannachef/api-contract'
import { z } from 'zod'

import {
  ActionError,
  fail,
  ok,
  type ActionResult,
} from '@/server/actions/types'
import { Prisma } from '@/server/db'
import {
  requireIntakeFormOwnership,
  withAction,
  type AuthenticatedUser,
} from '@/server/guards'
import { recordReferralClaim } from '@/server/referral-claim'

// =============================================================================
// 0. Constants
// =============================================================================

const INTAKE_PATHS = [
  '/admin/intake',
  '/admin/consultations',
  '/admin/clients',
  '/portal/onboarding',
] as const

const INTAKE_TAGS = [
  'intake',
  'consultations',
  'onboarding',
  'pipeline',
] as const

/**
 * The public forms, throttled per IP.
 *
 * `scope: 'ip'` rather than the default `'identity'`: a prospect has no
 * identity, and a bucket that falls back to IP *only* for signed-out callers
 * would hand a scraper a private quota per account it can mint.
 */
const PUBLIC_FORM_RATE_LIMIT = {
  tokens: 5,
  windowMs: 60 * 60 * 1_000,
  scope: 'ip',
} as const

/** The signed-in questionnaire. Generous — a household edits it as they think. */
const INTAKE_RATE_LIMIT = { tokens: 20, windowMs: 60 * 60 * 1_000 } as const

/** Dietary joins are only ever these two kinds of `Tag`. */
const DIETARY_TAG_KINDS = ['DIETARY', 'ALLERGEN'] as const

// =============================================================================
// 1. Local input schemas
//
// Composed from `@mannachef/validators`, never restating a rule the package
// already owns. Each of the three below is a *pairing* or a *narrowing* of
// schemas that live there.
// =============================================================================

/**
 * The signed-out questionnaire: who is asking, and what they told us.
 *
 * `consultationRequestSchema` already owns identity, consent, the referral code
 * and the candidate times; `clientIntakeSchema` already owns the five wizard
 * steps. Nesting them *is* the schema — there is no third set of rules here.
 */
const prospectIntakeSchema = z
  .object({
    contact: consultationRequestSchema,
    answers: clientIntakeSchema,
  })
  .strict()

const intakeFormIdSchema = z.object({ intakeFormId: cuidSchema }).strict()

/**
 * Scoring is a *server* computation, so the payload names the interview and
 * nothing else. A caller cannot post a score: `compatibilityScore` reaches the
 * column through {@link scoreConsultationCompatibility}'s own arithmetic, or
 * through {@link recordConsultationNotes}, where a human is deliberately
 * overriding the rubric and `consultationInterviewUpdateSchema` bounds them.
 */
const consultationScoreSchema = z
  .object({
    consultationInterviewId: cuidSchema,
    /** Score against this chef in particular rather than against the house. */
    staffProfileId: cuidSchema.optional(),
  })
  .strict()

// =============================================================================
// 2. Projections
// =============================================================================

/** Exactly the intake columns a read may touch. Nothing is spread. */
const INTAKE_FORM_SELECT = {
  id: true,
  clientProfileId: true,
  householdSize: true,
  adults: true,
  children: true,
  allergies: true,
  dislikes: true,
  cuisinePreferences: true,
  kitchenEquipment: true,
  favouriteDishes: true,
  hasPets: true,
  petsNote: true,
  deliveryFrequency: true,
  budgetPerMealCents: true,
  currency: true,
  serviceAddressLine1: true,
  serviceAddressLine2: true,
  serviceCity: true,
  serviceRegion: true,
  servicePostalCode: true,
  serviceCountry: true,
  serviceAccessNotes: true,
  preferredContactMethod: true,
  preferredCookDays: true,
  notes: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
  dietaryPreferences: {
    select: {
      tagId: true,
      tag: { select: { slug: true, name: true, kind: true } },
    },
  },
} satisfies Prisma.ClientIntakeFormSelect

type IntakeFormRow = Prisma.ClientIntakeFormGetPayload<{
  select: typeof INTAKE_FORM_SELECT
}>

const CONSULTATION_SELECT = {
  id: true,
  clientProfileId: true,
  conductedById: true,
  staffProfileId: true,
  scheduledFor: true,
  durationMinutes: true,
  location: true,
  meetingUrl: true,
  startedAt: true,
  completedAt: true,
  compatibilityScore: true,
  notes: true,
  chefSummary: true,
  outcome: true,
  followUpAt: true,
  convertedToClientAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConsultationInterviewSelect

type ConsultationRow = Prisma.ConsultationInterviewGetPayload<{
  select: typeof CONSULTATION_SELECT
}>

/** One dietary or allergen tag attached to a questionnaire. */
interface IntakeTagView {
  readonly tagId: string
  readonly slug: string
  readonly name: string
  readonly kind: string
}

/** A household's answers, as the OS and the portal render them. */
interface IntakeFormView {
  readonly id: string
  readonly clientProfileId: string
  readonly householdSize: number
  readonly adults: number
  readonly children: number
  readonly allergies: readonly string[]
  readonly dislikes: readonly string[]
  readonly cuisinePreferences: readonly string[]
  readonly kitchenEquipment: readonly string[]
  readonly favouriteDishes: readonly string[]
  readonly hasPets: boolean
  readonly petsNote: string | null
  readonly deliveryFrequency: DeliveryFrequency
  readonly budgetPerMealCents: number | null
  readonly currency: string
  readonly serviceAddress: {
    readonly line1: string | null
    readonly line2: string | null
    readonly city: string | null
    readonly region: string | null
    readonly postalCode: string | null
    readonly country: string | null
  } | null
  readonly serviceAccessNotes: string | null
  readonly preferredContactMethod: ContactMethod
  readonly preferredCookDays: readonly string[]
  readonly notes: string | null
  readonly dietaryPreferences: readonly IntakeTagView[]
  readonly submittedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** An interview, with the kitchen's private commentary conditionally removed. */
interface ConsultationView {
  readonly id: string
  readonly clientProfileId: string
  readonly conductedById: string | null
  readonly staffProfileId: string | null
  readonly scheduledFor: Date
  readonly durationMinutes: number
  readonly location: string | null
  readonly meetingUrl: string | null
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly compatibilityScore: number | null
  readonly notes: string | null
  readonly chefSummary: string | null
  readonly outcome: ConsultationOutcome
  readonly followUpAt: Date | null
  readonly convertedToClientAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What a public consultation request returns. Ids only for a known caller. */
interface ConsultationReceipt {
  readonly received: true
  /** `null` for an anonymous caller — see the note at the head of this file. */
  readonly consultationInterviewId: string | null
  readonly scheduledFor: Date
  readonly durationMinutes: number
}

/** What the public questionnaire returns. Ids only for a known caller. */
interface ProspectIntakeReceipt {
  readonly received: true
  readonly intakeFormId: string | null
  readonly clientProfileId: string | null
  readonly consultationInterviewId: string | null
  readonly submittedAt: Date | null
}

/** A page of questionnaires for the concierge. */
interface IntakeListView {
  readonly items: readonly IntakeFormView[]
  readonly meta: PageMeta
}

/** A page of interviews. */
interface ConsultationListView {
  readonly items: readonly ConsultationView[]
  readonly meta: PageMeta
}

/** One line of the rubric. */
interface ScoreComponent {
  readonly label: string
  readonly awarded: number
  readonly available: number
  readonly reason: string
}

/** The rubric, itemised, so a concierge can see why a household scored as it did. */
interface CompatibilityBreakdown {
  readonly consultationInterviewId: string
  readonly score: number
  readonly components: readonly ScoreComponent[]
}

/** What {@link convertProspect} reports. */
interface ProspectConversionView {
  readonly clientProfileId: string
  readonly status: ClientStatus
  readonly onboardingStage: OnboardingStage
  readonly consultationInterviewId: string | null
  readonly convertedAt: Date | null
  /**
   * `true` when the household was already in the requested state and this call
   * changed nothing. The conversion button is a one-click gesture on a busy
   * board; pressing it twice must not write twice.
   */
  readonly alreadyConverted: boolean
}

function buildPageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0

  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  }
}

function isStaff(user: AuthenticatedUser): boolean {
  return hasRoleAtLeast(user.role, 'CHEF_STAFF')
}

function toIntakeFormView(row: IntakeFormRow): IntakeFormView {
  const hasAddress =
    row.serviceAddressLine1 !== null ||
    row.serviceAddressLine2 !== null ||
    row.serviceCity !== null ||
    row.serviceRegion !== null ||
    row.servicePostalCode !== null ||
    row.serviceCountry !== null

  return {
    id: row.id,
    clientProfileId: row.clientProfileId,
    householdSize: row.householdSize,
    adults: row.adults,
    children: row.children,
    allergies: row.allergies,
    dislikes: row.dislikes,
    cuisinePreferences: row.cuisinePreferences,
    kitchenEquipment: row.kitchenEquipment,
    favouriteDishes: row.favouriteDishes,
    hasPets: row.hasPets,
    petsNote: row.petsNote,
    deliveryFrequency: row.deliveryFrequency,
    budgetPerMealCents: row.budgetPerMealCents,
    currency: row.currency,
    serviceAddress: hasAddress
      ? {
          line1: row.serviceAddressLine1,
          line2: row.serviceAddressLine2,
          city: row.serviceCity,
          region: row.serviceRegion,
          postalCode: row.servicePostalCode,
          country: row.serviceCountry,
        }
      : null,
    serviceAccessNotes: row.serviceAccessNotes,
    preferredContactMethod: row.preferredContactMethod,
    preferredCookDays: row.preferredCookDays,
    notes: row.notes,
    dietaryPreferences: row.dietaryPreferences.map((join) => ({
      tagId: join.tagId,
      slug: join.tag.slug,
      name: join.tag.name,
      kind: join.tag.kind,
    })),
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Render an interview for a caller.
 *
 * Four columns are staff-only and are nulled rather than omitted, so the shape
 * a household receives is the shape a concierge receives and no screen has to
 * branch on which it got. `notes` and `chefSummary` are written *about* the
 * household; `compatibilityScore` is written about how much we want them; and
 * `conductedById` names a colleague the household has no business identifying.
 */
function toConsultationView(
  row: ConsultationRow,
  forStaff: boolean
): ConsultationView {
  return {
    id: row.id,
    clientProfileId: row.clientProfileId,
    conductedById: forStaff ? row.conductedById : null,
    staffProfileId: row.staffProfileId,
    scheduledFor: row.scheduledFor,
    durationMinutes: row.durationMinutes,
    location: row.location,
    meetingUrl: row.meetingUrl,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    compatibilityScore: forStaff ? row.compatibilityScore : null,
    notes: forStaff ? row.notes : null,
    chefSummary: forStaff ? row.chefSummary : null,
    outcome: row.outcome,
    followUpAt: row.followUpAt,
    convertedToClientAt: row.convertedToClientAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** `@db.Text` will take anything; the questionnaire's own ceiling is 2,000. */
function clampProse(value: string): string {
  return value.length <= MAX_NOTES_LENGTH
    ? value
    : `${value.slice(0, MAX_NOTES_LENGTH - 1)}…`
}

// =============================================================================
// 3. Identity, resolved without trusting an email address
// =============================================================================

interface ProspectContact {
  readonly fullName: string
  readonly email: string
  readonly phone?: string | undefined
  readonly preferredContactMethod: ContactMethod
  readonly source: ClientSource
  readonly sourceDetail?: string | undefined
}

/**
 * Where the `User` behind an enquiry came from.
 *
 * Two answers rather than one field, and modelled as a discriminated union for
 * the reason the Stripe webhook's `Attribution` is: the difference between "we
 * opened this account a moment ago" and "this account was already ours" decides
 * whether a caller who has proved nothing may write to it, and a shape that
 * could only report an id made that question invisible at every call site.
 *
 * ## What this discriminant is, and what it is not (MCV-050)
 *
 * It is a statement about **rows**: whether this transaction inserted the `User`,
 * or found one. It is therefore the right question to ask before writing a
 * *column* — a stranger must not scribble on a household that was already ours,
 * and that is the promise the file docblock makes.
 *
 * It is **not** a statement about **consent**, and for one audit round it was
 * read as one. The note that used to sit on `created` said: *"Nobody else has
 * ever held this account, so there is nothing of anybody's to damage and no
 * consent to forge."* Both halves are false. Nobody has held it **yet** — the
 * address belongs to a person who has simply not registered with us, and who may
 * do so tomorrow through the ordinary magic link, binding to this very row.
 * `attachReferral` trusted that sentence and wrote a money-bearing
 * `ReferralRedemption` against addresses nobody had proved, which is how an
 * anonymous caller was paid $50 when a stranger they had never met signed up and
 * settled an invoice.
 *
 * So nothing that carries money branches on this any more. The question that
 * decides money is *"has this caller proved control of this mailbox?"*, it is
 * answered by a session and not by a row count, and it is asked in
 * `@/server/referral-claim` at the first authenticated sign-in.
 *
 * `clientProfileId` accompanies both, because every caller needs it.
 */
type ResolvedIdentity =
  /**
   * This call inserted the `User` row, and marked it `unclaimedSince`.
   *
   * The account is new **to us**; the mailbox is not thereby the caller's. What
   * follows is exactly this: no household's existing columns can be damaged,
   * because there was no household. Nothing about ownership, consent, or the
   * right to earn money against this address follows, and code that needs one of
   * those must ask `@/server/referral-claim` instead.
   */
  | {
      readonly kind: 'created'
      readonly userId: string
      readonly clientProfileId: string
    }
  /**
   * The `User` row was already ours. Either the caller's own session named it —
   * in which case ownership is proved but the account is still not new — or an
   * **unproved email address** in a public payload matched it, in which case the
   * caller has demonstrated nothing beyond knowing how to spell it.
   */
  | {
      readonly kind: 'matched'
      readonly userId: string
      readonly clientProfileId: string
    }

/**
 * Find, or carefully open, the household this enquiry belongs to.
 *
 * A signed-in caller is themselves — the payload's email is not consulted at
 * all, so nobody can drive this function at a record they do not own by typing
 * somebody else's address into a public form. That identity is reported as
 * `matched`: a session proves *ownership*, not *novelty*, and the two callers of
 * this function want to know about novelty.
 *
 * An anonymous caller whose address we already hold gets the *existing* rows
 * back, untouched, also as `matched`. The `create` branch runs only when there
 * is genuinely nothing there, and the `P2002` retry inside
 * {@link createProspectUser} covers two submissions racing for the same
 * brand-new address — reporting `matched`, because the loser of that race read
 * a row it did not write.
 *
 * ## The `User` this opens is marked as a placeholder (MCV-050)
 *
 * `unclaimedSince` is stamped on every account this function creates, and is
 * cleared by `markMailboxProved` at the first sign-in that proves the mailbox.
 * It is what makes "an account nobody has ever authenticated into" a thing the
 * platform can *see* rather than infer, and three decisions turn on it: such a
 * row may be adopted by an OAuth sign-in instead of colliding with it
 * (`adoptUnclaimedAccount` — see below), it is the account state in which a
 * referral claim is still only a string, and it is the only state in which
 * {@link attachReferralClaim} will refresh that string.
 *
 * ## Why a `User` is opened at all for an address nobody has proved
 *
 * It was reconsidered for MCV-050, because opening one has a cost: a placeholder
 * has no `Account`, `allowDangerousEmailAccountLinking` is `false`, and Auth.js
 * therefore refuses a later Google sign-in for that address with
 * `OAuthAccountNotLinked` — so typing an address into a public form could deny
 * its owner registration, permanently.
 *
 * Holding the prospect without a `User` would be structurally cleaner, and it is
 * not affordable here: `User` is this schema's identity spine. `Invoice`,
 * `UserSubscription`, `PaymentHistory`, `RewardBalance`, `Review` and
 * `ReferralRedemption` are all keyed on `User`, not on `ClientProfile`, and
 * {@link convertProspect} promotes a prospect *into* those tables. Making
 * `ClientProfile.userId` nullable to defer it would put a nullable identity
 * behind ~225 references across ten server modules and nine `user: { select … }`
 * traversals, every one of which would have to answer "and what if this
 * household has no account yet" — a far larger surface than the harm being
 * removed, and one no test in this repository covers.
 *
 * So the row is opened, and the harm is closed where it actually lands:
 * `adoptUnclaimedAccount` in `@/server/referral-claim` links the OAuth account to
 * a placeholder that has no `Account`, no `Session` and no `lastLoginAt`, instead
 * of refusing it. That is narrower than the provider flag by exactly the property
 * that makes the flag dangerous — it applies only to rows no human has ever
 * exercised.
 */
async function resolveIdentity(
  tx: Prisma.TransactionClient,
  sessionUserId: string | null,
  contact: ProspectContact,
  now: Date
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
  let kind: ResolvedIdentity['kind']

  if (existingUser !== null) {
    // Deliberately no update. The name, phone, role and locale on an account
    // that already exists belong to that account; a public form does not edit
    // them, and a stranger who guessed the address must not be able to.
    userId = existingUser.id
    kind = 'matched'

    if (existingUser.clientProfile !== null) {
      return { kind, userId, clientProfileId: existingUser.clientProfile.id }
    }
  } else {
    const opened = await createProspectUser(tx, contact, now)

    userId = opened.userId
    kind = opened.kind
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
    // An `upsert` rather than a `create` purely so a profile opened by a
    // concurrent request is returned instead of raising a unique violation.
    // The update branch is empty on purpose: reaching it means the record was
    // already ours, and this path does not rewrite one.
    update: {},
    select: { id: true },
  })

  return { kind, userId, clientProfileId: profile.id }
}

/** A `User` opened for a prospect, and whether this call is what opened it. */
interface OpenedProspectUser {
  readonly kind: ResolvedIdentity['kind']
  readonly userId: string
}

async function createProspectUser(
  tx: Prisma.TransactionClient,
  contact: ProspectContact,
  now: Date
): Promise<OpenedProspectUser> {
  try {
    const created = await tx.user.create({
      data: {
        name: contact.fullName,
        email: contact.email,
        // A prospect is a `CLIENT`. Nothing on the public path mints a role.
        role: 'CLIENT',
        phone: contact.phone ?? null,
        // Nobody has proved this mailbox. See `unclaimedSince` in
        // `schema.prisma` and `resolveIdentity`'s note above: this is the
        // difference between an account and a placeholder, and it is what a
        // later real sign-in adopts.
        unclaimedSince: now,
      },
      select: { id: true },
    })

    return { kind: 'created', userId: created.id }
  } catch (error) {
    // Two submissions for the same unknown address arriving together: the loser
    // reads the winner's row rather than failing the enquiry.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const raced = await tx.user.findUnique({
        where: { email: contact.email },
        select: { id: true },
      })

      if (raced !== null) {
        // `matched`, emphatically. This branch *read* a row another transaction
        // wrote; the winner may have been the household itself signing up in
        // the next tab, and the loser has proved no more about that address
        // than the exploit in finding A did.
        return { kind: 'matched', userId: raced.id }
      }
    }

    throw error
  }
}

// =============================================================================
// 4. The onboarding ladder, as intake drives it
// =============================================================================

/**
 * Move a household's flow to `target`, opening the flow if it has none.
 *
 * The move is offered to `canAdvanceTo` and *silently declined* when the ladder
 * refuses it, because intake is not the authority on the journey: a household
 * that has already paid must not be dragged back to `INTAKE_SUBMITTED` because
 * somebody re-sent their questionnaire. `onboarding.ts` is where a refused move
 * is an error the operator is told about; here it is simply not made.
 */
async function advanceFlowTo(
  tx: Prisma.TransactionClient,
  clientProfileId: string,
  target: OnboardingStage,
  note: string | null,
  occurredAt: Date
): Promise<OnboardingStage> {
  const flow = await tx.onboardingFlow.upsert({
    where: { clientProfileId },
    create: {
      clientProfileId,
      currentStage: 'INVITED',
      startedAt: occurredAt,
      progressPercent: onboardingProgressPercent('INVITED'),
    },
    update: {},
    select: { id: true, currentStage: true },
  })

  if (!canAdvanceTo(flow.currentStage, target)) {
    return flow.currentStage
  }

  await tx.onboardingFlow.update({
    where: { id: flow.id },
    data: {
      currentStage: target,
      progressPercent: onboardingProgressPercent(target),
      lastAdvancedAt: occurredAt,
      ...(target === 'ACTIVATED' ? { completedAt: occurredAt } : {}),
    },
    select: { id: true },
  })

  await tx.onboardingStepCompletion.upsert({
    where: {
      onboardingFlowId_stage: { onboardingFlowId: flow.id, stage: target },
    },
    create: {
      onboardingFlowId: flow.id,
      stage: target,
      completedAt: occurredAt,
      ...(note === null ? {} : { note: clampProse(note) }),
    },
    update: {},
    select: { id: true },
  })

  return target
}

// =============================================================================
// 5. Shared write helpers
// =============================================================================

/**
 * Confirm every dietary tag the household chose is a real, live `DIETARY` or
 * `ALLERGEN` tag.
 *
 * Checked before the join rows are written so a bad id becomes a message
 * against the field the guest can see rather than a foreign-key violation from
 * inside a transaction. The *kind* filter matters as much as existence: without
 * it a caller could attach a `CUISINE` tag and quietly poison the allergen
 * report a chef reads before cooking.
 */
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
    // Thrown rather than returned: this runs inside `$transaction`, where a
    // return would commit. `withAction` turns an `ActionError` back into the
    // precise `ActionResult` it stands for.
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

/** The literal columns an intake write touches, stated once. */
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
    // Absent parts become `null`, so clearing an address clears the row rather
    // than leaving a stale fragment of the last one behind.
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

/**
 * Write the questionnaire and its dietary joins.
 *
 * `submittedAt` moves forward and never back: passing `null` leaves whatever is
 * stored alone, so an amendment made after submission does not un-submit the
 * form and drop the household out of the concierge's queue.
 */
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

interface EnquiryDetails {
  readonly householdSize?: number | undefined
  readonly staffProfileId?: string | undefined
  readonly preferredDates: readonly Date[]
  readonly durationMinutes: number
  readonly message?: string | undefined
  readonly referralCode?: string | undefined
}

/** The enquiry, written up for the concierge who will answer it. */
function describeEnquiry(details: EnquiryDetails): string {
  const lines: string[] = ['Requested through the public enquiry form.']

  if (details.householdSize !== undefined) {
    lines.push(`Household of ${String(details.householdSize)}.`)
  }

  lines.push(
    `Times offered: ${details.preferredDates
      .map((date) => date.toISOString())
      .join(', ')}.`
  )

  if (details.message !== undefined && details.message.length > 0) {
    lines.push(`Message: ${details.message}`)
  }

  if (details.referralCode !== undefined) {
    lines.push(`Referral code given: ${details.referralCode}`)
  }

  return clampProse(lines.join('\n'))
}

/**
 * Open the interview, or return the one this enquiry has already produced.
 *
 * The dedupe key is the household and the exact instant they asked for, among
 * interviews still `PENDING`. A double-submitted form — the second tap on a
 * slow connection — therefore produces one interview rather than two identical
 * rows in the concierge's morning queue.
 */
async function openConsultation(
  tx: Prisma.TransactionClient,
  clientProfileId: string,
  details: EnquiryDetails,
  scheduledFor: Date
): Promise<{ id: string; scheduledFor: Date; durationMinutes: number }> {
  const existing = await tx.consultationInterview.findFirst({
    where: { clientProfileId, scheduledFor, outcome: 'PENDING' },
    select: { id: true, scheduledFor: true, durationMinutes: true },
  })

  if (existing !== null) {
    return existing
  }

  // A chef asked for by name is honoured only if they are one we publish. An
  // unknown or hidden id resolves to `null` rather than to an error, so the
  // form cannot be used to test whether a given chef id is real.
  const namedChef =
    details.staffProfileId === undefined
      ? null
      : await tx.staffProfile.findFirst({
          where: { id: details.staffProfileId, isPubliclyListed: true },
          select: { id: true },
        })

  return tx.consultationInterview.create({
    data: {
      clientProfileId,
      staffProfileId: namedChef?.id ?? null,
      scheduledFor,
      durationMinutes: details.durationMinutes,
      outcome: 'PENDING',
      notes: describeEnquiry(details),
    },
    select: { id: true, scheduledFor: true, durationMinutes: true },
  })
}

/**
 * Record the enquiry, and the consent that came with it, on the household's
 * timeline.
 *
 * `consentToContact` is form-only — `consultationRequestSchema` says so — and
 * this is where the acceptance is actually kept. `externalRef` carries a
 * deterministic key so a replayed submission does not add a second line.
 */
async function logEnquiry(
  tx: Prisma.TransactionClient,
  clientProfileId: string,
  loggedById: string | null,
  subject: string,
  body: string,
  externalRef: string,
  occurredAt: Date
): Promise<void> {
  const key = externalRef.slice(0, 255)

  const existing = await tx.interactionLog.findFirst({
    where: { clientProfileId, externalRef: key },
    select: { id: true },
  })

  if (existing !== null) {
    return
  }

  await tx.interactionLog.create({
    data: {
      clientProfileId,
      loggedById,
      channel: 'IN_APP',
      direction: 'INBOUND',
      subject: subject.slice(0, 280),
      body: clampProse(body),
      occurredAt,
      externalRef: key,
    },
    select: { id: true },
  })
}

/**
 * Record the code the prospect typed, as **attribution and not as money**
 * (MCV-050).
 *
 * ## What used to be here, and why it kept being a finding
 *
 * `attachReferral`. It inserted a `ReferralRedemption`, which is money: the
 * settlement sweep credits the code's owner as soon as the named household has a
 * paid invoice clearing the programme's floor. Both callers are `auth: 'PUBLIC'`,
 * so an unauthenticated stranger reached it with nothing but an email address
 * they had typed.
 *
 * It was guarded twice, and both guards were the same mistake in different
 * clothes:
 *
 *  - It first took a bare `userId`, so nothing at the call site said whose
 *    account it was. A `CLIENT` could mint a code and post a *paying household's*
 *    address with it; the victim's own invoice qualified the redemption and the
 *    next sweep paid the attacker (MCV-040 finding A).
 *  - It was then narrowed to identities of kind `created` — accounts the same
 *    transaction had inserted. So the attacker named an address that **did not
 *    exist yet**. `resolveIdentity` created it, reported `created`, the guard was
 *    satisfied, and the money arrived when the real owner of that mailbox signed
 *    up through the ordinary magic link and paid.
 *
 * Both guards ask about **rows**. Neither asks the question that decides money,
 * which is whether the caller has **proved control of the mailbox**. Narrowing a
 * guard that asks the wrong question produces a narrower wrong answer.
 *
 * ## What happens instead
 *
 * The public path writes a string. `ClientProfile.claimedReferralCode` sits
 * beside `source` and `sourceDetail` — the other two columns recording where a
 * household says it came from — and carries no redemption, no ledger entry and no
 * movement of `ReferralCode.redemptionCount`. It becomes a `ReferralRedemption`
 * only in `settleAcceptedClaim`, called by `acceptReferralClaim` on behalf of
 * the **authenticated household** that owns the mailbox, through the one
 * canonical writer. `@/server/referral-claim` is where that is argued, including
 * what it does not buy.
 *
 * Settling automatically at the first sign-in — which is what this used to say —
 * was the MCV-052 finding. The server cannot tell the genuine prospect's
 * magic-link sign-in from the victim's, so an automatic settlement paid a
 * sprayer $50.00 off a victim's own organic sign-in and invoice. Consent is not
 * a stronger guess at which of them it was; it is the absence of a guess.
 *
 * ## There is no cap, expiry or owner check here, on purpose
 *
 * `attachReferral` carried all three. Every one of them is gone rather than
 * disabled, because a check whose outcome cannot change anything is the exact
 * shape MCV-040 finding B was: `attachReferral` compared `redemptionCount`
 * against `maxRedemptions` and then wrote the redemption **without moving the
 * counter**, so the comparison was against zero for every caller, for ever — and
 * it read as a cap for two audits. Nothing is written here that a cap could
 * bound, an expiry could stale, or an owner could be wronged by; the settlement
 * asks all three at the one moment their answers bind.
 *
 * ## Nothing about the outcome reaches the caller
 *
 * Unchanged, and for the unchanged reason. The claim is recorded silently
 * whatever the code turns out to be: telling a stranger which codes are live
 * would turn the enquiry form into a way to harvest them.
 *
 * ## Only for an account nobody has ever proved
 *
 * The identity, not a bare id, because a column on a `ClientProfile` belongs to
 * that `ClientProfile` and a call site must not be able to forget whose it is.
 * The rule at the head of this file — a public submission writes neither a row
 * nor a column of a household that was already ours — is enforced here by
 * {@link isUnprovedPlaceholder}: the write is admitted for an identity of kind
 * `created`, and for a `matched` identity **only** while `User.unclaimedSince`
 * is still stamped. That column means "opened by this very path for an address
 * nobody had proved", and `markMailboxProved` clears it at the first sign-in. So
 * a household that has ever authenticated — which includes every signed-in
 * caller, every real client and every member — is untouchable from here, exactly
 * as before. Their audited door is `redeemReferralCode`.
 *
 * ## Why `created` alone was not enough: the precedence finding
 *
 * `created` alone made the *first* public submission for an address the only one
 * that could ever write this column, because the second finds the
 * `ClientProfile` the first one opened and {@link resolveIdentity} reports
 * `matched` for ever after. That is first-writer-wins, and round three measured
 * what it costs: a sprayer posts `HARVEST24` at an address, the household later
 * types the `GENUINE24` their friend actually gave them, and the code they typed
 * is silently discarded. They are then shown a stranger's invitation and never
 * shown their own.
 *
 * Refreshing it is safe *now* and would not have been before, and the difference
 * is the whole of MCV-052: under the automatic settlement this column decided
 * who got paid, so whoever wrote it last won the money. Under consent it decides
 * only what the household is *offered*, and the household then accepts or
 * declines it — see `recordReferralClaim` in `@/server/referral-claim`. Neither
 * writer outranks the other because neither is ranked: a household shown a code
 * they do not recognise declines it, and a household whose own code was
 * overwritten by a later spray still has `redeemReferralCode`. What they cannot
 * have, and what first-writer-wins gave them, is no way to see their own code at
 * all.
 *
 * Do not reintroduce this refresh if this column is ever given authority again.
 * The two changes are only jointly safe.
 */
async function attachReferralClaim(
  tx: Prisma.TransactionClient,
  identity: ResolvedIdentity,
  code: string,
  now: Date
): Promise<void> {
  if (
    identity.kind !== 'created' &&
    !(await isUnprovedPlaceholder(tx, identity.userId))
  ) {
    return
  }

  await recordReferralClaim(tx, identity.clientProfileId, code, now)
}

/**
 * Is this `User` still a row the public path opened and no human has signed
 * into?
 *
 * Asked of the database rather than of {@link ResolvedIdentity}, because the
 * identity records what *this transaction* did and the question here is what has
 * ever happened to the row. `isActive` is carried along so a deactivated account
 * is not written to either; nothing on the public path should be editing one.
 */
async function isUnprovedPlaceholder(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<boolean> {
  const row = await tx.user.findFirst({
    where: { id: userId, isActive: true, unclaimedSince: { not: null } },
    select: { id: true },
  })

  return row !== null
}

/** The earliest of the times the prospect offered. */
function earliestDate(dates: readonly Date[]): Date {
  let earliest = dates[0]

  if (earliest === undefined) {
    // `consultationRequestSchema` enforces `min(1)`, so this is unreachable
    // through the parser. It is answered rather than asserted away, so the
    // function is total.
    return new Date()
  }

  for (const candidate of dates) {
    if (candidate.getTime() < earliest.getTime()) {
      earliest = candidate
    }
  }

  return earliest
}

/**
 * May this caller act for this household?
 *
 * The `ClientProfile` counterpart of the ownership guards in `@/server/guards`.
 * There is no `requireClientProfileOwnership` there because the session already
 * carries `clientProfileId`, so the comparison needs no second query — but the
 * *shape* is the same, including the `NOT_FOUND` denial that keeps the check
 * from becoming an oracle for which household ids are real.
 */
async function requireHouseholdAccess(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  clientProfileId: string
): Promise<ActionResult<{ id: string; status: ClientStatus }>> {
  const row = await tx.clientProfile.findUnique({
    where: { id: clientProfileId },
    select: { id: true, status: true },
  })

  if (row === null) {
    return fail('NOT_FOUND', 'We could not find that household.')
  }

  if (isStaff(user)) {
    return ok(row)
  }

  return user.clientProfileId !== null && user.clientProfileId === row.id
    ? ok(row)
    : fail('NOT_FOUND', 'We could not find that household.')
}

// =============================================================================
// 6. The public enquiry
// =============================================================================

/**
 * Ask for a consultation. No account required.
 *
 * Writes, in one transaction: the `User` and `ClientProfile` **only if they do
 * not already exist** — and if they did not, the `User` is marked
 * `unclaimedSince` — an `OnboardingFlow` moved to `CONSULTATION_SCHEDULED` when
 * the ladder permits it, a `ConsultationInterview` for the earliest time
 * offered, an `InteractionLog` recording the enquiry and the consent that came
 * with it, and — silently, on a profile this call opened — the referral code as
 * an *attribution string*.
 *
 * It writes **no `ReferralRedemption`**, which is the whole of MCV-050.
 * {@link attachReferralClaim} says why a public form may not, whatever it knows
 * about the account.
 *
 * See the note at the head of this file for why an anonymous caller receives no
 * row identifiers and why the reply does not vary with whether we already knew
 * the address.
 */
export const requestConsultation = withAction(
  {
    name: 'intake.consultation.request',
    auth: 'PUBLIC',
    input: consultationRequestSchema,
    rateLimit: PUBLIC_FORM_RATE_LIMIT,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ConsultationReceipt>> => {
    const now = new Date()
    const scheduledFor = earliestDate(input.preferredDates)
    const sessionUserId = ctx.user?.id ?? null

    const details: EnquiryDetails = {
      householdSize: input.householdSize,
      staffProfileId: input.staffProfileId,
      preferredDates: input.preferredDates,
      durationMinutes: input.durationMinutes,
      message: input.message,
      referralCode: input.referralCode,
    }

    const receipt = await ctx.db.$transaction(async (tx) => {
      const identity = await resolveIdentity(
        tx,
        sessionUserId,
        {
          fullName: input.fullName,
          email: input.email,
          phone: input.phone,
          preferredContactMethod: input.preferredContactMethod,
          source: input.source,
          sourceDetail: input.sourceDetail,
        },
        now
      )

      const consultation = await openConsultation(
        tx,
        identity.clientProfileId,
        details,
        scheduledFor
      )

      await advanceFlowTo(
        tx,
        identity.clientProfileId,
        'CONSULTATION_SCHEDULED',
        'Consultation requested from the public site.',
        now
      )

      await logEnquiry(
        tx,
        identity.clientProfileId,
        sessionUserId,
        'Consultation requested',
        `${describeEnquiry(details)}\nConsent to be contacted was given at ${now.toISOString()}.`,
        `consultation-request:${consultation.id}`,
        now
      )

      if (input.referralCode !== undefined) {
        // A string on this household's own file, and nothing else. No
        // redemption, no counter, no ledger — see {@link attachReferralClaim}
        // and `@/server/referral-claim`. The identity rather than the id,
        // because the column belongs to whoever the profile does.
        await attachReferralClaim(tx, identity, input.referralCode, now)
      }

      return consultation
    })

    return ok({
      received: true,
      consultationInterviewId: sessionUserId === null ? null : receipt.id,
      scheduledFor: receipt.scheduledFor,
      durationMinutes: receipt.durationMinutes,
    })
  }
)

/**
 * The whole questionnaire, answered by somebody who has not signed in.
 *
 * Identical identity handling to {@link requestConsultation}, plus the one rule
 * that is the reason this action is separate from {@link submitIntake}:
 *
 * **An anonymous submission never writes a `ClientIntakeForm` for a household
 * that was already ours.**
 *
 * ## The rule used to have a condition on it, and the condition was the bug
 *
 * It read: *never overwrites answers that are already on file* — implemented as
 * "if the resolved household has a form carrying a `submittedAt`, touch
 * nothing". Every word of that is about a household that has **already
 * answered**. A household that exists and has *not* answered — one the
 * concierge opened over the telephone, one {@link convertProspect} promoted —
 * has no `ClientIntakeForm` at all, fell straight past the condition, and had a
 * stranger's questionnaire written into it (MCV-040 finding D).
 *
 * That is the worse of the two cases, not the lesser one:
 *
 *  - `allergies` is a `string[]`, and a submission that names none writes an
 *    **empty allergen list** for a real household. The kitchen reads it before
 *    cooking, and an empty list is indistinguishable from a safe one.
 *  - `writeIntakeForm` stamps `submittedAt`. So from that moment the household
 *    *does* have a submitted form, the old condition finally engages, and every
 *    genuine submission the household later makes is swallowed by the duplicate
 *    branch. The stranger's answers become permanent by making the real ones
 *    unwriteable.
 *
 * So the test is now the caller's provenance rather than the row's state: an
 * anonymous caller whose identity {@link resolveIdentity} `matched` writes no
 * questionnaire, whether or not one exists. The enquiry is still logged, so the
 * concierge sees that somebody sent the form and can telephone — which is the
 * right response whether it was the household repeating itself or a stranger
 * typing their address.
 *
 * A *signed-in* caller is unaffected by that rule: their session proves the
 * household is theirs, so their questionnaire is written exactly as before, and
 * if they already have a submitted one they are told plainly to amend it in the
 * portal rather than being silently no-op'd.
 *
 * ## The anonymous receipt is a constant
 *
 * Every anonymous caller gets `{ received: true, …null ids…, submittedAt: now }`
 * regardless of which of the three branches ran. The ids were already withheld;
 * `submittedAt` is now withheld too, because returning the household's *real*
 * submission date to a stranger — or `null` where a new prospect would have seen
 * a timestamp — is the same oracle the null ids exist to close.
 */
export const submitProspectIntake = withAction(
  {
    name: 'intake.prospect.submit',
    auth: 'PUBLIC',
    input: prospectIntakeSchema,
    rateLimit: PUBLIC_FORM_RATE_LIMIT,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ProspectIntakeReceipt>> => {
    const now = new Date()
    const scheduledFor = earliestDate(input.contact.preferredDates)
    const sessionUserId = ctx.user?.id ?? null

    const details: EnquiryDetails = {
      householdSize: input.answers.householdSize,
      staffProfileId: input.contact.staffProfileId,
      preferredDates: input.contact.preferredDates,
      durationMinutes: input.contact.durationMinutes,
      message: input.contact.message,
      referralCode: input.contact.referralCode,
    }

    const outcome = await ctx.db.$transaction(async (tx) => {
      const identity = await resolveIdentity(
        tx,
        sessionUserId,
        {
          fullName: input.contact.fullName,
          email: input.contact.email,
          phone: input.contact.phone,
          preferredContactMethod: input.contact.preferredContactMethod,
          source: input.contact.source,
          sourceDetail: input.contact.sourceDetail,
        },
        now
      )

      const onFile = await tx.clientIntakeForm.findUnique({
        where: { clientProfileId: identity.clientProfileId },
        select: { id: true, submittedAt: true },
      })

      const consultation = await openConsultation(
        tx,
        identity.clientProfileId,
        details,
        scheduledFor
      )

      // Finding D, in one expression. Not `onFile === null`, not
      // `onFile.submittedAt === null` — the question is who is asking, and
      // whether this call is what brought the household into being.
      if (sessionUserId === null && identity.kind === 'matched') {
        await logEnquiry(
          tx,
          identity.clientProfileId,
          sessionUserId,
          'Questionnaire sent from the public site for a household we already hold',
          'A questionnaire arrived from the public form quoting the address of a household already on our books. Nothing on their file was written — the sender has not proved the address is theirs, and a public form may not answer for a household we already know. Please telephone to confirm who sent it.',
          `withheld-intake:${consultation.id}`,
          now
        )

        // Nothing of the matched household's leaves the transaction — not the
        // profile id, not the form id, not the date they really submitted.
        // The receipt below is a constant anyway, and a value that is never
        // read is a value that cannot later be returned by accident.
        return { kind: 'withheld' as const }
      }

      if (onFile !== null && onFile.submittedAt !== null) {
        await logEnquiry(
          tx,
          identity.clientProfileId,
          sessionUserId,
          'Questionnaire re-sent from the public site',
          'A questionnaire arrived from the public form for a household that already has one on file. Nothing was overwritten — please telephone to confirm who sent it.',
          `duplicate-intake:${consultation.id}`,
          now
        )

        return {
          kind: 'duplicate' as const,
          clientProfileId: identity.clientProfileId,
          intakeFormId: onFile.id,
          consultationInterviewId: consultation.id,
          submittedAt: onFile.submittedAt,
        }
      }

      const form = await writeIntakeForm(
        tx,
        identity.clientProfileId,
        input.answers,
        now
      )

      await advanceFlowTo(
        tx,
        identity.clientProfileId,
        'INTAKE_SUBMITTED',
        'Questionnaire completed on the public site.',
        now
      )

      await advanceFlowTo(
        tx,
        identity.clientProfileId,
        'CONSULTATION_SCHEDULED',
        'Consultation requested alongside the questionnaire.',
        now
      )

      await logEnquiry(
        tx,
        identity.clientProfileId,
        sessionUserId,
        'Questionnaire completed',
        `${describeEnquiry(details)}\nConsent to be contacted was given at ${now.toISOString()}.`,
        `prospect-intake:${form.id}:${consultation.id}`,
        now
      )

      if (input.contact.referralCode !== undefined) {
        // The identity, not the id — see {@link attachReferralClaim}. Reaching
        // this statement does not by itself mean the identity is new: a
        // signed-in caller writes their own questionnaire here and is
        // `matched`, and the refusal that keeps their referral on the audited
        // path lives inside the callee rather than in a condition somebody has
        // to remember.
        await attachReferralClaim(tx, identity, input.contact.referralCode, now)
      }

      return {
        kind: 'written' as const,
        clientProfileId: identity.clientProfileId,
        intakeFormId: form.id,
        consultationInterviewId: consultation.id,
        submittedAt: form.submittedAt,
      }
    })

    // One receipt for every anonymous caller, whichever branch ran, and it is
    // the same one a brand-new prospect gets. `submittedAt` is `now` rather
    // than the row's own value: a matched household's real submission date is
    // theirs, and a `null` where a new prospect would see a timestamp would
    // say "we know this address" just as loudly as an id would.
    if (sessionUserId === null) {
      return ok({
        received: true,
        intakeFormId: null,
        clientProfileId: null,
        consultationInterviewId: null,
        submittedAt: now,
      })
    }

    // Honest to somebody we can identify. `withheld` is unreachable here — it
    // is returned only when `sessionUserId` is `null`, which the branch above
    // has already answered — and the exhaustiveness check below is what says so
    // in a way the compiler will keep checking.
    if (outcome.kind === 'duplicate') {
      return fail(
        'CONFLICT',
        'We already have your questionnaire. Please sign in to amend it rather than sending a new one.'
      )
    }

    if (outcome.kind === 'written') {
      return ok({
        received: true,
        intakeFormId: outcome.intakeFormId,
        clientProfileId: outcome.clientProfileId,
        consultationInterviewId: outcome.consultationInterviewId,
        submittedAt: outcome.submittedAt,
      })
    }

    const exhaustive: 'withheld' = outcome.kind

    throw new ActionError(
      'INTERNAL',
      `A signed-in questionnaire produced an anonymous outcome (${exhaustive}).`
    )
  }
)

// =============================================================================
// 7. The signed-in questionnaire
// =============================================================================

/**
 * Submit or amend the questionnaire for a household that has an account.
 *
 * A `CLIENT` may act only for their own `ClientProfile`; `CHEF_STAFF` and above
 * may act for any, which is the concierge completing the form over the
 * telephone. `clientProfileId` arrives from the browser and is therefore
 * re-checked against the caller before a single column is written.
 *
 * `submittedAt` is stamped now unless a staff caller back-dated it — a client
 * cannot post one, because although `clientIntakeCreateSchema` carries the
 * field this action discards it for anybody below `CHEF_STAFF`. It never moves
 * back to `null`, so amending the form does not un-submit it.
 */
export const submitIntake = withAction(
  {
    name: 'intake.submit',
    auth: 'SESSION',
    input: clientIntakeCreateSchema,
    rateLimit: INTAKE_RATE_LIMIT,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<IntakeSubmissionView>> => {
    const now = new Date()
    const staffCaller = isStaff(ctx.user)

    const submittedAt =
      staffCaller && input.submittedAt !== undefined ? input.submittedAt : now

    const outcome = await ctx.db.$transaction(async (tx) => {
      const household = await requireHouseholdAccess(
        tx,
        ctx.user,
        input.clientProfileId
      )

      if (!household.ok) {
        return { kind: 'denied' as const, failure: household }
      }

      const form = await writeIntakeForm(
        tx,
        household.data.id,
        input,
        submittedAt
      )

      const stage = await advanceFlowTo(
        tx,
        household.data.id,
        'INTAKE_SUBMITTED',
        'Questionnaire completed.',
        now
      )

      const consultation = await tx.consultationInterview.findFirst({
        where: { clientProfileId: household.data.id },
        orderBy: { scheduledFor: 'desc' },
        select: { id: true },
      })

      const view: IntakeSubmissionView = {
        intakeFormId: form.id,
        clientProfileId: household.data.id,
        submittedAt: form.submittedAt,
        clientStatus: household.data.status,
        onboardingStage: stage,
        deliveryFrequency: form.deliveryFrequency,
        consultationInterviewId: consultation?.id ?? null,
      }

      return { kind: 'written' as const, view }
    })

    return outcome.kind === 'denied' ? outcome.failure : ok(outcome.view)
  }
)

// =============================================================================
// 8. Reading the submissions
// =============================================================================

/**
 * The concierge's queue of questionnaires.
 *
 * `CHEF_STAFF` and above only. A household reads its own form through
 * {@link getIntakeSubmission}, which goes through the ownership guard; there is
 * deliberately no client-facing *list*, because a list is where a forgotten
 * filter turns into every household's allergies.
 */
export const listIntakeSubmissions = withAction(
  {
    name: 'intake.list',
    auth: 'CHEF_STAFF',
    input: clientIntakeFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<IntakeListView>> => {
    const filters: Prisma.ClientIntakeFormWhereInput[] = []

    if (filter.deliveryFrequency !== undefined) {
      filters.push({ deliveryFrequency: filter.deliveryFrequency })
    }

    if (filter.isSubmitted !== undefined) {
      filters.push(
        filter.isSubmitted
          ? { submittedAt: { not: null } }
          : { submittedAt: null }
      )
    }

    if (filter.hasAllergies !== undefined) {
      filters.push({ allergies: { isEmpty: !filter.hasAllergies } })
    }

    if (filter.submittedFrom !== undefined) {
      filters.push({ submittedAt: { gte: filter.submittedFrom } })
    }

    if (filter.submittedUntil !== undefined) {
      filters.push({ submittedAt: { lte: filter.submittedUntil } })
    }

    const where: Prisma.ClientIntakeFormWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.clientIntakeForm.count({ where }),
      ctx.db.clientIntakeForm.findMany({
        where,
        select: INTAKE_FORM_SELECT,
        orderBy: [{ submittedAt: filter.sortDirection }, { id: 'asc' }],
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map(toIntakeFormView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

/**
 * One questionnaire.
 *
 * Ownership goes through `requireIntakeFormOwnership`, whose bypass defaults to
 * `CHEF_STAFF` — a chef who cannot read the allergies cannot cook safely — and
 * whose denial is `NOT_FOUND`, so the id of a form that is not the caller's is
 * indistinguishable from one that never existed.
 */
export const getIntakeSubmission = withAction(
  {
    name: 'intake.detail',
    auth: 'SESSION',
    input: intakeFormIdSchema,
  },
  async (ctx, input): Promise<ActionResult<IntakeFormView>> => {
    const owned = await requireIntakeFormOwnership(ctx.user, input.intakeFormId)

    if (!owned.ok) {
      return owned
    }

    const row = await ctx.db.clientIntakeForm.findUnique({
      where: { id: owned.data.id },
      select: INTAKE_FORM_SELECT,
    })

    if (row === null) {
      return fail('NOT_FOUND', 'We could not find that questionnaire.')
    }

    return ok(toIntakeFormView(row))
  }
)

// =============================================================================
// 9. Interviews
// =============================================================================

/**
 * Put an interview in the diary.
 *
 * Staff-only, and both foreign keys the payload carries are confirmed to exist
 * before the row is written — a violation from inside Prisma would otherwise
 * surface as a bare `CONFLICT` with nothing useful attached to it.
 */
export const scheduleConsultation = withAction(
  {
    name: 'intake.consultation.schedule',
    auth: 'CHEF_STAFF',
    input: consultationInterviewCreateSchema,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ConsultationView>> => {
    const now = new Date()

    const outcome = await ctx.db.$transaction(async (tx) => {
      const household = await tx.clientProfile.findUnique({
        where: { id: input.clientProfileId },
        select: { id: true },
      })

      if (household === null) {
        return { kind: 'noHousehold' as const }
      }

      if (input.staffProfileId !== undefined) {
        const chef = await tx.staffProfile.findUnique({
          where: { id: input.staffProfileId },
          select: { id: true },
        })

        if (chef === null) {
          return { kind: 'noChef' as const }
        }
      }

      if (input.conductedById !== undefined) {
        const interviewer = await tx.user.findUnique({
          where: { id: input.conductedById },
          select: { id: true },
        })

        if (interviewer === null) {
          return { kind: 'noInterviewer' as const }
        }
      }

      const created = await tx.consultationInterview.create({
        data: {
          clientProfileId: household.id,
          // The interviewer is the session unless the payload names somebody
          // else — a concierge booking an interview for a colleague to run.
          conductedById: input.conductedById ?? ctx.user.id,
          staffProfileId: input.staffProfileId ?? null,
          scheduledFor: input.scheduledFor,
          durationMinutes: input.durationMinutes,
          location: input.location ?? null,
          meetingUrl: input.meetingUrl ?? null,
          startedAt: input.startedAt ?? null,
          completedAt: input.completedAt ?? null,
          compatibilityScore: input.compatibilityScore ?? null,
          notes: input.notes ?? null,
          chefSummary: input.chefSummary ?? null,
          outcome: input.outcome,
          followUpAt: input.followUpAt ?? null,
          convertedToClientAt: input.convertedToClientAt ?? null,
        },
        select: CONSULTATION_SELECT,
      })

      await advanceFlowTo(
        tx,
        household.id,
        'CONSULTATION_SCHEDULED',
        'Consultation booked by the concierge.',
        now
      )

      return { kind: 'created' as const, row: created }
    })

    switch (outcome.kind) {
      case 'created':
        return ok(toConsultationView(outcome.row, true))

      case 'noHousehold':
        return fail('NOT_FOUND', 'We could not find that household.')

      case 'noChef':
        return fail('NOT_FOUND', 'We could not find that chef.')

      case 'noInterviewer':
        return fail('NOT_FOUND', 'We could not find that colleague.')

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

/**
 * Write up an interview — the notes, the summary, the outcome, the follow-up.
 *
 * Every field is optional and only the ones present are written.
 * `consultationInterviewUpdateSchema` goes through `buildUpdateSchema`, which
 * strips the `.default(...)`s *before* making the shape partial, so typing up
 * notes cannot reset a `CONVERTED` outcome to `PENDING`. The conditional
 * spreads below carry that property all the way to the column: under
 * `exactOptionalPropertyTypes`, handing Prisma an explicit `undefined` is not
 * even expressible.
 */
export const recordConsultationNotes = withAction(
  {
    name: 'intake.consultation.record',
    auth: 'CHEF_STAFF',
    input: consultationInterviewUpdateSchema,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ConsultationView>> => {
    const outcome = await ctx.db.$transaction(async (tx) => {
      const existing = await tx.consultationInterview.findUnique({
        where: { id: input.consultationInterviewId },
        select: { id: true },
      })

      if (existing === null) {
        return { kind: 'notFound' as const }
      }

      if (input.staffProfileId !== undefined) {
        const chef = await tx.staffProfile.findUnique({
          where: { id: input.staffProfileId },
          select: { id: true },
        })

        if (chef === null) {
          return { kind: 'noChef' as const }
        }
      }

      if (input.conductedById !== undefined) {
        const interviewer = await tx.user.findUnique({
          where: { id: input.conductedById },
          select: { id: true },
        })

        if (interviewer === null) {
          return { kind: 'noInterviewer' as const }
        }
      }

      const updated = await tx.consultationInterview.update({
        where: { id: existing.id },
        data: {
          ...(input.conductedById === undefined
            ? {}
            : { conductedById: input.conductedById }),
          ...(input.staffProfileId === undefined
            ? {}
            : { staffProfileId: input.staffProfileId }),
          ...(input.scheduledFor === undefined
            ? {}
            : { scheduledFor: input.scheduledFor }),
          ...(input.durationMinutes === undefined
            ? {}
            : { durationMinutes: input.durationMinutes }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.meetingUrl === undefined
            ? {}
            : { meetingUrl: input.meetingUrl }),
          ...(input.startedAt === undefined
            ? {}
            : { startedAt: input.startedAt }),
          ...(input.completedAt === undefined
            ? {}
            : { completedAt: input.completedAt }),
          ...(input.compatibilityScore === undefined
            ? {}
            : { compatibilityScore: input.compatibilityScore }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.chefSummary === undefined
            ? {}
            : { chefSummary: input.chefSummary }),
          ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
          ...(input.followUpAt === undefined
            ? {}
            : { followUpAt: input.followUpAt }),
          ...(input.convertedToClientAt === undefined
            ? {}
            : { convertedToClientAt: input.convertedToClientAt }),
        },
        select: CONSULTATION_SELECT,
      })

      if (updated.completedAt !== null) {
        await advanceFlowTo(
          tx,
          updated.clientProfileId,
          'CONSULTATION_COMPLETED',
          'Consultation written up.',
          updated.completedAt
        )
      }

      return { kind: 'updated' as const, row: updated }
    })

    switch (outcome.kind) {
      case 'updated':
        return ok(toConsultationView(outcome.row, true))

      case 'notFound':
        return fail('NOT_FOUND', 'We could not find that consultation.')

      case 'noChef':
        return fail('NOT_FOUND', 'We could not find that chef.')

      case 'noInterviewer':
        return fail('NOT_FOUND', 'We could not find that colleague.')

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)

/**
 * The consultation calendar.
 *
 * A caller below `CHEF_STAFF` has `clientProfileId` pinned to their own
 * household whatever the filter asked for, and receives interviews with the
 * kitchen's columns removed by {@link toConsultationView}. A signed-in caller
 * with no household at all sees an empty page rather than everybody's diary.
 */
export const listConsultations = withAction(
  {
    name: 'intake.consultation.list',
    auth: 'SESSION',
    input: consultationInterviewFilterSchema,
  },
  async (ctx, filter): Promise<ActionResult<ConsultationListView>> => {
    const staffCaller = isStaff(ctx.user)
    const filters: Prisma.ConsultationInterviewWhereInput[] = []

    if (staffCaller) {
      if (filter.clientProfileId !== undefined) {
        filters.push({ clientProfileId: filter.clientProfileId })
      }

      if (filter.conductedById !== undefined) {
        filters.push({ conductedById: filter.conductedById })
      }

      if (filter.minCompatibilityScore !== undefined) {
        filters.push({
          compatibilityScore: { gte: filter.minCompatibilityScore },
        })
      }
    } else {
      const ownProfileId = ctx.user.clientProfileId

      // A signed-in caller with no household sees an empty page rather than
      // an unscoped query.
      if (ownProfileId === null) {
        return ok({
          items: [],
          meta: buildPageMeta(filter.page, filter.pageSize, 0),
        })
      }

      // Pinned, not merged: an explicit `clientProfileId` from the browser is
      // discarded rather than combined with the caller's own.
      filters.push({ clientProfileId: ownProfileId })
    }

    if (filter.staffProfileId !== undefined) {
      filters.push({ staffProfileId: filter.staffProfileId })
    }

    if (filter.outcome !== undefined) {
      filters.push({ outcome: filter.outcome })
    }

    if (filter.scheduledFrom !== undefined) {
      filters.push({ scheduledFor: { gte: filter.scheduledFrom } })
    }

    if (filter.scheduledUntil !== undefined) {
      filters.push({ scheduledFor: { lte: filter.scheduledUntil } })
    }

    const where: Prisma.ConsultationInterviewWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)

    const [total, rows] = await ctx.db.$transaction([
      ctx.db.consultationInterview.count({ where }),
      ctx.db.consultationInterview.findMany({
        where,
        select: CONSULTATION_SELECT,
        orderBy: [{ scheduledFor: filter.sortDirection }, { id: 'asc' }],
        skip,
        take,
      }),
    ])

    return ok({
      items: rows.map((row) => toConsultationView(row, staffCaller)),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

// =============================================================================
// 10. Compatibility scoring
// =============================================================================

/** The house budget band, in cents: $25 to $250 a head is where we cook best. */
const BUDGET_FLOOR_CENTS = 2_500
const BUDGET_CEILING_CENTS = 25_000

/** Households of two to eight are the size an in-home service is designed for. */
const IDEAL_HOUSEHOLD_MIN = 2
const IDEAL_HOUSEHOLD_MAX = 8

/**
 * How complete the questionnaire is. Thirty points, six answers.
 *
 * Completeness is the single most predictive signal we have: a household that
 * troubled to list their equipment and their dislikes is a household that will
 * be at home when the chef arrives.
 */
function scoreCompleteness(form: IntakeFormRow | null): ScoreComponent {
  const available = 30

  if (form === null) {
    return {
      label: 'Questionnaire',
      awarded: 0,
      available,
      reason: 'No questionnaire has been completed yet.',
    }
  }

  const answered = [
    form.allergies.length > 0 || form.dislikes.length > 0,
    form.cuisinePreferences.length > 0,
    form.kitchenEquipment.length > 0,
    form.favouriteDishes.length > 0,
    form.serviceCity !== null,
    form.notes !== null && form.notes.length > 0,
  ].filter(Boolean).length

  return {
    label: 'Questionnaire',
    awarded: Math.round((answered / 6) * available),
    available,
    reason: `${String(answered)} of six sections answered in detail.`,
  }
}

/** Twenty-five points for a budget inside the band we cook well within. */
function scoreBudget(form: IntakeFormRow | null): ScoreComponent {
  const available = 25

  if (form === null || form.budgetPerMealCents === null) {
    return {
      label: 'Budget',
      awarded: Math.round(available / 2),
      available,
      reason: 'No budget given — scored neutrally.',
    }
  }

  const budget = form.budgetPerMealCents

  if (budget > BUDGET_CEILING_CENTS) {
    return {
      label: 'Budget',
      awarded: available,
      available,
      reason: 'Above our usual range — a bespoke engagement.',
    }
  }

  if (budget >= BUDGET_FLOOR_CENTS) {
    return {
      label: 'Budget',
      awarded: available,
      available,
      reason: 'Comfortably inside the range we cook within.',
    }
  }

  // Below the floor: awarded in proportion to how close they are to it.
  return {
    label: 'Budget',
    awarded: Math.round((budget / BUDGET_FLOOR_CENTS) * available),
    available,
    reason: 'Below the range an in-home service is priced at.',
  }
}

/** Fifteen points for cadence. A weekly household is the business. */
function scoreCadence(form: IntakeFormRow | null): ScoreComponent {
  const available = 15

  if (form === null) {
    return {
      label: 'Cadence',
      awarded: 0,
      available,
      reason: 'No cadence chosen yet.',
    }
  }

  // Written out key by key so a new `DeliveryFrequency` is a compile error
  // rather than a silent zero.
  const awardedByFrequency: Record<DeliveryFrequency, number> = {
    WEEKLY: 15,
    BIWEEKLY: 12,
    MONTHLY: 8,
    ON_DEMAND: 4,
  }

  return {
    label: 'Cadence',
    awarded: awardedByFrequency[form.deliveryFrequency],
    available,
    reason: `Asked for ${form.deliveryFrequency.toLowerCase().replace(/_/g, ' ')} service.`,
  }
}

/** Ten points for a table the service is designed around. */
function scoreHousehold(form: IntakeFormRow | null): ScoreComponent {
  const available = 10

  if (form === null) {
    return {
      label: 'Household',
      awarded: 0,
      available,
      reason: 'Household size unknown.',
    }
  }

  const size = form.householdSize

  if (size >= IDEAL_HOUSEHOLD_MIN && size <= IDEAL_HOUSEHOLD_MAX) {
    return {
      label: 'Household',
      awarded: available,
      available,
      reason: `A table of ${String(size)}.`,
    }
  }

  return {
    label: 'Household',
    awarded: Math.round(available / 2),
    available,
    reason:
      size < IDEAL_HOUSEHOLD_MIN
        ? 'A single cover — workable, but not where the service is strongest.'
        : 'Larger than a private dinner — closer to a private event.',
  }
}

/** Ten points for how much of a conversation there has been so far. */
function scoreRelationship(
  interactionCount: number,
  completedConsultations: number
): ScoreComponent {
  const available = 10
  const fromInteractions = Math.min(6, interactionCount * 2)
  const fromConsultations = Math.min(4, completedConsultations * 4)

  return {
    label: 'Conversation',
    awarded: fromInteractions + fromConsultations,
    available,
    reason: `${String(interactionCount)} exchanges logged, ${String(completedConsultations)} consultations completed.`,
  }
}

interface ChefForScoring {
  readonly specialties: string[]
  readonly baseCity: string | null
  readonly isAcceptingClients: boolean
}

/** Ten points for the fit with a named chef, or a neutral five for the house. */
function scoreChefAlignment(
  form: IntakeFormRow | null,
  chef: ChefForScoring | null
): ScoreComponent {
  const available = 10

  if (chef === null) {
    return {
      label: 'Chef',
      awarded: Math.round(available / 2),
      available,
      reason: 'Scored against the house rather than a named chef.',
    }
  }

  if (!chef.isAcceptingClients) {
    return {
      label: 'Chef',
      awarded: 0,
      available,
      reason: 'That chef is not taking new households.',
    }
  }

  const wanted = new Set(
    (form === null ? [] : form.cuisinePreferences).map((entry) =>
      entry.toLocaleLowerCase()
    )
  )

  const shared = chef.specialties.filter((specialty) =>
    wanted.has(specialty.toLocaleLowerCase())
  ).length

  const cuisinePoints = wanted.size === 0 ? 3 : Math.min(6, shared * 3)

  const serviceCity = form === null ? null : form.serviceCity
  const chefCity = chef.baseCity

  const cityPoints =
    serviceCity !== null &&
    chefCity !== null &&
    serviceCity.toLocaleLowerCase() === chefCity.toLocaleLowerCase()
      ? 4
      : 0

  return {
    label: 'Chef',
    awarded: cuisinePoints + cityPoints,
    available,
    reason:
      shared > 0
        ? `${String(shared)} shared cuisines${cityPoints > 0 ? ', and the same city' : ''}.`
        : 'No overlap recorded between their tastes and this chef.',
  }
}

/**
 * Score a household's fit from their own answers rather than from a form field.
 *
 * The rubric is six components summing to a hundred, evaluated over the
 * household's questionnaire, their history with us, and — when one is named —
 * the chef being considered. It is deterministic: the same rows produce the
 * same number, which is what makes a score comparable across a board.
 *
 * The result is written to `ConsultationInterview.compatibilityScore` and the
 * itemised breakdown is returned so a concierge can see the arithmetic. A
 * household never sees either: {@link toConsultationView} withholds the score
 * from anybody below `CHEF_STAFF`, and this action is `CHEF_STAFF` to begin
 * with.
 */
export const scoreConsultationCompatibility = withAction(
  {
    name: 'intake.consultation.score',
    auth: 'CHEF_STAFF',
    input: consultationScoreSchema,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<CompatibilityBreakdown>> => {
    const consultation = await ctx.db.consultationInterview.findUnique({
      where: { id: input.consultationInterviewId },
      select: { id: true, clientProfileId: true, staffProfileId: true },
    })

    if (consultation === null) {
      return fail('NOT_FOUND', 'We could not find that consultation.')
    }

    const chefId = input.staffProfileId ?? consultation.staffProfileId

    const [form, interactionCount, completedConsultations, chef] =
      await Promise.all([
        ctx.db.clientIntakeForm.findUnique({
          where: { clientProfileId: consultation.clientProfileId },
          select: INTAKE_FORM_SELECT,
        }),
        ctx.db.interactionLog.count({
          where: { clientProfileId: consultation.clientProfileId },
        }),
        ctx.db.consultationInterview.count({
          where: {
            clientProfileId: consultation.clientProfileId,
            completedAt: { not: null },
          },
        }),
        chefId === null
          ? Promise.resolve(null)
          : ctx.db.staffProfile.findUnique({
              where: { id: chefId },
              select: {
                specialties: true,
                baseCity: true,
                isAcceptingClients: true,
              },
            }),
      ])

    const components: ScoreComponent[] = [
      scoreCompleteness(form),
      scoreBudget(form),
      scoreCadence(form),
      scoreHousehold(form),
      scoreRelationship(interactionCount, completedConsultations),
      scoreChefAlignment(form, chef),
    ]

    const raw = components.reduce(
      (total, component) => total + component.awarded,
      0
    )

    // `percentSchema` bounds the column at 0–100 and so does this. The weights
    // already sum to a hundred; the clamp keeps a future weight change from
    // writing a value the schema would refuse to read back.
    const score = Math.max(0, Math.min(100, Math.round(raw)))

    await ctx.db.consultationInterview.update({
      where: { id: consultation.id },
      data: { compatibilityScore: score },
      select: { id: true },
    })

    return ok({
      consultationInterviewId: consultation.id,
      score,
      components,
    })
  }
)

// =============================================================================
// 11. Conversion
// =============================================================================

/**
 * Turn a prospect into a client, in one press.
 *
 * ## Idempotent
 *
 * The board's conversion button is the most double-clicked control in the OS.
 * The transaction therefore re-reads the household's status *inside itself* and
 * returns `alreadyConverted: true` without writing when the household is
 * already where the payload asks for it to be — same response, no second note
 * on the timeline, no second `convertedToClientAt`.
 *
 * ## Transactional
 *
 * Four effects commit together or not at all: the household's `status`, the
 * consultation's outcome and conversion stamp, the onboarding flow's stage, and
 * the note recording why. A half-converted household — qualified on the
 * pipeline but still `INVITED` on the ladder — is exactly the state this shape
 * exists to make impossible.
 *
 * ## Checked, not trusted
 *
 * `prospectConversionSchema` already refuses every status but `LEAD_QUALIFIED`
 * and `ACTIVE_SUBSCRIBER`, refuses an outcome other than `CONVERTED` or
 * `FOLLOW_UP_REQUIRED`, and requires a follow-up date when one is owed. What it
 * cannot know is whether the consultation named actually belongs to the
 * household named — a payload can pair any two cuids — so that is re-checked
 * here before either row is touched.
 */
export const convertProspect = withAction(
  {
    name: 'intake.prospect.convert',
    auth: 'ADMIN',
    input: prospectConversionSchema,
    revalidatePaths: INTAKE_PATHS,
    revalidateTags: INTAKE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<ProspectConversionView>> => {
    const now = new Date()
    const convertedAt = input.convertedAt ?? now

    const outcome = await ctx.db.$transaction(async (tx) => {
      const household = await tx.clientProfile.findUnique({
        where: { id: input.clientProfileId },
        select: { id: true, status: true },
      })

      if (household === null) {
        return { kind: 'noHousehold' as const }
      }

      let consultationId: string | null = null
      let consultationSettled = false

      if (input.consultationInterviewId !== undefined) {
        const consultation = await tx.consultationInterview.findUnique({
          where: { id: input.consultationInterviewId },
          select: {
            id: true,
            clientProfileId: true,
            outcome: true,
            convertedToClientAt: true,
          },
        })

        if (consultation === null) {
          return { kind: 'noConsultation' as const }
        }

        // A cuid from a browser is a claim. This consultation must belong to
        // this household, or the conversion would close somebody else's
        // interview and stamp it with this household's outcome.
        if (consultation.clientProfileId !== household.id) {
          return { kind: 'consultationMismatch' as const }
        }

        consultationId = consultation.id
        consultationSettled =
          consultation.outcome === input.outcome &&
          (input.outcome !== 'CONVERTED' ||
            consultation.convertedToClientAt !== null)
      }

      const flow = await tx.onboardingFlow.findUnique({
        where: { clientProfileId: household.id },
        select: { currentStage: true },
      })

      const stageSettled =
        input.advanceOnboardingTo === undefined ||
        flow?.currentStage === input.advanceOnboardingTo

      if (
        household.status === input.status &&
        (consultationId === null || consultationSettled) &&
        stageSettled
      ) {
        return {
          kind: 'unchanged' as const,
          clientProfileId: household.id,
          status: household.status,
          stage: flow?.currentStage ?? 'INVITED',
          consultationInterviewId: consultationId,
        }
      }

      await tx.clientProfile.update({
        where: { id: household.id },
        data: {
          status: input.status,
          lastContactedAt: convertedAt,
          ...(input.followUpAt === undefined
            ? {}
            : { followUpAt: input.followUpAt }),
          // Winning a household clears the churn bookkeeping: a `churnedAt`
          // left behind on an active subscriber corrupts every churn figure
          // `crm.ts` reports.
          ...(input.status === 'ACTIVE_SUBSCRIBER'
            ? { churnedAt: null, churnReason: null }
            : {}),
        },
        select: { id: true },
      })

      if (consultationId !== null) {
        await tx.consultationInterview.update({
          where: { id: consultationId },
          data: {
            outcome: input.outcome,
            conductedById: ctx.user.id,
            ...(input.outcome === 'CONVERTED'
              ? { convertedToClientAt: convertedAt }
              : {}),
            ...(input.followUpAt === undefined
              ? {}
              : { followUpAt: input.followUpAt }),
            ...(input.compatibilityScore === undefined
              ? {}
              : { compatibilityScore: input.compatibilityScore }),
            ...(input.chefSummary === undefined
              ? {}
              : { chefSummary: input.chefSummary }),
          },
          select: { id: true },
        })
      }

      const stage =
        input.advanceOnboardingTo === undefined
          ? (flow?.currentStage ?? 'INVITED')
          : await advanceFlowTo(
              tx,
              household.id,
              input.advanceOnboardingTo,
              input.notes ?? 'Converted from the pipeline.',
              convertedAt
            )

      await tx.clientNote.create({
        data: {
          clientProfileId: household.id,
          authorId: ctx.user.id,
          body: clampProse(
            input.notes ??
              `Converted to ${input.status.toLowerCase().replace(/_/g, ' ')}.`
          ),
          // Staff-visible, not client-visible: the reason a household was
          // qualified is a note about them, not a note for them.
          visibility: 'STAFF',
          pinned: false,
        },
        select: { id: true },
      })

      return {
        kind: 'converted' as const,
        clientProfileId: household.id,
        status: input.status,
        stage,
        consultationInterviewId: consultationId,
      }
    })

    switch (outcome.kind) {
      case 'converted':
        return ok({
          clientProfileId: outcome.clientProfileId,
          status: outcome.status,
          onboardingStage: outcome.stage,
          consultationInterviewId: outcome.consultationInterviewId,
          convertedAt,
          alreadyConverted: false,
        })

      case 'unchanged':
        return ok({
          clientProfileId: outcome.clientProfileId,
          status: outcome.status,
          onboardingStage: outcome.stage,
          consultationInterviewId: outcome.consultationInterviewId,
          convertedAt: null,
          alreadyConverted: true,
        })

      case 'noHousehold':
        return fail('NOT_FOUND', 'We could not find that household.')

      case 'noConsultation':
        return fail('NOT_FOUND', 'We could not find that consultation.')

      case 'consultationMismatch':
        return fail(
          'CONFLICT',
          'That consultation belongs to a different household.',
          {
            consultationInterviewId: [
              'This consultation is not the one arranged for this household.',
            ],
          }
        )

      default: {
        const exhaustive: never = outcome
        return exhaustive
      }
    }
  }
)
