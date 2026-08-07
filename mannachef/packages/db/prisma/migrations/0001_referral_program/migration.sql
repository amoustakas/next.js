-- CreateTable
CREATE TABLE "ReferralProgram" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL DEFAULT 'default',
    "rewardType" "RewardType" NOT NULL DEFAULT 'FIXED_CREDIT',
    "rewardValueCents" INTEGER,
    "rewardValuePercent" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "refereeRewardCents" INTEGER,
    "defaultMaxRedemptions" INTEGER,
    "defaultExpiryDays" INTEGER,
    "minimumQualifyingInvoiceCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgram_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgram_key_key" ON "ReferralProgram"("key");

-- CreateIndex
CREATE INDEX "ReferralProgram_isActive_idx" ON "ReferralProgram"("isActive");

-- CreateIndex
CREATE INDEX "ReferralProgram_updatedById_idx" ON "ReferralProgram"("updatedById");

-- AddForeignKey
ALTER TABLE "ReferralProgram" ADD CONSTRAINT "ReferralProgram_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- HAND-WRITTEN ADDITIONS (MCV-030) — DO NOT DELETE ON REGENERATION
-- =============================================================================
-- Everything below this marker is hand-written and is NOT produced by
-- `prisma migrate diff`. It encodes invariants the Prisma DSL cannot express
-- (CHECK constraints). If this migration is ever regenerated from a schema
-- diff, re-append this exact block afterwards.
-- See packages/db/README.md for the full explanation, and note that the
-- equivalent block in 0000_init belongs to that migration and must not be
-- touched from here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Documented numeric ranges the Prisma DSL cannot enforce
-- -----------------------------------------------------------------------------

-- ReferralProgram.rewardValueCents: "Set when rewardType is FIXED_CREDIT /
-- FREE_MEAL / FREE_DELIVERY. 1-1,000,000." Both bounds are constrained here,
-- unlike ReferralCode.rewardValueCents, which carries only a non-negativity
-- check. The difference is deliberate: this is the one row a caller who is not
-- an administrator can cause money to be paid out against, so the ceiling that
-- `rewardCentsSchema` enforces in the Zod layer (MAX_REWARD_CENTS = 1,000,000)
-- is restated where a direct `psql` session cannot walk around it. Zero is
-- excluded on the same grounds as the validator's message: a reward has to be
-- worth something, and a standing offer of nothing is a misconfiguration rather
-- than a withdrawn programme (which is `isActive = false`).
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_rewardValueCents_range_check"
  CHECK ("rewardValueCents" IS NULL OR ("rewardValueCents" >= 1 AND "rewardValueCents" <= 1000000));

-- ReferralProgram.rewardValuePercent: "Set when rewardType is PERCENT_DISCOUNT.
-- Whole percent, 1-100." Same range as ReferralCode.rewardValuePercent.
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_rewardValuePercent_range_check"
  CHECK ("rewardValuePercent" IS NULL OR ("rewardValuePercent" >= 1 AND "rewardValuePercent" <= 100));

-- ReferralProgram.refereeRewardCents: the invited household's half of the offer,
-- 1-1,000,000 when set, null when the offer rewards only the inviter.
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_refereeRewardCents_range_check"
  CHECK ("refereeRewardCents" IS NULL OR ("refereeRewardCents" >= 1 AND "refereeRewardCents" <= 1000000));

-- ReferralProgram.defaultMaxRedemptions: "1-10,000, or null to leave programme
-- codes open-ended." The ceiling matches MAX_REDEMPTIONS in
-- packages/validators/src/referral.ts; beyond it, a code is a campaign rather
-- than an invitation.
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_defaultMaxRedemptions_range_check"
  CHECK ("defaultMaxRedemptions" IS NULL OR ("defaultMaxRedemptions" >= 1 AND "defaultMaxRedemptions" <= 10000));

-- ReferralProgram.defaultExpiryDays: "1-3,650, or null to leave programme codes
-- open until they are withdrawn." Ten years is not a business rule so much as a
-- guard against a fat-fingered value that is indistinguishable from "never".
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_defaultExpiryDays_range_check"
  CHECK ("defaultExpiryDays" IS NULL OR ("defaultExpiryDays" >= 1 AND "defaultExpiryDays" <= 3650));

-- ReferralProgram.minimumQualifyingInvoiceCents: "0 means any paid invoice
-- qualifies." Non-negative because it is a money magnitude, and capped at the
-- same 1,000,000 as a reward so a typo cannot silently make every referral
-- unqualifiable for ever.
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_minimumQualifyingInvoiceCents_range_check"
  CHECK ("minimumQualifyingInvoiceCents" >= 0 AND "minimumQualifyingInvoiceCents" <= 1000000);

-- -----------------------------------------------------------------------------
-- 2. Reward pairing invariant
-- -----------------------------------------------------------------------------

-- The reward a programme offers is a discriminated union, not a bag of nullable
-- columns: PERCENT_DISCOUNT carries a percentage and no cash value, and every
-- other kind carries a cash value and no percentage. `referralProgramUpsertSchema`
-- enforces this at the boundary and `updateReferralProgram` writes the triple as
-- a whole, but this is the row the reward figures on every client-minted code
-- are copied from, so the pairing is made a fact of the table as well. Without
-- it, a FIXED_CREDIT programme with a NULL rewardValueCents would mint codes
-- promising a fixed credit of nothing.
ALTER TABLE "ReferralProgram"
  ADD CONSTRAINT "ReferralProgram_reward_pairing_check"
  CHECK (
    ("rewardType" = 'PERCENT_DISCOUNT' AND "rewardValuePercent" IS NOT NULL AND "rewardValueCents" IS NULL)
    OR
    ("rewardType" <> 'PERCENT_DISCOUNT' AND "rewardValueCents" IS NOT NULL AND "rewardValuePercent" IS NULL)
  );
