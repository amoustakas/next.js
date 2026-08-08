// mannachef/apps/web/src/components/marketing/site-config.ts

/**
 * The business, written down once.
 *
 * The header, the footer, the contact page and every `generateMetadata` on the
 * public site read their facts from here. A phone number that appears in three
 * files is a phone number that will be wrong in two of them.
 *
 * Nothing in this module is a component and nothing in it is a client
 * reference, so it is importable from a Server Component and from a client
 * island alike.
 */

/** How the brand is written, everywhere. */
export const BRAND_NAME = 'MannaChef'

/** The one-line description used as the fallback meta description. */
export const BRAND_TAGLINE = 'Private chef, at your table'

/**
 * The canonical origin.
 *
 * Mirrors the root layout's `metadataBase` so a page-level `alternates.canonical`
 * and an absolute Open Graph image resolve against the same host.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://mannachef.com'

/**
 * Where the kitchen actually is, and how to reach it.
 *
 * The telephone number is inside the +1-555-01xx range that the CRTC and NANPA
 * reserve for fiction, which is the honest thing to ship in a repository: a
 * real-looking number here would ring a stranger.
 */
export const CONTACT = {
  email: 'hello@mannachef.com',
  /** Pretty form, for reading. */
  phoneDisplay: '(416) 555-0142',
  /** E.164, for `tel:` and for `phoneSchema`. */
  phoneE164: '+14165550142',
  street: '148 Ossington Avenue, Unit 3',
  locality: 'Toronto',
  region: 'Ontario',
  regionCode: 'ON',
  postalCode: 'M6J 2Z5',
  country: 'Canada',
  countryCode: 'CA',
} as const

/** The prep kitchen's office hours — not the hours we cook, which are yours. */
export const OFFICE_HOURS: ReadonlyArray<{
  readonly days: string
  readonly hours: string
}> = [
  { days: 'Tuesday – Friday', hours: '10:00 – 18:00 ET' },
  { days: 'Saturday', hours: '10:00 – 14:00 ET' },
  { days: 'Sunday & Monday', hours: 'Closed — enquiries answered next day' },
]

/** Where we cook without a travel arrangement. */
export const SERVICE_AREA: readonly string[] = [
  'Toronto & East York',
  'North York, Etobicoke & Scarborough',
  'Mississauga, Oakville & Burlington',
  'Vaughan, Richmond Hill & Markham',
  'Hamilton & Niagara-on-the-Lake',
]

/** Plain operating facts. No awards, no testimonials, no claims we cannot keep. */
export const OPERATING_FACTS: readonly string[] = [
  'Ontario Food Handler Certification held by every chef in the kitchen',
  'Commercial general liability cover carried on every engagement',
  'HST shown as a separate line on every invoice',
  'Ingredients sourced weekly from Ontario growers, millers and fishers',
]

/**
 * The primary navigation.
 *
 * `as const` matters: `typedRoutes` is on in `next.config.ts`, and a widened
 * `string` would not satisfy the generated `Route` type at build time.
 */
export const PRIMARY_NAV = [
  { href: '/menu', label: 'The menu' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
] as const

export type PrimaryNavItem = (typeof PRIMARY_NAV)[number]

/** The single call to action the public site repeats. */
export const CONSULTATION_CTA = {
  href: '/contact',
  label: 'Request a consultation',
} as const

/** Off-site profiles. Plain anchors — these leave the app. */
export const SOCIAL_LINKS: ReadonlyArray<{
  readonly href: string
  readonly label: string
}> = [
  { href: 'https://www.instagram.com/mannachef', label: 'Instagram' },
  { href: 'https://ca.linkedin.com/company/mannachef', label: 'LinkedIn' },
]

/** `148 Ossington Avenue, Unit 3, Toronto, ON M6J 2Z5` — one line. */
export function formattedAddress(): string {
  return `${CONTACT.street}, ${CONTACT.locality}, ${CONTACT.regionCode} ${CONTACT.postalCode}`
}
