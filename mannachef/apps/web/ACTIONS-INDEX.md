# Server Action Index (generated)

Signature reference so UI code never has to open a 2,000-line action module.

Regenerate with `pnpm gen:action-index`. Do not hand-edit — it is derived from
`src/server/actions/*.ts` and will be overwritten.

## `server/actions/availability.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `createAvailabilityRule` | `availability.createRule` | CHEF_STAFF | `chefAvailabilityRuleSchema` | `_(inferred)_` |  |
| `createAvailabilityBlackout` | `availability.createBlackout` | CHEF_STAFF | `chefAvailabilityRuleSchema.refine` | `_(inferred)_` |  |
| `updateAvailabilityRule` | `availability.updateRule` | CHEF_STAFF | `chefAvailabilityUpdateSchema` | `_(inferred)_` |  |
| `deleteAvailabilityRule` | `availability.deleteRule` | CHEF_STAFF | `availabilityRuleIdSchema` | `_(inferred)_` |  |
| `listAvailabilityRules` | `availability.listRules` | CHEF_STAFF | `staffScopedQuerySchema` | `_(inferred)_` |  |
| `previewAvailabilityWindows` | `availability.preview` | CHEF_STAFF | `availabilityPreviewSchema` | `_(inferred)_` |  |
| `generateBookingSlots` | `availability.generateSlots` | CHEF_STAFF | `recurringSlotGenerationSchema` | `_(inferred)_` |  |
| `withdrawBookingSlot` | `availability.withdrawSlot` | CHEF_STAFF | `bookingSlotIdSchema` | `_(inferred)_` |  |
| `listBookableWindows` | `availability.query` | PUBLIC | `bookingSlotFilterSchema` | `_(inferred)_` | yes |
| `expireLapsedSlotHolds` | `availability.expireHolds` | ADMIN | `z.object` | `_(inferred)_` |  |

## `server/actions/billing.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `listSubscriptionPlans` | `plan.list` | PUBLIC | `subscriptionPlanFilterSchema` | `SubscriptionPlanListView` |  |
| `createSubscriptionPlan` | `plan.create` | ADMIN | `subscriptionPlanCreateSchema` | `SubscriptionPlanView` |  |
| `updateSubscriptionPlan` | `plan.update` | ADMIN | `subscriptionPlanUpdateSchema` | `SubscriptionPlanView` |  |
| `deleteSubscriptionPlan` | `plan.delete` | ADMIN | `planIdSchema` | `SubscriptionPlanDeletionView` |  |
| `createCheckoutSession` | `billing.checkout.create` | SESSION | `checkoutSessionSchema` | `CheckoutSessionView` | yes |
| `listSubscriptions` | `subscription.read` | SESSION | `userSubscriptionFilterSchema` | `SubscriptionListView` |  |
| `changeSubscription` | `subscription.change` | SESSION | `subscriptionChangeSchema` | `SubscriptionView` | yes |
| `listInvoices` | `invoice.list` | SESSION | `invoiceFilterSchema` | `InvoiceListView` |  |
| `getInvoice` | `invoice.read` | SESSION | `invoiceIdSchema` | `InvoiceView` |  |
| `createManualInvoice` | `invoice.create` | ADMIN | `manualInvoiceCreateSchema` | `InvoiceView` |  |
| `getBillingDashboard` | `billing.dashboard` | ADMIN | `billingDashboardRangeSchema` | `BillingDashboardView` |  |

