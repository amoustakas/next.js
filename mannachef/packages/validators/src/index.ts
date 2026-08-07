// mannachef/packages/validators/src/index.ts

/**
 * Public surface of `@mannachef/validators`.
 *
 * Every domain module in this directory is re-exported from here so that the
 * marketing site, the client portal, the admin OS, the API contract, and the
 * Expo client all import validation from a single specifier:
 *
 * ```ts
 * import { menuItemFilterSchema, type MenuItemFilterInput } from '@mannachef/validators'
 * ```
 *
 * ## Collision policy
 *
 * Eight of the ten modules are re-exported wholesale because their public
 * surfaces are provably disjoint. Two are not: `intake.ts` and `referral.ts`
 * both declare a constant named `MAX_REFERRAL_CODE_LENGTH`, and they mean
 * genuinely different things:
 *
 *  - `referral.ts` → `12`. The longest code `generateReferralCode` will mint,
 *    and the ceiling `referralCodeSchema` enforces. This is the referral
 *    domain's own rule, so it keeps the unqualified name.
 *  - `intake.ts` → `40`. The width of the `ReferralCode.code` column
 *    (`@db.VarChar(40)`), used to bound the free-text "how did you hear about
 *    us" field on the prospect-conversion form, which must tolerate a code
 *    typed from memory rather than one we generated. It is re-exported as
 *    `MAX_INTAKE_REFERRAL_CODE_LENGTH`.
 *
 * A blanket `export *` from both modules would silently drop the name from this
 * barrel and produce a confusing "has no exported member" at the call site, so
 * those two modules are enumerated explicitly instead. Everything else they
 * export is listed below verbatim — adding a declaration to `intake.ts` or
 * `referral.ts` means adding it here too.
 *
 * `verbatimModuleSyntax` is on, so type-only re-exports use `export type`.
 */

// =============================================================================
// Disjoint modules — re-exported wholesale
// =============================================================================

export * from './common'
export * from './enums'
export * from './menu'
export * from './media'
export * from './review'
export * from './booking'
export * from './billing'
export * from './crm'

// =============================================================================
// intake.ts — enumerated (see collision policy above)
// =============================================================================

export {
  // Limits
  MAX_HOUSEHOLD_SIZE,
  MAX_ALLERGIES,
  MAX_DISLIKES,
  MAX_CUISINE_PREFERENCES,
  MAX_KITCHEN_EQUIPMENT,
  MAX_FAVOURITE_DISHES,
  MAX_DIETARY_PREFERENCE_TAGS,
  MAX_LIST_ENTRY_LENGTH,
  MAX_PETS_NOTE_LENGTH,
  MAX_NOTES_LENGTH,
  MIN_BUDGET_PER_MEAL_CENTS,
  MAX_BUDGET_PER_MEAL_CENTS,
  MIN_CONSULTATION_MINUTES,
  MAX_CONSULTATION_MINUTES,
  MAX_PREFERRED_CONSULTATION_DATES,
  MAX_CONSULTATION_LOCATION_LENGTH,
  MAX_SOURCE_DETAIL_LENGTH,
  /**
   * `ReferralCode.code` is `@db.VarChar(40)`, so the intake form accepts up to
   * forty characters from a guest typing a code they were given. Renamed here
   * to keep it distinct from `MAX_REFERRAL_CODE_LENGTH` (12), which is the
   * longest code we ourselves generate.
   */
  MAX_REFERRAL_CODE_LENGTH as MAX_INTAKE_REFERRAL_CODE_LENGTH,
  // Schemas & helpers
  cookDaySchema,
  intakeHouseholdStepSchema,
  intakeDietaryStepSchema,
  intakeKitchenStepSchema,
  intakeServiceStepSchema,
  intakePreferencesStepSchema,
  intakeStepSchemas,
  INTAKE_STEP_COUNT,
  INTAKE_STEP_IDS,
  INTAKE_STEPS,
  intakeStepSchemaAt,
  clientIntakeSchema,
  clientIntakeCreateSchema,
  clientIntakeUpdateSchema,
  serviceAddressToColumns,
  clientIntakeFilterSchema,
  consultationRequestSchema,
  consultationInterviewSchema,
  consultationInterviewCreateSchema,
  consultationInterviewUpdateSchema,
  consultationInterviewFilterSchema,
  PROSPECT_CONVERSION_STATUSES,
  PROSPECT_CONVERSION_OUTCOMES,
  PROSPECT_CONVERSION_STAGES,
  prospectConversionSchema,
} from './intake'

