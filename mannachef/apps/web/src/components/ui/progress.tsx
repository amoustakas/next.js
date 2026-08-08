// mannachef/apps/web/src/components/ui/progress.tsx
'use client'

import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const progressVariants = cva(
  'relative w-full overflow-hidden rounded-full border border-ash bg-charcoal',
  {
    variants: {
      size: {
        sm: 'h-1',
        md: 'h-2',
        lg: 'h-3',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
)

const progressIndicatorVariants = cva(
  'h-full w-full flex-1 transition-transform duration-300 ease-luxe',
  {
    variants: {
      tone: {
        champagne: 'bg-gradient-to-r from-gold to-champagne',
        success: 'bg-sage',
        warning: 'bg-terracotta',
        destructive: 'bg-claret',
        neutral: 'bg-stone',
      },
    },
    defaultVariants: {
      tone: 'champagne',
    },
  }
)

export interface ProgressProps
  extends Omit<
      React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
      'value'
    >,
    VariantProps<typeof progressVariants>,
    VariantProps<typeof progressIndicatorVariants> {
  /** Completed amount. `null` renders the indeterminate state. */
  value?: number | null
  /** Total. Defaults to 100, so `value` reads as a percentage. */
  max?: number
  /** Required: a bare bar announces as "progress bar" and nothing else. */
  label: string
  /** Show the numeric percentage beside the bar. */
  showValue?: boolean
}

/**
 * A determinate or indeterminate progress bar.
 *
 * Radix supplies `role="progressbar"` and the `aria-value*` attributes; `label`
 * becomes `aria-label` so the bar says what it is measuring. When `showValue`
 * is on, the percentage is rendered as visible text in `tabular-nums` — a
 * figure that shifts its own width as it counts up is exactly the kind of
 * detail this design system exists to prevent.
 */
export const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(function Progress(
  { className, size, tone, value = null, max = 100, label, showValue = false, ...props },
  ref
) {
  const isIndeterminate = value === null
  const safeMax = max > 0 ? max : 100
  const clamped = isIndeterminate
    ? 0
    : Math.min(Math.max(value, 0), safeMax)
  const percent = isIndeterminate ? 0 : Math.round((clamped / safeMax) * 100)

  return (
    <div className="flex items-center gap-3">
      <ProgressPrimitive.Root
        ref={ref}
        max={safeMax}
        value={isIndeterminate ? null : clamped}
        aria-label={label}
        className={cn(progressVariants({ size }), className)}
        {...props}
      >
        <ProgressPrimitive.Indicator
          className={cn(
            progressIndicatorVariants({ tone }),
            isIndeterminate && 'motion-safe:animate-shimmer'
          )}
          style={{
            transform: isIndeterminate
              ? 'translateX(0)'
              : `translateX(-${String(100 - percent)}%)`,
          }}
        />
      </ProgressPrimitive.Root>
      {showValue && !isIndeterminate ? (
        <span className="w-10 shrink-0 text-right font-sans text-xs tabular-nums text-parchment">
          {percent}%
        </span>
      ) : null}
    </div>
  )
})

export { progressVariants, progressIndicatorVariants }
