// mannachef/apps/web/src/components/portal/referral-claim-banner.tsx
'use client'

/**
 * "Somebody typed a code against your address. Was it you?"
 *
 * This is the only surface in the portal for `readPendingReferralClaim`,
 * `acceptReferralClaim` and `declineReferralClaim` — the consent gate
 * `@/server/actions/referral-claim` describes at length. Read that file's
 * module docblock before touching this one; every rule below is downstream of
 * it.
 *
 * ## Why Accept and Decline must look like the same decision
 *
 * The claim this card renders is a string an anonymous visitor typed into the
 * public enquiry form. It may be a genuine friend, or it may be a stranger who
 * sprayed this household's address at a code they found online hoping the
 * reward sticks. The server cannot tell the two apart — that is the entire
 * reason this file exists instead of an automatic settlement — so the UI must
 * not tell them apart either. Both buttons are `variant="outline"`, same
 * size, same weight, and neither carries the champagne accent that this
 * design system reserves for "the thing you're meant to click". A household
 * that was never referred has to find "I wasn't referred" exactly as easy to
 * reach as "Accept" — that is the whole point of asking instead of crediting
 * on sight.
 *
 * The one champagne element this card ever shows is the small sparkle beside
 * a *completed* acceptance, after the choice has already been made freely.
 * It celebrates a decision; it never nudges toward one.
 *
 * ## Why this renders `null` so often
 *
 * No claim, a failed read, and a resolved race (`nothing-standing`,
 * `already-answered`) are all, from a household's point of view, "there is
 * nothing here" — CONTRACT.md's own design notes call an empty card that
 * answers none of "is it loading / did something break / am I allowed to see
 * this" worse than no card. A prompt nobody can act on is exactly that empty
 * card, so this component would rather disappear than linger uselessly on a
 * dashboard the household opened to check their next appointment.
 *
 * ## What is, and is not, checked here
 *
 * Nothing. `acceptReferralClaim` and `declineReferralClaim` re-run the full
 * ownership check, the full eligibility predicate, and the tombstone lookup
 * inside `withAction` and their own transactions — CONTRACT.md §5's "never
 * only in the UI" is precisely why this component sends nothing but the code
 * that was rendered and lets the two actions decide everything else,
 * including which of the household's own claims — if the standing column
 * changed underneath — is actually being answered (`superseded`).
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Gift, ShieldAlert, Sparkles, Timer, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { Money } from '@/components/ui/money'
import { useAction } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import {
  acceptReferralClaim,
  declineReferralClaim,
} from '@/server/actions/referral-claim'
import type {
  PendingReferralClaimView,
  ReferralClaimAcceptanceView,
  ReferralClaimAttributionView,
  ReferralClaimDeclineView,
} from '@/server/actions/referral-claim'

export interface ReferralClaimBannerProps {
  /**
   * The result of `readPendingReferralClaim`, already unwrapped by the page.
   * `null` covers every shape of "nothing to ask about" — no claim, a failed
   * read, a lapsed-and-discarded one — and the component renders nothing for
   * every one of them.
   */
  readonly claim: PendingReferralClaimView | null
}

type Outcome =
  | { readonly source: 'accept'; readonly data: ReferralClaimAcceptanceView }
  | { readonly source: 'decline'; readonly data: ReferralClaimDeclineView }

interface OutcomeDisplay {
  readonly icon: LucideIcon
  readonly iconClassName: string
  readonly title: string
  readonly body: React.ReactNode
  /** `superseded`: nothing was consumed, and a fresh read may have something new. */
  readonly showRecheck: boolean
}

// =============================================================================
// 1. Copy
// =============================================================================

/**
 * Who is claiming the credit, exactly as `readPendingReferralClaim`'s own
 * docblock puts it: an unnamed inviter is a case to look at twice, not a gap
 * to paper over with an invented name.
 */
function inviterSentence(inviterDisplayName: string | null): string {
  return inviterDisplayName === null
    ? 'A member who has not given us a name says they referred your household.'
    : `${inviterDisplayName} says they referred your household.`
}

