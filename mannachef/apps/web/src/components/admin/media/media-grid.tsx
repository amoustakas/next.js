// mannachef/apps/web/src/components/admin/media/media-grid.tsx
'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { generateReactHelpers } from '@uploadthing/react'
import type { FileRouter } from 'uploadthing/types'
import { z } from 'zod'
import {
  AlertCircle,
  Check,
  FileText,
  Image as ImageIcon,
  ImageOff,
  MoreVertical,
  Music,
  Pencil,
  Plus,
  Search,
  SearchX,
  Tag as TagIcon,
  Trash2,
  Video,
  X,
} from 'lucide-react'

import {
  altTextSchema,
  cuidSchema,
  mediaKindSchema,
  optionalProse,
  MAX_BULK_MEDIA_TAGS,
  MAX_UPLOAD_BYTES,
  type MediaAssetFilterRawInput,
  type MediaAssetFromUploadRawInput,
  type MediaAssetSortBy,
  type MediaKind,
  type SortDirection,
  type TagMatchMode,
} from '@mannachef/validators'

import type { MediaAssetListView, MediaAssetView } from '@/server/actions/media'
import {
  bulkTagMediaAssets,
  completeMediaUpload,
  deleteMediaAsset,
  listMediaAssets,
  updateMediaAsset,
} from '@/server/actions/media'
import type { TagView } from '@/server/actions/menu'

import { describeActionError, useAction } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'
import { cn, FOCUS_RING } from '@/lib/utils'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckboxField } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { DateTime } from '@/components/ui/date-time'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
  FormStatus,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

// =============================================================================
// 1. Constants & lookups
// =============================================================================

/** Matches the initial server-rendered page in `page.tsx`. */
const PAGE_SIZE = 24

/** The four kinds a media asset can be, in the order the filter row shows them. */
const MEDIA_KINDS = mediaKindSchema.options

const KIND_LABELS: Readonly<Record<MediaKind, string>> = {
  IMAGE: 'Image',
  VIDEO: 'Video',
  AUDIO: 'Audio',
  DOCUMENT: 'Document',
}

const KIND_ICONS: Readonly<Record<MediaKind, typeof ImageIcon>> = {
  IMAGE: ImageIcon,
  VIDEO: Video,
  AUDIO: Music,
  DOCUMENT: FileText,
}

/**
 * `MediaAsset.caption` / `MediaAsset.credit` column widths, mirrored from
 * `@mannachef/validators/media.ts` (`MAX_CAPTION_LENGTH` / `MAX_CREDIT_LENGTH`).
 * Those two constants are module-local there, not exported, so the bound and
 * its message are restated here rather than imported.
 */
const MAX_CAPTION_LENGTH = 2_000
const MAX_CREDIT_LENGTH = 200
const CAPTION_TOO_LONG_MESSAGE =
  'Please keep the caption to 2,000 characters or fewer.'
const CREDIT_TOO_LONG_MESSAGE =
  'Please keep the credit to 200 characters or fewer.'

const SORT_OPTIONS: ReadonlyArray<{
  readonly value: string
  readonly label: string
  readonly sortBy: MediaAssetSortBy
  readonly sortDirection: SortDirection
}> = [
  {
    value: 'created-desc',
    label: 'Newest first',
    sortBy: 'CREATED',
    sortDirection: 'desc',
  },
  {
    value: 'created-asc',
    label: 'Oldest first',
    sortBy: 'CREATED',
    sortDirection: 'asc',
  },
  {
    value: 'updated-desc',
    label: 'Recently updated',
    sortBy: 'UPDATED',
    sortDirection: 'desc',
  },
  {
    value: 'size-desc',
    label: 'Largest file',
    sortBy: 'SIZE',
    sortDirection: 'desc',
  },
  {
    value: 'size-asc',
    label: 'Smallest file',
    sortBy: 'SIZE',
    sortDirection: 'asc',
  },
  {
    value: 'alt-asc',
    label: 'Description, A–Z',
    sortBy: 'ALT',
    sortDirection: 'asc',
  },
  { value: 'kind-asc', label: 'Kind', sortBy: 'KIND', sortDirection: 'asc' },
]

