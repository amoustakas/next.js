// mannachef/apps/web/src/server/actions/media.ts

'use server'

/**
 * Media domain Server Actions — the asset library behind every plate
 * photograph, chef portrait, and collection hero image.
 *
 * Every exported function here is produced by {@link withAction}, so each one
 * runs the six steps `mannachef/CONTRACT.md` §5 prescribes before touching a
 * row: resolve the session, enforce the minimum role, rate limit, `safeParse`
 * the raw payload, run, translate anything thrown into a guest-safe
 * `ActionResult`, and revalidate on success only.
 *
 * ## Who may read, and who may write
 *
 *  - **Reading is public.** A `MediaAsset` is a photograph that is already on
 *    the marketing site; there is nothing private about the pixels. The library
 *    listing is therefore `auth: 'PUBLIC'`.
 *  - **Writing is `ADMIN` and above.** Uploading, editing, tagging and deleting
 *    are all curation.
 *
 * ## Reading is public; the *metadata* is not
 *
 * `MediaAsset` carries three kinds of column, and the split is enforced by
 * running two different `select`s rather than by filtering a full row after the
 * fact — the columns a caller may not see are never read into the process:
 *
 *  1. **The photograph.** `url`, `alt`, `caption`, `credit`, dimensions, blur
 *     placeholder. Public.
 *  2. **The storage record.** `provider`, `providerFileKey`, `bytes`,
 *     `checksum`. A provider file key is a durable handle to an object in a
 *     bucket, and `CONTRACT.md` §5 is clear that infrastructure detail does not
 *     leave the server for a guest. `CHEF_STAFF` and above.
 *  3. **The attribution.** `uploadedById` and the uploader's name. Who
 *     photographed what is staff information about a colleague.
 *     `CHEF_STAFF` and above.
 *
 * The filters follow the same line. `uploadedById`, `needsAltText` and
 * `unattachedOnly` are curation filters over metadata a guest cannot see, so for
 * a caller below `CHEF_STAFF` they are **silently dropped** rather than refused
 * — the same rule `menu.ts` applies to `includeInactive`. A dropped filter
 * always widens the caller's result set back to the public view and never
 * narrows it to something they were not entitled to.
 *
 * ## Ownership
 *
 * §5 step 4 asks for an ownership check "for anything scoped to a client". No
 * row in this domain is: the library is one shared catalogue of imagery, and
 * `uploadedById` is attribution rather than tenancy — an asset uploaded by one
 * administrator is edited by the next without ceremony. There is accordingly no
 * `require*Ownership` guard here, and the protections are the role gate on every
 * write, the re-read of every id that arrives from a browser, and the split
 * projection above.
 *
 * ## Deleting is refused, not cascaded
 *
 * `MenuItemMedia.mediaAsset` is `onDelete: Cascade`, and both
 * `MenuCategory.heroMedia` and `StaffProfile.avatarMedia` are
 * `onDelete: SetNull`. Left to the database, deleting one asset would silently
 * strip a dish's lead photograph, blank a collection's hero, and remove a chef's
 * portrait — with no error anywhere. {@link deleteMediaAsset} therefore reads
 * every reference first and refuses while any remain, naming them.
 */

import { z } from 'zod'

import type { PageMeta, TagSummary } from '@mannachef/api-contract'
import {
  cuidSchema,
  hasRoleAtLeast,
  mediaAssetFilterSchema,
  mediaAssetFromUploadSchema,
  mediaAssetUpdateSchema,
  mediaBulkTagSchema,
  paginationToSkipTake,
  type MediaAssetSortBy,
  type MediaBulkTagMode,
  type MediaKind,
  type MediaProvider,
  type Role,
  type SortDirection,
} from '@mannachef/validators'

import {
  fail,
  ok,
  type ActionFailure,
  type ActionResult,
} from '@/server/actions/types'
import { Prisma, prisma } from '@/server/db'
import { withAction, type RevalidatePathTarget } from '@/server/guards'

// =============================================================================
// 0. Cache invalidation targets
// =============================================================================

