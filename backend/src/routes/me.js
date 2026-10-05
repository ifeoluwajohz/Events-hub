// /me: the signed-in user's own data. Identity always comes from the session.
const express = require("express");
const { route, id, pagination, page, z } = require("../http/route");
const { requireUser } = require("../auth/currentUser");
const { requireActiveUser } = require("../policy");
const { rateLimits } = require("../http/security");
const schemas = require("../http/schemas");
const { getPrisma } = require("../db");
const bookings = require("../services/bookings");
const engagement = require("../services/engagement");
const s = require("../serializers");

/** @param {import("../auth/identity").IdentityProvider} identity */
function meRouter(identity) {
  const router = express.Router();
  // Suspended users may still read their own profile, bookings and tickets.
  router.use(requireUser(identity, { allowSuspended: true }));
  const active = requireActiveUser;
  const ticketId = z.object({ id: z.string().uuid() }).strict();

  router.get("/", route({}, async (req, res) => res.json({ data: s.me(req.user) })));

  router.patch(
    "/",
    active,
    route({ body: schemas.meUpdate }, async (req, res) => {
      const user = await getPrisma().user.update({ where: { id: req.user.id }, data: req.valid.body, include: { organizer: true } });
      res.json({ data: s.me(user) });
    }),
  );

  // ── Bookings & tickets ──
  router.get(
    "/bookings",
    route({ query: z.object(pagination).strict() }, async (req, res) => {
      const f = req.valid.query;
      const { items, nextCursor } = page(await bookings.listOwnBookings(req.user, f), f.limit, (b) => b.id);
      res.json({ data: items.map(s.bookingForOwner), nextCursor });
    }),
  );

  router.post(
    "/bookings",
    active,
    rateLimits.booking(),
    route({ body: schemas.bookingCreate }, async (req, res) => {
      const { booking, replayed } = await bookings.createFreeBooking(req.user, req.valid.body);
      res.status(replayed ? 200 : 201).json({ data: s.bookingForOwner(booking), replayed });
    }),
  );

  router.get(
    "/bookings/:id",
    route({ params: z.object({ id }).strict() }, async (req, res) => {
      res.json({ data: s.bookingForOwner(await bookings.getOwnBooking(req.user, req.valid.params.id)) });
    }),
  );

  router.post(
    "/bookings/:id/cancel",
    active,
    route({ params: z.object({ id }).strict() }, async (req, res) => {
      res.json({ data: s.bookingForOwner(await bookings.cancelOwnBooking(req.user, req.valid.params.id)) });
    }),
  );

  router.get(
    "/tickets",
    route({ query: z.object(pagination).strict() }, async (req, res) => {
      const f = req.valid.query;
      const { items, nextCursor } = page(await bookings.listOwnTickets(req.user, f), f.limit, (t) => t.id);
      res.json({ data: items.map(s.ticketForHolder), nextCursor });
    }),
  );

  router.get(
    "/tickets/:id",
    route({ params: ticketId }, async (req, res) => {
      res.json({ data: s.ticketForHolder(await bookings.getOwnTicket(req.user, req.valid.params.id)) });
    }),
  );

  // ── Saved events ──
  router.get(
    "/saved-events",
    route({ query: z.object(pagination).strict() }, async (req, res) => {
      const f = req.valid.query;
      const { items, nextCursor } = page(await engagement.listSavedEvents(req.user, f), f.limit, (r) => r.eventId);
      res.json({ data: items.map((r) => ({ savedAt: s.iso(r.createdAt), event: s.eventPublic(r.event) })), nextCursor });
    }),
  );

  router.put(
    "/saved-events/:eventId",
    active,
    route({ params: z.object({ eventId: id }).strict() }, async (req, res) => {
      const { created } = await engagement.saveEvent(req.user, req.valid.params.eventId);
      res.status(created ? 201 : 200).json({ data: { eventId: req.valid.params.eventId, saved: true } });
    }),
  );

  router.delete(
    "/saved-events/:eventId",
    active,
    route({ params: z.object({ eventId: id }).strict() }, async (req, res) => {
      await engagement.unsaveEvent(req.user, req.valid.params.eventId);
      res.status(204).end();
    }),
  );

  // ── Follows ──
  router.get(
    "/follows",
    route({}, async (req, res) => {
      const rows = await engagement.listFollows(req.user);
      res.json({ data: rows.map((r) => ({ followedAt: s.iso(r.createdAt), organizer: s.organizerPublic(r.organizer) })) });
    }),
  );

  router.put(
    "/follows/:organizerId",
    active,
    route({ params: z.object({ organizerId: id }).strict() }, async (req, res) => {
      const { created } = await engagement.followOrganizer(req.user, req.valid.params.organizerId);
      res.status(created ? 201 : 200).json({ data: { organizerId: req.valid.params.organizerId, following: true } });
    }),
  );

  router.delete(
    "/follows/:organizerId",
    active,
    route({ params: z.object({ organizerId: id }).strict() }, async (req, res) => {
      await engagement.unfollowOrganizer(req.user, req.valid.params.organizerId);
      res.status(204).end();
    }),
  );

  // ── Reports ──
  router.get("/reports", route({}, async (req, res) => res.json({ data: (await engagement.listOwnReports(req.user)).map(s.reportForReporter) })));

  router.post(
    "/reports",
    active,
    rateLimits.reports(),
    route({ body: schemas.reportCreate }, async (req, res) => {
      res.status(201).json({ data: s.reportForReporter(await engagement.createReport(req.user, req.valid.body, req)) });
    }),
  );

  return router;
}

module.exports = { meRouter };
