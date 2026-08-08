// mannachef/apps/web/src/app/(portal)/portal/layout.tsx

/**
 * The client portal's shell, and its front door.
 *
 * ## The guard is server-side, and it is a redirect
 *
 * `getSessionUser()` runs on the server before a single child is rendered. A
 * visitor without a session is sent to the sign-in page with a `callbackUrl`
 * pointing back at the portal, so signing in returns them where they were going
 * rather than to the home page.
 *
 * This is a *navigation* guard, not a security boundary, and nothing here is
 * relied upon as one. Every action the pages below call re-resolves the session
 * itself inside `withAction` and re-checks ownership of every row it touches
 * (`CONTRACT.md` §5). Hiding a page is a courtesy to the person who wandered
 * into it; refusing the write is what actually protects the data. The rule this
 * layout obeys is the other half of that: **never rely on hiding UI** — so the
 * guard redirects rather than rendering an empty shell, and the pages assume
 * nothing from it.
 *
 * ## A signed-in caller with no household record
 *
 * A `User` can exist without a `ClientProfile` — a staff account, or a prospect
 * whose questionnaire has not yet been converted. Those callers are *not*
 * redirected: they are signed in, they are entitled to their own profile page,
 * and the actions behind every other page already return an empty list or a
 * `NOT_FOUND` for them. What they get instead is a banner saying so, and the
 * one link that would change it.
 */

import type * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { PortalNav } from '@/components/portal/portal-nav'
import { Button } from '@/components/ui/button'
import { getSessionUser } from '@/server/auth'

export const metadata: Metadata = {
  title: {
    default: 'Your portal',
    template: '%s · Your portal · MannaChef',
  },
  robots: { index: false, follow: false },
}

/** Where an unauthenticated visitor is sent, and where they come back to. */
const SIGN_IN_PATH = '/api/auth/signin'

export default async function PortalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const user = await getSessionUser()

  if (user === null) {
    redirect(`${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent('/portal')}`)
  }

  const displayName = user.name ?? user.email ?? 'your household'

  return (
    <div className="min-h-dvh bg-obsidian">
      <div className="mx-auto w-full max-w-7xl px-6 py-10 lg:py-14">
        <header className="flex flex-col gap-2 pb-8">
          <p className="font-sans text-xs tracking-[0.24em] text-champagne uppercase">
            MannaChef
          </p>
          <h1 className="font-display text-4xl leading-tight font-light text-linen">
            {`Good to see you, ${displayName}.`}
          </h1>
        </header>

        {user.clientProfileId === null ? (
          <div className="mb-8 flex flex-col gap-3 rounded-lg border border-terracotta/60 bg-terracotta/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-sans text-sm leading-relaxed text-parchment">
              There is no household record on this account yet, so most of the
              portal will be empty. Completing the questionnaire is what opens
              it.
            </p>
            <Button asChild variant="outline" className="shrink-0">
              <Link href="/consultation">Answer the questionnaire</Link>
            </Button>
          </div>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[15rem_1fr] lg:gap-12">
          <PortalNav />

          <main id="main-content" tabIndex={-1} className="min-w-0 outline-none">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
