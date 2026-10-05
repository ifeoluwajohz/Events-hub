-- Phase 2B, Stage B: BACKFILL (data only, deterministic, all-or-nothing, FAIL CLOSED).
--
-- Approved rules:
--   * Legacy "Admin" rows that own events become Organizer profiles (NOT verified,
--     NOT platform admins, no paid-ticket or publishing privileges).
--   * Nobody becomes a platform admin. The legacy "role" column is ignored.
--   * Future events -> PENDING_REVIEW, past events -> COMPLETED. Nothing is published.
--   * currency = NGN, timezone = Africa/Lagos only where no value exists (reported).
--   * Each event gets one "General admission" TicketType (price in integer minor units).
--   * Image URLs are preserved as FileAsset(storageProvider = 'external-url') + EventMedia.
--   * Nothing is deleted. Legacy columns/tables keep their data.
--
-- Fail closed: any record that cannot be mapped without inventing or guessing data
-- RAISEs in the pre-flight, rolling back everything. Post-conditions are evaluated
-- together; if ANY fails, all failures are listed and everything rolls back.
--
-- Reporting: every write is counted. The final AuditLog row
-- (action 'migration.phase2b.backfill') records exactly what was transformed, every
-- invariant and its result, the approved defaults applied, and anomalies kept as
-- history. That row can only exist if every invariant passed.
-- `npm run migrate:report` prints it and independently re-verifies the invariants.

CREATE FUNCTION pg_temp.slugify(input text, fallback text) RETURNS text AS $$
  SELECT coalesce(
    nullif(trim(BOTH '-' FROM lower(regexp_replace(coalesce(input, ''), '[^a-zA-Z0-9]+', '-', 'g'))), ''),
    fallback)
$$ LANGUAGE sql IMMUTABLE;

CREATE TEMP TABLE phase2b_counts (step text PRIMARY KEY, n bigint NOT NULL);
CREATE TEMP TABLE phase2b_invariants (name text PRIMARY KEY, violations bigint NOT NULL);

