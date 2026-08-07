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

| Script             | What it does                                    |
| ------------------ | ----------------------------------------------- |
| `pnpm dev`         | Runs all workspace `dev` tasks via Turbo        |
| `pnpm build`       | Builds all workspace packages/apps via Turbo    |
| `pnpm lint`        | Lints all workspaces via Turbo                  |
| `pnpm typecheck`   | Type-checks all workspaces via Turbo            |
| `pnpm verify`      | Runs every workspace's own correctness harness  |
| `pnpm format`      | Formats the repo with Prettier                  |
| `pnpm db:generate` | Regenerates the Prisma client (`@mannachef/db`) |
| `pnpm db:migrate`  | Runs `prisma migrate dev`                       |
| `pnpm db:push`     | Pushes the Prisma schema without a migration    |
| `pnpm db:studio`   | Opens Prisma Studio                             |

### Working on the web app only

```bash
pnpm --filter=@mannachef/web dev
pnpm --filter=@mannachef/web build
pnpm --filter=@mannachef/web typecheck

# The web app's own harnesses. The first two are run by `pnpm verify`:
pnpm --filter=@mannachef/web test             # unit tests under src/**/*.test.ts
pnpm --filter=@mannachef/web verify:referral  # the MCV-030 privilege regression
pnpm --filter=@mannachef/web verify:superadmin # the MCV-031 concurrency regression
```

`verify:referral` drives the real referral Server Actions — the real guard
wrapper, the real schemas — against an in-memory database, and asserts that a
`CLIENT` cannot state what their own invitation code is worth. It needs no
PostgreSQL instance and no `DATABASE_URL`. See the docblock at the head of
`apps/web/scripts/verify-referral-privilege.ts`.

`verify:superadmin` asserts that two administrators acting at the same instant
cannot between them leave the platform with no `SUPER_ADMIN`. Unlike every other
harness here it needs a **real PostgreSQL**, because the property under test is
one of PostgreSQL's isolation levels rather than one of the application's —
write skew that `READ COMMITTED` permits and Serializable Snapshot Isolation
refuses. It runs the same actions at both levels and prints the two outcomes
side by side:

```bash
createdb mannachef_race
DATABASE_URL='postgresql://…@localhost:5432/mannachef_race' \
  pnpm --filter=@mannachef/db exec prisma db push
DATABASE_URL='postgresql://…@localhost:5432/mannachef_race' \
  pnpm --filter=@mannachef/web verify:superadmin
```

It **empties the identity tables** on every scenario, so it refuses to start
unless the database name contains `race`, `test` or `harness`. That is also why
it is deliberately _not_ wired into `pnpm verify`: the other harnesses need no
services, and a `verify` that silently required a database would be a worse
default than one extra command. See the docblock at the head of
`apps/web/scripts/verify-superadmin-race.ts`.
