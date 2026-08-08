// mannachef/apps/web/src/components/ui/accordion.tsx
'use client'

import * as React from 'react'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronDown } from 'lucide-react'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * A disclosure list.
 *
 * The height animation reads `--radix-accordion-content-height`, which Radix
 * measures and sets on the content element. Under `prefers-reduced-motion` the
 * global rule in `globals.css` collapses the duration to ~0 ms, so the panel
 * simply appears — no opt-out is needed at the call site.
 *
 * `<AccordionTrigger>` renders a real `<button>` inside the heading Radix
 * provides, so the item is reachable by Tab, toggled by Enter or Space, and
 * announced with its expanded state.
 */
export const Accordion = AccordionPrimitive.Root

export const AccordionItem = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(function AccordionItem({ className, ...props }, ref) {
  return (
    <AccordionPrimitive.Item
      ref={ref}
      className={cn('border-b border-ash last:border-b-0', className)}
      {...props}
    />
  )
})

export interface AccordionTriggerProps
  extends React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> {
  /**
   * The heading level Radix's wrapper should use. Default `3`.
   *
   * Set it so the accordion sits correctly under whatever heading precedes it —
   * a list of FAQs below an `<h2>` uses `3`.
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
}

export const AccordionTrigger = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Trigger>,
  AccordionTriggerProps
>(function AccordionTrigger(
  { className, children, headingLevel = 3, ...props },
  ref
) {
  return (
    <AccordionPrimitive.Header asChild>
      {React.createElement(
        `h${String(headingLevel)}`,
        { className: 'flex' },
        <AccordionPrimitive.Trigger
          ref={ref}
          className={cn(
            'group flex flex-1 items-center justify-between gap-4 rounded-sm py-4 text-left',
            'font-sans text-sm font-medium text-linen',
            'transition-colors duration-200 ease-luxe hover:text-champagne',
            FOCUS_RING,
            className
          )}
          {...props}
        >
          {children}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-stone',
              'transition-transform duration-200 ease-luxe',
              'group-data-[state=open]:rotate-180'
            )}
          />
        </AccordionPrimitive.Trigger>
      )}
    </AccordionPrimitive.Header>
  )
})

export const AccordionContent = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className={cn(
        'overflow-hidden',
        'data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up'
      )}
      {...props}
    >
      <div
        className={cn(
          'pb-4 font-sans text-sm leading-relaxed text-parchment',
          className
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Content>
  )
})
