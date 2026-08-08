// mannachef/apps/web/src/components/admin/intake/consultation-review.tsx
'use client'

/**
 * The interactive half of a household's intake record.
 *
 * `app/(admin)/admin/intake/page.tsx` is the Server Component: it resolves the
 * queue, the selected questionnaire, the household, and its consultations, and
 * hands all of it here as plain data. Everything a concierge actually *does* —
 * write up an interview, run the compatibility rubric, convert a prospect —
 * lives in this file, because all three are mutations that need pending
 * state, inline field errors, and a live region.
 *
 * The allergy panel is the one piece of this screen that is not optional to
 * notice. It is rendered first, full width, with its own border colour and a
 * heading a size larger than anything else on the page — a personal-chef
 * product that lets an allergy scroll past as a grey tag is a liability, not
 * a design choice.
 */

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChefHat,
  Dog,
  Gauge,
  Home,
  Mail,
  MapPin,
  Phone,
  Sparkles,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'

import {
  PROSPECT_CONVERSION_OUTCOMES,
  PROSPECT_CONVERSION_STAGES,
  PROSPECT_CONVERSION_STATUSES,
  consultationInterviewUpdateSchema,
  prospectConversionSchema,
  type ClientStatus,
  type ConsultationInterviewUpdateInput,
  type ConsultationOutcome,
  type ContactMethod,
  type DeliveryFrequency,
  type OnboardingStage,
  type ProspectConversionInput,
} from '@mannachef/validators'

import { cn, FOCUS_RING } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { useAction } from '@/lib/action-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  convertProspect,
  recordConsultationNotes,
  scoreConsultationCompatibility,
} from '@/server/actions/intake'

// =============================================================================
// 1. Shapes
//
// `IntakeFormView`, `ConsultationView` and `ClientProfileView` are internal
// types of `server/actions/intake.ts` and `server/actions/client.ts` — not
// exported, and this module is not on the "grep the action file" list. These
// mirror them structurally, field for field, the same way
// `components/admin/crm/pipeline-board.tsx` mirrors `PipelineClientView`.
// =============================================================================

export interface IntakeQuestionnaireSummary {
  readonly id: string
  readonly clientProfileId: string
  readonly householdSize: number
  readonly adults: number
  readonly children: number
  readonly allergies: readonly string[]
  readonly dislikes: readonly string[]
  readonly cuisinePreferences: readonly string[]
  readonly kitchenEquipment: readonly string[]
  readonly favouriteDishes: readonly string[]
  readonly hasPets: boolean
  readonly petsNote: string | null
  readonly deliveryFrequency: DeliveryFrequency
  readonly budgetPerMealCents: number | null
  readonly currency: string
  readonly serviceAddress: {
    readonly line1: string | null
    readonly line2: string | null
    readonly city: string | null
    readonly region: string | null
    readonly postalCode: string | null
    readonly country: string | null
  } | null
  readonly serviceAccessNotes: string | null
  readonly preferredContactMethod: ContactMethod
  readonly preferredCookDays: readonly string[]
  readonly notes: string | null
  readonly dietaryPreferences: readonly {
    readonly tagId: string
    readonly slug: string
    readonly name: string
    readonly kind: string
  }[]
  readonly submittedAt: Date | string | null
}

export interface HouseholdSummary {
  readonly id: string
  readonly accountName: string | null
  readonly accountEmail: string | null
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly phone: string | null
  readonly status: ClientStatus
}

export interface ConsultationSummary {
  readonly id: string
  readonly clientProfileId: string
  readonly staffProfileId: string | null
  readonly scheduledFor: Date | string
  readonly durationMinutes: number
  readonly location: string | null
  readonly meetingUrl: string | null
  readonly startedAt: Date | string | null
  readonly completedAt: Date | string | null
  readonly compatibilityScore: number | null
  readonly notes: string | null
  readonly chefSummary: string | null
  readonly outcome: ConsultationOutcome
  readonly followUpAt: Date | string | null
  readonly convertedToClientAt: Date | string | null
}

interface ScoreComponentView {
  readonly label: string
  readonly awarded: number
  readonly available: number
  readonly reason: string
}

