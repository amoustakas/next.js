// mannachef/apps/web/src/components/portal/appointment-actions.tsx
'use client'

/**
 * The two things a household may do to an engagement on its own: move it, and
 * withdraw it.
 *
 * Both go through the real booking actions, and both exist to render the *real*
 * refusals those actions produce rather than a generic apology.
 *
 * ## The conflict engine's reasons are the point
 *
 * `rescheduleAppointment` re-runs the whole placement evaluation inside a
 * serializable transaction and, when it refuses, packages the engine's verdict
 * as an `ActionFailure` with `code: 'CONFLICT'` — the reasons filed under
 * `fieldErrors.startsAt` (or `travelBufferBeforeMinutes`, or `bookingSlotId`,
 * depending on which rule refused), and any alternative times the engine could
 * suggest appended to the same key as "Try Sat, 15 Feb, 19:00."
 *
 * `useAction` is given this form, so every one of those messages lands under
 * the field the guest has to change, unmodified. Nothing in this component
 * rewrites them, summarises them, or replaces them with "that time is not
 * available" — the engine already wrote a sentence for a guest, and the
 * describing was done server-side where the decision was made.
 *
 * The described failure is *also* rendered as a persistent panel above the
 * submit, because a toast times out and a refusal a guest must act on should
 * not.
 *
 * ## What each dialog refuses to offer
 *
 * The reschedule dialog offers a start, a finish, and the party size — and
 * nothing else. `RESCHEDULE_FORBIDDEN_FIELDS` in `actions/booking.ts` *refuses*
 * a payload carrying the menu, the money, the service type or the kitchen's
 * notes rather than dropping them silently, so a control for any of them would
 * be a control that makes the whole submission fail.
 *
 * The party size is on the allowed side of that line and is worth a word: it is
 * the one of the four that costs money, and changing it away from the figure a
 * quote was made for marks the engagement as needing a re-quote. The dialog
 * says so rather than letting a household discover it on an invoice.
 *
 * ## Focus
 *
 * Both dialogs are Radix `<Dialog>`s, which trap focus while open and restore
 * it to the trigger on close. Nothing here reimplements either behaviour.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { CalendarClock, XCircle } from 'lucide-react'

import { appointmentCancelInputSchema } from '@mannachef/api-contract'
import {
  appointmentUpdateSchema,
  MAX_GUEST_COUNT,
  MIN_GUEST_COUNT,
  type AppointmentStatus,
  type AppointmentStatusTransitionInput,
  type AppointmentStatusTransitionRawInput,
  type AppointmentUpdateInput,
  type AppointmentUpdateRawInput,
} from '@mannachef/validators'

import { NumberField } from '@/components/forms/field-kit'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { Textarea } from '@/components/ui/textarea'
import { useAction, type DescribedActionFailure } from '@/lib/action-client'
import {
  minutesBetween,
  shiftLocalDateTimeInputValue,
  toLocalDateTimeInputValue,
} from '@/lib/local-datetime'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import {
  cancelAppointment,
  rescheduleAppointment,
} from '@/server/actions/booking'

// =============================================================================
// 1. Shared
// =============================================================================

/** Exactly what these dialogs need. Serialisable, so a server page may pass it. */
export interface AppointmentActionTarget {
  readonly id: string
  readonly status: AppointmentStatus
  /** ISO 8601, as the action returned it. */
  readonly startsAt: string
  readonly endsAt: string
  readonly guestCount: number
  /** The party size the money was quoted for, or `null` if nobody has quoted. */
  readonly quotedGuestCount: number | null
}

/** The persistent copy of a failure, beneath the toast and above the button. */
function FailurePanel({
  failure,
}: {
  readonly failure: DescribedActionFailure | null
}): React.JSX.Element | null {
  if (failure === null) {
    return null
  }

  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border px-3 py-2',
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
      {failure.hasFieldErrors ? (
        <p className="mt-1 font-sans text-xs text-stone">
          The detail is under the fields above.
        </p>
      ) : null}
    </div>
  )
}

// =============================================================================
// 2. Moving an engagement
// =============================================================================

export interface RescheduleAppointmentDialogProps {
  readonly appointment: AppointmentActionTarget
}

