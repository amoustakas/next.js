// mannachef/apps/web/scripts/fixtures/fake-db.ts

/**
 * An in-memory stand-in for the five Prisma models the referral privilege
 * regression touches.
 *
 * ## What this is for, and what it is deliberately not
 *
 * `scripts/verify-referral-privilege.ts` drives the real
 * `createReferralCode` / `updateReferralCode` / `redeemReferralCode` /
 * `updateReferralRedemption` Server Actions through the real `withAction`
 * wrapper and the real zod schemas. The only things replaced are the ones a
 * test cannot bring with it: the session, the Next.js cache primitives, and
 * this — the database.
 *
 * It is **not** a Prisma emulator. It supports exactly the queries those four
 * actions make, and every unsupported model, method, operator or `select`
 * shape **throws**. That is the whole design: a fake that silently answers
 * `undefined` to a query it does not understand is a fake that can turn a
 * broken authorisation check into a green run. If this file throws, the
 * harness has found a code path it was not written for and the harness is
 * wrong until somebody extends it.
 *
 * Rows are plain records rather than Prisma payload types. The actions are
 * type-checked against real Prisma types by `tsc` over `src/`; this module is
 * substituted at *runtime only*, by `scripts/stub-resolver.mjs`, so nothing
 * here needs to satisfy `PrismaClient` structurally.
 */

// =============================================================================
// 1. Rows and the store
// =============================================================================

export type Row = Record<string, unknown>

/** The five tables. Everything else is a `throw`. */
export interface Store {
  users: Row[]
  referralPrograms: Row[]
  referralCodes: Row[]
  referralRedemptions: Row[]
  invoices: Row[]
}

export function emptyStore(): Store {
  return {
    users: [],
    referralPrograms: [],
    referralCodes: [],
    referralRedemptions: [],
    invoices: [],
  }
}

/** One query the fake was asked to answer, in order. */
export interface CallRecord {
  readonly model: string
  readonly method: string
  readonly args: Row
}

// =============================================================================
// 2. Matching
// =============================================================================

function isPlainObject(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  )
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }

  return left === right
}

/** The `where` operators the four actions under test actually use. */
const KNOWN_OPERATORS = new Set(['not', 'in', 'gte', 'lte', 'lt', 'gt'])

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (!isPlainObject(condition)) {
    return sameScalar(value, condition)
  }

  const keys = Object.keys(condition)
  const unknown = keys.filter((key) => !KNOWN_OPERATORS.has(key))

  if (unknown.length > 0) {
    throw new Error(
      `fake db: unsupported where operator(s) ${unknown.join(', ')} — extend the harness`
    )
  }

  for (const key of keys) {
    const operand = condition[key]

    if (key === 'not' && matchesCondition(value, operand)) {
      return false
    }

    if (key === 'in') {
      if (!Array.isArray(operand)) {
        throw new Error('fake db: `in` expects an array')
      }

      if (!operand.some((candidate) => sameScalar(value, candidate))) {
        return false
      }
    }

    if (key === 'gte' || key === 'lte' || key === 'lt' || key === 'gt') {
      const left = value instanceof Date ? value.getTime() : value
      const right = operand instanceof Date ? operand.getTime() : operand

      if (typeof left !== 'number' || typeof right !== 'number') {
        throw new Error(
          `fake db: \`${key}\` expects comparable numbers or dates`
        )
      }

      const held =
        key === 'gte'
          ? left >= right
          : key === 'lte'
            ? left <= right
            : key === 'lt'
              ? left < right
              : left > right

      if (!held) {
        return false
      }
    }
  }

  return true
}

function matches(row: Row, where: Row): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (!(key in row) && isPlainObject(condition)) {
      // A compound unique — `referralCodeId_referredUserId: { … }`.
      const nested = Object.entries(condition).every(([field, value]) =>
        matchesCondition(row[field], value)
      )

      if (!nested) {
        return false
      }

      continue
    }

    if (!matchesCondition(row[key], condition)) {
      return false
    }
  }

  return true
}

// =============================================================================
// 3. Projection
// =============================================================================

type RelationResolver = (row: Row) => Row | null

function project(
  row: Row,
  select: Row | undefined,
  relations: Record<string, RelationResolver>
): Row {
  if (select === undefined) {
    return { ...row }
  }

  const out: Row = {}

  for (const [key, value] of Object.entries(select)) {
    if (value === true) {
      out[key] = row[key] ?? null
      continue
    }

    if (isPlainObject(value) && isPlainObject(value['select'])) {
      const resolve = relations[key]

      if (resolve === undefined) {
        throw new Error(`fake db: no relation resolver for \`${key}\``)
      }

      const related = resolve(row)
      out[key] = related === null ? null : project(related, value['select'], {})
      continue
    }

    throw new Error(`fake db: unsupported select entry \`${key}\``)
  }

  return out
}

// =============================================================================
// 4. Writes
// =============================================================================

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value)) {
      const increment = value['increment']

      if (typeof increment !== 'number') {
        throw new Error(`fake db: unsupported update operation on \`${key}\``)
      }

      const current = row[key]

      if (typeof current !== 'number') {
        throw new Error(`fake db: cannot increment non-numeric \`${key}\``)
      }

      row[key] = current + increment
      continue
    }

    row[key] = value
  }
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) {
    return rows
  }

  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]
  const sorted = [...rows]

  sorted.sort((left, right) => {
    for (const clause of clauses) {
      if (!isPlainObject(clause)) {
        throw new Error('fake db: unsupported orderBy clause')
      }

      for (const [field, direction] of Object.entries(clause)) {
        const a = left[field]
        const b = right[field]
        const av = a instanceof Date ? a.getTime() : a
        const bv = b instanceof Date ? b.getTime() : b

        if (av === bv) {
          continue
        }

        if (typeof av !== typeof bv) {
          throw new Error(`fake db: cannot order mixed types on \`${field}\``)
        }

        const ascending =
          (typeof av === 'number' && typeof bv === 'number' && av < bv) ||
          (typeof av === 'string' && typeof bv === 'string' && av < bv)

        return direction === 'desc' ? (ascending ? 1 : -1) : ascending ? -1 : 1
      }
    }

    return 0
  })

  return sorted
}

