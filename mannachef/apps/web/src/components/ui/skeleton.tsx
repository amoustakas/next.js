// mannachef/apps/web/src/components/ui/skeleton.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * A loading placeholder.
 *
 * The pulse is `motion-safe:` — under `prefers-reduced-motion` the block simply
 * sits at a steady tint rather than breathing, which is both the accessible
 * behaviour and, frankly, the calmer one.
 *
 * A skeleton is decorative. It is `aria-hidden` and the *region* it lives in
 * carries `aria-busy` — see `<SkeletonText>` and `<DataTable>`, both of which
 * announce "Loading…" once rather than letting a screen reader walk twelve
 * empty boxes.
 */
const skeletonVariants = cva(
  'block bg-ash/70 motion-safe:animate-shimmer',
  {
    variants: {
      shape: {
        block: 'rounded-md',
        text: 'h-4 rounded-sm',
        circle: 'rounded-full',
        pill: 'h-5 rounded-full',
      },
    },
    defaultVariants: {
      shape: 'block',
    },
  }
)

export interface SkeletonProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof skeletonVariants> {}

export const Skeleton = React.forwardRef<HTMLSpanElement, SkeletonProps>(
  function Skeleton({ className, shape, ...props }, ref) {
    return (
      <span
        ref={ref}
        aria-hidden="true"
        className={cn(skeletonVariants({ shape }), className)}
        {...props}
      />
    )
  }
)

export interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many lines to draw. */
  lines?: number
  /** Announced once for the whole block. */
  label?: string
}

/**
 * A paragraph-shaped skeleton with a single, honest announcement.
 *
 * The last line is short, because real prose does not end flush.
 */
export const SkeletonText = React.forwardRef<HTMLDivElement, SkeletonTextProps>(
  function SkeletonText(
    { className, lines = 3, label = 'Loading…', ...props },
    ref
  ) {
    const rows = Array.from({ length: Math.max(1, lines) }, (_, index) => index)

    return (
      <div
        ref={ref}
        role="status"
        aria-busy="true"
        aria-live="polite"
        className={cn('flex flex-col gap-2', className)}
        {...props}
      >
        <span className="sr-only">{label}</span>
        {rows.map((index) => (
          <Skeleton
            key={index}
            shape="text"
            className={index === rows.length - 1 && rows.length > 1 ? 'w-2/3' : 'w-full'}
          />
        ))}
      </div>
    )
  }
)

export { skeletonVariants }
