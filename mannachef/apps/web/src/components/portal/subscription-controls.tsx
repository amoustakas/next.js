// mannachef/apps/web/src/components/portal/subscription-controls.tsx
'use client'

/**
 * Pause, resume, cancel, and change plan — the four moves a subscriber may make
 * on their own, all four through the one `changeSubscription` action and its
 * one discriminated union.
 *
 * ## What this component deliberately does not offer
 *
 * **No proration control, and no "when should this take effect" control.**
 *
 * `subscriptionChangeSchema` accepts `prorationBehavior` and `effectiveAt` on
 * both plan arms, and below `ADMIN` the action **discards both** —
 * `resolveSubscriptionChangeTerms` replaces them with the house's terms and
 * only logs that a substitution happened. A select box offering
 * "Don't charge me the difference" would therefore be a control that does
 * nothing, on a page about money, which is worse than no control at all: the
 * subscriber would believe they had chosen something.
 *
 * `quantity` is in the same position and is likewise absent — the action keeps
 * whatever the subscription already carries for anybody below `ADMIN`.
 *
 * What replaces those controls is a plain statement of the terms the house
 * applies, taken from the action's own rules:
 *
 *  - an upgrade lands **at once** and the difference for the rest of the period
 *    **is** prorated and billed;
 *  - a downgrade waits for the **end of the period already paid for**, and
 *    nothing is prorated.
 *
 * Saying it is honest. Offering a switch that flips nothing is not.
 *
 * ## Why the direction is derived rather than chosen
 *
 * `UPGRADE` and `DOWNGRADE` are separate arms of the union, and the action
 * refuses an `UPGRADE` to a cheaper plan outright — the direction "is not
 * cosmetic: it selects the proration and timing defaults the schema applies".
 * So the component compares the two prices and sends the arm that matches,
 * rather than asking the subscriber to classify their own move and then failing
 * them for getting it wrong.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { ArrowUpDown, Ban, Pause, Play } from 'lucide-react'

import {
  subscriptionChangeSchema,
  type SubscriptionChangeInput,
  type SubscriptionChangeRawInput,
  type SubscriptionStatus,
} from '@mannachef/validators'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Money } from '@/components/ui/money'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAction, type DescribedActionFailure } from '@/lib/action-client'
import { toLocalDateTimeInputValue } from '@/lib/local-datetime'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { changeSubscription } from '@/server/actions/billing'

// =============================================================================
// 1. Props
// =============================================================================

/** A plan the subscriber could move to. */
export interface PlanOption {
  readonly id: string
  readonly name: string
  readonly priceCents: number
  readonly currency: string
  readonly mealsPerWeek: number
  readonly servingsPerMeal: number
}

export interface SubscriptionControlsProps {
  readonly subscriptionId: string
  readonly status: SubscriptionStatus
  readonly currentPlanId: string
  readonly currentPlanPriceCents: number
  readonly cancelAtPeriodEnd: boolean
  /** Every active plan except the one this subscription is already on. */
  readonly planOptions: readonly PlanOption[]
}

// =============================================================================
// 2. Shared bits
// =============================================================================

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
    </div>
  )
}

/** Six months from now, which is the ceiling `subscriptionChangeSchema` sets. */
const MAX_PAUSE_MS = 180 * 24 * 60 * 60 * 1000

function defaultPauseUntil(): string {
  return toLocalDateTimeInputValue(
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  )
}

function latestPauseUntil(): string {
  return toLocalDateTimeInputValue(new Date(Date.now() + MAX_PAUSE_MS))
}

// =============================================================================
// 3. The controls
// =============================================================================

