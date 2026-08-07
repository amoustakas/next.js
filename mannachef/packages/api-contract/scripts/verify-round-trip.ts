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
 * ## The second half: the malformed path
 *
 * Everything above feeds the contract **valid** inputs. That is a real
 * guarantee and it is only half of one, because a public endpoint is reached by
 * strangers and most of what a stranger sends is not valid. The hole this left
 * was not theoretical:
 *
 * ```text
 *   GET /api/availability?startsFrom=foo&startsUntil=bar
 *   → TypeError: value.startsUntil.getTime is not a function
 *   → HTTP 500, unauthenticated, on a PUBLIC route
 * ```
 *
 * Every fixture in `CASES` is a payload we would be happy to accept, so no
 * arrangement of them could ever have caught that. The second section therefore
 * drives each GET entry down the path a route handler actually takes when the
 * query string is hostile —
 *
 * ```ts
 * entry.input.safeParse(fromSearchParams(malformedQueryString, entry.input))
 * ```
 *
 * — and asserts the two things that separate a 400 from a 500: nothing throws,
 * and the result is a clean `{ success: false }` carrying issues.
 *
 * The auditor's literal repro is included by name, and every GET route is swept
 * with generated hostile query strings: every key at once, each key alone, and
 * every unordered pair of keys. The pair sweep is exhaustive rather than aimed
 * at the declared cross-field rules for the reason set out at the head of
 * `packages/validators/scripts/fuzz-schemas.ts` — a harness aimed by the
 * mechanism under test cannot see that mechanism being removed.
 *
 * This file covers the transport. `pnpm --filter=@mannachef/validators
 * verify:fuzz` covers the same invariant across every schema in the package,
 * including the ones no route reaches.
 *
 * Run: `pnpm --filter=@mannachef/api-contract verify:round-trip`
 */

import { crossFieldDependencyKeys } from '@mannachef/validators'

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
// The malformed path
//
// What a route handler does with a query string it did not expect. Reflection
// over the input schema is done locally and defensively — zod publishes no
// stable visitor, and a harness that throws while looking for things that throw
// would be a poor joke.
// =============================================================================

/** The subset of a zod definition node this section reads. */
interface MalformedDefNode {
  readonly type: string
  readonly shape?: Readonly<Record<string, unknown>>
  readonly catchall?: unknown
  readonly checks?: readonly unknown[]
}

/** The definition node behind a schema, or `undefined` for anything else. */
function defNodeOf(value: unknown): MalformedDefNode | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const internals = (value as { readonly _zod?: unknown })._zod

  if (typeof internals !== 'object' || internals === null) {
    return undefined
  }

  const def = (internals as { readonly def?: unknown }).def

  if (typeof def !== 'object' || def === null) {
    return undefined
  }

  const { type } = def as { readonly type?: unknown }

  return typeof type === 'string' ? (def as MalformedDefNode) : undefined
}

/** A field schema, reduced to the one method this section calls on it. */
interface FieldSchema {
  safeParse(input: unknown): { readonly success: boolean }
}

/** True for a value that can be parsed with. */
function isFieldSchema(value: unknown): value is FieldSchema {
  if (defNodeOf(value) === undefined) {
    return false
  }

  return (
    typeof (value as { readonly safeParse?: unknown }).safeParse === 'function'
  )
}

/**
 * Values a query string can actually deliver — all strings, because that is all
 * a URL carries. `'foo'` leads because it is the auditor's own value.
 */
const HOSTILE_QUERY_VALUES: readonly string[] = [
  'foo',
  'bar',
  '§ not-a-valid-value §',
  '-1e999',
  '99999999999999999999',
  'x'.repeat(2_048),
]

/**
 * Raw query strings that are malformed as *transport* rather than as values:
 * bad percent-encoding, empty pairs, a repeated scalar, and the two keys that
 * reach for `Object.prototype`.
 *
 * None of these carries an asserted rejection. A filter schema is entitled to
 * read `?page=&pageSize=` as "no filter" and succeed — that is what
 * `withNumericCoercion` is for. The claim being made about them is the
 * unconditional one: `fromSearchParams` and `safeParse` both return.
 */
