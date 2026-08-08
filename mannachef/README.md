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

# The web app's own harnesses. All but the last are run by `pnpm verify`:
pnpm --filter=@mannachef/web test              # unit tests under src/**/*.test.ts
pnpm --filter=@mannachef/web verify:referral   # the MCV-030 privilege regression
pnpm --filter=@mannachef/web verify:intake     # the three MCV-040 intake regressions
pnpm --filter=@mannachef/web verify:preemption # the MCV-050 referral pre-emption regression
pnpm --filter=@mannachef/web verify:media      # the MCV-042 media upload regression
pnpm --filter=@mannachef/web verify:billing    # the two MCV-041 billing regressions
pnpm --filter=@mannachef/web verify:mcv043     # the re-quote marker and the referral economics
pnpm --filter=@mannachef/web verify:superadmin # the MCV-031 concurrency regression
```

`verify:referral` drives the real referral Server Actions — the real guard
wrapper, the real schemas — against an in-memory database, and asserts that a
`CLIENT` cannot state what their own invitation code is worth. It needs no
PostgreSQL instance and no `DATABASE_URL`. See the docblock at the head of
`apps/web/scripts/verify-referral-privilege.ts`.

`verify:intake` runs the three MCV-040 regressions over the **anonymous intake
path** — the two `auth: 'PUBLIC'` Server Actions a stranger with a browser can
reach. Each drives the real actions against a real PostgreSQL and prints a
before/after table:

| Script                    | Asserts                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `verify:intake-hijack`    | a referral cannot name a household the caller merely guessed      |
| `verify:intake-cap`       | a code's redemption cap binds, sequentially and under concurrency |
| `verify:intake-allergens` | a public questionnaire is never written for a household we hold   |

Since MCV-050 the public enquiry writes no `ReferralRedemption` at all, so
`verify:intake-cap` drives the enquiry **and** the sign-in that settles it: the
cap moved with the write, which is the only place a cap can be enforced. Its
concurrency scenario is four simultaneous first sign-ins rather than four
simultaneous enquiries, which is what four guests accepting one invitation
actually looks like.

```bash
createdb mannachef_harness
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/db exec prisma migrate deploy
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/web verify:intake
```

`migrate deploy` rather than `db push`: several migrations carry hand-written
`CHECK` constraints that a schema push does not reproduce, and two harnesses
assert against them by name.

These need a database for the same kind of reason `verify:superadmin` does: two
of the three claims are about what PostgreSQL does — a compare-and-swap under
four concurrent transactions, and an `upsert` against a unique constraint —
rather than about what the application decides. **`pnpm verify` therefore now
requires `DATABASE_URL`**, where it previously required no services at all. The
"before" column of each transcript is produced by running the pre-fix source,
reproduced in `apps/web/scripts/fixtures/intake-legacy.ts`; each harness also
asserts that reproduction still matches the shipped code where the two are
supposed to agree, so a transcript cannot quietly stop describing this codebase.
See the docblocks at the head of the three `apps/web/scripts/verify-intake-*.ts`
files.

`verify:preemption` is the MCV-050 regression, and it is the fourth round on the
same door. `verify:intake-hijack` asserts that a referral cannot name a household
the caller merely guessed; this asserts the harder half — that it cannot name an
address **nobody has registered yet** either. An anonymous caller was staking a
`ReferralRedemption` against a mailbox they had only typed, and being paid $50
when its genuine owner later signed up and settled an invoice, because the guard
asked "did this call insert the `User` row?" rather than "has this caller proved
control of this mailbox?".

The public path now writes `ClientProfile.claimedReferralCode` — a string with no
ledger row and no financial meaning — and the redemption is written by
`settleFirstAuthenticatedSession` at the first sign-in that proves the mailbox,
through `createReferralRedemption`, the one canonical writer. The harness asserts
both directions: the pre-emption is refused _and_ a genuine referral is still paid
end to end. It also covers the second, quieter harm of the same call — a
placeholder account with no `Account` row would have denied its owner Google
registration for ever with `OAuthAccountNotLinked`.

```bash
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/web verify:preemption
```

It needs the same database as `verify:intake`, applied from `prisma/migrations`
rather than `db push` — `0004_mcv050_referral_claim` carries a hand-written
`CHECK`. See the docblocks at the head of
`apps/web/scripts/verify-referral-preemption.ts` and
`apps/web/src/server/referral-claim.ts`; the second states what the fix does
**not** buy as plainly as what it does.

`verify:media` drives the real `completeMediaUpload` Server Action against a
real PostgreSQL **built from `prisma/migrations`**, and both halves of that
sentence are the finding. `schema.prisma` declared
`@@unique([provider, providerFileKey])` on `MediaAsset` while `0000_init`
created a _partial_ index for the pair, so the `ON CONFLICT` Prisma Client emits
matched nothing and every upload failed with PostgreSQL `42P10` — a 100% failure
rate on the only path an asset enters the library by, behind a green test suite,
because nothing in that suite reached `mediaAsset.upsert` on a database. It
needs a `DATABASE_URL` and empties the media and identity tables, so the
disposable-name rule applies:

```bash
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/web verify:media
```

Set that database up with `pnpm --filter=@mannachef/db exec prisma migrate
deploy`, **not** `prisma db push`. `db push` builds the database from
`schema.prisma` and would therefore create the very index whose absence is the
defect. See `packages/db/README.md`, "Reconciling a hand-written index with the
datamodel".

`verify:billing` runs the two MCV-041 regressions over the **billing and growth
paths a signed-in subscriber can reach**. Both drive the real actions against a
real PostgreSQL and print a before/after table:

| Script              | Asserts                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `verify:proration`  | the Stripe payload for a `CLIENT` upgrade always carries `create_prorations` |
| `verify:redemption` | the portal, Checkout and the webhook agree on what a valid redemption is     |

```bash
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/web verify:billing
```

`verify:proration` is exhaustive rather than illustrative on the point that
matters: it puts **every** pair the `effectiveAt` and `prorationBehavior` enums
can produce through `changeSubscription` as a `CLIENT`, so a value added to
either enum fails the harness until somebody has thought about it. Four of the
six were unbilled before the fix.

`verify:redemption` drives the **real webhook route**, signature and all — the
recorder in `apps/web/scripts/fixtures/stripe-recorder.ts` is a genuine `Stripe`
instance with three resource namespaces replaced, so `constructEvent` verifies a
header `generateTestHeaderString` produced. Neither harness talks to Stripe: the
recorder installs itself into the `globalThis` slot `getStripe()` already
memoises its client into, which leaves `@/server/stripe` itself the shipped
module. The "before" columns come from `apps/web/scripts/fixtures/billing-legacy.ts`,
under the same "checked, not trusted" rule the MCV-040 copies follow.

`verify:mcv043` covers the two findings of MCV-043 and the structural point
behind them. It drives the real booking and referral actions against a real
PostgreSQL:

| Section             | Asserts                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| the re-quote marker | a household may still grow its own party, and the stale quote now says it is stale |
| the trial invoice   | a `PAID` invoice whose `amount_paid` is `0` earns nothing, even at a floor of `0`  |
| the economics       | an offer may not out-pay the invoice that earns it — at the validator and in SQL   |
| the mint            | `createReferralCode` is metered per identity, and the meter is what refused        |

```bash
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/web verify:mcv043
```

Set that database up with `prisma migrate deploy` rather than `db push`, for the
reason `verify:media` gives: two of the four claims are about `CHECK`
constraints, which live in `prisma/migrations` and have no Prisma DSL syntax to
be pushed from. The economics section deliberately writes a money-losing offer
with the raw Prisma client, going around the validator entirely, so the
transcript's last line is PostgreSQL's refusal rather than zod's.

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
unless the database name contains `race`, `test` or `harness` — the same rule
the MCV-040 harnesses apply. It is deliberately _not_ wired into `pnpm verify`,
because it is the one harness that needs two overlapping transactions and a
rendezvous to hold them there, and a scenario that hangs is a worse failure mode
for a default `verify` than one extra command. See the docblock at the head of
`apps/web/scripts/verify-superadmin-race.ts`.

### Working on the database package only

```bash
pnpm --filter=@mannachef/db typecheck

