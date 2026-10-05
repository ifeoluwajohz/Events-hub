// /admin: platform administration. requireAdmin is mounted ONCE for the whole router,
// so no admin route can be exposed by a forgotten guard. Non-admins get 404.
const express = require("express");
const { route, id, pagination, page, reason, z } = require("../http/route");
const { requireUser } = require("../auth/currentUser");
const { requireAdmin } = require("../policy");
const events = require("../services/events");
const organizers = require("../services/organizers");
const engagement = require("../services/engagement");
const admin = require("../services/admin");
const s = require("../serializers");

/** @param {import("../auth/identity").IdentityProvider} identity */
function adminRouter(identity) {
  const router = express.Router();
  router.use(requireUser(identity), requireAdmin);
  const byId = z.object({ id }).strict();
  const note = z.string().trim().max(2000).optional();

  // ── Verification review ──
  router.get(
    "/verification-submissions",
    route(
      { query: z.object({ status: z.enum(["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "REJECTED", "REVOKED", "WITHDRAWN"]).optional(), ...pagination }).strict() },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await organizers.listSubmissions(f), f.limit, (x) => x.id);
        res.json({ data: items.map(s.submissionSummaryForAdmin), nextCursor });
      },
    ),
  );

  router.get(
    "/verification-submissions/:id",
    route({ params: byId }, async (req, res) => {
      const { submission, history } = await organizers.getSubmissionForAdmin(req.user, req.valid.params.id, req);
      res.json({ data: { ...s.submissionDetailForAdmin(submission), previousSubmissions: history.map((h) => ({ ...h, submittedAt: s.iso(h.submittedAt) })) } });
    }),
  );

  router.get(
    "/verification-submissions/:id/evidence/:evidenceId",
    route({ params: z.object({ id, evidenceId: id }).strict() }, async (req, res) => {
      res.json({ data: await organizers.viewEvidence(req.user, req.valid.params.id, req.valid.params.evidenceId, req) });
    }),
  );

  router.post(
    "/verification-submissions/:id/decisions",
    route(
      { params: byId, body: z.object({ action: z.enum(["START_REVIEW", "APPROVE", "REQUEST_CHANGES", "REJECT", "REVOKE"]), reason: reason.optional(), internalNote: note }).strict() },
      async (req, res) => {
        const submission = await organizers.decideVerification(req.user, req.valid.params.id, req.valid.body, req);
        res.json({ data: s.submissionDetailForAdmin(submission) });
      },
    ),
  );

  // ── Organizers ──
  router.get(
    "/organizers",
    route(
      {
        query: z
          .object({
            status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
            verificationStatus: z.enum(["NOT_STARTED", "PENDING", "CHANGES_REQUESTED", "VERIFIED", "REJECTED"]).optional(),
            ...pagination,
          })
          .strict(),
      },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await organizers.listOrganizersForAdmin(f), f.limit, (o) => o.id);
        res.json({ data: items.map(s.organizerOwner), nextCursor });
      },
    ),
  );

  for (const [path, status] of /** @type {const} */ ([["suspend", "SUSPENDED"], ["reinstate", "ACTIVE"]])) {
    router.post(
      `/organizers/:id/${path}`,
      route({ params: byId, body: z.object({ reason }).strict() }, async (req, res) => {
        res.json({ data: s.organizerOwner(await organizers.setOrganizerStatus(req.user, req.valid.params.id, status, req.valid.body.reason, req)) });
      }),
    );
  }

  // ── Event moderation ──
  router.get(
    "/events",
    route(
      { query: z.object({ status: z.enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "CANCELLED", "SUSPENDED", "COMPLETED"]).optional(), ...pagination }).strict() },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await events.listEventsForAdmin(f), f.limit, (e) => e.id);
        res.json({ data: items.map((e) => ({ ...s.eventOwner(e), organizer: s.organizerOwner(e.organizer) })), nextCursor });
      },
    ),
  );

  router.get(
    "/events/:id",
    route({ params: byId }, async (req, res) => {
      const { event, history } = await events.getEventForAdmin(req.valid.params.id);
      res.json({ data: { ...s.eventOwner(event), organizer: s.organizerOwner(event.organizer), history: history.map(s.moderationForAdmin) } });
    }),
  );

  router.post(
    "/events/:id/moderation",
    route(
      { params: byId, body: z.object({ action: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SUSPEND", "REINSTATE", "CANCEL"]), reason: reason.optional(), internalNote: note }).strict() },
      async (req, res) => {
        const { event, history } = await events.moderateEvent(req.user, req.valid.params.id, req.valid.body, req);
        res.json({ data: { ...s.eventOwner(event), organizer: s.organizerOwner(event.organizer), history: history.map(s.moderationForAdmin) } });
      },
    ),
  );

  router.post(
    "/jobs/complete-events",
    route({}, async (req, res) => res.json({ data: await events.completeEndedEvents({ actor: req.user, req }) })),
  );

  // ── Users ──
  router.get(
    "/users",
    route(
      { query: z.object({ q: z.string().trim().max(100).optional(), status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(), role: z.enum(["USER", "ADMIN"]).optional(), ...pagination }).strict() },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await admin.listUsers(f), f.limit, (u) => u.id);
        res.json({ data: items.map(s.userForAdmin), nextCursor });
      },
    ),
  );

  router.get("/users/:id", route({ params: byId }, async (req, res) => res.json({ data: s.userForAdmin(await admin.getUser(req.valid.params.id)) })));

  for (const [path, status] of /** @type {const} */ ([["suspend", "SUSPENDED"], ["reinstate", "ACTIVE"]])) {
    router.post(
      `/users/:id/${path}`,
      route({ params: byId, body: z.object({ reason }).strict() }, async (req, res) => {
        res.json({ data: s.userForAdmin(await admin.setUserStatus(req.user, req.valid.params.id, status, req.valid.body.reason, req)) });
      }),
    );
  }

  router.post(
    "/users/:id/platform-role",
    route({ params: byId, body: z.object({ role: z.enum(["USER", "ADMIN"]), reason }).strict() }, async (req, res) => {
      res.json({ data: s.userForAdmin(await admin.setPlatformRole(req.user, req.valid.params.id, req.valid.body.role, req.valid.body.reason, req)) });
    }),
  );

  // ── Reports ──
  router.get(
    "/reports",
    route({ query: z.object({ status: z.enum(["OPEN", "UNDER_REVIEW", "ACTION_TAKEN", "DISMISSED"]).optional(), ...pagination }).strict() }, async (req, res) => {
      const f = req.valid.query;
      const { items, nextCursor } = page(await engagement.listReportsForAdmin(f), f.limit, (r) => r.id);
      res.json({ data: items.map(s.reportForAdmin), nextCursor });
    }),
  );

  router.post(
    "/reports/:id/status",
    route({ params: byId, body: z.object({ status: z.enum(["UNDER_REVIEW", "ACTION_TAKEN", "DISMISSED"]), resolution: reason.optional() }).strict() }, async (req, res) => {
      res.json({ data: s.reportForAdmin(await engagement.updateReportStatus(req.user, req.valid.params.id, req.valid.body, req)) });
    }),
  );

  // ── Categories ──
  router.get("/categories", route({}, async (req, res) => res.json({ data: await admin.listAllCategories() })));

  router.post(
    "/categories",
    route({ body: z.object({ name: z.string().trim().min(2).max(60), slug: z.string().regex(/^[a-z0-9-]{2,60}$/).optional(), sortOrder: z.number().int().min(0).max(1000).optional() }).strict() }, async (req, res) => {
      res.status(201).json({ data: await admin.createCategory(req.user, req.valid.body, req) });
    }),
  );

  router.patch(
    "/categories/:id",
    route(
      { params: byId, body: z.object({ name: z.string().trim().min(2).max(60).optional(), sortOrder: z.number().int().min(0).max(1000).optional(), isActive: z.boolean().optional() }).strict() },
      async (req, res) => res.json({ data: await admin.updateCategory(req.user, req.valid.params.id, req.valid.body, req) }),
    ),
  );

  // ── Audit log (read-only) ──
  router.get(
    "/audit-logs",
    route(
      {
        query: z
          .object({ targetType: z.string().max(64).optional(), targetId: z.string().max(64).optional(), actorId: z.string().max(64).optional(), action: z.string().max(100).optional(), ...pagination })
          .strict(),
      },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await admin.listAuditLogs(f), f.limit, (a) => a.id);
        res.json({ data: items.map(s.auditEntry), nextCursor });
      },
    ),
  );

  return router;
}

module.exports = { adminRouter };
