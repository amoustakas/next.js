// mannachef/packages/validators/src/media.ts

/**
 * Media domain validation — the asset library behind every plate photograph,
 * chef portrait, and collection hero image.
 *
 * Mirrors `MediaAsset` and `MediaTag` in
 * `mannachef/packages/db/prisma/schema.prisma`.
 *
 * Rules that govern this file (see `mannachef/CONTRACT.md`):
 *
 *  1. No runtime dependency on `@prisma/client` — enum values arrive from
 *     `./enums`, which re-declares them as Zod enums.
 *  2. Shared primitives come from `./common`; nothing is re-implemented here.
 *  3. `alt` is never optional. An image without a description is an image a
 *     screen-reader guest cannot see, and the message says so plainly.
 */

import { z } from 'zod'

import {
  cuidSchema,
  isoDateTimeSchema,
  paginationSchema,
  slugSchema,
  urlSchema,
} from './common'
import { mediaKindSchema, mediaProviderSchema, type MediaKind } from './enums'
import { tagMatchModeSchema } from './menu'

// =============================================================================
// Limits
// =============================================================================

/** Matches `MediaAsset.alt` — `@db.VarChar(400)`. */
const MAX_ALT_LENGTH = 400

/** Matches `MediaAsset.credit` — `@db.VarChar(200)`. */
const MAX_CREDIT_LENGTH = 200

/** Matches `MediaAsset.mimeType` — `@db.VarChar(160)`. */
const MAX_MIME_TYPE_LENGTH = 160

/** Matches `MediaAsset.providerFileKey` — `@db.VarChar(255)`. */
const MAX_PROVIDER_FILE_KEY_LENGTH = 255

/** Matches `MediaAsset.checksum` — `@db.VarChar(128)`. */
const MAX_CHECKSUM_LENGTH = 128

/** Generous ceiling for the `@db.Text` caption. */
const MAX_CAPTION_LENGTH = 2_000

/** A base64 LQIP placeholder is small by design; this is a paste-bomb guard. */
const MAX_BLUR_DATA_LENGTH = 20_000

/** Longest accepted original file name from the uploader. */
const MAX_FILE_NAME_LENGTH = 255

/** Largest pixel dimension we accept, in either axis. */
const MAX_PIXEL_DIMENSION = 20_000

/** 64 MiB — the ceiling configured on the UploadThing file route. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** How many assets one bulk action may touch. */
export const MAX_BULK_MEDIA_ASSETS = 200

/** How many tags may be applied in a single bulk operation. */
export const MAX_BULK_MEDIA_TAGS = 24

/** How many tag handles a single filter may combine. */
const MAX_FILTER_TAGS = 20

/** Longest accepted free-text search phrase. */
const MAX_SEARCH_LENGTH = 120

/** A MIME type, with any parameters already stripped: `image/avif`. */
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_+.-]*\/[a-z0-9][a-z0-9!#$&^_+.-]*$/

/** A leading fragment of a MIME type used as a filter: `image` or `image/`. */
const MIME_TYPE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9!#$&^_+.-]*\/?$/

/** Lowercase hexadecimal digest — MD5 (32) through SHA-512 (128). */
const CHECKSUM_PATTERN = /^[0-9a-f]{32,128}$/

// =============================================================================
// Local helpers
// =============================================================================

/** True when no value in the list repeats. */
function hasUniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}

type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]
}

/**
 * Strips `.default(...)` from every field of a shape.
 *
 * A default belongs on a create form, where an omitted field honestly means
 * "use the house setting". On a partial update it is actively harmful: Zod still
 * applies a default underneath `.partial()`, so a payload that only corrected a
 * caption would quietly refile the asset as an image hosted on UploadThing.
 * Update schemas are therefore built from the defaults-free shape.
 */
function withoutDefaults<T extends z.ZodRawShape>(
  shape: T
): WithoutDefaults<T> {
  const stripped: Record<string, unknown> = {}

  for (const [key, schema] of Object.entries(shape)) {
    stripped[key] = schema instanceof z.ZodDefault ? schema.unwrap() : schema
  }

  return stripped as unknown as WithoutDefaults<T>
}

