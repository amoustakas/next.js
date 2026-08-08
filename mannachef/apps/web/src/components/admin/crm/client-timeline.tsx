// mannachef/apps/web/src/components/admin/crm/client-timeline.tsx
'use client'

/**
 * The interaction timeline on a client's detail page.
 *
 * Two record types share one feed — a `ClientNote` (something staff wrote
 * about the household) and an `InteractionLog` entry (something that actually
 * happened with the household: a call, an email, a visit). Pinned notes are
 * lifted into their own strip above the feed; everything else is merged and
 * sorted newest first by whichever timestamp is the record's own — `createdAt`
 * for a note, `occurredAt` for a logged exchange — so a note written today
 * about a call from last week sits where it was actually written, not where
 * the call happened.
 *
 * ## Visibility is not decoration
 *
 * `NoteVisibility` decides who may ever read a note again, and three of its
 * four values — `PRIVATE`, `STAFF`, `ADMIN_ONLY` — are things a client must
 * never see. Every note in this feed carries a badge stating which one it is,
 * with its own colour and icon, so a chef scanning the record cannot mistake
 * an internal note for one the household has already read. `CLIENT_VISIBLE`
 * is the only value that gets the "client can see this" framing; the other
 * three all read as some flavour of "staff only."
 *
 * ## Two forms, one shared shape
 *
 * "Add a note" and "Log an interaction" are both self-contained dialogs, each
 * with its own trigger, form, and submit — the same shape
 * `<ManualInvoiceForm>` uses. `clientProfileId` is seeded into both forms as a
 * default value and never rendered as a field, exactly as the pipeline
 * board's churn and follow-up dialogs seed theirs. A successful save calls
 * `router.refresh()`, which re-runs the server reads on
 * `app/(admin)/admin/clients/[id]/page.tsx` and repopulates this component's
 * props with the new record.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  Eye,
  EyeOff,
  History,
  Lock,
  Mail,
  MessageSquare,
  MessagesSquare,
  Phone,
  Pin,
  Plus,
  Smartphone,
  StickyNote,
  Users,
  type LucideIcon,
} from 'lucide-react'

import {
  clientNoteCreateSchema,
  interactionLogCreateSchema,
  MAX_INTERACTION_BODY_LENGTH,
  MAX_NOTE_BODY_LENGTH,
  type ClientNoteCreateInput,
  type ClientNoteCreateRawInput,
  type InteractionChannel,
  type InteractionDirection,
  type InteractionLogCreateInput,
  type InteractionLogCreateRawInput,
  type NoteVisibility,
} from '@mannachef/validators'

import { createClientNote, logInteraction } from '@/server/actions/crm'
import { useAction, type DescribedActionFailure } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'
import { cn } from '@/lib/utils'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CheckboxField } from '@/components/ui/checkbox'
import { DateTime } from '@/components/ui/date-time'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
  FormStatus,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

// =============================================================================
// 1. View models — what this component reads off a note or an exchange
// =============================================================================

/** A `ClientNote`, reduced to what the timeline renders. */
export interface ClientNoteEntry {
  readonly id: string
  readonly authorName: string | null
  readonly body: string
  readonly pinned: boolean
  readonly visibility: NoteVisibility
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** An `InteractionLog` row, reduced to what the timeline renders. */
export interface InteractionEntry {
  readonly id: string
  readonly loggedByName: string | null
  readonly channel: InteractionChannel
  readonly direction: InteractionDirection
  readonly subject: string | null
  readonly body: string | null
  readonly occurredAt: Date
  readonly durationMinutes: number | null
}

export interface ClientTimelineProps {
  readonly clientProfileId: string
  readonly clientName: string
  readonly notes: readonly ClientNoteEntry[]
  readonly interactions: readonly InteractionEntry[]
}

// =============================================================================
// 2. Vocabulary
// =============================================================================

const VISIBILITY_META: Readonly<
  Record<
    NoteVisibility,
    {
      readonly label: string
      readonly description: string
      readonly icon: LucideIcon
      readonly badgeVariant: BadgeProps['variant']
    }
  >
> = {
  CLIENT_VISIBLE: {
    label: 'Client-visible',
    description: 'The household can read this in their portal.',
    icon: Eye,
    badgeVariant: 'success',
  },
  STAFF: {
    label: 'Staff only',
    description: 'Any chef or staff member — never the client.',
    icon: EyeOff,
    badgeVariant: 'muted',
  },
  ADMIN_ONLY: {
    label: 'Admin only',
    description: 'Admins and above only — never the client.',
    icon: Lock,
    badgeVariant: 'warning',
  },
  PRIVATE: {
    label: 'Private',
    description: 'You and super admins only — never the client.',
    icon: Lock,
    badgeVariant: 'destructive',
  },
}

const VISIBILITY_OPTIONS: readonly NoteVisibility[] = [
  'CLIENT_VISIBLE',
  'STAFF',
  'ADMIN_ONLY',
  'PRIVATE',
]

const CHANNEL_META: Readonly<
  Record<
    InteractionChannel,
    { readonly label: string; readonly icon: LucideIcon }
  >
> = {
  EMAIL: { label: 'Email', icon: Mail },
  PHONE: { label: 'Phone call', icon: Phone },
  SMS: { label: 'Text message', icon: MessageSquare },
  IN_APP: { label: 'In-app message', icon: Smartphone },
  IN_PERSON: { label: 'In person', icon: Users },
}

const CHANNEL_OPTIONS: readonly InteractionChannel[] = [
  'EMAIL',
  'PHONE',
  'SMS',
  'IN_APP',
  'IN_PERSON',
]

const DIRECTION_META: Readonly<
  Record<
    InteractionDirection,
    { readonly label: string; readonly icon: LucideIcon }
  >
> = {
  INBOUND: { label: 'Inbound — they reached out', icon: ArrowDownLeft },
  OUTBOUND: { label: 'Outbound — we reached out', icon: ArrowUpRight },
}

const DIRECTION_OPTIONS: readonly InteractionDirection[] = [
  'INBOUND',
  'OUTBOUND',
]

/** Only a call or a visit has a duration. Mirrors the server-side rule in
 *  `interactionLogCreateSchema`. */
function channelHasDuration(channel: InteractionChannel): boolean {
  return channel === 'PHONE' || channel === 'IN_PERSON'
}

// =============================================================================
// 3. The merged feed
// =============================================================================

interface NoteFeedItem {
  readonly kind: 'NOTE'
  readonly sortAt: Date
  readonly note: ClientNoteEntry
}

interface InteractionFeedItem {
  readonly kind: 'INTERACTION'
  readonly sortAt: Date
  readonly interaction: InteractionEntry
}

type FeedItem = NoteFeedItem | InteractionFeedItem

function buildFeed(
  notes: readonly ClientNoteEntry[],
  interactions: readonly InteractionEntry[]
): readonly FeedItem[] {
  const items: FeedItem[] = [
    ...notes
      .filter((note) => !note.pinned)
      .map((note): NoteFeedItem => ({
        kind: 'NOTE',
        sortAt: note.createdAt,
        note,
      })),
    ...interactions.map((interaction): InteractionFeedItem => ({
      kind: 'INTERACTION',
      sortAt: interaction.occurredAt,
      interaction,
    })),
  ]

  return items.sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime())
}

