// mannachef/apps/web/scripts/verify-admin-route-guard.ts

/**
 * MCV-052 — the per-section admin gate, driven through the real guard.
 *
 * ```bash
 * pnpm --filter @mannachef/web verify:admin-guard
 * ```
 *
 * Exits non-zero on the first failed assertion. Touches no database, no Stripe
 * and no network: the thing under test is a routing decision, and every input
 * it reads is a session and a pathname.
 *
 * ## The defect
 *
 * `@/server/admin-access` has always implemented the whole check the design
 * calls for — resolve the session, apply the `CHEF_STAFF` floor for the tree,
 * then apply `minimumRoleForPathname()` for the section being asked for. But
 * `requireAdminViewer` had **no callers**. `grep -rn requireAdminViewer src/`
 * returned hits only inside the module that defines it.
 *
 * The layout had forked the first two steps inline — `getSessionUser()` then
 * `hasRoleAtLeast(user.role, ADMIN_MINIMUM_ROLE)` — and imported
 * `currentAdminPathname` only to draw breadcrumbs and build a `callbackUrl`.
 * The third step, the one that reads the section's own floor, never ran at
 * request time. Every `minRole: 'ADMIN'` in `@/lib/admin-nav` was therefore
 * decorative: it hid a link from the rail and the command bar, and did nothing
 * whatsoever to the route. A `CHEF_STAFF` reached Invoices, Subscriptions,
 * Referrals, Clients, Reviews and Settings by typing the URL, and the aggregate
 * revenue on those screens renders long before anybody clicks a control that a
 * Server Action would refuse.
 *
 * ## Why this harness has two halves, and why it needs both
 *
 * The failure was never "the guard computes the wrong answer". The guard was
 * always right. The failure was that **nothing called it** — so a harness that
 * only exercised `requireAdminViewer()` would have been green throughout the
 * entire period the route tree was open, which is the precise definition of a
 * test that cannot fail for the reason you care about.
 *
 *  - **Part A — wiring.** Reads `src/app/(admin)/admin/layout.tsx` as text and
 *    asserts that it imports and calls `requireAdminViewer`, and that it no
 *    longer imports the pieces of the fork (`getSessionUser`, `hasRoleAtLeast`,
 *    `ADMIN_MINIMUM_ROLE`). Deleting the guard call from the layout turns this
 *    red; re-introducing a second copy of the check turns it red too, which is
 *    the drift that caused the defect in the first place.
 *  - **Parts B–F — behaviour.** Drives the real `requireAdminViewer()` over
 *    every section in the nav model, once per role, and asserts on the outcome:
 *    admitted, or redirected, and to where.
 *
 * Part A is a source assertion rather than a render, because rendering the
 * layout means React, JSX, Radix, `lucide-react` and a Next.js request scope,
 * and the only thing that would prove beyond a text search is that the JSX also
 * compiles — which `pnpm typecheck` already proves. What matters here is
 * whether the call site exists, and that is exactly what a source assertion
 * answers.
 *
 * ## What is substituted, and what is real
 *
 * Three specifiers, installed with `module.registerHooks` before the first
 * dynamic import below:
 *
 *  - `@/server/auth` — a session, without Auth.js or a database behind it.
 *  - `next/headers` — the pathname header middleware stamps on the request.
 *  - `next/navigation` — `redirect()`, which throws in production and must
 *    therefore throw here; a stub that returned normally would let
 *    `requireAdminViewer` carry on past its own refusal and prove the opposite
 *    of what this file claims.
 *
 * The hooks live in this file rather than in a `scripts/*-resolver.mjs` because
 * there is exactly one consumer and the substitutions are three lines. The
 * guard, the nav model, `hasRoleAtLeast` and the role hierarchy are all the real
 * modules, unmodified — nothing in `src/` knows this harness exists.
 */

import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Role } from '@mannachef/validators'
import type { AdminViewer } from '@/server/admin-access'
import type { AdminNavItem } from '@/lib/admin-nav'