/**
 * A boolean that survives the trip through a URL search-parameter object, where
 * `true` arrives as the string `"true"`. A transport concern of list filters
 * rather than a domain primitive, which is why it is not in `./common`.
 */
function queryFlag(defaultValue: boolean, error: string) {
  return z
    .union([z.boolean({ error }), z.stringbool({ error })], { error })
    .default(defaultValue)
}

/** `@db.Text` prose that may be cleared by sending `null`. */
function optionalProse(maxLength: number, tooLongMessage: string) {
  return z
    .string({ error: 'Please provide text, or leave the field empty.' })
    .trim()
    .max(maxLength, { error: tooLongMessage })
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()
    .optional()
}

// =============================================================================
// Field schemas
// =============================================================================

/**
 * Alternative text. **Required, and never blank.**
 *
 * `MediaAsset.alt` is a non-nullable column precisely so that this rule cannot
 * be sidestepped: every asset in the library carries a description a screen
 * reader can announce.
 */
export const altTextSchema = z
  .string({
    error:
      'Please describe this image — the description is read aloud to guests using a screen reader.',
  })
  .trim()
  .min(1, {
    error:
      'Please describe this image — the description is read aloud to guests using a screen reader.',
  })
  .max(MAX_ALT_LENGTH, {
    error:
      'A description is most useful under 400 characters. Save the longer telling for the caption.',
  })
export type AltText = z.infer<typeof altTextSchema>

/**
 * A MIME type. Any parameters (`; charset=utf-8`) are stripped and the value is
 * lower-cased before the shape is checked.
 */
export const mimeTypeSchema = z
  .string({ error: 'Please tell us what kind of file this is.' })
  .trim()
  .toLowerCase()
  .transform((value) => {
    const withoutParameters = value.split(';')[0]
    return (withoutParameters ?? '').trim()
  })
  .pipe(
    z
      .string()
      .max(MAX_MIME_TYPE_LENGTH, {
        error: 'That file type is longer than our records allow.',
      })
      .regex(MIME_TYPE_PATTERN, {
        error:
          'We could not recognise that file type. Please upload an image, video, audio file or document.',
      })
  )
export type MimeType = z.infer<typeof mimeTypeSchema>

/** A lowercase hexadecimal content digest. */
export const checksumSchema = z
  .string({ error: 'Please provide a content checksum.' })
  .trim()
  .toLowerCase()
  .max(MAX_CHECKSUM_LENGTH, {
    error: 'That checksum is longer than our records allow.',
  })
  .refine((value) => CHECKSUM_PATTERN.test(value), {
    error: 'A checksum is a hexadecimal digest, between 32 and 128 characters.',
  })
export type Checksum = z.infer<typeof checksumSchema>

/** A base64 LQIP placeholder, as produced at upload time. */
export const blurDataSchema = z
  .string({ error: 'Please provide the placeholder image data.' })
  .trim()
  .max(MAX_BLUR_DATA_LENGTH, {
    error: 'That placeholder is far larger than a placeholder should be.',
  })
  .refine((value) => value.startsWith('data:image/'), {
    error: 'The placeholder must be a data URI beginning with data:image/.',
  })
export type BlurData = z.infer<typeof blurDataSchema>

/** A pixel measurement in either axis. */
const pixelDimensionSchema = z
  .int({ error: 'Please give the measurement in whole pixels.' })
  .min(1, { error: 'A dimension must be at least one pixel.' })
  .max(MAX_PIXEL_DIMENSION, {
    error: 'That dimension is larger than anything we can serve.',
  })

/** A file size in bytes. */
export const fileBytesSchema = z
  .int({ error: 'Please give the file size in whole bytes.' })
  .min(1, { error: 'An empty file has nothing for us to show.' })
  .max(MAX_UPLOAD_BYTES, {
    error: 'Files must be 64 MB or smaller. Please compress and try again.',
  })
