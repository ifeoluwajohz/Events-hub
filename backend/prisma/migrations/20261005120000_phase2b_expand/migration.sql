-- Phase 2B, Stage A: EXPAND (additive only).
-- * New enums, tables, columns and indexes.
-- * New columns that will become required are created NULLABLE; the backfill
--   fills them and the tighten migration sets NOT NULL.
-- * Legacy columns only lose NOT NULL so new rows can omit them. Nothing is dropped
--   or renamed (renames are Prisma-level @map only).
-- * The one dropped index is "User_prefferedName_key": display names are no longer
--   globally unique. Data is untouched.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "OrganizerType" AS ENUM ('INDIVIDUAL', 'BUSINESS', 'NON_PROFIT');

-- CreateEnum
CREATE TYPE "OrganizerStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrganizerVerificationStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'CHANGES_REQUESTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationSubmissionStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('GOVERNMENT_ID', 'BUSINESS_REGISTRATION', 'PROOF_OF_ADDRESS', 'TAX_ID', 'WEB_PRESENCE', 'SOCIAL_PROFILE', 'OTHER');

-- CreateEnum
CREATE TYPE "VerificationAction" AS ENUM ('START_REVIEW', 'APPROVE', 'REQUEST_CHANGES', 'REJECT', 'REVOKE');

-- CreateEnum
CREATE TYPE "AssetPurpose" AS ENUM ('EVENT_IMAGE', 'ORGANIZER_LOGO', 'VERIFICATION_EVIDENCE');

-- CreateEnum
CREATE TYPE "AssetVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'DELETED');

-- CreateEnum
CREATE TYPE "EventLifecycleStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'CANCELLED', 'SUSPENDED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AttendanceMode" AS ENUM ('IN_PERSON', 'ONLINE', 'HYBRID');

-- CreateEnum
CREATE TYPE "EventMediaRole" AS ENUM ('COVER', 'GALLERY');

-- CreateEnum
CREATE TYPE "ModerationAction" AS ENUM ('SUBMIT', 'WITHDRAW', 'APPROVE', 'REQUEST_CHANGES', 'REJECT', 'SUSPEND', 'REINSTATE', 'CANCEL', 'COMPLETE', 'EDIT', 'MIGRATED');

