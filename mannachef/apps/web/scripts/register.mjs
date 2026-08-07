// mannachef/apps/web/scripts/register.mjs

// Installs `ts-resolver.mjs` for the process. Used via `node --import`.
import { register } from 'node:module'

register('./ts-resolver.mjs', import.meta.url)
