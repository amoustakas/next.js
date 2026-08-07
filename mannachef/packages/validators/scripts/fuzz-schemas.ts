// mannachef/packages/validators/scripts/fuzz-schemas.ts

/**
 * A permanent hostile-input harness for `@mannachef/validators`.
 *
 * ## Why this exists
 *
 * `packages/api-contract/scripts/verify-round-trip.ts` proves that a *valid*
 * input survives the GET transport. It cannot, by construction, say anything
 * about an invalid one — every fixture in it is a payload we would be happy to
 * accept. That left the whole of the reject path unexercised, and the reject
 * path is where the interesting failure lives:
 *
 * ```text
 *   GET /api/availability?startsFrom=foo&startsUntil=bar
 *   → TypeError: value.startsUntil.getTime is not a function
 *   → HTTP 500, unauthenticated, on a PUBLIC route
 * ```
 *
 * An object-level refinement that dereferences two fields runs, in zod 4,
 * *after* those fields have failed their own parse, because a `ZodPipe` field
 * records its issue with `continue: true` and does not abort the parent. The
 * refinement then receives the raw strings. A two-character query string is
 * enough to turn a public endpoint into a 500, and nothing in the test suite
 * was looking.
 *
 * `crossField` / `crossFieldMixed` in `src/common.ts` fixed the mechanism. This
 * file is what stops it coming back, and stops the *next* one arriving in a
 * schema nobody thought to write a test for.
 *
 * ## What it asserts
 *
 * 1. **`safeParse` never throws.** For any schema, for any input, ever. This is
 *    the invariant that actually matters, because a throw out of `safeParse` is
 *    a 500 and a `{ success: false }` is a 400. Every parse this file performs
 *    — including the small probes it runs to *choose* its hostile values — goes
 *    through one recorder, and a throw is reported with the schema name, the
 *    payload, and the stack.
 * 2. **Hostile input is rejected, not accepted.** A schema that answers
 *    `{ success: true }` to a bag of garbage is its own bug: it means the
 *    handler behind it is about to write that garbage to Postgres. The
 *    assertion is only made where it is provably correct — see "Falsifiability"
 *    below — so a clean run means something.
 *
 * ## How the schemas are found
 *
 * Nothing is hand-listed. The barrel is imported as a namespace and every
 * export is examined: a value carrying `_zod.def.type` and a `safeParse` method
 * is a schema. Exported *collections* of schemas — `intakeStepSchemas`, the
 * `…WritableShape` records — are walked one level, because a schema reachable
 * from the public surface is a schema an action can parse with.
 *
 * Discriminated unions are walked into each branch and each branch is fuzzed as
 * an object in its own right, since that is where the shape (and the cross-field
 * checks) actually live. `referralCodeCreateSchema`'s four reward branches are
 * four separate targets.
 *
 * ## Falsifiability
 *
 * "A string that is not a valid value for any type" does not exist for a field
 * that accepts free text: `search: z.string().max(120)` is perfectly happy with
 * `'§ not-a-valid-value §'`, and asserting a rejection there would be asserting
 * a bug. So the harness *probes* each field's own schema with a ladder of
 * hostile candidates and keeps the first one the field itself rejects. A field
 * that rejects nothing is marked permissive: its payloads still run — the
 * no-throw invariant is unconditional — but the rejection assertion is dropped
 * for them. `mustReject` is therefore a provable lower bound rather than a
 * guess, and a case that passes when it was not required to is never a failure.
 *
 * ## The payloads, per object schema
 *
 *  - `all-fields-hostile` — every key at once.
 *  - `one-field-hostile:<key>` — each key alone, so a failure names the field.
 *  - `hostile-pair:<a>+<b>` — **every** unordered pair of fields. Exhaustive
 *    rather than aimed at the pairs the cross-field checks declare, for the
 *    reason set out on {@link allFieldPairs}: aiming the harness with the
 *    mechanism under test made it blind to that mechanism being removed, which
 *    a mutation test caught. This is the `startsFrom=foo&startsUntil=bar`
 *    family, generated from the shape rather than remembered.
 *  - `cross-field-repro:<a>=foo+<b>=bar` — the auditor's literal values, on
 *    every pair some `crossField` check declares.
 *  - `undefined`, `null`, `[]`, `0`, `''` — the five non-objects a handler can
 *    be handed when a body fails to parse or a caller sends the wrong thing.
 *  - `unexpected-extra-keys` — including `'__proto__'` and `'constructor'` as
 *    computed (therefore ordinary own) properties.
 *
 * Every schema, object or not, additionally takes the whole scalar corpus.
 *
 * Run: `pnpm --filter=@mannachef/validators verify:fuzz`
 */

