// mannachef/apps/web/src/components/forms/field-kit.tsx
'use client'

/**
 * The four input shapes the questionnaire needs and the UI primitives do not
 * already provide.
 *
 * Every one of them exists because a zod schema in `@mannachef/validators` asks
 * for a value a plain `<input>` cannot produce:
 *
 *  - {@link NumberField} — `z.int()` does **not** coerce, so a text input's
 *    string would fail validation with "expected number" rather than with the
 *    schema's own copy. This maps the control's string to `number | undefined`.
 *  - {@link DollarsField} — money is stored in integer minor units
 *    (`CONTRACT.md` §4) while a guest thinks in dollars. This is the only place
 *    in the questionnaire where the two are converted.
 *  - {@link StringListField} — the five `String[]` columns behind
 *    `freeTextList` are lists, not comma-separated strings, and one of them is
 *    the household's allergen record.
 *  - {@link DateTimeListField} — `preferredDates` is one to three future
 *    instants, each of which must survive `isoDateTimeSchema`.
 *
 * All four are `forwardRef` and pass their remaining props through, so each one
 * can sit inside a `<FormControl>` and receive the generated `id`,
 * `aria-describedby` and `aria-invalid` without knowing they exist.
 *
 * There is no animation in this file, so there is nothing here for
 * `prefers-reduced-motion` to reduce: the only movement is the champagne focus
 * ring, which is a `box-shadow` on `:focus-visible` and is not animated.
 */

import * as React from 'react'
import { Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input, type InputProps } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toLocalDateTimeInputValue } from '@/lib/local-datetime'
import { cn } from '@/lib/utils'

// =============================================================================
// 1. Whole numbers
// =============================================================================

export interface NumberFieldProps
  extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'defaultValue'> {
  /** The current value, or `undefined` while the control is empty. */
  readonly value: number | undefined
  /** Called with `undefined` when the control is cleared. */
  readonly onValueChange: (value: number | undefined) => void
}

/**
 * A whole-number input that yields `number | undefined`.
 *
 * The empty control is `undefined` rather than `0`, because "how many children
 * are in the household" left blank is a question that has not been answered,
 * and `0` is an answer.
 */
export const NumberField = React.forwardRef<HTMLInputElement, NumberFieldProps>(
  function NumberField({ value, onValueChange, ...props }, ref) {
    return (
      <Input
        {...props}
        ref={ref}
        type="number"
        inputMode="numeric"
        numeric
        value={value === undefined ? '' : String(value)}
        onChange={(event) => {
          const raw = event.target.value.trim()

          if (raw === '') {
            onValueChange(undefined)
            return
          }

          const parsed = Number(raw)

          onValueChange(Number.isFinite(parsed) ? parsed : undefined)
        }}
      />
    )
  }
)

// =============================================================================
// 2. Money
// =============================================================================

export interface DollarsFieldProps
  extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'defaultValue'> {
  /** The amount in integer minor units, or `undefined` while empty. */
  readonly valueCents: number | undefined
  /** Called with minor units, or `undefined` when the control is cleared. */
  readonly onValueCentsChange: (valueCents: number | undefined) => void
}

function centsToText(valueCents: number | undefined): string {
  return valueCents === undefined ? '' : (valueCents / 100).toFixed(2)
}

function textToCents(text: string): number | undefined {
  const trimmed = text.trim()

  if (trimmed === '') {
    return undefined
  }

  const parsed = Number(trimmed)

  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined
}

/**
 * A dollars-and-cents input over an integer-minor-units value.
 *
 * The typed text is held locally so that typing "12." or "12.5" is not
 * reformatted out from under the caret; the committed value is always the
 * rounded minor-unit integer. The effect re-synchronises the text only when the
 * incoming amount genuinely differs from what the text already means, which is
 * what lets a restored draft repopulate the control without fighting a guest
 * who is mid-keystroke.
 */
export const DollarsField = React.forwardRef<
  HTMLInputElement,
  DollarsFieldProps
>(function DollarsField(
  { valueCents, onValueCentsChange, className, ...props },
  ref
) {
  const [text, setText] = React.useState(() => centsToText(valueCents))

  React.useEffect(() => {
    setText((current) =>
      textToCents(current) === valueCents ? current : centsToText(valueCents)
    )
  }, [valueCents])

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-sans text-sm text-stone"
      >
        $
      </span>
      <Input
        {...props}
        ref={ref}
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        numeric
        className={cn('pl-7', className)}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          onValueCentsChange(textToCents(event.target.value))
        }}
      />
    </div>
  )
})

// =============================================================================
// 3. Free-text lists
// =============================================================================

export interface StringListFieldProps {
  /** The generated id from `<FormControl>`; lands on the entry input. */
  readonly id?: string
  readonly 'aria-describedby'?: string
  readonly 'aria-invalid'?: boolean | undefined
  readonly value: readonly string[]
  readonly onValueChange: (value: string[]) => void
  /** Singular noun for one entry — "allergy", "dish", "cuisine". */
  readonly itemNoun: string
  readonly placeholder: string
  /** Refuses further entries once the list reaches this length. */
  readonly maxEntries: number
  /**
   * Renders the chips in claret rather than in the quiet default.
   *
   * Reserved for allergies. The kitchen reads that list before it cooks, so it
   * is the one list on the questionnaire where a wrong entry is a safety
   * matter and the interface should say so without being asked.
   */
  readonly tone?: 'default' | 'critical'
  readonly disabled?: boolean
}

