// mannachef/apps/web/src/components/marketing/consultation-request-form.tsx
'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { CalendarPlus, Check, Trash2 } from 'lucide-react'

import {
  consultationRequestSchema,
  MAX_HOUSEHOLD_SIZE,
  MAX_NOTES_LENGTH,
  MAX_PREFERRED_CONSULTATION_DATES,
  MAX_SOURCE_DETAIL_LENGTH,
  type ClientSource,
  type ConsultationRequestInput,
  type ConsultationRequestRawInput,
} from '@mannachef/validators'

import { useAction } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CheckboxField } from '@/components/ui/checkbox'
import { DateTime } from '@/components/ui/date-time'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
  FormStatus,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { CONTACT } from '@/components/marketing/site-config'
import { requestConsultation } from '@/server/actions/intake'

/**
 * The public consultation enquiry.
 *
 * ## The three states, all of them handled
 *
 *  - **Pending** — `useAction` runs the call inside `useTransition`, and
 *    `isPending` drives the submit button's `loading` state (which keeps its
 *    width, so the footer does not jump) and the `aria-busy` on the fieldset.
 *  - **Success** — the form is replaced by a receipt that quotes the time we
 *    are holding and how long it runs, read from the action's own return value
 *    rather than from what the guest typed.
 *  - **Failure** — `fieldErrors` land under the inputs that caused them, with
 *    no re-keying: `zodFail()` on the server and `@/lib/zod-resolver` on the
 *    client both spell paths with `z.core.toDotPath`, so `preferredDates[0]`
 *    means the same thing in both directions. Object-level rules — "please
 *    share a phone number if you would like us to reach you by phone" is
 *    reported at `phone` by the schema, but a genuinely pathless rule would not
 *    be — go to `<FormRootError>` above the submit. Everything that is not a
 *    field error is announced by code: a `RATE_LIMITED` says to wait, a
 *    `FORBIDDEN` never renders as "something went wrong".
 *
 * ## `knownFieldPaths`
 *
 * Passed explicitly, including the indexed spellings of `preferredDates`.
 * `consultationRequestSchema` has a `staffProfileId` this form deliberately does
 * not expose; without the allow-list, a server error on it would be handed to
 * `setError('staffProfileId')`, which React Hook Form accepts without complaint
 * and then never displays. With it, that message is promoted to the form-level
 * error instead of being dropped on the floor.
 *
 * ## The resolver
 *
 * `@/lib/zod-resolver`, never `@hookform/resolvers/zod` — the shipped resolver
 * guards on `Array.isArray(error.errors)` and zod 4 renamed that property to
 * `issues`, so it throws where it should return field errors and the form shows
 * no messages at all. The local resolver also hands `handleSubmit` zod's
 * *parsed* output, which is exactly what the action's own `input` schema
 * expects, so nothing is coerced twice.
 */
const DURATION_OPTIONS: ReadonlyArray<{
  readonly value: string
  readonly label: string
}> = [
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: 'One hour' },
  { value: '90', label: 'An hour and a half' },
]

const SOURCE_OPTIONS: ReadonlyArray<{
  readonly value: ClientSource
  readonly label: string
}> = [
  { value: 'WORD_OF_MOUTH', label: 'Someone told me about you' },
  { value: 'REFERRAL', label: 'I was given a referral code' },
  { value: 'ORGANIC_SEARCH', label: 'I found you searching' },
  { value: 'SOCIAL', label: 'Social media' },
  { value: 'PARTNER', label: 'Through a partner or supplier' },
  { value: 'EVENT', label: 'I met you at an event' },
  { value: 'DIRECT', label: 'I came straight to the site' },
  { value: 'OTHER', label: 'Another way' },
]

const CONTACT_METHOD_OPTIONS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'PHONE', label: 'A phone call' },
  { value: 'SMS', label: 'Text message' },
] as const

/**
 * Every path this form owns, in the spelling `z.core.toDotPath` produces.
 * Anything outside this set is promoted to the form-level error.
 */
const KNOWN_FIELD_PATHS: readonly string[] = [
  'fullName',
  'email',
  'phone',
  'preferredContactMethod',
  'householdSize',
  'preferredDates',
  ...Array.from(
    { length: MAX_PREFERRED_CONSULTATION_DATES },
    (_, index) => `preferredDates[${String(index)}]`
  ),
  'durationMinutes',
  'source',
  'sourceDetail',
  'referralCode',
  'message',
  'consentToContact',
]

