// mannachef/apps/web/src/components/admin/billing/plan-editor.tsx
'use client'

/**
 * The plan ladder — create, amend and retire the `SubscriptionPlan` rows
 * guests subscribe to, from a table handed down by a Server Component
 * ancestor (`/admin/subscriptions`).
 *
 * ## What lives here versus what lives in Stripe
 *
 * A plan's `stripePriceId` / `stripeProductId` name the real Stripe objects
 * that actually determine what a card gets charged — `createSubscriptionPlan`
 * and `updateSubscriptionPlan` retrieve the named price and refuse to save a
 * plan whose amount, currency or cadence disagrees with it. Because of that,
 * this editor treats the two fields asymmetrically:
 *
 *  - **Creating** a plan asks for them as plain text, pasted from the Stripe
 *    dashboard — a plan cannot exist without a real price behind it.
 *  - **Editing** a plan shows them as read-only text in a "Mirrored from
 *    Stripe" panel and never submits them at all. Reassigning a price on a
 *    live plan is a Stripe migration, not a form field — Stripe prices are
 *    themselves immutable amounts, so the house convention is to retire a
 *    plan and create its replacement rather than repoint an existing one.
 *
 * ## One Save button, two schemas
 *
 * `subscriptionPlanCreateSchema` and `subscriptionPlanUpdateSchema` come
 * straight from `@mannachef/validators`; nothing about a plan's shape is
 * restated here. `createSubscriptionPlan` / `updateSubscriptionPlan` /
 * `deleteSubscriptionPlan` are called directly — this is the client
 * component the CONTRACT means when it says a client component may import
 * and call a Server Action.
 */

import * as React from 'react'
import {
  BadgeCheck,
  Layers,
  Pencil,
  Plus,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import { useForm } from 'react-hook-form'

import {
  MAX_INTERVAL_COUNT,
  MAX_MEALS_PER_WEEK,
  MAX_PLAN_FEATURES,
  MAX_SERVINGS_PER_MEAL,
  MAX_SORT_ORDER,
  MAX_TRIAL_DAYS,
  subscriptionPlanCreateSchema,
  subscriptionPlanUpdateSchema,
  type BillingInterval,
  type SubscriptionPlanCreateInput,
  type SubscriptionPlanCreateRawInput,
  type SubscriptionPlanUpdateInput,
  type SubscriptionPlanUpdateRawInput,
} from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckboxField } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateTime } from '@/components/ui/date-time'
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
import { Money } from '@/components/ui/money'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { SwitchField } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useAction, type DescribedActionFailure } from '@/lib/action-client'
import { cn, FOCUS_RING } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import {
  createSubscriptionPlan,
  deleteSubscriptionPlan,
  updateSubscriptionPlan,
} from '@/server/actions/billing'

// =============================================================================
// Public shape
// =============================================================================

/**
 * One rung of the plan ladder, flattened for this editor.
 *
 * Mirrors the fields of `SubscriptionPlanView` that this screen touches — a
 * local restatement rather than an import of that interface, because
 * `SubscriptionPlanView` is declared inside the `'use server'` action module
 * and this component may only reach it through a plain, server-authored prop.
 * `stripePriceId`, `stripeProductId`, `subscriptionCount` and `updatedAt` come
 * from `SubscriptionPlanAdminDetailView.admin`, which is `null` for any caller
 * below `ADMIN` — this whole screen is `ADMIN`-gated, so a `null` here means
 * the read genuinely came back without the admin projection, and every field
 * below renders a dash rather than assuming a value that isn't there.
 */
export interface PlanLadderRow {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly tagline: string | null
  readonly description: string | null
  readonly interval: BillingInterval
  readonly intervalCount: number
  readonly priceCents: number
  readonly currency: string
  readonly setupFeeCents: number | null
  readonly trialDays: number | null
  readonly mealsPerWeek: number
  readonly servingsPerMeal: number
  readonly features: readonly string[]
  readonly isActive: boolean
  readonly isFeatured: boolean
  readonly sortOrder: number
  readonly stripePriceId: string | null
  readonly stripeProductId: string | null
  readonly subscriptionCount: number | null
  readonly updatedAt: Date | null
}

