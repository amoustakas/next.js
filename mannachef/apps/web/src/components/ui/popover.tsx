// mannachef/apps/web/src/components/ui/popover.tsx
'use client'

import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'

import { cn } from '@/lib/utils'

/**
 * A non-modal floating panel.
 *
 * Unlike `<Dialog>`, the page behind stays interactive and is not made inert —
 * which is right for a date picker, a filter panel, or a column chooser, and
 * wrong for anything the guest must answer before continuing.
 *
 * Focus still moves into the panel on open and returns to the trigger on close,
 * and Escape still dismisses. Content that needs a name should carry one:
 * `aria-label` on `<PopoverContent>`, or a heading inside it referenced by
 * `aria-labelledby`.
 */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent(
  { className, align = 'center', sideOffset = 6, ...props },
  ref
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-md border border-ash bg-popover p-4 text-popover-foreground',
          'shadow-[inset_0_1px_0_rgba(244,240,233,0.05)]',
          'max-h-(--radix-popover-content-available-height) overflow-y-auto',
          'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})