/** The figure this household stands to receive, or the offer's name when none is set. */
function rewardNode(
  attribution: ReferralClaimAttributionView
): React.ReactNode {
  if (attribution.refereeRewardCents === null) {
    return 'the reward set out in our standing referral programme'
  }

  return (
    <Money
      cents={attribution.refereeRewardCents}
      currency={attribution.currency}
      weight="medium"
    />
  )
}

function sharedNothingStanding(): OutcomeDisplay {
  return {
    icon: ShieldAlert,
    iconClassName: 'text-stone',
    title: "There's nothing left to answer.",
    body: 'This invitation is no longer standing on your account. If you were expecting one, ask whoever invited you to send it again.',
    showRecheck: false,
  }
}

function sharedAlreadyAnswered(): OutcomeDisplay {
  return {
    icon: Check,
    iconClassName: 'text-stone',
    title: 'Already answered.',
    body: "You've already told us about this invitation, so there is nothing more to do here.",
    showRecheck: false,
  }
}

function sharedSuperseded(): OutcomeDisplay {
  return {
    icon: ShieldAlert,
    iconClassName: 'text-stone',
    title: 'This has changed since it was shown.',
    body: 'A different invitation is now on file for your household — the one you were just shown is no longer current. Check again to see it.',
    showRecheck: true,
  }
}

/** Render-ready copy for whatever `acceptReferralClaim` or `declineReferralClaim` reported. */
function describeOutcome(outcome: Outcome): OutcomeDisplay {
  if (outcome.source === 'accept') {
    const data = outcome.data

    switch (data.kind) {
      case 'accepted':
        return {
          icon: Sparkles,
          iconClassName: 'text-champagne',
          title: 'Thank you for confirming.',
          body:
            data.refereeRewardCents === null ? (
              "We've recorded the invitation. Your household will receive the standing referral reward once your first booking is billed and paid."
            ) : (
              <>
                We&rsquo;ve recorded the invitation. Your household will receive{' '}
                <Money
                  cents={data.refereeRewardCents}
                  currency={data.currency}
                  weight="medium"
                />{' '}
                once your first booking is billed and paid.
              </>
            ),
          showRecheck: false,
        }

      case 'expired':
        return {
          icon: Timer,
          iconClassName: 'text-stone',
          title: 'That invitation had expired.',
          body: (
            <>
              It was entered on{' '}
              <DateTime value={data.claimedAt} format="date" tone="muted" />,
              which is past the window in which it could be accepted, so nothing
              was credited.
            </>
          ),
          showRecheck: false,
        }

      case 'refused':
        return {
          icon: ShieldAlert,
          iconClassName: 'text-stone',
          title: 'That invitation could not be accepted.',
          body: data.refusal.message,
          showRecheck: false,
        }

      case 'nothing-standing':
        return sharedNothingStanding()

      case 'already-answered':
        return sharedAlreadyAnswered()

      case 'superseded':
        return sharedSuperseded()
    }
  }

  const data = outcome.data

  switch (data.kind) {
    case 'declined':
      return {
        icon: Check,
        iconClassName: 'text-sage',
        title: 'Understood — thank you for telling us.',
        body: "We've cleared that invitation. It will not be offered to you again.",
        showRecheck: false,
      }

    case 'nothing-standing':
      return sharedNothingStanding()

    case 'already-answered':
      return sharedAlreadyAnswered()

    case 'superseded':
      return sharedSuperseded()
  }
}

// =============================================================================
// 2. The card
// =============================================================================

