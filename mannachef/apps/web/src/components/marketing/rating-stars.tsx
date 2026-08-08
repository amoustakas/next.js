// mannachef/apps/web/src/components/marketing/rating-stars.tsx
import * as React from 'react'
import { Star } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A five-star average, drawn once and read correctly.
 *
 * ## Accessibility, which is the whole reason this is a component
 *
 * Five glyphs are five glyphs to a screen reader — at best "star star star",
 * at worst nothing at all. So the glyphs are `aria-hidden` and the meaning is
 * carried by a visually-hidden sentence: "Rated 4.6 out of 5 from 18 reviews."
 * That is a fact a listener can act on; a row of icons is not.
 *
 * ## Partial stars without a gradient
 *
 * The half-lit star is drawn by clipping a filled star to a percentage width
 * over an unfilled one, so 4.6 renders as four solid stars and one three-fifths
 * lit. No SVG gradient, no second icon set, and it survives a forced-colours
 * mode because the unfilled star underneath is a real, visible outline.
 *
 * ## Colour
 *
 * Parchment, not champagne. A dish card already spends its one accent on the
 * price (`CONTRACT.md` §3), and a grid of gold stars would turn the whole menu
 * into a jewellery counter.
 *
 * No `'use client'`: pure props in, markup out, so it serves the server-rendered
 * dish grid and the client review dialog from one definition.
 */
const MAX_RATING = 5

export interface RatingStarsProps {
  /** The mean of approved reviews, or `null` before the first one. */
  readonly rating: number | null
  /** How many reviews the mean is drawn from. */
  readonly reviewCount?: number
  readonly size?: 'sm' | 'md'
  /** Show the numeric average beside the stars. */
  readonly showValue?: boolean
  /** Rendered when `rating` is `null`. */
  readonly emptyLabel?: string
  readonly className?: string
}

export function RatingStars({
  rating,
  reviewCount,
  size = 'sm',
  showValue = true,
  emptyLabel = 'Not yet reviewed',
  className,
}: RatingStarsProps): React.JSX.Element {
  const starSize = size === 'sm' ? 'size-3.5' : 'size-4'

  if (rating === null) {
    return (
      <p className={cn('font-sans text-xs text-stone', className)}>
        {emptyLabel}
      </p>
    )
  }

  const clamped = Math.min(MAX_RATING, Math.max(0, rating))
  const percentage = (clamped / MAX_RATING) * 100
  const displayValue = clamped.toFixed(1)

  const countSentence =
    reviewCount === undefined
      ? ''
      : ` from ${String(reviewCount)} ${reviewCount === 1 ? 'review' : 'reviews'}`

  return (
    <p className={cn('inline-flex items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className="relative inline-flex shrink-0 items-center"
      >
        <span className="inline-flex items-center gap-0.5">
          {Array.from({ length: MAX_RATING }, (_, index) => (
            <Star key={index} className={cn(starSize, 'text-ash')} />
          ))}
        </span>
        <span
          className="absolute inset-y-0 left-0 inline-flex items-center gap-0.5 overflow-hidden"
          style={{ width: `${String(percentage)}%` }}
        >
          {Array.from({ length: MAX_RATING }, (_, index) => (
            <Star
              key={index}
              className={cn(starSize, 'shrink-0 fill-parchment text-parchment')}
            />
          ))}
        </span>
      </span>

      {showValue ? (
        <span
          aria-hidden="true"
          className="font-sans text-xs text-parchment tabular-nums"
        >
          {displayValue}
          {reviewCount === undefined ? null : (
            <span className="text-stone"> ({String(reviewCount)})</span>
          )}
        </span>
      ) : null}

      <span className="sr-only">
        Rated {displayValue} out of {String(MAX_RATING)}
        {countSentence}.
      </span>
    </p>
  )
}
