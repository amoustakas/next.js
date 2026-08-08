// mannachef/apps/web/src/components/admin/calendar/availability-editor.tsx
'use client'

/**
 * The two writing surfaces of the calendar: what the diary *offers*, and what
 * gets *placed into* it.
 *
 * ## Why the booking composer lives in this file
 *
 * Availability and booking are one conversation. Every refusal the booking
 * engine returns is answered either by moving the engagement or by opening a
 * window — and the second of those is this file's other half. Keeping them in
 * one module means "the chef does not work then" can point at the editor
 * beside it rather than at a page the operator has to go and find.
 *
 * ## The vocabulary of a refusal
 *
 * `requestAppointment` never says "unavailable". It refuses with `CONFLICT` and
 * a `fieldErrors` map, and that map is structured: the *key* says which control
 * is at fault (`startsAt`, `bookingSlotId`, `travelBufferBeforeMinutes`, …) and
 * the *sentence* says which of the engine's six refusals it is. Alternatives
 * ride in the same map, as sentences beginning `Try `, because `ActionResult`
 * has no third arm for "refused, and here are three other times".
 *
 * {@link classifyConflict} turns that pair back into a discriminated reason, so
 * a core overlap and a travel-buffer overlap are told apart on screen — they
 * have different remedies, and collapsing them costs the operator the one piece
 * of information that would have fixed the booking in a single move.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm, type Resolver } from 'react-hook-form'
import {
  CalendarClock,
  CalendarOff,
  CalendarPlus,
  CalendarX2,
  CircleAlert,
  Clock,
  History,
  Pencil,
  Route,
  ShieldAlert,
  Trash2,
  Users,
} from 'lucide-react'
import { z } from 'zod'

import {
  availabilityRuleKindSchema,
  chefAvailabilityRuleSchema,
  chefAvailabilityUpdateSchema,
  appointmentCreateSchema,
  serviceTypeSchema,
  MAX_GUEST_COUNT,
  MAX_REASON_LENGTH,
  MAX_TRAVEL_BUFFER_MINUTES,
  MIN_GUEST_COUNT,
  ON_SITE_SERVICE_TYPES,
  type AppointmentCreateInput,
  type AppointmentCreateRawInput,
  type AvailabilityRuleKind,
  type ChefAvailabilityRuleInput,
  type ChefAvailabilityRuleRawInput,
  type ChefAvailabilityUpdateInput,
  type ChefAvailabilityUpdateRawInput,
  type ServiceType,
} from '@mannachef/validators'

import { useAction, type ActionFailure } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'
import { toLocalDateTimeInputValue } from '@/lib/local-datetime'
import { cn } from '@/lib/utils'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { RadioGroup, RadioGroupField } from '@/components/ui/radio-group'
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

import {
  createAvailabilityBlackout,
  createAvailabilityRule,
  deleteAvailabilityRule,
  previewAvailabilityWindows,
  updateAvailabilityRule,
} from '@/server/actions/availability'
import { requestAppointment } from '@/server/actions/booking'

// =============================================================================
// 1. The shapes the calendar passes around
// =============================================================================

/**
 * One `ChefAvailability` row, exactly as `listAvailabilityRules` selects it.
 *
 * Declared here rather than imported from the action module so that the grid,
 * the editor and the page all name the same type without any of them reaching
 * into `src/server`.
 */
export interface AvailabilityRuleRow {
  readonly id: string
  readonly kind: AvailabilityRuleKind
  /** Sunday-indexed. Set on a weekly rule, `null` on a date override. */
  readonly dayOfWeek: number | null
  /** A `@db.Date` column: read its calendar date in UTC, never locally. */
  readonly specificDate: Date | null
  readonly startMinute: number
  readonly endMinute: number
  readonly timeZone: string
  readonly effectiveFrom: Date | null
  readonly effectiveUntil: Date | null
  readonly isBlackout: boolean
  readonly reason: string | null
  readonly note: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** One expanded availability window, as `previewAvailabilityWindows` returns it. */
export interface AvailabilityWindowView {
  readonly start: Date
  readonly end: Date
  readonly sourceRuleIds: readonly string[]
}

// =============================================================================
// 2. Minutes from midnight
// =============================================================================

const MINUTES_PER_DAY = 1440
const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `540` → `09:00`. `1440` is midnight at the end of the day and has no input. */
function minutesToTimeValue(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
    return ''
  }

  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** `09:00` → `540`. An empty or half-typed control yields `null`, not zero. */
function timeValueToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)

  if (match === null) {
    return null
  }

  const hours = Number.parseInt(match[1] ?? '', 10)
  const minutes = Number.parseInt(match[2] ?? '', 10)

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null
  }

  return hours * 60 + minutes
}

/** `09:00 – 14:30`, or `09:00 – midnight` for a window that closes the day. */
function describeMinuteWindow(startMinute: number, endMinute: number): string {
  const close =
    endMinute === MINUTES_PER_DAY ? 'midnight' : minutesToTimeValue(endMinute)

  return `${minutesToTimeValue(startMinute)} – ${close}`
}

/** A `@db.Date` value, read as the calendar date it stores. */
function formatDateOnly(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(value)
}

/** `<input type="date">` wants `YYYY-MM-DD` in UTC for a date-only column. */
function toDateInputValue(value: Date | null): string {
  if (value === null) {
    return ''
  }

  return `${String(value.getUTCFullYear())}-${pad(
    value.getUTCMonth() + 1
  )}-${pad(value.getUTCDate())}`
}

/** An instant written out in the chef's own zone, with the zone named. */
function formatInZone(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant)
  } catch {
    return instant.toISOString()
  }
}

/** "1 hour 30 minutes later", "2 days earlier" — how far a suggestion moves. */
function describeShift(shiftMs: number): string {
  if (shiftMs === 0) {
    return 'at the time you asked for'
  }

  const direction = shiftMs < 0 ? 'earlier' : 'later'
  const total = Math.round(Math.abs(shiftMs) / MS_PER_MINUTE)
  const days = Math.floor(total / MINUTES_PER_DAY)
  const hours = Math.floor((total % MINUTES_PER_DAY) / 60)
  const minutes = total % 60

  const parts: string[] = []

  if (days > 0) {
    parts.push(`${String(days)} day${days === 1 ? '' : 's'}`)
  }

  if (hours > 0) {
    parts.push(`${String(hours)} hour${hours === 1 ? '' : 's'}`)
  }

  if (minutes > 0 && days === 0) {
    parts.push(`${String(minutes)} minute${minutes === 1 ? '' : 's'}`)
  }

  return `${parts.join(' ')} ${direction}`
}

// =============================================================================
// 3. Refusals that are not conflicts
// =============================================================================

interface RefusalCopy {
  readonly title: string
  readonly description: string
  readonly icon: typeof ShieldAlert
}

/**
 * A sentence per `ActionErrorCode`, so no refusal renders as a generic fault.
 *
 * `FORBIDDEN` is given its own words on purpose. "Something went wrong" invites
 * a retry that cannot possibly succeed; the sentence below tells the operator
 * that the answer will not change until somebody grants them access.
 */