const MALFORMED_TRANSPORT: readonly (readonly [
  label: string,
  query: string,
])[] = [
  ['empty', ''],
  ['separators only', '&&&'],
  ['bare equals', '='],
  ['leading question mark', '?page=1'],
  ['bare key, no equals', 'page'],
  ['empty values', 'page=&pageSize=&search='],
  ['invalid percent-encoding', '%zz=%E0%A4%A&%=%'],
  ['repeated scalar key', 'page=1&page=2&page=3'],
  ['prototype key', '__proto__=foo'],
  ['prototype key, repeated', '__proto__=foo&__proto__=bar'],
  ['constructor key', 'constructor=foo&toString=bar'],
  ['bracket notation', 'a[]=1&a[]=2&a[0][b]=3'],
  ['very long value', `search=${'y'.repeat(8_192)}`],
  ['newline injection', 'search=a%0D%0AX-Injected:%20yes'],
  ['nul byte', 'search=a%00b'],
]

/**
 * The routes the audit found answering a two-character query string with an
 * HTTP 500.
 *
 * Every one of them carries a cross-field rule over a pair of `Date` fields,
 * which is the crash: comparing two `Date`s means calling `.getTime()`, and an
 * object-level refinement in zod 4 still runs after a `ZodPipe` field has
 * failed, so it was handed the raw string. The routes whose cross-field rules
 * compare *numbers* — `menu.list` and `staff.directory` — were never in this
 * list, because `'foo' > 'bar'` merely evaluates to `false`. They are swept
 * anyway; every GET entry in the contract is.
 *
 * The list is asserted against the contract below, and each entry is required
 * to have taken at least one malformed case whose rejection was asserted. A
 * route dropping off the contract, or losing the field pair the case names, is
 * a failure here rather than a silently narrower sweep.
 */
const PREVIOUSLY_500ING: readonly ApiRouteKey[] = [
  'availability.query',
  'appointment.list',
  'invoice.list',
  'payment.history',
  'onboarding.read',
  'referral.read',
  'subscription.read',
]

/**
 * The auditor's repro, verbatim.
 *
 * Named rather than generated so it survives any future change to the hostile
 * ladder, and so a failure quotes the string from the ticket. It is driven at
 * *every* GET route: on the two that declare `startsFrom`/`startsUntil` it is
 * the original crash, and on the rest it is a pair of keys the schema does not
 * know, which must still be answered rather than thrown at.
 */
const AUDITOR_REPRO = 'startsFrom=foo&startsUntil=bar'

let malformedCases = 0
let malformedThrows = 0
let malformedRejectionsAsserted = 0

/** Which routes took at least one malformed case with an asserted rejection. */
const provenRejecting = new Set<ApiRouteKey>()

/** Truncates a query string for a report line. */
function showQuery(query: string): string {
  return query.length > 160 ? `${query.slice(0, 160)}…` : query
}

/**
 * One malformed request, driven exactly as a route handler drives it.
 *
 * `mustReject` is asserted only where the schema's own field schema is known to
 * refuse the value — see the falsifiability note in
 * `packages/validators/scripts/fuzz-schemas.ts`. A filter that legitimately
 * accepts a string is not a bug, and asserting otherwise would make a green run
 * meaningless.
 */
function driveMalformed(
  routeKey: ApiRouteKey,
  entry: AnyApiRoute,
  label: string,
  query: string,
  mustReject: boolean
): void {
  malformedCases += 1

  let bag: Record<string, string | readonly string[]>

  try {
    bag = fromSearchParams(query, entry.input)
  } catch (error) {
    malformedThrows += 1
    failures.push({
      route: routeKey,
      label: `malformed / ${label}`,
      detail: `fromSearchParams threw on ?${showQuery(query)}\n      ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    })

    return
  }

  let result: ReturnType<AnyApiRoute['input']['safeParse']>

  try {
    result = entry.input.safeParse(bag)
  } catch (error) {
    malformedThrows += 1
    failures.push({
      route: routeKey,
      label: `malformed / ${label}`,
      detail: `safeParse THREW on ?${showQuery(query)} — this is the HTTP 500.\n      A route handler has no way to turn this into a 400; the throw escapes before it can.\n      ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    })

    return
  }

  if (!result.success && result.error.issues.length === 0) {
    failures.push({
      route: routeKey,
      label: `malformed / ${label}`,
      detail: `safeParse failed with no issues on ?${showQuery(query)} — a handler has nothing to put in fieldErrors.`,
    })

    return
  }

  if (!mustReject) {
    return
  }

  malformedRejectionsAsserted += 1
  provenRejecting.add(routeKey)

  if (result.success) {
    failures.push({
      route: routeKey,
      label: `malformed / ${label}`,
      detail: `safeParse ACCEPTED ?${showQuery(query)}, every named key of which its own field schema rejects.\n      parsed → ${show(result.data)}`,
    })
  }
}

