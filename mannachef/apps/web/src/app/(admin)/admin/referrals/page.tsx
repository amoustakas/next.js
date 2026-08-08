// mannachef/apps/web/src/app/(admin)/admin/referrals/page.tsx
import * as React from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertCircle,
  Gift,
  Inbox,
  Info,
  ServerCrash,
  ShieldAlert,
  Users,
} from 'lucide-react'

import { MAX_PAGE_SIZE, signedLedgerAmountCents } from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DateTime } from '@/components/ui/date-time'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Money } from '@/components/ui/money'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  BalanceTools,
  ProgramEditor,
  REDEMPTION_STATUS_META,
  RedemptionActions,
} from '@/components/admin/referrals/program-editor'
import { getSessionRole } from '@/server/auth'
import {
  listReferralCodes,
  listReferralRedemptions,
  readRewardLedger,
} from '@/server/actions/referral'
import { readReferralProgram } from '@/server/actions/referral-program'

export const metadata: Metadata = {
  title: 'Referral Engine',
}

type RawSearchParams = Record<string, string | string[] | undefined>

interface ReferralsPageProps {
  readonly searchParams: Promise<RawSearchParams>
}

/**
 * The success payload of an `ActionResult`-returning action.
 *
 * Same helper as `/admin/subscriptions` — see that file for why the extra
 * layer of generics is what makes `Extract` distribute correctly.
 */
type ActionSuccessData<TAction extends (...args: never[]) => Promise<unknown>> =
  Extract<Awaited<ReturnType<TAction>>, { ok: true }>['data']

function firstParam(raw: RawSearchParams, key: string): string {
  const value = raw[key]
  const single = Array.isArray(value) ? value[0] : value
  return typeof single === 'string' ? single.trim() : ''
}

// =============================================================================
// Failure copy — `readReferralProgram` is this screen's `ADMIN` gate
// =============================================================================

function programFailureCopy(code: string): {
  readonly title: string
  readonly description: string
  readonly isAccessIssue: boolean
} {
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: "You don't have access to the Referral Engine.",
        description:
          'This account is signed in, but its role is too low to see referral codes, redemptions or reward balances. Ask a house admin to raise your access, then refresh.',
        isAccessIssue: true,
      }
    case 'UNAUTHENTICATED':
      return {
        title: 'Your session has expired.',
        description: 'Sign in again to keep managing the referral programme.',
        isAccessIssue: true,
      }
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests, too quickly.',
        description: 'Wait a moment and refresh the page.',
        isAccessIssue: false,
      }
    default:
      return {
        title: 'The Referral Engine could not be loaded.',
        description:
          'Something went wrong on our end. Refresh the page, or try again shortly.',
        isAccessIssue: false,
      }
  }
}

function AccessFailure({ code, message }: { readonly code: string; readonly message: string }) {
  const copy = programFailureCopy(code)

  return (
    <EmptyState
      tone="error"
      icon={copy.isAccessIssue ? ShieldAlert : ServerCrash}
      headingLevel={2}
      title={copy.title}
      description={
        <>
          {copy.description}
          {message.length > 0 && message !== copy.description ? (
            <span className="mt-2 block text-xs text-stone">{message}</span>
          ) : null}
        </>
      }
      action={
        copy.isAccessIssue ? (
          <Button asChild variant="outline">
            <Link href="/admin">Return to the dashboard</Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/admin/referrals">Try again</Link>
          </Button>
        )
      }
    />
  )
}

// =============================================================================
// The page
// =============================================================================

/**
 * The Referral Engine — codes and who owns them, the redemption payout queue,
 * reward balances, and the standing offer that decides what any of it is
 * worth.
 *
 * A Server Component. `readReferralProgram` is `ADMIN` and is called first
 * expressly as this screen's access gate, exactly as `getBillingDashboard` is
 * for `/admin/subscriptions` — a `FORBIDDEN` from it is what decides whether
 * the rest of the page renders at all.
 *
 * ## Why there is no platform-wide "every code" table
 *
 * `listReferralCodes` — "the same page of codes without the balance, for an
 * admin growth table" per its own docblock — still scopes to `ownerId ?? the
 * caller's own id` even for an `ADMIN`. There genuinely is no action that
 * returns every code across every owner in one read; inventing that view here
 * would show data no server call actually produces. Codes are therefore
 * browsed **by owner** — a plain `GET` form, no client JavaScript, exactly
 * like the invoice filters on `/admin/invoices` — while the payout queue below
 * it is the one list that already is platform-wide (`listReferralRedemptions`
 * omits `referralCode.ownerId`'s scoping entirely once the caller is `ADMIN`).
 *
 * Every mutating control — the terms editor, the redemption lifecycle buttons,
 * the balance tools — lives in `<ProgramEditor>`, `<RedemptionActions>` and
 * `<BalanceTools>`, the three client components this page hands flattened,
 * server-authored props to.
 */
