// mannachef/apps/web/src/components/ui/calendar.tsx
'use client'

import * as React from 'react'
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn, FOCUS_RING } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * A month calendar.
 *
 * Hand-built rather than wrapping `react-day-picker`, which is not a dependency
 * of this workspace — and, more usefully, because the accessibility contract
 * here is short enough to own outright:
 *
 *  - The grid is a real `<table role="grid">` with `<th scope="col">` weekday
 *    headers carrying full day names for screen readers and two-letter
 *    abbreviations for eyes.
 *  - **One tab stop.** Exactly one day button is in the tab order at a time
 *    (the roving-tabindex pattern). Tab moves past the calendar; the arrow keys
 *    move within it.
 *  - `←`/`→` a day, `↑`/`↓` a week, `PageUp`/`PageDown` a month,
 *    `Home`/`End` to the ends of the week, `Enter`/`Space` to choose. Moving
 *    off the edge of the displayed month pages the month automatically.
 *  - The selected day is `aria-selected`; today is `aria-current="date"`; a day
 *    outside `fromDate`/`toDate` or refused by `disabled` is a real
 *    `disabled` button rather than a dimmed `<div>`.
 *  - The month heading is an `aria-live="polite"` region, so paging is
 *    announced instead of happening silently.
 *
 * All state is date-only: every incoming `Date` is normalised with
 * `startOfDay`, so a value carrying a time never causes a day to compare
 * unequal to itself.
 */

/** The day a week begins on. 0 is Sunday. */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface CalendarProps {
  /** The chosen day, or `null`. Controlled. */
  selected?: Date | null
  /** Called with a day-only `Date` when a day is chosen. */
  onSelect?: (date: Date) => void
  /** The displayed month, controlled. Pair with `onMonthChange`. */
  month?: Date
  /** The month shown initially when `month` is not supplied. */
  defaultMonth?: Date
  onMonthChange?: (month: Date) => void
  /** Refuse individual days — a blackout, a fully booked sitting. */
  disabled?: (date: Date) => boolean
  /** Earliest selectable day, inclusive. */
  fromDate?: Date
  /** Latest selectable day, inclusive. */
  toDate?: Date
  weekStartsOn?: WeekStartsOn
  /** Names the grid. Required — a bare grid announces as "grid". */
  label?: string
  className?: string
  id?: string
}

const WEEKDAY_FORMAT_LONG = 'EEEE'
const WEEKDAY_FORMAT_SHORT = 'EEEEEE'
const DAY_KEY_FORMAT = 'yyyy-MM-dd'

function clampToRange(
  date: Date,
  fromDate: Date | undefined,
  toDate: Date | undefined
): Date {
  if (fromDate !== undefined && isBefore(date, fromDate)) {
    return startOfDay(fromDate)
  }

  if (toDate !== undefined && isAfter(date, toDate)) {
    return startOfDay(toDate)
  }

  return date
}

