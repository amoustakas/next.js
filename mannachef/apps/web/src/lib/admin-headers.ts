// mannachef/apps/web/src/lib/admin-headers.ts

/**
 * The one request header the business OS adds to itself.
 *
 * Declared in its own module because it has exactly two readers that must never
 * drift apart, and they live on opposite sides of the runtime boundary:
 * `src/middleware.ts` writes it on the edge, and `src/server/admin-access.ts`
 * reads it on Node. A string literal repeated in both would fail silently — the
 * layout would simply stop finding the pathname and quietly fall back to the
 * tree-wide floor.
 *
 * @see src/middleware.ts for why a client cannot forge this value.
 */
export const ADMIN_PATHNAME_HEADER = 'x-mannachef-pathname'
