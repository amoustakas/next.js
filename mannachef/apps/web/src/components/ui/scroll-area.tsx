// mannachef/apps/web/src/components/ui/scroll-area.tsx
'use client'

import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'

import { cn } from '@/lib/utils'

export interface ScrollAreaProps
  extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /** Which bars to render. Default `'vertical'`. */
  orientation?: 'vertical' | 'horizontal' | 'both'
  /** Classes for the inner viewport — put `max-h-*` here, not on the root. */
  viewportClassName?: string
}

/**
 * A scroll container with a styled bar.
 *
 * Radix keeps the viewport natively scrollable, so keyboard scrolling, wheel
 * momentum, and `scroll-into-view` all still work — the custom bar is chrome
 * over real overflow, not a re-implementation of it. `type="hover"` means the
 * bar is invisible until the pointer is inside, which keeps a list of menu
 * items from carrying a permanent grey stripe.
 */
export const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(function ScrollArea(
  { className, children, orientation = 'vertical', viewportClassName, type, ...props },
  ref
) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      type={type ?? 'hover'}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn(
          'size-full rounded-[inherit] [&>div]:!block',
          viewportClassName
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation === 'vertical' || orientation === 'both' ? (
        <ScrollBar orientation="vertical" />
      ) : null}
      {orientation === 'horizontal' || orientation === 'both' ? (
        <ScrollBar orientation="horizontal" />
      ) : null}
      <ScrollAreaPrimitive.Corner className="bg-transparent" />
    </ScrollAreaPrimitive.Root>
  )
})

export const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(function ScrollBar({ className, orientation = 'vertical', ...props }, ref) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors duration-200 ease-luxe',
        orientation === 'vertical' && 'h-full w-2 border-l border-l-transparent p-px',
        orientation === 'horizontal' &&
          'h-2 flex-col border-t border-t-transparent p-px',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-ash hover:bg-stone/70" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
})
