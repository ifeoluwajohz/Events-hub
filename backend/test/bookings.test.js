const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup, idemKey } = require("./helpers/app");

describe("free-ticket booking", () => {
  /** @type {any} */ let t;
  let org, admin, alice, bob;
  before(async () => {
    t = await setup();
    org = await t.organizer("host");
    admin = await t.admin("adm");
    alice = await t.attendee("alice");
    bob = await t.attendee("bob");
  });
  after(async () => t && t.teardown());

  const book = (who, ev, quantity = 1, key = idemKey(), ticketTypeId = ev.ticketTypes[0].id) =>
    who.api.post("/me/bookings", { eventId: ev.id, items: [{ ticketTypeId, quantity }], idempotencyKey: key });

  test("authenticated booking issues one unguessable ticket per seat at the database price", async () => {
    const ev = await t.publishedEvent(org, admin);
    const res = await book(alice, ev, 3);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const b = res.body.data;
    assert.equal(b.status, "CONFIRMED");
    assert.equal(b.totalMinor, 0);
    assert.equal(b.currency, "NGN");
    assert.equal(b.tickets.length, 3);
    const codes = b.tickets.map((x) => x.code);
    assert.equal(new Set(codes).size, 3);
    assert.ok(codes.every((c) => c.length >= 26 && !c.includes(b.id)), "random codes, not ids");
    const tt = await t.prisma.ticketType.findUnique({ where: { id: ev.ticketTypes[0].id } });
    assert.equal(tt?.quantitySold, 3);
    // the booking belongs to the session user
    const row = await t.prisma.booking.findUnique({ where: { id: b.id } });
    assert.equal(row?.userId, alice.id);
  });

  test("anonymous users cannot book", async () => {
    const ev = await t.publishedEvent(org, admin);
    const res = await t.as(null).post("/me/bookings", { eventId: ev.id, items: [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }], idempotencyKey: idemKey() });
    assert.equal(res.status, 401);
  });

  test("capacity cannot be exceeded", async () => {
    const ev = await t.publishedEvent(org, admin, { ticketTypes: [{ name: "Tiny", priceMinor: 0, quantityTotal: 2 }] });
    assert.equal((await book(alice, ev, 2)).status, 201);
    const res = await book(bob, ev, 1);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "SOLD_OUT");
    const pub = await t.as(null).get(`/public/events/${ev.id}`);
    assert.equal(pub.body.data.soldOut, true, "sold-out is derived");
    assert.equal(pub.body.data.ticketTypes[0].remaining, 0);
  });

  test("concurrent bookings never oversell", async () => {
    const ev = await t.publishedEvent(org, admin, { ticketTypes: [{ name: "Hot", priceMinor: 0, quantityTotal: 10 }] });
    const buyers = await Promise.all(Array.from({ length: 30 }, (_, i) => t.attendee(`rush${i}`)));
    const results = await Promise.all(buyers.map((b) => book(b, ev, 1)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 10, JSON.stringify(statuses));
    assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409));
    const tt = await t.prisma.ticketType.findUnique({ where: { id: ev.ticketTypes[0].id } });
    assert.equal(tt?.quantitySold, 10);
    assert.equal(await t.prisma.ticket.count({ where: { eventId: ev.id } }), 10);
  });

  test("retrying with the same idempotency key returns the original booking", async () => {
    const ev = await t.publishedEvent(org, admin);
    const key = idemKey();
    const [a, b] = await Promise.all([book(bob, ev, 1, key), book(bob, ev, 1, key)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(a.body.data.id, b.body.data.id);
    assert.equal(await t.prisma.booking.count({ where: { userId: bob.id, eventId: ev.id } }), 1);
    const other = await t.publishedEvent(org, admin);
    const reused = await book(bob, other, 1, key);
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  test("paid tickets are not sold until Phase 4", async () => {
    const vorg = await t.verifiedOrganizer("seller");
    const ev = await t.publishedEvent(vorg, admin, { ticketTypes: [{ name: "VIP", priceMinor: 500000, quantityTotal: 5 }] });
    const res = await book(alice, ev, 1);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "PAID_CHECKOUT_UNAVAILABLE");
  });

  test("only published, upcoming events can be booked", async () => {
    const draft = (await org.api.post("/organizer/events", t.eventBody())).body.data;
    assert.equal((await book(alice, draft, 1)).status, 404, "drafts are invisible");
    const ev = await t.publishedEvent(org, admin);
    await org.api.post(`/organizer/events/${ev.id}/cancel`, { reason: "Called off" });
    const cancelled = await book(alice, ev, 1);
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.error.code, "EVENT_NOT_BOOKABLE");
  });

  test("invalid ticket types and quantities are rejected", async () => {
    const ev = await t.publishedEvent(org, admin);
    const otherEv = await t.publishedEvent(org, admin);
    assert.equal((await book(alice, ev, 1, idemKey(), otherEv.ticketTypes[0].id)).status, 404, "ticket type of another event");
    assert.equal((await book(alice, ev, 11)).status, 400, "above maxPerOrder");
    const dup = await alice.api.post("/me/bookings", {
      eventId: ev.id, items: [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }, { ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }], idempotencyKey: idemKey(),
    });
    assert.equal(dup.status, 400);
  });

  test("organizers cannot book their own events", async () => {
    const ev = await t.publishedEvent(org, admin);
    assert.equal((await book(org, ev, 1)).status, 403);
  });

  test("cancelling returns inventory; other users cannot touch the booking", async () => {
    const ev = await t.publishedEvent(org, admin);
    const b = (await book(alice, ev, 2)).body.data;
    assert.equal((await bob.api.post(`/me/bookings/${b.id}/cancel`)).status, 404);
    const res = await alice.api.post(`/me/bookings/${b.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "CANCELLED");
    assert.ok(res.body.data.tickets.every((x) => x.status === "CANCELLED"));
    const tt = await t.prisma.ticketType.findUnique({ where: { id: ev.ticketTypes[0].id } });
    assert.equal(tt?.quantitySold, 0);
    assert.equal((await alice.api.post(`/me/bookings/${b.id}/cancel`)).status, 409, "already cancelled");
  });

  test("tickets: holder sees QR code; organizer checks in once; attendee list has no emails", async () => {
    const ev = await t.publishedEvent(org, admin);
    const b = (await book(bob, ev, 1)).body.data;
    const ticket = (await bob.api.get(`/me/tickets/${b.tickets[0].id}`)).body.data;
    assert.equal(ticket.code, b.tickets[0].code);
    const first = await org.api.post(`/organizer/events/${ev.id}/check-in`, { code: ticket.code });
    assert.equal(first.status, 200);
    assert.ok(first.body.data.checkedInAt);
    const again = await org.api.post(`/organizer/events/${ev.id}/check-in`, { code: ticket.code });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "ALREADY_CHECKED_IN");
    const otherOrg = await t.organizer("rival");
    assert.equal((await otherOrg.api.post(`/organizer/events/${ev.id}/check-in`, { code: ticket.code })).status, 404);
    const list = await org.api.get(`/organizer/events/${ev.id}/attendees`);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes("@example.test"), "no attendee emails");
  });
});