export function ReferralClaimBanner({
  claim,
}: ReferralClaimBannerProps): React.JSX.Element | null {
  const router = useRouter()
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [isRechecking, startRecheck] = React.useTransition()

  const accept = useAction(acceptReferralClaim, {
    silent: true,
    onSuccess: (data) => {
      setOutcome({ source: 'accept', data })
    },
  })

  const decline = useAction(declineReferralClaim, {
    silent: true,
    onSuccess: (data) => {
      setOutcome({ source: 'decline', data })
    },
  })

  const claimCode = claim === null ? null : claim.code

  // A fresh claim — including "nothing at all" — supersedes whatever this
  // card was showing about the previous one. `accept.reset`/`decline.reset`
  // are stable across renders (see `useAction`), so this still only actually
  // re-runs when the claim itself changes.
  React.useEffect(() => {
    setOutcome(null)
    accept.reset()
    decline.reset()
  }, [claimCode, accept.reset, decline.reset])

  if (claim === null) {
    return null
  }

  const isPending = accept.isPending || decline.isPending
  const failure = outcome === null ? (accept.failure ?? decline.failure) : null

  const handleAccept = (): void => {
    void accept.execute({ code: claim.code })
  }

  const handleDecline = (): void => {
    void decline.execute({ code: claim.code })
  }

  // Deliberately does not clear `outcome` itself. A stale "superseded" claim
  // must not flash back into a decision prompt for a claim that is already
  // known to be wrong — it waits for the refreshed server read to hand this
  // component a new (or absent) claim, which the effect above then answers.
  const handleRecheck = (): void => {
    startRecheck(() => {
      router.refresh()
    })
  }

  const display = outcome === null ? null : describeOutcome(outcome)
  const HeaderIcon = display === null ? Gift : display.icon

  return (
    <section aria-labelledby="referral-claim-heading">
      <Card as="article" variant="elevated">
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <HeaderIcon
              aria-hidden="true"
              className={cn('size-4', display?.iconClassName)}
            />
            {display === null
              ? 'An invitation was entered for your household'
              : 'Your answer'}
          </CardDescription>
          <CardTitle id="referral-claim-heading" level={2}>
            {display === null ? 'Were you referred?' : display.title}
          </CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {display === null ? (
            <DecisionBody claim={claim} />
          ) : (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="animate-scale-in flex flex-col gap-3"
            >
              <p className="font-sans text-sm leading-relaxed text-parchment">
                {display.body}
              </p>

              {display.showRecheck ? (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRecheck}
                    loading={isRechecking}
                    loadingLabel="Checking again…"
                  >
                    Check again
                  </Button>
                </div>
              ) : null}
            </div>
          )}

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
        </CardContent>

        {display === null ? (
          <CardFooter className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleAccept}
              loading={accept.isPending}
              loadingLabel="Recording your answer…"
              disabled={isPending}
            >
              <Check aria-hidden="true" className="size-4" />
              Yes, accept it
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleDecline}
              loading={decline.isPending}
              loadingLabel="Recording your answer…"
              disabled={isPending}
            >
              <X aria-hidden="true" className="size-4" />I wasn&rsquo;t referred
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </section>
  )
}

// =============================================================================
// 3. The decision prompt
// =============================================================================

function DecisionBody({
  claim,
}: {
  readonly claim: PendingReferralClaimView
}): React.JSX.Element {
  const standing = claim.standing

  return (
    <div className="flex flex-col gap-4">
      {standing.kind === 'acceptable' ? (
        <p className="font-sans text-sm leading-relaxed text-linen">
          {inviterSentence(standing.attribution.inviterDisplayName)} If you
          accept, your household will receive {rewardNode(standing.attribution)}{' '}
          once your first booking is billed and paid.
        </p>
      ) : standing.kind === 'lapsed' ? (
        <p className="font-sans text-sm leading-relaxed text-parchment">
          This invitation is now past the window in which it can be accepted, so
          accepting it will not credit anything. If it was not you, telling us
          keeps it from being offered again.
        </p>
      ) : (
        <p className="font-sans text-sm leading-relaxed text-parchment">
          {standing.refusal.message} Accepting will not credit anything as
          things stand, but if it was not you, telling us keeps it from being
          offered again.
        </p>
      )}

      {standing.kind === 'acceptable' &&
      standing.attribution.codeExpiresAt !== null ? (
        <p className="font-sans text-xs text-stone">
          This code expires on{' '}
          <DateTime
            value={standing.attribution.codeExpiresAt}
            format="date"
            tone="subtle"
          />
          .
        </p>
      ) : null}

      <p className="font-sans text-xs leading-relaxed text-stone">
        {claim.disclosure}
      </p>
    </div>
  )
}
