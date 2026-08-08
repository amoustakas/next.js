// mannachef/apps/web/src/components/ui/tooltip.tsx
'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

/**
 * A hover/focus hint.
 *
 * ## The accessibility rule this file will not let you break
 *
 * **A tooltip is never the only place information lives.** It appears on hover
 * and on keyboard focus, but not on touch, and a screen-reader user meets it as
 * the trigger's accessible description rather than as content they can navigate
 * into. So: an icon-only button gets a `<span className="sr-only">` label *and*
 * a tooltip. The tooltip repeats the label for sighted mouse users; the
 * `sr-only` text is what actually names the control.
 *
 * `<TooltipProvider>` is mounted once in `app/providers.tsx` with the house
 * delay, so a screen may use `<Tooltip>` directly without nesting another
 * provider.
 */
export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent(
  { className, sideOffset = 6, children, ...props },
  ref
) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-64 rounded-md border border-ash bg-slate-warm px-3 py-1.5',
          'font-sans text-xs leading-relaxed text-linen',
          'shadow-[inset_0_1px_0_rgba(244,240,233,0.05)]',
          'data-[state=delayed-open]:animate-scale-in data-[state=closed]:animate-scale-out',
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-ash" width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
})

export interface HintProps {
  /** The tooltip text. */
  label: React.ReactNode
  /** The element the hint describes. Must be focusable. */
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  className?: string
}

/**
 * The whole tooltip, in one element.
 *
 * ```tsx
 * <Hint label="Withdraw this sitting">
 *   <Button variant="ghost" size="icon">
 *     <Trash2 /><span className="sr-only">Withdraw this sitting</span>
 *   </Button>
 * </Hint>
 * ```
 */
export function Hint({ label, children, side = 'top', align = 'center', className }: HintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} className={className}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
