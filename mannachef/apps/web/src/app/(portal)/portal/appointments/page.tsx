// mannachef/apps/web/src/app/(portal)/portal/appointments/page.tsx

/**
 * Every engagement, in two lists.
 *
 * A **Server Component**. The two reads run together, the cards render as HTML,
 * and the only client code on the page is the pair of dialogs behind "Move" and
 * "Withdraw" — which need it, because they are forms that call actions.
 *
 * ## Which engagements offer the two buttons
 *
 * Only `REQUESTED` and `CONFIRMED` ones, which is the same list
 * `CLIENT_CHANGEABLE_STATUSES` bounds a household to in `actions/booking.ts`.
 * Once a chef is `IN_PROGRESS` — shopping done, in the car — a change is a
 * telephone call rather than a form, and the action says so.
 *
 * That gate is presentation, not permission. A household that reached the
 * action anyway would be refused there, inside the transaction, against the
 * status read from the database rather than the one this page rendered.
 * Hiding the button is a courtesy; the refusal is the check.
 */

import type * as React from 'react'
import Link from 'next/link'
import { CalendarDays, History } from 'lucide-react'

import type { AppointmentView } from '@mannachef/api-contract'
import type { AppointmentStatus } from '@mannachef/validators'

import { ActionError } from '@/components/portal/action-error'
import {
  CancelAppointmentDialog,
  RescheduleAppointmentDialog,
  type AppointmentActionTarget,
} from '@/components/portal/appointment-actions'
import { AppointmentStatusBadge } from '@/components/portal/status-badges'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DateTimeRange } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { listAppointments } from '@/server/actions/booking'

export const metadata = {
  title: 'Appointments',
}

/** The statuses a household may still move or withdraw on its own. */
const CHANGEABLE: readonly AppointmentStatus[] = ['REQUESTED', 'CONFIRMED']

function toActionTarget(
  appointment: AppointmentView
): AppointmentActionTarget {
  return {
    id: appointment.id,
    status: appointment.status,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    guestCount: appointment.guestCount,
    quotedGuestCount: appointment.quotedGuestCount,
  }
}

function formatAddress(address: AppointmentView['address']): string | null {
  if (address === null) {
    return null
  }

  const parts = [
    address.line1,
    address.line2,
    address.city,
    address.region,
    address.postalCode,
  ].filter((part): part is string => part !== null && part.length > 0)

  return parts.length === 0 ? null : parts.join(', ')
}

function AppointmentCard({
  appointment,
  changeable,
}: {
  readonly appointment: AppointmentView
  readonly changeable: boolean
}): React.JSX.Element {
  const address = formatAddress(appointment.address)

  return (
    <Card as="article" variant="default">
      <CardContent className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h3 className="font-display text-2xl leading-tight font-light text-linen">
              <DateTimeRange
                start={appointment.startsAt}
                end={appointment.endsAt}
              />
            </h3>
            <p className="font-sans text-sm text-parchment">
              {appointment.staffName ?? 'A chef is being assigned'}
            </p>
          </div>
          <AppointmentStatusBadge status={appointment.status} />
        </div>

        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              At the table
            </dt>
            <dd className="mt-1 font-sans text-sm text-parchment tabular-nums">
              {String(appointment.guestCount)}
            </dd>
          </div>
          <div>
            <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              Total
            </dt>
            <dd className="mt-1 font-sans text-sm text-parchment">
              {appointment.totalCents === 0 ? (
                <span className="text-stone">Not yet quoted</span>
              ) : (
                <Money
                  cents={appointment.totalCents}
                  currency={appointment.currency}
                />
              )}
            </dd>
          </div>
          <div>
            <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              Deposit
            </dt>
            <dd className="mt-1 font-sans text-sm text-parchment">
              {appointment.depositCents === 0 ? (
                <span className="text-stone">None taken</span>
              ) : (
                <Money
                  cents={appointment.depositCents}
                  currency={appointment.currency}
                />
              )}
            </dd>
          </div>
        </dl>

        {appointment.requiresRequote ? (
          <p className="rounded-md border border-terracotta/60 bg-terracotta/10 px-3 py-2 font-sans text-xs leading-relaxed text-parchment">
            {`The figures above were priced for ${String(
              appointment.quotedGuestCount
            )} at the table and the party is now ${String(
              appointment.guestCount
            )}. The concierge will send a new quote before we cook.`}
          </p>
        ) : null}

        {address === null ? null : (
          <div>
            <p className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              Where
            </p>
            <p className="mt-1 font-sans text-sm text-parchment">{address}</p>
          </div>
        )}

        {appointment.menuItems.length === 0 ? null : (
          <div>
            <p className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              The menu
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {appointment.menuItems.map((dish) => (
                <li key={dish.id} className="font-sans text-sm text-parchment">
                  {dish.name}
                  {dish.quantity > 1 ? (
                    <span className="text-stone tabular-nums">
                      {` × ${String(dish.quantity)}`}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {appointment.cancellationReason === null ? null : (
          <div>
            <p className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
              Why it was withdrawn
            </p>
            <p className="mt-1 font-sans text-sm text-parchment">
              {appointment.cancellationReason}
            </p>
          </div>
        )}

        {changeable ? (
          <>
            <Separator variant="hairline" decorative />
            <div className="flex flex-wrap gap-2">
              <RescheduleAppointmentDialog
                appointment={toActionTarget(appointment)}
              />
              <CancelAppointmentDialog
                appointment={toActionTarget(appointment)}
              />
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default async function PortalAppointmentsPage(): Promise<React.JSX.Element> {
  const now = new Date()

  const [upcoming, past] = await Promise.all([
    listAppointments({ startsFrom: now, sortDirection: 'asc', pageSize: 25 }),
    listAppointments({ startsUntil: now, sortDirection: 'desc', pageSize: 25 }),
  ])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-3xl leading-tight font-light text-linen">
          Appointments
        </h2>
        <p className="font-sans text-sm leading-relaxed text-parchment">
          Everything in the diary, and everything we have already cooked.
        </p>
      </header>

      <Tabs defaultValue="upcoming">
        <TabsList variant="underline">
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="flex flex-col gap-5">
          {!upcoming.ok ? (
            <ActionError
              code={upcoming.code}
              error={upcoming.error}
              subject="your upcoming engagements"
            />
          ) : upcoming.data.items.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="Nothing in the diary."
              description="Choose this week's dishes and a window that suits you, and we will send it to the kitchen."
              action={
                <Button asChild variant="champagne">
                  <Link href="/portal/menu-selection">
                    Compose this week&rsquo;s menu
                  </Link>
                </Button>
              }
            />
          ) : (
            upcoming.data.items.map((appointment) => (
              <AppointmentCard
                key={appointment.id}
                appointment={appointment}
                changeable={CHANGEABLE.includes(appointment.status)}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="past" className="flex flex-col gap-5">
          {!past.ok ? (
            <ActionError
              code={past.code}
              error={past.error}
              subject="your past engagements"
            />
          ) : past.data.items.length === 0 ? (
            <EmptyState
              icon={History}
              title="Nothing behind you yet."
              description="Once a chef has cooked for you, the evening and its menu stay here."
            />
          ) : (
            past.data.items.map((appointment) => (
              <AppointmentCard
                key={appointment.id}
                appointment={appointment}
                changeable={false}
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
