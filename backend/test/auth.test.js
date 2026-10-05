const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, token, otherKey } = require("./helpers/app");

describe("authentication: Clerk -> canonical User", () => {
  let t;
  before(async () => (t = await setup()));
  after(async () => t && t.teardown());

  const get = (auth) => {
    const r = request(t.app).get("/me");
    return auth ? r.set("Authorization", auth) : r;
  };

  test("no token is rejected", async () => {
    const res = await get(null);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHENTICATED");
  });

  test("a token signed by another key is rejected", async () => {
    t.setProfile("user_forged", { email: "forged@example.test" });
    assert.equal((await get(`Bearer ${token("user_forged", { key: otherKey })}`)).status, 401);
  });

  test("an expired token is rejected", async () => {
    assert.equal((await get(`Bearer ${token("user_x", { expired: true })}`)).status, 401);
  });

  test("a token issued to an unauthorized origin is rejected", async () => {
    assert.equal((await get(`Bearer ${token("user_x", { azp: "https://evil.example" })}`)).status, 401);
  });

  test("a garbage token is rejected", async () => {
    assert.equal((await get("Bearer not-a-jwt")).status, 401);
  });

  test("an unknown Clerk user is created once, with the verified email", async () => {
    t.setProfile("user_new", { email: "new@example.test", emailVerified: true, name: "New Person" });
    const first = await get(`Bearer ${token("user_new")}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.email, "new@example.test");
    assert.equal(first.body.data.platformRole, "USER");
    assert.deepEqual(first.body.data.capabilities.isPlatformAdmin, false);
    const second = await get(`Bearer ${token("user_new")}`);
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(await t.prisma.user.count({ where: { clerkUserId: "user_new" } }), 1);
  });

  test("concurrent first requests create exactly one user", async () => {
    t.setProfile("user_race", { email: "race@example.test" });
    const results = await Promise.all(Array.from({ length: 8 }, () => get(`Bearer ${token("user_race")}`)));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
    assert.equal(await t.prisma.user.count({ where: { clerkUserId: "user_race" } }), 1);
  });

  test("an unverified email is never stored", async () => {
    t.setProfile("user_unverified", { email: "unverified@example.test", emailVerified: false });
    const res = await get(`Bearer ${token("user_unverified")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.email, null);
  });

  describe("legacy Firebase account linking", () => {
    const legacy = (id, email) =>
      t.prisma.user.create({ data: { id, legacyFirebaseUid: `fb_${id}`, email, name: "Legacy", legacyRole: "ADMIN" } });

    test("links on a verified, exactly matching email and keeps the legacy identity", async () => {
      await legacy("usr_legacy_1", "legacy1@example.test");
      t.setProfile("user_clerk_legacy1", { email: "legacy1@example.test", emailVerified: true });
      const res = await get(`Bearer ${token("user_clerk_legacy1")}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, "usr_legacy_1", "same database user, so bookings/events are preserved");
      // legacy role ADMIN does not make them a platform admin
      assert.equal(res.body.data.platformRole, "USER");
      const audit = await t.prisma.auditLog.findFirst({ where: { action: "user.legacy_account_linked", targetId: "usr_legacy_1" } });
      assert.ok(audit);
      assert.equal(/** @type {any} */ (audit.metadata).rule, "verified-email-exact-match");
    });

    test("does NOT link on an unverified email", async () => {
      await legacy("usr_legacy_2", "legacy2@example.test");
      t.setProfile("user_clerk_unverified", { email: "legacy2@example.test", emailVerified: false });
      const res = await get(`Bearer ${token("user_clerk_unverified")}`);
      assert.equal(res.status, 200);
      assert.notEqual(res.body.data.id, "usr_legacy_2");
      assert.equal(res.body.data.email, null);
      const stillLegacy = await t.prisma.user.findUnique({ where: { id: "usr_legacy_2" } });
      assert.equal(stillLegacy?.clerkUserId, null);
    });

    test("does NOT link on a different email (no fuzzy matching)", async () => {
      await legacy("usr_legacy_3", "legacy3@example.test");
      t.setProfile("user_clerk_other", { email: "legacy3+alias@example.test", emailVerified: true });
      const res = await get(`Bearer ${token("user_clerk_other")}`);
      assert.notEqual(res.body.data.id, "usr_legacy_3");
    });

    test("refuses (409) when the verified email belongs to another linked account", async () => {
      t.setProfile("user_owner", { email: "taken@example.test", emailVerified: true });
      assert.equal((await get(`Bearer ${token("user_owner")}`)).status, 200);
      t.setProfile("user_intruder", { email: "taken@example.test", emailVerified: true });
      const res = await get(`Bearer ${token("user_intruder")}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ACCOUNT_LINK_CONFLICT");
      assert.equal(await t.prisma.user.count({ where: { clerkUserId: "user_intruder" } }), 0);
      assert.ok(await t.prisma.auditLog.findFirst({ where: { action: "user.account_link_conflict" } }));
    });

    test("a second Clerk account cannot take over an already-linked legacy user", async () => {
      await legacy("usr_legacy_4", "legacy4@example.test");
      t.setProfile("user_first", { email: "legacy4@example.test" });
      assert.equal((await get(`Bearer ${token("user_first")}`)).body.data.id, "usr_legacy_4");
      t.setProfile("user_second", { email: "legacy4@example.test" });
      assert.equal((await get(`Bearer ${token("user_second")}`)).status, 409);
    });
  });

  describe("account status", () => {
    test("a suspended user can read their account but not act", async () => {
      const u = await t.attendee("suspended");
      await t.prisma.user.update({ where: { id: u.id }, data: { status: "SUSPENDED" } });
      assert.equal((await u.api.get("/me")).status, 200);
      assert.equal((await u.api.get("/me/bookings")).status, 200);
      const write = await u.api.patch("/me", { displayName: "x" });
      assert.equal(write.status, 403);
      assert.equal(write.body.error.code, "ACCOUNT_SUSPENDED");
      assert.equal((await u.api.post("/organizer", { displayName: "Nope" })).status, 403);
    });
  });

  describe("errors never leak internals", () => {
    test("malformed JSON gives a clean 400", async () => {
      const u = await t.attendee();
      const res = await request(t.app).patch("/me").set("Authorization", `Bearer ${token(u.sub)}`).set("Content-Type", "application/json").send("{bad");
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "INVALID_JSON");
      assert.ok(!JSON.stringify(res.body).includes("at "), "no stack trace");
    });
  });
});
