// mannachef/apps/web/src/components/admin/media/media-selector.tsx
'use client'

/**
 * The media library browser.
 *
 * A modal that lets an admin search and tag-filter the asset library, choose a
 * bounded set of photographs, put them in order, and mark exactly one as the
 * lead ("primary") image — the same invariant
 * `menuItemMediaAssociationSchema` enforces server-side: a gallery must carry
 * exactly one primary entry. This component never persists anything itself;
 * it hands the ordered, one-primary selection back to `onConfirm` and the
 * caller decides what to do with it (attach it to a dish, a chef profile, a
 * collection hero, …), which is also why it reads library data through the
 * read-only `media.list` / `menu.tags.list` actions rather than through a
 * React Hook Form — there is nothing here for a form to submit.
 *
 * Reordering has two equivalent controls on purpose: dragging the row, and
 * the "move up" / "move down" buttons. The buttons are not a fallback for
 * when drag is unavailable — they are how a keyboard or screen-reader guest
 * does the same job, so they are wired to the same state update as the drop
 * handler and are never disabled while drag is possible.
 */

import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  FileText,
  Film,
  GripVertical,
  Image as ImageIcon,
  type LucideIcon,
  Music,
  Search as SearchIcon,
  Star,
  X,
} from 'lucide-react'

import type {
  MediaAssetFilterRawInput,
  MediaKind,
  TagFilterRawInput,
  TagMatchMode,
} from '@mannachef/validators'
import { MAX_MENU_ITEM_MEDIA, MAX_PAGE_SIZE } from '@mannachef/validators'

import { useAction } from '@/lib/action-client'
import { cn, FOCUS_RING } from '@/lib/utils'
import { listMediaAssets } from '@/server/actions/media'
import { listTags } from '@/server/actions/menu'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'

// =============================================================================
// 1. Vocabulary
// =============================================================================

/** How many assets one page of the library grid shows. */
const LIBRARY_PAGE_SIZE = 24

/** How long the search box waits after the last keystroke before querying. */
const SEARCH_DEBOUNCE_MS = 300

/** Enough placeholder tiles to fill the grid while the first page loads. */
const LOADING_TILE_COUNT = 8

/** The lucide glyph shown when an asset has no visual thumbnail to render. */
const KIND_FALLBACK_ICON: Record<MediaKind, LucideIcon> = {
  IMAGE: ImageIcon,
  VIDEO: Film,
  AUDIO: Music,
  DOCUMENT: FileText,
}

/**
 * A chosen asset, reduced to what this component and its caller need.
 *
 * Array position *is* the running order — there is no separate `sortOrder`
 * field here, so a caller assembling `MenuItemMediaEntryInput[]` (or any other
 * ordered-media payload) derives `sortOrder` from the index, exactly as
 * `menuItemMediaAssociationSchema` does when the field is omitted.
 */
export interface SelectedMediaAsset {
  readonly id: string
  readonly url: string
  readonly thumbnailUrl: string | null
  readonly alt: string
  readonly kind: MediaKind
  /** Exactly one entry in the array this belongs to has this set to `true`. */
  readonly isPrimary: boolean
}

export interface MediaSelectorProps {
  /** Whether the dialog is open. This component does not manage its own visibility. */
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /**
   * Called once, when the admin confirms. `selection` is in the chosen order
   * and always has exactly one `isPrimary: true` entry when it is non-empty.
   */
  readonly onConfirm: (selection: readonly SelectedMediaAsset[]) => void
  /** What was already chosen, if this selector is reopening an existing set. */
  readonly initialSelection?: readonly SelectedMediaAsset[]
  /** The largest gallery this call site allows. Defaults to a dish gallery's ceiling. */
  readonly maxItems?: number
  readonly title?: string
  readonly description?: string
  readonly confirmLabel?: string
}

// =============================================================================
// 2. Small, pure helpers
// =============================================================================

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) {
    return items.slice()
  }
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  if (moved === undefined) {
    return next
  }
  next.splice(to, 0, moved)
  return next
}

/** If nothing in the list is primary any more, the lead falls to the first entry. */
function withPrimaryGuaranteed(
  items: readonly SelectedMediaAsset[]
): SelectedMediaAsset[] {
  if (items.length === 0) {
    return []
  }
  if (items.some((item) => item.isPrimary)) {
    return items.slice()
  }
  return items.map((item, index) =>
    index === 0 ? { ...item, isPrimary: true } : item
  )
}

