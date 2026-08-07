// mannachef/apps/web/scripts/billing-register.mjs

// Installs `action-resolver.mjs` for the process. Used via `node --import`.
//
// No `DATABASE_URL` fallback, for the reason `intake-register.mjs` gives: the
// two MCV-041 harnesses query a real PostgreSQL, and inventing a syntactically
// valid URL would turn "you have not started a database" into a connection
// error thrown from somewhere unhelpful. `assertDisposableDatabase` in
// `fixtures/database.ts` checks for it up front and says so in one line.
//
// `STRIPE_SECRET_KEY` is not set either, and deliberately: the recorder is
// installed into the `globalThis` slot `getStripe()` checks first, so a run
// that reached the key would be a run whose recorder had not been installed —
// and that should fail loudly rather than construct a client pointed at Stripe.
import { register } from 'node:module'

register('./action-resolver.mjs', import.meta.url)