export interface PlanEditorProps {
  readonly plans: readonly PlanLadderRow[]
}

// =============================================================================
// Shared constants
// =============================================================================

const INTERVAL_OPTIONS: ReadonlyArray<{
  value: BillingInterval
  label: string
}> = [
  { value: 'DAY', label: 'Day' },
  { value: 'WEEK', label: 'Week' },
  { value: 'MONTH', label: 'Month' },
  { value: 'QUARTER', label: 'Quarter' },
  { value: 'YEAR', label: 'Year' },
]

/** Every field path either mutation schema can produce a `fieldErrors` entry for. */
const PLAN_FIELD_PATHS = [
  'slug',
  'name',
  'tagline',
  'description',
  'stripePriceId',
  'stripeProductId',
  'interval',
  'intervalCount',
  'priceCents',
  'currency',
  'setupFeeCents',
  'trialDays',
  'mealsPerWeek',
  'servingsPerMeal',
  'features',
  'isActive',
  'isFeatured',
  'sortOrder',
] as const

const CREATE_DEFAULT_VALUES: SubscriptionPlanCreateRawInput = {
  slug: '',
  name: '',
  tagline: null,
  description: null,
  stripePriceId: '',
  stripeProductId: '',
  interval: 'MONTH',
  intervalCount: 1,
  priceCents: 0,
  currency: 'CAD',
  setupFeeCents: null,
  trialDays: null,
  mealsPerWeek: 5,
  servingsPerMeal: 1,
  features: [],
  isActive: true,
  isFeatured: false,
  sortOrder: 0,
}

function editDefaultValues(
  plan: PlanLadderRow
): SubscriptionPlanUpdateRawInput {
  return {
    id: plan.id,
    slug: plan.slug,
    name: plan.name,
    tagline: plan.tagline,
    description: plan.description,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    priceCents: plan.priceCents,
    currency: plan.currency,
    setupFeeCents: plan.setupFeeCents,
    trialDays: plan.trialDays,
    mealsPerWeek: plan.mealsPerWeek,
    servingsPerMeal: plan.servingsPerMeal,
    features: [...plan.features],
    isActive: plan.isActive,
    isFeatured: plan.isFeatured,
    sortOrder: plan.sortOrder,
    // stripePriceId / stripeProductId deliberately omitted — see file docblock.
  }
}

function formatCadence(
  interval: BillingInterval,
  intervalCount: number
): string {
  const unit =
    INTERVAL_OPTIONS.find((option) => option.value === interval)?.label ??
    interval
  if (intervalCount === 1) {
    return `Every ${unit.toLowerCase()}`
  }
  return `Every ${String(intervalCount)} ${unit.toLowerCase()}s`
}

