# mannachef/packages/api-contract/README.md

# @mannachef/api-contract

A transport-agnostic description of every endpoint a _client_ consumes, shared
unchanged by the Next.js app and the future Expo client. Data plus zod schemas —
nothing here imports React, Next.js, Prisma, or `fetch`.

The contract itself, the `infer*` helpers, and the URL construction and
query-string helpers are documented at the head of `src/index.ts`.

## Scripts

| Script                   | What it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `pnpm typecheck`         | `tsc --noEmit` over `src/` and `scripts/`                   |
| `pnpm verify:round-trip` | GET transport: the lossless half **and** the malformed half |
| `pnpm verify:responses`  | Response-schema checks                                      |
| `pnpm verify`            | Both of the above, in order                                 |

All three exit non-zero on failure. The verification scripts import
`../src/index.ts` by its real path and run under
`node --experimental-strip-types`, so they can never be checking a stale
`dist/`.

---

## `scripts/verify-round-trip.ts`

Two halves, run in one pass.

### Half one — the lossless path

Every `GET` entry is exercised end to end with the contract's _own_ serialiser
and its _own_ input schema:

```text
representative input
  → entry.input.parse          (what a JSON body would produce)
  → toSearchParams / buildQueryUrl
  → fromSearchParams
  → entry.input.parse          (what the query string produces)
  → deep-equal the two
```

Both directions are checked per case — the **parsed** shape, where defaults are
filled and dates are `Date` instances, and the **raw** shape a screen actually
holds. A route passes only when both parse _and_ land on exactly the value a
JSON body would have produced. Parsing successfully is not enough: a filter that
silently loses `tagSlugs` on the way through would still be a 200, and would
still show the guest the wrong dishes.

Each GET route needs an entry in `CASES` and in `URL_BUILDERS`; a route with
neither is a failure, so adding an endpoint forces the question.

### Half two — the malformed path

Half one feeds the contract nothing but **valid** inputs. That is a real
guarantee and it is exactly half of one, because a public endpoint is reached by
strangers and most of what a stranger sends is not valid. The hole was not
theoretical:

```text
GET /api/availability?startsFrom=foo&startsUntil=bar
  → TypeError: value.startsUntil.getTime is not a function
  → HTTP 500, unauthenticated, on a PUBLIC route
```

No arrangement of the `CASES` fixtures could ever have caught that. So each GET
entry is now also driven down the path a route handler actually takes:

```ts
entry.input.safeParse(fromSearchParams(malformedQueryString, entry.input))
```

and asserted on the two things that separate a 400 from a 500:

1. **Nothing throws** — neither `fromSearchParams` nor `safeParse`. A throw
   escapes before a handler can turn it into a 400, so a throw is reported as
   "this is the HTTP 500" with the query string and the stack.
2. **A failure is clean** — `{ success: false }` carrying at least one issue, so
   a handler has something to put in `fieldErrors`.

#### What each route is swept with

- **The auditor's repro, by name:** `?startsFrom=foo&startsUntil=bar`, driven at
  _every_ GET route. On the two that declare those keys it is the original
  crash; on the rest it is a pair of keys the schema does not know, which must
  still be answered rather than thrown at.
- **Every key hostile at once**, and **each key hostile alone**.
- **Every unordered pair of keys.** Exhaustive rather than aimed at the declared
  cross-field rules, for the reason set out in
  `packages/validators/README.md` — a harness aimed by the mechanism under test
  cannot see that mechanism being removed. Declared pairs additionally get the
  literal `foo`/`bar` spelling.
- **Transport-level junk**, where the query string is malformed as _transport_
  rather than as values: bad percent-encoding (`%zz=%E0%A4%A`), separators only
  (`&&&`), a bare key, empty values, a repeated scalar key, `__proto__=` and
  `constructor=`, bracket notation, an 8 KiB value, CRLF and NUL injection.
  These carry no rejection assertion — a filter is entitled to read `?page=` as
  "no filter" and succeed. The claim about them is the unconditional one.

#### The eight routes from the audit

`PREVIOUSLY_500ING` names the routes the audit found answering a two-character
query string with a 500:

```
availability.query   appointment.list   invoice.list   payment.history
onboarding.read      referral.read      subscription.read
```

Every one of them carries a cross-field rule over a pair of `Date` fields, and
that is the crash: comparing two `Date`s means calling `.getTime()`. The two GET
routes whose cross-field rules compare _numbers_ — `menu.list`
(`priceCentsMin`/`priceCentsMax`) and `staff.directory`
(`minHourlyRateCents`/`maxHourlyRateCents`) — were never in that class, because
`'foo' > 'bar'` merely evaluates to `false`. They are swept anyway; **all 11 GET
entries in the contract are**, so the covered set is a strict superset of the
audit list either way.

The list is not decoration. After the sweep, each named route is asserted to
still be a `GET` entry in the contract _and_ to have taken at least one
malformed case whose rejection was asserted. A route that loses the field pair
its repro names would otherwise quietly reduce to a no-throw check, and the
regression would have somewhere to hide.

#### Falsifiability, and modelling the transport

As in the validators fuzzer, a rejection is asserted only where the schema's own
field schema is known to refuse the value — probed, not assumed. A filter that
legitimately accepts a string is not a bug.

The probe must ask the field the same question `fromSearchParams` will ask it.
`fromSearchParams` reads a key listed by `queryArrayKeys` as a list even when it
appears once, so `?tagSlugs=foo` reaches the schema as `['foo']`, which
`z.array(slugSchema)` accepts. The first draft probed such fields with the bare
string and reported four phantom failures against `menu.list` and
`staff.directory`. `hostileValueFor` now takes `isArrayKey` and probes with
`[candidate]` accordingly.

### Reading the output

```text
round trip — routes: 11   cases: 29   assertions: 58
malformed  — routes: 11   cases: 2053   rejections asserted: 1009   throws: 0
audit routes proven to reject: 7/7
total cases: 2082   failures: 0
```

`audit routes proven to reject` dropping below `7/7` is the coverage guard
firing: the sweep is still running but has stopped actually checking something.

### Mutation-tested

Reverting `bookingSlotFilterSchema`'s `.check(crossField(…))` to the plain
two-field `.refine(…)` it used to be fails this script by name:

```text
✗ availability.query [malformed / AUDITOR REPRO ?startsFrom=foo&startsUntil=bar]
    safeParse THREW on ?startsFrom=foo&startsUntil=bar — this is the HTTP 500.
    TypeError: value.startsUntil.getTime is not a function
```

## Companion

This file covers the transport. `pnpm --filter=@mannachef/validators verify:fuzz`
covers the same no-throw invariant across every schema in the validators
package, including the ones no route reaches. Run both.