// =============================================================================
// 1. The shared slot the substituted modules read
// =============================================================================

/** The `AuthenticatedUser` shape, reduced to what the guard actually reads. */
interface HarnessSessionUser {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  readonly image: string | null
  readonly role: Role
  readonly isActive: true
  readonly timeZone: string
  readonly locale: string
  readonly clientProfileId: string | null
  readonly staffProfileId: string | null
}

/**
 * What the three stub modules and the assertions both see.
 *
 * On `globalThis` because the stubs are `data:` URL modules with no file on
 * disk to import from, and because a mutable object shared by reference is the
 * only way a stub evaluated once can answer differently on each attempt.
 */
interface GuardHarnessState {
  /** `ADMIN_PATHNAME_HEADER`, filled in once the real module has loaded. */
  header: string
  /** What middleware stamped, or `null` for "middleware did not run". */
  pathname: string | null
  /** Who is asking. `null` is signed out. */
  user: HarnessSessionUser | null
  /** Where the last `redirect()` pointed, or `null` if none was called. */
  lastRedirect: string | null
}

const HARNESS_SLOT = '__mannachefAdminGuardHarness'

const state: GuardHarnessState = {
  header: '',
  pathname: null,
  user: null,
  lastRedirect: null,
}

;(globalThis as unknown as Record<string, GuardHarnessState>)[HARNESS_SLOT] =
  state

// =============================================================================
// 2. Module resolution
// =============================================================================

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const sourceRoot = path.join(projectRoot, 'src')

