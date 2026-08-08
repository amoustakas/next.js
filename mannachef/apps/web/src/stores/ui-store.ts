// mannachef/apps/web/src/stores/ui-store.ts
'use client'

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * OS-level chrome state.
 *
 * ## What belongs in here, and what emphatically does not
 *
 * This store holds **only** state that describes the shell: is the sidebar
 * collapsed, is the command palette open, is the mobile nav showing. Three
 * properties of the *window*, not of the business.
 *
 * Server data does not go in Zustand. Not a client list, not an appointment,
 * not "the invoice we just loaded". Server data lives in the RSC payload or in
 * TanStack Query, both of which know how to invalidate it; a copy in Zustand
 * knows nothing, goes stale silently, and — because a Zustand store is a module
 * singleton — would be shared across every component tree in the process. On a
 * server that is a cross-request leak; in the browser it is simply a lie that
 * outlives the page that made it.
 *
 * The test to apply before adding a field: *would this be wrong if it survived
 * a sign-out?* If yes, it is not shell state.
 *
 * ## Hydration
 *
 * `skipHydration: true`, because reading `localStorage` during the first render
 * of a server-rendered tree produces markup the server could not have produced,
 * and React replaces the whole subtree. Rehydration is instead kicked off once,
 * in an effect, by `<Providers>`; the first paint shows the server's defaults
 * and the stored preference lands a tick later. See `useStoreRehydration`.
 */

/** Everything the shell knows about itself. */
export interface UiState {
  // --- Sidebar (persisted) --------------------------------------------------

  /** Admin sidebar rail collapsed to icons. */
  readonly sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void

  // --- Command palette (ephemeral) ------------------------------------------

  /** The ⌘K palette. Never persisted — nobody wants it open on reload. */
  readonly commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void

  // --- Mobile navigation (ephemeral) ----------------------------------------

  readonly mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void

  /** Close every transient overlay. Call it on route change. */
  closeOverlays: () => void
}

/** The subset written to storage. */
export interface UiPersistedState {
  readonly sidebarCollapsed: boolean
}

export const UI_STORAGE_KEY = 'mannachef.ui.v1'

export const useUiStore = create<UiState>()(
  persist<UiState, [], [], UiPersistedState>(
    (set) => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: (collapsed) => {
        set({ sidebarCollapsed: collapsed })
      },
      toggleSidebar: () => {
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
      },

      commandPaletteOpen: false,
      setCommandPaletteOpen: (open) => {
        set({ commandPaletteOpen: open })
      },
      toggleCommandPalette: () => {
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen }))
      },

      mobileNavOpen: false,
      setMobileNavOpen: (open) => {
        set({ mobileNavOpen: open })
      },

      closeOverlays: () => {
        set({ commandPaletteOpen: false, mobileNavOpen: false })
      },
    }),
    {
      name: UI_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): UiPersistedState => ({
        sidebarCollapsed: state.sidebarCollapsed,
      }),
      skipHydration: true,
    }
  )
)
