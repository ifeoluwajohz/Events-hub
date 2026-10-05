const { Prisma } = require("@prisma/client");
const { getPrisma } = require("../db");
const { notFound, conflict, forbidden, badRequest } = require("../http/errors");
const policy = require("../policy");
const { recordAudit } = require("./audit");
const { uniqueSlug } = require("../lib/slug");
const { requirementsFor } = require("../verification/requirements");
const storage = require("../storage");

// ───────────────────────── Organizer profile ─────────────────────────

/** @param {import("../auth/currentUser").CurrentUser} user @param {any} input @param {any} req */
async function createOrganizer(user, input, req) {
  if (user.organizer) throw conflict("ORGANIZER_EXISTS", "You already have an organizer profile");
  try {
    return await getPrisma().$transaction(async (tx) => {
      const org = await tx.organizer.create({ data: { ...input, ownerUserId: user.id, slug: uniqueSlug(input.displayName, "organizer") } });
      await recordAudit(tx, { actor: user, actorRole: "ORGANIZER", action: "organizer.created", targetType: "organizer", targetId: org.id, req });
      return org;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw conflict("ORGANIZER_EXISTS", "You already have an organizer profile");
    }
    throw err;
  }
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {any} changes */
async function updateOrganizer(user, changes) {
  const org = policy.requireActiveOrganizer(user);
  if (Object.keys(changes).length === 0) throw badRequest("NO_CHANGES", "Nothing to update");
  return getPrisma().organizer.update({ where: { id: org.id }, data: changes });
}

/** @param {string} slug */
async function getPublicOrganizer(slug) {
  const prisma = getPrisma();
  const org = await prisma.organizer.findFirst({ where: { slug, status: "ACTIVE" } });
  if (!org) throw notFound("Organizer");
  const now = new Date();
  const [followers, upcomingEvents] = await Promise.all([
    prisma.organizerFollow.count({ where: { organizerId: org.id } }),
    prisma.event.findMany({
      where: { organizerId: org.id, status: "PUBLISHED", startsAt: { gte: now } },
      include: { organizer: true, ticketTypes: true, media: { include: { asset: true } }, categories: { include: { category: true } } },
      orderBy: { startsAt: "asc" },
      take: 20,
    }),
  ]);
  return { org, followers, upcomingEvents };
}

// ───────────────────────── Verification (organizer side) ─────────────────────────

/** @param {import("../auth/currentUser").CurrentUser} user */
async function getOwnVerification(user) {
  if (!user.organizer) throw forbidden("ORGANIZER_REQUIRED", "Create an organizer profile first");
  const submissions = await getPrisma().verificationSubmission.findMany({
    where: { organizerId: user.organizer.id },
    include: { evidence: true, decisions: { orderBy: { createdAt: "asc" } } },
    orderBy: { submittedAt: "desc" },
  });
  return { organizer: user.organizer, submissions };
}

/**
 * Validates a submission against the country/type requirement set, then stores it
 * immutably. Evidence files must be the user's own READY, PRIVATE verification assets.
 * @param {import("../auth/currentUser").CurrentUser} user
 * @param {{ country: string, organizerType: import("@prisma/client").OrganizerType, declaredData: Record<string, string>, evidence: Array<{ requirementKey: string, kind: import("@prisma/client").EvidenceKind, assetId?: string, value?: string, note?: string }> }} input
 * @param {any} req
 */
async function submitVerification(user, input, req) {
  const org = policy.requireActiveOrganizer(user);
  policy.assertCanSubmitVerification(org);
  const set = requirementsFor(input.country, input.organizerType);

  // Declared fields
  const missingFields = set.declaredFields.filter((f) => f.required && !input.declaredData[f.key]?.trim()).map((f) => f.key);
  const unknownFields = Object.keys(input.declaredData).filter((k) => !set.declaredFields.some((f) => f.key === k));
  // Evidence
  const problems = [];
  for (const e of input.evidence) {
    const req_ = set.evidence.find((r) => r.key === e.requirementKey);
    if (!req_) problems.push(`${e.requirementKey}: not part of ${set.version}`);
    else if (!req_.kinds.includes(e.kind)) problems.push(`${e.requirementKey}: kind must be ${req_.kinds.join(" or ")}`);
    else if (e.assetId && !req_.accepts.includes("file")) problems.push(`${e.requirementKey}: a file is not accepted`);
    else if (!e.assetId && e.value && !req_.accepts.includes("value")) problems.push(`${e.requirementKey}: a document upload is required`);
  }
  const missingEvidence = set.evidence.filter((r) => r.required && !input.evidence.some((e) => e.requirementKey === r.key)).map((r) => r.key);
  if (missingFields.length || unknownFields.length || problems.length || missingEvidence.length) {
    throw badRequest("REQUIREMENTS_NOT_MET", `Submission does not meet ${set.version}`, { missingFields, unknownFields, missingEvidence, problems });
  }

  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const assetIds = input.evidence.map((e) => e.assetId).filter(Boolean);
    if (assetIds.length) {
      const ok = await tx.fileAsset.count({
        where: { id: { in: /** @type {string[]} */ (assetIds) }, ownerUserId: user.id, purpose: "VERIFICATION_EVIDENCE", visibility: "PRIVATE", status: "READY" },
      });
      if (ok !== new Set(assetIds).size) throw badRequest("INVALID_EVIDENCE_FILE", "Evidence files must be your own uploaded verification documents");
    }
    // Resubmission links to the latest decided submission it answers.
    const previous = await tx.verificationSubmission.findFirst({
      where: { organizerId: org.id, status: { in: ["CHANGES_REQUESTED", "REJECTED", "REVOKED"] }, supersededBy: { is: null } },
      orderBy: { submittedAt: "desc" },
    });
    const submission = await tx.verificationSubmission.create({
      data: {
        organizerId: org.id,
        submittedById: user.id,
        country: input.country,
        organizerType: input.organizerType,
        requirementSetVersion: set.version,
        declaredData: input.declaredData,
        supersedesId: previous ? previous.id : null,
        evidence: { create: input.evidence.map((e) => ({ requirementKey: e.requirementKey, kind: e.kind, assetId: e.assetId ?? null, value: e.value ?? null, note: e.note ?? null })) },
      },
      include: { evidence: true, decisions: true },
    });
    // Conditional: a concurrent submission cannot double-submit.
    const { count } = await tx.organizer.updateMany({
      where: { id: org.id, verificationStatus: org.verificationStatus, status: "ACTIVE" },
      data: { verificationStatus: "PENDING" },
    });
    if (count !== 1) throw conflict("STALE_STATE", "Verification state changed; reload and try again");
    await recordAudit(tx, {
      actor: user, actorRole: "ORGANIZER", action: "organizer.verification.submitted", targetType: "verification_submission", targetId: submission.id,
      metadata: { organizerId: org.id, requirementSetVersion: set.version, resubmissionOf: previous ? previous.id : null }, req,
    });
    return submission;
  });
}

