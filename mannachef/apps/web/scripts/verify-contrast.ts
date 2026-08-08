// mannachef/apps/web/scripts/verify-contrast.ts

/**
 * MCV-061 — the semantic colour ramp clears WCAG, and stays clear.
 *
 * ```bash
 * pnpm --filter @mannachef/web verify:contrast
 * ```
 *
 * Exits non-zero on the first failed assertion. Touches no database, no Stripe,
 * no network and no browser: contrast is arithmetic over two sRGB triples, and
 * every input it needs is a hex literal sitting in `src/app/globals.css`.
 *
 * ## The defect this exists to stop coming back
 *
 * A design review computed every ratio in the product by hand and found the
 * semantic ramp failing across the board, on the exact strings that exist to be
 * read in a hurry:
 *
 *     claret     #7c2f35   1.95:1 on slate-warm   every FormMessage in the product
 *     terracotta #9c5b3c   3.35:1 on slate-warm   cancellation + conflict notices
 *     sage       #6e7f63   4.11:1 on slate-warm   positive money, allergy "clear"
 *     bg-sage/12 text-sage        3.62:1          the `success` badge
 *     bg-terracotta/12 …          3.01:1          the `warning` badge
 *     champagne @ 40% ring        2.65:1          every focus ring, everywhere
 *
 * None of those numbers is discoverable by looking at a component. They are
 * properties of a *pair*, they change when alpha is involved, and the token
 * names give no hint — `text-claret` looks exactly as safe as `text-linen` in a
 * class list. That is why this is a script and not a style-guide paragraph: the
 * only durable form of "remember to check the ratio" is a program that checks
 * the ratio.
 *
 * ## What it asserts, and why each part is needed
 *
 *  - **Part A — the palette parses and the ramp exists.** Reads the `@theme`
 *    block and asserts the base surfaces still hold the values CONTRACT.md §3
 *    fixes, so a darkened surface cannot silently invalidate every row below.
 *
 *  - **Part B — the documented budget is the computed budget.** `globals.css`
 *    carries a BUDGET comment block listing every text/surface pair the product
 *    renders. This recomputes all of them from the parsed hexes and fails if a
 *    written figure disagrees with the arithmetic, or if any pair is under
 *    4.5:1. That makes the comment block load-bearing: edit a token without
 *    regenerating the table and the build breaks, rather than the table quietly
 *    becoming a lie. A comment nobody can trust is worse than no comment.
 *
 *  - **Part C — the focus ring is solid and clears 3:1.** Parses the
 *    `:focus-visible` rule out of `globals.css` and `FOCUS_RING` /
 *    `FOCUS_RING_WITHIN` out of `src/lib/utils.ts`, and fails on any alpha at
 *    all. Alpha is the whole defect: champagne is 9.08:1 solid and 2.65:1 at
 *    40%, and no amount of care with the token's nominal figure catches that.
 *
 *  - **Part D — source scan.** Parts A–C prove the *tokens* are sound. They
 *    cannot tell whether a component still uses the failing one, so this walks
 *    `src/` and fails on `text-claret` / `text-sage` / `text-terracotta` (the
 *    surface-weight tokens, now illegal as text), on any alpha ring, on a ring
 *    that is not a palette token, on `bg-ash` beside `text-stone` (the one
 *    documented exclusion in the budget, enforced instead of promised), and on
 *    a ring drawn flush against a background of the same token, which is a 1:1
 *    edge and therefore not an indicator at all.
 *
 * Parts A–C without D would stay green while the ramp went unused; D without
 * A–C would police names while the values rotted underneath them. Both halves
 * are load-bearing.
 *
 * ## Method
 *
 * WCAG 2.x relative luminance, verbatim from the spec: each sRGB channel is
 * normalised to 0–1, linearised through the piecewise transfer function
 * (`c/12.92` below the 0.04045 knee, `((c+0.055)/1.055)^2.4` above it), then
 * weighted 0.2126 / 0.7152 / 0.0722. Contrast is `(Lhi + 0.05) / (Llo + 0.05)`.
 *
 * The one thing worth stating plainly, because it is what the product got
 * wrong: **a translucent colour has no contrast of its own.** `bg-sage/12` is
 * not sage, and a ratio quoted against sage is meaningless. Every alpha here is
 * composited over its real parent surface first — simple source-over in sRGB,
 * `fg*a + bg*(1-a)`, which is what a browser does for a flat opaque parent —
 * and the ratio is taken against that composited value.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// =============================================================================
// Paths
// =============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const GLOBALS_CSS = path.join(APP_ROOT, 'src/app/globals.css')
const UTILS_TS = path.join(APP_ROOT, 'src/lib/utils.ts')
const SRC_DIR = path.join(APP_ROOT, 'src')

/** Text under 24px (or 19px bold) — WCAG 2.x SC 1.4.3. */
const TEXT_THRESHOLD = 4.5