export default async function ReferralsPage({
  searchParams,
}: ReferralsPageProps): Promise<React.JSX.Element> {
  const raw = await searchParams
  const ownerId = firstParam(raw, 'ownerId')

  const [role, programResult, redemptionsResult] = await Promise.all([
    getSessionRole(),
    readReferralProgram({}),
    listReferralRedemptions({ pageSize: 25, sortDirection: 'desc' }),
  ])

  const [ownerCodesResult, ownerLedgerResult] =
    ownerId.length > 0
      ? await Promise.all([
          listReferralCodes({
            ownerId,
            pageSize: MAX_PAGE_SIZE,
            sortBy: 'CREATED',
            sortDirection: 'desc',
          }),
          readRewardLedger({ userId: ownerId, pageSize: 10, sortDirection: 'desc' }),
        ])
      : [null, null]

  const isSuperAdmin = role === 'SUPER_ADMIN'

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-xs tracking-[0.24em] text-stone uppercase">
          Referral Engine
        </p>
        <h1
          id="referrals-heading"
          className="font-display text-3xl font-light tracking-tight text-linen"
        >
          Who invited whom, and what it cost
        </h1>
        <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          The standing offer, the payout queue that settles it, and every
          household&rsquo;s reward balance.
        </p>
      </header>

      {!programResult.ok ? (
        <AccessFailure code={programResult.code} message={programResult.error} />
      ) : (
        <>
          <section aria-labelledby="program-heading" className="flex flex-col gap-4">
            <h2 id="program-heading" className="sr-only">
              Programme terms
            </h2>
            <ProgramEditor program={programResult.data} canEdit={isSuperAdmin} />
          </section>

          <RedemptionsSection
            redemptionsResult={redemptionsResult}
            isSuperAdmin={isSuperAdmin}
          />

          <OwnerLookupSection
            ownerId={ownerId}
            codesResult={ownerCodesResult}
            ledgerResult={ownerLedgerResult}
            isSuperAdmin={isSuperAdmin}
          />
        </>
      )}
    </div>
  )
}

// =============================================================================
// The payout queue
// =============================================================================

