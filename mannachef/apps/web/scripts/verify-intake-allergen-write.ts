// mannachef/apps/web/scripts/verify-intake-allergen-write.ts

/**
 * The MCV-040 finding D regression: an anonymous questionnaire may not be
 * written against a household we already hold — including one that has never
 * answered.
 *
 * ```bash
 * createdb mannachef_harness
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/db exec prisma db push
 * DATABASE_URL='postgresql://…/mannachef_harness' \
 *   pnpm --filter=@mannachef/web verify:intake-allergens
 * ```
 *
 * Exits non-zero on the first failed assertion. **Every table it touches is
 * emptied on each scenario**, so it refuses to start unless the database name
 * looks disposable.
 *
 * ## The defect
 *
 * `submitProspectIntake` guarded the write like this:
 *
 * ```ts
 * if (onFile !== null && onFile.submittedAt !== null) { …log a duplicate, return… }
 * ```
 *
 * Every word of that condition is about a household that has **already
 * answered**. A household that exists and has not — one the concierge opened
 * over the telephone, one `convertProspect` promoted out of the pipeline — has
 * no `ClientIntakeForm` at all. `onFile` is `null`, the guard does not engage,
 * and execution falls through to `writeIntakeForm`, which upserts the whole
 * questionnaire and stamps `submittedAt`.
 *
 * So an anonymous caller who knows nothing but the address could:
 *
 *  1. write `allergies: []` for a real household — and an empty allergen list
 *     is not "no information", it is the list a chef reads before cooking, and
 *     it is indistinguishable from a household that genuinely has no allergies;
 *  2. **make it permanent**, because the write stamps `submittedAt`, which is
 *     exactly the condition the guard above tests. From that moment the
 *     household does have a submitted form, so every later submission by the
 *     *actual* household is swallowed by the duplicate branch. The stranger's
 *     answers become unwriteable-over by the people they are about.
 *
 * ## The fix
 *
 * The test is now the caller's provenance rather than the row's state. An
 * anonymous caller whose identity `resolveIdentity` reports as `matched` writes
 * nothing to `ClientIntakeForm`, whether or not one exists. The headline
 * promise at the head of `actions/intake.ts` — *a public submission never
 * writes to an existing household's record* — is therefore unconditional,
 * which is what it always claimed to be.
 *
 * A genuine household is not locked out; it is moved to a door that proves who
 * it is. Scenario 4 walks that door.
 *
 * ## The six scenarios
 *
 * | # | Shape                                            | Proves                              |
 * | - | ------------------------------------------------ | ----------------------------------- |
 * | 1 | pre-fix source, unanswered household             | empty allergen list, then locked in  |
 * | 2 | shipped action, unanswered household             | nothing written at all               |
 * | 3 | shipped action, household that HAS answered      | the original rule still holds        |
 * | 4 | the real household signs in and submits          | no legitimate household is shut out  |
 * | 5 | shipped action, an unknown address               | the public form still works, and the |
 * |   |                                                  | legacy transcription still matches   |
 * | 6 | the anonymous receipt, known vs unknown address  | the form is not an oracle            |
 */

import assert from 'node:assert/strict'

import { submitIntake, submitProspectIntake } from '@/server/actions/intake'
import type { ActionResult } from '@/server/actions/types'
import { prisma } from '@/server/db'

import { legacyProspectIntake } from './fixtures/intake-legacy'
import { signInAs } from './fixtures/harness-state'
import {
  ANSWERED,
  UNANSWERED,
  assertDisposableDatabase,
  accountSnapshot,
  check,
  checkCount,
  clearRateLimits,
  consultationCountOf,
  disconnect,
  intakeSnapshot,
  interactionSubjectsOf,
  note,
  onboardingStageOf,
  printTable,
  prospectPayload,
  questionnaireAnswers,
  resetDatabase,
  section,
  seedHousehold,
  type IntakeSnapshot,
} from './fixtures/intake-harness'

// =============================================================================
// 1. The cast's own words
// =============================================================================