-- CreateEnum
CREATE TYPE "ActorRole" AS ENUM ('ORGANIZER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TicketTypeStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SCAM_OR_FRAUD', 'MISLEADING', 'INAPPROPRIATE', 'SPAM', 'SAFETY_CONCERN', 'INTELLECTUAL_PROPERTY', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ACTION_TAKEN', 'DISMISSED');

-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'EXPIRED';

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'VALID';

-- DropIndex
DROP INDEX "User_prefferedName_key";

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "totalMinor" INTEGER,
ALTER COLUMN "quantity" DROP NOT NULL,
ALTER COLUMN "totalAmount" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "addressLine" TEXT,
ADD COLUMN     "attendanceMode" "AttendanceMode" NOT NULL DEFAULT 'IN_PERSON',
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "onlineUrl" TEXT,
ADD COLUMN     "organizerId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "region" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "status" "EventLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT,
ALTER COLUMN "venue" DROP NOT NULL,
ALTER COLUMN "eventType" DROP NOT NULL,
ALTER COLUMN "availableTickets" DROP NOT NULL,
ALTER COLUMN "adminId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "checkedInById" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "ticketTypeId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "clerkUserId" TEXT,
ADD COLUMN     "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER',
ADD COLUMN     "profileSyncedAt" TIMESTAMP(3),
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ALTER COLUMN "firebaseUid" DROP NOT NULL,
ALTER COLUMN "profilePicture" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Organizer" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "type" "OrganizerType" NOT NULL DEFAULT 'INDIVIDUAL',
    "bio" TEXT,
    "websiteUrl" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "country" TEXT,
    "city" TEXT,
    "logoAssetId" TEXT,
    "status" "OrganizerStatus" NOT NULL DEFAULT 'ACTIVE',
    "verificationStatus" "OrganizerVerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organizer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerStatusChange" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "fromStatus" "OrganizerStatus" NOT NULL,
    "toStatus" "OrganizerStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationSubmission" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "status" "VerificationSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "country" TEXT NOT NULL,
    "organizerType" "OrganizerType" NOT NULL,
    "requirementSetVersion" TEXT NOT NULL,
    "declaredData" JSONB NOT NULL,
    "supersedesId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationEvidence" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "requirementKey" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "assetId" TEXT,
    "value" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationDecision" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "action" "VerificationAction" NOT NULL,
    "reason" TEXT,
    "internalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "purpose" "AssetPurpose" NOT NULL,
    "visibility" "AssetVisibility" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "checksumSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMedia" (
    "eventId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" "EventMediaRole" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EventMedia_pkey" PRIMARY KEY ("eventId","assetId")
);

-- CreateTable
CREATE TABLE "EventModerationAction" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "ActorRole" NOT NULL,
    "action" "ModerationAction" NOT NULL,
    "fromStatus" "EventLifecycleStatus",
    "toStatus" "EventLifecycleStatus" NOT NULL,
    "reason" TEXT,
    "internalNote" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketType" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "quantityTotal" INTEGER NOT NULL,
    "quantitySold" INTEGER NOT NULL DEFAULT 0,
    "minPerOrder" INTEGER NOT NULL DEFAULT 1,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
    "salesStartAt" TIMESTAMP(3),
    "salesEndAt" TIMESTAMP(3),
    "status" "TicketTypeStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingItem" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,

    CONSTRAINT "BookingItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedEvent" (
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedEvent_pkey" PRIMARY KEY ("userId","eventId")
);

-- CreateTable
CREATE TABLE "OrganizerFollow" (
    "userId" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerFollow_pkey" PRIMARY KEY ("userId","organizerId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "eventId" TEXT,
    "organizerId" TEXT,
    "targetUserId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "ActorRole" NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB,
    "requestId" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organizer_ownerUserId_key" ON "Organizer"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Organizer_slug_key" ON "Organizer"("slug");

-- CreateIndex
CREATE INDEX "Organizer_verificationStatus_idx" ON "Organizer"("verificationStatus");

-- CreateIndex
CREATE INDEX "Organizer_status_idx" ON "Organizer"("status");

-- CreateIndex
CREATE INDEX "OrganizerStatusChange_organizerId_createdAt_idx" ON "OrganizerStatusChange"("organizerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationSubmission_supersedesId_key" ON "VerificationSubmission"("supersedesId");

-- CreateIndex
CREATE INDEX "VerificationSubmission_organizerId_submittedAt_idx" ON "VerificationSubmission"("organizerId", "submittedAt");

-- CreateIndex
CREATE INDEX "VerificationSubmission_status_submittedAt_idx" ON "VerificationSubmission"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "VerificationEvidence_submissionId_idx" ON "VerificationEvidence"("submissionId");

-- CreateIndex
CREATE INDEX "VerificationDecision_submissionId_createdAt_idx" ON "VerificationDecision"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationDecision_reviewerId_createdAt_idx" ON "VerificationDecision"("reviewerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_storageProvider_storageKey_purpose_key" ON "FileAsset"("storageProvider", "storageKey", "purpose");

-- CreateIndex
CREATE INDEX "EventModerationAction_eventId_createdAt_idx" ON "EventModerationAction"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "EventModerationAction_actorId_createdAt_idx" ON "EventModerationAction"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketType_eventId_idx" ON "TicketType"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketType_eventId_name_key" ON "TicketType"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BookingItem_bookingId_ticketTypeId_key" ON "BookingItem"("bookingId", "ticketTypeId");

-- CreateIndex
CREATE INDEX "SavedEvent_eventId_idx" ON "SavedEvent"("eventId");

-- CreateIndex
CREATE INDEX "OrganizerFollow_organizerId_idx" ON "OrganizerFollow"("organizerId");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_eventId_idx" ON "Report"("eventId");

-- CreateIndex
CREATE INDEX "Report_organizerId_idx" ON "Report"("organizerId");

-- CreateIndex
CREATE INDEX "Report_reporterId_createdAt_idx" ON "Report"("reporterId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_createdAt_idx" ON "AuditLog"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_userId_bookingDate_idx" ON "Booking"("userId", "bookingDate");

-- CreateIndex
CREATE INDEX "Booking_eventId_status_idx" ON "Booking"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_userId_idempotencyKey_key" ON "Booking"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE INDEX "Event_status_date_idx" ON "Event"("status", "date");

-- CreateIndex
CREATE INDEX "Event_organizerId_status_idx" ON "Event"("organizerId", "status");

-- CreateIndex
CREATE INDEX "Event_status_submittedAt_idx" ON "Event"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "Event_country_city_date_idx" ON "Event"("country", "city", "date");

-- CreateIndex
CREATE INDEX "EventCategory_categoryId_idx" ON "EventCategory"("categoryId");


-- CreateIndex
CREATE UNIQUE INDEX "Ticket_code_key" ON "Ticket"("code");

-- CreateIndex
CREATE INDEX "Ticket_eventId_status_idx" ON "Ticket"("eventId", "status");

-- CreateIndex
CREATE INDEX "Ticket_bookingId_idx" ON "Ticket"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- AddForeignKey
ALTER TABLE "Organizer" ADD CONSTRAINT "Organizer_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organizer" ADD CONSTRAINT "Organizer_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerStatusChange" ADD CONSTRAINT "OrganizerStatusChange_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Organizer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerStatusChange" ADD CONSTRAINT "OrganizerStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubmission" ADD CONSTRAINT "VerificationSubmission_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Organizer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubmission" ADD CONSTRAINT "VerificationSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubmission" ADD CONSTRAINT "VerificationSubmission_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "VerificationSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvidence" ADD CONSTRAINT "VerificationEvidence_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "VerificationSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvidence" ADD CONSTRAINT "VerificationEvidence_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationDecision" ADD CONSTRAINT "VerificationDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "VerificationSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationDecision" ADD CONSTRAINT "VerificationDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Organizer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMedia" ADD CONSTRAINT "EventMedia_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMedia" ADD CONSTRAINT "EventMedia_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventModerationAction" ADD CONSTRAINT "EventModerationAction_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventModerationAction" ADD CONSTRAINT "EventModerationAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingItem" ADD CONSTRAINT "BookingItem_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingItem" ADD CONSTRAINT "BookingItem_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedEvent" ADD CONSTRAINT "SavedEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedEvent" ADD CONSTRAINT "SavedEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerFollow" ADD CONSTRAINT "OrganizerFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerFollow" ADD CONSTRAINT "OrganizerFollow_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Organizer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Organizer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