## `server/actions/booking.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `requestAppointment` | `appointment.create` | SESSION | `appointmentCreateSchema` | `_(inferred)_` | yes |
| `rescheduleAppointment` | `appointment.reschedule` | SESSION | `appointmentRescheduleSchema` | `_(inferred)_` |  |
| `repriceAppointment` | `appointment.reprice` | CHEF_STAFF | `appointmentRepriceSchema` | `AppointmentView` |  |
| `confirmAppointment` | `appointment.confirm` | CHEF_STAFF | `appointmentConfirmSchema` | `_(inferred)_` |  |
| `cancelAppointment` | `appointment.cancel` | SESSION | `appointmentCancelInputSchema` | `_(inferred)_` |  |
| `completeAppointment` | `appointment.complete` | CHEF_STAFF | `appointmentCompleteSchema` | `_(inferred)_` |  |
| `transitionAppointment` | `appointment.transition` | CHEF_STAFF | `appointmentStatusTransitionSchema` | `_(inferred)_` |  |
| `holdBookingSlot` | `booking.holdSlot` | CHEF_STAFF | `slotHoldSchema` | `_(inferred)_` |  |
| `releaseBookingSlot` | `booking.releaseSlot` | CHEF_STAFF | `slotIdSchema` | `_(inferred)_` |  |
| `getAppointment` | `appointment.detail` | SESSION | `appointmentIdSchema` | `_(inferred)_` |  |
| `listAppointments` | `appointment.list` | SESSION | `appointmentFilterSchema` | `_(inferred)_` |  |
| `getDispatchQueue` | `appointment.dispatchQueue` | CHEF_STAFF | `dispatchQueueSchema` | `_(inferred)_` |  |

## `server/actions/client.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `createClientProfile` | `client.profile.create` | SESSION | `clientProfileCreateSchema` | `ClientProfileView` |  |
| `updateClientProfile` | `client.profile.update` | SESSION | `clientProfileUpdateSchema` | `ClientProfileView` |  |
| `readClientProfile` | `client.profile.read` | SESSION | `clientProfileIdSchema` | `ClientProfileView` |  |
| `readMyClientProfile` | `client.profile.read.mine` | SESSION | `emptyInputSchema` | `ClientProfileView` |  |

## `server/actions/crm.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `createClientNote` | `crm.note.create` | CHEF_STAFF | `clientNoteCreateSchema` | `ClientNoteView` |  |
| `updateClientNote` | `crm.note.update` | SESSION | `clientNoteUpdateSchema` | `ClientNoteView` |  |
| `deleteClientNote` | `crm.note.delete` | SESSION | `clientNoteIdSchema` | `{ id: string }` |  |
| `listClientNotes` | `crm.note.list` | SESSION | `clientNoteFilterSchema` | `ClientNoteListView` |  |
| `logInteraction` | `crm.interaction.log` | CHEF_STAFF | `interactionLogCreateSchema` | `InteractionView` |  |
| `listInteractions` | `crm.interaction.list` | CHEF_STAFF | `interactionLogFilterSchema` | `InteractionListView` |  |
| `transitionClientStatus` | `crm.client.transition` | ADMIN | `clientStatusTransitionSchema` | `PipelineClientView` |  |
| `flagClientFollowUp` | `crm.client.followUp` | CHEF_STAFF | `clientFollowUpSchema` | `PipelineClientView` |  |
| `queryClientPipeline` | `crm.pipeline.query` | CHEF_STAFF | `clientPipelineFilterSchema` | `PipelineView` |  |
| `readLifetimeValueReport` | `crm.analytics.ltv` | ADMIN | `clientLtvBucketingSchema` | `LifetimeValueReport` |  |
| `recalculateLifetimeValues` | `crm.analytics.ltv.recalculate` | ADMIN | `emptyInputSchema` | `{ updatedClients: number }` |  |
| `readChurnRate` | `crm.analytics.churn` | ADMIN | `churnQuerySchema` | `ChurnReport` |  |
| `readCohortRetention` | `crm.analytics.cohorts` | ADMIN | `cohortQuerySchema` | `CohortRetentionReport` |  |