export type FileBytes = z.infer<typeof fileBytesSchema>

/** Free-text search across the asset library. Blank input means "no filter". */
const mediaSearchSchema = z
  .string({ error: 'Please type something to search the library for.' })
  .trim()
  .max(MAX_SEARCH_LENGTH, {
    error: 'Please shorten your search to 120 characters or fewer.',
  })
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional()

// =============================================================================
// Media assets
// =============================================================================

/**
 * The base shape of an asset.
 *
 * `uploadedById` is deliberately absent: attribution is taken from the session
 * inside the server action and is never accepted from the client
 * (`mannachef/CONTRACT.md` §5).
 */
const mediaAssetBaseSchema = z
  .object({
    url: urlSchema,
    thumbnailUrl: urlSchema.nullable().optional(),
    alt: altTextSchema,
    caption: optionalProse(
      MAX_CAPTION_LENGTH,
      'Please keep the caption to 2,000 characters or fewer.'
    ),
    credit: optionalProse(
      MAX_CREDIT_LENGTH,
      'Please keep the credit to 200 characters or fewer.'
    ),

    kind: mediaKindSchema.default('IMAGE'),
    provider: mediaProviderSchema.default('UPLOADTHING'),
    /** Provider-scoped identifier — the UploadThing file key, the S3 object key. */
    providerFileKey: z
      .string({ error: 'Please provide the storage key for this file.' })
      .trim()
      .max(MAX_PROVIDER_FILE_KEY_LENGTH, {
        error: 'That storage key is longer than our records allow.',
      })
      .transform((value) => (value.length > 0 ? value : null))
      .nullable()
      .optional(),

    width: pixelDimensionSchema.nullable().optional(),
    height: pixelDimensionSchema.nullable().optional(),
    bytes: fileBytesSchema.nullable().optional(),
    mimeType: mimeTypeSchema,
    blurData: blurDataSchema.nullable().optional(),
    checksum: checksumSchema.nullable().optional(),
  })
  .strict()

export const mediaAssetCreateSchema = mediaAssetBaseSchema
export type MediaAssetCreateInput = z.infer<typeof mediaAssetCreateSchema>
export type MediaAssetCreateRawInput = z.input<typeof mediaAssetCreateSchema>

export const mediaAssetUpdateSchema = z
  .object(withoutDefaults(mediaAssetBaseSchema.shape))
  .partial()
  .extend({ id: cuidSchema })
  .strict()
  .refine((value) => Object.keys(value).length > 1, {
    error: 'Nothing has changed yet — adjust a field before saving.',
    path: ['id'],
  })
  .refine((value) => value.alt === undefined || value.alt.length > 0, {
    error:
      'Please describe this image — the description is read aloud to guests using a screen reader.',
    path: ['alt'],
  })
export type MediaAssetUpdateInput = z.infer<typeof mediaAssetUpdateSchema>
export type MediaAssetUpdateRawInput = z.input<typeof mediaAssetUpdateSchema>

/** How a page of the library is ordered; direction comes from `sortDirection`. */
export const mediaAssetSortBySchema = z
  .enum(['CREATED', 'UPDATED', 'SIZE', 'KIND', 'ALT'], {
    error: 'Please choose how the library should be ordered.',
  })
  .default('CREATED')
export type MediaAssetSortBy = z.infer<typeof mediaAssetSortBySchema>