/**
 * A capped list of short free-text entries.
 *
 * Entries are added from a single input — by the "Add" button, or by pressing
 * Enter, which is intercepted so it adds an entry rather than submitting the
 * step. Each entry is a chip carrying its own labelled remove button, so the
 * whole control is operable from the keyboard alone, and additions and removals
 * are announced through a polite live region rather than happening silently.
 *
 * Case-insensitive duplicates are refused here as well as in the schema —
 * `freeTextList` de-duplicates on parse, so a list that showed the same allergy
 * twice would silently lose one on submit and the guest would never know which.
 */
export const StringListField = React.forwardRef<
  HTMLInputElement,
  StringListFieldProps
>(function StringListField(
  {
    id,
    value,
    onValueChange,
    itemNoun,
    placeholder,
    maxEntries,
    tone = 'default',
    disabled = false,
    ...aria
  },
  ref
) {
  const [entry, setEntry] = React.useState('')
  const [announcement, setAnnouncement] = React.useState('')

  const isFull = value.length >= maxEntries

  const addEntry = React.useCallback(() => {
    const trimmed = entry.trim()

    if (trimmed === '' || isFull) {
      return
    }

    const alreadyThere = value.some(
      (existing) => existing.toLowerCase() === trimmed.toLowerCase()
    )

    if (alreadyThere) {
      setAnnouncement(`${trimmed} is already on the list.`)
      setEntry('')
      return
    }

    onValueChange([...value, trimmed])
    setAnnouncement(`${trimmed} added.`)
    setEntry('')
  }, [entry, isFull, onValueChange, value])

  const removeAt = React.useCallback(
    (index: number) => {
      const removed = value[index]

      onValueChange(value.filter((_, position) => position !== index))
      setAnnouncement(
        removed === undefined ? 'Entry removed.' : `${removed} removed.`
      )
    },
    [onValueChange, value]
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          {...aria}
          ref={ref}
          id={id}
          value={entry}
          disabled={disabled || isFull}
          placeholder={isFull ? `That is ${maxEntries} — the list is full.` : placeholder}
          onChange={(event) => {
            setEntry(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Without this the first Enter in the questionnaire submits the
              // step with an empty list.
              event.preventDefault()
              addEntry()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={addEntry}
          disabled={disabled || isFull || entry.trim() === ''}
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className="sr-only sm:not-sr-only sm:ml-2">Add</span>
        </Button>
      </div>

      {value.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label={`${itemNoun} list`}>
          {value.map((item, index) => (
            <li key={`${item}-${String(index)}`}>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border py-1 pr-1 pl-2.5',
                  'font-sans text-xs leading-none',
                  tone === 'critical'
                    ? 'border-claret/60 bg-claret/12 text-linen'
                    : 'border-ash bg-charcoal text-parchment'
                )}
              >
                {item}
                <button
                  type="button"
                  onClick={() => {
                    removeAt(index)
                  }}
                  disabled={disabled}
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-sm',
                    'text-stone transition-colors duration-150 hover:text-linen',
                    'focus-visible:outline-none disabled:pointer-events-none'
                  )}
                >
                  <X aria-hidden="true" className="size-3" />
                  <span className="sr-only">{`Remove ${item}`}</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
})

// =============================================================================
// 4. Candidate consultation times
// =============================================================================

export interface DateTimeListFieldProps {
  readonly id?: string
  readonly 'aria-describedby'?: string
  readonly 'aria-invalid'?: boolean | undefined
  readonly value: readonly (Date | string)[]
  readonly onValueChange: (value: (Date | string)[]) => void
  readonly maxEntries: number
  readonly disabled?: boolean
}

/**
 * One to three candidate times, best first.
 *
 * Each row is a real labelled control rather than an unlabelled cell in a grid:
 * "First choice", "Second choice", "Third choice" is what the concierge will
 * read them as, so it is what the guest is asked for.
 *
 * The values are held as the `datetime-local` strings the control produces.
 * `ISO_DATE_TIME_PATTERN` in `@mannachef/validators` accepts exactly that
 * spelling — `2026-02-14T19:30` — and `isoDateTimeSchema` then reads it as the
 * guest's local time, which is the time they meant.
 */
export const DateTimeListField = React.forwardRef<
  HTMLInputElement,
  DateTimeListFieldProps
>(function DateTimeListField(
  { id, value, onValueChange, maxEntries, disabled = false, ...aria },
  ref
) {
  const generatedId = React.useId()
  const baseId = id ?? generatedId
  const ordinals = ['First choice', 'Second choice', 'Third choice'] as const

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <p className="font-sans text-xs leading-relaxed text-stone">
          No times offered yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {value.map((item, index) => {
            const rowId = `${baseId}-${String(index)}`
            const ordinal = ordinals[index] ?? `Choice ${String(index + 1)}`

            return (
              <li key={rowId} className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor={rowId} className="text-xs">
                    {ordinal}
                  </Label>
                  <Input
                    {...(index === 0 ? aria : {})}
                    ref={index === 0 ? ref : undefined}
                    id={rowId}
                    type="datetime-local"
                    disabled={disabled}
                    value={toLocalDateTimeInputValue(item)}
                    onChange={(event) => {
                      const next = [...value]
                      next[index] = event.target.value
                      onValueChange(next)
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => {
                    onValueChange(
                      value.filter((_, position) => position !== index)
                    )
                  }}
                >
                  <X aria-hidden="true" className="size-4" />
                  <span className="sr-only">{`Remove ${ordinal.toLowerCase()}`}</span>
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || value.length >= maxEntries}
          onClick={() => {
            onValueChange([...value, ''])
          }}
        >
          <Plus aria-hidden="true" className="mr-2 size-4" />
          {value.length === 0 ? 'Offer a time' : 'Offer another time'}
        </Button>
      </div>
    </div>
  )
})
