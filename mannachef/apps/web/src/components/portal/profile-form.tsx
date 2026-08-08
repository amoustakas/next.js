// mannachef/apps/web/src/components/portal/profile-form.tsx
'use client'

/**
 * The four things a household may change about its own record.
 *
 * ## Why only four
 *
 * `clientProfileUpdateSchema` is built from `clientProfileWritableShape`, which
 * has seven keys. Three of them are not this form's to offer:
 *
 *  - `vipNotes` is staff commentary. `updateClientProfile` writes it only when
 *    the caller is `CHEF_STAFF` or above and silently drops it otherwise, so a
 *    field here would be a control that does nothing.
 *  - `source` and `sourceDetail` are lead attribution — how the household came
 *    to us. The action does *not* role-gate these, so a field here would let a
 *    household rewrite its own attribution, and the validators' own note on
 *    `clientProfileWritableShape` names exactly that failure: a referral quietly
 *    re-recorded as `DIRECT` shows up months later as a lead-source report
 *    saying everybody found us on their own. Attribution is the house's record
 *    of a fact, not a preference, so it is displayed on the page and not
 *    editable here.
 *
 * That leaves the household's own description of itself, which is what this
 * form is: the name to use, the name to use in person, a number, and how to be
 * reached.
 *
 * ## The partial-update shape
 *
 * `buildUpdateSchema` strips the defaults, makes every writable key optional,
 * requires `id`, and refuses a payload that is nothing but `{ id }`. So an
 * untouched field must arrive as `undefined` rather than as `''` — an empty
 * string is a *value*, and sending it would blank a name the household never
 * meant to touch. `phone` is the one field where clearing is meaningful, and
 * the schema says so by being `.nullable()`: an emptied box sends `null`, which
 * removes the number, while an untouched one sends nothing at all.
 *
 * ## Ownership
 *
 * `profileId` is re-checked server-side. `updateClientProfile` calls
 * `requireHouseholdWriteAccess` before it writes anything, so passing another
 * household's id here fails in the action rather than succeeding
 * (`CONTRACT.md` §5 — the id is never trusted because it arrived from the
 * client).
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'

import {
  clientProfileUpdateSchema,
  type ClientProfileUpdateInput,
  type ClientProfileUpdateRawInput,
  type ContactMethod,
} from '@mannachef/validators'

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
import { RadioGroup, RadioGroupField } from '@/components/ui/radio-group'
import { useAction } from '@/lib/action-client'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import { updateClientProfile } from '@/server/actions/client'

export interface ProfileFormProps {
  /** The household's own profile id. Re-checked inside the action. */
  readonly profileId: string
  readonly displayName: string | null
  readonly preferredName: string | null
  readonly phone: string | null
  readonly preferredContactMethod: ContactMethod
}

/** Each way of being reached, and what choosing it actually means. */
const CONTACT_METHODS: ReadonlyArray<{
  readonly value: ContactMethod
  readonly label: string
  readonly description: string
}> = [
  {
    value: 'EMAIL',
    label: 'Email',
    description: 'Confirmations, menus and invoices in writing.',
  },
  {
    value: 'PHONE',
    label: 'A phone call',
    description: 'For anything time-sensitive. Requires a number below.',
  },
  {
    value: 'SMS',
    label: 'Text message',
    description: 'Short confirmations only. Requires a number below.',
  },
  {
    value: 'IN_APP',
    label: 'In the portal',
    description: 'Nothing is sent; everything waits for you here.',
  },
]

/** An untouched box is `undefined` — "unchanged" — never `''`. */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : undefined
}

export function ProfileForm({
  profileId,
  displayName,
  preferredName,
  phone,
  preferredContactMethod,
}: ProfileFormProps): React.JSX.Element {
  const router = useRouter()

  const form = useForm<
    ClientProfileUpdateRawInput,
    unknown,
    ClientProfileUpdateInput
  >({
    resolver: zodResolver(clientProfileUpdateSchema),
    defaultValues: {
      id: profileId,
      displayName: displayName ?? undefined,
      preferredName: preferredName ?? undefined,
      phone: phone ?? undefined,
      preferredContactMethod,
    },
    mode: 'onBlur',
  })

  const { execute, isPending, statusMessage, failure } = useAction(
    updateClientProfile,
    {
      form,
      knownFieldPaths: [
        'displayName',
        'preferredName',
        'phone',
        'preferredContactMethod',
      ],
      successMessage: 'Your profile is saved.',
      onSuccess: () => {
        router.refresh()
      },
    }
  )

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          void execute(values)
        })}
        noValidate
        className="flex flex-col gap-6"
      >
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Household name</FormLabel>
              <FormControl>
                <Input
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  autoComplete="organization"
                  placeholder="The Okonkwo household"
                  className="sm:max-w-sm"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(optionalText(event.target.value))
                  }}
                />
              </FormControl>
              <FormDescription>
                How we address the household in writing — on menus, invoices and
                confirmations.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="preferredName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>What your chef should call you</FormLabel>
              <FormControl>
                <Input
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  autoComplete="given-name"
                  placeholder="Ada"
                  className="sm:max-w-sm"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={(event) => {
                    field.onChange(optionalText(event.target.value))
                  }}
                />
              </FormControl>
              <FormDescription>
                Used in person and at the door, where a household name would be
                far too formal.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl>
                <Input
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  type="tel"
                  autoComplete="tel"
                  placeholder="+14165550132"
                  className="sm:max-w-sm"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={(event) => {
                    // `phone` is `.nullable()`, so clearing the box is a real
                    // instruction — `null` removes the number — where clearing
                    // any other field above only means "leave it alone".
                    const next = event.target.value.trim()

                    field.onChange(next.length > 0 ? next : null)
                  }}
                />
              </FormControl>
              <FormDescription>
                With the country code, as +1 416 555 0132. Leave it empty to
                remove the number we hold.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="preferredContactMethod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>How we should reach you</FormLabel>
              <FormControl>
                <RadioGroup
                  name={field.name}
                  value={
                    typeof field.value === 'string' ? field.value : 'EMAIL'
                  }
                  onValueChange={(next) => {
                    field.onChange(next)
                  }}
                  className="flex flex-col gap-3"
                >
                  {CONTACT_METHODS.map((method) => (
                    <RadioGroupField
                      key={method.value}
                      value={method.value}
                      label={method.label}
                      description={method.description}
                    />
                  ))}
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormRootError />

        {failure === null ? null : (
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
        )}

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" variant="champagne" loading={isPending}>
            Save changes
          </Button>
          <FormStatus>{statusMessage}</FormStatus>
        </div>
      </form>
    </Form>
  )
}