// =============================================================================
// 3. Thumbnails
// =============================================================================

function AssetThumbnail({
  asset,
  className,
}: {
  readonly asset: Pick<SelectedMediaAsset, 'url' | 'thumbnailUrl' | 'kind'>
  readonly className?: string
}) {
  const previewUrl =
    asset.kind === 'IMAGE' ? asset.thumbnailUrl ?? asset.url : asset.thumbnailUrl

  if (previewUrl !== null) {
    return (
      // Decorative: the accessible name for a thumbnail lives on the control
      // that wraps it (the grid button's aria-label, or the visible caption
      // text in the tray), never on the image twice over.
      <img
        src={previewUrl}
        alt=""
        loading="lazy"
        className={cn('size-full object-cover', className)}
      />
    )
  }

  const Icon = KIND_FALLBACK_ICON[asset.kind]
  return (
    <span
      className={cn(
        'flex size-full items-center justify-center bg-charcoal text-stone',
        className
      )}
    >
      <Icon aria-hidden="true" className="size-6" />
    </span>
  )
}

// =============================================================================
// 4. The library grid tile
// =============================================================================

interface LibraryTileProps {
  readonly asset: SelectedMediaAsset
  readonly selected: boolean
  readonly position: number | null
  readonly disabled: boolean
  readonly onToggle: () => void
}