import * as Barrel from '../src/index.ts'

// =============================================================================
// 1. Reflection over zod's internals
//
// Zod publishes no stable visitor, so the definition nodes are walked by hand.
// Every member read below is optional and every read is guarded, so a node
// shape this does not recognise degrades to "not an object schema" rather than
// throwing — which would be a fine irony in a harness whose whole subject is
// things that throw.
// =============================================================================

/** A bag of unknowns, which is all a reflected shape can honestly be. */
type UnknownRecord = Readonly<Record<string, unknown>>

/** The subset of a zod definition node this file reads. */
interface ZodDefNode {
  readonly type: string
  /** Present on `ZodObject`. */
  readonly shape?: UnknownRecord
  /** `ZodNever` when the object is `.strict()`; absent when it strips. */
  readonly catchall?: unknown
  /** `ZodOptional`, `ZodDefault`, `ZodNullable`, `ZodReadonly`, … */
  readonly innerType?: unknown
  /** `ZodPipe`. */
  readonly in?: unknown
  readonly out?: unknown
  /** `ZodUnion` and `ZodDiscriminatedUnion`. */
  readonly options?: readonly unknown[]
  /** `ZodDiscriminatedUnion` only. */
  readonly discriminator?: string
  /** `z.literal(...)`, whose sole value names a union branch. */
  readonly values?: readonly unknown[]
  /** Everything attached with `.check()`, `.refine()`, or `.superRefine()`. */
  readonly checks?: readonly unknown[]
}

/** The minimum surface this file calls on a schema. */
interface ParseableSchema {
  safeParse(input: unknown): { readonly success: boolean }
}

/** Nothing in this package nests wrappers anywhere near this deep. */
const MAX_WRAPPER_DEPTH = 8

/** The definition node behind a value, or `undefined` for a non-schema. */
function defNodeOf(value: unknown): ZodDefNode | undefined {
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

  return typeof type === 'string' ? (def as ZodDefNode) : undefined
}

/** True for anything that is a zod schema and can therefore be parsed with. */
function isSchema(value: unknown): value is ParseableSchema {
  if (defNodeOf(value) === undefined) {
    return false
  }

  const candidate = value as { readonly safeParse?: unknown }

  return typeof candidate.safeParse === 'function'
}

/** The object a schema ultimately presents, once its wrappers are peeled. */
interface ObjectFace {
  readonly shape: UnknownRecord
  /** `.strict()`, so an unrecognised key is an error rather than dropped. */
  readonly strict: boolean
  /** Every check on the way down, outermost first. */
  readonly checks: readonly unknown[]
}

/**
 * The object shape underneath any wrappers, with the checks collected on the
 * way through.
 *
 * `ZodDefault<ZodObject>` and `ZodPipe<ZodObject, …>` both occur on this
 * package's public surface, and a check may be attached at either level — a
 * `buildUpdateSchema` result carries its "nothing to save" guard on the object
 * while a caller may attach a `crossField` above it.
 */
function objectFace(
  schema: unknown,
  depth: number = 0
): ObjectFace | undefined {
  if (depth > MAX_WRAPPER_DEPTH) {
    return undefined
  }

  const def = defNodeOf(schema)

  if (def === undefined) {
    return undefined
  }

  const checks: readonly unknown[] = def.checks ?? []

  if (def.shape !== undefined) {
    return {
      shape: def.shape,
      strict: defNodeOf(def.catchall)?.type === 'never',
      checks,
    }
  }

  for (const inner of [def.innerType, def.in]) {
    if (inner === undefined) {
      continue
    }

    const found = objectFace(inner, depth + 1)

    if (found !== undefined) {
      return { ...found, checks: [...checks, ...found.checks] }
    }
  }

  return undefined
}

