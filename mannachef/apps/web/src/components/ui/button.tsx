// mannachef/apps/web/src/components/ui/button.tsx
'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'

import { cn, FOCUS_RING } from '@/lib/utils'

/**
 * The house button.
 *
 * ## Accent discipline
 *
 * `champagne` is the *only* filled-accent variant, and CONTRACT.md §3 allows at
 * most one champagne or gold element per visual group — so a dialog footer has
 * one champagne button and its neighbour is `outline` or `ghost`, never a
 * second champagne. `default` is a quiet linen-on-charcoal fill for the many
 * buttons that are not the point of the screen.
 *
 * ## Elevation
 *
 * Every variant is bordered rather than shadowed. `champagne` gets a single
 * inset hairline (`shadow-[inset_0_1px_0_...]`) which reads as light catching a
 * bevelled edge; that is the whole of its elevation and it is one pixel.
 */
const buttonVariants = cva(
  cn(
    'relative inline-flex shrink-0 items-center justify-center gap-2',
    'rounded-md border font-sans text-sm font-medium whitespace-nowrap',
    'transition-[background-color,border-color,color,opacity] duration-200 ease-luxe',
    'disabled:pointer-events-none disabled:opacity-45',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
    FOCUS_RING
  ),
  {
    variants: {
      variant: {
        default:
          'border-ash bg-slate-warm text-linen hover:border-stone/60 hover:bg-ash active:bg-ash/80',
        champagne: cn(
          'border-gold/70 bg-champagne text-obsidian font-semibold',
          'shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]',
          'hover:bg-champagne/90 hover:border-gold active:bg-champagne/80'
        ),
        outline:
          'border-ash bg-transparent text-linen hover:border-champagne/50 hover:bg-slate-warm/60 active:bg-slate-warm',
        ghost:
          'border-transparent bg-transparent text-parchment hover:bg-slate-warm/70 hover:text-linen active:bg-slate-warm',
        destructive:
          'border-claret/70 bg-claret/85 text-linen hover:bg-claret hover:border-claret active:bg-claret/90',
        link: 'border-transparent bg-transparent text-champagne underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'size-10 p-0',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
      fullWidth: false,
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Render as the single child element instead of a `<button>`, forwarding
   * every class and handler onto it. Use it to make a `next/link` look like a
   * button without nesting an anchor inside one.
   */
  asChild?: boolean

  /**
   * Show a spinner and refuse clicks.
   *
   * The label is kept mounted at `opacity-0` and the spinner is absolutely
   * centred over it, so the button's width does not change when a submit
   * starts — a footer whose primary button jumps from "Confirm booking" to
   * "…" and back is the cheapest possible way to make an interface feel
   * unfinished.
   */
  loading?: boolean

  /**
   * What a screen reader hears while `loading`. The visual label is hidden, so
   * without this the button would announce as unlabelled mid-submit.
   */
  loadingLabel?: string
}

/**
 * `<Button loading>` keeps its width. `<Button asChild>` becomes its child.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant,
      size,
      fullWidth,
      asChild = false,
      loading = false,
      loadingLabel = 'Working…',
      disabled,
      children,
      type,
      ...props
    },
    ref
  ) {
    const Comp = asChild ? Slot : 'button'

    // `asChild` hands everything to a child element that is not necessarily a
    // button, so the spinner scaffolding — which relies on wrapping children —
    // is not applied there. A link does not have a pending state.
    if (asChild) {
      return (
        <Comp
          ref={ref}
          className={cn(buttonVariants({ variant, size, fullWidth }), className)}
          {...props}
        >
          {children}
        </Comp>
      )
    }

    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        disabled={disabled === true || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        <span
          className={cn(
            'inline-flex items-center gap-2',
            loading && 'invisible'
          )}
        >
          {children}
        </span>
        {loading ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin-slow"
            />
            <span className="sr-only">{loadingLabel}</span>
          </span>
        ) : null}
      </button>
    )
  }
)

export { buttonVariants }
