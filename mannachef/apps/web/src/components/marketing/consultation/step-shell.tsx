// mannachef/apps/web/src/components/marketing/consultation/step-shell.tsx
'use client'

/**
 * The chrome every step of the questionnaire shares: the progress rule at the
 * top, the heading and description, and the Back / Continue footer.
 *
 * ## Why the heading takes focus
 *
 * Moving between steps replaces the whole panel without navigating, so nothing
 * moves the caret: a keyboard or screen-reader user pressing "Continue" is left
 * focused on a button that no longer exists, and the browser drops focus to the
 * document. {@link StepShell} therefore focuses its own heading on every step
 * change — the heading is `tabIndex={-1}` so it is programmatically focusable
 * without joining the tab order — which both announces the new step and puts
 * the next Tab press at the top of the new fields rather than back at the site
 * navigation.
 *
 * The focus is deliberately *not* moved on the first render. The guest arrived
 * by scrolling or by following a link; yanking focus into the middle of the
 * page before they have done anything is disorienting.
 *
 * ## Motion
 *
 * The panel fades in with `animate-fade-in`, which is a CSS animation built
 * from the `--duration-*` / `--ease-luxe` tokens. The
 * `@media (prefers-reduced-motion: reduce)` block at the foot of `globals.css`
 * collapses every animation and transition in the document to 0.001 ms, so this
 * component honours the preference without a JavaScript branch of its own.
 */

import * as React from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

// =============================================================================
// 1. Progress
// =============================================================================

export interface WizardProgressProps {
  readonly stepIndex: number
  readonly stepTitles: readonly string[]
}

/**
 * How far through the questionnaire the guest is.
 *
 * The bar carries the champagne accent and is the only accented element in this
 * group, per `CONTRACT.md` §3. The step list beside it is quiet text: the
 * current step is marked with `aria-current="step"` and set in linen, the rest
 * in stone.
 */
export function WizardProgress({
  stepIndex,
  stepTitles,
}: WizardProgressProps): React.JSX.Element {
  const total = stepTitles.length
  const position = Math.min(stepIndex + 1, total)
  const current = stepTitles[stepIndex] ?? stepTitles[total - 1] ?? ''

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-sans text-xs tracking-[0.18em] text-stone uppercase">
          {`Step ${String(position)} of ${String(total)}`}
        </p>
        <p className="font-sans text-xs text-parchment">{current}</p>
      </div>

      <Progress
        label={`Questionnaire progress: step ${String(position)} of ${String(
          total
        )}`}
        value={position}
        max={total}
        size="sm"
        tone="champagne"
      />

      <ol className="hidden flex-wrap gap-x-5 gap-y-1 sm:flex">
        {stepTitles.map((title, index) => (
          <li
            key={title}
            aria-current={index === stepIndex ? 'step' : undefined}
            className={cn(
              'font-sans text-xs',
              index === stepIndex
                ? 'text-linen'
                : index < stepIndex
                  ? 'text-parchment'
                  : 'text-stone'
            )}
          >
            {title}
          </li>
        ))}
      </ol>
    </div>
  )
}

// =============================================================================
// 2. The step panel
// =============================================================================

export interface StepShellProps {
  readonly stepIndex: number
  readonly title: string
  readonly description: string
  readonly children: React.ReactNode
  /** Omitted on the first step, where there is nowhere to go back to. */
  readonly onBack?: (() => void) | undefined
  /** Defaults to "Continue". */
  readonly nextLabel?: string
  /** Puts the primary button in its loading state and blocks a second submit. */
  readonly submitting?: boolean
  /** Rendered between the description and the fields — an intake caution, say. */
  readonly intro?: React.ReactNode
  /** Rendered directly above the footer: form-level errors, live status. */
  readonly beforeFooter?: React.ReactNode
}

/**
 * One step's heading, body, and footer.
 *
 * Rendered *inside* each step's own `<form>`, so "Continue" is a real submit
 * button and Enter in a text field advances the step — which is what a guest
 * filling in a form expects, and what a `<div>`-and-`onClick` wizard never
 * does.
 */
export function StepShell({
  stepIndex,
  title,
  description,
  children,
  onBack,
  nextLabel = 'Continue',
  submitting = false,
  intro,
  beforeFooter,
}: StepShellProps): React.JSX.Element {
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const isFirstRender = React.useRef(true)

  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    headingRef.current?.focus()
  }, [stepIndex])

  return (
    <div className="animate-fade-in flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl leading-tight font-light text-linen sm:text-4xl"
        >
          {title}
        </h2>
        <p className="font-sans text-sm leading-relaxed text-parchment">
          {description}
        </p>
      </header>

      {intro}

      <div className="flex flex-col gap-6">{children}</div>

      {beforeFooter}

      <footer className="flex flex-col-reverse gap-3 border-t border-ash pt-6 sm:flex-row sm:items-center sm:justify-between">
        {onBack === undefined ? (
          <span aria-hidden="true" />
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={submitting}
          >
            <ArrowLeft aria-hidden="true" className="mr-2 size-4" />
            Back
          </Button>
        )}

        <Button
          type="submit"
          variant="champagne"
          size="lg"
          loading={submitting}
          loadingLabel="Sending your questionnaire…"
        >
          {nextLabel}
          <ArrowRight aria-hidden="true" className="ml-2 size-4" />
        </Button>
      </footer>
    </div>
  )
}
