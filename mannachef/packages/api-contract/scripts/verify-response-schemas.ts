// mannachef/packages/api-contract/scripts/verify-response-schemas.ts

/**
 * Proves that a response schema reports a malformed payload rather than
 * completing it.
 *
 * `currencySchema` and `timeZoneSchema` in `@mannachef/validators` both carry a
 * `.default(...)`, which is correct on the request side and a hazard on the
 * response side: a default turns "the server did not send this field" into a
 * plausible value, and the client renders it with no error anywhere. The
 * response models in `../src/index.ts` therefore use the unwrapped twins
 * {@link responseCurrencySchema} and {@link responseTimeZoneSchema}.
 *
 * For every read model that quotes an amount or a time zone, this asserts:
 *
 *  1. a **complete** payload parses, and the field survives verbatim;
 *  2. a payload with the field **omitted** is rejected — not silently filled;
 *  3. a payload with the field **malformed** is rejected.
 *
 * Assertion 2 is the one that regressed. It fails the moment a read model is
 * pointed back at a defaulted schema.
 *
 * Run: `pnpm --filter=@mannachef/api-contract verify:responses`
 */

import { z } from 'zod'

import {
  appointmentMenuItemSchema,
  appointmentSchema,
  bookingSlotSchema,
  invoiceLineItemSchema,
  invoiceSchema,
  menuItemSummarySchema,
  paymentSchema,
  referralCodeSummarySchema,
  rewardBalanceSchema,
  sessionUserSchema,
  staffProfileSummarySchema,
  subscriptionPlanSummarySchema,
  subscriptionSchema,
} from '../src/index.ts'

// =============================================================================
// Fixtures
// =============================================================================

const CUID = 'clh3k9x0a0000qwer1234asdf'
const CUID_2 = 'clh3k9x0a0001zxcv5678hjkl'
const NOW = '2026-02-14T19:30:00.000Z'

const MEDIA = {
  id: CUID,
  url: 'https://cdn.mannachef.test/plate.jpg',
  thumbnailUrl: null,
  alt: 'A plated dish',
  caption: null,
  credit: null,
  kind: 'IMAGE',
  width: 1600,
  height: 1200,
  blurData: null,
}

const PLAN = {
  id: CUID,
  slug: 'weekly-table',
  name: 'The Weekly Table',
  tagline: null,
  interval: 'MONTH',
  intervalCount: 1,
  priceCents: 120_000,
  currency: 'CAD',
  setupFeeCents: null,
  trialDays: 14,
  mealsPerWeek: 3,
  servingsPerMeal: 4,
  features: ['Weekly menu', 'Pantry restock'],
  isFeatured: true,
}

/** One read model, the field under test, and a complete payload for it. */
interface Subject {
  readonly label: string
  readonly field: string
  readonly schema: z.ZodType
  readonly payload: Readonly<Record<string, unknown>>
  /** A value the field's rules must refuse. */
  readonly malformed: unknown
}

const BAD_CURRENCY = 'Canadian Dollars'
const BAD_TIME_ZONE = 'Mars/Olympus_Mons'

