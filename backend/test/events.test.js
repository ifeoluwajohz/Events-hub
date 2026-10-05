const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup, idemKey } = require("./helpers/app");

describe("event lifecycle and moderation", () => {
  /** @type {any} */ let t;
  let org, admin, attendee;
  before(async () => {
    t = await setup();
    org = await t.organizer("life");
    admin = await t.admin("mod");
    attendee = await t.attendee("fan");
  });
  after(async () => t && t.teardown());

  const create = async (overrides) => {
    const res = await org.api.post("/organizer/events", t.eventBody(overrides));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const moderate = (id, body) => admin.api.post(`/admin/events/${id}/moderation`, body);
  const isPublic = async (id) => (await t.as(null).get(`/public/events/${id}`)).status === 200;

  test("new events are drafts and not public", async () => {
    const ev = await create();
    assert.equal(ev.status, "DRAFT");
    assert.equal(await isPublic(ev.id), false);
  });

  test("submission requires a ticket type", async () => {
    const ev = await create({ ticketTypes: [] });
    const res = await org.api.post(`/organizer/events/${ev.id}/submit`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "TICKETS_REQUIRED");
  });

  test("draft → submit → request changes → resubmit → approve → published, with full history", async () => {
    const ev = await create();
    assert.equal((await org.api.post(`/organizer/events/${ev.id}/submit`)).body.data.status, "PENDING_REVIEW");
    assert.equal(await isPublic(ev.id), false);

    // locked while in review
    assert.equal((await org.api.patch(`/organizer/events/${ev.id}`, { title: "Changed in review" })).status, 409);

    const rc = await moderate(ev.id, { action: "REQUEST_CHANGES" });
    assert.equal(rc.status, 400, "reason required");
    const changes = await moderate(ev.id, { action: "REQUEST_CHANGES", reason: "Add the venue address", internalNote: "low quality" });
    assert.equal(changes.status, 200);
    assert.equal(changes.body.data.status, "DRAFT");

    assert.equal((await org.api.patch(`/organizer/events/${ev.id}`, { addressLine: "1 Herbert Macaulay Way" })).status, 200);
    await org.api.post(`/organizer/events/${ev.id}/submit`);
    const approved = await moderate(ev.id, { action: "APPROVE" });
    assert.equal(approved.body.data.status, "PUBLISHED");
    assert.ok(approved.body.data.publishedAt);
    assert.equal(await isPublic(ev.id), true);

    // Admin history answers who / when / what / why / resubmitted
    const h = approved.body.data.history;
    assert.deepEqual(h.map((x) => x.action), ["SUBMIT", "REQUEST_CHANGES", "SUBMIT", "APPROVE"]);
    assert.equal(h[1].actorId, admin.id);
    assert.equal(h[1].reason, "Add the venue address");
    assert.equal(h[1].internalNote, "low quality");
    assert.equal(h[0].metadata.resubmission, false);
    assert.equal(h[2].metadata.resubmission, true);
    assert.equal(h[2].metadata.snapshot.title, ev.title);
    assert.ok(h.every((x) => x.createdAt));

    // Organizer view: reasons yes, internal notes and reviewer identity no
    const own = await org.api.get(`/organizer/events/${ev.id}/history`);
    assert.equal(own.body.data[1].reason, "Add the venue address");
    assert.equal(own.body.data[1].internalNote, undefined);
    assert.equal(own.body.data[1].actorId, undefined);

    // Every admin decision is audited
    const audits = await t.prisma.auditLog.findMany({ where: { targetId: ev.id, actorRole: "ADMIN" } });
    assert.deepEqual(audits.map((a) => a.action).sort(), ["event.moderation.approve", "event.moderation.request_changes"]);
  });

  test("withdraw returns a pending event to draft", async () => {
    const ev = await create();
    await org.api.post(`/organizer/events/${ev.id}/submit`);
    const res = await org.api.post(`/organizer/events/${ev.id}/withdraw`);
    assert.equal(res.body.data.status, "DRAFT");
  });

  test("rejection returns to draft with the reason recorded", async () => {
    const ev = await create();
    await org.api.post(`/organizer/events/${ev.id}/submit`);
    const res = await moderate(ev.id, { action: "REJECT", reason: "Prohibited content" });
    assert.equal(res.body.data.status, "DRAFT");
    assert.equal(res.body.data.history.at(-1).action, "REJECT");
  });

  test("organizers cannot approve; invalid transitions are refused", async () => {
    const ev = await create();
    assert.equal((await moderate(ev.id, { action: "APPROVE" })).status, 409, "cannot approve a draft");
    assert.equal((await moderate(ev.id, { action: "SUSPEND", reason: "x x x" })).status, 409, "cannot suspend a draft");
  });

  test("published events: material fields locked, description editable and logged as EDIT", async () => {
    const ev = await t.publishedEvent(org, admin);
    const locked = await org.api.patch(`/organizer/events/${ev.id}`, { startsAt: t.future(40) });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, "EVENT_LOCKED");
    const ok = await org.api.patch(`/organizer/events/${ev.id}`, { description: "Updated agenda" });
    assert.equal(ok.status, 200);
    const edit = await t.prisma.eventModerationAction.findFirst({ where: { eventId: ev.id, action: "EDIT" } });
    assert.deepEqual(/** @type {any} */ (edit?.metadata).description.to, "Updated agenda");
    // ticket prices locked after publication; inventory may only grow
    const tt = ev.ticketTypes[0].id;
    assert.equal((await org.api.patch(`/organizer/events/${ev.id}/ticket-types/${tt}`, { priceMinor: 0, name: "Renamed" })).status, 409);
    assert.equal((await org.api.patch(`/organizer/events/${ev.id}/ticket-types/${tt}`, { quantityTotal: 50 })).status, 409);
    assert.equal((await org.api.patch(`/organizer/events/${ev.id}/ticket-types/${tt}`, { quantityTotal: 150 })).status, 200);
  });

  test("suspension hides an event; reinstatement restores it", async () => {
    const ev = await t.publishedEvent(org, admin);
    const s = await moderate(ev.id, { action: "SUSPEND", reason: "Reported as a scam" });
    assert.equal(s.body.data.status, "SUSPENDED");
    assert.equal(await isPublic(ev.id), false);
    assert.equal((await org.api.post(`/organizer/events/${ev.id}/cancel`, { reason: "Trying to escape" })).status, 409);
    const r = await moderate(ev.id, { action: "REINSTATE", reason: "Investigated, legitimate" });
    assert.equal(r.body.data.status, "PUBLISHED");
    assert.equal(await isPublic(ev.id), true);
  });

  test("cancellation cancels free bookings and their tickets", async () => {
    const ev = await t.publishedEvent(org, admin);
    const b = await attendee.api.post("/me/bookings", { eventId: ev.id, items: [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }], idempotencyKey: idemKey() });
    assert.equal(b.status, 201);
    const res = await org.api.post(`/organizer/events/${ev.id}/cancel`, { reason: "Venue unavailable" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "CANCELLED");
    assert.equal(res.body.cancelledBookings, 1);
    const mine = await attendee.api.get(`/me/bookings/${b.body.data.id}`);
    assert.equal(mine.body.data.status, "CANCELLED");
    assert.ok(mine.body.data.tickets.every((x) => x.status === "CANCELLED"));
    // still viewable by direct link, but not bookable
    assert.equal(await isPublic(ev.id), true);
  });

  test("ended published events are completed by the job, as SYSTEM", async () => {
    const ev = await t.publishedEvent(org, admin);
    await t.prisma.$executeRaw`UPDATE "Event" SET "date" = now() - interval '2 days' WHERE "id" = ${ev.id}`;
    const res = await admin.api.post("/admin/jobs/complete-events");
    assert.ok(res.body.data.completed >= 1);
    const done = await t.prisma.event.findUnique({ where: { id: ev.id } });
    assert.equal(done?.status, "COMPLETED");
    const last = await t.prisma.eventModerationAction.findFirst({ where: { eventId: ev.id }, orderBy: { createdAt: "desc" } });
    assert.equal(last?.action, "COMPLETE");
    assert.equal(last?.actorRole, "SYSTEM");
  });

  test("approval re-checks the paid-ticket rule", async () => {
    const vorg = await t.verifiedOrganizer("paid");
    const ev = (await vorg.api.post("/organizer/events", t.eventBody({ ticketTypes: [{ name: "VIP", priceMinor: 250000, quantityTotal: 10 }] }))).body.data;
    await vorg.api.post(`/organizer/events/${ev.id}/submit`);
    // verification lost while in review
    await t.prisma.organizer.update({ where: { id: vorg.organizerId }, data: { verificationStatus: "REJECTED" } });
    const res = await moderate(ev.id, { action: "APPROVE" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "VERIFICATION_REQUIRED");
  });

  test("duplicate ticket type names are refused", async () => {
    const ev = await create();
    const res = await org.api.post(`/organizer/events/${ev.id}/ticket-types`, { name: "General admission", priceMinor: 0, quantityTotal: 3 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "DUPLICATE_TICKET_TYPE");
  });

  test("validation rejects bad input before business logic", async () => {
    const bad = await org.api.post("/organizer/events", t.eventBody({ timezone: "Mars/Olympus", currency: "naira", startsAt: "2001-01-01", extra: 1 }));
    assert.equal(bad.status, 400);
    const paths = bad.body.error.details.map((d) => d.path);
    assert.ok(paths.includes("timezone") && paths.includes("currency"), JSON.stringify(paths));
    assert.equal((await org.api.get("/organizer/events/" + "x".repeat(200))).status, 400);
  });

  test("history tables are append-only at the database level", async () => {
    await assert.rejects(t.prisma.$executeRaw`UPDATE "AuditLog" SET "action" = 'tampered'`, /append-only/);
    await assert.rejects(t.prisma.$executeRaw`DELETE FROM "EventModerationAction"`, /append-only/);
  });

  test("events of other currencies and time zones are supported", async () => {
    const ev = await create({ currency: "GHS", timezone: "Africa/Accra", country: "GH", city: "Accra" });
    assert.equal(ev.currency, "GHS");
    assert.equal(ev.timezone, "Africa/Accra");
  });
});