function refusalCopy(failure: ActionFailure, subject: string): RefusalCopy {
  switch (failure.code) {
    case 'FORBIDDEN':
      return {
        title: 'This diary is not yours to change.',
        description: `You are signed in, but ${subject} belongs to another chef. A chef writes only to their own calendar; an administrator writes to any. Ask an administrator to raise your access — retrying will not change the answer.`,
        icon: ShieldAlert,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again, then repeat what you were doing.',
        icon: ShieldAlert,
      }
    case 'VALIDATION':
      return {
        title: 'Some of these details do not add up.',
        description:
          failure.error +
          ' The fields at fault are marked; correct them and submit again.',
        icon: CircleAlert,
      }
    case 'NOT_FOUND':
      return {
        title: 'That is no longer on the calendar.',
        description: `${failure.error} Somebody may have removed it while this page was open — refresh to see the diary as it now stands.`,
        icon: CalendarOff,
      }
    case 'RATE_LIMITED':
      return {
        title: 'One moment.',
        description: `${failure.error} Wait a few seconds, then try once more.`,
        icon: Clock,
      }
    case 'CONFLICT':
      return {
        title: 'The calendar refused this.',
        description: failure.error,
        icon: CalendarX2,
      }
    default:
      return {
        title: 'That did not go through.',
        description: `${failure.error} Nothing was written to the calendar. Try again shortly.`,
        icon: CircleAlert,
      }
  }
}

/** An inline, persistent report of a refusal. Survives the toast timing out. */
function RefusalNotice({
  failure,
  subject,
}: {
  readonly failure: ActionFailure
  readonly subject: string
}): React.JSX.Element {
  const copy = refusalCopy(failure, subject)
  const Icon = copy.icon

  return (
    <div
      role="alert"
      className="flex gap-3 rounded-md border border-claret/50 bg-claret/10 px-3 py-3"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-claret" />
      <div className="flex flex-col gap-1">
        <p className="font-sans text-sm leading-tight font-medium text-linen">
          {copy.title}
        </p>
        <p className="font-sans text-xs leading-relaxed text-parchment">
          {copy.description}
        </p>
      </div>
    </div>
  )
}

// =============================================================================
// 4. The availability editor
// =============================================================================

/**
 * What the dialog holds while a rule is being written.
 *
 * A superset of both branches of `chefAvailabilityRuleSchema`: the dialog
 * always has a weekday control *and* a date control, and shows whichever the
 * chosen kind uses. The schema's branches are `.strict()`, so the irrelevant
 * key has to be dropped before parsing — {@link toRulePayload} does that, and
 * the two schemas below wire it in front of the real validators.
 */
interface RuleFormValues {
  readonly availabilityId: string
  readonly staffProfileId: string
  readonly kind: AvailabilityRuleKind
  readonly dayOfWeek: number
  readonly specificDate: string
  readonly startMinute: number
  readonly endMinute: number
  readonly timeZone: string
  readonly effectiveFrom: string
  readonly effectiveUntil: string
  readonly isBlackout: boolean
  readonly reason: string
  readonly note: string
}

const ruleFormShape = {
  availabilityId: z.string(),
  staffProfileId: z.string(),
  kind: availabilityRuleKindSchema,
  dayOfWeek: z.number(),
  specificDate: z.string(),
  startMinute: z.number(),
  endMinute: z.number(),
  timeZone: z.string(),
  effectiveFrom: z.string(),
  effectiveUntil: z.string(),
  isBlackout: z.boolean(),
  reason: z.string(),
  note: z.string(),
} as const

/** The dialog's superset, projected onto the branch the chosen kind selects. */
function toRulePayload(values: RuleFormValues): ChefAvailabilityRuleRawInput {
  const shared = {
    staffProfileId: values.staffProfileId,
    startMinute: values.startMinute,
    endMinute: values.endMinute,
    timeZone: values.timeZone,
    isBlackout: values.isBlackout,
    ...(values.effectiveFrom === ''
      ? {}
      : { effectiveFrom: values.effectiveFrom }),
    ...(values.effectiveUntil === ''
      ? {}
      : { effectiveUntil: values.effectiveUntil }),
    ...(values.reason.trim() === '' ? {} : { reason: values.reason }),
    ...(values.note.trim() === '' ? {} : { note: values.note }),
  }

  if (values.kind === 'RECURRING_WEEKLY') {
    return {
      ...shared,
      kind: 'RECURRING_WEEKLY',
      dayOfWeek: values.dayOfWeek,
    }
  }

  return {
    ...shared,
    kind: 'DATE_OVERRIDE',
    specificDate: values.specificDate,
  }
}

/**
 * The same superset, projected onto an amendment.
 *
 * `kind` and `staffProfileId` are absent by design: `chefAvailabilityUpdate`
 * refuses to move a window between chefs or to change what sort of rule it is,
 * both of which are a delete and a create. `reason` and `note` are always sent,
 * including as empty strings, so clearing one actually clears it — the two date
 * bounds are not, because `isoDateTimeSchema` has no spelling for "no longer
 * bounded" and sending `''` would only produce a validation error.
 */
function toRuleUpdatePayload(
  values: RuleFormValues
): ChefAvailabilityUpdateRawInput {
  return {
    availabilityId: values.availabilityId,
    startMinute: values.startMinute,
    endMinute: values.endMinute,
    timeZone: values.timeZone,
    isBlackout: values.isBlackout,
    reason: values.reason,
    note: values.note,
    ...(values.effectiveFrom === ''
      ? {}
      : { effectiveFrom: values.effectiveFrom }),
    ...(values.effectiveUntil === ''
      ? {}
      : { effectiveUntil: values.effectiveUntil }),
    ...(values.kind === 'RECURRING_WEEKLY'
      ? { dayOfWeek: values.dayOfWeek }
      : { specificDate: values.specificDate }),
  }
}

/**
 * The dialog's two validators, each ending in a real schema.
 *
 * The projection is a `.transform()` in front of a `.pipe()`, so every issue
 * the schema raises still carries the schema's own path — `endMinute`,
 * `reason`, `specificDate` — and lands under the right input rather than in a
 * single lump above the form.
 *
 * A note on the create validator: `chefAvailabilityRuleSchema` is a union, and
 * a failing union reports one issue at the root rather than per field. That is
 * what `<FormRootError>` above the buttons is for. The server re-validates and
 * answers with a proper `fieldErrors` map, which `useAction` puts back on the
 * individual inputs, so a rejected rule always ends up marked field by field.
 */
const createRuleValidator: z.ZodType<
  ChefAvailabilityRuleInput,
  RuleFormValues
> = z
  .object(ruleFormShape)
  .transform(toRulePayload)
  .pipe(chefAvailabilityRuleSchema)

const editRuleValidator: z.ZodType<
  ChefAvailabilityUpdateInput,
  RuleFormValues
> = z
  .object(ruleFormShape)
  .transform(toRuleUpdatePayload)
  .pipe(chefAvailabilityUpdateSchema)

