// /organizer: the caller's own organizer profile, verification and events.
// Every event route is owner-scoped in the service layer (others' events are 404).
const express = require("express");
const { route, id, pagination, page, reason, z } = require("../http/route");
const { requireUser } = require("../auth/currentUser");
const { rateLimits } = require("../http/security");
const schemas = require("../http/schemas");
const events = require("../services/events");
const organizers = require("../services/organizers");
const storage = require("../storage");
const { requirementsFor } = require("../verification/requirements");
const { notFound } = require("../http/errors");
const s = require("../serializers");

/** @param {import("../auth/identity").IdentityProvider} identity */
function organizerRouter(identity) {
  const router = express.Router();
  router.use(requireUser(identity));
  const eventParams = z.object({ id }).strict();

  // ── Profile ──
  router.post(
    "/",
    route({ body: schemas.organizerCreate }, async (req, res) => {
      res.status(201).json({ data: s.organizerOwner(await organizers.createOrganizer(req.user, req.valid.body, req)) });
    }),
  );

  router.get(
    "/",
    route({}, async (req, res) => {
      if (!req.user.organizer) throw notFound("Organizer profile");
      res.json({ data: s.organizerOwner(req.user.organizer) });
    }),
  );

  router.patch(
    "/",
    route({ body: schemas.organizerUpdate }, async (req, res) => {
      res.json({ data: s.organizerOwner(await organizers.updateOrganizer(req.user, req.valid.body)) });
    }),
  );

  // ── Uploads (provider-neutral boundary; no provider configured yet) ──
  router.post(
    "/uploads",
    route({ body: z.object({ purpose: z.enum(["EVENT_IMAGE", "ORGANIZER_LOGO", "VERIFICATION_EVIDENCE"]), mimeType: z.string().max(100), sizeBytes: z.number().int().positive() }).strict() }, async () => {
      await storage.createUploadIntent();
    }),
  );

  // ── Verification ──
  router.get(
    "/verification/requirements",
    route(
      { query: z.object({ country: schemas.countryCode, type: z.enum(["INDIVIDUAL", "BUSINESS", "NON_PROFIT"]) }).strict() },
      async (req, res) => {
        const set = requirementsFor(req.valid.query.country, req.valid.query.type);
        res.json({ data: set });
      },
    ),
  );

  router.get(
    "/verification",
    route({}, async (req, res) => {
      const { organizer, submissions } = await organizers.getOwnVerification(req.user);
      res.json({ data: { status: s.organizerOwner(organizer).verificationStatus, submissions: submissions.map(s.submissionForOrganizer) } });
    }),
  );

  router.post(
    "/verification/submissions",
    rateLimits.verification(),
    route({ body: schemas.verificationSubmission }, async (req, res) => {
      res.status(201).json({ data: s.submissionForOrganizer(await organizers.submitVerification(req.user, req.valid.body, req)) });
    }),
  );

  router.post(
    "/verification/submissions/:id/withdraw",
    route({ params: eventParams }, async (req, res) => {
      res.json({ data: s.submissionForOrganizer(await organizers.withdrawVerification(req.user, req.valid.params.id, req)) });
    }),
  );

  // ── Events ──
  router.get(
    "/events",
    route(
      { query: z.object({ status: z.enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "CANCELLED", "SUSPENDED", "COMPLETED"]).optional(), ...pagination }).strict() },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await events.listOwnEvents(req.user, f), f.limit, (e) => e.id);
        res.json({ data: items.map(s.eventOwner), nextCursor });
      },
    ),
  );

  router.post(
    "/events",
    route({ body: schemas.eventCreate }, async (req, res) => {
      res.status(201).json({ data: s.eventOwner(await events.createEvent(req.user, req.valid.body, req)) });
    }),
  );

  router.get(
    "/events/:id",
    route({ params: eventParams }, async (req, res) => {
      res.json({ data: s.eventOwner(await events.loadOwnEvent(req.user, req.valid.params.id)) });
    }),
  );

  router.patch(
    "/events/:id",
    route({ params: eventParams, body: schemas.eventUpdate }, async (req, res) => {
      res.json({ data: s.eventOwner(await events.updateEvent(req.user, req.valid.params.id, req.valid.body, req)) });
    }),
  );

  router.post(
    "/events/:id/submit",
    route({ params: eventParams }, async (req, res) => {
      res.json({ data: s.eventOwner(await events.submitEvent(req.user, req.valid.params.id, req)) });
    }),
  );

  router.post(
    "/events/:id/withdraw",
    route({ params: eventParams }, async (req, res) => {
      res.json({ data: s.eventOwner(await events.withdrawEvent(req.user, req.valid.params.id)) });
    }),
  );

  router.post(
    "/events/:id/cancel",
    route({ params: eventParams, body: z.object({ reason }).strict() }, async (req, res) => {
      const { event, ...effect } = await events.cancelOwnEvent(req.user, req.valid.params.id, req.valid.body.reason, req);
      res.json({ data: s.eventOwner(event), ...effect });
    }),
  );

  router.get(
    "/events/:id/history",
    route({ params: eventParams }, async (req, res) => {
      res.json({ data: (await events.ownEventHistory(req.user, req.valid.params.id)).map(s.moderationForOrganizer) });
    }),
  );

  // ── Ticket types ──
  router.post(
    "/events/:id/ticket-types",
    route({ params: eventParams, body: schemas.ticketTypeCreate }, async (req, res) => {
      res.status(201).json({ data: s.ticketTypeOwner(await events.createTicketType(req.user, req.valid.params.id, req.valid.body)) });
    }),
  );

  router.patch(
    "/events/:id/ticket-types/:ticketTypeId",
    route({ params: z.object({ id, ticketTypeId: id }).strict(), body: schemas.ticketTypeUpdate }, async (req, res) => {
      const { id: eventId, ticketTypeId } = req.valid.params;
      res.json({ data: s.ticketTypeOwner(await events.updateTicketType(req.user, eventId, ticketTypeId, req.valid.body)) });
    }),
  );

  // ── Media (public https image URLs until a storage provider exists) ──
  router.post(
    "/events/:id/media",
    route({ params: eventParams, body: z.object({ url: schemas.httpsUrl, role: z.enum(["COVER", "GALLERY"]) }).strict() }, async (req, res) => {
      res.status(201).json({ data: s.eventOwner(await events.addEventMedia(req.user, req.valid.params.id, req.valid.body)) });
    }),
  );

  router.delete(
    "/events/:id/media/:assetId",
    route({ params: z.object({ id, assetId: id }).strict() }, async (req, res) => {
      res.json({ data: s.eventOwner(await events.removeEventMedia(req.user, req.valid.params.id, req.valid.params.assetId)) });
    }),
  );

  // ── Attendees & check-in ──
  router.get(
    "/events/:id/attendees",
    route({ params: eventParams, query: z.object(pagination).strict() }, async (req, res) => {
      const f = req.valid.query;
      const { items, nextCursor } = page(await events.listAttendees(req.user, req.valid.params.id, f), f.limit, (t) => t.id);
      res.json({ data: items.map(s.attendeeForOrganizer), nextCursor });
    }),
  );

  router.post(
    "/events/:id/check-in",
    route({ params: eventParams, body: z.object({ code: z.string().trim().min(10).max(100) }).strict() }, async (req, res) => {
      res.json({ data: s.attendeeForOrganizer(await events.checkInTicket(req.user, req.valid.params.id, req.valid.body.code)) });
    }),
  );

  return router;
}

module.exports = { organizerRouter };