/**
 * A library write can change what is rendered anywhere an image appears, which
 * on this platform is the whole public site plus the two admin surfaces.
 */
const MEDIA_REVALIDATE_PATHS: readonly RevalidatePathTarget[] = [
  '/',
  '/menu',
  { path: '/menu/[slug]', type: 'page' },
  '/admin/media',
  '/admin/menu',
]

/** Immediate expiry, so the library grid re-reads the row it just saved. */
const MEDIA_REVALIDATE_TAGS: readonly string[] = ['media']

// =============================================================================
// 1. Projections
//
// Two selects, one per privilege level. The public one is a strict subset, so a
// caller below CHEF_STAFF never has the storage record or the attribution read
// into the process at all — this is the "select only the columns the caller is
// allowed to see" rule made structural rather than remembered.
// =============================================================================

const TAG_SUMMARY_SELECT = Prisma.validator<Prisma.TagSelect>()({
  id: true,
  slug: true,
  name: true,
  kind: true,
  colorToken: true,
})

/** What anyone may read. */
const MEDIA_PUBLIC_SELECT = Prisma.validator<Prisma.MediaAssetSelect>()({
  id: true,
  url: true,
  thumbnailUrl: true,
  alt: true,
  caption: true,
  credit: true,
  kind: true,
  width: true,
  height: true,
  blurData: true,
  mimeType: true,
  createdAt: true,
  tags: {
    where: { tag: { isActive: true } },
    orderBy: [{ tag: { sortOrder: 'asc' } }, { tag: { name: 'asc' } }],
    select: { tag: { select: TAG_SUMMARY_SELECT } },
  },
})

/** The public columns plus the storage record, the attribution, and the usage. */
const MEDIA_LIBRARY_SELECT = Prisma.validator<Prisma.MediaAssetSelect>()({
  id: true,
  url: true,
  thumbnailUrl: true,
  alt: true,
  caption: true,
  credit: true,
  kind: true,
  width: true,
  height: true,
  blurData: true,
  mimeType: true,
  createdAt: true,
  updatedAt: true,
  provider: true,
  providerFileKey: true,
  bytes: true,
  checksum: true,
  uploadedById: true,
  uploadedBy: { select: { name: true } },
  tags: {
    where: { tag: { isActive: true } },
    orderBy: [{ tag: { sortOrder: 'asc' } }, { tag: { name: 'asc' } }],
    select: { tag: { select: TAG_SUMMARY_SELECT } },
  },
  _count: {
    select: { menuItemMedia: true, menuCategories: true, staffAvatars: true },
  },
})

type MediaPublicRow = Prisma.MediaAssetGetPayload<{
  select: typeof MEDIA_PUBLIC_SELECT
}>

type MediaLibraryRow = Prisma.MediaAssetGetPayload<{
  select: typeof MEDIA_LIBRARY_SELECT
}>

// =============================================================================
// 2. Return shapes
// =============================================================================

/** Where an asset is currently in use. */
export interface MediaUsageView {
  readonly menuItemCount: number
  readonly menuCategoryCount: number
  readonly staffAvatarCount: number
  readonly total: number
}

/**
 * The curation half of an asset. `null` for every caller below `CHEF_STAFF`,
 * because none of these columns is public — see the module docblock.
 */
export interface MediaLibraryDetailView {
  readonly provider: MediaProvider
  readonly providerFileKey: string | null
  readonly bytes: number | null
  readonly checksum: string | null
  readonly uploadedById: string | null
  readonly uploadedByName: string | null
  readonly updatedAt: Date
  readonly usage: MediaUsageView
}

/** One asset in the library. */
export interface MediaAssetView {
  readonly id: string
  readonly url: string
  readonly thumbnailUrl: string | null
  readonly alt: string
  readonly caption: string | null
  readonly credit: string | null
  readonly kind: MediaKind
  readonly width: number | null
  readonly height: number | null
  readonly blurData: string | null
  readonly mimeType: string
  readonly createdAt: Date
  readonly tags: readonly TagSummary[]
  /** Present only for `CHEF_STAFF` and above. */
  readonly library: MediaLibraryDetailView | null
}

