// mannachef/apps/web/src/components/admin/menu/menu-item-sheet.tsx
'use client'

/**
 * Create or edit a single dish, in a sheet.
 *
 * ## Where the data comes from
 *
 * This component holds no data-fetching of its own — `categories`,
 * `subcategories` and `dietaryTags` are read by a Server Component ancestor
 * (`listMenuCategories`, `listMenuSubcategories`, `listTags`) and handed down
 * as plain props, per `CONTRACT.md`'s "Server Components by default". Pass
 * `item` to edit an existing dish; omit it (or pass `null`) to create one.
 *
 * ## Two actions, one Save button
 *
 * `menuItemCreateSchema` / `menuItemUpdateSchema` carry every field on the
 * dish itself, but a dish's dietary tags are a separate relationship —
 * `setMenuItemTags`, per `ACTIONS-INDEX.md` — because a create payload cannot
 * name a `menuItemId` that does not exist yet. The operator only ever sees one
 * Save button; underneath it this component:
 *
 *  1. Calls `createMenuItem`/`updateMenuItem` with the dish's own fields.
 *  2. On success, if the dietary-tag selection changed, calls
 *     `setMenuItemTags` with the now-known dish id.
 *  3. Closes only once both halves have landed. If the tag call fails, the
 *     dish is already safely saved — the sheet stays open with a distinct
 *     retry control rather than pretending the whole save failed.
 *
 * Editing a dish is idempotent (`updateMenuItem` may be resubmitted freely),
 * so its fields stay live even after a successful save. Creating one is not —
 * a second click on "Add dish" would mint a duplicate — so the create form
 * locks its own fields the moment `createMenuItem` succeeds and replaces the
 * footer with "Done" / "Retry saving tags".
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { Check, ChefHat, ChevronDown, X } from 'lucide-react'

import {
  MAX_MENU_ITEM_TAGS,
  menuItemCreateSchema,
  menuItemUpdateSchema,
  type MenuItemCreateInput,
  type MenuItemCreateRawInput,
  type MenuItemUpdateInput,
  type MenuItemUpdateRawInput,
  type SpiceLevel,
  type TagKind,
} from '@mannachef/validators'

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  useAction,
  type DescribedActionFailure,
} from '@/lib/action-client'
import { cn, FOCUS_RING } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { createMenuItem, setMenuItemTags, updateMenuItem } from '@/server/actions/menu'

// =============================================================================
// Public shapes
// =============================================================================

export interface MenuItemSheetCategoryOption {
  readonly id: string
  readonly name: string
}

export interface MenuItemSheetSubcategoryOption {
  readonly id: string
  readonly name: string
  readonly categoryId: string
}

export interface MenuItemSheetDietaryTagOption {
  readonly id: string
  readonly name: string
  readonly kind: TagKind
}

/** The dish as it exists today. Every field `menuItemUpdateSchema` can touch, flattened. */
export interface MenuItemSheetRecord {
  readonly id: string
  readonly slug: string
  readonly categoryId: string
  readonly subcategoryId: string | null
  readonly name: string
  readonly description: string | null
  readonly story: string | null
  readonly tastingNote: string | null
  readonly pairingNote: string | null
  readonly chefNote: string | null
  readonly basePriceCents: number
  readonly currency: string
  readonly servingSize: string | null
  readonly servingsPerUnit: number | null
  readonly prepTimeMinutes: number | null
  readonly cookTimeMinutes: number | null
  readonly calories: number | null
  readonly proteinGram: number | null
  readonly carbGram: number | null
  readonly fatGram: number | null
  readonly spiceLevel: SpiceLevel
  readonly isSeasonal: boolean
  readonly seasonStart: number | null
  readonly seasonEnd: number | null
  readonly isActive: boolean
  readonly isSignature: boolean
  readonly sortOrder: number
  /** The dietary tags — `Tag.kind === 'DIETARY'` — currently pinned to this dish. */
  readonly tagIds: readonly string[]
}

export interface MenuItemSheetProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Omit, or pass `null`, to create a new dish. Pass a dish to edit it. */
  readonly item?: MenuItemSheetRecord | null
  readonly categories: readonly MenuItemSheetCategoryOption[]
  readonly subcategories: readonly MenuItemSheetSubcategoryOption[]
  /** Every active tag; this component keeps only `kind === 'DIETARY'`. */
  readonly dietaryTags: readonly MenuItemSheetDietaryTagOption[]
  /** Called once the dish (and, if changed, its tags) have been saved. */
  readonly onSaved?: ((saved: { id: string; name: string }) => void) | undefined
}

// =============================================================================
// Shared constants & small helpers
// =============================================================================

const MONTH_NAMES = [
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
] as const

