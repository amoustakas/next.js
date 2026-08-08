// mannachef/apps/web/src/components/ui/separator.tsx
'use client'

import * as React from 'react'
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * A divider.
 *
 * `hairline` is the gold gradient rule from CONTRACT.md §3 — a 1px line that
 * fades to transparent at both ends. It is an accent, so it counts against the
 * one-champagne-per-group budget; the plain `default` is what most dividers
 * should be.
 *
 * `decorative` defaults to `true`, which removes the element from the
 * accessibility tree. Pass `decorative={false}` only when the rule genuinely
 * separates two groups a screen-reader user needs to be told apart.
 */
const separatorVariants = cva('shrink-0 border-0', {
  variants: {
    variant: {
      default: 'bg-ash',
      subtle: 'bg-ash/60',
      hairline: 'bg-transparent',
    },
    orientation: {
      horizontal: 'h-px w-full',
      vertical: 'h-full w-px',
    },
  },
  compoundVariants: [
    {
      variant: 'hairline',
      orientation: 'horizontal',
      class:
        'bg-gradient-to-r from-transparent via-gold/70 to-transparent',
    },
    {
      variant: 'hairline',
      orientation: 'vertical',
      class:
        'bg-gradient-to-b from-transparent via-gold/70 to-transparent',
    },
  ],
  defaultVariants: {
    variant: 'default',
    orientation: 'horizontal',
  },
})

export interface SeparatorProps
  extends React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>,
    Omit<VariantProps<typeof separatorVariants>, 'orientation'> {}

export const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  SeparatorProps
>(function Separator(
  { className, orientation = 'horizontal', decorative = true, variant, ...props },
  ref
) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(separatorVariants({ variant, orientation }), className)}
      {...props}
    />
  )
})

export { separatorVariants }