const SUBJECTS: readonly Subject[] = [
  {
    label: 'sessionUserSchema',
    field: 'timeZone',
    schema: sessionUserSchema,
    malformed: BAD_TIME_ZONE,
    payload: {
      id: CUID,
      name: 'Amélie Fournier',
      email: 'amelie@example.test',
      image: null,
      role: 'CLIENT',
      timeZone: 'America/Vancouver',
      locale: 'en-CA',
      isActive: true,
    },
  },
  {
    label: 'menuItemSummarySchema',
    field: 'currency',
    schema: menuItemSummarySchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      slug: 'chef-tasting-menu',
      name: 'Chef Tasting Menu',
      description: null,
      categoryId: CUID_2,
      categorySlug: 'mains',
      categoryName: 'Mains',
      subcategorySlug: null,
      basePriceCents: 18_500,
      currency: 'EUR',
      spiceLevel: 'MILD',
      isSeasonal: false,
      seasonStart: null,
      seasonEnd: null,
      isSignature: true,
      isActive: true,
      sortOrder: 0,
      tags: [],
      primaryMedia: null,
      averageRating: null,
      reviewCount: 0,
    },
  },
  {
    label: 'bookingSlotSchema',
    field: 'currency',
    schema: bookingSlotSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      staffProfileId: CUID_2,
      staffName: 'Amélie Fournier',
      startsAt: NOW,
      endsAt: '2026-02-14T22:30:00.000Z',
      capacity: 1,
      bookedCount: 0,
      status: 'OPEN',
      serviceType: 'IN_HOME_DINNER',
      priceCents: 90_000,
      currency: 'USD',
      holdsUntil: null,
      note: null,
      isBookable: true,
    },
  },
  {
    label: 'appointmentMenuItemSchema',
    field: 'currency',
    schema: appointmentMenuItemSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      menuItemId: CUID_2,
      slug: 'chef-tasting-menu',
      name: 'Chef Tasting Menu',
      quantity: 4,
      courseOrder: 1,
      notes: null,
      priceCentsAtBooking: 18_500,
      currency: 'EUR',
    },
  },
  {
    label: 'appointmentSchema',
    field: 'currency',
    schema: appointmentSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      clientProfileId: CUID_2,
      staffProfileId: CUID_2,
      staffName: null,
      bookingSlotId: null,
      serviceType: 'IN_HOME_DINNER',
      status: 'CONFIRMED',
      startsAt: NOW,
      endsAt: '2026-02-14T22:30:00.000Z',
      prepStartsAt: null,
      travelBufferBeforeMinutes: 30,
      travelBufferAfterMinutes: 30,
      guestCount: 6,
      address: null,
      accessNotes: null,
      totalCents: 150_000,
      depositCents: 50_000,
      gratuityCents: 0,
      currency: 'USD',
      quotedGuestCount: 6,
      requiresRequote: false,
      clientNotes: null,
      chefNotes: null,
      confirmedAt: NOW,
      completedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      cancelledById: null,
      menuItems: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  },
  {
    label: 'subscriptionPlanSummarySchema',
    field: 'currency',
    schema: subscriptionPlanSummarySchema,
    malformed: BAD_CURRENCY,
    payload: { ...PLAN, currency: 'EUR' },
  },
  {
    label: 'subscriptionSchema',
    field: 'currency',
    schema: subscriptionSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      userId: CUID_2,
      planId: CUID,
      plan: PLAN,
      stripeSubscriptionId: 'sub_1Pabcd',
      status: 'ACTIVE',
      quantity: 1,
      currency: 'USD',
      currentPeriodStart: NOW,
      currentPeriodEnd: '2026-03-14T19:30:00.000Z',
      cancelAtPeriodEnd: false,
      cancelAt: null,
      canceledAt: null,
      cancellationReason: null,
      endedAt: null,
      trialEndsAt: null,
      pausedUntil: null,
      startedAt: NOW,
    },
  },
  {
    label: 'invoiceLineItemSchema',
    field: 'currency',
    schema: invoiceLineItemSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      kind: 'SUBSCRIPTION',
      description: 'The Weekly Table — February',
      quantity: 1,
      unitAmountCents: 120_000,
      amountCents: 120_000,
      taxCents: 15_600,
      currency: 'EUR',
      sortOrder: 0,
    },
  },
  {
    label: 'invoiceSchema',
    field: 'currency',
    schema: invoiceSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      userId: CUID_2,
      subscriptionId: null,
      appointmentId: null,
      number: 'INV-2026-0042',
      status: 'OPEN',
      amountDueCents: 135_600,
      amountPaidCents: 0,
      amountRemainingCents: 135_600,
      subtotalCents: 120_000,
      taxCents: 15_600,
      discountCents: 0,
      currency: 'USD',
      hostedInvoiceUrl: null,
      pdfUrl: null,
      description: null,
      issuedAt: NOW,
      dueAt: null,
      paidAt: null,
      voidedAt: null,
      isManual: false,
      lineItems: [],
      createdAt: NOW,
    },
  },
  {
    label: 'referralCodeSummarySchema',
    field: 'currency',
    schema: referralCodeSummarySchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      code: 'MANNA2026',
      ownerId: CUID_2,
      label: null,
      rewardType: 'FIXED_CREDIT',
      rewardValueCents: 5_000,
      rewardValuePercent: null,
      refereeRewardCents: 2_500,
      currency: 'EUR',
      maxRedemptions: 10,
      redemptionCount: 2,
      expiresAt: null,
      isActive: true,
      isRedeemable: true,
      createdAt: NOW,
    },
  },
  {
    label: 'rewardBalanceSchema',
    field: 'currency',
    schema: rewardBalanceSchema,
    malformed: BAD_CURRENCY,
    payload: {
      balanceCents: 7_500,
      lifetimeEarnedCents: 12_500,
      lifetimeRedeemedCents: 5_000,
      currency: 'USD',
      lastEarnedAt: null,
      lastRedeemedAt: null,
    },
  },
  {
    label: 'staffProfileSummarySchema (currency)',
    field: 'currency',
    schema: staffProfileSummarySchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      userId: CUID_2,
      name: 'Amélie Fournier',
      title: 'Chef de Cuisine',
      bio: null,
      specialties: ['pastry'],
      languages: ['English', 'French'],
      hourlyRateCents: 25_000,
      currency: 'USD',
      serviceRadiusKm: 40,
      yearsExperience: 12,
      baseCity: 'Toronto',
      baseRegion: 'Ontario',
      baseCountry: 'CA',
      calendarTimeZone: 'America/Toronto',
      isAcceptingClients: true,
      maxConcurrentEvents: 2,
      isPubliclyListed: true,
      sortOrder: 0,
      avatarMedia: MEDIA,
      averageRating: 4.8,
      reviewCount: 31,
      createdAt: NOW,
    },
  },
  {
    label: 'staffProfileSummarySchema (calendarTimeZone)',
    field: 'calendarTimeZone',
    schema: staffProfileSummarySchema,
    malformed: BAD_TIME_ZONE,
    payload: {
      id: CUID,
      userId: CUID_2,
      name: 'Amélie Fournier',
      title: null,
      bio: null,
      specialties: [],
      languages: [],
      hourlyRateCents: 25_000,
      currency: 'CAD',
      serviceRadiusKm: 40,
      yearsExperience: null,
      baseCity: null,
      baseRegion: null,
      baseCountry: null,
      calendarTimeZone: 'America/Vancouver',
      isAcceptingClients: true,
      maxConcurrentEvents: 1,
      isPubliclyListed: true,
      sortOrder: 0,
      avatarMedia: null,
      averageRating: null,
      reviewCount: 0,
      createdAt: NOW,
    },
  },
  {
    label: 'paymentSchema',
    field: 'currency',
    schema: paymentSchema,
    malformed: BAD_CURRENCY,
    payload: {
      id: CUID,
      userId: CUID_2,
      invoiceId: null,
      subscriptionId: null,
      stripePaymentIntentId: 'pi_3PabcdEFGHijklMN',
      stripeChargeId: 'ch_3PabcdEFGHijklMN',
      amountCents: 135_600,
      refundedCents: 0,
      feeCents: 4_100,
      currency: 'USD',
      status: 'SUCCEEDED',
      method: 'CARD',
      cardBrand: 'Visa',
      cardLast4: '4242',
      failureCode: null,
      failureReason: null,
      receiptUrl: null,
      processedAt: NOW,
      refundedAt: null,
      isRefundable: true,
      createdAt: NOW,
    },
  },
]

