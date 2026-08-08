// mannachef/apps/web/src/components/marketing/dish-reviews-dialog.tsx
'use client'

import * as React from 'react'
import { MessageSquareQuote } from 'lucide-react'

import type { ReviewView } from '@mannachef/api-contract'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RatingStars } from '@/components/marketing/rating-stars'
import { ReviewCard } from '@/components/marketing/review-card'

/**
 * The reviews popup on a dish page.
 *
 * ## What Radix guarantees, and why that is the whole reason for using it
 *
 * A "reviews modal" is the single most commonly broken widget on a restaurant
 * site, and the breakages are always the same four. Radix's `Dialog` closes all
 * four for us and this component does not re-open any of them:
 *
 *  - **Focus is trapped.** Tab and Shift+Tab cycle inside the panel; they cannot
 *    reach the page underneath.
 *  - **Focus is restored.** On close, focus returns to the trigger — so a
 *    keyboard user carries on from the button they pressed rather than from the
 *    top of the document.
 *  - **Escape closes it**, and so does a click on the overlay.
 *  - **The rest of the page is inert** and `aria-hidden`, so a screen reader
 *    reads the dialog rather than reading the dish page through it.
 *
 * `<DialogTitle>` is mandatory — a dialog without one announces itself as
 * "dialog" and nothing else — and `<DialogDescription>` is wired to
 * `aria-describedby`, so the count and the average are heard on open.
 *
 * ## Why the reviews arrive as props
 *
 * They are read on the server by `listPublishedReviews`, which intersects the
 * requested statuses with `APPROVED | FEATURED` and refuses to widen — there is
 * no argument this component could pass that would surface an unmoderated
 * review, because it passes nothing at all. Fetching on open would mean a
 * spinner, a second round trip, and a client-side call into an action whose
 * result the server already had.
 *
 * The list is scrollable rather than paginated: `<ScrollArea>` keeps the
 * viewport natively scrollable, so the keyboard, the wheel and
 * `scrollIntoView` all behave, and the dialog's own height is capped by
 * `DialogContent`.
 */
export interface DishReviewsDialogProps {
  readonly dishName: string
  readonly reviews: readonly ReviewView[]
  /** The mean across every approved review, as the dish summary reports it. */
  readonly averageRating: number | null
  /** The total the dish carries, which may exceed the page shown here. */
  readonly totalReviewCount: number
}

export function DishReviewsDialog({
  dishName,
  reviews,
  averageRating,
  totalReviewCount,
}: DishReviewsDialogProps): React.JSX.Element {
  const shown = reviews.length
  const isPartial = totalReviewCount > shown

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <MessageSquareQuote aria-hidden="true" />
          Read {String(totalReviewCount)}{' '}
          {totalReviewCount === 1 ? 'review' : 'reviews'}
        </Button>
      </DialogTrigger>

      <DialogContent
        className="max-w-2xl"
        closeLabel="Close the reviews"
      >
        <DialogHeader>
          <DialogTitle>Reviews of {dishName}</DialogTitle>
          <DialogDescription>
            {isPartial
              ? `The ${String(shown)} most recent of ${String(totalReviewCount)} approved reviews. Every one was written by a household we cooked for and read by the kitchen before it was published.`
              : `Every approved review of this dish. Each one was written by a household we cooked for and read by the kitchen before it was published.`}
          </DialogDescription>
          {averageRating === null ? null : (
            <RatingStars
              rating={averageRating}
              reviewCount={totalReviewCount}
              size="md"
              className="pt-1"
            />
          )}
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[min(60dvh,32rem)] pr-4">
          <ul className="flex flex-col gap-4">
            {reviews.map((review) => (
              <li key={review.id}>
                <ReviewCard review={review} headingLevel={3} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
