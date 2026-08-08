// mannachef/apps/web/src/components/marketing/consultation/steps/contact-step.tsx
'use client'

/**
 * Step 6 — who is asking, and when they are free.
 *
 * Validated by `consultationRequestSchema`, which the public action pairs with
 * the five questionnaire steps. Three of its rules are conditional and all
 * three are rendered as conditions rather than as surprises:
 *
 *  - a contact method other than email requires a telephone number, so the
 *    phone field is marked required the moment the method changes;
 *  - `source: 'OTHER'` requires `sourceDetail`, so that field appears only then;
 *  - `source: 'REFERRAL'` requires a code, so that field does too.
 *
 * `householdSize` is carried through from step 1 rather than asked again. It is
 * still a value of *this* form — the schema takes it here — so it is shown back
 * as a sentence the guest can check rather than hidden in a `type="hidden"`
 * input they cannot.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'

import {
  consultationRequestSchema,
  MAX_INTAKE_REFERRAL_CODE_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PREFERRED_CONSULTATION_DATES,
  MAX_SOURCE_DETAIL_LENGTH,
  type ConsultationRequestInput,
  type ConsultationRequestRawInput,
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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { zodResolver } from '@/lib/zod-resolver'

import { DateTimeListField } from '@/components/forms/field-kit'
import { StepShell } from '../step-shell'

export interface ContactStepProps {
  readonly stepIndex: number
  readonly initial: ConsultationRequestInput | null
  /** Carried from step 1 so the concierge sees the same number twice. */
  readonly householdSize: number | undefined
  readonly onSubmit: (values: ConsultationRequestInput) => void
  readonly onBack: () => void
}

const SOURCES = [
  { value: 'WORD_OF_MOUTH', label: 'Somebody mentioned you' },
  { value: 'REFERRAL', label: 'A friend gave me a code' },
  { value: 'ORGANIC_SEARCH', label: 'I searched for a private chef' },
  { value: 'SOCIAL', label: 'Social media' },
  { value: 'PAID_SEARCH', label: 'An advertisement' },
  { value: 'PARTNER', label: 'Through a partner of yours' },
  { value: 'EVENT', label: 'At an event' },
  { value: 'DIRECT', label: 'I already knew of you' },
  { value: 'OTHER', label: 'Some other way' },
] as const

const CONTACT_METHODS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'PHONE', label: 'Telephone' },
  { value: 'SMS', label: 'Text message' },
  { value: 'IN_APP', label: 'In the portal' },
] as const

const DURATIONS = [
  { value: 30, label: '30 minutes' },
  { value: 45, label: '45 minutes' },
  { value: 60, label: 'An hour' },
  { value: 90, label: 'An hour and a half' },
] as const

