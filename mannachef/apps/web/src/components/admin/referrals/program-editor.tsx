// mannachef/apps/web/src/components/admin/referrals/program-editor.tsx
'use client'

/**
 * The interactive surface of the Referral Engine admin — everything on
 * `/admin/referrals` that moves money or changes state.
 *
 * Three concerns share this file because they share a rule: each one either
 * *is* a `SUPER_ADMIN`-gated lever, or sits directly beside one and needs the
 * same gate explained the same way (`CONTRACT.md`'s instruction to explain a
 * gate rather than hide it silently for an `ADMIN`).
 *
 *  - {@link ProgramEditor} — the standing offer. What a referral is worth is
 *    decided here, once, for the whole platform; a code only ever copies these
 *    figures (see the file docblock on `@mannachef/validators`'s
 *    `referralProgramUpsertSchema`). `canEdit` gates the form; an `ADMIN`
 *    still sees every figure, just not a way to change them.
 *  - {@link RedemptionActions} — the lifecycle buttons on one payout-queue row.
 *    `QUALIFY` and `EXPIRE` are plain `ADMIN` moves. `REWARD` and a `REVOKE`
 *    that claws back paid credit both move money, and `updateReferralRedemption`
 *    itself refuses them below `SUPER_ADMIN` — `isSuperAdmin` here only decides
 *    whether the button is disabled-with-an-explanation or live; the server
 *    would refuse it either way.
 *  - {@link BalanceTools} — reconciling and hand-adjusting one household's
 *    balance. Recomputing is `ADMIN`; writing a manual ledger entry is
 *    `SUPER_ADMIN` for the same reason `REWARD` is — it can put credit on a
 *    balance with no earned referral behind it.
 *
 * ## How the strict/union schemas below get a `zodResolver`
 *
 * `referralProgramUpsertSchema` and `rewardAdjustmentSchema` are, respectively,
 * a discriminated union and a schema with five `reason`-keyed cross-field
 * rules, and every branch involved is `.strict()`. A flat RHF value bag
 * naturally holds keys from every branch at once (both `rewardValueCents` and
 * `rewardValuePercent`, say, or a `revokedReason`-shaped bag missing the
 * `action`/`redemptionId`/`userId` a command schema requires) — a `.strict()`
 * schema rejects the former on sight and the latter for want of a required
 * key. So none of the three forms below hands its schema straight to
 * `zodResolver`. Each instead runs its existing "build the exact payload"
 * function (`buildProgramPayload`, `buildRevokePayload`,
 * `buildAdjustmentPayload` — the same functions `execute()` uses) as a
 * `z.transform()` in front of the real schema via `.pipe()`, the same
 * shape-then-validate idiom `availability-editor.tsx` uses for its own
 * strict/union rule schemas (see `ruleResolverFor` there), and asks for
 * `raw: true` values so React Hook Form keeps working with the flat,
 * on-screen field names rather than the transformed/piped shape. Server-side
 * rejection still lands exactly where it would have client-side: `useAction`'s
 * `fieldErrors` mapping sets the same named field, because the field names
 * here already match the schema's.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Ban,
  Calculator,
  CheckCircle2,
  Clock3,
  Lock,
  Pencil,
  Wallet,
} from 'lucide-react'
import { useForm, type Resolver } from 'react-hook-form'
import { z } from 'zod'

import {
  MAX_PROGRAM_EXPIRY_DAYS,
  REFERRAL_PROGRAM_KEY,
  referralProgramUpsertSchema,
  referralRedemptionStatusUpdateSchema,
  rewardAdjustmentSchema,
  type ReferralProgramUpsertRawInput,
  type ReferralRedemptionStatus,
  type ReferralRedemptionStatusUpdateRawInput,
  type RewardAdjustmentRawInput,
  type RewardLedgerDirection,
  type RewardLedgerReason,
  type RewardType,
} from '@mannachef/validators'

import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { CheckboxField } from '@/components/ui/checkbox'
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
import { DateTime } from '@/components/ui/date-time'
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
import { Textarea } from '@/components/ui/textarea'
import { useAction, type DescribedActionFailure } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import {
  recomputeRewardBalance,
  recordRewardAdjustment,
  updateReferralRedemption,
} from '@/server/actions/referral'
import { updateReferralProgram } from '@/server/actions/referral-program'

// =============================================================================
// Shared bits
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

/** A gate explanation, for a lever that is real but not this viewer's to pull. */
function GateNotice({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-ash bg-charcoal px-3 py-3">
      <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-stone" />
      <p className="font-sans text-sm leading-relaxed text-parchment">
        {children}
      </p>
    </div>
  )
}