/**
 * The UploadThing router type is intentionally left at its widest bound.
 *
 * Binding to a narrower, app-specific `FileRouter` would need a type import
 * from the route that defines it (`@/app/api/uploadthing/core`), which is
 * outside the two files this component owns. `FileRouter` (the base
 * `Record<string, AnyFileRoute>`) is a real export of `uploadthing/types`, so
 * this still type-checks on its own, and `useUploadThing` still talks to the
 * house `/api/uploadthing` route at runtime — it only loses the endpoint-name
 * autocomplete a narrower binding would add.
 */
const { useUploadThing } = generateReactHelpers<FileRouter>()

/** The FileRouter endpoint this library uploads through. */
const MEDIA_UPLOAD_ENDPOINT = 'mediaUploader'

// =============================================================================
// 2. Local, upload/edit-only schemas
//
// `mediaAssetFromUploadSchema` and `mediaAssetUpdateSchema` (both from
// `@mannachef/validators`) describe the *whole* action payload, including the
// UploadThing completion object this form does not have until the file has
// actually finished uploading. What the form itself collects beforehand — the
// description, the caption, the credit — is validated here by composing the
// same field schemas the validators package exports, so "required, never
// blank" for `alt` is enforced with the identical rule and the identical
// message, not a hand-rolled copy of it.
// =============================================================================

const mediaDetailsSchema = z.object({
  alt: altTextSchema,
  caption: optionalProse(MAX_CAPTION_LENGTH, CAPTION_TOO_LONG_MESSAGE),
  credit: optionalProse(MAX_CREDIT_LENGTH, CREDIT_TOO_LONG_MESSAGE),
})
type MediaDetailsInput = z.input<typeof mediaDetailsSchema>
type MediaDetailsOutput = z.output<typeof mediaDetailsSchema>

// =============================================================================
// 3. Small helpers
// =============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

interface FilterState {
  readonly search: string
  readonly kinds: readonly MediaKind[]
  readonly tagSlugs: readonly string[]
  readonly tagMatchMode: TagMatchMode
  readonly needsAltText: boolean
  readonly unattachedOnly: boolean
  readonly sortBy: MediaAssetSortBy
  readonly sortDirection: SortDirection
  readonly page: number
}

const DEFAULT_FILTERS: FilterState = {
  search: '',
  kinds: [],
  tagSlugs: [],
  tagMatchMode: 'ALL',
  needsAltText: false,
  unattachedOnly: false,
  sortBy: 'CREATED',
  sortDirection: 'desc',
  page: 1,
}

function toFilterInput(filters: FilterState): MediaAssetFilterRawInput {
  return {
    page: filters.page,
    pageSize: PAGE_SIZE,
    sortDirection: filters.sortDirection,
    sortBy: filters.sortBy,
    search: filters.search,
    kinds: [...filters.kinds],
    tagSlugs: [...filters.tagSlugs],
    tagMatchMode: filters.tagMatchMode,
    needsAltText: filters.needsAltText,
    unattachedOnly: filters.unattachedOnly,
  }
}

function hasActiveFilters(filters: FilterState): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.kinds.length > 0 ||
    filters.tagSlugs.length > 0 ||
    filters.needsAltText ||
    filters.unattachedOnly
  )
}

// =============================================================================
// 4. Tag picker — shared by the filter row, the upload dialog, and the edit
//    sheet. `getValue` is what makes it double as both: the filter row keys
//    selections by `slug` (what `mediaAssetFilterSchema.tagSlugs` wants), the
//    upload and edit forms key them by `id` (what `bulkTagMediaAssets` and
//    `completeMediaUpload` want).
// =============================================================================

