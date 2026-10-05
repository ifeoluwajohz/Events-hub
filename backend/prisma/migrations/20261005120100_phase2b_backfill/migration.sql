-- Phase 2B, Stage B: BACKFILL (data only, deterministic, all-or-nothing).
--
-- Approved rules:
--   * Legacy "Admin" rows that own events become Organizer profiles (NOT verified,
--     NOT platform admins, no paid-ticket or publishing privileges).
--   * Nobody becomes a platform admin. The legacy "role" column is ignored.
--   * Future events -> PENDING_REVIEW, past events -> COMPLETED. Nothing is published.
--   * currency = NGN, timezone = Africa/Lagos only where no value exists.
--   * Each event gets one "General admission" TicketType (price in integer minor units).
--   * Image URLs are preserved as FileAsset(storageProvider = 'external-url') + EventMedia.
--   * Nothing is deleted. Legacy columns/tables keep their data.
--
-- The script RAISEs (rolling back everything) when data cannot be mapped safely.
-- Generated ids are md5-derived from existing ids, so re-running on the same input
-- produces the same output.

CREATE FUNCTION pg_temp.slugify(input text, fallback text) RETURNS text AS $$
  SELECT coalesce(
    nullif(trim(BOTH '-' FROM lower(regexp_replace(coalesce(input, ''), '[^a-zA-Z0-9]+', '-', 'g'))), ''),
    fallback)
$$ LANGUAGE sql IMMUTABLE;

