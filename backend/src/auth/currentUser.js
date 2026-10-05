// Clerk identity → canonical User. The client never chooses which User it is.
const { Prisma } = require("@prisma/client");
const { getPrisma } = require("../db");
const { conflict, forbidden, unauthorized } = require("../http/errors");
const { recordAudit } = require("../services/audit");

const PROFILE_REFRESH_MS = 60 * 60 * 1000;
const userInclude = { organizer: true };

/**
 * @typedef {import("@prisma/client").User & { organizer: import("@prisma/client").Organizer | null }} CurrentUser
 */

const isUniqueViolation = (err, field) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  err.code === "P2002" &&
  (!field || JSON.stringify(err.meta?.target || "").includes(field));

/**
 * Finds, links or creates the User for a verified Clerk subject.
 * Approved linking rule: a legacy (Firebase-era) user is linked ONLY when the Clerk
 * primary email is verified and exactly equals the legacy email. Anything ambiguous
 * is refused (409) for manual resolution; nothing is ever linked on unverified data.
 *
 * @param {import("./identity").IdentityProvider} identity
 * @param {string} clerkUserId verified Clerk subject
 * @param {any} [req]
 * @returns {Promise<CurrentUser>}
 */
async function resolveUser(identity, clerkUserId, req) {
  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { clerkUserId }, include: userInclude });
  if (existing) return refreshProfileIfStale(identity, existing);

  const profile = await identity.getProfile(clerkUserId);
  const verifiedEmail = profile.emailVerified && profile.email ? profile.email : null;

  if (verifiedEmail) {
    const match = await prisma.user.findUnique({ where: { email: verifiedEmail }, include: userInclude });
    if (match) {
      // A concurrent first request for this same Clerk user just created it.
      if (match.clerkUserId === clerkUserId) return match;
      if (match.clerkUserId === null && match.legacyFirebaseUid !== null) {
        return linkLegacyUser(match, clerkUserId, profile, req);
      }
      // The verified email belongs to a different (already linked or non-legacy) account.
      await prisma.$transaction((tx) =>
        recordAudit(tx, {
          actor: null,
          actorRole: "SYSTEM",
          action: "user.account_link_conflict",
          targetType: "user",
          targetId: match.id,
          metadata: { clerkUserId },
          req,
        }),
      );
      throw conflict(
        "ACCOUNT_LINK_CONFLICT",
        "This email is already attached to another account. Contact support to resolve it.",
      );
    }
  }

  try {
    return await prisma.user.create({
      data: {
        clerkUserId,
        // Only a verified email is stored: an unverified one could claim someone else's address.
        email: verifiedEmail,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        profileSyncedAt: new Date(),
      },
      include: userInclude,
    });
  } catch (err) {
    // Two first requests raced: the other one created the row (whichever unique key hit first).
    if (isUniqueViolation(err)) {
      const raced = await prisma.user.findUnique({ where: { clerkUserId }, include: userInclude });
      if (raced) return raced;
    }
    if (isUniqueViolation(err, "email")) {
      throw conflict("ACCOUNT_LINK_CONFLICT", "This email is already attached to another account.");
    }
    throw err;
  }
}

/**
 * @param {CurrentUser} legacy
 * @param {string} clerkUserId
 * @param {import("./identity").IdentityProfile} profile
 * @param {any} req
 */
async function linkLegacyUser(legacy, clerkUserId, profile, req) {
  const prisma = getPrisma();
  const linked = await prisma.$transaction(async (tx) => {
    // Conditional update: only links if still unlinked (guards concurrent logins).
    const { count } = await tx.user.updateMany({
      where: { id: legacy.id, clerkUserId: null },
      data: {
        clerkUserId,
        avatarUrl: legacy.avatarUrl || profile.avatarUrl,
        name: legacy.name || profile.name,
        profileSyncedAt: new Date(),
      },
    });
    if (count === 1) {
      await recordAudit(tx, {
        actor: null,
        actorRole: "SYSTEM",
        action: "user.legacy_account_linked",
        targetType: "user",
        targetId: legacy.id,
        metadata: { clerkUserId, rule: "verified-email-exact-match" },
        req,
      });
    }
    return count === 1;
  });
  const user = await prisma.user.findUnique({ where: { clerkUserId }, include: userInclude });
  if (!user) {
    throw conflict("ACCOUNT_LINK_CONFLICT", linked ? "Account link failed" : "Account was linked concurrently");
  }
  return user;
}

/**
 * Keeps name/avatar/email in sync with Clerk (at most hourly). Email only updates
 * when verified and not used by another account.
 * @param {import("./identity").IdentityProvider} identity
 * @param {CurrentUser} user
 */
async function refreshProfileIfStale(identity, user) {
  if (user.profileSyncedAt && Date.now() - user.profileSyncedAt.getTime() < PROFILE_REFRESH_MS) return user;
  try {
    const profile = await identity.getProfile(/** @type {string} */ (user.clerkUserId));
    const prisma = getPrisma();
    const email = profile.emailVerified && profile.email ? profile.email : user.email;
    return await prisma.user.update({
      where: { id: user.id },
      data: { name: profile.name ?? user.name, avatarUrl: profile.avatarUrl ?? user.avatarUrl, email, profileSyncedAt: new Date() },
      include: userInclude,
    });
  } catch {
    return user; // a sync failure must not lock the user out
  }
}

/**
 * Middleware: requires a verified Clerk session and attaches the canonical User.
 * @param {import("./identity").IdentityProvider} identity
 * @param {{ allowSuspended?: boolean }} [options]
 * @returns {import("express").RequestHandler}
 */
function requireUser(identity, { allowSuspended = false } = {}) {
  return async (req, res, next) => {
    try {
      const subject = identity.getSubject(req);
      if (!subject) throw unauthorized();
      const user = await resolveUser(identity, subject, req);
      if (user.status === "DEACTIVATED") throw forbidden("ACCOUNT_DEACTIVATED", "This account is deactivated");
      if (user.status === "SUSPENDED" && !allowSuspended) {
        throw forbidden("ACCOUNT_SUSPENDED", "This account is suspended");
      }
      /** @type {any} */ (req).user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireUser, resolveUser };
