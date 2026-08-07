// mannachef/packages/api-contract/scripts/verify-round-trip.ts

/**
 * Proves the GET transport is lossless.
 *
 * Every `GET` entry in {@link ApiContract} is exercised end to end with the
 * contract's *own* serialiser and its *own* input schema:
 *
 * ```text
 *   representative input
 *     → entry.input.parse            (what a JSON body would produce)
 *     → toSearchParams / buildQueryUrl
 *     → fromSearchParams
 *     → entry.input.parse            (what the query string produces)
 *     → deep-equal the two
 * ```
 *
 * Two directions are checked per case, because a client reaches
 * {@link buildQueryUrl} from both sides of the parse:
 *
 *  - **parsed** — the shape the JSDoc on `toSearchParams` describes, where
 *    defaults are filled and dates are `Date` instances;
 *  - **raw** — the shape a screen actually holds, where a flag is a real
 *    `boolean` and a date may still be an ISO string.
 *
 * A route passes only when both directions parse *and* land on exactly the
 * value a JSON body would have produced. Parsing successfully is not enough:
 * a filter that silently loses `tagSlugs` on the way through would still be a
 * 200, and would still show the guest the wrong dishes.
 *
 * Run: `pnpm --filter=@mannachef/api-contract verify:round-trip`
 */

import {
  ApiContract,
  API_ROUTE_KEYS,
  buildQueryUrl,
  fromSearchParams,
  queryArrayKeys,
  toSearchParams,
  type AnyApiRoute,
  type ApiRouteKey,
} from '../src/index.ts'

// =============================================================================
// Fixtures
// =============================================================================

/** `z.cuid()` is `/^[cC][0-9a-z]{6,}$/`. */
const CUID_A = 'clh3k9x0a0000qwer1234asdf'
const CUID_B = 'clh3k9x0a0001zxcv5678hjkl'
const CUID_C = 'clh3k9x0a0002poiu9012mnbv'

const EARLIER = new Date('2026-02-14T19:30:00.000Z')
const LATER = new Date('2026-03-21T17:00:00.000Z')

/** One representative payload, named so a failure says which one broke. */
interface Case {
  readonly label: string
  readonly input: Readonly<Record<string, unknown>>
}

/**
 * Representative inputs per route.
 *
 * Each route gets a `minimal` case — nothing but what is required, which proves
 * defaults survive the trip — and a `full` case that touches every kind of
 * value the transport has to encode: integers, enums, booleans, `Date`s, and
 * arrays. Where a route has an array field it also gets a `single-element
 * array` case, because that is the one shape a query string cannot distinguish
 * from a scalar and therefore the one that breaks silently.
 */
