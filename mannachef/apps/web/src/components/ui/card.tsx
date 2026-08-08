// mannachef/apps/web/src/components/ui/card.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * The raised surface.
 *
 * Radius `lg` per CONTRACT.md §3. Elevation comes from a border and, on
 * `elevated`, a single inset hairline of light along the top edge — never a
 * drop shadow. The `accent` variant adds one gold gradient rule across the top;
 * it is the card's *one* champagne/gold element, so a card using it must not
 * also carry a champagne button in the same visual group.
 */
const cardVariants = cva(
  'relative rounded-lg border bg-card text-card-foreground',
  {
    variants: {
      variant: {
        default: 'border-ash',
        elevated:
          'border-ash shadow-[inset_0_1px_0_rgba(244,240,233,0.05)] bg-slate-warm',
        quiet: 'border-ash/60 bg-charcoal',
        accent: cn(
          'border-ash bg-slate-warm',
          'before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-lg',
          'before:bg-gradient-to-r before:from-transparent before:via-gold/70 before:to-transparent'
        ),
        interactive: cn(
          'border-ash bg-slate-warm',
          'transition-[border-color,background-color] duration-200 ease-luxe',
          'hover:border-stone/50 hover:bg-ash/40'
        ),
      },
      padded: {
        true: 'p-6',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      padded: false,
    },
  }
)

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  /**
   * Render as a different element. Use `'article'` or `'section'` when the card
   * is a landmark in its own right rather than a decorative box.
   */
  as?: 'div' | 'article' | 'section' | 'li'
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant, padded, as, ...props },
  ref
) {
  // Widened to `ElementType` on purpose. Typed as the literal union, the four
  // tags' ref types intersect — `RefObject<HTMLDivElement> &
  // RefObject<HTMLLIElement> & …` — which nothing can satisfy. The runtime tag
  // is still exactly what the caller asked for.
  const Comp = (as ?? 'div') as React.ElementType

  return (
    <Comp
      ref={ref}
      className={cn(cardVariants({ variant, padded }), className)}
      {...props}
    />
  )
})

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn('flex flex-col gap-1.5 p-6 pb-4', className)}
      {...props}
    />
  )
})

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /**
   * Heading level. A card inside a section that already has an `<h2>` should
   * use `3`, so the document outline stays honest — the visual size is set by
   * `className`, never by the level.
   */
  level?: 1 | 2 | 3 | 4 | 5 | 6
}

/**
 * Serif display face, per CONTRACT.md §3 — headings only. Never reach for
 * `font-display` on a value, a label, or a table cell.
 */
export const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
  function CardTitle({ className, level = 3, ...props }, ref) {
    const Comp = `h${String(level)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

    return (
      <Comp
        ref={ref}
        className={cn(
          'font-display text-xl leading-tight font-medium tracking-tight text-linen',
          className
        )}
        {...props}
      />
    )
  }
)

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn('font-sans text-sm leading-relaxed text-parchment', className)}
      {...props}
    />
  )
})

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
})

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex items-center gap-3 border-t border-ash/70 px-6 py-4',
        className
      )}
      {...props}
    />
  )
})

export { cardVariants }
