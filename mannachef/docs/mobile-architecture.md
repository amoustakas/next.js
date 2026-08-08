# Mobile Architecture — React Native / Expo Client

Phase 4 of the MannaChef build. This is not a green-field mobile plan: `mannachef/` was
already laid out with a native client in mind (`packages/api-contract`, `packages/validators`
with no Prisma dependency, `docs/mobile-architecture.md` reserved in `CONTRACT.md` §1). This
document says what that groundwork actually buys today, what it does not, and what it costs to
close the gap. It is grounded in the current state of the repo as of this writing: **17 of 136
server actions have a contract entry, and exactly one route handler exists
(`apps/web/src/app/api/webhooks/stripe/route.ts`)**. Nothing under `/api/menu`, `/api/appointments`,
`/api/intake`, etc. has been built yet, even though `api-contract` already describes those routes.

---

## 1. What is already shared, and why

Two packages in `mannachef/packages/` were built to have zero Next.js and zero Prisma in their
dependency graph, specifically so a React Native bundle can import them unmodified.

### `@mannachef/validators`

`packages/validators/package.json` declares exactly one runtime dependency:

```json
"dependencies": { "zod": "^4.0.0" }
```

No `@mannachef/db`, no `@prisma/client`. This is deliberate, not incidental — Prisma's generated
client is a Node addon with a query engine binary; it cannot run in a Hermes/JSC bundle, and even
if it somehow loaded, a mobile client has no business holding a database connection string. Because
`validators` never imports it, the same `appointmentCreateSchema`, `clientIntakeCreateSchema`,
`menuItemFilterSchema`, `cuidSchema`, `moneyCentsSchema`, `isoDateTimeSchema`, `roleSchema`, and the
rest of `packages/validators/src/{common,enums,menu,booking,intake,billing,review,referral,crm,media,staff,user}.ts`
barrel-exported from `src/index.ts` are exactly as usable inside an Expo app as inside
`apps/web`. A booking form on the phone validates client-side with the identical Zod schema the
server re-validates with — not a hand-copied approximation of it that will drift.

### `@mannachef/api-contract`

`packages/api-contract/src/index.ts` is the transport-agnostic route map the module docblock
describes as consumed by "the Next.js app... and the future Expo client." Concretely, for every
key in `ApiContract` (`'menu.list'`, `'appointment.create'`, `'auth.session'`, …) it stores:

```ts
export interface ApiRoute<TPath extends PathBuilder, TInput extends z.ZodType, TOutput extends z.ZodType> {
  readonly method: HttpMethod
  readonly path: TPath
  readonly input: TInput
  readonly output: TOutput
  readonly auth: AuthRequirement
  readonly summary: string
}
```

e.g.

```ts
'menu.detail': {
  method: 'GET',
  path: (params: MenuDetailParams): string => `/api/menu/items/${encodeURIComponent(params.slug)}`,
  input: menuDetailInputSchema,
  output: menuItemDetailSchema,
  auth: 'PUBLIC',
  summary: 'One dish, with its story, gallery, and pantry.',
},
```

Three type-level helpers give Expo end-to-end inference **with no codegen step**:

- `inferInput<K>` — `z.input<ApiContract[K]['input']>`: what a client may send, pre-defaults.
- `inferParsedInput<K>` — `z.output` of the same schema: what the handler sees post-parse.
- `inferOutput<K>` — `z.output<ApiContract[K]['output']>`: what a successful response resolves to,
  with `isoDateTimeSchema` fields already typed as `Date` even though they travel the wire as ISO
  strings.

Plus runtime helpers that need no scaffolding either: `buildUrl(base, ApiContract['menu.detail'], { slug })`,
`buildQueryUrl(base, entry, params, query)` (which serializes a parsed filter object into a query
string per the rules in `toSearchParams` — arrays repeat the key, `Date` becomes ISO, `null` clears
a filter), and the shared envelopes `apiErrorSchema` / `apiErrorCodeSchema` (`UNAUTHENTICATED |
FORBIDDEN | VALIDATION | NOT_FOUND | CONFLICT | RATE_LIMITED | INTERNAL`) and `paginated(item)`.

There is no OpenAPI file, no `.d.ts` generation step, no client SDK build. The Expo app imports
`@mannachef/api-contract` as a workspace package and gets a fully-typed `fetch` wrapper for free:

```ts
async function call<K extends ApiRouteKey>(
  key: K,
  params: inferPathParams<K>,
  body?: inferInput<K>
): Promise<inferOutput<K>> {
  const entry = ApiContract[key]
  const res = await fetch(buildUrl(process.env.EXPO_PUBLIC_API_URL!, entry, params), {
    method: entry.method,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw apiErrorSchema.parse(await res.json())
  return entry.output.parse(await res.json())
}
```

That function, once written, is the entire "SDK." Renaming a route key is a compile error at every
call site (`API_ROUTE_KEYS` is checked both directions — `satisfies readonly ApiRouteKey[]` and the
`_EveryRouteKeyIsListed` assertion — so a route can't silently fall out of the generated surface).
This is the actual payoff of Phase 0–3's package split: it wasn't done for the web app's benefit,
web doesn't need it — it exists for a client that doesn't have RSC.

**The catch, and it's the subject of the rest of this document: the contract currently describes 17
routes. `apps/web/ACTIONS-INDEX.md` lists 136 server actions.** The remaining ~119 have no `api-contract`
entry and no route handler. The type-safety story is real for what's declared; it says nothing
about what isn't.

---

## 2. What cannot be shared: Server Actions are a transport, not a function

Every one of the 136 actions in `apps/web/src/server/actions/*.ts` is exported from a module marked
`'use server'` — see the top of `booking.ts`:

```ts
'use server'
...
export const requestAppointment = withAction(appointmentCreateSchema, async (input, caller) => { ... })
```

`'use server'` makes `requestAppointment` a **React Server Reference**: Next's build step wraps it so
a Client Component holding a `<form action={requestAppointment}>` can invoke it as if it were local,
by generating a POST to a Next-internal RPC endpoint and re-encoding arguments/return values with
React's Flight protocol. That protocol, and the `next/cache` (`revalidatePath`, `revalidateTag`)
calls threaded through `guards.ts`'s `withAction`, only exist inside a Next.js request/render cycle.
Expo has no React Server Components runtime, no Flight decoder, and nothing resembling a
`"use server"` bundler transform. **A server action cannot be called from Expo. Not "with
difficulty" — there is no wire format for it to speak.**

The concrete consequence: those 119 undeclared actions cannot become mobile-reachable by exposing
them "as-is." Something has to sit at an HTTP boundary that Expo's `fetch` can hit, with a JSON
request and response, `Authorization` header instead of RSC's implicit request context, and a real
status code instead of a Flight-encoded error boundary.

### The recommended shape: thin route handlers, shared domain functions

Do **not** hand-write two implementations of `requestAppointment` (one action, one
route handler that re-derives the same conflict-checking and Serializable-transaction logic
described in `booking.ts`'s module docblock). That doubles the maintenance surface on exactly the
code this codebase is most careful about — `runSerializable`, the conditional `updateMany` guarded
on `bookedCount`, the pure conflict engine in `scheduling.ts`. Two implementations of a booking
write path is how you get the double-booking bug this file's entire docblock exists to prevent.

The shape to build toward, one route at a time:

```
apps/web/src/app/api/appointments/route.ts   →  POST handler
  ├─ parses body with ApiContract['appointment.create'].input   (= appointmentCreateSchema, already shared)
  ├─ resolves the caller (see §3 — this is the part that changes for native)
  ├─ calls the SAME function requestAppointment's handler calls
  └─ maps the result to { status, body } using apiErrorSchema / entry.output
```

Concretely this means factoring each action's body — today an inline closure passed as the second
argument to `withAction(schema, async (input, caller) => { ... })` — into a named, exported,
transport-agnostic function that both the action and the route handler call:

```ts
// server/domain/booking.ts  (new)
export async function bookAppointment(input: AppointmentCreateInput, caller: AuthenticatedUser) {
  // the existing transaction body, unchanged
}

// server/actions/booking.ts
export const requestAppointment = withAction(appointmentCreateSchema, bookAppointment)

// app/api/appointments/route.ts
export async function POST(req: Request) {
  const parsed = ApiContract['appointment.create'].input.safeParse(await req.json())
  if (!parsed.success) return NextResponse.json(zodFail(parsed.error), { status: 400 })
  const caller = await resolveApiCaller(req) // §3
  if (!caller.ok) return NextResponse.json(caller.error, { status: caller.status })
  const result = await bookAppointment(parsed.data, caller.user)
  return toHttpResponse(result, ApiContract['appointment.create'].output)
}
```

**Be honest about the cost.** This is not a flag flip and not a codegen run. For each of the ~119
undeclared actions, closing the gap requires:

1. **Extracting the domain function** out of `withAction(...)`'s inline closure — a mechanical but
   real edit to every action file in `server/actions/`, because right now the business logic and
   the Server-Action wrapper are the same closure.
2. **Writing the `api-contract` entry** — most rows in `ACTIONS-INDEX.md` show `returns: _(inferred)_`,
   meaning there is today no explicit Zod response schema, only whatever TypeScript infers from the
   Prisma call. An HTTP contract needs an actual `output` schema (see `menuItemDetailSchema`,
   `appointmentSchema` for the pattern, and the `.strict()` + no-`.default()`-on-responses rule the
   module docblock lays out in its "Why a response schema never carries a default" section).
3. **A route handler file** under `src/app/api/**`, one per resource, translating `ActionResult`
   (the action layer's `{ ok, data } | ActionFailure` union from `server/actions/types.ts`) into an
   HTTP status + `apiErrorSchema` body — `UNAUTHENTICATED → 401`, `FORBIDDEN → 403`, `VALIDATION →
   400`, `NOT_FOUND → 404`, `CONFLICT → 409` (this is exactly the code `appointment.cancel`'s
   `from`-mismatch and `onboarding.advance`'s stage-mismatch already return), `RATE_LIMITED → 429`,
   `INTERNAL → 500`.
4. **Re-verifying every ownership and role guard** the action relied on still holds when invoked
   through this new door — `guards.ts`'s `requireUser`, `requireRole`, and the seven ownership
   guards all currently assume they're running inside a Next.js request where `auth()` can read the
   incoming cookie (see §3). That assumption breaks first, before anything else does.

Do not build all 119 at once. §5 gives the order. But scope this as what it is: a per-endpoint
refactor-plus-new-file exercise across most of `server/actions/`, not an infrastructure switch.

---

## 3. Auth across the boundary

`apps/web/src/server/auth.ts` configures Auth.js v5 with:

```ts
export const authConfig = {
  adapter: PrismaAdapter(prisma),
  providers: buildProviders(),      // Google + Resend (magic link)
  session: {
    strategy: 'database',           // "a row can be revoked, a JWT cannot" — module docblock
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  ...
} satisfies NextAuthConfig
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
```

and every authorization check in the app bottoms out in `getSessionUser()`:

```ts
export async function getSessionUser(): Promise<AuthenticatedUser | null> {
  const session = await auth()
  ...
}
```

`auth()` resolves the session by reading the incoming request's session cookie and looking up the
matching `Session` row via the Prisma adapter. This is why the docblock calls the strategy
revocable — deactivate a user (`setUserActive`) and every live `Session` row for them is dead on
the next request, no token to wait out. It is also entirely dependent on there being a cookie
attached to the request, which only happens automatically inside a browser talking to
`next-auth`'s own `/api/auth/*` handlers.

**What changes for native, concretely:**

- Expo has no automatic cookie jar tied to an origin the way a browser does. `fetch` in React
  Native does not persist or resend `Set-Cookie` by default.
- Storing anything long-lived (a session identifier, a refresh token) has to go through
  `expo-secure-store` (backed by iOS Keychain / Android Keystore), not `AsyncStorage`, which is
  unencrypted disk storage.
- `guards.ts`'s `requireUser → getSessionUser → auth()` chain has exactly one way to identify a
  caller today: the cookie. A native request authenticated by `Authorization: Bearer <token>` never
  reaches that code path successfully — `resolveApiCaller` (§2) has to be a second entry point that
  `requireUser` doesn't have yet.

**Two real options, with real trade-offs:**

**A. Reuse the database-session cookie as an opaque bearer token.** At login, the Expo client hits
`/api/auth/callback/*` (or a thin wrapper around it) the same way the web client does, reads the
`Set-Cookie` value from the response by hand (React Native's `fetch` exposes response headers even
though it won't auto-manage the jar), stores the raw cookie value in SecureStore, and resends it as
a `Cookie:` header on every subsequent request. `getSessionUser()` needs **no change** — it's still
looking up the same `Session` row by the same value. Cheapest to build; keeps exactly one session
model in the database. The costs: it inherits Auth.js's cookie *shape* (`__Secure-authjs.session-token`
naming, `SameSite`/`HttpOnly` attributes that a browser enforces but a raw HTTP client simply
ignores by treating it as an opaque string) without any of a browser's protections, there's no
`updateAge`-driven silent refresh unless the client re-implements it, and it is fighting Auth.js's
grain rather than working with it — the library was not designed to have its cookie internals
read and replayed by a non-browser client, so a provider upgrade could change the cookie name or
encoding under you with no warning.

**B. A dedicated token/refresh path for the API surface.** Add a `POST /api/auth/mobile/login` (or
extend the credentials flow) that, after Auth.js/OAuth verification succeeds, mints a short-lived
access token plus a longer-lived, rotating refresh token — either a second `NextAuthConfig.session`
strategy switch scoped to this route, or a parallel table (`PersonalAccessToken` / `DeviceSession`)
alongside `Session`. `requireUser` in `guards.ts` gains a second resolution branch: try the cookie
(web), else try `Authorization: Bearer` against the new table (native). This is the idiomatic
mobile pattern — short-lived access token in memory, refresh token in SecureStore, silent refresh
on 401, revocation by deleting the refresh-token row — but it means **a second session mechanism to
build, test, and reason about for revocation alongside the existing database-session one**, and
`assignUserRole`/`setUserActive` (already hardened for the database-session race per this repo's
own history — see `server/actions/user.ts`) need the equivalent guarantee re-verified for
whichever token store B introduces: deactivating a user must kill their mobile session as
immediately as it kills their web one, or it is a regression on a property this codebase already
paid to establish once.

**Recommendation:** B. Option A's fragility (an internal, undocumented cookie format from a
third-party auth library, replayed by hand) is the kind of thing that breaks silently on a
dependency bump. Budget it as new surface, not a config toggle — it touches `auth.ts`, `guards.ts`,
the Prisma schema, and needs its own verification script in the pattern of
`apps/web/scripts/verify-superadmin-race.ts` for the revocation guarantee specifically.

---

## 4. The monorepo

### What moves where

Nothing needs to *move*. `pnpm-workspace.yaml` already scopes to `apps/*` and `packages/*`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

An Expo app lands as a new sibling, `apps/native/`, next to `apps/web/`. It depends on
`@mannachef/validators` and `@mannachef/api-contract` via `"workspace:*"` — the same protocol
`CONTRACT.md`'s own package.json entries already use for cross-package references — and nothing
else in `packages/`. Specifically **not** `@mannachef/db`: that package's `package.json` exists to
wrap the Prisma singleton, and Expo must never see a `DATABASE_URL` or a query engine binary.

### Metro's constraints on symlinked workspace packages

pnpm workspaces are symlinks (`node_modules/@mannachef/validators` → `../../packages/validators`),
and both shared packages resolve purely through `package.json`'s `exports` field to *raw TypeScript
source* with no build step:

```json
// packages/validators/package.json and packages/api-contract/package.json, identically
"exports": { ".": "./src/index.ts" }
```

There is no `dist/`, no `main`, nothing but a `.ts` file behind `exports`. Two things follow for
Metro (React Native's bundler):

- **Package Exports resolution must be turned on and verified**, not assumed — Metro historically
  resolved only `main`/`browser` fields, and `exports`-field support is newer and version-gated in
  `expo/metro-config`. Confirm the target Expo SDK's default before relying on it; if it isn't
  default-on for the SDK actually pinned in `apps/native/package.json`, it needs the explicit
  resolver opt-in. Since these two packages have *no* `main` fallback, Metro cannot silently fall
  back to a `main` resolution if `exports` support is off — the import fails outright rather than
  degrading, which at least makes the misconfiguration loud instead of picking up a stale build.
- **Symlink handling and monorepo watch config**: Expo SDK 52+ configures `expo/metro-config`
  automatically for a detected monorepo (watch folders, `resolver.nodeModulesPaths`) where earlier
  SDKs required hand-setting `watchFolders`/`nodeModulesPaths` in `metro.config.js` to see files
  outside `apps/native/`. Pin to an SDK new enough to get this for free, and if `apps/native` is
  bootstrapped on an older SDK, budget the manual Metro config as part of that bootstrap, not as an
  afterthought once imports mysteriously fail to hot-reload.
- Because `@mannachef/validators`/`@mannachef/api-contract` ship `.ts` directly, Metro (which
  already transpiles TS via Babel for RN's own sources) must apply the same transform reaching
  *through* the symlink into `packages/`, not just inside `apps/native/`. This is the practical
  reason to smoke-test the two shared packages' import in a bare Expo app *before* building any
  screen against them — a resolution failure here is a monorepo-wiring bug, not an app bug, and is
  cheaper to isolate early.

### `turbo.json` for a native app

The existing `turbo.json` tasks generalize with no schema change — `build`, `lint`, `typecheck`,
`verify` are already generically defined with `dependsOn: ["^build"]`, so `apps/native` picks up
`^build` from `@mannachef/validators` and `@mannachef/api-contract` (which have no `build` script
today, just `typecheck`, so Turbo treats that leg as a no-op-but-satisfied dependency) automatically
once its `package.json` declares the workspace dependency. What's missing is task definitions Expo
actually needs that have no web equivalent:

```jsonc
// additions to turbo.json, not a rewrite
"start": { "cache": false, "persistent": true },   // `expo start`
"prebuild": { "cache": false },                     // native project generation
"eas-build": { "dependsOn": ["^build"], "cache": false }
```

`globalEnv` needs `EXPO_PUBLIC_API_URL` alongside the existing `NEXT_PUBLIC_APP_URL` — same role
(the origin a client is pointed at), different runtime (`buildUrl`'s `base` parameter, per its own
docblock: `''` for web's relative paths, `process.env.EXPO_PUBLIC_API_URL` for Expo).

---

## 5. Staging: what to build first

Order by (a) how little of §2's server-side work it needs, and (b) how much of the domain
tolerates an incomplete data path without becoming actively wrong.

1. **Menu browsing.** `menu.list` and `menu.detail` are already `api-contract` entries — the only
   two `PUBLIC`, `GET`, no-auth routes with real output schemas already written
   (`menuItemSummarySchema`, `menuItemDetailSchema`). This is the entire mobile surface that needs
   zero work from §2 (no domain-function extraction, no auth boundary — `auth: 'PUBLIC'` means §3 is
   irrelevant to it) and zero work from §3. It is also trivially shareable — a dish's slug URL is
   already meaningful outside the app (deep link, share sheet, SMS to a friend), unlike an
   authenticated dashboard screen. Build the route handlers for these two first, ship a read-only
   menu browser, and you've validated the entire Metro/monorepo/contract pipeline (§4) before
   spending a single hour on the harder auth problem.

2. **Booking and intake, second — and only after §3 is resolved.** `appointment.create`,
   `availability.query`, and `intake.submit` are the first `OWNER`-gated, mutating routes worth
   exposing, because they're the actions a client most plausibly fires from a spotty connection (in
   a car, at a client's home) and most needs to survive that gracefully — see §6 for what "survive"
   has to mean given `scheduling.ts`'s Serializable-transaction guarantees. Do not attempt this
   before §3's token auth is real: `appointmentCreateSchema`'s `auth: 'OWNER'` requirement is
   currently enforced entirely through the cookie-backed `getSessionUser()`, and a booking flow is
   the worst possible place to discover the auth boundary doesn't hold.

3. **Billing stays in a web view.** `createCheckoutSession`, `changeSubscription`, and the Stripe
   flow in `apps/web/src/server/stripe.ts` are built on Stripe Checkout/Billing Portal redirects —
   hosted, PCI-scope-bearing pages. Reimplementing card collection natively (Stripe's React Native
   SDK, PaymentSheet, etc.) is a materially different PCI posture (SAQ A vs. something closer to
   SAQ A-EP/D depending on integration depth) and a second Stripe integration to maintain
   alongside `apps/web/src/app/api/webhooks/stripe/route.ts`'s webhook handler. Route it through an
   in-app `WebView` pointed at the existing hosted Checkout/Portal session URL the server already
   knows how to mint (`CheckoutSessionView`, `createCheckoutSession` in `server/actions/billing.ts`)
   rather than building a second payment collection surface. This is a scope decision, not a
   technical limitation — it can change later if there's a product reason to own the native payment
   UI, but there is no reason to take on that PCI surface for Phase 4.

---

## 6. Offline and sync

Split by whether staleness is a UX inconvenience or a wrong answer with consequences.

**Tolerates staleness — cache and show it:**

- **Menu content** (`menuItemSummarySchema`/`menuItemDetailSchema` — name, description, pricing,
  media, tags, ratings). A dish description or price being a few minutes stale while offline is a
  normal client-cache trade-off; nothing downstream acts on it as a live fact.
- **CRM/onboarding read views** (`OnboardingFlowView`, `PipelineView`) for staff — informational,
  re-synced on reconnect, no write races because they're mostly staff-facing dashboards, not the
  write path itself.

**Must never be served stale — availability and allergens, specifically:**

- **Availability** (`bookingSlotSchema`, `availability.query`) is exactly the data `scheduling.ts`'s
  conflict engine exists to protect. The module docblock is explicit that the engine is pure and
  every real decision is re-derived **inside the transaction, from a fresh read** — "no conflict
  logic is reimplemented [at the call site]... Nothing read before [the transaction] opened is
  trusted, including the row an ownership guard just fetched." A cached slot list shown to a guest
  offline is a *proposal* to submit for re-validation, never a promise. The UI must present it as
  "as of last sync" and be prepared for the server to refuse it.
- **Allergens** (`MenuItemIngredient.isAllergen`, indexed in `schema.prisma` at
  `@@index([isAllergen])` specifically because it's queried on a safety path, not just a display
  path). This is the one category where "stale by a few minutes" is not a UX inconvenience — it's a
  wrong answer that can hurt someone. If ingredient data can't be confirmed fresh, the client should
  say so rather than render a possibly-outdated allergen badge as if it were current. Do not treat
  this the same as menu copy going stale; it needs its own cache-invalidation rule (short TTL, or no
  offline serving at all for the allergen fields specifically, even if the rest of the dish record
  is shown from cache).

**The conflict story for a booking made offline:** the server-side guarantee — Serializable
isolation catching the read-write dependency between two concurrent bookings, plus the conditional
`updateMany` on `bookedCount` as a second, independent guard, both described in `booking.ts`'s
module docblock — does not change one bit for an offline-originated request. It already assumes the
client's view of the calendar might be stale relative to the transaction (that's the *entire reason
it re-reads and re-evaluates inside the transaction rather than trusting anything the caller
believed*). What offline capability adds is queuing the write locally and replaying it once
connectivity returns; the server does not need new logic to reject a since-taken slot, because
rejecting a since-taken slot is what it already does to every booking request, online or not,
per `appointmentStatusTransitionSchema`'s optimistic-concurrency pattern (`from` is the status the
caller believes it's in; a mismatch is answered with `CONFLICT`, "rather than a silent overwrite").

What genuinely is new work for offline: the **client-side experience of that rejection**. A booking
submitted while offline and replayed twenty minutes later needs a first-class "this slot is gone,
here's what's still open nearby" UI — `findConflicts`/the capacity-assessment functions in
`scheduling.ts` are pure (no Prisma, no `Date.now()`, per the same docblock), so they are, in
principle, portable to a bundle to give an *optimistic* client-side pre-check before replay. That
would be new plumbing (`scheduling.ts` lives in `apps/web/src/server/`, not a shared package — it
would need extracting alongside `validators`/`api-contract` to be reachable from Expo) purely for a
better "don't even bother submitting, that's clearly gone" UX; the server re-check on replay is
non-negotiable and already correct regardless of whether that optimization is ever built.

---

## 7. What is not yet built

- `apps/native/` itself — no Expo project exists in the repo.
- Route handlers for all but one endpoint (`api/webhooks/stripe`). All 17 declared `api-contract`
  routes need their `src/app/api/**/route.ts` written; none exist.
- The domain-function extraction described in §2 — every action's logic currently lives inside the
  `withAction(...)` closure in `server/actions/*.ts`, not in a transport-agnostic function two
  transports can call.
- `api-contract` entries and response schemas for the ~119 actions in `ACTIONS-INDEX.md` beyond the
  17 already declared — most show `returns: _(inferred)_`, meaning no explicit Zod output schema
  exists yet to promote to a contract `output`.
- Any native-reachable auth mechanism (§3, option A or B) — `getSessionUser()` today has exactly one
  path in, the database-session cookie.
- A `PersonalAccessToken`/device-session schema and revocation guarantee, if §3's option B is
  chosen — and the verification script for it, in the shape of the existing
  `apps/web/scripts/verify-superadmin-race.ts`.
- Metro/monorepo configuration validated end-to-end for these two specific `exports`-only,
  no-`main`, raw-`.ts` packages — untested until `apps/native` exists.
- `turbo.json` task entries for `start`/`prebuild`/`eas-build`, and `EXPO_PUBLIC_API_URL` in
  `globalEnv`.
- Any offline queue/replay mechanism for booking and intake submissions, and the client UI for a
  replay that comes back `CONFLICT`.
- A decision (not yet made here beyond a recommendation) on whether `scheduling.ts`'s pure conflict
  engine gets extracted to a shared package for client-side optimistic pre-checks, versus staying
  server-only with the server as the sole source of conflict truth.
- Push notification infrastructure for anything the platform would want to alert on natively
  (booking confirmed, slot about to lapse) — out of scope of every section above, not mentioned
  anywhere in the current codebase, and not addressed by this document beyond flagging its absence.