/**
 * Displays and edits an amount in dollars, submits it in cents.
 *
 * Mirrors `DollarsInput` in `admin/billing/plan-editor.tsx` — there is no
 * shared primitive for an editable money field (`<Money>` only renders one),
 * so every screen that edits cents re-states this same small buffer.
 */
interface DollarsInputProps extends Omit<
  React.ComponentPropsWithoutRef<'input'>,
  'value' | 'onChange' | 'type'
> {
  readonly cents: number
  readonly onCentsChange: (cents: number) => void
}

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
// 1. The standing offer
// =============================================================================

/**
 * The current terms, flattened for this screen.
 *
 * Mirrors `ReferralProgramView` (`src/server/referral-program.ts`) rather than
 * importing it — that type lives on the server side of the `'use server'`
 * boundary `referral-program.ts` sits behind, and a client component's only
 * licensed source of a type is `@mannachef/validators` or a plain prop shape
 * a Server Component parent hands down, per `CONTRACT.md`.
 */
export interface ProgramTerms {
  readonly rewardType: RewardType
  readonly rewardValueCents: number | null
  readonly rewardValuePercent: number | null
  readonly currency: string
  readonly refereeRewardCents: number | null
  readonly defaultMaxRedemptions: number | null
  readonly defaultExpiryDays: number | null
  readonly minimumQualifyingInvoiceCents: number
  readonly allowLossLeader: boolean
  readonly allowExistingCustomerReferral: boolean
  readonly isActive: boolean
  readonly isCoherent: boolean
  readonly updatedAt: Date
}

export interface ProgramEditorProps {
  readonly program: ProgramTerms | null
  /** Only a `SUPER_ADMIN` may change what a referral is worth. */
  readonly canEdit: boolean
}

const REWARD_TYPE_LABEL: Record<RewardType, string> = {
  FIXED_CREDIT: 'Fixed credit',
  PERCENT_DISCOUNT: 'Percent of the qualifying invoice',
  FREE_MEAL: 'A complimentary meal',
  FREE_DELIVERY: 'Waived delivery',
}

function describeReward(program: ProgramTerms): string {
  if (program.rewardType === 'PERCENT_DISCOUNT') {
    return `${String(program.rewardValuePercent ?? 0)}% off the qualifying invoice`
  }

  return REWARD_TYPE_LABEL[program.rewardType]
}

/**
 * The standing offer — what a referral is worth, platform-wide, and the one
 * form allowed to change it.
 *
 * Every figure here is read-only fact for an `ADMIN`: a code owner's reward is
 * a snapshot copied from this row at the moment the code was minted, never a
 * number a client chooses (`CONTRACT.md`'s instruction for this screen). The
 * edit form itself only renders for `canEdit`; anyone else sees the terms and
 * a plain sentence about why the button is missing rather than the button
 * simply not being there.
 */