/** The branches of a union, however deeply it is wrapped. */
function unionOptions(
  schema: unknown,
  depth: number = 0
): readonly unknown[] | undefined {
  if (depth > MAX_WRAPPER_DEPTH) {
    return undefined
  }

  const def = defNodeOf(schema)

  if (def === undefined) {
    return undefined
  }

  if (def.options !== undefined) {
    return def.options
  }

  for (const inner of [def.innerType, def.in]) {
    if (inner === undefined) {
      continue
    }

    const found = unionOptions(inner, depth + 1)

    if (found !== undefined) {
      return found
    }
  }

  return undefined
}

/** The discriminator key of a union, when it has one. */
function unionDiscriminator(
  schema: unknown,
  depth: number = 0
): string | undefined {
  if (depth > MAX_WRAPPER_DEPTH) {
    return undefined
  }

  const def = defNodeOf(schema)

  if (def === undefined) {
    return undefined
  }

  if (def.discriminator !== undefined) {
    return def.discriminator
  }

  for (const inner of [def.innerType, def.in]) {
    if (inner === undefined) {
      continue
    }

    const found = unionDiscriminator(inner, depth + 1)

    if (found !== undefined) {
      return found
    }
  }

  return undefined
}

/**
 * A readable name for one branch of a union.
 *
 * A discriminated union's branch is named by its discriminant —
 * `referralCodeCreateSchema › rewardType=FREE_MEAL` — so a failure says which
 * reward broke rather than which array index did.
 */
function branchLabel(
  branch: unknown,
  discriminator: string | undefined,
  index: number
): string {
  if (discriminator !== undefined) {
    const face = objectFace(branch)
    const literal = defNodeOf(face?.shape[discriminator])?.values?.[0]

    if (typeof literal === 'string' || typeof literal === 'number') {
      return `${discriminator}=${String(literal)}`
    }
  }

  return `branch ${String(index)}`
}

// =============================================================================
// 2. The corpus
// =============================================================================

/**
 * The value every payload reaches for first.
 *
 * `'foo'` is not a decorative choice: it is verbatim the value from the
 * auditor's repro, `?startsFrom=foo&startsUntil=bar`. Keeping it at the head of
 * the ladder means the reported payload for a rediscovered regression is the
 * one already written in the ticket.
 */
const PRIMARY_HOSTILE = 'foo'

/**
 * Strings first, in the spirit of "a string that is not a valid value for any
 * type" — a query string can only ever deliver strings, so these are the values
 * an HTTP caller can actually send.
 */
const HOSTILE_STRINGS: readonly string[] = [
  PRIMARY_HOSTILE,
  'bar',
  '§ not-a-valid-value §',
  '-1e999',
  '0x1f',
  // A NUL, a right-to-left override and a replacement character, written as
  // escapes so this file stays plain text and greps as one.
  '\u0000\u202E\uFFFD',
  'x'.repeat(4_096),
]

/**
 * Then the non-strings, for a field that accepts free text and can only be
 * falsified with a different runtime type. A body — unlike a query string — can
 * deliver any of these.
 */
const HOSTILE_NON_STRINGS: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -1,
  0,
  true,
  false,
  [],
  [PRIMARY_HOSTILE],
  {},
  null,
]

/** The ladder, in the order it is climbed. */
const HOSTILE_LADDER: readonly unknown[] = [
  ...HOSTILE_STRINGS,
  ...HOSTILE_NON_STRINGS,
]

/**
 * The five non-objects, plus the scalar junk, that every schema is handed.
 *
 * `undefined`, `null`, `[]`, `0` and `''` come first and are named in the
 * report exactly as the task lists them; the rest widen the no-throw sweep to
 * types a schema is unlikely to have considered.
 */
