// mannachef/apps/web/src/components/marketing/consultation/steps/dietary-step.tsx
'use client'

/**
 * Step 2 — the palate, and the one field on this questionnaire that can hurt
 * somebody.
 *
 * ## Allergies are treated differently, on purpose
 *
 * `allergies` is a `String[]` on `ClientIntakeForm` that the kitchen reads
 * before it shops. An empty list is not "unknown", it is a statement that there
 * is nothing to avoid — so the interface never lets that statement be made by
 * accident. Three things follow, and all three are visible:
 *
 *  1. The field sits in its own claret-bordered panel, above the fields it
 *     shares a step with, rather than as the first of four look-alike inputs.
 *  2. Entries render as claret chips, so what has been recorded is legible at a
 *     glance rather than hidden inside a comma-separated string.
 *  3. An empty list is confirmed rather than assumed: the panel says in words
 *     that leaving it blank tells the kitchen there are no allergies at the
 *     table, and a live region states the current count.
 *
 * The structured counterpart — `dietaryPreferenceTagIds`, the `Tag` rows of
 * kind `DIETARY` and `ALLERGEN` — is offered as checkboxes beside it, because a
 * chosen tag is something the menu can be filtered by and free text is not.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { ShieldAlert } from 'lucide-react'

import {
  intakeDietaryStepSchema,
  MAX_ALLERGIES,
  MAX_CUISINE_PREFERENCES,
  MAX_DISLIKES,
  type IntakeDietaryStep,
  type IntakeDietaryStepInput,
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
import { zodResolver } from '@/lib/zod-resolver'
import { cn } from '@/lib/utils'

import { StringListField } from '@/components/forms/field-kit'
import { StepShell } from '../step-shell'

/** One selectable `Tag` of kind `DIETARY` or `ALLERGEN`. */
export interface DietaryTagOption {
  readonly id: string
  readonly name: string
  readonly kind: string
}

export interface DietaryStepProps {
  readonly stepIndex: number
  readonly initial: IntakeDietaryStep | null
  readonly tagOptions: readonly DietaryTagOption[]
  readonly onSubmit: (values: IntakeDietaryStep) => void
  readonly onBack: () => void
}

const BLANK: IntakeDietaryStepInput = {
  allergies: [],
  dislikes: [],
  cuisinePreferences: [],
  dietaryPreferenceTagIds: [],
}

export function DietaryStep({
  stepIndex,
  initial,
  tagOptions,
  onSubmit,
  onBack,
}: DietaryStepProps): React.JSX.Element {
  const form = useForm<IntakeDietaryStepInput, unknown, IntakeDietaryStep>({
    resolver: zodResolver(intakeDietaryStepSchema),
    defaultValues: initial ?? BLANK,
    mode: 'onBlur',
  })

  const allergies = form.watch('allergies') ?? []

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepIndex={stepIndex}
          title="Your palate"
          description="Allergies, aversions, and the flavours you return to. Everything here reaches the chef before they shop."
          onBack={onBack}
        >
          <section
            aria-labelledby="allergy-panel-heading"
            className="rounded-lg border border-claret/60 bg-claret/8 p-5"
          >
            <div className="mb-4 flex items-start gap-3">
              <ShieldAlert
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-claret-ink"
              />
              <div className="flex flex-col gap-1">
                <h3
                  id="allergy-panel-heading"
                  className="font-sans text-sm font-semibold text-linen"
                >
                  Allergies and intolerances
                </h3>
                <p className="font-sans text-xs leading-relaxed text-parchment">
                  This is the one answer the kitchen treats as a rule rather
                  than a preference. Name each one separately — “shellfish”,
                  “tree nuts”, “sesame” — and add anything that matters even a
                  little. Leaving the list empty tells us there is nothing to
                  avoid at your table.
                </p>
              </div>
            </div>

            <FormField
              control={form.control}
              name="allergies"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Add an allergy</FormLabel>
                  <FormControl>
                    <StringListField
                      value={field.value ?? []}
                      onValueChange={field.onChange}
                      itemNoun="allergy"
                      placeholder="Shellfish"
                      maxEntries={MAX_ALLERGIES}
                      tone="critical"
                    />
                  </FormControl>
                  <FormDescription>
                    Anything you tell us here is repeated to every chef who
                    cooks for you, and to the concierge who plans the menu.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <p
              role="status"
              aria-live="polite"
              className={cn(
                'mt-4 font-sans text-xs leading-relaxed',
                allergies.length === 0 ? 'text-stone' : 'text-linen'
              )}
            >
              {allergies.length === 0
                ? 'No allergies recorded — we will cook without restriction.'
                : `${String(allergies.length)} recorded: ${allergies.join(', ')}.`}
            </p>
          </section>

          <FormField
            control={form.control}
            name="dislikes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Things you would rather not see</FormLabel>
                <FormControl>
                  <StringListField
                    value={field.value ?? []}
                    onValueChange={field.onChange}
                    itemNoun="dislike"
                    placeholder="Coriander"
                    maxEntries={MAX_DISLIKES}
                  />
                </FormControl>
                <FormDescription>
                  Aversions rather than allergies — an ingredient we will simply
                  design around.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="cuisinePreferences"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cuisines you love</FormLabel>
                <FormControl>
                  <StringListField
                    value={field.value ?? []}
                    onValueChange={field.onChange}
                    itemNoun="cuisine"
                    placeholder="Levantine"
                    maxEntries={MAX_CUISINE_PREFERENCES}
                  />
                </FormControl>
                <FormDescription>
                  Where your favourite meals tend to come from. This shapes the
                  first menu we propose more than anything else on the page.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {tagOptions.length === 0 ? null : (
            <FormField
              control={form.control}
              name="dietaryPreferenceTagIds"
              render={({ field }) => {
                const selected = field.value ?? []

                return (
                  <FormItem>
                    <FormLabel>Dietary preferences</FormLabel>
                    <FormDescription>
                      Chosen from our own vocabulary, so the menu can be
                      filtered by them automatically.
                    </FormDescription>
                    <FormControl>
                      <fieldset className="grid gap-3 sm:grid-cols-2">
                        <legend className="sr-only">
                          Dietary preferences and allergen tags
                        </legend>
                        {tagOptions.map((tag) => (
                          <CheckboxField
                            key={tag.id}
                            label={tag.name}
                            description={
                              tag.kind === 'ALLERGEN'
                                ? 'Allergen'
                                : 'Dietary preference'
                            }
                            checked={selected.includes(tag.id)}
                            onCheckedChange={(checked) => {
                              field.onChange(
                                checked === true
                                  ? [...selected, tag.id]
                                  : selected.filter((id) => id !== tag.id)
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
          )}
        </StepShell>
      </form>
    </Form>
  )
}
