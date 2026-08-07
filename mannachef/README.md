# MannaChef Platform & Business OS

MannaChef is a private-chef marketing site, client portal, and internal business OS
(admin) built as one Next.js application, backed by a shared Prisma/PostgreSQL data
layer and a transport-agnostic API contract package intended to also serve a future
Expo mobile app.

This directory is a **self-contained Turborepo** living inside the host `next.js`
repository. It is deliberately excluded from the host repo's own pnpm workspace,
ESLint config, and Prettier runs — it has its own `package.json`, `pnpm-workspace.yaml`,
`turbo.json`, and `tsconfig.base.json`, and manages its own dependency graph
independently of the surrounding Next.js framework monorepo.

See `CONTRACT.md` for the authoritative directory layout, stack versions, design
system tokens, naming conventions, security rules, and definition of done that every
change in this directory must follow.

## Layout

```
mannachef/
├── package.json            # root: pnpm workspaces + turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── CONTRACT.md             # single source of truth — read this first
├── packages/
│   ├── db/                 # @mannachef/db — Prisma client singleton + schema
│   ├── validators/         # @mannachef/validators — Zod v4 schemas (no Prisma dep)
│   └── api-contract/       # @mannachef/api-contract — shared route/action contracts
└── apps/
    └── web/                # @mannachef/web — the Next.js 16 App Router application
```

## Stack

- **Framework:** Next.js 16 (App Router, RSC, Server Actions)
- **Language:** TypeScript 5.9, `strict: true`
- **Styling:** Tailwind CSS v4 (CSS-first `@theme`, defined in `apps/web/src/app/globals.css`)
- **Components:** shadcn/ui (new-york) + Radix + Lucide
- **ORM:** Prisma 6 + PostgreSQL
- **Auth:** Auth.js v5 (`next-auth@beta`) with the Prisma adapter
- **Client state:** TanStack Query v5 + Zustand
- **Payments:** Stripe
- **Media:** UploadThing

## Getting started

All commands below are run from inside `mannachef/`, not the repo root.

```bash
cd mannachef

# 1. Install dependencies (this workspace only)
pnpm install

# 2. Configure environment variables
cp apps/web/.env.example apps/web/.env.local
# then fill in DATABASE_URL, AUTH_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
# UPLOADTHING_TOKEN, and NEXT_PUBLIC_APP_URL with real local/dev values.

# 3. Generate the Prisma client
pnpm db:generate

# 4. Push the schema to your local/dev database (no migration history)
pnpm db:push
# — or, once you want tracked migrations —
pnpm db:migrate

# 5. Start every app in dev mode (Turbo runs each workspace's `dev` task)
pnpm dev
```

### Common scripts (root)

| Script          | What it does                                      |
| ---------------- | -------------------------------------------------- |
| `pnpm dev`        | Runs all workspace `dev` tasks via Turbo           |
| `pnpm build`       | Builds all workspace packages/apps via Turbo       |
| `pnpm lint`        | Lints all workspaces via Turbo                     |
| `pnpm typecheck`   | Type-checks all workspaces via Turbo                |
| `pnpm format`      | Formats the repo with Prettier                      |
| `pnpm db:generate` | Regenerates the Prisma client (`@mannachef/db`)     |
| `pnpm db:migrate`  | Runs `prisma migrate dev`                            |
| `pnpm db:push`     | Pushes the Prisma schema without a migration        |
| `pnpm db:studio`   | Opens Prisma Studio                                  |

### Working on the web app only

```bash
pnpm --filter=@mannachef/web dev
pnpm --filter=@mannachef/web build
pnpm --filter=@mannachef/web typecheck
```
