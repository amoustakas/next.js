// mannachef/apps/web/src/app/layout.tsx
import type { Metadata, Viewport } from 'next'
import { Cormorant_Garamond, Inter } from 'next/font/google'

import { cn } from '@/lib/utils'
import { Providers } from '@/app/providers'

import './globals.css'

/**
 * The root layout.
 *
 * A Server Component, and it stays one: the only client boundary in the whole
 * document is `<Providers>`, which receives `{children}` as an already-rendered
 * slot. A page below this tree is server-rendered unless it says otherwise.
 *
 * ## Fonts
 *
 * `next/font/google` self-hosts both faces at build time — no request to
 * `fonts.googleapis.com` at runtime, no layout shift from a late swap, and no
 * third-party origin in the critical path. Each face publishes a CSS variable
 * that `globals.css` already expects:
 *
 *  - `--font-cormorant` → `--font-display`, the serif. **Headings only.**
 *  - `--font-inter` → `--font-sans`, everything else.
 *
 * The weights are deliberately few. Cormorant carries 300–600 because a display
 * face earns its range; Inter is a variable font, so one declaration covers the
 * lot. `display: 'swap'` shows the fallback immediately rather than holding the
 * first paint hostage, and the fallback stacks are metric-adjacent so the swap
 * does not shove the page.
 */
const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
  fallback: ['ui-serif', 'Georgia', 'Times New Roman', 'serif'],
  preload: true,
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  fallback: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Helvetica Neue',
    'sans-serif',
  ],
  preload: true,
})

const SITE_NAME = 'MannaChef'
const SITE_DESCRIPTION =
  'Private chef service for the table you actually sit at — seasonal menus, cooked in your kitchen, planned around how you like to eat.'
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://mannachef.com'

/**
 * Site-wide metadata.
 *
 * `title.template` means a page exports `title: 'Menu'` and the tab reads
 * "Menu · MannaChef", while the home page's `title.default` stands alone. The
 * separator is a middle dot rather than a pipe, which is a small thing and
 * exactly the kind of small thing this brand is made of.
 *
 * `metadataBase` is what lets every `openGraph.images` entry below — and every
 * relative image a page adds later — resolve to an absolute URL, which is the
 * only kind a crawler will accept.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — Private chef, at your table`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  keywords: [
    'private chef',
    'personal chef',
    'in-home dining',
    'seasonal menu',
    'chef service',
    'Toronto private chef',
  ],
  referrer: 'strict-origin-when-cross-origin',
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
  openGraph: {
    type: 'website',
    locale: 'en_CA',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} — Private chef, at your table`,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} — private chef service`,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — Private chef, at your table`,
    description: SITE_DESCRIPTION,
    images: ['/opengraph-image'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  alternates: {
    canonical: '/',
  },
}

/**
 * `themeColor` matches `--color-obsidian` exactly, so the mobile browser chrome
 * continues the page rather than framing it. `colorScheme: 'dark'` tells the UA
 * to render its own widgets — scrollbars, form controls, the caret — dark, which
 * is the other half of `color-scheme: dark` in `globals.css`.
 */
export const viewport: Viewport = {
  themeColor: '#0B0A09',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html
      lang="en"
      dir="ltr"
      className={cn(cormorant.variable, inter.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-obsidian font-sans text-linen antialiased">
        {/*
          The skip link. First focusable element in the document, invisible
          until it has focus, then a champagne chip in the top-left. Without it
          a keyboard user tabs through the entire navigation on every single
          page before reaching anything they came for.

          It targets `#main-content`, which every route group's layout must put
          on its `<main>` element.

          The ring carries a `ring-offset-obsidian` gap (MCV-061). This chip is
          the one focusable element in the product whose own background is the
          ring colour, so a champagne ring drawn flush against a champagne pill
          is a 1:1 edge — a wider pill, not an indicator. The obsidian offset
          puts the page ground between the two, which reads as 11.49:1 on both
          sides and satisfies SC 1.4.11 the way the flush ring never did (at the
          40% alpha this used to carry it was 2.65:1 against the page as well).
        */}
        <a
          href="#main-content"
          className="sr-only rounded-md border border-gold/70 bg-champagne px-4 py-2 font-sans text-sm font-semibold text-obsidian focus-visible:not-sr-only focus-visible:absolute focus-visible:top-4 focus-visible:left-4 focus-visible:z-100 focus-visible:ring-2 focus-visible:ring-champagne focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian"
        >
          Skip to content
        </a>

        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
