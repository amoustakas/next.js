// mannachef/apps/web/src/app/(admin)/admin/layout.tsx
import type { Metadata } from 'next'
import type * as React from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight, LogOut, Menu, Search } from 'lucide-react'

import { hasRoleAtLeast, type Role } from '@mannachef/validators'

import { getSessionUser, signOut } from '@/server/auth'
import { currentAdminPathname } from '@/server/admin-access'
import {
  ADMIN_FALLBACK_PATH,
  ADMIN_MINIMUM_ROLE,
  ADMIN_ROOT_PATH,
  breadcrumbsForPathname,
  visibleNavGroups,
  type AdminBreadcrumb,
  type AdminNavGroup,
} from '@/lib/admin-nav'
import { cn, FOCUS_RING } from '@/lib/utils'
import { AdminSidebar } from '@/components/admin/admin-sidebar'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, initialsFrom } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

/** Auth.js v5's default credential-less sign-in route (no custom page is configured). */
const SIGN_IN_PATH = '/api/auth/signin'

const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  CHEF_STAFF: 'Chef Staff',
  CLIENT: 'Client',
}

export const metadata: Metadata = {
  title: {
    template: '%s · Business OS · MannaChef',
    default: 'Business OS · MannaChef',
  },
}

interface AdminLayoutProps {
  readonly children: React.ReactNode
}

/**
 * The business OS shell.
 *
 * Every route under `/admin` renders inside this layout, so this is the one
 * place the role floor is enforced — `visibleNavGroups` inside
 * `<AdminSidebar>` only ever *reflects* the outcome decided here, it never
 * decides on its own. An unauthenticated visitor is sent to sign in; a
 * signed-in visitor below `CHEF_STAFF` is shown a real "you don't have
 * access" screen rather than being bounced to `/portal` — a bounce back and
 * forth between two role-gated shells is how a redirect loop gets written by
 * accident.
 */
