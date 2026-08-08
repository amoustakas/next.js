// mannachef/apps/web/src/components/marketing/reveal.tsx
'use client'

import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

/**
 * The two entrance motions the public site is allowed to use.
 *
 * `<Entrance>` runs once on mount, for what is already above the fold.
 * `<Reveal>` runs when a section scrolls into view, once, and never again.
 *
 * ## Restraint, expressed numerically
 *
 * Both animate opacity and a **12px** rise, over 200–250 ms, on
 * `cubic-bezier(0.16, 1, 0.3, 1)` — the `--ease-luxe` curve and the 150–250 ms
 * band from `CONTRACT.md` §3, restated here because Framer Motion is JavaScript
 * and cannot read a CSS custom property. Nothing scales, nothing rotates,
 * nothing springs. A dining room does not bounce.
 *
 * ## Reduced motion
 *
 * `globals.css` collapses every *CSS* animation under
 * `prefers-reduced-motion: reduce`, and that block has no authority over a
 * JavaScript-driven transform. So the guard is made here: when
 * `useReducedMotion()` is true, `initial` is `false` — the element mounts in its
 * final state with no transition at all, rather than animating quickly. There is
 * no such thing as a "subtle" animation for someone whose vestibular system
 * objects to it.
 *
 * ## Why `data-reveal` is on every element
 *
 * Framer Motion renders `initial` as inline styles during SSR, which means a
 * visitor with JavaScript disabled would be served `opacity: 0` markup and no
 * script to raise it. The marketing layout ships a `<noscript>` rule that
 * targets this attribute and forces every reveal visible. Progressive
 * enhancement, not a promise that the bundle always arrives.
 */
const EASE_LUXE: [number, number, number, number] = [0.16, 1, 0.3, 1]

/** The rise, in pixels. Small enough to read as settling rather than sliding. */
const RISE = 12

export interface RevealProps {
  readonly children: React.ReactNode
  readonly className?: string
  /** Stagger, in seconds. Keep the whole group inside ~0.2s. */
  readonly delay?: number
  /** Rendered element. Use a landmark tag when the reveal *is* the section. */
  readonly as?: 'div' | 'section' | 'li' | 'article'
}

/**
 * Reveals its children the first time they scroll into view.
 *
 * ```tsx
 * <Reveal as="section" delay={0.06}>…</Reveal>
 * ```
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as = 'div',
}: RevealProps): React.JSX.Element {
  const shouldReduceMotion = useReducedMotion() ?? false
  const Component = motion[as]

  return (
    <Component
      data-reveal=""
      className={cn(className)}
      initial={shouldReduceMotion ? false : { opacity: 0, y: RISE }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2, margin: '0px 0px -64px 0px' }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : { duration: 0.25, ease: EASE_LUXE, delay }
      }
    >
      {children}
    </Component>
  )
}

export interface EntranceProps extends RevealProps {}

/**
 * Reveals its children on mount, for content that is already on screen.
 *
 * A `whileInView` reveal on the hero would fire in the same frame anyway, but
 * would leave the first paint blank for the length of one intersection-observer
 * callback. This animates directly instead.
 */
export function Entrance({
  children,
  className,
  delay = 0,
  as = 'div',
}: EntranceProps): React.JSX.Element {
  const shouldReduceMotion = useReducedMotion() ?? false
  const Component = motion[as]

  return (
    <Component
      data-reveal=""
      className={cn(className)}
      initial={shouldReduceMotion ? false : { opacity: 0, y: RISE }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : { duration: 0.25, ease: EASE_LUXE, delay }
      }
    >
      {children}
    </Component>
  )
}