const CASES: Readonly<Partial<Record<ApiRouteKey, readonly Case[]>>> = {
  'auth.session': [{ label: 'minimal', input: {} }],

  'menu.list': [
    { label: 'minimal', input: {} },
    {
      label: 'single-element array',
      input: { tagSlugs: ['vegan'] },
    },
    {
      label: 'full',
      input: {
        page: 3,
        pageSize: 50,
        sortDirection: 'asc',
        search: 'truffle',
        categorySlug: 'mains',
        subcategorySlug: 'pasta',
        tagSlugs: ['vegan', 'gluten-free', 'nut-free'],
        tagMatchMode: 'ANY',
        priceCentsMin: 1_500,
        priceCentsMax: 12_000,
        seasonalOnly: true,
        signatureOnly: false,
        includeInactive: true,
        sortBy: 'PRICE',
      },
    },
  ],

  'menu.detail': [
    { label: 'minimal', input: { slug: 'chef-tasting-menu' } },
    {
      label: 'explicit false flag',
      input: { slug: 'chef-tasting-menu', includeInactive: false },
    },
    {
      label: 'explicit true flag',
      input: { slug: 'chef-tasting-menu', includeInactive: true },
    },
  ],

  'availability.query': [
    { label: 'minimal', input: {} },
    {
      label: 'full',
      input: {
        page: 2,
        pageSize: 10,
        sortDirection: 'asc',
        staffProfileId: CUID_A,
        status: 'OPEN',
        serviceType: 'IN_HOME_DINNER',
        startsFrom: EARLIER,
        startsUntil: LATER,
        onlyBookable: true,
      },
    },
  ],

  'appointment.list': [
    { label: 'minimal', input: {} },
    {
      label: 'full',
      input: {
        page: 1,
        pageSize: 25,
        sortDirection: 'desc',
        clientProfileId: CUID_A,
        staffProfileId: CUID_B,
        bookingSlotId: CUID_C,
        status: 'CONFIRMED',
        serviceType: 'PRIVATE_EVENT',
        startsFrom: EARLIER,
        startsUntil: LATER,
      },
    },
  ],

  'subscription.read': [
    { label: 'minimal', input: {} },
    { label: 'single-element array', input: { statuses: ['ACTIVE'] } },
    {
      label: 'full',
      input: {
        page: 2,
        pageSize: 5,
        sortDirection: 'asc',
        userId: CUID_A,
        planId: CUID_B,
        statuses: ['ACTIVE', 'TRIALING', 'PAST_DUE'],
        cancellingOnly: false,
        pausedOnly: true,
        renewingFrom: EARLIER,
        renewingUntil: LATER,
      },
    },
  ],

  'invoice.list': [
    { label: 'minimal', input: {} },
    { label: 'single-element array', input: { statuses: ['OPEN'] } },
    {
      label: 'full',
      input: {
        page: 4,
        pageSize: 100,
        sortDirection: 'asc',
        search: 'INV-2026',
        userId: CUID_A,
        subscriptionId: CUID_B,
        appointmentId: CUID_C,
        issuedById: CUID_A,
        statuses: ['OPEN', 'PAID'],
        manualOnly: true,
        outstandingOnly: false,
        overdueOnly: false,
        minAmountDueCents: 2_500,
        maxAmountDueCents: 250_000,
        issuedFrom: EARLIER,
        issuedTo: LATER,
        dueFrom: EARLIER,
        dueTo: LATER,
        sortBy: 'AMOUNT',
      },
    },
  ],

  'referral.read': [
    { label: 'minimal', input: {} },
    {
      label: 'single-element array',
      input: { rewardTypes: ['FREE_MEAL'] },
    },
    {
      label: 'full',
      input: {
        page: 1,
        pageSize: 20,
        sortDirection: 'desc',
        search: 'MANNA',
        ownerId: CUID_A,
        rewardTypes: ['FIXED_CREDIT', 'PERCENT_DISCOUNT'],
        isActive: false,
        expiredOnly: true,
        exhaustedOnly: false,
        createdFrom: EARLIER,
        createdTo: LATER,
        sortBy: 'REDEMPTIONS',
      },
    },
  ],

  'staff.directory': [
    { label: 'minimal', input: {} },
    {
      label: 'single-element arrays',
      input: { specialties: ['pastry'], languages: ['French'] },
    },
    {
      label: 'full',
      input: {
        page: 2,
        pageSize: 12,
        sortDirection: 'asc',
        search: 'wood-fired',
        specialties: ['pastry', 'Levantine'],
        languages: ['English', 'French'],
        baseCity: 'Toronto',
        baseRegion: 'Ontario',
        baseCountry: 'CA',
        minHourlyRateCents: 5_000,
        maxHourlyRateCents: 40_000,
        minYearsExperience: 5,
        maxServiceRadiusKm: 60,
        acceptingClientsOnly: false,
        sortBy: 'EXPERIENCE',
      },
    },
  ],

  'payment.history': [
    { label: 'minimal', input: {} },
    { label: 'single-element arrays', input: { statuses: ['SUCCEEDED'] } },
    {
      label: 'full',
      input: {
        page: 3,
        pageSize: 30,
        sortDirection: 'desc',
        search: 'ch_3Pabcd',
        userId: CUID_A,
        invoiceId: CUID_B,
        subscriptionId: CUID_C,
        statuses: ['SUCCEEDED', 'PARTIALLY_REFUNDED'],
        methods: ['CARD', 'INTERAC'],
        currency: 'CAD',
        minAmountCents: 1_000,
        maxAmountCents: 500_000,
        refundedOnly: true,
        failedOnly: false,
        unsettledOnly: false,
        createdFrom: EARLIER,
        createdTo: LATER,
        processedFrom: EARLIER,
        processedTo: LATER,
        sortBy: 'AMOUNT',
      },
    },
  ],

  'onboarding.read': [
    { label: 'minimal', input: {} },
    { label: 'single-element array', input: { stages: ['ACTIVATED'] } },
    {
      label: 'full',
      input: {
        page: 1,
        pageSize: 15,
        sortDirection: 'asc',
        search: 'Fournier',
        clientProfileId: CUID_A,
        stages: ['INVITED', 'INTAKE_SUBMITTED', 'PLAN_SELECTED'],
        minProgressPercent: 10,
        maxProgressPercent: 90,
        completedOnly: false,
        abandonedOnly: false,
        inProgressOnly: true,
        startedFrom: EARLIER,
        startedTo: LATER,
        lastAdvancedFrom: EARLIER,
        lastAdvancedTo: LATER,
        sortBy: 'PROGRESS',
      },
    },
  ],
}

