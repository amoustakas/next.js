// mannachef/apps/web/src/components/admin/admin-sidebar.tsx
'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { Role } from '@mannachef/validators'

import { cn, FOCUS_RING } from '@/lib/utils'
import {
  navItemForPathname,
  visibleNavGroups,
  type AdminNavItem,
} from '@/lib/admin-nav'
import { Hint } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'

/**
 * The navigation rail.
 *
 * ## Collapsing
 *
 * The collapsed state lives in `useUiStore` and is persisted, so an operator who
 * prefers the icon rail keeps it across sessions. It is *passed in* rather than
 * read from the store here, because the same component renders inside the mobile
 * `<Sheet>` where collapsing makes no sense — a sheet that is already a drawer
 * does not need a narrower drawer.
 *
 * When collapsed the label is removed from the flow rather than hidden with
 * `sr-only`, and the accessible name moves onto the link's `aria-label`. A
 * `<Hint>` supplies the same words on hover and on focus, so the rail is
 * readable with a pointer, with a keyboard, and with a screen reader — three
 * different people, one label.
 *
 * ## What this component does not do
 *
 * It does not decide who may see what. `visibleNavGroups` filters by role, and
 * that filter is a *reflection* of the guard in `@/server/admin-access`, which
 * has already redirected anybody who does not belong on the page. If the two
 * ever disagree, the server wins and the operator meets a redirect rather than a
 * broken screen.
 */

export interface AdminSidebarProps {
  readonly role: Role
  /** Icon-only rail. Ignored inside the mobile sheet, which passes `false`. */
  readonly collapsed: boolean
  /** Present on the desktop rail; omitted in the sheet, which has its own close. */
  readonly onToggleCollapsed?: (() => void) | undefined
  /** Called after a destination is chosen — the sheet closes itself with it. */
  readonly onNavigate?: (() => void) | undefined
  /** The id the toggle's `aria-controls` points at. */
  readonly navigationId?: string | undefined
  readonly className?: string
}

export function AdminSidebar({
  role,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  navigationId,
  className,
}: AdminSidebarProps): React.JSX.Element {
  const pathname = usePathname()
  const groups = React.useMemo(() => visibleNavGroups(role), [role])
  const activeItem = navItemForPathname(pathname)

  return (
    <div className={cn('flex h-full flex-col gap-4', className)}>
      <div
        className={cn(
          'flex items-center gap-2 px-3 pt-4',
          collapsed ? 'justify-center' : 'justify-between'
        )}
      >
        {collapsed ? null : (
          <Link
            href="/admin"
            // Spread rather than pass directly: under `exactOptionalPropertyTypes`
            // an explicit `undefined` is not assignable to Link's `onClick`.
            {...(onNavigate ? { onClick: onNavigate } : {})}
            className={cn(
              'flex min-w-0 flex-col rounded-sm px-1 py-0.5 leading-none',
              FOCUS_RING
            )}
          >
            <span className="font-display text-lg font-light tracking-wide text-linen">
              MannaChef
            </span>
            <span className="font-sans text-[0.625rem] tracking-[0.24em] text-stone uppercase">
              Business OS
            </span>
          </Link>
        )}

        {onToggleCollapsed === undefined ? null : (
          <Hint label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-expanded={!collapsed}
              aria-controls={navigationId}
              className={cn(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-md',
                'border border-transparent text-stone',
                'transition-colors duration-150 ease-luxe',
                'hover:border-ash hover:bg-slate-warm hover:text-linen',
                FOCUS_RING
              )}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" className="size-4" />
              ) : (
                <PanelLeftClose aria-hidden="true" className="size-4" />
              )}
              <span className="sr-only">
                {collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
              </span>
            </button>
          </Hint>
        )}
      </div>

      <Separator variant="hairline" decorative />

      <nav
        id={navigationId}
        aria-label="Business OS sections"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4"
      >
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-1">
            {collapsed ? (
              <div
                aria-hidden="true"
                className="mx-auto my-1 h-px w-6 bg-ash"
              />
            ) : (
              <h2 className="px-3 font-sans text-[0.625rem] tracking-[0.18em] text-stone uppercase">
                {group.label}
              </h2>
            )}

            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <SidebarLink
                    item={item}
                    collapsed={collapsed}
                    active={activeItem?.href === item.href}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}

interface SidebarLinkProps {
  readonly item: AdminNavItem
  readonly collapsed: boolean
  readonly active: boolean
  readonly onNavigate?: (() => void) | undefined
}

function SidebarLink({
  item,
  collapsed,
  active,
  onNavigate,
}: SidebarLinkProps): React.JSX.Element {
  const Icon = item.icon

  const link = (
    <Link
      href={item.href}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-md px-3 py-2',
        'font-sans text-sm transition-colors duration-150 ease-luxe',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-slate-warm text-linen'
          : 'text-parchment hover:bg-slate-warm/60 hover:text-linen',
        FOCUS_RING
      )}
    >
      {/*
        The active mark is the single champagne element in this visual group —
        one 2px rule at the leading edge, not a filled row. CONTRACT.md §3.
      */}
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-champagne"
        />
      ) : null}

      <Icon
        aria-hidden="true"
        className={cn(
          'size-4 shrink-0',
          active ? 'text-champagne' : 'text-stone group-hover:text-parchment'
        )}
      />

      {collapsed ? null : <span className="truncate">{item.label}</span>}
    </Link>
  )

  if (!collapsed) {
    return link
  }

  return <Hint label={item.label} side="right">{link}</Hint>
}