export function RescheduleAppointmentDialog({
  appointment,
}: RescheduleAppointmentDialogProps): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)

  /** How long the engagement runs now, so moving the start keeps its length. */
  const originalMinutes = React.useMemo(
    () => minutesBetween(appointment.startsAt, appointment.endsAt),
    [appointment.endsAt, appointment.startsAt]
  )

  const form = useForm<
    AppointmentUpdateRawInput,
    unknown,
    AppointmentUpdateInput
  >({
    resolver: zodResolver(appointmentUpdateSchema),
    defaultValues: {
      appointmentId: appointment.id,
      startsAt: toLocalDateTimeInputValue(appointment.startsAt),
      endsAt: toLocalDateTimeInputValue(appointment.endsAt),
      guestCount: appointment.guestCount,
    },
    mode: 'onBlur',
  })

  const { execute, isPending, statusMessage, failure, reset } = useAction(
    rescheduleAppointment,
    {
      form,
      successMessage: 'Your engagement has been moved.',
      knownFieldPaths: ['appointmentId', 'startsAt', 'endsAt', 'guestCount'],
      onSuccess: () => {
        setOpen(false)
        // The action revalidates `/portal/appointments`, but this dialog is
        // mounted on whichever page rendered it — an overview card, say — so
        // the current route is refreshed explicitly rather than assumed.
        router.refresh()
      },
    }
  )

  const guestCount = form.watch('guestCount')
  const quoteWillGoStale =
    appointment.quotedGuestCount !== null &&
    typeof guestCount === 'number' &&
    guestCount !== appointment.quotedGuestCount

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) {
          // A refusal from the last attempt must not be waiting inside the
          // dialog the next time it is opened.
          reset()
          form.reset()
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CalendarClock aria-hidden="true" className="mr-2 size-4" />
          Move
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move this engagement</DialogTitle>
          <DialogDescription>
            Choose a new start and finish. We will re-check the chef&rsquo;s
            diary the moment you send it, and tell you plainly if the new time
            will not work.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => {
              void execute(values)
            })}
            noValidate
            className="flex flex-col gap-5"
          >
            <FormField
              control={form.control}
              name="startsAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>New start</FormLabel>
                  <FormControl>
                    <Input
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      type="datetime-local"
                      value={toLocalDateTimeInputValue(field.value)}
                      onChange={(event) => {
                        const next = event.target.value

                        field.onChange(next)

                        if (next !== '' && originalMinutes > 0) {
                          form.setValue(
                            'endsAt',
                            shiftLocalDateTimeInputValue(next, originalMinutes),
                            { shouldValidate: true }
                          )
                        }
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    Moving the start carries the finish with it, keeping the
                    engagement the same length. Adjust the finish below if you
                    would rather it ran longer or shorter.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="endsAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>New finish</FormLabel>
                  <FormControl>
                    <Input
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      type="datetime-local"
                      value={toLocalDateTimeInputValue(field.value)}
                      onChange={(event) => {
                        field.onChange(event.target.value)
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="guestCount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>How many will be dining?</FormLabel>
                  <FormControl>
                    <NumberField
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value}
                      onValueChange={field.onChange}
                      min={MIN_GUEST_COUNT}
                      max={MAX_GUEST_COUNT}
                      className="sm:max-w-32"
                    />
                  </FormControl>
                  <FormDescription>
                    {quoteWillGoStale
                      ? `This engagement was priced for ${String(
                          appointment.quotedGuestCount
                        )}. Changing the party marks the quote as out of date, and the concierge will send you a new one before we cook.`
                      : 'Change it here if the party has grown or shrunk. The menu, the price and the chef’s notes are amended separately.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormRootError />
            <FailurePanel failure={failure} />
            <FormStatus>{statusMessage}</FormStatus>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false)
                }}
                disabled={isPending}
              >
                Keep it as it is
              </Button>
              <Button
                type="submit"
                variant="champagne"
                loading={isPending}
                loadingLabel="Checking the diary…"
              >
                Move the engagement
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 3. Withdrawing an engagement
// =============================================================================

export interface CancelAppointmentDialogProps {
  readonly appointment: AppointmentActionTarget
}

export function CancelAppointmentDialog({
  appointment,
}: CancelAppointmentDialogProps): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)

  const form = useForm<
    AppointmentStatusTransitionRawInput,
    unknown,
    AppointmentStatusTransitionInput
  >({
    resolver: zodResolver(appointmentCancelInputSchema),
    defaultValues: {
      appointmentId: appointment.id,
      // `from` is the status this browser last saw. The action compares it
      // against the row and refuses on a mismatch, so a colleague who moved the
      // engagement a second ago cannot have their change silently overwritten.
      from: appointment.status,
      to: 'CANCELLED',
      reason: '',
    },
    mode: 'onBlur',
  })

  const { execute, isPending, statusMessage, failure, reset } = useAction(
    cancelAppointment,
    {
      form,
      successMessage: 'The engagement has been withdrawn.',
      knownFieldPaths: ['appointmentId', 'from', 'to', 'reason', 'occurredAt'],
      onSuccess: () => {
        setOpen(false)
        router.refresh()
      },
    }
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) {
          reset()
          form.reset()
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <XCircle aria-hidden="true" className="mr-2 size-4" />
          Withdraw
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw this engagement</DialogTitle>
          <DialogDescription>
            The chef will be told at once and the window will reopen for
            somebody else. If a deposit has been taken, the concierge will be in
            touch about it — this does not refund anything by itself.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => {
              void execute(values)
            })}
            noValidate
            className="flex flex-col gap-5"
          >
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Why are you withdrawing it?</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ''}
                      rows={3}
                      placeholder="We are away that week."
                    />
                  </FormControl>
                  <FormDescription>
                    A line is plenty. It goes to the chef who was expecting you,
                    and nowhere else.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormRootError />
            <FailurePanel failure={failure} />
            <FormStatus>{statusMessage}</FormStatus>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false)
                }}
                disabled={isPending}
              >
                Keep the engagement
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={isPending}
                loadingLabel="Withdrawing…"
              >
                Withdraw it
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
