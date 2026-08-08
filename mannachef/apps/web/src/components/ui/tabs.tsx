// mannachef/apps/web/src/components/ui/tabs.tsx
'use client'

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * Tabs.
 *
 * Radix supplies the roving tabindex, arrow-key navigation, and the
 * `aria-controls`/`aria-labelledby` wiring between each trigger and its panel.
 * `activationMode="automatic"` (the default) selects on arrow — pass
 * `activationMode="manual"` when a panel is expensive enough that arrowing past
 * it should not mount it.
 *
 * The active tab is marked by a champagne underline, which is the group's one
 * accent — a tab bar should not also contain a champagne button.
 */
export const Tabs = TabsPrimitive.Root

const tabsListVariants = cva('inline-flex items-center', {
  variants: {
    variant: {
      underline: 'gap-6 border-b border-ash',
      pills: 'gap-1 rounded-md border border-ash bg-charcoal p-1',
    },
    fullWidth: {
      true: 'flex w-full',
      false: '',
    },
  },
  defaultVariants: {
    variant: 'underline',
    fullWidth: false,
  },
})

const tabsTriggerVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 font-sans text-sm font-medium whitespace-nowrap',
    'transition-[color,border-color,background-color] duration-200 ease-luxe',
    'disabled:pointer-events-none disabled:opacity-50',
    "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
    FOCUS_RING
  ),
  {
    variants: {
      variant: {
        underline: cn(
          '-mb-px border-b-2 border-transparent px-1 pb-3 text-stone',
          'hover:text-parchment',
          'data-[state=active]:border-champagne data-[state=active]:text-linen'
        ),
        pills: cn(
          'rounded-sm px-3 py-1.5 text-stone',
          'hover:text-parchment',
          'data-[state=active]:bg-slate-warm data-[state=active]:text-linen'
        ),
      },
    },
    defaultVariants: {
      variant: 'underline',
    },
  }
)

export interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(function TabsList({ className, variant, fullWidth, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(tabsListVariants({ variant, fullWidth }), className)}
      {...props}
    />
  )
})

export interface TabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>,
    VariantProps<typeof tabsTriggerVariants> {}

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(function TabsTrigger({ className, variant, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  )
})

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn('mt-6', FOCUS_RING, className)}
      {...props}
    />
  )
})

export { tabsListVariants, tabsTriggerVariants }