/** Shortens a Stripe identifier for a table cell while keeping the full value in `title`. */
function shortStripeId(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`
}

// =============================================================================
// Shared failure notice
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
      <p className="font-sans text-sm font-semibold text-linen">
        {failure.title}
      </p>
      <p className="mt-1 font-sans text-sm leading-relaxed text-parchment">
        {failure.description}
      </p>
    </div>
  )
}

// =============================================================================
// Cents ⇄ dollars input (required amount)
// =============================================================================

interface DollarsInputProps extends Omit<
  React.ComponentPropsWithoutRef<'input'>,
  'value' | 'onChange' | 'type'
> {
  readonly cents: number
  readonly onCentsChange: (cents: number) => void
}

/**
 * Displays and edits an amount in dollars, submits it in cents.
 *
 * `moneyCentsSchema` is `z.int()` — no coercion — so this must always hand
 * `field.onChange` an integer. A local text buffer lets the operator type
 * "42.5" without the field snapping to a rounded value mid-keystroke.
 */
const DollarsInput = React.forwardRef<HTMLInputElement, DollarsInputProps>(
  function DollarsInput(
    { cents, onCentsChange, className, onBlur, ...rest },
    ref
  ) {
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
// Features — freeform inclusion list
// =============================================================================

interface FeaturesEditorProps {
  readonly id: string
  readonly value: readonly string[]
  readonly onChange: (features: string[]) => void
  readonly disabled?: boolean
}

const MAX_FEATURE_ENTRY_LENGTH = 160

function FeaturesEditor({
  id,
  value,
  onChange,
  disabled = false,
}: FeaturesEditorProps) {
  const [draft, setDraft] = React.useState('')

  function addFeature() {
    const trimmed = draft.trim()
    if (trimmed.length < 2) {
      return
    }
    if (
      value.some((feature) => feature.toLowerCase() === trimmed.toLowerCase())
    ) {
      setDraft('')
      return
    }
    if (value.length >= MAX_PLAN_FEATURES) {
      return
    }
    onChange([...value, trimmed])
    setDraft('')
  }

  function removeFeature(feature: string) {
    onChange(value.filter((entry) => entry !== feature))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          disabled={disabled || value.length >= MAX_PLAN_FEATURES}
          maxLength={MAX_FEATURE_ENTRY_LENGTH}
          placeholder="Chef's tasting menu, twice weekly"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addFeature()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={
            disabled ||
            draft.trim().length < 2 ||
            value.length >= MAX_PLAN_FEATURES
          }
          onClick={addFeature}
        >
          Add
        </Button>
      </div>
      <p className="font-sans text-xs leading-relaxed text-stone">
        {value.length} of {MAX_PLAN_FEATURES} inclusions listed.
      </p>
      {value.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Plan inclusions">
          {value.map((feature) => (
            <li key={feature}>
              <Badge variant="outline" className="gap-1 py-1 pr-1 pl-2">
                {feature}
                <button
                  type="button"
                  onClick={() => removeFeature(feature)}
                  disabled={disabled}
                  className={cn(
                    'rounded-sm p-0.5 text-stone transition-colors duration-150 ease-luxe hover:text-linen',
                    'disabled:pointer-events-none disabled:opacity-50',
                    FOCUS_RING
                  )}
                  aria-label={`Remove ${feature} from this plan`}
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
// Stripe read-only panel — shown only while editing
// =============================================================================

function StripeSyncPanel({ plan }: { readonly plan: PlanLadderRow }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-gold/40 bg-champagne/6 p-4">
      <div className="flex items-center gap-2">
        <BadgeCheck aria-hidden="true" className="size-4 text-champagne" />
        <p className="font-sans text-sm font-semibold text-linen">
          Mirrored from Stripe
        </p>
      </div>
      <p className="font-sans text-xs leading-relaxed text-stone">
        These identifiers point at the real price and product already created in
        the Stripe dashboard. They are not editable here — a price is immutable
        on Stripe's side, so a change in amount belongs to a new plan, not this
        one.
      </p>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <dt className="font-sans text-xs tracking-wide text-stone uppercase">
            Stripe price
          </dt>
          <dd
            className="mt-0.5 font-sans text-sm text-parchment"
            title={plan.stripePriceId ?? undefined}
          >
            <code className="font-sans">{plan.stripePriceId ?? '—'}</code>
          </dd>
        </div>
        <div>
          <dt className="font-sans text-xs tracking-wide text-stone uppercase">
            Stripe product
          </dt>
          <dd
            className="mt-0.5 font-sans text-sm text-parchment"
            title={plan.stripeProductId ?? undefined}
          >
            <code className="font-sans">{plan.stripeProductId ?? '—'}</code>
          </dd>
        </div>
        <div>
          <dt className="font-sans text-xs tracking-wide text-stone uppercase">
            Linked subscriptions
          </dt>
          <dd className="mt-0.5 font-sans text-sm text-parchment tabular-nums">
            {plan.subscriptionCount ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="font-sans text-xs tracking-wide text-stone uppercase">
            Last synced
          </dt>
          <dd className="mt-0.5 font-sans text-sm text-parchment">
            <DateTime value={plan.updatedAt} format="relative" tone="muted" />
          </dd>
        </div>
      </dl>
    </div>
  )
}

// =============================================================================
// Create form
// =============================================================================

interface PlanFormPanelProps {
  readonly onClose: () => void
  readonly onSaved: (saved: { id: string; name: string }) => void
}

function CreatePlanForm({ onClose, onSaved }: PlanFormPanelProps) {
  const form = useForm<
    SubscriptionPlanCreateRawInput,
    unknown,
    SubscriptionPlanCreateInput
  >({
    resolver: zodResolver(subscriptionPlanCreateSchema),
    defaultValues: CREATE_DEFAULT_VALUES,
    mode: 'onBlur',
  })

  const action = useAction(createSubscriptionPlan, {
    form,
    knownFieldPaths: PLAN_FIELD_PATHS,
    successMessage: (data) => `${data.name} joined the ladder.`,
    onSuccess: (data) => {
      onSaved({ id: data.id, name: data.name })
      onClose()
    },
  })

  const trialDays = form.watch('trialDays')
  const setupFeeCents = form.watch('setupFeeCents')
  const features = form.watch('features') ?? []
  const pending = action.isPending

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-6"
        onSubmit={form.handleSubmit((values) => {
          void action.execute(values)
        })}
        noValidate
      >
        <fieldset disabled={pending} className="contents">
          <legend className="sr-only">New plan details</legend>

          <section
            aria-labelledby="plan-create-identity"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-create-identity"
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
                    <Input placeholder="The Tasting Table" {...field} />
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
                    <Input placeholder="the-tasting-table" {...field} />
                  </FormControl>
                  <FormDescription>
                    Lowercase letters, numbers and single hyphens — this becomes
                    part of the plan's public web address.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="tagline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tagline</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Five courses, delivered weekly"
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
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-create-stripe"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-create-stripe"
              className="font-display text-base font-medium text-linen"
            >
              Stripe connection
            </h3>
            <p className="font-sans text-xs leading-relaxed text-stone">
              Paste the identifiers of a price and product already created in
              the Stripe dashboard. The house refuses to save a plan whose
              amount, currency or cadence disagrees with the price named here.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="stripePriceId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Stripe price ID</FormLabel>
                    <FormControl>
                      <Input placeholder="price_1PabcdEFGHijklMN" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="stripeProductId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Stripe product ID</FormLabel>
                    <FormControl>
                      <Input placeholder="prod_QabcdEFGHijkl" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-create-pricing"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-create-pricing"
              className="font-display text-base font-medium text-linen"
            >
              Pricing &amp; cadence
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="priceCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Price</FormLabel>
                    <FormControl>
                      <DollarsInput
                        name={field.name}
                        cents={field.value}
                        onCentsChange={field.onChange}
                        onBlur={field.onBlur}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      Shown to guests in dollars; stored as cents. Must match
                      the Stripe price above.
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
              <FormField
                control={form.control}
                name="interval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Renews every</FormLabel>
                    <Select
                      value={field.value ?? 'MONTH'}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a cadence" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {INTERVAL_OPTIONS.map((option) => (
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
                name="intervalCount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Interval count</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_INTERVAL_COUNT}
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
                    <FormDescription>
                      1 renews every interval; 3 with "Month" renews quarterly.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <SwitchField
              label="One-time setup fee"
              description="Charged once, alongside the first invoice."
              checked={setupFeeCents !== null && setupFeeCents !== undefined}
              onCheckedChange={(checked) =>
                form.setValue('setupFeeCents', checked ? 0 : null, {
                  shouldDirty: true,
                })
              }
            />
            {setupFeeCents !== null && setupFeeCents !== undefined ? (
              <FormField
                control={form.control}
                name="setupFeeCents"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel>Setup fee</FormLabel>
                    <FormControl>
                      <DollarsInput
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
            ) : null}

            <SwitchField
              label="Offer a free trial"
              description="Delays the first charge by a number of days."
              checked={trialDays !== null && trialDays !== undefined}
              onCheckedChange={(checked) =>
                form.setValue('trialDays', checked ? 7 : null, {
                  shouldDirty: true,
                })
              }
            />
            {trialDays !== null && trialDays !== undefined ? (
              <FormField
                control={form.control}
                name="trialDays"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel>Trial length (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_TRIAL_DAYS}
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
            ) : null}
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-create-serving"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-create-serving"
              className="font-display text-base font-medium text-linen"
            >
              What's included
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="mealsPerWeek"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Meals per week</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_MEALS_PER_WEEK}
                        step={1}
                        value={field.value}
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
                name="servingsPerMeal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Servings per meal</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_SERVINGS_PER_MEAL}
                        step={1}
                        value={field.value}
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
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="plan-create-features">Inclusions</Label>
              <FeaturesEditor
                id="plan-create-features"
                value={features}
                onChange={(next) =>
                  form.setValue('features', next, { shouldDirty: true })
                }
                disabled={pending}
              />
            </div>
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-create-flags"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-create-flags"
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
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                      label="Open for enrolment"
                      description="Guests can subscribe to this plan once it is published."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isFeatured"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <CheckboxField
                      checked={field.value ?? false}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                      label="Lead the collection"
                      description="Featured ahead of the rest of the ladder."
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
                      max={MAX_SORT_ORDER}
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
                    Lower numbers sit first on the ladder.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>
        </fieldset>

        <div className="flex flex-col gap-3">
          <FormRootError />
          {action.failure === null ? null : (
            <ActionFailureNotice failure={action.failure} />
          )}
          <FormStatus>{action.statusMessage}</FormStatus>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="champagne"
            loading={pending}
            loadingLabel="Adding plan…"
          >
            Add plan
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

// =============================================================================
// Edit form
// =============================================================================

interface EditPlanFormProps extends PlanFormPanelProps {
  readonly plan: PlanLadderRow
}

function EditPlanForm({ plan, onClose, onSaved }: EditPlanFormProps) {
  const form = useForm<
    SubscriptionPlanUpdateRawInput,
    unknown,
    SubscriptionPlanUpdateInput
  >({
    resolver: zodResolver(subscriptionPlanUpdateSchema),
    defaultValues: editDefaultValues(plan),
    mode: 'onBlur',
  })

  const action = useAction(updateSubscriptionPlan, {
    form,
    knownFieldPaths: [...PLAN_FIELD_PATHS, 'id'],
    successMessage: (data) => `${data.name} has been updated.`,
    onSuccess: (data) => {
      onSaved({ id: data.id, name: data.name })
      onClose()
    },
  })

  const trialDays = form.watch('trialDays') ?? plan.trialDays
  const setupFeeCents = form.watch('setupFeeCents') ?? plan.setupFeeCents
  const features = form.watch('features') ?? plan.features
  const pending = action.isPending

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-6"
        onSubmit={form.handleSubmit((values) => {
          void action.execute(values)
        })}
        noValidate
      >
        <StripeSyncPanel plan={plan} />

        <fieldset disabled={pending} className="contents">
          <legend className="sr-only">Plan details</legend>

          <section
            aria-labelledby="plan-edit-identity"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-edit-identity"
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
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(event.target.value)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormDescription>
                    Changing this updates the plan's public web address.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="tagline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tagline</FormLabel>
                  <FormControl>
                    <Input
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
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-edit-pricing"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-edit-pricing"
              className="font-display text-base font-medium text-linen"
            >
              Pricing &amp; cadence
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="priceCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Price</FormLabel>
                    <FormControl>
                      <DollarsInput
                        name={field.name}
                        cents={field.value ?? plan.priceCents}
                        onCentsChange={field.onChange}
                        onBlur={field.onBlur}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      Must keep matching the Stripe price above.
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
                        value={field.value ?? plan.currency}
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
                name="interval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Renews every</FormLabel>
                    <Select
                      value={field.value ?? plan.interval}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a cadence" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {INTERVAL_OPTIONS.map((option) => (
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
                name="intervalCount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Interval count</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_INTERVAL_COUNT}
                        step={1}
                        value={field.value ?? plan.intervalCount}
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
            </div>

            <SwitchField
              label="One-time setup fee"
              description="Charged once, alongside the first invoice."
              checked={setupFeeCents !== null && setupFeeCents !== undefined}
              onCheckedChange={(checked) =>
                form.setValue('setupFeeCents', checked ? 0 : null, {
                  shouldDirty: true,
                })
              }
            />
            {setupFeeCents !== null && setupFeeCents !== undefined ? (
              <FormField
                control={form.control}
                name="setupFeeCents"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel>Setup fee</FormLabel>
                    <FormControl>
                      <DollarsInput
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
            ) : null}

            <SwitchField
              label="Offer a free trial"
              description="Delays the first charge by a number of days."
              checked={trialDays !== null && trialDays !== undefined}
              onCheckedChange={(checked) =>
                form.setValue('trialDays', checked ? 7 : null, {
                  shouldDirty: true,
                })
              }
            />
            {trialDays !== null && trialDays !== undefined ? (
              <FormField
                control={form.control}
                name="trialDays"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel>Trial length (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_TRIAL_DAYS}
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
            ) : null}
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-edit-serving"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-edit-serving"
              className="font-display text-base font-medium text-linen"
            >
              What's included
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="mealsPerWeek"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Meals per week</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_MEALS_PER_WEEK}
                        step={1}
                        value={field.value ?? plan.mealsPerWeek}
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
                name="servingsPerMeal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Servings per meal</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        numeric
                        min={1}
                        max={MAX_SERVINGS_PER_MEAL}
                        step={1}
                        value={field.value ?? plan.servingsPerMeal}
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
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="plan-edit-features">Inclusions</Label>
              <FeaturesEditor
                id="plan-edit-features"
                value={features}
                onChange={(next) =>
                  form.setValue('features', next, { shouldDirty: true })
                }
                disabled={pending}
              />
            </div>
          </section>

          <Separator className="my-6" />

          <section
            aria-labelledby="plan-edit-flags"
            className="flex flex-col gap-4"
          >
            <h3
              id="plan-edit-flags"
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
                      checked={field.value ?? plan.isActive}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                      label="Open for enrolment"
                      description="Guests can subscribe to this plan once it is published."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isFeatured"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <CheckboxField
                      checked={field.value ?? plan.isFeatured}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                      label="Lead the collection"
                      description="Featured ahead of the rest of the ladder."
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
                      max={MAX_SORT_ORDER}
                      step={1}
                      value={field.value ?? plan.sortOrder}
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
                    Lower numbers sit first on the ladder.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>
        </fieldset>

        <div className="flex flex-col gap-3">
          <FormRootError />
          {action.failure === null ? null : (
            <ActionFailureNotice failure={action.failure} />
          )}
          <FormStatus>{action.statusMessage}</FormStatus>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="champagne"
            loading={pending}
            loadingLabel="Saving…"
          >
            Save changes
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

// =============================================================================
// Create / edit dialog
// =============================================================================

interface PlanFormDialogProps {
  readonly open: boolean
  readonly plan: PlanLadderRow | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSaved: (saved: { id: string; name: string }) => void
}

function PlanFormDialog({
  open,
  plan,
  onOpenChange,
  onSaved,
}: PlanFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {plan === null ? 'New plan' : `Edit ${plan.name}`}
          </DialogTitle>
          <DialogDescription>
            {plan === null
              ? 'Add a rung to the ladder. It needs a real Stripe price and product already created — paste their identifiers below.'
              : 'Amend what guests see and what the house charges. The Stripe connection itself is fixed once a plan exists.'}
          </DialogDescription>
        </DialogHeader>
        {plan === null ? (
          <CreatePlanForm
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : (
          <EditPlanForm
            key={plan.id}
            plan={plan}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// Delete confirmation
// =============================================================================

interface DeletePlanDialogProps {
  readonly plan: PlanLadderRow | null
  readonly onOpenChange: (open: boolean) => void
  readonly onDeleted: (deleted: { id: string; name: string }) => void
  readonly onClosedInstead: (closed: { id: string; name: string }) => void
}

function DeletePlanDialog({
  plan,
  onOpenChange,
  onDeleted,
  onClosedInstead,
}: DeletePlanDialogProps) {
  const deleteAction = useAction(deleteSubscriptionPlan, {
    successMessage: (data) => `${data.name} was removed from the ladder.`,
    onSuccess: (data) => {
      onDeleted({ id: data.id, name: data.name })
      onOpenChange(false)
    },
  })

  const closeAction = useAction(updateSubscriptionPlan, {
    successMessage: (data) => `${data.name} is now closed to enrolment.`,
    onSuccess: (data) => {
      onClosedInstead({ id: data.id, name: data.name })
      onOpenChange(false)
    },
  })

  const pending = deleteAction.isPending || closeAction.isPending
  const hasSubscribers = (plan?.subscriptionCount ?? 0) > 0

  return (
    <Dialog
      open={plan !== null}
      onOpenChange={(next) => {
        if (!pending) {
          onOpenChange(next)
        }
      }}
    >
      {plan === null ? null : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {plan.name}?</DialogTitle>
            <DialogDescription>
              This takes the plan off the ladder entirely. It cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {hasSubscribers ? (
            <div className="flex flex-col gap-2 rounded-md border border-terracotta/50 bg-terracotta/12 px-3 py-2">
              <p className="font-sans text-sm font-semibold text-linen">
                {plan.subscriptionCount}{' '}
                {plan.subscriptionCount === 1
                  ? 'subscription references'
                  : 'subscriptions reference'}{' '}
                this plan.
              </p>
              <p className="font-sans text-sm leading-relaxed text-parchment">
                The house will refuse the removal while that's true. Closing it
                to enrolment keeps every past invoice legible instead.
              </p>
            </div>
          ) : null}

          {deleteAction.failure === null ? null : (
            <ActionFailureNotice failure={deleteAction.failure} />
          )}
          {closeAction.failure === null ? null : (
            <ActionFailureNotice failure={closeAction.failure} />
          )}
          <FormStatus>{deleteAction.statusMessage}</FormStatus>
          <FormStatus>{closeAction.statusMessage}</FormStatus>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {hasSubscribers ? (
              <Button
                type="button"
                variant="outline"
                loading={closeAction.isPending}
                loadingLabel="Closing…"
                disabled={pending}
                onClick={() =>
                  void closeAction.execute({ id: plan.id, isActive: false })
                }
              >
                <ShieldOff aria-hidden="true" />
                Close to enrolment instead
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              loading={deleteAction.isPending}
              loadingLabel="Removing…"
              disabled={pending}
              onClick={() => void deleteAction.execute({ id: plan.id })}
            >
              <Trash2 aria-hidden="true" />
              Remove plan
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

// =============================================================================
// The ladder table + entry point
// =============================================================================

/**
 * The full interactive surface of the plan ladder: the table, the "New plan"
 * trigger, and the create/edit/delete dialogs behind it.
 *
 * `plans` is read by a Server Component ancestor and handed down as a plain
 * prop — this component holds no data-fetching of its own, per CONTRACT.md's
 * "Server Components by default".
 */
export function PlanEditor({ plans }: PlanEditorProps) {
  const [dialogState, setDialogState] = React.useState<
    | { readonly mode: 'create' }
    | { readonly mode: 'edit'; readonly plan: PlanLadderRow }
    | null
  >(null)
  const [deleteTarget, setDeleteTarget] = React.useState<PlanLadderRow | null>(
    null
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-sans text-sm text-parchment">
          {plans.length === 0
            ? 'No plans yet.'
            : `${String(plans.length)} plan${plans.length === 1 ? '' : 's'} on the ladder.`}
        </p>
        <Button
          variant="champagne"
          onClick={() => setDialogState({ mode: 'create' })}
        >
          <Plus aria-hidden="true" />
          New plan
        </Button>
      </div>

      {plans.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="The ladder is empty"
          description="Add the first plan guests will be able to subscribe to — it needs a real Stripe price and product behind it."
          action={
            <Button
              variant="champagne"
              onClick={() => setDialogState({ mode: 'create' })}
            >
              <Plus aria-hidden="true" />
              New plan
            </Button>
          }
        />
      ) : (
        <Table>
          <TableCaption>
            The house plan ladder, priced and staged for enrolment.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Cadence</TableHead>
              <TableHead numeric>Price</TableHead>
              <TableHead>Trial</TableHead>
              <TableHead numeric>Subscriptions</TableHead>
              <TableHead>Stripe</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-sans text-sm font-medium text-linen">
                        {plan.name}
                      </span>
                      {plan.isFeatured ? (
                        <Badge variant="champagne">Featured</Badge>
                      ) : null}
                      {plan.isActive ? null : (
                        <Badge variant="muted">Closed</Badge>
                      )}
                    </div>
                    <code className="font-sans text-xs text-stone">
                      {plan.slug}
                    </code>
                    <span className="font-sans text-xs text-stone">
                      {plan.mealsPerWeek}/wk · {plan.servingsPerMeal}{' '}
                      {plan.servingsPerMeal === 1 ? 'serving' : 'servings'}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {formatCadence(plan.interval, plan.intervalCount)}
                </TableCell>
                <TableCell numeric>
                  <div className="flex flex-col items-end gap-0.5">
                    <Money
                      cents={plan.priceCents}
                      currency={plan.currency}
                      weight="medium"
                    />
                    {plan.setupFeeCents === null ||
                    plan.setupFeeCents === 0 ? null : (
                      <span className="font-sans text-xs text-stone">
                        +
                        <Money
                          cents={plan.setupFeeCents}
                          currency={plan.currency}
                          tone="subtle"
                        />{' '}
                        setup
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {plan.trialDays === null ? (
                    <span className="text-stone">—</span>
                  ) : (
                    `${String(plan.trialDays)}-day trial`
                  )}
                </TableCell>
                <TableCell numeric>{plan.subscriptionCount ?? '—'}</TableCell>
                <TableCell>
                  {plan.stripePriceId === null ? (
                    <span className="text-stone">—</span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <Badge variant="outline" className="w-fit">
                        <BadgeCheck aria-hidden="true" />
                        Synced
                      </Badge>
                      <code
                        className="font-sans text-xs text-stone"
                        title={plan.stripePriceId}
                      >
                        {shortStripeId(plan.stripePriceId)}
                      </code>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setDialogState({ mode: 'edit', plan })}
                      aria-label={`Edit ${plan.name}`}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-claret-ink hover:text-claret-ink"
                      onClick={() => setDeleteTarget(plan)}
                      aria-label={`Remove ${plan.name}`}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <PlanFormDialog
        open={dialogState !== null}
        plan={dialogState?.mode === 'edit' ? dialogState.plan : null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogState(null)
          }
        }}
        onSaved={() => setDialogState(null)}
      />

      <DeletePlanDialog
        plan={deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
        onDeleted={() => setDeleteTarget(null)}
        onClosedInstead={() => setDeleteTarget(null)}
      />
    </div>
  )
}
