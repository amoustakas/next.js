// mannachef/apps/web/scripts/race-register.mjs

// Installs `race-resolver.mjs` for the process. Used via `node --import`.
//
// No `DATABASE_URL` fallback here, unlike `stub-register.mjs`. That harness
// needs a syntactically valid URL for a client it never queries; this one needs
// a URL that reaches a PostgreSQL it is about to hammer, and inventing one
// would turn "you have not started a database" into a connection error thrown
// from somewhere unhelpful. `verify-superadmin-race.ts` checks for it up front
// and says so in one line.
import { register } from 'node:module'

register('./race-resolver.mjs', import.meta.url)
