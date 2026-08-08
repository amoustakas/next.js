// mannachef/apps/web/src/components/marketing/menu-skeletons.tsx
import * as React from 'react'

import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The placeholders that hold a menu's shape while its data streams in.
 *
 * Each of these is the `fallback` of a `<Suspense>` boundary, which is what
 * lets the page shell — header, hero, filter panel — paint on the first byte
 * while the database is still being asked for dishes.
 *
 * ## One announcement per region, not one per box
 *
 * A grid of nine skeleton cards is nine `aria-hidden` decorations inside a
 * single `role="status" aria-busy="true"` region carrying one visually-hidden
 * sentence. A screen-reader user hears "Loading the menu" once; without the
 * wrapper they would hear nothing at all, because `<Skeleton>` is correctly
 * hidden from the accessibility tree.
 *
 * ## The shapes match what replaces them
 *
 * Same 4:3 image box, same three text lines, same badge row, same price line as
 * `<DishCard>`. A skeleton whose proportions differ from its content is worse
 * than no skeleton: it guarantees a layout shift at exactly the moment the
 * guest starts reading.
 */
export interface DishGridSkeletonProps {
  /** How many cards to draw. Match the page size you are about to render. */
  readonly count?: number
  readonly label?: string
  readonly className?: string
}

const GRID_CLASSES = 'grid gap-6 sm:grid-cols-2 lg:grid-cols-3'

export function DishGridSkeleton({
  count = 6,
  label = 'Loading the menu…',
  className,
}: DishGridSkeletonProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(GRID_CLASSES, className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} variant="quiet" className="h-full overflow-hidden">
          <Skeleton className="aspect-[4/3] w-full rounded-none" />
          <CardContent className="flex flex-col gap-3 p-5 pt-5">
            <Skeleton shape="text" className="h-3 w-24" />
            <Skeleton shape="text" className="h-5 w-3/4" />
            <Skeleton shape="text" className="w-full" />
            <Skeleton shape="text" className="w-5/6" />
            <div className="flex gap-1.5 pt-1">
              <Skeleton shape="pill" className="w-20" />
              <Skeleton shape="pill" className="w-16" />
            </div>
            <div className="flex items-center justify-between pt-2">
              <Skeleton shape="text" className="h-4 w-20" />
              <Skeleton shape="text" className="h-4 w-24" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export interface ReviewStripSkeletonProps {
  readonly count?: number
  readonly label?: string
  readonly className?: string
}

/** Three review cards' worth of space, held open. */
export function ReviewStripSkeleton({
  count = 3,
  label = 'Loading guest reviews…',
  className,
}: ReviewStripSkeletonProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('grid gap-6 md:grid-cols-3', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} variant="quiet" className="h-full">
          <CardContent className="flex flex-col gap-4 p-6">
            <Skeleton shape="text" className="h-4 w-24" />
            <Skeleton shape="text" className="h-5 w-2/3" />
            <Skeleton shape="text" className="w-full" />
            <Skeleton shape="text" className="w-full" />
            <Skeleton shape="text" className="w-4/5" />
            <Skeleton shape="text" className="mt-2 h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export interface FilterPanelSkeletonProps {
  readonly label?: string
  readonly className?: string
}

/** The filter rail, before the collections and tags have arrived. */
export function FilterPanelSkeleton({
  label = 'Loading the menu filters…',
  className,
}: FilterPanelSkeletonProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        'flex flex-col gap-6 rounded-lg border border-ash bg-charcoal/50 p-5',
        className
      )}
    >
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-2">
        <Skeleton shape="text" className="h-3 w-20" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton shape="text" className="h-3 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton shape="text" className="h-3 w-16" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} shape="text" className="w-36" />
        ))}
      </div>
    </div>
  )
}
