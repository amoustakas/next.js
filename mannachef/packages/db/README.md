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
hand-written constraints it needs to *that* migration's `.sql` file instead,
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

3. **NULL-distinctness fixes.** Two `@@unique` constraints in the Prisma
   schema are decorative under Postgres's NULL-distinctness rules, because
   they span two nullable columns that are supposed to be mutually exclusive:
   - `ChefAvailability` distinguishes `RECURRING_WEEKLY` rows (`dayOfWeek` set,
     `specificDate` null) from `DATE_OVERRIDE` rows (`specificDate` set,
     `dayOfWeek` null). The original
     `@@unique([staffProfileId, kind, dayOfWeek, specificDate, startMinute, endMinute])`
     always has a `NULL` in one of `dayOfWeek`/`specificDate`, and Postgres
     never treats two `NULL`s as equal — so two identical `RECURRING_WEEKLY`
     rows for the same staff member, day, and time window could be inserted
     without ever tripping the constraint. This is replaced with two partial
     unique indexes, one per `kind`, each keyed only on the columns that are
     actually populated for that branch.
   - `MediaAsset.@@unique([provider, providerFileKey])` is decorative for
     every row where `providerFileKey` is `NULL` (e.g. `provider = EXTERNAL`
     assets, which have no provider file key at all) for the same reason.
     Replaced with a unique index scoped to `WHERE "providerFileKey" IS NOT
     NULL`.

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
