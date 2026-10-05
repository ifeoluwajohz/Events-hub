// Table-driven check of the Phase 2A authorization matrix (docs/PHASE2_ARCHITECTURE.md §I).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup, idemKey } = require("./helpers/app");

describe("authorization matrix", () => {
  /** @type {any} */ let t;
  /** @type {Record<string, any>} */ const p = {};
  let publicEvent, draftOfA, bookingOfAttendee;

  before(async () => {
    t = await setup();
    p.anonymous = { api: t.as(null) };
    p.attendee = await t.attendee("att");
    p.organizer = await t.organizer("org");
    p.organizerB = await t.organizer("orgb");
    p.verified = await t.verifiedOrganizer("ver");
    p.admin = await t.admin("adm");
    p.admin2 = await t.admin("adm2");

    publicEvent = await t.publishedEvent(p.organizer, p.admin);
    draftOfA = (await p.organizer.api.post("/organizer/events", t.eventBody({ title: "Draft of A" }))).body.data;
    const b = await p.attendee.api.post("/me/bookings", {
      eventId: publicEvent.id, items: [{ ticketTypeId: publicEvent.ticketTypes[0].id, quantity: 1 }], idempotencyKey: idemKey(),
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    bookingOfAttendee = b.body.data;
  });
  after(async () => t && t.teardown());

  // [capability, persona, request, expected status]
  /** @type {Array<[string, string, (api: any) => any, number | number[]]>} */
  const matrix = [
    ["browse events", "anonymous", (a) => a.get("/public/events"), 200],
    ["browse events", "attendee", (a) => a.get("/public/events"), 200],
    ["view published event", "anonymous", (a) => a.get(`/public/events/${publicEvent.id}`), 200],
    ["view a draft publicly", "anonymous", (a) => a.get(`/public/events/${draftOfA.id}`), 404],

    ["save events", "anonymous", (a) => a.put(`/me/saved-events/${publicEvent.id}`), 401],
    ["save events", "attendee", (a) => a.put(`/me/saved-events/${publicEvent.id}`), 201],
    ["save events", "organizerB", (a) => a.put(`/me/saved-events/${publicEvent.id}`), 201],
    ["save events", "admin", (a) => a.put(`/me/saved-events/${publicEvent.id}`), 201],

    ["follow organizers", "attendee", (a) => a.put(`/me/follows/${p.organizer.organizerId}`), 201],
    ["follow organizers", "verified", (a) => a.put(`/me/follows/${p.organizer.organizerId}`), 201],

    ["create organizer profile", "attendee", (a) => a.post("/organizer", { displayName: "Attendee Turned Organizer" }), 201],
    ["create a second organizer profile", "organizer", (a) => a.post("/organizer", { displayName: "Second" }), 409],

    ["create event", "anonymous", (a) => a.post("/organizer/events", t.eventBody()), 401],
    ["create event without organizer profile", "admin2", (a) => a.post("/organizer/events", t.eventBody()), 403],
    ["create event", "organizer", (a) => a.post("/organizer/events", t.eventBody()), 201],
    ["create event", "verified", (a) => a.post("/organizer/events", t.eventBody()), 201],

    ["edit own event", "organizer", (a) => a.patch(`/organizer/events/${draftOfA.id}`, { summary: "Edited" }), 200],
    ["edit another organizer's event", "organizerB", (a) => a.patch(`/organizer/events/${draftOfA.id}`, { summary: "Hijack" }), 404],
    ["read another organizer's event", "organizerB", (a) => a.get(`/organizer/events/${draftOfA.id}`), 404],
    ["edit an organizer event as admin (admins change status, not content)", "admin", (a) => a.patch(`/organizer/events/${draftOfA.id}`, { summary: "Admin edit" }), [403, 404]],
    ["attendee modifies organizer resources", "attendee", (a) => a.patch(`/organizer/events/${draftOfA.id}`, { summary: "x" }), [403, 404]],

    ["create free ticket type", "organizer", (a) => a.post(`/organizer/events/${draftOfA.id}/ticket-types`, { name: "Free tier", priceMinor: 0, quantityTotal: 5 }), 201],
    ["create paid ticket type (unverified)", "organizer", (a) => a.post(`/organizer/events/${draftOfA.id}/ticket-types`, { name: "VIP", priceMinor: 500000, quantityTotal: 5 }), 403],
    ["create paid event (unverified)", "organizer", (a) => a.post("/organizer/events", t.eventBody({ ticketTypes: [{ name: "VIP", priceMinor: 100, quantityTotal: 5 }] })), 403],
    ["create paid event (verified)", "verified", (a) => a.post("/organizer/events", t.eventBody({ ticketTypes: [{ name: "VIP", priceMinor: 100, quantityTotal: 5 }] })), 201],

    ["publish directly (no such route)", "verified", (a) => a.post(`/organizer/events/${draftOfA.id}/publish`), 404],

    ["view own bookings", "attendee", (a) => a.get(`/me/bookings/${bookingOfAttendee.id}`), 200],
    ["view another user's booking", "organizerB", (a) => a.get(`/me/bookings/${bookingOfAttendee.id}`), 404],
    ["cancel another user's booking", "organizerB", (a) => a.post(`/me/bookings/${bookingOfAttendee.id}/cancel`), 404],
    ["view another user's ticket", "organizerB", (a) => a.get(`/me/tickets/${bookingOfAttendee.tickets[0].id}`), 404],

    ["moderate events", "attendee", (a) => a.post(`/admin/events/${draftOfA.id}/moderation`, { action: "APPROVE" }), 404],
    ["moderate events", "verified", (a) => a.post(`/admin/events/${draftOfA.id}/moderation`, { action: "APPROVE" }), 404],
    ["review organizers", "organizer", (a) => a.get("/admin/verification-submissions"), 404],
    ["review organizers", "admin", (a) => a.get("/admin/verification-submissions"), 200],
    ["manage users", "attendee", (a) => a.get("/admin/users"), 404],
    ["manage users", "admin", (a) => a.get("/admin/users"), 200],
    ["review reports", "verified", (a) => a.get("/admin/reports"), 404],
    ["review reports", "admin", (a) => a.get("/admin/reports"), 200],
    ["view audit logs", "organizer", (a) => a.get("/admin/audit-logs"), 404],
    ["view audit logs", "admin", (a) => a.get("/admin/audit-logs"), 200],
    ["admin routes anonymously", "anonymous", (a) => a.get("/admin/users"), 401],

    ["self-promote via /me", "attendee", (a) => a.patch("/me", { platformRole: "ADMIN" }), 400],
    ["self-promote via admin route", "attendee", (a) => a.post(`/admin/users/${p.attendee.id}/platform-role`, { role: "ADMIN", reason: "please" }), 404],
    ["admin changes own role", "admin", (a) => a.post(`/admin/users/${p.admin.id}/platform-role`, { role: "USER", reason: "test" }), 403],
    ["client-supplied userId in a booking", "attendee", (a) => a.post("/me/bookings", { userId: p.organizerB.id, eventId: publicEvent.id, items: [{ ticketTypeId: publicEvent.ticketTypes[0].id, quantity: 1 }], idempotencyKey: idemKey() }), 400],
    ["client-supplied price in a booking", "attendee", (a) => a.post("/me/bookings", { eventId: publicEvent.id, items: [{ ticketTypeId: publicEvent.ticketTypes[0].id, quantity: 1, priceMinor: 0 }], idempotencyKey: idemKey() }), 400],
  ];

  for (const [capability, persona, call, expected] of matrix) {
    test(`${capability} — ${persona} → ${expected}`, async () => {
      const res = await call(p[persona].api);
      const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
      assert.ok(ok, `got ${res.status}: ${JSON.stringify(res.body)}`);
    });
  }

  test("admins cannot moderate their own organizer's events (separation of duties)", async () => {
    const admOrg = await p.admin2.api.post("/organizer", { displayName: "Admin's Own Events" });
    assert.equal(admOrg.status, 201);
    const ev = await p.admin2.api.post("/organizer/events", t.eventBody());
    await p.admin2.api.post(`/organizer/events/${ev.body.data.id}/submit`);
    const res = await p.admin2.api.post(`/admin/events/${ev.body.data.id}/moderation`, { action: "APPROVE" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CONFLICT_OF_INTEREST");
    // a different admin can
    assert.equal((await p.admin.api.post(`/admin/events/${ev.body.data.id}/moderation`, { action: "APPROVE" })).status, 200);
  });

  test("admin grants admin, audited; the last admin cannot be removed", async () => {
    const res = await p.admin.api.post(`/admin/users/${p.attendee.id}/platform-role`, { role: "ADMIN", reason: "Ops hire" });
    assert.equal(res.status, 200);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: "user.platform_admin.granted", targetId: p.attendee.id, actorId: p.admin.id } }));
    // demote everyone but one, then the last cannot be demoted
    await p.admin.api.post(`/admin/users/${p.attendee.id}/platform-role`, { role: "USER", reason: "Revert" });
    await p.admin.api.post(`/admin/users/${p.admin2.id}/platform-role`, { role: "USER", reason: "Revert" });
    const last = await p.admin2.api.get("/admin/users");
    assert.equal(last.status, 404, "admin2 lost admin access");
    const third = await t.admin("adm3");
    await third.api.post(`/admin/users/${p.admin.id}/platform-role`, { role: "USER", reason: "Rotate" });
    const lastOne = await p.admin.api.post(`/admin/users/${third.id}/platform-role`, { role: "USER", reason: "Try" });
    assert.equal(lastOne.status, 404, "admin was demoted, so the route is gone for them");
    const self = await third.api.post(`/admin/users/${third.id}/platform-role`, { role: "USER", reason: "Try" });
    assert.equal(self.status, 403);
  });

  test("a suspended organizer cannot create or submit events", async () => {
    const org = await t.organizer("susp");
    const ev = (await org.api.post("/organizer/events", t.eventBody())).body.data;
    await t.prisma.organizer.update({ where: { id: org.organizerId }, data: { status: "SUSPENDED" } });
    const create = await org.api.post("/organizer/events", t.eventBody());
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, "ORGANIZER_SUSPENDED");
    assert.equal((await org.api.post(`/organizer/events/${ev.id}/submit`)).status, 403);
  });
});
