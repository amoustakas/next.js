// mannachef/apps/web/src/components/marketing/consultation/steps/review-step.tsx
'use client'

/**
 * Step 7 — read it back, then send it.
 *
 * ## Why the review step is where the action lives
 *
 * Every earlier step validates locally and writes to the draft; nothing leaves
 * the browser until here. So this is the only component in the questionnaire
 * that calls a Server Action, and the only one that has to answer for a
 * failure.
 *
 * ## The three states, and the codes
 *
 * `useAction` handles pending (a real `useTransition`, so the page stays
 * interactive), success (the receipt is handed upward and the draft is
 * cleared), and each `ActionErrorCode` by its own name. Two are given words of
 * their own here, because the generic sentence cannot say what a guest should
 * do next:
 *
 *  - **`RATE_LIMITED`.** `submitProspectIntake` is a public form with a bucket
 *    of five per hour, scoped to the address rather than to an identity — a
 *    prospect has none. That is a real, temporary, *survivable* refusal: the
 *    answers are still in the draft and the guest can send them shortly. A
 *    "something went wrong" would invite them to hammer the form and lose the
 *    lot.
 *  - **`CONFLICT`.** The action returns this to a *signed-in* caller who
 *    already has a questionnaire on file, and tells them to amend it in the
 *    portal rather than send a second. Rendering that as a fault would be
 *    wrong: nothing failed.
 *
 * The failure is rendered inline above the submit as well as being toasted,
 * because a toast times out and a refusal a guest has to act on must not.
 */

import * as React from 'react'
import { Pencil } from 'lucide-react'

import type {
  ConsultationRequestInput,
  IntakeDietaryStep,
  IntakeHouseholdStep,
  IntakeKitchenStep,
  IntakePreferencesStep,
  IntakeServiceStep,
} from '@mannachef/validators'

import { Button } from '@/components/ui/button'
import { DateTime } from '@/components/ui/date-time'
import { FormStatus } from '@/components/ui/form'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { useAction } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import { submitProspectIntake } from '@/server/actions/intake'

import { StepShell } from '../step-shell'

// =============================================================================
// 1. Props
// =============================================================================

/** Every slice, all of them answered — the wizard only mounts this step then. */
export interface CompletedConsultationAnswers {
  readonly household: IntakeHouseholdStep
  readonly dietary: IntakeDietaryStep
  readonly kitchen: IntakeKitchenStep
  readonly service: IntakeServiceStep
  readonly preferences: IntakePreferencesStep
  readonly contact: ConsultationRequestInput
}

export interface ReviewStepProps {
  readonly stepIndex: number
  readonly answers: CompletedConsultationAnswers
  readonly onBack: () => void
  /** Jump straight back to a numbered step from its "Edit" link. */
  readonly onEditStep: (stepIndex: number) => void
  readonly onSubmitted: (receipt: {
    readonly submittedAt: Date | null
  }) => void
}

// =============================================================================
// 2. Presentation helpers
// =============================================================================

const CADENCE_LABELS: Readonly<Record<string, string>> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every other week',
  MONTHLY: 'Monthly',
  ON_DEMAND: 'When we ask',
}

const CONTACT_LABELS: Readonly<Record<string, string>> = {
  EMAIL: 'Email',
  PHONE: 'Telephone',
  SMS: 'Text message',
  IN_APP: 'In the portal',
}

function titleCase(token: string): string {
  return token.charAt(0) + token.slice(1).toLowerCase()
}

interface SummaryRowProps {
  readonly label: string
  readonly children: React.ReactNode
  readonly tone?: 'default' | 'critical'
}

function SummaryRow({
  label,
  children,
  tone = 'default',
}: SummaryRowProps): React.JSX.Element {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[13rem_1fr] sm:gap-4">
      <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          'font-sans text-sm leading-relaxed',
          tone === 'critical' ? 'text-linen' : 'text-parchment'
        )}
      >
        {children}
      </dd>
    </div>
  )
}

