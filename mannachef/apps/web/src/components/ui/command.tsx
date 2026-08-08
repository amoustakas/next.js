// mannachef/apps/web/src/components/ui/command.tsx
'use client'

import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/**
 * A filterable command list, and the ⌘K palette built on it.
 *
 * cmdk renders a `role="combobox"` input over a `role="listbox"` of options,
 * keeps `aria-activedescendant` pointed at the highlighted item, and moves the
 * selection with the arrow keys while focus stays in the input — which is the
 * correct pattern and the one that makes the palette usable without a mouse.
 *
 * `<CommandDialog>` wraps it in our `<Dialog>`, so it inherits the focus trap
 * and, crucially, focus restoration: dismissing the palette returns the caret
 * to whatever the operator was doing.
 */
export const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground',
        className
      )}
      {...props}
    />
  )
})

export interface CommandDialogProps
  extends React.ComponentPropsWithoutRef<typeof CommandPrimitive> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Announced when the palette opens. Visually hidden. */
  title?: string
  /** Describes what can be typed. Visually hidden. */
  description?: string
}

export function CommandDialog({
  open,
  onOpenChange,
  title = 'Command palette',
  description = 'Search for a page, a client, or an action, then press Enter.',
  children,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className="max-w-xl gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-stone [&_[cmdk-group-heading]]:uppercase"
          {...props}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(function CommandInput({ className, ...props }, ref) {
  return (
    <div className="flex items-center gap-3 border-b border-ash px-4">
      <Search aria-hidden="true" className="size-4 shrink-0 text-stone" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'flex h-12 w-full bg-transparent font-sans text-sm text-linen outline-none',
          'placeholder:text-stone disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    </div>
  )
})

export const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn('max-h-80 overflow-x-hidden overflow-y-auto p-1', className)}
      {...props}
    />
  )
})

export const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(function CommandEmpty({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Empty
      ref={ref}
      className={cn(
        'py-8 text-center font-sans text-sm text-stone',
        className
      )}
      {...props}
    />
  )
})

export const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn('overflow-hidden p-1 text-linen', className)}
      {...props}
    />
  )
})

export const CommandSeparator = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function CommandSeparator({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-ash', className)}
      {...props}
    />
  )
})

export const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default items-center gap-3 rounded-sm px-3 py-2',
        'font-sans text-sm text-linen outline-none select-none',
        'transition-colors duration-150 ease-luxe',
        'data-[selected=true]:bg-ash data-[selected=true]:text-linen',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone",
        'data-[selected=true]:[&_svg]:text-champagne',
        className
      )}
      {...props}
    />
  )
})

/** A keyboard hint at the right of an item. Hidden from assistive tech. */
export function CommandShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'ml-auto font-sans text-xs tracking-widest text-stone tabular-nums',
        className
      )}
      {...props}
    />
  )
}
