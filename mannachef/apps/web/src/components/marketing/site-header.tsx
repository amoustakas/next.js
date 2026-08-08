// mannachef/apps/web/src/components/marketing/site-header.tsx
'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  BRAND_NAME,
  CONSULTATION_CTA,
  PRIMARY_NAV,
} from '@/components/marketing/site-config'

/**
 * The public site's header.
 *
 * A client component, and one of only three on the marketing site, because it
 * owns two pieces of genuinely interactive state: how far the page has
 * scrolled, and whether the mobile navigation is open. Everything it *renders*
 * — the wordmark, the links, the call to action — is static markup that the
 * server produced.
 *
 * ## Transparent to charcoal
 *
 * Above the fold the header sits on the hero with no background at all, so the
 * photograph runs to the top of the viewport. Past 16px of scroll it takes a
 * charcoal ground, a hairline bottom border and a backdrop blur, so body copy
 * never runs under unreadable navigation. The switch is a CSS transition on
 * `background-color`/`border-color`, which means the `prefers-reduced-motion`
 * block in `globals.css` already collapses it to nothing — no JavaScript guard
 * is needed for a colour fade that is not, in any case, motion.
 *
 * The scroll listener is `passive` and reads `window.scrollY` only, so it never
 * blocks the compositor and never forces a layout.
 *
 * ## Accent discipline
 *
 * Exactly one champagne element lives here: the consultation button. The active
 * navigation link is marked with a linen hairline rather than a gold one, which
 * is what keeps `CONTRACT.md` §3's "at most one champagne/gold element per
 * visual group" true of the header as a whole rather than only of its parts.
 */
const SCROLL_THRESHOLD = 16

export function SiteHeader(): React.JSX.Element {
  const pathname = usePathname()
  const [isScrolled, setIsScrolled] = React.useState(false)
  const [isMobileNavOpen, setIsMobileNavOpen] = React.useState(false)

  React.useEffect(() => {
    const handleScroll = (): void => {
      setIsScrolled(window.scrollY > SCROLL_THRESHOLD)
    }

    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', handleScroll)
    }
  }, [])

  // A route change while the sheet is open would otherwise leave it covering
  // the page it just navigated to.
  React.useEffect(() => {
    setIsMobileNavOpen(false)
  }, [pathname])

  const isActive = (href: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`)

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-40',
        'transition-[background-color,border-color,backdrop-filter] duration-200 ease-luxe',
        isScrolled
          ? 'border-b border-ash/80 bg-charcoal/95 backdrop-blur-sm'
          : 'border-b border-transparent bg-transparent'
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-5 sm:px-8">
        <Link
          href="/"
          className="rounded-sm font-display text-xl leading-none font-medium tracking-[0.14em] text-linen uppercase"
        >
          {BRAND_NAME}
        </Link>

        <nav aria-label="Primary" className="hidden md:block">
          <ul className="flex items-center gap-8">
            {PRIMARY_NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cn(
                    'relative rounded-sm py-2 font-sans text-sm transition-colors duration-200 ease-luxe',
                    'after:absolute after:inset-x-0 after:-bottom-0.5 after:h-px after:origin-left after:bg-linen/70',
                    'after:transition-transform after:duration-200 after:ease-luxe',
                    isActive(item.href)
                      ? 'text-linen after:scale-x-100'
                      : 'text-parchment hover:text-linen after:scale-x-0 hover:after:scale-x-100'
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="champagne" size="sm" className="hidden sm:inline-flex">
            <Link href={CONSULTATION_CTA.href}>{CONSULTATION_CTA.label}</Link>
          </Button>

          <Sheet open={isMobileNavOpen} onOpenChange={setIsMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu aria-hidden="true" />
                <span className="sr-only">Open the menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="right" closeLabel="Close the menu">
              <SheetHeader>
                <SheetTitle className="font-display text-xl tracking-[0.14em] uppercase">
                  {BRAND_NAME}
                </SheetTitle>
                <SheetDescription>
                  Browse the menu, read how we work, or ask for a consultation.
                </SheetDescription>
              </SheetHeader>

              <nav aria-label="Primary, mobile">
                <ul className="flex flex-col">
                  {PRIMARY_NAV.map((item) => (
                    <li key={item.href} className="border-b border-ash/70">
                      <Link
                        href={item.href}
                        aria-current={isActive(item.href) ? 'page' : undefined}
                        className={cn(
                          'block rounded-sm py-4 font-sans text-base transition-colors duration-200 ease-luxe',
                          isActive(item.href)
                            ? 'text-linen'
                            : 'text-parchment hover:text-linen'
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>

              <Button asChild variant="champagne" fullWidth>
                <Link href={CONSULTATION_CTA.href}>{CONSULTATION_CTA.label}</Link>
              </Button>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