-- ── 1. Pre-flight checks: refuse data that cannot be mapped without loss ──
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "Ticket";
  IF n > 0 THEN
    RAISE EXCEPTION 'phase2b backfill: % legacy Ticket rows exist; the legacy ticket model cannot be mapped automatically. Manual decision required.', n;
  END IF;

  SELECT count(*) INTO n FROM "Event" WHERE "adminId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % events have no owner (adminId)', n; END IF;

  SELECT count(*) INTO n FROM "Event" WHERE "eventType" = 'PAID' AND ("price" IS NULL OR "price" <= 0);
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % PAID events have no positive price', n; END IF;

  SELECT count(*) INTO n FROM "Event" WHERE "price" IS NOT NULL AND abs("price" * 100 - round("price" * 100)) > 1e-6;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % event prices have sub-minor-unit fractions', n; END IF;

  SELECT count(*) INTO n FROM "Event" WHERE "availableTickets" IS NULL OR "availableTickets" < 0;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % events have missing or negative availableTickets', n; END IF;

  SELECT count(*) INTO n FROM "Booking" WHERE "quantity" IS NULL OR "quantity" < 1;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % bookings have a missing or non-positive quantity', n; END IF;

  SELECT count(*) INTO n FROM "Booking" WHERE "totalAmount" IS NULL OR "totalAmount" < 0
    OR abs("totalAmount" * 100 - round("totalAmount" * 100)) > 1e-6;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % bookings have invalid totalAmount', n; END IF;

  SELECT count(*) INTO n FROM (SELECT lower("email") FROM "User" WHERE "email" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % emails collide case-insensitively; resolve manually', n; END IF;

  SELECT count(*) INTO n FROM (SELECT pg_temp.slugify("name", "id") FROM "Category" GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % category names collide as slugs; resolve manually', n; END IF;

  SELECT count(*) INTO n FROM (SELECT "eventId", "categoryId" FROM "EventCategory" GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % duplicate event/category links; resolve manually', n; END IF;
END $$;

-- ── 2. Users ──
UPDATE "User" SET "email" = lower("email") WHERE "email" IS NOT NULL AND "email" <> lower("email");
UPDATE "User" SET "platformRole" = 'USER' WHERE "platformRole" <> 'USER';

-- ── 3. Organizers from legacy Admin rows that own events ──
INSERT INTO "Organizer" ("id", "ownerUserId", "slug", "displayName", "type", "status", "verificationStatus", "createdAt", "updatedAt")
SELECT 'org_' || substr(md5(a."userId"), 1, 24),
       a."userId",
       pg_temp.slugify(coalesce(u."prefferedName", u."name"), 'organizer') || '-' || substr(md5(a."userId"), 1, 6),
       coalesce(nullif(trim(u."prefferedName"), ''), nullif(trim(u."name"), ''), 'Organizer'),
       'INDIVIDUAL', 'ACTIVE', 'NOT_STARTED', a."createdAt", now()
FROM "Admin" a
JOIN "User" u ON u."id" = a."userId"
WHERE EXISTS (SELECT 1 FROM "Event" e WHERE e."adminId" = a."userId");

-- ── 4. Events ──
UPDATE "Event" e SET
  "organizerId" = 'org_' || substr(md5(e."adminId"), 1, 24),
  "slug"        = pg_temp.slugify(e."title", 'event') || '-' || substr(md5(e."id"), 1, 8),
  "timezone"    = coalesce(e."timezone", 'Africa/Lagos'),
  "currency"    = coalesce(e."currency", 'NGN'),
  "status"      = CASE WHEN e."date" < now() THEN 'COMPLETED' ELSE 'PENDING_REVIEW' END::"EventLifecycleStatus",
  "submittedAt" = CASE WHEN e."date" < now() THEN NULL ELSE now() END;

INSERT INTO "EventModerationAction" ("id", "eventId", "actorId", "actorRole", "action", "fromStatus", "toStatus", "reason", "metadata", "createdAt")
SELECT 'ema_' || substr(md5('migrated:' || e."id"), 1, 24), e."id", NULL, 'SYSTEM', 'MIGRATED', NULL, e."status",
       CASE WHEN e."status" = 'COMPLETED'
            THEN 'Migrated from pre-Phase-2 data as a past event.'
            ELSE 'Migrated from pre-Phase-2 data. Requires moderation before publication.' END,
       jsonb_build_object('legacyAdminId', e."adminId", 'legacyEventType', e."eventType",
                          'legacyPrice', e."price", 'legacyAvailableTickets', e."availableTickets",
                          'legacyPictureId', e."pictureId"),
       now()
FROM "Event" e;

-- ── 5. Ticket types: one "General admission" per event ──
INSERT INTO "TicketType" ("id", "eventId", "name", "priceMinor", "quantityTotal", "quantitySold", "status", "createdAt", "updatedAt")
SELECT 'tt_' || substr(md5(e."id"), 1, 24), e."id", 'General admission',
       CASE WHEN e."eventType" = 'PAID' THEN round(e."price" * 100)::integer ELSE 0 END,
       e."availableTickets" + coalesce(s.sold, 0),
       coalesce(s.sold, 0),
       'ACTIVE', now(), now()
FROM "Event" e
LEFT JOIN (SELECT "eventId", sum("quantity")::integer AS sold FROM "Booking" WHERE "status" <> 'CANCELLED' GROUP BY 1) s
  ON s."eventId" = e."id";

-- ── 6. Bookings ──
UPDATE "Booking" b SET "currency" = e."currency", "totalMinor" = round(b."totalAmount" * 100)::integer
FROM "Event" e WHERE e."id" = b."eventId";

INSERT INTO "BookingItem" ("id", "bookingId", "ticketTypeId", "quantity", "unitPriceMinor")
SELECT 'bi_' || substr(md5(b."id"), 1, 24), b."id", 'tt_' || substr(md5(b."eventId"), 1, 24), b."quantity", tt."priceMinor"
FROM "Booking" b JOIN "TicketType" tt ON tt."id" = 'tt_' || substr(md5(b."eventId"), 1, 24);

-- ── 7. Media: every legacy image URL becomes a public FileAsset ──
INSERT INTO "FileAsset" ("id", "purpose", "visibility", "status", "storageProvider", "storageKey", "createdAt", "updatedAt")
SELECT DISTINCT 'fa_' || substr(md5(url), 1, 24), 'EVENT_IMAGE'::"AssetPurpose", 'PUBLIC'::"AssetVisibility",
       'READY'::"AssetStatus", 'external-url', url, now(), now()
FROM (
  SELECT "displayPicture" AS url FROM "Picture"
  UNION
  SELECT unnest("previewPictures") FROM "Picture"
) urls
WHERE url IS NOT NULL AND trim(url) <> '';

INSERT INTO "EventMedia" ("eventId", "assetId", "role", "position")
SELECT e."id", 'fa_' || substr(md5(p."displayPicture"), 1, 24), 'COVER', 0
FROM "Event" e JOIN "Picture" p ON p."id" = e."pictureId"
WHERE trim(p."displayPicture") <> '';

INSERT INTO "EventMedia" ("eventId", "assetId", "role", "position")
SELECT e."id", 'fa_' || substr(md5(g.url), 1, 24), 'GALLERY', g.pos::integer
FROM "Event" e JOIN "Picture" p ON p."id" = e."pictureId"
CROSS JOIN LATERAL unnest(p."previewPictures") WITH ORDINALITY AS g(url, pos)
WHERE trim(g.url) <> ''
ON CONFLICT ("eventId", "assetId") DO NOTHING; -- same URL already attached to this event

-- ── 8. Categories ──
UPDATE "Category" SET "slug" = pg_temp.slugify("name", "id") WHERE "slug" IS NULL;

-- ── 9. Audit trail for the migration itself ──
INSERT INTO "AuditLog" ("id", "actorId", "actorRole", "action", "targetType", "targetId", "metadata", "createdAt")
SELECT 'aud_' || substr(md5('org-from-admin:' || o."id"), 1, 24), NULL, 'SYSTEM',
       'migration.organizer.created_from_legacy_admin', 'organizer', o."id",
       jsonb_build_object('ownerUserId', o."ownerUserId", 'note', 'Historical ownership only; not verified.'), now()
FROM "Organizer" o;

INSERT INTO "AuditLog" ("id", "actorId", "actorRole", "action", "targetType", "targetId", "metadata", "createdAt")
SELECT 'aud_phase2b_backfill', NULL, 'SYSTEM', 'migration.phase2b.backfill', 'system', 'phase2b',
       jsonb_build_object(
         'users', (SELECT count(*) FROM "User"),
         'organizers', (SELECT count(*) FROM "Organizer"),
         'events', (SELECT count(*) FROM "Event"),
         'eventsPendingReview', (SELECT count(*) FROM "Event" WHERE "status" = 'PENDING_REVIEW'),
         'eventsCompleted', (SELECT count(*) FROM "Event" WHERE "status" = 'COMPLETED'),
         'ticketTypes', (SELECT count(*) FROM "TicketType"),
         'bookings', (SELECT count(*) FROM "Booking"),
         'fileAssets', (SELECT count(*) FROM "FileAsset"),
         'eventMedia', (SELECT count(*) FROM "EventMedia")),
       now();

-- ── 10. Post-conditions: abort if any invariant fails ──
DO $$
DECLARE n integer; m integer;
BEGIN
  SELECT count(*) INTO n FROM "Event"
   WHERE "organizerId" IS NULL OR "slug" IS NULL OR "timezone" IS NULL OR "currency" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % events missing organizer/slug/timezone/currency', n; END IF;

  -- ownership preserved: organizer owner == legacy admin
  SELECT count(*) INTO n FROM "Event" e JOIN "Organizer" o ON o."id" = e."organizerId"
   WHERE o."ownerUserId" IS DISTINCT FROM e."adminId";
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % events lost their owner', n; END IF;

  SELECT count(DISTINCT "adminId") INTO n FROM "Event";
  SELECT count(*) INTO m FROM "Organizer";
  IF n <> m THEN RAISE EXCEPTION 'post-check: % event owners but % organizers', n, m; END IF;

  SELECT count(*) INTO n FROM "Event" e WHERE (SELECT count(*) FROM "TicketType" t WHERE t."eventId" = e."id") <> 1;
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % events without exactly one ticket type', n; END IF;

  SELECT count(*) INTO n FROM "Event" WHERE "status" NOT IN ('PENDING_REVIEW', 'COMPLETED');
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % migrated events are neither PENDING_REVIEW nor COMPLETED', n; END IF;

  SELECT coalesce(sum("availableTickets"), 0) + coalesce((SELECT sum("quantity") FROM "Booking" WHERE "status" <> 'CANCELLED'), 0)
    INTO n FROM "Event";
  SELECT coalesce(sum("quantityTotal"), 0) INTO m FROM "TicketType";
  IF n <> m THEN RAISE EXCEPTION 'post-check: inventory mismatch (legacy % vs ticket types %)', n, m; END IF;

  SELECT count(*) INTO n FROM "Booking" WHERE "currency" IS NULL OR "totalMinor" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % bookings missing currency/total', n; END IF;

  SELECT count(*) INTO n FROM "Booking" b
   WHERE b."quantity" IS DISTINCT FROM (SELECT sum(i."quantity") FROM "BookingItem" i WHERE i."bookingId" = b."id");
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % bookings with mismatched item quantities', n; END IF;

  SELECT count(*) INTO n FROM "Event" e JOIN "Picture" p ON p."id" = e."pictureId"
   WHERE trim(p."displayPicture") <> '' AND NOT EXISTS (
     SELECT 1 FROM "EventMedia" em JOIN "FileAsset" fa ON fa."id" = em."assetId"
      WHERE em."eventId" = e."id" AND em."role" = 'COVER' AND fa."storageKey" = p."displayPicture");
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % events lost their cover image', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT "displayPicture" AS url FROM "Picture" UNION SELECT unnest("previewPictures") FROM "Picture") u
   WHERE trim(url) <> '' AND NOT EXISTS (SELECT 1 FROM "FileAsset" fa WHERE fa."storageKey" = u.url);
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % image URLs not preserved', n; END IF;

  SELECT count(*) INTO n FROM "User" WHERE "platformRole" <> 'USER';
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % platform admins after migration (must be 0)', n; END IF;

  SELECT count(*) INTO n FROM "Organizer" WHERE "verificationStatus" <> 'NOT_STARTED';
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % migrated organizers are marked verified/pending', n; END IF;

  SELECT count(*) INTO n FROM "Category" WHERE "slug" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'post-check: % categories without slug', n; END IF;
END $$;
