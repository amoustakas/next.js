// mannachef/apps/web/src/stores/index.ts
'use client'

/**
 * Client-only, OS-level state.
 *
 * Two stores, both about the *interface* rather than the business:
 *
 *  - `useUiStore` — sidebar, command palette, mobile nav.
 *  - `useTablePreferencesStore` — density, page size, hidden columns, default
 *    sort, per admin table.
 *
 * The rule that governs this directory, restated because it is the one that
 * quietly rots an app: **no server data in Zustand.** Appointments, invoices,
 * clients, menu items — those come from the RSC payload or from TanStack Query,
 * both of which can be invalidated when the server changes underneath them. A
 * Zustand store is a module singleton with no notion of freshness and no notion
 * of who is signed in.
 */

import * as React from 'react'

import { useUiStore } from './ui-store'
import { useTablePreferencesStore } from './table-preferences-store'

export {
  useUiStore,
  UI_STORAGE_KEY,
  type UiState,
  type UiPersistedState,
} from './ui-store'

export {
  useTablePreferencesStore,
  useTableView,
  DEFAULT_TABLE_VIEW,
  TABLE_PREFERENCES_STORAGE_KEY,
  type TablePreferencesState,
  type TablePreferencesPersistedState,
  type TableViewPreference,
} from './table-preferences-store'

/**
 * Read persisted preferences out of `localStorage`, once, after mount.
 *
 * Both stores are created with `skipHydration: true`. Without it, the very
 * first render would read `localStorage` — which the server cannot do — and
 * React would find markup that does not match, discard the tree, and re-render
 * it on the client. That is a visible flash and a wasted paint on every single
 * navigation into the shell.
 *
 * With it, the first paint uses the server's defaults and this effect swaps in
 * the operator's preferences on the next tick. Mounted once, in `<Providers>`.
 */
export function useStoreRehydration(): void {
  React.useEffect(() => {
    void useUiStore.persist.rehydrate()
    void useTablePreferencesStore.persist.rehydrate()
  }, [])
}