/**
 * The resolver for whichever validator applies, asked for **raw** values.
 *
 * `raw` is normally the wrong choice — parsed output is what makes a coerced
 * field arrive at an action already narrowed. Here it is the right one, and for
 * a specific reason: the dialog holds a superset of both branches of the rule
 * schema, so the parsed output is a *different shape* from the fields on
 * screen. Handing that back to React Hook Form would make `handleSubmit` and
 * `form.setValue` disagree about what a field is called. Instead the dialog
 * keeps its own shape end to end and applies {@link toRulePayload} /
 * {@link toRuleUpdatePayload} at the moment of dispatch — the same two
 * functions the validator above ran, so what is validated is what is sent.
 *
 * The cast narrows the validator's declared output to the shape `raw: true`
 * actually returns. It changes no behaviour: with `raw` set, `zodResolver`
 * resolves with the values it was given.
 */
function ruleResolverFor(
  isEdit: boolean
): Resolver<RuleFormValues, unknown, RuleFormValues> {
  const validator = (isEdit
    ? editRuleValidator
    : createRuleValidator) as unknown as z.ZodType<
    RuleFormValues,
    RuleFormValues
  >

  return zodResolver(validator, { raw: true })
}

/** Which of the three lists a rule belongs in. */
type RuleGroup = 'weekly' | 'override' | 'blackout'

function groupOf(rule: AvailabilityRuleRow): RuleGroup {
  if (rule.isBlackout) {
    return 'blackout'
  }

  return rule.kind === 'RECURRING_WEEKLY' ? 'weekly' : 'override'
}

interface GroupPresentation {
  readonly title: string
  readonly description: string
  readonly rail: string
  readonly badge: 'success' | 'warning' | 'destructive'
  readonly badgeLabel: string
  readonly emptyTitle: string
  readonly emptyDescription: string
}

/**
 * Each kind of rule gets its own colour of hairline and its own badge, because
 * they are not variations on one thing: a weekly rule is the shape of an
 * ordinary week, an override replaces that shape for one date, and a blackout
 * subtracts from whatever survives. Reading them as one list is how an evening
 * gets double-booked.
 */
const GROUPS: Readonly<Record<RuleGroup, GroupPresentation>> = {
  weekly: {
    title: 'Every week',
    description:
      'The ordinary shape of the week. A recurring window is offered on that weekday until an override or a blackout says otherwise.',
    rail: 'bg-sage/60',
    badge: 'success',
    badgeLabel: 'Weekly',
    emptyTitle: 'The week has no shape yet.',
    emptyDescription:
      'Add a recurring window — say Thursday to Saturday, 16:00 to midnight — and the diary will offer it every week.',
  },
  override: {
    title: 'One date only',
    description:
      'An exception for a single date. An override replaces the recurring windows underneath it for that day entirely, rather than adding to them.',
    rail: 'bg-terracotta/60',
    badge: 'warning',
    badgeLabel: 'Override',
    emptyTitle: 'No dates are being treated differently.',
    emptyDescription:
      'Add an override for a Sunday you will cook, or a Friday you will start late.',
  },
  blackout: {
    title: 'Closed',
    description:
      'Time subtracted from the calendar. A blackout wins over everything above it and always carries a reason, so the concierge can explain it.',
    rail: 'bg-claret/70',
    badge: 'destructive',
    badgeLabel: 'Closed',
    emptyTitle: 'The diary is never closed.',
    emptyDescription:
      'Add a blackout for a holiday, a family occasion, or a week away.',
  },
}

const GROUP_ORDER: readonly RuleGroup[] = ['weekly', 'override', 'blackout']

export interface AvailabilityEditorProps {
  readonly staffProfileId: string
  readonly chefName: string
  /** The chef's own zone. Every rule below is authored against a zone like it. */
  readonly calendarTimeZone: string
  readonly rules: readonly AvailabilityRuleRow[]
}

/**
 * Create and amend the three kinds of availability rule.
 *
 * Times are minutes from midnight in the **chef's** wall clock, not the
 * reader's — a window authored as 16:00 in `America/Toronto` stays 16:00 in
 * Toronto when the clocks change, and reads as 21:00 to a dispatcher in London.
 * The zone therefore travels with every rule and is named on every row.
 */
export function AvailabilityEditor({
  staffProfileId,
  chefName,
  calendarTimeZone,
  rules,
}: AvailabilityEditorProps): React.JSX.Element {
  const [editing, setEditing] = React.useState<
    | { readonly mode: 'create' }
    | { readonly mode: 'edit'; readonly rule: AvailabilityRuleRow }
    | null
  >(null)
  const [pendingDelete, setPendingDelete] =
    React.useState<AvailabilityRuleRow | null>(null)

  const grouped = React.useMemo(() => {
    const buckets: Record<RuleGroup, AvailabilityRuleRow[]> = {
      weekly: [],
      override: [],
      blackout: [],
    }

    for (const rule of rules) {
      buckets[groupOf(rule)].push(rule)
    }

    return buckets
  }, [rules])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-sans text-xs leading-relaxed text-stone">
          Authored in{' '}
          <abbr
            title={`${chefName}'s calendar time zone`}
            className="font-medium text-parchment no-underline"
          >
            {calendarTimeZone}
          </abbr>
          . Every time below is that clock, not yours.
        </p>
        <Button
          variant="champagne"
          size="sm"
          onClick={() => {
            setEditing({ mode: 'create' })
          }}
        >
          <CalendarPlus aria-hidden="true" className="size-4" />
          New rule
        </Button>
      </div>

      {GROUP_ORDER.map((group) => (
        <RuleGroupSection
          key={group}
          group={group}
          rules={grouped[group]}
          onEdit={(rule) => {
            setEditing({ mode: 'edit', rule })
          }}
          onDelete={setPendingDelete}
        />
      ))}

      <RuleDialog
        key={
          editing === null
            ? 'closed'
            : editing.mode === 'edit'
              ? editing.rule.id
              : 'new'
        }
        state={editing}
        staffProfileId={staffProfileId}
        chefName={chefName}
        calendarTimeZone={calendarTimeZone}
        onClose={() => {
          setEditing(null)
        }}
      />

      <DeleteRuleDialog
        rule={pendingDelete}
        chefName={chefName}
        onClose={() => {
          setPendingDelete(null)
        }}
      />
    </div>
  )
}