## `server/actions/intake.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `requestConsultation` | `intake.consultation.request` | PUBLIC | `consultationRequestSchema` | `ConsultationReceipt` | yes |
| `submitProspectIntake` | `intake.prospect.submit` | PUBLIC | `prospectIntakeSchema` | `ProspectIntakeReceipt` | yes |
| `submitIntake` | `intake.submit` | SESSION | `clientIntakeCreateSchema` | `IntakeSubmissionView` | yes |
| `listIntakeSubmissions` | `intake.list` | CHEF_STAFF | `clientIntakeFilterSchema` | `IntakeListView` |  |
| `getIntakeSubmission` | `intake.detail` | SESSION | `intakeFormIdSchema` | `IntakeFormView` |  |
| `scheduleConsultation` | `intake.consultation.schedule` | CHEF_STAFF | `consultationInterviewCreateSchema` | `ConsultationView` |  |
| `recordConsultationNotes` | `intake.consultation.record` | CHEF_STAFF | `consultationInterviewUpdateSchema` | `ConsultationView` |  |
| `listConsultations` | `intake.consultation.list` | SESSION | `consultationInterviewFilterSchema` | `ConsultationListView` |  |
| `scoreConsultationCompatibility` | `intake.consultation.score` | CHEF_STAFF | `consultationScoreSchema` | `CompatibilityBreakdown` |  |
| `convertProspect` | `intake.prospect.convert` | ADMIN | `prospectConversionSchema` | `ProspectConversionView` |  |

## `server/actions/media.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `listMediaAssets` | `media.list` | PUBLIC | `mediaAssetFilterSchema` | `MediaAssetListView` |  |
| `completeMediaUpload` | `media.upload.complete` | ADMIN | `mediaAssetFromUploadSchema` | `MediaUploadResultView` |  |
| `updateMediaAsset` | `media.update` | ADMIN | `mediaAssetUpdateSchema` | `MediaAssetMutationView` |  |
| `bulkTagMediaAssets` | `media.tags.bulk` | ADMIN | `mediaBulkTagSchema` | `MediaBulkTagResultView` |  |
| `deleteMediaAsset` | `media.delete` | ADMIN | `mediaAssetIdSchema` | `MediaDeletionView` |  |

## `server/actions/menu.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `listMenuItems` | `menu.list` | PUBLIC | `menuItemFilterSchema` | `MenuItemListView` |  |
| `getMenuItem` | `menu.detail` | PUBLIC | `menuDetailInputSchema` | `MenuItemDetailView` |  |
| `listMenuCategories` | `menu.categories.list` | PUBLIC | `menuCategoryFilterSchema` | `MenuCategoryListView` |  |
| `listMenuSubcategories` | `menu.subcategories.list` | PUBLIC | `menuSubcategoryFilterSchema` | `MenuSubcategoryListView` |  |
| `listTags` | `menu.tags.list` | PUBLIC | `tagFilterSchema` | `TagListView` |  |
| `listIngredients` | `menu.ingredients.list` | CHEF_STAFF | `ingredientFilterSchema` | `IngredientListView` |  |
| `createMenuCategory` | `menu.categories.create` | ADMIN | `menuCategoryCreateSchema` | `MenuCategoryMutationView` |  |
| `updateMenuCategory` | `menu.categories.update` | ADMIN | `menuCategoryUpdateSchema` | `MenuCategoryMutationView` |  |
| `deleteMenuCategory` | `menu.categories.delete` | ADMIN | `entityIdSchema` | `MenuDeletionView` |  |
| `createMenuSubcategory` | `menu.subcategories.create` | ADMIN | `menuSubcategoryCreateSchema` | `MenuSubcategoryMutationView` |  |
| `updateMenuSubcategory` | `menu.subcategories.update` | ADMIN | `menuSubcategoryUpdateSchema` | `MenuSubcategoryMutationView` |  |
| `deleteMenuSubcategory` | `menu.subcategories.delete` | ADMIN | `entityIdSchema` | `MenuDeletionView` |  |
| `createMenuItem` | `menu.items.create` | ADMIN | `menuItemCreateSchema` | `MenuItemMutationView` |  |
| `updateMenuItem` | `menu.items.update` | ADMIN | `menuItemUpdateSchema` | `MenuItemMutationView` |  |
| `deleteMenuItem` | `menu.items.delete` | ADMIN | `entityIdSchema` | `MenuDeletionView` |  |
| `toggleMenuItemSeasonal` | `menu.items.seasonal` | ADMIN | `menuItemSeasonalToggleSchema` | `MenuItemSeasonView` |  |
| `createTag` | `menu.tags.create` | ADMIN | `tagCreateSchema` | `TagMutationView` |  |
| `updateTag` | `menu.tags.update` | ADMIN | `tagUpdateSchema` | `TagMutationView` |  |
| `deleteTag` | `menu.tags.delete` | ADMIN | `entityIdSchema` | `MenuDeletionView` |  |
| `setMenuItemTags` | `menu.items.tags.set` | ADMIN | `menuItemTagAssignmentSchema` | `MenuItemTagSetView` |  |
| `createIngredient` | `menu.ingredients.create` | ADMIN | `ingredientCreateSchema` | `IngredientMutationView` |  |
| `updateIngredient` | `menu.ingredients.update` | ADMIN | `ingredientUpdateSchema` | `IngredientMutationView` |  |
| `deleteIngredient` | `menu.ingredients.delete` | ADMIN | `entityIdSchema` | `MenuDeletionView` |  |
| `setMenuItemIngredients` | `menu.items.ingredients.set` | ADMIN | `menuItemIngredientSetSchema` | `MenuItemIngredientSetView` |  |
| `setMenuItemMedia` | `menu.items.media.set` | ADMIN | `menuItemMediaAssociationSchema` | `MenuItemMediaSetView` |  |
| `runMenuItemBulkAction` | `menu.items.bulk` | ADMIN | `menuItemBulkActionSchema` | `MenuItemBulkResultView` |  |
| `reorderMenuEntries` | `menu.reorder` | ADMIN | `menuReorderSchema` | `MenuReorderView` |  |

