// Durable Phase 2B invariants: properties of MIGRATED records that must remain true
// after the application is in use. Each query returns one row: { violations }.
// Legacy columns are read until the (deferred) contract migration removes them.

/** @type {Array<{ name: string, sql: string }>} */
const DURABLE_CHECKS = [
  {
    name: "migrated_events_keep_legacy_owner",
    sql: `SELECT count(*) AS violations FROM "Event" e JOIN "Organizer" o ON o."id" = e."organizerId"
          WHERE e."adminId" IS NOT NULL AND o."ownerUserId" <> e."adminId"`,
  },
  {
    name: "migrated_events_keep_general_admission",
    sql: `SELECT count(*) AS violations FROM "Event" e
          WHERE e."adminId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "TicketType" t WHERE t."id" = 'tt_' || substr(md5(e."id"), 1, 24) AND t."eventId" = e."id")`,
  },
  {
    name: "migrated_ticket_prices_match_legacy",
    sql: `SELECT count(*) AS violations FROM "Event" e JOIN "TicketType" t ON t."id" = 'tt_' || substr(md5(e."id"), 1, 24)
          WHERE e."adminId" IS NOT NULL
            AND t."priceMinor" <> CASE e."eventType" WHEN 'PAID' THEN round(e."price" * 100)::integer ELSE 0 END`,
  },
  {
    name: "migrated_booking_totals_match_legacy",
    sql: `SELECT count(*) AS violations FROM "Booking"
          WHERE "totalAmount" IS NOT NULL AND "totalMinor" <> round("totalAmount" * 100)::integer`,
  },
  {
    name: "migrated_booking_items_match_legacy_quantity",
    sql: `SELECT count(*) AS violations FROM "Booking" b
          WHERE b."quantity" IS NOT NULL
            AND b."quantity" IS DISTINCT FROM (SELECT sum(i."quantity") FROM "BookingItem" i WHERE i."bookingId" = b."id")`,
  },
  {
    name: "all_legacy_image_urls_preserved",
    sql: `SELECT count(*) AS violations FROM (
            SELECT "displayPicture" AS url FROM "Picture" UNION SELECT unnest("previewPictures") FROM "Picture") u
          WHERE trim(url) <> '' AND NOT EXISTS (SELECT 1 FROM "FileAsset" fa WHERE fa."storageKey" = u.url)`,
  },
  {
    name: "migration_history_intact",
    sql: `SELECT (SELECT count(*) FROM "Event" WHERE "adminId" IS NOT NULL)
               - (SELECT count(*) FROM "EventModerationAction" WHERE "action" = 'MIGRATED') AS violations`,
  },
  {
    name: "no_rows_lost_since_migration",
    sql: `SELECT (CASE WHEN (SELECT count(*) FROM "User") < (r."metadata"->'totals'->>'users')::int THEN 1 ELSE 0 END
                + CASE WHEN (SELECT count(*) FROM "Event") < (r."metadata"->'totals'->>'events')::int THEN 1 ELSE 0 END
                + CASE WHEN (SELECT count(*) FROM "Booking") < (r."metadata"->'totals'->>'bookings')::int THEN 1 ELSE 0 END) AS violations
          FROM "AuditLog" r WHERE r."id" = 'aud_phase2b_backfill'`,
  },
];

module.exports = { DURABLE_CHECKS };