/** A page of the library. */
export interface MediaAssetListView {
  readonly items: readonly MediaAssetView[]
  readonly meta: PageMeta
}

/** What persisting a finished upload acknowledges. */
export interface MediaUploadResultView {
  readonly id: string
  readonly url: string
  readonly alt: string
  readonly kind: MediaKind
  readonly tagCount: number
  /**
   * `false` when the callback fired twice for the same storage key and this
   * call refreshed the existing row instead of inserting a second one.
   */
  readonly created: boolean
}

/** What an edit acknowledges. */
export interface MediaAssetMutationView {
  readonly id: string
  readonly url: string
  readonly alt: string
  readonly kind: MediaKind
}

/** What a bulk tagging pass changed. */
export interface MediaBulkTagResultView {
  readonly mode: MediaBulkTagMode
  readonly assetCount: number
  readonly tagCount: number
  readonly linksCreated: number
  readonly linksRemoved: number
}

/** What a deletion acknowledges. */
export interface MediaDeletionView {
  readonly id: string
  readonly alt: string
  /**
   * The storage key the object still occupies at the provider. The database row
   * is gone; the bytes are not. Deleting the object itself belongs to the
   * storage lifecycle job rather than to a request the operator is waiting on,
   * and this is the handle that job needs.
   */
  readonly providerFileKey: string | null
  readonly provider: MediaProvider
  /** Tag links removed alongside the row. */
  readonly tagLinksRemoved: number
}

// =============================================================================
// 3. Locally composed input schema
//
// Every domain rule this module validates against comes from
// `@mannachef/validators` and none is restated. The one below describes an
// operation rather than an entity — "delete the asset with this id" — and is
// nothing but the shared `cuidSchema` in an envelope.
// =============================================================================

const mediaAssetIdSchema = z.strictObject({ id: cuidSchema })

// =============================================================================
// 4. Shared helpers
// =============================================================================

/**
 * The standard list envelope.
 *
 * Duplicated from `menu.ts` rather than shared: a `'use server'` module may only
 * export async functions, so a helper cannot cross between two of them.
 */
function buildPageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0

  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  }
}

/** `true` when the caller may read the storage record and the attribution. */
function isCurator(role: Role | null): boolean {
  return hasRoleAtLeast(role, 'CHEF_STAFF')
}

function toPublicMediaView(row: MediaPublicRow): MediaAssetView {
  return {
    id: row.id,
    url: row.url,
    thumbnailUrl: row.thumbnailUrl,
    alt: row.alt,
    caption: row.caption,
    credit: row.credit,
    kind: row.kind,
    width: row.width,
    height: row.height,
    blurData: row.blurData,
    mimeType: row.mimeType,
    createdAt: row.createdAt,
    tags: row.tags.map((edge) => edge.tag),
    library: null,
  }
}

function toLibraryMediaView(row: MediaLibraryRow): MediaAssetView {
  return {
    ...toPublicMediaView(row),
    library: {
      provider: row.provider,
      providerFileKey: row.providerFileKey,
      bytes: row.bytes,
      checksum: row.checksum,
      uploadedById: row.uploadedById,
      uploadedByName: row.uploadedBy?.name ?? null,
      updatedAt: row.updatedAt,
      usage: {
        menuItemCount: row._count.menuItemMedia,
        menuCategoryCount: row._count.menuCategories,
        staffAvatarCount: row._count.staffAvatars,
        total:
          row._count.menuItemMedia +
          row._count.menuCategories +
          row._count.staffAvatars,
      },
    },
  }
}

/** `a`, `a and b`, `a, b and c`. */
function formatList(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? ''
  }

  const head = parts.slice(0, -1).join(', ')
  const tail = parts[parts.length - 1] ?? ''

  return `${head} and ${tail}`
}

/** Names the first requested id that no row answered to. */
function missingIds(
  requested: readonly string[],
  found: readonly { readonly id: string }[]
): string[] {
  const present = new Set(found.map((row) => row.id))
  return requested.filter((id) => !present.has(id))
}

