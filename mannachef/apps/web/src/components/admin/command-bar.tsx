// mannachef/apps/web/src/components/admin/command-bar.tsx
'use client'

import * as React from 'react'
import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import {
  CalendarPlus,
  Receipt,
  Search,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'
import { hasRoleAtLeast, type Role } from '@mannachef/validators'

import { visibleNavGroups, type AdminNavItem } from '@/lib/admin-nav'
import type { AdminViewerView } from '@/components/admin/view-models'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'

/**
 * The ⌘K command bar for the business OS.
 *
 * ## What it lists, and why that list can shrink
 *
 * Two sources feed the palette: {@link visibleNavGroups} (every destination
 * the sidebar would show, from `@/lib/admin-nav`) and {@link QUICK_ACTIONS}
 * (a handful of "create" shortcuts this file owns). Both are filtered by
 * `viewer.role` before anything is rendered — a `CHEF_STAFF` never sees
 * "Invoices" or "New invoice" appear and then get refused; the command
 * simply is not in the list. That filtering is, as the nav module's own
 * docs say of itself, a *reflection* of the enforcement inside the server
 * guards and the actions behind each destination, never a substitute for
 * it. Selecting "New invoice" only ever navigates to `/admin/invoices` —
 * the manual-invoice action itself is `ADMIN`-gated on the server and is
 * never called from here.
 *
 * ## Keyboard contract
 *
 *  - `⌘K` / `Ctrl+K` from anywhere toggles the palette open and closed.
 *  - Every item is a `cmdk` combobox option: arrow keys move
 *    `aria-activedescendant` and the visible `data-[selected=true]` state
 *    inherited from `<CommandItem>`; `Enter` activates the highlighted item;
 *    typing filters fuzzily over each item's label, description and
 *    keywords.
 *  - `Escape`, the overlay, and selecting an item all close it.
 *  - Closing — by any of those paths — moves focus back to the trigger
 *    button that opened it, deliberately, rather than trusting Radix's
 *    default "wherever focus happened to be" restoration: a global shortcut
 *    can open the palette with nothing in particular focused, and this way
 *    the operator always lands somewhere they can find, not on the body.
 */

interface QuickAction {
  readonly id: string
  readonly label: string
  readonly description: string
  /** Typed as `Route` so a shortcut to a screen nobody built fails the build. */
  readonly href: Route
  readonly icon: LucideIcon
  /** The role at or above which this shortcut may be offered. */
  readonly minRole: Role
  readonly keywords: readonly string[]
}

/**
 * Create shortcuts. Each one only ever navigates to the screen that owns the
 * actual form — this file has no server action import and starts no
 * mutation itself. The destination page is responsible for opening its own
 * create flow when it sees `?new=…`.
 *
 * `minRole` mirrors the floor of the action the destination screen will
 * eventually call (`menu.items.create` and `invoice.create` are `ADMIN`;
 * `appointment.create` sits under the `CHEF_STAFF` bookings section), so a
 * viewer never sees a shortcut to a form they could not submit.
 */
const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: 'new-menu-item',
    label: 'New menu item',
    description: 'Add a dish to the catalogue.',
    href: '/admin/menu?new=item',
    icon: UtensilsCrossed,
    minRole: 'ADMIN',
    keywords: ['dish', 'create', 'add', 'catalogue', 'catalog', 'menu'],
  },
  {
    id: 'new-appointment',
    label: 'New appointment',
    description: 'Schedule an engagement for a client.',
    href: '/admin/bookings?new=appointment',
    icon: CalendarPlus,
    minRole: 'CHEF_STAFF',
    keywords: ['booking', 'engagement', 'schedule', 'sitting', 'create'],
  },
  {
    id: 'new-invoice',
    label: 'New invoice',
    description: 'Bill a client manually.',
    href: '/admin/invoices?new=invoice',
    icon: Receipt,
    minRole: 'ADMIN',
    keywords: ['bill', 'charge', 'create', 'manual', 'payment'],
  },
]

export interface CommandBarProps {
  readonly viewer: AdminViewerView
  /** Extra classes for the trigger button, so a header can size/place it. */
  readonly className?: string
}

export function CommandBar({
  viewer,
  className,
}: CommandBarProps): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [isMac, setIsMac] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/.test(window.navigator.userAgent))
  }, [])

  const navGroups = React.useMemo(
    () => visibleNavGroups(viewer.role),
    [viewer.role]
  )

  const quickActions = React.useMemo(
    () =>
      QUICK_ACTIONS.filter((action) =>
        hasRoleAtLeast(viewer.role, action.minRole)
      ),
    [viewer.role]
  )

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next)

    if (!next) {
      // Deferred past Radix's own focus-restore pass (which returns focus to
      // whatever was focused when the palette opened — the body, if it was
      // opened by the global shortcut). This runs after it, so the operator
      // always ends up back on the trigger, however the palette was opened.
      window.setTimeout(() => {
        triggerRef.current?.focus()
      }, 0)
    }
  }, [])

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const isToggleChord =
        event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)

      if (!isToggleChord) {
        return
      }

      event.preventDefault()
      handleOpenChange(!open)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleOpenChange])

  const navigateTo = React.useCallback(
    (href: Route) => {
      handleOpenChange(false)
      router.push(href)
    },
    [handleOpenChange, router]
  )

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => handleOpenChange(true)}
        className={className}
      >
        <Search aria-hidden="true" className="size-4 text-stone" />
        <span>Search</span>
        <span
          aria-hidden="true"
          className="ml-2 hidden items-center gap-0.5 rounded-sm border border-ash bg-charcoal px-1.5 py-0.5 font-sans text-[0.625rem] tracking-wide text-stone sm:inline-flex"
        >
          <kbd className="font-sans">{isMac ? '⌘' : 'Ctrl'}</kbd>
          <kbd className="font-sans">K</kbd>
        </span>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Command bar"
        description="Search for a page or a quick action, then press Enter."
      >
        <CommandInput placeholder="Search pages and actions…" />
        <CommandList aria-label="Command results">
          <CommandEmpty>No results found.</CommandEmpty>

          {quickActions.length > 0 ? (
            <>
              <CommandGroup heading="Quick actions">
                {quickActions.map((action) => {
                  const Icon = action.icon

                  return (
                    <CommandItem
                      key={action.id}
                      value={action.label}
                      keywords={[action.description, ...action.keywords]}
                      onSelect={() => navigateTo(action.href)}
                    >
                      <Icon aria-hidden="true" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{action.label}</span>
                        <span className="truncate text-xs text-stone">
                          {action.description}
                        </span>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}

          {navGroups.map((group) => (
            <CommandGroup key={group.id} heading={group.label}>
              {group.items.map((item: AdminNavItem) => {
                const Icon = item.icon

                return (
                  <CommandItem
                    key={item.href}
                    value={item.label}
                    keywords={[item.description, ...item.keywords]}
                    onSelect={() => navigateTo(item.href)}
                  >
                    <Icon aria-hidden="true" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{item.label}</span>
                      <span className="truncate text-xs text-stone">
                        {item.description}
                      </span>
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  )
}