## `server/actions/onboarding.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `advanceOnboardingStage` | `onboarding.advance` | CHEF_STAFF | `onboardingStageAdvanceSchema` | `OnboardingFlowView` |  |
| `completeOnboardingStep` | `onboarding.step.complete` | CHEF_STAFF | `onboardingStepCompletionSchema` | `OnboardingStepResultView` |  |
| `startOnboardingFlow` | `onboarding.start` | CHEF_STAFF | `onboardingFlowCreateSchema` | `OnboardingFlowView` |  |
| `amendOnboardingFlow` | `onboarding.amend` | ADMIN | `onboardingFlowUpdateSchema` | `OnboardingFlowView` |  |
| `readMyOnboarding` | `onboarding.read.mine` | SESSION | `emptyInputSchema` | `OnboardingFlowView` |  |
| `listOnboardingFlows` | `onboarding.read` | SESSION | `onboardingFlowFilterSchema` | `OnboardingListView` |  |

## `server/actions/referral-program.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `readReferralProgram` | `referral.program.read` | ADMIN | `referralProgramReadSchema` | `ReferralProgramView | null` |  |
| `updateReferralProgram` | `referral.program.update` | SUPER_ADMIN | `referralProgramUpsertSchema` | `ReferralProgramView` |  |

## `server/actions/referral.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `createReferralCode` | `referral.code.create` | SESSION | `referralCodeCreateSchema` | `ReferralCodeSummary` | yes |
| `updateReferralCode` | `referral.code.update` | SESSION | `referralCodeUpdateSchema` | `ReferralCodeSummary` |  |
| `deactivateReferralCode` | `referral.code.deactivate` | SESSION | `referralCodeIdSchema` | `ReferralCodeSummary` |  |
| `readReferralOverview` | `referral.read` | SESSION | `referralCodeFilterSchema` | `ReferralOverview` |  |
| `listReferralCodes` | `referral.code.list` | SESSION | `referralCodeFilterSchema` | `ReferralCodeListView` |  |
| `redeemReferralCode` | `referral.redeem` | SESSION | `referralRedemptionCreateSchema` | `ReferralRedemptionReceipt` | yes |
| `settleReferralRedemptions` | `referral.settle` | ADMIN | `referralSettlementSchema` | `ReferralSettlementView` |  |
| `updateReferralRedemption` | `referral.redemption.update` | ADMIN | `referralRedemptionStatusUpdateSchema` | `ReferralRedemptionView` |  |
| `listReferralRedemptions` | `referral.redemption.list` | SESSION | `referralRedemptionFilterSchema` | `ReferralRedemptionListView` |  |
| `readRewardLedger` | `referral.ledger.read` | SESSION | `rewardLedgerFilterSchema` | `RewardLedgerView` |  |
| `payReferralReward` | `referral.reward.pay` | SUPER_ADMIN | `rewardPayoutSchema` | `RewardLedgerEntryView` |  |
| `recordRewardAdjustment` | `referral.reward.adjust` | SUPER_ADMIN | `rewardAdjustmentSchema` | `RewardLedgerEntryView` |  |
| `recomputeRewardBalance` | `referral.balance.recompute` | ADMIN | `rewardSubjectSchema` | `RewardBalanceView` |  |

