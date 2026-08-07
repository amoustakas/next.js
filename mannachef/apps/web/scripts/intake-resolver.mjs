// mannachef/apps/web/scripts/intake-resolver.mjs

// The MCV-040 harnesses' loader hook. Its four substitutions turned out to be
// the four every real-database harness needs, so the implementation moved to
// `action-resolver.mjs` when MCV-041 added a second pair; this file stays so
// that `intake-register.mjs` — and anybody who has the name in their fingers —
// keeps working.
export { resolve } from './action-resolver.mjs'
