// mannachef/apps/web/src/app/(marketing)/menu/[slug]/page.tsx
import * as React from 'react'
import { cache, Suspense } from 'react'
import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronRight, UtensilsCrossed } from 'lucide-react'

import type { MenuItemDetail } from '@mannachef/api-contract'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { DishReviewsDialog } from '@/components/marketing/dish-reviews-dialog'
import {
  ingredientQuantityLabel,
  seasonWindowLabel,
  spiceLevelLabel,
} from '@/components/marketing/menu-format'
import { RatingStars } from '@/components/marketing/rating-stars'
import { ReadFailure } from '@/components/marketing/read-failure'
import { getMenuItem, listMenuItems } from '@/server/actions/menu'
import { listPublishedReviews } from '@/server/actions/review'
import { readAsGuest } from '@/server/guards'

/**
 * One dish.
 *
 * ## `generateStaticParams` and what it is honestly buying
 *
 * The slugs of the published menu are enumerated at build time, so every dish
 * that exists when the build runs gets a pre-rendered entry rather than being
 * generated on a guest's first visit. `dynamicParams` stays at its default
 * (`true`), so a dish published *after* the build is rendered on demand and then
 * cached — the menu is not frozen to whatever existed at deploy time.
 *
 * Until MCV-072 that paragraph was a description of code that did not run. The
 * enumeration was wrapped in a `try`/`catch` falling back to `[]`, and the
 * fallback was not the unlikely branch — it was the only branch. `withAction`
 * resolved a session through `auth()` before every handler, `auth()` reads the
 * session cookie, and there is no cookie store during `generateStaticParams`,
 * so the read failed on every build and the function returned an empty array
 * every single time. The build reported `● /menu/[slug]` and prerendered
 * nothing. `readAsGuest` removes the cookie read rather than catching its
 * consequences, so the enumeration now actually enumerates and the `try`/`catch`
 * is gone with it: a database that is genuinely unreachable at build time is a
 * build that should fail loudly, not one that silently ships zero dish pages.
 *
 * ## Revalidation
 *
 * One hour. A dish page is the most stable thing on the public site — its
 * story, ingredients and macros change when someone edits them and at no other
 * time — and every menu mutation already revalidates `/menu/[slug]` as a `page`
 * target through `MENU_REVALIDATE_PATHS`. The hour is a backstop, and it is
 * longer than the menu index's fifteen minutes because a dish page has no
 * filter surface to go stale and because its *price* is the only volatile field
 * on it.
 *
 * The reviews are the exception, which is why they are in their own
 * `<Suspense>` boundary: moderation happens on a different clock from menu
 * editing, and `server/actions/review.ts` revalidates `/menu` on every
 * moderation pass.
 *
 * Like the enumeration above, the hour only started meaning anything with
 * MCV-072. All three reads on this route — the dish, its reviews, and the slug
 * list — go through `readAsGuest`, so nothing here reads a cookie and the route
 * prerenders. A dish page has no viewer-dependent content to lose by that:
 * the price, the story and the ingredients are the same for a signed-in guest,
 * and the only role-sensitive field `getMenuItem` has — the draft dish an
 * editor may read — is reached from `/admin/menu`, which does not use this
 * page.
 */
export const revalidate = 3600

interface DishPageProps {
  readonly params: Promise<{ readonly slug: string }>
}

/**
 * One read per request, however many times it is asked for.
 *
 * `generateMetadata` and the page body both need the dish, and Next.js runs
 * them in the same request. `React.cache` memoises the call for the lifetime of
 * that render, so the database is asked once rather than twice. Without it the
 * `<title>` and the `<h1>` would come from two separate queries that could, in
 * principle, disagree.
 */
const loadDish = cache(async (slug: string) =>
  readAsGuest(getMenuItem, { slug })
)

