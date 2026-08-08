// mannachef/apps/web/src/app/(admin)/admin/media/page.tsx
import type { Metadata } from 'next'

import type { MediaAssetListView } from '@/server/actions/media'
import { listMediaAssets } from '@/server/actions/media'
import type { TagListView } from '@/server/actions/menu'
import { listTags } from '@/server/actions/menu'
import { MediaGrid } from '@/components/admin/media/media-grid'

export const metadata: Metadata = {
  title: 'Media Library — MannaChef Admin',
  description:
    'Search, tag, and curate every plate photograph, chef portrait, and collection hero image in the MannaChef library.',
}

/** How many tags the filter and tagging pickers offer at once. */
const TAG_PAGE_SIZE = 100

/** Falls back to an honestly empty page when the initial read fails. */
const EMPTY_MEDIA_LIST: MediaAssetListView = {
  items: [],
  meta: {
    page: 1,
    pageSize: 24,
    total: 0,
    pageCount: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  },
}

const EMPTY_TAG_LIST: TagListView = {
  items: [],
  meta: {
    page: 1,
    pageSize: TAG_PAGE_SIZE,
    total: 0,
    pageCount: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  },
}

/**
 * The media library.
 *
 * A Server Component fetches the first page of assets and the full roster of
 * tags — both are `PUBLIC` reads, but calling them from here rather than the
 * client means the grid paints with real content on the first byte instead of
 * a skeleton. Every filter, upload, edit, and delete after that is handled by
 * {@link MediaGrid}, which is a client boundary precisely because searching,
 * tagging, and confirming a deletion are the only parts of this screen that
 * need interactivity.
 */
export default async function MediaLibraryPage() {
  const [assetsResult, tagsResult] = await Promise.all([
    listMediaAssets({ pageSize: 24 }),
    listTags({ pageSize: TAG_PAGE_SIZE, sortBy: 'NAME', sortDirection: 'asc' }),
  ])

  const initialAssets = assetsResult.ok ? assetsResult.data : EMPTY_MEDIA_LIST
  const tags = tagsResult.ok ? tagsResult.data : EMPTY_TAG_LIST

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1
          id="media-library-heading"
          className="font-display text-3xl leading-tight font-medium tracking-tight text-linen sm:text-4xl"
        >
          Media Library
        </h1>
        <p className="max-w-prose font-sans text-sm leading-relaxed text-parchment">
          Every plate photograph, chef portrait, and collection hero image lives
          here. Every upload carries a written description before it joins the
          library, so the library is never a place a screen-reader guest cannot
          follow.
        </p>
      </header>

      <section aria-labelledby="media-library-heading">
        <MediaGrid initialAssets={initialAssets} tags={tags.items} />
      </section>
    </div>
  )
}