# Both need a reachable PostgreSQL. Both are run by `pnpm verify`:
pnpm --filter=@mannachef/db verify:drift            # migrations must reproduce schema.prisma
pnpm --filter=@mannachef/db verify:conflict-targets # every compound key must resolve
```

`verify:drift` is the MCV-042 guardrail. Prisma Client is generated from
`schema.prisma` and the database is built from `prisma/migrations`, and when
those two disagree nothing fails until PostgreSQL rejects a query in production.
It runs `prisma migrate diff --from-migrations … --to-schema-datamodel …
--exit-code` and fails on any difference, creating the throwaway shadow database
it needs beside whatever `DATABASE_URL` names.

`verify:conflict-targets` builds a scratch database, applies the **full
migration history** to it, regenerates the client, and issues the real queries —
including the `mediaAsset.upsert` that MCV-042 made impossible. It also covers
the constraints `migrate diff` structurally cannot see: `CHECK` constraints and
partial unique indexes have no Prisma DSL syntax, so `ChefAvailability`'s two
per-discriminator partial indexes are asserted against the database directly.

```bash
DATABASE_URL='postgresql://…@localhost:5432/mannachef_harness' \
  pnpm --filter=@mannachef/db verify
```

Neither writes to the database `DATABASE_URL` names; both derive their own
scratch database from its name. See `packages/db/README.md`.
