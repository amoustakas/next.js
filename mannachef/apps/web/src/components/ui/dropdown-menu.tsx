// mannachef/apps/web/src/components/ui/dropdown-menu.tsx
'use client'

import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, Circle } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * An action menu.
 *
 * Radix implements the WAI-ARIA menu pattern in full: arrow-key navigation,
 * typeahead, submenus that open on hover *and* on right-arrow, Escape to close
 * one level, focus returned to the trigger when the last level closes.
 *
 * Use it for verbs — "Duplicate", "Archive", "Send invoice". It is not a select:
 * a menu item performs an action, it does not hold a value. For choosing a value
 * use `<Select>`; for filtering a long list use `<Command>`.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal
export const DropdownMenuSub = DropdownMenuPrimitive.Sub
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const menuSurface = cn(
  'z-50 min-w-40 overflow-hidden rounded-md border border-ash bg-popover p-1',
  'text-popover-foreground shadow-[inset_0_1px_0_rgba(244,240,233,0.05)]',
  'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out'
)

const menuItemBase = cn(
  'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5',
  'font-sans text-sm text-linen outline-none select-none',
  'transition-colors duration-150 ease-luxe',
  'data-[highlighted]:bg-ash data-[highlighted]:text-linen',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone",
  'data-[highlighted]:[&_svg]:text-parchment'
)

export interface DropdownMenuSubTriggerProps
  extends React.ComponentPropsWithoutRef<
    typeof DropdownMenuPrimitive.SubTrigger
  > {
  inset?: boolean
}

export const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  DropdownMenuSubTriggerProps
>(function DropdownMenuSubTrigger({ className, inset, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        menuItemBase,
        'data-[state=open]:bg-ash',
        inset === true && 'pl-8',
        className
      )}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
})

export const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn(menuSurface, className)}
      {...props}
    />
  )
})

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          menuSurface,
          'max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto',
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})

export interface DropdownMenuItemProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  inset?: boolean
  /** Claret text for a destructive verb. Never the *only* signal — say so too. */
  variant?: 'default' | 'destructive'
}

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  DropdownMenuItemProps
>(function DropdownMenuItem({ className, inset, variant = 'default', ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        menuItemBase,
        inset === true && 'pl-8',
        variant === 'destructive' &&
          'text-claret-ink data-[highlighted]:bg-claret/15 data-[highlighted]:text-linen [&_svg]:text-claret-ink',
        className
      )}
      {...props}
    />
  )
})

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(menuItemBase, 'pl-8', className)}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="size-4 text-champagne" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
})

export const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn(menuItemBase, 'pl-8', className)}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle
            aria-hidden="true"
            className="size-2 fill-champagne text-champagne"
          />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
})

export interface DropdownMenuLabelProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> {
  inset?: boolean
}

export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  DropdownMenuLabelProps
>(function DropdownMenuLabel({ className, inset, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn(
        'px-2 py-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase',
        inset === true && 'pl-8',
        className
      )}
      {...props}
    />
  )
})

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-ash', className)}
      {...props}
    />
  )
})

/**
 * A keyboard hint at the right of an item.
 *
 * `aria-hidden`, because the shortcut is announced by the item's own label if
 * it matters and read as gibberish ("⌘K") if it does not.
 */
export function DropdownMenuShortcut({
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
