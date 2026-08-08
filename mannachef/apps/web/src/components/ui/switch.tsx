// mannachef/apps/web/src/components/ui/switch.tsx
'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * An on/off switch.
 *
 * Use it for a setting that takes effect immediately — "publish this dish",
 * "notify me by SMS". A checkbox is the right control for something that only
 * takes effect when the form is submitted; a switch that needs a Save button
 * beside it is a checkbox wearing a costume.
 *
 * The thumb transition is 200 ms on `--ease-luxe` and is inert under
 * `prefers-reduced-motion` via the global rule in `globals.css`.
 */
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border',
        'transition-[background-color,border-color] duration-200 ease-luxe',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'border-ash bg-charcoal',
        'data-[state=checked]:border-gold data-[state=checked]:bg-champagne/85',
        FOCUS_RING,
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-stone ring-0',
          'transition-transform duration-200 ease-luxe',
          'translate-x-0.5 data-[state=checked]:translate-x-[1.125rem]',
          'data-[state=checked]:bg-obsidian'
        )}
      />
    </SwitchPrimitive.Root>
  )
})

export interface SwitchFieldProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label: React.ReactNode
  description?: React.ReactNode
  containerClassName?: string
}

/**
 * A switch with its label to the left, as a settings row.
 *
 * The label is a real `<label>` bound by `htmlFor`, so clicking the text toggles
 * the switch and a screen reader announces the two together.
 */
export const SwitchField = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  SwitchFieldProps
>(function SwitchField(
  { label, description, containerClassName, id, ...props },
  ref
) {
  const generatedId = React.useId()
  const switchId = id ?? generatedId
  const descriptionId = `${switchId}-description`

  return (
    <div
      className={cn(
        'flex items-start justify-between gap-6 py-1',
        containerClassName
      )}
    >
      <label htmlFor={switchId} className="cursor-pointer select-none">
        <span className="block font-sans text-sm leading-tight font-medium text-linen">
          {label}
        </span>
        {description === undefined ? null : (
          <span
            id={descriptionId}
            className="mt-1 block max-w-prose font-sans text-xs leading-relaxed text-stone"
          >
            {description}
          </span>
        )}
      </label>
      <Switch
        ref={ref}
        id={switchId}
        className="mt-0.5"
        aria-describedby={description === undefined ? undefined : descriptionId}
        {...props}
      />
    </div>
  )
})