/** A `data:` module, so a substitution needs no file on disk. */
function inlineModule(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`
}

const READ_STATE = `const state = globalThis[${JSON.stringify(HARNESS_SLOT)}];`

const SUBSTITUTIONS = new Map<string, string>([
  [
    '@/server/auth',
    inlineModule(
      `${READ_STATE}
       export async function getSessionUser() { return state.user }`
    ),
  ],
  [
    'next/headers',
    inlineModule(
      `${READ_STATE}
       export async function headers() {
         const bag = new Headers()
         if (state.pathname !== null) { bag.set(state.header, state.pathname) }
         return bag
       }`
    ),
  ],
  [
    'next/navigation',
    inlineModule(
      // Mirrors the real `redirect`: records the destination, then throws the
      // sentinel Next.js catches. Never returns, exactly like the real one.
      `${READ_STATE}
       export function redirect(url) {
         state.lastRedirect = url
         const error = new Error('NEXT_REDIRECT')
         error.digest = 'NEXT_REDIRECT;replace;' + url + ';307;'
         throw error
       }
       export function notFound() {
         const error = new Error('NEXT_NOT_FOUND')
         error.digest = 'NEXT_NOT_FOUND'
         throw error
       }`
    ),
  ],
])

/** `@/lib/admin-nav` → `src/lib/admin-nav.ts`, as the bundler would. */
function firstExisting(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (path.extname(candidate) !== '' && existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const substitute = SUBSTITUTIONS.get(specifier)

    if (substitute !== undefined) {
      return { url: substitute, shortCircuit: true }
    }

    if (specifier.startsWith('@/')) {
      const resolved = firstExisting(path.join(sourceRoot, specifier.slice(2)))

      if (resolved !== null) {
        return { url: pathToFileURL(resolved).href, shortCircuit: true }
      }
    }

    // The workspace compiles under `moduleResolution: "Bundler"`, so its
    // relative imports carry no extension and Node cannot resolve them alone.
    if (specifier.startsWith('.') && path.extname(specifier) === '') {
      const parent =
        context.parentURL === undefined
          ? process.cwd()
          : fileURLToPath(context.parentURL)
      const resolved = firstExisting(
        path.resolve(path.dirname(parent), specifier)
      )

      if (resolved !== null) {
        return { url: pathToFileURL(resolved).href, shortCircuit: true }
      }
    }

    return nextResolve(specifier, context)
  },
})

// Everything below is imported dynamically: the hooks above have to be
// installed before the specifiers they rewrite are resolved, and a static
// import graph is resolved before this module's body ever runs.
const { ADMIN_PATHNAME_HEADER } = await import('@/lib/admin-headers')
const {
  ADMIN_FALLBACK_PATH,
  ADMIN_MINIMUM_ROLE,
  ADMIN_NAV_ITEMS,
  ADMIN_ROOT_PATH,
  minimumRoleForPathname,
  visibleNavGroups,
} = await import('@/lib/admin-nav')
const { requireAdminViewer, requireAdminRole } =
  await import('@/server/admin-access')
const { check, checkCount, note, printTable, section } =
  await import('./fixtures/report')

state.header = ADMIN_PATHNAME_HEADER

/** Auth.js's built-in sign-in route, as `admin-access.ts` spells it. */
const SIGN_IN_PATH = '/api/auth/signin'

// =============================================================================
// 3. Driving the guard
// =============================================================================

function sessionFor(role: Role): HarnessSessionUser {
  const slug = role.toLowerCase()

  return {
    id: `user_${slug}`,
    name: `${role} Operator`,
    email: `${slug}@mannachef.test`,
    image: null,
    role,
    isActive: true,
    timeZone: 'America/Toronto',
    locale: 'en-CA',
    clientProfileId: role === 'CLIENT' ? 'client_profile_1' : null,
    staffProfileId: role === 'CHEF_STAFF' ? 'staff_profile_1' : null,
  }
}

type GuardOutcome =
  | { readonly kind: 'admitted'; readonly viewer: AdminViewer }
  | { readonly kind: 'redirected'; readonly to: string }

/**
 * One request: this session, asking for this pathname.
 *
 * A `redirect()` inside the guard throws, so the `catch` is the refusal path.
 * An error that arrived *without* a recorded destination is a genuine fault in
 * the code under test and is re-thrown rather than counted as a refusal —
 * otherwise a `TypeError` would read as a successful gate.
 */
async function attempt(
  user: HarnessSessionUser | null,
  pathname: string | null
): Promise<GuardOutcome> {
  state.user = user
  state.pathname = pathname
  state.lastRedirect = null

  try {
    const viewer = await requireAdminViewer()

    return { kind: 'admitted', viewer }
  } catch (error) {
    if (state.lastRedirect === null) {
      throw error
    }

    return { kind: 'redirected', to: state.lastRedirect }
  }
}

function describe(outcome: GuardOutcome): string {
  return outcome.kind === 'admitted' ? 'admitted' : `redirected → ${outcome.to}`
}

function assertAdmitted(outcome: GuardOutcome, role: Role): AdminViewer {
  if (outcome.kind !== 'admitted') {
    throw new Error(`expected ${role} to be admitted, got ${describe(outcome)}`)
  }

  return outcome.viewer
}

function assertRedirectedTo(outcome: GuardOutcome, target: string): void {
  if (outcome.kind !== 'redirected') {
    throw new Error(`expected a redirect to ${target}, was admitted instead`)
  }

  if (outcome.to !== target) {
    throw new Error(`expected a redirect to ${target}, got ${outcome.to}`)
  }
}

// =============================================================================
// 4. The policy this file pins
// =============================================================================

/**
 * The floor every admin section is *supposed* to have.
 *
 * Written out here rather than read from `ADMIN_NAV` so that the two can
 * disagree. Deriving the expectation from the thing under test would make this
 * table a tautology: lowering Invoices to `CHEF_STAFF` in `@/lib/admin-nav`
 * would silently lower the expectation with it and the harness would stay
 * green.
 *
 * The reasoning behind each line lives in `@/lib/admin-nav`'s header. In short:
 * a chef needs the Overview, the catalogue they cook from, the diary, the
 * sittings, the household questionnaires and their own staff record. Reviews,
 * Clients, Referrals, Subscriptions and Invoices are commercial or
 * administrative screens whose contents are not a chef's to read.
 */
const EXPECTED_FLOOR: ReadonlyMap<string, Role> = new Map([
  ['/admin', 'CHEF_STAFF'],
  ['/admin/menu', 'CHEF_STAFF'],
  ['/admin/media', 'CHEF_STAFF'],
  ['/admin/reviews', 'ADMIN'],
  // No `/admin/bookings` and no `/admin/settings`: neither route was ever
  // built, and both nav entries were removed rather than retargeted — the
  // calendar is the screen that answers bookings, and there is no settings
  // surface at all (the only editable configuration, the referral programme's
  // terms, lives on `/admin/referrals`). This table is the independent policy
  // statement, so a section returning to the nav must be added here too.
  ['/admin/calendar', 'CHEF_STAFF'],
  ['/admin/intake', 'CHEF_STAFF'],
  ['/admin/clients', 'ADMIN'],
  ['/admin/referrals', 'ADMIN'],
  ['/admin/subscriptions', 'ADMIN'],
  ['/admin/invoices', 'ADMIN'],
  ['/admin/staff', 'CHEF_STAFF'],
])

/** Every role, weakest first. */
const ALL_ROLES: readonly Role[] = [
  'CLIENT',
  'CHEF_STAFF',
  'ADMIN',
  'SUPER_ADMIN',
]

/**
 * A plausible child route under each section.
 *
 * `navItemForPathname` resolves by longest prefix, so a detail page inherits
 * its section's floor. This is the case the URL-typing chef actually exercises:
 * `/admin/invoices` may be linked from nowhere they can see, but
 * `/admin/invoices/<cuid>` is one paste away.
 */
function childOf(href: string): string {
  return `${href === ADMIN_ROOT_PATH ? '' : href}/clh2k9x0000008l3f4h1a2b3`
}

// =============================================================================
// 5. Part A — the layout is wired to the guard
// =============================================================================

const LAYOUT_PATH = path.join(
  sourceRoot,
  'app',
  '(admin)',
  'admin',
  'layout.tsx'
)

/** One `import … from '…'` statement, split into its clause and specifier. */
interface ImportStatement {
  readonly clause: string
  readonly specifier: string
}

/**
 * The layout's import statements.
 *
 * Anchored to `^import` so prose in a doc comment can never match — this file's
 * own subject matter means the layout's header legitimately *names*
 * `getSessionUser` and `hasRoleAtLeast` while explaining why they are gone, and
 * an unanchored search would read that as the fork still being present.
 */
function importsOf(source: string): ImportStatement[] {
  const statements: ImportStatement[] = []
  const pattern = /^import\s+([\s\S]*?)\s+from\s+'([^']+)'/gm
  let match = pattern.exec(source)

  while (match !== null) {
    const [, clause, specifier] = match

    if (clause !== undefined && specifier !== undefined) {
      statements.push({ clause, specifier })
    }

    match = pattern.exec(source)
  }

  return statements
}

/**
 * The body of `AdminLayout`, with comments removed.
 *
 * Comment stripping is a regex over a region that contains no string literal
 * holding `//` or a block-comment opener — verified by the anchor assertion
 * below, which fails loudly if the region stops looking like the function it is
 * meant to be rather than passing on a mangled slice.
 */
function layoutBody(source: string): string {
  const marker = 'export default async function AdminLayout'
  const start = source.indexOf(marker)

  if (start === -1) {
    throw new Error(`${LAYOUT_PATH}: no \`${marker}\` declaration`)
  }

  const end = source.indexOf('\n}\n', start)

  if (end === -1) {
    throw new Error(`${LAYOUT_PATH}: \`AdminLayout\` is never closed`)
  }

  return source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

function verifyWiring(): void {
  section('A · The layout calls the guard, and only the guard')

  const source = readFileSync(LAYOUT_PATH, 'utf8')
  const statements = importsOf(source)
  const body = layoutBody(source)

  check('the layout body is a recognisable function, not a bad slice', () => {
    if (!body.includes('AdminLayoutProps')) {
      throw new Error('the extracted body does not mention AdminLayoutProps')
    }

    if (!body.includes('<AdminSidebar')) {
      throw new Error('the extracted body does not render the sidebar')
    }
  })

  check('imports `requireAdminViewer` from @/server/admin-access', () => {
    const found = statements.some(
      (statement) =>
        statement.specifier === '@/server/admin-access' &&
        statement.clause.includes('requireAdminViewer')
    )

    if (!found) {
      throw new Error(
        'the layout does not import requireAdminViewer — the guard is dead code again'
      )
    }
  })

  check('calls `await requireAdminViewer()` in the layout body', () => {
    if (!/await\s+requireAdminViewer\s*\(\s*\)/.test(body)) {
      throw new Error(
        'the layout imports the guard but never awaits it; every section floor is unenforced'
      )
    }
  })

  for (const forked of [
    'getSessionUser',
    'hasRoleAtLeast',
    'ADMIN_MINIMUM_ROLE',
  ]) {
    check(`does not re-import \`${forked}\` to fork the check`, () => {
      const found = statements.some((statement) =>
        new RegExp(`\\b${forked}\\b`).test(statement.clause)
      )

      if (found) {
        throw new Error(
          `the layout imports ${forked} again — two copies of this check is what drifted last time`
        )
      }
    })
  }

  note('the guard has exactly one implementation, in @/server/admin-access')
}

// =============================================================================
// 6. Parts B–F — behaviour
// =============================================================================

function verifyDeclarations(): void {
  section('B · Every section declares the floor it is supposed to')

  const declared = new Map(
    ADMIN_NAV_ITEMS.map((item) => [item.href as string, item.minRole])
  )

  check('the nav model and the expected policy cover the same sections', () => {
    const missing = [...EXPECTED_FLOOR.keys()].filter(
      (href) => !declared.has(href)
    )
    const extra = [...declared.keys()].filter(
      (href) => !EXPECTED_FLOOR.has(href)
    )

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `missing from the nav model: ${missing.join(', ') || 'none'}; ` +
          `not covered by this harness: ${extra.join(', ') || 'none'}`
      )
    }
  })

  for (const [href, expected] of EXPECTED_FLOOR) {
    check(`${href} declares ${expected}`, () => {
      const actual = declared.get(href)

      if (actual !== expected) {
        throw new Error(`declared ${String(actual)}, expected ${expected}`)
      }
    })

    check(`${href} resolves to ${expected} at request time`, () => {
      const resolved = minimumRoleForPathname(href)

      if (resolved !== expected) {
        throw new Error(`minimumRoleForPathname gave ${resolved}`)
      }
    })

    check(`${childOf(href)} inherits ${expected}`, () => {
      const resolved = minimumRoleForPathname(childOf(href))

      if (resolved !== expected) {
        throw new Error(`a detail page resolved to ${resolved}`)
      }
    })
  }
}