// =============================================================================
// 5. The client
// =============================================================================

interface QueryArgs {
  where?: Row
  data?: Row
  create?: Row
  update?: Row
  select?: Row
  orderBy?: unknown
}

/** One model's worth of the delegate surface the actions use. */
export interface FakeDelegate {
  findUnique(args: QueryArgs): Promise<Row | null>
  findUniqueOrThrow(args: QueryArgs): Promise<Row>
  findFirst(args: QueryArgs): Promise<Row | null>
  create(args: QueryArgs): Promise<Row>
  update(args: QueryArgs): Promise<Row>
  updateMany(args: QueryArgs): Promise<{ count: number }>
  upsert(args: QueryArgs): Promise<Row>
}

export interface FakeClient {
  readonly user: FakeDelegate
  readonly referralProgram: FakeDelegate
  readonly referralCode: FakeDelegate
  readonly referralRedemption: FakeDelegate
  readonly invoice: FakeDelegate
  $transaction<T>(run: (tx: FakeClient) => Promise<T>): Promise<T>
}

export interface FakeDatabase {
  readonly client: FakeClient
  readonly calls: CallRecord[]
  /** Rows written by the actions, for the assertions to read back. */
  readonly store: Store
}

let sequence = 0

/**
 * A synthetic primary key.
 *
 * Shaped like a cuid — a leading `c` and then lower-case alphanumerics — because
 * ids minted here go straight back out through `cuidSchema` on the next call,
 * exactly as a real one would. An id the validators would reject is an id the
 * harness could never amend.
 */
function nextId(model: string): string {
  sequence += 1

  const slug = model.toLowerCase().replace(/[^a-z0-9]/g, '')

  return `c${slug}${String(sequence).padStart(8, '0')}`
}

function delegate(
  model: string,
  rows: Row[],
  calls: CallRecord[],
  relations: Record<string, RelationResolver>
): FakeDelegate {
  const record = (method: string, args: QueryArgs): void => {
    calls.push({ model, method, args: { ...args } })
  }

  const findRow = (where: Row | undefined): Row | null => {
    if (where === undefined) {
      throw new Error(`fake db: ${model} query with no where clause`)
    }

    return rows.find((row) => matches(row, where)) ?? null
  }

  return {
    async findUnique(args) {
      record('findUnique', args)
      const row = findRow(args.where)

      return row === null ? null : project(row, args.select, relations)
    },

    async findUniqueOrThrow(args) {
      record('findUniqueOrThrow', args)
      const row = findRow(args.where)

      if (row === null) {
        throw new Error(`fake db: ${model} row not found`)
      }

      return project(row, args.select, relations)
    },

    async findFirst(args) {
      record('findFirst', args)
      const where = args.where ?? {}
      const candidates = sortRows(
        rows.filter((row) => matches(row, where)),
        args.orderBy
      )
      const row = candidates[0] ?? null

      return row === null ? null : project(row, args.select, relations)
    },

    async create(args) {
      record('create', args)

      if (args.data === undefined) {
        throw new Error(`fake db: ${model} create with no data`)
      }

      const row: Row = {
        id: nextId(model),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      }

      rows.push(row)

      return project(row, args.select, relations)
    },

    async update(args) {
      record('update', args)
      const row = findRow(args.where)

      if (row === null) {
        throw new Error(`fake db: ${model} row not found for update`)
      }

      applyData(row, args.data ?? {})

      return project(row, args.select, relations)
    },

    async updateMany(args) {
      record('updateMany', args)
      const where = args.where ?? {}
      const targets = rows.filter((row) => matches(row, where))

      for (const target of targets) {
        applyData(target, args.data ?? {})
      }

      return { count: targets.length }
    },

    async upsert(args) {
      record('upsert', args)
      const existing = findRow(args.where)

      if (existing !== null) {
        applyData(existing, args.update ?? {})

        return project(existing, args.select, relations)
      }

      const row: Row = {
        id: nextId(model),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.create,
      }

      rows.push(row)

      return project(row, args.select, relations)
    },
  }
}

/**
 * Build a client over `store`.
 *
 * `$transaction` runs the callback against the same client: there is no
 * rollback, so an action that throws mid-transaction leaves its partial writes
 * behind. Every assertion in the harness is written knowing that, and the two
 * refusal cases it exercises throw before writing anything.
 */
export function createFakeDatabase(store: Store): FakeDatabase {
  const calls: CallRecord[] = []

  const byId = (rows: Row[], id: unknown): Row | null =>
    rows.find((row) => row['id'] === id) ?? null

  const client: FakeClient = {
    user: delegate('user', store.users, calls, {}),
    referralProgram: delegate(
      'referralProgram',
      store.referralPrograms,
      calls,
      {}
    ),
    referralCode: delegate('referralCode', store.referralCodes, calls, {}),
    referralRedemption: delegate(
      'referralRedemption',
      store.referralRedemptions,
      calls,
      {
        referralCode: (row) => byId(store.referralCodes, row['referralCodeId']),
        referredUser: (row) => byId(store.users, row['referredUserId']),
      }
    ),
    invoice: delegate('invoice', store.invoices, calls, {}),
    async $transaction<T>(run: (tx: FakeClient) => Promise<T>): Promise<T> {
      return run(client)
    },
  }

  return { client, calls, store }
}
