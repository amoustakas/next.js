// mannachef/apps/web/src/components/portal/menu-selection-board.tsx
'use client'

/**
 * The week's dishes, chosen against a plan's allowance.
 *
 * ## The allowance is enforced, and it is explained
 *
 * `mealsPerWeek` comes from the household's own plan and is the only limit here.
 * Two things follow from it, and both matter:
 *
 *  1. **Enforced.** Once the allowance is spent, every unchosen dish is
 *     `disabled`. Radix renders that as `aria-disabled` on a real control, so a
 *     keyboard or screen-reader user meets the same limit a mouse user does
 *     rather than tabbing into a box that silently refuses to tick.
 *  2. **Explained.** A control that stops working without saying why reads as a
 *     bug. The count is stated permanently ("2 of 4 chosen"), the boundary is
 *     stated in prose before it is reached, and the disabled rows carry the
 *     reason — so the limit is never a surprise, and never anonymous.
 *
 * The count is `aria-live="polite"`: it changes as a consequence of choosing
 * rather than at the caret, so a screen-reader user is told the new total
 * without being interrupted mid-word.
 *
 * ## Why "Save" is not on this screen
 *
 * Because there is nothing to save to. The schema has no weekly-selection
 * model, so `ACTIONS-INDEX.md` has no action to call, and a Save button that
 * wrote nowhere would be the one genuinely dangerous thing this page could do —
 * a household would believe the kitchen had been told, and would find out
 * otherwise at dinner.
 *
 * Dishes do attach to a *service* — `AppointmentMenuItem` — so the composed
 * week is carried to the engagement, which is where the kitchen actually reads
 * it. That is the honest handoff, and the button says exactly that.
 *
 * When a `menuSelection.*` action lands, this component is the only thing that
 * changes: `chosen` is already the payload, and `useAction` is the pattern the
 * rest of the portal's forms use.
 */

import * as React from 'react'
import Link from 'next/link'

import type { SpiceLevel } from '@mannachef/validators'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Money } from '@/components/ui/money'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/** One dish, trimmed to what a chooser needs to decide. */
export interface SelectableDish {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly categoryName: string
  readonly basePriceCents: number
  readonly currency: string
  readonly spiceLevel: SpiceLevel
  readonly isSeasonal: boolean
  readonly isSignature: boolean
}

export interface MenuSelectionBoardProps {
  readonly planName: string
  /** The allowance. Always the plan's own figure, never a constant. */
  readonly mealsPerWeek: number
  readonly servingsPerMeal: number
  readonly dishes: readonly SelectableDish[]
}

/** Heat, where it is worth saying. `NONE` and `MILD` are not worth a badge. */
const SPICE_LABELS: Partial<Record<SpiceLevel, string>> = {
  MEDIUM: 'Medium heat',
  HOT: 'Hot',
  FIERY: 'Fiery',
}

