// mannachef/apps/web/src/components/ui/checkbox.tsx
'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'

import { cn, FOCUS_RING } from '@/lib/utils'

export interface CheckboxProps
  extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {}

/**
 * A tri-state checkbox.
 *
 * Radix gives it `role="checkbox"`, space-bar operability, and the
 * `aria-checked="mixed"` that `checked="indeterminate"` implies — which is what
 * `<DataTable>`'s select-all uses when some but not all rows are chosen.
 *
 * The champagne fill is the accent, so a row of checkboxes counts as *one*
 * champagne element for the group, not one per box.
 */
export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'peer size-4 shrink-0 rounded-sm border border-ash bg-charcoal',
        'transition-[background-color,border-color] duration-150 ease-luxe',
        'hover:border-stone/70',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-gold data-[state=checked]:bg-champagne data-[state=checked]:text-obsidian',
        'data-[state=indeterminate]:border-gold data-[state=indeterminate]:bg-champagne data-[state=indeterminate]:text-obsidian',
        'aria-invalid:border-claret',
        FOCUS_RING,
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {props.checked === 'indeterminate' ? (
          <Minus aria-hidden="true" className="size-3" strokeWidth={3} />
        ) : (
          <Check aria-hidden="true" className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})

export interface CheckboxFieldProps extends CheckboxProps {
  /** The clickable label text. */
  label: React.ReactNode
  /** Optional helper line under the label. */
  description?: React.ReactNode
  /** Wrapper classes. */
  containerClassName?: string
}

/**
 * A checkbox with its label and description already wired.
 *
 * The whole block is a `<label>`, so the hit area is the text as well as the
 * box — a 16px target is not a target. `description` is joined by
 * `aria-describedby` rather than being left as decorative text beside it.
 */
export const CheckboxField = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  CheckboxFieldProps
>(function CheckboxField(
  { label, description, containerClassName, className, id, ...props },
  ref
) {
  const generatedId = React.useId()
  const checkboxId = id ?? generatedId
  const descriptionId = `${checkboxId}-description`

  return (
    <div className={cn('flex items-start gap-3', containerClassName)}>
      <Checkbox
        ref={ref}
        id={checkboxId}
        className={cn('mt-0.5', className)}
        aria-describedby={description === undefined ? undefined : descriptionId}
        {...props}
      />
      <label htmlFor={checkboxId} className="cursor-pointer select-none">
        <span className="block font-sans text-sm leading-tight font-medium text-linen">
          {label}
        </span>
        {description === undefined ? null : (
          <span
            id={descriptionId}
            className="mt-1 block font-sans text-xs leading-relaxed text-stone"
          >
            {description}
          </span>
        )}
      </label>
    </div>
  )
})
