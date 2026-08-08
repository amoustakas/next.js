// mannachef/apps/web/src/components/marketing/dish-card.tsx
import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { UtensilsCrossed } from 'lucide-react'

import type { MenuItemSummary } from '@mannachef/api-contract'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import { Money } from '@/components/ui/money'
import { RatingStars } from '@/components/marketing/rating-stars'
import {
  seasonWindowLabel,
  spiceLevelLabel,
} from '@/components/marketing/menu-format'

/**
 * One dish, as it appears in a grid.
 *
 * A Server Component — there is nothing interactive here beyond a link, and a
 * link is markup. The whole card is one anchor, so the hit area is the
 * photograph as well as the name, and the anchor is the *only* focusable thing
 * in the card, so tabbing through the menu visits twelve dishes rather than
 * thirty-six sub-elements.
 *
 * ## Accent budget
 *
 * The card is one visual group and it spends its single champagne element on
 * the price. Every badge is therefore deliberately not champagne: seasonality
 * is sage (`success`), a signature dish is a hairline `outline`, and dietary
 * tags are `muted`. `CONTRACT.md` §3.
 *
 * ## The photograph
 *
 * `next/image` with `fill` inside a fixed 4:3 box, `sizes` matching the grid so
 * a phone never downloads a 1600px plate, and `blurData` from `MediaSummary`
 * used as a real LQIP when the media pipeline produced one. A dish with no
 * image gets a bordered glyph rather than a broken frame — the layout must not
 * shift depending on whether the kitchen has photographed a plate yet.
 *
 * `alt` comes from `MediaSummary.alt`, which the media domain requires; there is
 * no fallback to the dish name, because "Seared scallops" as alt text on a
 * photograph of seared scallops is what the heading beside it already says.
 */
export interface DishCardProps {
  readonly dish: MenuItemSummary
  /**
   * Heading level for the dish name. A grid under an `<h2>` uses `3`.
   */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6
  /** Sizes hint for the responsive image. Match the grid that holds the card. */
  readonly imageSizes?: string
  /** Eagerly load the photograph — the first row of the first grid only. */
  readonly priority?: boolean
  readonly className?: string
}

const DEFAULT_IMAGE_SIZES =
  '(min-width: 1024px) 22rem, (min-width: 640px) 45vw, 92vw'

export function DishCard({
  dish,
  headingLevel = 3,
  imageSizes = DEFAULT_IMAGE_SIZES,
  priority = false,
  className,
}: DishCardProps): React.JSX.Element {
  const media = dish.primaryMedia
  const heat = spiceLevelLabel(dish.spiceLevel)
  const season = dish.isSeasonal
    ? seasonWindowLabel(dish.seasonStart, dish.seasonEnd)
    : null

  const dietaryTags = dish.tags.filter((tag) => tag.kind === 'DIETARY')
  const allergenTags = dish.tags.filter((tag) => tag.kind === 'ALLERGEN')

  return (
    <Card
      as="article"
      variant="interactive"
      className={cn('group h-full overflow-hidden', className)}
    >
      <Link
        href={`/menu/${dish.slug}`}
        className="flex h-full flex-col rounded-lg"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-ash bg-charcoal">
          {media === null ? (
            <span
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center text-stone"
            >
              <UtensilsCrossed className="size-8" />
            </span>
          ) : (
            <Image
              src={media.url}
              alt={media.alt}
              fill
              sizes={imageSizes}
              priority={priority}
              className="object-cover transition-transform duration-200 ease-luxe motion-safe:group-hover:scale-[1.02]"
              {...(media.blurData === null
                ? {}
                : { placeholder: 'blur' as const, blurDataURL: media.blurData })}
            />
          )}
        </div>

        <CardContent className="flex flex-1 flex-col gap-3 p-5 pt-5">
          <p className="font-sans text-xs tracking-[0.18em] text-stone uppercase">
            {dish.categoryName}
          </p>

          <CardTitle level={headingLevel} className="text-lg">
            {dish.name}
          </CardTitle>

          {dish.description === null ? null : (
            <p className="line-clamp-3 font-sans text-sm leading-relaxed text-parchment">
              {dish.description}
            </p>
          )}

          {dietaryTags.length === 0 &&
          allergenTags.length === 0 &&
          season === null &&
          heat === null &&
          !dish.isSignature ? null : (
            <ul className="flex flex-wrap gap-1.5">
              {dish.isSignature ? (
                <li>
                  <Badge variant="outline">Signature</Badge>
                </li>
              ) : null}
              {season === null ? null : (
                <li>
                  <Badge variant="success" srPrefix="In season: ">
                    {season}
                  </Badge>
                </li>
              )}
              {dietaryTags.map((tag) => (
                <li key={tag.id}>
                  <Badge variant="muted" srPrefix="Dietary: ">
                    {tag.name}
                  </Badge>
                </li>
              ))}
              {allergenTags.map((tag) => (
                <li key={tag.id}>
                  <Badge variant="warning" srPrefix="Contains: ">
                    {tag.name}
                  </Badge>
                </li>
              ))}
              {heat === null ? null : (
                <li>
                  <Badge variant="muted" srPrefix="Heat: ">
                    {heat}
                  </Badge>
                </li>
              )}
            </ul>
          )}

          <div className="mt-auto flex items-end justify-between gap-3 pt-2">
            <Money
              cents={dish.basePriceCents}
              currency={dish.currency}
              tone="accent"
              weight="medium"
              className="text-base"
            />
            <RatingStars
              rating={dish.averageRating}
              reviewCount={dish.reviewCount}
            />
          </div>
        </CardContent>
      </Link>
    </Card>
  )
}
