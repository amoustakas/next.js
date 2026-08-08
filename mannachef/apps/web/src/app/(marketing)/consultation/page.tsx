// mannachef/apps/web/src/app/(marketing)/consultation/page.tsx

/**
 * The consultation gateway — the product's front door.
 *
 * A **Server Component**. Everything above the questionnaire is static prose
 * rendered on the server, and the one read this page performs — the dietary and
 * allergen tag vocabulary — happens here rather than in the browser, so the
 * wizard mounts with its checkboxes already populated and no request of its
 * own to make.
 *
 * The only client boundary is `<ConsultationWizard>`, which genuinely needs
 * one: seven steps of local form state, a draft in `sessionStorage`, and a
 * Server Action to call at the end.
 *
 * ## Why the tag read cannot fail the page
 *
 * `listTags` is `auth: 'PUBLIC'` and returns `ActionResult`, never throws. A
 * failure here means the structured dietary vocabulary is unavailable, which is
 * a degradation and not an outage: the questionnaire's free-text allergy,
 * dislike and cuisine fields are the ones that matter, and the wizard omits the
 * tag group entirely when the list is empty. So the failure is absorbed and the
 * gateway still opens.
 */

import type * as React from 'react'
import type { Metadata } from 'next'

import { ConsultationWizard } from '@/components/marketing/consultation/consultation-wizard'
import type { DietaryTagOption } from '@/components/marketing/consultation/steps/dietary-step'
import { Separator } from '@/components/ui/separator'
import { listTags } from '@/server/actions/menu'

export const metadata: Metadata = {
  title: 'Request a consultation',
  description:
    'Tell us how your household eats — allergies, aversions, the kitchen, the cadence — and we will arrange a consultation with a chef who has already read it.',
  alternates: { canonical: '/consultation' },
  openGraph: {
    title: 'Request a consultation · MannaChef',
    description:
      'A questionnaire, then a conversation. Twenty minutes now saves the first three menus.',
    url: '/consultation',
  },
}

/** The vocabulary the dietary step offers as checkboxes. */
async function readDietaryTags(): Promise<readonly DietaryTagOption[]> {
  const result = await listTags({
    kinds: ['DIETARY', 'ALLERGEN'],
    sortBy: 'NAME',
    pageSize: 100,
  })

  if (!result.ok) {
    return []
  }

  return result.data.items.map((tag) => ({
    id: tag.id,
    name: tag.name,
    kind: tag.kind,
  }))
}

export default async function ConsultationPage(): Promise<React.JSX.Element> {
  const tagOptions = await readDietaryTags()

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
      <header className="flex flex-col gap-5">
        <p className="font-sans text-xs tracking-[0.24em] text-champagne uppercase">
          Consultation
        </p>

        <h1 className="font-display text-5xl leading-[1.05] font-light text-linen sm:text-6xl">
          Tell us how you eat.
        </h1>

        <p className="max-w-2xl font-sans text-base leading-relaxed text-parchment">
          Before a chef cooks for you, we ask. Not a form for the file — a
          questionnaire a chef actually reads, about who sits at your table,
          what must never appear on it, and the kitchen we will be standing in.
        </p>

        <p className="max-w-2xl font-sans text-sm leading-relaxed text-stone">
          Seven short steps, about ten minutes. Your answers stay in this tab
          until you send them, so you may leave and come back. Nothing is
          charged, and nothing is committed to — the consultation is a
          conversation.
        </p>
      </header>

      <Separator variant="hairline" className="my-12" decorative />

      <ConsultationWizard tagOptions={tagOptions} />
    </div>
  )
}