function RedemptionsSection({
  redemptionsResult,
  isSuperAdmin,
}: {
  readonly redemptionsResult: Awaited<ReturnType<typeof listReferralRedemptions>>
  readonly isSuperAdmin: boolean
}) {
  return (
    <section aria-labelledby="queue-heading" className="flex flex-col gap-4">
      <div>
        <h2
          id="queue-heading"
          className="font-display text-2xl font-light tracking-tight text-linen"
        >
          Redemptions &amp; the payout queue
        </h2>
        <p className="mt-1 max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          Every accepted invitation, platform-wide, most recent first.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-md border border-ash bg-charcoal px-3 py-3">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-stone" />
        <p className="font-sans text-sm leading-relaxed text-parchment">
          A row only exists here once the invited household has said yes —
          consent happens before a redemption is written, not after. The
          status below describes what happens <em>next</em>, not whether they
          agreed: <strong className="text-linen">Pending</strong> means
          accepted but not yet earned, not undecided. A household that never
          answered, or that declined, never appears here — there is no admin
          list of those, by design; only the household sees an invitation
          they have not yet acted on.
        </p>
      </div>

      {!redemptionsResult.ok ? (
        <EmptyState
          tone="error"
          icon={ServerCrash}
          headingLevel={3}
          title="The payout queue could not be loaded."
          description={
            redemptionsResult.error.length > 0
              ? redemptionsResult.error
              : 'Something went wrong on our end. Refresh the page, or try again shortly.'
          }
          action={
            <Button asChild variant="outline">
              <Link href="/admin/referrals">Try again</Link>
            </Button>
          }
        />
      ) : redemptionsResult.data.items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          headingLevel={3}
          title="No redemptions yet"
          description="Once a household accepts an invitation, it will appear here waiting to qualify."
        />
      ) : (
        <Table>
          <TableCaption>
            {redemptionsResult.data.meta.total} redemption
            {redemptionsResult.data.meta.total === 1 ? '' : 's'}, newest
            first.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Referred household</TableHead>
              <TableHead>State</TableHead>
              <TableHead numeric>Reward</TableHead>
              <TableHead>Accepted</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {redemptionsResult.data.items.map((redemption) => {
              const meta = REDEMPTION_STATUS_META[redemption.status]

              return (
                <TableRow key={redemption.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <code className="font-sans text-sm text-linen">
                        {redemption.code}
                      </code>
                      {redemption.codeLabel === null ? null : (
                        <span className="font-sans text-xs text-stone">
                          {redemption.codeLabel}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {redemption.referredUserName === null ? (
                      <span className="text-stone">Withheld</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-sans text-sm text-linen">
                          {redemption.referredUserName}
                        </span>
                        {redemption.referredUserId === null ? null : (
                          <code
                            className="font-sans text-xs text-stone"
                            title={redemption.referredUserId}
                          >
                            {redemption.referredUserId.slice(0, 10)}…
                          </code>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      {redemption.status === 'REVOKED' &&
                      redemption.revokedReason !== null ? (
                        <span
                          className="max-w-[16rem] truncate font-sans text-xs text-stone"
                          title={redemption.revokedReason}
                        >
                          {redemption.revokedReason}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    {redemption.rewardCents === null ? (
                      <span className="text-stone">—</span>
                    ) : (
                      <Money
                        cents={redemption.rewardCents}
                        currency={redemption.currency}
                        weight="medium"
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <DateTime value={redemption.createdAt} format="relative" tone="muted" />
                  </TableCell>
                  <TableCell>
                    <RedemptionActions redemption={redemption} isSuperAdmin={isSuperAdmin} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

// =============================================================================
// Owner lookup — codes, balance, ledger
// =============================================================================

function OwnerLookupSection({
  ownerId,
  codesResult,
  ledgerResult,
  isSuperAdmin,
}: {
  readonly ownerId: string
  readonly codesResult: ActionSuccessData<typeof listReferralCodes> extends never
    ? never
    : Awaited<ReturnType<typeof listReferralCodes>> | null
  readonly ledgerResult: Awaited<ReturnType<typeof readRewardLedger>> | null
  readonly isSuperAdmin: boolean
}) {
  return (
    <section aria-labelledby="owner-heading" className="flex flex-col gap-4">
      <div>
        <h2
          id="owner-heading"
          className="font-display text-2xl font-light tracking-tight text-linen"
        >
          Codes, owned
        </h2>
        <p className="mt-1 max-w-2xl font-sans text-sm leading-relaxed text-parchment">
          Every code, redemption count and balance belongs to one account.
          There is no single list of every code on the platform — look one
          account up by its ID to see what it owns.
        </p>
      </div>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ownerId">Account ID</Label>
          <Input
            id="ownerId"
            name="ownerId"
            defaultValue={ownerId}
            placeholder="cl9ebqhxk00003b600tymydho"
            className="w-80 font-sans"
          />
        </div>
        <Button type="submit" variant="outline">
          Look up
        </Button>
        {ownerId.length > 0 ? (
          <Button asChild variant="ghost">
            <Link href="/admin/referrals">Clear</Link>
          </Button>
        ) : null}
      </form>

      {ownerId.length === 0 ? (
        <EmptyState
          icon={Users}
          headingLevel={3}
          title="No account selected"
          description="Paste an account ID above to see its codes, its balance and its recent ledger entries."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {ledgerResult !== null && ledgerResult.ok ? (
            <Card padded>
              <CardHeader className="flex-row items-start justify-between gap-4 p-0 pb-4">
                <div>
                  <CardTitle level={3}>Balance</CardTitle>
                  <CardDescription>
                    Reconciled directly from the ledger below, not the cached
                    total.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 p-0">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="font-sans text-xs text-stone uppercase">
                      Current balance
                    </dt>
                    <dd className="font-display text-2xl text-linen">
                      <Money
                        cents={ledgerResult.data.balance.balanceCents}
                        currency={ledgerResult.data.balance.currency}
                        weight="semibold"
                        colorBySign
                      />
                    </dd>
                  </div>
                  <div>
                    <dt className="font-sans text-xs text-stone uppercase">
                      Lifetime earned
                    </dt>
                    <dd className="font-display text-2xl text-linen">
                      <Money
                        cents={ledgerResult.data.balance.lifetimeEarnedCents}
                        currency={ledgerResult.data.balance.currency}
                        weight="semibold"
                      />
                    </dd>
                  </div>
                  <div>
                    <dt className="font-sans text-xs text-stone uppercase">
                      Lifetime redeemed
                    </dt>
                    <dd className="font-display text-2xl text-linen">
                      <Money
                        cents={ledgerResult.data.balance.lifetimeRedeemedCents}
                        currency={ledgerResult.data.balance.currency}
                        weight="semibold"
                      />
                    </dd>
                  </div>
                </div>

                <BalanceTools userId={ownerId} isSuperAdmin={isSuperAdmin} />

                {ledgerResult.data.items.length === 0 ? (
                  <p className="font-sans text-sm text-stone">
                    No ledger entries for this account yet.
                  </p>
                ) : (
                  <Table>
                    <TableCaption>Recent ledger entries, newest first.</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Reason</TableHead>
                        <TableHead numeric>Amount</TableHead>
                        <TableHead numeric>Balance after</TableHead>
                        <TableHead>Note</TableHead>
                        <TableHead>When</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ledgerResult.data.items.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            <Badge variant={entry.direction === 'CREDIT' ? 'success' : 'muted'}>
                              {entry.reason}
                            </Badge>
                          </TableCell>
                          <TableCell numeric>
                            <Money
                              cents={signedLedgerAmountCents(entry)}
                              currency={entry.currency}
                              signed
                              colorBySign
                              weight="medium"
                            />
                          </TableCell>
                          <TableCell numeric>
                            <Money cents={entry.balanceAfterCents} currency={entry.currency} />
                          </TableCell>
                          <TableCell>
                            {entry.note === null ? (
                              <span className="text-stone">—</span>
                            ) : (
                              <span
                                className="block max-w-[16rem] truncate font-sans text-sm text-parchment"
                                title={entry.note}
                              >
                                {entry.note}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <DateTime value={entry.createdAt} format="relative" tone="muted" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="flex items-start gap-3 rounded-md border border-terracotta/50 bg-terracotta/12 px-3 py-3">
              <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-terracotta" />
              <p className="font-sans text-sm leading-relaxed text-parchment">
                The balance and ledger for this account could not be loaded.
              </p>
            </div>
          )}

          {codesResult === null ? null : !codesResult.ok ? (
            <EmptyState
              tone="error"
              icon={ServerCrash}
              headingLevel={3}
              title="This account's codes could not be loaded."
              description={
                codesResult.error.length > 0
                  ? codesResult.error
                  : 'Something went wrong on our end. Refresh the page, or try again shortly.'
              }
            />
          ) : codesResult.data.items.length === 0 ? (
            <EmptyState
              icon={Gift}
              headingLevel={3}
              title="This account owns no referral codes"
              description="A code appears here once this account mints one."
            />
          ) : (
            <Table>
              <TableCaption>
                This account&rsquo;s referral codes, snapshotted from the
                standing terms at the moment each was minted.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Reward</TableHead>
                  <TableHead numeric>Redemptions</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codesResult.data.items.map((code) => (
                  <TableRow key={code.id}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <code className="font-sans text-sm text-linen">{code.code}</code>
                        {code.label === null ? null : (
                          <span className="font-sans text-xs text-stone">{code.label}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {code.rewardType === 'PERCENT_DISCOUNT' ? (
                        `${String(code.rewardValuePercent ?? 0)}%`
                      ) : (
                        <Money cents={code.rewardValueCents ?? 0} currency={code.currency} />
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {code.redemptionCount}
                      {code.maxRedemptions === null ? '' : ` / ${String(code.maxRedemptions)}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={code.isRedeemable ? 'success' : 'muted'}>
                        {code.isRedeemable ? 'Redeemable' : code.isActive ? 'Exhausted' : 'Deactivated'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {code.expiresAt === null ? (
                        <span className="text-stone">Never</span>
                      ) : (
                        <DateTime value={code.expiresAt} format="date" tone="muted" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </section>
  )
}
