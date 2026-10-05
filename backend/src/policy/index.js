// Central authorization and state rules. Controllers and services ask these
// functions; nothing else decides roles, capabilities or allowed transitions.
const { forbidden, conflict, badRequest } = require("../http/errors");

/** @typedef {import("../auth/currentUser").CurrentUser} CurrentUser */
/** @typedef {import("@prisma/client").Organizer} Organizer */
/** @typedef {import("@prisma/client").EventStatus} EventStatus */

// ── Capabilities ──

/** @param {CurrentUser} user */
const isActive = (user) => user.status === "ACTIVE";
/** @param {CurrentUser} user */
const isPlatformAdmin = (user) => user.platformRole === "ADMIN" && isActive(user);
/** @param {Organizer | null | undefined} org */
const isVerifiedOrganizer = (org) => Boolean(org && org.status === "ACTIVE" && org.verificationStatus === "VERIFIED");

/**
 * What the product shows: suspension overrides the verification state.
 * @param {Organizer} org
 * @returns {"NOT_STARTED"|"PENDING"|"CHANGES_REQUESTED"|"VERIFIED"|"REJECTED"|"SUSPENDED"}
 */
const effectiveVerificationStatus = (org) => (org.status === "SUSPENDED" ? "SUSPENDED" : org.verificationStatus);

/** @param {CurrentUser} user */
function capabilities(user) {
  const org = user.organizer;
  return {
    isAuthenticated: true,
    isPlatformAdmin: isPlatformAdmin(user),
    hasOrganizer: Boolean(org),
    isActiveOrganizer: Boolean(org && org.status === "ACTIVE"),
    isVerifiedOrganizer: isVerifiedOrganizer(org),
    canCreatePaidTickets: isVerifiedOrganizer(org),
  };
}

// ── Guards (throw AppError) ──

/** @type {import("express").RequestHandler} */
function requireActiveUser(req, res, next) {
  const user = /** @type {any} */ (req).user;
  if (!user || !isActive(user)) return next(forbidden("ACCOUNT_SUSPENDED", "This account is suspended"));
  next();
}

/** @type {import("express").RequestHandler} */
function requireAdmin(req, res, next) {
  const user = /** @type {any} */ (req).user;
  // Same 404 a non-existent route gives: admin routes are not advertised.
  if (!user || !isPlatformAdmin(user)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
    return;
  }
  next();
}

/**
 * The caller's organizer, which must exist and be ACTIVE.
 * @param {CurrentUser} user
 * @returns {Organizer}
 */
function requireActiveOrganizer(user) {
  if (!user.organizer) throw forbidden("ORGANIZER_REQUIRED", "Create an organizer profile first");
  if (user.organizer.status !== "ACTIVE") throw forbidden("ORGANIZER_SUSPENDED", "This organizer profile is suspended");
  return user.organizer;
}

/**
 * Paid ticket types require a verified, active organizer.
 * @param {Organizer} org
 * @param {number} priceMinor
 */
function assertCanSetPrice(org, priceMinor) {
  if (priceMinor > 0 && !isVerifiedOrganizer(org)) {
    throw forbidden("VERIFICATION_REQUIRED", "Only verified organizers can sell paid tickets");
  }
}

/**
 * Separation of duties: an admin never reviews their own organizer or events.
 * @param {CurrentUser} admin
 * @param {{ ownerUserId: string }} organizer
 */
function assertNotOwnOrganizer(admin, organizer) {
  if (organizer.ownerUserId === admin.id) {
    throw forbidden("CONFLICT_OF_INTEREST", "Admins cannot review their own organizer profile or events");
  }
}

// ── Event lifecycle ──

/**
 * @typedef {"SUBMIT"|"WITHDRAW"|"APPROVE"|"REQUEST_CHANGES"|"REJECT"|"SUSPEND"|"REINSTATE"|"CANCEL"|"COMPLETE"} EventAction
 * @type {Record<EventAction, { actors: Array<"ORGANIZER"|"ADMIN"|"SYSTEM">, from: EventStatus[], to: EventStatus, reasonRequired?: boolean }>}
 */
