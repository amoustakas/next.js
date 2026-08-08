// mannachef/apps/web/src/app/api/auth/[...nextauth]/route.ts

/**
 * The Auth.js v5 mount point.
 *
 * `@/server/auth` builds the config and calls `NextAuth(...)`, which returns
 * `handlers` — the `GET`/`POST` pair that serves every `/api/auth/*` address:
 * `/api/auth/signin`, the provider callbacks, `/api/auth/signout`, the CSRF and
 * session endpoints. Auth.js does not register those routes on its own; this
 * file is the only thing that puts them on the router.
 *
 * Without it `handlers` is an exported symbol nobody imports, and the sign-in
 * redirect that `@/server/admin-access` and both shell layouts perform points
 * at a 404 — the app can gate on a session it has no way to establish.
 *
 * There is deliberately no logic here. Every decision — which providers exist,
 * how a session is resolved, whether `User.isActive` still holds — lives in
 * `@/server/auth`, so this stays a single re-export.
 */

import { handlers } from '@/server/auth'

export const { GET, POST } = handlers
