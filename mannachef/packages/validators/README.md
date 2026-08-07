# mannachef/packages/validators/README.md

# @mannachef/validators

Every Zod v4 schema in the platform. No Prisma dependency, no React, no
`fetch` — the package is plain data plus schemas, so it runs identically in a
React Server Component, a route handler, a React Native bundle, and a test.

Import from the barrel, never from a domain module:

```ts
import {
  menuItemFilterSchema,
  type MenuItemFilterInput,
} from '@mannachef/validators'
```

The barrel's collision policy, the `MAX_REFERRAL_CODE_LENGTH` split, and the
compile-time guards that keep both halves honest are documented at the head of
`src/index.ts`.

## Scripts

| Script             | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `pnpm typecheck`   | `tsc --noEmit` over `src/` and `scripts/`                 |
| `pnpm verify:fuzz` | Hostile-input fuzz over every exported schema (see below) |
| `pnpm verify`      | Currently an alias for `verify:fuzz`                      |

---

## `scripts/fuzz-schemas.ts` — the hostile-input harness

```bash
pnpm --filter=@mannachef/validators verify:fuzz
```

Exits non-zero on any failure. Runs in a couple of seconds; there is no reason
not to run it before every commit that touches a schema.

### Why it exists

`packages/api-contract/scripts/verify-round-trip.ts` proves a _valid_ input
survives the GET transport. It could never say anything about an invalid one,
because every fixture in it is a payload we would be happy to accept. That left
the entire reject path unexercised, and the reject path is where the interesting
failure lived:

```text
GET /api/availability?startsFrom=foo&startsUntil=bar
  → TypeError: value.startsUntil.getTime is not a function
  → HTTP 500, unauthenticated, on a PUBLIC route
```

In zod 4 an object-level `.refine()` runs against the **raw** value and still
runs after a nested field has failed, when that field is a `ZodPipe` — which is
what every `.transform(...).refine(...)` chain produces, `isoDateTimeSchema`
included. The refinement was handed two strings and called `.getTime()` on one.
`crossField` / `crossFieldMixed` in `src/common.ts` fixed the mechanism. This
script is what stops it coming back, and what catches the next one in a schema
nobody thought to write a test for.

### What it asserts

1. **`safeParse` never throws.** For any schema, for any input, ever. A throw
   out of `safeParse` is an HTTP 500; a `{ success: false }` is an HTTP 400. A
   failure reports the schema name, the payload, and the stack.
2. **Hostile input is rejected, not accepted.** A schema answering
   `{ success: true }` to a bag of garbage means the handler behind it is about
   to write that garbage to Postgres.

### How the schemas are found

Nothing is hand-listed. The barrel is imported as a namespace and every export
carrying `_zod.def.type` and a `safeParse` method is a target. Exported
_collections_ — `intakeStepSchemas`, the `…WritableShape` records — are walked
one level. Unions are walked into each branch and each branch is fuzzed as an
object in its own right, since that is where the shape and the checks live;
`referralCodeCreateSchema`'s four reward branches are four separate targets.

Adding a schema to any domain module therefore adds it to this sweep with no
edit here.

### The payloads, per object schema

- `all-fields-hostile` — every key at once.
- `one-field-hostile:<key>` — each key alone, so a failure names the field.
- `hostile-pair:<a>+<b>` — **every** unordered pair of fields.
- `cross-field-repro:<a>=foo+<b>=bar` — the auditor's literal values, on every
  pair some `crossField` check declares.
- `undefined`, `null`, `[]`, `0`, `''` — asserted to be rejected by any bare
  object schema.
- `unexpected-extra-keys` — including `'__proto__'` and `'constructor'` written
  as computed (therefore ordinary own) properties, the way `JSON.parse`
  produces them.

Every schema, object or not, additionally takes the full scalar corpus:
`NaN`, `Infinity`, `-0`, `bigint`, `symbol`, a function, an invalid `Date`, a
null-prototype bag, a 4 KiB string, nested junk.

### Falsifiability — why "hostile" is measured, not assumed

"A string that is not a valid value for any type" does not exist for a field
that accepts free text: `search: z.string().max(120)` is perfectly happy with
`'§ not-a-valid-value §'`, and asserting a rejection there would be asserting a
bug. So the harness **probes each field's own schema** with a ladder of hostile
candidates and keeps the first one the field itself rejects. A field that
rejects nothing is marked permissive: its payloads still run — the no-throw
invariant is unconditional — but the rejection assertion is dropped for them.

`mustReject` is therefore a provable lower bound. A case that passes when it was
not required to is never reported as a failure, which is what makes a green run
mean something.

### Why the pair sweep is exhaustive

`src/common.ts` records each `crossField` check's dependency list as the check
is built, readable through the exported `crossFieldDependencyKeys(check)`. The
first draft of this harness generated hostile pairs _only_ from that registry.

It was mutation-tested by putting the original defect back —
`bookingSlotFilterSchema`'s `.check(crossField({ deps: ['startsFrom',
'startsUntil'], … }))` rewritten as the plain two-field `.refine(…)` it used to
be, which is exactly the regression the file exists to catch.

**It passed.** Reverting to `.refine()` takes the check out of the registry, so
the harness stopped generating the one pair that would have crashed it: the
reported pair count fell from 103 to 102 and nothing else moved. A harness whose
aim is supplied by the mechanism under test is blind in precisely the direction
it is pointed.

The pairs are now the complete set, derived from the _shape_, which no refactor
of a refinement can take away. The registry survives only to label the declared
ones in the summary and to add the literal `foo`/`bar` payload. With that
change the same mutation fails the run:

```text
✗ bookingSlotFilterSchema [hostile-pair:startsFrom+startsUntil]
    kind: threw
    payload: {"startsFrom":"foo","startsUntil":"foo"}
    TypeError: value.startsUntil.getTime is not a function
```

The cost is quadratic in the field count and entirely affordable: ~1,200 fields
across ~140 object schemas, ~6,400 pairs, a few seconds end to end.

### Reading the output

The summary line names the four numbers worth watching:

```text
schemas: 298   object schemas: 138   fields: 1161   field pairs: 6375 (103 declared cross-field)
cases: 18302   rejection assertions: 8456   throws: 0   failures: 0
```

`cases` counts every `safeParse` the run performed, including the small probes
that choose each field's hostile value — those go through the same recorder, so
the no-throw claim covers them too rather than there being a second, unwatched
call site.

A drop in `schemas` or `rejection assertions` after an unrelated change is worth
looking at: it usually means a schema stopped being exported, or a field started
accepting values it used to refuse.

### When it fails

**Fix the schema, not the harness.** The two exceptions, both of which are
harness bugs rather than schema bugs and both of which have already been made
once:

- A rejection asserted on a value the field is entitled to accept. That is the
  falsifiability rule being violated — the probe is wrong, not the schema.
- A probe that does not model the transport. The api-contract half of this work
  reported four phantom failures against `menu.list` and `staff.directory` by
  probing array-typed keys with a bare string, when `fromSearchParams` delivers
  `['foo']`. Both are documented in place.
