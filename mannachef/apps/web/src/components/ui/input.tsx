// mannachef/apps/web/src/components/ui/input.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * A single-line text field.
 *
 * No `'use client'`: this is a plain `<input>` with no state and no handlers of
 * its own, so it renders in a Server Component as happily as in a form. The
 * client boundary belongs to whatever binds it — `<FormControl>`, a
 * `<Controller>`, an `onChange`.
 */
const inputVariants = cva(
  cn(
    'flex h-10 w-full min-w-0 rounded-md border bg-charcoal px-3 py-2',
    'font-sans text-sm text-linen',
    'transition-[border-color,background-color] duration-200 ease-luxe',
    'placeholder:text-stone',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-parchment',
    // A number field's spinners are noise in a currency or guest-count input.
    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
    FOCUS_RING
  ),
  {
    variants: {
      invalid: {
        true: 'border-claret/80 focus-visible:ring-claret/40',
        false: 'border-ash hover:border-stone/60 focus-visible:border-champagne/60',
      },
      inputSize: {
        sm: 'h-8 px-2.5 text-xs',
        md: '',
        lg: 'h-12 px-4 text-base',
      },
      numeric: {
        true: 'tabular-nums',
        false: '',
      },
    },
    defaultVariants: {
      invalid: false,
      inputSize: 'md',
      numeric: false,
    },
  }
)

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, type, invalid, inputSize, numeric, ...props }, ref) {
    // A field that is `aria-invalid` gets the claret border without the caller
    // having to say so twice — `<FormControl>` sets `aria-invalid` already.
    const isInvalid =
      invalid ?? (props['aria-invalid'] === true || props['aria-invalid'] === 'true')

    return (
      <input
        ref={ref}
        type={type ?? 'text'}
        className={cn(
          inputVariants({ invalid: isInvalid, inputSize, numeric }),
          className
        )}
        {...props}
      />
    )
  }
)

export { inputVariants }
