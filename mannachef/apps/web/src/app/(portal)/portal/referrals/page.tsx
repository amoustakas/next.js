// mannachef/apps/web/src/app/(portal)/portal/referrals/page.tsx

/**
 * The referral programme, from a subscriber's side of it.
 *
 * A **Server Component**. Three reads run together; the only client code is the
 * share affordances and — when there is no code yet — the one-field form that
 * asks for one.
 *
 * ## The terms are the programme's, and the page says so
 *
 * A `CLIENT` cannot set what a code is worth. `createReferralCode` and
 * `updateReferralCode` both take the seven money-bearing fields
 * (`rewardType`, `rewardValueCents`, `rewardValuePercent`,
 * `refereeRewardCents`, `currency`, `maxRedemptions`, `expiresAt`) off the
 * standing `ReferralProgram` for anybody below `ADMIN` and discard whatever the
 * browser sent — in **both** directions, so the invariant an auditor checks is
 * "a client code's terms are the programme's" rather than "a client may move
 * them, but only in the house's favour".
 *
 * This page therefore renders those seven values as **facts about the offer**,
 * not as fields. There is no edit control anywhere on it, and the copy says
 * plainly that the figures are the programme's. A subscriber keeps exactly two
 * powers over a code — naming it and withdrawing it — and naming is the only
 * one this screen offers, on the form that mints it.
 *
 * ## Why a reward is not credited at signup
 *
 * Because `redeemReferralCode` writes a `PENDING` redemption and stops: a
 * reward is earned when the referred household actually pays a qualifying
 * bill. The page states that where the pending count is shown, since "waiting
 * to qualify" is otherwise the sort of status that reads like a delay rather
 * than a rule.
 */

import type * as React from 'react'
import { Gift, Users } from 'lucide-react'

import type { ReferralCodeSummary } from '@mannachef/api-contract'

import { ActionError } from '@/components/portal/action-error'
import { ReferralShare } from '@/components/portal/referral-share'
import { RedemptionStatusBadge } from '@/components/portal/status-badges'
import { RequestReferralCodeForm } from '@/components/portal/request-referral-code-form'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getSessionUser } from '@/server/auth'
import {
  listReferralRedemptions,
  readReferralOverview,
  readRewardLedger,
} from '@/server/actions/referral'

