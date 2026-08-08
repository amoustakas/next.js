// mannachef/apps/web/src/lib/admin-nav.ts

/**
 * The map of the business OS.
 *
 * One declaration of every admin destination, the minimum role that may reach
 * it, and the words an operator might search for when they cannot remember what
 * it is called. Three very different consumers read this file, and they must
 * agree or the shell lies:
 *
 *  1. **The layout's server-side guard** (`@/server/admin-access`) turns a
 *     pathname into the role it demands, and redirects when the viewer falls
 *     short. That is the enforcement.
 *  2. **The sidebar** renders the groups the viewer may reach. That is a
 *     reflection of the enforcement, never a substitute for it — a nav that
 *     forgot to hide something must still not open it.
 *  3. **The command bar** turns the same list into navigation commands, filtered
 *     by the same rule, so a `CHEF_STAFF` cannot ⌘K their way into Invoices.
 *
 * The module is deliberately free of `'use client'` and `'use server'`: it is
 * plain data plus two pure functions, so it compiles into the server graph for
 * the guard and the browser graph for the chrome without either importing the
 * other.
 *
 * ## Why the minimum roles are what they are
 *
 * Each `minRole` below is the *floor of the actions the section calls*, read out
 * of `src/server/actions/**` rather than guessed:
 *
 *  - `menu.*` and `media.*` **reads** are public or `CHEF_STAFF`; their writes
 *    are `ADMIN`. The kitchen reads the catalogue to cook from it, so both
 *    sections sit at `CHEF_STAFF` and the *write* affordances inside them are
 *    gated separately on `canCurate`.
 *  - Review moderation, billing, referrals, staff administration and settings
 *    are `ADMIN` throughout, so their sections are too.
 *  - Bookings, the calendar, intake and clients are `CHEF_STAFF`: a chef needs
 *    the allergies, the address and the sitting they are cooking. The row-level
 *    ownership rules inside those actions are what stop one chef reading
 *    another's engagement, and no navigation decision can or should do that.
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
  Settings,
  UsersRound,
  UtensilsCrossed,
} from 'lucide-react'
import { hasRoleAtLeast, type Role } from '@mannachef/validators'

// =============================================================================
// 1. Shape
// =============================================================================

/** One destination in the business OS. */
export interface AdminNavItem {
  /** Absolute path. Also the identity used for prefix matching. */
  readonly href: string
  /** The word on the rail. Kept to one or two. */
  readonly label: string
  /** One line, shown in the command bar and in the collapsed rail's tooltip. */
  readonly description: string
  readonly icon: LucideIcon
  /** The role at or above which this section may be reached. */
  readonly minRole: Role
  /** Extra words the command bar should match on. */
  readonly keywords: readonly string[]
}

/** A titled band of the rail. */
export interface AdminNavGroup {
  readonly id: string
  readonly label: string
  readonly items: readonly AdminNavItem[]
}

// =============================================================================
// 2. The map
// =============================================================================

/**
 * The floor for the whole `/admin` tree.
 *
 * A `CLIENT` has no business anywhere below it; they are sent to their own
 * portal rather than shown an empty shell.
 */
export const ADMIN_MINIMUM_ROLE: Role = 'CHEF_STAFF'

/** Where the shell sends a signed-in caller who is not staff. */
export const ADMIN_FALLBACK_PATH = '/portal'

/** The root of the business OS. */
export const ADMIN_ROOT_PATH = '/admin'

