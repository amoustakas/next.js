// mannachef/apps/web/src/middleware.ts

/**
 * One job: tell the admin layout which URL it is rendering.
 *
 * A Server Component layout is handed `params`, never the pathname — and the
 * business OS shell needs the pathname to decide whether the viewer's role
 * reaches the section they asked for. Next.js has no API for that, so the
 * pathname is stamped onto the request headers here, where `nextUrl` is
 * authoritative, and read back in `@/server/admin-access`.
 *
 * ## Why this is not a header the caller can forge
 *
 * {@link ADMIN_PATHNAME_HEADER} looks exactly like the kind of internal header
 * an attacker would try to send — and it is, which is why the line below uses
 * `set` rather than `append`. `set` **replaces** whatever arrived from the
 * network with the value of `request.nextUrl.pathname`, which is derived from
 * the request line and not from a header. There is no code path in which a
 * client-supplied value survives, and no route outside the matcher reads it.
 *
 * The direction of the guard matters too. The header selects the *minimum role*
 * a path demands; a forged value could only ever name a different section, and
 * the layout's floor (`CHEF_STAFF` for the whole tree) plus the role check
 * inside every single Server Action are what actually protect the data. This
 * header is how the shell stops showing a chef a page they cannot use — it is
 * not the thing standing between a chef and an invoice.
 *
 * ## Why authentication is deliberately *not* done here
 *
 * Middleware runs on the edge runtime, where the Prisma session lookup this
 * platform uses is unavailable. Resolving identity here would mean trusting a
 * decoded cookie without touching the database, and `User.isActive` would stop
 * being enforced. The session is therefore resolved in the layout, on Node,
 * through `getSessionUser()` — the same function every action uses.
 */

import { NextResponse, type NextRequest } from 'next/server'

import { ADMIN_PATHNAME_HEADER } from '@/lib/admin-headers'

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers)

  // `set`, never `append`: this overwrites anything the caller sent.
  headers.set(ADMIN_PATHNAME_HEADER, request.nextUrl.pathname)

  return NextResponse.next({ request: { headers } })
}

/**
 * Scoped to the business OS. Nothing else needs the header, and running
 * middleware over the marketing site would put a function invocation in front
 * of pages that are otherwise fully static.
 */
export const config = {
  matcher: ['/admin', '/admin/:path*'],
}
