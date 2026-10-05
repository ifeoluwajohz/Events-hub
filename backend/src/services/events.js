const { Prisma } = require("@prisma/client");
const { getPrisma } = require("../db");
const { notFound, conflict, badRequest } = require("../http/errors");
const policy = require("../policy");
const { recordAudit } = require("./audit");
const { uniqueSlug } = require("../lib/slug");

const eventInclude = {
  organizer: true,
  ticketTypes: true,
  media: { include: { asset: true } },
  categories: { include: { category: true } },
};

const isUniqueViolation = (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// ───────────────────────── Public ─────────────────────────

/**
 * Upcoming, published events of active organizers.
 * @param {{ q?: string, location?: string, category?: string, from?: Date, to?: Date, price?: "free"|"paid", cursor?: string, limit: number }} f
 */
async function listPublicEvents(f) {
  const now = new Date();
  /** @type {Prisma.EventWhereInput[]} */
  const and = [
    { status: "PUBLISHED", organizer: { status: "ACTIVE" } },
    { OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }] },
  ];
  if (f.q) {
    and.push({
      OR: [
        { title: { contains: f.q, mode: "insensitive" } },
        { summary: { contains: f.q, mode: "insensitive" } },
        { description: { contains: f.q, mode: "insensitive" } },
      ],
    });
  }
  if (f.location) {
    // OR across location fields (the legacy search required BOTH title and venue to match).
    and.push({
      OR: [
        { city: { contains: f.location, mode: "insensitive" } },
        { venueName: { contains: f.location, mode: "insensitive" } },
        { addressLine: { contains: f.location, mode: "insensitive" } },
        { region: { contains: f.location, mode: "insensitive" } },
      ],
    });
  }
  if (f.category) and.push({ categories: { some: { category: { slug: f.category, isActive: true } } } });
  if (f.from) and.push({ startsAt: { gte: f.from } });
  if (f.to) and.push({ startsAt: { lte: f.to } });
  if (f.price === "free") {
    and.push({ ticketTypes: { some: { status: "ACTIVE" }, every: { OR: [{ status: { not: "ACTIVE" } }, { priceMinor: 0 }] } } });
  } else if (f.price === "paid") {
    and.push({ ticketTypes: { some: { status: "ACTIVE", priceMinor: { gt: 0 } } } });
  }

  return getPrisma().event.findMany({
    where: { AND: and },
    include: eventInclude,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** @param {string} idOrSlug */
async function getPublicEvent(idOrSlug) {
  const event = await getPrisma().event.findFirst({
    where: {
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      status: { in: policy.PUBLIC_EVENT_STATUSES },
      organizer: { status: "ACTIVE" },
    },
    include: eventInclude,
  });
  if (!event) throw notFound("Event");
  return event;
}

// ───────────────────────── Organizer: own events ─────────────────────────

/**
 * Owner-scoped load. Another organizer's event is indistinguishable from a missing one.
 * @param {import("../auth/currentUser").CurrentUser} user
 * @param {string} eventId
 * @param {Prisma.TransactionClient} [tx]
 */
async function loadOwnEvent(user, eventId, tx = getPrisma()) {
  if (!user.organizer) throw notFound("Event");
  const event = await tx.event.findFirst({ where: { id: eventId, organizerId: user.organizer.id }, include: eventInclude });
  if (!event) throw notFound("Event");
  return event;
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {{ status?: import("@prisma/client").EventStatus, cursor?: string, limit: number }} f */
async function listOwnEvents(user, f) {
  if (!user.organizer) return [];
  return getPrisma().event.findMany({
    where: { organizerId: user.organizer.id, ...(f.status ? { status: f.status } : {}) },
    include: eventInclude,
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** @param {Prisma.TransactionClient} tx @param {string[] | undefined} categoryIds */
async function assertCategories(tx, categoryIds) {
  if (!categoryIds || categoryIds.length === 0) return;
  const found = await tx.category.count({ where: { id: { in: categoryIds }, isActive: true } });
  if (found !== new Set(categoryIds).size) throw badRequest("INVALID_CATEGORY", "One or more categories do not exist");
}

/** Location/online consistency for anything that will be reviewed or shown. @param {any} e */
function assertLocationComplete(e) {
  if (["IN_PERSON", "HYBRID"].includes(e.attendanceMode) && !(e.venueName || e.addressLine)) {
    throw badRequest("VENUE_REQUIRED", "In-person events need a venue or address");
  }
  if (["ONLINE", "HYBRID"].includes(e.attendanceMode) && !e.onlineUrl) {
    throw badRequest("ONLINE_URL_REQUIRED", "Online events need a link for ticket holders");
  }
}

/**
 * @param {import("../auth/currentUser").CurrentUser} user
 * @param {any} input validated create body
 * @param {any} req
 */
async function createEvent(user, input, req) {
  const org = policy.requireActiveOrganizer(user);
  const { categoryIds, ticketTypes = [], ...fields } = input;
  for (const tt of ticketTypes) policy.assertCanSetPrice(org, tt.priceMinor);

  return getPrisma().$transaction(async (tx) => {
    await assertCategories(tx, categoryIds);
    const event = await tx.event.create({
      data: {
        ...fields,
        organizerId: org.id,
        slug: uniqueSlug(fields.title, "event"),
        status: "DRAFT",
        categories: categoryIds ? { create: [...new Set(categoryIds)].map((categoryId) => ({ categoryId })) } : undefined,
        ticketTypes: { create: ticketTypes.map((tt, i) => ({ ...tt, sortOrder: tt.sortOrder ?? i })) },
      },
      include: eventInclude,
    });
    await recordAudit(tx, { actor: user, actorRole: "ORGANIZER", action: "event.created", targetType: "event", targetId: event.id, req });
    return event;
  }).catch((err) => {
    if (isUniqueViolation(err)) throw conflict("DUPLICATE_TICKET_TYPE", "Ticket type names must be unique per event");
    throw err;
  });
}

/**
 * @param {import("../auth/currentUser").CurrentUser} user
 * @param {string} eventId
 * @param {any} changes validated partial body
 * @param {any} req
 */
async function updateEvent(user, eventId, changes, req) {
  policy.requireActiveOrganizer(user);
  const fields = Object.keys(changes);
  if (fields.length === 0) throw badRequest("NO_CHANGES", "Nothing to update");

  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    policy.assertEventEditable(event.status, fields);
    const { categoryIds, ...data } = changes;
    const merged = { ...event, ...data };
    if (merged.endsAt && merged.endsAt <= merged.startsAt) throw badRequest("INVALID_DATES", "endsAt must be after startsAt");
    if (event.status === "PUBLISHED") assertLocationComplete(merged);
    await assertCategories(tx, categoryIds);

    const { count } = await tx.event.updateMany({ where: { id: event.id, status: event.status }, data });
    if (count !== 1) throw conflict("STALE_STATE", "The event changed; reload and try again");
    if (categoryIds) {
      await tx.eventCategory.deleteMany({ where: { eventId: event.id } });
      await tx.eventCategory.createMany({ data: [...new Set(categoryIds)].map((categoryId) => ({ eventId: event.id, categoryId })) });
    }
    if (event.status === "PUBLISHED") {
      // "What changed?" for published events, kept in the moderation history.
      /** @type {Record<string, { from: unknown, to: unknown }>} */
      const diff = {};
      for (const f of fields) diff[f] = { from: f === "categoryIds" ? event.categories.map((c) => c.categoryId) : /** @type {any} */ (event)[f], to: changes[f] };
      await tx.eventModerationAction.create({
        data: { eventId: event.id, actorId: user.id, actorRole: "ORGANIZER", action: "EDIT", fromStatus: "PUBLISHED", toStatus: "PUBLISHED", metadata: /** @type {any} */ (diff) },
      });
      await recordAudit(tx, { actor: user, actorRole: "ORGANIZER", action: "event.published_edit", targetType: "event", targetId: event.id, metadata: { fields }, req });
    }
    return tx.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude });
  });
}

/**
 * The single place event status changes. Conditional on the current status
 * (optimistic concurrency) and always writes a moderation history row.
 * @param {Prisma.TransactionClient} tx
 * @param {{ event: any, action: policy.EventAction, actorRole: "ORGANIZER"|"ADMIN"|"SYSTEM", actor: { id: string } | null, reason?: string | null, internalNote?: string | null, metadata?: any, data?: Prisma.EventUpdateManyMutationInput }} t
 */
async function transitionEvent(tx, { event, action, actorRole, actor, reason = null, internalNote = null, metadata, data = {} }) {
  const to = policy.assertEventTransition(event.status, action, actorRole, reason);
  const { count } = await tx.event.updateMany({ where: { id: event.id, status: event.status }, data: { ...data, status: to } });
  if (count !== 1) throw conflict("STALE_STATE", "The event changed; reload and try again");
  await tx.eventModerationAction.create({
    data: { eventId: event.id, actorId: actor ? actor.id : null, actorRole, action, fromStatus: event.status, toStatus: to, reason, internalNote, metadata },
  });
  return to;
}

/** Fields a reviewer approves, frozen at submission so later edits are visible. @param {any} event */
const reviewSnapshot = (event) => ({
  title: event.title,
  summary: event.summary,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  timezone: event.timezone,
  attendanceMode: event.attendanceMode,
  venueName: event.venueName,
  addressLine: event.addressLine,
  city: event.city,
  country: event.country,
  currency: event.currency,
  ticketTypes: event.ticketTypes
    .filter((t) => t.status === "ACTIVE")
    .map((t) => ({ name: t.name, priceMinor: t.priceMinor, quantityTotal: t.quantityTotal })),
});

/** Checks shared by submit and approve. @param {any} event @param {import("@prisma/client").Organizer} org */
function assertReadyForReview(event, org) {
  const active = event.ticketTypes.filter((t) => t.status === "ACTIVE");
  if (active.length === 0) throw badRequest("TICKETS_REQUIRED", "Add at least one ticket type first");
  if (event.startsAt <= new Date()) throw badRequest("EVENT_IN_PAST", "The event must start in the future");
  assertLocationComplete(event);
  for (const t of active) policy.assertCanSetPrice(org, t.priceMinor);
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {any} req */
async function submitEvent(user, eventId, req) {
  const org = policy.requireActiveOrganizer(user);
  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    assertReadyForReview(event, org);
    const previousSubmissions = await tx.eventModerationAction.count({ where: { eventId: event.id, action: "SUBMIT" } });
    await transitionEvent(tx, {
      event,
      action: "SUBMIT",
      actorRole: "ORGANIZER",
      actor: user,
      metadata: { resubmission: previousSubmissions > 0, submissionNumber: previousSubmissions + 1, snapshot: reviewSnapshot(event) },
      data: { submittedAt: new Date() },
    });
    await recordAudit(tx, { actor: user, actorRole: "ORGANIZER", action: "event.submitted", targetType: "event", targetId: event.id, req });
    return tx.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude });
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId */
async function withdrawEvent(user, eventId) {
  policy.requireActiveOrganizer(user);
  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    await transitionEvent(tx, { event, action: "WITHDRAW", actorRole: "ORGANIZER", actor: user, data: { submittedAt: null } });
    return tx.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude });
  });
}

