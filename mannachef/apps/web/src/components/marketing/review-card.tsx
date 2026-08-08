// mannachef/apps/web/src/components/marketing/review-card.tsx
import * as React from 'react'
import { BadgeCheck } from 'lucide-react'

import type { ReviewView } from '@mannachef/api-contract'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { RatingStars } from '@/components/marketing/rating-stars'

/**
 * One published review.
 *
 * No directive, so the same component renders inside the server-built featured
 * strip on the home page *and* inside the client-side reviews dialog on a dish
 * page. It is a pure function of `ReviewView` — the shape
 * `listPublishedReviews` returns, which is projected through
 * `REVIEW_PUBLIC_SELECT` and therefore carries no moderation note, no moderator
 * id and no email address.
 *
 * ## Markup that means what it looks like
 *
 * A quotation is a `<blockquote>` with a `<figcaption>` attribution, not a
 * `<div>` with quotation marks glued on. The em-dash before the author's name
 * is `aria-hidden`, because a screen reader announcing "em dash Priya" is
 * noise, and the visually-hidden word "by" carries the relationship instead.
 *
 * `authorName` is nullable: an author may have no display name on their `User`
 * row. The fallback is "A MannaChef guest" rather than "Anonymous", which reads
 * as a withheld identity rather than an absent one.
 *
 * ## Accent budget
 *
 * `quiet`, deliberately. A row of three reviews would otherwise be three gold
 * hairlines abreast; the section they sit in spends the group's one gold
 * element on its own rule. `CONTRACT.md` §3.
 */
export interface ReviewCardProps {
  readonly review: ReviewView
  /** Heading level for the review's headline, when it has one. Default `3`. */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6
  readonly className?: string
}

export function ReviewCard({
  review,
  headingLevel = 3,
  className,
}: ReviewCardProps): React.JSX.Element {
  const Heading = `h${String(headingLevel)}` as
    | 'h2'
    | 'h3'
    | 'h4'
    | 'h5'
    | 'h6'

  return (
    <Card
      as="article"
      variant="quiet"
      className={cn('h-full', className)}
    >
      <CardContent className="flex h-full flex-col gap-4 p-6">
        <RatingStars
          rating={review.rating}
          size="md"
          showValue={false}
          className="shrink-0"
        />

        <figure className="flex flex-1 flex-col gap-4">
          {review.title === null ? null : (
            <Heading className="font-display text-lg leading-snug font-medium tracking-tight text-linen">
              {review.title}
            </Heading>
          )}

          <blockquote className="flex-1 font-sans text-sm leading-relaxed text-parchment">
            {review.body}
          </blockquote>

          <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-sans text-sm text-linen">
              <span aria-hidden="true" className="mr-1 text-stone">
                —
              </span>
              <span className="sr-only">by </span>
              {review.authorName ?? 'A MannaChef guest'}
            </span>

            <DateTime
              value={review.createdAt}
              format="date"
              tone="subtle"
              className="font-sans text-xs"
            />

            {review.isVerified ? (
              <Badge variant="success" srPrefix="Status: ">
                <BadgeCheck aria-hidden="true" />
                Served engagement
              </Badge>
            ) : null}
          </figcaption>
        </figure>
      </CardContent>
    </Card>
  )
}
