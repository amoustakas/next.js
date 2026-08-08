// mannachef/apps/web/src/components/ui/dialog.tsx
'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * A modal dialog.
 *
 * ## What Radix is doing for us here
 *
 * Focus is trapped inside the content while it is open, moved to the first
 * tabbable element on open, and **restored to the trigger on close** — the last
 * of those is the one hand-rolled modals always miss, and it is the difference
 * between a keyboard user carrying on and a keyboard user landing back at the
 * top of the document. Escape closes; a click on the overlay closes; the rest
 * of the page is `aria-hidden` and inert while it is open.
 *
 * ## What this file adds
 *
 * `<DialogContent>` **requires** a `<DialogTitle>` among its children. Radix
 * warns at runtime when one is missing; the type here does not enforce it, so
 * the rule is stated plainly: a dialog with no title announces itself as
 * "dialog" and nothing more. If the title should not be seen, wrap it in
 * `<DialogTitle className="sr-only">` rather than omitting it.
 *
 * `<DialogDescription>` is likewise wired to `aria-describedby` automatically.
 * Omit it deliberately by passing `aria-describedby={undefined}` to
 * `<DialogContent>`, which suppresses Radix's warning.
 */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
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

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Hide the built-in close button when the dialog supplies its own. */
  hideCloseButton?: boolean
  /** Accessible name for the close button. */
  closeLabel?: string
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className, children, hideCloseButton = false, closeLabel = 'Close', ...props },
  ref
) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
          'gap-5 rounded-lg border border-ash bg-card p-6 text-card-foreground',
          'shadow-[inset_0_1px_0_rgba(244,240,233,0.06)]',
          'max-h-[calc(100dvh-4rem)] overflow-y-auto',
          'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
          className
        )}
        {...props}
      >
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close
            className={cn(
              'absolute top-4 right-4 rounded-sm p-1 text-stone',
              'transition-colors duration-150 ease-luxe hover:text-linen',
              'disabled:pointer-events-none',
              FOCUS_RING
            )}
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})

export function DialogHeader({
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

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  )
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        'font-display text-2xl leading-tight font-medium tracking-tight text-linen',
        className
      )}
      {...props}
    />
  )
})

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
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