interface ConversionResult {
  readonly status: ClientStatus
  readonly onboardingStage: OnboardingStage
  readonly convertedAt: Date | string | null
  readonly alreadyConverted: boolean
}

export interface ConsultationReviewProps {
  readonly form: IntakeQuestionnaireSummary
  readonly household: HouseholdSummary
  readonly consultations: readonly ConsultationSummary[]
}

// =============================================================================
// 2. Vocabulary
// =============================================================================

const CLIENT_STATUS_LABEL: Readonly<Record<ClientStatus, string>> = {
  PROSPECT: 'Prospect',
  LEAD_QUALIFIED: 'Lead qualified',
  ACTIVE_SUBSCRIBER: 'Active subscriber',
  PAUSED: 'Paused',
  CHURNED: 'Churned',
}

type BadgeTone =
  | 'default'
  | 'champagne'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'muted'
  | 'outline'

const CLIENT_STATUS_BADGE_TONE: Readonly<Record<ClientStatus, BadgeTone>> = {
  PROSPECT: 'muted',
  LEAD_QUALIFIED: 'outline',
  ACTIVE_SUBSCRIBER: 'success',
  PAUSED: 'warning',
  CHURNED: 'destructive',
}

const CONSULTATION_OUTCOME_VALUES: readonly ConsultationOutcome[] = [
  'PENDING',
  'CONVERTED',
  'DECLINED_BY_CLIENT',
  'DECLINED_BY_CHEF',
  'NO_SHOW',
  'RESCHEDULED',
  'FOLLOW_UP_REQUIRED',
]

const CONSULTATION_OUTCOME_LABEL: Readonly<
  Record<ConsultationOutcome, string>
> = {
  PENDING: 'Pending',
  CONVERTED: 'Converted',
  DECLINED_BY_CLIENT: 'Declined by client',
  DECLINED_BY_CHEF: 'Declined by chef',
  NO_SHOW: 'No-show',
  RESCHEDULED: 'Rescheduled',
  FOLLOW_UP_REQUIRED: 'Follow-up required',
}

const CONSULTATION_OUTCOME_BADGE_TONE: Readonly<
  Record<ConsultationOutcome, BadgeTone>
> = {
  PENDING: 'outline',
  CONVERTED: 'success',
  DECLINED_BY_CLIENT: 'muted',
  DECLINED_BY_CHEF: 'muted',
  NO_SHOW: 'destructive',
  RESCHEDULED: 'warning',
  FOLLOW_UP_REQUIRED: 'warning',
}

const ONBOARDING_STAGE_LABEL: Readonly<Record<OnboardingStage, string>> = {
  INVITED: 'Invited',
  ACCOUNT_CREATED: 'Account created',
  INTAKE_SUBMITTED: 'Intake submitted',
  CONSULTATION_SCHEDULED: 'Consultation scheduled',
  CONSULTATION_COMPLETED: 'Consultation completed',
  PLAN_SELECTED: 'Plan selected',
  PAYMENT_CONFIRMED: 'Payment confirmed',
  FIRST_APPOINTMENT_BOOKED: 'First appointment booked',
  ACTIVATED: 'Activated',
  ABANDONED: 'Abandoned',
}

const DELIVERY_FREQUENCY_LABEL: Readonly<Record<DeliveryFrequency, string>> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every two weeks',
  MONTHLY: 'Monthly',
  ON_DEMAND: 'On demand',
}

const CONTACT_METHOD_LABEL: Readonly<Record<ContactMethod, string>> = {
  EMAIL: 'Email',
  PHONE: 'Phone call',
  SMS: 'Text message',
  IN_APP: 'In-app message',
}

/** Sentinel for "leave the onboarding stage unchanged" — Radix `<Select>` items
 *  cannot carry an empty-string value. */
const NO_STAGE_CHANGE = '__NO_STAGE_CHANGE__'

function resolveHouseholdName(household: HouseholdSummary): string {
  return (
    household.preferredName ??
    household.displayName ??
    household.accountName ??
    household.accountEmail ??
    'This household'
  )
}

/** `yyyy-mm-dd` for a native `<input type="date">`, from whatever shape a
 *  timestamp arrives in — a `Date`, an ISO string, or nothing at all. */