/**
 * Cancels bookings and tickets of a cancelled event. Free bookings are cancelled now;
 * paid ones (legacy only, until Phase 4) are counted for refund handling.
 * @param {Prisma.TransactionClient} tx
 * @param {string} eventId
 */
async function cancelEventBookings(tx, eventId) {
  const active = await tx.booking.findMany({ where: { eventId, status: { in: ["PENDING", "CONFIRMED"] } }, select: { id: true, totalMinor: true } });
  const free = active.filter((b) => b.totalMinor === 0).map((b) => b.id);
  const now = new Date();
  if (free.length) {
    await tx.booking.updateMany({ where: { id: { in: free } }, data: { status: "CANCELLED", cancelledAt: now, cancellationReason: "Event cancelled" } });
    await tx.ticket.updateMany({ where: { bookingId: { in: free }, status: "VALID" }, data: { status: "CANCELLED" } });
  }
  return { cancelledBookings: free.length, paidBookingsAwaitingRefund: active.length - free.length };
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {string} reason @param {any} req */
async function cancelOwnEvent(user, eventId, reason, req) {
  policy.requireActiveOrganizer(user);
  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    await transitionEvent(tx, {
      event, action: "CANCEL", actorRole: "ORGANIZER", actor: user, reason,
      data: { cancelledAt: new Date(), cancellationReason: reason },
    });
    const effect = await cancelEventBookings(tx, event.id);
    await recordAudit(tx, { actor: user, actorRole: "ORGANIZER", action: "event.cancelled", targetType: "event", targetId: event.id, metadata: { reason, ...effect }, req });
    return { event: await tx.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude }), ...effect };
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId */
async function ownEventHistory(user, eventId) {
  const event = await loadOwnEvent(user, eventId);
  return getPrisma().eventModerationAction.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "asc" } });
}

