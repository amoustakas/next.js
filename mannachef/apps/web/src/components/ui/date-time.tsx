// mannachef/apps/web/src/components/ui/date-time.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import {
  cn,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatTime,
} from '@/lib/utils'

/**
 * The only place a timestamp becomes a string.
 *
 * Everything in the database is a UTC `DateTime` (`CONTRACT.md` §4). Screens
 * render one through this component so that:
 *
 *  - the element is a real `<time>` with a machine-readable `dateTime`, which
 *    is what makes a date in a table cell meaningful to anything that is not a
 *    pair of eyes;
 *  - the visible text uses the house `en-CA` formats from `@/lib/utils` rather
 *    than each screen picking its own `Intl` options;
 *  - dates carry `tabular-nums`, so a column of them does not ripple;
 *  - a value that fails to parse renders a dash instead of "Invalid Date",
 *    which is a string no guest should ever be shown.
 *
 * No `'use client'`: pure props in, markup out, so it serves a Server Component
 * and `<DataTable>` alike.
 */
const dateTimeVariants = cva('tabular-nums', {
  variants: {
    tone: {
      default: 'text-linen',
      muted: 'text-parchment',
      subtle: 'text-stone',
      accent: 'text-champagne',
    },
    nowrap: {
      true: 'whitespace-nowrap',
      false: '',
    },
  },
  defaultVariants: {
    tone: 'default',
    nowrap: true,
  },
})

/** Which house format to render. */
export type DateTimeFormat = 'date' | 'datetime' | 'time' | 'relative'

export interface DateTimeProps
  extends Omit<React.TimeHTMLAttributes<HTMLTimeElement>, 'dateTime' | 'children'>,
    VariantProps<typeof dateTimeVariants> {
  /** The moment. A `Date`, or the ISO string an action returned. */
  value: Date | string | null | undefined

  /** Default `'date'`. */
  format?: DateTimeFormat

  /** Rendered when `value` is absent or unparseable. */
  fallback?: React.ReactNode

  /**
   * Show the full timestamp in the native `title` tooltip.
   *
   * On by default for `'relative'` and `'time'`, where the visible text alone
   * does not identify the moment — "3 days ago" in a list a week from now is
   * not an answer.
   */
  showTitle?: boolean
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null
  }

  const parsed = typeof value === 'string' ? new Date(value) : value

  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * A formatted timestamp.
 *
 * ```tsx
 * <DateTime value={appointment.startsAt} format="datetime" />
 * <DateTime value={note.createdAt} format="relative" tone="subtle" />
 * ```
 *
 * `format="relative"` is the one variant whose output depends on the clock, so
 * a server render and a hydration can legitimately disagree by a unit. The
 * element sets `suppressHydrationWarning` for that reason and keeps the
 * absolute moment in `dateTime` and `title`, where it cannot drift.
 */
export const DateTime = React.forwardRef<HTMLTimeElement, DateTimeProps>(
  function DateTime(
    {
      value,
      format = 'date',
      fallback = '—',
      showTitle,
      tone,
      nowrap,
      className,
      ...props
    },
    ref
  ) {
    const date = toDate(value)

    if (date === null) {
      return (
        <span className={cn('tabular-nums text-stone', className)}>
          {fallback}
        </span>
      )
    }

    const text =
      format === 'datetime'
        ? formatDateTime(date)
        : format === 'time'
          ? formatTime(date)
          : format === 'relative'
            ? formatRelativeTime(date)
            : formatDate(date)

    const wantsTitle =
      showTitle ?? (format === 'relative' || format === 'time')

    return (
      <time
        ref={ref}
        dateTime={date.toISOString()}
        title={wantsTitle ? formatDateTime(date) : undefined}
        suppressHydrationWarning={format === 'relative'}
        className={cn(dateTimeVariants({ tone, nowrap }), className)}
        {...props}
      >
        {text}
      </time>
    )
  }
)

export interface DateTimeRangeProps
  extends Omit<DateTimeProps, 'value' | 'format'> {
  start: Date | string | null | undefined
  end: Date | string | null | undefined
  /** Include the calendar date on both ends even when they share a day. */
  alwaysShowBothDates?: boolean
}

/**
 * A service window — "Aug 7, 2026, 6:30 PM – 10:00 PM".
 *
 * When both ends fall on the same day the date is written once, which is how a
 * person would say it. Each end is still its own `<time>`, so the pair remains
 * machine-readable.
 */
export const DateTimeRange = React.forwardRef<HTMLSpanElement, DateTimeRangeProps>(
  function DateTimeRange(
    {
      start,
      end,
      alwaysShowBothDates = false,
      fallback = '—',
      tone,
      nowrap,
      className,
      ...props
    },
    ref
  ) {
    const startDate = toDate(start)
    const endDate = toDate(end)

    if (startDate === null || endDate === null) {
      return (
        <span className={cn('tabular-nums text-stone', className)}>
          {fallback}
        </span>
      )
    }

    const sameDay =
      !alwaysShowBothDates &&
      startDate.getFullYear() === endDate.getFullYear() &&
      startDate.getMonth() === endDate.getMonth() &&
      startDate.getDate() === endDate.getDate()

    return (
      <span
        ref={ref}
        className={cn(dateTimeVariants({ tone, nowrap }), className)}
      >
        <DateTime value={startDate} format="datetime" tone={tone} {...props} />
        <span aria-hidden="true" className="mx-1 text-stone">
          –
        </span>
        <span className="sr-only"> until </span>
        <DateTime
          value={endDate}
          format={sameDay ? 'time' : 'datetime'}
          tone={tone}
          showTitle={false}
          {...props}
        />
      </span>
    )
  }
)

export { dateTimeVariants }
