// mannachef/apps/web/src/components/marketing/consultation/consultation-confirmation.tsx
'use client'

/**
 * What a guest sees once the questionnaire has been accepted.
 *
 * A state on the same page rather than a redirect, for two reasons. The first
 * is that there is nothing to redirect *to*: an anonymous prospect has no
 * account and no record they may read, and `submitProspectIntake` deliberately
 * returns no row identifiers to them (it would otherwise say whether we already
 * held their address). The second is that a redirect throws away the one thing
 * this screen can honestly tell them — the times they offered, which the
 * browser still has and the server will not repeat.
 *
 * So the confirmation states three facts and no more: that it arrived, when it
 * arrived, and which time we will try first. Everything else is a promise about
 * what happens next, phrased as a promise.
 */

import * as React from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DateTime } from '@/components/ui/date-time'
import { Separator } from '@/components/ui/separator'

export interface ConsultationConfirmationProps {
  /** The moment the server recorded. `null` is answered rather than blank. */
  readonly submittedAt: Date | null
  /** The times the guest offered, best first. */
  readonly preferredDates: readonly Date[]
  /** How long the consultation was booked for. */
  readonly durationMinutes: number
  /** Where the reply will go. */
  readonly email: string
  /** `EMAIL` | `PHONE` | `SMS` | `IN_APP`, as chosen on the contact step. */
  readonly preferredContactMethod: string
  /** Whether anything was recorded in the safety-critical field. */
  readonly allergyCount: number
}

const REPLY_ROUTE: Readonly<Record<string, string>> = {
  EMAIL: 'by email',
  PHONE: 'by telephone',
  SMS: 'by text message',
  IN_APP: 'in your portal, once your account is open',
}

export function ConsultationConfirmation({
  submittedAt,
  preferredDates,
  durationMinutes,
  email,
  preferredContactMethod,
  allergyCount,
}: ConsultationConfirmationProps): React.JSX.Element {
  const headingRef = React.useRef<HTMLHeadingElement>(null)

  // The panel replaces the form without a navigation, so nothing would move
  // focus. Announcing the heading is what tells a screen-reader user that the
  // thing they pressed actually worked.
  React.useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const first = preferredDates[0]
  const rest = preferredDates.slice(1)
  const route = REPLY_ROUTE[preferredContactMethod] ?? 'by email'

  return (
    <div className="animate-fade-in flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <span className="inline-flex size-11 items-center justify-center rounded-full border border-gold/70 text-champagne">
          <Check aria-hidden="true" className="size-5" />
        </span>

        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-4xl leading-tight font-light text-linen"
        >
          Thank you — it has reached us.
        </h2>

        <p className="max-w-2xl font-sans text-base leading-relaxed text-parchment">
          Your questionnaire is with the concierge. A chef reads it before we
          reply, so the conversation you have with us will already be about your
          table rather than about ours.
        </p>
      </div>

      <Separator variant="hairline" decorative />

      <dl className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <dt className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
            Received
          </dt>
          <dd className="font-sans text-sm text-linen">
            {submittedAt === null ? (
              'Just now.'
            ) : (
              <DateTime value={submittedAt} format="datetime" />
            )}
          </dd>
        </div>

        {first === undefined ? null : (
          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
              The time we will try first
            </dt>
            <dd className="font-sans text-sm text-linen">
              <DateTime value={first} format="datetime" />
              <span className="text-parchment">
                {` · ${String(durationMinutes)} minutes`}
              </span>
            </dd>
            {rest.length === 0 ? null : (
              <dd className="font-sans text-xs leading-relaxed text-stone">
                {`If that will not do, we will fall back to the ${
                  rest.length === 1 ? 'other time' : 'other times'
                } you offered.`}
              </dd>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <dt className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
            How we will reply
          </dt>
          <dd className="font-sans text-sm text-linen">
            {`We will confirm ${route}. Your enquiry is filed under ${email}.`}
          </dd>
        </div>

        <div className="flex flex-col gap-1">
          <dt className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
            Allergies on file
          </dt>
          <dd className="font-sans text-sm text-linen">
            {allergyCount === 0
              ? 'None recorded. If that is wrong, tell us at the consultation — the kitchen reads this list before it shops.'
              : `${String(allergyCount)} recorded. Every chef who cooks for you will see them, and we will confirm each one aloud at the consultation.`}
          </dd>
        </div>
      </dl>

      <Separator variant="hairline" decorative />

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button asChild variant="outline">
          <Link href="/menu">Read this season&rsquo;s menu</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Back to the beginning</Link>
        </Button>
      </div>

      <p className="font-sans text-xs leading-relaxed text-stone">
        Your draft has been cleared from this browser. If you need to change
        something before we speak, reply to the note we send you and the
        concierge will amend it by hand.
      </p>
    </div>
  )
}
