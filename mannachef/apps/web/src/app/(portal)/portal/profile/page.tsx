// mannachef/apps/web/src/app/(portal)/portal/profile/page.tsx

/**
 * The household's own record: what we hold, what they may change, and the way
 * back into the questionnaire that fills the rest of it in.
 *
 * A **Server Component**. The read happens here; the only client boundary is
 * `<ProfileForm>`, which is a genuine form with validation and a Server Action
 * behind it.
 *
 * ## Two different empties
 *
 * A signed-in caller may legitimately have no `ClientProfile` — a staff account,
 * or a prospect whose questionnaire has not been converted yet. The portal
 * layout already says so in a banner and does not redirect them, so this page
 * has to handle it as a *state*, not an error: `readMyClientProfile` answers
 * `NOT_FOUND`, and the page renders the one route that would change it rather
 * than an error panel. Every other `ActionErrorCode` really is a failed read and
 * goes to `<ActionError>`.
 *
 * ## What is shown but not editable
 *
 * `status`, `source`, `lifetimeValueCents` and the follow-up dates are the
 * house's view of the relationship, not the household's description of itself,
 * and none of them is offered as an input. They are still *shown*: a record
 * kept about somebody that they cannot read is a worse default than one they
 * can read but not rewrite.
 *
 * `vipNotes` is the exception and is never rendered here at all. It is staff
 * commentary — `updateClientProfile` only writes it for a `CHEF_STAFF` caller,
 * and `toClientProfileView` nulls it for a household reading its own file, so
 * there would be nothing to show even if this page asked.
 */

import type * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ClipboardList, UserRound } from 'lucide-react'

import { ActionError } from '@/components/portal/action-error'
import { ProfileForm } from '@/components/portal/profile-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { readMyClientProfile } from '@/server/actions/client'

export const metadata: Metadata = {
  title: 'Profile',
}

/** How each lifecycle stage reads to the household it describes. */
const STATUS_LABELS: Record<string, string> = {
  PROSPECT: 'Enquiry',
  ACTIVE: 'Active',
  PAUSED: 'Resting',
  CHURNED: 'Closed',
  ARCHIVED: 'Archived',
}

/** How the household first reached us, in their words rather than the CRM's. */
const SOURCE_LABELS: Record<string, string> = {
  DIRECT: 'Came to us directly',
  REFERRAL: 'Introduced by an existing client',
  SOCIAL: 'Found us on social media',
  SEARCH: 'Found us through a search',
  PARTNER: 'Through a partner',
  EVENT: 'Met us at an event',
  OTHER: 'Another way',
}

function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-sans text-sm text-parchment">{children}</dd>
    </div>
  )
}

export default async function PortalProfilePage(): Promise<React.JSX.Element> {
  const result = await readMyClientProfile({})

  const header = (
    <header className="flex flex-col gap-2">
      <h2 className="font-display text-3xl leading-tight font-light text-linen">
        Profile
      </h2>
      <p className="font-sans text-sm leading-relaxed text-parchment">
        What we hold about your household, and how you would like to be reached.
      </p>
    </header>
  )

  if (!result.ok) {
    // Not an error: a signed-in account can simply have no household record yet.
    if (result.code === 'NOT_FOUND') {
      return (
        <div className="flex flex-col gap-8">
          {header}

          <EmptyState
            icon={ClipboardList}
            headingLevel={3}
            title="There is no household record on this account yet."
            description="The questionnaire is what opens one. It asks how your household eats — allergies, aversions, the kitchen, the cadence — and a chef reads it before anything else happens."
            action={
              <Button asChild variant="champagne">
                <Link href="/consultation">Answer the questionnaire</Link>
              </Button>
            }
          />
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-8">
        {header}
        <ActionError
          code={result.code}
          error={result.error}
          subject="your profile"
          headingLevel={3}
        />
      </div>
    )
  }

  const profile = result.data

  return (
    <div className="flex flex-col gap-8">
      {header}

      <Card as="article" variant="elevated">
        <CardHeader>
          <CardDescription>Your household</CardDescription>
          <CardTitle level={3} className="text-2xl">
            {profile.displayName ?? profile.accountName ?? 'Your household'}
          </CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline">
              {STATUS_LABELS[profile.status] ?? profile.status}
            </Badge>
            {profile.churnedAt === null ? null : (
              <span className="font-sans text-xs text-stone">
                Closed <DateTime value={profile.churnedAt} />
              </span>
            )}
          </div>

          <dl className="grid gap-5 sm:grid-cols-2">
            <Field label="Account">
              {profile.accountEmail ?? 'No email on the account'}
            </Field>

            <Field label="With us since">
              <DateTime value={profile.createdAt} />
            </Field>

            <Field label="How we met">
              {SOURCE_LABELS[profile.source] ?? profile.source}
              {profile.sourceDetail === null
                ? null
                : ` — ${profile.sourceDetail}`}
            </Field>

            <Field label="Time zone">
              {`${profile.timeZone} · ${profile.locale}`}
            </Field>

            <Field label="Booked with us to date">
              <Money
                cents={profile.lifetimeValueCents}
                currency={profile.currency}
                tone="muted"
              />
            </Field>

            <Field label="Last spoke">
              {profile.lastContactedAt === null ? (
                'Not yet'
              ) : (
                <DateTime value={profile.lastContactedAt} />
              )}
            </Field>
          </dl>

          <p className="font-sans text-xs leading-relaxed text-stone">
            How we met, your standing with us and the figure above are our own
            record of the relationship and are not editable here. If any of them
            looks wrong, say so and we will correct it.
          </p>
        </CardContent>
      </Card>

      <Separator variant="hairline" decorative />

      <section
        aria-labelledby="profile-edit-heading"
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <h3
            id="profile-edit-heading"
            className="font-display text-2xl font-light text-linen"
          >
            What you can change
          </h3>
          <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
            Your name as we should use it, and how you would rather be reached.
            Changing your contact preference changes how we confirm bookings and
            send invoices, so it is worth keeping current.
          </p>
        </div>

        <ProfileForm
          profileId={profile.id}
          displayName={profile.displayName}
          preferredName={profile.preferredName}
          phone={profile.phone}
          preferredContactMethod={profile.preferredContactMethod}
        />
      </section>

      <Separator variant="hairline" decorative />

      <section
        aria-labelledby="profile-intake-heading"
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <h3
            id="profile-intake-heading"
            className="font-display text-2xl font-light text-linen"
          >
            Allergies, aversions and your kitchen
          </h3>
          <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
            These are not fields on this page, and deliberately so — they are
            the questionnaire, because an allergy answered in a box next to a
            phone number is an allergy waiting to be missed. Answering it again
            replaces what we hold and a chef reads the new version before your
            next menu is written.
          </p>
        </div>

        <EmptyState
          size="sm"
          icon={UserRound}
          headingLevel={4}
          title="Something changed at home?"
          description="A new allergy, a household that has grown, a kitchen that has been rebuilt — the questionnaire is the right place for all three."
          action={
            <Button asChild variant="outline">
              <Link href="/consultation">Re-open the questionnaire</Link>
            </Button>
          }
        />
      </section>
    </div>
  )
}