export const metadata = {
  title: 'Referrals',
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://mannachef.com'

const REWARD_TYPE_LABELS: Readonly<Record<string, string>> = {
  FIXED_CREDIT: 'Credit on your account',
  PERCENT_DISCOUNT: 'A share off your next bill',
  FREE_MEAL: 'A complimentary meal',
  FREE_DELIVERY: 'A waived delivery',
}

const LEDGER_REASON_LABELS: Readonly<Record<string, string>> = {
  REFERRAL_REWARD: 'A referral was earned',
  REFERRAL_SIGNUP_BONUS: 'A welcome from somebody else’s code',
  PROMOTIONAL_GRANT: 'A gesture from us',
  MANUAL_ADJUSTMENT: 'An adjustment by hand',
  INVOICE_REDEMPTION: 'Spent against an invoice',
  EXPIRATION: 'Lapsed',
  REVERSAL: 'Reversed',
}

/** The invitation link, which pre-fills the questionnaire with the code. */
function invitationUrlFor(code: string): string {
  return `${SITE_URL}/consultation?code=${encodeURIComponent(code)}`
}

/** What the owner of a code receives, in the programme's own terms. */
function OwnerReward({
  code,
}: {
  readonly code: ReferralCodeSummary
}): React.JSX.Element {
  if (code.rewardType === 'PERCENT_DISCOUNT') {
    return (
      <span className="text-linen tabular-nums">
        {code.rewardValuePercent === null
          ? 'Set by the programme'
          : `${String(code.rewardValuePercent)}%`}
      </span>
    )
  }

  return code.rewardValueCents === null ? (
    <span className="text-stone">Set by the programme</span>
  ) : (
    <Money
      cents={code.rewardValueCents}
      currency={code.currency}
      tone="accent"
      weight="medium"
    />
  )
}

export default async function PortalReferralsPage(): Promise<React.JSX.Element> {
  const user = await getSessionUser()

  const [overview, redemptions, ledger] = await Promise.all([
    readReferralOverview({ pageSize: 10 }),
    listReferralRedemptions({ pageSize: 25 }),
    readRewardLedger({ pageSize: 10 }),
  ])

  if (!overview.ok) {
    return (
      <ActionError
        code={overview.code}
        error={overview.error}
        subject="your referrals"
        headingLevel={2}
      />
    )
  }

  const codes = overview.data.codes.items
  const primary = codes.find((entry) => entry.isRedeemable) ?? codes[0] ?? null
  const balance = overview.data.balance

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-3xl leading-tight font-light text-linen">
          Referrals
        </h2>
        <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          The households you send us are the ones we most want to cook for.
          Share your code, and when somebody you invited has dined with us and
          settled their bill, a reward lands on your account.
        </p>
      </header>

      {/* ---- Balance --------------------------------------------------- */}
      <Card as="section" variant="elevated">
        <CardHeader>
          <CardDescription>Your reward balance</CardDescription>
          <CardTitle level={3} className="font-display text-4xl font-light">
            <Money
              cents={balance.balanceCents}
              currency={balance.currency}
              tone="accent"
            />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 sm:grid-cols-3">
            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                Earned in all
              </dt>
              <dd className="mt-1 font-sans text-sm text-parchment">
                <Money
                  cents={balance.lifetimeEarnedCents}
                  currency={balance.currency}
                />
              </dd>
            </div>
            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                Spent
              </dt>
              <dd className="mt-1 font-sans text-sm text-parchment">
                <Money
                  cents={balance.lifetimeRedeemedCents}
                  currency={balance.currency}
                />
              </dd>
            </div>
            <div>
              <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                Still to qualify
              </dt>
              <dd className="mt-1 font-sans text-sm text-parchment tabular-nums">
                {String(overview.data.pendingRedemptions)}
              </dd>
            </div>
          </dl>

          <p className="mt-5 font-sans text-xs leading-relaxed text-stone">
            An invitation that has been accepted is not yet a reward. Nothing is
            credited until the household you invited has actually dined with us
            and paid a qualifying bill — which is what keeps the programme worth
            something to everybody in it.
          </p>
        </CardContent>
      </Card>

      {/* ---- The code -------------------------------------------------- */}
      <section aria-labelledby="your-code-heading" className="flex flex-col gap-5">
        <h3
          id="your-code-heading"
          className="font-display text-2xl font-light text-linen"
        >
          Your invitation
        </h3>

        {primary === null ? (
          // The layout has already redirected a signed-out visitor, so this
          // arm is unreachable in practice. It is answered rather than
          // asserted away — `getSessionUser` is honestly nullable, and a page
          // that reads `user.id` behind a `!` would be a page that trusts the
          // layout to have run.
          user === null ? (
            <EmptyState
              icon={Gift}
              title="No invitation code yet."
              description="Sign in again and we will issue one for you."
            />
          ) : (
            <Card variant="quiet">
              <CardContent className="flex flex-col gap-5 p-6">
                <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
                  You do not have an invitation code yet. We will mint one for
                  you on the programme&rsquo;s standing terms — you do not
                  choose what it is worth, and neither do we from this page.
                </p>
                <RequestReferralCodeForm ownerId={user.id} />
              </CardContent>
            </Card>
          )
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <Card variant="default">
              <CardContent className="p-6">
                <ReferralShare
                  code={primary.code}
                  invitationUrl={invitationUrlFor(primary.code)}
                  isRedeemable={primary.isRedeemable}
                />
              </CardContent>
            </Card>

            <Card variant="accent">
              <CardHeader>
                <CardDescription>The terms</CardDescription>
                <CardTitle level={4}>Set by the programme</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-4">
                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      You receive
                    </dt>
                    <dd className="mt-1 font-sans text-sm">
                      <OwnerReward code={primary} />
                      <span className="block text-xs text-stone">
                        {REWARD_TYPE_LABELS[primary.rewardType] ??
                          primary.rewardType}
                      </span>
                    </dd>
                  </div>

                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      They receive
                    </dt>
                    <dd className="mt-1 font-sans text-sm text-parchment">
                      {primary.refereeRewardCents === null ? (
                        <span className="text-stone">
                          Nothing beyond our welcome
                        </span>
                      ) : (
                        <Money
                          cents={primary.refereeRewardCents}
                          currency={primary.currency}
                        />
                      )}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      How many times
                    </dt>
                    <dd className="mt-1 font-sans text-sm text-parchment tabular-nums">
                      {primary.maxRedemptions === null
                        ? `${String(primary.redemptionCount)} used, no limit`
                        : `${String(primary.redemptionCount)} of ${String(
                            primary.maxRedemptions
                          )} used`}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                      Until
                    </dt>
                    <dd className="mt-1 font-sans text-sm text-parchment">
                      {primary.expiresAt === null ? (
                        'Open until we withdraw it'
                      ) : (
                        <DateTime value={primary.expiresAt} />
                      )}
                    </dd>
                  </div>
                </dl>

                <Separator variant="hairline" className="my-5" decorative />

                <p className="font-sans text-xs leading-relaxed text-stone">
                  These figures belong to the programme, not to the code. They
                  are the same for every subscriber and cannot be changed from
                  here — which is what makes an invitation worth the same
                  whoever sends it.
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {codes.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            <span className="font-sans text-xs text-stone">
              Your other codes:
            </span>
            {codes
              .filter((entry) => entry.id !== primary?.id)
              .map((entry) => (
                <Badge
                  key={entry.id}
                  variant={entry.isRedeemable ? 'outline' : 'muted'}
                >
                  {entry.label ?? entry.code}
                </Badge>
              ))}
          </div>
        ) : null}
      </section>

      {/* ---- Redemptions ----------------------------------------------- */}
      <section
        aria-labelledby="redemptions-heading"
        className="flex flex-col gap-5"
      >
        <h3
          id="redemptions-heading"
          className="font-display text-2xl font-light text-linen"
        >
          Invitations accepted
        </h3>

        {!redemptions.ok ? (
          <ActionError
            code={redemptions.code}
            error={redemptions.error}
            subject="the invitations you have sent"
          />
        ) : redemptions.data.items.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody has used your code yet."
            description="When somebody does, they appear here — first as waiting to qualify, then as rewarded once they have dined with us and settled."
          />
        ) : (
          <Table containerClassName="rounded-lg border border-ash">
            <TableCaption srOnly>
              Invitations accepted against your codes, newest first.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Accepted</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>State</TableHead>
                <TableHead numeric>Reward</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redemptions.data.items.map((redemption) => (
                <TableRow key={redemption.id}>
                  <TableCell>
                    <DateTime value={redemption.createdAt} />
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs tracking-wider text-parchment uppercase">
                      {redemption.code}
                    </span>
                    {redemption.codeLabel === null ? null : (
                      <span className="block text-xs text-stone">
                        {redemption.codeLabel}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <RedemptionStatusBadge status={redemption.status} />
                  </TableCell>
                  <TableCell numeric>
                    {redemption.rewardCents === null ? (
                      <span className="text-xs text-stone">Not yet set</span>
                    ) : (
                      <Money
                        cents={redemption.rewardCents}
                        currency={redemption.currency}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <p className="font-sans text-xs leading-relaxed text-stone">
          We do not tell you who accepted an invitation. Whoever used your code
          has their own relationship with us, and that is theirs rather than
          ours to share.
        </p>
      </section>

      {/* ---- Ledger ---------------------------------------------------- */}
      <section aria-labelledby="ledger-heading" className="flex flex-col gap-5">
        <h3
          id="ledger-heading"
          className="font-display text-2xl font-light text-linen"
        >
          Where the balance came from
        </h3>

        {!ledger.ok ? (
          <ActionError
            code={ledger.code}
            error={ledger.error}
            subject="your reward ledger"
          />
        ) : ledger.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Gift}
            title="Nothing on the ledger yet."
            description="Every credit and every penny spent is recorded here, with the reason for it."
          />
        ) : (
          <Table containerClassName="rounded-lg border border-ash" density="compact">
            <TableCaption srOnly>
              Your reward ledger, newest first, with the balance after each
              entry.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Why</TableHead>
                <TableHead numeric>Amount</TableHead>
                <TableHead numeric>Balance after</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.data.items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <DateTime value={entry.createdAt} />
                  </TableCell>
                  <TableCell>
                    {LEDGER_REASON_LABELS[entry.reason] ?? entry.reason}
                    {entry.note === null ? null : (
                      <span className="block text-xs text-stone">
                        {entry.note}
                      </span>
                    )}
                  </TableCell>
                  <TableCell numeric>
                    <Money
                      cents={
                        entry.direction === 'DEBIT'
                          ? -entry.amountCents
                          : entry.amountCents
                      }
                      currency={entry.currency}
                      signed
                      colorBySign
                    />
                  </TableCell>
                  <TableCell numeric>
                    <Money
                      cents={entry.balanceAfterCents}
                      currency={entry.currency}
                      tone="muted"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}
