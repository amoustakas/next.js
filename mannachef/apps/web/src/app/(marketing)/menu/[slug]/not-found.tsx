// mannachef/apps/web/src/app/(marketing)/menu/[slug]/not-found.tsx
import * as React from 'react'
import Link from 'next/link'
import { SearchX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * The 404 for a dish.
 *
 * Segment-scoped on purpose. `notFound()` in `[slug]/page.tsx` is thrown for
 * two different situations that look identical to a guest — a slug that never
 * existed, and a dish that has been taken off the menu — and both deserve an
 * answer written by the kitchen rather than the framework's default page. It
 * renders inside the marketing layout, so the header, the footer and the skip
 * link's `#main-content` target are all still there.
 *
 * It offers the menu rather than the home page: someone who followed a link to
 * a dish wants a dish, and the menu is the nearest true thing we have.
 */
export default function DishNotFound(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8 sm:py-32">
      <EmptyState
        size="lg"
        icon={SearchX}
        headingLevel={1}
        title="That dish is not on the menu."
        description="It may have come off with the season, or the address may have a typo in it. Everything the kitchen is cooking right now is one link away."
        action={
          <Button asChild variant="champagne">
            <Link href="/menu">See this season&rsquo;s menu</Link>
          </Button>
        }
        secondaryAction={
          <Button asChild variant="ghost">
            <Link href="/contact">Ask us about it</Link>
          </Button>
        }
      />
    </div>
  )
}