async function verifyTreeFloor(): Promise<void> {
  section('C · The floor for the whole tree')

  check('the tree floor is CHEF_STAFF', () => {
    if (ADMIN_MINIMUM_ROLE !== 'CHEF_STAFF') {
      throw new Error(`ADMIN_MINIMUM_ROLE is ${ADMIN_MINIMUM_ROLE}`)
    }
  })

  for (const href of EXPECTED_FLOOR.keys()) {
    const signedOut = await attempt(null, href)

    check(`signed out at ${href} → sign in, carrying the destination`, () => {
      assertRedirectedTo(
        signedOut,
        `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(href)}`
      )
    })

    const asClient = await attempt(sessionFor('CLIENT'), href)

    check(`a CLIENT at ${href} → ${ADMIN_FALLBACK_PATH}`, () => {
      assertRedirectedTo(asClient, ADMIN_FALLBACK_PATH)
    })
  }

  note('a CLIENT is not an error; /portal admits any session, so it terminates')
}

interface SectionRow {
  readonly href: string
  readonly floor: Role
  readonly chefStaff: string
  readonly admin: string
}

const rows: SectionRow[] = []

async function verifySections(): Promise<void> {
  section('D · Per-section enforcement, one request per role')

  for (const [href, floor] of EXPECTED_FLOOR) {
    const outcomes = new Map<Role, GuardOutcome>()

    for (const role of ALL_ROLES) {
      outcomes.set(role, await attempt(sessionFor(role), href))
    }

    for (const role of ALL_ROLES) {
      const outcome = outcomes.get(role)

      if (outcome === undefined) {
        throw new Error(`no outcome recorded for ${role}`)
      }

      const shouldReach = ALL_ROLES.indexOf(role) >= ALL_ROLES.indexOf(floor)

      if (role === 'CLIENT') {
        // Covered by part C; a CLIENT never reaches the section check at all.
        continue
      }

      check(
        `${role} at ${href} is ${shouldReach ? 'admitted' : 'refused'}`,
        () => {
          if (shouldReach) {
            const viewer = assertAdmitted(outcome, role)

            if (viewer.role !== role) {
              throw new Error(`the viewer came back as ${viewer.role}`)
            }
          } else {
            assertRedirectedTo(outcome, ADMIN_ROOT_PATH)
          }
        }
      )
    }

    // The paste-the-URL case, which is how the defect was reachable.
    const child = childOf(href)
    const chefOnChild = await attempt(sessionFor('CHEF_STAFF'), child)

    check(
      `CHEF_STAFF at ${child} is ${floor === 'ADMIN' ? 'refused' : 'admitted'}`,
      () => {
        if (floor === 'ADMIN') {
          assertRedirectedTo(chefOnChild, ADMIN_ROOT_PATH)
        } else {
          assertAdmitted(chefOnChild, 'CHEF_STAFF')
        }
      }
    )

    const chefOutcome = outcomes.get('CHEF_STAFF')
    const adminOutcome = outcomes.get('ADMIN')

    rows.push({
      href,
      floor,
      chefStaff: chefOutcome === undefined ? '—' : describe(chefOutcome),
      admin: adminOutcome === undefined ? '—' : describe(adminOutcome),
    })
  }
}

