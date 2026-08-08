// mannachef/apps/web/src/components/marketing/consultation/steps/household-step.tsx
'use client'

/**
 * Step 1 — the table.
 *
 * Validated by `intakeHouseholdStepSchema`, which owns the cross-field rule
 * that the adults and the children have to add up to the household. That rule
 * is filed against `householdSize`, so it renders under the first field rather
 * than floating above the form.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'

import {
  intakeHouseholdStepSchema,
  MAX_HOUSEHOLD_SIZE,
  type IntakeHouseholdStep,
  type IntakeHouseholdStepInput,
} from '@mannachef/validators'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { zodResolver } from '@/lib/zod-resolver'

import { NumberField } from '@/components/forms/field-kit'
import { StepShell } from '../step-shell'

export interface HouseholdStepProps {
  readonly stepIndex: number
  readonly initial: IntakeHouseholdStep | null
  readonly onSubmit: (values: IntakeHouseholdStep) => void
}

const BLANK: IntakeHouseholdStepInput = {
  householdSize: 2,
  adults: 2,
  children: 0,
}

export function HouseholdStep({
  stepIndex,
  initial,
  onSubmit,
}: HouseholdStepProps): React.JSX.Element {
  const form = useForm<IntakeHouseholdStepInput, unknown, IntakeHouseholdStep>({
    resolver: zodResolver(intakeHouseholdStepSchema),
    defaultValues: initial ?? BLANK,
    mode: 'onBlur',
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepIndex={stepIndex}
          title="Your table"
          description="Who are we cooking for? The number of covers decides the portions, the pans, and how long a chef stays."
        >
          <FormField
            control={form.control}
            name="householdSize"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>How many people live in the home?</FormLabel>
                <FormControl>
                  <NumberField
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onValueChange={field.onChange}
                    onBlur={field.onBlur}
                    min={1}
                    max={MAX_HOUSEHOLD_SIZE}
                    autoComplete="off"
                  />
                </FormControl>
                <FormDescription>
                  Everyone we normally cook for, including you. Guests for a
                  particular evening are counted when that evening is booked.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="adults"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Adults</FormLabel>
                  <FormControl>
                    <NumberField
                      name={field.name}
                      ref={field.ref}
                      value={field.value}
                      onValueChange={field.onChange}
                      onBlur={field.onBlur}
                      min={1}
                      max={MAX_HOUSEHOLD_SIZE}
                      autoComplete="off"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="children"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Children</FormLabel>
                  <FormControl>
                    <NumberField
                      name={field.name}
                      ref={field.ref}
                      value={field.value}
                      onValueChange={field.onChange}
                      onBlur={field.onBlur}
                      min={0}
                      max={MAX_HOUSEHOLD_SIZE}
                      autoComplete="off"
                    />
                  </FormControl>
                  <FormDescription>
                    Younger palates change a menu more than any other single
                    fact, so it is worth being exact.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </StepShell>
      </form>
    </Form>
  )
}