// =============================================================================
// Run
// =============================================================================

interface Failure {
  readonly subject: string
  readonly detail: string
}

const failures: Failure[] = []
let assertions = 0

function omit(
  payload: Readonly<Record<string, unknown>>,
  field: string
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...payload }
  delete copy[field]

  return copy
}

console.log(
  'Response schemas must reject an incomplete payload, not complete it'
)
console.log(`${SUBJECTS.length} read models under test\n`)

for (const subject of SUBJECTS) {
  const sent = subject.payload[subject.field]

  // 1. A complete payload parses, and the field survives verbatim.
  assertions += 1
  const complete = subject.schema.safeParse(subject.payload)

  if (!complete.success) {
    failures.push({
      subject: subject.label,
      detail: `a complete payload was rejected:\n        ${complete.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('\n        ')}`,
    })

    continue
  }

  const received = (complete.data as Record<string, unknown>)[subject.field]

  if (received !== sent) {
    failures.push({
      subject: subject.label,
      detail: `${subject.field} was altered in transit: sent ${JSON.stringify(sent)}, parsed ${JSON.stringify(received)}`,
    })
  }

  // 2. The field omitted must be an error, not a fabricated default.
  assertions += 1
  const missing = subject.schema.safeParse(omit(subject.payload, subject.field))

  if (missing.success) {
    const fabricated = (missing.data as Record<string, unknown>)[subject.field]

    failures.push({
      subject: subject.label,
      detail: `a payload with no ${subject.field} was ACCEPTED and filled with ${JSON.stringify(fabricated)}. The read model is still pointed at a defaulted schema — use the response twin.`,
    })
  }

  // 3. A malformed value must be an error.
  assertions += 1
  const malformed = subject.schema.safeParse({
    ...subject.payload,
    [subject.field]: subject.malformed,
  })

  if (malformed.success) {
    failures.push({
      subject: subject.label,
      detail: `a payload with ${subject.field} = ${JSON.stringify(subject.malformed)} was ACCEPTED.`,
    })
  }

  console.log(
    `  · ${subject.label.padEnd(44)} ${subject.field} — kept, required, validated`
  )
}

console.log(
  `\n${'-'.repeat(72)}\nread models: ${SUBJECTS.length}   assertions: ${assertions}   failures: ${failures.length}`
)

if (failures.length > 0) {
  console.error('\nFAILURES\n')

  for (const failure of failures) {
    console.error(`  ✗ ${failure.subject}\n      ${failure.detail}\n`)
  }

  process.exit(1)
}

console.log(
  '\nPASS — no response schema fabricates a field the server did not send.'
)