export function MenuSelectionBoard({
  planName,
  mealsPerWeek,
  servingsPerMeal,
  dishes,
}: MenuSelectionBoardProps): React.JSX.Element {
  const [chosen, setChosen] = React.useState<readonly string[]>([])

  const remaining = mealsPerWeek - chosen.length
  const isFull = remaining <= 0

  const toggle = React.useCallback(
    (dishId: string) => {
      setChosen((current) => {
        if (current.includes(dishId)) {
          return current.filter((id) => id !== dishId)
        }

        // The guard is here as well as on the control, so the limit holds even
        // if a disabled box is somehow actuated.
        if (current.length >= mealsPerWeek) {
          return current
        }

        return [...current, dishId]
      })
    },
    [mealsPerWeek]
  )

  const chosenDishes = dishes.filter((dish) => chosen.includes(dish.id))

  return (
    <div className="flex flex-col gap-8">
      {/*
        The allowance, stated before anything can be chosen. One champagne
        element in this group — the count — per CONTRACT.md §3.
      */}
      <Card as="section" variant="elevated" aria-labelledby="allowance-heading">
        <CardContent className="flex flex-col gap-4 p-6">
          <h3
            id="allowance-heading"
            className="font-display text-xl font-light text-linen"
          >
            {`Your ${planName} plan`}
          </h3>

          <p
            aria-live="polite"
            className="font-sans text-3xl font-semibold text-champagne tabular-nums"
          >
            {`${String(chosen.length)} of ${String(mealsPerWeek)} chosen`}
          </p>

          <p className="max-w-2xl font-sans text-sm leading-relaxed text-parchment">
            {`Your plan covers ${String(mealsPerWeek)} meal${
              mealsPerWeek === 1 ? '' : 's'
            } a week, ${String(servingsPerMeal)} serving${
              servingsPerMeal === 1 ? '' : 's'
            } each. `}
            {isFull
              ? 'That is the full week. To swap something in, take one out first — the rest of the list stays visible so you can see what you are choosing between.'
              : `Choose ${String(remaining)} more, or fewer if you would rather. Nothing obliges you to spend the whole allowance in one week.`}
          </p>
        </CardContent>
      </Card>

      <section
        aria-labelledby="catalogue-heading"
        className="flex flex-col gap-4"
      >
        <h3
          id="catalogue-heading"
          className="font-display text-2xl font-light text-linen"
        >
          The dishes
        </h3>

        <ul className="flex flex-col gap-3">
          {dishes.map((dish) => {
            const isChosen = chosen.includes(dish.id)
            // Full weeks lock only what is *not* already chosen — taking a dish
            // back out has to stay possible, or the week cannot be revised.
            const isLocked = isFull && !isChosen
            const inputId = `dish-${dish.id}`
            const describedBy = `${inputId}-detail`
            const spice = SPICE_LABELS[dish.spiceLevel]

            return (
              <Card
                as="li"
                key={dish.id}
                variant={isChosen ? 'accent' : 'default'}
                className={cn(
                  'transition-[border-color,opacity] duration-200 ease-luxe',
                  isLocked && 'opacity-60'
                )}
              >
                <CardContent className="flex items-start gap-4 p-5">
                  <Checkbox
                    id={inputId}
                    checked={isChosen}
                    disabled={isLocked}
                    aria-describedby={describedBy}
                    onCheckedChange={() => {
                      toggle(dish.id)
                    }}
                    className="mt-1"
                  />

                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <label
                        htmlFor={inputId}
                        className={cn(
                          'font-sans text-base font-medium text-linen',
                          isLocked ? 'cursor-not-allowed' : 'cursor-pointer'
                        )}
                      >
                        {dish.name}
                      </label>

                      <Money
                        cents={dish.basePriceCents}
                        currency={dish.currency}
                        tone="subtle"
                        className="text-sm"
                      />
                    </div>

                    <p id={describedBy} className="flex flex-col gap-2">
                      <span className="font-sans text-xs tracking-[0.12em] text-stone uppercase">
                        {dish.categoryName}
                      </span>

                      {dish.description === null ? null : (
                        <span className="font-sans text-sm leading-relaxed text-parchment">
                          {dish.description}
                        </span>
                      )}

                      {isLocked ? (
                        <span className="font-sans text-xs text-stone">
                          {`Your week is full at ${String(
                            mealsPerWeek
                          )}. Take one out to choose this instead.`}
                        </span>
                      ) : null}
                    </p>

                    {dish.isSignature ||
                    dish.isSeasonal ||
                    spice !== undefined ? (
                      <span className="flex flex-wrap gap-2">
                        {dish.isSignature ? (
                          <Badge variant="outline">Signature</Badge>
                        ) : null}
                        {dish.isSeasonal ? (
                          <Badge variant="success">In season</Badge>
                        ) : null}
                        {spice === undefined ? null : (
                          <Badge variant="warning">{spice}</Badge>
                        )}
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </ul>
      </section>

      <Separator variant="hairline" decorative />

      <section aria-labelledby="chosen-heading" className="flex flex-col gap-4">
        <h3
          id="chosen-heading"
          className="font-display text-2xl font-light text-linen"
        >
          Your week
        </h3>

        {chosenDishes.length === 0 ? (
          <p className="font-sans text-sm leading-relaxed text-stone">
            Nothing chosen yet. Tick the dishes above and they will gather here.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {chosenDishes.map((dish, index) => (
              <li
                key={dish.id}
                className="flex items-center justify-between gap-4 rounded-md border border-ash bg-charcoal px-4 py-3"
              >
                <span className="min-w-0 font-sans text-sm text-linen">
                  <span className="text-stone tabular-nums">
                    {`${String(index + 1)}. `}
                  </span>
                  {dish.name}
                </span>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    toggle(dish.id)
                  }}
                >
                  <span className="sr-only">{`Remove ${dish.name} from this week`}</span>
                  <span aria-hidden="true">Remove</span>
                </Button>
              </li>
            ))}
          </ol>
        )}

        {/*
          The handoff, stated plainly. See this file's header: the kitchen reads
          the dishes off the engagement, so the engagement is where this goes.
        */}
        <div className="flex flex-col gap-3 rounded-lg border border-ash bg-slate-warm px-5 py-4">
          <p className="font-sans text-sm leading-relaxed text-parchment">
            Your chef confirms the week with you when the engagement is booked,
            and the dishes are recorded against it — that is what the kitchen
            cooks from. Bring this list with you when you book.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="champagne">
              <Link href="/portal/appointments">
                Book the engagement for this week
              </Link>
            </Button>

            {chosenDishes.length === 0 ? null : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setChosen([])
                }}
              >
                Start again
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
