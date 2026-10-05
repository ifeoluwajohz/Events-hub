// Platform administration: users, roles, categories, audit log access.
const { getPrisma } = require("../db");
const { notFound, conflict, forbidden } = require("../http/errors");
const { recordAudit } = require("./audit");
const { slugify } = require("../lib/slug");

/** @param {{ q?: string, status?: import("@prisma/client").UserStatus, role?: import("@prisma/client").PlatformRole, cursor?: string, limit: number }} f */
function listUsers(f) {
  return getPrisma().user.findMany({
    where: {
      ...(f.status ? { status: f.status } : {}),
      ...(f.role ? { platformRole: f.role } : {}),
      ...(f.q
        ? { OR: [{ email: { contains: f.q, mode: "insensitive" } }, { name: { contains: f.q, mode: "insensitive" } }, { displayName: { contains: f.q, mode: "insensitive" } }] }
        : {}),
    },
    include: { organizer: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** @param {string} id */
async function getUser(id) {
  const user = await getPrisma().user.findUnique({ where: { id }, include: { organizer: true } });
  if (!user) throw notFound("User");
  return user;
}

/**
 * @param {import("../auth/currentUser").CurrentUser} admin @param {string} userId
 * @param {"ACTIVE"|"SUSPENDED"} status @param {string} reason @param {any} req
 */
async function setUserStatus(admin, userId, status, reason, req) {
  if (userId === admin.id) throw forbidden("SELF_ACTION", "Admins cannot change their own account status");
  return getPrisma().$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User");
    if (user.status === status) throw conflict("INVALID_TRANSITION", `User is already ${status}`);
    if (user.status === "DEACTIVATED") throw conflict("INVALID_TRANSITION", "Deactivated accounts cannot be changed here");
    const { count } = await tx.user.updateMany({ where: { id: user.id, status: user.status }, data: { status } });
    if (count !== 1) throw conflict("STALE_STATE", "The user changed; reload and try again");
    await recordAudit(tx, {
      actor: admin, actorRole: "ADMIN", action: status === "SUSPENDED" ? "user.suspended" : "user.reinstated",
      targetType: "user", targetId: user.id, metadata: { from: user.status, to: status, reason }, req,
    });
    return tx.user.findUniqueOrThrow({ where: { id: user.id }, include: { organizer: true } });
  });
}

/**
 * Grants or revokes platform admin. Only reachable by an existing admin (the first
 * admin is created with the CLI). Admins cannot change their own role, and the last
 * active admin can never be removed.
 * @param {import("../auth/currentUser").CurrentUser} admin @param {string} userId
 * @param {"USER"|"ADMIN"} role @param {string} reason @param {any} req
 */
async function setPlatformRole(admin, userId, role, reason, req) {
  if (userId === admin.id) throw forbidden("SELF_ACTION", "Admins cannot change their own role");
  return getPrisma().$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User");
    if (user.platformRole === role) throw conflict("INVALID_TRANSITION", `User already has role ${role}`);
    if (role === "ADMIN" && user.status !== "ACTIVE") throw conflict("USER_NOT_ACTIVE", "Only active users can become admins");
    if (role === "USER") {
      const admins = await tx.user.count({ where: { platformRole: "ADMIN", status: "ACTIVE" } });
      if (admins <= 1) throw conflict("LAST_ADMIN", "The last admin cannot be removed");
    }
    const { count } = await tx.user.updateMany({ where: { id: user.id, platformRole: user.platformRole }, data: { platformRole: role } });
    if (count !== 1) throw conflict("STALE_STATE", "The user changed; reload and try again");
    await recordAudit(tx, {
      actor: admin, actorRole: "ADMIN", action: role === "ADMIN" ? "user.platform_admin.granted" : "user.platform_admin.revoked",
      targetType: "user", targetId: user.id, metadata: { from: user.platformRole, to: role, reason }, req,
    });
    return tx.user.findUniqueOrThrow({ where: { id: user.id }, include: { organizer: true } });
  });
}

// ── Categories ──

function listActiveCategories() {
  return getPrisma().category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

function listAllCategories() {
  return getPrisma().category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

/** @param {import("../auth/currentUser").CurrentUser} admin @param {{ name: string, slug?: string, sortOrder?: number }} input @param {any} req */
async function createCategory(admin, input, req) {
  return getPrisma().$transaction(async (tx) => {
    const category = await tx.category.create({ data: { name: input.name, slug: input.slug || slugify(input.name, "category"), sortOrder: input.sortOrder ?? 0 } });
    await recordAudit(tx, { actor: admin, actorRole: "ADMIN", action: "category.created", targetType: "category", targetId: category.id, metadata: { name: category.name }, req });
    return category;
  });
}

/** @param {import("../auth/currentUser").CurrentUser} admin @param {string} id @param {any} changes @param {any} req */
async function updateCategory(admin, id, changes, req) {
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.category.findUnique({ where: { id } });
    if (!existing) throw notFound("Category");
    const category = await tx.category.update({ where: { id }, data: changes });
    await recordAudit(tx, { actor: admin, actorRole: "ADMIN", action: "category.updated", targetType: "category", targetId: id, metadata: { changes }, req });
    return category;
  });
}

// ── Audit log (read-only; the table itself rejects UPDATE/DELETE) ──

/** @param {{ targetType?: string, targetId?: string, actorId?: string, action?: string, cursor?: string, limit: number }} f */
function listAuditLogs(f) {
  return getPrisma().auditLog.findMany({
    where: {
      ...(f.targetType ? { targetType: f.targetType } : {}),
      ...(f.targetId ? { targetId: f.targetId } : {}),
      ...(f.actorId ? { actorId: f.actorId } : {}),
      ...(f.action ? { action: { startsWith: f.action } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

module.exports = {
  listUsers,
  getUser,
  setUserStatus,
  setPlatformRole,
  listActiveCategories,
  listAllCategories,
  createCategory,
  updateCategory,
  listAuditLogs,
};