/** @param {import("../auth/currentUser").CurrentUser} user @param {string} submissionId @param {any} req */
async function withdrawVerification(user, submissionId, req) {
  if (!user.organizer) throw notFound("Submission");
  const orgId = user.organizer.id;
  return getPrisma().$transaction(async (tx) => {
    const submission = await tx.verificationSubmission.findFirst({ where: { id: submissionId, organizerId: orgId } });
    if (!submission) throw notFound("Submission");
    if (submission.status !== "SUBMITTED") throw conflict("INVALID_TRANSITION", `A ${submission.status} submission cannot be withdrawn`);
    const { count } = await tx.verificationSubmission.updateMany({ where: { id: submission.id, status: "SUBMITTED" }, data: { status: "WITHDRAWN" } });
    if (count !== 1) throw conflict("STALE_STATE", "The submission changed; reload and try again");
    await syncOrganizerVerification(tx, orgId);
    await recordAudit(tx, { actor: user, actorRole: "ORGANIZER", action: "organizer.verification.withdrawn", targetType: "verification_submission", targetId: submission.id, req });
    return tx.verificationSubmission.findUniqueOrThrow({ where: { id: submission.id }, include: { evidence: true, decisions: true } });
  });
}

/**
 * Re-derives Organizer.verificationStatus from submission history (never set directly).
 * @param {Prisma.TransactionClient} tx @param {string} organizerId
 */
async function syncOrganizerVerification(tx, organizerId) {
  const latest = await tx.verificationSubmission.findFirst({
    where: { organizerId, status: { not: "WITHDRAWN" } },
    orderBy: { submittedAt: "desc" },
  });
  const status = policy.deriveVerificationStatus(latest ? latest.status : null);
  await tx.organizer.update({
    where: { id: organizerId },
    data: { verificationStatus: status, verifiedAt: status === "VERIFIED" ? new Date() : null },
  });
  return status;
}

// ───────────────────────── Verification (admin side) ─────────────────────────