// ───────────────────────── Ticket types ─────────────────────────

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {any} input */
async function createTicketType(user, eventId, input) {
  const org = policy.requireActiveOrganizer(user);
  policy.assertCanSetPrice(org, input.priceMinor);
  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    policy.assertTicketTypesEditable(event.status, "create");
    return tx.ticketType.create({ data: { ...input, eventId: event.id } });
  }).catch((err) => {
    if (isUniqueViolation(err)) throw conflict("DUPLICATE_TICKET_TYPE", "A ticket type with this name already exists for this event");
    throw err;
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {string} ticketTypeId @param {any} changes */
async function updateTicketType(user, eventId, ticketTypeId, changes) {
  const org = policy.requireActiveOrganizer(user);
  const fields = Object.keys(changes);
  if (fields.length === 0) throw badRequest("NO_CHANGES", "Nothing to update");
  if (changes.priceMinor !== undefined) policy.assertCanSetPrice(org, changes.priceMinor);

  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    policy.assertTicketTypesEditable(event.status, "update", fields);
    const tt = event.ticketTypes.find((t) => t.id === ticketTypeId);
    if (!tt) throw notFound("Ticket type");
    if (changes.quantityTotal !== undefined) {
      if (changes.quantityTotal < tt.quantitySold) throw conflict("BELOW_SOLD", `${tt.quantitySold} tickets are already sold`);
      if (event.status === "PUBLISHED" && changes.quantityTotal < tt.quantityTotal) {
        throw conflict("TICKETS_LOCKED", "Inventory can only be increased after publication");
      }
    }
    if (event.status === "PUBLISHED" && changes.status === "ARCHIVED") throw conflict("TICKETS_LOCKED", "Hide the ticket type instead");
    if (changes.status === "ARCHIVED" && tt.quantitySold > 0) throw conflict("HAS_SALES", "Ticket types with sales cannot be archived");
    return tx.ticketType.update({ where: { id: tt.id }, data: changes });
  }).catch((err) => {
    if (isUniqueViolation(err)) throw conflict("DUPLICATE_TICKET_TYPE", "A ticket type with this name already exists for this event");
    throw err;
  });
}

