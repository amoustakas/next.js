// mannachef/apps/web/scripts/fixtures/referral-legacy.ts

/**
 * The pre-MCV-051 qualification query, reproduced so that the "before" column
 * of `verify-mcv051.ts` is produced by **running the defect** rather than by
 * asserting a comment.
 *
 * The technique and its justification are `fixtures/intake-legacy.ts`'s and
 * `fixtures/billing-legacy.ts`'s: the only lever that would let the shipped
 * file run both ways is a flag inside the shipped file, which is a worse thing
 * to have in a codebase than a fixture is.
 *
 * Transcribed from `findQualifyingInvoice` in
 * `apps/web/src/server/actions/referral.ts` as it stood before MCV-051 —
 * `where` and `orderBy` verbatim, with the docblock's own claim about the
 * ordering quoted below because that claim is the finding.
 *
 * ## Why one function is the whole of it
 *
 * MCV-051 has two halves and only this one has a "before" worth running. The
 * other half — `ALREADY_A_CUSTOMER` in `resolveRedemptionEligibility` — was the
 * *absence* of a rule, and an absent rule transcribes to nothing: the pre-fix
 * predicate is the shipped one with that block deleted, which the shipped one
 * demonstrates by being handed a household it now refuses.
 *
 * Nothing under `src/` imports this file, and nothing here is reachable from
 * the application.
 */

import { prisma } from '@/server/db'

/** What the pre-fix `findQualifyingInvoice` returned. */
export interface LegacyQualifyingInvoice {
  readonly id: string
  readonly amountPaidCents: number
  readonly currency: string
  readonly paidAt: Date
}

/**
 * The referred person's earliest paid invoice clearing the floor — **anywhere
 * in their billing history**.
 *
 * The docblock above this query used to read:
 *
 * > Ordered ascending so a household with a long billing history qualifies on
 * > the invoice that actually converted them rather than on their most recent
 * > one.
 *
 * which is the defect stated as a feature. For a household that had already
 * been converted, the earliest invoice is the one furthest from having anything
 * to do with the referral, and with no lower bound this query *searched for* the
 * oldest revenue it could find and paid the reward against that.
 *
 * Note what is missing relative to the shipped version: there is no
 * `qualifyingFromAt` parameter and no bound on `paidAt` beyond `not: null`.
 * Everything else — the `PAID` status, the floor, the `gt: 0` MCV-043 added,
 * the ordering and the tiebreak — is unchanged, so a difference in outcome
 * between this and the shipped sweep is attributable to the bound and to
 * nothing else.
 */
export async function legacyFindQualifyingInvoice(
  referredUserId: string,
  minimumQualifyingInvoiceCents: number
): Promise<LegacyQualifyingInvoice | null> {
  const invoice = await prisma.invoice.findFirst({
    where: {
      userId: referredUserId,
      status: 'PAID',
      paidAt: { not: null },
      amountPaidCents: { gte: minimumQualifyingInvoiceCents, gt: 0 },
    },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      amountPaidCents: true,
      currency: true,
      paidAt: true,
    },
  })

  if (invoice === null || invoice.paidAt === null) {
    return null
  }

  return {
    id: invoice.id,
    amountPaidCents: invoice.amountPaidCents,
    currency: invoice.currency,
    paidAt: invoice.paidAt,
  }
}
