// mannachef/apps/web/src/components/admin/view-models.ts

/**
 * What crosses from a Server Component into the admin's client components.
 *
 * Every one of these shapes has a counterpart inside `src/server/actions/**` —
 * `MenuCategoryView`, `TagView`, `MediaAssetView` — and none of them is imported
 * from there. Two reasons, and the second is the one that matters:
 *
 *  1. Those modules carry `'use server'` and pull in Prisma. Importing one into
 *     a client component *for a type* is erased by `verbatimModuleSyntax`, so it
 *     is harmless at runtime — but it is a reference that stops being type-only
 *     the moment somebody adds a value to the import, and nothing in the build
 *     complains until the browser bundle has grown a database client.
 *  2. Declaring the boundary here makes it *readable*. This file is the complete
 *     list of what the admin browser bundle knows about a dish, an asset and a
 *     tag. A column that is not on it — `chefNote`, `providerFileKey`, an
 *     uploader's identity — was a decision, not an omission.
 *
 * The mapping happens in the page that fetches, which is a Server Component, so
 * a field added to an action's return type does not silently start crossing the
 * wire.
 *
 * `Date` survives the RSC payload intact, so timestamps stay `Date` here rather
 * than being stringified and re-parsed on the other side.
 */

import type {
  MediaKind,
  Role,
  SpiceLevel,
  TagKind,
} from '@mannachef/validators'

// =============================================================================
// 1. The operator
// =============================================================================

/** The signed-in operator, as the chrome and the command bar know them. */
export interface AdminViewerView {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  readonly image: string | null
  readonly role: Role
  /** `ADMIN` and above. Every menu and media *write* sits behind this. */
  readonly canCurate: boolean
  /** `SUPER_ADMIN`. Role assignment and the destructive settings. */
  readonly canGovern: boolean
}

// =============================================================================
// 2. Taxonomy
// =============================================================================

/** A collection, as the dish form's picker and the taxonomy table need it. */
export interface AdminCategoryView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly tagline: string | null
  readonly description: string | null
  readonly sortOrder: number
  readonly isActive: boolean
  readonly heroMediaId: string | null
  readonly heroMediaUrl: string | null
  readonly heroMediaAlt: string | null
  readonly subcategoryCount: number
  readonly menuItemCount: number
}

/** A course within a collection. */
export interface AdminSubcategoryView {
  readonly id: string
  readonly categoryId: string
  readonly categoryName: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly sortOrder: number
  readonly isActive: boolean
  readonly menuItemCount: number
}

/** A tag, with how widely it is used. */
export interface AdminTagView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: TagKind
  readonly description: string | null
  readonly colorToken: string | null
  readonly sortOrder: number
  readonly isActive: boolean
  readonly menuItemCount: number
  readonly mediaCount: number
}

// =============================================================================
// 3. Media
// =============================================================================

/** A tag chip, as it hangs off a dish or an asset. */
export interface AdminTagChip {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: TagKind
  readonly colorToken: string | null
}

/** Where an asset is currently in use. Drives the refusal a delete surfaces. */
export interface AdminMediaUsage {
  readonly menuItemCount: number
  readonly menuCategoryCount: number
  readonly staffAvatarCount: number
  readonly total: number
}

/**
 * One asset in the library.
 *
 * `providerFileKey`, `checksum` and the uploader's id are deliberately absent:
 * a storage handle is infrastructure, and no admin screen renders one.
 * `uploadedByName` is here because the library grid credits the photographer.
 */
export interface AdminMediaAssetView {
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
  readonly bytes: number | null
  readonly createdAt: Date
  readonly uploadedByName: string | null
  readonly tags: readonly AdminTagChip[]
  /** `null` for a viewer below `CHEF_STAFF`, which the admin shell excludes. */
  readonly usage: AdminMediaUsage | null
}

// =============================================================================
// 4. Dishes
// =============================================================================

/** A dish as the menu table renders it. */
export interface AdminMenuItemView {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly categoryId: string
  readonly categoryName: string
  readonly subcategorySlug: string | null
  readonly basePriceCents: number
  readonly currency: string
  readonly spiceLevel: SpiceLevel
  readonly isSeasonal: boolean
  readonly seasonStart: number | null
  readonly seasonEnd: number | null
  readonly isSignature: boolean
  readonly isActive: boolean
  readonly sortOrder: number
  readonly tags: readonly AdminTagChip[]
  readonly primaryMediaUrl: string | null
  readonly primaryMediaAlt: string | null
  readonly averageRating: number | null
  readonly reviewCount: number
}

/** The list envelope, exactly as every action returns it. */
export interface AdminPageMeta {
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly pageCount: number
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
}

// =============================================================================
// 5. Presentation vocabulary
// =============================================================================

/** The twelve months, for the seasonal window pickers. */
export const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `3` → `March`. Out-of-range and `null` both read as an em dash. */
export function monthName(month: number | null): string {
  if (month === null) {
    return '—'
  }

  return MONTH_NAMES[month - 1] ?? '—'
}

/**
 * Is `month` inside `[start, end]`, counting a window that wraps the new year?
 *
 * The client half of `isMonthInSeason` in `src/server/actions/menu.ts`, written
 * to agree with it case for case. It exists so the table can say "in season"
 * without a round trip, and so an optimistic seasonal toggle can predict what
 * the server is about to answer.
 */
export function isMonthWithinSeason(
  seasonStart: number | null,
  seasonEnd: number | null,
  month: number
): boolean {
  if (seasonStart === null || seasonEnd === null) {
    return true
  }

  if (seasonStart <= seasonEnd) {
    return month >= seasonStart && month <= seasonEnd
  }

  return month >= seasonStart || month <= seasonEnd
}

/** The heat scale, in words a menu card would use. */
export const SPICE_LEVEL_LABELS: Readonly<Record<SpiceLevel, string>> = {
  NONE: 'No heat',
  MILD: 'Mild',
  MEDIUM: 'Medium',
  HOT: 'Hot',
  FIERY: 'Fiery',
}

/** The five kinds of tag, in the vocabulary the kitchen uses. */
export const TAG_KIND_LABELS: Readonly<Record<TagKind, string>> = {
  DIETARY: 'Dietary',
  ALLERGEN: 'Allergen',
  CUISINE: 'Cuisine',
  TECHNIQUE: 'Technique',
  OCCASION: 'Occasion',
}

/** The four kinds of asset. */
export const MEDIA_KIND_LABELS: Readonly<Record<MediaKind, string>> = {
  IMAGE: 'Photograph',
  VIDEO: 'Film',
  AUDIO: 'Audio',
  DOCUMENT: 'Document',
}

/** `1048576` → `1 MB`. `null` reads as an em dash. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) {
    return '—'
  }

  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const unit = units[unitIndex] ?? 'B'
  const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10

  return `${String(rounded)} ${unit}`
}
