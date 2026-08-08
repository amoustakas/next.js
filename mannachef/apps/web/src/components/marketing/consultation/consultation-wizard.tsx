// mannachef/apps/web/src/components/marketing/consultation/consultation-wizard.tsx
'use client'

/**
 * The consultation questionnaire — seven steps, one submission.
 *
 * ## The shape of the machine
 *
 * The wizard owns two pieces of state and nothing else: which step is on
 * screen, and the answers gathered so far. Each step is its own `<form>` with
 * its own `useForm`, resolved against its own member of `intakeStepSchemas` (or
 * `consultationRequestSchema` for the contact step). Nothing validates a step
 * it does not own, and nothing is submitted until the review step.
 *
 * That is a deliberate reading of "each step validates independently". The
 * alternative — one giant form and `trigger(fieldNames)` per step — makes the
 * resolver evaluate the whole questionnaire on every keystroke of every step,
 * and makes the set of fields a step owns a second, hand-maintained list that
 * can drift from the schema. Here the schema *is* the list.
 *
 * ## Where answers live between steps
 *
 * In `answers`, as **parsed step outputs**. A step hands up
 * `z.output<its schema>` — already trimmed, already de-duplicated, already
 * coerced — so assembling the final payload on the review step is a spread of
 * five objects rather than a second round of parsing.
 *
 * ## Going back does not lose anything
 *
 * Each step is remounted with its previous answers as `defaultValues`, so
 * moving backwards and forwards through the questionnaire is lossless for
 * every step that has been completed once. Only the step currently on screen
 * holds unsaved keystrokes, and that is the one the guest is looking at.
 *
 * ## The draft
 *
 * `answers` and `stepIndex` are mirrored into `sessionStorage` on every change
 * (see `./draft`). A restore is clamped to the furthest step the restored
 * answers actually support, so a draft whose contact step no longer parses —
 * the ordinary case being a preferred consultation time that has since passed —
 * lands the guest on that step rather than on a review of answers that are not
 * all there.
 *
 * Restoration happens in an effect rather than during render. `sessionStorage`
 * does not exist on the server, so reading it during render would produce
 * markup that cannot match the client's and would fail hydration.
 */

import * as React from 'react'
import { RotateCcw } from 'lucide-react'

import { INTAKE_STEPS, type ConsultationRequestInput } from '@mannachef/validators'

import { Button } from '@/components/ui/button'

import { ConsultationConfirmation } from './consultation-confirmation'
import {
  clearConsultationDraft,
  EMPTY_CONSULTATION_ANSWERS,
  readConsultationDraft,
  writeConsultationDraft,
  type ConsultationAnswers,
} from './draft'
import { WizardProgress } from './step-shell'
import { ContactStep } from './steps/contact-step'
import { DietaryStep, type DietaryTagOption } from './steps/dietary-step'
import { HouseholdStep } from './steps/household-step'
import { KitchenStep } from './steps/kitchen-step'
import { PreferencesStep } from './steps/preferences-step'
import { ReviewStep } from './steps/review-step'
import { ServiceStep } from './steps/service-step'

// =============================================================================
// 1. Step titles
// =============================================================================

/**
 * The five questionnaire titles come from `INTAKE_STEPS`, which the validators
 * package publishes precisely so the wizard does not restate them. The two the
 * package does not own — the consultation request and the review — are added
 * here, in the order they are shown.
 */
const STEP_TITLES: readonly string[] = [
  ...INTAKE_STEPS.map((step) => step.title),
  'Your consultation',
  'Read it back',
]

const REVIEW_STEP_INDEX = STEP_TITLES.length - 1

/**
 * The furthest step a set of answers can support.
 *
 * A guest may only ever be one step beyond their last completed answer, so a
 * restored draft that lost a slice is clamped back to it rather than being
 * shown a review with a hole in it.
 */
function reachableStepIndex(answers: ConsultationAnswers): number {
  if (answers.household === null) {
    return 0
  }

  if (answers.dietary === null) {
    return 1
  }

  if (answers.kitchen === null) {
    return 2
  }

  if (answers.service === null) {
    return 3
  }

  if (answers.preferences === null) {
    return 4
  }

  if (answers.contact === null) {
    return 5
  }

  return REVIEW_STEP_INDEX
}

// =============================================================================
// 2. The wizard
// =============================================================================

export interface ConsultationWizardProps {
  /** `Tag` rows of kind `DIETARY` and `ALLERGEN`, read on the server. */
  readonly tagOptions: readonly DietaryTagOption[]
}

interface Receipt {
  readonly submittedAt: Date | null
  readonly contact: ConsultationRequestInput
  readonly allergyCount: number
}