export function Calendar({
  selected = null,
  onSelect,
  month,
  defaultMonth,
  onMonthChange,
  disabled,
  fromDate,
  toDate,
  weekStartsOn = 0,
  label = 'Calendar',
  className,
  id,
}: CalendarProps) {
  const generatedId = React.useId()
  const calendarId = id ?? generatedId
  const gridRef = React.useRef<HTMLTableElement>(null)

  const normalizedSelected = React.useMemo(
    () => (selected === null ? null : startOfDay(selected)),
    [selected]
  )

  const [uncontrolledMonth, setUncontrolledMonth] = React.useState(() =>
    startOfMonth(month ?? defaultMonth ?? normalizedSelected ?? new Date())
  )

  const displayedMonth = month === undefined ? uncontrolledMonth : startOfMonth(month)

  const setMonth = React.useCallback(
    (next: Date) => {
      const normalized = startOfMonth(next)

      if (month === undefined) {
        setUncontrolledMonth(normalized)
      }

      onMonthChange?.(normalized)
    },
    [month, onMonthChange]
  )

  // The single day that holds the tab stop. It follows the selection when there
  // is one, otherwise today, otherwise the first of the displayed month.
  const [focusedDate, setFocusedDate] = React.useState<Date>(() => {
    const today = startOfDay(new Date())
    const candidate =
      normalizedSelected ??
      (isSameMonth(today, displayedMonth) ? today : startOfMonth(displayedMonth))

    return clampToRange(candidate, fromDate, toDate)
  })

  // Whether the last focus change came from the keyboard. Focus is only *moved*
  // in that case — re-rendering for an unrelated reason must not steal it.
  const shouldRestoreFocusRef = React.useRef(false)

  React.useEffect(() => {
    if (!shouldRestoreFocusRef.current) {
      return
    }

    shouldRestoreFocusRef.current = false

    const grid = gridRef.current

    if (grid === null) {
      return
    }

    const key = format(focusedDate, DAY_KEY_FORMAT)
    const target = grid.querySelector<HTMLButtonElement>(
      `[data-mc-day="${key}"]`
    )

    target?.focus()
  }, [focusedDate])

  const days = React.useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(displayedMonth), { weekStartsOn })
    const gridEnd = endOfWeek(endOfMonth(displayedMonth), { weekStartsOn })

    return eachDayOfInterval({ start: gridStart, end: gridEnd }).map((day) =>
      startOfDay(day)
    )
  }, [displayedMonth, weekStartsOn])

  const weeks = React.useMemo(() => {
    const grouped: Date[][] = []

    for (let index = 0; index < days.length; index += 7) {
      grouped.push(days.slice(index, index + 7))
    }

    return grouped
  }, [days])

  const weekdayHeadings = React.useMemo(() => {
    const first = startOfWeek(new Date(), { weekStartsOn })

    return Array.from({ length: 7 }, (_, index) => {
      const day = addDays(first, index)

      return {
        key: index,
        long: format(day, WEEKDAY_FORMAT_LONG),
        short: format(day, WEEKDAY_FORMAT_SHORT),
      }
    })
  }, [weekStartsOn])

  const isDayDisabled = React.useCallback(
    (day: Date): boolean => {
      if (fromDate !== undefined && isBefore(day, startOfDay(fromDate))) {
        return true
      }

      if (toDate !== undefined && isAfter(day, startOfDay(toDate))) {
        return true
      }

      return disabled?.(day) ?? false
    },
    [disabled, fromDate, toDate]
  )

  const moveFocus = React.useCallback(
    (next: Date) => {
      const clamped = clampToRange(startOfDay(next), fromDate, toDate)

      shouldRestoreFocusRef.current = true
      setFocusedDate(clamped)

      if (!isSameMonth(clamped, displayedMonth)) {
        setMonth(clamped)
      }
    },
    [displayedMonth, fromDate, setMonth, toDate]
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTableElement>) => {
      const handlers: Readonly<Record<string, () => Date>> = {
        ArrowLeft: () => addDays(focusedDate, -1),
        ArrowRight: () => addDays(focusedDate, 1),
        ArrowUp: () => addDays(focusedDate, -7),
        ArrowDown: () => addDays(focusedDate, 7),
        Home: () => startOfWeek(focusedDate, { weekStartsOn }),
        End: () => endOfWeek(focusedDate, { weekStartsOn }),
        PageUp: () => addMonths(focusedDate, -1),
        PageDown: () => addMonths(focusedDate, 1),
      }

      const handler = handlers[event.key]

      if (handler === undefined) {
        return
      }

      event.preventDefault()
      moveFocus(handler())
    },
    [focusedDate, moveFocus, weekStartsOn]
  )

  const goToPreviousMonth = React.useCallback(() => {
    setMonth(addMonths(displayedMonth, -1))
  }, [displayedMonth, setMonth])

  const goToNextMonth = React.useCallback(() => {
    setMonth(addMonths(displayedMonth, 1))
  }, [displayedMonth, setMonth])

  const previousDisabled =
    fromDate !== undefined &&
    isBefore(endOfMonth(addMonths(displayedMonth, -1)), startOfDay(fromDate))

  const nextDisabled =
    toDate !== undefined &&
    isAfter(startOfMonth(addMonths(displayedMonth, 1)), startOfDay(toDate))

  const monthLabelId = `${calendarId}-month`

  return (
    <div className={cn('w-fit select-none', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={goToPreviousMonth}
          disabled={previousDisabled}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          <span className="sr-only">Previous month</span>
        </Button>
        <div
          id={monthLabelId}
          aria-live="polite"
          className="font-display text-base font-medium tracking-tight text-linen"
        >
          {format(displayedMonth, 'MMMM yyyy')}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={goToNextMonth}
          disabled={nextDisabled}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
          <span className="sr-only">Next month</span>
        </Button>
      </div>

      <table
        ref={gridRef}
        role="grid"
        aria-label={label}
        aria-labelledby={monthLabelId}
        onKeyDown={handleKeyDown}
        className="border-collapse"
      >
        <thead>
          <tr>
            {weekdayHeadings.map((weekday) => (
              <th
                key={weekday.key}
                scope="col"
                abbr={weekday.long}
                className="size-9 p-0 text-center font-sans text-xs font-medium text-stone"
              >
                <span aria-hidden="true">{weekday.short}</span>
                <span className="sr-only">{weekday.long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => {
            const firstOfWeek = week[0]

            return (
              <tr key={firstOfWeek === undefined ? 'empty' : format(firstOfWeek, DAY_KEY_FORMAT)}>
                {week.map((day) => {
                  const key = format(day, DAY_KEY_FORMAT)
                  const outside = !isSameMonth(day, displayedMonth)
                  const isSelected =
                    normalizedSelected !== null && isSameDay(day, normalizedSelected)
                  const dayDisabled = isDayDisabled(day)
                  const isFocusTarget = isSameDay(day, focusedDate)
                  const today = isToday(day)

                  return (
                    <td key={key} role="gridcell" className="p-0.5">
                      <button
                        type="button"
                        data-mc-day={key}
                        tabIndex={isFocusTarget ? 0 : -1}
                        disabled={dayDisabled}
                        aria-selected={isSelected}
                        aria-current={today ? 'date' : undefined}
                        aria-label={format(day, 'EEEE, d MMMM yyyy')}
                        onClick={() => {
                          shouldRestoreFocusRef.current = false
                          setFocusedDate(day)

                          if (!isSameMonth(day, displayedMonth)) {
                            setMonth(day)
                          }

                          onSelect?.(day)
                        }}
                        onFocus={() => {
                          setFocusedDate(day)
                        }}
                        className={cn(
                          'flex size-9 items-center justify-center rounded-md border border-transparent',
                          'font-sans text-sm tabular-nums',
                          'transition-[background-color,border-color,color] duration-150 ease-luxe',
                          'disabled:pointer-events-none disabled:opacity-30',
                          outside ? 'text-stone' : 'text-linen',
                          'hover:border-ash hover:bg-slate-warm',
                          today && !isSelected && 'border-gold/50',
                          isSelected &&
                            'border-gold bg-champagne font-semibold text-obsidian hover:bg-champagne/90',
                          FOCUS_RING
                        )}
                      >
                        {format(day, 'd')}
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
