// mannachef/apps/web/src/components/ui/sheet.tsx
'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * A drawer that slides in from an edge.
 *
 * Built on the same Radix Dialog as `<Dialog>`, so it inherits the full modal
 * contract: focus trapped while open, focus **restored to the trigger** on
 * close, Escape to dismiss, the rest of the page inert. The only difference is
 * where it comes from and how it is shaped.
 *
 * Use it for a mobile navigation panel, a filter drawer, or a record detail
 * that should not lose the list behind it. Use `<Dialog>` for a decision the
 * guest has to make before anything else can happen.
 *
 * The same rule about `<SheetTitle>` applies as for `<DialogTitle>`: it is
 * required, and `className="sr-only"` is how you hide it rather than omitting
 * it.
 */
export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close
export const SheetPortal = DialogPrimitive.Portal

export const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function SheetOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-obsidian/80 backdrop-blur-sm',
        'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        className
      )}
      {...props}
    />
  )
})

const sheetVariants = cva(
  cn(
    'fixed z-50 flex flex-col gap-5 border-ash bg-card p-6 text-card-foreground',
    'shadow-[inset_0_1px_0_rgba(244,240,233,0.05)]'
  ),
  {
    variants: {
      side: {
        top: cn(
          'inset-x-0 top-0 max-h-[85dvh] overflow-y-auto border-b',
          'data-[state=open]:animate-slide-in-top data-[state=closed]:animate-slide-out-top'
        ),
        bottom: cn(
          'inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto border-t',
          'data-[state=open]:animate-slide-in-bottom data-[state=closed]:animate-slide-out-bottom'
        ),
        left: cn(
          'inset-y-0 left-0 h-full w-4/5 max-w-sm overflow-y-auto border-r',
          'data-[state=open]:animate-slide-in-left data-[state=closed]:animate-slide-out-left'
        ),
        right: cn(
          'inset-y-0 right-0 h-full w-4/5 max-w-md overflow-y-auto border-l',
          'data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right'
        ),
      },
    },
    defaultVariants: {
      side: 'right',
    },
  }
)

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  hideCloseButton?: boolean
  closeLabel?: string
}

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  {
    className,
    children,
    side = 'right',
    hideCloseButton = false,
    closeLabel = 'Close',
    ...props
  },
  ref
) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close
            className={cn(
              'absolute top-4 right-4 rounded-sm p-1 text-stone',
              'transition-colors duration-150 ease-luxe hover:text-linen',
              FOCUS_RING
            )}
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </SheetPortal>
  )
})

export function SheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-2 pr-8 text-left', className)}
      {...props}
    />
  )
}

export function SheetFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  )
}

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        'font-display text-xl leading-tight font-medium tracking-tight text-linen',
        className
      )}
      {...props}
    />
  )
})

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn(
        'font-sans text-sm leading-relaxed text-parchment',
        className
      )}
      {...props}
    />
  )
})

export { sheetVariants }