## `server/actions/review.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `submitReview` | `review.submit` | SESSION | `reviewSubmissionSchema` | `ReviewView` | yes |
| `updateMyReview` | `review.update` | SESSION | `reviewUpdateSchema` | `ReviewView` |  |
| `withdrawMyReview` | `review.withdraw` | SESSION | `reviewIdSchema` | `{ id: string }` |  |
| `listPublishedReviews` | `review.list.published` | PUBLIC | `reviewFilterSchema` | `ReviewListView` |  |
| `listMyReviews` | `review.list.mine` | SESSION | `reviewFilterSchema` | `ReviewListView` |  |
| `listModerationQueue` | `review.moderation.queue` | ADMIN | `reviewFilterSchema` | `ModerationQueueView` |  |
| `moderateReview` | `review.moderate` | ADMIN | `reviewModerationSchema` | `ModeratedReviewView` |  |
| `bulkModerateReviews` | `review.moderate.bulk` | ADMIN | `reviewBulkModerationSchema` | `BulkModerationView` |  |
| `getReviewForModeration` | `review.moderation.read` | ADMIN | `reviewIdSchema` | `ModeratedReviewView` |  |
| `canModerateReviews` | `review.moderation.permitted` | SESSION | `emptyInputSchema` | `{ permitted: boolean }` |  |

## `server/actions/staff.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `createStaffProfile` | `staff.profile.create` | ADMIN | `staffProfileCreateSchema` | `StaffRosterView` |  |
| `updateStaffProfile` | `staff.profile.update` | SESSION | `staffProfileUpdateSchema` | `StaffRosterView` |  |
| `deleteStaffProfile` | `staff.profile.delete` | ADMIN | `staffProfileIdSchema` | `{ id: string }` |  |
| `listStaffDirectory` | `staff.directory` | PUBLIC | `staffDirectoryFilterSchema` | `StaffDirectoryView` |  |
| `readStaffProfile` | `staff.profile.read` | PUBLIC | `staffProfileIdSchema` | `StaffProfileSummary` |  |
| `listStaffRoster` | `staff.roster` | ADMIN | `staffRosterFilterSchema` | `StaffRosterListView` |  |
| `readMyStaffProfile` | `staff.profile.read.mine` | CHEF_STAFF | `emptyInputSchema` | `StaffRosterView` |  |

## `server/actions/user.ts`

| export | action | auth | input schema | returns | rate-limited |
|---|---|---|---|---|---|
| `updateUserProfile` | `user.profile.update` | SESSION | `userProfileUpdateSchema` | `AccountView` |  |
| `assignUserRole` | `user.role.assign` | SUPER_ADMIN | `roleAssignmentSchema` | `AccountChangeView` |  |
| `setUserActive` | `user.activation.set` | ADMIN | `userActivationSchema` | `AccountChangeView` |  |
| `listUsers` | `user.list` | ADMIN | `userFilterSchema` | `AccountListView` |  |
| `readUserAccount` | `user.read` | ADMIN | `userIdSchema` | `AccountView` |  |
| `readMyAccount` | `user.read.mine` | SESSION | `emptyInputSchema` | `AccountView` |  |