function toDateInputValue(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return ''
  }

  const date = typeof value === 'string' ? new Date(value) : value

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

export function ClientStatusBadge({
  status,
}: {
  readonly status: ClientStatus
}): React.JSX.Element {
  return (
    <Badge variant={CLIENT_STATUS_BADGE_TONE[status]} numeric={false}>
      {CLIENT_STATUS_LABEL[status]}
    </Badge>
  )
}

// =============================================================================
// 3. The allergy panel — the one thing on this screen that must not be missed
// =============================================================================

function AllergyPanel({
  form,
}: {
  readonly form: IntakeQuestionnaireSummary
}): React.JSX.Element {
  const allergenTags = form.dietaryPreferences
    .filter((tag) => tag.kind === 'ALLERGEN')
    .map((tag) => tag.name)

  const combined = Array.from(
    new Set(
      [...form.allergies, ...allergenTags]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  )

  const hasAllergies = combined.length > 0

  return (
    <section
      aria-labelledby="allergy-heading"
      className={cn(
        'flex items-start gap-4 rounded-lg border-2 p-6',
        hasAllergies ? 'border-claret bg-claret/10' : 'border-sage/60 bg-sage/8'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-full border-2',
          hasAllergies ? 'border-claret text-claret-ink' : 'border-sage text-sage-ink'
        )}
      >
        <AlertTriangle className="size-6" />
      </span>
      <div className="flex flex-col gap-2">
        <h2
          id="allergy-heading"
          className="font-display text-2xl leading-tight font-semibold tracking-tight text-linen"
        >
          {hasAllergies
            ? 'Allergies — read before cooking'
            : 'No known allergies recorded'}
        </h2>
        {hasAllergies ? (
          <ul
            className="flex flex-wrap gap-2"
            aria-label="Recorded allergies and allergens"
          >
            {combined.map((allergy) => (
              <li key={allergy}>
                <Badge
                  variant="destructive"
                  className="px-3 py-1 text-sm font-semibold"
                >
                  {allergy}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="max-w-prose font-sans text-sm leading-relaxed text-parchment">
            The household did not report any allergies on their questionnaire.
            Confirm at the interview before assuming there are none — this field
            drives what a chef is allowed to cook for them.
          </p>
        )}
      </div>
    </section>
  )
}

// =============================================================================
// 4. Household header and questionnaire detail
// =============================================================================

function HouseholdHeader({
  form,
  household,
}: {
  readonly form: IntakeQuestionnaireSummary
  readonly household: HouseholdSummary
}): React.JSX.Element {
  const name = resolveHouseholdName(household)

  return (
    <header className="flex flex-col gap-2 border-b border-ash pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-2xl leading-tight font-medium tracking-tight text-linen">
          {name}
        </h2>
        <ClientStatusBadge status={household.status} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 font-sans text-sm text-parchment">
        {household.accountEmail === null ? null : (
          <span className="inline-flex items-center gap-1.5">
            <Mail aria-hidden="true" className="size-3.5 text-stone" />
            {household.accountEmail}
          </span>
        )}
        {household.phone === null ? null : (
          <span className="inline-flex items-center gap-1.5">
            <Phone aria-hidden="true" className="size-3.5 text-stone" />
            {household.phone}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock aria-hidden="true" className="size-3.5 text-stone" />
          Submitted{' '}
          <DateTime value={form.submittedAt} format="relative" tone="muted" />
        </span>
      </div>
    </header>
  )
}

function DetailItem({
  icon: Icon,
  label,
  children,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 font-sans text-xs font-medium tracking-wide text-stone uppercase">
        <Icon aria-hidden="true" className="size-3.5" />
        {label}
      </span>
      <span className="font-sans text-sm leading-relaxed text-linen">
        {children}
      </span>
    </div>
  )
}

function QuestionnaireDetails({
  form,
}: {
  readonly form: IntakeQuestionnaireSummary
}): React.JSX.Element {
  const address = form.serviceAddress
  const addressLine =
    address === null
      ? null
      : [
          address.line1,
          address.line2,
          address.city,
          address.region,
          address.postalCode,
          address.country,
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(', ')
  const otherTags = form.dietaryPreferences.filter(
    (tag) => tag.kind !== 'ALLERGEN'
  )

  return (
    <Card variant="default" padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={2}>Questionnaire</CardTitle>
        <CardDescription>
          What the household told us before their consultation.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-x-6 gap-y-5 p-0 sm:grid-cols-2 lg:grid-cols-3">
        <DetailItem icon={Home} label="Household">
          {form.adults} adult{form.adults === 1 ? '' : 's'}
          {form.children > 0
            ? `, ${String(form.children)} child${form.children === 1 ? '' : 'ren'}`
            : ''}{' '}
          ({form.householdSize} total)
        </DetailItem>

        <DetailItem icon={Gauge} label="Delivery">
          {DELIVERY_FREQUENCY_LABEL[form.deliveryFrequency]}
        </DetailItem>

        <DetailItem icon={UtensilsCrossed} label="Budget per meal">
          {form.budgetPerMealCents === null ? (
            'Not specified'
          ) : (
            <Money cents={form.budgetPerMealCents} currency={form.currency} />
          )}
        </DetailItem>

        <DetailItem icon={ChefHat} label="Cuisine preferences">
          {form.cuisinePreferences.length === 0
            ? 'None recorded'
            : form.cuisinePreferences.join(', ')}
        </DetailItem>

        <DetailItem icon={Sparkles} label="Favourite dishes">
          {form.favouriteDishes.length === 0
            ? 'None recorded'
            : form.favouriteDishes.join(', ')}
        </DetailItem>

        <DetailItem icon={UtensilsCrossed} label="Dislikes">
          {form.dislikes.length === 0
            ? 'None recorded'
            : form.dislikes.join(', ')}
        </DetailItem>

        <DetailItem icon={Home} label="Kitchen equipment">
          {form.kitchenEquipment.length === 0
            ? 'None recorded'
            : form.kitchenEquipment.join(', ')}
        </DetailItem>

        <DetailItem icon={Dog} label="Pets">
          {form.hasPets
            ? (form.petsNote ?? 'Yes — no further detail given')
            : 'None'}
        </DetailItem>

        <DetailItem icon={Mail} label="Preferred contact">
          {CONTACT_METHOD_LABEL[form.preferredContactMethod]}
        </DetailItem>

        <DetailItem icon={CalendarClock} label="Preferred cook days">
          {form.preferredCookDays.length === 0
            ? 'No preference given'
            : form.preferredCookDays.join(', ')}
        </DetailItem>

        <DetailItem icon={MapPin} label="Service address">
          {addressLine === null || addressLine.length === 0
            ? 'Not provided'
            : addressLine}
        </DetailItem>

        {form.serviceAccessNotes === null ? null : (
          <DetailItem icon={Home} label="Access notes">
            {form.serviceAccessNotes}
          </DetailItem>
        )}
      </CardContent>

      {otherTags.length === 0 && form.notes === null ? null : (
        <CardFooter className="flex-col items-start gap-3">
          {otherTags.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
                Dietary tags
              </span>
              {otherTags.map((tag) => (
                <Badge key={tag.tagId} variant="outline">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
          {form.notes === null ? null : (
            <p className="font-sans text-sm leading-relaxed text-parchment">
              {form.notes}
            </p>
          )}
        </CardFooter>
      )}
    </Card>
  )
}

// =============================================================================
// 5. Interview notes
// =============================================================================

function ConsultationDetailCard({
  consultation,
}: {
  readonly consultation: ConsultationSummary
}): React.JSX.Element {
  return (
    <Card variant="quiet" padded>
      <CardContent className="grid gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <span className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
            Scheduled for
          </span>
          <DateTime value={consultation.scheduledFor} format="datetime" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
            Duration
          </span>
          <span className="font-sans text-sm tabular-nums text-linen">
            {consultation.durationMinutes} min
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
            Where
          </span>
          <span className="font-sans text-sm text-linen">
            {consultation.location ?? consultation.meetingUrl ?? 'Not set'}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-sans text-xs font-medium tracking-wide text-stone uppercase">
            Outcome
          </span>
          <Badge
            variant={CONSULTATION_OUTCOME_BADGE_TONE[consultation.outcome]}
          >
            {CONSULTATION_OUTCOME_LABEL[consultation.outcome]}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}

function InterviewNotesForm({
  consultation,
  onSaved,
}: {
  readonly consultation: ConsultationSummary
  readonly onSaved: (next: ConsultationSummary) => void
}): React.JSX.Element {
  const rhfForm = useForm<
    z.input<typeof consultationInterviewUpdateSchema>,
    unknown,
    ConsultationInterviewUpdateInput
  >({
    resolver: zodResolver(consultationInterviewUpdateSchema),
    defaultValues: {
      consultationInterviewId: consultation.id,
      notes: consultation.notes ?? '',
      chefSummary: consultation.chefSummary ?? '',
      outcome: consultation.outcome,
      followUpAt:
        consultation.followUpAt === null
          ? undefined
          : new Date(consultation.followUpAt).toISOString(),
      compatibilityScore: consultation.compatibilityScore ?? undefined,
    },
  })

  const outcome = rhfForm.watch('outcome')

  const action = useAction(recordConsultationNotes, {
    form: rhfForm,
    knownFieldPaths: [
      'consultationInterviewId',
      'notes',
      'chefSummary',
      'outcome',
      'followUpAt',
      'compatibilityScore',
    ],
    successMessage: 'Interview notes saved.',
    onSuccess: (data) => {
      onSaved({
        ...consultation,
        notes: data.notes,
        chefSummary: data.chefSummary,
        outcome: data.outcome,
        followUpAt: data.followUpAt,
        compatibilityScore: data.compatibilityScore,
        convertedToClientAt: data.convertedToClientAt,
      })
    },
  })

  return (
    <Form {...rhfForm}>
      <form
        noValidate
        onSubmit={rhfForm.handleSubmit((values) => action.execute(values))}
        className="flex flex-col gap-4"
        aria-labelledby="interview-notes-heading"
      >
        <h3
          id="interview-notes-heading"
          className="font-display text-lg font-medium text-linen"
        >
          Interview notes
        </h3>

        <FormField
          control={rhfForm.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>What was discussed</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={field.value ?? ''}
                  rows={5}
                  placeholder="What was discussed, in the household's own words where it matters."
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={rhfForm.control}
          name="chefSummary"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Summary for the chef</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={field.value ?? ''}
                  rows={3}
                  placeholder="The two or three lines a chef needs before the first visit."
                />
              </FormControl>
              <FormDescription>
                Shown to the chef assigned to this household, not to the
                household itself.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={rhfForm.control}
            name="outcome"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Outcome</FormLabel>
                <Select
                  value={field.value ?? 'PENDING'}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose an outcome" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {CONSULTATION_OUTCOME_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {CONSULTATION_OUTCOME_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={rhfForm.control}
            name="compatibilityScore"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Override score</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    numeric
                    inputMode="numeric"
                    value={field.value === undefined ? '' : field.value}
                    onChange={(event) => {
                      const raw = event.target.value
                      field.onChange(raw === '' ? undefined : Number(raw))
                    }}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                </FormControl>
                <FormDescription>
                  Leave blank to keep the rubric&rsquo;s own score.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={rhfForm.control}
          name="followUpAt"
          render={({ field }) => (
            <FormItem>
              <FormLabel required={outcome === 'FOLLOW_UP_REQUIRED'}>
                Follow-up date
              </FormLabel>
              <FormControl>
                <Input
                  type="date"
                  value={toDateInputValue(
                    typeof field.value === 'string' ? field.value : undefined
                  )}
                  onChange={(event) => {
                    field.onChange(
                      event.target.value === ''
                        ? undefined
                        : `${event.target.value}T00:00:00.000Z`
                    )
                  }}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FormControl>
              <FormDescription>
                {outcome === 'FOLLOW_UP_REQUIRED'
                  ? 'Required when the outcome is "Follow-up required."'
                  : 'Only needed if this interview leaves something to circle back on.'}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />
        <FormStatus>{action.statusMessage}</FormStatus>

        <div>
          <Button type="submit" variant="champagne" loading={action.isPending}>
            Save interview notes
          </Button>
        </div>
      </form>
    </Form>
  )
}

// =============================================================================
// 6. Compatibility scoring
// =============================================================================

function scoreTone(
  score: number | null
): 'champagne' | 'success' | 'warning' | 'destructive' | 'neutral' {
  if (score === null) {
    return 'neutral'
  }
  if (score >= 80) {
    return 'success'
  }
  if (score >= 50) {
    return 'champagne'
  }
  return 'destructive'
}

function CompatibilityCard({
  consultation,
  onScored,
}: {
  readonly consultation: ConsultationSummary
  readonly onScored: (score: number) => void
}): React.JSX.Element {
  const [breakdown, setBreakdown] = React.useState<
    readonly ScoreComponentView[] | null
  >(null)

  const action = useAction(scoreConsultationCompatibility, {
    successMessage: (data) => `Scored ${String(data.score)} of 100.`,
    onSuccess: (data) => {
      setBreakdown(data.components)
      onScored(data.score)
    },
  })

  const score = consultation.compatibilityScore

  return (
    <Card variant="elevated" padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={3}>Compatibility</CardTitle>
        <CardDescription>
          A deterministic rubric over the household&rsquo;s own answers, their
          history with us, and the chef under consideration.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-0">
        <Progress
          label="Compatibility score"
          value={score ?? 0}
          tone={scoreTone(score)}
          showValue={score !== null}
        />
        {score === null ? (
          <p className="font-sans text-sm text-stone">Not yet scored.</p>
        ) : null}

        <div>
          <Button
            type="button"
            variant="outline"
            loading={action.isPending}
            onClick={() => {
              void action.execute({
                consultationInterviewId: consultation.id,
                ...(consultation.staffProfileId === null
                  ? {}
                  : { staffProfileId: consultation.staffProfileId }),
              })
            }}
          >
            {score === null ? 'Run compatibility score' : 'Recalculate score'}
          </Button>
        </div>

        <FormStatus>{action.statusMessage}</FormStatus>

        {breakdown === null ? null : (
          <ul className="flex flex-col gap-2 border-t border-ash/70 pt-4">
            {breakdown.map((item) => (
              <li
                key={item.label}
                className="flex items-start justify-between gap-4 font-sans text-sm"
              >
                <div className="flex flex-col">
                  <span className="text-linen">{item.label}</span>
                  <span className="text-xs text-stone">{item.reason}</span>
                </div>
                <span className="shrink-0 tabular-nums text-parchment">
                  {item.awarded}/{item.available}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 7. Prospect conversion — idempotent, and shown as such
// =============================================================================

function ConversionDialogForm({
  household,
  consultation,
  onCancel,
  onConverted,
}: {
  readonly household: HouseholdSummary
  readonly consultation: ConsultationSummary | null
  readonly onCancel: () => void
  readonly onConverted: (result: ConversionResult) => void
}): React.JSX.Element {
  const rhfForm = useForm<
    z.input<typeof prospectConversionSchema>,
    unknown,
    ProspectConversionInput
  >({
    resolver: zodResolver(prospectConversionSchema),
    defaultValues: {
      clientProfileId: household.id,
      consultationInterviewId:
        consultation === null ? undefined : consultation.id,
      status:
        household.status === 'ACTIVE_SUBSCRIBER'
          ? 'ACTIVE_SUBSCRIBER'
          : 'LEAD_QUALIFIED',
      outcome: 'CONVERTED',
      advanceOnboardingTo: undefined,
      followUpAt: undefined,
      chefSummary: '',
      notes: '',
    },
  })

  const outcome = rhfForm.watch('outcome')
  const name = resolveHouseholdName(household)

  const action = useAction(convertProspect, {
    form: rhfForm,
    knownFieldPaths: [
      'clientProfileId',
      'consultationInterviewId',
      'status',
      'outcome',
      'advanceOnboardingTo',
      'followUpAt',
      'compatibilityScore',
      'chefSummary',
      'notes',
    ],
    successMessage: (data) =>
      data.alreadyConverted
        ? `${name} was already ${CLIENT_STATUS_LABEL[data.status].toLowerCase()} — nothing changed.`
        : `${name} is now ${CLIENT_STATUS_LABEL[data.status].toLowerCase()}.`,
    onSuccess: (data) => {
      onConverted({
        status: data.status,
        onboardingStage: data.onboardingStage,
        convertedAt: data.convertedAt,
        alreadyConverted: data.alreadyConverted,
      })
    },
  })

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Convert {name}</DialogTitle>
        <DialogDescription>
          This closes out the consultation and moves the household forward.
          Pressing convert again on a household already at the chosen stage
          reports back without changing anything.
        </DialogDescription>
      </DialogHeader>

      <Form {...rhfForm}>
        <form
          noValidate
          onSubmit={rhfForm.handleSubmit((values) => action.execute(values))}
          className="flex flex-col gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={rhfForm.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>New status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROSPECT_CONVERSION_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {CLIENT_STATUS_LABEL[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={rhfForm.control}
              name="outcome"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Consultation outcome</FormLabel>
                  <Select
                    value={field.value ?? 'CONVERTED'}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROSPECT_CONVERSION_OUTCOMES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {CONSULTATION_OUTCOME_LABEL[value]}
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
            control={rhfForm.control}
            name="advanceOnboardingTo"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Advance onboarding to</FormLabel>
                <Select
                  value={field.value ?? NO_STAGE_CHANGE}
                  onValueChange={(value) =>
                    field.onChange(
                      value === NO_STAGE_CHANGE ? undefined : value
                    )
                  }
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_STAGE_CHANGE}>
                      Leave unchanged
                    </SelectItem>
                    {PROSPECT_CONVERSION_STAGES.map((stage) => (
                      <SelectItem key={stage} value={stage}>
                        {ONBOARDING_STAGE_LABEL[stage]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {outcome === 'FOLLOW_UP_REQUIRED' ? (
            <FormField
              control={rhfForm.control}
              name="followUpAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Follow-up date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      value={toDateInputValue(
                        typeof field.value === 'string'
                          ? field.value
                          : undefined
                      )}
                      onChange={(event) => {
                        field.onChange(
                          event.target.value === ''
                            ? undefined
                            : `${event.target.value}T00:00:00.000Z`
                        )
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

          <FormField
            control={rhfForm.control}
            name="chefSummary"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Summary for the chef</FormLabel>
                <FormControl>
                  <Textarea {...field} value={field.value ?? ''} rows={2} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={rhfForm.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Why now</FormLabel>
                <FormControl>
                  <Textarea {...field} value={field.value ?? ''} rows={2} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormRootError />
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
              Convert household
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  )
}

function ConversionResultSummary({
  result,
}: {
  readonly result: ConversionResult
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded-md border border-sage/40 bg-sage/8 px-4 py-3"
    >
      <span className="inline-flex items-center gap-2 font-sans text-sm font-medium text-linen">
        <CheckCircle2 aria-hidden="true" className="size-4 text-sage-ink" />
        {result.alreadyConverted
          ? 'No change — already at this stage.'
          : 'Conversion recorded.'}
      </span>
      <span className="font-sans text-xs text-parchment">
        Status: {CLIENT_STATUS_LABEL[result.status]} · Onboarding:{' '}
        {ONBOARDING_STAGE_LABEL[result.onboardingStage]}
        {result.convertedAt === null ? null : (
          <>
            {' '}
            ·{' '}
            <DateTime
              value={result.convertedAt}
              format="relative"
              tone="muted"
            />
          </>
        )}
      </span>
    </div>
  )
}

function ConversionCard({
  household,
  consultation,
  onConverted,
}: {
  readonly household: HouseholdSummary
  readonly consultation: ConsultationSummary | null
  readonly onConverted: (result: ConversionResult) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [lastResult, setLastResult] = React.useState<ConversionResult | null>(
    null
  )

  return (
    <Card variant="elevated" padded>
      <CardHeader className="p-0 pb-4">
        <CardTitle level={2}>Convert to client</CardTitle>
        <CardDescription>
          Moves this household past the prospect stage. Safe to press more than
          once — a repeat conversion changes nothing and says so.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-0">
        <div className="flex items-center gap-2">
          <span className="font-sans text-sm text-parchment">
            Current status
          </span>
          <ClientStatusBadge status={household.status} />
        </div>

        {lastResult === null ? null : (
          <ConversionResultSummary result={lastResult} />
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="champagne">
              {household.status === 'PROSPECT'
                ? 'Convert this household'
                : 'Convert again'}
            </Button>
          </DialogTrigger>
          {open ? (
            <ConversionDialogForm
              household={household}
              consultation={consultation}
              onCancel={() => setOpen(false)}
              onConverted={(result) => {
                setOpen(false)
                setLastResult(result)
                onConverted(result)
              }}
            />
          ) : null}
        </Dialog>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// 8. Interview section — picks which consultation the notes/score below bind to
// =============================================================================

function InterviewSection({
  consultations,
  onConsultationsChange,
}: {
  readonly consultations: readonly ConsultationSummary[]
  readonly onConsultationsChange: (next: readonly ConsultationSummary[]) => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = React.useState<string | null>(
    consultations[0]?.id ?? null
  )

  const selected =
    consultations.find((consultation) => consultation.id === selectedId) ?? null

  if (consultations.length === 0) {
    return (
      <EmptyState
        tone="empty"
        size="sm"
        title="No consultation scheduled yet"
        description="Interview notes and compatibility scoring need a scheduled consultation to attach to. Conversion can still go ahead once one exists."
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {consultations.length > 1 ? (
        <div
          role="group"
          aria-label="Choose a consultation"
          className="flex flex-wrap gap-2"
        >
          {consultations.map((consultation) => {
            const isSelected = consultation.id === selectedId

            return (
              <button
                key={consultation.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedId(consultation.id)}
                className={cn(
                  'rounded-md border px-3 py-1.5 font-sans text-sm transition-colors duration-150 ease-luxe',
                  FOCUS_RING,
                  // Champagne is spent on the "Save interview notes" button below —
                  // this selector uses a neutral highlight so the two don't compete
                  // for the same one-accent-per-group budget (CONTRACT.md §3).
                  isSelected
                    ? 'border-linen/40 bg-ash text-linen'
                    : 'border-ash text-parchment hover:border-stone/60'
                )}
              >
                <DateTime
                  value={consultation.scheduledFor}
                  format="date"
                  tone={isSelected ? 'default' : 'muted'}
                />
              </button>
            )
          })}
        </div>
      ) : null}

      {selected === null ? null : (
        <div className="flex flex-col gap-6">
          <ConsultationDetailCard consultation={selected} />

          <InterviewNotesForm
            key={`${selected.id}-notes`}
            consultation={selected}
            onSaved={(next) =>
              onConsultationsChange(
                consultations.map((consultation) =>
                  consultation.id === next.id ? next : consultation
                )
              )
            }
          />

          <CompatibilityCard
            key={`${selected.id}-score`}
            consultation={selected}
            onScored={(score) =>
              onConsultationsChange(
                consultations.map((consultation) =>
                  consultation.id === selected.id
                    ? { ...consultation, compatibilityScore: score }
                    : consultation
                )
              )
            }
          />
        </div>
      )}
    </div>
  )
}

// =============================================================================
// 9. The panel
// =============================================================================

export function ConsultationReview({
  form,
  household: initialHousehold,
  consultations: initialConsultations,
}: ConsultationReviewProps): React.JSX.Element {
  const [household, setHousehold] =
    React.useState<HouseholdSummary>(initialHousehold)
  const [consultations, setConsultations] =
    React.useState<readonly ConsultationSummary[]>(initialConsultations)

  const selectedForConversion = consultations[0] ?? null

  return (
    <div className="flex flex-col gap-6">
      <HouseholdHeader form={form} household={household} />

      <AllergyPanel form={form} />

      <QuestionnaireDetails form={form} />

      <Card variant="elevated" padded>
        <CardHeader className="p-0 pb-4">
          <CardTitle level={2}>Interview</CardTitle>
          <CardDescription>
            Notes recorded from the consultation, and the compatibility rubric
            scored against them.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <InterviewSection
            consultations={consultations}
            onConsultationsChange={setConsultations}
          />
        </CardContent>
      </Card>

      <ConversionCard
        household={household}
        consultation={selectedForConversion}
        onConverted={(result) => {
          setHousehold((current) => ({ ...current, status: result.status }))
        }}
      />
    </div>
  )
}
