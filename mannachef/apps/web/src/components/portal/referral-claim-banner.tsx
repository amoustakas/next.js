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
 * ## The question has three true answers, not two
 *
 * The version of this card that shipped with MCV-052 offered two: *accept the
 * standing claim* and *I wasn't referred*. That is the wrong pair, and
 * `verify-referral-preemption.ts` §9 measures why.
 *
 * `recordReferralClaim` is last-writer-wins for as long as the account is an
 * unproved placeholder, so of two anonymous enquiries at one address the
 * **second** is the one this card renders. A household that really was referred,
 * who really did type `GENUINE24` into the enquiry form themselves, and whom a
 * sprayer then followed with `HARVEST24`, opens this card, is asked "were you
 * referred?", and answers — truthfully — *yes*. With two buttons the truthful
 * answer credits the sprayer. "I wasn't referred" is a lie, and pressing it
 * throws away an invitation they actually hold.
 *
 * So there is a third answer, and it is the honest one for that household: **I
 * was given a different code.** It routes to `redeemReferralCode`, the
 * authenticated, separately audited, separately rate-limited door that has
 * always existed for a code a member handed you privately. It does not read the
 * claim column, it does not trust it, and it does not need it. The consent door
 * stays as narrow as it was — it converts the attribution already on file and
 * refuses free-form input — precisely so that the free-form door can be the one
 * that takes free-form input, with its own audit trail.
 *
 * ## Why all three answers look the same, and why the code is on the card
 *
 * The claim this card renders is a string an anonymous visitor typed into the
 * public enquiry form. It may be a genuine friend, or it may be a stranger who
 * sprayed this household's address at a code they found online hoping the
 * reward sticks. The server cannot tell the two apart — that is the entire
 * reason this file exists instead of an automatic settlement — so the UI must
 * not tell them apart either. All three answers are `variant="outline"`, same
 * size, same weight, and none carries the champagne accent that this design
 * system reserves for "the thing you're meant to click". A household that was
 * never referred has to find "I wasn't referred" exactly as easy to reach as
 * "Accept" — that is the whole point of asking instead of crediting on sight —
 * and a household holding a different code has to find that just as easily.
 *
 * The genuine case is still **one click**: Accept is the first control in the
 * row and needs nothing typed. The third answer costs a disclosure and a field,
 * and only the household that needs it pays that.
 *
 * The card also **shows the code**. The version this replaces named the inviter
 * but not the string, which left a household no way to notice that the code on
 * file is not the one written on the card in their hand — the single fact that
 * distinguishes their friend's invitation from a stranger's. A consent prompt
 * that withholds the thing being consented to is not consent. It is stated
 * plainly and without alarm: this is what was entered, this is when, this is who
 * is named, and nobody has checked any of it.
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
 * Nothing. `acceptReferralClaim`, `declineReferralClaim` and
 * `redeemReferralCode` re-run the full ownership check, the full eligibility
 * predicate, and the tombstone lookup inside `withAction` and their own
 * transactions — CONTRACT.md §5's "never only in the UI" is precisely why this
 * component sends nothing but a code and lets the actions decide everything
 * else, including which of the household's own claims — if the standing column
 * changed underneath — is actually being answered (`superseded`). The asserted
 * code in particular is `referralCodeSchema`-shaped here only so the field can
 * say "that is not the shape of a code" without a round trip; the action parses
 * it again, and the action's answer is the one that counts.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import {
  Check,
  Gift,
  KeyRound,
  ShieldAlert,
  Sparkles,
  Timer,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import {
  referralRedemptionCreateSchema,
  type ReferralRedemptionCreateInput,
  type ReferralRedemptionCreateRawInput,
} from '@mannachef/validators'

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
import { useAction } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { redeemReferralCode } from '@/server/actions/referral'
import type { ReferralRedemptionReceipt } from '@/server/actions/referral'
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
  /** The household named a code of their own. `redeemReferralCode`'s receipt. */
  | { readonly source: 'assert'; readonly data: ReferralRedemptionReceipt }

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

/**
 * The reward sentence, shared by an acceptance and an assertion.
 *
 * Both end in the same place — a `PENDING` `ReferralRedemption` that pays when
 * the household's first bill is paid — so both say the same thing about it. A
 * household that reached it through the second door has not bought a worse
 * invitation, and the copy must not imply they have.
 */
