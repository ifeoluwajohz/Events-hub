-- Phase 2B, Stage C: TIGHTEN (constraints only; no data is changed or removed).

-- Columns filled by the backfill become required.
ALTER TABLE "Event" ALTER COLUMN "organizerId" SET NOT NULL,
                    ALTER COLUMN "slug" SET NOT NULL,
                    ALTER COLUMN "timezone" SET NOT NULL,
                    ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "Booking" ALTER COLUMN "currency" SET NOT NULL,
                      ALTER COLUMN "totalMinor" SET NOT NULL;
ALTER TABLE "Category" ALTER COLUMN "slug" SET NOT NULL;

-- New tickets are VALID by default (enum value committed by the expand migration).
ALTER TABLE "Ticket" ALTER COLUMN "status" SET DEFAULT 'VALID';

-- One link per event/category (duplicates were rejected by the backfill pre-flight).
CREATE UNIQUE INDEX "EventCategory_eventId_categoryId_key" ON "EventCategory"("eventId", "categoryId");

-- ── CHECK constraints (not expressible in Prisma; Prisma's diff ignores them) ──
ALTER TABLE "TicketType"
  ADD CONSTRAINT "TicketType_priceMinor_nonnegative" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "TicketType_quantity_valid" CHECK ("quantityTotal" >= 0 AND "quantitySold" >= 0 AND "quantitySold" <= "quantityTotal"),
  ADD CONSTRAINT "TicketType_order_limits_valid" CHECK ("minPerOrder" >= 1 AND "maxPerOrder" >= "minPerOrder"),
  ADD CONSTRAINT "TicketType_sales_window_valid" CHECK ("salesStartAt" IS NULL OR "salesEndAt" IS NULL OR "salesEndAt" > "salesStartAt");

ALTER TABLE "BookingItem"
  ADD CONSTRAINT "BookingItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "BookingItem_unitPrice_nonnegative" CHECK ("unitPriceMinor" >= 0);

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_totalMinor_nonnegative" CHECK ("totalMinor" >= 0),
  ADD CONSTRAINT "Booking_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "Event_country_format" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "Event_ends_after_start" CHECK ("endsAt" IS NULL OR "endsAt" > "date");

ALTER TABLE "Organizer"
  ADD CONSTRAINT "Organizer_country_format" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

ALTER TABLE "VerificationSubmission"
  ADD CONSTRAINT "VerificationSubmission_country_format" CHECK ("country" ~ '^[A-Z]{2}$');

ALTER TABLE "VerificationEvidence"
  ADD CONSTRAINT "VerificationEvidence_has_content" CHECK ("assetId" IS NOT NULL OR "value" IS NOT NULL);

ALTER TABLE "Report"
  ADD CONSTRAINT "Report_exactly_one_target" CHECK (num_nonnulls("eventId", "organizerId", "targetUserId") = 1);

-- ── Append-only history ──
CREATE FUNCTION "forbid_history_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "forbid_history_mutation"();
CREATE TRIGGER "VerificationDecision_append_only" BEFORE UPDATE OR DELETE ON "VerificationDecision"
  FOR EACH ROW EXECUTE FUNCTION "forbid_history_mutation"();
CREATE TRIGGER "EventModerationAction_append_only" BEFORE UPDATE OR DELETE ON "EventModerationAction"
  FOR EACH ROW EXECUTE FUNCTION "forbid_history_mutation"();
CREATE TRIGGER "OrganizerStatusChange_append_only" BEFORE UPDATE OR DELETE ON "OrganizerStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "forbid_history_mutation"();
CREATE TRIGGER "VerificationEvidence_immutable" BEFORE UPDATE OR DELETE ON "VerificationEvidence"
  FOR EACH ROW EXECUTE FUNCTION "forbid_history_mutation"();

-- Submissions: only status (and updatedAt) may change after creation.
CREATE FUNCTION "verification_submission_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VerificationSubmission rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."organizerId" IS DISTINCT FROM OLD."organizerId"
     OR NEW."submittedById" IS DISTINCT FROM OLD."submittedById"
     OR NEW."country" IS DISTINCT FROM OLD."country"
     OR NEW."organizerType" IS DISTINCT FROM OLD."organizerType"
     OR NEW."requirementSetVersion" IS DISTINCT FROM OLD."requirementSetVersion"
     OR NEW."declaredData" IS DISTINCT FROM OLD."declaredData"
     OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId"
     OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'VerificationSubmission content is immutable; only status may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VerificationSubmission_guard" BEFORE UPDATE OR DELETE ON "VerificationSubmission"
  FOR EACH ROW EXECUTE FUNCTION "verification_submission_guard"();
