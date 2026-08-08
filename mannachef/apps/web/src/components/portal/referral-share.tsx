// mannachef/apps/web/src/components/portal/referral-share.tsx
'use client'

/**
 * The share affordances for one invitation code.
 *
 * Three ways out of the browser and no more: the code itself on the clipboard,
 * the invitation link on the clipboard, and the platform share sheet where the
 * device has one.
 *
 * ## Why the clipboard buttons announce
 *
 * A copy button that changes its own label to "Copied" tells a sighted user
 * what happened and tells nobody else. Every copy here writes into a polite
 * live region as well as flipping the icon, so the confirmation is heard as
 * well as seen — and the region is mounted from the first render rather than
 * inserted with its text, which is the difference between an announcement and
 * silence.
 *
 * ## Why `navigator.share` is behind a capability check made after mount
 *
 * `navigator.share` does not exist on the server and is absent on most
 * desktops. Reading it during render would produce markup the client could not
 * match; so the button is rendered only once an effect has confirmed the
 * capability, which is a hydration-safe way to ask.
 *
 * ## What this component does not do
 *
 * It states no terms. The reward, the cap and the expiry are the programme's,
 * they are rendered by the page from the code's own server-set columns, and
 * nothing here can change any of them.
 */

import * as React from 'react'
import { Check, Copy, Share2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface ReferralShareProps {
  readonly code: string
  /** Absolute invitation URL, built on the server from the site origin. */
  readonly invitationUrl: string
  /** `false` once the code is spent, expired, or withdrawn. */
  readonly isRedeemable: boolean
}

type CopyTarget = 'code' | 'link'

export function ReferralShare({
  code,
  invitationUrl,
  isRedeemable,
}: ReferralShareProps): React.JSX.Element {
  const [copied, setCopied] = React.useState<CopyTarget | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const [canShare, setCanShare] = React.useState(false)
  const codeInputId = React.useId()
  const linkInputId = React.useId()

  React.useEffect(() => {
    setCanShare(typeof navigator.share === 'function')
  }, [])

  React.useEffect(() => {
    if (copied === null) {
      return
    }

    const timer = window.setTimeout(() => {
      setCopied(null)
    }, 2000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [copied])

  const copy = React.useCallback(
    async (target: CopyTarget, value: string, spoken: string) => {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(target)
        setAnnouncement(`${spoken} copied to the clipboard.`)
      } catch {
        // Clipboard access can be refused outright — an insecure origin, a
        // permission the guest declined. Both inputs are readonly rather than
        // disabled precisely so that selecting the text by hand still works,
        // and that is what the announcement points at.
        setAnnouncement(
          `We could not reach the clipboard. Select the ${spoken.toLowerCase()} and copy it by hand.`
        )
      }
    },
    []
  )

  const share = React.useCallback(async () => {
    try {
      await navigator.share({
        title: 'An invitation to MannaChef',
        text: `Use my code ${code} when you ask MannaChef for a consultation.`,
        url: invitationUrl,
      })
      setAnnouncement('Invitation shared.')
    } catch {
      // A dismissed share sheet rejects, and a dismissal is not a failure
      // worth telling anybody about.
      setAnnouncement('')
    }
  }, [code, invitationUrl])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor={codeInputId}>Your code</Label>
        <div className="flex gap-2">
          <Input
            id={codeInputId}
            readOnly
            value={code}
            className="font-mono text-lg tracking-[0.2em] uppercase"
            onFocus={(event) => {
              event.target.select()
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void copy('code', code, 'Your code')
            }}
          >
            {copied === 'code' ? (
              <Check aria-hidden="true" className="size-4 text-sage-ink" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
            <span className="sr-only sm:not-sr-only sm:ml-2">Copy code</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={linkInputId}>The invitation link</Label>
        <div className="flex gap-2">
          <Input
            id={linkInputId}
            readOnly
            value={invitationUrl}
            onFocus={(event) => {
              event.target.select()
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void copy('link', invitationUrl, 'The invitation link')
            }}
          >
            {copied === 'link' ? (
              <Check aria-hidden="true" className="size-4 text-sage-ink" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
            <span className="sr-only sm:not-sr-only sm:ml-2">Copy link</span>
          </Button>
        </div>
        <p className="font-sans text-xs leading-relaxed text-stone">
          The link opens the consultation questionnaire with your code already
          filled in, so whoever you send it to has nothing to remember.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {canShare ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void share()
            }}
          >
            <Share2 aria-hidden="true" className="mr-2 size-4" />
            Share it
          </Button>
        ) : null}

        <Button asChild variant="ghost">
          <a
            href={`mailto:?subject=${encodeURIComponent(
              'An invitation to MannaChef'
            )}&body=${encodeURIComponent(
              `I thought of you. Use my code ${code} when you ask MannaChef for a consultation: ${invitationUrl}`
            )}`}
          >
            Write an email
          </a>
        </Button>
      </div>

      {isRedeemable ? null : (
        <p className="rounded-md border border-ash bg-charcoal/60 px-3 py-2 font-sans text-xs leading-relaxed text-parchment">
          This code can no longer be redeemed — it has expired, reached its
          limit, or been withdrawn. Anyone who has already used it keeps their
          place; new invitations will need a new code.
        </p>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