/** What the unanswered household would have told us, had anybody asked them. */
const TRUE_ALLERGIES = ['peanuts', 'shellfish'] as const

/** What the household that already answered has on file. Seeded, not written here. */
const ON_FILE_ALLERGIES = ['sesame'] as const

const UNANSWERED_EMAIL = UNANSWERED.email ?? ''
const ANSWERED_EMAIL = ANSWERED.email ?? ''
const UNANSWERED_PROFILE = UNANSWERED.clientProfileId ?? ''
const ANSWERED_PROFILE = ANSWERED.clientProfileId ?? ''

const NEWCOMER_EMAIL = 'sylvia.marchetti@example.org'

// =============================================================================
// 2. Staging
// =============================================================================

/**
 * Two real households and no referral programme.
 *
 * `UNANSWERED` is `LEAD_QUALIFIED` with **no** `ClientIntakeForm`: the state a
 * concierge-created household sits in before the questionnaire comes back, and
 * the state `convertProspect` leaves one in. `ANSWERED` has a submitted form,
 * so the rule the old condition *did* cover is still under test.
 */
async function stage(): Promise<void> {
  await resetDatabase()

  await seedHousehold({ person: UNANSWERED, status: 'LEAD_QUALIFIED' })
  await seedHousehold({
    person: ANSWERED,
    status: 'ACTIVE_SUBSCRIBER',
    allergies: ON_FILE_ALLERGIES,
  })

  clearRateLimits()
}

function codeOf(result: ActionResult<unknown>): string {
  return result.ok ? 'ok' : result.code
}

function describeIntake(snapshot: IntakeSnapshot | null): string {
  if (snapshot === null) {
    return 'no questionnaire on file'
  }

  const allergies =
    snapshot.allergies.length === 0
      ? 'EMPTY allergen list'
      : `allergies [${snapshot.allergies.join(', ')}]`

  return `${allergies}, submittedAt ${snapshot.submittedAt === null ? 'null' : 'set'}`
}

// =============================================================================
// 3. Scenario 1 — the pre-fix source against a household that never answered
// =============================================================================

interface AllergenOutcome {
  readonly written: boolean
  readonly allergies: readonly string[]
  readonly submitted: boolean
  /** Whether the household could still put its own answers in afterwards. */
  readonly householdCanStillAnswer: boolean
}

async function scenarioLegacy(): Promise<AllergenOutcome> {
  section('1. the pre-fix source against a household that never answered')

  await stage()

  const before = await intakeSnapshot(UNANSWERED_PROFILE)

  check('the household starts with no questionnaire at all', () => {
    assert.equal(before, null)
  })

  // A stranger, signed out, quoting the household's address. No allergies given.
  const first = await legacyProspectIntake(
    {
      sessionUserId: null,
      fullName: 'M. Quist',
      email: UNANSWERED_EMAIL,
      preferredContactMethod: 'EMAIL',
      source: 'DIRECT',
    },
    questionnaireAnswers({})
  )

  const afterStranger = await intakeSnapshot(UNANSWERED_PROFILE)

  check('the branch does not engage — the answers are written', () => {
    assert.equal(first.outcome, 'written')
    assert.notEqual(afterStranger, null)
  })

  check(
    'the kitchen now reads an EMPTY allergen list for a real household',
    () => {
      assert.deepEqual(afterStranger?.allergies, [])
    }
  )

  check('and submittedAt has been stamped', () => {
    assert.notEqual(afterStranger?.submittedAt ?? null, null)
  })

  // Now the household itself sends the form in, with its real allergies.
  const second = await legacyProspectIntake(
    {
      sessionUserId: null,
      fullName: UNANSWERED.name ?? '',
      email: UNANSWERED_EMAIL,
      preferredContactMethod: 'EMAIL',
      source: 'DIRECT',
    },
    questionnaireAnswers({ allergies: TRUE_ALLERGIES })
  )

  const afterHousehold = await intakeSnapshot(UNANSWERED_PROFILE)

  check(
    'the household’s own submission is now swallowed as a duplicate',
    () => {
      assert.equal(second.outcome, 'duplicate')
    }
  )

  check('their real allergies never reach the row', () => {
    assert.deepEqual(afterHousehold?.allergies, [])
  })

  note(`outcome: ${describeIntake(afterHousehold)}`)
  note(
    'the stranger’s answers became permanent by making the household’s unwriteable.'
  )

  return {
    written: afterStranger !== null,
    allergies: afterHousehold?.allergies ?? [],
    submitted: (afterHousehold?.submittedAt ?? null) !== null,
    householdCanStillAnswer: second.outcome !== 'duplicate',
  }
}