export const mediaAssetFilterSchema = paginationSchema
  .extend({
    /** Matches the description, caption, and credit. */
    search: mediaSearchSchema,
    kinds: z
      .array(mediaKindSchema, {
        error: 'Please choose the kinds of media to show.',
      })
      .max(4, { error: 'There are only four kinds of media to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That kind of media is already part of your search.',
      })
      .default([]),
    providers: z
      .array(mediaProviderSchema, {
        error: 'Please choose where the assets are hosted.',
      })
      .max(5, { error: 'There are only five providers to choose from.' })
      .refine(hasUniqueValues, {
        error: 'That provider is already part of your search.',
      })
      .default([]),
    tagSlugs: z
      .array(slugSchema, { error: 'Please choose tags from the list.' })
      .max(MAX_FILTER_TAGS, {
        error: 'Please narrow your search to twenty tags or fewer.',
      })
      .refine(hasUniqueValues, {
        error: 'That tag is already part of your search.',
      })
      .default([]),
    /** Applies to `tagSlugs`: match every tag (`ALL`) or any of them (`ANY`). */
    tagMatchMode: tagMatchModeSchema,
    /** Server actions must confirm the caller may see another person's uploads. */
    uploadedById: cuidSchema.optional(),
    /** A leading fragment of a MIME type, such as `image` or `image/`. */
    mimeTypePrefix: z
      .string({ error: 'Please give a file type to filter by.' })
      .trim()
      .toLowerCase()
      .max(MAX_MIME_TYPE_LENGTH, {
        error: 'That file type is longer than our records allow.',
      })
      .refine((value) => MIME_TYPE_PREFIX_PATTERN.test(value), {
        error: 'Filter by a file type such as image, image/ or image/avif.',
      })
      .optional(),
    /** Surfaces legacy rows whose description was never written. */
    needsAltText: queryFlag(
      false,
      'Please say whether to show only assets still awaiting a description.'
    ),
    /** Surfaces assets attached to no dish, collection, or chef. */
    unattachedOnly: queryFlag(
      false,
      'Please say whether to show only assets that are not yet in use.'
    ),
    createdFrom: isoDateTimeSchema.optional(),
    createdTo: isoDateTimeSchema.optional(),
    sortBy: mediaAssetSortBySchema,
  })
  .refine(
    ({ createdFrom, createdTo }) =>
      createdFrom === undefined ||
      createdTo === undefined ||
      createdFrom.getTime() <= createdTo.getTime(),
    {
      error: 'The earlier date must fall on or before the later one.',
      path: ['createdTo'],
    }
  )
export type MediaAssetFilterInput = z.infer<typeof mediaAssetFilterSchema>
export type MediaAssetFilterRawInput = z.input<typeof mediaAssetFilterSchema>

// =============================================================================
// Upload completion (UploadThing)
// =============================================================================

/**
 * The payload UploadThing hands back once a file has landed.
 *
 * These five field names are UploadThing's, not ours, and are mirrored exactly
 * so the client callback can be forwarded to a server action untouched. The
 * server action still re-verifies the key against the provider before it trusts
 * the URL — a completion payload is client-supplied input like any other.
 */
export const uploadCompletionSchema = z
  .object({
    key: z
      .string({ error: 'The upload did not return a storage key.' })
      .trim()
      .min(1, { error: 'The upload did not return a storage key.' })
      .max(MAX_PROVIDER_FILE_KEY_LENGTH, {
        error: 'That storage key is longer than our records allow.',
      }),
    url: urlSchema,
    name: z
      .string({ error: 'The upload did not return a file name.' })
      .trim()
      .min(1, { error: 'The upload did not return a file name.' })
      .max(MAX_FILE_NAME_LENGTH, {
        error: 'That file name is longer than our records allow.',
      }),
    size: fileBytesSchema,
    type: mimeTypeSchema,
  })
  .strict()
export type UploadCompletionInput = z.infer<typeof uploadCompletionSchema>
export type UploadCompletionRawInput = z.input<typeof uploadCompletionSchema>

/**
 * Reads the media kind from a MIME type, so the uploader does not have to ask.
 * Anything we do not recognise is filed as a document.
 */
export function inferMediaKindFromMimeType(mimeType: string): MediaKind {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''

  if (normalized.startsWith('image/')) {
    return 'IMAGE'
  }

  if (normalized.startsWith('video/')) {
    return 'VIDEO'
  }

  if (normalized.startsWith('audio/')) {
    return 'AUDIO'
  }

  return 'DOCUMENT'
}

/**
 * Turns a finished upload into a library entry.
 *
 * The description is collected in the same step as the upload — an asset never
 * enters the library without one. The output is shaped as a
 * `MediaAssetCreateInput` plus the tags to attach, so the server action can hand
 * `asset` straight to Prisma after its own authorization checks.
 */
