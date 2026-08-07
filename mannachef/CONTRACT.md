# MannaChef Platform & Business OS — Build Contract

This file is the **single source of truth** for every agent working in `mannachef/`.
Do not deviate from the paths, names, or conventions below. If something you need is
not specified here, follow the closest existing pattern in the repo.

---

## 0. Repository placement

Everything lives under `mannachef/` at the root of the host repository. This directory is a
**self-contained Turborepo** and is deliberately excluded from the host Next.js framework's
pnpm workspace, ESLint, and Prettier runs. Never edit files outside `mannachef/` except:

- `.config/eslintignore.mjs` and `.prettierignore` (already updated to ignore `mannachef/`).

---

## 1. Directory layout (authoritative)

```
mannachef/
├── package.json                     # root, pnpm workspaces + turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── README.md
├── CONTRACT.md                      # this file
├── docs/
│   └── mobile-architecture.md       # Phase 4 Expo / Turborepo strategy
├── packages/
│   ├── db/
│   │   ├── package.json             # name: "@mannachef/db"
│   │   ├── tsconfig.json
│   │   ├── prisma/schema.prisma
│   │   └── src/index.ts             # PrismaClient singleton + re-export of @prisma/client
│   ├── validators/
│   │   ├── package.json             # name: "@mannachef/validators"
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts             # barrel
│   │       ├── common.ts            # shared primitives (id, pagination, money, slug…)
│   │       ├── enums.ts             # zod enums MIRRORING prisma enums exactly
│   │       ├── menu.ts
│   │       ├── media.ts
│   │       ├── review.ts
│   │       ├── intake.ts
│   │       ├── booking.ts
│   │       ├── billing.ts
│   │       ├── referral.ts
│   │       └── crm.ts
│   └── api-contract/
│       ├── package.json             # name: "@mannachef/api-contract"
│       ├── tsconfig.json
│       └── src/index.ts             # transport-agnostic route map shared by web + expo
└── apps/
    └── web/
        ├── package.json             # name: "@mannachef/web"
        ├── next.config.ts
        ├── tsconfig.json
        ├── components.json          # shadcn/ui config
        ├── postcss.config.mjs
        ├── .env.example
        └── src/
            ├── app/
            │   ├── layout.tsx                     # root layout, fonts, providers
            │   ├── globals.css                    # Tailwind v4 @theme tokens
            │   ├── (marketing)/…                  # public luxury site
            │   ├── (portal)/portal/…              # client portal
            │   ├── (admin)/admin/…                # business OS
            │   └── api/webhooks/stripe/route.ts
            ├── components/
            │   ├── ui/                            # shadcn primitives
            │   ├── marketing/
            │   ├── portal/
            │   └── admin/
            ├── server/
            │   ├── auth.ts                        # Auth.js v5 config + `auth()`
            │   ├── guards.ts                      # requireUser / requireRole / withAction
            │   ├── stripe.ts                      # Stripe client singleton
            │   └── actions/                       # "use server" modules, one per domain
            ├── hooks/
            ├── stores/                            # zustand
            └── lib/                               # utils, formatters, query client
```

---

## 2. Stack & versions

| Concern       | Choice                                                    |
| ------------- | --------------------------------------------------------- |
| Framework     | Next.js 16 (App Router, RSC, Server Actions, streaming)    |
| Language      | TypeScript 5.9, `strict: true`, `noUncheckedIndexedAccess` |
| Styling       | Tailwind CSS v4 (CSS-first `@theme`, no `tailwind.config`) |
| Components    | shadcn/ui (new-york style) + Radix + Lucide React          |
| Animation     | Framer Motion (`motion/react` import specifier)            |
| ORM           | Prisma 6 + PostgreSQL                                      |
| Auth          | Auth.js v5 (`next-auth@beta`) with Prisma adapter          |
| Client state  | TanStack Query v5 (server cache) + Zustand (UI/OS state)   |
| Forms         | React Hook Form + `@hookform/resolvers/zod`                |
| Validation    | Zod v4 (`import { z } from 'zod'`)                         |
| Payments      | Stripe (`stripe` node SDK, apiVersion pinned)              |
| Media         | UploadThing                                                |

---

## 3. Design system — "Luxury Culinary"

Defined once in `apps/web/src/app/globals.css` via Tailwind v4 `@theme`. Never hardcode hex
values in components; always use the token names.

Palette (dark-first; the marketing site is dark, the admin OS is dark with lighter surfaces):

