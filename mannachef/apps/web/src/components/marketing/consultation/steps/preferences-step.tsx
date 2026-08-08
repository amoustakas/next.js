// mannachef/apps/web/src/components/marketing/consultation/steps/preferences-step.tsx
'use client'

/**
 * Step 5 — the days that suit you and how you like to hear from us.
 *
 * `preferredCookDays` is a `String[]` narrowed by `cookDaySchema` to the seven
 * uppercase weekday tokens, so the checkboxes carry those tokens as their
 * values and the visible label is a separate concern. The schema's own
 * uniqueness rule means the group can never submit the same day twice, which is
 * what a checkbox group naturally guarantees anyway — the rule is there for
 * payloads that did not come from this form.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'

import {
  intakePreferencesStepSchema,
  MAX_NOTES_LENGTH,
  type CookDay,
  type IntakePreferencesStep,
  type IntakePreferencesStepInput,
} from '@mannachef/validators'

import { CheckboxField } from '@/components/ui/checkbox'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { RadioGroup, RadioGroupField } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { zodResolver } from '@/lib/zod-resolver'

import { StepShell } from '../step-shell'

export interface PreferencesStepProps {
  readonly stepIndex: number
  readonly initial: IntakePreferencesStep | null
  readonly onSubmit: (values: IntakePreferencesStep) => void
  readonly onBack: () => void
}

const BLANK: IntakePreferencesStepInput = {
  preferredContactMethod: 'EMAIL',
  preferredCookDays: [],
}

const COOK_DAYS: readonly { readonly value: CookDay; readonly label: string }[] =
  [
    { value: 'MONDAY', label: 'Monday' },
    { value: 'TUESDAY', label: 'Tuesday' },
    { value: 'WEDNESDAY', label: 'Wednesday' },
    { value: 'THURSDAY', label: 'Thursday' },
    { value: 'FRIDAY', label: 'Friday' },
    { value: 'SATURDAY', label: 'Saturday' },
    { value: 'SUNDAY', label: 'Sunday' },
  ]

const CONTACT_METHODS = [
  { value: 'EMAIL', label: 'Email', description: 'Considered, and in writing.' },
  { value: 'PHONE', label: 'Telephone', description: 'A call from the concierge.' },
  { value: 'SMS', label: 'Text message', description: 'Short notes about the week ahead.' },
  {
    value: 'IN_APP',
    label: 'In the portal',
    description: 'Nothing pushed — you will read it when you sign in.',
  },
] as const

export function PreferencesStep({
  stepIndex,
  initial,
  onSubmit,
  onBack,
}: PreferencesStepProps): React.JSX.Element {
  const form = useForm<
    IntakePreferencesStepInput,
    unknown,
    IntakePreferencesStep
  >({
    resolver: zodResolver(intakePreferencesStepSchema),
    defaultValues: initial ?? BLANK,
    mode: 'onBlur',
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepIndex={stepIndex}
          title="Staying in touch"
          description="The days that suit you, and the way you would like to hear from us."
          onBack={onBack}
        >
          <FormField
            control={form.control}
            name="preferredCookDays"
            render={({ field }) => {
              const selected = field.value ?? []

              return (
                <FormItem>
                  <FormLabel>Which days suit you?</FormLabel>
                  <FormDescription>
                    Choose as many as you like, or none at all — we will find a
                    rhythm together either way.
                  </FormDescription>
                  <FormControl>
                    <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <legend className="sr-only">Preferred cooking days</legend>
                      {COOK_DAYS.map((day) => (
                        <CheckboxField
                          key={day.value}
                          label={day.label}
                          checked={selected.includes(day.value)}
                          onCheckedChange={(checked) => {
                            field.onChange(
                              checked === true
                                ? [...selected, day.value]
                                : selected.filter((value) => value !== day.value)
                            )
                          }}
                        />
                      ))}
                    </fieldset>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )
            }}
          />

          <FormField
            control={form.control}
            name="preferredContactMethod"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>How would you like to be reached?</FormLabel>
                <FormControl>
                  <RadioGroup
                    value={field.value ?? 'EMAIL'}
                    onValueChange={field.onChange}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    {CONTACT_METHODS.map((method) => (
                      <RadioGroupField
                        key={method.value}
                        value={method.value}
                        label={method.label}
                        description={method.description}
                      />
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Anything else we should know?</FormLabel>
                <FormControl>
                  <Textarea
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    rows={5}
                    maxLength={MAX_NOTES_LENGTH}
                    placeholder="A birthday in March we always mark, a grandmother's recipe we would love reproduced, a wine cellar to cook against."
                    value={field.value ?? ''}
                    onChange={(event) => {
                      const next = event.target.value

                      field.onChange(next === '' ? undefined : next)
                    }}
                  />
                </FormControl>
                <FormDescription>
                  The part of the questionnaire chefs read first. Nothing is too
                  small.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </StepShell>
      </form>
    </Form>
  )
}