const SENTINELS: readonly (readonly [label: string, value: unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['[]', []],
  ['0', 0],
  ["''", ''],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-0', -0],
  ['true', true],
  ['false', false],
  ['bigint', 10n],
  ['symbol', Symbol('hostile')],
  ['function', (): void => undefined],
  ['Date(Invalid)', new Date(Number.NaN)],
  ['nested junk', { a: { b: { c: [PRIMARY_HOSTILE] } } }],
  ['array of junk', [PRIMARY_HOSTILE, null, 0, {}]],
  ['long string', 'x'.repeat(4_096)],
  ['null-prototype', Object.create(null) as UnknownRecord],
]

/**
 * How many leading entries of {@link SENTINELS} are the five the task names —
 * `undefined`, `null`, `[]`, `0`, `''` — and are therefore assertable against
 * an object schema rather than merely run through it.
 */
const NAMED_SENTINEL_COUNT = 5

/**
 * A payload of keys no schema declares.
 *
 * `'__proto__'` and `'constructor'` are written as computed keys on purpose: a
 * bare `__proto__:` in an object literal sets the prototype instead of defining
 * a property, which is not what a JSON body does. `JSON.parse` produces an
 * ordinary own property, and so does this.
 */
const EXTRA_KEYS_PAYLOAD: UnknownRecord = {
  ['__proto__']: { polluted: true },
  ['constructor']: PRIMARY_HOSTILE,
  ['toString']: PRIMARY_HOSTILE,
  ['__mannachef_unexpected__']: PRIMARY_HOSTILE,
  ['id;DROP TABLE "User"']: PRIMARY_HOSTILE,
}

// =============================================================================
// 3. The recorder
//
// Every `safeParse` in this file goes through `execute`. That is what makes the
// no-throw claim total rather than aspirational: there is no second, unwatched
// call site, including the probes that choose the hostile values.
// =============================================================================

/** One thing that went wrong, in enough detail to fix it without re-running. */
interface Failure {
  readonly schema: string
  readonly caseLabel: string
  readonly kind: 'threw' | 'accepted-garbage'
  readonly payload: string
  readonly detail: string
}

const failures: Failure[] = []
let casesRun = 0
let throwsSeen = 0
let rejectionsAsserted = 0

/**
 * Renders a payload for the report: cycle-safe, truncated, and legible for the
 * values `JSON.stringify` has no spelling for.
 */
function show(value: unknown): string {
  const seen = new WeakSet<object>()

  const rendered = ((): string => {
    if (value === undefined) {
      return 'undefined'
    }

    if (typeof value === 'symbol' || typeof value === 'function') {
      return String(value)
    }

    try {
      return (
        JSON.stringify(value, (_key, raw: unknown): unknown => {
          if (typeof raw === 'bigint') {
            return `${raw.toString()}n`
          }

          if (typeof raw === 'symbol' || typeof raw === 'function') {
            return String(raw)
          }

          if (typeof raw === 'object' && raw !== null) {
            if (seen.has(raw)) {
              return '[circular]'
            }

            seen.add(raw)
          }

          return raw
        }) ?? String(value)
      )
    } catch {
      return '[unserialisable]'
    }
  })()

  return rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered
}

/** The stack of a thrown value, or the best description available. */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  return `non-Error thrown: ${show(error)}`
}

/**
 * Runs one case.
 *
 * `mustReject` is asserted only where a rejection is provable — see the
 * "Falsifiability" note at the head of this file. Returns whether the parse
 * succeeded, so callers can reason about a probe without a second parse.
 */
function execute(
  schemaName: string,
  caseLabel: string,
  schema: ParseableSchema,
  input: unknown,
  mustReject: boolean
): boolean {
  casesRun += 1

  let result: { readonly success: boolean }

  try {
    result = schema.safeParse(input)
  } catch (error) {
    throwsSeen += 1
    failures.push({
      schema: schemaName,
      caseLabel,
      kind: 'threw',
      payload: show(input),
      detail: describeThrown(error),
    })

    return false
  }

  if (mustReject) {
    rejectionsAsserted += 1

    if (result.success) {
      failures.push({
        schema: schemaName,
        caseLabel,
        kind: 'accepted-garbage',
        payload: show(input),
        detail:
          'safeParse answered { success: true } to a payload every field of which its own field schema rejects. A schema that accepts garbage is its own bug.',
      })
    }
  }

  return result.success
}

// =============================================================================
// 4. Choosing a hostile value per field
// =============================================================================

/** A hostile value for one field, and whether the field provably rejects it. */
interface HostileChoice {
  readonly value: unknown
  /** `false` for a field that accepts everything on the ladder. */
  readonly rejected: boolean
}

/**
 * The first ladder rung the field's own schema refuses.
 *
 * The probe parses the *field* schema, not the object, so the answer is a
 * property of the field alone and stays true however the object is composed.
 * Probes are recorded like any other case: a field schema that throws on a
 * scalar is exactly the defect this harness is for.
 */
