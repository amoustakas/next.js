-- =============================================================================
-- MCV-043 — the re-quote marker, and the referral programme's economics
-- =============================================================================
--
-- Two unrelated columns in one migration because they are one task, and because
-- a migration per column buys nothing on a history this short.
--
--  1. `ChefAppointment.quotedGuestCount` — the party size the money columns were
--     priced for (finding G). `rescheduleAppointment` lets a household change
--     `guestCount` and refuses every money field, so a party of four could be
--     priced by the concierge and then rescheduled to forty at the four-person
--     figure. Recording what the quote was *for* makes that divergence visible
--     instead of silent; see the note on the column in `schema.prisma`.
--
--  2. `ReferralProgram.allowLossLeader` — plus the constraint that makes a
--     money-losing offer a decision rather than an accident. See the economics
--     note on the `ReferralProgram` model in `schema.prisma` for the full
--     argument; the short version is that nothing bounds the *aggregate* cost of
--     the referral programme, so the only thing that can keep it from being
--     farmable is that each referred household costs more than it pays out.

-- -----------------------------------------------------------------------------
-- 1. Columns (this half is what `prisma migrate diff` produces)
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "ChefAppointment" ADD COLUMN     "quotedGuestCount" INTEGER;

-- AlterTable
ALTER TABLE "ReferralProgram" ADD COLUMN     "allowLossLeader" BOOLEAN NOT NULL DEFAULT false;


-- =============================================================================
-- HAND-WRITTEN ADDITIONS (MCV-043) — DO NOT DELETE ON REGENERATION
-- =============================================================================
-- Everything below this marker is hand-written and is NOT produced by
-- `prisma migrate diff`. It encodes invariants the Prisma DSL cannot express
-- (CHECK constraints) and one backfill. If this migration is ever regenerated
-- from a schema diff, re-append this exact block afterwards.
-- See packages/db/README.md for the full explanation, and note that the
-- equivalent blocks in 0000_init and 0001_referral_program belong to those
-- migrations and must not be touched from here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2. Documented numeric range: ChefAppointment.quotedGuestCount
-- -----------------------------------------------------------------------------

-- "1-200 when set, and null while nobody has priced this engagement at all."
-- The bounds are MIN_GUEST_COUNT and MAX_GUEST_COUNT in
-- packages/validators/src/booking.ts, which is where `guestCount` itself is
-- bounded. `guestCount` carries no such constraint in 0000_init; that is that
-- migration's business and is deliberately not changed from here, but a column
-- being added now is added with its documented range enforced.
ALTER TABLE "ChefAppointment"
  ADD CONSTRAINT "ChefAppointment_quotedGuestCount_range_check"
  CHECK ("quotedGuestCount" IS NULL OR ("quotedGuestCount" >= 1 AND "quotedGuestCount" <= 200));

-- -----------------------------------------------------------------------------
-- 3. Backfill: existing offers that already lose money say so
-- -----------------------------------------------------------------------------

-- The constraint added in section 4 is validated against existing rows, and any
-- programme configured before this migration may well violate it — the floor
-- column defaults to 0, so an offer switched on without anybody thinking about
-- the floor pays a real reward for an invoice of nothing. That row has to go
-- somewhere.
--
-- It is marked as a loss leader rather than "repaired". The alternatives were
-- to raise its floor or to lower its reward, and both silently change what an
-- offer already in circulation pays out or what qualifies for it — a migration
-- must not do that. `allowLossLeader` is a statement about the row, and for
-- these rows the statement is simply true: this offer does pay out more than
-- the invoice that earns it. Setting it changes no behaviour at all, and it
-- surfaces on the SUPER_ADMIN form as a ticked box somebody can now untick
-- (which will then require them to give the offer a floor that covers it).
--
-- The arithmetic mirrors `ownerRewardCents` in
-- apps/web/src/server/actions/referral.ts exactly: a flat credit is constant, a
-- percentage is taken against the floor. The MAX_REWARD_CENTS clamp that
-- function applies is not restated, because it can never bind here — the floor
-- is capped at 1,000,000 by
-- `ReferralProgram_minimumQualifyingInvoiceCents_range_check` and the percentage
-- at 100, so the product never exceeds the clamp.
UPDATE "ReferralProgram"
SET "allowLossLeader" = true
WHERE (
  CASE
    WHEN "rewardType" = 'PERCENT_DISCOUNT'
      THEN round(("minimumQualifyingInvoiceCents"::numeric * COALESCE("rewardValuePercent", 0)::numeric) / 100)
    ELSE COALESCE("rewardValueCents", 0)::numeric
  END
  + COALESCE("refereeRewardCents", 0)::numeric
) > "minimumQualifyingInvoiceCents"::numeric;

-- -----------------------------------------------------------------------------
-- 4. The economics invariant
-- -----------------------------------------------------------------------------

-- What the offer pays out for one referred household must not exceed what that
-- household pays in — unless somebody has said, on this row, that a loss is the
-- point.
--
-- Checking at the floor checks everywhere: `ownerRewardCents` is either a
-- constant (every non-PERCENT reward type) or a share of the invoice bounded at
-- 100%, so `invoice - ownerReward(invoice)` is non-decreasing in `invoice` and
-- the tightest case is the smallest invoice that can qualify. That smallest
-- invoice is `minimumQualifyingInvoiceCents` — or one cent, when the floor is
-- zero, since `findQualifyingInvoice` refuses an invoice paid for nothing.
-- Using the floor rather than max(floor, 1) is the stricter of the two by at
-- most a cent and is the figure an operator actually typed, which is the one
-- worth putting in an error message.
--
-- `referralProgramUpsertSchema` enforces the same rule at the boundary and is
-- what an operator will actually meet. This is here for the same reason
-- `ReferralProgram_reward_pairing_check` is: this is the one row a caller who is
-- not an administrator can cause money to be paid out against, so the rule is
-- restated where a direct `psql` session cannot walk around it.
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_reward_economics_check"
  CHECK (
    "allowLossLeader"
    OR (
      (
        CASE
          WHEN "rewardType" = 'PERCENT_DISCOUNT'
            THEN round(("minimumQualifyingInvoiceCents"::numeric * COALESCE("rewardValuePercent", 0)::numeric) / 100)
          ELSE COALESCE("rewardValueCents", 0)::numeric
        END
        + COALESCE("refereeRewardCents", 0)::numeric
      ) <= "minimumQualifyingInvoiceCents"::numeric
    )
  );