export function ContactStep({
  stepIndex,
  initial,
  householdSize,
  onSubmit,
  onBack,
}: ContactStepProps): React.JSX.Element {
  /**
   * `consentToContact` is `z.literal(true)`, so its *input* type is `true` and
   * there is no value that spells "not yet ticked". The key is therefore left
   * off the blank defaults entirely rather than set to `undefined` — under
   * `exactOptionalPropertyTypes` those are different things, and only the first
   * one compiles. An absent value fails the literal with the schema's own
   * sentence, which is exactly the message an unticked box should produce.
   */
  const blank = {
    fullName: '',
    email: '',
    preferredContactMethod: 'EMAIL',
    source: 'WORD_OF_MOUTH',
    preferredDates: [] as (string | Date)[],
    durationMinutes: 30,
  } as const satisfies Partial<ConsultationRequestRawInput>

  const form = useForm<
    ConsultationRequestRawInput,
    unknown,
    ConsultationRequestInput
  >({
    resolver: zodResolver(consultationRequestSchema),
    defaultValues:
      initial === null
        ? { ...blank, householdSize }
        : { ...initial, householdSize: householdSize ?? initial.householdSize },
    mode: 'onBlur',
  })

  const contactMethod = form.watch('preferredContactMethod')
  const source = form.watch('source')
  const phoneRequired = contactMethod !== undefined && contactMethod !== 'EMAIL'

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepIndex={stepIndex}
          title="Your consultation"
          description="A conversation before anything is cooked — thirty unhurried minutes about how you eat."
          onBack={onBack}
          nextLabel="Review your answers"
        >
          <div className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Your name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      autoComplete="name"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Email</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      value={field.value ?? ''}
                      autoComplete="email"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="preferredContactMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>How shall we reply?</FormLabel>
                  <Select
                    value={field.value ?? 'EMAIL'}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a way to reach you" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CONTACT_METHODS.map((method) => (
                        <SelectItem key={method.value} value={method.value}>
                          {method.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required={phoneRequired}>Telephone</FormLabel>
                  <FormControl>
                    <Input
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      type="tel"
                      autoComplete="tel"
                      placeholder="(416) 555-0134"
                      value={field.value ?? ''}
                      onChange={(event) => {
                        const next = event.target.value

                        field.onChange(next === '' ? undefined : next)
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    {phoneRequired
                      ? 'Needed, since you have asked us to reach you by something other than email.'
                      : 'Optional while you would rather hear from us by email.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>How did you come to find us?</FormLabel>
                <Select
                  value={field.value ?? 'WORD_OF_MOUTH'}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose one" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SOURCES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {source === 'OTHER' ? (
            <FormField
              control={form.control}
              name="sourceDetail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Tell us a little more</FormLabel>
                  <FormControl>
                    <Input
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      maxLength={MAX_SOURCE_DETAIL_LENGTH}
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
          ) : null}

          {source === 'REFERRAL' ? (
            <FormField
              control={form.control}
              name="referralCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Referral code</FormLabel>
                  <FormControl>
                    <Input
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      maxLength={MAX_INTAKE_REFERRAL_CODE_LENGTH}
                      autoCapitalize="characters"
                      spellCheck={false}
                      className="uppercase sm:max-w-64"
                      value={field.value ?? ''}
                      onChange={(event) => {
                        const next = event.target.value

                        field.onChange(next === '' ? undefined : next)
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    Letters, numbers and hyphens. We will note it against your
                    enquiry; nothing is credited to anybody until you have
                    actually dined with us.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}

          <FormField
            control={form.control}
            name="preferredDates"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>When would suit you?</FormLabel>
                <FormDescription>
                  {`Offer up to ${String(
                    MAX_PREFERRED_CONSULTATION_DATES
                  )} times, best first. We will confirm one of them — the earliest we can keep.`}
                </FormDescription>
                <FormControl>
                  <DateTimeListField
                    value={field.value ?? []}
                    onValueChange={field.onChange}
                    maxEntries={MAX_PREFERRED_CONSULTATION_DATES}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="durationMinutes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>How long should we set aside?</FormLabel>
                <Select
                  value={String(field.value ?? 30)}
                  onValueChange={(value) => {
                    field.onChange(Number(value))
                  }}
                >
                  <FormControl>
                    <SelectTrigger className="sm:max-w-64">
                      <SelectValue placeholder="Choose a length" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {DURATIONS.map((duration) => (
                      <SelectItem
                        key={duration.value}
                        value={String(duration.value)}
                      >
                        {duration.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What do you have in mind?</FormLabel>
                <FormControl>
                  <Textarea
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    rows={4}
                    maxLength={MAX_NOTES_LENGTH}
                    placeholder="We host a great deal and would like the weeknights taken off our hands."
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

          {householdSize === undefined ? null : (
            <p className="rounded-md border border-ash bg-charcoal/60 px-4 py-3 font-sans text-xs leading-relaxed text-parchment">
              {`We will tell the chef there are ${String(
                householdSize
              )} of you at the table, as you said on the first step. Go back to change it.`}
            </p>
          )}

          <FormField
            control={form.control}
            name="consentToContact"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <CheckboxField
                    label="You may contact me about this enquiry"
                    description="We will use your details to arrange the consultation and nothing else. No newsletter, no list."
                    checked={field.value === true}
                    onCheckedChange={(checked) => {
                      field.onChange(checked === true ? true : undefined)
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </StepShell>
      </form>
    </Form>
  )
}