export function ConsultationWizard({
  tagOptions,
}: ConsultationWizardProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = React.useState(0)
  const [answers, setAnswers] = React.useState<ConsultationAnswers>(
    EMPTY_CONSULTATION_ANSWERS
  )
  const [receipt, setReceipt] = React.useState<Receipt | null>(null)
  const [restored, setRestored] = React.useState(false)

  // --- Restore ------------------------------------------------------------
  React.useEffect(() => {
    const draft = readConsultationDraft()

    if (draft === null) {
      return
    }

    setAnswers(draft.answers)
    setStepIndex(Math.min(draft.stepIndex, reachableStepIndex(draft.answers)))
    setRestored(true)
  }, [])

  // --- Persist ------------------------------------------------------------
  // Skipped once a receipt exists: the draft is cleared on success and must not
  // be written back by the effect that observes the same render.
  React.useEffect(() => {
    if (receipt !== null) {
      return
    }

    if (reachableStepIndex(answers) === 0) {
      return
    }

    writeConsultationDraft({ stepIndex, answers })
  }, [answers, receipt, stepIndex])

  const goBack = React.useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1))
  }, [])

  const startOver = React.useCallback(() => {
    clearConsultationDraft()
    setAnswers(EMPTY_CONSULTATION_ANSWERS)
    setStepIndex(0)
    setRestored(false)
  }, [])

  const handleSubmitted = React.useCallback(
    (result: { readonly submittedAt: Date | null }) => {
      const contact = answers.contact

      if (contact === null) {
        // Unreachable: the review step is only mounted once every slice is
        // present. Answered rather than asserted away, so the function is total.
        return
      }

      clearConsultationDraft()
      setReceipt({
        submittedAt: result.submittedAt,
        contact,
        allergyCount: answers.dietary?.allergies.length ?? 0,
      })
    },
    [answers.contact, answers.dietary]
  )

  if (receipt !== null) {
    return (
      <ConsultationConfirmation
        submittedAt={receipt.submittedAt}
        preferredDates={receipt.contact.preferredDates}
        durationMinutes={receipt.contact.durationMinutes}
        email={receipt.contact.email}
        preferredContactMethod={receipt.contact.preferredContactMethod}
        allergyCount={receipt.allergyCount}
      />
    )
  }

  return (
    <div className="flex flex-col gap-10">
      <WizardProgress stepIndex={stepIndex} stepTitles={STEP_TITLES} />

      {restored ? (
        <div className="flex flex-col gap-3 rounded-lg border border-ash bg-charcoal/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-sans text-xs leading-relaxed text-parchment">
            We kept the answers you had already given in this tab. Anything you
            were part-way through typing was not saved.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={startOver}>
            <RotateCcw aria-hidden="true" className="mr-2 size-3.5" />
            Start again
          </Button>
        </div>
      ) : null}

      {stepIndex === 0 ? (
        <HouseholdStep
          stepIndex={stepIndex}
          initial={answers.household}
          onSubmit={(values) => {
            setAnswers((current) => ({ ...current, household: values }))
            setStepIndex(1)
          }}
        />
      ) : null}

      {stepIndex === 1 ? (
        <DietaryStep
          stepIndex={stepIndex}
          initial={answers.dietary}
          tagOptions={tagOptions}
          onBack={goBack}
          onSubmit={(values) => {
            setAnswers((current) => ({ ...current, dietary: values }))
            setStepIndex(2)
          }}
        />
      ) : null}

      {stepIndex === 2 ? (
        <KitchenStep
          stepIndex={stepIndex}
          initial={answers.kitchen}
          onBack={goBack}
          onSubmit={(values) => {
            setAnswers((current) => ({ ...current, kitchen: values }))
            setStepIndex(3)
          }}
        />
      ) : null}

      {stepIndex === 3 ? (
        <ServiceStep
          stepIndex={stepIndex}
          initial={answers.service}
          onBack={goBack}
          onSubmit={(values) => {
            setAnswers((current) => ({ ...current, service: values }))
            setStepIndex(4)
          }}
        />
      ) : null}

      {stepIndex === 4 ? (
        <PreferencesStep
          stepIndex={stepIndex}
          initial={answers.preferences}
          onBack={goBack}
          onSubmit={(values) => {
            setAnswers((current) => ({ ...current, preferences: values }))
            setStepIndex(5)
          }}
        />
      ) : null}

      {stepIndex === 5 ? (
        <ContactStep
          stepIndex={stepIndex}
          initial={answers.contact}
          householdSize={answers.household?.householdSize}
          onBack={goBack}
          onSubmit={(values) => {
            setAnswers((current) => ({ ...current, contact: values }))
            setStepIndex(REVIEW_STEP_INDEX)
          }}
        />
      ) : null}

      {stepIndex === REVIEW_STEP_INDEX &&
      answers.household !== null &&
      answers.dietary !== null &&
      answers.kitchen !== null &&
      answers.service !== null &&
      answers.preferences !== null &&
      answers.contact !== null ? (
        <ReviewStep
          stepIndex={stepIndex}
          answers={{
            household: answers.household,
            dietary: answers.dietary,
            kitchen: answers.kitchen,
            service: answers.service,
            preferences: answers.preferences,
            contact: answers.contact,
          }}
          onBack={goBack}
          onEditStep={setStepIndex}
          onSubmitted={handleSubmitted}
        />
      ) : null}
    </div>
  )
}