// ───────────────────────── Media (external URLs until storage exists) ─────────────────────────

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {{ url: string, role: "COVER"|"GALLERY" }} input */
async function addEventMedia(user, eventId, { url, role }) {
  policy.requireActiveOrganizer(user);
  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    if (!["DRAFT", "PUBLISHED"].includes(event.status)) throw conflict("EVENT_LOCKED", `A ${event.status} event cannot change media`);
    const asset = await tx.fileAsset.upsert({
      where: { storageProvider_storageKey_purpose: { storageProvider: "external-url", storageKey: url, purpose: "EVENT_IMAGE" } },
      update: {},
      create: { ownerUserId: user.id, purpose: "EVENT_IMAGE", visibility: "PUBLIC", status: "READY", storageProvider: "external-url", storageKey: url },
    });
    if (role === "COVER") await tx.eventMedia.deleteMany({ where: { eventId: event.id, role: "COVER" } });
    const position = role === "COVER" ? 0 : await tx.eventMedia.count({ where: { eventId: event.id, role: "GALLERY" } });
    await tx.eventMedia.upsert({
      where: { eventId_assetId: { eventId: event.id, assetId: asset.id } },
      update: { role, position },
      create: { eventId: event.id, assetId: asset.id, role, position },
    });
    return tx.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude });
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {string} assetId */
async function removeEventMedia(user, eventId, assetId) {
  policy.requireActiveOrganizer(user);
  return getPrisma().$transaction(async (tx) => {
    const event = await loadOwnEvent(user, eventId, tx);
    if (!["DRAFT", "PUBLISHED"].includes(event.status)) throw conflict("EVENT_LOCKED", `A ${event.status} event cannot change media`);
    const { count } = await tx.eventMedia.deleteMany({ where: { eventId: event.id, assetId } });
    if (count === 0) throw notFound("Media");
    return tx.event.findUniqueOrThrow({ where: { id: event.id }, include: eventInclude });
  });
}