function chooseHostile(
  schemaName: string,
  key: string,
  field: unknown
): HostileChoice {
  if (!isSchema(field)) {
    return { value: PRIMARY_HOSTILE, rejected: false }
  }

  for (const candidate of HOSTILE_LADDER) {
    const accepted = execute(
      schemaName,
      `probe field '${key}' with ${show(candidate)}`,
      field,
      candidate,
      false
    )

    if (!accepted) {
      return { value: candidate, rejected: true }
    }
  }

  return { value: PRIMARY_HOSTILE, rejected: false }
}

// =============================================================================
// 5. Cross-field pairs
// =============================================================================

/** An unordered pair of field names, normalised so the smaller comes first. */
type FieldPair = readonly [string, string]

/** Adds a normalised pair to a set keyed by its two names. */
function addPair(
  into: Map<string, FieldPair>,
  left: string,
  right: string
): void {
  if (left === right) {
    return
  }

  const pair: FieldPair = left < right ? [left, right] : [right, left]

  into.set(`${pair[0]}+${pair[1]}`, pair)
}

/**
 * **Every** unordered pair of fields on the schema.
 *
 * ## Why this is exhaustive rather than targeted
 *
 * The first draft generated pairs only from `crossFieldDependencyKeys` — the
 * dependency lists `src/common.ts` records as each `crossField` check is built.
 * It was then mutation-tested by putting the original defect back:
 * `bookingSlotFilterSchema`'s `.check(crossField({ deps: ['startsFrom',
 * 'startsUntil'], … }))` was rewritten as the plain two-field `.refine(…)` it
 * used to be, which is exactly the regression this file exists to catch.
 *
 * **The harness passed.** Reverting to `.refine()` takes the check out of the
 * registry, so the harness stopped generating the one pair that would have
 * crashed it: the reported pair count fell from 103 to 102 and nothing else
 * moved. A harness whose aim is supplied by the mechanism under test is blind
 * in precisely the direction it is pointed.
 *
 * So the pairs are the complete set, derived from the *shape*, which no
 * refactor of a refinement can take away. The registry is kept only to label
 * the declared ones in the summary and to add the auditor's literal
 * `foo`/`bar` payload alongside the ladder's choice.
 *
 * The cost is quadratic in the field count and entirely affordable: ~1,200
 * fields across ~140 object schemas, a few seconds end to end.
 */
function allFieldPairs(keys: readonly string[]): readonly FieldPair[] {
  const pairs = new Map<string, FieldPair>()

  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const left = keys[i]
      const right = keys[j]

      if (left === undefined || right === undefined) {
        continue
      }

      addPair(pairs, left, right)
    }
  }

  return [...pairs.values()]
}

/**
 * The pairs some cross-field check on this schema declares it reads together —
 * a strict subset of {@link allFieldPairs}.
 *
 * Used for reporting, and to give a declared pair the auditor's literal repro
 * (`startsFrom=foo`, `startsUntil=bar`) in addition to whatever value the
 * hostile ladder picked. A check declaring three dependencies yields all three
 * of its pairs.
 */
function declaredCrossFieldPairs(face: ObjectFace): readonly FieldPair[] {
  const pairs = new Map<string, FieldPair>()

  for (const check of face.checks) {
    const deps = Barrel.crossFieldDependencyKeys(check)

    if (deps === undefined) {
      continue
    }

    const present = deps.filter((key) => key in face.shape)

    for (let i = 0; i < present.length; i += 1) {
      for (let j = i + 1; j < present.length; j += 1) {
        const left = present[i]
        const right = present[j]

        if (left === undefined || right === undefined) {
          continue
        }

        addPair(pairs, left, right)
      }
    }
  }

  return [...pairs.values()]
}

// =============================================================================
// 6. Fuzzing one target
// =============================================================================

/** One schema under test, named the way a failure should read. */
interface Target {
  readonly name: string
  readonly schema: ParseableSchema
}

interface TargetReport {
  readonly name: string
  readonly kind: 'object' | 'other'
  readonly fields: number
  /** Every unordered field pair — the exhaustive set. */
  readonly pairs: number
  /** How many of those a `crossField` check declares. */
  readonly declaredPairs: number
  readonly cases: number
}

/**
 * The scalar sweep every target takes, object or not.
 *
 * No rejection is asserted here for a non-object schema: `z.string()` is
 * entirely within its rights to accept `''`, and `staffSpecialtiesSchema`
 * accepts `[]`. The claim being made is the unconditional one — no throw.
 */
