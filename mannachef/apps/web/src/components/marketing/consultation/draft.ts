// mannachef/apps/web/src/components/marketing/consultation/draft.ts

/**
 * The consultation questionnaire's draft, and the `sessionStorage` it survives
 * a refresh in.
 *
 * ## What is stored
 *
 * Only **parsed step outputs**. Each step of the wizard validates itself
 * against its own schema from `@mannachef/validators` before its answers reach
 * this module, so nothing here is ever a half-typed value: the draft is a
 * record of the answers a guest has actually given, plus where they had got to.
 *
 * That choice is what makes the restore total. Reading a draft runs each stored
 * slice back through the *same* schema that produced it — so a draft that was
 * hand-edited in devtools, that was written by an older build with a different
 * shape, or that carries a preferred consultation time which has since passed,
 * loses exactly the steps that no longer parse and keeps the rest. There is no
 * cast anywhere in this file and no `any`: a slice either survives its own
 * validator or it is dropped.
 *
 * ## Why `sessionStorage` and not `localStorage`
 *
 * The questionnaire records a household's allergies, their address, and their
 * telephone number. `sessionStorage` is scoped to the tab and is cleared when
 * it closes, so an answered-but-unsent questionnaire does not outlive the visit
 * on a shared machine. `localStorage` would keep it indefinitely, which is the
 * wrong default for this content.
 *
 * The draft is cleared the moment a submission succeeds — see
 * {@link clearConsultationDraft}.
 */

import {
  consultationRequestSchema,
  intakeDietaryStepSchema,
  intakeHouseholdStepSchema,
  intakeKitchenStepSchema,
  intakePreferencesStepSchema,
  intakeServiceStepSchema,
  type ConsultationRequestInput,
  type IntakeDietaryStep,
  type IntakeHouseholdStep,
  type IntakeKitchenStep,
  type IntakePreferencesStep,
  type IntakeServiceStep,
} from '@mannachef/validators'

// =============================================================================
// 1. The shape
// =============================================================================

/**
 * Every answer the wizard has collected.
 *
 * One property per step, `null` until that step has been completed once. The
 * five questionnaire slices are the exact `z.infer` of the five members of
 * `intakeStepSchemas`; `contact` is the `consultationRequestSchema` payload the
 * public action pairs them with.
 */
export interface ConsultationAnswers {
  readonly household: IntakeHouseholdStep | null
  readonly dietary: IntakeDietaryStep | null
  readonly kitchen: IntakeKitchenStep | null
  readonly service: IntakeServiceStep | null
  readonly preferences: IntakePreferencesStep | null
  readonly contact: ConsultationRequestInput | null
}

/** Nothing answered yet. */
export const EMPTY_CONSULTATION_ANSWERS: ConsultationAnswers = {
  household: null,
  dietary: null,
  kitchen: null,
  service: null,
  preferences: null,
  contact: null,
}

/** The answers, plus where in the wizard the guest had reached. */
export interface ConsultationDraft {
  readonly stepIndex: number
  readonly answers: ConsultationAnswers
}

// =============================================================================
// 2. Storage
// =============================================================================

/**
 * Versioned so that a shape change retires old drafts by simply not finding
 * them, rather than by trying to migrate something nobody can any longer read.
 */
const STORAGE_KEY = 'mannachef:consultation-draft:v1'

/** `sessionStorage`, or `null` where there is no window or it is blocked. */
function storage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.sessionStorage
  } catch {
    // Safari in private mode, and any browser with storage disabled, throw on
    // access rather than returning null. A guest who cannot persist a draft
    // should still be able to complete the questionnaire.
    return null
  }
}

/** `true` when `value` is a plain object we can read properties off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Re-validate one stored slice.
 *
 * Returns the parsed answers when the slice still satisfies its own schema, and
 * `null` for anything else — absent, malformed, or grown stale (a preferred
 * consultation time in the past is the ordinary case).
 */
function restoreHousehold(value: unknown): IntakeHouseholdStep | null {
  const parsed = intakeHouseholdStepSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function restoreDietary(value: unknown): IntakeDietaryStep | null {
  const parsed = intakeDietaryStepSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function restoreKitchen(value: unknown): IntakeKitchenStep | null {
  const parsed = intakeKitchenStepSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function restoreService(value: unknown): IntakeServiceStep | null {
  const parsed = intakeServiceStepSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function restorePreferences(value: unknown): IntakePreferencesStep | null {
  const parsed = intakePreferencesStepSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function restoreContact(value: unknown): ConsultationRequestInput | null {
  const parsed = consultationRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * The draft this tab left behind, or `null`.
 *
 * Never throws. A draft that cannot be read is a draft that did not exist.
 */
export function readConsultationDraft(): ConsultationDraft | null {
  const store = storage()

  if (store === null) {
    return null
  }

  let raw: string | null

  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return null
  }

  if (raw === null) {
    return null
  }

  let decoded: unknown

  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isRecord(decoded)) {
    return null
  }

  const storedAnswers = isRecord(decoded.answers) ? decoded.answers : {}
  const storedIndex = decoded.stepIndex

  const answers: ConsultationAnswers = {
    household: restoreHousehold(storedAnswers.household),
    dietary: restoreDietary(storedAnswers.dietary),
    kitchen: restoreKitchen(storedAnswers.kitchen),
    service: restoreService(storedAnswers.service),
    preferences: restorePreferences(storedAnswers.preferences),
    contact: restoreContact(storedAnswers.contact),
  }

  const hasAnything =
    answers.household !== null ||
    answers.dietary !== null ||
    answers.kitchen !== null ||
    answers.service !== null ||
    answers.preferences !== null ||
    answers.contact !== null

  if (!hasAnything) {
    return null
  }

  const stepIndex =
    typeof storedIndex === 'number' &&
    Number.isInteger(storedIndex) &&
    storedIndex >= 0
      ? storedIndex
      : 0

  return { stepIndex, answers }
}

/** Persist the draft. Silently does nothing where storage is unavailable. */
export function writeConsultationDraft(draft: ConsultationDraft): void {
  const store = storage()

  if (store === null) {
    return
  }

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // A full quota is not a reason to lose the guest's place in the form.
  }
}

/** Forget the draft. Called the moment a questionnaire is accepted. */
export function clearConsultationDraft(): void {
  const store = storage()

  if (store === null) {
    return
  }

  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do, and nothing worth telling the guest.
  }
}
