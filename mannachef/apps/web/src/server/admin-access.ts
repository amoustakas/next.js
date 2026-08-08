// mannachef/apps/web/src/server/admin-access.ts

/**
 * The business OS front door.
 *
 * `CONTRACT.md` §5 is explicit that a hidden button is not a permission check,
 * and nothing in this file pretends otherwise: every Server Action the admin
 * screens call re-resolves the session and re-checks the caller's role inside
 * `withAction`, and every id that arrives from a browser is re-read before it is
 * used. What this module adds is the *navigation* half — a chef who follows a
 * bookmark into `/admin/invoices` should meet a redirect, not an empty table
 * whose every action answers `FORBIDDEN`.
 *
 * It runs in the layout, on the Node runtime, before a single child renders.
 *
 * ## Three decisions, in order
 *
 *  1. **No session** → the sign-in page, carrying a `callbackUrl` so the
 *     operator lands where they were going.
 *  2. **Session below `CHEF_STAFF`** → their own portal. A `CLIENT` is not an
 *     error, they are simply somewhere else in the building.
 *  3. **Session below the section's own floor** → the OS root. They are staff,
 *     they are allowed in the building, and this one room is not theirs.
 *
 * The third needs the pathname, which a Server Component layout is never given.
 * `src/middleware.ts` stamps it onto the request headers — see that file for
 * why the value cannot be forged — and {@link currentAdminPathname} reads it
 * back. When the header is absent (middleware disabled, a unit test, a runtime
 * that skipped it) the section check is skipped and only the tree floor
 * applies; the actions behind the page are what refuse the write in that case,
 * which is exactly the layering this file is built on.
 */

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { hasRoleAtLeast, type Role } from '@mannachef/validators'

import { ADMIN_PATHNAME_HEADER } from '@/lib/admin-headers'
import {
  ADMIN_FALLBACK_PATH,
  ADMIN_MINIMUM_ROLE,
  ADMIN_ROOT_PATH,
  minimumRoleForPathname,
} from '@/lib/admin-nav'
import { getSessionUser } from '@/server/auth'

/** Auth.js's built-in sign-in route. */
const SIGN_IN_PATH = '/api/auth/signin'

/**
 * What the shell renders itself from.
 *
 * Deliberately *not* `AuthenticatedUser`: this crosses into client components,
 * and `clientProfileId` / `staffProfileId` / `locale` are of no use to the
 * chrome. A payload carries what the screen needs and nothing more, even when
 * the extra fields would be harmless.
 */
export interface AdminViewer {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  readonly image: string | null
  readonly role: Role
  /** `true` at `ADMIN` and above — the threshold every menu/media write sits behind. */
  readonly canCurate: boolean
  /** `true` at `SUPER_ADMIN` — role assignment and the destructive settings. */
  readonly canGovern: boolean
}

/**
 * The pathname currently being rendered, or `null` when middleware did not run.
 *
 * @see ADMIN_PATHNAME_HEADER
 */
export async function currentAdminPathname(): Promise<string | null> {
  const requestHeaders = await headers()
  const pathname = requestHeaders.get(ADMIN_PATHNAME_HEADER)

  if (pathname === null || !pathname.startsWith(ADMIN_ROOT_PATH)) {
    return null
  }

  return pathname
}

/**
 * Resolve the operator, or redirect.
 *
 * Never returns for a caller who may not be here, so the layout can use the
 * result without a null check. `redirect()` throws a sentinel Next.js catches,
 * which is why there is no `return` after any of the three calls below.
 */
export async function requireAdminViewer(): Promise<AdminViewer> {
  const user = await getSessionUser()

  if (user === null) {
    const target = (await currentAdminPathname()) ?? ADMIN_ROOT_PATH

    redirect(`${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(target)}`)
  }

  if (!hasRoleAtLeast(user.role, ADMIN_MINIMUM_ROLE)) {
    redirect(ADMIN_FALLBACK_PATH)
  }

  const pathname = await currentAdminPathname()

  if (pathname !== null) {
    const required = minimumRoleForPathname(pathname)

    if (!hasRoleAtLeast(user.role, required)) {
      // Not `notFound()`. The section exists, the operator simply is not
      // entitled to it, and sending them somewhere they *can* use beats an
      // error page that reads like the product is broken.
      redirect(ADMIN_ROOT_PATH)
    }
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role,
    canCurate: hasRoleAtLeast(user.role, 'ADMIN'),
    canGovern: hasRoleAtLeast(user.role, 'SUPER_ADMIN'),
  }
}

/**
 * Assert a minimum role from inside a page rather than the layout.
 *
 * For a section whose floor is higher than its route prefix implies — a
 * `SUPER_ADMIN`-only panel nested under `/admin/settings`, say. Redirects to the
 * OS root when the viewer falls short.
 */
export async function requireAdminRole(minimum: Role): Promise<AdminViewer> {
  const viewer = await requireAdminViewer()

  if (!hasRoleAtLeast(viewer.role, minimum)) {
    redirect(ADMIN_ROOT_PATH)
  }

  return viewer
}
