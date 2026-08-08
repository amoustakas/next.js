// mannachef/apps/web/src/components/admin/staff/staff-form.tsx
'use client'

/**
 * Amend one chef's profile — reachable from the roster (an administrator
 * editing anybody) and from a chef's own "Chef Staff" page (editing exactly
 * the one profile their session names).
 *
 * ## `canCurate` is a prop, never inferred
 *
 * `isPubliclyListed` and `sortOrder` decide who appears on the marketing site
 * and in what order — CONTRACT.md's staff domain reserves both to `ADMIN` and
 * above. `updateStaffProfile` refuses the write outright (`FORBIDDEN`) if a
 * non-curator's payload carries either key at all, matching or not, so this
 * form does two things to honour that rather than merely disabling a control:
 *
 *  1. The two controls render `disabled` with a sentence explaining who may
 *     change them, so a chef sees a real reason rather than a dead switch.
 *  2. {@link buildPayload} drops both keys from the object handed to
 *     `execute()` for anyone who is not a curator — the values stay in the
 *     form's own state (so re-enabling never has to re-fetch), they are simply
 *     never sent.
 *
 * `avatarMediaId` is deliberately not a field here. It is a `MediaAsset`
 * reference, and choosing one is a media-library job, not a text box for a
 * cuid; the portrait is shown read-only and the key is left out of every
 * payload this form ever sends, which `staffProfileUpdateSchema` reads as
 * "leave it attached to whatever it already points at".
 */

import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'

import {
  MAX_CONCURRENT_EVENTS,
  MAX_HOURLY_RATE_CENTS,
  MAX_SERVICE_RADIUS_KM,
  MAX_STAFF_LANGUAGES,
  MAX_STAFF_SORT_ORDER,
  MAX_STAFF_SPECIALTIES,
  MAX_YEARS_EXPERIENCE,
  staffProfileUpdateSchema,
  type StaffProfileUpdateInput,
} from '@mannachef/validators'

import { updateStaffProfile } from '@/server/actions/staff'
import type { AdminStaffRosterView as StaffRosterView } from '@/components/admin/view-models'
import { useAction } from '@/lib/action-client'
import { zodResolver } from '@/lib/zod-resolver'

import {
  DollarsField,
  NumberField,
  StringListField,
} from '@/components/forms/field-kit'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  initialsFrom,
} from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
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
import { Separator } from '@/components/ui/separator'
import { SwitchField } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export interface StaffFormProps {
  /** The profile being edited — a roster row, or the caller's own. */
  readonly profile: StaffRosterView
  /**
   * `true` for `ADMIN` and above. Governs the two curatorial fields only —
   * every other field is open to the chef the profile belongs to.
   */
  readonly canCurate: boolean
}

/** The field paths this form registers, for `useAction`'s field-error map. */
const STAFF_FIELD_PATHS = [
  'title',
  'bio',
  'specialties',
  'languages',
  'yearsExperience',
  'hourlyRateCents',
  'currency',
  'serviceRadiusKm',
  'maxConcurrentEvents',
  'isAcceptingClients',
  'baseCity',
  'baseRegion',
  'baseCountry',
  'calendarTimeZone',
  'isPubliclyListed',
  'sortOrder',
] as const

type StaffFormInput = z.input<typeof staffProfileUpdateSchema>

function defaultValuesFrom(profile: StaffRosterView): StaffFormInput {
  return {
    id: profile.id,
    title: profile.title,
    bio: profile.bio,
    specialties: [...profile.specialties],
    languages: [...profile.languages],
    hourlyRateCents: profile.hourlyRateCents,
    currency: profile.currency,
    serviceRadiusKm: profile.serviceRadiusKm,
    yearsExperience: profile.yearsExperience,
    baseCity: profile.baseCity,
    baseRegion: profile.baseRegion,
    baseCountry: profile.baseCountry,
    calendarTimeZone: profile.calendarTimeZone,
    isAcceptingClients: profile.isAcceptingClients,
    maxConcurrentEvents: profile.maxConcurrentEvents,
    isPubliclyListed: profile.isPubliclyListed,
    sortOrder: profile.sortOrder,
  }
}

/**
 * Drops the two curatorial keys for anyone who is not a curator.
 *
 * `updateStaffProfile` treats an *absent* key as "leave this column alone" and
 * a *present* one — even carrying the value already stored — as a change a
 * non-curator is not allowed to propose. Sending the whole parsed object
 * unconditionally would therefore turn every save from a chef's own page into
 * a `FORBIDDEN`, since the controls exist in the form's state even while
 * disabled.
 */
