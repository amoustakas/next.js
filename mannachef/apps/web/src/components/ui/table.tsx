// mannachef/apps/web/src/components/ui/table.tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * The bare table primitives. `<DataTable>` composes these; a screen with a
 * genuinely bespoke table composes them directly.
 *
 * Two rules are enforced here rather than left to call sites:
 *
 *  1. **A caption is not optional.** `<TableCaption>` is what tells a screen
 *     reader what the grid contains before it starts reading cells. It may be
 *     visually hidden (`srOnly`) but it must exist.
 *  2. **Numeric cells are `tabular-nums` and right-aligned.** `<TableCell
 *     numeric>` and `<TableHead numeric>` do both, so a column of prices lines
 *     up on the decimal without anybody remembering to say so.
 */
const tableVariants = cva('w-full caption-bottom border-collapse font-sans', {
  variants: {
    density: {
      comfortable: 'text-sm [&_td]:py-3 [&_th]:py-3',
      compact: 'text-xs [&_td]:py-2 [&_th]:py-2',
    },
  },
  defaultVariants: {
    density: 'comfortable',
  },
})

export interface TableProps
  extends React.TableHTMLAttributes<HTMLTableElement>,
    VariantProps<typeof tableVariants> {
  /** Classes for the scroll wrapper. A wide table scrolls, the page does not. */
  containerClassName?: string
}

export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  function Table({ className, containerClassName, density, ...props }, ref) {
    return (
      <div
        className={cn(
          'relative w-full overflow-x-auto rounded-lg border border-ash',
          containerClassName
        )}
      >
        <table
          ref={ref}
          className={cn(tableVariants({ density }), className)}
          {...props}
        />
      </div>
    )
  }
)

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return (
    <thead
      ref={ref}
      className={cn('bg-charcoal [&_tr]:border-b [&_tr]:border-ash', className)}
      {...props}
    />
  )
})

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return (
    <tbody
      ref={ref}
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  )
})

export const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableFooter({ className, ...props }, ref) {
  return (
    <tfoot
      ref={ref}
      className={cn(
        'border-t border-ash bg-charcoal font-medium [&>tr]:last:border-b-0',
        className
      )}
      {...props}
    />
  )
})

export interface TableRowProps
  extends React.HTMLAttributes<HTMLTableRowElement> {
  /**
   * Marks the row as chosen; sets `aria-selected` alongside the tint.
   *
   * `| undefined` is explicit because `exactOptionalPropertyTypes` is on and a
   * table without selection passes `undefined` deliberately — `aria-selected`
   * must be *absent* on a row that cannot be selected, not `false`.
   */
  selected?: boolean | undefined
  /** Adds hover feedback and a pointer. Pair it with a real key handler. */
  interactive?: boolean | undefined
}

export const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  function TableRow({ className, selected, interactive, ...props }, ref) {
    return (
      <tr
        ref={ref}
        aria-selected={selected}
        data-state={selected === true ? 'selected' : undefined}
        className={cn(
          'border-b border-ash/60 transition-colors duration-150 ease-luxe',
          interactive === true && 'cursor-pointer hover:bg-slate-warm/70',
          selected === true && 'bg-champagne/8',
          className
        )}
        {...props}
      />
    )
  }
)

export interface TableHeadProps
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Right-aligns and applies `tabular-nums` to match a numeric column. */
  numeric?: boolean
}

export const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  function TableHead({ className, numeric, scope, ...props }, ref) {
    return (
      <th
        ref={ref}
        scope={scope ?? 'col'}
        className={cn(
          'px-4 text-left align-middle text-xs font-medium tracking-wide text-stone uppercase',
          numeric === true && 'text-right tabular-nums',
          className
        )}
        {...props}
      />
    )
  }
)

export interface TableCellProps
  extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Right-aligns and applies `tabular-nums`. Every money or count column. */
  numeric?: boolean
}

export const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  function TableCell({ className, numeric, ...props }, ref) {
    return (
      <td
        ref={ref}
        className={cn(
          'px-4 align-middle text-linen',
          numeric === true && 'text-right tabular-nums',
          className
        )}
        {...props}
      />
    )
  }
)

export interface TableCaptionProps
  extends React.HTMLAttributes<HTMLTableCaptionElement> {
  /**
   * Hide the caption visually while leaving it in the accessibility tree.
   *
   * Almost always what you want: the visible heading above the table is the
   * design, and the caption is the machine-readable restatement of it.
   */
  srOnly?: boolean
}

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  TableCaptionProps
>(function TableCaption({ className, srOnly = true, ...props }, ref) {
  return (
    <caption
      ref={ref}
      className={cn(
        srOnly ? 'sr-only' : 'mt-3 text-sm text-parchment',
        className
      )}
      {...props}
    />
  )
})

export { tableVariants }
