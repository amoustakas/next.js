// mannachef/apps/web/scripts/intake-register.mjs

// Installs `intake-resolver.mjs` for the process. Used via `node --import`.
//
// No `DATABASE_URL` fallback here, for the reason `race-register.mjs` gives:
// these three harnesses query a real PostgreSQL, and inventing a syntactically
// valid URL would turn "you have not started a database" into a connection
// error thrown from somewhere unhelpful. `assertDisposableDatabase` in
// `fixtures/intake-harness.ts` checks for it up front and says so in one line.
import { register } from 'node:module'

register('./intake-resolver.mjs', import.meta.url)