const SPICE_LEVEL_OPTIONS: ReadonlyArray<{ value: SpiceLevel; label: string }> = [
  { value: 'NONE', label: 'None' },
  { value: 'MILD', label: 'Mild' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HOT', label: 'Hot' },
  { value: 'FIERY', label: 'Fiery' },
]

/** Every field path the two mutation schemas can produce a `fieldErrors` entry for. */
const MENU_ITEM_FIELD_PATHS = [
  'slug',
  'categoryId',
  'subcategoryId',
  'name',
  'description',
  'story',
  'tastingNote',
  'pairingNote',
  'chefNote',
  'basePriceCents',
  'currency',
  'servingSize',
  'servingsPerUnit',
  'prepTimeMinutes',
  'cookTimeMinutes',
  'calories',
  'proteinGram',
  'carbGram',
  'fatGram',
  'spiceLevel',
  'isSeasonal',
  'seasonStart',
  'seasonEnd',
  'isActive',
  'isSignature',
  'sortOrder',
] as const

const NO_SUBCATEGORY_VALUE = '__none__'

/** Order-independent set equality for two id lists. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

// =============================================================================
// Failure presentation — shared by both actions this sheet drives
// =============================================================================

/**
 * A distinct title and sentence per `ActionErrorCode`, never a generic box.
 * `useAction` already computes this; this just renders it the way every other
 * form on the platform does.
 */
function ActionFailureNotice({
  failure,
}: {
  readonly failure: DescribedActionFailure
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border px-3 py-2',
        failure.severity === 'error'
          ? 'border-claret/60 bg-claret/12'
          : 'border-terracotta/60 bg-terracotta/12'
      )}
    >
      <p className="font-sans text-sm font-semibold text-linen">{failure.title}</p>
      <p className="mt-1 font-sans text-sm leading-relaxed text-parchment">
        {failure.description}
      </p>
    </div>
  )
}

// =============================================================================
// Cents ⇄ dollars price input
// =============================================================================

interface PriceCentsInputProps
  extends Omit<React.ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'type'> {
  readonly cents: number
  readonly onCentsChange: (cents: number) => void
}

/**
 * Displays and edits `basePriceCents` in dollars, submits it in cents.
 *
 * `moneyCentsSchema` is `z.int()` — no coercion — so the value this hands to
 * `field.onChange` must already be the integer cents the schema wants. A local
 * text buffer lets the operator type "12.5" without the field snapping to a
 * rounded value mid-keystroke; the buffer re-syncs from `cents` whenever it
 * changes from outside (a reset, a server-applied correction).
 */
const PriceCentsInput = React.forwardRef<HTMLInputElement, PriceCentsInputProps>(
  function PriceCentsInput({ cents, onCentsChange, className, onBlur, ...rest }, ref) {
    const [text, setText] = React.useState(() => (cents / 100).toFixed(2))
    const lastCommitted = React.useRef(cents)

    React.useEffect(() => {
      if (cents !== lastCommitted.current) {
        lastCommitted.current = cents
        setText((cents / 100).toFixed(2))
      }
    }, [cents])

    return (
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-sans text-sm text-stone"
        >
          $
        </span>
        <Input
          ref={ref}
          type="text"
          inputMode="decimal"
          numeric
          placeholder="0.00"
          className={cn('pl-7', className)}
          value={text}
          onChange={(event) => {
            const raw = event.target.value
            // Allow only what a price can be while it is still being typed.
            if (!/^\d*\.?\d{0,2}$/.test(raw)) {
              return
            }
            setText(raw)
            const parsed = Number.parseFloat(raw)
            if (raw.trim().length > 0 && !Number.isNaN(parsed)) {
              const next = Math.round(parsed * 100)
              lastCommitted.current = next
              onCentsChange(next)
            }
          }}
          onBlur={(event) => {
            const parsed = Number.parseFloat(text)
            const next = Number.isNaN(parsed) ? 0 : Math.round(parsed * 100)
            lastCommitted.current = next
            setText((next / 100).toFixed(2))
            onCentsChange(next)
            onBlur?.(event)
          }}
          {...rest}
        />
      </div>
    )
  }
)

// =============================================================================
// Dietary tags — multi-select
// =============================================================================

interface DietaryTagsPickerProps {
  readonly id: string
  readonly tags: readonly MenuItemSheetDietaryTagOption[]
  readonly selectedIds: readonly string[]
  readonly onChange: (ids: string[]) => void
  readonly disabled?: boolean
}

/**
 * A Popover + Command combobox for the dish's dietary tags.
 *
 * Not an RHF field — `menuItemCreateSchema`/`menuItemUpdateSchema` know
 * nothing about tags, which live on `MenuItemTag` and are set by
 * `setMenuItemTags` once the dish itself has an id.
 */