/**
 * Every published dish, as a build-time path.
 *
 * `readAsGuest` is load-bearing twice over. It is what lets this run at all —
 * there is no request scope during a build, so the session read this used to
 * perform could only fail — and it is what makes the answer *correct*: the
 * pages generated here are served to strangers, so they must be built from the
 * stranger's view of the menu and nothing wider.
 *
 * A read failure is thrown rather than swallowed. `withAction` has already
 * turned a Prisma error into a value by this point, so the only way to reach
 * this branch is a database that genuinely could not answer, and a menu site
 * built against a database that could not answer should stop the build rather
 * than ship a `/menu/[slug]` segment with nothing behind it. That silent `[]`
 * is precisely the failure this ticket exists to remove.
 *
 * `pageSize: 100` is the schema's ceiling. Past a hundred dishes the tail is
 * rendered on first visit and then cached, which `dynamicParams` already
 * covers — it is a cold-start cost on the least-visited pages, not a gap.
 */
export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  const result = await readAsGuest(listMenuItems, {
    page: 1,
    pageSize: 100,
    sortBy: 'CURATED',
    sortDirection: 'asc',
  })

  if (!result.ok) {
    throw new Error(
      `generateStaticParams could not read the menu (${result.code}): ${result.error}`
    )
  }

  return result.data.items.map((dish) => ({ slug: dish.slug }))
}

export async function generateMetadata({
  params,
}: DishPageProps): Promise<Metadata> {
  const { slug } = await params
  const result = await loadDish(slug)

  if (!result.ok) {
    return {
      title: 'Dish not found',
      description:
        'That dish is not on the menu at the moment. Browse everything MannaChef is cooking this season.',
      robots: { index: false, follow: true },
    }
  }

  const dish = result.data
  const description =
    dish.tastingNote ??
    dish.description ??
    `${dish.name}, from the ${dish.categoryName} collection on the MannaChef menu.`

  const image = dish.primaryMedia

  return {
    title: dish.name,
    description,
    alternates: { canonical: `/menu/${dish.slug}` },
    openGraph: {
      type: 'article',
      title: `${dish.name} · MannaChef`,
      description,
      url: `/menu/${dish.slug}`,
      ...(image === null
        ? {}
        : {
            images: [
              {
                url: image.url,
                alt: image.alt,
                ...(image.width === null ? {} : { width: image.width }),
                ...(image.height === null ? {} : { height: image.height }),
              },
            ],
          }),
    },
    twitter: {
      card: 'summary_large_image',
      title: `${dish.name} · MannaChef`,
      description,
      ...(image === null ? {} : { images: [image.url] }),
    },
  }
}

