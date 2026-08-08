// mannachef/apps/web/src/components/marketing/consultation/steps/kitchen-step.tsx
'use client'

/**
 * Step 3 — the kitchen we will be working in, and who else is home.
 *
 * `intakeKitchenStepSchema` carries one cross-field rule: a note about the pets
 * only makes sense once the household has said there are pets. It is filed
 * against `hasPets`, so the message appears beside the switch that resolves it.
 * The note field is therefore only rendered while the switch is on, and the
 * switch clears the note on its way down — an interface that can only produce
 * payloads its schema accepts is better than one that explains the refusal
 * afterwards.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'

import {
  intakeKitchenStepSchema,
  MAX_FAVOURITE_DISHES,
  MAX_KITCHEN_EQUIPMENT,
  MAX_PETS_NOTE_LENGTH,
  type IntakeKitchenStep,
  type IntakeKitchenStepInput,
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
import { SwitchField } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { zodResolver } from '@/lib/zod-resolver'

import { StringListField } from '@/components/forms/field-kit'
import { StepShell } from '../step-shell'

export interface KitchenStepProps {
  readonly stepIndex: number
  readonly initial: IntakeKitchenStep | null
  readonly onSubmit: (values: IntakeKitchenStep) => void
  readonly onBack: () => void
}

const BLANK: IntakeKitchenStepInput = {
  kitchenEquipment: [],
  favouriteDishes: [],
  hasPets: false,
}

export function KitchenStep({
  stepIndex,
  initial,
  onSubmit,
  onBack,
}: KitchenStepProps): React.JSX.Element {
  const form = useForm<IntakeKitchenStepInput, unknown, IntakeKitchenStep>({
    resolver: zodResolver(intakeKitchenStepSchema),
    defaultValues: initial ?? BLANK,
    mode: 'onBlur',
  })

  const hasPets = form.watch('hasPets') === true

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepIndex={stepIndex}
          title="Your kitchen"
          description="What we will be working with. A chef who knows the room arrives with the right pans rather than the usual ones."
          onBack={onBack}
        >
          <FormField
            control={form.control}
            name="kitchenEquipment"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What the kitchen holds</FormLabel>
                <FormControl>
                  <StringListField
                    value={field.value ?? []}
                    onValueChange={field.onChange}
                    itemNoun="piece of equipment"
                    placeholder="Gas range"
                    maxEntries={MAX_KITCHEN_EQUIPMENT}
                  />
                </FormControl>
                <FormDescription>
                  Ovens, hobs, a stand mixer, a smoker on the terrace — whatever
                  comes to mind. Anything you leave out, the chef will find on
                  the day; anything you name, they can plan around.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="favouriteDishes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Dishes you would be glad to see again</FormLabel>
                <FormControl>
                  <StringListField
                    value={field.value ?? []}
                    onValueChange={field.onChange}
                    itemNoun="dish"
                    placeholder="Bouillabaisse"
                    maxEntries={MAX_FAVOURITE_DISHES}
                  />
                </FormControl>
                <FormDescription>
                  A handful is plenty. They tell us more about how you eat than
                  a page of adjectives would.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="hasPets"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <SwitchField
                    label="There are pets in the home"
                    description="Cats on the counter and dogs underfoot change how a chef stages a kitchen. It is worth saying."
                    checked={field.value === true}
                    onCheckedChange={(checked) => {
                      field.onChange(checked)

                      if (!checked) {
                        form.setValue('petsNote', undefined, {
                          shouldValidate: true,
                        })
                      }
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {hasPets ? (
            <FormField
              control={form.control}
              name="petsNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tell us about them</FormLabel>
                  <FormControl>
                    <Textarea
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      rows={3}
                      maxLength={MAX_PETS_NOTE_LENGTH}
                      placeholder="A very interested labrador who should stay out of the kitchen."
                      value={field.value ?? ''}
                      onChange={(event) => {
                        const next = event.target.value

                        field.onChange(next === '' ? undefined : next)
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    A sentence or two is plenty — whether they should be kept
                    out, and anything a stranger in the house should know.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
        </StepShell>
      </form>
    </Form>
  )
}
