// mannachef/apps/web/src/components/portal/view-models.ts

/**
 * What crosses from a Server Component into the portal's client components.
 *
 * Every one of these shapes has a counterpart inside `src/server/actions/**` —
 * `ReferralRedemptionReceipt`, `PendingReferralClaimView`,
 * `ReferralClaimAcceptanceView` and friends, all from `referral.ts` and
 * `referral-claim.ts` — and none of them is imported from there. Two reasons,
 * and the second is the one that matters (see `@/components/admin/view-models`
 * for the admin side of the same rule):
 *
 *  1. Those modules carry `'use server'` and pull in Prisma. Importing one into
 *     a client component *for a type* is erased by `verbatimModuleSyntax`, so it
 *     is harmless at runtime — but it is a reference that stops being type-only
 *     the moment somebody adds a value to the import, and nothing in the build
 *     complains until the browser bundle has grown a database client.
 *  2. Declaring the boundary here makes it *readable*. This file is the complete
 *     list of what the portal browser bundle knows about a referral claim.
 *
 * `referral-claim-banner.tsx` is the only consumer today — the claim it renders
 * is already exactly the disclosure `@/server/actions/referral-claim`'s module
 * docblock describes, so these are verbatim mirrors, not trimmed subsets.
 */

import type { ReferralRedemptionStatus } from '@mannachef/validators'

/**
 * Mirrors `RedemptionRefusal` in `src/server/referral-eligibility.ts` — that
 * module isn't a `'use server'` action file, but it sits under `src/server/`
 * and is not written to be client-safe, so its types get the same treatment
 * as an action module's rather than being imported directly.
 */
export type RedemptionRefusal =
  | 'NO_ACCOUNT'
  | 'UNKNOWN_CODE'
  | 'EXPIRED'
  | 'FULLY_REDEEMED'
  | 'OWN_CODE'
  | 'SAME_HOUSEHOLD'
  | 'ALREADY_USED'
  | 'ALREADY_REFERRED'
  | 'ALREADY_A_CUSTOMER'

/** The guest-facing reason a redemption or claim was refused. */
export interface ReferralClaimRefusalView {
  /**
   * The machine-readable refusal, so a screen can branch on it.
   *
   * More informative than {@link ReferralClaimRefusalView.message}:
   * `EXPIRED`, `FULLY_REDEEMED`, `OWN_CODE` and `SAME_HOUSEHOLD` each imply
   * the code exists.
   */
  readonly reason: RedemptionRefusal
  /** The guest sentence from `REDEMPTION_REFUSALS`. Never a Prisma message. */
  readonly message: string
}

/**
 * What the standing claim is worth and who is claiming the credit for it.
 *
 * Present only when the claim is acceptable *at this moment* — a name is
 * disclosed exactly when a completed redemption would have disclosed it
 * anyway.
 */
export interface ReferralClaimAttributionView {
  /**
   * The inviter as they are known to us, or `null` when we hold no name for
   * them. Never an email address, a phone number or a user id.
   */
  readonly inviterDisplayName: string | null
  /**
   * What this household would receive, in whole cents, or `null` when
   * neither the code nor the standing programme names a figure for the
   * referred party.
   */
  readonly refereeRewardCents: number | null
  readonly currency: string
  /** The code's own expiry, when it states one. */
  readonly codeExpiresAt: Date | null
}

/** Whether the standing claim can be acted on, and on what terms. */
export type ReferralClaimStanding =
  /** Acceptable now. The only arm that carries an attribution. */
  | {
      readonly kind: 'acceptable'
      readonly attribution: ReferralClaimAttributionView
    }
  /** Older than the claim window. Only declining is left. */
  | { readonly kind: 'lapsed' }
  /** The canonical predicate refuses it as things stand. */
  | {
      readonly kind: 'unacceptable'
      readonly refusal: ReferralClaimRefusalView
    }

/** The standing claim, as a consent prompt renders it. */
export interface PendingReferralClaimView {
  readonly code: string
  readonly claimedAt: Date
  /**
   * The last moment this claim may be accepted — `claimedAt` plus the claim
   * window.
   *
   * Distinct from `attribution.codeExpiresAt`, which is the code's own
   * expiry. Both bind; this one is the floor under codes that carry no
   * expiry at all.
   */
  readonly expiresAt: Date
  readonly standing: ReferralClaimStanding
  /** Where the claim came from. Every claim this view can describe was typed
   * by somebody who had proved nothing. */
  readonly provenance: 'public-enquiry-form'
  /** Nobody has verified that the party who typed this knows this household. */
  readonly assurance: 'unverified'
  /** The disclosure sentence shown alongside the claim. */
  readonly disclosure: string
}

/** What `acceptReferralClaim` did. */
export type ReferralClaimAcceptanceView =
  /** A `PENDING` redemption now exists, written by the one canonical writer. */
  | {
      readonly kind: 'accepted'
      readonly code: string
      readonly redemptionId: string
      readonly status: ReferralRedemptionStatus
      readonly refereeRewardCents: number | null
      readonly currency: string
    }
  /** Past the claim window. Consumed and discarded. */
  | {
      readonly kind: 'expired'
      readonly code: string
      readonly claimedAt: Date
    }
  /** The canonical predicate refused it now. Consumed and discarded. */
  | {
      readonly kind: 'refused'
      readonly code: string
      readonly refusal: ReferralClaimRefusalView
    }
  /** Nothing is standing for this household. Re-read; there is nothing to show. */
  | { readonly kind: 'nothing-standing' }
  /**
   * This household has already answered for this code — here, in another tab,
   * or in an earlier session. Idempotent no-op.
   */
  | { readonly kind: 'already-answered'; readonly code: string }
  /**
   * A different claim is standing than the one that was rendered. Nothing was
   * consumed; re-read and ask again.
   */
  | { readonly kind: 'superseded'; readonly standing: string }

/** What `declineReferralClaim` did. */
export type ReferralClaimDeclineView =
  /** Cleared and tombstoned. It will not be offered again. */
  | { readonly kind: 'declined'; readonly code: string }
  | { readonly kind: 'nothing-standing' }
  | { readonly kind: 'already-answered'; readonly code: string }
  | { readonly kind: 'superseded'; readonly standing: string }

/** The receipt `redeemReferralCode` hands back — "I was given a different code". */
export interface ReferralRedemptionReceipt {
  readonly redemptionId: string
  readonly code: string
  readonly status: ReferralRedemptionStatus
  /**
   * What the invited guest themselves will receive once they qualify, in
   * whole cents, or `null` when the code rewards only its owner. The
   * *owner's* reward is deliberately not disclosed: it is somebody else's
   * money.
   */
  readonly refereeRewardCents: number | null
  readonly currency: string
}
