// mannachef/apps/web/src/components/admin/billing/manual-invoice-form.tsx
'use client'

/**
 * The manual invoice generator — a private event, a tasting, a bottle of
 * something rare, billed outside the subscription engine.
 *
 * Self-contained on purpose: its own trigger button, its own dialog, its own
 * submit. `app/(admin)/admin/invoices/page.tsx` is a Server Component and
 * renders `<ManualInvoiceForm />` with no props at all — a Server Component
 * cannot hand a Client Component a callback, so a successful save closes the
 * dialog itself and calls `router.refresh()`, which re-runs the page's own
 * `listInvoices` read and puts the new invoice straight into the ledger.
 *
 * ## The total on screen is not the total that gets charged
 *
 * `manualInvoiceCreateSchema` accepts an `expectedTotalCents` the caller
 * believes the invoice comes to, purely so the server can cross-check it —
 * this form never sends one. The figures under "Preview" are computed here
 * with the exact same `computeInvoiceTotals` function `createManualInvoice`
 * calls on the server, so the arithmetic agrees, but nothing about that
 * agreement is enforced by the wire: the server recomputes the total from the
 * line items and the discount it actually received and that recomputed figure
 * — never a number this component sends — is what is billed. The panel says
 * so, twice, because a number that merely *looks* authoritative is exactly the
 * kind of thing an operator learns to trust by habit.
 *
 * ## Per-line arithmetic
 *
 * `amountCents` and `sourceRefId` on each line are never rendered as fields —
 * the first is recomputed and cross-checked by the server from `quantity` and
 * `unitAmountCents`, and the second is a pointer this form has no value for.
 * Both stay entirely absent from what is submitted rather than being sent as
 * `undefined` placeholders.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useFieldArray, useForm } from 'react-hook-form'
import { Check, ChevronDown, Plus, Receipt, Trash2 } from 'lucide-react'

import {
  MAX_INVOICE_LINE_ITEMS,
  MAX_LINE_QUANTITY,
  computeInvoiceTotals,
  manualInvoiceCreateSchema,
  type InvoiceLineKind,
  type ManualInvoiceCreateInput,
  type ManualInvoiceCreateRawInput,
} from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { CheckboxField } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Money } from '@/components/ui/money'
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
import { Textarea } from '@/components/ui/textarea'
import { useAction, type DescribedActionFailure } from '@/lib/action-client'
import { cn, FOCUS_RING } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { createManualInvoice } from '@/server/actions/billing'
import { listUsers } from '@/server/actions/user'

// =============================================================================
// 1. Vocabulary
// =============================================================================

/** The fields this form reads off a search result. */
interface RecipientOption {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
}

const LINE_KIND_OPTIONS: ReadonlyArray<{ value: InvoiceLineKind; label: string }> =
  [
    { value: 'MENU_ITEM', label: 'Menu item' },
    { value: 'INGREDIENT_COST', label: 'Ingredient cost' },
    { value: 'TRAVEL', label: 'Travel' },
    { value: 'GRATUITY', label: 'Gratuity' },
    { value: 'TAX', label: 'Tax' },
    { value: 'DISCOUNT', label: 'Discount' },
    { value: 'APPOINTMENT', label: 'Appointment' },
    { value: 'SUBSCRIPTION', label: 'Subscription' },
    { value: 'OTHER', label: 'Other' },
  ]

/** A fresh, blank line. `amountCents` and `sourceRefId` are left off entirely
 *  — see the file docblock — rather than set to `undefined`. */
function blankLineItem(sortOrder: number): ManualInvoiceCreateRawInput['lineItems'][number] {
  return {
    kind: 'OTHER',
    description: '',
    quantity: 1,
    unitAmountCents: 0,
    taxCents: 0,
    sortOrder,
  }
}

const DEFAULT_VALUES: ManualInvoiceCreateRawInput = {
  userId: '',
  appointmentId: null,
  currency: 'CAD',
  lineItems: [blankLineItem(0)],
  discountCents: 0,
  description: null,
  memo: null,
  issueImmediately: false,
}