-- ── 1. Pre-flight: refuse data that cannot be mapped without guessing ──
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

  SELECT count(*) INTO n FROM "Event" WHERE "eventType" = 'FREE' AND "price" IS NOT NULL AND "price" > 0;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % FREE events carry a positive price (contradictory); resolve manually', n; END IF;

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

  -- An organizer needs a real public name; never invent one.
  SELECT count(*) INTO n FROM "User" u
   WHERE EXISTS (SELECT 1 FROM "Event" e WHERE e."adminId" = u."id")
     AND nullif(trim(u."prefferedName"), '') IS NULL AND nullif(trim(u."name"), '') IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % event owners have no name to use as organizer name; resolve manually', n; END IF;

  SELECT count(*) INTO n FROM (SELECT pg_temp.slugify("name", "id") FROM "Category" GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % category names collide as slugs; resolve manually', n; END IF;

  SELECT count(*) INTO n FROM (SELECT "eventId", "categoryId" FROM "EventCategory" GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'phase2b backfill: % duplicate event/category links; resolve manually', n; END IF;
END $$;

-- Approved defaults applied (recorded before the update so the report is exact).
INSERT INTO phase2b_counts SELECT 'defaults.events_currency_ngn', count(*) FROM "Event" WHERE "currency" IS NULL;
INSERT INTO phase2b_counts SELECT 'defaults.events_timezone_africa_lagos', count(*) FROM "Event" WHERE "timezone" IS NULL;

-- ── 2. Users ──
WITH x AS (UPDATE "User" SET "email" = lower("email") WHERE "email" IS NOT NULL AND "email" <> lower("email") RETURNING 1)
INSERT INTO phase2b_counts SELECT 'users.emails_lowercased', count(*) FROM x;
WITH x AS (UPDATE "User" SET "platformRole" = 'USER' WHERE "platformRole" <> 'USER' RETURNING 1)
INSERT INTO phase2b_counts SELECT 'users.platform_role_reset', count(*) FROM x;
INSERT INTO phase2b_counts SELECT 'users.legacy_role_admin_kept_inert', count(*) FROM "User" WHERE "role" = 'ADMIN';

-- ── 3. Organizers from legacy Admin rows that own events ──
WITH x AS (
  INSERT INTO "Organizer" ("id", "ownerUserId", "slug", "displayName", "type", "status", "verificationStatus", "createdAt", "updatedAt")
  SELECT 'org_' || substr(md5(a."userId"), 1, 24),
         a."userId",
         pg_temp.slugify(coalesce(nullif(trim(u."prefferedName"), ''), u."name"), 'organizer') || '-' || substr(md5(a."userId"), 1, 6),
         coalesce(nullif(trim(u."prefferedName"), ''), trim(u."name")),
         'INDIVIDUAL', 'ACTIVE', 'NOT_STARTED', a."createdAt", now()
  FROM "Admin" a
  JOIN "User" u ON u."id" = a."userId"
  WHERE EXISTS (SELECT 1 FROM "Event" e WHERE e."adminId" = a."userId")
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'organizers.created_from_legacy_admin', count(*) FROM x;
INSERT INTO phase2b_counts SELECT 'admins.legacy_rows_without_events_untouched', count(*) FROM "Admin" a
  WHERE NOT EXISTS (SELECT 1 FROM "Event" e WHERE e."adminId" = a."userId");

-- ── 4. Events ──
WITH x AS (
  UPDATE "Event" e SET
    "organizerId" = 'org_' || substr(md5(e."adminId"), 1, 24),
    "slug"        = pg_temp.slugify(e."title", 'event') || '-' || substr(md5(e."id"), 1, 8),
    "timezone"    = coalesce(e."timezone", 'Africa/Lagos'),
    "currency"    = coalesce(e."currency", 'NGN'),
    "status"      = CASE WHEN e."date" < now() THEN 'COMPLETED' ELSE 'PENDING_REVIEW' END::"EventLifecycleStatus",
    "submittedAt" = CASE WHEN e."date" < now() THEN NULL ELSE now() END
  RETURNING e."status")
INSERT INTO phase2b_counts
  SELECT 'events.migrated', count(*) FROM x
  UNION ALL SELECT 'events.to_pending_review', count(*) FROM x WHERE "status" = 'PENDING_REVIEW'
  UNION ALL SELECT 'events.to_completed', count(*) FROM x WHERE "status" = 'COMPLETED';

WITH x AS (
  INSERT INTO "EventModerationAction" ("id", "eventId", "actorId", "actorRole", "action", "fromStatus", "toStatus", "reason", "metadata", "createdAt")
  SELECT 'ema_' || substr(md5('migrated:' || e."id"), 1, 24), e."id", NULL, 'SYSTEM', 'MIGRATED', NULL, e."status",
         CASE WHEN e."status" = 'COMPLETED'
              THEN 'Migrated from pre-Phase-2 data as a past event.'
              ELSE 'Migrated from pre-Phase-2 data. Requires moderation before publication.' END,
         jsonb_build_object('legacyAdminId', e."adminId", 'legacyEventType', e."eventType",
                            'legacyPrice', e."price", 'legacyAvailableTickets', e."availableTickets",
                            'legacyPictureId', e."pictureId"),
         now()
  FROM "Event" e
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'moderation.migrated_records_created', count(*) FROM x;

-- ── 5. Ticket types: one "General admission" per event ──
WITH x AS (
  INSERT INTO "TicketType" ("id", "eventId", "name", "priceMinor", "quantityTotal", "quantitySold", "status", "createdAt", "updatedAt")
  SELECT 'tt_' || substr(md5(e."id"), 1, 24), e."id", 'General admission',
         CASE e."eventType" WHEN 'PAID' THEN round(e."price" * 100)::integer WHEN 'FREE' THEN 0 END,
         e."availableTickets" + coalesce(s.sold, 0),
         coalesce(s.sold, 0),
         'ACTIVE', now(), now()
  FROM "Event" e
  LEFT JOIN (SELECT "eventId", sum("quantity")::integer AS sold FROM "Booking" WHERE "status" <> 'CANCELLED' GROUP BY 1) s
    ON s."eventId" = e."id"
  RETURNING "priceMinor")
INSERT INTO phase2b_counts
  SELECT 'ticket_types.created', count(*) FROM x
  UNION ALL SELECT 'ticket_types.free', count(*) FROM x WHERE "priceMinor" = 0
  UNION ALL SELECT 'ticket_types.paid', count(*) FROM x WHERE "priceMinor" > 0;

-- ── 6. Bookings ──
WITH x AS (
  UPDATE "Booking" b SET "currency" = e."currency", "totalMinor" = round(b."totalAmount" * 100)::integer
  FROM "Event" e WHERE e."id" = b."eventId"
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'bookings.converted_to_minor_units', count(*) FROM x;

WITH x AS (
  INSERT INTO "BookingItem" ("id", "bookingId", "ticketTypeId", "quantity", "unitPriceMinor")
  SELECT 'bi_' || substr(md5(b."id"), 1, 24), b."id", 'tt_' || substr(md5(b."eventId"), 1, 24), b."quantity", tt."priceMinor"
  FROM "Booking" b JOIN "TicketType" tt ON tt."id" = 'tt_' || substr(md5(b."eventId"), 1, 24)
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'booking_items.created', count(*) FROM x;

-- ── 7. Media: every legacy image URL becomes a public FileAsset ──
WITH x AS (
  INSERT INTO "FileAsset" ("id", "purpose", "visibility", "status", "storageProvider", "storageKey", "createdAt", "updatedAt")
  SELECT DISTINCT 'fa_' || substr(md5(url), 1, 24), 'EVENT_IMAGE'::"AssetPurpose", 'PUBLIC'::"AssetVisibility",
         'READY'::"AssetStatus", 'external-url', url, now(), now()
  FROM (
    SELECT "displayPicture" AS url FROM "Picture"
    UNION
    SELECT unnest("previewPictures") FROM "Picture"
  ) urls
  WHERE url IS NOT NULL AND trim(url) <> ''
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'file_assets.created_from_legacy_urls', count(*) FROM x;
INSERT INTO phase2b_counts SELECT 'media.empty_legacy_urls_skipped', count(*) FROM (
  SELECT "displayPicture" AS url FROM "Picture" UNION ALL SELECT unnest("previewPictures") FROM "Picture") u
  WHERE url IS NULL OR trim(url) = '';

WITH x AS (
  INSERT INTO "EventMedia" ("eventId", "assetId", "role", "position")
  SELECT e."id", 'fa_' || substr(md5(p."displayPicture"), 1, 24), 'COVER', 0
  FROM "Event" e JOIN "Picture" p ON p."id" = e."pictureId"
  WHERE trim(p."displayPicture") <> ''
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'event_media.covers_linked', count(*) FROM x;

WITH x AS (
  INSERT INTO "EventMedia" ("eventId", "assetId", "role", "position")
  SELECT e."id", 'fa_' || substr(md5(g.url), 1, 24), 'GALLERY', g.pos::integer
  FROM "Event" e JOIN "Picture" p ON p."id" = e."pictureId"
  CROSS JOIN LATERAL unnest(p."previewPictures") WITH ORDINALITY AS g(url, pos)
  WHERE trim(g.url) <> ''
  ON CONFLICT ("eventId", "assetId") DO NOTHING -- same URL already attached to this event (URL still preserved)
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'event_media.gallery_linked', count(*) FROM x;

-- ── 8. Categories ──
WITH x AS (UPDATE "Category" SET "slug" = pg_temp.slugify("name", "id") WHERE "slug" IS NULL RETURNING 1)
INSERT INTO phase2b_counts SELECT 'categories.slugged', count(*) FROM x;

-- ── 9. Per-organizer audit trail ──
WITH x AS (
  INSERT INTO "AuditLog" ("id", "actorId", "actorRole", "action", "targetType", "targetId", "metadata", "createdAt")
  SELECT 'aud_' || substr(md5('org-from-admin:' || o."id"), 1, 24), NULL, 'SYSTEM',
         'migration.organizer.created_from_legacy_admin', 'organizer', o."id",
         jsonb_build_object('ownerUserId', o."ownerUserId", 'note', 'Historical ownership only; not verified.'), now()
  FROM "Organizer" o
  RETURNING 1)
INSERT INTO phase2b_counts SELECT 'audit.organizer_entries', count(*) FROM x;

-- ── 10. Post-conditions: evaluate ALL, then abort listing every failure ──
INSERT INTO phase2b_invariants
SELECT 'events_have_organizer_slug_timezone_currency', count(*) FROM "Event"
 WHERE "organizerId" IS NULL OR "slug" IS NULL OR "timezone" IS NULL OR "currency" IS NULL
UNION ALL
SELECT 'event_ownership_preserved', count(*) FROM "Event" e LEFT JOIN "Organizer" o ON o."id" = e."organizerId"
 WHERE o."ownerUserId" IS DISTINCT FROM e."adminId"
UNION ALL
SELECT 'one_organizer_per_legacy_owner',
       abs((SELECT count(DISTINCT "adminId") FROM "Event") - (SELECT count(*) FROM "Organizer"))
UNION ALL
SELECT 'events_have_exactly_one_ticket_type', count(*) FROM "Event" e
 WHERE (SELECT count(*) FROM "TicketType" t WHERE t."eventId" = e."id") <> 1
UNION ALL
SELECT 'no_event_published_by_migration', count(*) FROM "Event" WHERE "status" NOT IN ('PENDING_REVIEW', 'COMPLETED')
UNION ALL
SELECT 'ticket_prices_match_legacy', count(*) FROM "Event" e JOIN "TicketType" t ON t."eventId" = e."id"
 WHERE t."priceMinor" <> CASE e."eventType" WHEN 'PAID' THEN round(e."price" * 100)::integer ELSE 0 END
UNION ALL
SELECT 'inventory_preserved',
       abs((SELECT coalesce(sum("availableTickets"), 0) FROM "Event")
         + (SELECT coalesce(sum("quantity"), 0) FROM "Booking" WHERE "status" <> 'CANCELLED')
         - (SELECT coalesce(sum("quantityTotal"), 0) FROM "TicketType"))
UNION ALL
SELECT 'bookings_have_currency_and_total', count(*) FROM "Booking" WHERE "currency" IS NULL OR "totalMinor" IS NULL
UNION ALL
SELECT 'booking_totals_preserved', count(*) FROM "Booking" WHERE "totalMinor" <> round("totalAmount" * 100)::integer
UNION ALL
SELECT 'booking_items_match_quantity', count(*) FROM "Booking" b
 WHERE b."quantity" IS DISTINCT FROM (SELECT sum(i."quantity") FROM "BookingItem" i WHERE i."bookingId" = b."id")
UNION ALL
SELECT 'cover_images_preserved', count(*) FROM "Event" e JOIN "Picture" p ON p."id" = e."pictureId"
 WHERE trim(p."displayPicture") <> '' AND NOT EXISTS (
   SELECT 1 FROM "EventMedia" em JOIN "FileAsset" fa ON fa."id" = em."assetId"
    WHERE em."eventId" = e."id" AND em."role" = 'COVER' AND fa."storageKey" = p."displayPicture")
UNION ALL
SELECT 'all_image_urls_preserved', count(*) FROM (
  SELECT "displayPicture" AS url FROM "Picture" UNION SELECT unnest("previewPictures") FROM "Picture") u
 WHERE trim(url) <> '' AND NOT EXISTS (SELECT 1 FROM "FileAsset" fa WHERE fa."storageKey" = u.url)
UNION ALL
SELECT 'no_platform_admins_created', count(*) FROM "User" WHERE "platformRole" <> 'USER'
UNION ALL
SELECT 'no_organizer_verified_by_migration', count(*) FROM "Organizer" WHERE "verificationStatus" <> 'NOT_STARTED'
UNION ALL
SELECT 'emails_lowercase', count(*) FROM "User" WHERE "email" <> lower("email")
UNION ALL
SELECT 'categories_have_slug', count(*) FROM "Category" WHERE "slug" IS NULL;

DO $$
DECLARE failures text;
BEGIN
  SELECT string_agg(name || '=' || violations, ', ' ORDER BY name) INTO failures FROM phase2b_invariants WHERE violations <> 0;
  IF failures IS NOT NULL THEN
    RAISE EXCEPTION 'phase2b backfill: invariants failed (violations): %', failures;
  END IF;
END $$;

-- ── 11. Summary (exists only if every invariant passed) ──
INSERT INTO "AuditLog" ("id", "actorId", "actorRole", "action", "targetType", "targetId", "metadata", "createdAt")
SELECT 'aud_phase2b_backfill', NULL, 'SYSTEM', 'migration.phase2b.backfill', 'system', 'phase2b',
       jsonb_build_object(
         'transformed', (SELECT jsonb_object_agg(step, n ORDER BY step) FROM phase2b_counts
                          WHERE step NOT LIKE 'defaults.%' AND step NOT LIKE '%untouched' AND step NOT LIKE '%skipped' AND step NOT LIKE '%kept_inert'),
         'defaultsApplied', (SELECT jsonb_object_agg(step, n ORDER BY step) FROM phase2b_counts WHERE step LIKE 'defaults.%'),
         'leftUntouched', (SELECT jsonb_object_agg(step, n ORDER BY step) FROM phase2b_counts
                            WHERE step LIKE '%untouched' OR step LIKE '%skipped' OR step LIKE '%kept_inert'),
         'invariants', (SELECT jsonb_object_agg(name, CASE WHEN violations = 0 THEN 'passed' ELSE 'FAILED' END ORDER BY name) FROM phase2b_invariants),
         'anomaliesKeptAsHistory', jsonb_build_object(
           -- legacy totals were client-supplied; the recorded amount is preserved, not "corrected"
           'bookings_total_differs_from_quantity_x_price',
           (SELECT count(*) FROM "Booking" b JOIN "BookingItem" i ON i."bookingId" = b."id"
             WHERE b."totalMinor" <> i."quantity" * i."unitPriceMinor")),
         'totals', jsonb_build_object(
           'users', (SELECT count(*) FROM "User"),
           'organizers', (SELECT count(*) FROM "Organizer"),
           'events', (SELECT count(*) FROM "Event"),
           'bookings', (SELECT count(*) FROM "Booking"),
           'ticketTypes', (SELECT count(*) FROM "TicketType"),
           'fileAssets', (SELECT count(*) FROM "FileAsset"),
           'eventMedia', (SELECT count(*) FROM "EventMedia"))),
       now();

DROP TABLE phase2b_counts;
DROP TABLE phase2b_invariants;