export function SubscriptionControls({
  subscriptionId,
  status,
  currentPlanId,
  currentPlanPriceCents,
  cancelAtPeriodEnd,
  planOptions,
}: SubscriptionControlsProps): React.JSX.Element {
  const router = useRouter()
  const [openDialog, setOpenDialog] = React.useState<
    'pause' | 'cancel' | 'plan' | null
  >(null)

  const form = useForm<
    SubscriptionChangeRawInput,
    unknown,
    SubscriptionChangeInput
  >({
    resolver: zodResolver(subscriptionChangeSchema),
    defaultValues: { action: 'PAUSE', subscriptionId },
    mode: 'onBlur',
  })

  const { execute, isPending, statusMessage, failure, reset } = useAction(
    changeSubscription,
    {
      form,
      knownFieldPaths: [
        'action',
        'subscriptionId',
        'planId',
        'pausedUntil',
        'resumeAt',
        'cancelAtPeriodEnd',
        'cancelAt',
        'cancellationReason',
        'reason',
      ],
      onSuccess: () => {
        setOpenDialog(null)
        router.refresh()
      },
    }
  )

  /** Open a dialog with the union arm it is about already selected. */
  const openWith = React.useCallback(
    (
      dialog: 'pause' | 'cancel' | 'plan',
      values: SubscriptionChangeRawInput
    ) => {
      reset()
      form.reset(values)
      setOpenDialog(dialog)
    },
    [form, reset]
  )

  const closeDialog = React.useCallback(() => {
    setOpenDialog(null)
    reset()
  }, [reset])

  /** Resume needs no dialog: there is nothing to ask. */
  const resumeNow = React.useCallback(() => {
    void execute({ action: 'RESUME', subscriptionId })
  }, [execute, subscriptionId])

  const selectedPlanId = form.watch('planId')
  const selectedPlan =
    typeof selectedPlanId === 'string'
      ? (planOptions.find((plan) => plan.id === selectedPlanId) ?? null)
      : null
  const isUpgrade =
    selectedPlan !== null && selectedPlan.priceCents > currentPlanPriceCents

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {status === 'PAUSED' ? (
          <Button
            type="button"
            variant="champagne"
            loading={isPending && openDialog === null}
            loadingLabel="Resuming your service…"
            onClick={resumeNow}
          >
            <Play aria-hidden="true" className="mr-2 size-4" />
            Resume service
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              openWith('pause', {
                action: 'PAUSE',
                subscriptionId,
                pausedUntil: defaultPauseUntil(),
              })
            }}
          >
            <Pause aria-hidden="true" className="mr-2 size-4" />
            Pause for a while
          </Button>
        )}

        {planOptions.length === 0 ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              openWith('plan', {
                action: 'UPGRADE',
                subscriptionId,
                planId: currentPlanId,
              })
            }}
          >
            <ArrowUpDown aria-hidden="true" className="mr-2 size-4" />
            Change plan
          </Button>
        )}

        {cancelAtPeriodEnd ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              openWith('cancel', {
                action: 'CANCEL',
                subscriptionId,
                cancelAtPeriodEnd: true,
              })
            }}
          >
            <Ban aria-hidden="true" className="mr-2 size-4" />
            Cancel
          </Button>
        )}
      </div>

      {/* The live region and the persistent failure for the dialogless
          "Resume" path, which has no form of its own to render them in. */}
      {openDialog === null ? (
        <>
          <FailurePanel failure={failure} />
          <FormStatus>{statusMessage}</FormStatus>
        </>
      ) : null}

      <Form {...form}>
        {/* ---- Pause ------------------------------------------------- */}
        <Dialog
          open={openDialog === 'pause'}
          onOpenChange={(next) => {
            if (!next) {
              closeDialog()
            }
          }}
        >
          {/*
            No `<DialogTrigger>`: all three dialogs are opened from the row of
            buttons above, which also seeds the form with the union arm the
            dialog is about. Radix still restores focus to whatever was focused
            before the dialog mounted, so the trigger-less form keeps the same
            focus behaviour a trigger would have given it.
          */}
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rest your subscription</DialogTitle>
              <DialogDescription>
                We stop collecting and stop cooking until the date you choose.
                Nothing is cancelled, and you keep your plan and its price.
              </DialogDescription>
            </DialogHeader>

            <form
              onSubmit={form.handleSubmit((values) => {
                void execute(values)
              })}
              noValidate
              className="flex flex-col gap-5"
            >
              <FormField
                control={form.control}
                name="pausedUntil"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Resume on</FormLabel>
                    <FormControl>
                      <Input
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        type="datetime-local"
                        max={latestPauseUntil()}
                        value={toLocalDateTimeInputValue(field.value)}
                        onChange={(event) => {
                          field.onChange(event.target.value)
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      A subscription may rest for up to six months. Beyond that,
                      cancel and rejoin when you are ready.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Anything we should know?</FormLabel>
                    <FormControl>
                      <Textarea
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        rows={2}
                        placeholder="We are travelling until the autumn."
                        value={typeof field.value === 'string' ? field.value : ''}
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

              <FormRootError />
              <FailurePanel failure={failure} />
              <FormStatus>{statusMessage}</FormStatus>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeDialog}
                  disabled={isPending}
                >
                  Never mind
                </Button>
                <Button
                  type="submit"
                  variant="champagne"
                  loading={isPending}
                  loadingLabel="Pausing…"
                >
                  Pause my subscription
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* ---- Change plan ------------------------------------------- */}
        <Dialog
          open={openDialog === 'plan'}
          onOpenChange={(next) => {
            if (!next) {
              closeDialog()
            }
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Change your plan</DialogTitle>
              <DialogDescription>
                Choose the plan you would like instead. We work out whether that
                is a step up or a step down from the price, and apply the house
                terms below.
              </DialogDescription>
            </DialogHeader>

            <form
              onSubmit={form.handleSubmit((values) => {
                void execute(values)
              })}
              noValidate
              className="flex flex-col gap-5"
            >
              <FormField
                control={form.control}
                name="planId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>New plan</FormLabel>
                    <Select
                      value={typeof field.value === 'string' ? field.value : ''}
                      onValueChange={(value) => {
                        field.onChange(value)

                        const target = planOptions.find(
                          (plan) => plan.id === value
                        )

                        // The arm decides the terms, so it is set from the
                        // prices rather than asked for.
                        form.setValue(
                          'action',
                          target !== undefined &&
                            target.priceCents > currentPlanPriceCents
                            ? 'UPGRADE'
                            : 'DOWNGRADE'
                        )
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a plan" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {planOptions.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {`${plan.name} — ${String(
                              plan.mealsPerWeek
                            )} meals a week`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedPlan === null ? null : (
                <div className="rounded-md border border-ash bg-charcoal/60 px-4 py-3">
                  <p className="font-sans text-sm text-linen">
                    <Money
                      cents={selectedPlan.priceCents}
                      currency={selectedPlan.currency}
                      weight="medium"
                    />
                    <span className="text-stone">
                      {` · ${String(selectedPlan.mealsPerWeek)} meals a week, ${String(
                        selectedPlan.servingsPerMeal
                      )} servings each`}
                    </span>
                  </p>
                  <p className="mt-2 font-sans text-xs leading-relaxed text-parchment">
                    {isUpgrade
                      ? 'This is a step up, so it takes effect at once and the difference for the rest of this period is charged to your card.'
                      : 'This is a step down, so you keep everything the period you have already paid for entitles you to, and the lighter price applies from your next invoice. Nothing is refunded and nothing is charged today.'}
                  </p>
                </div>
              )}

              <FormRootError />
              <FailurePanel failure={failure} />
              <FormStatus>{statusMessage}</FormStatus>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeDialog}
                  disabled={isPending}
                >
                  Stay on my plan
                </Button>
                <Button
                  type="submit"
                  variant="champagne"
                  loading={isPending}
                  loadingLabel="Changing your plan…"
                  disabled={selectedPlan === null}
                >
                  Move to this plan
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* ---- Cancel ------------------------------------------------ */}
        <Dialog
          open={openDialog === 'cancel'}
          onOpenChange={(next) => {
            if (!next) {
              closeDialog()
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel your subscription</DialogTitle>
              <DialogDescription>
                Service continues to the end of the period you have already paid
                for, and then stops. You will not be charged again.
              </DialogDescription>
            </DialogHeader>

            <form
              onSubmit={form.handleSubmit((values) => {
                void execute(values)
              })}
              noValidate
              className="flex flex-col gap-5"
            >
              <FormField
                control={form.control}
                name="cancellationReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Would you tell us why?</FormLabel>
                    <FormControl>
                      <Textarea
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        rows={3}
                        placeholder="We are moving house."
                        value={typeof field.value === 'string' ? field.value : ''}
                        onChange={(event) => {
                          const next = event.target.value

                          field.onChange(next === '' ? undefined : next)
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      Entirely optional, and read by a person rather than
                      counted by a report.
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
                  onClick={closeDialog}
                  disabled={isPending}
                >
                  Keep my subscription
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  loading={isPending}
                  loadingLabel="Cancelling…"
                >
                  Cancel at the end of the period
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </Form>
    </div>
  )
}
