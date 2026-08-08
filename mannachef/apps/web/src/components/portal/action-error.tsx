// mannachef/apps/web/src/components/portal/action-error.tsx

/**
 * How a *read* that failed is rendered on a portal page.
 *
 * Mutations report through `useAction`, which owns the toast and the inline
 * form error. Reads have no form and no toast: a page component awaits an
 * action, gets `{ ok: false }`, and has to put something on the screen. This is
 * that something.
 *
 * ## Why the titles are declared here rather than imported
 *
 * `ACTION_ERROR_TITLES` lives in `@/lib/action-client`, which carries
 * `'use client'`. Every export of a client module is a *client reference* when
 * it is imported from a Server Component — reading it as a plain object during
 * a server render does not work. So the seven codes get a second, server-side
 * table, typed as `Record<ActionErrorCode, …>` so that a code added to the
 * union is a compile error here rather than an unlabelled panel.
 *
 * The wording differs from the toast's on purpose. A toast interrupts something
 * the guest just did; this panel explains why a section of a page they merely
 * opened is empty, and the two want different sentences.
 */

import type * as React from 'react'
import { AlertTriangle, Lock, SearchX, Timer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { EmptyState } from '@/components/ui/empty-state'
import type { ActionErrorCode } from '@/server/actions/types'

interface FailurePresentation {
  readonly title: string
  readonly icon: LucideIcon
}

const PRESENTATION: Readonly<Record<ActionErrorCode, FailurePresentation>> = {
  UNAUTHENTICATED: { title: 'Please sign in again', icon: Lock },
  FORBIDDEN: { title: 'This is not yours to see', icon: Lock },
  VALIDATION: { title: 'We could not read that request', icon: AlertTriangle },
  NOT_FOUND: { title: 'There is nothing here yet', icon: SearchX },
  CONFLICT: { title: 'Something changed first', icon: AlertTriangle },
  RATE_LIMITED: { title: 'One moment', icon: Timer },
  INTERNAL: { title: 'We could not load this', icon: AlertTriangle },
}

export interface ActionErrorProps {
  readonly code: ActionErrorCode
  /** The sentence the action wrote for a guest. Always shown as given. */
  readonly error: string
  /** What the panel is standing in for — "your invoices", "your appointments". */
  readonly subject: string
  readonly headingLevel?: 2 | 3 | 4
}

/**
 * A failed read, named by its code.
 *
 * A `FORBIDDEN` says it is not the caller's to see; a `RATE_LIMITED` says to
 * wait; an `INTERNAL` says we could not load it. None of them says "something
 * went wrong", which tells a guest nothing about whether trying again is worth
 * their time.
 */
export function ActionError({
  code,
  error,
  subject,
  headingLevel = 3,
}: ActionErrorProps): React.JSX.Element {
  const presentation = PRESENTATION[code]

  return (
    <EmptyState
      tone="error"
      size="sm"
      icon={presentation.icon}
      headingLevel={headingLevel}
      title={`${presentation.title} — ${subject}`}
      description={error}
    />
  )
}