const EVENT_TRANSITIONS = {
  SUBMIT: { actors: ["ORGANIZER"], from: ["DRAFT"], to: "PENDING_REVIEW" },
  WITHDRAW: { actors: ["ORGANIZER"], from: ["PENDING_REVIEW"], to: "DRAFT" },
  APPROVE: { actors: ["ADMIN"], from: ["PENDING_REVIEW"], to: "PUBLISHED" },
  REQUEST_CHANGES: { actors: ["ADMIN"], from: ["PENDING_REVIEW"], to: "DRAFT", reasonRequired: true },
  REJECT: { actors: ["ADMIN"], from: ["PENDING_REVIEW"], to: "DRAFT", reasonRequired: true },
  SUSPEND: { actors: ["ADMIN"], from: ["PUBLISHED"], to: "SUSPENDED", reasonRequired: true },
  REINSTATE: { actors: ["ADMIN"], from: ["SUSPENDED"], to: "PUBLISHED", reasonRequired: true },
  CANCEL: { actors: ["ORGANIZER", "ADMIN"], from: ["DRAFT", "PENDING_REVIEW", "PUBLISHED", "SUSPENDED"], to: "CANCELLED", reasonRequired: true },
  COMPLETE: { actors: ["SYSTEM", "ADMIN"], from: ["PUBLISHED"], to: "COMPLETED" },
};

/**
 * @param {EventStatus} from
 * @param {EventAction} action
 * @param {"ORGANIZER"|"ADMIN"|"SYSTEM"} actorRole
 * @param {string | null | undefined} reason
 * @returns {EventStatus} the target status
 */
function assertEventTransition(from, action, actorRole, reason) {
  const rule = EVENT_TRANSITIONS[action];
  if (!rule || !rule.actors.includes(actorRole)) {
    throw forbidden("TRANSITION_NOT_ALLOWED", `${actorRole} cannot ${action} an event`);
  }
  // Organizers cannot cancel an event an admin has suspended.
  if (action === "CANCEL" && actorRole === "ORGANIZER" && from === "SUSPENDED") {
    throw conflict("INVALID_TRANSITION", "Suspended events can only be cancelled by an admin");
  }
  if (!rule.from.includes(from)) {
    throw conflict("INVALID_TRANSITION", `Cannot ${action} an event that is ${from}`);
  }
  if (rule.reasonRequired && !reason) throw badRequest("REASON_REQUIRED", `A reason is required to ${action}`);
  return rule.to;
}

// Fields an organizer may edit, by status. Material fields lock once published.
const EVENT_FIELDS_ALL = [
  "title", "summary", "description", "startsAt", "endsAt", "timezone", "attendanceMode", "venueName",
  "addressLine", "city", "region", "country", "latitude", "longitude", "onlineUrl", "currency", "categoryIds",
];
const EVENT_FIELDS_AFTER_PUBLISH = ["summary", "description", "categoryIds"];

/**
 * @param {EventStatus} status
 * @param {string[]} fields
 */
function assertEventEditable(status, fields) {
  if (status === "DRAFT") return;
  if (status === "PUBLISHED") {
    const locked = fields.filter((f) => !EVENT_FIELDS_AFTER_PUBLISH.includes(f));
    if (locked.length) {
      throw conflict("EVENT_LOCKED", "These fields cannot change after publication", { fields: locked });
    }
    return;
  }
  if (status === "PENDING_REVIEW") {
    throw conflict("EVENT_LOCKED", "Withdraw the event from review before editing it");
  }
  throw conflict("EVENT_LOCKED", `A ${status} event cannot be edited`);
}

/**
 * Ticket types: anything in DRAFT; after publication only more inventory or visibility.
 * @param {EventStatus} status
 * @param {"create"|"update"} op
 * @param {string[]} [fields]
 */
