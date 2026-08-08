# mannachef/packages/db/README.md

# @mannachef/db

Prisma 6 schema, generated client, and the PostgreSQL migration history for the
MannaChef platform.

## The hand-written block in `prisma/migrations/0000_init/migration.sql`

`0000_init/migration.sql` starts with the output of:

```bash
npx prisma@6 migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Everything **after** the banner

```sql
-- =============================================================================
-- HAND-WRITTEN ADDITIONS (MCV-007) — DO NOT DELETE ON REGENERATION
-- =============================================================================
```

is **hand-written** and is not, and never will be, produced by `prisma migrate
diff`. Prisma's schema DSL has no syntax for `CHECK` constraints or partial
(`WHERE`-scoped) unique indexes, so these invariants have to be added by hand
directly to the SQL migration.

**If this migration is ever regenerated** (e.g. because the initial schema
changed before the project has shipped, and `0000_init` is being redone rather
than followed by a new migration), you must re-run the `prisma migrate diff`
command above and then re-append this exact hand-written block to the new
output. Do not let a regeneration silently drop it — the application code and
the tests for money handling, availability scheduling, and booking capacity
all assume these constraints exist in every environment, not just in
apps/web's Zod validators.

In the normal case — the schema changes going forward — do **not** touch
`0000_init` at all. Create a new migration for the change and add any new
hand-written constraints it needs to _that_ migration's `.sql` file instead,
following the same pattern.

### What's in the hand-written block, and why

1. **Numeric range `CHECK` constraints** for every range documented in a
   `schema.prisma` doc comment that the Prisma DSL itself cannot enforce:
   `Review.rating` (1–5), `ConsultationInterview.compatibilityScore` (0–100),
   `MenuItem.seasonStart` / `seasonEnd` (1–12), `ChefAvailability.dayOfWeek`
   (0–6), `ChefAvailability.startMinute` / `endMinute` (0–1439 / 1–1440, with
   `endMinute > startMinute`), and `ReferralCode.rewardValuePercent` (1–100).
   Without these, a bug in a server action (or a direct `psql` session, or a
   future service that talks to the same database) could silently write a
   6-star review or a 13th "month" of seasonality — the Zod layer only
   protects writes that go through it.

2. **Money sanity checks.** Every `…Cents` column is constrained to be `>= 0`,
   because money is stored as integer minor units and a negative price,
   balance, or fee is a bug in every model except two documented exceptions:
   - `InvoiceLineItem.amountCents` may be negative **only** when
     `kind = 'DISCOUNT'`, so that summing every line item's `amountCents`
     yields the invoice subtotal directly without the summing code having to
     special-case discount lines.
   - `RewardLedgerEntry.amountCents` and `RewardLedgerEntry.balanceAfterCents`
     are left **unconstrained** in sign. `RewardLedgerEntry` is an
     append-only audit trail; a `MANUAL_ADJUSTMENT` or `REVERSAL` entry must
     be able to carry a negative amount to correct a prior over-credit, and
     `balanceAfterCents` mirrors the running balance immediately after that
     entry, which can transiently go negative until a later corrective entry
     restores it. `RewardBalance.balanceCents` itself (the customer-facing
     current balance) is still constrained to `>= 0` — it's spendable store
     credit, not a line of credit a client can go into debt on.

3. **NULL-distinctness fix (`ChefAvailability`).** `ChefAvailability`
   distinguishes `RECURRING_WEEKLY` rows (`dayOfWeek` set, `specificDate`
   null) from `DATE_OVERRIDE` rows (`specificDate` set, `dayOfWeek` null). The
   original
   `@@unique([staffProfileId, kind, dayOfWeek, specificDate, startMinute, endMinute])`
   always has a `NULL` in one of `dayOfWeek`/`specificDate`, and Postgres never
   treats two `NULL`s as equal — so two identical `RECURRING_WEEKLY` rows for
   the same staff member, day, and time window could be inserted without ever
   tripping the constraint. It is replaced with two partial unique indexes, one
   per `kind`, each keyed only on the columns that are actually populated for
   that branch.

   `0000_init` applied the same reasoning to
   `MediaAsset.@@unique([provider, providerFileKey])` and replaced it with an
   index scoped to `WHERE "providerFileKey" IS NOT NULL`. **That one was
   wrong**, and `0002_media_asset_conflict_target` puts it back. The reasoning
   is in "Reconciling a hand-written index with the datamodel" below; read that
   section before reaching for a partial index again.

4. **`ChefAvailability` discriminator invariant.** A `CHECK` constraint
   enforces that `RECURRING_WEEKLY` rows always have `dayOfWeek NOT NULL` and
   `specificDate NULL`, and `DATE_OVERRIDE` rows always have the reverse. This
   is also a prerequisite for the two partial unique indexes above to be
   mutually exclusive and exhaustive.

5. **Time-ordering invariants.**
   - `ChefAppointment`: `endsAt > startsAt` (an appointment can't have
     zero or negative duration), and `prepStartsAt <= startsAt` when set (prep
     can't start after the appointment itself has started).
   - `BookingSlot`: `endsAt > startsAt`, and `bookedCount <= capacity` (a slot
     can never be oversold at the database layer, independent of whatever
     application-level locking is used when incrementing `bookedCount`).

### The later hand-written blocks

`0000_init` is not the only migration with one, and each block belongs to the
migration that introduced the column it constrains:

- **`0001_referral_program`** — the numeric ranges on `ReferralProgram`, and the
  reward-pairing `CHECK` that keeps a `FIXED_CREDIT` offer from carrying a
  percentage (MCV-030).
- **`0003_mcv043_referral_economics_and_requote`** — the range on
  `ChefAppointment.quotedGuestCount`, a one-off backfill, and
  `ReferralProgram_reward_economics_check` (MCV-043).
- **`0004_mcv050_referral_claim`** — `ClientProfile.claimedReferralCode` /
  `.claimedReferralCodeAt`, `User.unclaimedSince`, and
  `ClientProfile_claimed_referral_pairing_check`, which keeps a claimed code and
  the date it was claimed non-null together (MCV-050). The pairing is in SQL
  because the date is not decoration: `settleFirstAuthenticatedSession` refuses a
  claim older than its window, and a claim with no date could not be aged out.
  An attribution that never lapses is the one part of that mechanism with a cost.
- **`0005_mcv051_referral_new_money`** — `ReferralRedemption.qualifyingFromAt`
  and `ReferralProgram.allowExistingCustomerReferral`, plus a backfill, a
  `SET NOT NULL`, and `ReferralRedemption_qualifyingFromAt_floor_check`
  (MCV-051). This is the only migration whose _column_ section is hand-sequenced
  rather than verbatim `prisma migrate diff` output: `qualifyingFromAt` is
  `NOT NULL` with no default, which cannot be added to a populated table in one
  statement, so it arrives nullable, is backfilled from `createdAt`, and is then
  tightened. See below for what the column is for.

`ReferralProgram_reward_economics_check` is the only `CHECK` in the history that is _arithmetic across
several columns_ rather than a range on one, so it is worth saying what it
encodes. Nothing bounds the aggregate cost of the referral programme — every
other ceiling is per redemption — so the only thing that can keep it from being
farmable is that each referred household costs more to manufacture than it pays
out. The constraint is that inequality, evaluated at the cheapest invoice that
can qualify:

```
ownerRewardAtTheFloor + COALESCE(refereeRewardCents, 0)
  <= minimumQualifyingInvoiceCents      unless allowLossLeader