function recordedNode(
  refereeRewardCents: number | null,
  currency: string
): React.ReactNode {
  if (refereeRewardCents === null) {
    return 'Your household will receive the standing referral reward once your first booking is billed and paid.'
  }

  return (
    <>
      Your household will receive{' '}
      <Money cents={refereeRewardCents} currency={currency} weight="medium" />{' '}
      once your first booking is billed and paid.
    </>
  )
}

/** Render-ready copy for whatever action the household's answer reached. */
function describeOutcome(outcome: Outcome): OutcomeDisplay {
  if (outcome.source === 'assert') {
    const data = outcome.data

    return {
      icon: Sparkles,
      iconClassName: 'text-champagne',
      title: 'Thank you — we have recorded your invitation.',
      body: (
        <>
          We&rsquo;ve recorded {data.code} as the invitation you were given, and
          cleared the one that was entered on the enquiry form.{' '}
          {recordedNode(data.refereeRewardCents, data.currency)}
        </>
      ),
      showRecheck: false,
    }
  }

  if (outcome.source === 'accept') {
    const data = outcome.data

    switch (data.kind) {
      case 'accepted':
        return {
          icon: Sparkles,
          iconClassName: 'text-champagne',
          title: 'Thank you for confirming.',
          body: (
            <>
              We&rsquo;ve recorded the invitation.{' '}
              {recordedNode(data.refereeRewardCents, data.currency)}
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
  const [isAsserting, setIsAsserting] = React.useState(false)
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

  /**
   * The same action as `decline`, bound separately and deliberately.
   *
   * When the household asserts a code of their own they have told us two
   * things, and this is the second: the string on file is not theirs. Clearing
   * it through the ordinary decline door writes the ordinary tombstone, so the
   * claim is not offered again — but its *outcome* must not reach the card,
   * because the sentence the household is owed is the one about the invitation
   * they just recorded, not the one about the invitation they just discarded.
   * A second binding with no `onSuccess` is how that is said in one place
   * rather than guarded at the two places `decline` writes state.
   */
  const clearStandingClaim = useAction(declineReferralClaim, { silent: true })

  const claimCode = claim === null ? null : claim.code

  // A fresh claim — including "nothing at all" — supersedes whatever this
  // card was showing about the previous one. The `reset` callbacks are stable
  // across renders (see `useAction`), so this still only actually re-runs when
  // the claim itself changes.
  React.useEffect(() => {
    setOutcome(null)
    setIsAsserting(false)
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

  /**
   * `redeemReferralCode` succeeded, so the household holds a real invitation.
   *
   * The standing claim is cleared *after* that, never before: a decline is a
   * tombstone and cannot be taken back, so clearing first would cost a
   * household their standing claim whenever the code they typed turned out to
   * be expired, filled, or mistyped — the exact household this affordance
   * exists for. Its result is not awaited and not rendered; the redemption is
   * already written, and a failure to tidy the column leaves nothing worse than
   * a prompt that reappears and can then be declined on its own.
   */
  const handleAsserted = (receipt: ReferralRedemptionReceipt): void => {
    setOutcome({ source: 'assert', data: receipt })
    void clearStandingClaim.execute({ code: claim.code })
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
            <>
              <DecisionBody claim={claim} />

              {isAsserting ? (
                <AssertOwnCodeForm
                  standingCode={claim.code}
                  disabled={isPending}
                  onRecorded={handleAsserted}
                  onCancel={() => {
                    setIsAsserting(false)
                  }}
                />
              ) : null}
            </>
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
          // Three answers, one weight. See the module docblock: the question
          // "were you referred?" has three true answers and only one of them
          // used to be on this card, which is how a truthful *yes* from a
          // household holding a different code paid a stranger.
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
              onClick={() => {
                setIsAsserting((open) => !open)
              }}
              disabled={isPending}
              aria-expanded={isAsserting}
              aria-controls="referral-claim-assert"
            >
              <KeyRound aria-hidden="true" className="size-4" />I was given a
              different code
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

/**
 * The prompt itself, with the code on it.
 *
 * The string comes first, before the inviter's name and before the figure,
 * because it is the only part of this card the household can check against
 * something they already hold. A name they do not recognise is ambiguous — the
 * friend who invited them may be in our records under a name they have never
 * used. A code is not ambiguous: it is either the one written on the card in
 * their hand or it is not.
 */
function DecisionBody({
  claim,
}: {
  readonly claim: PendingReferralClaimView
}): React.JSX.Element {
  const standing = claim.standing

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="font-sans text-sm leading-relaxed text-parchment">
          This code was entered on an enquiry form for your household on{' '}
          <DateTime value={claim.claimedAt} format="date" tone="muted" />.
        </p>
        <p className="font-mono text-lg tracking-[0.2em] text-linen uppercase">
          {claim.code}
        </p>
      </div>

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

      {/*
        The provenance, stated once and stated flatly. `CLAIM_DISCLOSURE` is
        the server's own sentence — this card does not paraphrase it, so the
        thing the household is told matches the thing the action believes. The
        second sentence is the point of the third button: naming the remedy is
        what keeps the first sentence from being merely ominous.
      */}
      <p className="font-sans text-xs leading-relaxed text-stone">
        {claim.disclosure} If you were referred but given a different code, you
        can enter yours instead.
      </p>
    </div>
  )
}

// =============================================================================
// 4. The third answer
// =============================================================================

/**
 * "I was given a different code."
 *
 * One field, routed to `redeemReferralCode` — the door a household has always
 * had for a code handed to them privately. It is not the consent door and is not
 * a variant of it: the consent door converts the attribution the platform is
 * already holding and refuses free-form input on purpose, so that free-form
 * input arrives at the door that is built, audited and rate limited for it.
 *
 * The two doors cannot both be spent. `redeemReferralCode` and
 * `acceptReferralClaim` end at the same `createReferralRedemption`, and the
 * one-live-redemption-per-household rule is enforced there, so a household that
 * records an invitation here is refused `ALREADY_REFERRED` if they then go back
 * and accept the standing claim. Nothing in this component enforces that, and
 * nothing in this component should — CONTRACT.md §5.
 *
 * `referralRedemptionCreateSchema` also carries an optional `referredUserId`,
 * which this form never sends. Omitting it is what makes the action default to
 * the resolved session's own id; sending one would be asking a client to name
 * the account being credited, which is the shape four rounds of findings were
 * about.
 */
function AssertOwnCodeForm({
  standingCode,
  disabled,
  onRecorded,
  onCancel,
}: {
  /** The claim this answer implicitly rejects. Rendered, never submitted. */
  readonly standingCode: string
  readonly disabled: boolean
  readonly onRecorded: (receipt: ReferralRedemptionReceipt) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const form = useForm<
    ReferralRedemptionCreateRawInput,
    unknown,
    ReferralRedemptionCreateInput
  >({
    resolver: zodResolver(referralRedemptionCreateSchema),
    defaultValues: { code: '' },
    mode: 'onBlur',
  })

  const { execute, isPending, statusMessage } = useAction(redeemReferralCode, {
    form,
    knownFieldPaths: ['code'],
    silent: true,
    errorMessages: {
      RATE_LIMITED:
        'You have entered several codes in a short time, so this one has been held back. Please try again shortly.',
    },
    onSuccess: onRecorded,
  })

  return (
    <Form {...form}>
      <form
        id="referral-claim-assert"
        noValidate
        className="animate-scale-in flex flex-col gap-4 rounded-lg border border-ash bg-charcoal/40 p-4"
        onSubmit={form.handleSubmit((values) => {
          // Only the code. See the docblock on `referredUserId` above.
          void execute({ code: values.code })
        })}
      >
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>The code you were given</FormLabel>
              <FormControl>
                <Input
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  placeholder="TABLE24"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono tracking-[0.15em] uppercase sm:max-w-xs"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(event.target.value)
                  }}
                />
              </FormControl>
              <FormDescription>
                Spacing, hyphens and lower case are all fine. We will record
                this one and clear {standingCode}.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />
        <FormStatus>{statusMessage}</FormStatus>

        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="outline"
            loading={isPending}
            loadingLabel="Recording your invitation…"
            disabled={disabled}
          >
            <KeyRound aria-hidden="true" className="size-4" />
            Record this code
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={isPending || disabled}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  )
}