/** A `datetime-local` input needs a string; the schema also accepts a `Date`. */
function toDateTimeLocalValue(value: string | Date | undefined): string {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : value.toISOString().slice(0, 16)
}

export function ConsultationRequestForm(): React.JSX.Element {
  const form = useForm<
    ConsultationRequestRawInput,
    unknown,
    ConsultationRequestInput
  >({
    resolver: zodResolver(consultationRequestSchema),
    mode: 'onBlur',
    defaultValues: {
      fullName: '',
      email: '',
      phone: '',
      preferredContactMethod: 'EMAIL',
      source: 'WORD_OF_MOUTH',
      sourceDetail: '',
      referralCode: '',
      message: '',
      durationMinutes: 30,
      preferredDates: [''],
    },
  })

  const {
    execute,
    isPending,
    status,
    data,
    statusMessage,
    reset: resetAction,
  } = useAction(requestConsultation, {
    form,
    resetFormOnSuccess: true,
    knownFieldPaths: KNOWN_FIELD_PATHS,
    // The receipt below replaces the form on success, which unmounts the
    // `<FormStatus>` live region with it — and a live region that is removed at
    // the moment its text would have changed is not announced. The toast is
    // mounted permanently by `<Providers>`, so it is the announcement that
    // actually reaches a screen reader.
    successMessage: 'Your enquiry is with the kitchen.',
    errorMessages: {
      RATE_LIMITED:
        'We have had a few enquiries from this connection in the last hour. Please try again shortly, or call the kitchen directly.',
    },
  })

  const source = form.watch('source')
  const preferredDates = form.watch('preferredDates')
  const slots = preferredDates.length === 0 ? 1 : preferredDates.length

  const addDateSlot = (): void => {
    if (slots >= MAX_PREFERRED_CONSULTATION_DATES) {
      return
    }

    form.setValue('preferredDates', [...preferredDates, ''], {
      shouldDirty: true,
    })
  }

  const removeDateSlot = (index: number): void => {
    form.setValue(
      'preferredDates',
      preferredDates.filter((_, position) => position !== index),
      { shouldDirty: true }
    )
  }

  if (status === 'success' && data !== null) {
    return (
      <Card variant="accent" as="section" aria-labelledby="enquiry-received">
        <CardContent className="flex flex-col gap-5 p-8 pt-8">
          <span
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-full border border-ash text-sage"
          >
            <Check className="size-5" />
          </span>

          <h2
            id="enquiry-received"
            className="font-display text-2xl leading-tight font-medium tracking-tight text-linen"
          >
            Your enquiry is with the kitchen.
          </h2>

          <p className="font-sans text-sm leading-relaxed text-parchment">
            We have pencilled in{' '}
            <DateTime
              value={data.scheduledFor}
              format="datetime"
              tone="default"
              className="font-medium"
            />{' '}
            for {String(data.durationMinutes)} minutes and will confirm it — or
            offer one of the other times you gave us — within one working day.
            If it is urgent, the kitchen office is on{' '}
            <a
              href={`tel:${CONTACT.phoneE164}`}
              className="rounded-sm text-linen underline underline-offset-4"
            >
              {CONTACT.phoneDisplay}
            </a>
            .
          </p>

          <div>
            <Button
              variant="outline"
              onClick={() => {
                resetAction()
              }}
            >
              Send another enquiry
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => {
          void execute(values)
        })}
        className="flex flex-col gap-10"
      >
        <fieldset
          disabled={isPending}
          aria-busy={isPending || undefined}
          className="flex flex-col gap-10 border-0 p-0"
        >
          <section aria-labelledby="about-you" className="flex flex-col gap-6">
            <h2
              id="about-you"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              About you
            </h2>

            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Your name</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="name"
                      placeholder="Priya Raghavan"
                      {...field}
                      value={field.value}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        placeholder="you@example.com"
                        {...field}
                        value={field.value}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="(416) 555-0134"
                        value={field.value ?? ''}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(event) => {
                          const next = event.target.value
                          field.onChange(next.length === 0 ? undefined : next)
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      Only needed if you would rather we called or texted.
                    </FormDescription>
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
                    <FormLabel>How should we reach you?</FormLabel>
                    <Select
                      value={field.value ?? 'EMAIL'}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Email" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CONTACT_METHOD_OPTIONS.map((option) => (
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

              <FormField
                control={form.control}
                name="householdSize"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>People in the household</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        numeric
                        min={1}
                        max={MAX_HOUSEHOLD_SIZE}
                        step={1}
                        inputMode="numeric"
                        placeholder="4"
                        value={field.value === undefined ? '' : String(field.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(event) => {
                          const raw = event.target.value
                          field.onChange(
                            raw.length === 0 ? undefined : Number(raw)
                          )
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      Everyone who eats at the table, including children.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </section>

          <Separator variant="subtle" />

          <section aria-labelledby="when-suits" className="flex flex-col gap-6">
            <div>
              <h2
                id="when-suits"
                className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
              >
                When suits you
              </h2>
              <p className="mt-3 font-sans text-sm leading-relaxed text-parchment">
                Offer up to {String(MAX_PREFERRED_CONSULTATION_DATES)} times and
                we will confirm one of them. The consultation can be in your
                kitchen or over a call — whichever you prefer.
              </p>
            </div>

            <div className="flex flex-col gap-4">
              {Array.from({ length: slots }, (_, index) => index).map(
                (index) => (
                  <FormField
                    key={index}
                    control={form.control}
                    name={`preferredDates.${index}`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required={index === 0}>
                          {index === 0
                            ? 'First choice'
                            : `Alternative ${String(index)}`}
                        </FormLabel>
                        <div className="flex items-start gap-2">
                          <FormControl>
                            <Input
                              type="datetime-local"
                              value={toDateTimeLocalValue(field.value)}
                              onBlur={field.onBlur}
                              name={field.name}
                              ref={field.ref}
                              onChange={field.onChange}
                            />
                          </FormControl>
                          {index > 0 ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                removeDateSlot(index)
                              }}
                            >
                              <Trash2 aria-hidden="true" />
                              <span className="sr-only">
                                Remove alternative {String(index)}
                              </span>
                            </Button>
                          ) : null}
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )
              )}

              {slots < MAX_PREFERRED_CONSULTATION_DATES ? (
                <div>
                  <Button variant="outline" size="sm" onClick={addDateSlot}>
                    <CalendarPlus aria-hidden="true" />
                    Offer another time
                  </Button>
                </div>
              ) : null}
            </div>

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
                      <SelectTrigger>
                        <SelectValue placeholder="30 minutes" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DURATION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Half an hour is enough for most households.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <Separator variant="subtle" />

          <section aria-labelledby="how-found" className="flex flex-col gap-6">
            <h2
              id="how-found"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              How you came to us
            </h2>

            <FormField
              control={form.control}
              name="source"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>How did you hear about MannaChef?</FormLabel>
                  <Select
                    value={field.value ?? 'WORD_OF_MOUTH'}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Someone told me about you" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SOURCE_OPTIONS.map((option) => (
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
                    <FormLabel required>Tell us how</FormLabel>
                    <FormControl>
                      <Input
                        maxLength={MAX_SOURCE_DETAIL_LENGTH}
                        placeholder="A note in the window at the Wychwood market"
                        value={field.value ?? ''}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(event) => {
                          const next = event.target.value
                          field.onChange(next.length === 0 ? undefined : next)
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
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="MANNA-8XK2"
                        value={field.value ?? ''}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(event) => {
                          const next = event.target.value
                          field.onChange(next.length === 0 ? undefined : next)
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      The code from the household who sent you. Letters, numbers
                      and hyphens.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
          </section>

          <Separator variant="subtle" />

          <section aria-labelledby="anything-else" className="flex flex-col gap-6">
            <h2
              id="anything-else"
              className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
            >
              Anything we should know
            </h2>

            <FormField
              control={form.control}
              name="message"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Your message</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={5}
                      maxLength={MAX_NOTES_LENGTH}
                      placeholder="Two adults and a nine-year-old. One serious tree-nut allergy. We cook two nights a week and would like the other three handled."
                      value={field.value ?? ''}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      onChange={(event) => {
                        const next = event.target.value
                        field.onChange(next.length === 0 ? undefined : next)
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    Allergies, aversions, how many nights a week, anything that
                    would change the answer.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="consentToContact"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <CheckboxField
                      label="You may contact me about this enquiry"
                      description="We use your details to answer this enquiry and nothing else. No newsletter, no list, no third party."
                      checked={field.value === true}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true)
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>
        </fieldset>

        <FormRootError />

        <div className="flex flex-wrap items-center gap-4">
          <Button
            type="submit"
            variant="champagne"
            size="lg"
            loading={isPending}
            loadingLabel="Sending your enquiry…"
          >
            Request a consultation
          </Button>
          <p className="font-sans text-xs leading-relaxed text-stone">
            No charge, no obligation.
          </p>
        </div>

        <FormStatus>{statusMessage}</FormStatus>
      </form>
    </Form>
  )
}