```

Checking at the floor checks everywhere, because the owner's reward is either a
constant or a share of the invoice bounded at 100%, so the slack only grows as
the invoice does. The full argument is on the `ReferralProgram` model in
`schema.prisma`; `referralProgramUpsertSchema` enforces the same rule at the
boundary, and `apps/web`'s `verify:mcv043` asserts both layers, the second by
writing around the first with the raw client.

The backfill in that migration deserves its own note, because a migration that
changes data is rare here. `ALTER TABLE … ADD CONSTRAINT … CHECK` validates
existing rows, and a programme configured before MCV-043 may well violate the
new one — `minimumQualifyingInvoiceCents` defaults to `0`, so an offer switched
on before anybody thought about the floor pays a real reward for an invoice of
nothing. Such rows are marked `allowLossLeader = true` rather than repaired: the
alternatives were to raise the floor or lower the reward, and both silently
change what an offer already in circulation pays out. Setting the flag changes
no behaviour and states something true of the row.

### The premise that constraint rests on (MCV-051)

`ReferralProgram_reward_economics_check` compares what an offer pays out against
`minimumQualifyingInvoiceCents`, and the whole argument for that being a _cost_
is the sentence "the cost of manufacturing one referred household is a single
PAID invoice on a **new** account". Nothing enforced the word _new_ until
MCV-051. `findQualifyingInvoice` searched a household's entire billing history
with no lower bound, and `resolveRedemptionEligibility` had no rule against an
existing customer, so a two-year subscriber could accept an invitation today and
have it settled against a bill paid long before the code existed. The invoice
side of the inequality was then revenue the house had already booked, the cost
of manufacturing a referred household was zero for everybody already on the
books, and the constraint's arithmetic held while its premise did not.

`ReferralRedemption.qualifyingFromAt` is that premise made checkable. It records
the moment an invitation was accepted, and two rules hang off it: the settlement
query bounds `paidAt` below by it, and the eligibility predicate refuses a
household that had already paid us before it. `ReferralRedemption_qualifyingFromAt_floor_check`
bounds how far back the anchor may reach — thirty days, matching
`CLAIM_WINDOW_DAYS`, which is the longest an MCV-050 claim may precede the
sign-in that settles it. There is deliberately no upper bound: an anchor later
than `createdAt` can only refuse an invoice, never admit one, so it carries no
money risk, and such a check would compare the application's clock against the
database's and fail on the first millisecond of skew.

`ReferralProgram.allowExistingCustomerReferral` is the way to say a win-back is
intended, on the same terms as `allowLossLeader`: off by default, so the
permissive branch is never chosen by a missing key. It widens who may be
referred and never what pays for them — the anchor still bounds the qualifying
invoice. `apps/web`'s `verify:mcv051` asserts every one of these, including the
`CHECK` by writing around the application with the raw client, and produces its
"before" column by running the pre-fix query out of
`scripts/fixtures/referral-legacy.ts`.

### Regenerating or extending

- Changing an existing model? Add a new migration (`prisma migrate dev
--create-only` or hand-authored) for the schema change, and add any new
  hand-written constraints to that migration, not to `0000_init`.
- Touching one of the columns/models above? Update both the `schema.prisma`
  doc comment (the source of truth for the documented range/invariant) and
  the corresponding `CHECK`/index in the migration that introduced it.
- Validate any hand-written SQL you add the same way this file's block was
  validated: load it into a disposable Postgres instance (or at minimum run
  it through `psql --set ON_ERROR_STOP=1 -f migration.sql` against a scratch
  database) before committing.
- **Run `pnpm --filter @mannachef/db verify` before committing.** A
  hand-written index that diverges from `schema.prisma` is not a style
  problem; MCV-042 below is what it costs.

---

## Reconciling a hand-written index with the datamodel (MCV-042)

Prisma has two schemas, and the hand-written block above is what makes them
come apart.

- **Prisma Client is generated from `schema.prisma`.** An `@@unique` there is
  what puts a compound key in `WhereUniqueInput`, and what makes `upsert` emit
  `INSERT … ON CONFLICT (<those columns>) DO UPDATE`.
- **The database is built from `prisma/migrations`.** An `@@unique` that no
  migration creates as a plain unique index exists nowhere a query can reach.

Every hand-written index therefore has to be reconciled with the datamodel
deliberately, in one of two directions. Getting the direction wrong is silent:
the types still check, the unit tests still pass, and PostgreSQL rejects the
query at runtime.

### What went wrong

`0000_init` swapped a plain unique index for a partial one on
`MediaAsset(provider, providerFileKey)` while leaving
`@@unique([provider, providerFileKey])` in `schema.prisma`. PostgreSQL will
only infer an `ON CONFLICT` target from a bare column list to a **non-partial**
unique index, so `completeMediaUpload`
(`apps/web/src/server/actions/media.ts`) — the only path an asset enters the
library by — failed on every call, on every database built from the migration
history:

```text
42P10: there is no unique or exclusion constraint matching the ON CONFLICT
       specification
