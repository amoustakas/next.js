// mannachef/apps/web/src/components/ui/label.tsx
'use client'

import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const labelVariants = cva(
  cn(
    'inline-flex items-center gap-1.5 font-sans text-sm leading-none font-medium',
    'select-none',
    'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
    'group-data-[disabled=true]:cursor-not-allowed group-data-[disabled=true]:opacity-60'
  ),
  {
    variants: {
      tone: {
        default: 'text-linen',
        muted: 'text-parchment',
        invalid: 'text-claret-ink',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  }
)

export interface LabelProps
  extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>,
    VariantProps<typeof labelVariants> {
  /**
   * Append the required marker.
   *
   * The asterisk is `aria-hidden` and paired with visually hidden text, because
   * a screen reader announcing "asterisk" tells a guest nothing — the input's
   * own `required`/`aria-required` is what actually carries the semantics, and
   * this is the visual half of the same fact.
   */
  required?: boolean
}

/**
 * A real `<label>`, always associated with a control.
 *
 * Radix's Label prevents text selection from stealing focus on double-click and
 * forwards clicks to the control even when the control is a Radix widget rather
 * than a native input.
 */
export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  LabelProps
>(function Label({ className, tone, required = false, children, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(labelVariants({ tone }), className)}
      {...props}
    >
      {children}
      {required ? (
        <>
          <span aria-hidden="true" className="text-champagne">
            *
          </span>
          <span className="sr-only">(required)</span>
        </>
      ) : null}
    </LabelPrimitive.Root>
  )
})

export { labelVariants }
