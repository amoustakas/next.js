// mannachef/apps/web/src/components/portal/status-badges.tsx

/**
 * The four status vocabularies the portal renders, each as a `<Badge>` with a
 * tone and a sentence a guest can read.
 *
 * No `'use client'`: these are pure functions of their props, so they render on
 * the server inside the pages that use them and cost the browser nothing.
 *
 * ## Why the labels are not `titleCase(status)`
 *
 * `NO_SHOW` is not "No show" to the person it happened to, and `INCOMPLETE` on
 * a subscription does not mean the subscriber left something out — it means
 * Stripe has not yet taken the first payment. A machine token turned into
 * sentence case reads like an apology from a database. Each label below is
 * written for the household.
 *
 * Every map is `Record<X, …>` over the exact union from `@mannachef/validators`,
 * so a value added to one of those enums is a compile error here rather than a
 * silently unlabelled badge.
 */

import type * as React from 'react'

import type {
  AppointmentStatus,
  InvoiceStatus,
  ReferralRedemptionStatus,
  SubscriptionStatus,
} from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'

type BadgeVariant =
  | 'default'
  | 'champagne'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'muted'
  | 'outline'

interface StatusPresentation {
  readonly label: string
  readonly variant: BadgeVariant
}

// =============================================================================
// Appointments
// =============================================================================

const APPOINTMENT_STATUS: Readonly<
  Record<AppointmentStatus, StatusPresentation>
> = {
  REQUESTED: { label: 'Awaiting confirmation', variant: 'warning' },
  CONFIRMED: { label: 'Confirmed', variant: 'success' },
  IN_PROGRESS: { label: 'Under way', variant: 'champagne' },
  COMPLETED: { label: 'Cooked', variant: 'muted' },
  CANCELLED: { label: 'Withdrawn', variant: 'outline' },
  NO_SHOW: { label: 'Nobody home', variant: 'destructive' },
}

export function AppointmentStatusBadge({
  status,
}: {
  readonly status: AppointmentStatus
}): React.JSX.Element {
  const presentation = APPOINTMENT_STATUS[status]

  return (
    <Badge variant={presentation.variant} srPrefix="Status: ">
      {presentation.label}
    </Badge>
  )
}

// =============================================================================
// Subscriptions
// =============================================================================

const SUBSCRIPTION_STATUS: Readonly<
  Record<SubscriptionStatus, StatusPresentation>
> = {
  INCOMPLETE: { label: 'Awaiting first payment', variant: 'warning' },
  INCOMPLETE_EXPIRED: { label: 'Never started', variant: 'outline' },
  TRIALING: { label: 'On trial', variant: 'champagne' },
  ACTIVE: { label: 'Active', variant: 'success' },
  PAST_DUE: { label: 'Payment overdue', variant: 'destructive' },
  CANCELED: { label: 'Ended', variant: 'outline' },
  UNPAID: { label: 'Unpaid', variant: 'destructive' },
  PAUSED: { label: 'Resting', variant: 'muted' },
}

export function SubscriptionStatusBadge({
  status,
}: {
  readonly status: SubscriptionStatus
}): React.JSX.Element {
  const presentation = SUBSCRIPTION_STATUS[status]

  return (
    <Badge variant={presentation.variant} srPrefix="Subscription status: ">
      {presentation.label}
    </Badge>
  )
}

// =============================================================================
// Invoices
// =============================================================================

const INVOICE_STATUS: Readonly<Record<InvoiceStatus, StatusPresentation>> = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  OPEN: { label: 'Due', variant: 'warning' },
  PAID: { label: 'Paid', variant: 'success' },
  VOID: { label: 'Voided', variant: 'outline' },
  UNCOLLECTIBLE: { label: 'Written off', variant: 'muted' },
}

export function InvoiceStatusBadge({
  status,
}: {
  readonly status: InvoiceStatus
}): React.JSX.Element {
  const presentation = INVOICE_STATUS[status]

  return (
    <Badge variant={presentation.variant} srPrefix="Invoice status: ">
      {presentation.label}
    </Badge>
  )
}

// =============================================================================
// Referral redemptions
// =============================================================================

const REDEMPTION_STATUS: Readonly<
  Record<ReferralRedemptionStatus, StatusPresentation>
> = {
  PENDING: { label: 'Waiting to qualify', variant: 'warning' },
  QUALIFIED: { label: 'Qualified', variant: 'champagne' },
  REWARDED: { label: 'Rewarded', variant: 'success' },
  EXPIRED: { label: 'Lapsed', variant: 'outline' },
  REVOKED: { label: 'Withdrawn', variant: 'destructive' },
}

export function RedemptionStatusBadge({
  status,
}: {
  readonly status: ReferralRedemptionStatus
}): React.JSX.Element {
  const presentation = REDEMPTION_STATUS[status]

  return (
    <Badge variant={presentation.variant} srPrefix="Redemption status: ">
      {presentation.label}
    </Badge>
  )
}
