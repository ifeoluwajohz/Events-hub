// Phase 2B migration tests: realistic legacy data -> expand/backfill/tighten,
// deployed with `prisma migrate deploy` exactly as in production.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const BACKEND = path.resolve(__dirname, "..");
const {
  allMigrationNames,
  createDatabase,
  dropDatabase,
  migrateDeploy,
  prismaCli,
  withClient,
} = require("./helpers/database");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "legacy-data.sql"), "utf8");
const ALL = allMigrationNames();
const LEGACY = ALL.filter((n) => !n.includes("phase2b"));
const EXPAND = ALL.find((n) => n.endsWith("_phase2b_expand"));
const BACKFILL = ALL.find((n) => n.endsWith("_phase2b_backfill"));

const rows = async (client, sql, params) => (await client.query(sql, params)).rows;
const count = async (client, table) =>
  Number((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);

// Everything the old application stored, read through the legacy column names.
async function snapshotLegacy(client) {
  const tables = ["User", "Admin", "Event", "Booking", "Picture", "Category", "EventCategory", "EventReview"];
  const counts = {};
  for (const t of tables) counts[t] = await count(client, t);
  return {
    counts,
    users: await rows(client, `SELECT "id","firebaseUid","email","name","prefferedName","phone","location","role" FROM "User" ORDER BY "id"`),
    events: await rows(client, `SELECT "id","title","shortDescription","longDescription","date","venue","eventType","price","availableTickets","pictureId","adminId" FROM "Event" ORDER BY "id"`),
    bookings: await rows(client, `SELECT "id","userId","eventId","quantity","totalAmount","status","bookingDate" FROM "Booking" ORDER BY "id"`),
    pictures: await rows(client, `SELECT * FROM "Picture" ORDER BY "id"`),
  };
}

describe("phase 2B migration on realistic legacy data", () => {
  let db;
  let before_;

  before(async () => {
    db = await createDatabase("evt_mig");
    migrateDeploy(db.url, LEGACY);
    await withClient(db.url, (c) => c.query(FIXTURE));
    before_ = await withClient(db.url, snapshotLegacy);
    migrateDeploy(db.url); // applies the three phase2b migrations
  });
  after(async () => db && dropDatabase(db.name));

  test("no row disappears and legacy data is untouched", async () => {
    const after_ = await withClient(db.url, snapshotLegacy);
    assert.deepEqual(after_.counts, before_.counts);
    // emails are lower-cased (the only legacy value intentionally normalised)
    const expectedUsers = before_.users.map((u) => ({ ...u, email: u.email && u.email.toLowerCase() }));
    assert.deepEqual(after_.users, expectedUsers);
    assert.deepEqual(after_.events, before_.events);
    assert.deepEqual(after_.bookings, before_.bookings);
    assert.deepEqual(after_.pictures, before_.pictures);
  });

  test("organizers exist only for legacy admins that own events, unverified", async () => {
    await withClient(db.url, async (c) => {
      const orgs = await rows(c, `SELECT "ownerUserId","displayName","verificationStatus","status" FROM "Organizer" ORDER BY "ownerUserId"`);
      assert.deepEqual(orgs, [
        { ownerUserId: "usr_ada", displayName: "Ada Events", verificationStatus: "NOT_STARTED", status: "ACTIVE" },
        { ownerUserId: "usr_bola", displayName: "Bola", verificationStatus: "NOT_STARTED", status: "ACTIVE" },
      ]);
    });
  });

  test("event ownership is preserved through the organizer", async () => {
    await withClient(db.url, async (c) => {
      const mismatched = await rows(c, `SELECT e."id" FROM "Event" e JOIN "Organizer" o ON o."id" = e."organizerId" WHERE o."ownerUserId" <> e."adminId"`);
      assert.equal(mismatched.length, 0);
      assert.equal(await count(c, "Event"), 4);
    });
  });

  test("nobody becomes a platform admin; legacy role is kept but inert", async () => {
    await withClient(db.url, async (c) => {
      const admins = await rows(c, `SELECT "id" FROM "User" WHERE "platformRole" = 'ADMIN'`);
      assert.equal(admins.length, 0);
      const legacyAdmins = await rows(c, `SELECT "id" FROM "User" WHERE "role" = 'ADMIN' ORDER BY "id"`);
      assert.deepEqual(legacyAdmins.map((r) => r.id), ["usr_ada", "usr_bola", "usr_ghost"]);
    });
  });

  test("future events await moderation, past events are completed, nothing is published", async () => {
    await withClient(db.url, async (c) => {
      const ev = await rows(c, `SELECT "id","status","currency","timezone","submittedAt" IS NOT NULL AS submitted FROM "Event" ORDER BY "id"`);
      assert.deepEqual(ev, [
        { id: "evt_bola", status: "PENDING_REVIEW", currency: "NGN", timezone: "Africa/Lagos", submitted: true },
        { id: "evt_future_free", status: "PENDING_REVIEW", currency: "NGN", timezone: "Africa/Lagos", submitted: true },
        { id: "evt_future_paid", status: "PENDING_REVIEW", currency: "NGN", timezone: "Africa/Lagos", submitted: true },
        { id: "evt_past_paid", status: "COMPLETED", currency: "NGN", timezone: "Africa/Lagos", submitted: false },
      ]);
      const history = await rows(c, `SELECT "eventId","action","actorRole","toStatus" FROM "EventModerationAction" ORDER BY "eventId"`);
      assert.equal(history.length, 4);
      assert.ok(history.every((h) => h.action === "MIGRATED" && h.actorRole === "SYSTEM"));
    });
  });

  test("slugs are unique even for identical titles", async () => {
    await withClient(db.url, async (c) => {
      const slugs = (await rows(c, `SELECT "slug" FROM "Event" WHERE "title" = 'Afrobeats Night'`)).map((r) => r.slug);
      assert.equal(slugs.length, 2);
      assert.notEqual(slugs[0], slugs[1]);
      assert.ok(slugs.every((s) => s.startsWith("afrobeats-night-")));
    });
  });

  test("general admission ticket types carry price (minor units) and inventory", async () => {
    await withClient(db.url, async (c) => {
      const tt = await rows(c, `SELECT "eventId","name","priceMinor","quantityTotal","quantitySold" FROM "TicketType" ORDER BY "eventId"`);
      assert.deepEqual(tt, [
        { eventId: "evt_bola", name: "General admission", priceMinor: 0, quantityTotal: 20, quantitySold: 0 },
        // 47 available + 3 held (bk_1 x2 PENDING, bk_5 x1 CONFIRMED; cancelled bk_2 excluded)
        { eventId: "evt_future_free", name: "General admission", priceMinor: 0, quantityTotal: 50, quantitySold: 3 },
        // 10 available + bk_3 + bk_6
        { eventId: "evt_future_paid", name: "General admission", priceMinor: 500050, quantityTotal: 12, quantitySold: 2 },
        { eventId: "evt_past_paid", name: "General admission", priceMinor: 250000, quantityTotal: 3, quantitySold: 3 },
      ]);
    });
  });

  test("bookings keep their owner and gain minor-unit totals and items", async () => {
    await withClient(db.url, async (c) => {
      const bk = await rows(c, `
        SELECT b."id", b."userId", b."currency", b."totalMinor", i."quantity", i."unitPriceMinor"
        FROM "Booking" b JOIN "BookingItem" i ON i."bookingId" = b."id" ORDER BY b."id"`);
      assert.deepEqual(bk, [
        { id: "bk_1", userId: "usr_tunde", currency: "NGN", totalMinor: 0, quantity: 2, unitPriceMinor: 0 },
        { id: "bk_2", userId: "usr_chidi", currency: "NGN", totalMinor: 0, quantity: 1, unitPriceMinor: 0 },
        { id: "bk_3", userId: "usr_tunde", currency: "NGN", totalMinor: 500050, quantity: 1, unitPriceMinor: 500050 },
        { id: "bk_4", userId: "usr_chidi", currency: "NGN", totalMinor: 750000, quantity: 3, unitPriceMinor: 250000 },
        { id: "bk_5", userId: "usr_bola", currency: "NGN", totalMinor: 0, quantity: 1, unitPriceMinor: 0 },
        // recorded total kept as history (anomaly), not "corrected"
        { id: "bk_6", userId: "usr_ghost", currency: "NGN", totalMinor: 0, quantity: 1, unitPriceMinor: 500050 },
      ]);
    });
  });

  test("every image URL survives as a public asset and covers/galleries are linked", async () => {
    await withClient(db.url, async (c) => {
      const assets = (await rows(c, `SELECT "storageKey" FROM "FileAsset" WHERE "storageProvider" = 'external-url' AND "visibility" = 'PUBLIC' ORDER BY 1`)).map((r) => r.storageKey);
      assert.deepEqual(assets, [
        "https://img.example.test/concert-2.jpg",
        "https://img.example.test/concert-3.jpg",
        "https://img.example.test/concert.jpg",
        "https://img.example.test/meetup.jpg",
        "https://img.example.test/unused.jpg",
      ]);
      const media = await rows(c, `
        SELECT em."eventId", em."role", fa."storageKey" FROM "EventMedia" em JOIN "FileAsset" fa ON fa."id" = em."assetId"
        ORDER BY em."eventId", em."role", em."position"`);
      assert.deepEqual(media, [
        { eventId: "evt_future_free", role: "COVER", storageKey: "https://img.example.test/meetup.jpg" },
        { eventId: "evt_future_free", role: "GALLERY", storageKey: "https://img.example.test/concert-2.jpg" },
        { eventId: "evt_future_paid", role: "COVER", storageKey: "https://img.example.test/concert.jpg" },
        { eventId: "evt_future_paid", role: "GALLERY", storageKey: "https://img.example.test/concert-2.jpg" },
        { eventId: "evt_future_paid", role: "GALLERY", storageKey: "https://img.example.test/concert-3.jpg" },
      ]);
    });
  });

  test("categories get slugs; links and ratings are preserved", async () => {
    await withClient(db.url, async (c) => {
      assert.deepEqual(await rows(c, `SELECT "slug" FROM "Category" ORDER BY 1`), [{ slug: "music" }, { slug: "tech-startups" }]);
      assert.equal(await count(c, "EventCategory"), 3);
      assert.equal(await count(c, "EventReview"), 1);
    });
  });

  test("the migration is recorded in the audit log", async () => {
    await withClient(db.url, async (c) => {
      const actions = (await rows(c, `SELECT "action" FROM "AuditLog" ORDER BY "action"`)).map((r) => r.action);
      assert.deepEqual(actions, [
        "migration.organizer.created_from_legacy_admin",
        "migration.organizer.created_from_legacy_admin",
        "migration.phase2b.backfill",
      ]);
    });
  });

  test("the backfill records exactly what it transformed and that every invariant passed", async () => {
    await withClient(db.url, async (c) => {
      const [row] = await rows(c, `SELECT "metadata" FROM "AuditLog" WHERE "id" = 'aud_phase2b_backfill'`);
      const m = row.metadata;
      assert.deepEqual(m.transformed, {
        "audit.organizer_entries": 2,
        "booking_items.created": 6,
        "bookings.converted_to_minor_units": 6,
        "categories.slugged": 2,
        "event_media.covers_linked": 2,
        "event_media.gallery_linked": 3,
        "events.migrated": 4,
        "events.to_completed": 1,
        "events.to_pending_review": 3,
        "file_assets.created_from_legacy_urls": 5,
        "moderation.migrated_records_created": 4,
        "organizers.created_from_legacy_admin": 2,
        "ticket_types.created": 4,
        "ticket_types.free": 2,
        "ticket_types.paid": 2,
        "users.emails_lowercased": 1,
        "users.platform_role_reset": 0,
      });
      assert.deepEqual(m.defaultsApplied, { "defaults.events_currency_ngn": 4, "defaults.events_timezone_africa_lagos": 4 });
      assert.deepEqual(m.leftUntouched, {
        "admins.legacy_rows_without_events_untouched": 3,
        "media.empty_legacy_urls_skipped": 1,
        "users.legacy_role_admin_kept_inert": 3,
      });
      assert.deepEqual(m.anomaliesKeptAsHistory, { bookings_total_differs_from_quantity_x_price: 1 });
      assert.equal(Object.keys(m.invariants).length, 16);
      assert.ok(Object.values(m.invariants).every((v) => v === "passed"), JSON.stringify(m.invariants));
      assert.deepEqual(m.totals, { users: 5, organizers: 2, events: 4, bookings: 6, ticketTypes: 4, fileAssets: 5, eventMedia: 5 });
    });
  });

  test("migrate:report prints the record and independently re-verifies durable invariants", () => {
    const out = execFileSync("node", ["scripts/migration-report.js", "--json"], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: db.url }, encoding: "utf8" });
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.equal(report.recorded.transformed["events.migrated"], 4);
    assert.ok(report.rechecks.length >= 8 && report.rechecks.every((c) => c.passed), JSON.stringify(report.rechecks));
  });

  test("history is append-only at the database level (all five tables, UPDATE and DELETE)", async () => {
    await withClient(db.url, async (c) => {
      // give every history table at least one row
      await c.query(`INSERT INTO "OrganizerStatusChange" ("id","organizerId","actorId","fromStatus","toStatus","reason")
                     SELECT 'osc_t', "id", "ownerUserId", 'ACTIVE', 'SUSPENDED', 'test' FROM "Organizer" LIMIT 1`);
      await c.query(`INSERT INTO "VerificationSubmission" ("id","organizerId","submittedById","country","organizerType","requirementSetVersion","declaredData","updatedAt")
                     SELECT 'vs_t', "id", "ownerUserId", 'NG', 'INDIVIDUAL', 'DEFAULT-INDIVIDUAL@2026-10', '{}'::jsonb, now() FROM "Organizer" LIMIT 1`);
      await c.query(`INSERT INTO "VerificationEvidence" ("id","submissionId","requirementKey","kind","value") VALUES ('ve_t','vs_t','web_presence','WEB_PRESENCE','https://x.example')`);
      await c.query(`INSERT INTO "VerificationDecision" ("id","submissionId","reviewerId","action") SELECT 'vd_t','vs_t',"ownerUserId",'START_REVIEW' FROM "Organizer" LIMIT 1`);
      for (const table of ["AuditLog", "EventModerationAction", "VerificationDecision", "OrganizerStatusChange", "VerificationEvidence"]) {
        await assert.rejects(c.query(`UPDATE "${table}" SET "createdAt" = now()`), /append-only/, `UPDATE ${table}`);
        await assert.rejects(c.query(`DELETE FROM "${table}"`), /append-only/, `DELETE ${table}`);
      }
      await assert.rejects(c.query(`UPDATE "VerificationSubmission" SET "declaredData" = '{"x":1}'::jsonb`), /immutable/);
      await assert.rejects(c.query(`DELETE FROM "VerificationSubmission"`), /cannot be deleted/);
      // status (and only status) may change
      await c.query(`UPDATE "VerificationSubmission" SET "status" = 'UNDER_REVIEW' WHERE "id" = 'vs_t'`);
    });
  });

  test("schema has no drift after migrating", () => {
    // exits non-zero (throws) if the migrated database differs from schema.prisma
    prismaCli(db.url, ["migrate", "diff", "--from-url", db.url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"]);
  });
});

describe("phase 2B migration refuses unsafe data and rolls back", () => {
  async function legacyDbWith(extraSql, upTo = LEGACY) {
    const db = await createDatabase("evt_mig_bad");
    migrateDeploy(db.url, upTo);
    await withClient(db.url, async (c) => {
      await c.query(FIXTURE);
      if (extraSql) await c.query(extraSql);
    });
    return db;
  }

  const deployFails = (db, pattern) => {
    assert.throws(() => migrateDeploy(db.url), (err) => {
      const out = `${err.stdout || ""}${err.stderr || ""}`;
      assert.match(out, pattern);
      return true;
    });
  };

  test("a PAID event without a price aborts the backfill", async () => {
    const db = await legacyDbWith(`UPDATE "Event" SET "price" = NULL WHERE "id" = 'evt_future_paid'`);
    try {
      deployFails(db, /PAID events have no positive price/);
      await withClient(db.url, async (c) => {
        assert.equal(await count(c, "Organizer"), 0);
        assert.equal(await count(c, "TicketType"), 0);
      });
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("a FREE event that carries a price is refused, not silently made free", async () => {
    const db = await legacyDbWith(`UPDATE "Event" SET "price" = 1500 WHERE "id" = 'evt_bola'`);
    try {
      deployFails(db, /FREE events carry a positive price/);
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("an event owner without any name is refused, not given an invented organizer name", async () => {
    const db = await legacyDbWith(`UPDATE "User" SET "prefferedName" = NULL, "name" = '  ' WHERE "id" = 'usr_bola'`);
    try {
      deployFails(db, /no name to use as organizer name/);
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("migrate:report fails when the backfill never ran", async () => {
    const db = await legacyDbWith(null);
    try {
      assert.throws(
        () => execFileSync("node", ["scripts/migration-report.js"], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: db.url }, encoding: "utf8", stdio: "pipe" }),
        () => true,
      );
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("migrate:report detects later tampering with migrated data", async () => {
    const db = await legacyDbWith(null);
    try {
      migrateDeploy(db.url);
      await withClient(db.url, (c) => c.query(`UPDATE "TicketType" SET "priceMinor" = 1 WHERE "eventId" = 'evt_future_paid'`));
      let out = "";
      try {
        execFileSync("node", ["scripts/migration-report.js", "--json"], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: db.url }, encoding: "utf8", stdio: "pipe" });
        assert.fail("report should exit non-zero");
      } catch (err) {
        out = /** @type {any} */ (err).stdout;
      }
      const report = JSON.parse(out);
      assert.equal(report.ok, false);
      assert.equal(report.rechecks.find((c) => c.name === "migrated_ticket_prices_match_legacy").passed, false);
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("legacy Ticket rows stop the migration for a manual decision", async () => {
    const db = await legacyDbWith(`INSERT INTO "Ticket" ("id","eventId","status","updatedAt") VALUES ('00000000-0000-0000-0000-0000000000aa','evt_bola','AVAILABLE',now())`);
    try {
      deployFails(db, /legacy Ticket rows exist/);
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("case-insensitive duplicate emails stop the migration", async () => {
    const db = await legacyDbWith(`UPDATE "User" SET "email" = 'ADA.organizer@example.com' WHERE "id" = 'usr_chidi'`);
    try {
      deployFails(db, /emails collide case-insensitively/);
    } finally {
      await dropDatabase(db.name);
    }
  });

  test("a failure after writes leaves no partial backfill, and can be retried", async () => {
    // Expand applied, then a colliding Organizer id makes step 3 fail AFTER step 2 has updated emails.
    const db = await legacyDbWith(null, [...LEGACY, EXPAND]);
    try {
      await withClient(db.url, (c) =>
        c.query(`INSERT INTO "Organizer" ("id","ownerUserId","slug","displayName","updatedAt")
                 VALUES ('org_' || substr(md5('usr_ada'),1,24), 'usr_chidi', 'squatter', 'Squatter', now())`));
      deployFails(db, /duplicate key|unique/i);
      await withClient(db.url, async (c) => {
        const [ada] = await rows(c, `SELECT "email" FROM "User" WHERE "id" = 'usr_ada'`);
        assert.equal(ada.email, "Ada.Organizer@Example.COM", "step 2 must have been rolled back");
        assert.equal(await count(c, "EventModerationAction"), 0);
        await c.query(`DELETE FROM "Organizer" WHERE "slug" = 'squatter'`);
      });
      // documented recovery: mark the failed migration rolled back, fix data, redeploy
      prismaCli(db.url, ["migrate", "resolve", "--rolled-back", BACKFILL]);
      migrateDeploy(db.url);
      await withClient(db.url, async (c) => assert.equal(await count(c, "Organizer"), 2));
    } finally {
      await dropDatabase(db.name);
    }
  });
});

describe("phase 2B migration on an empty database", () => {
  test("all migrations apply cleanly with no data", async () => {
    const db = await createDatabase("evt_mig_empty");
    try {
      migrateDeploy(db.url);
      await withClient(db.url, async (c) => assert.equal(await count(c, "Event"), 0));
    } finally {
      await dropDatabase(db.name);
    }
  });
});