function assertTicketTypesEditable(status, op, fields = []) {
  if (status === "DRAFT") return;
  if (status === "PUBLISHED" && op === "update" && fields.every((f) => ["quantityTotal", "status"].includes(f))) return;
  throw conflict("TICKETS_LOCKED", `Ticket types of a ${status} event cannot be ${op === "create" ? "added" : "changed"} this way`);
}

// Statuses a member of the public may see (via direct link for CANCELLED).
const PUBLIC_EVENT_STATUSES = /** @type {EventStatus[]} */ (["PUBLISHED", "COMPLETED", "CANCELLED"]);

// ── Verification lifecycle ──

/**
 * @typedef {"START_REVIEW"|"APPROVE"|"REQUEST_CHANGES"|"REJECT"|"REVOKE"} VerificationAction
 * @type {Record<VerificationAction, { from: import("@prisma/client").VerificationSubmissionStatus[], to: import("@prisma/client").VerificationSubmissionStatus, reasonRequired?: boolean }>}
 */
const VERIFICATION_TRANSITIONS = {
  START_REVIEW: { from: ["SUBMITTED"], to: "UNDER_REVIEW" },
  APPROVE: { from: ["SUBMITTED", "UNDER_REVIEW"], to: "APPROVED" },
  REQUEST_CHANGES: { from: ["SUBMITTED", "UNDER_REVIEW"], to: "CHANGES_REQUESTED", reasonRequired: true },
  REJECT: { from: ["SUBMITTED", "UNDER_REVIEW"], to: "REJECTED", reasonRequired: true },
  REVOKE: { from: ["APPROVED"], to: "REVOKED", reasonRequired: true },
};

/**
 * @param {import("@prisma/client").VerificationSubmissionStatus} from
 * @param {VerificationAction} action
 * @param {string | null | undefined} reason
 */
function assertVerificationTransition(from, action, reason) {
  const rule = VERIFICATION_TRANSITIONS[action];
  if (!rule.from.includes(from)) throw conflict("INVALID_TRANSITION", `Cannot ${action} a ${from} submission`);
  if (rule.reasonRequired && !reason) throw badRequest("REASON_REQUIRED", `A reason is required to ${action}`);
  return rule.to;
}

/**
 * Organizer verification status is derived from its latest non-withdrawn submission.
 * @param {import("@prisma/client").VerificationSubmissionStatus | null} latestStatus
 * @returns {import("@prisma/client").OrganizerVerificationStatus}
 */
function deriveVerificationStatus(latestStatus) {
  switch (latestStatus) {
    case "SUBMITTED":
    case "UNDER_REVIEW":
      return "PENDING";
    case "CHANGES_REQUESTED":
      return "CHANGES_REQUESTED";
    case "APPROVED":
      return "VERIFIED";
    case "REJECTED":
    case "REVOKED":
      return "REJECTED";
    default:
      return "NOT_STARTED";
  }
}

/** @param {Organizer} org */
function assertCanSubmitVerification(org) {
  if (org.status !== "ACTIVE") throw forbidden("ORGANIZER_SUSPENDED", "This organizer profile is suspended");
  if (!["NOT_STARTED", "CHANGES_REQUESTED", "REJECTED"].includes(org.verificationStatus)) {
    throw conflict("VERIFICATION_IN_PROGRESS", `Verification is already ${org.verificationStatus}`);
  }
}

module.exports = {
  isActive,
  isPlatformAdmin,
  isVerifiedOrganizer,
  effectiveVerificationStatus,
  capabilities,
  requireActiveUser,
  requireAdmin,
  requireActiveOrganizer,
  assertCanSetPrice,
  assertNotOwnOrganizer,
  EVENT_TRANSITIONS,
  assertEventTransition,
  EVENT_FIELDS_ALL,
  EVENT_FIELDS_AFTER_PUBLISH,
  assertEventEditable,
  assertTicketTypesEditable,
  PUBLIC_EVENT_STATUSES,
  VERIFICATION_TRANSITIONS,
  assertVerificationTransition,
  deriveVerificationStatus,
  assertCanSubmitVerification,
};
