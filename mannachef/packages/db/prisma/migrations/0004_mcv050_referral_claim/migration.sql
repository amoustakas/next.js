-- =============================================================================
-- MCV-050 — a referral claim is a string until a mailbox is proved
-- =============================================================================
--
-- Three audit rounds produced the same money hole from the same public door:
-- an unauthenticated caller causing a `ReferralRedemption` — which is money — to
-- be written by typing an email address. Round 3 did it against an address that
-- did not exist yet, so the MCV-040 guard ("did this call insert the `User`
-- row?") waved it through and the attacker was paid when the genuine owner of
-- that mailbox later signed up and paid a real invoice.
--
-- The discriminant was wrong. "This call created the row" is not "this caller
-- has proved control of this mailbox". Nobody had held that account *yet*.
--
-- So the public path stops writing to the ledger at all. What it may write is
-- two columns of attribution:
--
--  1. `ClientProfile.claimedReferralCode` / `.claimedReferralCodeAt` — the code
--     somebody typed, with no financial meaning whatever. It becomes a
--     redemption only at the first sign-in that proves the mailbox, through the
--     one canonical writer (`createReferralRedemption`), with the full
--     eligibility predicate re-run at that moment.
--
--  2. `User.unclaimedSince` — the marker on an account opened for an address
--     nobody has proved. It exists because a placeholder with no `Account` row
--     and `allowDangerousEmailAccountLinking: false` would otherwise deny Google
--     registration to that address for ever, which is a second, quieter harm of
--     the same call. A row nobody has ever signed into holds nothing of
--     anybody's, so it may be adopted rather than collided with.
--
-- See the notes on both models in `schema.prisma`, and
-- `apps/web/src/server/referral-claim.ts` for the settlement itself.

-- -----------------------------------------------------------------------------
-- 1. Columns (this half is what `prisma migrate diff` produces)
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "ClientProfile" ADD COLUMN     "claimedReferralCode" VARCHAR(40),
ADD COLUMN     "claimedReferralCodeAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "unclaimedSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ClientProfile_claimedReferralCode_idx" ON "ClientProfile"("claimedReferralCode");

-- CreateIndex
CREATE INDEX "User_unclaimedSince_idx" ON "User"("unclaimedSince");


-- =============================================================================
-- HAND-WRITTEN ADDITIONS (MCV-050) — DO NOT DELETE ON REGENERATION
-- =============================================================================
-- Everything below this marker is hand-written and is NOT produced by
-- `prisma migrate diff`. It encodes an invariant the Prisma DSL cannot express.
-- If this migration is ever regenerated from a schema diff, re-append this exact
-- block afterwards. See packages/db/README.md.

-- A claim is a code *and* the moment it was made, or it is neither.
--
-- The date is not decoration: `settleFirstAuthenticatedSession` refuses a claim
-- older than its window, and a claim with no date could not be aged out. Since
-- an attribution that never lapses is the one part of this mechanism that has a
-- cost — it is what an address-sprayer would be waiting on — the pairing is
-- restated here, where a direct `psql` session cannot walk around it.
ALTER TABLE "ClientProfile"
  ADD CONSTRAINT "ClientProfile_claimed_referral_pairing_check"
  CHECK (("claimedReferralCode" IS NULL) = ("claimedReferralCodeAt" IS NULL));
