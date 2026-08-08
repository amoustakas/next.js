// mannachef/apps/web/src/app/providers.tsx
'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useStoreRehydration } from '@/stores'

/**
 * Every client-side provider the app needs, mounted once at the root.
 *
 * Kept deliberately thin. This is the only `'use client'` boundary in the
 * layout tree, and everything below it that does not need interactivity stays a
 * Server Component — `<Providers>` renders `{children}` as an opaque slot, so
 * pages passed through it are still server-rendered.
 */

// =============================================================================
// 1. The QueryClient, and why it is created inside a hook
// =============================================================================

/**
 * The house defaults.
 *
 * `staleTime: 60s` — with RSC doing the first fetch, a query that refetches the
 * instant it mounts is duplicating work the server already did. A minute of
 * "fresh" is what makes the client cache a supplement to the server render
 * rather than a race with it.
 *
 * `gcTime: 5m` — long enough that navigating away and back is instant, short
 * enough that a long admin session does not accumulate every list it has ever
 * seen.
 *
 * `refetchOnWindowFocus: false` — an operator alt-tabbing to their email and
 * back should not cause every table on screen to flicker. Freshness after a
 * mutation is the *action's* job, via `revalidatePath`/`revalidateTag` in
 * `withAction`, plus an explicit `invalidateQueries` where a client cache is
 * genuinely involved.
 *
 * `retry` — retrying a 403 or a 404 is pointless and slow, and the seven
 * `ActionErrorCode` values mean the same is true of most of our failures. One
 * retry, only for what might be transient.
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (failureCount >= 1) {
            return false
          }

          // Only a genuinely transient fault is worth a second attempt.
          const message = error instanceof Error ? error.message : ''

          return !/\b(401|403|404|422)\b/.test(message)
        },
      },
      mutations: {
        // Server Actions carry their own result contract and their own error
        // reporting through `useAction`; a silent retry would double-apply a
        // mutation that actually succeeded but whose response was lost.
        retry: false,
      },
    },
  })
}

/**
 * ## The data-leak footgun this `useState` exists to prevent
 *
 * The obvious thing to write is a module-level singleton:
 *
 * ```ts
 * const queryClient = new QueryClient() // ← do not do this
 * export function Providers({ children }) {
 *   return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
 * }
 * ```
 *
 * In a client-only SPA that is fine: the module is evaluated once per browser
 * tab, so the cache belongs to exactly one person.
 *
 * In an app with server rendering it is a security bug. The module is evaluated
 * once per **server process**, and that process renders requests for every
 * signed-in user. A `QueryClient` in module scope is therefore shared across
 * users: a query that runs during the server render of guest A's dashboard —
 * their appointments, their invoices, their address — is written into a cache
 * that is still there when guest B's request is rendered by the same process.
 * B's render then reads A's data straight out of the cache as a fresh hit and
 * puts it in the HTML. No warning, no error; the wrong person's booking history
 * simply appears on the page, and only under production concurrency, which is
 * exactly when nobody is watching.
 *
 * Creating the client inside `useState`'s initialiser makes it **per component
 * instance**, which on the server means per request and in the browser means
 * per tab:
 *
 *  - `useState(() => …)` runs the initialiser once per mount and never again on
 *    re-render, so the client is stable for the life of the tree — the thing a
 *    bare `new QueryClient()` in the component body would get wrong in the
 *    other direction, throwing the cache away on every render and refetching
 *    everything.
 *  - Each server render of `<Providers>` is a fresh mount, so each request gets
 *    its own empty cache and there is nothing for a later request to read.
 *  - Strict Mode's double-invoke is harmless: the initialiser may run twice,
 *    but only one result is kept.
 *
 * The rule, stated once: **a `QueryClient` must never be reachable from module
 * scope.**
 */
export interface ProvidersProps {
  readonly children: React.ReactNode
}

const ReactQueryDevtools = dynamic(
  () =>
    import('@tanstack/react-query-devtools').then(
      (module) => module.ReactQueryDevtools
    ),
  { ssr: false }
)

export function Providers({ children }: ProvidersProps): React.JSX.Element {
  const [queryClient] = React.useState(makeQueryClient)

  // Pull the operator's persisted shell preferences out of localStorage after
  // the first paint. See `useStoreRehydration` for why it cannot happen during
  // render.
  useStoreRehydration()

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250} skipDelayDuration={400}>
        {children}
        <AppToaster />
      </TooltipProvider>
      {process.env.NODE_ENV === 'development' ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      ) : null}
    </QueryClientProvider>
  )
}

// =============================================================================
// 2. Toasts
// =============================================================================

/**
 * `sonner`, dressed in the Luxury Culinary palette.
 *
 * Every surface is `--color-slate-warm` behind a `--color-ash` hairline, with
 * the tone carried by a single left-hand accent rather than a coloured fill —
 * the same restraint the rest of the system applies. The champagne accent is
 * reserved for success, which is the one toast a guest is pleased to see.
 *
 * `richColors` stays off: it would paint whole toasts in saturated greens and
 * reds that belong to a different design language entirely.
 *
 * Positioning is bottom-right on desktop and full-width at the top on mobile,
 * where a bottom toast collides with the home indicator. `closeButton` is on
 * because a toast that can only be dismissed by waiting is not dismissible by
 * someone using a screen reader.
 */
function AppToaster(): React.JSX.Element {
  return (
    <Toaster
      position="bottom-right"
      closeButton
      duration={5000}
      gap={10}
      offset={20}
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast:
            'group !rounded-md !border !border-ash !bg-slate-warm !text-linen !font-sans !shadow-[inset_0_1px_0_rgba(244,240,233,0.05)]',
          title: '!text-sm !font-medium !text-linen',
          description: '!text-xs !leading-relaxed !text-parchment',
          actionButton:
            '!rounded-md !border !border-gold/70 !bg-champagne !text-obsidian !text-xs !font-semibold',
          cancelButton:
            '!rounded-md !border !border-ash !bg-transparent !text-parchment !text-xs',
          closeButton:
            '!border-ash !bg-slate-warm !text-stone hover:!text-linen',
          success: '!border-l-2 !border-l-champagne',
          error: '!border-l-2 !border-l-claret',
          warning: '!border-l-2 !border-l-terracotta',
          info: '!border-l-2 !border-l-stone',
          loading: '!border-l-2 !border-l-stone',
        },
      }}
    />
  )
}