export default async function AdminLayout({
  children,
}: AdminLayoutProps): Promise<React.JSX.Element> {
  const [user, pathname] = await Promise.all([
    getSessionUser(),
    currentAdminPathname(),
  ])

  const resolvedPathname = pathname ?? ADMIN_ROOT_PATH

  if (user === null) {
    redirect(`${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(resolvedPathname)}`)
  }

  if (!hasRoleAtLeast(user.role, ADMIN_MINIMUM_ROLE)) {
    return <ForbiddenScreen role={user.role} />
  }

  const breadcrumbs = breadcrumbsForPathname(resolvedPathname)
  const navGroups = visibleNavGroups(user.role)
  const displayName = user.name ?? user.email ?? 'Operator'

  return (
    <div className="flex min-h-screen bg-obsidian">
      <a
        href="#admin-main"
        className={cn(
          'sr-only rounded-md border border-ash bg-charcoal px-3 py-2 font-sans text-sm text-linen',
          'focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50',
          FOCUS_RING
        )}
      >
        Skip to content
      </a>

      <aside
        aria-label="Primary"
        className="hidden w-64 shrink-0 border-r border-ash lg:flex lg:flex-col"
      >
        <AdminSidebar role={user.role} collapsed={false} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ash bg-charcoal/95 px-4 py-3 backdrop-blur">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open navigation"
              >
                <Menu aria-hidden="true" className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-ash bg-charcoal p-0">
              <SheetTitle className="sr-only">Business OS navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Browse the sections of the business OS.
              </SheetDescription>
              <AdminSidebar role={user.role} collapsed={false} />
            </SheetContent>
          </Sheet>

          <Breadcrumbs items={breadcrumbs} />

          <div className="ml-auto flex items-center gap-2">
            <CommandBarMount groups={navGroups} />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Account menu for ${displayName}`}
                  className={cn(
                    'flex items-center gap-2 rounded-md border border-transparent p-1',
                    'transition-colors duration-150 ease-luxe hover:border-ash hover:bg-slate-warm',
                    FOCUS_RING
                  )}
                >
                  <Avatar size="sm">
                    <AvatarFallback>{initialsFrom(user.name)}</AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="flex flex-col gap-1 normal-case tracking-normal">
                  <span className="truncate font-sans text-sm font-medium text-linen">
                    {displayName}
                  </span>
                  {user.email === null ? null : (
                    <span className="truncate font-sans text-xs text-stone">
                      {user.email}
                    </span>
                  )}
                  <Badge variant="outline" className="w-fit">
                    {ROLE_LABEL[user.role]}
                  </Badge>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <form action={signOutAction}>
                  <DropdownMenuItem asChild variant="destructive">
                    <button type="submit" className="w-full text-left">
                      <LogOut aria-hidden="true" className="size-4" />
                      Sign out
                    </button>
                  </DropdownMenuItem>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main id="admin-main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 lg:px-8">
          {children}
        </main>
      </div>

      {/*
        The palette dialog below is intentionally uncontrolled — Radix owns its
        own open state via the trigger button's id. This tiny inline script is
        the one way to fire that same trigger from a global ⌘K without adding a
        client component solely to hold `useState` + a `keydown` listener.
      */}
      <script
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html:
            "(function(){document.addEventListener('keydown',function(event){var isK=event.key==='k'||event.key==='K';if(isK&&(event.metaKey||event.ctrlKey)){var trigger=document.getElementById('mc-command-trigger');if(trigger instanceof HTMLElement){event.preventDefault();trigger.click();}}});})();",
        }}
      />
    </div>
  )
}

async function signOutAction(): Promise<void> {
  'use server'
  await signOut({ redirectTo: '/' })
}

function Breadcrumbs({
  items,
}: {
  readonly items: readonly AdminBreadcrumb[]
}): React.JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-x-auto">
      <ol className="flex items-center gap-1.5 whitespace-nowrap">
        {items.map((crumb, index) => {
          const isLast = index === items.length - 1

          return (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index === 0 ? null : (
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-stone" />
              )}
              {crumb.href === null || isLast ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={cn('font-sans text-sm', isLast ? 'text-linen' : 'text-stone')}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={crumb.href}
                  className={cn(
                    'rounded-sm font-sans text-sm text-stone underline-offset-4',
                    'hover:text-linen hover:underline',
                    FOCUS_RING
                  )}
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function CommandBarMount({
  groups,
}: {
  readonly groups: readonly AdminNavGroup[]
}): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          id="mc-command-trigger"
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 text-parchment"
        >
          <Search aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Search or jump to…</span>
          <kbd
            aria-hidden="true"
            className="hidden items-center rounded-sm border border-ash bg-charcoal px-1.5 py-0.5 font-sans text-[0.6875rem] text-stone sm:inline-flex"
          >
            ⌘K
          </kbd>
          <span className="sr-only">Open the command bar</span>
        </Button>
      </DialogTrigger>
      <DialogContent hideCloseButton className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search for a page, then select it to go there.
        </DialogDescription>
        <Command className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-stone [&_[cmdk-group-heading]]:uppercase">
          <CommandInput placeholder="Jump to a section…" />
          <CommandList>
            <CommandEmpty>No matching section.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.id} heading={group.label}>
                {group.items.map((item) => {
                  const Icon = item.icon

                  return (
                    <CommandItem
                      key={item.href}
                      value={[item.label, item.description, ...item.keywords].join(' ')}
                    >
                      <DialogClose asChild>
                        <Link href={item.href} className="flex w-full items-center gap-3">
                          <Icon aria-hidden="true" className="size-4 shrink-0 text-stone" />
                          <span className="flex flex-col">
                            <span>{item.label}</span>
                            <span className="text-xs text-stone">{item.description}</span>
                          </span>
                        </Link>
                      </DialogClose>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function ForbiddenScreen({ role }: { readonly role: Role }): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center bg-obsidian px-6 py-16">
      <div className="w-full max-w-md rounded-lg border border-ash bg-slate-warm p-8 text-center shadow-[inset_0_1px_0_rgba(244,240,233,0.04)]">
        <p className="font-sans text-xs tracking-[0.24em] text-terracotta uppercase">
          Access restricted · 403
        </p>
        <h1 className="mt-3 font-display text-2xl font-light text-linen">
          This part of the Business OS isn&rsquo;t open to your account
        </h1>
        <p className="mt-3 font-sans text-sm leading-relaxed text-parchment">
          You&rsquo;re signed in as{' '}
          <span className="font-medium text-linen">{ROLE_LABEL[role]}</span>. Reaching this
          area needs Chef Staff access or higher — ask an admin to raise your access level if
          you believe this is wrong.
        </p>
        <div className="hairline mt-6" aria-hidden="true" />
        <Button asChild variant="champagne" className="mt-6">
          <Link href={ADMIN_FALLBACK_PATH}>Return to your portal</Link>
        </Button>
      </div>
    </main>
  )
}