/** Attaches a query string to a route's URL. */
type UrlBuilder = (query: Readonly<Record<string, unknown>>) => string

/**
 * How each route's URL is built, one entry per GET route.
 *
 * Spelled out per key rather than driven from a widened `AnyApiRoute`, because
 * `PathBuilder` is `(...args: never[]) => string` — deliberately, so that every
 * concrete builder is assignable to it — and nothing can *call* a `never[]`
 * parameter. Reaching `buildQueryUrl` through the literal key keeps each
 * route's own parameter type, so `menu.detail` is checked against
 * `MenuDetailParams` and a missing or misspelled `slug` is a compile error
 * here, exactly as it would be in the Expo client. The alternative was a cast,
 * which would have defeated the point of the typed path builders.
 */
const URL_BUILDERS: Readonly<Partial<Record<ApiRouteKey, UrlBuilder>>> = {
  'auth.session': (query) =>
    buildQueryUrl('', ApiContract['auth.session'], {}, query),
  'menu.list': (query) =>
    buildQueryUrl('', ApiContract['menu.list'], {}, query),
  'menu.detail': (query) =>
    buildQueryUrl(
      '',
      ApiContract['menu.detail'],
      { slug: 'chef-tasting-menu' },
      query
    ),
  'availability.query': (query) =>
    buildQueryUrl('', ApiContract['availability.query'], {}, query),
  'appointment.list': (query) =>
    buildQueryUrl('', ApiContract['appointment.list'], {}, query),
  'subscription.read': (query) =>
    buildQueryUrl('', ApiContract['subscription.read'], {}, query),
  'invoice.list': (query) =>
    buildQueryUrl('', ApiContract['invoice.list'], {}, query),
  'referral.read': (query) =>
    buildQueryUrl('', ApiContract['referral.read'], {}, query),
  'staff.directory': (query) =>
    buildQueryUrl('', ApiContract['staff.directory'], {}, query),
  'payment.history': (query) =>
    buildQueryUrl('', ApiContract['payment.history'], {}, query),
  'onboarding.read': (query) =>
    buildQueryUrl('', ApiContract['onboarding.read'], {}, query),
}

// =============================================================================
// Comparison
// =============================================================================

/** Structural equality, with `Date` compared by instant rather than identity. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }

    return a.every((element, index) => deepEqual(element, b[index]))
  }

  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null
  ) {
    const aRecord = a as Record<string, unknown>
    const bRecord = b as Record<string, unknown>
    const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)])

    for (const key of keys) {
      if (!deepEqual(aRecord[key], bRecord[key])) {
        return false
      }
    }

    return true
  }

  return Object.is(a, b)
}

/** Renders a value so a mismatch report is readable. */
function show(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, raw: unknown) => (raw instanceof Date ? raw.toISOString() : raw),
    0
  )
}

/** The keys whose values differ, for a mismatch report. */
function differingKeys(a: unknown, b: unknown): readonly string[] {
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return ['<root>']
  }

  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>

  return [...new Set([...Object.keys(aRecord), ...Object.keys(bRecord)])]
    .filter((key) => !deepEqual(aRecord[key], bRecord[key]))
    .sort()
}

// =============================================================================
// The round trip
// =============================================================================

interface Failure {
  readonly route: string
  readonly label: string
  readonly detail: string
}

const failures: Failure[] = []
let assertions = 0
let casesRun = 0

/** The query half of a URL produced by `buildQueryUrl`. */
function queryOf(url: string): string {
  const index = url.indexOf('?')

  return index === -1 ? '' : url.slice(index + 1)
}

/**
 * One direction of one case.
 *
 * `payload` is what gets serialised — the parsed form for the first direction,
 * the raw representative input for the second. `expected` is what a JSON body
 * would have produced, and is the same for both.
 */
