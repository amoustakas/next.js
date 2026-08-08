// mannachef/apps/web/src/lib/local-datetime.ts

/**
 * The one conversion between a moment and the string
 * `<input type="datetime-local">` speaks.
 *
 * ## Why `toISOString()` cannot be used
 *
 * `datetime-local` has no time zone: it means "this wall-clock time, wherever
 * the person reading it is". `Date.prototype.toISOString()` converts to UTC, so
 * a guest in Toronto looking at a seven-o'clock dinner would be shown a control
 * reading midnight, and moving it by an hour would move the booking by five.
 * The formatter below reads the local components instead, which is the only
 * spelling that round-trips through the control unchanged.
 *
 * ## Why the output is safe to submit
 *
 * `ISO_DATE_TIME_PATTERN` in `@mannachef/validators` accepts
 * `YYYY-MM-DDTHH:MM` with no seconds and no offset — exactly what this produces
 * and exactly what the control emits. `isoDateTimeSchema` then hands it to
 * `new Date(...)`, which reads an offset-less date-time as **local** time. So
 * the value a guest sees, the value the form holds, and the instant the server
 * stores all mean the same wall clock.
 *
 * No `'use client'`: it is a pure function, and both a Server Component
 * computing a default and a client form editing one may call it.
 */

function pad(part: number): string {
  return String(part).padStart(2, '0')
}

/**
 * `2026-02-14T19:30` for a moment, in the reader's own local time.
 *
 * Returns `''` for a value that is not a usable instant, which is what an empty
 * `datetime-local` holds — so an unparseable stored draft renders as a blank
 * control rather than as the string `Invalid Date`.
 */
export function toLocalDateTimeInputValue(
  value: Date | string | null | undefined
): string {
  if (value === null || value === undefined) {
    return ''
  }

  const date = typeof value === 'string' ? new Date(value) : value

  if (Number.isNaN(date.getTime())) {
    // A string that did not parse is handed back untouched: it may be a
    // half-typed value the guest is still working on, and replacing it with an
    // empty string would delete their keystrokes.
    return typeof value === 'string' ? value : ''
  }

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The same moment shifted by whole minutes, as a `datetime-local` string.
 *
 * Used to propose an end that keeps an engagement's original length when its
 * start is moved.
 */
export function shiftLocalDateTimeInputValue(
  value: Date | string | null | undefined,
  minutes: number
): string {
  if (value === null || value === undefined) {
    return ''
  }

  const date = typeof value === 'string' ? new Date(value) : value

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return toLocalDateTimeInputValue(new Date(date.getTime() + minutes * 60_000))
}

/** How many whole minutes separate two moments. Negative when `end` precedes. */
export function minutesBetween(
  start: Date | string,
  end: Date | string
): number {
  const from = typeof start === 'string' ? new Date(start) : start
  const to = typeof end === 'string' ? new Date(end) : end

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 0
  }

  return Math.round((to.getTime() - from.getTime()) / 60_000)
}