/** @param {{ status?: import("@prisma/client").VerificationSubmissionStatus, cursor?: string, limit: number }} f */
function listSubmissions(f) {
  return getPrisma().verificationSubmission.findMany({
    where: f.status ? { status: f.status } : { status: { in: ["SUBMITTED", "UNDER_REVIEW"] } },
    include: { organizer: true },
    orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

/** Full detail includes declared PII, so every view is audited. @param {import("../auth/currentUser").CurrentUser} admin @param {string} id @param {any} req */
async function getSubmissionForAdmin(admin, id, req) {
  return getPrisma().$transaction(async (tx) => {
    const submission = await tx.verificationSubmission.findUnique({
      where: { id },
      include: { organizer: true, evidence: true, decisions: { orderBy: { createdAt: "asc" } } },
    });
    if (!submission) throw notFound("Submission");
    policy.assertNotOwnOrganizer(admin, submission.organizer);
    await recordAudit(tx, { actor: admin, actorRole: "ADMIN", action: "verification.submission.viewed", targetType: "verification_submission", targetId: id, req });
    const history = await tx.verificationSubmission.findMany({
      where: { organizerId: submission.organizerId, id: { not: id } },
      select: { id: true, status: true, submittedAt: true, requirementSetVersion: true },
      orderBy: { submittedAt: "desc" },
    });
    return { submission, history };
  });
}

/**
 * Sensitive evidence access: authorized (admin, not own organizer) and audited BEFORE
 * anything is returned. Files need a storage provider (signed URL), so they 503 for now.
 * @param {import("../auth/currentUser").CurrentUser} admin @param {string} submissionId @param {string} evidenceId @param {any} req
 */
async function viewEvidence(admin, submissionId, evidenceId, req) {
  const prisma = getPrisma();
  const evidence = await prisma.verificationEvidence.findFirst({
    where: { id: evidenceId, submissionId },
    include: { asset: true, submission: { include: { organizer: true } } },
  });
  if (!evidence) throw notFound("Evidence");
  policy.assertNotOwnOrganizer(admin, evidence.submission.organizer);
  await prisma.$transaction((tx) =>
    recordAudit(tx, {
      actor: admin, actorRole: "ADMIN", action: "verification.evidence.viewed", targetType: "verification_evidence", targetId: evidence.id,
      metadata: { submissionId, requirementKey: evidence.requirementKey, kind: evidence.kind }, req,
    }),
  );
  const file = evidence.asset ? await storage.signedReadUrl(evidence.asset) : null;
  return { id: evidence.id, requirementKey: evidence.requirementKey, kind: evidence.kind, value: evidence.value, note: evidence.note, file };
}

/**
 * @param {import("../auth/currentUser").CurrentUser} admin
 * @param {string} submissionId
 * @param {{ action: import("../policy").VerificationAction, reason?: string, internalNote?: string }} input
 * @param {any} req
 */
async function decideVerification(admin, submissionId, { action, reason, internalNote }, req) {
  return getPrisma().$transaction(async (tx) => {
    const submission = await tx.verificationSubmission.findUnique({ where: { id: submissionId }, include: { organizer: true } });
    if (!submission) throw notFound("Submission");
    policy.assertNotOwnOrganizer(admin, submission.organizer);
    const to = policy.assertVerificationTransition(submission.status, action, reason);

    const { count } = await tx.verificationSubmission.updateMany({ where: { id: submission.id, status: submission.status }, data: { status: to } });
    if (count !== 1) throw conflict("STALE_STATE", "The submission changed; reload and try again");
    await tx.verificationDecision.create({ data: { submissionId: submission.id, reviewerId: admin.id, action, reason: reason ?? null, internalNote: internalNote ?? null } });
    const organizerStatus = await syncOrganizerVerification(tx, submission.organizerId);
    await recordAudit(tx, {
      actor: admin, actorRole: "ADMIN", action: `organizer.verification.${action.toLowerCase()}`, targetType: "organizer", targetId: submission.organizerId,
      metadata: { submissionId: submission.id, from: submission.status, to, organizerStatus, reason }, req,
    });
    return tx.verificationSubmission.findUniqueOrThrow({
      where: { id: submission.id },
      include: { organizer: true, evidence: true, decisions: { orderBy: { createdAt: "asc" } } },
    });
  });
}

// ───────────────────────── Organizer suspension (admin) ─────────────────────────

/**
 * @param {import("../auth/currentUser").CurrentUser} admin @param {string} organizerId
 * @param {"SUSPENDED"|"ACTIVE"} toStatus @param {string} reason @param {any} req
 */
async function setOrganizerStatus(admin, organizerId, toStatus, reason, req) {
  return getPrisma().$transaction(async (tx) => {
    const org = await tx.organizer.findUnique({ where: { id: organizerId } });
    if (!org) throw notFound("Organizer");
    policy.assertNotOwnOrganizer(admin, org);
    if (org.status === toStatus) throw conflict("INVALID_TRANSITION", `Organizer is already ${toStatus}`);
    const { count } = await tx.organizer.updateMany({ where: { id: org.id, status: org.status }, data: { status: toStatus } });
    if (count !== 1) throw conflict("STALE_STATE", "The organizer changed; reload and try again");
    await tx.organizerStatusChange.create({ data: { organizerId: org.id, actorId: admin.id, fromStatus: org.status, toStatus, reason } });
    await recordAudit(tx, {
      actor: admin, actorRole: "ADMIN", action: toStatus === "SUSPENDED" ? "organizer.suspended" : "organizer.reinstated",
      targetType: "organizer", targetId: org.id, metadata: { reason }, req,
    });
    return tx.organizer.findUniqueOrThrow({ where: { id: org.id } });
  });
}

/** @param {{ status?: import("@prisma/client").OrganizerStatus, verificationStatus?: import("@prisma/client").OrganizerVerificationStatus, cursor?: string, limit: number }} f */
function listOrganizersForAdmin(f) {
  return getPrisma().organizer.findMany({
    where: { ...(f.status ? { status: f.status } : {}), ...(f.verificationStatus ? { verificationStatus: f.verificationStatus } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
}

module.exports = {
  createOrganizer,
  updateOrganizer,
  getPublicOrganizer,
  getOwnVerification,
  submitVerification,
  withdrawVerification,
  listSubmissions,
  getSubmissionForAdmin,
  viewEvidence,
  decideVerification,
  setOrganizerStatus,
  listOrganizersForAdmin,
};
