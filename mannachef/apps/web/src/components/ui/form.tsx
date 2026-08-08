// mannachef/apps/web/src/components/ui/form.tsx
'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form'

import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

/**
 * The React Hook Form bindings.
 *
 * These exist to make one accessibility contract automatic, because it is the
 * one every hand-wired form gets partly wrong:
 *
 *  - the label's `htmlFor` points at the control's `id`;
 *  - the control's `aria-describedby` lists **both** its description and its
 *    error message, in that order, so a screen reader reads the helper text and
 *    then what went wrong;
 *  - the control carries `aria-invalid` when — and only when — the field has an
 *    error;
 *  - the error message is `role="alert"`, so it is announced the moment it
 *    appears rather than only when the field is next visited.
 *
 * `<FormField>` supplies the field name through context; `<FormItem>` mints the
 * ids; `<FormControl>` is a `Slot` that stamps them onto whatever control it
 * wraps, native or Radix.
 *
 * ```tsx
 * <Form {...form}>
 *   <form onSubmit={form.handleSubmit((values) => execute(values))} noValidate>
 *     <FormField
 *       control={form.control}
 *       name="guestCount"
 *       render={({ field }) => (
 *         <FormItem>
 *           <FormLabel required>Guests</FormLabel>
 *           <FormControl>
 *             <Input type="number" numeric {...field} />
 *           </FormControl>
 *           <FormDescription>Including yourself.</FormDescription>
 *           <FormMessage />
 *         </FormItem>
 *       )}
 *     />
 *     <FormRootError />
 *     <FormStatus>{statusMessage}</FormStatus>
 *   </form>
 * </Form>
 * ```
 *
 * `noValidate` on the `<form>` is not decoration: the browser's own bubbles
 * would otherwise compete with the zod messages, and only one of the two is
 * written in the brand's voice.
 */
export const Form = FormProvider

interface FormFieldContextValue {
  readonly name: string
}

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null)

interface FormItemContextValue {
  readonly id: string
}

const FormItemContext = React.createContext<FormItemContextValue | null>(null)

/**
 * A controlled field.
 *
 * Thin over RHF's `<Controller>` — its only addition is publishing the field
 * name so the pieces below can find their own error without being told it.
 */
export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  const value = React.useMemo(() => ({ name: props.name }), [props.name])

  return (
    <FormFieldContext.Provider value={value}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

export interface UseFormFieldResult {
  readonly id: string
  readonly name: string
  readonly formItemId: string
  readonly formDescriptionId: string
  readonly formMessageId: string
  readonly error: { message?: string | undefined } | undefined
  readonly invalid: boolean
}

/**
 * The ids and error state for the field this component sits inside.
 *
 * Throws when used outside a `<FormField>`/`<FormItem>` pair — a loud failure
 * in development beats a label silently pointing at nothing in production.
 */
export function useFormField(): UseFormFieldResult {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState } = useFormContext()
  const formState = useFormState()

  if (fieldContext === null) {
    throw new Error('useFormField must be used within a <FormField>.')
  }

  if (itemContext === null) {
    throw new Error('useFormField must be used within a <FormItem>.')
  }

  const fieldState = getFieldState(fieldContext.name, formState)
  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    error: fieldState.error,
    invalid: fieldState.error !== undefined,
  }
}

export const FormItem = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function FormItem({ className, ...props }, ref) {
  const id = React.useId()
  const value = React.useMemo(() => ({ id }), [id])

  return (
    <FormItemContext.Provider value={value}>
      <div
        ref={ref}
        className={cn('flex flex-col gap-2', className)}
        {...props}
      />
    </FormItemContext.Provider>
  )
})

export const FormLabel = React.forwardRef<
  React.ComponentRef<typeof Label>,
  React.ComponentPropsWithoutRef<typeof Label>
>(function FormLabel({ className, tone, ...props }, ref) {
  const { invalid, formItemId } = useFormField()

  return (
    <Label
      ref={ref}
      htmlFor={formItemId}
      tone={tone ?? (invalid ? 'invalid' : 'default')}
      className={className}
      {...props}
    />
  )
})

/**
 * Stamps the field's id, `aria-describedby` and `aria-invalid` onto its child.
 *
 * A `Slot`, so it adds no element of its own — the child *is* the control,
 * whether that is an `<Input>`, a `<SelectTrigger>`, or a `<Switch>`.
 */
export const FormControl = React.forwardRef<
  React.ComponentRef<typeof Slot>,
  React.ComponentPropsWithoutRef<typeof Slot>
>(function FormControl({ ...props }, ref) {
  const { invalid, formItemId, formDescriptionId, formMessageId } =
    useFormField()

  return (
    <Slot
      ref={ref}
      id={formItemId}
      aria-describedby={
        invalid ? `${formDescriptionId} ${formMessageId}` : formDescriptionId
      }
      aria-invalid={invalid || undefined}
      {...props}
    />
  )
})

export const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function FormDescription({ className, ...props }, ref) {
  const { formDescriptionId } = useFormField()

  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn('font-sans text-xs leading-relaxed text-stone', className)}
      {...props}
    />
  )
})

/**
 * The field's error, if it has one.
 *
 * `role="alert"` so it is announced on appearance. Renders nothing at all when
 * the field is valid and no `children` were supplied, so the layout does not
 * reserve a blank line under every input.
 */
export const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function FormMessage({ className, children, ...props }, ref) {
  const { error, formMessageId } = useFormField()
  const body = error?.message ?? children

  if (body === undefined || body === null || body === '') {
    return null
  }

  return (
    <p
      ref={ref}
      id={formMessageId}
      role="alert"
      className={cn('font-sans text-xs leading-relaxed text-claret-ink', className)}
      {...props}
    >
      {body}
    </p>
  )
})

/**
 * The form-level error.
 *
 * This is where `useAction` puts a `FORBIDDEN`, a `CONFLICT`, or a cross-field
 * rule from `@mannachef/validators` that names no single input — RHF's `root`
 * bucket. Put it directly above the submit button: it must survive the toast
 * timing out.
 */
export const FormRootError = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function FormRootError({ className, ...props }, ref) {
  const { errors } = useFormState()
  const message = errors.root?.message

  if (message === undefined || message === '') {
    return null
  }

  return (
    <p
      ref={ref}
      role="alert"
      className={cn(
        'rounded-md border border-claret/60 bg-claret/12 px-3 py-2',
        'font-sans text-sm leading-relaxed text-linen',
        className
      )}
      {...props}
    />
  )
})

export interface FormStatusProps
  extends React.HTMLAttributes<HTMLParagraphElement> {
  /** The sentence to announce. `useAction().statusMessage` is written for this. */
  children?: React.ReactNode
}

/**
 * The live region every form needs and almost none have.
 *
 * `aria-live="polite"` with `role="status"`, always mounted — a live region
 * that is inserted at the same moment its text appears is not reliably
 * announced, so the element persists and only its contents change. It is
 * visually hidden by default; pass `className="not-sr-only …"` on a screen
 * where the status should also be seen.
 */
export const FormStatus = React.forwardRef<HTMLParagraphElement, FormStatusProps>(
  function FormStatus({ className, children, ...props }, ref) {
    return (
      <p
        ref={ref}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn('sr-only', className)}
        {...props}
      >
        {children}
      </p>
    )
  }
)