export default async function DishPage({
  params,
}: DishPageProps): Promise<React.JSX.Element> {
  const { slug } = await params
  const result = await loadDish(slug)

  if (!result.ok) {
    // A dish that is not on the menu is a 404, not an error page — the action
    // answers `NOT_FOUND` both for a slug that never existed and for one that
    // is unpublished, and neither should render a dish-shaped page.
    if (result.code === 'NOT_FOUND') {
      notFound()
    }

    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-24 sm:px-8">
        <ReadFailure failure={result} subject="this dish" headingLevel={1} />
      </div>
    )
  }

  const dish = result.data
  const heat = spiceLevelLabel(dish.spiceLevel)
  const season = dish.isSeasonal
    ? seasonWindowLabel(dish.seasonStart, dish.seasonEnd)
    : null

  return (
    <article className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
      <Breadcrumbs
        categoryName={dish.categoryName}
        categorySlug={dish.categorySlug}
        dishName={dish.name}
      />

      <div className="mt-10 grid gap-12 lg:grid-cols-2 lg:gap-16">
        <Gallery dish={dish} />

        <div className="flex flex-col gap-6">
          <div>
            <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
              {dish.categoryName}
            </p>
            <h1 className="mt-4 font-display text-4xl leading-tight font-light tracking-tight text-linen text-balance sm:text-5xl">
              {dish.name}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Money
              cents={dish.basePriceCents}
              currency={dish.currency}
              tone="accent"
              weight="medium"
              className="text-xl"
            />
            <RatingStars
              rating={dish.averageRating}
              reviewCount={dish.reviewCount}
              size="md"
            />
          </div>

          {dish.tags.length === 0 &&
          season === null &&
          heat === null &&
          !dish.isSignature ? null : (
            <ul className="flex flex-wrap gap-2">
              {dish.isSignature ? (
                <li>
                  <Badge variant="outline">Signature dish</Badge>
                </li>
              ) : null}
              {season === null ? null : (
                <li>
                  <Badge variant="success" srPrefix="Season: ">
                    {season}
                  </Badge>
                </li>
              )}
              {heat === null ? null : (
                <li>
                  <Badge variant="muted" srPrefix="Heat: ">
                    {heat}
                  </Badge>
                </li>
              )}
              {dish.tags.map((tag) => (
                <li key={tag.id}>
                  <Badge
                    variant={tag.kind === 'ALLERGEN' ? 'warning' : 'muted'}
                    srPrefix={
                      tag.kind === 'ALLERGEN' ? 'Contains: ' : `${tag.kind}: `
                    }
                  >
                    {tag.name}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {dish.isSeasonal && !dish.isInSeason ? (
            <p
              role="status"
              className="rounded-md border border-terracotta/50 bg-terracotta/10 px-4 py-3 font-sans text-sm leading-relaxed text-linen"
            >
              This dish is out of season at the moment
              {season === null ? '' : ` — it returns for ${season}`}. It is not
              on the current menu, but we can plan a household menu around its
              return.
            </p>
          ) : null}

          <div aria-hidden="true" className="hairline" />

          {dish.tastingNote === null ? null : (
            <section aria-labelledby="tasting-note-heading">
              <h2
                id="tasting-note-heading"
                className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
              >
                Tasting note
              </h2>
              <p className="mt-3 font-sans text-base leading-relaxed text-parchment">
                {dish.tastingNote}
              </p>
            </section>
          )}

          {dish.pairingNote === null ? null : (
            <section aria-labelledby="pairing-note-heading">
              <h2
                id="pairing-note-heading"
                className="font-sans text-xs font-semibold tracking-[0.18em] text-stone uppercase"
              >
                Pairing
              </h2>
              <p className="mt-3 font-sans text-sm leading-relaxed text-parchment">
                {dish.pairingNote}
              </p>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Suspense fallback={<Skeleton className="h-10 w-44" />}>
              <ReviewsAction dishId={dish.id} dishName={dish.name} />
            </Suspense>
            <Button asChild variant="ghost">
              <Link href="/contact">Ask about this dish</Link>
            </Button>
          </div>
        </div>
      </div>

      {dish.story === null ? null : (
        <section
          aria-labelledby="story-heading"
          className="mt-20 max-w-3xl"
        >
          <h2
            id="story-heading"
            className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
          >
            Where it comes from
          </h2>
          <p className="mt-6 font-sans text-base leading-relaxed whitespace-pre-line text-parchment">
            {dish.story}
          </p>
        </section>
      )}

      <div className="mt-20 grid gap-12 lg:grid-cols-2 lg:gap-16">
        <Ingredients dish={dish} />
        <Nutrition dish={dish} />
      </div>
    </article>
  )
}

/** Where the guest is, expressed as links they can walk back up. */
function Breadcrumbs({
  categoryName,
  categorySlug,
  dishName,
}: {
  readonly categoryName: string
  readonly categorySlug: string
  readonly dishName: string
}): React.JSX.Element {
  const linkClasses =
    'rounded-sm underline-offset-4 transition-colors duration-200 ease-luxe hover:text-linen hover:underline'

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 font-sans text-sm text-stone">
        <li>
          <Link href="/menu" className={linkClasses}>
            The menu
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-3.5" />
        </li>
        <li>
          <Link href={`/menu?category=${categorySlug}`} className={linkClasses}>
            {categoryName}
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-3.5" />
        </li>
        <li aria-current="page" className="text-parchment">
          {dishName}
        </li>
      </ol>
    </nav>
  )
}

/**
 * The plate.
 *
 * The primary image leads at 4:3 and the rest of the gallery follows as a
 * square strip. There is no lightbox: opening a photograph in a modal is a
 * client island, a focus trap and a keyboard contract, and none of it tells a
 * guest anything the caption does not. Captions are rendered where the media
 * domain supplied one.
 */
function Gallery({ dish }: { readonly dish: MenuItemDetail }): React.JSX.Element {
  const [primary, ...rest] = dish.media

  return (
    <div className="flex flex-col gap-4">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-ash bg-charcoal">
        {primary === undefined ? (
          <span
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center text-stone"
          >
            <UtensilsCrossed className="size-10" />
          </span>
        ) : (
          <Image
            src={primary.url}
            alt={primary.alt}
            fill
            priority
            sizes="(min-width: 1024px) 32rem, 92vw"
            className="object-cover"
            {...(primary.blurData === null
              ? {}
              : {
                  placeholder: 'blur' as const,
                  blurDataURL: primary.blurData,
                })}
          />
        )}
      </div>

      {primary === undefined || primary.caption === null ? null : (
        <p className="font-sans text-xs leading-relaxed text-stone">
          {primary.caption}
          {primary.credit === null ? null : (
            <span className="text-ash"> · {primary.credit}</span>
          )}
        </p>
      )}

      {rest.length === 0 ? null : (
        <ul className="grid grid-cols-4 gap-3">
          {rest.slice(0, 4).map((media) => (
            <li key={media.id}>
              <figure>
                <div className="relative aspect-square w-full overflow-hidden rounded-md border border-ash bg-charcoal">
                  <Image
                    src={media.url}
                    alt={media.alt}
                    fill
                    sizes="(min-width: 1024px) 8rem, 22vw"
                    className="object-cover"
                    {...(media.blurData === null
                      ? {}
                      : {
                          placeholder: 'blur' as const,
                          blurDataURL: media.blurData,
                        })}
                  />
                </div>
                {media.caption === null ? null : (
                  <figcaption className="sr-only">{media.caption}</figcaption>
                )}
              </figure>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The reviews trigger, streamed separately from the dish.
 *
 * `listPublishedReviews` is asked for `APPROVED` and `FEATURED` explicitly —
 * the two statuses `PUBLISHED_REVIEW_STATUSES` allows — and the action
 * intersects whatever it is asked for with that pair, so there is no path from
 * this component to a `PENDING` or `REJECTED` review whatever it passes.
 *
 * A failed read renders nothing rather than an error box: reviews are an
 * embellishment on a dish page, and a claret panel where a button should be
 * would be a louder failure than the thing it is failing at.
 *
 * `readAsGuest` because the handler never consults `ctx.user` — the published
 * statuses are pinned for every caller — so the session it used to resolve
 * could not have changed a single row, and resolving it was the last cookie
 * read standing between this route and a real prerender.
 */
async function ReviewsAction({
  dishId,
  dishName,
}: {
  readonly dishId: string
  readonly dishName: string
}): Promise<React.JSX.Element | null> {
  const result = await readAsGuest(listPublishedReviews, {
    menuItemId: dishId,
    statuses: ['APPROVED', 'FEATURED'],
    page: 1,
    pageSize: 24,
    sortBy: 'CREATED',
    sortDirection: 'desc',
  })

  if (!result.ok || result.data.items.length === 0) {
    return null
  }

  const ratings = result.data.items.map((review) => review.rating)
  const average =
    ratings.length === 0
      ? null
      : ratings.reduce((total, rating) => total + rating, 0) / ratings.length

  return (
    <DishReviewsDialog
      dishName={dishName}
      reviews={result.data.items}
      averageRating={average}
      totalReviewCount={result.data.meta.total}
    />
  )
}

/** What is in it, with allergens marked rather than merely listed. */
function Ingredients({
  dish,
}: {
  readonly dish: MenuItemDetail
}): React.JSX.Element | null {
  if (dish.ingredients.length === 0) {
    return null
  }

  return (
    <section aria-labelledby="ingredients-heading">
      <h2
        id="ingredients-heading"
        className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
      >
        In the dish
      </h2>

      <Separator variant="subtle" className="mt-6" />

      <ul className="mt-6 flex flex-col gap-4">
        {dish.ingredients.map((ingredient) => (
          <li
            key={ingredient.id}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'font-sans text-sm text-linen',
                  ingredient.isOptional && 'text-parchment'
                )}
              >
                {ingredient.name}
              </span>
              {ingredient.isAllergen ? (
                <Badge variant="warning" srPrefix="Allergen: ">
                  Allergen
                </Badge>
              ) : null}
              {ingredient.isGarnish ? (
                <Badge variant="muted">Garnish</Badge>
              ) : null}
              {ingredient.isOptional ? (
                <Badge variant="muted">Optional</Badge>
              ) : null}
            </div>
            <span className="font-sans text-sm text-stone tabular-nums">
              {ingredientQuantityLabel(
                ingredient.quantity,
                ingredient.unit,
                ingredient.preparation
              )}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-6 font-sans text-xs leading-relaxed text-stone">
        Quantities are per serving as the dish is written. Any of them can be
        changed for an allergy or a preference — tell us at the consultation and
        the recipe is rewritten rather than garnished around.
      </p>
    </section>
  )
}

/** Macros, timings and yield, in one table of facts. */
function Nutrition({
  dish,
}: {
  readonly dish: MenuItemDetail
}): React.JSX.Element | null {
  const rows: Array<{ readonly term: string; readonly value: string }> = []

  if (dish.servingSize !== null) {
    rows.push({ term: 'Serving', value: dish.servingSize })
  }

  if (dish.servingsPerUnit !== null) {
    rows.push({
      term: 'Servings per dish',
      value: String(dish.servingsPerUnit),
    })
  }

  if (dish.prepTimeMinutes !== null) {
    rows.push({
      term: 'Preparation',
      value: `${String(dish.prepTimeMinutes)} min`,
    })
  }

  if (dish.cookTimeMinutes !== null) {
    rows.push({ term: 'Cooking', value: `${String(dish.cookTimeMinutes)} min` })
  }

  if (dish.calories !== null) {
    rows.push({ term: 'Energy', value: `${String(dish.calories)} kcal` })
  }

  if (dish.proteinGram !== null) {
    rows.push({ term: 'Protein', value: `${String(dish.proteinGram)} g` })
  }

  if (dish.carbGram !== null) {
    rows.push({ term: 'Carbohydrate', value: `${String(dish.carbGram)} g` })
  }

  if (dish.fatGram !== null) {
    rows.push({ term: 'Fat', value: `${String(dish.fatGram)} g` })
  }

  if (rows.length === 0) {
    return null
  }

  return (
    <section aria-labelledby="nutrition-heading">
      <h2
        id="nutrition-heading"
        className="font-display text-2xl leading-tight font-light tracking-tight text-linen sm:text-3xl"
      >
        Per serving
      </h2>

      <Card variant="quiet" className="mt-6">
        <CardContent className="p-6 pt-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            {rows.map((row) => (
              <div key={row.term} className="flex flex-col gap-1">
                <dt className="font-sans text-xs tracking-[0.14em] text-stone uppercase">
                  {row.term}
                </dt>
                <dd className="font-sans text-sm text-linen tabular-nums">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <p className="mt-6 font-sans text-xs leading-relaxed text-stone">
        Figures are the kitchen&rsquo;s own calculation for the dish as written
        and move with the portion we cook for your household.
      </p>
    </section>
  )
}
