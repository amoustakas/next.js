// mannachef/apps/web/src/app/(admin)/admin/staff/page.tsx
import type { Metadata } from 'next'
import { Users } from 'lucide-react'

import { hasRoleAtLeast, type Role } from '@mannachef/validators'

import { getSessionUser } from '@/server/auth'
import {
  listStaffRoster,
  readMyStaffProfile,
  type StaffRosterView,
} from '@/server/actions/staff'
import { StaffForm } from '@/components/admin/staff/staff-form'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  initialsFrom,
} from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'

export const metadata: Metadata = {
  title: 'Chef Staff — MannaChef Admin',
  description:
    'The chef roster: rates, availability, service area and public listing, in one place.',
}

/** How many rows the roster reads at once. The kitchen is not this large yet. */
const ROSTER_PAGE_SIZE = 100

const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  CHEF_STAFF: 'Chef Staff',
  CLIENT: 'Client',
}

/**
 * The chef roster.
 *
 * Which read runs — and therefore what a visitor can even see — is decided by
 * role, not by which controls happen to be rendered: an `ADMIN` (or higher)
 * gets {@link listStaffRoster}, everybody else gets {@link readMyStaffProfile},
 * which the server itself refuses to anyone who is not `CHEF_STAFF`. The
 * `AdminLayout` above this route has already turned away a visitor below
 * `CHEF_STAFF`, so the only two branches reachable here are "curator" and
 * "chef looking at their own card".
 *
 * `isPubliclyListed` and `sortOrder` are curatorial — CONTRACT.md's staff
 * domain reserves them to `ADMIN` and above — so {@link StaffForm} always
 * receives `canCurate` rather than inferring it from anything on the row
 * itself. A hidden button is not a permission check; a disabled one, with the
 * reason written next to it, is.
 */
export default async function StaffRosterPage() {
  const user = await getSessionUser()

  if (user === null) {
    return null
  }

  const canCurate = hasRoleAtLeast(user.role, 'ADMIN')

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1
          id="staff-heading"
          className="font-display text-3xl leading-tight font-medium tracking-tight text-linen sm:text-4xl"
        >
          Chef Staff
        </h1>
        <p className="max-w-prose font-sans text-sm leading-relaxed text-parchment">
          {canCurate
            ? 'Every chef on the roster: their rates, their reach, and whether the marketing site is allowed to show them at all.'
            : 'Your profile, as it appears to the kitchen and — where you have chosen to be listed — to a visitor browsing the directory.'}
        </p>
      </header>

      {canCurate ? <CuratorRoster viewerRole={user.role} /> : <OwnProfile />}
    </div>
  )
}

async function CuratorRoster({ viewerRole }: { readonly viewerRole: Role }) {
  const result = await listStaffRoster({
    pageSize: ROSTER_PAGE_SIZE,
    sortBy: 'CURATED',
  })

  if (!result.ok) {
    return (
      <EmptyState
        tone="error"
        icon={Users}
        title="The roster could not be read"
        description={result.error}
      />
    )
  }

  const { items, meta } = result.data

  if (items.length === 0) {
    return (
      <EmptyState
        tone="empty"
        icon={Users}
        title="No chef profiles yet"
        description="A chef's profile is created from their account once they join the kitchen."
      />
    )
  }

  return (
    <section aria-labelledby="staff-heading" className="flex flex-col gap-3">
      <p className="font-sans text-xs tracking-wide text-stone uppercase">
        {meta.total} {meta.total === 1 ? 'chef' : 'chefs'} on the roster
        {meta.hasNextPage
          ? ` · showing the first ${String(ROSTER_PAGE_SIZE)}`
          : ''}
      </p>

      <div className="overflow-hidden rounded-lg border border-ash bg-slate-warm">
        <Accordion type="single" collapsible>
          {items.map((chef) => (
            <AccordionItem key={chef.id} value={chef.id} className="px-4">
              <AccordionTrigger
                aria-label={`Edit ${chef.name ?? 'this chef'}'s profile`}
              >
                <RosterSummaryRow chef={chef} />
              </AccordionTrigger>
              <AccordionContent>
                <StaffForm
                  key={chef.updatedAt.toISOString()}
                  profile={chef}
                  canCurate
                />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      <p className="font-sans text-xs leading-relaxed text-stone">
        Signed in as {ROLE_LABEL[viewerRole]}. Whether a chef is listed publicly
        and where they sit in the directory is set here; every other field a
        chef may also amend from their own account.
      </p>
    </section>
  )
}

function RosterSummaryRow({ chef }: { readonly chef: StaffRosterView }) {
  const displayName = chef.name ?? chef.accountEmail ?? 'Unnamed chef'

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar size="sm">
          {chef.avatarMedia === null ? null : (
            <AvatarImage
              src={chef.avatarMedia.thumbnailUrl ?? chef.avatarMedia.url}
              alt={chef.avatarMedia.alt}
            />
          )}
          <AvatarFallback>{initialsFrom(chef.name)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col text-left">
          <span className="truncate font-sans text-sm font-medium text-linen">
            {displayName}
          </span>
          <span className="truncate font-sans text-xs text-stone">
            {chef.title ?? 'No title set'}
            {chef.baseCity === null ? '' : ` · ${chef.baseCity}`}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {chef.isAcceptingClients ? (
          <Badge variant="success">Accepting</Badge>
        ) : (
          <Badge variant="muted">Not accepting</Badge>
        )}
        {chef.isPubliclyListed ? (
          <Badge variant="champagne">Listed</Badge>
        ) : (
          <Badge variant="muted">Hidden</Badge>
        )}
        <Money
          cents={chef.hourlyRateCents}
          currency={chef.currency}
          className="text-sm"
        />
        <span className="font-sans text-xs text-stone">/hr</span>
      </div>
    </div>
  )
}

async function OwnProfile() {
  const result = await readMyStaffProfile({})

  if (!result.ok) {
    return (
      <EmptyState
        tone="empty"
        icon={Users}
        title="No chef profile on this account yet"
        description={result.error}
      />
    )
  }

  const profile = result.data

  return (
    <Card variant="elevated" as="section" aria-labelledby="staff-heading">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Avatar size="lg">
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
          <div className="flex flex-col gap-1">
            <CardTitle level={2}>{profile.name ?? 'Your profile'}</CardTitle>
            <CardDescription>
              {profile.averageRating === null
                ? 'No reviews yet.'
                : `${String(profile.averageRating)} average · ${String(profile.reviewCount)} ${profile.reviewCount === 1 ? 'review' : 'reviews'}`}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <StaffForm profile={profile} canCurate={false} />
      </CardContent>
    </Card>
  )
}
