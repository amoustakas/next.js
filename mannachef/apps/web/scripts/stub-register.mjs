// mannachef/apps/web/scripts/stub-register.mjs

// Installs `stub-resolver.mjs` for the process. Used via `node --import`.
import { register } from 'node:module'

// `fixtures/db-stub.ts` re-exports the **real** `Prisma` namespace from
// `@mannachef/db`, because two `instanceof Prisma.PrismaClientKnownRequestError`
// comparisons in the code under test would be silently false against a
// home-made class. That module's scope constructs a `PrismaClient`, which
// requires a syntactically valid `DATABASE_URL` — so one is supplied here when
// the environment has none. No query is ever issued against it: every model the
// harness touches is served by `fixtures/fake-db.ts`, and a real connection
// attempt would fail loudly rather than quietly reach a database.
process.env.DATABASE_URL ??=
  'postgresql://harness:harness@127.0.0.1:5432/mannachef_harness?schema=public'

register('./stub-resolver.mjs', import.meta.url)
