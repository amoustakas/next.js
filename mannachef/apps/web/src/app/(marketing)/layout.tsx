// mannachef/apps/web/src/app/(marketing)/layout.tsx

/**
 * The public site's route-group shell.
 *
 * Its one non-negotiable job is the `<main>` landmark carrying
 * `id="main-content"`, which the skip link in the root layout targets — the
 * convention every route group in this application follows. The marketing
 * navigation and footer are assembled around that same `<main>`; nothing below
 * this file assumes anything about either of them.
 *
 * A Server Component. The only client boundary it introduces is
 * `<SiteHeader>`, which needs the scroll position and the mobile sheet's open
 * state; the footer, and every page rendered into `{children}`, stay on the
 * server.
 *
 * ## `tabIndex={-1}` on `<main>`
 *
 * A `<main>` is not focusable by default, so following `#main-content` would
 * move the *scroll* position while leaving keyboard focus at the top of the
 * document — and the very next Tab would return the guest to the navigation
 * they had just skipped. The negative tabindex makes the landing stick without
 * putting `<main>` into the tab order.
 *
 * ## `pt-16`
 *
 * The header is `fixed` so a hero can run under it. Everything that is not a
 * hero must therefore be pushed clear of its 4rem height, and a page that wants
 * the full-bleed treatment cancels it with a negative margin on its first
 * section — which the home page does, once, deliberately.
 */

import type * as React from 'react'
import type { Metadata } from 'next'

import { SiteFooter } from '@/components/marketing/site-footer'
import { SiteHeader } from '@/components/marketing/site-header'
import { BRAND_NAME, SITE_URL } from '@/components/marketing/site-config'

export const metadata: Metadata = {
  openGraph: {
    type: 'website',
    locale: 'en_CA',
    siteName: BRAND_NAME,
    url: SITE_URL,
  },
}

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col bg-obsidian">
      {/*
        Framer Motion serialises a reveal's `initial` state into inline styles
        during SSR, so a visitor whose JavaScript never arrives would be served
        `opacity: 0` markup with nothing to raise it. This rule runs only when
        scripting is disabled and forces every reveal to its resting state.
      */}
      <noscript>
        <style
          dangerouslySetInnerHTML={{
            __html:
              '[data-reveal]{opacity:1!important;transform:none!important;}',
          }}
        />
      </noscript>

      <SiteHeader />

      <main id="main-content" tabIndex={-1} className="flex-1 pt-16 outline-none">
        {children}
      </main>

      <SiteFooter />
    </div>
  )
}