interface SummarySectionProps {
  readonly title: string
  readonly editStepIndex: number
  readonly onEditStep: (stepIndex: number) => void
  readonly children: React.ReactNode
}

function SummarySection({
  title,
  editStepIndex,
  onEditStep,
  children,
}: SummarySectionProps): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-ash bg-slate-warm/60 p-5"
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-display text-xl font-light text-linen">{title}</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onEditStep(editStepIndex)
          }}
        >
          <Pencil aria-hidden="true" className="mr-2 size-3.5" />
          {`Edit ${title.toLowerCase()}`}
        </Button>
      </div>
      <Separator variant="hairline" className="my-4" decorative />
      <dl className="divide-y divide-ash/70">{children}</dl>
    </section>
  )
}

/** A list rendered as prose, or an explicit statement that it is empty. */
function listOrNone(
  values: readonly string[],
  emptySentence: string
): React.ReactNode {
  return values.length === 0 ? (
    <span className="text-stone">{emptySentence}</span>
  ) : (
    values.join(', ')
  )
}

// =============================================================================
// 3. The step
// =============================================================================

export function ReviewStep({
  stepIndex,
  answers,
  onBack,
  onEditStep,
  onSubmitted,
}: ReviewStepProps): React.JSX.Element {
  const { household, dietary, kitchen, service, preferences, contact } = answers

  const { execute, isPending, statusMessage, failure } = useAction(
    submitProspectIntake,
    {
      errorMessages: {
        RATE_LIMITED:
          'We have taken several enquiries from this connection in the last hour, so this one has been held back. Your answers are safe on this page — please try again in a little while, or telephone us and we will take them down ourselves.',
      },
      onSuccess: (data) => {
        onSubmitted(data)
      },
    }
  )

  const handleSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      void execute({
        contact,
        answers: {
          ...household,
          ...dietary,
          ...kitchen,
          ...service,
          ...preferences,
        },
      })
    },
    [contact, dietary, execute, household, kitchen, preferences, service]
  )

  return (
    <form onSubmit={handleSubmit} noValidate>
      <StepShell
        stepIndex={stepIndex}
        title="Read it back"
        description="Everything you have told us, in one place. Nothing has been sent yet."
        onBack={onBack}
        nextLabel="Send my questionnaire"
        submitting={isPending}
        beforeFooter={
          <div className="flex flex-col gap-4">
            {failure === null ? null : (
              <div
                role="alert"
                className={cn(
                  'rounded-lg border px-4 py-3',
                  failure.severity === 'error'
                    ? 'border-claret/60 bg-claret/12'
                    : 'border-terracotta/60 bg-terracotta/12'
                )}
              >
                <p className="font-sans text-sm font-semibold text-linen">
                  {failure.title}
                </p>
                <p className="mt-1 font-sans text-sm leading-relaxed text-parchment">
                  {failure.description}
                </p>
              </div>
            )}

            <FormStatus>{statusMessage}</FormStatus>
          </div>
        }
      >
        <SummarySection
          title="Your table"
          editStepIndex={0}
          onEditStep={onEditStep}
        >
          <SummaryRow label="Household">
            {`${String(household.householdSize)} in the home`}
          </SummaryRow>
          <SummaryRow label="Adults">{String(household.adults)}</SummaryRow>
          <SummaryRow label="Children">{String(household.children)}</SummaryRow>
        </SummarySection>

        <SummarySection
          title="Your palate"
          editStepIndex={1}
          onEditStep={onEditStep}
        >
          <SummaryRow label="Allergies" tone="critical">
            {dietary.allergies.length === 0 ? (
              <span className="text-stone">
                None recorded — we will cook without restriction.
              </span>
            ) : (
              <span className="font-medium text-linen">
                {dietary.allergies.join(', ')}
              </span>
            )}
          </SummaryRow>
          <SummaryRow label="Dislikes">
            {listOrNone(dietary.dislikes, 'Nothing named.')}
          </SummaryRow>
          <SummaryRow label="Cuisines">
            {listOrNone(dietary.cuisinePreferences, 'Open to anything.')}
          </SummaryRow>
          <SummaryRow label="Dietary preferences">
            {dietary.dietaryPreferenceTagIds.length === 0 ? (
              <span className="text-stone">None chosen.</span>
            ) : (
              `${String(dietary.dietaryPreferenceTagIds.length)} chosen from our list`
            )}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          title="Your kitchen"
          editStepIndex={2}
          onEditStep={onEditStep}
        >
          <SummaryRow label="Equipment">
            {listOrNone(kitchen.kitchenEquipment, 'We will see on the day.')}
          </SummaryRow>
          <SummaryRow label="Favourites">
            {listOrNone(kitchen.favouriteDishes, 'Nothing named yet.')}
          </SummaryRow>
          <SummaryRow label="Pets">
            {kitchen.hasPets
              ? (kitchen.petsNote ?? 'Yes, in the home.')
              : 'None in the home.'}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          title="Your service"
          editStepIndex={3}
          onEditStep={onEditStep}
        >
          <SummaryRow label="Cadence">
            {CADENCE_LABELS[service.deliveryFrequency] ??
              service.deliveryFrequency}
          </SummaryRow>
          <SummaryRow label="Budget a meal">
            {service.budgetPerMealCents === undefined ? (
              <span className="text-stone">
                Left to us to propose.
              </span>
            ) : (
              <Money
                cents={service.budgetPerMealCents}
                currency={service.currency}
                weight="medium"
              />
            )}
          </SummaryRow>
          <SummaryRow label="Address">
            {service.serviceAddress === undefined ? (
              <span className="text-stone">
                Not settled yet — we will ask before the first booking.
              </span>
            ) : (
              <span>
                {service.serviceAddress.line1}
                {service.serviceAddress.line2 === undefined
                  ? ''
                  : `, ${service.serviceAddress.line2}`}
                {`, ${service.serviceAddress.city}, ${service.serviceAddress.region} ${service.serviceAddress.postalCode}`}
              </span>
            )}
          </SummaryRow>
          <SummaryRow label="Getting in">
            {service.serviceAccessNotes ?? (
              <span className="text-stone">Nothing noted.</span>
            )}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          title="Staying in touch"
          editStepIndex={4}
          onEditStep={onEditStep}
        >
          <SummaryRow label="Days that suit you">
            {preferences.preferredCookDays.length === 0 ? (
              <span className="text-stone">No preference.</span>
            ) : (
              preferences.preferredCookDays.map(titleCase).join(', ')
            )}
          </SummaryRow>
          <SummaryRow label="Preferred contact">
            {CONTACT_LABELS[preferences.preferredContactMethod] ??
              preferences.preferredContactMethod}
          </SummaryRow>
          <SummaryRow label="Notes">
            {preferences.notes ?? (
              <span className="text-stone">Nothing added.</span>
            )}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          title="Your consultation"
          editStepIndex={5}
          onEditStep={onEditStep}
        >
          <SummaryRow label="Name">{contact.fullName}</SummaryRow>
          <SummaryRow label="Email">{contact.email}</SummaryRow>
          <SummaryRow label="Telephone">
            {contact.phone ?? <span className="text-stone">Not given.</span>}
          </SummaryRow>
          <SummaryRow label="Times offered">
            <ul className="flex flex-col gap-1">
              {contact.preferredDates.map((date, index) => (
                <li key={date.toISOString()}>
                  <DateTime value={date} format="datetime" />
                  {index === 0 ? (
                    <span className="ml-2 text-xs text-stone">
                      (first choice)
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </SummaryRow>
          <SummaryRow label="Length">
            {`${String(contact.durationMinutes)} minutes`}
          </SummaryRow>
          <SummaryRow label="What you have in mind">
            {contact.message ?? (
              <span className="text-stone">Nothing added.</span>
            )}
          </SummaryRow>
        </SummarySection>
      </StepShell>
    </form>
  )
}
