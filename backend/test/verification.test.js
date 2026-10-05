const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/app");

describe("organizer verification", () => {
  /** @type {any} */ let t;
  let admin;
  before(async () => {
    t = await setup();
    admin = await t.admin("reviewer");
  });
  after(async () => t && t.teardown());

  // Until a storage provider exists, uploads cannot happen through the API; tests insert
  // the READY private asset an upload would have produced.
  const evidenceFile = (ownerUserId) =>
    t.prisma.fileAsset.create({
      data: { ownerUserId, purpose: "VERIFICATION_EVIDENCE", visibility: "PRIVATE", status: "READY", storageProvider: "test-provider", storageKey: `k-${Math.random()}` },
    });

  const individualSubmission = async (org) => ({
    country: "GH",
    organizerType: "INDIVIDUAL",
    declaredData: { legalName: "Ama Mensah", address: "1 Oxford St, Accra" },
    evidence: [
      { requirementKey: "gov_id", kind: "GOVERNMENT_ID", assetId: (await evidenceFile(org.id)).id },
      { requirementKey: "web_presence", kind: "SOCIAL_PROFILE", value: "https://instagram.com/ama" },
    ],
  });

  const decide = (id, body) => admin.api.post(`/admin/verification-submissions/${id}/decisions`, body);
  const myStatus = async (org) => (await org.api.get("/organizer/verification")).body.data.status;

  test("requirements are country-aware", async () => {
    const org = await t.organizer("req");
    const ng = await org.api.get("/organizer/verification/requirements?country=NG&type=BUSINESS");
    const gh = await org.api.get("/organizer/verification/requirements?country=GH&type=BUSINESS");
    assert.equal(ng.body.data.version, "NG-BUSINESS@2026-10");
    assert.equal(gh.body.data.version, "DEFAULT-BUSINESS@2026-10");
    assert.ok(ng.body.data.evidence.some((e) => e.key === "tax_id"));
  });

  test("submissions that miss requirements are rejected with specifics", async () => {
    const org = await t.organizer("missing");
    const res = await org.api.post("/organizer/verification/submissions", {
      country: "NG", organizerType: "BUSINESS", declaredData: { legalName: "Acme" }, evidence: [{ requirementKey: "web_presence", kind: "WEB_PRESENCE", value: "https://acme.example" }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "REQUIREMENTS_NOT_MET");
    assert.ok(res.body.error.details.missingFields.includes("registrationNumber"));
    assert.ok(res.body.error.details.missingEvidence.includes("business_registration"));
  });

  test("evidence files must be the submitter's own private uploads", async () => {
    const org = await t.organizer("thief");
    const victim = await t.organizer("victim");
    const body = await individualSubmission(org);
    body.evidence[0].assetId = (await evidenceFile(victim.id)).id;
    const res = await org.api.post("/organizer/verification/submissions", body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_EVIDENCE_FILE");
  });

  test("full journey: submit → review → changes requested → resubmit → approve → paid tickets; history kept", async () => {
    const org = await t.organizer("journey");
    assert.equal(await myStatus(org), "NOT_STARTED");

    const s1 = await org.api.post("/organizer/verification/submissions", await individualSubmission(org));
    assert.equal(s1.status, 201, JSON.stringify(s1.body));
    assert.equal(await myStatus(org), "PENDING");
    assert.equal((await org.api.post("/organizer/verification/submissions", await individualSubmission(org))).status, 409, "no double submission");

    assert.equal((await decide(s1.body.data.id, { action: "START_REVIEW" })).body.data.status, "UNDER_REVIEW");
    assert.equal((await decide(s1.body.data.id, { action: "REQUEST_CHANGES" })).status, 400, "reason required");
    await decide(s1.body.data.id, { action: "REQUEST_CHANGES", reason: "ID photo is blurry", internalNote: "check again" });
    assert.equal(await myStatus(org), "CHANGES_REQUESTED");

    // paid tickets still forbidden
    assert.equal((await org.api.post("/organizer/events", t.eventBody({ ticketTypes: [{ name: "VIP", priceMinor: 100, quantityTotal: 1 }] }))).status, 403);

    const s2 = await org.api.post("/organizer/verification/submissions", await individualSubmission(org));
    assert.equal(s2.status, 201);
    assert.equal(s2.body.data.supersedesId, s1.body.data.id, "resubmission is linked");
    const approved = await decide(s2.body.data.id, { action: "APPROVE" });
    assert.equal(approved.body.data.status, "APPROVED");
    assert.equal(await myStatus(org), "VERIFIED");
    assert.equal((await org.api.post("/organizer/events", t.eventBody({ ticketTypes: [{ name: "VIP", priceMinor: 100, quantityTotal: 1 }] }))).status, 201);

    // public badge is real state
    const pub = await t.as(null).get(`/public/organizers/${(await org.api.get("/organizer")).body.data.slug}`);
    assert.equal(pub.body.data.verified, true);

    // organizer sees reasons, never internal notes
    const mine = await org.api.get("/organizer/verification");
    const old = mine.body.data.submissions.find((x) => x.id === s1.body.data.id);
    assert.deepEqual(old.decisions.map((d) => d.action), ["START_REVIEW", "REQUEST_CHANGES"]);
    assert.equal(old.decisions[1].reason, "ID photo is blurry");
    assert.ok(!JSON.stringify(mine.body).includes("check again"));
    assert.ok(!JSON.stringify(mine.body).includes("Ama Mensah"), "declared PII is not echoed");

    // every decision is permanent and audited
    assert.equal(await t.prisma.verificationDecision.count({ where: { submission: { organizerId: org.organizerId } } }), 3);
    assert.equal(await t.prisma.auditLog.count({ where: { targetId: org.organizerId, action: { startsWith: "organizer.verification." }, actorRole: "ADMIN" } }), 3);
    await assert.rejects(t.prisma.$executeRaw`DELETE FROM "VerificationDecision"`, /append-only/);
    await assert.rejects(
      t.prisma.$executeRaw`UPDATE "VerificationSubmission" SET "declaredData" = '{}'::jsonb WHERE "id" = ${s1.body.data.id}`,
      /immutable/,
    );

    // revocation
    const revoked = await decide(s2.body.data.id, { action: "REVOKE", reason: "Fraud report confirmed" });
    assert.equal(revoked.body.data.status, "REVOKED");
    assert.equal(await myStatus(org), "REJECTED");
  });

  test("rejection, then a fresh resubmission is possible", async () => {
    const org = await t.organizer("rejected");
    const s = (await org.api.post("/organizer/verification/submissions", await individualSubmission(org))).body.data;
    await decide(s.id, { action: "REJECT", reason: "Documents do not match" });
    assert.equal(await myStatus(org), "REJECTED");
    const again = await org.api.post("/organizer/verification/submissions", await individualSubmission(org));
    assert.equal(again.status, 201);
    assert.equal(again.body.data.supersedesId, s.id);
  });

  test("withdrawal restores the previous state", async () => {
    const org = await t.organizer("withdraw");
    const s = (await org.api.post("/organizer/verification/submissions", await individualSubmission(org))).body.data;
    const res = await org.api.post(`/organizer/verification/submissions/${s.id}/withdraw`);
    assert.equal(res.body.data.status, "WITHDRAWN");
    assert.equal(await myStatus(org), "NOT_STARTED");
  });

  test("suspension overrides verification and is reversible with history", async () => {
    const org = await t.verifiedOrganizer("suspend");
    const ev = await t.publishedEvent(org, admin);
    const s = await admin.api.post(`/admin/organizers/${org.organizerId}/suspend`, { reason: "Chargeback fraud" });
    assert.equal(s.status, 200);
    assert.equal(s.body.data.verificationStatus, "SUSPENDED");
    assert.equal((await t.as(null).get(`/public/events/${ev.id}`)).status, 404, "suspended organizer's events are hidden");
    assert.equal((await org.api.post("/organizer/events", t.eventBody())).status, 403);
    const r = await admin.api.post(`/admin/organizers/${org.organizerId}/reinstate`, { reason: "Resolved" });
    assert.equal(r.body.data.verificationStatus, "VERIFIED", "verification was not lost");
    const changes = await t.prisma.organizerStatusChange.findMany({ where: { organizerId: org.organizerId }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(changes.map((c) => c.toStatus), ["SUSPENDED", "ACTIVE"]);
  });

  test("viewing sensitive data is audited; files need a storage provider", async () => {
    const org = await t.organizer("audit");
    const s = (await org.api.post("/organizer/verification/submissions", await individualSubmission(org))).body.data;
    const detail = await admin.api.get(`/admin/verification-submissions/${s.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.declaredData.legalName, "Ama Mensah");
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: "verification.submission.viewed", targetId: s.id, actorId: admin.id } }));

    const [fileEv, valueEv] = detail.body.data.evidence.sort((a, b) => (a.hasFile ? -1 : 1));
    const value = await admin.api.get(`/admin/verification-submissions/${s.id}/evidence/${valueEv.id}`);
    assert.equal(value.status, 200);
    assert.equal(value.body.data.value, "https://instagram.com/ama");
    const file = await admin.api.get(`/admin/verification-submissions/${s.id}/evidence/${fileEv.id}`);
    assert.equal(file.status, 503);
    assert.equal(file.body.error.code, "STORAGE_NOT_CONFIGURED");
    assert.equal(await t.prisma.auditLog.count({ where: { action: "verification.evidence.viewed", actorId: admin.id } }), 2, "both views audited, even the failed one");

    // non-admins never see the queue or evidence
    assert.equal((await org.api.get(`/admin/verification-submissions/${s.id}`)).status, 404);
  });

  test("admins cannot review their own organizer", async () => {
    const res = await admin.api.post("/organizer", { displayName: "Reviewer's Own Org" });
    assert.equal(res.status, 201);
    const body = await individualSubmission({ id: admin.id });
    const s = (await admin.api.post("/organizer/verification/submissions", body)).body.data;
    const d = await decide(s.id, { action: "APPROVE" });
    assert.equal(d.status, 403);
    assert.equal(d.body.error.code, "CONFLICT_OF_INTEREST");
  });

  test("uploads report that no storage provider is configured", async () => {
    const org = await t.organizer("upload");
    const res = await org.api.post("/organizer/uploads", { purpose: "VERIFICATION_EVIDENCE", mimeType: "image/jpeg", sizeBytes: 1000 });
    assert.equal(res.status, 503);
  });
});
