// mannachef/apps/web/src/components/marketing/read-failure.tsx
import * as React from 'react'
import { AlertTriangle, Lock, SearchX, Timer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { ActionErrorCode, ActionFailure } from '@/server/actions/types'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * How a *read* that failed is shown on the public site.
 *
 * Every marketing page calls a public server action and every one of those can
 * come back `{ ok: false }`. Rendering "Something went wrong" for all seven
 * `ActionErrorCode` values is the failure mode `CONTRACT.md` §4 and the
 * `useAction` docblock both single out: a `FORBIDDEN` tells the guest to stop, a
 * `RATE_LIMITED` tells them to wait, and an `INTERNAL` tells them to retry.
 * Collapsing the three into one sentence sends two of those three guests back
 * into a loop that cannot terminate.
 *
 * ## Why the titles are restated here rather than imported
 *
 * `ACTION_ERROR_TITLES` lives in `@/lib/action-client`, which carries
 * `'use client'`. Every export of a `'use client'` module is a *client
 * reference*, so reading a plain object out of one inside a Server Component
 * throws at render. The map below is therefore its own declaration — but it is
 * typed `Record<ActionErrorCode, …>`, so adding a code to the union without
 * adding it here is a compile error rather than a `undefined` in the heading.
 *
 * The *sentence* under the title is always `failure.error`, which the server
 * wrote for a guest and which is the only text on screen that knows what
 * actually happened.
 */
const FAILURE_TITLES: Readonly<Record<ActionErrorCode, string>> = {
  UNAUTHENTICATED: 'Please sign in to see this',
  FORBIDDEN: 'This part of the menu is not public',
  VALIDATION: 'That filter did not make sense to us',
  NOT_FOUND: 'We could not find that',
  CONFLICT: 'Something changed while you were reading',
  RATE_LIMITED: 'One moment, please',
  INTERNAL: 'The kitchen is not answering',
}

const FAILURE_ICONS: Readonly<Record<ActionErrorCode, LucideIcon>> = {
  UNAUTHENTICATED: Lock,
  FORBIDDEN: Lock,
  VALIDATION: SearchX,
  NOT_FOUND: SearchX,
  CONFLICT: AlertTriangle,
  RATE_LIMITED: Timer,
  INTERNAL: AlertTriangle,
}

export interface ReadFailureProps {
  /** The failed arm of the `ActionResult`, verbatim. */
  readonly failure: ActionFailure
  /** What could not be read — "the signature dishes", "this dish". */
  readonly subject: string
  /** Heading level, so the page outline stays honest. Default `3`. */
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  readonly className?: string
}

/**
 * A failed read, rendered as itself.
 *
 * ```tsx
 * const result = await listMenuItems({ signatureOnly: true })
 * if (!result.ok) {
 *   return <ReadFailure failure={result} subject="the signature dishes" />
 * }
 * ```
 */
export function ReadFailure({
  failure,
  subject,
  headingLevel = 3,
  className,
}: ReadFailureProps): React.JSX.Element {
  const Icon = FAILURE_ICONS[failure.code]

  return (
    <EmptyState
      tone="error"
      size="md"
      icon={Icon}
      headingLevel={headingLevel}
      title={FAILURE_TITLES[failure.code]}
      description={
        <>
          {failure.error}{' '}
          <span className="text-stone">
            We were trying to load {subject}.
          </span>
        </>
      }
      {...(className === undefined ? {} : { className })}
    />
  )
}
