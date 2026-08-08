-- =============================================================================
-- MCV-051 — a referral is paid on money the invitation brought in
-- =============================================================================
--
-- MCV-030 gave the programme a qualifying floor. MCV-043 refused an invoice
-- paid for nothing and made a money-losing offer a decision rather than an
-- accident. Both rest on one unexamined premise, stated on the `ReferralProgram`
-- model in `schema.prisma`: that the whole cost of manufacturing a referred
-- household is "a single PAID invoice on a **new** account".
--
-- Nothing enforced the word *new*. `findQualifyingInvoice` filtered on
-- `userId`, `status = 'PAID'`, `paidAt IS NOT NULL` and the floor, ordered
-- `paidAt ASC`, with no lower bound tied to the redemption — and its docblock
-- argued *for* that, on the grounds that a household with a long billing history
-- should qualify on "the invoice that actually converted them". That reasoning
-- is exactly backwards for a household that was already converted.
-- `resolveRedemptionEligibility`, meanwhile, had no rule against an existing
-- customer at all.
--
-- So an ACTIVE_SUBSCRIBER whose only invoice was paid two years ago could sign
-- in, redeem a code minted this morning, and be settled against that invoice on
-- the next sweep. Two existing customers redeeming each other's codes were both
-- paid out of revenue the house had already booked, and the entire customer base
-- could be farmed once each.
--
-- This migration adds the two columns the fix needs:
--
--  1. `ReferralRedemption.qualifyingFromAt` — the moment the invitation was
--     accepted. `findQualifyingInvoice` now requires `paidAt >=` it, in the
--     WHERE clause rather than in a comment.
--
--  2. `ReferralProgram.allowExistingCustomerReferral` — off by default. The
--     eligibility predicate refuses a household that had already paid us before
--     that moment; this column is the explicit, deliberate way to say that a
--     win-back is the offer being made, rather than letting it happen by
--     accident.
--
-- See the notes on both models in `schema.prisma`, and
-- `apps/web/src/server/referral-eligibility.ts` for the predicate.

-- -----------------------------------------------------------------------------
-- 1. Columns
--
-- `qualifyingFromAt` is NOT NULL with no default, because each writer has to
-- state which moment it means (see the model note). That cannot be added to a
-- populated table in one statement, so it arrives nullable, is backfilled, and
-- is then tightened — which is why this section is hand-sequenced rather than
-- the verbatim output of `prisma migrate diff`.
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "ReferralProgram" ADD COLUMN     "allowExistingCustomerReferral" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReferralRedemption" ADD COLUMN     "qualifyingFromAt" TIMESTAMP(3);


-- =============================================================================
-- HAND-WRITTEN ADDITIONS (MCV-051) — DO NOT DELETE ON REGENERATION
-- =============================================================================
-- Everything below this marker is hand-written and is NOT produced by
-- `prisma migrate diff`. It is one backfill, one NOT NULL tightening, and one
-- CHECK constraint. If this migration is ever regenerated from a schema diff,
-- re-append this exact block afterwards. See packages/db/README.md, and note
-- that the equivalent blocks in 0000_init, 0001_referral_program, 0003 and 0004
-- belong to those migrations and must not be touched from here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2. Backfill: an existing redemption is anchored to its own creation
-- -----------------------------------------------------------------------------

-- `createdAt` is the only moment a pre-MCV-051 row records, and it is the
-- honest reading of it: whatever the path that wrote it, the invitation was
-- accepted no later than the row that records the acceptance.
--
-- For rows written by the Checkout webhook this is very slightly *stricter*
-- than the moment the fix will store going forward — the session was opened
-- before it completed — so a historical redemption whose conversion invoice was
-- recorded a few seconds "early" will not settle. That is the correct direction
-- for a backfill to err in: it can refuse a payout that was owed, which an
-- operator can grant by hand through `payReferralReward`, and it cannot make one
-- that was not. Inventing a wider window here would be inventing consent to pay.
UPDATE "ReferralRedemption"
SET "qualifyingFromAt" = "createdAt"
WHERE "qualifyingFromAt" IS NULL;

ALTER TABLE "ReferralRedemption"
  ALTER COLUMN "qualifyingFromAt" SET NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. How far back the anchor may reach
-- -----------------------------------------------------------------------------

-- The anchor is supplied by the application, and the whole value of the column
-- is that it bounds the qualifying invoice below. A writer that could set it
-- arbitrarily far into the past would have re-opened the finding one argument at
-- a time, so the floor is restated here where a direct `psql` session cannot
-- walk around it.
--
-- Thirty days is CLAIM_WINDOW_DAYS in
-- `apps/web/src/server/referral-claim.ts`, which is the longest any of the three
-- legitimate moments can precede the row that records it: an MCV-050 claim typed
-- into an enquiry form settles at the first sign-in within that window, and a
-- Stripe Checkout session (the other anchor that precedes its row) expires
-- within 24 hours. The portal form's anchor is the redemption instant itself.
--
-- There is deliberately **no upper bound**. An anchor later than `createdAt` can
-- only refuse an invoice, never admit one, so it carries no money risk — and a
-- `qualifyingFromAt <= createdAt` check would compare a timestamp taken from the
-- application's clock against one taken from the database's, which is a
-- constraint violation waiting for the first millisecond of skew.
ALTER TABLE "ReferralRedemption"
  ADD CONSTRAINT "ReferralRedemption_qualifyingFromAt_floor_check"
  CHECK ("qualifyingFromAt" >= "createdAt" - INTERVAL '30 days');
