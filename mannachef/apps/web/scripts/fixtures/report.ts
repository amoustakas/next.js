// mannachef/apps/web/scripts/fixtures/report.ts

/**
 * How a verification harness talks to the operator reading it.
 *
 * Extracted from `intake-harness.ts` when the MCV-041 harnesses needed the same
 * six functions and the alternative was a second copy of them. The counter
 * behind {@link check} is module state, so keeping one module is also what
 * makes `checkCount()` mean "assertions this run" rather than "assertions this
 * harness happens to have imported a copy of".
 *
 * `intake-harness.ts` re-exports every name here, so the three MCV-040
 * harnesses import exactly what they imported before.
 */

let checks = 0
let scenario = ''

export function section(title: string): void {
  scenario = title
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

/** Run one assertion block. Throws on failure, naming the scenario. */
export function check(label: string, run: () => void): void {
  try {
    run()
    checks += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}`)
    console.error(`  in:  ${scenario}\n`)
    throw error
  }
}

export function note(line: string): void {
  console.log(`       ${line}`)
}

export function checkCount(): number {
  return checks
}

/** Minor units as an operator would read them. `5000` → `$50.00`. */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const whole = Math.floor(Math.abs(cents) / 100)
  const part = (Math.abs(cents) % 100).toString().padStart(2, '0')

  return `${sign}$${whole.toLocaleString('en-CA')}.${part}`
}

/**
 * Print a small table with a rule under the header row.
 *
 * Every harness closes with a before/after comparison, and a shared renderer is
 * the difference between transcripts an operator can put side by side and
 * transcripts that merely resemble each other.
 */
export function printTable(
  title: string,
  rows: readonly (readonly string[])[],
  footnote?: string
): void {
  const width = Math.max(...rows.map((row) => row.length))
  const widths: number[] = []

  for (let column = 0; column < width; column += 1) {
    widths.push(Math.max(...rows.map((row) => (row[column] ?? '').length)))
  }

  console.log(`\n${title}\n`)

  for (const [index, row] of rows.entries()) {
    const cells: string[] = []

    for (let column = 0; column < width; column += 1) {
      cells.push((row[column] ?? '').padEnd(widths[column] ?? 0))
    }

    console.log(`  ${cells.join('  ').trimEnd()}`)

    if (index === 0) {
      console.log(`  ${widths.map((size) => '-'.repeat(size)).join('  ')}`)
    }
  }

  if (footnote !== undefined) {
    console.log(`\n${footnote}`)
  }
}
