// mannachef/apps/web/src/components/portal/portal-nav.tsx
'use client'

/**
 * The portal's navigation.
 *
 * A client component for exactly one reason: `usePathname`. Which link is
 * current is a fact about the URL, and marking it needs `aria-current="page"`
 * as well as a colour — a coloured link that does not say it is current is
 * invisible to a screen reader and to anybody who cannot distinguish the two
 * greys.
 *
 * The list itself is static data and the labels are plain text, so nothing else
 * in this component needs to be interactive: no state, no effects, no store.
 *
 * ## Two layouts, one list
 *
 * Below `lg` the links are a horizontally scrollable row above the content;
 * from `lg` they are a column beside it. Both render the same `<ul>` in the
 * same order inside the same `<nav>`, so the reading order and the tab order
 * are identical at every width — which is the property a separate mobile menu
 * usually gives up.
 */

import * as React from 'react'
import type { Route } from 'next'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  CalendarDays,
  CreditCard,
  Gift,
  LayoutDashboard,
  ReceiptText,
  UserRound,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'

interface PortalLink {
  /** Typed as `Route` so a destination nobody built fails the typecheck. */
  readonly href: Route
  readonly label: string
  readonly icon: LucideIcon
}

const LINKS: readonly PortalLink[] = [
  { href: '/portal', label: 'Overview', icon: LayoutDashboard },
  {
    href: '/portal/menu-selection',
    label: 'This week’s menu',
    icon: UtensilsCrossed,
  },
  { href: '/portal/appointments', label: 'Appointments', icon: CalendarDays },
  { href: '/portal/subscription', label: 'Subscription', icon: CreditCard },
  { href: '/portal/invoices', label: 'Invoices', icon: ReceiptText },
  { href: '/portal/referrals', label: 'Referrals', icon: Gift },
  { href: '/portal/profile', label: 'Profile', icon: UserRound },
]

/**
 * `/portal` is current only on itself; every other entry is current for its own
 * subtree, so a detail page under `/portal/appointments/…` still highlights
 * "Appointments".
 */
function isCurrent(pathname: string, href: string): boolean {
  if (href === '/portal') {
    return pathname === '/portal'
  }

  return pathname === href || pathname.startsWith(`${href}/`)
}

export function PortalNav(): React.JSX.Element {
  const pathname = usePathname()

  return (
    <nav aria-label="Portal sections" className="lg:sticky lg:top-8">
      <ul
        className={cn(
          'flex gap-1 overflow-x-auto pb-2',
          'lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0'
        )}
      >
        {LINKS.map((link) => {
          const current = isCurrent(pathname, link.href)
          const Icon = link.icon

          return (
            <li key={link.href} className="shrink-0 lg:shrink">
              <Link
                href={link.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md border px-3 py-2',
                  'font-sans text-sm whitespace-nowrap',
                  'transition-colors duration-150 ease-[var(--ease-luxe)]',
                  current
                    ? 'border-ash bg-slate-warm text-linen'
                    : 'border-transparent text-stone hover:bg-slate-warm/50 hover:text-parchment'
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'size-4 shrink-0',
                    current ? 'text-champagne' : 'text-stone'
                  )}
                />
                {link.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
