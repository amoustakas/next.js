// mannachef/apps/web/src/components/ui/radio-group.tsx
'use client'

import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * A radio group.
 *
 * Radix implements the roving-tabindex pattern the WAI-ARIA radiogroup spec
 * calls for: one tab stop for the whole group, arrow keys to move *and* select
 * within it. That is the behaviour a keyboard user expects and the one a hand
 * rolled set of `<input type="radio">` almost never gets right.
 *
 * The group itself needs a name. Wrap it in `<FormItem>` with a `<FormLabel>`,
 * or pass `aria-label` — an unlabelled radiogroup announces its options with no
 * idea what question they answer.
 */
export const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(function RadioGroup({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Root
      ref={ref}
      className={cn('grid gap-3', className)}
      {...props}
    />
  )
})

export const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'aspect-square size-4 shrink-0 rounded-full border border-ash bg-charcoal',
        'transition-[border-color] duration-150 ease-luxe',
        'hover:border-stone/70',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-gold',
        'aria-invalid:border-claret',
        FOCUS_RING,
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex size-full items-center justify-center">
        <span
          aria-hidden="true"
          className="block size-2 rounded-full bg-champagne"
        />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
})

export interface RadioGroupFieldProps
  extends React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  label: React.ReactNode
  description?: React.ReactNode
  containerClassName?: string
}

/** A radio with its label and description already associated. */
export const RadioGroupField = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupFieldProps
>(function RadioGroupField(
  { label, description, containerClassName, className, id, ...props },
  ref
) {
  const generatedId = React.useId()
  const itemId = id ?? generatedId
  const descriptionId = `${itemId}-description`

  return (
    <div className={cn('flex items-start gap-3', containerClassName)}>
      <RadioGroupItem
        ref={ref}
        id={itemId}
        className={cn('mt-0.5', className)}
        aria-describedby={description === undefined ? undefined : descriptionId}
        {...props}
      />
      <label htmlFor={itemId} className="cursor-pointer select-none">
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
