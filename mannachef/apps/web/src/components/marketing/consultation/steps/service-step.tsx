// mannachef/apps/web/src/components/marketing/consultation/steps/service-step.tsx
'use client'

/**
 * Step 4 — cadence, budget, and where we are cooking.
 *
 * ## The address is genuinely optional, so the control says so
 *
 * `intakeServiceStepSchema` takes `serviceAddress` as an optional
 * `addressSchema`, and `addressSchema` itself is strict: a street, a city, a
 * province, and a postal code, or nothing at all. A form that rendered four
 * always-present inputs would make "nothing at all" unreachable — the guest
 * would have to leave four fields blank and would be told off four times for
 * it. The switch is therefore part of the schema's meaning rather than a
 * convenience: off writes `undefined`, on requires the whole address.
 *
 * ## The budget is entered in dollars and stored in cents
 *
 * `budgetPerMealCents` is integer minor units, per `CONTRACT.md` §4.
 * {@link DollarsField} is the only place in this questionnaire where the two
 * are converted, and `<Money>` is the only place anywhere that divides by a
 * hundred to display one.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'

import {
  intakeServiceStepSchema,
  MAX_BUDGET_PER_MEAL_CENTS,
  MAX_NOTES_LENGTH,
  MIN_BUDGET_PER_MEAL_CENTS,
  type IntakeServiceStep,
  type IntakeServiceStepInput,
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
import { Input } from '@/components/ui/input'
import { Money } from '@/components/ui/money'
import { RadioGroup, RadioGroupField } from '@/components/ui/radio-group'
import { SwitchField } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { zodResolver } from '@/lib/zod-resolver'

import { DollarsField } from '@/components/forms/field-kit'
import { StepShell } from '../step-shell'

export interface ServiceStepProps {
  readonly stepIndex: number
  readonly initial: IntakeServiceStep | null
  readonly onSubmit: (values: IntakeServiceStep) => void
  readonly onBack: () => void
}

const BLANK: IntakeServiceStepInput = {
  deliveryFrequency: 'WEEKLY',
}

const CADENCES = [
  {
    value: 'WEEKLY',
    label: 'Weekly',
    description: 'A chef in the kitchen once a week, cooking for the days ahead.',
  },
  {
    value: 'BIWEEKLY',
    label: 'Every other week',
    description: 'A fortnightly rhythm, with a larger cook each visit.',
  },
  {
    value: 'MONTHLY',
    label: 'Monthly',
    description: 'One considered evening a month rather than a standing order.',
  },
  {
    value: 'ON_DEMAND',
    label: 'When we ask',
    description: 'No cadence at all — you tell us when, and we come.',
  },
] as const

export function ServiceStep({
  stepIndex,
  initial,
  onSubmit,
  onBack,
}: ServiceStepProps): React.JSX.Element {
  const form = useForm<IntakeServiceStepInput, unknown, IntakeServiceStep>({
    resolver: zodResolver(intakeServiceStepSchema),
    defaultValues: initial ?? BLANK,
    mode: 'onBlur',
  })

  const [withAddress, setWithAddress] = React.useState(
    initial?.serviceAddress !== undefined && initial.serviceAddress !== null
  )

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepIndex={stepIndex}
          title="Your service"
          description="How often we cook, what you would like to invest in a meal, and where the kitchen is."
          onBack={onBack}
        >
          <FormField
            control={form.control}
            name="deliveryFrequency"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>How often should we cook?</FormLabel>
                <FormControl>
                  <RadioGroup
                    value={field.value ?? 'WEEKLY'}
                    onValueChange={field.onChange}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    {CADENCES.map((cadence) => (
                      <RadioGroupField
                        key={cadence.value}
                        value={cadence.value}
                        label={cadence.label}
                        description={cadence.description}
                      />
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormDescription>
                  Nothing is fixed by this answer — it simply tells the chef
                  what to design for.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="budgetPerMealCents"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What would you like to invest, per meal?</FormLabel>
                <FormControl>
                  <DollarsField
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    valueCents={field.value}
                    onValueCentsChange={field.onChange}
                    placeholder="45.00"
                    autoComplete="off"
                  />
                </FormControl>
                <FormDescription>
                  Per person, per meal, and entirely optional — leave it blank
                  and we will propose something and let you react to it. We work
                  between{' '}
                  <Money cents={MIN_BUDGET_PER_MEAL_CENTS} tone="accent" /> and{' '}
                  <Money cents={MAX_BUDGET_PER_MEAL_CENTS} tone="accent" /> a
                  meal; beyond that, we would rather design it with you in
                  person.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <SwitchField
            label="Add the service address now"
            description="Leave this off if you have not settled on the kitchen yet. We will ask again before the first booking."
            checked={withAddress}
            onCheckedChange={(checked) => {
              setWithAddress(checked)

              if (!checked) {
                form.setValue('serviceAddress', undefined, {
                  shouldValidate: true,
                })
              }
            }}
          />

          {withAddress ? (
            <fieldset className="grid gap-6 rounded-lg border border-ash bg-charcoal/60 p-5">
              <legend className="px-2 font-sans text-xs tracking-[0.18em] text-stone uppercase">
                Service address
              </legend>

              <FormField
                control={form.control}
                name="serviceAddress.line1"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Street address</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        autoComplete="address-line1"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="serviceAddress.line2"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Apartment, suite, or floor</FormLabel>
                    <FormControl>
                      <Input
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        autoComplete="address-line2"
                        value={field.value ?? ''}
                        onChange={(event) => {
                          const next = event.target.value

                          field.onChange(next === '' ? undefined : next)
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-6 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="serviceAddress.city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>City</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ''}
                          autoComplete="address-level2"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="serviceAddress.region"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Province or territory</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ''}
                          autoComplete="address-level1"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="serviceAddress.postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Postal code</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        autoComplete="postal-code"
                        placeholder="M5V 2T6"
                        className="sm:max-w-40"
                      />
                    </FormControl>
                    <FormDescription>
                      We cook in Canada, so a Canadian postal code is what this
                      field expects.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </fieldset>
          ) : null}

          <FormField
            control={form.control}
            name="serviceAccessNotes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>How should we reach your door?</FormLabel>
                <FormControl>
                  <Textarea
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    rows={3}
                    maxLength={MAX_NOTES_LENGTH}
                    placeholder="Buzzer 402, park in the lane behind the building."
                    value={field.value ?? ''}
                    onChange={(event) => {
                      const next = event.target.value

                      field.onChange(next === '' ? undefined : next)
                    }}
                  />
                </FormControl>
                <FormDescription>
                  Gate codes, lifts, where to leave a car — the small things
                  that decide whether a chef arrives calm.
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
