// mannachef/apps/web/src/components/ui/empty-state.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The "nothing here" state.
 *
 * An empty list is a moment of doubt — *is it loading? did my filter break? am
 * I allowed to see this?* — so this component insists on answering all three.
 * `title` says what is empty, `description` says why, and `action` says what to
 * do next. A grey box reading "No results" answers none of them.
 *
 * Three tones, and choosing the right one matters:
 *
 *  - `empty` — the collection is genuinely new. Offer the primary action.
 *  - `filtered` — there is data, this filter excludes it. Offer "Clear
 *    filters", never "Create your first…", which is a lie.
 *  - `error` — the read failed. Offer "Try again".
 *
 * The `icon` is decorative and `aria-hidden`; the heading carries the meaning.
 */
const emptyStateVariants = cva(
  'flex flex-col items-center justify-center rounded-lg border border-dashed text-center',
  {
    variants: {
      tone: {
        empty: 'border-ash bg-charcoal/50',
        filtered: 'border-ash bg-charcoal/50',
        error: 'border-claret/40 bg-claret/8',
      },
      size: {
        sm: 'gap-2 px-6 py-8',
        md: 'gap-3 px-8 py-14',
        lg: 'gap-4 px-8 py-20',
      },
    },
    defaultVariants: {
      tone: 'empty',
      size: 'md',
    },
  }
)

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof emptyStateVariants> {
  /** What is empty. Written as a sentence, not a label. */
  title: React.ReactNode
  /** Why it is empty, and what would change that. */
  description?: React.ReactNode
  /** Decorative glyph above the title. */
  icon?: LucideIcon
  /** The one thing to do next — a `<Button>`, usually. */
  action?: React.ReactNode
  /** A quieter secondary route, e.g. "Read the guide". */
  secondaryAction?: React.ReactNode
  /** Heading level, so the document outline stays honest. Default `3`. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  function EmptyState(
    {
      className,
      tone,
      size,
      title,
      description,
      icon: Icon,
      action,
      secondaryAction,
      headingLevel = 3,
      ...props
    },
    ref
  ) {
    const Heading = `h${String(headingLevel)}` as
      | 'h1'
      | 'h2'
      | 'h3'
      | 'h4'
      | 'h5'
      | 'h6'

    return (
      <div
        ref={ref}
        className={cn(emptyStateVariants({ tone, size }), className)}
        {...props}
      >
        {Icon === undefined ? null : (
          <span
            aria-hidden="true"
            className={cn(
              'mb-1 flex size-11 items-center justify-center rounded-full border',
              tone === 'error'
                ? 'border-claret/40 text-claret-ink'
                : 'border-ash text-stone'
            )}
          >
            <Icon className="size-5" />
          </span>
        )}
        <Heading className="font-display text-lg leading-tight font-medium tracking-tight text-linen">
          {title}
        </Heading>
        {description === undefined ? null : (
          <p className="max-w-prose font-sans text-sm leading-relaxed text-parchment">
            {description}
          </p>
        )}
        {action === undefined && secondaryAction === undefined ? null : (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    )
  }
)

export { emptyStateVariants }