function checkDirection(
  routeKey: ApiRouteKey,
  entry: AnyApiRoute,
  buildUrlFor: UrlBuilder,
  label: string,
  direction: string,
  payload: Readonly<Record<string, unknown>>,
  expected: unknown
): void {
  assertions += 1

  const query = queryOf(buildUrlFor(payload))

  // `toSearchParams` is called directly as well, so the two entry points a
  // client may use are both covered rather than only the composed one.
  const direct = toSearchParams(payload).toString()

  if (direct !== query) {
    failures.push({
      route: routeKey,
      label: `${label} / ${direction}`,
      detail: `buildQueryUrl and toSearchParams disagree:\n      buildQueryUrl → ${query}\n      toSearchParams → ${direct}`,
    })

    return
  }

  const bag = fromSearchParams(query, entry.input)
  const result = entry.input.safeParse(bag)

  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) =>
          `${issue.path.join('.') || '<root>'}: ${issue.message} (received ${show(bag[String(issue.path[0] ?? '')])})`
      )
      .join('\n        ')

    failures.push({
      route: routeKey,
      label: `${label} / ${direction}`,
      detail: `re-parse rejected the contract's own query string\n      ?${query}\n      issues:\n        ${issues}`,
    })

    return
  }

  if (!deepEqual(result.data, expected)) {
    failures.push({
      route: routeKey,
      label: `${label} / ${direction}`,
      detail: `values did not survive; differing keys: ${differingKeys(expected, result.data).join(', ')}\n      body  → ${show(expected)}\n      query → ${show(result.data)}`,
    })
  }
}

function checkRoute(routeKey: ApiRouteKey): void {
  const entry: AnyApiRoute = ApiContract[routeKey]
  const cases = CASES[routeKey]
  const buildUrlFor: UrlBuilder | undefined = URL_BUILDERS[routeKey]

  if (cases === undefined || cases.length === 0 || buildUrlFor === undefined) {
    failures.push({
      route: routeKey,
      label: '<no fixture>',
      detail:
        'GET route has no representative input in CASES or no entry in URL_BUILDERS. Every GET entry must be covered — add one.',
    })

    return
  }

  const arrayKeys = [...queryArrayKeys(entry.input)].sort()
  console.log(
    `\n  ${routeKey}  (${cases.length} case${cases.length === 1 ? '' : 's'}, array keys: ${arrayKeys.length > 0 ? arrayKeys.join(', ') : 'none'})`
  )

  for (const testCase of cases) {
    casesRun += 1

    const canonical = entry.input.safeParse(testCase.input)

    if (!canonical.success) {
      failures.push({
        route: routeKey,
        label: testCase.label,
        detail: `the representative input is not valid for this schema:\n        ${canonical.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('\n        ')}`,
      })

      continue
    }

    const expected = canonical.data

    // Direction 1: the parsed form, as `toSearchParams` documents.
    checkDirection(
      routeKey,
      entry,
      buildUrlFor,
      testCase.label,
      'parsed',
      expected as Readonly<Record<string, unknown>>,
      expected
    )

    // Direction 2: the raw form a screen actually holds.
    checkDirection(
      routeKey,
      entry,
      buildUrlFor,
      testCase.label,
      'raw',
      testCase.input,
      expected
    )

    console.log(`      · ${testCase.label}`)
  }
}

// =============================================================================
// Run
// =============================================================================

const getRoutes = API_ROUTE_KEYS.filter(
  (key) => ApiContract[key].method === 'GET'
)

console.log('GET round trip: input → toSearchParams → fromSearchParams → input')
console.log(
  `${API_ROUTE_KEYS.length} contract entries, ${getRoutes.length} of them GET`
)

for (const routeKey of getRoutes) {
  checkRoute(routeKey)
}

console.log(
  `\n${'-'.repeat(72)}\nroutes: ${getRoutes.length}   cases: ${casesRun}   assertions: ${assertions}   failures: ${failures.length}`
)

if (failures.length > 0) {
  console.error('\nFAILURES\n')

  for (const failure of failures) {
    console.error(
      `  ✗ ${failure.route} [${failure.label}]\n      ${failure.detail}\n`
    )
  }

  process.exit(1)
}

console.log('\nPASS — every GET route round-trips through its own serialiser.')
