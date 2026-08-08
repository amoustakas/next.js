// mannachef/apps/web/src/components/ui/badge.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * A small status token.
 *
 * Every variant is a tinted wash behind a hairline border rather than a solid
 * fill — a grid of solid badges would read as a paint chart, and CONTRACT.md §3
 * forbids fully-filled accent surfaces. `champagne` is the one accent variant
 * and counts against the one-champagne-per-group budget.
 *
 * Colour alone never carries the meaning: the badge's text says what it is, so
 * `sage` and `claret` are reinforcement, not information.
 */
const badgeVariants = cva(
  cn(
    'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5',
    'font-sans text-xs leading-5 font-medium whitespace-nowrap',
    "[&_svg:not([class*='size-'])]:size-3 [&_svg]:shrink-0"
  ),
  {
    variants: {
      variant: {
        default: 'border-ash bg-charcoal text-parchment',
        champagne: 'border-gold/50 bg-champagne/10 text-champagne',
        success: 'border-sage/50 bg-sage/12 text-sage',
        warning: 'border-terracotta/50 bg-terracotta/12 text-terracotta',
        destructive: 'border-claret/60 bg-claret/15 text-linen',
        muted: 'border-ash/70 bg-transparent text-stone',
        outline: 'border-stone/50 bg-transparent text-parchment',
      },
      numeric: {
        true: 'tabular-nums',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      numeric: false,
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * A prefix a screen reader hears but nobody sees — "Status: " before
   * "Confirmed", so a badge in a table row is not read as a bare adjective.
   */
  srPrefix?: string
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, numeric, srPrefix, children, ...props },
  ref
) {
  return (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, numeric }), className)}
      {...props}
    >
      {srPrefix === undefined ? null : (
        <span className="sr-only">{srPrefix}</span>
      )}
      {children}
    </span>
  )
})

export { badgeVariants }