/**
 * Confirms every tag id in a payload resolves to a real tag.
 *
 * Returns the failure to hand straight back, or `null` when the set is clean.
 * Applying a tag that has just been retired from the vocabulary would otherwise
 * be a foreign key violation dressed up as an internal error.
 */
async function rejectUnknownTags(
  db: typeof prisma,
  tagIds: readonly string[]
): Promise<ActionFailure | null> {
  if (tagIds.length === 0) {
    return null
  }

  const tags = await db.tag.findMany({
    where: { id: { in: [...tagIds] } },
    select: { id: true },
  })

  if (missingIds(tagIds, tags).length === 0) {
    return null
  }

  return fail(
    'NOT_FOUND',
    'One of those tags is no longer in the vocabulary. Please refresh and try again.',
    { tagIds: ['One of those tags is no longer in the vocabulary.'] }
  )
}

// =============================================================================
// 5. Reading the library
// =============================================================================

/**
 * Browse the asset library.
 *
 * Public, with the projection and three of the filters narrowed by role — see
 * the module docblock for the exact split. The two `findMany` branches differ
 * only in their `select`, and that difference is the whole access control: the
 * public branch cannot leak a storage key because it never reads one.
 *
 * There is deliberately no rate limit, for the same reason as `menu.list`: this
 * runs during static generation, where `headers()` yields no address and every
 * anonymous render would share one bucket.
 */
export const listMediaAssets = withAction(
  { name: 'media.list', auth: 'PUBLIC', input: mediaAssetFilterSchema },
  async (ctx, filter): Promise<ActionResult<MediaAssetListView>> => {
    const role = ctx.user?.role ?? null
    const mayCurate = isCurator(role)

    const filters: Prisma.MediaAssetWhereInput[] = []

    if (filter.search !== undefined) {
      filters.push({
        OR: [
          { alt: { contains: filter.search, mode: 'insensitive' } },
          { caption: { contains: filter.search, mode: 'insensitive' } },
          { credit: { contains: filter.search, mode: 'insensitive' } },
        ],
      })
    }

    if (filter.kinds.length > 0) {
      filters.push({ kind: { in: [...filter.kinds] } })
    }

    if (filter.providers.length > 0) {
      filters.push({ provider: { in: [...filter.providers] } })
    }

    if (filter.mimeTypePrefix !== undefined) {
      filters.push({ mimeType: { startsWith: filter.mimeTypePrefix } })
    }

    if (filter.createdFrom !== undefined) {
      filters.push({ createdAt: { gte: filter.createdFrom } })
    }

    if (filter.createdTo !== undefined) {
      filters.push({ createdAt: { lte: filter.createdTo } })
    }

    if (filter.tagSlugs.length > 0) {
      if (filter.tagMatchMode === 'ANY') {
        filters.push({
          tags: { some: { tag: { slug: { in: [...filter.tagSlugs] } } } },
        })
      } else {
        // `ALL` is a conjunction of independent `some` clauses. A single
        // `every` would also match an asset carrying no tags at all.
        for (const slug of filter.tagSlugs) {
          filters.push({ tags: { some: { tag: { slug } } } })
        }
      }
    }

    // The three curation filters. Silently dropped below CHEF_STAFF — see the
    // module docblock on why a dropped filter is safe and a refusal is not.
    if (mayCurate) {
      if (filter.uploadedById !== undefined) {
        filters.push({ uploadedById: filter.uploadedById })
      }

      if (filter.needsAltText) {
        filters.push({ alt: '' })
      }

      if (filter.unattachedOnly) {
        filters.push({
          menuItemMedia: { none: {} },
          menuCategories: { none: {} },
          staffAvatars: { none: {} },
        })
      }
    }

    const where: Prisma.MediaAssetWhereInput = { AND: filters }
    const { skip, take } = paginationToSkipTake(filter)
    const orderBy = mediaOrderBy(filter.sortBy, filter.sortDirection)

    const total = await ctx.db.mediaAsset.count({ where })

    if (mayCurate) {
      const rows = await ctx.db.mediaAsset.findMany({
        where,
        select: MEDIA_LIBRARY_SELECT,
        orderBy,
        skip,
        take,
      })

      return ok({
        items: rows.map(toLibraryMediaView),
        meta: buildPageMeta(filter.page, filter.pageSize, total),
      })
    }

    const rows = await ctx.db.mediaAsset.findMany({
      where,
      select: MEDIA_PUBLIC_SELECT,
      orderBy,
      skip,
      take,
    })

    return ok({
      items: rows.map(toPublicMediaView),
      meta: buildPageMeta(filter.page, filter.pageSize, total),
    })
  }
)