function LibraryTile({
  asset,
  selected,
  position,
  disabled,
  onToggle,
}: LibraryTileProps) {
  const stateLabel = selected
    ? asset.isPrimary
      ? `, chosen as the lead photograph, position ${String(position)}`
      : `, chosen, position ${String(position)}`
    : ''

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`${asset.alt}${stateLabel}`}
      onClick={onToggle}
      disabled={disabled}
      title={asset.alt}
      className={cn(
        'group relative flex aspect-square flex-col overflow-hidden rounded-md border text-left',
        'transition-colors duration-150 ease-luxe disabled:opacity-45',
        selected
          ? 'border-stone/70'
          : 'border-ash hover:border-stone/50 disabled:hover:border-ash',
        FOCUS_RING
      )}
    >
      <AssetThumbnail asset={asset} className="min-h-0 flex-1" />
      {selected ? (
        <span className="absolute top-1.5 left-1.5 flex items-center gap-1">
          <Badge variant="default" numeric>
            {position}
          </Badge>
          {asset.isPrimary ? (
            <span className="flex size-5 items-center justify-center rounded-full border border-gold/60 bg-obsidian/70">
              <Star
                aria-hidden="true"
                fill="currentColor"
                className="size-3 text-champagne"
              />
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="truncate bg-charcoal/90 px-2 py-1 font-sans text-[11px] leading-tight text-parchment">
        {asset.alt}
      </span>
    </button>
  )
}

// =============================================================================
// 5. The chosen-photographs tray
// =============================================================================

interface TrayRowProps {
  readonly item: SelectedMediaAsset
  readonly index: number
  readonly total: number
  readonly dragging: boolean
  readonly onMoveUp: () => void
  readonly onMoveDown: () => void
  readonly onRemove: () => void
  readonly onDragStart: (event: React.DragEvent<HTMLLIElement>) => void
  readonly onDragOver: (event: React.DragEvent<HTMLLIElement>) => void
  readonly onDrop: (event: React.DragEvent<HTMLLIElement>) => void
  readonly onDragEnd: () => void
}

function TrayRow({
  item,
  index,
  total,
  dragging,
  onMoveUp,
  onMoveDown,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TrayRowProps) {
  const radioId = React.useId()

  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-roledescription="Draggable photograph. Use the move buttons to reorder from the keyboard."
      className={cn(
        'flex items-center gap-3 rounded-md border border-ash bg-charcoal/60 p-2',
        'transition-opacity duration-150 ease-luxe',
        dragging && 'opacity-50'
      )}
    >
      <GripVertical
        aria-hidden="true"
        className="size-4 shrink-0 cursor-grab text-stone"
      />
      <span className="size-12 shrink-0 overflow-hidden rounded-sm border border-ash">
        <AssetThumbnail asset={item} />
      </span>
      <span className="min-w-0 flex-1 truncate font-sans text-sm text-linen">
        <span className="sr-only">Position {index + 1}. </span>
        {item.alt}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <RadioGroupItem value={item.id} id={radioId} />
        <label
          htmlFor={radioId}
          className="cursor-pointer font-sans text-xs text-parchment select-none"
        >
          Lead photo
        </label>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMoveUp}
          disabled={index === 0}
          aria-label={`Move ${item.alt} up`}
        >
          <ArrowUp aria-hidden="true" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onMoveDown}
          disabled={index === total - 1}
          aria-label={`Move ${item.alt} down`}
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove ${item.alt} from the selection`}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </li>
  )
}

// =============================================================================
// 6. The dialog
// =============================================================================

export function MediaSelector({
  open,
  onOpenChange,
  onConfirm,
  initialSelection,
  maxItems = MAX_MENU_ITEM_MEDIA,
  title = 'Choose photographs',
  description = 'Search the library, choose photographs, then put them in order. The lead photograph is the one the dish — or chef, or collection — is remembered by.',
  confirmLabel = 'Use selected photographs',
}: MediaSelectorProps) {
  const searchInputId = React.useId()
  const hintId = React.useId()

  // Read once at the moment the dialog opens; see the reset effect below for
  // why this is a ref rather than a dependency.
  const initialSelectionRef = React.useRef(initialSelection)
  initialSelectionRef.current = initialSelection

  const [search, setSearch] = React.useState('')
  const [debouncedSearch, setDebouncedSearch] = React.useState('')
  const [tagSlugs, setTagSlugs] = React.useState<readonly string[]>([])
  const [tagMatchMode, setTagMatchMode] = React.useState<TagMatchMode>('ALL')
  const [page, setPage] = React.useState(1)
  const [selection, setSelection] = React.useState<readonly SelectedMediaAsset[]>(
    []
  )
  const [draggingId, setDraggingId] = React.useState<string | null>(null)

  const libraryQuery = useAction(listMediaAssets, { silent: true })
  const tagsQuery = useAction(listTags, { silent: true })

  // --- Reset everything the moment the dialog opens ------------------------
  // Deliberately keyed on `open` alone. `initialSelection` is read through a
  // ref instead of being a dependency: a caller re-rendering with a fresh
  // array literal for that prop must not wipe out browsing that is already in
  // progress while the dialog is still open.
  React.useEffect(() => {
    if (!open) {
      return
    }
    setSearch('')
    setDebouncedSearch('')
    setTagSlugs([])
    setTagMatchMode('ALL')
    setPage(1)
    setSelection(
      initialSelectionRef.current === undefined
        ? []
        : initialSelectionRef.current.map((item) => ({ ...item }))
    )
  }, [open])

  // --- Debounce the search box ----------------------------------------------
  React.useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search])

  // A filter changing (as opposed to paging) always starts back at page one.
  React.useEffect(() => {
    setPage(1)
  }, [debouncedSearch, tagSlugs, tagMatchMode])

  const runLibraryQuery = React.useCallback(() => {
    const raw: MediaAssetFilterRawInput = {
      search: debouncedSearch.length > 0 ? debouncedSearch : undefined,
      tagSlugs: tagSlugs.slice(),
      tagMatchMode,
      page,
      pageSize: LIBRARY_PAGE_SIZE,
    }
    void libraryQuery.execute(raw)
  }, [debouncedSearch, tagSlugs, tagMatchMode, page, libraryQuery.execute])

  React.useEffect(() => {
    if (open) {
      runLibraryQuery()
    }
  }, [open, runLibraryQuery])

  const runTagsQuery = React.useCallback(() => {
    const raw: TagFilterRawInput = { pageSize: MAX_PAGE_SIZE, sortBy: 'NAME' }
    void tagsQuery.execute(raw)
  }, [tagsQuery.execute])

  React.useEffect(() => {
    if (open) {
      runTagsQuery()
    }
  }, [open, runTagsQuery])

  // --- Selection mutations ---------------------------------------------------

  const toggleAsset = React.useCallback(
    (asset: SelectedMediaAsset) => {
      setSelection((current) => {
        const exists = current.some((item) => item.id === asset.id)
        if (exists) {
          return withPrimaryGuaranteed(
            current.filter((item) => item.id !== asset.id)
          )
        }
        if (current.length >= maxItems) {
          return current
        }
        return [...current, { ...asset, isPrimary: current.length === 0 }]
      })
    },
    [maxItems]
  )

  const removeSelected = React.useCallback((id: string) => {
    setSelection((current) =>
      withPrimaryGuaranteed(current.filter((item) => item.id !== id))
    )
  }, [])

  const setPrimary = React.useCallback((id: string) => {
    setSelection((current) =>
      current.map((item) => ({ ...item, isPrimary: item.id === id }))
    )
  }, [])

  const moveSelected = React.useCallback((index: number, direction: -1 | 1) => {
    setSelection((current) => moveItem(current, index, index + direction))
  }, [])

  const dragIndexRef = React.useRef<number | null>(null)

  const handleDragStart = React.useCallback(
    (index: number, id: string) => (event: React.DragEvent<HTMLLIElement>) => {
      dragIndexRef.current = index
      setDraggingId(id)
      event.dataTransfer.effectAllowed = 'move'
    },
    []
  )

  const handleDragOver = React.useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      event.preventDefault()
    },
    []
  )

  const handleDrop = React.useCallback(
    (index: number) => (event: React.DragEvent<HTMLLIElement>) => {
      event.preventDefault()
      const from = dragIndexRef.current
      dragIndexRef.current = null
      setDraggingId(null)
      if (from === null || from === index) {
        return
      }
      setSelection((current) => moveItem(current, from, index))
    },
    []
  )

  const handleDragEnd = React.useCallback(() => {
    dragIndexRef.current = null
    setDraggingId(null)
  }, [])

  const clearFilters = React.useCallback(() => {
    setSearch('')
    setDebouncedSearch('')
    setTagSlugs([])
    setTagMatchMode('ALL')
  }, [])

  const toggleTag = React.useCallback((slug: string) => {
    setTagSlugs((current) =>
      current.includes(slug)
        ? current.filter((existing) => existing !== slug)
        : [...current, slug]
    )
  }, [])

  const handleConfirm = React.useCallback(() => {
    onConfirm(selection)
    onOpenChange(false)
  }, [onConfirm, onOpenChange, selection])

  // --- Derived view state -----------------------------------------------------

  const items = libraryQuery.data?.items ?? []
  const meta = libraryQuery.data?.meta ?? null
  const tags = tagsQuery.data?.items ?? []
  const hasActiveFilters = debouncedSearch.length > 0 || tagSlugs.length > 0
  const primaryAsset = selection.find((item) => item.isPrimary) ?? null
  const primaryValue = primaryAsset?.id ?? ''

  const hintMessage =
    selection.length === 0
      ? 'Choose at least one photograph to continue.'
      : selection.length >= maxItems
        ? `${String(selection.length)} of ${String(maxItems)} chosen — that is the most this gallery holds. "${primaryAsset?.alt ?? ''}" is the lead photograph.`
        : `${String(selection.length)} of ${String(maxItems)} chosen. "${primaryAsset?.alt ?? ''}" is the lead photograph.`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-4xl flex-col gap-5">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_20rem]">
          {/* --- Library ------------------------------------------------- */}
          <section aria-label="Photograph library" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={searchInputId}>Search the library</Label>
              <div className="relative">
                <SearchIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone"
                />
                <Input
                  id={searchInputId}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by description, caption, or credit"
                  className="pl-9"
                />
              </div>
            </div>

            {tags.length > 0 ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="font-sans text-sm font-medium text-linen">
                  Tags
                </legend>
                <div className="flex flex-wrap items-center gap-2">
                  {tags.map((tag) => {
                    const active = tagSlugs.includes(tag.slug)
                    return (
                      <Button
                        key={tag.id}
                        type="button"
                        variant={active ? 'default' : 'outline'}
                        size="sm"
                        aria-pressed={active}
                        onClick={() => toggleTag(tag.slug)}
                      >
                        {tag.name}
                      </Button>
                    )
                  })}
                </div>
                {tagSlugs.length > 1 ? (
                  <div
                    role="group"
                    aria-label="How multiple tags are matched"
                    className="mt-1 flex items-center gap-2"
                  >
                    <Button
                      type="button"
                      variant={tagMatchMode === 'ALL' ? 'default' : 'ghost'}
                      size="sm"
                      aria-pressed={tagMatchMode === 'ALL'}
                      onClick={() => setTagMatchMode('ALL')}
                    >
                      Match every tag
                    </Button>
                    <Button
                      type="button"
                      variant={tagMatchMode === 'ANY' ? 'default' : 'ghost'}
                      size="sm"
                      aria-pressed={tagMatchMode === 'ANY'}
                      onClick={() => setTagMatchMode('ANY')}
                    >
                      Match any tag
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            ) : null}

            <Separator />

            <ScrollArea className="h-80 rounded-md border border-ash p-3">
              {libraryQuery.failure !== null ? (
                <EmptyState
                  tone="error"
                  title={libraryQuery.failure.title}
                  description={libraryQuery.failure.description}
                  action={
                    <Button variant="outline" size="sm" onClick={runLibraryQuery}>
                      Try again
                    </Button>
                  }
                />
              ) : libraryQuery.isPending && items.length === 0 ? (
                <div
                  role="status"
                  aria-busy="true"
                  aria-label="Loading the library"
                  className="grid grid-cols-3 gap-3 sm:grid-cols-4"
                >
                  {Array.from({ length: LOADING_TILE_COUNT }, (_, index) => (
                    <Skeleton key={index} className="aspect-square" />
                  ))}
                </div>
              ) : items.length === 0 ? (
                <EmptyState
                  tone={hasActiveFilters ? 'filtered' : 'empty'}
                  size="sm"
                  title={
                    hasActiveFilters
                      ? 'No photographs match those filters.'
                      : 'The library is empty.'
                  }
                  description={
                    hasActiveFilters
                      ? 'Try a different search, or clear the tags.'
                      : 'Upload photographs to the media library to choose them here.'
                  }
                  action={
                    hasActiveFilters ? (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {items.map((asset) => {
                    const chosen = selection.find((item) => item.id === asset.id)
                    const position =
                      chosen === undefined
                        ? null
                        : selection.findIndex((item) => item.id === asset.id) + 1
                    return (
                      <LibraryTile
                        key={asset.id}
                        asset={
                          chosen ?? {
                            id: asset.id,
                            url: asset.url,
                            thumbnailUrl: asset.thumbnailUrl,
                            alt: asset.alt,
                            kind: asset.kind,
                            isPrimary: false,
                          }
                        }
                        selected={chosen !== undefined}
                        position={position}
                        disabled={chosen === undefined && selection.length >= maxItems}
                        onToggle={() =>
                          toggleAsset({
                            id: asset.id,
                            url: asset.url,
                            thumbnailUrl: asset.thumbnailUrl,
                            alt: asset.alt,
                            kind: asset.kind,
                            isPrimary: false,
                          })
                        }
                      />
                    )
                  })}
                </div>
              )}
            </ScrollArea>

            <div className="flex items-center justify-between">
              <p className="font-sans text-xs text-stone">
                {meta === null
                  ? ''
                  : `Page ${String(meta.page)} of ${String(Math.max(meta.pageCount, 1))} — ${String(meta.total)} photograph${meta.total === 1 ? '' : 's'}`}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={meta?.hasPreviousPage !== true}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={meta?.hasNextPage !== true}
                >
                  Next
                </Button>
              </div>
            </div>
          </section>

          {/* --- Chosen tray ---------------------------------------------- */}
          <section aria-label="Chosen photographs" className="flex flex-col gap-3">
            <h3 className="font-display text-lg leading-tight font-medium tracking-tight text-linen">
              Chosen photographs
            </h3>
            <p id={hintId} aria-live="polite" className="font-sans text-xs text-stone">
              {hintMessage}
            </p>

            <ScrollArea className="h-80 rounded-md border border-ash p-2">
              {selection.length === 0 ? (
                <EmptyState
                  tone="empty"
                  size="sm"
                  title="Nothing chosen yet"
                  description="Select photographs from the library to add them here."
                />
              ) : (
                <RadioGroup
                  value={primaryValue}
                  onValueChange={setPrimary}
                  aria-label="Lead photograph"
                  className="contents"
                >
                  <ol aria-label="Chosen photographs, in order" className="flex flex-col gap-2">
                    {selection.map((item, index) => (
                      <TrayRow
                        key={item.id}
                        item={item}
                        index={index}
                        total={selection.length}
                        dragging={draggingId === item.id}
                        onMoveUp={() => moveSelected(index, -1)}
                        onMoveDown={() => moveSelected(index, 1)}
                        onRemove={() => removeSelected(item.id)}
                        onDragStart={handleDragStart(index, item.id)}
                        onDragOver={handleDragOver}
                        onDrop={handleDrop(index)}
                        onDragEnd={handleDragEnd}
                      />
                    ))}
                  </ol>
                </RadioGroup>
              )}
            </ScrollArea>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="champagne"
            onClick={handleConfirm}
            disabled={selection.length === 0}
            aria-describedby={hintId}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