/** Focus rings and other non-text state indicators — WCAG 2.x SC 1.4.11. */
const NON_TEXT_THRESHOLD = 3

/**
 * The surface tokens CONTRACT.md §3 fixes. Pinned here so that darkening or
 * lightening a ground re-runs every ratio in the budget instead of silently
 * shifting the floor under it.
 */
const PINNED_SURFACES: ReadonlyArray<readonly [string, string]> = [
  ['obsidian', '#0b0a09'],
  ['charcoal', '#121110'],
  ['slate-warm', '#1a1817'],
  ['ash', '#26231f'],
]

/** The lifted text siblings introduced by MCV-061. */
const INK_TOKENS = ['sage-ink', 'terracotta-ink', 'claret-ink'] as const

/** The surface-weight tokens those replaced. Illegal as `text-*` from now on. */
const SURFACE_WEIGHT_TOKENS = ['sage', 'terracotta', 'claret'] as const

// =============================================================================
// Failure accounting
// =============================================================================

const failures: string[] = []
let assertions = 0

function check(condition: boolean, message: string): void {
  assertions += 1
  if (!condition) {
    failures.push(message)
  }
}

// =============================================================================
// WCAG 2.x colour maths
// =============================================================================

type Rgb = readonly [number, number, number]

function parseHex(hex: string): Rgb {
  const body = hex.trim().replace(/^#/, '')

  if (!/^[0-9a-fA-F]{6}$/.test(body)) {
    throw new Error(`Not a 6-digit hex colour: ${JSON.stringify(hex)}`)
  }

  const channel = (offset: number): number => {
    const pair = body.slice(offset, offset + 2)
    return Number.parseInt(pair, 16)
  }

  return [channel(0), channel(2), channel(4)]
}

function toHex(rgb: Rgb): string {
  const part = (value: number): string => {
    const clamped = Math.min(255, Math.max(0, Math.round(value)))
    return clamped.toString(16).padStart(2, '0')
  }

  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`
}

/** The sRGB → linear-light transfer function, exactly as WCAG 2.x states it. */
function linearise(channel8Bit: number): number {
  const c = channel8Bit / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * linearise(rgb[0]) +
    0.7152 * linearise(rgb[1]) +
    0.0722 * linearise(rgb[2])
  )
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Source-over compositing of `fg` at `alpha` onto an opaque `bg`.
 *
 * This is the step the product skipped. `bg-sage/12` never puts sage on screen;
 * it puts this result on screen, and this result is what a ratio must be taken
 * against.
 *
 * The result is quantised to 8 bits per channel, which is not a rounding
 * convenience — it is the physical fact. A compositor writes integers into a
 * framebuffer, so the colour the eye receives from `bg-sage/12 on ash` is
 * exactly #2f2e27 and nothing finer. Measuring the un-quantised intermediate
 * instead moves the published ratios by up to ±0.06, which is enough to make
 * the BUDGET block in globals.css disagree with this script over figures that
 * are supposed to be re-derivable by hand from the hexes it prints. Quantising
 * here keeps "the hex in the table" and "the ratio in the table" the same
 * measurement.
 */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const channel = (index: 0 | 1 | 2): number =>
    Math.round(fg[index] * alpha + bg[index] * (1 - alpha))

  return [channel(0), channel(1), channel(2)]
}

// =============================================================================
// Part A — parse the palette out of globals.css
// =============================================================================

const globalsCss = readFileSync(GLOBALS_CSS, 'utf8')
const utilsTs = readFileSync(UTILS_TS, 'utf8')

/**
 * Every `--color-<name>: #rrggbb;` in the file.
 *
 * Deliberately ignores `var()` aliases (`--color-destructive: var(--color-claret)`)
 * — an alias has no colour of its own, and resolving them would invite the same
 * mistake this script exists to catch: reasoning about a name instead of a value.
 */
function parsePalette(css: string): ReadonlyMap<string, Rgb> {
  const palette = new Map<string, Rgb>()
  const pattern = /^\s*--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gm

  for (const match of css.matchAll(pattern)) {
    const name = match[1]
    const value = match[2]

    if (name === undefined || value === undefined) {
      continue
    }

    palette.set(name, parseHex(value))
  }

  return palette
}

const palette = parsePalette(globalsCss)

function tokenOrThrow(name: string): Rgb {
  const value = palette.get(name)

  if (value === undefined) {
    throw new Error(
      `globals.css declares no --color-${name}. ` +
        `Known tokens: ${[...palette.keys()].sort().join(', ')}`
    )
  }

  return value
}

function verifyPalette(): void {
  check(
    palette.size > 0,
    `Parsed no --color-* tokens out of ${GLOBALS_CSS}. The @theme block moved or the ` +
      `declaration syntax changed; this script's regex needs updating with it.`
  )

  for (const entry of PINNED_SURFACES) {
    const [name, expected] = entry
    const actual = palette.get(name)

    check(
      actual !== undefined && toHex(actual) === expected,
      `Surface --color-${name} is ${actual === undefined ? 'missing' : toHex(actual)}, ` +
        `expected ${expected} (CONTRACT.md §3). Every ratio in the BUDGET block is ` +
        `computed against these grounds — changing one invalidates the whole table, ` +
        `so regenerate it and update PINNED_SURFACES in this script together.`
    )
  }

  for (const name of INK_TOKENS) {
    check(
      palette.has(name),
      `globals.css declares no --color-${name}. The MCV-061 text ramp is incomplete: ` +
        `every surface-weight token needs a lifted sibling that is legal as text.`
    )
  }
}

// =============================================================================
// Surface expressions
// =============================================================================

/**
 * A background as the BUDGET block writes it: either a bare token (`ash`) or a
 * wash (`sage/12 on ash` — `--color-sage` at 12% alpha over `--color-ash`).
 */
function resolveSurface(expression: string): Rgb {
  const wash = /^([a-z0-9-]+)\/(\d+)\s+on\s+([a-z0-9-]+)$/.exec(
    expression.trim()
  )

  if (wash !== null) {
    const [, tint, percent, ground] = wash

    if (tint === undefined || percent === undefined || ground === undefined) {
      throw new Error(`Unparseable surface expression: ${expression}`)
    }

    return composite(
      tokenOrThrow(tint),
      Number.parseInt(percent, 10) / 100,
      tokenOrThrow(ground)
    )
  }

  return tokenOrThrow(expression.trim())
}

// =============================================================================
// Part B — the documented budget must equal the computed budget
// =============================================================================

interface BudgetRow {
  readonly kind: 'BUDGET' | 'RING'
  readonly text: string
  readonly surface: string
  readonly documentedHex: string
  readonly documentedRatio: number
  readonly documentedVerdict: string
  readonly computedHex: string
  readonly computedRatio: number
  readonly threshold: number
  readonly ok: boolean
}

function parseBudget(css: string): BudgetRow[] {
  const pattern =
    /^\s*\*\s*(BUDGET|RING)\s*\|\s*([a-z0-9-]+)\s*\|\s*(.+?)\s*\|\s*(#[0-9a-fA-F]{6})\s*\|\s*([\d.]+):1\s*\|\s*(PASS|FAIL)\s*$/gm

  const rows: BudgetRow[] = []

  for (const match of css.matchAll(pattern)) {
    const [, kind, text, surface, documentedHex, ratio, verdict] = match

    if (
      kind === undefined ||
      text === undefined ||
      surface === undefined ||
      documentedHex === undefined ||
      ratio === undefined ||
      verdict === undefined
    ) {
      continue
    }

    const background = resolveSurface(surface)
    const computedRatio = contrastRatio(tokenOrThrow(text), background)
    const threshold = kind === 'RING' ? NON_TEXT_THRESHOLD : TEXT_THRESHOLD

    rows.push({
      kind: kind === 'RING' ? 'RING' : 'BUDGET',
      text,
      surface,
      documentedHex: documentedHex.toLowerCase(),
      documentedRatio: Number.parseFloat(ratio),
      documentedVerdict: verdict,
      computedHex: toHex(background),
      computedRatio,
      threshold,
      ok: computedRatio >= threshold,
    })
  }

  return rows
}

const budgetRows = parseBudget(globalsCss)

function verifyBudget(): void {
  check(
    budgetRows.length >= 40,
    `Parsed only ${budgetRows.length} BUDGET/RING rows out of globals.css; expected the ` +
      `full ledger. Either the block was truncated or its row format drifted from ` +
      `"BUDGET | <text> | <surface> | <hex> | <ratio>:1 | <verdict>".`
  )

  for (const row of budgetRows) {
    const label = `${row.text} on ${row.surface}`

    check(
      row.computedHex === row.documentedHex,
      `${label}: globals.css documents the composited background as ${row.documentedHex}, ` +
        `but compositing it now yields ${row.computedHex}. A token moved underneath the ` +
        `table — regenerate the BUDGET block.`
    )

    check(
      Math.abs(row.computedRatio - row.documentedRatio) < 0.005,
      `${label}: globals.css documents ${row.documentedRatio.toFixed(2)}:1, computed ` +
        `${row.computedRatio.toFixed(2)}:1. The table has drifted from the tokens; ` +
        `regenerate the BUDGET block rather than editing the number by hand.`
    )

    check(
      row.ok,
      `${label}: ${row.computedRatio.toFixed(2)}:1 against ${row.computedHex}, under the ` +
        `${row.threshold}:1 required for ${row.kind === 'RING' ? 'a non-text indicator (SC 1.4.11)' : 'small text (SC 1.4.3)'}. ` +
        `Lift the text token; do not lower the threshold.`
    )

    check(
      row.documentedVerdict === (row.ok ? 'PASS' : 'FAIL'),
      `${label}: the table says ${row.documentedVerdict} but the arithmetic says ` +
        `${row.ok ? 'PASS' : 'FAIL'}.`
    )
  }

  // Every lifted token must actually appear in the ledger — a token nobody
  // measured is a token nobody has checked.
  for (const name of INK_TOKENS) {
    check(
      budgetRows.some((row) => row.text === name),
      `--color-${name} has no BUDGET row. Add it to the block in globals.css so its ` +
        `worst-case surface is recorded rather than assumed.`
    )
  }
}

// =============================================================================
// Part C — the focus ring is solid, and clears 3:1 on every surface
// =============================================================================

interface RingFinding {
  readonly source: string
  readonly token: string
  readonly worstSurface: string
  readonly worstRatio: number
}

const ringFindings: RingFinding[] = []

function measureRing(source: string, token: string): void {
  const ring = tokenOrThrow(token)

  let worstSurface = ''
  let worstRatio = Number.POSITIVE_INFINITY

  for (const entry of PINNED_SURFACES) {
    const [name] = entry
    const ratio = contrastRatio(ring, tokenOrThrow(name))

    if (ratio < worstRatio) {
      worstRatio = ratio
      worstSurface = name
    }
  }

  ringFindings.push({ source, token, worstSurface, worstRatio })

  check(
    worstRatio >= NON_TEXT_THRESHOLD,
    `${source}: ring token "${token}" is ${worstRatio.toFixed(2)}:1 on ${worstSurface}, ` +
      `under the ${NON_TEXT_THRESHOLD}:1 WCAG SC 1.4.11 requires of a focus indicator.`
  )
}

function verifyGlobalFocusRing(): void {
  const block = /:focus-visible\s*\{([^}]*)\}/.exec(globalsCss)

  check(
    block !== null,
    `globals.css has no ":focus-visible { … }" base rule. That rule is the product-wide ` +
      `floor for keyboard visibility; without it every ring depends on a primitive ` +
      `remembering to compose FOCUS_RING.`
  )

  if (block === null) {
    return
  }

  const body = block[1] ?? ''
  const boxShadow = /box-shadow:\s*([^;]+);/.exec(body)

  check(
    boxShadow !== null,
    `globals.css ":focus-visible" declares no box-shadow, so the rule sets "outline: none" ` +
      `without putting an indicator back. That removes the ring entirely.`
  )

  if (boxShadow === null) {
    return
  }

  const value = boxShadow[1] ?? ''

  check(
    !/color-mix/i.test(value) && !/rgba?\(/i.test(value),
    `globals.css ":focus-visible" box-shadow is "${value.trim()}", which blends the ring ` +
      `with the surface. CONTRACT.md §3 requires SOLID champagne: at 40% alpha this ` +
      `composited to 2.64–2.69:1 against the very surfaces it was drawn on, under the ` +
      `3:1 of SC 1.4.11. A token's nominal contrast does not survive alpha.`
  )

  const tokenRef = /var\(\s*--color-([a-z0-9-]+)\s*\)/.exec(value)

  check(
    tokenRef !== null,
    `globals.css ":focus-visible" box-shadow "${value.trim()}" does not reference a palette ` +
      `token. CONTRACT.md §3 forbids hardcoded hex in favour of the token names.`
  )

  if (tokenRef !== null && tokenRef[1] !== undefined) {
    measureRing('globals.css :focus-visible', tokenRef[1])
  }
}

function verifyFocusRingConstants(): void {
  for (const name of ['FOCUS_RING', 'FOCUS_RING_WITHIN']) {
    const declaration = new RegExp(
      `export const ${name}\\s*(?::[^=]*)?=\\s*'([^']*)'`
    ).exec(utilsTs)

    check(
      declaration !== null,
      `src/lib/utils.ts no longer exports ${name} as a single-quoted string literal. Every ` +
        `primitive in @/components/ui composes it; if it moves, this check must move too.`
    )

    if (declaration === null) {
      continue
    }

    const classes = declaration[1] ?? ''
    const ringClass =
      /(?:focus-visible|focus-within):ring-([a-z][a-z0-9-]*)(\/(\d+))?/.exec(
        classes
      )

    check(
      ringClass !== null,
      `${name} declares no focus ring colour: "${classes}".`
    )

    if (ringClass === null) {
      continue
    }

    check(
      ringClass[3] === undefined,
      `${name} uses "ring-${ringClass[1] ?? ''}/${ringClass[3] ?? ''}". CONTRACT.md §3 ` +
        `requires a SOLID ring — champagne at 40% is 2.65:1 against every surface here, ` +
        `while solid champagne is 9.08:1 at worst. Drop the alpha.`
    )

    if (ringClass[1] !== undefined && ringClass[3] === undefined) {
      measureRing(`src/lib/utils.ts ${name}`, ringClass[1])
    }
  }
}

// =============================================================================
// Part D — source scan
// =============================================================================

/**
 * Every `.ts`/`.tsx` under `src/`.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') {
        continue
      }
      out.push(...sourceFiles(full))
      continue
    }

    if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }

  return out
}

/**
 * Quoted string literals, with the line they start on.
 *
 * A class list is the unit that matters for the co-occurrence rules below: two
 * utilities only fight if they land on the same element. A single literal is
 * the conservative approximation of that — it never conflates two elements,
 * though a `cn()` call that splits one element's classes across several
 * literals is checked per-fragment rather than as a whole. Under-reporting is
 * the right failure direction for a rule that blocks a build.
 */
function classListLiterals(source: string): ReadonlyArray<{
  readonly text: string
  readonly line: number
}> {
  const out: { text: string; line: number }[] = []
  const pattern = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g

  for (const match of source.matchAll(pattern)) {
    const text = match[1] ?? match[2] ?? match[3]

    if (
      text === undefined ||
      !/(?:^|[\s:[])(?:text|bg|ring|border)-/.test(text)
    ) {
      continue
    }

    const line = source.slice(0, match.index).split('\n').length
    out.push({ text, line })
  }

  return out
}

function relative(file: string): string {
  return path.relative(APP_ROOT, file)
}

function verifySource(): void {
  const files = sourceFiles(SRC_DIR)

  check(
    files.length > 0,
    `Found no source files under ${SRC_DIR}; the scan would pass vacuously.`
  )

  // A surface-weight token used as text, e.g. `text-claret` (but not
  // `text-claret-ink`). This is the original defect, in its exact written form.
  const bannedText = new RegExp(
    `(?:^|[\\s:\\[])text-(${SURFACE_WEIGHT_TOKENS.join('|')})(?![\\w-])`
  )

  // Any ring carrying alpha, e.g. `ring-champagne/40`.
  const alphaRing = /(?:^|[\s:[])ring-([a-z][a-z0-9-]*)\/(\d+)/

  // Any ring colour at all, so it can be checked against the palette.
  const anyRing = /(?:^|[\s:[])ring-([a-z][a-z0-9-]*)(?![\w-])/g

  for (const file of files) {
    if (file === UTILS_TS) {
      // Its two ring constants are checked precisely in Part C; its prose
      // quotes the old broken class names on purpose.
      continue
    }

    const source = readFileSync(file, 'utf8')

    for (const literal of classListLiterals(source)) {
      const where = `${relative(file)}:${literal.line}`
      const classes = literal.text

      const banned = bannedText.exec(classes)
      check(
        banned === null,
        `${where}: uses "text-${banned?.[1] ?? ''}". That token is surface-weight and is not ` +
          `legible as text — claret is 1.95:1 on slate-warm, terracotta 3.35:1, sage 4.11:1. ` +
          `Use "text-${banned?.[1] ?? ''}-ink". Keep the base token for borders and fills.`
      )

      const alpha = alphaRing.exec(classes)
      check(
        alpha === null,
        `${where}: uses "ring-${alpha?.[1] ?? ''}/${alpha?.[2] ?? ''}". A translucent ring ` +
          `composites toward its surface and loses the contrast the token appears to have. ` +
          `CONTRACT.md §3 requires a solid ring.`
      )

      for (const ring of classes.matchAll(anyRing)) {
        const token = ring[1]

        if (token === undefined || token === 'inset' || /^\d/.test(token)) {
          continue
        }

        if (token.startsWith('offset-')) {
          const offsetToken = token.slice('offset-'.length)

          check(
            /^\d/.test(offsetToken) || palette.has(offsetToken),
            `${where}: "ring-offset-${offsetToken}" is neither a width nor a palette token.`
          )
          continue
        }

        check(
          palette.has(token),
          `${where}: "ring-${token}" is not a palette token declared in globals.css. ` +
            `CONTRACT.md §3 forbids colours that live outside the design system.`
        )

        if (palette.has(token)) {
          // A ring drawn flush against a background of the same token is a 1:1
          // edge — a wider element, not an indicator. An offset in a different
          // token puts a contrasting gap between them and makes it a ring again.
          const flush = new RegExp(`(?:^|[\\s:\\[])bg-${token}(?![\\w-])`).test(
            classes
          )
          const offsetMatch =
            /(?:^|[\s:[])ring-offset-([a-z][a-z0-9-]*)(?![\w-])/.exec(classes)
          const offsetToken = offsetMatch?.[1]
          const separated =
            offsetToken !== undefined &&
            palette.has(offsetToken) &&
            offsetToken !== token

          check(
            !flush || separated,
            `${where}: "ring-${token}" is drawn flush against "bg-${token}" — the indicator ` +
              `and the thing it indicates are the same colour, which is a 1:1 edge and no ` +
              `indicator at all (SC 1.4.11 wants 3:1 against adjacent colours). Add a ` +
              `"ring-offset-<surface>" so the page ground separates them.`
          )
        }
      }

      // The one exclusion the BUDGET block documents, enforced rather than
      // promised: stone is 4.18:1 on bare ash and only survives because no
      // ash panel carries stone text.
      const stoneOnAsh =
        /(?:^|[\s:[])bg-ash(?![\w-/])/.test(classes) &&
        /(?:^|[\s:[])text-stone(?![\w-])/.test(classes)

      check(
        !stoneOnAsh,
        `${where}: puts "text-stone" on "bg-ash". That pair is 4.18:1 — under 4.5:1 — and is ` +
          `the exclusion the BUDGET block in globals.css relies on never happening. Use ` +
          `text-parchment (9.32:1) or text-linen (13.77:1) on an ash panel, or lift stone ` +
          `the way sage/terracotta/claret were lifted.`
      )
    }
  }
}

// =============================================================================
// Reporting
// =============================================================================

function printTable(): void {
  const columns = [
    'text token',
    'surface expression',
    'composited',
    'ratio',
    'need',
    '',
  ]
  const rows = budgetRows.map((row) => [
    row.text,
    row.surface,
    row.computedHex,
    `${row.computedRatio.toFixed(2)}:1`,
    `${row.threshold.toFixed(1)}:1`,
    row.ok ? 'PASS' : 'FAIL',
  ])

  const widths = columns.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length))
  )

  const line = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0
        return index === 3 || index === 4
          ? cell.padStart(width)
          : cell.padEnd(width)
      })
      .join('  ')
      .trimEnd()

  console.log('\nContrast budget — every text/surface pair the product renders')
  console.log(line(columns))
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '))

  let previous = ''
  for (const row of rows) {
    const token = row[0] ?? ''
    if (previous !== '' && token !== previous) {
      console.log('')
    }
    previous = token
    console.log(line(row))
  }

  console.log(
    '\nFocus / state rings — solid tokens, worst surface (SC 1.4.11, need 3:1)'
  )
  for (const finding of ringFindings) {
    console.log(
      `  ${finding.source.padEnd(34)} ring-${finding.token.padEnd(14)} ` +
        `${finding.worstRatio.toFixed(2).padStart(6)}:1 on ${finding.worstSurface}`
    )
  }

  console.log(
    '\n  For the record, what these replaced: champagne at 40% composited to\n' +
      '  #5d5443–#6d6350 and measured 2.64–2.69:1 against the surface it was drawn\n' +
      '  on; claret at 40% on an invalid input measured 1.20–1.25:1. Neither was\n' +
      '  visible as an indicator, and neither figure is guessable from the token.'
  )
}

// =============================================================================
// Entry point
// =============================================================================

function main(): void {
  console.log('MCV-061 — the semantic colour ramp clears WCAG 2.x')

  verifyPalette()
  verifyBudget()
  verifyGlobalFocusRing()
  verifyFocusRingConstants()
  verifySource()

  printTable()

  if (failures.length > 0) {
    console.error(
      `\nFAIL — ${failures.length} of ${assertions} assertions failed:\n`
    )
    for (const failure of failures) {
      console.error(`  • ${failure}\n`)
    }
    process.exitCode = 1
    return
  }

  console.log(`\nPASS — ${assertions} assertions, 0 failures.`)
}

main()