export type {
  CookDay,
  IntakeHouseholdStep,
  IntakeHouseholdStepInput,
  IntakeDietaryStep,
  IntakeDietaryStepInput,
  IntakeKitchenStep,
  IntakeKitchenStepInput,
  IntakeServiceStep,
  IntakeServiceStepInput,
  IntakePreferencesStep,
  IntakePreferencesStepInput,
  IntakeStepSchema,
  IntakeStepValues,
  IntakeStepInput,
  IntakeStepId,
  ClientIntake,
  ClientIntakeInput,
  ClientIntakeCreateInput,
  ClientIntakeCreateRawInput,
  ClientIntakeUpdateInput,
  ClientIntakeUpdateRawInput,
  ServiceAddressColumns,
  ClientIntakeFilter,
  ClientIntakeFilterInput,
  ConsultationRequestInput,
  ConsultationRequestRawInput,
  ConsultationInterviewInput,
  ConsultationInterviewRawInput,
  ConsultationInterviewCreateInput,
  ConsultationInterviewUpdateInput,
  ConsultationInterviewUpdateRawInput,
  ConsultationInterviewFilter,
  ConsultationInterviewFilterInput,
  ProspectConversionInput,
  ProspectConversionRawInput,
} from './intake'

// =============================================================================
// referral.ts — enumerated (see collision policy above)
// =============================================================================

export {
  // Limits & alphabet
  MIN_REFERRAL_CODE_LENGTH,
  /**
   * The longest code `generateReferralCode` mints and `referralCodeSchema`
   * accepts. The referral domain owns the concept, so it keeps the plain name.
   */
  MAX_REFERRAL_CODE_LENGTH,
  DEFAULT_REFERRAL_CODE_LENGTH,
  MAX_REWARD_CENTS,
  MAX_REDEMPTIONS,
  REFERRAL_CODE_ALPHABET,
  // Schemas & helpers
  referralCodeSchema,
  generateReferralCode,
  referralRewardValueKind,
  rewardCentsSchema,
  rewardPercentSchema,
  referralCodeCreateSchema,
  referralCodeUpdateSchema,
  referralCodeSortBySchema,
  referralCodeFilterSchema,
  referralRedemptionCreateSchema,
  referralRedemptionStatusUpdateSchema,
  REFERRAL_REDEMPTION_ACTIONS,
  referralRedemptionFilterSchema,
  rewardPayoutSchema,
  rewardAdjustmentSchema,
  signedLedgerAmountCents,
  rewardLedgerFilterSchema,
} from './referral'

export type {
  ReferralCode,
  RewardCents,
  RewardPercent,
  ReferralCodeCreateInput,
  ReferralCodeCreateRawInput,
  ReferralCodeUpdateInput,
  ReferralCodeUpdateRawInput,
  ReferralCodeSortBy,
  ReferralCodeFilterInput,
  ReferralCodeFilterRawInput,
  ReferralRedemptionCreateInput,
  ReferralRedemptionCreateRawInput,
  ReferralRedemptionStatusUpdateInput,
  ReferralRedemptionStatusUpdateRawInput,
  ReferralRedemptionAction,
  ReferralRedemptionFilterInput,
  ReferralRedemptionFilterRawInput,
  RewardPayoutInput,
  RewardPayoutRawInput,
  RewardAdjustmentInput,
  RewardAdjustmentRawInput,
  RewardLedgerFilterInput,
  RewardLedgerFilterRawInput,
} from './referral'