function buildPayload(
  values: StaffProfileUpdateInput,
  canCurate: boolean
): StaffProfileUpdateInput {
  if (canCurate) {
    return values
  }

  return {
    id: values.id,
    title: values.title,
    bio: values.bio,
    specialties: values.specialties,
    languages: values.languages,
    hourlyRateCents: values.hourlyRateCents,
    currency: values.currency,
    serviceRadiusKm: values.serviceRadiusKm,
    yearsExperience: values.yearsExperience,
    baseCity: values.baseCity,
    baseRegion: values.baseRegion,
    baseCountry: values.baseCountry,
    calendarTimeZone: values.calendarTimeZone,
    isAcceptingClients: values.isAcceptingClients,
    maxConcurrentEvents: values.maxConcurrentEvents,
  }
}

export function StaffForm({ profile, canCurate }: StaffFormProps) {
  const router = useRouter()

  const form = useForm<StaffFormInput, unknown, StaffProfileUpdateInput>({
    resolver: zodResolver(staffProfileUpdateSchema),
    defaultValues: defaultValuesFrom(profile),
    mode: 'onBlur',
  })

  const action = useAction(updateStaffProfile, {
    form,
    knownFieldPaths: STAFF_FIELD_PATHS,
    successMessage: 'Profile saved.',
    onSuccess: (data) => {
      form.reset(defaultValuesFrom(data))
      router.refresh()
    },
  })

  const pending = action.isPending

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          void action.execute(buildPayload(values, canCurate))
        })}
        noValidate
        className="flex flex-col gap-6"
      >
        <fieldset disabled={pending} className="contents">
          <legend className="sr-only">
            {profile.name ?? 'Chef'}&rsquo;s profile
          </legend>

          <div className="flex items-center gap-3">
            <Avatar size="md">
              {profile.avatarMedia === null ? null : (
                <AvatarImage
                  src={
                    profile.avatarMedia.thumbnailUrl ?? profile.avatarMedia.url
                  }
                  alt={profile.avatarMedia.alt}
                />
              )}
              <AvatarFallback>{initialsFrom(profile.name)}</AvatarFallback>
            </Avatar>
            <p className="font-sans text-xs leading-relaxed text-stone">
              The portrait is managed from the Media Library and is not changed
              here.
            </p>
          </div>

          <section
            aria-labelledby="staff-identity-heading"
            className="flex flex-col gap-4"
          >
            <h3
              id="staff-identity-heading"
              className="font-display text-base font-medium text-linen"
            >
              Identity
            </h3>

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Executive Chef"
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(event.target.value)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormDescription>
                    What appears on the directory card, under the name.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="bio"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Biography</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={5}
                      placeholder="A few sentences on their kitchen, their training, and what a household can expect."
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

          <Separator />

          <section
            aria-labelledby="staff-craft-heading"
            className="flex flex-col gap-4"
          >
            <h3
              id="staff-craft-heading"
              className="font-display text-base font-medium text-linen"
            >
              Craft
            </h3>

            <FormField
              control={form.control}
              name="specialties"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Specialities</FormLabel>
                  <FormControl>
                    <StringListField
                      value={field.value ?? []}
                      onValueChange={field.onChange}
                      itemNoun="speciality"
                      placeholder="Wood-fired, Levantine, pastry…"
                      maxEntries={MAX_STAFF_SPECIALTIES}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="languages"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Languages</FormLabel>
                  <FormControl>
                    <StringListField
                      value={field.value ?? []}
                      onValueChange={field.onChange}
                      itemNoun="language"
                      placeholder="English, French…"
                      maxEntries={MAX_STAFF_LANGUAGES}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="yearsExperience"
              render={({ field }) => (
                <FormItem className="sm:max-w-xs">
                  <FormLabel>Years of experience</FormLabel>
                  <FormControl>
                    <NumberField
                      value={field.value ?? undefined}
                      onValueChange={(value) => field.onChange(value ?? null)}
                      min={0}
                      max={MAX_YEARS_EXPERIENCE}
                      step={1}
                      placeholder="Leave blank if unrecorded"
                    />
                  </FormControl>
                  <FormDescription>
                    Leave blank rather than guessing — that is different from
                    zero.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <Separator />

          <section
            aria-labelledby="staff-rates-heading"
            className="flex flex-col gap-4"
          >
            <h3
              id="staff-rates-heading"
              className="font-display text-base font-medium text-linen"
            >
              Rate & availability
            </h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="hourlyRateCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hourly rate</FormLabel>
                    <FormControl>
                      <DollarsField
                        valueCents={field.value ?? profile.hourlyRateCents}
                        onValueCentsChange={field.onChange}
                        max={MAX_HOURLY_RATE_CENTS / 100}
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
                    <FormLabel>Currency</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="CAD"
                        maxLength={3}
                        className="uppercase"
                        value={field.value ?? profile.currency}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      Three-letter ISO 4217 code.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="serviceRadiusKm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Travel radius (km)</FormLabel>
                    <FormControl>
                      <NumberField
                        value={field.value ?? profile.serviceRadiusKm}
                        onValueChange={(value) => field.onChange(value ?? 0)}
                        min={0}
                        max={MAX_SERVICE_RADIUS_KM}
                        step={1}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="maxConcurrentEvents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Concurrent engagements</FormLabel>
                    <FormControl>
                      <NumberField
                        value={field.value ?? profile.maxConcurrentEvents}
                        onValueChange={(value) => field.onChange(value ?? 1)}
                        min={1}
                        max={MAX_CONCURRENT_EVENTS}
                        step={1}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="isAcceptingClients"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <SwitchField
                      label="Accepting new households"
                      description="Off pauses new bookings without touching anything already on the calendar."
                      checked={field.value ?? profile.isAcceptingClients}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <Separator />

          <section
            aria-labelledby="staff-location-heading"
            className="flex flex-col gap-4"
          >
            <h3
              id="staff-location-heading"
              className="font-display text-base font-medium text-linen"
            >
              Location & calendar
            </h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="baseCity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Toronto"
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
                name="baseRegion"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Province / territory</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Ontario"
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
                name="baseCountry"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="CA"
                        maxLength={2}
                        className="uppercase"
                        value={field.value ?? ''}
                        onChange={(event) => {
                          const raw = event.target.value.trim()
                          field.onChange(raw === '' ? null : raw.toUpperCase())
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      Two-letter ISO 3166-1 code.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="calendarTimeZone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Calendar time zone</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="America/Toronto"
                        value={field.value ?? profile.calendarTimeZone}
                        onChange={(event) => field.onChange(event.target.value)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormDescription>
                      An IANA identifier — every appointment time on this chef's
                      calendar is read against it.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </section>

          <Separator />

          <section
            aria-labelledby="staff-curatorial-heading"
            className="flex flex-col gap-4 rounded-md border border-ash bg-charcoal/60 p-4"
          >
            <div className="flex flex-col gap-1">
              <h3
                id="staff-curatorial-heading"
                className="font-display text-base font-medium text-linen"
              >
                Directory & ordering
              </h3>
              <p className="font-sans text-xs leading-relaxed text-stone">
                {canCurate
                  ? 'Whether this chef appears on the public site, and where they sit relative to the rest of the roster.'
                  : 'Reserved to an administrator — ask one to change your listing or your position in the directory.'}
              </p>
            </div>

            <FormField
              control={form.control}
              name="isPubliclyListed"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <SwitchField
                      label="List in the public directory"
                      description={
                        canCurate
                          ? 'Visible to a visitor browsing chefs on the marketing site.'
                          : 'Set by an administrator, not by the chef.'
                      }
                      checked={field.value ?? profile.isPubliclyListed}
                      onCheckedChange={field.onChange}
                      disabled={!canCurate}
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
                    <NumberField
                      value={field.value ?? profile.sortOrder}
                      onValueChange={(value) => field.onChange(value ?? 0)}
                      min={0}
                      max={MAX_STAFF_SORT_ORDER}
                      step={1}
                      disabled={!canCurate}
                    />
                  </FormControl>
                  <FormDescription>
                    {canCurate
                      ? 'Lower numbers sit first in the directory.'
                      : 'Set by an administrator, not by the chef.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <div className="flex flex-col gap-3">
            <FormRootError />
            <FormStatus>{action.statusMessage}</FormStatus>
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="champagne"
              loading={pending}
              loadingLabel="Saving…"
            >
              Save profile
            </Button>
          </div>
        </fieldset>
      </form>
    </Form>
  )
}