// =============================================================================
// 4. Scenario 2 — the shipped action against the same household
// =============================================================================

async function scenarioFixed(): Promise<AllergenOutcome> {
  section('2. the shipped submitProspectIntake against the same household')

  await stage()

  const accountBefore = await accountSnapshot(UNANSWERED.id)

  const posted = await submitProspectIntake(
    prospectPayload({ email: UNANSWERED_EMAIL })
  )

  const onFile = await intakeSnapshot(UNANSWERED_PROFILE)
  const accountAfter = await accountSnapshot(UNANSWERED.id)
  const stage_ = await onboardingStageOf(UNANSWERED_PROFILE)
  const consultations = await consultationCountOf(UNANSWERED_PROFILE)
  const timeline = await interactionSubjectsOf(UNANSWERED_PROFILE)

  check('the submission is accepted, so the form is not an oracle', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('NO questionnaire is written — not amended, not created', () => {
    assert.equal(onFile, null)
  })

  check('not one column of the household’s account moved', () => {
    assert.deepEqual(accountAfter, accountBefore)
  })

  check('the onboarding ladder was not moved to INTAKE_SUBMITTED', () => {
    assert.notEqual(stage_, 'INTAKE_SUBMITTED')
  })

  check('the concierge still gets an interview to answer', () => {
    assert.equal(consultations, 1)
  })

  check('and a line on the timeline telling them to telephone', () => {
    assert.equal(timeline.length, 1)
    assert.match(timeline[0] ?? '', /household we already hold/i)
  })

  note(`outcome: ${describeIntake(onFile)}`)

  return {
    written: onFile !== null,
    allergies: onFile?.allergies ?? [],
    submitted: (onFile?.submittedAt ?? null) !== null,
    householdCanStillAnswer: true,
  }
}

// =============================================================================
// 5. Scenario 3 — the household that HAS answered is still protected
// =============================================================================

async function scenarioAlreadyAnswered(): Promise<void> {
  section('3. the household that had already answered')

  await stage()

  const before = await intakeSnapshot(ANSWERED_PROFILE)

  const posted = await submitProspectIntake(
    prospectPayload({ email: ANSWERED_EMAIL, allergies: [] })
  )

  const after = await intakeSnapshot(ANSWERED_PROFILE)

  check('the submission is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('their allergen list is untouched', () => {
    assert.deepEqual(after?.allergies, [...ON_FILE_ALLERGIES])
  })

  check('and so is the date they actually submitted', () => {
    assert.deepEqual(after?.submittedAt, before?.submittedAt)
  })

  note(`outcome: ${describeIntake(after)}`)
  note('the rule the old condition did cover is covered by the new one too.')
}

// =============================================================================
// 6. Scenario 4 — the real household is not locked out
// =============================================================================

/**
 * The household signs in and answers for itself.
 *
 * This is the scenario that makes the fix a *redirection* rather than a
 * removal. `submitIntake` is `auth: 'SESSION'` and runs the ownership check, so
 * the household proving who it is can write exactly the answers the anonymous
 * form now refuses — and, unlike the anonymous path, may amend them afterwards.
 */