```

Media upload was dead platform-wide behind a fully green test suite, because
nothing in that suite touched `mediaAsset.upsert` against a real PostgreSQL.

### The two directions, and how to choose

**Direction A — reconcile toward the datamodel** (`MediaAsset`,
`0002_media_asset_conflict_target`). Drop the partial index, create the plain
one Prisma expects, under the name Prisma derives
(`MediaAsset_provider_providerFileKey_key`).

Choose this when the partial index and the plain one enforce **the same thing**.
That was the case here, and the MCV-007 reasoning that produced the partial
index — "rows with a `NULL` file key can never collide anyway" — is exactly why:
a plain unique index on `(provider, providerFileKey)` still admits any number of
keyless `EXTERNAL` assets, because Postgres's default `NULLS DISTINCT` means two
such tuples are never equal. The predicate was buying no additional enforcement,
only losing the ability to back an `ON CONFLICT`. Nothing about the
NULL-distinctness finding is reverted; it simply had no work to do on this table.

**Direction B — reconcile toward the SQL** (`ChefAvailability`). Delete the
`@@unique` from `schema.prisma`, keep the partial indexes, and say in a comment
on the model what enforces uniqueness instead.

Choose this when the partial indexes encode something the DSL genuinely cannot
say. `ChefAvailability` has two constraints, not one — a `RECURRING_WEEKLY` rule
is unique on `(staffProfileId, dayOfWeek, startMinute, endMinute)` and a
`DATE_OVERRIDE` rule on `(staffProfileId, specificDate, startMinute, endMinute)`
— and no single tuple expresses both. The six-column `@@unique` that was there
could not reject a single real duplicate, and declaring it bought nothing but
permanent drift plus an unusable `ON CONFLICT` target in the generated client.

**Before choosing direction B, grep for the compound key.** Removing an
`@@unique` removes its member from `WhereUniqueInput`, so any `findUnique`,
`update`, `delete` or `upsert` addressing it stops compiling — and an `upsert`
that _was_ compiling was relying on an `ON CONFLICT` that could never have
worked. For `ChefAvailability` the search was
`grep -rn 'staffProfileId_kind' apps packages`, which found nothing: every
access is by `id`.

### The guardrail

Both of the checks below need a reachable PostgreSQL. They are wired into
`pnpm --filter @mannachef/db verify`, which the root `pnpm verify` runs.

```bash
DATABASE_URL=postgresql://…/mannachef_harness pnpm --filter @mannachef/db verify
```

- **`scripts/verify-migration-drift.ts`** (`verify:drift`) runs

  ```bash
  prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma \
    --shadow-database-url … \
    --exit-code
  ```

  and fails the build on any difference. Exit code 2 from that command means
  drift, not error, and the script separates the two — a guardrail that reads a
  CLI failure as "no drift" is decorative. The shadow database is derived from
  `DATABASE_URL` by suffixing the database name with `_migrate_shadow`, created
  on first use, and never the database `DATABASE_URL` itself names.

  Note what this does **not** cover: `CHECK` constraints and partial unique
  indexes have no DSL syntax, so `migrate diff` cannot see them in either
  direction. A partial index in SQL is not reported as an extra, and it cannot
  stand in for a plain `@@unique` in the datamodel — which is the asymmetry that
  makes it report MCV-042 in the first place.

- **`scripts/verify-conflict-targets.ts`** (`verify:conflict-targets`) drops and
  recreates a scratch database (`<DATABASE_URL's database>_conflict_harness`),
  applies the **full migration history** to it with `prisma migrate deploy`,
  regenerates the client from `schema.prisma`, and then issues the real queries.
  It asserts the upsert resolves its conflict target in both directions; that a
  genuine duplicate is still rejected; that keyless `EXTERNAL` assets are still
  admitted; and — for `ChefAvailability`, where the constraint was removed from
  the datamodel and therefore from the drift check's view — that both partial
  indexes and the discriminator `CHECK` still enforce what they claim to.

- **`apps/web`'s `verify:media`** (`scripts/verify-media-upload.ts`) drives the
  real `completeMediaUpload` Server Action — guard, zod transform, transaction
  and all — against a database built from the migration history. The two db
  checks prove the schema is coherent; this one proves the action an
  administrator actually reaches still files a photograph.
