// mannachef/apps/web/src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names and resolve Tailwind class conflicts.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format an integer amount stored in minor units (cents) as a localized
 * currency string. Money is never stored as a float — see CONTRACT.md §4.
 */
export function formatCurrency(cents: number, currency = 'CAD'): string {
  const amount = cents / 100
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(amount)
}

/**
 * Format a Date (or ISO string) as a human-readable calendar date,
 * e.g. "Aug 7, 2026".
 */
export function formatDate(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(value)
}

/**
 * Format a Date (or ISO string) as a human-readable date and time,
 * e.g. "Aug 7, 2026, 9:41 AM".
 */
export function formatDateTime(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}