function fuzzScalars(target: Target, mustRejectSentinels: boolean): void {
  SENTINELS.forEach(([label, value], index) => {
    // Only the five the task names are asserted, and only for a bare object
    // schema: no `undefined`, `null`, `[]`, `0` or `''` can ever satisfy one.
    // The rest of the ladder includes real objects — an invalid `Date`, a
    // null-prototype bag — which a non-strict schema may legitimately accept.
    const mustReject = mustRejectSentinels && index < NAMED_SENTINEL_COUNT

    execute(target.name, `sentinel ${label}`, target.schema, value, mustReject)
  })
}

/**
 * True when the target is an object schema *at the top*, with no `.optional()`,
 * `.default()`, `.nullable()` or `.catch()` above it.
 *
 * Only then can the five non-object sentinels be asserted to fail: a
 * `.default({})` wrapper legitimately accepts `undefined`, and a `.catch()`
 * legitimately accepts everything.
 */
function isBareObject(schema: unknown): boolean {
  return defNodeOf(schema)?.type === 'object'
}

function fuzzTarget(target: Target): TargetReport {
  const before = casesRun
  const face = objectFace(target.schema)

  fuzzScalars(target, isBareObject(target.schema))

  if (face === undefined) {
    for (const candidate of HOSTILE_LADDER) {
      execute(
        target.name,
        `scalar ${show(candidate)}`,
        target.schema,
        candidate,
        false
      )
    }

    return {
      name: target.name,
      kind: 'other',
      fields: 0,
      pairs: 0,
      declaredPairs: 0,
      cases: casesRun - before,
    }
  }

  const keys = Object.keys(face.shape)
  const chosen = new Map<string, HostileChoice>()

  for (const key of keys) {
    chosen.set(key, chooseHostile(target.name, key, face.shape[key]))
  }

  // --- every field hostile at once ------------------------------------------

  const everything: Record<string, unknown> = {}
  let anyFalsifiable = false

  for (const key of keys) {
    const choice = chosen.get(key)

    if (choice === undefined) {
      continue
    }

    everything[key] = choice.value
    anyFalsifiable = anyFalsifiable || choice.rejected
  }

  if (keys.length > 0) {
    execute(
      target.name,
      'all-fields-hostile',
      target.schema,
      everything,
      anyFalsifiable
    )
  }

  // --- each field hostile on its own ----------------------------------------

  for (const key of keys) {
    const choice = chosen.get(key)

    if (choice === undefined) {
      continue
    }

    execute(
      target.name,
      `one-field-hostile:${key}`,
      target.schema,
      { [key]: choice.value },
      choice.rejected
    )
  }

  // --- every hostile pair, plus the auditor's literal repro on declared ones -

  const pairs = allFieldPairs(keys)
  const declared = new Set(
    declaredCrossFieldPairs(face).map(([left, right]) => `${left}+${right}`)
  )

  for (const [left, right] of pairs) {
    const leftChoice = chosen.get(left)
    const rightChoice = chosen.get(right)

    if (leftChoice === undefined || rightChoice === undefined) {
      continue
    }

    execute(
      target.name,
      `hostile-pair:${left}+${right}`,
      target.schema,
      { [left]: leftChoice.value, [right]: rightChoice.value },
      leftChoice.rejected && rightChoice.rejected
    )

    if (!declared.has(`${left}+${right}`)) {
      continue
    }

    // A declared cross-field pair additionally gets the auditor's literal
    // values, so the exact reported repro — `?startsFrom=foo&startsUntil=bar` —
    // is a named case rather than merely a case the ladder happened to cover.
    execute(
      target.name,
      `cross-field-repro:${left}=foo+${right}=bar`,
      target.schema,
      { [left]: 'foo', [right]: 'bar' },
      false
    )
  }

  // --- keys the schema never declared ---------------------------------------

  execute(
    target.name,
    'unexpected-extra-keys',
    target.schema,
    EXTRA_KEYS_PAYLOAD,
    face.strict
  )

  return {
    name: target.name,
    kind: 'object',
    fields: keys.length,
    pairs: pairs.length,
    declaredPairs: declared.size,
    cases: casesRun - before,
  }
}

// =============================================================================
// 7. Discovering every target on the public surface
// =============================================================================

/**
 * Collects a schema and, if it is a union, each of its branches.
 *
 * Branches are fuzzed as objects in their own right because that is where the
 * shape and the cross-field checks live — a discriminated union node has
 * neither.
 */