export function ProgramEditor({ program, canEdit }: ProgramEditorProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <Card variant="accent" padded>
      <CardHeader className="flex-row items-start justify-between gap-4 p-0 pb-4">
        <div>
          <CardTitle level={2} className="font-display text-2xl font-light">
            Programme terms
          </CardTitle>
          <CardDescription>
            The fixed platform terms every referral code copies its reward from.
            No code owner chooses their own figures.
          </CardDescription>
        </div>
        {canEdit ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil aria-hidden="true" />
            Edit terms
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-0">
        {program === null ? (
          <p className="font-sans text-sm text-parchment">
            No standing offer has ever been configured. Referral codes cannot be
            minted until one exists.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={program.isActive ? 'success' : 'muted'}>
                {program.isActive ? 'Offer is live' : 'Offer is switched off'}
              </Badge>
              {program.isCoherent ? null : (
                <Badge variant="destructive">
                  <AlertTriangle aria-hidden="true" />
                  Reward figures do not pair up
                </Badge>
              )}
              {program.allowLossLeader ? (
                <Badge variant="warning">Allowed to run at a loss</Badge>
              ) : null}
              {program.allowExistingCustomerReferral ? (
                <Badge variant="outline">Win-backs count</Badge>
              ) : null}
            </div>

            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="font-sans text-xs text-stone uppercase">
                  Inviter earns
                </dt>
                <dd className="font-display text-xl text-linen">
                  {program.rewardType === 'PERCENT_DISCOUNT' ? (
                    describeReward(program)
                  ) : (
                    <Money
                      cents={program.rewardValueCents ?? 0}
                      currency={program.currency}
                      weight="semibold"
                    />
                  )}
                </dd>
                <dd className="font-sans text-xs text-stone">
                  {REWARD_TYPE_LABEL[program.rewardType]}
                </dd>
              </div>
              <div>
                <dt className="font-sans text-xs text-stone uppercase">
                  Invited household earns
                </dt>
                <dd className="font-display text-xl text-linen">
                  {program.refereeRewardCents === null ? (
                    <span className="text-stone">Nothing extra</span>
                  ) : (
                    <Money
                      cents={program.refereeRewardCents}
                      currency={program.currency}
                      weight="semibold"
                    />
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-sans text-xs text-stone uppercase">
                  Qualifying floor
                </dt>
                <dd className="font-display text-xl text-linen">
                  <Money
                    cents={program.minimumQualifyingInvoiceCents}
                    currency={program.currency}
                    weight="semibold"
                  />
                </dd>
                <dd className="font-sans text-xs text-stone">
                  The first paid invoice must clear this before a referral is
                  earned.
                </dd>
              </div>
              <div>
                <dt className="font-sans text-xs text-stone uppercase">
                  Redemptions per code
                </dt>
                <dd className="font-display text-xl text-linen">
                  {program.defaultMaxRedemptions ?? 'Unlimited'}
                </dd>
              </div>
              <div>
                <dt className="font-sans text-xs text-stone uppercase">
                  Code expiry
                </dt>
                <dd className="font-display text-xl text-linen">
                  {program.defaultExpiryDays === null
                    ? 'Never'
                    : `${String(program.defaultExpiryDays)} days`}
                </dd>
              </div>
              <div>
                <dt className="font-sans text-xs text-stone uppercase">
                  Last changed
                </dt>
                <dd className="font-display text-xl text-linen">
                  <DateTime value={program.updatedAt} format="relative" />
                </dd>
              </div>
            </dl>
          </>
        )}

        {canEdit ? null : (
          <GateNotice>
            Only Super Admins can change what a referral is worth. You&rsquo;re
            signed in as Admin, so the terms above are visible but not editable
            — ask a Super Admin to raise your access, or to make the change on
            your behalf.
          </GateNotice>
        )}
      </CardContent>

      {canEdit ? (
        <ProgramFormDialog
          open={open}
          onOpenChange={setOpen}
          program={program}
        />
      ) : null}
    </Card>
  )
}

interface ProgramFormValues {
  rewardType: RewardType
  rewardValueCents: number
  rewardValuePercent: number
  currency: string
  refereeRewardCents: number | null
  defaultMaxRedemptions: number | null
  defaultExpiryDays: number | null
  minimumQualifyingInvoiceCents: number
  allowLossLeader: boolean
  allowExistingCustomerReferral: boolean
  isActive: boolean
}

const PROGRAM_FIELD_PATHS = [
  'rewardType',
  'rewardValueCents',
  'rewardValuePercent',
  'currency',
  'refereeRewardCents',
  'defaultMaxRedemptions',
  'defaultExpiryDays',
  'minimumQualifyingInvoiceCents',
  'allowLossLeader',
  'allowExistingCustomerReferral',
  'isActive',
] as const

function defaultProgramFormValues(
  program: ProgramTerms | null
): ProgramFormValues {
  return {
    rewardType: program?.rewardType ?? 'FIXED_CREDIT',
    rewardValueCents: program?.rewardValueCents ?? 2500,
    rewardValuePercent: program?.rewardValuePercent ?? 10,
    currency: program?.currency ?? 'CAD',
    refereeRewardCents: program?.refereeRewardCents ?? null,
    defaultMaxRedemptions: program?.defaultMaxRedemptions ?? null,
    defaultExpiryDays: program?.defaultExpiryDays ?? null,
    minimumQualifyingInvoiceCents: program?.minimumQualifyingInvoiceCents ?? 0,
    allowLossLeader: program?.allowLossLeader ?? false,
    allowExistingCustomerReferral:
      program?.allowExistingCustomerReferral ?? false,
    isActive: program?.isActive ?? true,
  }
}

/** Builds the exact discriminated-union shape `referralProgramUpsertSchema` expects. */
function buildProgramPayload(
  values: ProgramFormValues
): ReferralProgramUpsertRawInput {
  const common = {
    key: REFERRAL_PROGRAM_KEY,
    currency: values.currency,
    refereeRewardCents: values.refereeRewardCents,
    defaultMaxRedemptions: values.defaultMaxRedemptions,
    defaultExpiryDays: values.defaultExpiryDays,
    minimumQualifyingInvoiceCents: values.minimumQualifyingInvoiceCents,
    allowLossLeader: values.allowLossLeader,
    allowExistingCustomerReferral: values.allowExistingCustomerReferral,
    isActive: values.isActive,
  }

  if (values.rewardType === 'PERCENT_DISCOUNT') {
    return {
      rewardType: 'PERCENT_DISCOUNT',
      rewardValuePercent: values.rewardValuePercent,
      ...common,
    }
  }

  return {
    rewardType: values.rewardType,
    rewardValueCents: values.rewardValueCents,
    ...common,
  }
}

/**
 * Validates by projecting through {@link buildProgramPayload} into
 * `referralProgramUpsertSchema`, then hands RHF back its own flat field names
 * (`raw: true`) — see the file docblock's "How the strict/union schemas below
 * get a `zodResolver`" section. The cast narrows the validator's declared
 * output to the shape `raw: true` actually returns; it changes no behaviour.
 */
const programValidator = z
  .custom<ProgramFormValues>()
  .transform(buildProgramPayload)
  .pipe(referralProgramUpsertSchema) as unknown as z.ZodType<
  ProgramFormValues,
  ProgramFormValues
>

const programResolver: Resolver<ProgramFormValues, unknown, ProgramFormValues> =
  zodResolver(programValidator, { raw: true })

function ProgramFormDialog({
  open,
  onOpenChange,
  program,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly program: ProgramTerms | null
}) {
  const router = useRouter()
  const form = useForm<ProgramFormValues>({
    resolver: programResolver,
    defaultValues: defaultProgramFormValues(program),
    mode: 'onBlur',
  })

  const action = useAction(updateReferralProgram, {
    form,
    knownFieldPaths: PROGRAM_FIELD_PATHS,
    successMessage: 'The standing offer was updated.',
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })

  const rewardType = form.watch('rewardType')
  const refereeRewardCents = form.watch('refereeRewardCents')
  const defaultMaxRedemptions = form.watch('defaultMaxRedemptions')
  const defaultExpiryDays = form.watch('defaultExpiryDays')
  const pending = action.isPending

  React.useEffect(() => {
    if (open) {
      form.reset(defaultProgramFormValues(program))
      action.reset()
    }
    // `program` and `action` intentionally excluded — this effect only ever
    // needs to run when the dialog is opened, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit the standing offer</DialogTitle>
          <DialogDescription>
            These figures apply platform-wide. A code minted after this change
            copies its reward from what is saved here.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            className="flex flex-col gap-6"
            onSubmit={form.handleSubmit((values) => {
              void action.execute(buildProgramPayload(values))
            })}
            noValidate
          >
            <fieldset disabled={pending} className="contents">
              <legend className="sr-only">Standing offer terms</legend>

              <FormRootError />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="rewardType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Reward type</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(REWARD_TYPE_LABEL).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
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

                {rewardType === 'PERCENT_DISCOUNT' ? (
                  <FormField
                    control={form.control}
                    name="rewardValuePercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Inviter earns (percent)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={1}
                            max={100}
                            step={1}
                            value={field.value}
                            onChange={(event) =>
                              field.onChange(Number(event.target.value))
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
                ) : (
                  <FormField
                    control={form.control}
                    name="rewardValueCents"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Inviter earns</FormLabel>
                        <FormControl>
                          <DollarsInput
                            name={field.name}
                            cents={field.value}
                            onCentsChange={field.onChange}
                            onBlur={field.onBlur}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="minimumQualifyingInvoiceCents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Qualifying floor</FormLabel>
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
                        The referred household&rsquo;s first paid invoice must
                        clear this amount.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <Separator />

              <div className="flex flex-col gap-3">
                <CheckboxField
                  label="Also reward the invited household"
                  description="Leave unchecked to reward only the inviter."
                  checked={refereeRewardCents !== null}
                  onCheckedChange={(checked) =>
                    form.setValue(
                      'refereeRewardCents',
                      checked === true ? 0 : null
                    )
                  }
                />
                {refereeRewardCents === null ? null : (
                  <FormField
                    control={form.control}
                    name="refereeRewardCents"
                    render={({ field }) => (
                      <FormItem className="max-w-xs">
                        <FormLabel>Invited household earns</FormLabel>
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
                )}
              </div>

              <Separator />

              <div className="flex flex-col gap-3">
                <CheckboxField
                  label="Cap redemptions per code"
                  checked={defaultMaxRedemptions !== null}
                  onCheckedChange={(checked) =>
                    form.setValue(
                      'defaultMaxRedemptions',
                      checked === true ? 1 : null
                    )
                  }
                />
                {defaultMaxRedemptions === null ? null : (
                  <FormField
                    control={form.control}
                    name="defaultMaxRedemptions"
                    render={({ field }) => (
                      <FormItem className="max-w-xs">
                        <FormLabel>Redemptions per code</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={1}
                            value={field.value ?? 1}
                            onChange={(event) =>
                              field.onChange(Number(event.target.value))
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
                )}

                <CheckboxField
                  label="Codes expire automatically"
                  checked={defaultExpiryDays !== null}
                  onCheckedChange={(checked) =>
                    form.setValue(
                      'defaultExpiryDays',
                      checked === true ? 90 : null
                    )
                  }
                />
                {defaultExpiryDays === null ? null : (
                  <FormField
                    control={form.control}
                    name="defaultExpiryDays"
                    render={({ field }) => (
                      <FormItem className="max-w-xs">
                        <FormLabel>Days until a code expires</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            numeric
                            min={1}
                            max={MAX_PROGRAM_EXPIRY_DAYS}
                            value={field.value ?? 90}
                            onChange={(event) =>
                              field.onChange(Number(event.target.value))
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
                )}
              </div>

              <Separator />

              <div className="flex flex-col gap-3">
                <FormField
                  control={form.control}
                  name="allowLossLeader"
                  render={({ field }) => (
                    <CheckboxField
                      label="Allow this offer to run at a loss"
                      description="Otherwise the reward may not exceed the qualifying floor."
                      checked={field.value}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name="allowExistingCustomerReferral"
                  render={({ field }) => (
                    <CheckboxField
                      label="Reward winning back a former customer"
                      description="Otherwise only a household that has never paid us qualifies."
                      checked={field.value}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name="isActive"
                  render={({ field }) => (
                    <SwitchField
                      label="Offer is live"
                      description="Off stops new codes being minted. It does not change existing codes."
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>

              {action.failure === null ? null : (
                <ActionFailureNotice failure={action.failure} />
              )}
              <FormStatus>{action.statusMessage}</FormStatus>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="champagne"
                  loading={pending}
                  loadingLabel="Saving…"
                >
                  Save terms
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 2. The payout queue — per-redemption actions
// =============================================================================

/**
 * One redemption, flattened for the action controls.
 *
 * Mirrors `ReferralRedemptionView` (`src/server/actions/referral.ts`) rather
 * than importing it, for the same reason `ProgramTerms` mirrors its view.
 */
export interface RedemptionQueueRow {
  readonly id: string
  readonly code: string
  readonly status: ReferralRedemptionStatus
  readonly rewardCents: number | null
  readonly currency: string
}

export interface RedemptionActionsProps {
  readonly redemption: RedemptionQueueRow
  /** `REWARD`, and a `REVOKE` that reverses paid credit, both need this. */
  readonly isSuperAdmin: boolean
}

/**
 * The lifecycle buttons for one payout-queue row.
 *
 * `updateReferralRedemption` is `ADMIN` at the door but refuses `REWARD` and a
 * money-reversing `REVOKE` from anyone below `SUPER_ADMIN` on its own — see
 * the file docblock. `isSuperAdmin` here decides whether those two controls
 * are live or disabled-with-an-explanation; it changes nothing about what the
 * server will actually allow.
 */
export function RedemptionActions({
  redemption,
  isSuperAdmin,
}: RedemptionActionsProps) {
  const router = useRouter()
  const [revokeOpen, setRevokeOpen] = React.useState(false)

  const action = useAction(updateReferralRedemption, {
    onSuccess: () => router.refresh(),
  })

  if (redemption.status === 'EXPIRED' || redemption.status === 'REVOKED') {
    return (
      <span className="font-sans text-xs text-stone">No further action</span>
    )
  }

  return (
    <>
      <div className="flex flex-wrap justify-end gap-1.5">
        {redemption.status === 'PENDING' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={action.isPending}
            onClick={() =>
              void action.execute({
                action: 'QUALIFY',
                redemptionId: redemption.id,
              })
            }
          >
            <CheckCircle2 aria-hidden="true" />
            Mark qualified
          </Button>
        ) : null}

        {redemption.status === 'QUALIFIED' ? (
          <Button
            type="button"
            variant="champagne"
            size="sm"
            loading={action.isPending}
            disabled={!isSuperAdmin}
            title={
              isSuperAdmin
                ? undefined
                : 'Paying a reward is reserved to a Super Admin.'
            }
            onClick={() =>
              void action.execute({
                action: 'REWARD',
                redemptionId: redemption.id,
              })
            }
          >
            <Wallet aria-hidden="true" />
            Pay reward
          </Button>
        ) : null}

        {redemption.status === 'PENDING' ||
        redemption.status === 'QUALIFIED' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={action.isPending}
            onClick={() =>
              void action.execute({
                action: 'EXPIRE',
                redemptionId: redemption.id,
              })
            }
          >
            <Clock3 aria-hidden="true" />
            Let it lapse
          </Button>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-claret-ink hover:text-claret-ink"
          onClick={() => setRevokeOpen(true)}
        >
          <Ban aria-hidden="true" />
          Revoke
        </Button>
      </div>

      {action.failure === null ? null : (
        <p className="mt-1.5 text-right font-sans text-xs text-claret-ink">
          {action.failure.description}
        </p>
      )}

      <RevokeDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        redemption={redemption}
        isSuperAdmin={isSuperAdmin}
      />
    </>
  )
}

interface RevokeFormValues {
  revokedReason: string
  reverseLedgerEntry: boolean
}

/** Builds the exact shape `referralRedemptionStatusUpdateSchema`'s `REVOKE` branch expects. */
function buildRevokePayload(
  values: RevokeFormValues,
  redemptionId: string,
  isSuperAdmin: boolean
): ReferralRedemptionStatusUpdateRawInput {
  return {
    action: 'REVOKE',
    redemptionId,
    revokedReason: values.revokedReason,
    reverseLedgerEntry: isSuperAdmin ? values.reverseLedgerEntry : false,
  }
}

/**
 * Same shape-then-validate idiom as {@link programResolver}, factored per
 * dialog instance because `redemptionId` and the `isSuperAdmin` gate on
 * `reverseLedgerEntry` are only known once the row is.
 */
function revokeResolverFor(
  redemptionId: string,
  isSuperAdmin: boolean
): Resolver<RevokeFormValues, unknown, RevokeFormValues> {
  const validator = z
    .custom<RevokeFormValues>()
    .transform((values) =>
      buildRevokePayload(values, redemptionId, isSuperAdmin)
    )
    .pipe(referralRedemptionStatusUpdateSchema) as unknown as z.ZodType<
    RevokeFormValues,
    RevokeFormValues
  >

  return zodResolver(validator, { raw: true })
}

function RevokeDialog({
  open,
  onOpenChange,
  redemption,
  isSuperAdmin,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly redemption: RedemptionQueueRow
  readonly isSuperAdmin: boolean
}) {
  const router = useRouter()
  const wasRewarded = redemption.status === 'REWARDED'

  const form = useForm<RevokeFormValues>({
    resolver: revokeResolverFor(redemption.id, isSuperAdmin),
    defaultValues: { revokedReason: '', reverseLedgerEntry: false },
  })

  const action = useAction(updateReferralRedemption, {
    form,
    knownFieldPaths: ['revokedReason', 'reverseLedgerEntry'],
    successMessage: 'The redemption was withdrawn.',
    onSuccess: () => {
      onOpenChange(false)
      form.reset({ revokedReason: '', reverseLedgerEntry: false })
      router.refresh()
    },
  })

  const pending = action.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke this redemption?</DialogTitle>
          <DialogDescription>
            Code {redemption.code}. This is permanent — the redemption moves to
            Revoked and stays there.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit((values) => {
              void action.execute(
                buildRevokePayload(values, redemption.id, isSuperAdmin)
              )
            })}
            noValidate
          >
            <fieldset disabled={pending} className="contents">
              <legend className="sr-only">Revocation details</legend>

              <FormRootError />

              <FormField
                control={form.control}
                name="revokedReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Why is this being withdrawn?</FormLabel>
                    <FormControl>
                      <Textarea rows={3} minLength={4} required {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {wasRewarded ? (
                <FormField
                  control={form.control}
                  name="reverseLedgerEntry"
                  render={({ field }) => (
                    <FormItem>
                      <CheckboxField
                        label="Also claw back the credit already paid"
                        description={
                          isSuperAdmin
                            ? 'Writes a compensating debit against the balance.'
                            : 'Reserved to a Super Admin — revoking here leaves the paid credit in place.'
                        }
                        checked={field.value}
                        disabled={!isSuperAdmin}
                        onCheckedChange={(checked) =>
                          field.onChange(checked === true)
                        }
                      />
                    </FormItem>
                  )}
                />
              ) : null}

              {action.failure === null ? null : (
                <ActionFailureNotice failure={action.failure} />
              )}
              <FormStatus>{action.statusMessage}</FormStatus>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  loading={pending}
                  loadingLabel="Revoking…"
                >
                  Revoke redemption
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 3. One household's balance — reconcile, and hand-adjust
// =============================================================================

const ADJUSTMENT_REASON_LABEL: Record<
  Exclude<RewardLedgerReason, 'REFERRAL_REWARD' | 'REFERRAL_SIGNUP_BONUS'>,
  string
> = {
  PROMOTIONAL_GRANT: 'Promotional grant (credit)',
  MANUAL_ADJUSTMENT: 'Manual correction',
  INVOICE_REDEMPTION: 'Credit spent against an invoice (debit)',
  EXPIRATION: 'Credit expired (debit)',
  REVERSAL: 'Reversal of a prior entry',
}

export interface BalanceToolsProps {
  readonly userId: string
  /** Recomputing is `ADMIN`; a hand-written ledger entry is `SUPER_ADMIN`. */
  readonly isSuperAdmin: boolean
}

/**
 * Reconcile one household's balance against the ledger, and — for a Super
 * Admin — write a hand-adjustment onto it.
 */
export function BalanceTools({ userId, isSuperAdmin }: BalanceToolsProps) {
  const router = useRouter()
  const [adjustOpen, setAdjustOpen] = React.useState(false)

  const recomputeAction = useAction(recomputeRewardBalance, {
    successMessage: 'The balance was recomputed from the ledger.',
    onSuccess: () => router.refresh(),
  })

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={recomputeAction.isPending}
        onClick={() => void recomputeAction.execute({ userId })}
      >
        <Calculator aria-hidden="true" />
        Recompute from ledger
      </Button>

      {isSuperAdmin ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdjustOpen(true)}
        >
          <Wallet aria-hidden="true" />
          Manual adjustment
        </Button>
      ) : (
        <span className="font-sans text-xs text-stone">
          Manual credits and corrections are reserved to Super Admins.
        </span>
      )}

      <AdjustmentDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        userId={userId}
      />
    </div>
  )
}

interface AdjustmentFormValues {
  direction: RewardLedgerDirection
  reason: Exclude<
    RewardLedgerReason,
    'REFERRAL_REWARD' | 'REFERRAL_SIGNUP_BONUS'
  >
  amountCents: number
  currency: string
  invoiceId: string
  referralRedemptionId: string
  note: string
}

/** Builds the exact shape `rewardAdjustmentSchema` expects; `userId` is a prop, not a field. */
function buildAdjustmentPayload(
  values: AdjustmentFormValues,
  userId: string
): RewardAdjustmentRawInput {
  return {
    userId,
    direction: values.direction,
    reason: values.reason,
    amountCents: values.amountCents,
    currency: values.currency,
    invoiceId:
      values.invoiceId.trim().length > 0 ? values.invoiceId.trim() : null,
    referralRedemptionId:
      values.referralRedemptionId.trim().length > 0
        ? values.referralRedemptionId.trim()
        : null,
    note: values.note,
  }
}

/**
 * Same shape-then-validate idiom as {@link programResolver}, factored per
 * dialog instance because `userId` is only known once the account is.
 */
function adjustmentResolverFor(
  userId: string
): Resolver<AdjustmentFormValues, unknown, AdjustmentFormValues> {
  const validator = z
    .custom<AdjustmentFormValues>()
    .transform((values) => buildAdjustmentPayload(values, userId))
    .pipe(rewardAdjustmentSchema) as unknown as z.ZodType<
    AdjustmentFormValues,
    AdjustmentFormValues
  >

  return zodResolver(validator, { raw: true })
}

function AdjustmentDialog({
  open,
  onOpenChange,
  userId,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly userId: string
}) {
  const router = useRouter()
  const form = useForm<AdjustmentFormValues>({
    resolver: adjustmentResolverFor(userId),
    defaultValues: {
      direction: 'CREDIT',
      reason: 'MANUAL_ADJUSTMENT',
      amountCents: 0,
      currency: 'CAD',
      invoiceId: '',
      referralRedemptionId: '',
      note: '',
    },
  })

  const action = useAction(recordRewardAdjustment, {
    form,
    knownFieldPaths: [
      'direction',
      'reason',
      'amountCents',
      'currency',
      'invoiceId',
      'referralRedemptionId',
      'note',
    ],
    successMessage: 'The ledger entry was recorded.',
    onSuccess: () => {
      onOpenChange(false)
      form.reset()
      router.refresh()
    },
  })

  const pending = action.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a manual ledger entry</DialogTitle>
          <DialogDescription>
            For this account only. The ledger is append-only — this writes a new
            row, it never edits one already recorded.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit((values) => {
              void action.execute(buildAdjustmentPayload(values, userId))
            })}
            noValidate
          >
            <fieldset disabled={pending} className="contents">
              <legend className="sr-only">Manual ledger entry</legend>

              <FormRootError />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="reason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Reason</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(ADJUSTMENT_REASON_LABEL).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="direction"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Direction</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="CREDIT">Credit — adds</SelectItem>
                          <SelectItem value="DEBIT">
                            Debit — subtracts
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="amountCents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Amount</FormLabel>
                      <FormControl>
                        <DollarsInput
                          name={field.name}
                          cents={field.value}
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
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Currency</FormLabel>
                      <FormControl>
                        <Input
                          maxLength={3}
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
                  name="invoiceId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Required for a spent credit"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="referralRedemptionId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Redemption ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Required for a reversal"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Note</FormLabel>
                    <FormControl>
                      <Textarea rows={3} minLength={4} required {...field} />
                    </FormControl>
                    <FormDescription>
                      Explained to whoever reads the ledger next, including the
                      household if they ask.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {action.failure === null ? null : (
                <ActionFailureNotice failure={action.failure} />
              )}
              <FormStatus>{action.statusMessage}</FormStatus>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="champagne"
                  loading={pending}
                  loadingLabel="Recording…"
                >
                  Record entry
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// Re-exports the page needs alongside these components
// =============================================================================

export const REDEMPTION_STATUS_META: Record<
  ReferralRedemptionStatus,
  {
    readonly label: string
    readonly variant: NonNullable<BadgeProps['variant']>
  }
> = {
  PENDING: {
    label: 'Pending — awaiting qualifying invoice',
    variant: 'outline',
  },
  QUALIFIED: { label: 'Qualified — ready to reward', variant: 'champagne' },
  REWARDED: { label: 'Rewarded', variant: 'success' },
  EXPIRED: { label: 'Expired', variant: 'muted' },
  REVOKED: { label: 'Revoked', variant: 'destructive' },
}