export const mediaAssetFromUploadSchema = z
  .object({
    upload: uploadCompletionSchema,
    alt: altTextSchema,
    caption: optionalProse(
      MAX_CAPTION_LENGTH,
      'Please keep the caption to 2,000 characters or fewer.'
    ),
    credit: optionalProse(
      MAX_CREDIT_LENGTH,
      'Please keep the credit to 200 characters or fewer.'
    ),
    width: pixelDimensionSchema.nullable().optional(),
    height: pixelDimensionSchema.nullable().optional(),
    blurData: blurDataSchema.nullable().optional(),
    checksum: checksumSchema.nullable().optional(),
    tagIds: z
      .array(cuidSchema, { error: 'Please choose tags from the list.' })
      .max(MAX_BULK_MEDIA_TAGS, {
        error: 'Please apply twenty-four tags or fewer.',
      })
      .refine(hasUniqueValues, {
        error: 'That tag has already been added to this asset.',
      })
      .default([]),
  })
  .strict()
  .transform(
    (
      value
    ): {
      asset: MediaAssetCreateInput
      tagIds: string[]
    } => ({
      asset: {
        url: value.upload.url,
        thumbnailUrl: null,
        alt: value.alt,
        caption: value.caption ?? null,
        credit: value.credit ?? null,
        kind: inferMediaKindFromMimeType(value.upload.type),
        provider: 'UPLOADTHING',
        providerFileKey: value.upload.key,
        width: value.width ?? null,
        height: value.height ?? null,
        bytes: value.upload.size,
        mimeType: value.upload.type,
        blurData: value.blurData ?? null,
        checksum: value.checksum ?? null,
      },
      tagIds: value.tagIds,
    })
  )
export type MediaAssetFromUploadInput = z.infer<
  typeof mediaAssetFromUploadSchema
>
export type MediaAssetFromUploadRawInput = z.input<
  typeof mediaAssetFromUploadSchema
>

// =============================================================================
// Bulk tagging
// =============================================================================

/** The assets a bulk action applies to. Re-checked server-side before it runs. */
export const mediaAssetIdsSchema = z
  .array(cuidSchema, { error: 'Please choose the assets to act on.' })
  .min(1, { error: 'Choose at least one asset first.' })
  .max(MAX_BULK_MEDIA_ASSETS, {
    error: 'Please act on two hundred assets at a time or fewer.',
  })
  .refine(hasUniqueValues, { error: 'That asset has already been chosen.' })
export type MediaAssetIds = z.infer<typeof mediaAssetIdsSchema>

/**
 * How a bulk tag operation treats the tags already on an asset.
 *
 * `REPLACE` with an empty list is the way to strip every tag, which is why the
 * list is only required to be non-empty for `ADD` and `REMOVE`.
 */
export const mediaBulkTagModeSchema = z.enum(['ADD', 'REMOVE', 'REPLACE'], {
  error: 'Please choose whether to add, remove, or replace these tags.',
})
export type MediaBulkTagMode = z.infer<typeof mediaBulkTagModeSchema>

export const mediaBulkTagSchema = z
  .object({
    mediaAssetIds: mediaAssetIdsSchema,
    tagIds: z
      .array(cuidSchema, { error: 'Please choose tags from the list.' })
      .max(MAX_BULK_MEDIA_TAGS, {
        error: 'Please apply twenty-four tags at a time or fewer.',
      })
      .refine(hasUniqueValues, { error: 'That tag has already been chosen.' }),
    mode: mediaBulkTagModeSchema.default('ADD'),
  })
  .strict()
  .refine(({ mode, tagIds }) => mode === 'REPLACE' || tagIds.length > 0, {
    error: 'Choose at least one tag first.',
    path: ['tagIds'],
  })
export type MediaBulkTagInput = z.infer<typeof mediaBulkTagSchema>
export type MediaBulkTagRawInput = z.input<typeof mediaBulkTagSchema>
