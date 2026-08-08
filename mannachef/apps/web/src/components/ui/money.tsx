// mannachef/apps/web/src/components/ui/money.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn, formatCurrency } from '@/lib/utils'

/**
 * The only place cents become a string.
 *
 * Money is stored as integer minor units everywhere in this platform —
 * `CONTRACT.md` §4, every `…Cents` column in the Prisma schema, every
 * `moneyCentsSchema` in the validators. That invariant is only worth anything
 * if the division by 100 happens in exactly one place, so no screen may write
 * `{cents / 100}` or call `formatCurrency` directly: it renders `<Money>`.
 *
 * What that buys, besides consistency:
 *
 *  - `tabular-nums`, always. A column of prices whose digits are proportionally
 *    spaced does not line up on the decimal, and a total that shifts width as
 *    it changes reads as broken.
 *  - The value is one unbreakable run of text, so "$1,240.00" never wraps
 *    between the dollar sign and the figure at a narrow width.
 *  - A machine-readable `data-cents` attribute, so a test can assert on the
 *    stored integer rather than on a formatted string that varies by locale.
 *
 * There is no `'use client'` here on purpose. `<Money>` is a pure function of
 * its props with no state and no effects, so it renders in a Server Component
 * *and* inside `<DataTable>`, which is a client component. A component with no
 * directive belongs to whichever graph imports it.
 */
const moneyVariants = cva('tabular-nums whitespace-nowrap', {
  variants: {
    tone: {
      default: 'text-linen',
      muted: 'text-parchment',
      subtle: 'text-stone',
      accent: 'text-champagne',
      positive: 'text-sage-ink',
      negative: 'text-claret-ink',
    },
    weight: {
      normal: 'font-normal',
      medium: 'font-medium',
      semibold: 'font-semibold',
    },
    strikethrough: {
      true: 'line-through decoration-stone',
      false: '',
    },
  },
  defaultVariants: {
    tone: 'default',
    weight: 'normal',
    strikethrough: false,
  },
})

export interface MoneyProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof moneyVariants> {
  /** The stored integer, in minor units. Never a float, never pre-divided. */
  cents: number

  /** ISO 4217 code. Defaults to the house currency. */
  currency?: string

  /**
   * Prefix a non-negative amount with `+`.
   *
   * For a ledger line, a proration, or a reward adjustment, where "0" and
   * "+0" mean different things to the reader.
   */
  signed?: boolean

  /**
   * Colour by sign — `positive` above zero, `negative` below, leaving `tone`
   * to govern zero. Overrides `tone` for non-zero amounts.
   */
  colorBySign?: boolean

  /** Rendered instead of the amount when `cents` is `null`-ish upstream. */
  fallback?: React.ReactNode
}

/**
 * A formatted monetary amount.
 *
 * ```tsx
 * <Money cents={invoice.totalCents} currency={invoice.currency} weight="medium" />
 * <Money cents={adjustment.amountCents} signed colorBySign />
 * ```
 */
export const Money = React.forwardRef<HTMLSpanElement, MoneyProps>(
  function Money(
    {
      cents,
      currency = 'CAD',
      signed = false,
      colorBySign = false,
      tone,
      weight,
      strikethrough,
      fallback = '—',
      className,
      ...props
    },
    ref
  ) {
    if (!Number.isFinite(cents)) {
      return (
        <span
          ref={ref}
          className={cn('tabular-nums text-stone', className)}
          {...props}
        >
          {fallback}
        </span>
      )
    }

    const rounded = Math.round(cents)
    const formatted = formatCurrency(rounded, currency)
    const display = signed && rounded >= 0 ? `+${formatted}` : formatted

    const effectiveTone = colorBySign
      ? rounded > 0
        ? 'positive'
        : rounded < 0
          ? 'negative'
          : (tone ?? 'default')
      : tone

    return (
      <span
        ref={ref}
        data-cents={rounded}
        data-currency={currency}
        className={cn(
          moneyVariants({ tone: effectiveTone, weight, strikethrough }),
          className
        )}
        {...props}
      >
        {display}
      </span>
    )
  }
)

export interface MoneyRangeProps
  extends Omit<MoneyProps, 'cents' | 'signed' | 'colorBySign'> {
  fromCents: number
  toCents: number
}

/**
 * A price band — "$120.00 – $240.00", or a single amount when the ends agree.
 *
 * The separator is an en dash inside a non-breaking run, so the range never
 * splits across lines mid-dash.
 */
export const MoneyRange = React.forwardRef<HTMLSpanElement, MoneyRangeProps>(
  function MoneyRange(
    { fromCents, toCents, currency = 'CAD', className, ...props },
    ref
  ) {
    if (Math.round(fromCents) === Math.round(toCents)) {
      return (
        <Money
          ref={ref}
          cents={fromCents}
          currency={currency}
          className={className}
          {...props}
        />
      )
    }

    return (
      <span
        ref={ref}
        className={cn('whitespace-nowrap tabular-nums', className)}
        {...props}
      >
        <Money cents={fromCents} currency={currency} {...props} />
        <span aria-hidden="true" className="mx-1 text-stone">
          –
        </span>
        <span className="sr-only"> to </span>
        <Money cents={toCents} currency={currency} {...props} />
      </span>
    )
  }
)

export { moneyVariants }