interface TagPickerProps {
  readonly tags: readonly TagView[]
  readonly selected: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  readonly getValue: (tag: TagView) => string
  readonly triggerLabel: string
  readonly disabled?: boolean
}

function TagPicker({
  tags,
  selected,
  onChange,
  getValue,
  triggerLabel,
  disabled = false,
}: TagPickerProps) {
  const [open, setOpen] = React.useState(false)
  const selectedSet = React.useMemo(() => new Set(selected), [selected])
  const selectedTags = React.useMemo(
    () => tags.filter((tag) => selectedSet.has(getValue(tag))),
    [tags, selectedSet, getValue]
  )

  function toggle(value: string) {
    onChange(
      selectedSet.has(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value]
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={disabled}>
            <TagIcon aria-hidden="true" />
            {triggerLabel}
            {selected.length > 0 ? (
              <Badge variant="default" numeric>
                {selected.length}
              </Badge>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search tags…" />
            <CommandList>
              <CommandEmpty>No tags found.</CommandEmpty>
              <CommandGroup>
                {tags.map((tag) => {
                  const value = getValue(tag)
                  const checked = selectedSet.has(value)

                  return (
                    <CommandItem
                      key={tag.id}
                      value={tag.name}
                      onSelect={() => toggle(value)}
                    >
                      <span className="flex-1">{tag.name}</span>
                      {checked ? (
                        <Check
                          aria-hidden="true"
                          className="size-4 text-champagne"
                        />
                      ) : null}
                      <span className="sr-only">
                        {checked ? ' — selected' : ''}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedTags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => (
            <li key={tag.id}>
              <Badge variant="outline" className="gap-1 pr-1">
                {tag.name}
                <button
                  type="button"
                  onClick={() => toggle(getValue(tag))}
                  disabled={disabled}
                  className={cn(
                    'rounded-full p-0.5 text-stone transition-colors duration-150 ease-luxe hover:text-linen disabled:pointer-events-none',
                    FOCUS_RING
                  )}
                >
                  <X aria-hidden="true" className="size-3" />
                  <span className="sr-only">Remove {tag.name} tag</span>
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// =============================================================================
// 5. One tile
// =============================================================================

interface AssetTileProps {
  readonly asset: MediaAssetView
  readonly onEdit: () => void
  readonly onDelete: () => void
}

function AssetTile({ asset, onEdit, onDelete }: AssetTileProps) {
  const Icon = KIND_ICONS[asset.kind]
  const usage = asset.library?.usage.total ?? null
  const thumbnail =
    asset.thumbnailUrl ?? (asset.kind === 'IMAGE' ? asset.url : null)

  return (
    <li className="group relative flex flex-col overflow-hidden rounded-lg border border-ash bg-slate-warm transition-colors duration-200 ease-luxe hover:border-stone/50">
      <button
        type="button"
        onClick={onEdit}
        className={cn(
          'relative aspect-4/3 w-full overflow-hidden bg-charcoal text-left',
          FOCUS_RING
        )}
      >
        {thumbnail === null ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-stone">
            <Icon aria-hidden="true" className="size-8" />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- remote,
          // operator-supplied URLs from any configured provider; a fixed
          // `next/image` remotePatterns allow-list is not this component's
          // file to own.
          <img
            src={thumbnail}
            alt={asset.alt}
            loading="lazy"
            className="size-full object-cover transition-transform duration-200 ease-luxe group-hover:scale-[1.02]"
          />
        )}
        <span className="absolute top-2 left-2">
          <Badge variant="default">
            <Icon aria-hidden="true" />
            {KIND_LABELS[asset.kind]}
          </Badge>
        </span>
        <span className="sr-only">Edit {asset.alt}</span>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 font-sans text-sm text-linen">{asset.alt}</p>
        {asset.tags.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1">
            {asset.tags.slice(0, 3).map((tag) => (
              <li key={tag.id}>
                <Badge variant="outline">{tag.name}</Badge>
              </li>
            ))}
            {asset.tags.length > 3 ? (
              <li>
                <Badge variant="muted">+{asset.tags.length - 3}</Badge>
              </li>
            ) : null}
          </ul>
        )}
        <div className="mt-auto flex items-center justify-between gap-2">
          <DateTime value={asset.createdAt} format="relative" tone="subtle" />
          {usage === null ? null : usage === 0 ? (
            <Badge variant="muted">Not in use</Badge>
          ) : (
            <Badge variant="success" numeric>
              {usage} {usage === 1 ? 'use' : 'uses'}
            </Badge>
          )}
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 border-ash/80 bg-obsidian/70 backdrop-blur-sm"
          >
            <MoreVertical aria-hidden="true" className="size-4" />
            <span className="sr-only">Actions for {asset.alt}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil aria-hidden="true" />
            Edit details
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

// =============================================================================
// 6. Upload dialog
// =============================================================================

interface UploadAssetDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly tags: readonly TagView[]
  readonly onUploaded: () => void
}

function UploadAssetDialog({
  open,
  onOpenChange,
  tags,
  onUploaded,
}: UploadAssetDialogProps) {
  const [file, setFile] = React.useState<File | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [tagIds, setTagIds] = React.useState<readonly string[]>([])
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const form = useForm<MediaDetailsInput, unknown, MediaDetailsOutput>({
    resolver: zodResolver(mediaDetailsSchema),
    defaultValues: { alt: '', caption: '', credit: '' },
  })

  const { startUpload, isUploading } = useUploadThing(MEDIA_UPLOAD_ENDPOINT, {
    onUploadError: (error) => {
      setFileError(
        error.message.length > 0
          ? error.message
          : 'The upload did not go through. Please try again.'
      )
    },
  })

  const completeAction = useAction(completeMediaUpload, {
    form,
    knownFieldPaths: ['alt', 'caption', 'credit'],
    successMessage: (data) => `${data.alt} was added to the library.`,
    onSuccess: () => {
      resetState()
      onOpenChange(false)
      onUploaded()
    },
  })

  function resetState() {
    form.reset({ alt: '', caption: '', credit: '' })
    setFile(null)
    setFileError(null)
    setTagIds([])

    if (fileInputRef.current !== null) {
      fileInputRef.current.value = ''
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null

    if (chosen === null) {
      setFile(null)
      return
    }

    if (chosen.size > MAX_UPLOAD_BYTES) {
      setFile(null)
      setFileError(
        'Files must be 64 MB or smaller. Please compress and try again.'
      )
      return
    }

    setFileError(null)
    setFile(chosen)
  }

  async function handleSubmit(values: MediaDetailsOutput) {
    if (file === null) {
      setFileError('Please choose a file to upload.')
      return
    }

    setFileError(null)
    const uploaded = await startUpload([file])
    const first = uploaded?.[0]

    if (first === undefined) {
      setFileError('The upload did not go through. Please try again.')
      return
    }

    const payload: MediaAssetFromUploadRawInput = {
      upload: {
        key: first.key,
        url: first.ufsUrl.length > 0 ? first.ufsUrl : first.url,
        name: first.name,
        size: first.size,
        type: first.type,
      },
      alt: values.alt,
      caption: values.caption,
      credit: values.credit,
      tagIds: [...tagIds],
    }

    await completeAction.execute(payload)
  }

  const busy = isUploading || completeAction.isPending

  function handleOpenChange(next: boolean) {
    if (busy) {
      return
    }

    onOpenChange(next)

    if (!next) {
      resetState()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add media</DialogTitle>
          <DialogDescription>
            Choose a file, then describe it. Every asset in the library carries
            a description before it is saved.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            noValidate
            className="flex flex-col gap-5"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="media-upload-file" required>
                File
              </Label>
              <Input
                ref={fileInputRef}
                id="media-upload-file"
                type="file"
                accept="image/*,video/*,audio/*,application/pdf"
                onChange={handleFileChange}
                disabled={busy}
                aria-describedby="media-upload-file-hint"
                invalid={fileError !== null}
              />
              <p
                id="media-upload-file-hint"
                className="font-sans text-xs text-stone"
              >
                Images, video, audio, or PDF, up to 64 MB.
              </p>
              {file === null ? null : (
                <p className="font-sans text-xs text-parchment">
                  {file.name} · {formatBytes(file.size)}
                </p>
              )}
              {fileError === null ? null : (
                <p role="alert" className="font-sans text-xs text-claret">
                  {fileError}
                </p>
              )}
            </div>

            <div className="flex items-start gap-2 rounded-md border border-gold/40 bg-champagne/8 p-3">
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-champagne"
              />
              <p className="font-sans text-xs leading-relaxed text-parchment">
                <strong className="font-medium text-champagne">
                  A description is required.
                </strong>{' '}
                It is read aloud to guests who use a screen reader, so every
                image, video, and document needs one before it can join the
                library.
              </p>
            </div>

            <FormField
              control={form.control}
              name="alt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="A close-up of the seared scallop plate, garnished with pea shoots."
                      disabled={busy}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    What would you tell someone who cannot see this file?
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="caption"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Caption</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Shown alongside the asset. Optional."
                      disabled={busy}
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="credit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Credit</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Photographer or source. Optional."
                      disabled={busy}
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex flex-col gap-2">
              <Label>Tags</Label>
              <TagPicker
                tags={tags}
                selected={tagIds}
                onChange={setTagIds}
                getValue={(tag) => tag.id}
                triggerLabel="Choose tags"
                disabled={busy}
              />
              {tagIds.length > MAX_BULK_MEDIA_TAGS ? (
                <p role="alert" className="font-sans text-xs text-claret">
                  Please apply {MAX_BULK_MEDIA_TAGS} tags or fewer.
                </p>
              ) : null}
            </div>

            <FormRootError />
            <FormStatus>{completeAction.statusMessage}</FormStatus>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="champagne"
                loading={busy}
                loadingLabel={isUploading ? 'Uploading…' : 'Saving…'}
              >
                Add to library
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 7. Edit sheet — description/caption/credit via `updateMediaAsset`, tags via
//    `bulkTagMediaAssets` in `REPLACE` mode. Two actions, one "Save changes".
// =============================================================================

interface EditAssetSheetProps {
  readonly asset: MediaAssetView | null
  readonly tags: readonly TagView[]
  readonly onOpenChange: (open: boolean) => void
  readonly onSaved: () => void
}

function EditAssetSheet({
  asset,
  tags,
  onOpenChange,
  onSaved,
}: EditAssetSheetProps) {
  const [tagIds, setTagIds] = React.useState<readonly string[]>([])

  const form = useForm<MediaDetailsInput, unknown, MediaDetailsOutput>({
    resolver: zodResolver(mediaDetailsSchema),
    defaultValues: { alt: '', caption: '', credit: '' },
    ...(asset === null
      ? {}
      : {
          values: {
            alt: asset.alt,
            caption: asset.caption ?? '',
            credit: asset.credit ?? '',
          },
        }),
  })

  React.useEffect(() => {
    setTagIds(asset === null ? [] : asset.tags.map((tag) => tag.id))
  }, [asset])

  const detailsAction = useAction(updateMediaAsset, {
    form,
    knownFieldPaths: ['alt', 'caption', 'credit'],
    successMessage: (data) => `${data.alt} saved.`,
  })
  const tagsAction = useAction(bulkTagMediaAssets, { silent: true })

  async function handleSubmit(values: MediaDetailsOutput) {
    if (asset === null) {
      return
    }

    const [detailsResult, tagsResult] = await Promise.all([
      detailsAction.execute({
        id: asset.id,
        alt: values.alt,
        caption: values.caption,
        credit: values.credit,
      }),
      tagsAction.execute({
        mediaAssetIds: [asset.id],
        tagIds: [...tagIds],
        mode: 'REPLACE',
      }),
    ])

    if (detailsResult.ok && tagsResult.ok) {
      onOpenChange(false)
      onSaved()
    }
  }

  const busy = detailsAction.isPending || tagsAction.isPending
  const Icon = asset === null ? ImageIcon : KIND_ICONS[asset.kind]
  const thumbnail =
    asset === null
      ? null
      : (asset.thumbnailUrl ?? (asset.kind === 'IMAGE' ? asset.url : null))

  return (
    <Sheet
      open={asset !== null}
      onOpenChange={(next) => {
        if (!busy) {
          onOpenChange(next)
        }
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        {asset === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>Edit media</SheetTitle>
              <SheetDescription>
                Update the description, credit, and tags for this asset.
              </SheetDescription>
            </SheetHeader>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(handleSubmit)}
                noValidate
                className="flex flex-col gap-5"
              >
                <div className="overflow-hidden rounded-md border border-ash">
                  {thumbnail === null ? (
                    <div className="flex aspect-4/3 items-center justify-center bg-charcoal text-stone">
                      <Icon aria-hidden="true" className="size-8" />
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- see AssetTile
                    <img
                      src={thumbnail}
                      alt={asset.alt}
                      className="aspect-4/3 w-full object-cover"
                    />
                  )}
                </div>

                <div className="rounded-md border border-ash bg-charcoal/60 p-3">
                  <p className="font-sans text-xs leading-relaxed text-parchment">
                    <strong className="font-medium text-linen">
                      Why this matters:
                    </strong>{' '}
                    the description below is read aloud to guests who use a
                    screen reader. It must describe what is in the file, not
                    just name it.
                  </p>
                </div>

                <FormField
                  control={form.control}
                  name="alt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Description</FormLabel>
                      <FormControl>
                        <Textarea rows={2} disabled={busy} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="caption"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Caption</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          disabled={busy}
                          {...field}
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="credit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Credit</FormLabel>
                      <FormControl>
                        <Input
                          disabled={busy}
                          {...field}
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex flex-col gap-2">
                  <Label>Tags</Label>
                  <TagPicker
                    tags={tags}
                    selected={tagIds}
                    onChange={setTagIds}
                    getValue={(tag) => tag.id}
                    triggerLabel="Choose tags"
                    disabled={busy}
                  />
                </div>

                <FormRootError />
                <FormStatus>{detailsAction.statusMessage}</FormStatus>

                <SheetFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="champagne" loading={busy}>
                    Save changes
                  </Button>
                </SheetFooter>
              </form>
            </Form>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// =============================================================================
// 8. Delete confirmation — surfaces what the server refuses to delete over,
//    by name, rather than a generic conflict message.
// =============================================================================

interface DeleteAssetDialogProps {
  readonly asset: MediaAssetView | null
  readonly onOpenChange: (open: boolean) => void
  readonly onDeleted: () => void
}

function DeleteAssetDialog({
  asset,
  onOpenChange,
  onDeleted,
}: DeleteAssetDialogProps) {
  const deleteAction = useAction(deleteMediaAsset, {
    silent: true,
    onSuccess: () => {
      onOpenChange(false)
      onDeleted()
    },
  })

  const described =
    deleteAction.error === null ? null : describeActionError(deleteAction.error)
  const references = deleteAction.error?.fieldErrors?._references ?? []

  function handleOpenChange(next: boolean) {
    if (deleteAction.isPending) {
      return
    }

    onOpenChange(next)

    if (!next) {
      deleteAction.reset()
    }
  }

  async function handleConfirm() {
    if (asset === null) {
      return
    }

    await deleteAction.execute({ id: asset.id })
  }

  return (
    <Dialog open={asset !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        {asset === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Delete “{asset.alt}”?</DialogTitle>
              <DialogDescription>
                This removes the asset from the library. The stored file is left
                with the storage provider.
              </DialogDescription>
            </DialogHeader>

            {described === null ? null : (
              <div
                role="alert"
                className={cn(
                  'flex flex-col gap-2 rounded-md border p-3',
                  described.severity === 'error'
                    ? 'border-claret/60 bg-claret/12'
                    : 'border-terracotta/50 bg-terracotta/10'
                )}
              >
                <p className="font-sans text-sm font-medium text-linen">
                  {described.title}
                </p>
                <p className="font-sans text-sm leading-relaxed text-linen">
                  {described.description}
                </p>
                {references.length === 0 ? null : (
                  <ul className="mt-1 flex flex-col gap-1 border-t border-linen/15 pt-2">
                    {references.map((reference) => (
                      <li
                        key={reference}
                        className="font-sans text-xs leading-relaxed text-parchment"
                      >
                        {reference}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={deleteAction.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleConfirm}
                loading={deleteAction.isPending}
                loadingLabel="Deleting…"
              >
                Delete asset
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 9. The grid
// =============================================================================

export interface MediaGridProps {
  readonly initialAssets: MediaAssetListView
  readonly tags: readonly TagView[]
}

export function MediaGrid({ initialAssets, tags }: MediaGridProps) {
  const [filters, setFilters] = React.useState<FilterState>(DEFAULT_FILTERS)
  const [searchDraft, setSearchDraft] = React.useState('')
  const [results, setResults] =
    React.useState<MediaAssetListView>(initialAssets)
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [editingAsset, setEditingAsset] = React.useState<MediaAssetView | null>(
    null
  )
  const [deletingAsset, setDeletingAsset] =
    React.useState<MediaAssetView | null>(null)

  const listAction = useAction(listMediaAssets, {
    silent: true,
    onSuccess: setResults,
  })

  const isFirstRender = React.useRef(true)

  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    void listAction.execute(toFilterInput(filters))
    // Re-fetch on every filter change; `listAction.execute` is stable per the
    // memoization in `useAction`.
  }, [filters, listAction.execute])

  React.useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((current) =>
        current.search === searchDraft
          ? current
          : { ...current, search: searchDraft, page: 1 }
      )
    }, 300)

    return () => clearTimeout(handle)
  }, [searchDraft])

  const refresh = React.useCallback(() => {
    void listAction.execute(toFilterInput(filters))
  }, [filters, listAction])

  function updateFilters(patch: Partial<Omit<FilterState, 'page'>>) {
    setFilters((current) => ({ ...current, ...patch, page: 1 }))
  }

  function clearFilters() {
    setFilters(DEFAULT_FILTERS)
    setSearchDraft('')
  }

  const active = hasActiveFilters(filters)
  const sortValue: string =
    SORT_OPTIONS.find(
      (option) =>
        option.sortBy === filters.sortBy &&
        option.sortDirection === filters.sortDirection
    )?.value ?? 'created-desc'

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <form
            role="search"
            className="relative min-w-56 flex-1 sm:max-w-sm"
            onSubmit={(event) => event.preventDefault()}
          >
            <Label htmlFor="media-search" className="sr-only">
              Search media library
            </Label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone"
            />
            <Input
              id="media-search"
              type="search"
              placeholder="Search descriptions, captions, credits…"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              className="pl-9"
            />
          </form>

          <Select
            value={sortValue}
            onValueChange={(value) => {
              const option = SORT_OPTIONS.find((entry) => entry.value === value)

              if (option !== undefined) {
                updateFilters({
                  sortBy: option.sortBy,
                  sortDirection: option.sortDirection,
                })
              }
            }}
          >
            <SelectTrigger className="w-48" aria-label="Sort media library">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="button"
            variant="champagne"
            onClick={() => setUploadOpen(true)}
            className="ml-auto"
          >
            <Plus aria-hidden="true" />
            Add media
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="Filter by kind"
            className="flex flex-wrap items-center gap-1.5"
          >
            {MEDIA_KINDS.map((kind) => {
              const isActive = filters.kinds.includes(kind)
              const Icon = KIND_ICONS[kind]

              return (
                <Button
                  key={kind}
                  type="button"
                  variant={isActive ? 'default' : 'ghost'}
                  size="sm"
                  aria-pressed={isActive}
                  onClick={() =>
                    updateFilters({
                      kinds: isActive
                        ? filters.kinds.filter((entry) => entry !== kind)
                        : [...filters.kinds, kind],
                    })
                  }
                >
                  <Icon aria-hidden="true" />
                  {KIND_LABELS[kind]}
                </Button>
              )
            })}
          </div>

          <TagPicker
            tags={tags}
            selected={filters.tagSlugs}
            onChange={(next) => updateFilters({ tagSlugs: next })}
            getValue={(tag) => tag.slug}
            triggerLabel="Tags"
          />

          {filters.tagSlugs.length > 1 ? (
            <Select
              value={filters.tagMatchMode}
              onValueChange={(value) =>
                updateFilters({ tagMatchMode: value as TagMatchMode })
              }
            >
              <SelectTrigger className="w-36" aria-label="How tags must match">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Match all tags</SelectItem>
                <SelectItem value="ANY">Match any tag</SelectItem>
              </SelectContent>
            </Select>
          ) : null}

          <CheckboxField
            label="Needs a description"
            checked={filters.needsAltText}
            onCheckedChange={(checked) =>
              updateFilters({ needsAltText: checked === true })
            }
          />

          <CheckboxField
            label="Not yet in use"
            checked={filters.unattachedOnly}
            onCheckedChange={(checked) =>
              updateFilters({ unattachedOnly: checked === true })
            }
          />

          {active ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      {results.items.length === 0 ? (
        <EmptyState
          tone={active ? 'filtered' : 'empty'}
          icon={active ? SearchX : ImageOff}
          title={
            active ? 'No assets match these filters' : 'The library is empty'
          }
          description={
            active
              ? 'Try clearing a filter or searching a different term.'
              : 'Add the first photograph, portrait, or document to get started.'
          }
          action={
            active ? (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button variant="champagne" onClick={() => setUploadOpen(true)}>
                <Plus aria-hidden="true" />
                Add media
              </Button>
            )
          }
        />
      ) : (
        <ul
          aria-label="Media assets"
          aria-busy={listAction.isPending}
          className={cn(
            'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6',
            listAction.isPending &&
              'opacity-60 transition-opacity duration-200 ease-luxe'
          )}
        >
          {results.items.map((asset) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              onEdit={() => setEditingAsset(asset)}
              onDelete={() => setDeletingAsset(asset)}
            />
          ))}
        </ul>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {listAction.isPending ? 'Updating results…' : ''}
      </p>

      <div className="flex items-center justify-between gap-4 border-t border-ash pt-4">
        <p className="font-sans text-xs text-stone tabular-nums">
          {results.meta.total === 0
            ? 'No assets'
            : `${results.meta.total} asset${results.meta.total === 1 ? '' : 's'} · Page ${String(results.meta.page)} of ${String(Math.max(results.meta.pageCount, 1))}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!results.meta.hasPreviousPage || listAction.isPending}
            onClick={() =>
              setFilters((current) => ({ ...current, page: current.page - 1 }))
            }
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!results.meta.hasNextPage || listAction.isPending}
            onClick={() =>
              setFilters((current) => ({ ...current, page: current.page + 1 }))
            }
          >
            Next
          </Button>
        </div>
      </div>

      <UploadAssetDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        tags={tags}
        onUploaded={refresh}
      />

      <EditAssetSheet
        asset={editingAsset}
        tags={tags}
        onOpenChange={(open) => {
          if (!open) {
            setEditingAsset(null)
          }
        }}
        onSaved={refresh}
      />

      <DeleteAssetDialog
        asset={deletingAsset}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingAsset(null)
          }
        }}
        onDeleted={refresh}
      />
    </div>
  )
}