// ───────────────────────── Attendees & check-in ─────────────────────────

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {{ cursor?: string, limit: number }} f */
async function listAttendees(user, eventId, f) {
  const event = await loadOwnEvent(user, eventId);
  return getPrisma().ticket.findMany({
    where: { eventId: event.id, status: { in: ["VALID", "CANCELLED"] } },
    include: { holder: { select: { displayName: true, name: true } }, ticketType: { select: { name: true } }, booking: { select: { bookingDate: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId @param {string} code */
async function checkInTicket(user, eventId, code) {
  policy.requireActiveOrganizer(user);
  const prisma = getPrisma();
  const event = await loadOwnEvent(user, eventId);
  if (event.status !== "PUBLISHED") throw conflict("EVENT_NOT_ACTIVE", "Check-in is only open for published events");
  const ticket = await prisma.ticket.findFirst({ where: { code, eventId: event.id }, include: { holder: { select: { displayName: true, name: true } }, ticketType: { select: { name: true } } } });
  if (!ticket) throw notFound("Ticket");
  if (ticket.status !== "VALID") throw conflict("TICKET_NOT_VALID", `This ticket is ${ticket.status}`);
  const { count } = await prisma.ticket.updateMany({
    where: { id: ticket.id, status: "VALID", checkedInAt: null },
    data: { checkedInAt: new Date(), checkedInById: user.id },
  });
  if (count !== 1) throw conflict("ALREADY_CHECKED_IN", "This ticket has already been used");
  return prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: { holder: { select: { displayName: true, name: true } }, ticketType: { select: { name: true } } } });
}

// ───────────────────────── Admin moderation ─────────────────────────

/** @param {{ status?: import("@prisma/client").EventStatus, cursor?: string, limit: number }} f */
function listEventsForAdmin(f) {
  return getPrisma().event.findMany({
    where: f.status ? { status: f.status } : {},
    include: eventInclude,
    // review queue is oldest-first
    orderBy: f.status === "PENDING_REVIEW" ? [{ submittedAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** @param {string} eventId */
async function getEventForAdmin(eventId) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, include: eventInclude });
  if (!event) throw notFound("Event");
  const history = await prisma.eventModerationAction.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } });
  return { event, history };
}

/**
 * @param {import("../auth/currentUser").CurrentUser} admin
 * @param {string} eventId
 * @param {{ action: "APPROVE"|"REQUEST_CHANGES"|"REJECT"|"SUSPEND"|"REINSTATE"|"CANCEL", reason?: string, internalNote?: string }} input
 * @param {any} req
 */
async function moderateEvent(admin, eventId, { action, reason, internalNote }, req) {
  return getPrisma().$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, include: eventInclude });
    if (!event) throw notFound("Event");
    policy.assertNotOwnOrganizer(admin, event.organizer);

    /** @type {Prisma.EventUpdateManyMutationInput} */
    const data = {};
    if (action === "APPROVE") {
      if (event.organizer.status !== "ACTIVE") throw conflict("ORGANIZER_SUSPENDED", "The organizer is suspended");
      assertReadyForReview(event, event.organizer);
      data.publishedAt = event.publishedAt || new Date();
    }
    if (action === "CANCEL") Object.assign(data, { cancelledAt: new Date(), cancellationReason: reason });

    const to = await transitionEvent(tx, { event, action, actorRole: "ADMIN", actor: admin, reason, internalNote, data });
    const effect = action === "CANCEL" ? await cancelEventBookings(tx, event.id) : undefined;
    await recordAudit(tx, {
      actor: admin, actorRole: "ADMIN", action: `event.moderation.${action.toLowerCase()}`, targetType: "event", targetId: event.id,
      metadata: { from: event.status, to, reason, ...(effect || {}) }, req,
    });
    return getEventForAdminTx(tx, event.id);
  });
}

/** @param {Prisma.TransactionClient} tx @param {string} eventId */
async function getEventForAdminTx(tx, eventId) {
  const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, include: eventInclude });
  const history = await tx.eventModerationAction.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } });
  return { event, history };
}

/**
 * Marks ended published events COMPLETED (run by a scheduler or an admin).
 * @param {{ actor: { id: string } | null, req?: any, now?: Date }} opts
 */
async function completeEndedEvents({ actor, req, now = new Date() }) {
  const prisma = getPrisma();
  const ended = await prisma.event.findMany({
    where: { status: "PUBLISHED", OR: [{ endsAt: { lt: now } }, { endsAt: null, startsAt: { lt: now } }] },
    select: { id: true, status: true },
  });
  let completed = 0;
  for (const event of ended) {
    await prisma.$transaction(async (tx) => {
      try {
        await transitionEvent(tx, { event, action: "COMPLETE", actorRole: "SYSTEM", actor: null });
        completed += 1;
      } catch (err) {
        if (!(err && /** @type {any} */ (err).code === "STALE_STATE")) throw err;
      }
    });
  }
  await prisma.$transaction((tx) =>
    recordAudit(tx, { actor, actorRole: actor ? "ADMIN" : "SYSTEM", action: "event.complete_job", targetType: "system", targetId: "events", metadata: { completed }, req }),
  );
  return { completed };
}

module.exports = {
  eventInclude,
  listPublicEvents,
  getPublicEvent,
  loadOwnEvent,
  listOwnEvents,
  createEvent,
  updateEvent,
  submitEvent,
  withdrawEvent,
  cancelOwnEvent,
  ownEventHistory,
  createTicketType,
  updateTicketType,
  addEventMedia,
  removeEventMedia,
  listAttendees,
  checkInTicket,
  listEventsForAdmin,
  getEventForAdmin,
  moderateEvent,
  completeEndedEvents,
};