async function scenarioSignedInHousehold(): Promise<void> {
  section('4. the same household signs in and answers for itself')

  await stage()

  // First the anonymous attempt, so the household is answering into the state
  // scenario 2 leaves behind rather than into a clean one.
  await submitProspectIntake(prospectPayload({ email: UNANSWERED_EMAIL }))

  signInAs(UNANSWERED)

  const posted = await submitIntake({
    clientProfileId: UNANSWERED_PROFILE,
    ...questionnaireAnswers({ allergies: TRUE_ALLERGIES }),
  })

  signInAs(null)

  const onFile = await intakeSnapshot(UNANSWERED_PROFILE)

  check('the signed-in submission is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  check('their real allergies are on the row', () => {
    assert.deepEqual(onFile?.allergies, [...TRUE_ALLERGIES])
  })

  check(
    'and submittedAt is stamped by the household, not by a stranger',
    () => {
      assert.notEqual(onFile?.submittedAt ?? null, null)
    }
  )

  note(`outcome: ${describeIntake(onFile)}`)
  note('the door that proves who you are is the door that still opens.')
}

// =============================================================================
// 7. Scenario 5 — an unknown address must still be able to answer
// =============================================================================

/**
 * A brand-new prospect, and the transcription check.
 *
 * A fix that closed finding D by never writing an anonymous questionnaire at
 * all would pass scenarios 2 and 3 and would have deleted the public
 * questionnaire. So this asks for the write and insists on it — and then puts
 * the *same* answers through the pre-fix path and compares the columns, which
 * is what keeps scenario 1 honest about being a reproduction of the defect
 * rather than a fixture that has drifted away from it.
 */
async function scenarioNoFalseRefusal(): Promise<void> {
  section('5. an unknown address — the public questionnaire still works')

  await stage()

  const posted = await submitProspectIntake(
    prospectPayload({ email: NEWCOMER_EMAIL, allergies: TRUE_ALLERGIES })
  )

  check('the submission is accepted', () => {
    assert.equal(codeOf(posted), 'ok')
  })

  const newcomerProfileId = await newcomerProfile()
  const newcomer = await accountSnapshot(await newcomerId())
  const shipped = await intakeSnapshot(newcomerProfileId)
  const ladder = await onboardingStageOf(newcomerProfileId)

  check('a household was opened for them', () => {
    assert.equal(newcomer.email, NEWCOMER_EMAIL)
    assert.equal(newcomer.status, 'PROSPECT')
  })

  check('their answers ARE written, allergies and all', () => {
    assert.deepEqual(shipped?.allergies, [...TRUE_ALLERGIES])
    assert.notEqual(shipped?.submittedAt ?? null, null)
  })

  check('and their onboarding ladder moved on', () => {
    assert.notEqual(ladder, null)
    assert.notEqual(ladder, 'INVITED')
  })

  // --- the transcription check -------------------------------------------
  await stage()

  await legacyProspectIntake(
    {
      sessionUserId: null,
      fullName: 'S. Marchetti',
      email: NEWCOMER_EMAIL,
      preferredContactMethod: 'EMAIL',
      source: 'DIRECT',
    },
    questionnaireAnswers({ allergies: TRUE_ALLERGIES })
  )

  const legacy = await intakeSnapshot(await newcomerProfile())

  check(
    'the pre-fix transcription still writes the same columns for a new address',
    () => {
      assert.deepEqual(legacy?.allergies, shipped?.allergies)
      assert.deepEqual(legacy?.dislikes, shipped?.dislikes)
      assert.equal(legacy?.householdSize, shipped?.householdSize)
      assert.equal(legacy?.notes, shipped?.notes)
      assert.equal(
        (legacy?.submittedAt ?? null) !== null,
        (shipped?.submittedAt ?? null) !== null
      )
    }
  )

  note(
    'so scenario 1 is measuring the defect, not a fixture that has drifted away from it.'
  )
}

// =============================================================================
// 8. Scenario 6 — the receipt is not an oracle
// =============================================================================

/**
 * The same form, posted for an address we hold and an address we do not.
 *
 * The ids were already withheld from anonymous callers. `submittedAt` was not:
 * the duplicate branch returned the household's *real* submission date, and the
 * withheld branch would now have nothing to return at all. Either would say "we
 * know this address" as loudly as an id would, so the anonymous receipt is a
 * constant.
 */