export const ADMIN_NAV: readonly AdminNavGroup[] = [
  {
    id: 'today',
    label: 'Today',
    items: [
      {
        href: '/admin',
        label: 'Overview',
        description: 'The state of the kitchen, the diary and the books.',
        icon: LayoutDashboard,
        minRole: 'CHEF_STAFF',
        keywords: ['dashboard', 'home', 'summary', 'start'],
      },
    ],
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    items: [
      {
        href: '/admin/menu',
        label: 'Menu',
        description: 'Dishes, collections, courses and the tag vocabulary.',
        icon: UtensilsCrossed,
        minRole: 'CHEF_STAFF',
        keywords: ['dish', 'dishes', 'catalogue', 'catalog', 'seasonal', 'course', 'tag'],
      },
      {
        href: '/admin/media',
        label: 'Media',
        description: 'The photograph library behind every plate and page.',
        icon: Images,
        minRole: 'CHEF_STAFF',
        keywords: ['photo', 'photograph', 'image', 'library', 'asset', 'upload', 'gallery'],
      },
      {
        href: '/admin/reviews',
        label: 'Reviews',
        description: 'Moderate what guests have written, and feature the best.',
        icon: MessageSquareQuote,
        minRole: 'ADMIN',
        keywords: ['rating', 'moderation', 'testimonial', 'feedback'],
      },
    ],
  },
  {
    id: 'service',
    label: 'Service',
    items: [
      {
        href: '/admin/bookings',
        label: 'Bookings',
        description: 'Engagements from first enquiry through to the plate.',
        icon: ClipboardList,
        minRole: 'CHEF_STAFF',
        keywords: ['appointment', 'engagement', 'sitting', 'service', 'event'],
      },
      {
        href: '/admin/calendar',
        label: 'Calendar',
        description: 'Availability, sittings and who is cooking when.',
        icon: CalendarDays,
        minRole: 'CHEF_STAFF',
        keywords: ['diary', 'schedule', 'availability', 'slot'],
      },
      {
        href: '/admin/intake',
        label: 'Intake',
        description: 'Household questionnaires: allergies, dislikes, kitchens.',
        icon: ClipboardList,
        minRole: 'CHEF_STAFF',
        keywords: ['questionnaire', 'form', 'allergy', 'allergen', 'dietary', 'consultation'],
      },
    ],
  },
  {
    id: 'relationships',
    label: 'Relationships',
    items: [
      {
        href: '/admin/clients',
        label: 'Clients',
        description: 'Households, their history and the notes kept on them.',
        icon: UsersRound,
        minRole: 'CHEF_STAFF',
        keywords: ['household', 'crm', 'customer', 'guest', 'contact', 'note'],
      },
      {
        href: '/admin/referrals',
        label: 'Referrals',
        description: 'Invitation codes, rewards and who introduced whom.',
        icon: Gift,
        minRole: 'ADMIN',
        keywords: ['invite', 'code', 'reward', 'introduction', 'programme', 'program'],
      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      {
        href: '/admin/subscriptions',
        label: 'Subscriptions',
        description: 'Plans, pauses, changes and cancellations.',
        icon: Repeat,
        minRole: 'ADMIN',
        keywords: ['plan', 'recurring', 'stripe', 'billing', 'membership'],
      },
      {
        href: '/admin/invoices',
        label: 'Invoices',
        description: 'What has been billed, what has been paid, what has not.',
        icon: Receipt,
        minRole: 'ADMIN',
        keywords: ['bill', 'payment', 'receipt', 'ledger', 'refund', 'stripe'],
      },
    ],
  },
  {
    id: 'house',
    label: 'The house',
    items: [
      {
        href: '/admin/staff',
        label: 'Staff',
        description: 'Chefs, their profiles and what each of them may reach.',
        icon: CreditCard,
        minRole: 'ADMIN',
        keywords: ['chef', 'team', 'role', 'permission', 'access', 'people'],
      },
      {
        href: '/admin/settings',
        label: 'Settings',
        description: 'How the platform behaves, and who may change it.',
        icon: Settings,
        minRole: 'ADMIN',
        keywords: ['configuration', 'preferences', 'account', 'integration'],
      },
    ],
  },
]

/** Every item, flattened, in rail order. */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = ADMIN_NAV.flatMap(
  (group) => group.items
)

// =============================================================================
// 3. Pure lookups
// =============================================================================

/** `true` when `role` may reach `item`. */
export function canReachNavItem(role: Role, item: AdminNavItem): boolean {
  return hasRoleAtLeast(role, item.minRole)
}

/**
 * The groups a viewer may see, with the items they may not reach removed and
 * any group left empty dropped entirely.
 *
 * Returns fresh arrays rather than filtering in place, so the module-level
 * `ADMIN_NAV` cannot be mutated by a caller.
 */
export function visibleNavGroups(role: Role): AdminNavGroup[] {
  const groups: AdminNavGroup[] = []

  for (const group of ADMIN_NAV) {
    const items = group.items.filter((item) => canReachNavItem(role, item))

    if (items.length > 0) {
      groups.push({ id: group.id, label: group.label, items })
    }
  }

  return groups
}

/**
 * The nav item that owns `pathname`, or `null`.
 *
 * Longest-prefix wins, so `/admin/menu/tags` resolves to Menu rather than to
 * Overview — `/admin` is a prefix of everything and would otherwise always
 * match. A prefix only counts when the next character is a `/`, so a future
 * `/admin/menus` section could never be mistaken for `/admin/menu`.
 */
export function navItemForPathname(pathname: string): AdminNavItem | null {
  let best: AdminNavItem | null = null

  for (const item of ADMIN_NAV_ITEMS) {
    const isMatch =
      pathname === item.href || pathname.startsWith(`${item.href}/`)

    if (!isMatch) {
      continue
    }

    if (best === null || item.href.length > best.href.length) {
      best = item
    }
  }

  return best
}

/**
 * The role `pathname` demands.
 *
 * An unmapped path inside `/admin` falls back to {@link ADMIN_MINIMUM_ROLE}
 * rather than to "anyone": a section somebody adds without registering it here
 * is still behind the tree floor, and its own actions still enforce their own
 * requirement. It is a floor, not a ceiling, and never a grant.
 */
export function minimumRoleForPathname(pathname: string): Role {
  return navItemForPathname(pathname)?.minRole ?? ADMIN_MINIMUM_ROLE
}

/** `true` when a viewer at `role` may open `pathname`. */
export function canReachPathname(role: Role, pathname: string): boolean {
  return hasRoleAtLeast(role, minimumRoleForPathname(pathname))
}

// =============================================================================
// 4. Breadcrumbs
// =============================================================================

/** One step of the trail above a page's title. */
export interface AdminBreadcrumb {
  readonly label: string
  /** `null` for the final crumb, which is the page you are already on. */
  readonly href: string | null
}

/** Matches a cuid/cuid2 well enough to know it is an id rather than a word. */
const OPAQUE_ID_PATTERN = /^(?:c[a-z0-9]{20,}|[a-z0-9]{24,})$/i

/** `menu-items` → `Menu items`. Ids become a neutral word instead. */
function humanizeSegment(segment: string): string {
  if (OPAQUE_ID_PATTERN.test(segment)) {
    return 'Detail'
  }

  const words = segment.replace(/-/g, ' ').trim()

  if (words.length === 0) {
    return segment
  }

  return `${words.slice(0, 1).toLocaleUpperCase('en-CA')}${words.slice(1)}`
}

/**
 * The trail for a pathname inside `/admin`.
 *
 * Always begins at the business OS root, then the owning section, then whatever
 * lies below it. The last crumb never carries an `href` — an anchor that points
 * at the page you are standing on is noise for a keyboard user and a lie to a
 * screen reader.
 */
export function breadcrumbsForPathname(pathname: string): AdminBreadcrumb[] {
  const crumbs: AdminBreadcrumb[] = [
    { label: 'Business OS', href: ADMIN_ROOT_PATH },
  ]

  const item = navItemForPathname(pathname)

  if (item !== null && item.href !== ADMIN_ROOT_PATH) {
    crumbs.push({ label: item.label, href: item.href })
  }

  const consumed = item?.href ?? ADMIN_ROOT_PATH
  const rest = pathname
    .slice(consumed.length)
    .split('/')
    .filter((segment) => segment.length > 0)

  let walked = consumed

  for (const segment of rest) {
    walked = `${walked}/${segment}`
    crumbs.push({ label: humanizeSegment(segment), href: walked })
  }

  const last = crumbs[crumbs.length - 1]

  if (last !== undefined) {
    crumbs[crumbs.length - 1] = { label: last.label, href: null }
  }

  return crumbs
}
