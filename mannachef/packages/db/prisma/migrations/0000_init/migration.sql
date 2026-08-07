-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'CHEF_STAFF', 'CLIENT');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('PROSPECT', 'LEAD_QUALIFIED', 'ACTIVE_SUBSCRIBER', 'PAUSED', 'CHURNED');

-- CreateEnum
CREATE TYPE "ClientSource" AS ENUM ('ORGANIC_SEARCH', 'PAID_SEARCH', 'SOCIAL', 'REFERRAL', 'PARTNER', 'EVENT', 'WORD_OF_MOUTH', 'DIRECT', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactMethod" AS ENUM ('EMAIL', 'PHONE', 'SMS', 'IN_APP');

-- CreateEnum
CREATE TYPE "TagKind" AS ENUM ('DIETARY', 'ALLERGEN', 'CUISINE', 'TECHNIQUE', 'OCCASION');

-- CreateEnum
CREATE TYPE "SpiceLevel" AS ENUM ('NONE', 'MILD', 'MEDIUM', 'HOT', 'FIERY');

-- CreateEnum
CREATE TYPE "MeasurementUnit" AS ENUM ('GRAM', 'KILOGRAM', 'MILLILITER', 'LITER', 'OUNCE', 'POUND', 'TEASPOON', 'TABLESPOON', 'CUP', 'PIECE', 'CLOVE', 'BUNCH', 'SLICE', 'PINCH', 'TO_TASTE');

-- CreateEnum
CREATE TYPE "MediaProvider" AS ENUM ('UPLOADTHING', 'S3', 'CLOUDINARY', 'VERCEL_BLOB', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO');

-- CreateEnum
CREATE TYPE "ReviewSubject" AS ENUM ('MENU_ITEM', 'CHEF', 'PLATFORM', 'APPOINTMENT');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FEATURED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'INCOMPLETE_EXPIRED', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'PAUSED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REQUIRES_PAYMENT_METHOD', 'REQUIRES_CONFIRMATION', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'CANCELED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('CARD', 'ACH_DEBIT', 'BANK_TRANSFER', 'INTERAC', 'CASH', 'CHEQUE', 'CREDIT_BALANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('SUBSCRIPTION', 'APPOINTMENT', 'MENU_ITEM', 'INGREDIENT_COST', 'TRAVEL', 'GRATUITY', 'DISCOUNT', 'TAX', 'OTHER');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('FIXED_CREDIT', 'PERCENT_DISCOUNT', 'FREE_MEAL', 'FREE_DELIVERY');

-- CreateEnum
CREATE TYPE "ReferralRedemptionStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RewardLedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "RewardLedgerReason" AS ENUM ('REFERRAL_REWARD', 'REFERRAL_SIGNUP_BONUS', 'PROMOTIONAL_GRANT', 'MANUAL_ADJUSTMENT', 'INVOICE_REDEMPTION', 'EXPIRATION', 'REVERSAL');

-- CreateEnum
CREATE TYPE "OnboardingStage" AS ENUM ('INVITED', 'ACCOUNT_CREATED', 'INTAKE_SUBMITTED', 'CONSULTATION_SCHEDULED', 'CONSULTATION_COMPLETED', 'PLAN_SELECTED', 'PAYMENT_CONFIRMED', 'FIRST_APPOINTMENT_BOOKED', 'ACTIVATED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "DeliveryFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ON_DEMAND');

-- CreateEnum
CREATE TYPE "ConsultationOutcome" AS ENUM ('PENDING', 'CONVERTED', 'DECLINED_BY_CLIENT', 'DECLINED_BY_CHEF', 'NO_SHOW', 'RESCHEDULED', 'FOLLOW_UP_REQUIRED');

-- CreateEnum
CREATE TYPE "AvailabilityRuleKind" AS ENUM ('RECURRING_WEEKLY', 'DATE_OVERRIDE');

-- CreateEnum
CREATE TYPE "BookingSlotStatus" AS ENUM ('OPEN', 'HELD', 'BOOKED', 'FULL', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('IN_HOME_DINNER', 'MEAL_PREP', 'PRIVATE_EVENT', 'COOKING_CLASS', 'TASTING', 'CATERING', 'CONSULTATION', 'DELIVERY_DROP_OFF');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "NoteVisibility" AS ENUM ('PRIVATE', 'STAFF', 'ADMIN_ONLY', 'CLIENT_VISIBLE');

-- CreateEnum
CREATE TYPE "InteractionChannel" AS ENUM ('EMAIL', 'PHONE', 'SMS', 'IN_APP', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "InteractionDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200),
    "email" VARCHAR(320),
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "phone" VARCHAR(32),
    "timeZone" VARCHAR(64) NOT NULL DEFAULT 'America/Toronto',
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-CA',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "refresh_token_expires_in" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Authenticator" (
    "credentialID" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "credentialPublicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "credentialDeviceType" TEXT NOT NULL,
    "credentialBackedUp" BOOLEAN NOT NULL,
    "transports" TEXT,

    CONSTRAINT "Authenticator_pkey" PRIMARY KEY ("userId","credentialID")
);

-- CreateTable
CREATE TABLE "ClientProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" VARCHAR(200),
    "status" "ClientStatus" NOT NULL DEFAULT 'PROSPECT',
    "source" "ClientSource" NOT NULL DEFAULT 'DIRECT',
    "sourceDetail" VARCHAR(200),
    "preferredName" VARCHAR(120),
    "phone" VARCHAR(32),
    "preferredContactMethod" "ContactMethod" NOT NULL DEFAULT 'EMAIL',
    "lifetimeValueCents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "lastContactedAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "churnedAt" TIMESTAMP(3),
    "churnReason" TEXT,
    "vipNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(160),
    "bio" TEXT,
    "specialties" TEXT[],
    "languages" TEXT[],
    "hourlyRateCents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "serviceRadiusKm" INTEGER NOT NULL DEFAULT 25,
    "yearsExperience" INTEGER,
    "baseCity" VARCHAR(120),
    "baseRegion" VARCHAR(120),
    "baseCountry" VARCHAR(2),
    "calendarTimeZone" VARCHAR(64) NOT NULL DEFAULT 'America/Toronto',
    "isAcceptingClients" BOOLEAN NOT NULL DEFAULT true,
    "maxConcurrentEvents" INTEGER NOT NULL DEFAULT 1,
    "isPubliclyListed" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "avatarMediaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "tagline" VARCHAR(280),
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "heroMediaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuSubcategory" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuSubcategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subcategoryId" TEXT,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "story" TEXT,
    "tastingNote" TEXT,
    "pairingNote" TEXT,
    "chefNote" TEXT,
    "basePriceCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "servingSize" VARCHAR(120),
    "servingsPerUnit" INTEGER,
    "prepTimeMinutes" INTEGER,
    "cookTimeMinutes" INTEGER,
    "calories" INTEGER,
    "proteinGram" INTEGER,
    "carbGram" INTEGER,
    "fatGram" INTEGER,
    "spiceLevel" "SpiceLevel" NOT NULL DEFAULT 'NONE',
    "isSeasonal" BOOLEAN NOT NULL DEFAULT false,
    "seasonStart" INTEGER,
    "seasonEnd" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSignature" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "kind" "TagKind" NOT NULL,
    "description" TEXT,
    "colorToken" VARCHAR(64),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemTag" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "sourcingNote" TEXT,
    "isAllergen" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultUnit" "MeasurementUnit" NOT NULL DEFAULT 'GRAM',
    "unitCostCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemIngredient" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unit" "MeasurementUnit" NOT NULL DEFAULT 'GRAM',
    "preparation" VARCHAR(200),
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "isGarnish" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemMedia" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "caption" VARCHAR(280),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "alt" VARCHAR(400) NOT NULL,
    "caption" TEXT,
    "credit" VARCHAR(200),
    "kind" "MediaKind" NOT NULL DEFAULT 'IMAGE',
    "provider" "MediaProvider" NOT NULL DEFAULT 'UPLOADTHING',
    "providerFileKey" VARCHAR(255),
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "mimeType" VARCHAR(160) NOT NULL,
    "blurData" TEXT,
    "checksum" VARCHAR(128),
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaTag" (
    "id" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "subject" "ReviewSubject" NOT NULL DEFAULT 'MENU_ITEM',
    "menuItemId" TEXT,
    "staffProfileId" TEXT,
    "appointmentId" TEXT,
    "authorId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" VARCHAR(200),
    "body" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "featuredOrder" INTEGER,
    "moderatedById" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "moderationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "tagline" VARCHAR(280),
    "description" TEXT,
    "stripePriceId" VARCHAR(255) NOT NULL,
    "stripeProductId" VARCHAR(255) NOT NULL,
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTH',
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "priceCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "setupFeeCents" INTEGER,
    "trialDays" INTEGER,
    "mealsPerWeek" INTEGER NOT NULL,
    "servingsPerMeal" INTEGER NOT NULL,
    "features" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stripeSubscriptionId" VARCHAR(255) NOT NULL,
    "stripeCustomerId" VARCHAR(255) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "endedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "appointmentId" TEXT,
    "issuedById" TEXT,
    "stripeInvoiceId" VARCHAR(255),
    "number" VARCHAR(64),
    "amountDueCents" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "amountRemainingCents" INTEGER NOT NULL DEFAULT 0,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "hostedInvoiceUrl" TEXT,
    "pdfUrl" TEXT,
    "description" TEXT,
    "memo" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL DEFAULT 'OTHER',
    "description" VARCHAR(400) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmountCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stripeInvoiceItemId" VARCHAR(255),
    "sourceRefId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "subscriptionId" TEXT,
    "stripePaymentIntentId" VARCHAR(255),
    "stripeChargeId" VARCHAR(255),
    "amountCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "feeCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PROCESSING',
    "method" "PaymentMethodType" NOT NULL DEFAULT 'CARD',
    "cardBrand" VARCHAR(40),
    "cardLast4" VARCHAR(4),
    "failureCode" VARCHAR(120),
    "failureReason" TEXT,
    "receiptUrl" TEXT,
    "processedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" VARCHAR(255) NOT NULL,
    "type" VARCHAR(160) NOT NULL,
    "apiVersion" VARCHAR(40),
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "payloadHash" VARCHAR(64) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "ownerId" TEXT NOT NULL,
    "label" VARCHAR(160),
    "rewardType" "RewardType" NOT NULL DEFAULT 'FIXED_CREDIT',
    "rewardValueCents" INTEGER,
    "rewardValuePercent" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "refereeRewardCents" INTEGER,
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralRedemption" (
    "id" TEXT NOT NULL,
    "referralCodeId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "status" "ReferralRedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "qualifiedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "rewardCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardBalance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarnedCents" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRedeemedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "lastEarnedAt" TIMESTAMP(3),
    "lastRedeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balanceId" TEXT,
    "direction" "RewardLedgerDirection" NOT NULL,
    "reason" "RewardLedgerReason" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "referralRedemptionId" TEXT,
    "invoiceId" TEXT,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingFlow" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "currentStage" "OnboardingStage" NOT NULL DEFAULT 'INVITED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),
    "abandonedReason" TEXT,
    "lastAdvancedAt" TIMESTAMP(3),
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingStepCompletion" (
    "id" TEXT NOT NULL,
    "onboardingFlowId" TEXT NOT NULL,
    "stage" "OnboardingStage" NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingStepCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientIntakeForm" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "householdSize" INTEGER NOT NULL DEFAULT 1,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "allergies" TEXT[],
    "dislikes" TEXT[],
    "cuisinePreferences" TEXT[],
    "kitchenEquipment" TEXT[],
    "favouriteDishes" TEXT[],
    "hasPets" BOOLEAN NOT NULL DEFAULT false,
    "petsNote" VARCHAR(280),
    "deliveryFrequency" "DeliveryFrequency" NOT NULL DEFAULT 'WEEKLY',
    "budgetPerMealCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "serviceAddressLine1" VARCHAR(200),
    "serviceAddressLine2" VARCHAR(200),
    "serviceCity" VARCHAR(120),
    "serviceRegion" VARCHAR(120),
    "servicePostalCode" VARCHAR(20),
    "serviceCountry" VARCHAR(2),
    "serviceAccessNotes" TEXT,
    "preferredContactMethod" "ContactMethod" NOT NULL DEFAULT 'EMAIL',
    "preferredCookDays" TEXT[],
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientIntakeForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientIntakeFormTag" (
    "id" TEXT NOT NULL,
    "clientIntakeFormId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientIntakeFormTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationInterview" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "conductedById" TEXT,
    "staffProfileId" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "location" VARCHAR(200),
    "meetingUrl" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "compatibilityScore" INTEGER,
    "notes" TEXT,
    "chefSummary" TEXT,
    "outcome" "ConsultationOutcome" NOT NULL DEFAULT 'PENDING',
    "followUpAt" TIMESTAMP(3),
    "convertedToClientAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChefAvailability" (
    "id" TEXT NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "kind" "AvailabilityRuleKind" NOT NULL DEFAULT 'RECURRING_WEEKLY',
    "dayOfWeek" INTEGER,
    "specificDate" DATE,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "timeZone" VARCHAR(64) NOT NULL DEFAULT 'America/Toronto',
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "isBlackout" BOOLEAN NOT NULL DEFAULT false,
    "reason" VARCHAR(280),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChefAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSlot" (
    "id" TEXT NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "bookedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "BookingSlotStatus" NOT NULL DEFAULT 'OPEN',
    "serviceType" "ServiceType",
    "priceCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "holdsUntil" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChefAppointment" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "bookingSlotId" TEXT,
    "serviceType" "ServiceType" NOT NULL DEFAULT 'IN_HOME_DINNER',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "prepStartsAt" TIMESTAMP(3),
    "travelBufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "travelBufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "guestCount" INTEGER NOT NULL DEFAULT 2,
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(120),
    "region" VARCHAR(120),
    "postalCode" VARCHAR(20),
    "country" VARCHAR(2),
    "accessNotes" TEXT,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "gratuityCents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "clientNotes" TEXT,
    "chefNotes" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChefAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentMenuItem" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "courseOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "priceCentsAtBooking" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentMenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientNote" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteractionLog" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "loggedById" TEXT,
    "channel" "InteractionChannel" NOT NULL,
    "direction" "InteractionDirection" NOT NULL DEFAULT 'OUTBOUND',
    "subject" VARCHAR(280),
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMinutes" INTEGER,
    "externalRef" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteractionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expires_idx" ON "Session"("expires");

-- CreateIndex
CREATE INDEX "VerificationToken_expires_idx" ON "VerificationToken"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Authenticator_credentialID_key" ON "Authenticator"("credentialID");

-- CreateIndex
CREATE INDEX "Authenticator_userId_idx" ON "Authenticator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientProfile_userId_key" ON "ClientProfile"("userId");

-- CreateIndex
CREATE INDEX "ClientProfile_status_followUpAt_idx" ON "ClientProfile"("status", "followUpAt");

-- CreateIndex
CREATE INDEX "ClientProfile_status_lastContactedAt_idx" ON "ClientProfile"("status", "lastContactedAt");

-- CreateIndex
CREATE INDEX "ClientProfile_source_idx" ON "ClientProfile"("source");

-- CreateIndex
CREATE INDEX "ClientProfile_createdAt_idx" ON "ClientProfile"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userId_key" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "StaffProfile_isAcceptingClients_isPubliclyListed_idx" ON "StaffProfile"("isAcceptingClients", "isPubliclyListed");

-- CreateIndex
CREATE INDEX "StaffProfile_avatarMediaId_idx" ON "StaffProfile"("avatarMediaId");

-- CreateIndex
CREATE INDEX "StaffProfile_sortOrder_idx" ON "StaffProfile"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCategory_slug_key" ON "MenuCategory"("slug");

-- CreateIndex
CREATE INDEX "MenuCategory_isActive_sortOrder_idx" ON "MenuCategory"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuCategory_heroMediaId_idx" ON "MenuCategory"("heroMediaId");

-- CreateIndex
CREATE INDEX "MenuSubcategory_categoryId_sortOrder_idx" ON "MenuSubcategory"("categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuSubcategory_isActive_idx" ON "MenuSubcategory"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MenuSubcategory_categoryId_slug_key" ON "MenuSubcategory"("categoryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_slug_key" ON "MenuItem"("slug");

-- CreateIndex
CREATE INDEX "MenuItem_categoryId_isActive_sortOrder_idx" ON "MenuItem"("categoryId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuItem_subcategoryId_idx" ON "MenuItem"("subcategoryId");

-- CreateIndex
CREATE INDEX "MenuItem_isActive_isSignature_idx" ON "MenuItem"("isActive", "isSignature");

-- CreateIndex
CREATE INDEX "MenuItem_isSeasonal_seasonStart_seasonEnd_idx" ON "MenuItem"("isSeasonal", "seasonStart", "seasonEnd");

-- CreateIndex
CREATE INDEX "MenuItem_basePriceCents_idx" ON "MenuItem"("basePriceCents");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_key" ON "Tag"("slug");

-- CreateIndex
CREATE INDEX "Tag_kind_sortOrder_idx" ON "Tag"("kind", "sortOrder");

-- CreateIndex
CREATE INDEX "Tag_isActive_idx" ON "Tag"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_kind_name_key" ON "Tag"("kind", "name");

-- CreateIndex
CREATE INDEX "MenuItemTag_tagId_idx" ON "MenuItemTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemTag_menuItemId_tagId_key" ON "MenuItemTag"("menuItemId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_slug_key" ON "Ingredient"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient"("name");

-- CreateIndex
CREATE INDEX "Ingredient_isAllergen_idx" ON "Ingredient"("isAllergen");

-- CreateIndex
CREATE INDEX "Ingredient_isActive_idx" ON "Ingredient"("isActive");

-- CreateIndex
CREATE INDEX "MenuItemIngredient_ingredientId_idx" ON "MenuItemIngredient"("ingredientId");

-- CreateIndex
CREATE INDEX "MenuItemIngredient_menuItemId_sortOrder_idx" ON "MenuItemIngredient"("menuItemId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemIngredient_menuItemId_ingredientId_key" ON "MenuItemIngredient"("menuItemId", "ingredientId");

-- CreateIndex
CREATE INDEX "MenuItemMedia_mediaAssetId_idx" ON "MenuItemMedia"("mediaAssetId");

-- CreateIndex
CREATE INDEX "MenuItemMedia_menuItemId_sortOrder_idx" ON "MenuItemMedia"("menuItemId", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuItemMedia_menuItemId_isPrimary_idx" ON "MenuItemMedia"("menuItemId", "isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemMedia_menuItemId_mediaAssetId_key" ON "MenuItemMedia"("menuItemId", "mediaAssetId");

-- CreateIndex
CREATE INDEX "MediaAsset_uploadedById_idx" ON "MediaAsset"("uploadedById");

-- CreateIndex
CREATE INDEX "MediaAsset_kind_createdAt_idx" ON "MediaAsset"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_createdAt_idx" ON "MediaAsset"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_provider_providerFileKey_key" ON "MediaAsset"("provider", "providerFileKey");

-- CreateIndex
CREATE INDEX "MediaTag_tagId_idx" ON "MediaTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaTag_mediaAssetId_tagId_key" ON "MediaTag"("mediaAssetId", "tagId");

-- CreateIndex
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Review_menuItemId_status_idx" ON "Review"("menuItemId", "status");

-- CreateIndex
CREATE INDEX "Review_staffProfileId_status_idx" ON "Review"("staffProfileId", "status");

-- CreateIndex
CREATE INDEX "Review_subject_status_idx" ON "Review"("subject", "status");

-- CreateIndex
CREATE INDEX "Review_authorId_idx" ON "Review"("authorId");

-- CreateIndex
CREATE INDEX "Review_appointmentId_idx" ON "Review"("appointmentId");

-- CreateIndex
CREATE INDEX "Review_moderatedById_idx" ON "Review"("moderatedById");

-- CreateIndex
CREATE INDEX "Review_status_featuredOrder_idx" ON "Review"("status", "featuredOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Review_authorId_menuItemId_key" ON "Review"("authorId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_slug_key" ON "SubscriptionPlan"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_stripePriceId_key" ON "SubscriptionPlan"("stripePriceId");

-- CreateIndex
CREATE INDEX "SubscriptionPlan_isActive_sortOrder_idx" ON "SubscriptionPlan"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "SubscriptionPlan_stripeProductId_idx" ON "SubscriptionPlan"("stripeProductId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_stripeSubscriptionId_key" ON "UserSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "UserSubscription_userId_status_idx" ON "UserSubscription"("userId", "status");

-- CreateIndex
CREATE INDEX "UserSubscription_planId_idx" ON "UserSubscription"("planId");

-- CreateIndex
CREATE INDEX "UserSubscription_status_currentPeriodEnd_idx" ON "UserSubscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "UserSubscription_stripeCustomerId_idx" ON "UserSubscription"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_userId_status_idx" ON "Invoice"("userId", "status");

-- CreateIndex
CREATE INDEX "Invoice_status_dueAt_idx" ON "Invoice"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Invoice_status_createdAt_idx" ON "Invoice"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_subscriptionId_idx" ON "Invoice"("subscriptionId");

-- CreateIndex
CREATE INDEX "Invoice_appointmentId_idx" ON "Invoice"("appointmentId");

-- CreateIndex
CREATE INDEX "Invoice_issuedById_idx" ON "Invoice"("issuedById");

-- CreateIndex
CREATE INDEX "Invoice_isManual_status_idx" ON "Invoice"("isManual", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineItem_stripeInvoiceItemId_key" ON "InvoiceLineItem"("stripeInvoiceItemId");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_invoiceId_sortOrder_idx" ON "InvoiceLineItem"("invoiceId", "sortOrder");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_kind_idx" ON "InvoiceLineItem"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentHistory_stripePaymentIntentId_key" ON "PaymentHistory"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentHistory_userId_status_idx" ON "PaymentHistory"("userId", "status");

-- CreateIndex
CREATE INDEX "PaymentHistory_status_createdAt_idx" ON "PaymentHistory"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentHistory_invoiceId_idx" ON "PaymentHistory"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentHistory_subscriptionId_idx" ON "PaymentHistory"("subscriptionId");

-- CreateIndex
CREATE INDEX "PaymentHistory_stripeChargeId_idx" ON "PaymentHistory"("stripeChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeEvent_stripeEventId_key" ON "StripeEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeEvent_type_receivedAt_idx" ON "StripeEvent"("type", "receivedAt");

-- CreateIndex
CREATE INDEX "StripeEvent_processedAt_idx" ON "StripeEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE INDEX "ReferralCode_ownerId_isActive_idx" ON "ReferralCode"("ownerId", "isActive");

-- CreateIndex
CREATE INDEX "ReferralCode_isActive_expiresAt_idx" ON "ReferralCode"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "ReferralRedemption_referredUserId_idx" ON "ReferralRedemption"("referredUserId");

-- CreateIndex
CREATE INDEX "ReferralRedemption_status_createdAt_idx" ON "ReferralRedemption"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralRedemption_referralCodeId_referredUserId_key" ON "ReferralRedemption"("referralCodeId", "referredUserId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardBalance_userId_key" ON "RewardBalance"("userId");

-- CreateIndex
CREATE INDEX "RewardBalance_balanceCents_idx" ON "RewardBalance"("balanceCents");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_userId_createdAt_idx" ON "RewardLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_balanceId_idx" ON "RewardLedgerEntry"("balanceId");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_reason_createdAt_idx" ON "RewardLedgerEntry"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_referralRedemptionId_idx" ON "RewardLedgerEntry"("referralRedemptionId");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_invoiceId_idx" ON "RewardLedgerEntry"("invoiceId");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_createdById_idx" ON "RewardLedgerEntry"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingFlow_clientProfileId_key" ON "OnboardingFlow"("clientProfileId");

-- CreateIndex
CREATE INDEX "OnboardingFlow_currentStage_lastAdvancedAt_idx" ON "OnboardingFlow"("currentStage", "lastAdvancedAt");

-- CreateIndex
CREATE INDEX "OnboardingFlow_completedAt_idx" ON "OnboardingFlow"("completedAt");

-- CreateIndex
CREATE INDEX "OnboardingStepCompletion_stage_completedAt_idx" ON "OnboardingStepCompletion"("stage", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingStepCompletion_onboardingFlowId_stage_key" ON "OnboardingStepCompletion"("onboardingFlowId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ClientIntakeForm_clientProfileId_key" ON "ClientIntakeForm"("clientProfileId");

-- CreateIndex
CREATE INDEX "ClientIntakeForm_submittedAt_idx" ON "ClientIntakeForm"("submittedAt");

-- CreateIndex
CREATE INDEX "ClientIntakeForm_deliveryFrequency_idx" ON "ClientIntakeForm"("deliveryFrequency");

-- CreateIndex
CREATE INDEX "ClientIntakeFormTag_tagId_idx" ON "ClientIntakeFormTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientIntakeFormTag_clientIntakeFormId_tagId_key" ON "ClientIntakeFormTag"("clientIntakeFormId", "tagId");

-- CreateIndex
CREATE INDEX "ConsultationInterview_clientProfileId_scheduledFor_idx" ON "ConsultationInterview"("clientProfileId", "scheduledFor");

-- CreateIndex
CREATE INDEX "ConsultationInterview_outcome_scheduledFor_idx" ON "ConsultationInterview"("outcome", "scheduledFor");

-- CreateIndex
CREATE INDEX "ConsultationInterview_conductedById_scheduledFor_idx" ON "ConsultationInterview"("conductedById", "scheduledFor");

-- CreateIndex
CREATE INDEX "ConsultationInterview_staffProfileId_scheduledFor_idx" ON "ConsultationInterview"("staffProfileId", "scheduledFor");

-- CreateIndex
CREATE INDEX "ChefAvailability_staffProfileId_kind_idx" ON "ChefAvailability"("staffProfileId", "kind");

-- CreateIndex
CREATE INDEX "ChefAvailability_staffProfileId_dayOfWeek_idx" ON "ChefAvailability"("staffProfileId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "ChefAvailability_staffProfileId_specificDate_idx" ON "ChefAvailability"("staffProfileId", "specificDate");

-- CreateIndex
CREATE INDEX "ChefAvailability_effectiveFrom_effectiveUntil_idx" ON "ChefAvailability"("effectiveFrom", "effectiveUntil");

-- CreateIndex
CREATE INDEX "ChefAvailability_isBlackout_idx" ON "ChefAvailability"("isBlackout");

-- CreateIndex
CREATE UNIQUE INDEX "ChefAvailability_staffProfileId_kind_dayOfWeek_specificDate_key" ON "ChefAvailability"("staffProfileId", "kind", "dayOfWeek", "specificDate", "startMinute", "endMinute");

-- CreateIndex
CREATE INDEX "BookingSlot_staffProfileId_startsAt_idx" ON "BookingSlot"("staffProfileId", "startsAt");

-- CreateIndex
CREATE INDEX "BookingSlot_status_startsAt_idx" ON "BookingSlot"("status", "startsAt");

-- CreateIndex
CREATE INDEX "BookingSlot_serviceType_startsAt_idx" ON "BookingSlot"("serviceType", "startsAt");

-- CreateIndex
CREATE INDEX "BookingSlot_startsAt_endsAt_idx" ON "BookingSlot"("startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSlot_staffProfileId_startsAt_endsAt_key" ON "BookingSlot"("staffProfileId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "ChefAppointment_clientProfileId_startsAt_idx" ON "ChefAppointment"("clientProfileId", "startsAt");

-- CreateIndex
CREATE INDEX "ChefAppointment_staffProfileId_startsAt_idx" ON "ChefAppointment"("staffProfileId", "startsAt");

-- CreateIndex
CREATE INDEX "ChefAppointment_status_startsAt_idx" ON "ChefAppointment"("status", "startsAt");

-- CreateIndex
CREATE INDEX "ChefAppointment_serviceType_status_idx" ON "ChefAppointment"("serviceType", "status");

-- CreateIndex
CREATE INDEX "ChefAppointment_bookingSlotId_idx" ON "ChefAppointment"("bookingSlotId");

-- CreateIndex
CREATE INDEX "ChefAppointment_cancelledById_idx" ON "ChefAppointment"("cancelledById");

-- CreateIndex
CREATE INDEX "ChefAppointment_startsAt_endsAt_idx" ON "ChefAppointment"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AppointmentMenuItem_menuItemId_idx" ON "AppointmentMenuItem"("menuItemId");

-- CreateIndex
CREATE INDEX "AppointmentMenuItem_appointmentId_courseOrder_idx" ON "AppointmentMenuItem"("appointmentId", "courseOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentMenuItem_appointmentId_menuItemId_key" ON "AppointmentMenuItem"("appointmentId", "menuItemId");

-- CreateIndex
CREATE INDEX "ClientNote_clientProfileId_pinned_createdAt_idx" ON "ClientNote"("clientProfileId", "pinned", "createdAt");

-- CreateIndex
CREATE INDEX "ClientNote_clientProfileId_createdAt_idx" ON "ClientNote"("clientProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientNote_authorId_idx" ON "ClientNote"("authorId");

-- CreateIndex
CREATE INDEX "ClientNote_visibility_idx" ON "ClientNote"("visibility");

-- CreateIndex
CREATE INDEX "InteractionLog_clientProfileId_occurredAt_idx" ON "InteractionLog"("clientProfileId", "occurredAt");

-- CreateIndex
CREATE INDEX "InteractionLog_channel_occurredAt_idx" ON "InteractionLog"("channel", "occurredAt");

-- CreateIndex
CREATE INDEX "InteractionLog_direction_occurredAt_idx" ON "InteractionLog"("direction", "occurredAt");

-- CreateIndex
CREATE INDEX "InteractionLog_loggedById_idx" ON "InteractionLog"("loggedById");

-- CreateIndex
CREATE INDEX "InteractionLog_externalRef_idx" ON "InteractionLog"("externalRef");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Authenticator" ADD CONSTRAINT "Authenticator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientProfile" ADD CONSTRAINT "ClientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_avatarMediaId_fkey" FOREIGN KEY ("avatarMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_heroMediaId_fkey" FOREIGN KEY ("heroMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuSubcategory" ADD CONSTRAINT "MenuSubcategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "MenuSubcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemTag" ADD CONSTRAINT "MenuItemTag_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemTag" ADD CONSTRAINT "MenuItemTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemIngredient" ADD CONSTRAINT "MenuItemIngredient_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemIngredient" ADD CONSTRAINT "MenuItemIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemMedia" ADD CONSTRAINT "MenuItemMedia_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemMedia" ADD CONSTRAINT "MenuItemMedia_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaTag" ADD CONSTRAINT "MediaTag_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaTag" ADD CONSTRAINT "MediaTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "ChefAppointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "ChefAppointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentHistory" ADD CONSTRAINT "PaymentHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentHistory" ADD CONSTRAINT "PaymentHistory_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentHistory" ADD CONSTRAINT "PaymentHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralRedemption" ADD CONSTRAINT "ReferralRedemption_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralRedemption" ADD CONSTRAINT "ReferralRedemption_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardBalance" ADD CONSTRAINT "RewardBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_balanceId_fkey" FOREIGN KEY ("balanceId") REFERENCES "RewardBalance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_referralRedemptionId_fkey" FOREIGN KEY ("referralRedemptionId") REFERENCES "ReferralRedemption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingFlow" ADD CONSTRAINT "OnboardingFlow_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "ClientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStepCompletion" ADD CONSTRAINT "OnboardingStepCompletion_onboardingFlowId_fkey" FOREIGN KEY ("onboardingFlowId") REFERENCES "OnboardingFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientIntakeForm" ADD CONSTRAINT "ClientIntakeForm_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "ClientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientIntakeFormTag" ADD CONSTRAINT "ClientIntakeFormTag_clientIntakeFormId_fkey" FOREIGN KEY ("clientIntakeFormId") REFERENCES "ClientIntakeForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientIntakeFormTag" ADD CONSTRAINT "ClientIntakeFormTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationInterview" ADD CONSTRAINT "ConsultationInterview_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "ClientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationInterview" ADD CONSTRAINT "ConsultationInterview_conductedById_fkey" FOREIGN KEY ("conductedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationInterview" ADD CONSTRAINT "ConsultationInterview_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefAvailability" ADD CONSTRAINT "ChefAvailability_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefAppointment" ADD CONSTRAINT "ChefAppointment_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "ClientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefAppointment" ADD CONSTRAINT "ChefAppointment_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "StaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefAppointment" ADD CONSTRAINT "ChefAppointment_bookingSlotId_fkey" FOREIGN KEY ("bookingSlotId") REFERENCES "BookingSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChefAppointment" ADD CONSTRAINT "ChefAppointment_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentMenuItem" ADD CONSTRAINT "AppointmentMenuItem_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "ChefAppointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentMenuItem" ADD CONSTRAINT "AppointmentMenuItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientNote" ADD CONSTRAINT "ClientNote_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "ClientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientNote" ADD CONSTRAINT "ClientNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractionLog" ADD CONSTRAINT "InteractionLog_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "ClientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractionLog" ADD CONSTRAINT "InteractionLog_loggedById_fkey" FOREIGN KEY ("loggedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- HAND-WRITTEN ADDITIONS (MCV-007) — DO NOT DELETE ON REGENERATION
-- =============================================================================
-- Everything below this marker is hand-written and is NOT produced by
-- `prisma migrate diff`. It encodes invariants the Prisma DSL cannot express
-- (CHECK constraints, partial unique indexes). If this migration is ever
-- regenerated from a schema diff, re-append this exact block afterwards.
-- See packages/db/README.md for the full explanation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Documented numeric ranges the Prisma DSL cannot enforce
-- -----------------------------------------------------------------------------

-- Review.rating: "1-5 inclusive" (schema.prisma comment)
ALTER TABLE "Review"
  ADD CONSTRAINT "Review_rating_range_check"
  CHECK ("rating" >= 1 AND "rating" <= 5);

-- ConsultationInterview.compatibilityScore: "0-100 fit score" (nullable until scored)
ALTER TABLE "ConsultationInterview"
  ADD CONSTRAINT "ConsultationInterview_compatibilityScore_range_check"
  CHECK ("compatibilityScore" IS NULL OR ("compatibilityScore" >= 0 AND "compatibilityScore" <= 100));

-- MenuItem.seasonStart / seasonEnd: "1-12, inclusive. Null when the item is not seasonal."
-- Deliberately no seasonStart <= seasonEnd ordering constraint: a season that wraps the
-- calendar year (e.g. Nov-Feb, seasonStart=11, seasonEnd=2) is a legitimate value.
ALTER TABLE "MenuItem"
  ADD CONSTRAINT "MenuItem_seasonStart_range_check"
  CHECK ("seasonStart" IS NULL OR ("seasonStart" >= 1 AND "seasonStart" <= 12));

ALTER TABLE "MenuItem"
  ADD CONSTRAINT "MenuItem_seasonEnd_range_check"
  CHECK ("seasonEnd" IS NULL OR ("seasonEnd" >= 1 AND "seasonEnd" <= 12));

-- ChefAvailability.dayOfWeek: "0-6, Sunday-indexed. Null for DATE_OVERRIDE rules."
ALTER TABLE "ChefAvailability"
  ADD CONSTRAINT "ChefAvailability_dayOfWeek_range_check"
  CHECK ("dayOfWeek" IS NULL OR ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6));

-- ChefAvailability.startMinute / endMinute: "Minutes from local midnight, 0-1440."
-- startMinute can equal 0 (midnight) but never reach 1440 (that's the end-of-day boundary,
-- only valid as an end time). endMinute can reach 1440 (midnight, end of day) but never 0
-- (a window can't end at the start of the day). endMinute must always be strictly after
-- startMinute, per MCV-007.
ALTER TABLE "ChefAvailability"
  ADD CONSTRAINT "ChefAvailability_startMinute_range_check"
  CHECK ("startMinute" >= 0 AND "startMinute" <= 1439);

ALTER TABLE "ChefAvailability"
  ADD CONSTRAINT "ChefAvailability_endMinute_range_check"
  CHECK ("endMinute" >= 1 AND "endMinute" <= 1440);

ALTER TABLE "ChefAvailability"
  ADD CONSTRAINT "ChefAvailability_endMinute_after_startMinute_check"
  CHECK ("endMinute" > "startMinute");

-- ReferralCode.rewardValuePercent: "Set when rewardType is PERCENT_DISCOUNT. Whole percent, 1-100."
ALTER TABLE "ReferralCode"
  ADD CONSTRAINT "ReferralCode_rewardValuePercent_range_check"
  CHECK ("rewardValuePercent" IS NULL OR ("rewardValuePercent" >= 1 AND "rewardValuePercent" <= 100));

-- -----------------------------------------------------------------------------
-- 2. Money sanity: every "...Cents" column must be non-negative, except where a
--    negative value is a legitimate accounting signal. Each exception is
--    documented at the point it is (deliberately) NOT constrained below.
-- -----------------------------------------------------------------------------

-- ClientProfile.lifetimeValueCents — cumulative revenue attributed to a household, never negative.
ALTER TABLE "ClientProfile"
  ADD CONSTRAINT "ClientProfile_lifetimeValueCents_nonnegative_check"
  CHECK ("lifetimeValueCents" >= 0);

-- StaffProfile.hourlyRateCents — a pay rate, never negative.
ALTER TABLE "StaffProfile"
  ADD CONSTRAINT "StaffProfile_hourlyRateCents_nonnegative_check"
  CHECK ("hourlyRateCents" >= 0);

-- MenuItem.basePriceCents — a catalogue price, never negative.
ALTER TABLE "MenuItem"
  ADD CONSTRAINT "MenuItem_basePriceCents_nonnegative_check"
  CHECK ("basePriceCents" >= 0);

-- Ingredient.unitCostCents — a unit cost, never negative (nullable: cost not yet entered).
ALTER TABLE "Ingredient"
  ADD CONSTRAINT "Ingredient_unitCostCents_nonnegative_check"
  CHECK ("unitCostCents" IS NULL OR "unitCostCents" >= 0);

-- SubscriptionPlan.priceCents — a subscription price, never negative.
ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT "SubscriptionPlan_priceCents_nonnegative_check"
  CHECK ("priceCents" >= 0);

-- SubscriptionPlan.setupFeeCents — a one-time fee, never negative (nullable: no fee).
ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT "SubscriptionPlan_setupFeeCents_nonnegative_check"
  CHECK ("setupFeeCents" IS NULL OR "setupFeeCents" >= 0);

-- Invoice.* — every amount on an invoice is a non-negative magnitude; discounts are
-- represented via the dedicated non-negative discountCents field (subtracted when the
-- invoice total is computed), not via a negative amountDueCents/subtotalCents/etc.
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amountDueCents_nonnegative_check"
  CHECK ("amountDueCents" >= 0);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amountPaidCents_nonnegative_check"
  CHECK ("amountPaidCents" >= 0);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amountRemainingCents_nonnegative_check"
  CHECK ("amountRemainingCents" >= 0);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_subtotalCents_nonnegative_check"
  CHECK ("subtotalCents" >= 0);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_taxCents_nonnegative_check"
  CHECK ("taxCents" >= 0);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_discountCents_nonnegative_check"
  CHECK ("discountCents" >= 0);

-- InvoiceLineItem.unitAmountCents — a per-unit price, never negative.
ALTER TABLE "InvoiceLineItem"
  ADD CONSTRAINT "InvoiceLineItem_unitAmountCents_nonnegative_check"
  CHECK ("unitAmountCents" >= 0);

-- InvoiceLineItem.amountCents — EXCEPTION: a DISCOUNT-kind line item is stored as a
-- negative amount so that summing every line item's amountCents yields the invoice
-- subtotal directly (a discount line subtracts rather than requiring the summing code
-- to special-case `kind`). Every other line kind (SUBSCRIPTION, APPOINTMENT, MENU_ITEM,
-- INGREDIENT_COST, TRAVEL, GRATUITY, TAX, OTHER) must remain non-negative.
ALTER TABLE "InvoiceLineItem"
  ADD CONSTRAINT "InvoiceLineItem_amountCents_sign_check"
  CHECK ("amountCents" >= 0 OR "kind" = 'DISCOUNT');

-- InvoiceLineItem.taxCents — a tax amount, never negative.
ALTER TABLE "InvoiceLineItem"
  ADD CONSTRAINT "InvoiceLineItem_taxCents_nonnegative_check"
  CHECK ("taxCents" >= 0);

-- PaymentHistory.amountCents — the charged amount, never negative (refunds are tracked
-- separately via refundedCents rather than by negating amountCents).
ALTER TABLE "PaymentHistory"
  ADD CONSTRAINT "PaymentHistory_amountCents_nonnegative_check"
  CHECK ("amountCents" >= 0);

-- PaymentHistory.refundedCents — cumulative amount refunded, never negative.
ALTER TABLE "PaymentHistory"
  ADD CONSTRAINT "PaymentHistory_refundedCents_nonnegative_check"
  CHECK ("refundedCents" >= 0);

-- PaymentHistory.feeCents — a processor fee, never negative (nullable: fee not yet known).
ALTER TABLE "PaymentHistory"
  ADD CONSTRAINT "PaymentHistory_feeCents_nonnegative_check"
  CHECK ("feeCents" IS NULL OR "feeCents" >= 0);

-- ReferralCode.rewardValueCents / refereeRewardCents — reward magnitudes, never negative
-- (nullable: unset when rewardType is PERCENT_DISCOUNT, or when no distinct referee reward
-- is configured).
ALTER TABLE "ReferralCode"
  ADD CONSTRAINT "ReferralCode_rewardValueCents_nonnegative_check"
  CHECK ("rewardValueCents" IS NULL OR "rewardValueCents" >= 0);

ALTER TABLE "ReferralCode"
  ADD CONSTRAINT "ReferralCode_refereeRewardCents_nonnegative_check"
  CHECK ("refereeRewardCents" IS NULL OR "refereeRewardCents" >= 0);

-- ReferralRedemption.rewardCents — a snapshot of the reward actually paid out, never negative
-- (nullable until the redemption is rewarded).
ALTER TABLE "ReferralRedemption"
  ADD CONSTRAINT "ReferralRedemption_rewardCents_nonnegative_check"
  CHECK ("rewardCents" IS NULL OR "rewardCents" >= 0);

-- RewardBalance.balanceCents / lifetimeEarnedCents / lifetimeRedeemedCents — customer-facing
-- store credit. The floor is zero: this is spendable credit, not a line of credit a client can
-- go into debt on. Any correction that would otherwise drive a balance below zero must be
-- reconciled (e.g. via a MANUAL_ADJUSTMENT/REVERSAL ledger entry, which is intentionally NOT
-- constrained to be non-negative — see RewardLedgerEntry below) before it is reflected here.
ALTER TABLE "RewardBalance"
  ADD CONSTRAINT "RewardBalance_balanceCents_nonnegative_check"
  CHECK ("balanceCents" >= 0);

ALTER TABLE "RewardBalance"
  ADD CONSTRAINT "RewardBalance_lifetimeEarnedCents_nonnegative_check"
  CHECK ("lifetimeEarnedCents" >= 0);

ALTER TABLE "RewardBalance"
  ADD CONSTRAINT "RewardBalance_lifetimeRedeemedCents_nonnegative_check"
  CHECK ("lifetimeRedeemedCents" >= 0);

-- RewardLedgerEntry.amountCents / balanceAfterCents — EXCEPTION, intentionally unconstrained
-- in sign. This is the append-only audit trail (schema.prisma: "Rows are never updated or
-- deleted by application code; corrections are expressed as a compensating REVERSAL entry").
-- A MANUAL_ADJUSTMENT or REVERSAL entry must be able to carry a negative amountCents to correct
-- a prior over-credit, and balanceAfterCents mirrors the running balance immediately after that
-- entry is applied — it can therefore transiently go negative until a subsequent corrective
-- entry brings the account back to a non-negative state. (No CHECK constraint added for either
-- column.)

-- ClientIntakeForm.budgetPerMealCents — a client-stated budget, never negative (nullable:
-- not yet provided).
ALTER TABLE "ClientIntakeForm"
  ADD CONSTRAINT "ClientIntakeForm_budgetPerMealCents_nonnegative_check"
  CHECK ("budgetPerMealCents" IS NULL OR "budgetPerMealCents" >= 0);

-- BookingSlot.priceCents — a slot price, never negative (nullable: price not yet set).
ALTER TABLE "BookingSlot"
  ADD CONSTRAINT "BookingSlot_priceCents_nonnegative_check"
  CHECK ("priceCents" IS NULL OR "priceCents" >= 0);

-- ChefAppointment.totalCents / depositCents / gratuityCents — booking amounts, never negative.
ALTER TABLE "ChefAppointment"
  ADD CONSTRAINT "ChefAppointment_totalCents_nonnegative_check"
  CHECK ("totalCents" >= 0);

ALTER TABLE "ChefAppointment"
  ADD CONSTRAINT "ChefAppointment_depositCents_nonnegative_check"
  CHECK ("depositCents" >= 0);

ALTER TABLE "ChefAppointment"
  ADD CONSTRAINT "ChefAppointment_gratuityCents_nonnegative_check"
  CHECK ("gratuityCents" >= 0);

-- AppointmentMenuItem.priceCentsAtBooking — a price snapshot, never negative (nullable: not
-- yet snapshotted).
ALTER TABLE "AppointmentMenuItem"
  ADD CONSTRAINT "AppointmentMenuItem_priceCentsAtBooking_nonnegative_check"
  CHECK ("priceCentsAtBooking" IS NULL OR "priceCentsAtBooking" >= 0);

-- -----------------------------------------------------------------------------
-- 3. NULL-distinctness fixes: replace decorative @@unique constraints that span
--    mutually-exclusive nullable columns with partial unique indexes, since
--    Postgres treats every NULL as distinct from every other NULL and the
--    original tuple could therefore never reject a real duplicate.
-- -----------------------------------------------------------------------------

-- ChefAvailability: the Prisma-generated
--   @@unique([staffProfileId, kind, dayOfWeek, specificDate, startMinute, endMinute])
-- is decorative because dayOfWeek and specificDate are mutually exclusive (exactly one is
-- NULL on every row, enforced by the discriminator CHECK below), so the unique tuple always
-- contains a NULL and Postgres never considers two such rows duplicates. Replace it with two
-- partial unique indexes, one per discriminator branch, each keyed on the columns that are
-- actually populated for that branch.
DROP INDEX "ChefAvailability_staffProfileId_kind_dayOfWeek_specificDate_key";

CREATE UNIQUE INDEX "ChefAvailability_recurring_weekly_unique"
  ON "ChefAvailability"("staffProfileId", "dayOfWeek", "startMinute", "endMinute")
  WHERE "kind" = 'RECURRING_WEEKLY';

CREATE UNIQUE INDEX "ChefAvailability_date_override_unique"
  ON "ChefAvailability"("staffProfileId", "specificDate", "startMinute", "endMinute")
  WHERE "kind" = 'DATE_OVERRIDE';

-- MediaAsset: the Prisma-generated @@unique([provider, providerFileKey]) is decorative for
-- every row where providerFileKey is NULL (e.g. provider = EXTERNAL, which has no file key),
-- since Postgres never treats two NULLs as duplicates. Scope the uniqueness to rows that
-- actually have a provider file key.
DROP INDEX "MediaAsset_provider_providerFileKey_key";

CREATE UNIQUE INDEX "MediaAsset_provider_providerFileKey_unique"
  ON "MediaAsset"("provider", "providerFileKey")
  WHERE "providerFileKey" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. ChefAvailability discriminator invariant
-- -----------------------------------------------------------------------------

-- RECURRING_WEEKLY rows must carry a dayOfWeek and no specificDate; DATE_OVERRIDE rows must
-- carry a specificDate and no dayOfWeek. This is also what makes the two partial unique
-- indexes above mutually exclusive and exhaustive.
ALTER TABLE "ChefAvailability"
  ADD CONSTRAINT "ChefAvailability_kind_discriminator_check"
  CHECK (
    ("kind" = 'RECURRING_WEEKLY' AND "dayOfWeek" IS NOT NULL AND "specificDate" IS NULL)
    OR
    ("kind" = 'DATE_OVERRIDE' AND "specificDate" IS NOT NULL AND "dayOfWeek" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 5. Time-ordering invariants
-- -----------------------------------------------------------------------------

-- ChefAppointment: the appointment window must have positive duration, and any prep-time
-- lead-in must start at or before the appointment itself (it can coincide with startsAt for
-- a zero-length prep window, but never begin after the appointment has started).
ALTER TABLE "ChefAppointment"
  ADD CONSTRAINT "ChefAppointment_endsAt_after_startsAt_check"
  CHECK ("endsAt" > "startsAt");

ALTER TABLE "ChefAppointment"
  ADD CONSTRAINT "ChefAppointment_prepStartsAt_before_startsAt_check"
  CHECK ("prepStartsAt" IS NULL OR "prepStartsAt" <= "startsAt");

-- BookingSlot: the slot window must have positive duration, and the number of bookings taken
-- against a slot can never exceed its capacity.
ALTER TABLE "BookingSlot"
  ADD CONSTRAINT "BookingSlot_endsAt_after_startsAt_check"
  CHECK ("endsAt" > "startsAt");

ALTER TABLE "BookingSlot"
  ADD CONSTRAINT "BookingSlot_bookedCount_within_capacity_check"
  CHECK ("bookedCount" <= "capacity");
