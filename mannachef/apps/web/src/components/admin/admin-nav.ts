// mannachef/apps/web/src/components/admin/admin-nav.ts

/**
 * @deprecated **Dead module — nothing imports this.** Delete it.
 *
 * The navigation model the sidebar and command bar actually consume is
 * `@/lib/admin-nav`. This file is an earlier, diverged draft of it: 183 lines
 * against 466, the same four export names, and a different field name for the
 * same concept (`minimumRole` here, `minRole` there). `admin-sidebar.tsx`,
 * `command-bar.tsx`, `admin/layout.tsx` and `server/admin-access.ts` all import
 * the `@/lib` one; no file in `src/` or `scripts/` imports this one.
 *
 * It is kept compiling rather than deleted only because removing a file was not
 * this change's to make. It is a live trap while it exists: it declares the same
 * symbols as the real module, so an editor's auto-import can pull the wrong one
 * in, and a future nav change made here would silently do nothing. Whoever
 * touches admin navigation next should delete this file.
 *
 * The navigation model the admin sidebar and the command bar both consume.
 *
 * One declaration of every business-OS destination and the minimum role that
 * may reach it. `visibleNavGroups` is the single filter both surfaces call, so
 * a `CHEF_STAFF` sees the same rail as they could ⌘K into — nothing more.
 *
 * This is a reflection of the enforcement that already lives in the server
 * guards, never a substitute for it: hiding a link here does not close the
 * server action behind it, and every mutating action re-checks the caller's
 * role on its own regardless of what this file says.
 */

import {
  CalendarDays,
  ClipboardList,
  CreditCard,
  Gift,
  Images,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareQuote,
  Receipt,
  Repeat,
  UsersRound,
  UtensilsCrossed,
} from 'lucide-react'
import type { Route } from 'next'
import { hasRoleAtLeast, type Role } from '@mannachef/validators'

/** One destination in the business OS rail / command bar. */
export interface AdminNavItem {
  readonly label: string
  /** Typed as `Route` so a destination nobody built fails the typecheck. */
  readonly href: Route
  readonly icon: LucideIcon
  /** The role at or above which this destination may be reached. */
  readonly minimumRole: Role
}

/** A titled band of destinations. */
export interface AdminNavGroup {
  readonly id: string
  readonly label: string
  readonly items: readonly AdminNavItem[]
}

export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      {
        label: 'Overview',
        href: '/admin',
        icon: LayoutDashboard,
        minimumRole: 'CHEF_STAFF',
      },
    ],
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    items: [
      {
        label: 'Menu',
        href: '/admin/menu',
        icon: UtensilsCrossed,
        minimumRole: 'CHEF_STAFF',
      },
      {
        label: 'Media',
        href: '/admin/media',
        icon: Images,
        minimumRole: 'CHEF_STAFF',
      },
      {
        label: 'Reviews',
        href: '/admin/reviews',
        icon: MessageSquareQuote,
        minimumRole: 'ADMIN',
      },
    ],
  },
  {
    id: 'service',
    label: 'Service',
    items: [
      // "Bookings" (`/admin/bookings`) removed: the route was never built, and
      // the calendar below is the screen that answers it. Mirrors the same
      // removal in `@/lib/admin-nav`, which is the module actually in use.
      {
        label: 'Calendar',
        href: '/admin/calendar',
        icon: CalendarDays,
        minimumRole: 'CHEF_STAFF',
      },
      {
        label: 'Clients',
        href: '/admin/clients',
        icon: UsersRound,
        minimumRole: 'CHEF_STAFF',
      },
      {
        label: 'Intake',
        href: '/admin/intake',
        icon: ClipboardList,
        minimumRole: 'CHEF_STAFF',
      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      {
        label: 'Subscriptions',
        href: '/admin/subscriptions',
        icon: Repeat,
        minimumRole: 'ADMIN',
      },
      {
        label: 'Invoices',
        href: '/admin/invoices',
        icon: Receipt,
        minimumRole: 'ADMIN',
      },
      {
        label: 'Referrals',
        href: '/admin/referrals',
        icon: Gift,
        minimumRole: 'ADMIN',
      },
    ],
  },
  {
    id: 'house',
    label: 'The house',
    items: [
      {
        label: 'Staff',
        href: '/admin/staff',
        icon: CreditCard,
        minimumRole: 'ADMIN',
      },
      // "Settings" (`/admin/settings`) removed: there is no settings surface in
      // this application. The only editable configuration is the referral
      // programme's terms, which live on `/admin/referrals`. Mirrors the same
      // removal in `@/lib/admin-nav`.
    ],
  },
]

/**
 * The groups a viewer at `role` may see, with unreachable items removed and
 * any group left empty dropped entirely.
 *
 * Returns fresh arrays rather than filtering in place, so the module-level
 * `ADMIN_NAV_GROUPS` cannot be mutated by a caller.
 */
export function visibleNavGroups(role: Role): AdminNavGroup[] {
  const groups: AdminNavGroup[] = []

  for (const group of ADMIN_NAV_GROUPS) {
    const items = group.items.filter((item) =>
      hasRoleAtLeast(role, item.minimumRole)
    )

    if (items.length > 0) {
      groups.push({ id: group.id, label: group.label, items })
    }
  }

  return groups
}
