// /public: anonymous, read-only, published data only.
const express = require("express");
const { route, pagination, page, z } = require("../http/route");
const events = require("../services/events");
const organizers = require("../services/organizers");
const admin = require("../services/admin");
const s = require("../serializers");

function publicRouter() {
  const router = express.Router();

  router.get(
    "/events",
    route(
      {
        query: z
          .object({
            q: z.string().trim().max(100).optional(),
            location: z.string().trim().max(100).optional(),
            category: z.string().trim().max(64).optional(),
            from: z.coerce.date().optional(),
            to: z.coerce.date().optional(),
            price: z.enum(["free", "paid"]).optional(),
            ...pagination,
          })
          .strict(),
      },
      async (req, res) => {
        const f = req.valid.query;
        const { items, nextCursor } = page(await events.listPublicEvents(f), f.limit, (e) => e.id);
        res.json({ data: items.map(s.eventPublic), nextCursor });
      },
    ),
  );

  router.get(
    "/events/:idOrSlug",
    route({ params: z.object({ idOrSlug: z.string().min(1).max(120) }) }, async (req, res) => {
      res.json({ data: s.eventPublic(await events.getPublicEvent(req.valid.params.idOrSlug)) });
    }),
  );

  router.get(
    "/organizers/:slug",
    route({ params: z.object({ slug: z.string().min(1).max(120) }) }, async (req, res) => {
      const { org, followers, upcomingEvents } = await organizers.getPublicOrganizer(req.valid.params.slug);
      res.json({ data: { ...s.organizerPublic(org), followers, upcomingEvents: upcomingEvents.map(s.eventPublic) } });
    }),
  );

  router.get(
    "/categories",
    route({}, async (req, res) => {
      const categories = await admin.listActiveCategories();
      res.json({ data: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug })) });
    }),
  );

  return router;
}

module.exports = { publicRouter };
