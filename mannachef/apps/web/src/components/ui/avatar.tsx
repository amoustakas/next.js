// mannachef/apps/web/src/components/ui/avatar.tsx
'use client'

import * as React from 'react'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const avatarVariants = cva(
  'relative flex shrink-0 overflow-hidden rounded-full border border-ash bg-charcoal',
  {
    variants: {
      size: {
        sm: 'size-7',
        md: 'size-9',
        lg: 'size-12',
        xl: 'size-16',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
)

export interface AvatarProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>,
    VariantProps<typeof avatarVariants> {}

export const Avatar = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Root>,
  AvatarProps
>(function Avatar({ className, size, ...props }, ref) {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(avatarVariants({ size }), className)}
      {...props}
    />
  )
})

export const AvatarImage = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(function AvatarImage({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Image
      ref={ref}
      className={cn('aspect-square size-full object-cover', className)}
      {...props}
    />
  )
})

export const AvatarFallback = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(function AvatarFallback({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        'flex size-full items-center justify-center bg-ash font-sans text-xs font-medium tracking-wide text-parchment uppercase',
        className
      )}
      {...props}
    />
  )
})

/**
 * Reduce a person's name to at most two initials.
 *
 * Exported because every avatar in the app needs the same rule, and because
 * "Jean-Luc de la Fontaine" should read as "JF" rather than "JD" or "J-".
 */
export function initialsFrom(name: string | null | undefined): string {
  if (name === null || name === undefined) {
    return ''
  }

  const words = name
    .split(/[\s-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && /\p{L}/u.test(word))

  const first = words[0]
  const last = words.length > 1 ? words[words.length - 1] : undefined

  if (first === undefined) {
    return ''
  }

  const head = [...first][0] ?? ''
  const tail = last === undefined ? '' : ([...last][0] ?? '')

  return `${head}${tail}`.toLocaleUpperCase()
}

export { avatarVariants }
