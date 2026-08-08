// mannachef/apps/web/src/stores/table-preferences-store.ts
'use client'

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { DEFAULT_PAGE_SIZE, type SortDirection } from '@mannachef/validators'

/**
 * How each admin operator likes their tables.
 *
 * Density, page size, hidden columns, and default sort — per table, keyed by a
 * table id the screen chooses (`'admin.appointments'`, `'admin.invoices'`).
 * These are preferences about the *view*, so they persist; the rows themselves
 * are server data and live nowhere near here.
 *
 * Note what is deliberately absent: the current page, the active filters, and
 * the selected rows. Those belong in the URL, so a link to "page 3 of overdue
 * invoices" is a link somebody can send. A preference that would be wrong to
 * restore into a different context is not a preference.
 */

/** One table's remembered view. */
export interface TableViewPreference {
  readonly density: 'comfortable' | 'compact'
  readonly pageSize: number
  /** Column ids the operator has switched off. */
  readonly hiddenColumnIds: readonly string[]
  /** The column this table opens sorted by, if any. */
  readonly sortColumnId: string | null
  readonly sortDirection: SortDirection
}

export const DEFAULT_TABLE_VIEW: TableViewPreference = {
  density: 'comfortable',
  pageSize: DEFAULT_PAGE_SIZE,
  hiddenColumnIds: [],
  sortColumnId: null,
  sortDirection: 'desc',
}

export interface TablePreferencesState {
  readonly views: Readonly<Record<string, TableViewPreference>>

  /** The stored view for a table, or the house default. */
  getView: (tableId: string) => TableViewPreference

  /** Merge a partial change into one table's view. */
  setView: (tableId: string, patch: Partial<TableViewPreference>) => void

  toggleColumn: (tableId: string, columnId: string) => void

  /** Forget one table's preferences, or every table's when `tableId` is absent. */
  resetView: (tableId?: string) => void
}

export interface TablePreferencesPersistedState {
  readonly views: Readonly<Record<string, TableViewPreference>>
}

export const TABLE_PREFERENCES_STORAGE_KEY = 'mannachef.tables.v1'

export const useTablePreferencesStore = create<TablePreferencesState>()(
  persist<
    TablePreferencesState,
    [],
    [],
    TablePreferencesPersistedState
  >(
    (set, get) => ({
      views: {},

      getView: (tableId) => get().views[tableId] ?? DEFAULT_TABLE_VIEW,

      setView: (tableId, patch) => {
        set((state) => {
          const current = state.views[tableId] ?? DEFAULT_TABLE_VIEW

          return {
            views: { ...state.views, [tableId]: { ...current, ...patch } },
          }
        })
      },

      toggleColumn: (tableId, columnId) => {
        set((state) => {
          const current = state.views[tableId] ?? DEFAULT_TABLE_VIEW
          const hidden = new Set(current.hiddenColumnIds)

          if (hidden.has(columnId)) {
            hidden.delete(columnId)
          } else {
            hidden.add(columnId)
          }

          return {
            views: {
              ...state.views,
              [tableId]: { ...current, hiddenColumnIds: [...hidden] },
            },
          }
        })
      },

      resetView: (tableId) => {
        if (tableId === undefined) {
          set({ views: {} })
          return
        }

        set((state) => {
          const next = { ...state.views }
          delete next[tableId]

          return { views: next }
        })
      },
    }),
    {
      name: TABLE_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): TablePreferencesPersistedState => ({
        views: state.views,
      }),
      skipHydration: true,
    }
  )
)

/**
 * Read one table's view as a reactive slice.
 *
 * Selecting the single entry rather than the whole `views` record means a
 * component re-renders when *its* table's preferences change and not when some
 * other screen's do.
 */
export function useTableView(tableId: string): TableViewPreference {
  return useTablePreferencesStore(
    (state) => state.views[tableId] ?? DEFAULT_TABLE_VIEW
  )
}
