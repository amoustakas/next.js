// mannachef/apps/web/src/components/ui/select.tsx
'use client'

import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * A single-choice select.
 *
 * Radix's listbox is typeahead-navigable, arrow-key operable, and closes on
 * Escape restoring focus to the trigger. It renders into a portal, so a select
 * inside a `<Dialog>` is not clipped by the dialog's own overflow.
 *
 * `Select` is a controlled or uncontrolled Radix root; the pieces below are the
 * styled parts. A form field uses it as:
 *
 * ```tsx
 * <Select value={field.value} onValueChange={field.onChange}>
 *   <FormControl>
 *     <SelectTrigger><SelectValue placeholder="Choose a status" /></SelectTrigger>
 *   </FormControl>
 *   <SelectContent>
 *     <SelectItem value="PROSPECT">Prospect</SelectItem>
 *   </SelectContent>
 * </Select>
 * ```
 */
export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

const selectTriggerVariants = cva(
  cn(
    'flex w-full items-center justify-between gap-2 rounded-md border bg-charcoal px-3',
    'font-sans text-sm text-linen',
    'transition-[border-color] duration-200 ease-luxe',
    'data-[placeholder]:text-stone',
    'disabled:cursor-not-allowed disabled:opacity-50',
    '[&>span]:line-clamp-1 [&>span]:text-left',
    FOCUS_RING
  ),
  {
    variants: {
      invalid: {
        true: 'border-claret/80 focus-visible:ring-claret/40',
        false:
          'border-ash hover:border-stone/60 focus-visible:border-champagne/60',
      },
      triggerSize: {
        sm: 'h-8 text-xs',
        md: 'h-10',
        lg: 'h-12 text-base',
      },
    },
    defaultVariants: {
      invalid: false,
      triggerSize: 'md',
    },
  }
)

export interface SelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
    VariantProps<typeof selectTriggerVariants> {}

export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(function SelectTrigger(
  { className, children, invalid, triggerSize, ...props },
  ref
) {
  const isInvalid =
    invalid ??
    (props['aria-invalid'] === true || props['aria-invalid'] === 'true')

  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        selectTriggerVariants({ invalid: isInvalid, triggerSize }),
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-stone transition-transform duration-200 ease-luxe"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

export const SelectScrollUpButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(function SelectScrollUpButton({ className, ...props }, ref) {
  return (
    <SelectPrimitive.ScrollUpButton
      ref={ref}
      className={cn(
        'flex cursor-default items-center justify-center py-1 text-stone',
        className
      )}
      {...props}
    >
      <ChevronUp aria-hidden="true" className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
})

export const SelectScrollDownButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(function SelectScrollDownButton({ className, ...props }, ref) {
  return (
    <SelectPrimitive.ScrollDownButton
      ref={ref}
      className={cn(
        'flex cursor-default items-center justify-center py-1 text-stone',
        className
      )}
      {...props}
    >
      <ChevronDown aria-hidden="true" className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
})

export const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent(
  { className, children, position = 'popper', ...props },
  ref
) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-32 overflow-hidden',
          'rounded-md border border-ash bg-popover text-popover-foreground',
          'shadow-[inset_0_1px_0_rgba(244,240,233,0.05)]',
          'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})

export const SelectLabel = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn(
        'px-2 py-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase',
        className
      )}
      {...props}
    />
  )
})

export const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2',
        'font-sans text-sm text-linen outline-none select-none',
        'data-[highlighted]:bg-ash data-[highlighted]:text-linen',
        'data-[state=checked]:text-champagne',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="size-4 text-champagne" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
})

export const SelectSeparator = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(function SelectSeparator({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-ash', className)}
      {...props}
    />
  )
})

export { selectTriggerVariants }