/**
 * A query-string value the field's own schema refuses, when one exists.
 *
 * `isArrayKey` is not a detail. `fromSearchParams` reads a key listed by
 * `queryArrayKeys` as a list even when it appears once, so `?tagSlugs=foo`
 * reaches the schema as `['foo']` — which `z.array(slugSchema)` is perfectly
 * happy with. Probing such a field with the bare string `'foo'` gets a
 * rejection for the wrong reason (an array schema refusing a string) and makes
 * the harness assert that the *route* must reject a query string it should
 * accept. The first draft did exactly that and reported four phantom failures
 * against `menu.list` and `staff.directory`.
 *
 * The probe therefore models the transport: it asks the field the same question
 * `fromSearchParams` will hand it.
 */
function hostileValueFor(
  field: unknown,
  isArrayKey: boolean
): string | undefined {
  if (!isFieldSchema(field)) {
    return undefined
  }

  for (const candidate of HOSTILE_QUERY_VALUES) {
    const asDelivered: unknown = isArrayKey ? [candidate] : candidate
    let rejected: boolean

    try {
      rejected = !field.safeParse(asDelivered).success
    } catch {
      // A field schema that throws on a bare string is itself the defect, and
      // the whole-route cases below will surface it with a stack. Treat the
      // candidate as unusable here rather than reporting it twice.
      continue
    }

    if (rejected) {
      return candidate
    }
  }

  return undefined
}

/** `key=value`, encoded the way a browser encodes it. */
function pair(key: string, value: string): string {
  const search = new URLSearchParams()

  search.append(key, value)

  return search.toString()
}

/** Every unordered pair of the given keys, each pair listed once. */
function keyPairs(
  keys: readonly string[]
): readonly (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = []

  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const left = keys[i]
      const right = keys[j]

      if (left !== undefined && right !== undefined) {
        pairs.push([left, right])
      }
    }
  }

  return pairs
}

/** The field pairs a `crossField` check on this schema declares it reads. */
function declaredPairsFor(entry: AnyApiRoute): readonly string[] {
  const def = defNodeOf(entry.input)
  const labels: string[] = []

  for (const check of def?.checks ?? []) {
    const deps = crossFieldDependencyKeys(check)

    if (deps !== undefined && deps.length > 1) {
      labels.push(deps.join('+'))
    }
  }

  return labels
}