async function scenarioReceiptIsConstant(): Promise<void> {
  section('6. the anonymous receipt, for an address we hold and one we do not')

  await stage()

  const known = await submitProspectIntake(
    prospectPayload({ email: ANSWERED_EMAIL })
  )

  clearRateLimits()

  const unknown = await submitProspectIntake(
    prospectPayload({ email: 'nobody.here@example.org' })
  )

  check('both are accepted', () => {
    assert.equal(codeOf(known), 'ok')
    assert.equal(codeOf(unknown), 'ok')
  })

  check('both withhold every row identifier', () => {
    assert.equal(known.ok && known.data.intakeFormId, null)
    assert.equal(known.ok && known.data.clientProfileId, null)
    assert.equal(known.ok && known.data.consultationInterviewId, null)
    assert.equal(unknown.ok && unknown.data.intakeFormId, null)
    assert.equal(unknown.ok && unknown.data.clientProfileId, null)
    assert.equal(unknown.ok && unknown.data.consultationInterviewId, null)
  })

  check('and neither leaks a submission date the other does not have', () => {
    const knownAt = known.ok ? known.data.submittedAt : null
    const unknownAt = unknown.ok ? unknown.data.submittedAt : null

    assert.notEqual(knownAt, null)
    assert.notEqual(unknownAt, null)

    // Both are "now". The household that answered in January does not have its
    // January date read back to a stranger.
    const drift = Math.abs(
      (knownAt?.getTime() ?? 0) - (unknownAt?.getTime() ?? 0)
    )

    assert.ok(drift < 60_000, `receipt dates differ by ${String(drift)}ms`)
  })

  note('the reply is the same reply whether or not the address is one of ours.')
}

// =============================================================================
// 9. Reading the newcomer back
// =============================================================================

async function newcomerId(): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email: NEWCOMER_EMAIL },
    select: { id: true },
  })

  return row.id
}

/** The `ClientProfile` the public form opened for the newcomer. */
async function newcomerProfile(): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email: NEWCOMER_EMAIL },
    select: { clientProfile: { select: { id: true } } },
  })

  assert.notEqual(
    row.clientProfile,
    null,
    'the public form should have opened a household for a new address'
  )

  return row.clientProfile?.id ?? ''
}

// =============================================================================
// 10. The report
// =============================================================================

function printReport(before: AllergenOutcome, after: AllergenOutcome): void {
  printTable(
    'An anonymous questionnaire quoting a LEAD_QUALIFIED household that never answered',
    [
      ['', 'pre-fix', 'shipped'],
      [
        'ClientIntakeForm written',
        before.written ? 'yes' : 'no',
        after.written ? 'yes' : 'no',
      ],
      [
        'allergen list the kitchen reads',
        before.written
          ? `[${before.allergies.join(', ')}] (empty)`
          : 'none — unchanged',
        after.written ? `[${after.allergies.join(', ')}]` : 'none — unchanged',
      ],
      [
        'submittedAt stamped',
        before.submitted ? 'yes' : 'no',
        after.submitted ? 'yes' : 'no',
      ],
      [
        'household may still answer',
        before.householdCanStillAnswer ? 'yes' : 'no — locked out',
        after.householdCanStillAnswer ? 'yes' : 'no — locked out',
      ],
    ],
    '  Both columns are the same database and the same seeded household. The\n' +
      '  only difference is whether the write is gated on the row’s state or on\n' +
      '  whether the caller is somebody this call brought into being.'
  )
}

// =============================================================================
// 11. Entry point
// =============================================================================

async function main(): Promise<void> {
  const name = assertDisposableDatabase()

  console.log(
    'MCV-040 finding D — a public form may not answer for a household we already hold'
  )
  console.log(`database: ${name}`)

  const before = await scenarioLegacy()
  const after = await scenarioFixed()

  await scenarioAlreadyAnswered()
  await scenarioSignedInHousehold()
  await scenarioNoFalseRefusal()
  await scenarioReceiptIsConstant()

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
