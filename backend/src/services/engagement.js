// Saved events, organizer follows and user reports.
const { getPrisma } = require("../db");
const { notFound, conflict, badRequest } = require("../http/errors");
const policy = require("../policy");
const { recordAudit } = require("./audit");

const publicEventWhere = (id) => ({ id, status: { in: policy.PUBLIC_EVENT_STATUSES }, organizer: { status: /** @type {const} */ ("ACTIVE") } });

// ── Saved events (unique per user+event via composite primary key) ──

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId */
async function saveEvent(user, eventId) {
  const prisma = getPrisma();
  const event = await prisma.event.findFirst({ where: publicEventWhere(eventId), select: { id: true } });
  if (!event) throw notFound("Event");
  // createMany + skipDuplicates makes repeated saves idempotent (no duplicate rows possible)
  const { count } = await prisma.savedEvent.createMany({ data: [{ userId: user.id, eventId }], skipDuplicates: true });
  return { created: count === 1 };
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} eventId */
async function unsaveEvent(user, eventId) {
  await getPrisma().savedEvent.deleteMany({ where: { userId: user.id, eventId } });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {{ cursor?: string, limit: number }} f */
async function listSavedEvents(user, f) {
  const rows = await getPrisma().savedEvent.findMany({
    where: { userId: user.id, event: { status: { in: policy.PUBLIC_EVENT_STATUSES }, organizer: { status: "ACTIVE" } } },
    include: { event: { include: { organizer: true, ticketTypes: true, media: { include: { asset: true } }, categories: { include: { category: true } } } } },
    orderBy: [{ createdAt: "desc" }, { eventId: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { userId_eventId: { userId: user.id, eventId: f.cursor } }, skip: 1 } : {}),
  });
  return rows;
}

// ── Follows ──

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} organizerId */
async function followOrganizer(user, organizerId) {
  const prisma = getPrisma();
  const org = await prisma.organizer.findFirst({ where: { id: organizerId, status: "ACTIVE" }, select: { id: true, ownerUserId: true } });
  if (!org) throw notFound("Organizer");
  if (org.ownerUserId === user.id) throw badRequest("CANNOT_FOLLOW_SELF", "You cannot follow your own organizer profile");
  const { count } = await prisma.organizerFollow.createMany({ data: [{ userId: user.id, organizerId }], skipDuplicates: true });
  return { created: count === 1 };
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} organizerId */
async function unfollowOrganizer(user, organizerId) {
  await getPrisma().organizerFollow.deleteMany({ where: { userId: user.id, organizerId } });
}

/** @param {import("../auth/currentUser").CurrentUser} user */
function listFollows(user) {
  return getPrisma().organizerFollow.findMany({
    where: { userId: user.id, organizer: { status: "ACTIVE" } },
    include: { organizer: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

// ── Reports ──

/**
 * @param {import("../auth/currentUser").CurrentUser} user
 * @param {{ targetType: "EVENT"|"ORGANIZER"|"USER", targetId: string, reason: import("@prisma/client").ReportReason, details?: string }} input
 * @param {any} req
 */
async function createReport(user, { targetType, targetId, reason, details }, req) {
  const prisma = getPrisma();
  /** @type {{ eventId?: string, organizerId?: string, targetUserId?: string }} */
  let target;
  if (targetType === "EVENT") {
    const event = await prisma.event.findFirst({ where: publicEventWhere(targetId), select: { id: true } });
    if (!event) throw notFound("Event");
    target = { eventId: event.id };
  } else if (targetType === "ORGANIZER") {
    const org = await prisma.organizer.findUnique({ where: { id: targetId }, select: { id: true, ownerUserId: true } });
    if (!org) throw notFound("Organizer");
    if (org.ownerUserId === user.id) throw badRequest("CANNOT_REPORT_SELF", "You cannot report yourself");
    target = { organizerId: org.id };
  } else {
    const target_ = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target_) throw notFound("User");
    if (target_.id === user.id) throw badRequest("CANNOT_REPORT_SELF", "You cannot report yourself");
    target = { targetUserId: target_.id };
  }

  const duplicate = await prisma.report.findFirst({
    where: { reporterId: user.id, ...target, status: { in: ["OPEN", "UNDER_REVIEW"] } },
    select: { id: true },
  });
  if (duplicate) throw conflict("DUPLICATE_REPORT", "You already have an open report for this");

  void req;
  return prisma.report.create({ data: { reporterId: user.id, reason, details: details ?? null, ...target } });
}

/** @param {import("../auth/currentUser").CurrentUser} user */
function listOwnReports(user) {
  return getPrisma().report.findMany({ where: { reporterId: user.id }, orderBy: { createdAt: "desc" }, take: 100 });
}

/** @param {{ status?: import("@prisma/client").ReportStatus, cursor?: string, limit: number }} f */
function listReportsForAdmin(f) {
  return getPrisma().report.findMany({
    where: f.status ? { status: f.status } : { status: { in: ["OPEN", "UNDER_REVIEW"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/**
 * @param {import("../auth/currentUser").CurrentUser} admin @param {string} reportId
 * @param {{ status: "UNDER_REVIEW"|"ACTION_TAKEN"|"DISMISSED", resolution?: string }} input @param {any} req
 */
async function updateReportStatus(admin, reportId, { status, resolution }, req) {
  return getPrisma().$transaction(async (tx) => {
    const report = await tx.report.findUnique({ where: { id: reportId } });
    if (!report) throw notFound("Report");
    const allowed = status === "UNDER_REVIEW" ? ["OPEN"] : ["OPEN", "UNDER_REVIEW"];
    if (!allowed.includes(report.status)) throw conflict("INVALID_TRANSITION", `Report is already ${report.status}`);
    if (status !== "UNDER_REVIEW" && !resolution) throw badRequest("REASON_REQUIRED", "A resolution is required");
    const resolved = status !== "UNDER_REVIEW";
    const { count } = await tx.report.updateMany({
      where: { id: report.id, status: report.status },
      data: { status, ...(resolved ? { resolution, resolvedById: admin.id, resolvedAt: new Date() } : {}) },
    });
    if (count !== 1) throw conflict("STALE_STATE", "The report changed; reload and try again");
    await recordAudit(tx, { actor: admin, actorRole: "ADMIN", action: `report.${status.toLowerCase()}`, targetType: "report", targetId: report.id, metadata: { resolution }, req });
    return tx.report.findUniqueOrThrow({ where: { id: report.id } });
  });
}

module.exports = {
  saveEvent,
  unsaveEvent,
  listSavedEvents,
  followOrganizer,
  unfollowOrganizer,
  listFollows,
  createReport,
  listOwnReports,
  listReportsForAdmin,
  updateReportStatus,
};