function DietaryTagsPicker({
  id,
  tags,
  selectedIds,
  onChange,
  disabled = false,
}: DietaryTagsPickerProps) {
  const [open, setOpen] = React.useState(false)

  const dietaryTags = React.useMemo(
    () => tags.filter((tag) => tag.kind === 'DIETARY'),
    [tags]
  )
  const selected = React.useMemo(
    () => dietaryTags.filter((tag) => selectedIds.includes(tag.id)),
    [dietaryTags, selectedIds]
  )

  function toggle(tagId: string) {
    if (selectedIds.includes(tagId)) {
      onChange(selectedIds.filter((value) => value !== tagId))
      return
    }
    if (selectedIds.length >= MAX_MENU_ITEM_TAGS) {
      return
    }
    onChange([...selectedIds, tagId])
  }

  function remove(tagId: string) {
    onChange(selectedIds.filter((value) => value !== tagId))
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            disabled={disabled || dietaryTags.length === 0}
            className="w-full justify-between font-normal"
          >
            <span
              className={cn('truncate text-left', selected.length === 0 && 'text-stone')}
            >
              {dietaryTags.length === 0
                ? 'No dietary tags yet'
                : selected.length === 0
                  ? 'Choose dietary tags'
                  : `${String(selected.length)} chosen`}
            </span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-stone" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
          <Command>
            <CommandInput placeholder="Search dietary tags…" />
            <CommandList>
              <CommandEmpty>No dietary tags match.</CommandEmpty>
              <CommandGroup>
                {dietaryTags.map((tag) => {
                  const isSelected = selectedIds.includes(tag.id)
                  return (
                    <CommandItem
                      key={tag.id}
                      value={tag.name}
                      onSelect={() => toggle(tag.id)}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-4 items-center justify-center rounded-sm border border-ash',
                          isSelected && 'border-gold bg-champagne text-obsidian'
                        )}
                      >
                        {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
                      </span>
                      {tag.name}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen dietary tags">
          {selected.map((tag) => (
            <li key={tag.id}>
              <Badge variant="outline" className="gap-1 py-1 pr-1 pl-2">
                {tag.name}
                <button
                  type="button"
                  onClick={() => remove(tag.id)}
                  disabled={disabled}
                  className={cn(
                    'rounded-sm p-0.5 text-stone transition-colors duration-150 ease-luxe hover:text-linen',
                    'disabled:pointer-events-none disabled:opacity-50',
                    FOCUS_RING
                  )}
                  aria-label={`Remove ${tag.name} from this dish`}
                >
                  <X aria-hidden="true" className="size-3" />
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
// Seasonality — wrap-around aware month range
// =============================================================================

function SeasonalWindowNote({
  start,
  end,
}: {
  readonly start: number | null
  readonly end: number | null
}) {
  if (start === null || end === null) {
    return (
      <p className="font-sans text-xs leading-relaxed text-stone">
        Choose both ends of the window. The closing month may come before the
        opening one — that means the season crosses the new year.
      </p>
    )
  }

  const startLabel = MONTH_NAMES[start - 1]
  const endLabel = MONTH_NAMES[end - 1]

  if (start === end) {
    return (
      <p className="font-sans text-xs leading-relaxed text-parchment">
        In season during {startLabel} only.
      </p>
    )
  }

  if (start < end) {
    return (
      <p className="font-sans text-xs leading-relaxed text-parchment">
        In season from {startLabel} through {endLabel}.
      </p>
    )
  }

  return (
    <p className="font-sans text-xs leading-relaxed text-parchment">
      In season from {startLabel} through {endLabel}, crossing over the new
      year.
    </p>
  )
}

// =============================================================================
// Create form
// =============================================================================

interface MenuItemFormPanelProps {
  readonly categories: readonly MenuItemSheetCategoryOption[]
  readonly subcategories: readonly MenuItemSheetSubcategoryOption[]
  readonly dietaryTags: readonly MenuItemSheetDietaryTagOption[]
  readonly onDirtyChange: (dirty: boolean) => void
  /** The guarded close — used by Cancel. Prompts first when there is unsaved work. */
  readonly onRequestClose: () => void
  /** The unconditional close — used once a save has actually landed. */
  readonly onClose: () => void
  readonly onSaved?: ((saved: { id: string; name: string }) => void) | undefined
}

const CREATE_DEFAULT_VALUES: Omit<MenuItemCreateRawInput, 'categoryId'> = {
  slug: '',
  subcategoryId: null,
  name: '',
  description: null,
  story: null,
  tastingNote: null,
  pairingNote: null,
  chefNote: null,
  basePriceCents: 0,
  currency: 'CAD',
  servingSize: null,
  servingsPerUnit: null,
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  calories: null,
  proteinGram: null,
  carbGram: null,
  fatGram: null,
  spiceLevel: 'NONE',
  isSeasonal: false,
  seasonStart: null,
  seasonEnd: null,
  isActive: true,
  isSignature: false,
  sortOrder: 0,
}

function CreateMenuItemForm({
  categories,
  subcategories,
  dietaryTags,
  onDirtyChange,
  onRequestClose,
  onClose,
  onSaved,
}: MenuItemFormPanelProps) {
  const form = useForm<MenuItemCreateRawInput, unknown, MenuItemCreateInput>({
    resolver: zodResolver(menuItemCreateSchema),
    defaultValues: {
      ...CREATE_DEFAULT_VALUES,
      categoryId: categories[0]?.id ?? '',
    },
    mode: 'onBlur',
  })

  const [selectedTagIds, setSelectedTagIds] = React.useState<string[]>([])
  const [savedItemId, setSavedItemId] = React.useState<string | null>(null)

  const tagAction = useAction(setMenuItemTags, {
    successMessage: 'Dietary tags saved.',
  })

  const coreAction = useAction(createMenuItem, {
    form,
    knownFieldPaths: MENU_ITEM_FIELD_PATHS,
    successMessage: (data) => `${data.name} is on the menu.`,
    onSuccess: async (data) => {
      setSavedItemId(data.id)

      if (selectedTagIds.length === 0) {
        onSaved?.({ id: data.id, name: data.name })
        onClose()
        return
      }

      const tagResult = await tagAction.execute({
        menuItemId: data.id,
        tagIds: selectedTagIds,
      })

      if (tagResult.ok) {
        onSaved?.({ id: data.id, name: data.name })
        onClose()
      }
    },
  })

  const coreDone = coreAction.status === 'success'
  const pending = coreAction.isPending || tagAction.isPending
  const tagsFailed = coreDone && tagAction.error !== null

  React.useEffect(() => {
    onDirtyChange(form.formState.isDirty && !coreDone)
  }, [form.formState.isDirty, coreDone, onDirtyChange])

  const categoryId = form.watch('categoryId')
  const isSeasonal = form.watch('isSeasonal')
  const seasonStart = form.watch('seasonStart') ?? null
  const seasonEnd = form.watch('seasonEnd') ?? null
  const availableSubcategories = subcategories.filter(
    (subcategory) => subcategory.categoryId === categoryId
  )

  const dietaryTagsFieldId = React.useId()

  async function retrySavingTags() {
    if (savedItemId === null) {
      return
    }
    const result = await tagAction.execute({
      menuItemId: savedItemId,
      tagIds: selectedTagIds,
    })
    if (result.ok) {
      onSaved?.({ id: savedItemId, name: form.getValues('name') })
      onClose()
    }
  }

  function closeWithoutTags() {
    if (savedItemId !== null) {
      onSaved?.({ id: savedItemId, name: form.getValues('name') })
    }
    onClose()
  }

  if (categories.length === 0) {
    return (
      <EmptyState
        icon={ChefHat}
        title="No collections yet"
        description="A dish needs a collection to belong to. Create one from the menu page before adding a dish."
        className="mt-6"
      />
    )
  }

  return (
    <Form {...form}>
      <form
        className="flex flex-1 flex-col gap-5 overflow-hidden"
        onSubmit={form.handleSubmit((values) => {
          void coreAction.execute(values)
        })}
        noValidate
      >
        <ScrollArea className="-mx-6 flex-1" viewportClassName="px-6 pb-1">
          <fieldset disabled={pending || coreDone} className="contents">
            <legend className="sr-only">Dish details</legend>
            <div className="flex flex-col gap-8">
              <section aria-labelledby="mi-create-identity" className="flex flex-col gap-4">
                <h3
                  id="mi-create-identity"
                  className="font-display text-base font-medium text-linen"
                >
                  Identity
                </h3>

                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Autumn squash agnolotti" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="slug"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Web address handle</FormLabel>
                      <FormControl>
                        <Input placeholder="autumn-squash-agnolotti" {...field} />
                      </FormControl>
                      <FormDescription>
                        Lowercase letters, numbers and single hyphens — this becomes
                        part of the dish&apos;s public web address.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="categoryId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Collection</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            const currentSub = form.getValues('subcategoryId')
                            const stillValid = subcategories.some(
                              (subcategory) =>
                                subcategory.id === currentSub &&
                                subcategory.categoryId === value
                            )
                            if (currentSub != null && !stillValid) {
                              form.setValue('subcategoryId', null, { shouldDirty: true })
                            }
                          }}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Choose a collection" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {categories.map((category) => (
                              <SelectItem key={category.id} value={category.id}>
                                {category.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="subcategoryId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Course</FormLabel>
                        <Select
                          value={field.value ?? NO_SUBCATEGORY_VALUE}
                          onValueChange={(value) =>
                            field.onChange(value === NO_SUBCATEGORY_VALUE ? null : value)
                          }
                          disabled={availableSubcategories.length === 0}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="No course" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={NO_SUBCATEGORY_VALUE}>No course</SelectItem>
                            {availableSubcategories.map((subcategory) => (
                              <SelectItem key={subcategory.id} value={subcategory.id}>
                                {subcategory.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="tastingNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tasting note</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          placeholder="Brown butter, sage, a whisper of nutmeg."
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value)}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormDescription>
                        The line a guest reads before they decide. Kept short on
                        purpose.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value)}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="story"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Story</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={4}
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value)}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormDescription>
                        The longer read on the dish page — provenance, technique,
                        why it&apos;s here.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="pairingNote"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Pairing note</FormLabel>
                        <FormControl>
                          <Textarea
                            rows={2}
                            value={field.value ?? ''}
                            onChange={(event) => field.onChange(event.target.value)}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="chefNote"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chef&apos;s note</FormLabel>
                        <FormControl>
                          <Textarea
                            rows={2}
                            value={field.value ?? ''}
                            onChange={(event) => field.onChange(event.target.value)}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>

              <Separator />

              <section aria-labelledby="mi-create-pricing" className="flex flex-col gap-4">
                <h3
                  id="mi-create-pricing"
                  className="font-display text-base font-medium text-linen"
                >
                  Pricing
                </h3>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="basePriceCents"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Price</FormLabel>
                        <FormControl>
                          <PriceCentsInput
                            name={field.name}
                            cents={field.value}
                            onCentsChange={field.onChange}
                            onBlur={field.onBlur}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormDescription>
                          Shown to guests in dollars; stored as cents.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Currency</FormLabel>
                        <FormControl>
                          <Input
                            maxLength={3}
                            placeholder="CAD"
                            className="uppercase"
                            value={field.value}
                            onChange={(event) =>
                              field.onChange(event.target.value.toUpperCase())
                            }
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>

              <Separator />

              <section aria-labelledby="mi-create-timings" className="flex flex-col gap-4">
                <h3
                  id="mi-create-timings"
                  className="font-display text-base font-medium text-linen"
                >
                  Timings
                </h3>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="servingSize"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Serving size</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="One generous portion"
                            value={field.value ?? ''}
                            onChange={(event) => field.onChange(event.target.value)}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="servingsPerUnit"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Servings per unit</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={1}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="prepTimeMinutes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Prep time (minutes)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={1}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="cookTimeMinutes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cook time (minutes)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={1}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>

              <Separator />

              <section aria-labelledby="mi-create-macros" className="flex flex-col gap-4">
                <h3
                  id="mi-create-macros"
                  className="font-display text-base font-medium text-linen"
                >
                  Macros &amp; heat
                </h3>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <FormField
                    control={form.control}
                    name="calories"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Calories</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={0}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="proteinGram"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Protein (g)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={0}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="carbGram"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Carbs (g)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={0}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="fatGram"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fat (g)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={0}
                            step={1}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw === '' ? null : Number(raw))
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="spiceLevel"
                  render={({ field }) => (
                    <FormItem className="sm:max-w-xs">
                      <FormLabel required>Heat level</FormLabel>
                      <Select value={field.value ?? 'NONE'} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a heat level" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SPICE_LEVEL_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </section>

            </div>
          </fieldset>

          {/*
           * Dietary tags live outside the fieldset above on purpose: they are
           * not part of `menuItemCreateSchema` at all (see the file docblock),
           * and they must stay editable after the dish itself has saved so a
           * failed `setMenuItemTags` call can be retried without re-creating
           * the dish.
           */}
          <Separator className="my-8" />
          <section aria-labelledby="mi-create-tags" className="flex flex-col gap-3">
            <h3
              id="mi-create-tags"
              className="font-display text-base font-medium text-linen"
            >
              Dietary tags
            </h3>
            <Label htmlFor={dietaryTagsFieldId}>Dietary tags</Label>
            <DietaryTagsPicker
              id={dietaryTagsFieldId}
              tags={dietaryTags}
              selectedIds={selectedTagIds}
              onChange={setSelectedTagIds}
              disabled={pending}
            />
            <p className="font-sans text-xs leading-relaxed text-stone">
              Every dietary note this dish satisfies — vegetarian, gluten-free,
              dairy-free, and the like.
            </p>
          </section>
          <Separator className="my-8" />

          <fieldset disabled={pending || coreDone} className="contents">
            <div className="flex flex-col gap-8">
              <section
                aria-labelledby="mi-create-seasonality"
                className="flex flex-col gap-4"
              >
                <h3
                  id="mi-create-seasonality"
                  className="font-display text-base font-medium text-linen"
                >
                  Seasonality
                </h3>

                <FormField
                  control={form.control}
                  name="isSeasonal"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <CheckboxField
                          checked={field.value ?? false}
                          onCheckedChange={(checked) => {
                            const next = checked === true
                            field.onChange(next)
                            if (!next) {
                              form.setValue('seasonStart', null, { shouldDirty: true })
                              form.setValue('seasonEnd', null, { shouldDirty: true })
                            }
                          }}
                          label="Follows the seasons"
                          description="Limit this dish to a window of months. The window may cross the new year."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {isSeasonal ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="seasonStart"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel required>From</FormLabel>
                            <Select
                              {...(field.value == null
                                ? {}
                                : { value: String(field.value) })}
                              onValueChange={(value) => field.onChange(Number(value))}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Month" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {MONTH_NAMES.map((label, index) => (
                                  <SelectItem key={label} value={String(index + 1)}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="seasonEnd"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel required>Through</FormLabel>
                            <Select
                              {...(field.value == null
                                ? {}
                                : { value: String(field.value) })}
                              onValueChange={(value) => field.onChange(Number(value))}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Month" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {MONTH_NAMES.map((label, index) => (
                                  <SelectItem key={label} value={String(index + 1)}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <SeasonalWindowNote start={seasonStart} end={seasonEnd} />
                  </>
                ) : null}
              </section>

              <Separator />

              <section aria-labelledby="mi-create-flags" className="flex flex-col gap-4">
                <h3
                  id="mi-create-flags"
                  className="font-display text-base font-medium text-linen"
                >
                  Flags
                </h3>

                <FormField
                  control={form.control}
                  name="isActive"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <CheckboxField
                          checked={field.value ?? true}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                          label="On the menu"
                          description="Guests can see and order this dish once it is published."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="isSignature"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <CheckboxField
                          checked={field.value ?? false}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                          label="Signature dish"
                          description="Featured ahead of the rest of the collection."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="sortOrder"
                  render={({ field }) => (
                    <FormItem className="sm:max-w-xs">
                      <FormLabel>Running order</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={0}
                          step={1}
                          value={field.value}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? 0 : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormDescription>
                        Where this dish sits within its course. Lower numbers
                        come first.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </section>
            </div>
          </fieldset>
        </ScrollArea>

        <div className="flex flex-col gap-3">
          <FormRootError />
          {coreAction.failure === null ? null : (
            <ActionFailureNotice failure={coreAction.failure} />
          )}
          {tagsFailed && tagAction.failure !== null ? (
            <div className="flex flex-col gap-2">
              <ActionFailureNotice failure={tagAction.failure} />
              <p className="font-sans text-xs leading-relaxed text-stone">
                The dish itself is already saved — only its dietary tags did not
                go through.
              </p>
            </div>
          ) : null}
          <FormStatus>{coreAction.statusMessage}</FormStatus>
          <FormStatus>{tagAction.statusMessage}</FormStatus>
        </div>

        <SheetFooter>
          {coreDone ? (
            <>
              <Button type="button" variant="outline" onClick={closeWithoutTags}>
                {tagsFailed ? 'Close without saving tags' : 'Done'}
              </Button>
              {tagsFailed ? (
                <Button
                  type="button"
                  variant="champagne"
                  loading={tagAction.isPending}
                  loadingLabel="Saving tags…"
                  onClick={() => void retrySavingTags()}
                >
                  Retry saving tags
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onRequestClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="champagne"
                loading={coreAction.isPending}
                loadingLabel="Adding dish…"
              >
                Add dish
              </Button>
            </>
          )}
        </SheetFooter>
      </form>
    </Form>
  )
}

// =============================================================================
// Edit form
// =============================================================================

interface EditMenuItemFormProps extends MenuItemFormPanelProps {
  readonly item: MenuItemSheetRecord
}

function editDefaultValues(item: MenuItemSheetRecord): MenuItemUpdateRawInput {
  return {
    id: item.id,
    slug: item.slug,
    categoryId: item.categoryId,
    subcategoryId: item.subcategoryId,
    name: item.name,
    description: item.description,
    story: item.story,
    tastingNote: item.tastingNote,
    pairingNote: item.pairingNote,
    chefNote: item.chefNote,
    basePriceCents: item.basePriceCents,
    currency: item.currency,
    servingSize: item.servingSize,
    servingsPerUnit: item.servingsPerUnit,
    prepTimeMinutes: item.prepTimeMinutes,
    cookTimeMinutes: item.cookTimeMinutes,
    calories: item.calories,
    proteinGram: item.proteinGram,
    carbGram: item.carbGram,
    fatGram: item.fatGram,
    spiceLevel: item.spiceLevel,
    isSeasonal: item.isSeasonal,
    seasonStart: item.seasonStart,
    seasonEnd: item.seasonEnd,
    isActive: item.isActive,
    isSignature: item.isSignature,
    sortOrder: item.sortOrder,
  }
}

function EditMenuItemForm({
  item,
  categories,
  subcategories,
  dietaryTags,
  onDirtyChange,
  onRequestClose,
  onClose,
  onSaved,
}: EditMenuItemFormProps) {
  const form = useForm<MenuItemUpdateRawInput, unknown, MenuItemUpdateInput>({
    resolver: zodResolver(menuItemUpdateSchema),
    defaultValues: editDefaultValues(item),
    mode: 'onBlur',
  })

  const [selectedTagIds, setSelectedTagIds] = React.useState<string[]>(() => [
    ...item.tagIds,
  ])
  const [syncedTagIds, setSyncedTagIds] = React.useState<string[]>(() => [
    ...item.tagIds,
  ])

  const tagAction = useAction(setMenuItemTags, {
    successMessage: 'Dietary tags saved.',
  })

  const coreAction = useAction(updateMenuItem, {
    form,
    knownFieldPaths: [...MENU_ITEM_FIELD_PATHS, 'id'],
    successMessage: (data) => `${data.name} has been updated.`,
    onSuccess: async (data) => {
      const tagsDirty = !sameIdSet(selectedTagIds, syncedTagIds)

      if (!tagsDirty) {
        onSaved?.({ id: data.id, name: data.name })
        onClose()
        return
      }

      const tagResult = await tagAction.execute({
        menuItemId: item.id,
        tagIds: selectedTagIds,
      })

      if (tagResult.ok) {
        setSyncedTagIds([...selectedTagIds])
        onSaved?.({ id: data.id, name: data.name })
        onClose()
      }
    },
  })

  const pending = coreAction.isPending || tagAction.isPending
  const tagsDirty = !sameIdSet(selectedTagIds, syncedTagIds)
  const tagsFailed = tagAction.error !== null

  React.useEffect(() => {
    onDirtyChange((form.formState.isDirty || tagsDirty) && coreAction.status !== 'success')
  }, [form.formState.isDirty, tagsDirty, coreAction.status, onDirtyChange])

  const categoryId = form.watch('categoryId') ?? item.categoryId
  const isSeasonal = form.watch('isSeasonal') ?? false
  const seasonStart = form.watch('seasonStart') ?? null
  const seasonEnd = form.watch('seasonEnd') ?? null
  const availableSubcategories = subcategories.filter(
    (subcategory) => subcategory.categoryId === categoryId
  )

  const dietaryTagsFieldId = React.useId()

  async function retrySavingTags() {
    const result = await tagAction.execute({
      menuItemId: item.id,
      tagIds: selectedTagIds,
    })
    if (result.ok) {
      setSyncedTagIds([...selectedTagIds])
      onSaved?.({ id: item.id, name: form.getValues('name') ?? item.name })
      onClose()
    }
  }

  return (
    <Form {...form}>
      <form
        className="flex flex-1 flex-col gap-5 overflow-hidden"
        onSubmit={form.handleSubmit((values) => {
          void coreAction.execute(values)
        })}
        noValidate
      >
        <ScrollArea className="-mx-6 flex-1" viewportClassName="px-6 pb-1">
          <div className="flex flex-col gap-8">
            <section aria-labelledby="mi-edit-identity" className="flex flex-col gap-4">
              <h3
                id="mi-edit-identity"
                className="font-display text-base font-medium text-linen"
              >
                Identity
              </h3>

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Name</FormLabel>
                    <FormControl>
                      <Input
                        disabled={pending}
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Web address handle</FormLabel>
                    <FormControl>
                      <Input
                        disabled={pending}
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      Changing this updates the dish&apos;s public web address.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Collection</FormLabel>
                      <Select
                        value={field.value ?? item.categoryId}
                        onValueChange={(value) => {
                          field.onChange(value)
                          const currentSub =
                            form.getValues('subcategoryId') ?? item.subcategoryId
                          const stillValid = subcategories.some(
                            (subcategory) =>
                              subcategory.id === currentSub &&
                              subcategory.categoryId === value
                          )
                          if (currentSub != null && !stillValid) {
                            form.setValue('subcategoryId', null, { shouldDirty: true })
                          }
                        }}
                        disabled={pending}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a collection" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="subcategoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Course</FormLabel>
                      <Select
                        value={field.value ?? NO_SUBCATEGORY_VALUE}
                        onValueChange={(value) =>
                          field.onChange(value === NO_SUBCATEGORY_VALUE ? null : value)
                        }
                        disabled={pending || availableSubcategories.length === 0}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="No course" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NO_SUBCATEGORY_VALUE}>No course</SelectItem>
                          {availableSubcategories.map((subcategory) => (
                            <SelectItem key={subcategory.id} value={subcategory.id}>
                              {subcategory.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="tastingNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tasting note</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        disabled={pending}
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      The line a guest reads before they decide.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        disabled={pending}
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="story"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Story</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        disabled={pending}
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      The longer read on the dish page — provenance, technique,
                      why it&apos;s here.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="pairingNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pairing note</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value)}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="chefNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chef&apos;s note</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value)}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <Separator />

            <section aria-labelledby="mi-edit-pricing" className="flex flex-col gap-4">
              <h3
                id="mi-edit-pricing"
                className="font-display text-base font-medium text-linen"
              >
                Pricing
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="basePriceCents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Price</FormLabel>
                      <FormControl>
                        <PriceCentsInput
                          name={field.name}
                          cents={field.value ?? item.basePriceCents}
                          onCentsChange={field.onChange}
                          onBlur={field.onBlur}
                          ref={field.ref}
                          disabled={pending}
                        />
                      </FormControl>
                      <FormDescription>
                        Shown to guests in dollars; stored as cents.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Currency</FormLabel>
                      <FormControl>
                        <Input
                          maxLength={3}
                          className="uppercase"
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) =>
                            field.onChange(event.target.value.toUpperCase())
                          }
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <Separator />

            <section aria-labelledby="mi-edit-timings" className="flex flex-col gap-4">
              <h3
                id="mi-edit-timings"
                className="font-display text-base font-medium text-linen"
              >
                Timings
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="servingSize"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Serving size</FormLabel>
                      <FormControl>
                        <Input
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value)}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="servingsPerUnit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Servings per unit</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={1}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="prepTimeMinutes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Prep time (minutes)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={1}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="cookTimeMinutes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cook time (minutes)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={1}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <Separator />

            <section aria-labelledby="mi-edit-macros" className="flex flex-col gap-4">
              <h3
                id="mi-edit-macros"
                className="font-display text-base font-medium text-linen"
              >
                Macros &amp; heat
              </h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <FormField
                  control={form.control}
                  name="calories"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Calories</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={0}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="proteinGram"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Protein (g)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={0}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="carbGram"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Carbs (g)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={0}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="fatGram"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fat (g)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          numeric
                          min={0}
                          step={1}
                          disabled={pending}
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw === '' ? null : Number(raw))
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="spiceLevel"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel required>Heat level</FormLabel>
                    <Select
                      value={field.value ?? item.spiceLevel}
                      onValueChange={field.onChange}
                      disabled={pending}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a heat level" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SPICE_LEVEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            <Separator />

            <section aria-labelledby="mi-edit-tags" className="flex flex-col gap-3">
              <h3
                id="mi-edit-tags"
                className="font-display text-base font-medium text-linen"
              >
                Dietary tags
              </h3>
              <Label htmlFor={dietaryTagsFieldId}>Dietary tags</Label>
              <DietaryTagsPicker
                id={dietaryTagsFieldId}
                tags={dietaryTags}
                selectedIds={selectedTagIds}
                onChange={setSelectedTagIds}
                disabled={pending}
              />
              <p className="font-sans text-xs leading-relaxed text-stone">
                Every dietary note this dish satisfies — vegetarian, gluten-free,
                dairy-free, and the like.
              </p>
              {tagsFailed && tagAction.failure !== null ? (
                <div className="flex flex-col gap-2">
                  <ActionFailureNotice failure={tagAction.failure} />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={tagAction.isPending}
                      loadingLabel="Saving tags…"
                      onClick={() => void retrySavingTags()}
                    >
                      Retry saving tags
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>

            <Separator />

            <section
              aria-labelledby="mi-edit-seasonality"
              className="flex flex-col gap-4"
            >
              <h3
                id="mi-edit-seasonality"
                className="font-display text-base font-medium text-linen"
              >
                Seasonality
              </h3>

              <FormField
                control={form.control}
                name="isSeasonal"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <CheckboxField
                        checked={field.value ?? false}
                        disabled={pending}
                        onCheckedChange={(checked) => {
                          const next = checked === true
                          field.onChange(next)
                          if (!next) {
                            form.setValue('seasonStart', null, { shouldDirty: true })
                            form.setValue('seasonEnd', null, { shouldDirty: true })
                          }
                        }}
                        label="Follows the seasons"
                        description="Limit this dish to a window of months. The window may cross the new year."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {isSeasonal ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="seasonStart"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel required>From</FormLabel>
                          <Select
                            {...(field.value == null ? {} : { value: String(field.value) })}
                            onValueChange={(value) => field.onChange(Number(value))}
                            disabled={pending}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Month" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {MONTH_NAMES.map((label, index) => (
                                <SelectItem key={label} value={String(index + 1)}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="seasonEnd"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel required>Through</FormLabel>
                          <Select
                            {...(field.value == null ? {} : { value: String(field.value) })}
                            onValueChange={(value) => field.onChange(Number(value))}
                            disabled={pending}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Month" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {MONTH_NAMES.map((label, index) => (
                                <SelectItem key={label} value={String(index + 1)}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <SeasonalWindowNote start={seasonStart} end={seasonEnd} />
                </>
              ) : null}
            </section>

            <Separator />

            <section aria-labelledby="mi-edit-flags" className="flex flex-col gap-4">
              <h3
                id="mi-edit-flags"
                className="font-display text-base font-medium text-linen"
              >
                Flags
              </h3>

              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <CheckboxField
                        checked={field.value ?? item.isActive}
                        disabled={pending}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                        label="On the menu"
                        description="Guests can see and order this dish once it is published."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isSignature"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <CheckboxField
                        checked={field.value ?? item.isSignature}
                        disabled={pending}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                        label="Signature dish"
                        description="Featured ahead of the rest of the collection."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sortOrder"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel>Running order</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={0}
                        step={1}
                        disabled={pending}
                        value={field.value ?? item.sortOrder}
                        onChange={(event) => {
                          const raw = event.target.value
                          field.onChange(raw === '' ? 0 : Number(raw))
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      Where this dish sits within its course. Lower numbers come
                      first.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>
          </div>
        </ScrollArea>

        <div className="flex flex-col gap-3">
          <FormRootError />
          {coreAction.failure === null ? null : (
            <ActionFailureNotice failure={coreAction.failure} />
          )}
          <FormStatus>{coreAction.statusMessage}</FormStatus>
          <FormStatus>{tagAction.statusMessage}</FormStatus>
        </div>

        <SheetFooter>
          <Button type="button" variant="outline" onClick={onRequestClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="champagne"
            loading={coreAction.isPending}
            loadingLabel="Saving changes…"
          >
            Save changes
          </Button>
        </SheetFooter>
      </form>
    </Form>
  )
}

// =============================================================================
// The sheet
// =============================================================================

export function MenuItemSheet({
  open,
  onOpenChange,
  item,
  categories,
  subcategories,
  dietaryTags,
  onSaved,
}: MenuItemSheetProps) {
  const [dirty, setDirty] = React.useState(false)
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false)

  const isEdit = item != null

  function requestClose() {
    if (dirty) {
      setConfirmDiscardOpen(true)
      return
    }
    onOpenChange(false)
  }

  function closeImmediately() {
    setDirty(false)
    setConfirmDiscardOpen(false)
    onOpenChange(false)
  }

  function handleSheetOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true)
      return
    }
    requestClose()
  }

  function confirmDiscard() {
    setDirty(false)
    setConfirmDiscardOpen(false)
    onOpenChange(false)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleSheetOpenChange}>
        <SheetContent side="right" className="w-full gap-4 sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{isEdit ? `Edit ${item.name}` : 'Add a dish'}</SheetTitle>
            <SheetDescription>
              {isEdit
                ? 'Every field here can be changed independently — save whenever you like.'
                : 'A dish needs a collection, a name and a price before it can go on the menu.'}
            </SheetDescription>
          </SheetHeader>

          {isEdit ? (
            <EditMenuItemForm
              key={item.id}
              item={item}
              categories={categories}
              subcategories={subcategories}
              dietaryTags={dietaryTags}
              onDirtyChange={setDirty}
              onRequestClose={requestClose}
              onClose={closeImmediately}
              onSaved={onSaved}
            />
          ) : (
            <CreateMenuItemForm
              key="create"
              categories={categories}
              subcategories={subcategories}
              dietaryTags={dietaryTags}
              onDirtyChange={setDirty}
              onRequestClose={requestClose}
              onClose={closeImmediately}
              onSaved={onSaved}
            />
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'This dish has changes that have not been saved. Closing now loses them.'
                : 'This dish has not been saved yet. Closing now loses what you have entered.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscardOpen(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={confirmDiscard}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
