// mannachef/apps/web/src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names and resolve Tailwind class conflicts.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * The champagne focus ring from `mannachef/CONTRACT.md` §3, as one string.
 *
 * "Every interactive element has a visible `focus-visible` ring in **solid**
 * champagne (no alpha)" is a rule that is only true if it is written the same
 * way every time, so it is written once. Every primitive in `@/components/ui`
 * composes this into its base class list.
 *
 * ## Why there is no `/40` here any more (MCV-061)
 *
 * This used to read `focus-visible:ring-champagne` at 40% alpha, because an
 * earlier revision of the contract asked for 40% opacity. That was a
 * product-wide WCAG SC 1.4.11 failure and the contract has been corrected.
 *
 * A token's nominal contrast does not survive alpha. Champagne (#d8c39a) is
 * 9.08:1 against ash and 11.49:1 against obsidian as a solid. At 40% it is not
 * champagne at all — it composites to #5d5443…#6d6350 depending on the surface
 * beneath, and measures **2.64–2.69:1 against that same surface**, under the
 * 3:1 that SC 1.4.11 requires of a focus indicator, on every surface in the
 * palette. A keyboard user could not reliably see where focus was, anywhere.
 *
 * Solid champagne is 9.08:1 at its worst. Always compute a ring's ratio from
 * the composited value against the actual parent surface, never from the
 * token's own figure. `scripts/verify-contrast.ts` fails the build if an alpha
 * ring reappears in this file or anywhere in `src/`.
 *
 * `outline-none` is safe here *because* the ring replaces it — never use
 * `outline-none` without one of these beside it.
 */
export const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-champagne focus-visible:ring-offset-0'

/**
 * The same ring for a control whose focus lives on a child (a Radix trigger
 * wrapping a native input, a table cell wrapping a checkbox).
 *
 * Solid champagne for the same reason, and to the same measurement, as
 * `FOCUS_RING` above.
 */
export const FOCUS_RING_WITHIN =
  'outline-none focus-within:ring-2 focus-within:ring-champagne focus-within:ring-offset-0'

/** The 1px gold hairline used instead of a shadow for elevation. */
export const HAIRLINE_BORDER = 'border border-ash/80'

/**
 * Format an integer amount stored in minor units (cents) as a localized
 * currency string. Money is never stored as a float — see CONTRACT.md §4.
 */
export function formatCurrency(cents: number, currency = 'CAD'): string {
  const amount = cents / 100
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(amount)
}

/**
 * Format a Date (or ISO string) as a human-readable calendar date,
 * e.g. "Aug 7, 2026".
 */
export function formatDate(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(value)
}

/**
 * Format a Date (or ISO string) as a human-readable date and time,
 * e.g. "Aug 7, 2026, 9:41 AM".
 */
export function formatDateTime(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

/**
 * Format a Date (or ISO string) as a wall-clock time, e.g. "9:41 AM".
 *
 * Added in MCV-060 so `<DateTime format="time">` has a formatter here rather
 * than a second `Intl` call inlined into a component — every screen renders
 * dates through `@/components/ui/date-time`, and that component renders them
 * through this module.
 */
export function formatTime(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

/**
 * Format a Date (or ISO string) relative to now, e.g. "3 days ago",
 * "in 2 hours".
 *
 * Uses `Intl.RelativeTimeFormat` rather than a dependency so the output is
 * locale-correct and needs no bundle. The largest unit that fits is chosen, so
 * a 90-minute gap reads "2 hours ago" rather than "90 minutes ago".
 *
 * The result depends on the clock, so a server render and a client hydration
 * can disagree by a unit. `<DateTime format="relative">` sets
 * `suppressHydrationWarning` for exactly that reason and keeps the absolute
 * timestamp in the element's `dateTime` attribute and `title`.
 */
export function formatRelativeTime(
  date: Date | string,
  now: Date = new Date()
): string {
  const value = typeof date === 'string' ? new Date(date) : date
  const deltaSeconds = (value.getTime() - now.getTime()) / 1000

  const thresholds: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> =
    [
      ['year', 60 * 60 * 24 * 365],
      ['month', 60 * 60 * 24 * 30],
      ['week', 60 * 60 * 24 * 7],
      ['day', 60 * 60 * 24],
      ['hour', 60 * 60],
      ['minute', 60],
      ['second', 1],
    ]

  const formatter = new Intl.RelativeTimeFormat('en-CA', { numeric: 'auto' })

  for (const threshold of thresholds) {
    const [unit, seconds] = threshold
    const amount = deltaSeconds / seconds

    if (Math.abs(amount) >= 1) {
      return formatter.format(Math.round(amount), unit)
    }
  }

  return formatter.format(0, 'second')
}