// =============================================================================
// 4. The component
// =============================================================================

export function ClientTimeline({
  clientProfileId,
  clientName,
  notes,
  interactions,
}: ClientTimelineProps): React.JSX.Element {
  const pinnedNotes = React.useMemo(
    () =>
      [...notes]
        .filter((note) => note.pinned)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    [notes]
  )

  const feed = React.useMemo(
    () => buildFeed(notes, interactions),
    [notes, interactions]
  )

  return (
    <section
      aria-labelledby="client-timeline-heading"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2
            id="client-timeline-heading"
            className="flex items-center gap-2 font-display text-2xl leading-tight font-medium tracking-tight text-linen"
          >
            <History aria-hidden="true" className="size-5 text-stone" />
            Interaction timeline
          </h2>
          <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
            Every note kept on {clientName} and every exchange logged with them,
            newest first. Visibility is marked on every note — only{' '}
            <span className="text-linen">client-visible</span> notes ever reach
            their portal.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LogInteractionDialog
            clientProfileId={clientProfileId}
            clientName={clientName}
          />
          <AddNoteDialog
            clientProfileId={clientProfileId}
            clientName={clientName}
          />
        </div>
      </div>

      {pinnedNotes.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase">
            <Pin aria-hidden="true" className="size-3.5" />
            Pinned
          </h3>
          <ul className="flex flex-col gap-3">
            {pinnedNotes.map((note) => (
              <li key={note.id}>
                <NoteCard note={note} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {feed.length === 0 && pinnedNotes.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing recorded yet"
          description="Notes and logged exchanges with this client will appear here."
        />
      ) : feed.length === 0 ? null : (
        <ol className="flex flex-col gap-3">
          {feed.map((item) =>
            item.kind === 'NOTE' ? (
              <li key={`note-${item.note.id}`}>
                <NoteCard note={item.note} />
              </li>
            ) : (
              <li key={`interaction-${item.interaction.id}`}>
                <InteractionCard interaction={item.interaction} />
              </li>
            )
          )}
        </ol>
      )}
    </section>
  )
}

// =============================================================================
// 5. Visibility badge
// =============================================================================

function VisibilityBadge({
  visibility,
}: {
  readonly visibility: NoteVisibility
}) {
  const meta = VISIBILITY_META[visibility]
  const Icon = meta.icon

  return (
    <Badge
      variant={meta.badgeVariant}
      title={meta.description}
      srPrefix="Visibility: "
    >
      <Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  )
}

// =============================================================================
// 6. A note card
// =============================================================================

function NoteCard({ note }: { readonly note: ClientNoteEntry }) {
  return (
    <Card variant={note.pinned ? 'accent' : 'default'} padded>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <StickyNote
            aria-hidden="true"
            className="size-4 shrink-0 text-stone"
          />
          <span className="font-sans text-sm font-medium text-linen">
            {note.authorName ?? 'A staff member'}
          </span>
          {note.pinned ? (
            <Badge variant="outline" className="gap-1">
              <Pin aria-hidden="true" className="size-3" />
              Pinned
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VisibilityBadge visibility={note.visibility} />
          <DateTime value={note.createdAt} format="relative" tone="subtle" />
        </div>
      </div>
      <p className="mt-3 font-sans text-sm leading-relaxed whitespace-pre-wrap text-parchment">
        {note.body}
      </p>
      {note.updatedAt.getTime() !== note.createdAt.getTime() ? (
        <p className="mt-2 font-sans text-xs text-stone">
          Edited{' '}
          <DateTime value={note.updatedAt} format="relative" tone="subtle" />
        </p>
      ) : null}
    </Card>
  )
}

// =============================================================================
// 7. An interaction card
// =============================================================================

function InteractionCard({
  interaction,
}: {
  readonly interaction: InteractionEntry
}) {
  const channelMeta = CHANNEL_META[interaction.channel]
  const directionMeta = DIRECTION_META[interaction.direction]
  const ChannelIcon = channelMeta.icon
  const DirectionIcon = directionMeta.icon

  return (
    <Card variant="quiet" padded>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <ChannelIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-stone"
          />
          <span className="font-sans text-sm font-medium text-linen">
            {channelMeta.label}
          </span>
          <Badge variant="outline" className="gap-1">
            <DirectionIcon aria-hidden="true" className="size-3" />
            <span className="sr-only">Direction: </span>
            {interaction.direction === 'INBOUND' ? 'Inbound' : 'Outbound'}
          </Badge>
          {interaction.durationMinutes === null ? null : (
            <Badge variant="muted" numeric className="gap-1">
              <Clock aria-hidden="true" className="size-3" />
              {interaction.durationMinutes} min
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-xs text-stone">
            {interaction.loggedByName ?? 'A staff member'}
          </span>
          <DateTime
            value={interaction.occurredAt}
            format="relative"
            tone="subtle"
          />
        </div>
      </div>
      {interaction.subject === null ? null : (
        <p className="mt-3 font-sans text-sm font-medium text-linen">
          {interaction.subject}
        </p>
      )}
      {interaction.body === null ? null : (
        <p className="mt-1.5 font-sans text-sm leading-relaxed whitespace-pre-wrap text-parchment">
          {interaction.body}
        </p>
      )}
    </Card>
  )
}

// =============================================================================
// 8. Shared failure notice
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
// 9. Add note dialog
// =============================================================================

function AddNoteDialog({
  clientProfileId,
  clientName,
}: {
  readonly clientProfileId: string
  readonly clientName: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
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
        <Button variant="outline">
          <Plus aria-hidden="true" />
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a note on {clientName}</DialogTitle>
          <DialogDescription>
            Written for colleagues. Choose visibility carefully — three of the
            four levels are never shown to the client.
          </DialogDescription>
        </DialogHeader>
        <AddNoteForm
          key={instance}
          clientProfileId={clientProfileId}
          onCancel={() => setOpen(false)}
          onCreated={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function AddNoteForm({
  clientProfileId,
  onCancel,
  onCreated,
}: {
  readonly clientProfileId: string
  readonly onCancel: () => void
  readonly onCreated: () => void
}) {
  const form = useForm<
    ClientNoteCreateRawInput,
    unknown,
    ClientNoteCreateInput
  >({
    resolver: zodResolver(clientNoteCreateSchema),
    defaultValues: {
      clientProfileId,
      body: '',
      pinned: false,
      visibility: 'STAFF',
    },
  })

  const action = useAction(createClientNote, {
    form,
    successMessage: 'Note saved.',
    onSuccess: onCreated,
  })

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => action.execute(values))}
        className="flex flex-col gap-4"
      >
        <fieldset disabled={action.isPending} className="contents">
          <legend className="sr-only">Note details</legend>

          <FormField
            control={form.control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Note</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    rows={5}
                    maxLength={MAX_NOTE_BODY_LENGTH}
                    placeholder="What should the next person reading this record know?"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="visibility"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Visibility</FormLabel>
                <Select
                  value={field.value ?? 'STAFF'}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {VISIBILITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {VISIBILITY_META[option].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="font-sans text-xs leading-relaxed text-stone">
                  {VISIBILITY_META[field.value ?? 'STAFF'].description}
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="pinned"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <CheckboxField
                    checked={field.value === true}
                    onCheckedChange={(checked) =>
                      field.onChange(checked === true)
                    }
                    label="Pin to the top of the record"
                    description="Pinned notes stay above the timeline until unpinned."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormRootError />
          {action.failure === null ? null : (
            <ActionFailureNotice failure={action.failure} />
          )}
          <FormStatus>{action.statusMessage}</FormStatus>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="champagne"
              loading={action.isPending}
            >
              Save note
            </Button>
          </DialogFooter>
        </fieldset>
      </form>
    </Form>
  )
}

// =============================================================================
// 10. Log interaction dialog
// =============================================================================

function LogInteractionDialog({
  clientProfileId,
  clientName,
}: {
  readonly clientProfileId: string
  readonly clientName: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
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
          <MessagesSquare aria-hidden="true" />
          Log interaction
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log an exchange with {clientName}</DialogTitle>
          <DialogDescription>
            A record of something that actually happened — a call, an email, a
            visit. Not for a note to yourself; that belongs in "Add note".
          </DialogDescription>
        </DialogHeader>
        <LogInteractionForm
          key={instance}
          clientProfileId={clientProfileId}
          onCancel={() => setOpen(false)}
          onCreated={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** `datetime-local` holds a wall-clock string with no zone; interpreted in the
 *  browser's own zone by `new Date(...)`, which is exactly what an admin
 *  logging "when did this happen" from their own desk means. */
function toLocalDateTimeInputValue(value: Date | undefined): string {
  if (value === undefined || Number.isNaN(value.getTime())) {
    return ''
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function LogInteractionForm({
  clientProfileId,
  onCancel,
  onCreated,
}: {
  readonly clientProfileId: string
  readonly onCancel: () => void
  readonly onCreated: () => void
}) {
  const form = useForm<
    InteractionLogCreateRawInput,
    unknown,
    InteractionLogCreateInput
  >({
    resolver: zodResolver(interactionLogCreateSchema),
    defaultValues: {
      clientProfileId,
      channel: 'EMAIL',
      direction: 'OUTBOUND',
      subject: '',
      body: '',
      occurredAt: undefined,
      durationMinutes: null,
      markAsContacted: true,
    },
  })

  const channel = form.watch('channel')
  const hasDuration = channelHasDuration(channel ?? 'EMAIL')

  const action = useAction(logInteraction, {
    form,
    successMessage: 'Exchange logged.',
    onSuccess: onCreated,
  })

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => action.execute(values))}
        className="flex flex-col gap-4"
      >
        <fieldset disabled={action.isPending} className="contents">
          <legend className="sr-only">Exchange details</legend>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="channel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Channel</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value)
                      if (!channelHasDuration(value as InteractionChannel)) {
                        form.setValue('durationMinutes', null)
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CHANNEL_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {CHANNEL_META[option].label}
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
              name="direction"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Direction</FormLabel>
                  <Select
                    value={field.value ?? 'OUTBOUND'}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DIRECTION_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {DIRECTION_META[option].label}
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
            name="subject"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Summary</FormLabel>
                <FormControl>
                  <Input
                    value={field.value ?? ''}
                    onChange={(event) => {
                      const raw = event.target.value
                      field.onChange(raw.trim().length === 0 ? null : raw)
                    }}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    maxLength={280}
                    placeholder="One line — what this exchange was about"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Details</FormLabel>
                <FormControl>
                  <Textarea
                    value={field.value ?? ''}
                    onChange={(event) => {
                      const raw = event.target.value
                      field.onChange(raw.trim().length === 0 ? null : raw)
                    }}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    rows={4}
                    maxLength={MAX_INTERACTION_BODY_LENGTH}
                    placeholder="What was said, decided, or promised"
                  />
                </FormControl>
                <p className="font-sans text-xs leading-relaxed text-stone">
                  A summary, a detail, or both — at least one is needed.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="occurredAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>When</FormLabel>
                  <FormControl>
                    <Input
                      type="datetime-local"
                      max={toLocalDateTimeInputValue(new Date())}
                      value={toLocalDateTimeInputValue(
                        typeof field.value === 'string'
                          ? new Date(field.value)
                          : (field.value as Date | undefined)
                      )}
                      onChange={(event) => {
                        const raw = event.target.value
                        field.onChange(
                          raw.length === 0
                            ? undefined
                            : new Date(raw).toISOString()
                        )
                      }}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <p className="font-sans text-xs leading-relaxed text-stone">
                    Leave blank for just now.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="durationMinutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Duration (minutes)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      numeric
                      min={1}
                      step={1}
                      disabled={!hasDuration}
                      value={field.value ?? ''}
                      onChange={(event) => {
                        const raw = event.target.value
                        field.onChange(raw === '' ? null : Number(raw))
                      }}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      placeholder={
                        hasDuration ? 'e.g. 15' : 'Calls and visits only'
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="markAsContacted"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <CheckboxField
                    checked={field.value === true}
                    onCheckedChange={(checked) =>
                      field.onChange(checked === true)
                    }
                    label="Counts as contact with this client"
                    description="Moves the client's last-contacted date forward. Leave unchecked for an automated or informational message."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormRootError />
          {action.failure === null ? null : (
            <ActionFailureNotice failure={action.failure} />
          )}
          <FormStatus>{action.statusMessage}</FormStatus>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="champagne"
              loading={action.isPending}
            >
              Log exchange
            </Button>
          </DialogFooter>
        </fieldset>
      </form>
    </Form>
  )
}