function mediaOrderBy(
  sortBy: MediaAssetSortBy,
  direction: SortDirection
): Prisma.MediaAssetOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'UPDATED':
      return [{ updatedAt: direction }, { id: 'asc' }]

    case 'SIZE':
      // A legacy row with no recorded size sorts last in either direction
      // rather than crowding the head of the page.
      return [{ bytes: { sort: direction, nulls: 'last' } }, { id: 'asc' }]

    case 'KIND':
      return [{ kind: direction }, { createdAt: 'desc' }, { id: 'asc' }]

    case 'ALT':
      return [{ alt: direction }, { id: 'asc' }]

    case 'CREATED':
      return [{ createdAt: direction }, { id: 'asc' }]

    default: {
      // A new member of `mediaAssetSortBySchema` is a compile error here rather
      // than a silently unordered page.
      const exhaustive: never = sortBy
      return exhaustive
    }
  }
}

// =============================================================================
// 6. Upload completion
// =============================================================================

/**
 * Turn a finished UploadThing upload into a library entry. `ADMIN` and above.
 *
 * ## The payload is client input
 *
 * UploadThing's completion callback runs in the browser, so `key`, `url`,
 * `name`, `size` and `type` all arrive across the trust boundary — which is why
 * they go through `mediaAssetFromUploadSchema` like anything else, and why the
 * uploader is taken from the session rather than from the payload.
 * `mediaAssetCreateSchema` deliberately has no `uploadedById` field for exactly
 * this reason.
 *
 * ## Alternative text is not optional
 *
 * `MediaAsset.alt` is a non-nullable column and `altTextSchema` rejects a blank
 * string, so an asset cannot enter the library without a description a screen
 * reader can announce. That rule is enforced at the schema, so this handler
 * needs no check of its own — and could not weaken it if it wanted to.
 *
 * ## Firing twice is not an error
 *
 * A client callback can fire more than once for one upload — a retried request,
 * a remounted component. `@@unique([provider, providerFileKey])` makes the
 * second insert a `P2002`, and reporting "that already exists" for a *successful*
 * upload would be a lie told to an administrator who did nothing wrong. This is
 * therefore an upsert keyed on the storage identity: the descriptive fields are
 * refreshed, the original uploader is kept, and `created` says which happened.
 */
