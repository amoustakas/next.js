// mannachef/apps/web/src/components/portal/request-referral-code-form.tsx
'use client'

/**
 * "Issue me an invitation code."
 *
 * ## Why a form this small still has a schema
 *
 * Because the *payload* is not small. `referralCodeCreateSchema` is a
 * discriminated union over `rewardType`, and every arm requires a reward value
 * alongside it — the shape exists so that a measure and its figure can never
 * travel apart.
 *
 * A subscriber, though, does not set either. `createReferralCode` reads the
 * seven money-bearing fields off the standing `ReferralProgram` for anybody
 * below `ADMIN` and **discards the payload's**, silently and deliberately: "the
 * form a subscriber submits legitimately renders the offer's figures back to
 * us, so refusing the request would break the ordinary case in order to scold
 * the hostile one."
 *
 * So this form renders one field — the label — and sends the rest as the
 * minimum the schema will accept. `rewardValueCents: 1` is not a proposal; it
 * is one cent because `rewardCentsSchema` will not take zero and because
 * whatever is sent is thrown away before a row is written. Presenting the
 * reward as an input would be presenting the subscriber with a decision they do
 * not have.
 *
 * The terms themselves are rendered by the page from the code's own columns
 * once it exists, which are the programme's figures as the server wrote them.
 *
 * ## The refusals worth naming
 *
 * `CONFLICT` here means one of two things and the action's own sentence says
 * which: either the standing programme has no live offer to issue against, or —
 * on a hand-chosen code — the string is taken. `RATE_LIMITED` means the minting
 * bucket is empty, which is a real limit with a real reason, so it gets a real
 * sentence rather than "try again".
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { Sparkles } from 'lucide-react'

import {
  referralCodeCreateSchema,
  type ReferralCodeCreateInput,
  type ReferralCodeCreateRawInput,
} from '@mannachef/validators'

import { Button } from '@/components/ui/button'
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
import { useAction } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { createReferralCode } from '@/server/actions/referral'

export interface RequestReferralCodeFormProps {
  /** The signed-in account. Re-checked against the session inside the action. */
  readonly ownerId: string
}

/**
 * The placeholder the action discards. One cent, because `rewardCentsSchema`
 * refuses zero and because the value never reaches a column.
 */
const DISCARDED_REWARD_CENTS = 1

export function RequestReferralCodeForm({
  ownerId,
}: RequestReferralCodeFormProps): React.JSX.Element {
  const router = useRouter()

  const form = useForm<
    ReferralCodeCreateRawInput,
    unknown,
    ReferralCodeCreateInput
  >({
    resolver: zodResolver(referralCodeCreateSchema),
    defaultValues: {
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: DISCARDED_REWARD_CENTS,
      ownerId,
      isActive: true,
    },
    mode: 'onBlur',
  })

  const { execute, isPending, statusMessage, failure } = useAction(
    createReferralCode,
    {
      form,
      knownFieldPaths: ['label', 'code'],
      successMessage: 'Your invitation code is ready.',
      errorMessages: {
        RATE_LIMITED:
          'You have asked for several codes in a short time, so this one has been held back. One invitation code is normally all anybody needs — try again shortly if you really do want another.',
      },
      onSuccess: () => {
        form.reset()
        router.refresh()
      },
    }
  )

  return (
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
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name it, if you like</FormLabel>
              <FormControl>
                <Input
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  placeholder="For the book club"
                  className="sm:max-w-sm"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={(event) => {
                    const next = event.target.value

                    field.onChange(next === '' ? undefined : next)
                  }}
                />
              </FormControl>
              <FormDescription>
                Only you see this. It is useful if you end up with more than
                one code and want to remember which is which.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />

        {failure === null ? null : (
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
        )}

        <FormStatus>{statusMessage}</FormStatus>

        <div>
          <Button
            type="submit"
            variant="champagne"
            loading={isPending}
            loadingLabel="Minting your code…"
          >
            <Sparkles aria-hidden="true" className="mr-2 size-4" />
            Issue my invitation code
          </Button>
        </div>
      </form>
    </Form>
  )
}
