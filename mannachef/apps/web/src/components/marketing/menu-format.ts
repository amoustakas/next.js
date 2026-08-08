// mannachef/apps/web/src/components/marketing/menu-format.ts

import type { SpiceLevel, TagKind } from '@mannachef/validators'

/**
 * The words the menu uses for the enums the database stores.
 *
 * Every one of these maps is a total `Record` over a union from
 * `@mannachef/validators`, which is the point: adding a member to
 * `spiceLevelSchema` or `tagKindSchema` becomes a compile error here rather than
 * a raw `FIERY` shown to a guest.
 *
 * No component, no directive — importable from the server-rendered dish grid and
 * from the client filter island alike.
 */

/** How heat is described on a menu, rather than how it is stored. */
export const SPICE_LEVEL_LABELS: Readonly<Record<SpiceLevel, string>> = {
  NONE: 'No heat',
  MILD: 'Gently warm',
  MEDIUM: 'Medium heat',
  HOT: 'Hot',
  FIERY: 'Fiery',
}

/** Which spice levels are worth saying out loud on a card. */
export function spiceLevelLabel(level: SpiceLevel): string | null {
  return level === 'NONE' ? null : SPICE_LEVEL_LABELS[level]
}

/** The heading each kind of tag sits under in the filter panel. */
export const TAG_KIND_LABELS: Readonly<Record<TagKind, string>> = {
  DIETARY: 'Dietary',
  ALLERGEN: 'Allergens',
  CUISINE: 'Cuisine',
  TECHNIQUE: 'Technique',
  OCCASION: 'Occasion',
}

const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `3` → `March`. Returns `null` for anything outside 1–12. */
export function monthName(month: number): string | null {
  return MONTH_NAMES[month - 1] ?? null
}

/**
 * "November through February", or `null` when the window is not set.
 *
 * A seasonal window may wrap the turn of the year — `menuItemSeasonalToggleSchema`
 * documents `{ seasonStart: 11, seasonEnd: 2 }` as November through February —
 * so the two months are never compared, only named in the order they were
 * stored.
 */
export function seasonWindowLabel(
  seasonStart: number | null,
  seasonEnd: number | null
): string | null {
  if (seasonStart === null || seasonEnd === null) {
    return null
  }

  const from = monthName(seasonStart)
  const to = monthName(seasonEnd)

  if (from === null || to === null) {
    return null
  }

  return from === to ? from : `${from} through ${to}`
}

/**
 * The quantity line under an ingredient — "180 g, finely sliced".
 *
 * `quantity` arrives as a string because the column is `Decimal(10,3)` and
 * `menuItemIngredientViewSchema` keeps it exact rather than rounding it through
 * a float. Trailing zeros are trimmed so `180.000` reads as `180`.
 */
export function ingredientQuantityLabel(
  quantity: string,
  unit: string,
  preparation: string | null
): string {
  const trimmed = quantity.includes('.')
    ? quantity.replace(/0+$/, '').replace(/\.$/, '')
    : quantity

  const measure = `${trimmed} ${unit.toLowerCase().replace(/_/g, ' ')}`

  return preparation === null ? measure : `${measure}, ${preparation}`
}