/** The whole malformed sweep for one GET route. */
function checkMalformedRoute(routeKey: ApiRouteKey): void {
  const entry: AnyApiRoute = ApiContract[routeKey]
  const shape = defNodeOf(entry.input)?.shape ?? {}
  const keys = Object.keys(shape)

  // The contract's own answer to "which keys arrive as lists", so the probes
  // below ask each field the question `fromSearchParams` will actually ask it.
  const arrayKeys = queryArrayKeys(entry.input)

  // --- the named regression, on every route --------------------------------

  const reproKeys = ['startsFrom', 'startsUntil'].filter((key) => key in shape)

  driveMalformed(
    routeKey,
    entry,
    `AUDITOR REPRO ?${AUDITOR_REPRO}`,
    AUDITOR_REPRO,
    reproKeys.length > 0 &&
      reproKeys.every(
        (key) => hostileValueFor(shape[key], arrayKeys.has(key)) !== undefined
      )
  )

  // --- transport-level junk ------------------------------------------------

  for (const [label, query] of MALFORMED_TRANSPORT) {
    driveMalformed(routeKey, entry, label, query, false)
  }

  // --- one hostile value per key, chosen by probing the field itself -------

  const hostile = new Map<string, string>()

  for (const key of keys) {
    const value = hostileValueFor(shape[key], arrayKeys.has(key))

    if (value !== undefined) {
      hostile.set(key, value)
    }
  }

  // Keys the field schema accepts anything for still get sent — the no-throw
  // claim is unconditional — they just carry no rejection assertion.
  const everyKey = keys
    .map((key) => pair(key, hostile.get(key) ?? 'foo'))
    .join('&')

  if (everyKey.length > 0) {
    driveMalformed(
      routeKey,
      entry,
      'every key hostile',
      everyKey,
      hostile.size > 0
    )
  }

  for (const key of keys) {
    const value = hostile.get(key)

    driveMalformed(
      routeKey,
      entry,
      `one key hostile: ${key}`,
      pair(key, value ?? 'foo'),
      value !== undefined
    )
  }

  // --- every unordered pair of keys ----------------------------------------

  for (const [left, right] of keyPairs(keys)) {
    const leftValue = hostile.get(left)
    const rightValue = hostile.get(right)

    driveMalformed(
      routeKey,
      entry,
      `hostile pair: ${left}+${right}`,
      `${pair(left, leftValue ?? 'foo')}&${pair(right, rightValue ?? 'bar')}`,
      leftValue !== undefined && rightValue !== undefined
    )

    // The auditor's literal spelling on top of the ladder's choice, so the
    // shape of the reported repro does not depend on which rung was picked.
    driveMalformed(
      routeKey,
      entry,
      `hostile pair, literal: ${left}=foo&${right}=bar`,
      `${pair(left, 'foo')}&${pair(right, 'bar')}`,
      false
    )
  }

  const declared = declaredPairsFor(entry)

  console.log(
    `\n  ${routeKey}  (${String(keys.length)} keys, ${String(keyPairs(keys).length)} pairs, declared cross-field: ${declared.length > 0 ? declared.join(', ') : 'none'})`
  )
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
  `\n${'-'.repeat(72)}\nround trip — routes: ${getRoutes.length}   cases: ${casesRun}   assertions: ${assertions}`
)

// --- the malformed half ------------------------------------------------------

console.log(
  '\nMalformed GET: fromSearchParams(hostile query, entry.input) → entry.input.safeParse'
)
console.log(
  `${getRoutes.length} GET routes, ${PREVIOUSLY_500ING.length} of them named in the MCV-011 audit as answering a two-character query string with a 500`
)

for (const routeKey of getRoutes) {
  checkMalformedRoute(routeKey)
}

// Every route the audit named must still be a GET entry in the contract, and
// must have taken at least one malformed case whose rejection was asserted.
// Without this, a route losing the field pair its repro names would quietly
// reduce to a no-throw check and the regression would have somewhere to hide.
for (const routeKey of PREVIOUSLY_500ING) {
  if (ApiContract[routeKey].method !== 'GET') {
    failures.push({
      route: routeKey,
      label: 'coverage',
      detail:
        'listed in PREVIOUSLY_500ING but is no longer a GET route. Either the audit list is stale or the route moved; decide which, do not delete the line.',
    })

    continue
  }

  if (!provenRejecting.has(routeKey)) {
    failures.push({
      route: routeKey,
      label: 'coverage',
      detail:
        'took no malformed case with an asserted rejection. Every field of its filter now accepts every hostile value the ladder offers, which means this route is being swept but not actually checked.',
    })
  }
}

console.log(
  `\n${'-'.repeat(72)}\nmalformed — routes: ${getRoutes.length}   cases: ${malformedCases}   rejections asserted: ${malformedRejectionsAsserted}   throws: ${malformedThrows}`
)
console.log(
  `audit routes proven to reject: ${PREVIOUSLY_500ING.filter((key) => provenRejecting.has(key)).length}/${PREVIOUSLY_500ING.length}`
)
console.log(
  `\ntotal cases: ${casesRun + malformedCases}   failures: ${failures.length}`
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

console.log(
  '\nPASS — every GET route round-trips through its own serialiser, and answers a hostile query string with a clean { success: false }.'
)