function recipientLabel(option: RecipientOption): string {
  if (option.name !== null && option.name.trim().length > 0) {
    return option.email === null ? option.name : `${option.name} — ${option.email}`
  }
  return option.email ?? option.id
}

// =============================================================================
// 2. Failure presentation — shared by both actions this form drives
// =============================================================================

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
// 3. Dollars ⇄ cents line-item input
// =============================================================================

interface CentsInputProps
  extends Omit<React.ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'type'> {
  readonly cents: number
  readonly onCentsChange: (cents: number) => void
}

/**
 * Displays and edits an amount in dollars, submits it in cents.
 *
 * `moneyCentsSchema` is `z.int()` — no coercion — so the value handed to
 * `onCentsChange` is already the integer the schema wants. A local text buffer
 * lets an admin type "12.5" without the field snapping to a rounded value
 * mid-keystroke; the buffer re-syncs from `cents` whenever it changes from
 * outside the input itself (a reset, a line removed above this one).
 */
const CentsInput = React.forwardRef<HTMLInputElement, CentsInputProps>(
  function CentsInput({ cents, onCentsChange, className, onBlur, ...rest }, ref) {
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
// 4. Recipient search
// =============================================================================

interface RecipientPickerProps {
  readonly value: string
  readonly selected: RecipientOption | null
  readonly onSelect: (option: RecipientOption) => void
  readonly disabled?: boolean
  readonly invalid?: boolean
}

/**
 * A search-as-you-type combobox over `listUsers`, biased to `CLIENT` accounts.
 *
 * Not itself an RHF field's whole story — the schema only carries `userId`, so
 * the chosen account's name and email live in `selected`, supplied by the
 * parent, purely so the trigger button can say who is about to be billed
 * rather than showing the raw id.
 */
function RecipientPicker({
  value,
  selected,
  onSelect,
  disabled = false,
  invalid = false,
}: RecipientPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const search = useAction(listUsers, { silent: true })

  React.useEffect(() => {
    if (!open) {
      return
    }

    const handle = setTimeout(() => {
      void search.execute({
        page: 1,
        pageSize: 8,
        roles: ['CLIENT'],
        activeOnly: true,
        sortBy: 'NAME',
        sortDirection: 'asc',
        search: query,
      })
    }, 250)

    return () => {
      clearTimeout(handle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, search.execute])

  const results = search.data?.items ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            invalid && 'border-claret/80'
          )}
        >
          <span className={cn('truncate text-left', value.length === 0 && 'text-stone')}>
            {selected === null
              ? value.length === 0
                ? 'Search clients by name or email…'
                : value
              : recipientLabel(selected)}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-stone" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search clients…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {search.isPending ? (
              <p className="px-3 py-4 text-center font-sans text-xs text-stone">
                Searching…
              </p>
            ) : (
              <>
                <CommandEmpty>No matching clients.</CommandEmpty>
                <CommandGroup>
                  {results.map((account) => {
                    const isSelected = account.id === value
                    return (
                      <CommandItem
                        key={account.id}
                        value={account.id}
                        onSelect={() => {
                          onSelect({
                            id: account.id,
                            name: account.name,
                            email: account.email,
                          })
                          setOpen(false)
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex size-4 items-center justify-center rounded-sm border border-ash',
                            isSelected && 'border-gold bg-champagne text-obsidian'
                          )}
                        >
                          {isSelected ? (
                            <Check className="size-3" strokeWidth={3} />
                          ) : null}
                        </span>
                        <span className="flex flex-col">
                          <span>{account.name ?? account.email ?? account.id}</span>
                          {account.name !== null && account.email !== null ? (
                            <span className="text-xs text-stone">{account.email}</span>
                          ) : null}
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// =============================================================================
// 5. The form
// =============================================================================

function CreateInvoiceForm({
  onCancel,
  onCreated,
}: {
  readonly onCancel: () => void
  readonly onCreated: () => void
}) {
  const form = useForm<ManualInvoiceCreateRawInput, unknown, ManualInvoiceCreateInput>({
    resolver: zodResolver(manualInvoiceCreateSchema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onBlur',
  })

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'lineItems',
  })

  const [selectedRecipient, setSelectedRecipient] =
    React.useState<RecipientOption | null>(null)

  const coreAction = useAction(createManualInvoice, {
    form,
    successMessage: (data) =>
      data.number === null
        ? 'Invoice saved as a draft.'
        : `Invoice ${data.number} created.`,
    onSuccess: () => {
      onCreated()
    },
  })

  const watchedLineItems = form.watch('lineItems')
  const watchedDiscountCents = form.watch('discountCents')
  const watchedCurrency = form.watch('currency')

  const preview = React.useMemo(() => {
    const safeLines = (watchedLineItems ?? []).map((line) => ({
      quantity: typeof line?.quantity === 'number' ? line.quantity : 1,
      unitAmountCents:
        typeof line?.unitAmountCents === 'number' ? line.unitAmountCents : 0,
      taxCents: typeof line?.taxCents === 'number' ? line.taxCents : 0,
    }))

    return computeInvoiceTotals({
      lineItems: safeLines,
      discountCents:
        typeof watchedDiscountCents === 'number' ? watchedDiscountCents : 0,
    })
  }, [watchedLineItems, watchedDiscountCents])

  const previewCurrency =
    typeof watchedCurrency === 'string' && watchedCurrency.length > 0
      ? watchedCurrency
      : 'CAD'

  function addLine() {
    if (fields.length >= MAX_INVOICE_LINE_ITEMS) {
      return
    }
    append(blankLineItem(fields.length))
  }

  function removeLine(index: number) {
    if (fields.length <= 1) {
      return
    }
    remove(index)
  }

  return (
    <Form {...form}>
      <form
        className="flex flex-1 flex-col gap-5 overflow-hidden"
        onSubmit={form.handleSubmit((values) => {
          const withRunningOrder: ManualInvoiceCreateInput = {
            ...values,
            lineItems: values.lineItems.map((line, index) => ({
              ...line,
              sortOrder: index,
            })),
          }
          void coreAction.execute(withRunningOrder)
        })}
        noValidate
      >
        <ScrollArea className="-mx-6 flex-1" viewportClassName="px-6 pb-1">
          <fieldset disabled={coreAction.isPending} className="contents">
            <legend className="sr-only">Invoice details</legend>
            <div className="flex flex-col gap-8">
              <section aria-labelledby="mi-recipient" className="flex flex-col gap-4">
                <h3
                  id="mi-recipient"
                  className="font-display text-base font-medium text-linen"
                >
                  Recipient
                </h3>

                <FormField
                  control={form.control}
                  name="userId"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel required>Client</FormLabel>
                      <FormControl>
                        <RecipientPicker
                          value={field.value}
                          selected={selectedRecipient}
                          disabled={coreAction.isPending}
                          invalid={fieldState.invalid}
                          onSelect={(option) => {
                            setSelectedRecipient(option)
                            field.onChange(option.id)
                          }}
                        />
                      </FormControl>
                      <FormDescription>
                        Search active clients by name or email. The invoice is
                        raised against this account.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="appointmentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Appointment ID (optional)</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Leave blank unless this settles a booked engagement"
                          value={field.value ?? ''}
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw.trim().length === 0 ? null : raw)
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormDescription>
                        Only needed when this invoice is settling a specific
                        booking rather than a bespoke, unbooked event.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </section>

              <Separator />

              <section aria-labelledby="mi-lines" className="flex flex-col gap-4">
                <div className="flex items-baseline justify-between gap-4">
                  <h3
                    id="mi-lines"
                    className="font-display text-base font-medium text-linen"
                  >
                    Line items
                  </h3>
                  <span className="font-sans text-xs text-stone">
                    {fields.length} of {MAX_INVOICE_LINE_ITEMS}
                  </span>
                </div>

                <FormField
                  control={form.control}
                  name="lineItems"
                  render={() => (
                    <FormItem>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex flex-col gap-4">
                  {fields.map((lineField, index) => {
                    const line = watchedLineItems?.[index]
                    const extendedCents =
                      typeof line?.quantity === 'number' &&
                      typeof line.unitAmountCents === 'number'
                        ? line.quantity * line.unitAmountCents
                        : 0

                    return (
                      <div
                        key={lineField.id}
                        className="flex flex-col gap-3 rounded-md border border-ash bg-charcoal/60 p-4"
                      >
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[7rem_1fr]">
                          <FormField
                            control={form.control}
                            name={`lineItems.${index}.kind`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Kind</FormLabel>
                                <Select
                                  value={field.value ?? 'OTHER'}
                                  onValueChange={field.onChange}
                                >
                                  <FormControl>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {LINE_KIND_OPTIONS.map((option) => (
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

                          <FormField
                            control={form.control}
                            name={`lineItems.${index}.description`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel required className="text-xs">
                                  Description
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder="Six-course tasting menu for eight"
                                    value={field.value ?? ''}
                                    onChange={(event) =>
                                      field.onChange(event.target.value)
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

                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <FormField
                            control={form.control}
                            name={`lineItems.${index}.quantity`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Qty</FormLabel>
                                <FormControl>
                                  <Input
                                    type="number"
                                    inputMode="numeric"
                                    numeric
                                    min={1}
                                    max={MAX_LINE_QUANTITY}
                                    step={1}
                                    value={field.value ?? 1}
                                    onChange={(event) => {
                                      const raw = event.target.value
                                      field.onChange(raw === '' ? 1 : Number(raw))
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
                            name={`lineItems.${index}.unitAmountCents`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel required className="text-xs">
                                  Unit price
                                </FormLabel>
                                <FormControl>
                                  <CentsInput
                                    name={field.name}
                                    cents={field.value ?? 0}
                                    onCentsChange={field.onChange}
                                    onBlur={field.onBlur}
                                    ref={field.ref}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name={`lineItems.${index}.taxCents`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Tax</FormLabel>
                                <FormControl>
                                  <CentsInput
                                    name={field.name}
                                    cents={field.value ?? 0}
                                    onCentsChange={field.onChange}
                                    onBlur={field.onBlur}
                                    ref={field.ref}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <div className="flex flex-col gap-2">
                            <span className="font-sans text-xs font-medium text-linen">
                              Extended
                            </span>
                            <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-ash bg-charcoal/40 px-3">
                              <Money
                                cents={extendedCents}
                                currency={previewCurrency}
                                tone="muted"
                              />
                              <button
                                type="button"
                                onClick={() => removeLine(index)}
                                disabled={fields.length <= 1 || coreAction.isPending}
                                className={cn(
                                  'rounded-sm p-1 text-stone transition-colors duration-150 ease-luxe hover:text-claret',
                                  'disabled:pointer-events-none disabled:opacity-40',
                                  FOCUS_RING
                                )}
                                aria-label={`Remove line ${String(index + 1)}`}
                              >
                                <Trash2 aria-hidden="true" className="size-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <Button
                  type="button"
                  variant="outline"
                  onClick={addLine}
                  disabled={fields.length >= MAX_INVOICE_LINE_ITEMS || coreAction.isPending}
                  className="self-start"
                >
                  <Plus aria-hidden="true" />
                  Add line
                </Button>
              </section>

              <Separator />

              <section aria-labelledby="mi-terms" className="flex flex-col gap-4">
                <h3
                  id="mi-terms"
                  className="font-display text-base font-medium text-linen"
                >
                  Terms
                </h3>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <FormField
                    control={form.control}
                    name="discountCents"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Discount</FormLabel>
                        <FormControl>
                          <CentsInput
                            name={field.name}
                            cents={field.value ?? 0}
                            onCentsChange={field.onChange}
                            onBlur={field.onBlur}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormDescription>Subtracted from the total.</FormDescription>
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
                            value={field.value ?? 'CAD'}
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

                  <FormField
                    control={form.control}
                    name="number"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Invoice number</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Auto-assigned"
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value
                              field.onChange(raw.trim().length === 0 ? undefined : raw)
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormDescription>
                          Leave blank to let the house numbering assign one.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="dueAt"
                  render={({ field }) => (
                    <FormItem className="sm:max-w-xs">
                      <FormLabel>Due date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          value={
                            typeof field.value === 'string' ? field.value : ''
                          }
                          onChange={(event) => {
                            const raw = event.target.value
                            field.onChange(raw.length === 0 ? undefined : raw)
                          }}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormDescription>
                        Leave blank to keep this invoice a draft with no due date
                        until it is reviewed.
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
                          rows={2}
                          placeholder="What the client sees on the invoice itself."
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
                  name="memo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Internal memo</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          placeholder="Visible to staff only — never to the client."
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
                  name="issueImmediately"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <CheckboxField
                          checked={field.value ?? false}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                          label="Send this invoice now"
                          description="Leave unchecked to keep it a draft until it has been reviewed."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </section>

              <Separator />

              <section
                aria-labelledby="mi-preview"
                className="flex flex-col gap-3 rounded-md border border-ash bg-charcoal/60 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3
                    id="mi-preview"
                    className="font-display text-base font-medium text-linen"
                  >
                    Preview
                  </h3>
                  <Badge variant="outline">Not the charge</Badge>
                </div>

                <dl className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <dt className="font-sans text-sm text-parchment">Subtotal</dt>
                    <dd>
                      <Money cents={preview.subtotalCents} currency={previewCurrency} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="font-sans text-sm text-parchment">Tax</dt>
                    <dd>
                      <Money cents={preview.taxCents} currency={previewCurrency} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="font-sans text-sm text-parchment">Discount</dt>
                    <dd>
                      <Money
                        cents={preview.discountCents}
                        currency={previewCurrency}
                        signed
                        colorBySign
                      />
                    </dd>
                  </div>
                  <Separator className="my-1" />
                  <div className="flex items-center justify-between">
                    <dt className="font-sans text-sm font-medium text-linen">
                      Estimated total
                    </dt>
                    <dd>
                      <Money
                        cents={preview.amountDueCents}
                        currency={previewCurrency}
                        weight="semibold"
                        tone="accent"
                      />
                    </dd>
                  </div>
                </dl>

                <p className="font-sans text-xs leading-relaxed text-stone">
                  This preview is calculated here, on your screen, for reference
                  only. It is <strong className="text-parchment">not</strong> sent
                  to the server — MannaChef recalculates the amount due from the
                  line items and discount above the moment this invoice is
                  created, and that recalculated figure, not this one, is what
                  gets billed.
                </p>
              </section>
            </div>
          </fieldset>
        </ScrollArea>

        <div className="flex flex-col gap-3">
          <FormRootError />
          {coreAction.failure === null ? null : (
            <ActionFailureNotice failure={coreAction.failure} />
          )}
          <FormStatus>{coreAction.statusMessage}</FormStatus>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={coreAction.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="champagne"
            loading={coreAction.isPending}
            loadingLabel="Creating invoice…"
          >
            Create invoice
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

// =============================================================================
// 6. The trigger + dialog
// =============================================================================

/**
 * The button, the dialog, and everything inside it.
 *
 * Renders directly on `app/(admin)/admin/invoices/page.tsx` with no props —
 * see the file docblock for why. Unmounting the whole form on close (rather
 * than merely hiding it) is deliberate: reopening always starts from a blank
 * invoice instead of resuming whatever an operator abandoned last time.
 */
export function ManualInvoiceForm(): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  // Bumped on every open, so a freshly-opened dialog always starts from a
  // blank invoice. Keyed on the form itself rather than gated behind
  // `{open && …}` so Radix's close animation fades the form's last state out
  // instead of a blank panel — `<DialogContent>` already stays mounted for the
  // duration of that animation and unmounts its children once it completes.
  const [instance, setInstance] = React.useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setInstance((current) => current + 1)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="champagne">
          <Receipt aria-hidden="true" />
          New manual invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-4rem)] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>New manual invoice</DialogTitle>
          <DialogDescription>
            For a bespoke culinary event billed outside the subscription
            engine — a private dinner, a tasting, a one-off booking.
          </DialogDescription>
        </DialogHeader>
        <CreateInvoiceForm
          key={instance}
          onCancel={() => {
            setOpen(false)
          }}
          onCreated={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