async function verifyRailAgreesWithGate(): Promise<void> {
  section('E · The rail shows exactly what the gate opens')

  for (const role of ALL_ROLES) {
    if (role === 'CLIENT') {
      check('a CLIENT is offered no rail at all', () => {
        if (visibleNavGroups(role).length > 0) {
          throw new Error('visibleNavGroups returned groups for a CLIENT')
        }
      })

      continue
    }

    const shown = visibleNavGroups(role)
      .flatMap((group) => group.items)
      .map((item: AdminNavItem) => item.href as string)
      .sort()

    const opened: string[] = []

    for (const href of EXPECTED_FLOOR.keys()) {
      const outcome = await attempt(sessionFor(role), href)

      if (outcome.kind === 'admitted') {
        opened.push(href)
      }
    }

    opened.sort()

    check(`${role}: the rail and the guard name the same sections`, () => {
      if (shown.join(' ') !== opened.join(' ')) {
        throw new Error(
          `rail: [${shown.join(', ')}] but the guard opens: [${opened.join(', ')}]`
        )
      }
    })
  }

  note('a link the rail forgot to hide would still meet a redirect')
}

async function verifyDegradedAndNested(): Promise<void> {
  section('F · No pathname header, and a floor above the section')

  const chefWithoutHeader = await attempt(sessionFor('CHEF_STAFF'), null)

  check(
    'middleware absent: the tree floor still applies to a CHEF_STAFF',
    () => {
      assertAdmitted(chefWithoutHeader, 'CHEF_STAFF')
    }
  )

  const clientWithoutHeader = await attempt(sessionFor('CLIENT'), null)

  check('middleware absent: a CLIENT is still turned away', () => {
    assertRedirectedTo(clientWithoutHeader, ADMIN_FALLBACK_PATH)
  })

  note(
    'without the header the section check cannot run; the actions behind the'
  )
  note('page are what refuse the read, which is the documented degradation')

  const unmapped = await attempt(
    sessionFor('CHEF_STAFF'),
    '/admin/not-a-section'
  )

  check(
    'an unregistered path falls back to the tree floor, not to "anyone"',
    () => {
      assertAdmitted(unmapped, 'CHEF_STAFF')
    }
  )

  const unmappedClient = await attempt(
    sessionFor('CLIENT'),
    '/admin/not-a-section'
  )

  check('…and a CLIENT is refused there too', () => {
    assertRedirectedTo(unmappedClient, ADMIN_FALLBACK_PATH)
  })

  // `requireAdminRole` is the escape hatch for a panel whose floor is higher
  // than its route prefix implies. It is exported and, unlike the guard it
  // wraps, has no caller yet — so it is pinned here before one appears.
  state.user = sessionFor('ADMIN')
  state.pathname = '/admin/referrals'
  state.lastRedirect = null

  let governed: AdminViewer | null = null

  try {
    governed = await requireAdminRole('SUPER_ADMIN')
  } catch (error) {
    if (state.lastRedirect === null) {
      throw error
    }
  }

  check('requireAdminRole refuses an ADMIN a SUPER_ADMIN panel', () => {
    if (governed !== null) {
      throw new Error('an ADMIN was admitted to a SUPER_ADMIN panel')
    }

    if (state.lastRedirect !== ADMIN_ROOT_PATH) {
      throw new Error(`redirected to ${String(state.lastRedirect)}`)
    }
  })

  const superViewer = await attempt(
    sessionFor('SUPER_ADMIN'),
    '/admin/referrals'
  )

  check('a SUPER_ADMIN carries canCurate and canGovern', () => {
    const viewer = assertAdmitted(superViewer, 'SUPER_ADMIN')

    if (!viewer.canCurate || !viewer.canGovern) {
      throw new Error(
        `canCurate=${String(viewer.canCurate)} canGovern=${String(viewer.canGovern)}`
      )
    }
  })

  const chefViewer = await attempt(sessionFor('CHEF_STAFF'), ADMIN_ROOT_PATH)

  check('a CHEF_STAFF carries neither', () => {
    const viewer = assertAdmitted(chefViewer, 'CHEF_STAFF')

    if (viewer.canCurate || viewer.canGovern) {
      throw new Error(
        `canCurate=${String(viewer.canCurate)} canGovern=${String(viewer.canGovern)}`
      )
    }
  })
}

// =============================================================================
// 7. Report
// =============================================================================

function printReport(): void {
  printTable(
    'Per-section outcome, driven through requireAdminViewer()',
    [
      ['section', 'floor', 'CHEF_STAFF', 'ADMIN'],
      ...rows.map((row) => [row.href, row.floor, row.chefStaff, row.admin]),
    ],
    '  Before the fix every CHEF_STAFF cell above read "admitted": the layout\n' +
      '  resolved the session and applied the CHEF_STAFF tree floor, and then\n' +
      '  never consulted minimumRoleForPathname(). The ADMIN column was already\n' +
      '  correct, which is why nothing looked wrong from an admin account.'
  )
}

async function main(): Promise<void> {
  console.log('MCV-052 — the per-section admin gate is enforced server-side')

  verifyWiring()
  verifyDeclarations()
  await verifyTreeFloor()
  await verifySections()
  await verifyRailAgreesWithGate()
  await verifyDegradedAndNested()

  printReport()

  console.log(`\nPASS — ${checkCount()} assertions, 0 failures.`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
