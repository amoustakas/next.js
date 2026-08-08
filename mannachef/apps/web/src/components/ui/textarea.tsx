// mannachef/apps/web/src/components/ui/textarea.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn, FOCUS_RING } from '@/lib/utils'

const textareaVariants = cva(
  cn(
    'flex w-full rounded-md border bg-charcoal px-3 py-2',
    'font-sans text-sm leading-relaxed text-linen',
    'transition-[border-color] duration-200 ease-luxe',
    'placeholder:text-stone',
    'disabled:cursor-not-allowed disabled:opacity-50',
    FOCUS_RING
  ),
  {
    variants: {
      invalid: {
        true: 'border-claret/80 focus-visible:ring-claret/40',
        false: 'border-ash hover:border-stone/60 focus-visible:border-champagne/60',
      },
      resize: {
        none: 'resize-none',
        vertical: 'resize-y',
        both: 'resize',
      },
    },
    defaultVariants: {
      invalid: false,
      resize: 'vertical',
    },
  }
)

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

/**
 * A multi-line text field.
 *
 * `rows` defaults to 4 rather than the browser's 2, because every textarea in
 * this app holds prose — a note, a memo, a dietary caution — and two rows makes
 * a guest feel they are being asked for less than they are.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, resize, rows, ...props }, ref) {
    const isInvalid =
      invalid ??
      (props['aria-invalid'] === true || props['aria-invalid'] === 'true')

    return (
      <textarea
        ref={ref}
        rows={rows ?? 4}
        className={cn(textareaVariants({ invalid: isInvalid, resize }), className)}
        {...props}
      />
    )
  }
)

export { textareaVariants }