function collectTargets(
  name: string,
  value: unknown,
  into: Target[],
  seen: Set<unknown>,
  depth: number = 0
): void {
  if (!isSchema(value) || seen.has(value) || depth > MAX_WRAPPER_DEPTH) {
    return
  }

  seen.add(value)
  into.push({ name, schema: value })

  const options = unionOptions(value)

  if (options === undefined) {
    return
  }

  const discriminator = unionDiscriminator(value)

  options.forEach((option, index) => {
    collectTargets(
      `${name} › ${branchLabel(option, discriminator, index)}`,
      option,
      into,
      seen,
      depth + 1
    )
  })
}

/**
 * Every schema reachable from the barrel.
 *
 * Exports that are collections rather than schemas — `intakeStepSchemas` is an
 * array, `staffProfileWritableShape` is a record — are walked one level, since
 * a schema published inside one is every bit as callable as a schema published
 * on its own.
 */
function discoverTargets(): readonly Target[] {
  const targets: Target[] = []
  const seen = new Set<unknown>()
  const surface: UnknownRecord = Barrel

  for (const name of Object.keys(surface).sort()) {
    const value = surface[name]

    if (isSchema(value)) {
      collectTargets(name, value, targets, seen)
      continue
    }

    if (Array.isArray(value)) {
      value.forEach((element, index) => {
        collectTargets(`${name}[${String(index)}]`, element, targets, seen)
      })

      continue
    }

    if (typeof value === 'object' && value !== null) {
      const record = value as UnknownRecord

      for (const key of Object.keys(record)) {
        collectTargets(`${name}.${key}`, record[key], targets, seen)
      }
    }
  }

  return targets
}

// =============================================================================
// 8. Run
// =============================================================================

const targets = discoverTargets()

console.log('Hostile-input fuzz over @mannachef/validators')
console.log(
  `${String(targets.length)} schemas discovered by reflection over the barrel (no hand-written list)\n`
)

const reports: TargetReport[] = []

for (const target of targets) {
  reports.push(fuzzTarget(target))
}

const objectReports = reports.filter((report) => report.kind === 'object')
const totalFields = objectReports.reduce(
  (sum, report) => sum + report.fields,
  0
)
const totalPairs = objectReports.reduce((sum, report) => sum + report.pairs, 0)
const totalDeclaredPairs = objectReports.reduce(
  (sum, report) => sum + report.declaredPairs,
  0
)
const withDeclaredPairs = objectReports.filter(
  (report) => report.declaredPairs > 0
)

console.log(
  '  schemas carrying a declared cross-field rule (every pair below also gets the literal foo/bar repro)'
)

if (withDeclaredPairs.length === 0) {
  console.log(
    '      (none — no schema on the barrel declares a cross-field check)'
  )
} else {
  for (const report of withDeclaredPairs) {
    console.log(
      `      · ${report.name} — ${String(report.declaredPairs)} declared of ${String(report.pairs)} pair${report.pairs === 1 ? '' : 's'} fuzzed`
    )
  }
}

console.log(`\n${'-'.repeat(72)}`)
console.log(
  [
    `schemas: ${String(targets.length)}`,
    `object schemas: ${String(objectReports.length)}`,
    `fields: ${String(totalFields)}`,
    `field pairs: ${String(totalPairs)} (${String(totalDeclaredPairs)} declared cross-field)`,
  ].join('   ')
)
console.log(
  [
    `cases: ${String(casesRun)}`,
    `rejection assertions: ${String(rejectionsAsserted)}`,
    `throws: ${String(throwsSeen)}`,
    `failures: ${String(failures.length)}`,
  ].join('   ')
)

if (failures.length > 0) {
  console.error('\nFAILURES\n')

  for (const failure of failures) {
    console.error(
      `  ✗ ${failure.schema} [${failure.caseLabel}]\n      kind: ${failure.kind}\n      payload: ${failure.payload}\n      ${failure.detail.split('\n').join('\n      ')}\n`
    )
  }

  console.error(
    `${String(failures.length)} failure${failures.length === 1 ? '' : 's'}. Fix the schema, not the harness.`
  )

  process.exit(1)
}

console.log(
  '\nPASS — safeParse never threw, and every provably-invalid payload was rejected.'
)
