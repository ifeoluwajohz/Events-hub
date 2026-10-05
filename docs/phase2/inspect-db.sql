-- READ-ONLY. Returns counts and structure only; no personal data.
BEGIN TRANSACTION READ ONLY;
-- 1. Which schema shape is this database in?
SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS columns
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('User','Admin','Event','Picture','EventImages','Booking','Ticket')
GROUP BY table_name ORDER BY table_name;
-- 2. Which migrations are recorded as applied?
SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at IS NOT NULL AS rolled_back
FROM "_prisma_migrations" ORDER BY started_at;
-- 3. Row counts
SELECT 'User' t, count(*) FROM "User" UNION ALL SELECT 'Admin', count(*) FROM "Admin"
UNION ALL SELECT 'Event', count(*) FROM "Event" UNION ALL SELECT 'Booking', count(*) FROM "Booking"
UNION ALL SELECT 'Ticket', count(*) FROM "Ticket" UNION ALL SELECT 'Picture', count(*) FROM "Picture"
UNION ALL SELECT 'Category', count(*) FROM "Category" UNION ALL SELECT 'EventCategory', count(*) FROM "EventCategory"
UNION ALL SELECT 'EventReview', count(*) FROM "EventReview" UNION ALL SELECT 'Payment', count(*) FROM "Payment"
UNION ALL SELECT 'DiscountCode', count(*) FROM "DiscountCode";
-- 4. Migration-relevant shapes (assumes the migrations' column names)
SELECT
  (SELECT count(*) FROM "User" WHERE role = 'ADMIN')                                   AS users_role_admin,
  (SELECT count(*) FROM "User" WHERE email IS NULL)                                    AS users_without_email,
  (SELECT count(*) FROM "Admin" a WHERE EXISTS (SELECT 1 FROM "Event" e WHERE e."adminId" = a."userId")) AS admins_owning_events,
  (SELECT count(*) FROM "Event" WHERE date < now())                                    AS events_past,
  (SELECT count(*) FROM "Event" WHERE date >= now())                                   AS events_future,
  (SELECT count(*) FROM "Event" WHERE "eventType" = 'PAID')                            AS events_paid,
  (SELECT count(*) FROM "Event" WHERE "eventType" = 'PAID' AND (price IS NULL OR price <= 0)) AS paid_without_price,
  (SELECT count(*) FROM "Event" WHERE price <> round(price::numeric, 2))               AS prices_over_2dp,
  (SELECT count(*) FROM "Event" WHERE "availableTickets" < 0)                          AS negative_inventory,
  (SELECT string_agg(s || '=' || c, ',') FROM (SELECT status::text s, count(*) c FROM "Booking" GROUP BY 1) x) AS booking_statuses,
  (SELECT count(*) FROM "Booking" WHERE "refundStatus" IS NOT NULL OR "isActive")      AS bookings_with_refund_or_active,
  (SELECT string_agg(s || '=' || c, ',') FROM (SELECT status::text s, count(*) c FROM "Ticket" GROUP BY 1) x)  AS ticket_statuses,
  (SELECT count(*) FROM (SELECT "eventId","categoryId" FROM "EventCategory" GROUP BY 1,2 HAVING count(*)>1) d) AS duplicate_event_categories,
  (SELECT count(*) FROM (SELECT lower(name) FROM "Category" GROUP BY 1 HAVING count(*)>1) d)                  AS case_duplicate_categories;
ROLLBACK;