function RuleGroupSection({
  group,
  rules,
  onEdit,
  onDelete,
}: {
  readonly group: RuleGroup
  readonly rules: readonly AvailabilityRuleRow[]
  readonly onEdit: (rule: AvailabilityRuleRow) => void
  readonly onDelete: (rule: AvailabilityRuleRow) => void
}): React.JSX.Element {
  const presentation = GROUPS[group]
  const headingId = `availability-group-${group}`

  return (
    <Card>
      <CardHeader>
        <CardTitle id={headingId} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('h-4 w-1 rounded-full', presentation.rail)}
          />
          {presentation.title}
        </CardTitle>
        <CardDescription>{presentation.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <EmptyState
            tone="empty"
            size="sm"
            headingLevel={4}
            title={presentation.emptyTitle}
            description={presentation.emptyDescription}
          />
        ) : (
          <ul aria-labelledby={headingId} className="flex flex-col gap-2">
            {rules.map((rule) => (
              <li key={rule.id}>
                <RuleRow
                  rule={rule}
                  presentation={presentation}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RuleRow({
  rule,
  presentation,
  onEdit,
  onDelete,
}: {
  readonly rule: AvailabilityRuleRow
  readonly presentation: GroupPresentation
  readonly onEdit: (rule: AvailabilityRuleRow) => void
  readonly onDelete: (rule: AvailabilityRuleRow) => void
}): React.JSX.Element {
  const when =
    rule.kind === 'RECURRING_WEEKLY'
      ? (WEEKDAY_NAMES[rule.dayOfWeek ?? 0] ?? 'Every day')
      : rule.specificDate === null
        ? 'One date'
        : formatDateOnly(rule.specificDate)

  const label = `${when}, ${describeMinuteWindow(rule.startMinute, rule.endMinute)} ${rule.timeZone}`

  return (
    <div className="flex items-start gap-3 rounded-md border border-ash bg-charcoal/60 p-3">
      <span
        aria-hidden="true"
        className={cn('mt-1 h-10 w-1 shrink-0 rounded-full', presentation.rail)}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-medium text-linen">
            {when}
          </span>
          <span className="font-sans text-sm tabular-nums text-parchment">
            {describeMinuteWindow(rule.startMinute, rule.endMinute)}
          </span>
          <Badge variant={presentation.badge} srPrefix="Rule type: ">
            {presentation.badgeLabel}
          </Badge>
        </div>

        <p className="font-sans text-xs text-stone">
          {rule.timeZone}
          {rule.effectiveFrom === null && rule.effectiveUntil === null
            ? ' · applies indefinitely'
            : ` · ${
                rule.effectiveFrom === null
                  ? 'until'
                  : `from ${formatDateOnly(rule.effectiveFrom)}`
              }${
                rule.effectiveUntil === null
                  ? ''
                  : ` until ${formatDateOnly(rule.effectiveUntil)}`
              }`}
        </p>

        {rule.reason === null || rule.reason === '' ? null : (
          <p className="font-sans text-xs leading-relaxed text-parchment">
            {rule.reason}
          </p>
        )}
        {rule.note === null || rule.note === '' ? null : (
          <p className="font-sans text-xs leading-relaxed text-stone">
            {rule.note}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onEdit(rule)
          }}
        >
          <Pencil aria-hidden="true" className="size-4" />
          <span className="sr-only">Amend {label}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onDelete(rule)
          }}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          <span className="sr-only">Remove {label}</span>
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// 5. Writing a rule
// =============================================================================

function defaultRuleValues(
  staffProfileId: string,
  calendarTimeZone: string,
  rule: AvailabilityRuleRow | null
): RuleFormValues {
  if (rule === null) {
    return {
      availabilityId: '',
      staffProfileId,
      kind: 'RECURRING_WEEKLY',
      dayOfWeek: 4,
      specificDate: '',
      startMinute: 16 * 60,
      endMinute: 22 * 60,
      timeZone: calendarTimeZone,
      effectiveFrom: '',
      effectiveUntil: '',
      isBlackout: false,
      reason: '',
      note: '',
    }
  }

  return {
    availabilityId: rule.id,
    staffProfileId,
    kind: rule.kind,
    dayOfWeek: rule.dayOfWeek ?? 0,
    specificDate: toDateInputValue(rule.specificDate),
    startMinute: rule.startMinute,
    endMinute: rule.endMinute,
    timeZone: rule.timeZone,
    effectiveFrom: toDateInputValue(rule.effectiveFrom),
    effectiveUntil: toDateInputValue(rule.effectiveUntil),
    isBlackout: rule.isBlackout,
    reason: rule.reason ?? '',
    note: rule.note ?? '',
  }
}

function RuleDialog({
  state,
  staffProfileId,
  chefName,
  calendarTimeZone,
  onClose,
}: {
  readonly state:
    | { readonly mode: 'create' }
    | { readonly mode: 'edit'; readonly rule: AvailabilityRuleRow }
    | null
  readonly staffProfileId: string
  readonly chefName: string
  readonly calendarTimeZone: string
  readonly onClose: () => void
}): React.JSX.Element {
  const router = useRouter()
  const isEdit = state !== null && state.mode === 'edit'
  const rule = state !== null && state.mode === 'edit' ? state.rule : null

  const form = useForm<RuleFormValues>({
    resolver: ruleResolverFor(isEdit),
    defaultValues: defaultRuleValues(staffProfileId, calendarTimeZone, rule),
  })

  /**
   * One dispatcher for three actions.
   *
   * A blackout is written by `createAvailabilityBlackout` rather than by
   * `createAvailabilityRule` — the two differ in that the first refuses a rule
   * that closes the diary without saying why, which is the whole point of the
   * distinction. Choosing here rather than at three call sites keeps the
   * pending state, the live region and the field errors in one place.
   */
  const saveRule = React.useCallback(
    async (values: RuleFormValues) => {
      if (isEdit) {
        return updateAvailabilityRule(toRuleUpdatePayload(values))
      }

      const payload = toRulePayload(values)

      return values.isBlackout
        ? createAvailabilityBlackout(payload)
        : createAvailabilityRule(payload)
    },
    [isEdit]
  )

  const { execute, isPending, statusMessage, error } = useAction(saveRule, {
    form,
    successMessage: isEdit
      ? 'The window has been amended.'
      : 'The window is on the calendar.',
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })

  const kind = form.watch('kind')
  const isBlackout = form.watch('isBlackout')
  const endMinute = form.watch('endMinute')
  const closesAtMidnight = endMinute === MINUTES_PER_DAY

  return (
    <Dialog
      open={state !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Amend this window' : 'A new window'}
          </DialogTitle>
          <DialogDescription>
            Times are wall-clock time in the zone named below — {chefName}
            &rsquo;s own clock, not yours.{' '}
            {isEdit
              ? 'What sort of rule this is cannot be changed; remove it and write a new one instead.'
              : ''}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            noValidate
            className="flex flex-col gap-5"
            onSubmit={form.handleSubmit(async (values) => {
              await execute(values)
            })}
          >
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>What sort of rule is this?</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={isEdit}
                      className="flex flex-col gap-3"
                    >
                      <RadioGroupField
                        value="RECURRING_WEEKLY"
                        label="It repeats every week"
                        description="Choose a weekday. The window is offered on that day, week after week."
                      />
                      <RadioGroupField
                        value="DATE_OVERRIDE"
                        label="It covers one date"
                        description="Choose a date. An override replaces the recurring windows under it for that day."
                      />
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {kind === 'RECURRING_WEEKLY' ? (
              <FormField
                control={form.control}
                name="dayOfWeek"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Weekday</FormLabel>
                    <Select
                      value={String(field.value)}
                      onValueChange={(next) => {
                        field.onChange(Number.parseInt(next, 10))
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a weekday" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {WEEKDAY_NAMES.map((name, index) => (
                          <SelectItem key={name} value={String(index)}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="specificDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      The calendar date this rule covers, read in{' '}
                      {form.watch('timeZone')}.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="startMinute"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Opens at</FormLabel>
                    <FormControl>
                      <Input
                        type="time"
                        step={300}
                        value={minutesToTimeValue(field.value)}
                        onChange={(event) => {
                          const minutes = timeValueToMinutes(event.target.value)

                          if (minutes !== null) {
                            field.onChange(minutes)
                          }
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      {field.value} minutes from midnight.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="endMinute"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Closes at</FormLabel>
                    <FormControl>
                      <Input
                        type="time"
                        step={300}
                        disabled={closesAtMidnight}
                        value={minutesToTimeValue(field.value)}
                        onChange={(event) => {
                          const minutes = timeValueToMinutes(event.target.value)

                          if (minutes !== null) {
                            field.onChange(minutes)
                          }
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      {closesAtMidnight
                        ? '1440 minutes from midnight — the window runs to the end of the day.'
                        : `${String(field.value)} minutes from midnight.`}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/*
             * A time control cannot express 24:00, and 00:00 already means the
             * start of the day. `endMinute = 1440` is the only way to say "runs
             * to the end of the day", so it gets its own switch rather than a
             * value the control would silently round.
             */}
            <SwitchField
              label="Closes at midnight"
              description="Run the window to the very end of the day. This is the only way to write a closing time of 24:00."
              checked={closesAtMidnight}
              onCheckedChange={(next) => {
                form.setValue('endMinute', next ? MINUTES_PER_DAY : 22 * 60, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }}
            />

            <FormField
              control={form.control}
              name="timeZone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Time zone</FormLabel>
                  <FormControl>
                    <Input
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </FormControl>
                  <FormDescription>
                    An IANA identifier such as {calendarTimeZone}. The window is
                    that clock: it survives the change to and from daylight
                    saving without moving.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <SwitchField
              label="This window closes the diary"
              description="A blackout subtracts from the calendar instead of adding to it, and wins over every rule beneath it."
              checked={isBlackout}
              onCheckedChange={(next) => {
                form.setValue('isBlackout', next, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }}
            />

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason{isBlackout ? '' : ' (optional)'}</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      maxLength={MAX_REASON_LENGTH}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormDescription>
                    {isBlackout
                      ? 'Required for a blackout: the concierge repeats this to a guest who asks why the evening is not on offer.'
                      : 'Shown to the concierge, never to a guest.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormDescription>
                    For the kitchen&rsquo;s own reference.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="effectiveFrom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Starts applying (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        value={field.value}
                        onChange={field.onChange}
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
                name="effectiveUntil"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stops applying (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        value={field.value}
                        onChange={field.onChange}
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

            <FormRootError />

            {error === null ? null : (
              <RefusalNotice
                failure={error}
                subject={`${chefName}'s calendar`}
              />
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="champagne"
                loading={isPending}
                loadingLabel="Saving the window"
              >
                {isEdit ? 'Save changes' : 'Add to the calendar'}
              </Button>
            </DialogFooter>

            <FormStatus>{statusMessage}</FormStatus>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteRuleDialog({
  rule,
  chefName,
  onClose,
}: {
  readonly rule: AvailabilityRuleRow | null
  readonly chefName: string
  readonly onClose: () => void
}): React.JSX.Element {
  const router = useRouter()
  const { execute, isPending, statusMessage, error } = useAction(
    deleteAvailabilityRule,
    {
      successMessage: 'The rule is off the calendar.',
      onSuccess: () => {
        onClose()
        router.refresh()
      },
    }
  )

  return (
    <Dialog
      open={rule !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this rule?</DialogTitle>
          <DialogDescription>
            {rule === null
              ? ''
              : `${
                  rule.isBlackout
                    ? 'Removing a blackout puts the time back on offer.'
                    : 'Removing a window takes the time off offer.'
                } Engagements already booked are untouched — they stay on ${chefName}'s calendar.`}
          </DialogDescription>
        </DialogHeader>

        {rule === null ? null : (
          <p className="rounded-md border border-ash bg-charcoal/60 px-3 py-2 font-sans text-sm text-parchment">
            {rule.kind === 'RECURRING_WEEKLY'
              ? (WEEKDAY_NAMES[rule.dayOfWeek ?? 0] ?? 'Every day')
              : rule.specificDate === null
                ? 'One date'
                : formatDateOnly(rule.specificDate)}
            {', '}
            <span className="tabular-nums">
              {describeMinuteWindow(rule.startMinute, rule.endMinute)}
            </span>{' '}
            {rule.timeZone}
          </p>
        )}

        {error === null ? null : (
          <RefusalNotice failure={error} subject={`${chefName}'s calendar`} />
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={isPending}
            loadingLabel="Removing the rule"
            onClick={() => {
              if (rule !== null) {
                void execute({ availabilityId: rule.id })
              }
            }}
          >
            Remove
          </Button>
        </DialogFooter>

        <FormStatus>{statusMessage}</FormStatus>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// 6. Reading a refusal
// =============================================================================

/**
 * The engine's refusals, as they survive the trip through `fieldErrors`.
 *
 * `conflictFailure` in `server/actions/booking.ts` files each refusal under the
 * control it belongs against and writes the engine's own sentence. The key
 * alone settles capacity and the interval faults; the overlaps and the
 * availability miss all land on `startsAt` and are told apart by their words.
 */
type ConflictKind =
  | 'CORE_OVERLAP'
  | 'BUFFER_OVERLAP'
  | 'CAPACITY'
  | 'OUTSIDE_AVAILABILITY'
  | 'STARTS_IN_THE_PAST'
  | 'INVALID_INTERVAL'
  | 'OTHER'

interface ConflictReason {
  readonly kind: ConflictKind
  readonly field: string
  /** The server's own sentence. Always shown; never paraphrased away. */
  readonly message: string
}

/** The prefix `conflictFailure` writes in front of every suggested time. */
const ALTERNATIVE_PREFIX = 'Try '

function classifyConflict(field: string, message: string): ConflictKind {
  if (field === 'bookingSlotId') {
    return 'CAPACITY'
  }

  if (field !== 'startsAt') {
    return 'INVALID_INTERVAL'
  }

  if (/cannot cook both at once/i.test(message)) {
    return 'CORE_OVERLAP'
  }

  if (/travel time collides|journey between them/i.test(message)) {
    return 'BUFFER_OVERLAP'
  }

  if (/availability|does not work at that time/i.test(message)) {
    return 'OUTSIDE_AVAILABILITY'
  }

  if (/already begun/i.test(message)) {
    return 'STARTS_IN_THE_PAST'
  }

  return 'OTHER'
}

interface ConflictPresentation {
  readonly title: string
  readonly remedy: string
  readonly icon: typeof CalendarX2
  readonly rail: string
}

/**
 * What each refusal means and what fixes it.
 *
 * The distinction between a core overlap and a buffer overlap is the reason
 * this table exists. They read identically in a list of times and are cured
 * differently: the first needs the engagement moved, the second usually needs
 * ten minutes taken off a travel buffer. An interface that says "unavailable"
 * for both has thrown that away.
 */
const CONFLICT_PRESENTATION: Readonly<
  Record<ConflictKind, ConflictPresentation>
> = {
  CORE_OVERLAP: {
    title: 'The chef is already cooking',
    remedy:
      'The two engagements themselves overlap. Move this one, or hand it to another chef — no buffer will absorb it.',
    icon: CalendarX2,
    rail: 'bg-claret/70',
  },
  BUFFER_OVERLAP: {
    title: 'The journey collides, not the cooking',
    remedy:
      'The engagements do not overlap; the travel time between them does. Shortening a buffer often fixes this without moving anything.',
    icon: Route,
    rail: 'bg-terracotta/70',
  },
  CAPACITY: {
    title: 'That sitting has no seat left',
    remedy:
      'Capacity is not a matter of timing — the same booking an hour later does not gain a seat. Choose a different window.',
    icon: Users,
    rail: 'bg-claret/70',
  },
  OUTSIDE_AVAILABILITY: {
    title: 'Outside the published availability',
    remedy:
      'Travel time is counted, so a dinner can fit while the journey either side of it does not. Open a window in the editor beside this, or move the engagement.',
    icon: CalendarOff,
    rail: 'bg-terracotta/70',
  },
  STARTS_IN_THE_PAST: {
    title: 'It has already begun',
    remedy:
      'Counting the travel before it, this engagement starts in the past. Choose a later time.',
    icon: History,
    rail: 'bg-stone/70',
  },
  INVALID_INTERVAL: {
    title: 'These times do not make a window',
    remedy:
      'Correct the marked field — the engagement must end after it begins, and preparation must not run away from it.',
    icon: CircleAlert,
    rail: 'bg-stone/70',
  },
  OTHER: {
    title: 'The calendar refused this time',
    remedy: 'Choose another time, or open a window for this one.',
    icon: CalendarX2,
    rail: 'bg-stone/70',
  },
}

interface ParsedRefusal {
  readonly reasons: readonly ConflictReason[]
  /** The engine's own suggested times, as it worded them. */
  readonly suggestions: readonly string[]
}

/** Split a `CONFLICT` failure back into reasons and suggestions. */
function parseRefusal(failure: ActionFailure): ParsedRefusal {
  const reasons: ConflictReason[] = []
  const suggestions: string[] = []
  const fieldErrors = failure.fieldErrors ?? {}

  for (const [field, messages] of Object.entries(fieldErrors)) {
    for (const message of messages) {
      if (field === 'startsAt' && message.startsWith(ALTERNATIVE_PREFIX)) {
        suggestions.push(
          message.slice(ALTERNATIVE_PREFIX.length).replace(/\.$/, '')
        )
        continue
      }

      reasons.push({
        kind: classifyConflict(field, message),
        field,
        message,
      })
    }
  }

  if (reasons.length === 0) {
    reasons.push({ kind: 'OTHER', field: 'startsAt', message: failure.error })
  }

  return { reasons, suggestions }
}

// =============================================================================
// 7. Alternatives that can actually be clicked
// =============================================================================

/** One conflict-free start the composer can move the whole engagement to. */
interface AlternativeChoice {
  readonly startsAt: Date
  readonly endsAt: Date
  readonly prepStartsAt: Date | null
  readonly shiftMs: number
}

interface TimingShape {
  readonly startsAt: Date
  readonly endsAt: Date
  readonly prepStartsAt: Date | null
  readonly travelBufferBeforeMinutes: number
  readonly travelBufferAfterMinutes: number
}

/** The engine's own suggestion span: two days back, a week forward. */
const SUGGESTION_LOOKBACK_MS = 2 * MS_PER_DAY
const SUGGESTION_LOOKAHEAD_MS = 7 * MS_PER_DAY
const SUGGESTION_LIMIT = 3

function mergeWindows(
  windows: readonly AvailabilityWindowView[]
): readonly { readonly start: number; readonly end: number }[] {
  const sorted = windows
    .map((window) => ({
      start: window.start.getTime(),
      end: window.end.getTime(),
    }))
    .filter((window) => window.end > window.start)
    .sort((a, b) => a.start - b.start)

  const merged: { start: number; end: number }[] = []

  for (const window of sorted) {
    const last = merged[merged.length - 1]

    if (last !== undefined && window.start <= last.end) {
      last.end = Math.max(last.end, window.end)
      continue
    }

    merged.push({ start: window.start, end: window.end })
  }

  return merged
}

/**
 * Concrete times the whole engagement could move to, as instants.
 *
 * ## Why this recomputes rather than parsing the engine's sentences
 *
 * The engine's suggestions reach the client as prose — `Try Sat, 15 Feb,
 * 19:00.` — because `ActionResult` carries no structured third arm for them.
 * Prose is not a thing a button can act on: a label formatted in the chef's
 * zone under the server's locale cannot be turned back into an instant without
 * guessing at both. So the sentences are shown exactly as the engine wrote them
 * — they are the authority — and the *clickable* times are recomputed here from
 * data the client can read for itself.
 *
 * The positions tried are the engine's own availability-derived ones: the start
 * of every published window, and the end of every window minus the engagement's
 * full occupied length. The booking is treated as rigid — preparation, service
 * and both travel buffers move together — exactly as `suggestAlternatives`
 * treats it, so a suggestion is the same evening at a different hour rather
 * than a compressed version of it.
 *
 * What is *not* reproduced is the engine's concurrency check against other
 * engagements, which the client cannot make. A suggestion offered here can
 * therefore still be refused; clicking it re-submits, and the refusal that
 * comes back replaces this one. That is a second click, not a dead end — which
 * is the whole difference between this and the word "unavailable".
 */
async function findAlternatives(
  staffProfileId: string,
  timing: TimingShape,
  now: Date
): Promise<readonly AlternativeChoice[]> {
  const serviceStart = timing.startsAt.getTime()
  const serviceEnd = timing.endsAt.getTime()
  const prepStart =
    timing.prepStartsAt === null ? serviceStart : timing.prepStartsAt.getTime()

  const occupiedStart =
    prepStart - timing.travelBufferBeforeMinutes * MS_PER_MINUTE
  const occupiedEnd =
    serviceEnd + timing.travelBufferAfterMinutes * MS_PER_MINUTE
  const durationMs = occupiedEnd - occupiedStart

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return []
  }

  const leadMs = serviceStart - occupiedStart
  const serviceMs = serviceEnd - serviceStart
  const prepLeadMs =
    timing.prepStartsAt === null ? null : serviceStart - prepStart

  const preview = await previewAvailabilityWindows({
    staffProfileId,
    range: {
      start: new Date(occupiedStart - SUGGESTION_LOOKBACK_MS),
      end: new Date(occupiedEnd + SUGGESTION_LOOKAHEAD_MS),
    },
  })

  if (!preview.ok) {
    return []
  }

  const merged = mergeWindows(preview.data.windows)
  const positions = new Set<number>()

  for (const window of merged) {
    for (const candidate of [window.start, window.end - durationMs]) {
      if (
        candidate >= window.start &&
        candidate + durationMs <= window.end &&
        candidate >= now.getTime()
      ) {
        positions.add(candidate)
      }
    }
  }

  return [...positions]
    .map((position) => {
      const startsAt = new Date(position + leadMs)

      return {
        startsAt,
        endsAt: new Date(startsAt.getTime() + serviceMs),
        prepStartsAt:
          prepLeadMs === null
            ? null
            : new Date(startsAt.getTime() - prepLeadMs),
        shiftMs: position - occupiedStart,
      }
    })
    .sort(
      (a, b) =>
        Math.abs(a.shiftMs) - Math.abs(b.shiftMs) || b.shiftMs - a.shiftMs
    )
    .slice(0, SUGGESTION_LIMIT)
}

// =============================================================================
// 8. The booking composer
// =============================================================================

const SERVICE_TYPE_LABELS: Readonly<Record<ServiceType, string>> = {
  IN_HOME_DINNER: 'Dinner at home',
  MEAL_PREP: 'Meal preparation',
  PRIVATE_EVENT: 'Private event',
  COOKING_CLASS: 'Cooking class',
  TASTING: 'Tasting',
  CATERING: 'Catering',
  CONSULTATION: 'Consultation',
  DELIVERY_DROP_OFF: 'Delivery drop-off',
}

export interface BookingComposerProps {
  readonly staffProfileId: string
  readonly chefName: string
  readonly calendarTimeZone: string
  /** A sensible first guess, chosen by the page from the view it is showing. */
  readonly defaultStartsAt: Date
}

/**
 * Place an engagement on the calendar, and read the refusal when one comes.
 *
 * The date-and-time controls are `datetime-local`, which means they hold *the
 * reader's* wall clock, not the chef's. That is a genuine hazard for a
 * dispatcher working a diary in another zone, so every instant is echoed back
 * underneath the control in the chef's own zone. Never assume the two agree.
 */
export function BookingComposer({
  staffProfileId,
  chefName,
  calendarTimeZone,
  defaultStartsAt,
}: BookingComposerProps): React.JSX.Element {
  const router = useRouter()
  const [alternatives, setAlternatives] = React.useState<
    readonly AlternativeChoice[]
  >([])
  const [isSearching, setIsSearching] = React.useState(false)

  const form = useForm<
    AppointmentCreateRawInput,
    unknown,
    AppointmentCreateInput
  >({
    resolver: zodResolver(appointmentCreateSchema),
    defaultValues: {
      clientProfileId: '',
      staffProfileId,
      serviceType: 'IN_HOME_DINNER',
      startsAt: toLocalDateTimeInputValue(defaultStartsAt),
      endsAt: toLocalDateTimeInputValue(
        new Date(defaultStartsAt.getTime() + 3 * 60 * MS_PER_MINUTE)
      ),
      travelBufferBeforeMinutes: 45,
      travelBufferAfterMinutes: 45,
      guestCount: 2,
      address: {
        line1: '',
        city: '',
        region: '',
        postalCode: '',
        country: 'CA',
      },
      chefNotes: '',
    },
  })

  const serviceType = form.watch('serviceType') ?? 'IN_HOME_DINNER'
  const needsAddress = ON_SITE_SERVICE_TYPES.includes(serviceType)

  const { execute, isPending, statusMessage, error } = useAction(
    requestAppointment,
    {
      form,
      successMessage: 'The engagement is on the calendar.',
      onSuccess: () => {
        setAlternatives([])
        router.refresh()
      },
      onError: () => {
        setAlternatives([])
      },
    }
  )

  const refusal = React.useMemo(
    () =>
      error === null || error.code !== 'CONFLICT' ? null : parseRefusal(error),
    [error]
  )

  /**
   * A refusal is the moment to go looking for somewhere else to put this. The
   * search runs once per refusal and is abandoned if the operator submits
   * again before it lands, so a stale set of times can never be shown beside a
   * fresh reason.
   */
  React.useEffect(() => {
    if (refusal === null) {
      return
    }

    const values = form.getValues()
    const startsAt = new Date(String(values.startsAt))
    const endsAt = new Date(String(values.endsAt))

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return
    }

    const prep =
      values.prepStartsAt === undefined || values.prepStartsAt === ''
        ? null
        : new Date(String(values.prepStartsAt))

    let abandoned = false
    setIsSearching(true)

    void findAlternatives(
      staffProfileId,
      {
        startsAt,
        endsAt,
        prepStartsAt:
          prep === null || Number.isNaN(prep.getTime()) ? null : prep,
        travelBufferBeforeMinutes: Number(
          values.travelBufferBeforeMinutes ?? 0
        ),
        travelBufferAfterMinutes: Number(values.travelBufferAfterMinutes ?? 0),
      },
      new Date()
    ).then(
      (found) => {
        if (!abandoned) {
          setAlternatives(found)
          setIsSearching(false)
        }
      },
      () => {
        if (!abandoned) {
          setAlternatives([])
          setIsSearching(false)
        }
      }
    )

    return () => {
      abandoned = true
    }
  }, [refusal, form, staffProfileId])

  const applyAlternative = React.useCallback(
    (choice: AlternativeChoice) => {
      form.setValue('startsAt', toLocalDateTimeInputValue(choice.startsAt), {
        shouldDirty: true,
      })
      form.setValue('endsAt', toLocalDateTimeInputValue(choice.endsAt), {
        shouldDirty: true,
      })

      if (choice.prepStartsAt !== null) {
        form.setValue(
          'prepStartsAt',
          toLocalDateTimeInputValue(choice.prepStartsAt),
          { shouldDirty: true }
        )
      }

      setAlternatives([])
      void form.handleSubmit(async (values) => {
        await execute(values)
      })()
    },
    [execute, form]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock aria-hidden="true" className="size-4 text-stone" />A
          new engagement
        </CardTitle>
        <CardDescription>
          The calendar checks this against {chefName}&rsquo;s published
          availability, the engagements already on the diary, and the travel
          time either side of each. If it says no, it says which of those it is.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Form {...form}>
          <form
            noValidate
            className="flex flex-col gap-5"
            onSubmit={form.handleSubmit(async (values) => {
              await execute(values)
            })}
          >
            <FormField
              control={form.control}
              name="clientProfileId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Household</FormLabel>
                  <FormControl>
                    <Input
                      value={String(field.value ?? '')}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Client profile id"
                    />
                  </FormControl>
                  <FormDescription>
                    The client profile this engagement is for. Copy it from the
                    household&rsquo;s record.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="serviceType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Service</FormLabel>
                  <Select
                    value={field.value ?? 'IN_HOME_DINNER'}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a service" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {serviceTypeSchema.options.map((option) => (
                        <SelectItem key={option} value={option}>
                          {SERVICE_TYPE_LABELS[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <InstantField
                control={form.control}
                name="startsAt"
                label="Service begins"
                timeZone={calendarTimeZone}
              />
              <InstantField
                control={form.control}
                name="endsAt"
                label="Service ends"
                timeZone={calendarTimeZone}
              />
            </div>

            <InstantField
              control={form.control}
              name="prepStartsAt"
              label="Preparation begins (optional)"
              timeZone={calendarTimeZone}
              description="Preparation occupies the chef just as the service does, and the calendar counts it when it looks for a collision."
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="travelBufferBeforeMinutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Travel before</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        numeric
                        min={0}
                        max={MAX_TRAVEL_BUFFER_MINUTES}
                        step={5}
                        value={String(field.value ?? 0)}
                        onChange={(event) => {
                          field.onChange(event.target.valueAsNumber)
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>Minutes.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="travelBufferAfterMinutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Travel after</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        numeric
                        min={0}
                        max={MAX_TRAVEL_BUFFER_MINUTES}
                        step={5}
                        value={String(field.value ?? 0)}
                        onChange={(event) => {
                          field.onChange(event.target.valueAsNumber)
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>Minutes.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="guestCount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Guests</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        numeric
                        min={MIN_GUEST_COUNT}
                        max={MAX_GUEST_COUNT}
                        value={String(field.value ?? MIN_GUEST_COUNT)}
                        onChange={(event) => {
                          field.onChange(event.target.valueAsNumber)
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>Dining.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {needsAddress ? (
              <fieldset className="flex flex-col gap-4 rounded-md border border-ash p-4">
                <legend className="px-1 font-sans text-xs tracking-[0.18em] text-stone uppercase">
                  Where we are cooking
                </legend>

                <FormField
                  control={form.control}
                  name="address.line1"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Street address</FormLabel>
                      <FormControl>
                        <Input
                          value={String(field.value ?? '')}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                          autoComplete="address-line1"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="address.city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>City</FormLabel>
                        <FormControl>
                          <Input
                            value={String(field.value ?? '')}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                            autoComplete="address-level2"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address.region"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Province or territory</FormLabel>
                        <FormControl>
                          <Input
                            value={String(field.value ?? '')}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                            autoComplete="address-level1"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address.postalCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Postal code</FormLabel>
                        <FormControl>
                          <Input
                            value={String(field.value ?? '')}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                            autoComplete="postal-code"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address.country"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Country</FormLabel>
                        <FormControl>
                          <Input
                            value={String(field.value ?? 'CA')}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                            autoComplete="country"
                          />
                        </FormControl>
                        <FormDescription>
                          Two-letter code, such as CA.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </fieldset>
            ) : null}

            <FormField
              control={form.control}
              name="chefNotes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note for the kitchen (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      value={String(field.value ?? '')}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormRootError />

            {error !== null && error.code !== 'CONFLICT' ? (
              <RefusalNotice
                failure={error}
                subject={`${chefName}'s calendar`}
              />
            ) : null}

            {refusal === null ? null : (
              <RefusalPanel
                refusal={refusal}
                alternatives={alternatives}
                isSearching={isSearching}
                timeZone={calendarTimeZone}
                onChoose={applyAlternative}
              />
            )}

            <Button
              type="submit"
              variant="champagne"
              loading={isPending}
              loadingLabel="Checking the calendar"
            >
              Place on the calendar
            </Button>

            <FormStatus>{statusMessage}</FormStatus>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

/**
 * A `datetime-local` control that also says what the chef's clock reads.
 *
 * Typed loosely over the three instant fields on purpose: they are the same
 * control three times, and giving each its own copy is how one of them ends up
 * missing the zone echo.
 */
function InstantField({
  control,
  name,
  label,
  timeZone,
  description,
}: {
  readonly control: ReturnType<
    typeof useForm<AppointmentCreateRawInput, unknown, AppointmentCreateInput>
  >['control']
  readonly name: 'startsAt' | 'endsAt' | 'prepStartsAt'
  readonly label: string
  readonly timeZone: string
  readonly description?: string
}): React.JSX.Element {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const raw = field.value
        const parsed =
          raw === undefined || raw === null || raw === ''
            ? null
            : new Date(raw instanceof Date ? raw.getTime() : String(raw))
        const inZone =
          parsed === null || Number.isNaN(parsed.getTime())
            ? null
            : formatInZone(parsed, timeZone)

        return (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <FormControl>
              <Input
                type="datetime-local"
                value={toLocalDateTimeInputValue(
                  raw instanceof Date || typeof raw === 'string' ? raw : ''
                )}
                onChange={field.onChange}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
              />
            </FormControl>
            <FormDescription>
              {inZone === null
                ? (description ?? 'Your own clock.')
                : `${inZone} in ${timeZone}.${description === undefined ? '' : ` ${description}`}`}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}

/**
 * The refusal, said in full.
 *
 * Every reason the engine gave is listed with its own icon, its own words and
 * its own remedy — one card each, so two reasons never merge into one vague
 * one. Beneath them sit the times the engagement could move to, as buttons.
 */
function RefusalPanel({
  refusal,
  alternatives,
  isSearching,
  timeZone,
  onChoose,
}: {
  readonly refusal: ParsedRefusal
  readonly alternatives: readonly AlternativeChoice[]
  readonly isSearching: boolean
  readonly timeZone: string
  readonly onChoose: (choice: AlternativeChoice) => void
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="refusal-heading"
      role="alert"
      className="flex flex-col gap-4 rounded-lg border border-ash bg-charcoal/70 p-4"
    >
      <h3
        id="refusal-heading"
        className="font-display text-lg font-light tracking-tight text-linen"
      >
        The calendar cannot take this — here is exactly why
      </h3>

      <ul className="flex flex-col gap-3">
        {refusal.reasons.map((reason, index) => {
          const presentation = CONFLICT_PRESENTATION[reason.kind]
          const Icon = presentation.icon

          return (
            <li
              key={`${reason.field}-${String(index)}`}
              className="flex items-start gap-3 rounded-md border border-ash bg-obsidian/50 p-3"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1 h-10 w-1 shrink-0 rounded-full',
                  presentation.rail
                )}
              />
              <Icon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-parchment"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-sans text-sm leading-tight font-medium text-linen">
                  {presentation.title}
                </p>
                <p className="font-sans text-xs leading-relaxed text-parchment">
                  {reason.message}
                </p>
                <p className="font-sans text-xs leading-relaxed text-stone">
                  {presentation.remedy}
                </p>
              </div>
            </li>
          )
        })}
      </ul>

      {refusal.suggestions.length === 0 ? null : (
        <p className="font-sans text-xs leading-relaxed text-stone">
          The calendar suggested{' '}
          <span className="text-parchment">
            {refusal.suggestions.join('; ')}
          </span>
          , read in {timeZone}.
        </p>
      )}

      <Separator />

      <div className="flex flex-col gap-2">
        <p
          id="alternatives-heading"
          className="font-sans text-xs tracking-[0.18em] text-stone uppercase"
        >
          Move the whole engagement to
        </p>

        {isSearching ? (
          <p className="font-sans text-xs text-stone" role="status">
            Looking for another time…
          </p>
        ) : alternatives.length === 0 ? (
          <p className="font-sans text-xs leading-relaxed text-stone">
            Nothing in the published availability over the next week can take
            this engagement at its current length. Open a window in the editor
            beside this, shorten the travel buffers, or choose a different chef.
          </p>
        ) : (
          <ul
            aria-labelledby="alternatives-heading"
            className="flex flex-col gap-2"
          >
            {alternatives.map((choice) => (
              <li key={choice.startsAt.toISOString()}>
                <Button
                  type="button"
                  variant="outline"
                  fullWidth
                  className="justify-between"
                  onClick={() => {
                    onChoose(choice)
                  }}
                >
                  <span className="tabular-nums">
                    {formatInZone(choice.startsAt, timeZone)}
                  </span>
                  <span className="font-sans text-xs text-stone">
                    {describeShift(choice.shiftMs)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="font-sans text-xs leading-relaxed text-stone">
          Choosing one moves preparation, service and both travel buffers
          together, and asks the calendar again.
        </p>
      </div>
    </section>
  )
}