export const completeMediaUpload = withAction(
  {
    name: 'media.upload.complete',
    auth: 'ADMIN',
    input: mediaAssetFromUploadSchema,
    revalidatePaths: MEDIA_REVALIDATE_PATHS,
    revalidateTags: MEDIA_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MediaUploadResultView>> => {
    const { asset, tagIds } = input

    const unknownTags = await rejectUnknownTags(ctx.db, tagIds)

    if (unknownTags !== null) {
      return unknownTags
    }

    const providerFileKey = asset.providerFileKey ?? null

    if (providerFileKey === null) {
      // `uploadCompletionSchema.key` is required and non-empty, so this is
      // unreachable through the schema. It is checked anyway because the upsert
      // below addresses the row by the compound key, and a null half of that
      // key would silently turn an idempotent write into a duplicate insert.
      return fail(
        'VALIDATION',
        'That upload did not return a storage key, so it cannot be filed. Please try uploading it again.',
        { upload: ['That upload did not return a storage key.'] }
      )
    }

    const existing = await ctx.db.mediaAsset.findUnique({
      where: {
        provider_providerFileKey: { provider: asset.provider, providerFileKey },
      },
      select: { id: true },
    })

    const saved = await ctx.db.$transaction(async (tx) => {
      const row = await tx.mediaAsset.upsert({
        where: {
          provider_providerFileKey: {
            provider: asset.provider,
            providerFileKey,
          },
        },
        create: {
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl ?? null,
          alt: asset.alt,
          caption: asset.caption ?? null,
          credit: asset.credit ?? null,
          kind: asset.kind,
          provider: asset.provider,
          providerFileKey,
          width: asset.width ?? null,
          height: asset.height ?? null,
          bytes: asset.bytes ?? null,
          mimeType: asset.mimeType,
          blurData: asset.blurData ?? null,
          checksum: asset.checksum ?? null,
          uploadedById: ctx.user.id,
        },
        update: {
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl ?? null,
          alt: asset.alt,
          caption: asset.caption ?? null,
          credit: asset.credit ?? null,
          kind: asset.kind,
          width: asset.width ?? null,
          height: asset.height ?? null,
          bytes: asset.bytes ?? null,
          mimeType: asset.mimeType,
          blurData: asset.blurData ?? null,
          checksum: asset.checksum ?? null,
        },
        select: { id: true, url: true, alt: true, kind: true },
      })

      if (tagIds.length > 0) {
        await tx.mediaTag.createMany({
          data: tagIds.map((tagId) => ({ mediaAssetId: row.id, tagId })),
          skipDuplicates: true,
        })
      }

      return row
    })

    return ok({
      id: saved.id,
      url: saved.url,
      alt: saved.alt,
      kind: saved.kind,
      tagCount: tagIds.length,
      created: existing === null,
    })
  }
)

// =============================================================================
// 7. Editing
// =============================================================================

/**
 * Edit an asset's description, caption, credit, or storage record.
 * `ADMIN` and above.
 *
 * `mediaAssetUpdateSchema` has already refused a payload that carries nothing
 * but an id, and has already refused a blank `alt`. What is left for the handler
 * is the pair of things a schema cannot know: that the row still exists, and
 * that moving it to a new `(provider, providerFileKey)` will not collide with an
 * asset that is already filed there.
 */
export const updateMediaAsset = withAction(
  {
    name: 'media.update',
    auth: 'ADMIN',
    input: mediaAssetUpdateSchema,
    revalidatePaths: MEDIA_REVALIDATE_PATHS,
    revalidateTags: MEDIA_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MediaAssetMutationView>> => {
    const existing = await ctx.db.mediaAsset.findUnique({
      where: { id: input.id },
      select: { id: true, provider: true, providerFileKey: true },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That asset is no longer in the library.')
    }

    const provider = input.provider ?? existing.provider
    const providerFileKey =
      input.providerFileKey === undefined
        ? existing.providerFileKey
        : input.providerFileKey

    const movesStorage =
      provider !== existing.provider ||
      providerFileKey !== existing.providerFileKey

    if (movesStorage && providerFileKey !== null) {
      const clash = await ctx.db.mediaAsset.findUnique({
        where: { provider_providerFileKey: { provider, providerFileKey } },
        select: { id: true },
      })

      if (clash !== null && clash.id !== existing.id) {
        return fail(
          'CONFLICT',
          'Another asset is already filed under that storage key.',
          {
            providerFileKey: [
              'Another asset is already filed under that storage key.',
            ],
          }
        )
      }
    }

    const updated = await ctx.db.mediaAsset.update({
      where: { id: existing.id },
      data: {
        ...(input.url !== undefined && { url: input.url }),
        ...(input.thumbnailUrl !== undefined && {
          thumbnailUrl: input.thumbnailUrl,
        }),
        ...(input.alt !== undefined && { alt: input.alt }),
        ...(input.caption !== undefined && { caption: input.caption }),
        ...(input.credit !== undefined && { credit: input.credit }),
        ...(input.kind !== undefined && { kind: input.kind }),
        ...(input.provider !== undefined && { provider: input.provider }),
        ...(input.providerFileKey !== undefined && {
          providerFileKey: input.providerFileKey,
        }),
        ...(input.width !== undefined && { width: input.width }),
        ...(input.height !== undefined && { height: input.height }),
        ...(input.bytes !== undefined && { bytes: input.bytes }),
        ...(input.mimeType !== undefined && { mimeType: input.mimeType }),
        ...(input.blurData !== undefined && { blurData: input.blurData }),
        ...(input.checksum !== undefined && { checksum: input.checksum }),
      },
      select: { id: true, url: true, alt: true, kind: true },
    })

    return ok(updated)
  }
)

// =============================================================================
// 8. Bulk tagging
// =============================================================================

/**
 * Add, remove, or replace the tags on a selection of assets. `ADMIN` and above.
 *
 * `mediaBulkTagSchema` already guarantees that `ADD` and `REMOVE` carry at least
 * one tag, while `REPLACE` may carry none — an empty `REPLACE` is how a
 * selection is stripped bare, and it is the only mode for which that is
 * meaningful.
 *
 * Both the asset ids and the tag ids are re-read before anything is written, and
 * the whole pass runs in one transaction so a `REPLACE` never leaves a selection
 * momentarily untagged.
 */
export const bulkTagMediaAssets = withAction(
  {
    name: 'media.tags.bulk',
    auth: 'ADMIN',
    input: mediaBulkTagSchema,
    revalidatePaths: MEDIA_REVALIDATE_PATHS,
    revalidateTags: MEDIA_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MediaBulkTagResultView>> => {
    const assets = await ctx.db.mediaAsset.findMany({
      where: { id: { in: [...input.mediaAssetIds] } },
      select: { id: true },
    })

    if (missingIds(input.mediaAssetIds, assets).length > 0) {
      return fail(
        'NOT_FOUND',
        'One of the selected assets is no longer in the library. Please refresh and try again.'
      )
    }

    const unknownTags = await rejectUnknownTags(ctx.db, input.tagIds)

    if (unknownTags !== null) {
      return unknownTags
    }

    const assetIds = assets.map((row) => row.id)
    const tagIds = [...input.tagIds]

    const { linksCreated, linksRemoved } = await ctx.db.$transaction(
      async (tx) => {
        if (input.mode === 'REMOVE') {
          const removed = await tx.mediaTag.deleteMany({
            where: { mediaAssetId: { in: assetIds }, tagId: { in: tagIds } },
          })

          return { linksCreated: 0, linksRemoved: removed.count }
        }

        let removedCount = 0

        if (input.mode === 'REPLACE') {
          const removed = await tx.mediaTag.deleteMany({
            where: {
              mediaAssetId: { in: assetIds },
              ...(tagIds.length > 0 && { tagId: { notIn: tagIds } }),
            },
          })

          removedCount = removed.count
        }

        if (tagIds.length === 0) {
          return { linksCreated: 0, linksRemoved: removedCount }
        }

        const created = await tx.mediaTag.createMany({
          data: assetIds.flatMap((mediaAssetId) =>
            tagIds.map((tagId) => ({ mediaAssetId, tagId }))
          ),
          skipDuplicates: true,
        })

        return { linksCreated: created.count, linksRemoved: removedCount }
      }
    )

    return ok({
      mode: input.mode,
      assetCount: assetIds.length,
      tagCount: tagIds.length,
      linksCreated,
      linksRemoved,
    })
  }
)

// =============================================================================
// 9. Deleting
// =============================================================================

/** How many referencing rows a refusal names before it says "and N more". */
const MAX_NAMED_REFERENCES = 5

/**
 * Remove an asset from the library. `ADMIN` and above.
 *
 * **Refuses while anything still points at it**, and says what. The three
 * references and what the database would otherwise do with them:
 *
 * | Reference                    | Foreign key behaviour | Silent damage                  |
 * | ---------------------------- | --------------------- | ------------------------------ |
 * | `MenuItemMedia.mediaAsset`   | `Cascade`             | the dish loses a gallery entry |
 * | `MenuCategory.heroMedia`     | `SetNull`             | the collection loses its hero  |
 * | `StaffProfile.avatarMedia`   | `SetNull`             | the chef loses their portrait  |
 *
 * None of the three raises an error on its own, which is precisely why this
 * check exists: an operator tidying the library would otherwise blank three
 * pages and be told the deletion succeeded.
 *
 * The refusal names up to {@link MAX_NAMED_REFERENCES} referencing rows in the
 * sentence, and carries the full list under the `_references` key of
 * `fieldErrors`. That key is not a form field, and the leading underscore
 * follows the same convention as `FORM_ERROR_KEY` in
 * `@/server/actions/types`: `z.core.toDotPath` never produces a leading
 * underscore, so it cannot collide with a real path. `fieldErrors` is the only
 * structured channel an `ActionFailure` has, and a list of names is exactly the
 * shape it carries.
 *
 * The stored object itself is left at the provider — see
 * {@link MediaDeletionView.providerFileKey}.
 */
export const deleteMediaAsset = withAction(
  {
    name: 'media.delete',
    auth: 'ADMIN',
    input: mediaAssetIdSchema,
    revalidatePaths: MEDIA_REVALIDATE_PATHS,
    revalidateTags: MEDIA_REVALIDATE_TAGS,
  },
  async (ctx, input): Promise<ActionResult<MediaDeletionView>> => {
    const existing = await ctx.db.mediaAsset.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        alt: true,
        provider: true,
        providerFileKey: true,
        _count: {
          select: {
            menuItemMedia: true,
            menuCategories: true,
            staffAvatars: true,
            tags: true,
          },
        },
        menuItemMedia: {
          take: MAX_NAMED_REFERENCES,
          orderBy: { menuItem: { name: 'asc' } },
          select: { menuItem: { select: { name: true } } },
        },
        menuCategories: {
          take: MAX_NAMED_REFERENCES,
          orderBy: { name: 'asc' },
          select: { name: true },
        },
        staffAvatars: {
          take: MAX_NAMED_REFERENCES,
          orderBy: { id: 'asc' },
          select: { title: true, user: { select: { name: true } } },
        },
      },
    })

    if (existing === null) {
      return fail('NOT_FOUND', 'That asset is no longer in the library.')
    }

    const referenceCount =
      existing._count.menuItemMedia +
      existing._count.menuCategories +
      existing._count.staffAvatars

    if (referenceCount > 0) {
      const references: string[] = [
        ...existing.menuItemMedia.map((edge) => `Dish: ${edge.menuItem.name}`),
        ...existing.menuCategories.map(
          (category) => `Collection: ${category.name}`
        ),
        ...existing.staffAvatars.map(
          (staff) =>
            `Chef portrait: ${staff.user.name ?? staff.title ?? 'unnamed chef'}`
        ),
      ]

      const clauses: string[] = []

      if (existing._count.menuItemMedia > 0) {
        clauses.push(
          `${existing._count.menuItemMedia} ${existing._count.menuItemMedia === 1 ? 'dish' : 'dishes'}`
        )
      }

      if (existing._count.menuCategories > 0) {
        clauses.push(
          `${existing._count.menuCategories} ${existing._count.menuCategories === 1 ? 'collection' : 'collections'}`
        )
      }

      if (existing._count.staffAvatars > 0) {
        clauses.push(
          `${existing._count.staffAvatars} ${existing._count.staffAvatars === 1 ? 'chef portrait' : 'chef portraits'}`
        )
      }

      const named = references.slice(0, MAX_NAMED_REFERENCES)
      const overflow = referenceCount - named.length

      const detail =
        named.length === 0
          ? ''
          : ` — ${formatList(named.map((entry) => `“${entry}”`))}${overflow > 0 ? `, and ${overflow} more` : ''}`

      return fail(
        'CONFLICT',
        `This asset is still in use on ${formatList(clauses)}${detail}. Detach it there, or replace it in place, before removing it from the library.`,
        { _references: references }
      )
    }

    await ctx.db.mediaAsset.delete({ where: { id: existing.id } })

    return ok({
      id: existing.id,
      alt: existing.alt,
      providerFileKey: existing.providerFileKey,
      provider: existing.provider,
      tagLinksRemoved: existing._count.tags,
    })
  }
)