| Token                | Value       | Use                                              |
| -------------------- | ----------- | ------------------------------------------------ |
| `--color-obsidian`   | `#0B0A09`   | page ground                                      |
| `--color-charcoal`   | `#121110`   | primary surface                                  |
| `--color-slate-warm` | `#1A1817`   | raised surface / card                            |
| `--color-ash`        | `#26231F`   | borders, dividers, inputs                        |
| `--color-linen`      | `#F4F0E9`   | primary text on dark                             |
| `--color-parchment`  | `#CFC7B8`   | secondary text                                   |
| `--color-stone`      | `#8B8377`   | muted text, placeholders                         |
| `--color-champagne`  | `#D8C39A`   | **accent — use sparingly** (CTAs, active, focus) |
| `--color-gold`       | `#B08D4F`   | accent depth, gradients, hairlines               |
| `--color-terracotta` | `#9C5B3C`   | warm secondary accent                            |
| `--color-sage`       | `#6E7F63`   | success / "in season"                            |
| `--color-claret`     | `#7C2F35`   | destructive                                      |

Typography:

- Display / headings: a serif — `next/font/google` **Cormorant Garamond**, CSS var `--font-display`.
- Body / UI: **Inter**, CSS var `--font-sans`.
- Numeric / data tables: `font-variant-numeric: tabular-nums`.

Rules:

- Accent discipline: at most **one** champagne/gold element per visual group. Never a fully
  gold-filled large surface; prefer hairline borders, 1px gradient rules, and text accents.
- Radii: `--radius-sm .25rem`, `--radius-md .5rem`, `--radius-lg .75rem`, `--radius-xl 1rem`.
  Cards use `lg`, buttons/inputs use `md`.
- Elevation is expressed with **borders + subtle inner light**, not heavy drop shadows.
- Motion: 150–250 ms, `cubic-bezier(0.16, 1, 0.3, 1)`. Respect `prefers-reduced-motion`
  in every Framer Motion component.
- Every interactive element has a visible `focus-visible` ring in champagne at 40% opacity.

---

## 4. Naming & code conventions

- Files: `kebab-case.ts` / `kebab-case.tsx`. React components: `PascalCase` named exports;
  page/layout/route files use `default` exports as Next.js requires.
- Prisma models: `PascalCase` singular. Fields: `camelCase`. Enums: `SCREAMING_SNAKE_CASE` values.
- Every Prisma model has `id String @id @default(cuid())`, `createdAt DateTime @default(now())`,
  `updatedAt DateTime @updatedAt`.
- Money is stored as **integer minor units** (`Int`, cents) named `…Cents`, plus a
  `currency String @default("CAD")` where a standalone amount exists. Never `Float` for money.
- All timestamps are `DateTime` stored UTC. Durations are `Int` minutes.
- Zod file layout per domain: `xCreateSchema`, `xUpdateSchema`, `xFilterSchema`, and inferred
  types `export type XCreateInput = z.infer<typeof xCreateSchema>`.
- No `any`. No non-null assertions (`!`) except immediately after an explicit guard.
- Server Actions live in `src/server/actions/<domain>.ts`, start with `'use server'`, and
  every exported action is wrapped by a guard from `src/server/guards.ts`.

### Server Action result contract

Every action returns the discriminated union from `src/server/actions/types.ts`:

```ts
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: ActionErrorCode; fieldErrors?: Record<string, string[]> }
```

`ActionErrorCode` = `'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL'`.
Actions never throw for expected failures and never leak Prisma/Stripe error text to the client.

---

## 5. Security rules (non-negotiable)

- Roles: `SUPER_ADMIN | ADMIN | CHEF_STAFF | CLIENT`. Hierarchy for checks:
  `SUPER_ADMIN > ADMIN > CHEF_STAFF > CLIENT`.
- Authorization is enforced **inside the server action / route handler**, never only in the UI.
  A hidden button is not a permission check.
- Every mutating action: (1) resolve session, (2) role check, (3) Zod `safeParse` the raw input,
  (4) **ownership check** for anything scoped to a client, (5) act, (6) `revalidatePath`/`revalidateTag`.
- Never trust an `id` from the client without re-checking it belongs to the caller's tenant/user.
- The Stripe webhook route verifies `stripe-signature` with `constructEvent`, runs on the Node
  runtime, reads the **raw** body, and is idempotent via a persisted `StripeEvent` ledger.
- Never log secrets, full card data, or raw webhook payloads.

---

## 6. Definition of done for generated code

- Complete and un-truncated. No `// TODO`, no `...rest`, no placeholder function bodies.
- Compiles conceptually against the schema and validators that already exist on disk —
  **read them before writing**, do not invent field names.
- Imports resolve to real paths in the layout above.
- Every file begins with a one-line comment stating its path, e.g. `// mannachef/apps/web/src/...`.
