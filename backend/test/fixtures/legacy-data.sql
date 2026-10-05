-- Realistic pre-Phase-2 data, in the shape produced by the 5 legacy migrations.
-- Fictional people and URLs only.

INSERT INTO "User" ("id", "firebaseUid", "email", "prefferedName", "profilePicture", "location", "name", "phone", "role", "createdAt", "updatedAt") VALUES
  ('usr_ada',   'fb_ada',   'Ada.Organizer@Example.COM', 'Ada Events', 'https://img.example.test/ada.png', 'Lagos', 'Ada Lovelace', '+2348000000001', 'ADMIN', now() - interval '300 days', now()),
  ('usr_ghost', 'fb_ghost', 'ghost@example.test',        NULL,         '',                                  NULL,    'Ghost Admin',  NULL,             'ADMIN', now() - interval '200 days', now()),
  ('usr_tunde', 'fb_tunde', NULL,                        NULL,         '',                                  'Abuja', 'Tunde',        NULL,             'USER',  now() - interval '100 days', now()),
  ('usr_bola',  'fb_bola',  'bola@example.test',         'Bola',       'https://img.example.test/bola.png', NULL,    NULL,           NULL,             'ADMIN', now() - interval '90 days',  now()),
  ('usr_chidi', 'fb_chidi', 'chidi@example.test',        NULL,         '',                                  NULL,    'Chidi',        NULL,             'USER',  now() - interval '10 days',  now());

-- loginUser created an Admin row for EVERY new user; only ada and bola own events.
INSERT INTO "Admin" ("userId", "createdAt", "updatedAt") VALUES
  ('usr_ada',   now() - interval '300 days', now()),
  ('usr_ghost', now() - interval '200 days', now()),
  ('usr_tunde', now() - interval '100 days', now()),
  ('usr_bola',  now() - interval '90 days',  now()),
  ('usr_chidi', now() - interval '10 days',  now());

INSERT INTO "Picture" ("id", "displayPicture", "previewPictures") VALUES
  ('pic_1', 'https://img.example.test/concert.jpg', ARRAY['https://img.example.test/concert-2.jpg', 'https://img.example.test/concert-3.jpg']),
  ('pic_2', 'https://img.example.test/meetup.jpg',  ARRAY['https://img.example.test/concert-2.jpg', 'https://img.example.test/meetup.jpg', '']),
  ('pic_orphan', 'https://img.example.test/unused.jpg', ARRAY[]::text[]);

INSERT INTO "Event" ("id", "title", "shortDescription", "longDescription", "date", "venue", "eventType", "price", "availableTickets", "pictureId", "adminId", "createdAt", "updatedAt") VALUES
  ('evt_future_free', 'Lagos Tech Meetup!',   'Monthly meetup', 'Talks and networking.', now() + interval '20 days', 'Yaba, Lagos',   'FREE', NULL,    47, 'pic_2', 'usr_ada',  now() - interval '30 days', now()),
  ('evt_future_paid', 'Afrobeats Night',      'Live music',     'All night long.',       now() + interval '45 days', 'Eko Hotel',     'PAID', 5000.5,  10, 'pic_1', 'usr_ada',  now() - interval '20 days', now()),
  ('evt_past_paid',   'Afrobeats Night',      'Last year',      'Sold out show.',        now() - interval '60 days', 'Eko Hotel',     'PAID', 2500,     0, NULL,    'usr_ada',  now() - interval '90 days', now()),
  ('evt_bola',        'Book Club: Season 2',  'Reading circle', 'Bring a book.',         now() + interval '5 days',  'Ikeja Library', 'FREE', 0,       20, NULL,    'usr_bola', now() - interval '3 days',  now());

INSERT INTO "Booking" ("id", "userId", "eventId", "bookingDate", "quantity", "totalAmount", "status", "isActive", "cancellationReason", "refundStatus") VALUES
  ('bk_1', 'usr_tunde', 'evt_future_free', now() - interval '5 days', 2, 0,      'PENDING',   false, NULL,           NULL),
  ('bk_2', 'usr_chidi', 'evt_future_free', now() - interval '4 days', 1, 0,      'CANCELLED', false, 'Cannot make it', NULL),
  ('bk_3', 'usr_tunde', 'evt_future_paid', now() - interval '3 days', 1, 5000.5, 'PENDING',   false, NULL,           NULL),
  ('bk_4', 'usr_chidi', 'evt_past_paid',   now() - interval '70 days', 3, 7500,  'CONFIRMED', true,  NULL,           NULL),
  ('bk_5', 'usr_bola',  'evt_future_free', now() - interval '1 day',  1, 0,      'CONFIRMED', false, NULL,           NULL),
  -- legacy API trusted client totals: a paid seat recorded with total 0 (kept as history, reported as anomaly)
  ('bk_6', 'usr_ghost', 'evt_future_paid', now() - interval '2 days', 1, 0,      'PENDING',   false, NULL,           NULL);

INSERT INTO "Category" ("id", "name") VALUES ('cat_music', 'Music'), ('cat_tech', 'Tech & Startups');
INSERT INTO "EventCategory" ("id", "eventId", "categoryId") VALUES
  ('ec_1', 'evt_future_free', 'cat_tech'), ('ec_2', 'evt_future_paid', 'cat_music'), ('ec_3', 'evt_past_paid', 'cat_music');

INSERT INTO "EventReview" ("id", "userId", "eventId", "rating", "comment", "createdAt", "updatedAt") VALUES
  ('00000000-0000-0000-0000-000000000001', 'usr_chidi', 'evt_past_paid', 5, 'Great night', now() - interval '59 days', now());
