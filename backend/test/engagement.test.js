const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/app");

describe("saved events, follows and reports", () => {
  /** @type {any} */ let t;
  let org, admin, alice, bob, ev;
  before(async () => {
    t = await setup();
    org = await t.organizer("host");
    admin = await t.admin("adm");
    alice = await t.attendee("alice");
    bob = await t.attendee("bob");
    ev = await t.publishedEvent(org, admin);
  });
  after(async () => t && t.teardown());

  test("saving is idempotent and unique per user and event", async () => {
    assert.equal((await alice.api.put(`/me/saved-events/${ev.id}`)).status, 201);
    assert.equal((await alice.api.put(`/me/saved-events/${ev.id}`)).status, 200);
    assert.equal(await t.prisma.savedEvent.count({ where: { userId: alice.id } }), 1);
    await assert.rejects(t.prisma.savedEvent.create({ data: { userId: alice.id, eventId: ev.id } }), /Unique constraint/);
    const list = await alice.api.get("/me/saved-events");
    assert.equal(list.body.data[0].event.id, ev.id);
    assert.equal((await bob.api.get("/me/saved-events")).body.data.length, 0, "saved lists are private");
    assert.equal((await alice.api.delete(`/me/saved-events/${ev.id}`)).status, 204);
    assert.equal((await alice.api.get("/me/saved-events")).body.data.length, 0);
  });

  test("unpublished events cannot be saved", async () => {
    const draft = (await org.api.post("/organizer/events", t.eventBody())).body.data;
    assert.equal((await alice.api.put(`/me/saved-events/${draft.id}`)).status, 404);
  });

  test("following is unique; organizers cannot follow themselves", async () => {
    assert.equal((await alice.api.put(`/me/follows/${org.organizerId}`)).status, 201);
    assert.equal((await alice.api.put(`/me/follows/${org.organizerId}`)).status, 200);
    assert.equal(await t.prisma.organizerFollow.count({ where: { userId: alice.id } }), 1);
    assert.equal((await org.api.put(`/me/follows/${org.organizerId}`)).status, 400);
    const pub = await t.as(null).get(`/public/organizers/${ev.organizer.slug}`);
    assert.equal(pub.body.data.followers, 1);
    assert.equal((await alice.api.delete(`/me/follows/${org.organizerId}`)).status, 204);
  });

  test("reports: one open report per target, admin resolution is audited", async () => {
    const r = await alice.api.post("/me/reports", { targetType: "EVENT", targetId: ev.id, reason: "MISLEADING", details: "Venue does not exist" });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, "OPEN");
    assert.equal((await alice.api.post("/me/reports", { targetType: "EVENT", targetId: ev.id, reason: "SPAM" })).status, 409);
    assert.equal((await bob.api.post("/me/reports", { targetType: "USER", targetId: bob.id, reason: "SPAM" })).status, 400, "cannot report yourself");
    assert.equal((await bob.api.post("/me/reports", { targetType: "EVENT", targetId: "missing", reason: "SPAM" })).status, 404);

    // reporters see only their own reports
    assert.equal((await bob.api.get("/me/reports")).body.data.length, 0);

    const queue = await admin.api.get("/admin/reports");
    assert.ok(queue.body.data.some((x) => x.id === r.body.data.id));
    assert.equal((await admin.api.post(`/admin/reports/${r.body.data.id}/status`, { status: "ACTION_TAKEN" })).status, 400, "resolution required");
    const resolved = await admin.api.post(`/admin/reports/${r.body.data.id}/status`, { status: "ACTION_TAKEN", resolution: "Event suspended pending review" });
    assert.equal(resolved.body.data.status, "ACTION_TAKEN");
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: "report.action_taken", targetId: r.body.data.id, actorId: admin.id } }));
    // the reporter may file again once the first is closed
    assert.equal((await alice.api.post("/me/reports", { targetType: "EVENT", targetId: ev.id, reason: "SPAM" })).status, 201);
  });

  test("the database enforces exactly one report target", async () => {
    await assert.rejects(
      t.prisma.report.create({ data: { reporterId: alice.id, reason: "SPAM", eventId: ev.id, targetUserId: bob.id } }),
      /Report_exactly_one_target/,
    );
  });

  test("admin user management: suspension is audited and blocks actions", async () => {
    const res = await admin.api.post(`/admin/users/${bob.id}/suspend`, { reason: "Abusive reports" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "SUSPENDED");
    assert.equal((await bob.api.put(`/me/saved-events/${ev.id}`)).status, 403);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: "user.suspended", targetId: bob.id } }));
    assert.equal((await admin.api.post(`/admin/users/${admin.id}/suspend`, { reason: "oops" })).status, 403, "no self-suspension");
    await admin.api.post(`/admin/users/${bob.id}/reinstate`, { reason: "Appeal accepted" });
    assert.equal((await bob.api.put(`/me/saved-events/${ev.id}`)).status, 201);
  });

  test("audit log is readable by admins and filterable", async () => {
    const res = await admin.api.get(`/admin/audit-logs?targetType=user&targetId=${bob.id}`);
    assert.deepEqual(res.body.data.map((a) => a.action), ["user.reinstated", "user.suspended"]);
  });

  test("categories: admin-managed, public list shows active ones", async () => {
    const c = await admin.api.post("/admin/categories", { name: "Food & Drink" });
    assert.equal(c.status, 201);
    assert.equal(c.body.data.slug, "food-drink");
    assert.ok((await t.as(null).get("/public/categories")).body.data.some((x) => x.slug === "food-drink"));
    await admin.api.patch(`/admin/categories/${c.body.data.id}`, { isActive: false });
    assert.ok(!(await t.as(null).get("/public/categories")).body.data.some((x) => x.slug === "food-drink"));
    assert.equal((await alice.api.post("/admin/categories", { name: "Hacked" })).status, 404);
  });

  test("public search matches title OR location", async () => {
    const byTitle = await t.as(null).get("/public/events?q=tech");
    assert.ok(byTitle.body.data.some((e) => e.id === ev.id));
    const byCity = await t.as(null).get("/public/events?location=lagos");
    assert.ok(byCity.body.data.some((e) => e.id === ev.id));
    const none = await t.as(null).get("/public/events?location=nowhere-city");
    assert.equal(none.status, 200, "no results is 200 + empty list, not 404");
    assert.equal(none.body.data.length, 0);
    const free = await t.as(null).get("/public/events?price=free");
    assert.ok(free.body.data.every((e) => e.isFree));
  });
});
