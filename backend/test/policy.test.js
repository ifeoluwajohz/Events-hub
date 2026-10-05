// Pure unit tests for the central policy module (no database).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/policy");

const user = (over = {}) => /** @type {any} */ ({ id: "u1", status: "ACTIVE", platformRole: "USER", organizer: null, ...over });
const org = (over = {}) => /** @type {any} */ ({ id: "o1", ownerUserId: "u1", status: "ACTIVE", verificationStatus: "NOT_STARTED", ...over });

describe("policy", () => {
  test("platform admin requires role ADMIN and an active account", () => {
    assert.equal(policy.isPlatformAdmin(user({ platformRole: "ADMIN" })), true);
    assert.equal(policy.isPlatformAdmin(user({ platformRole: "ADMIN", status: "SUSPENDED" })), false);
    assert.equal(policy.isPlatformAdmin(user()), false);
  });

  test("paid tickets require a verified, active organizer", () => {
    assert.throws(() => policy.assertCanSetPrice(org(), 100), /verified/);
    assert.throws(() => policy.assertCanSetPrice(org({ verificationStatus: "VERIFIED", status: "SUSPENDED" }), 100), /verified/);
    assert.doesNotThrow(() => policy.assertCanSetPrice(org({ verificationStatus: "VERIFIED" }), 100));
    assert.doesNotThrow(() => policy.assertCanSetPrice(org(), 0));
  });

  test("effective verification status shows suspension first", () => {
    assert.equal(policy.effectiveVerificationStatus(org({ verificationStatus: "VERIFIED", status: "SUSPENDED" })), "SUSPENDED");
    assert.equal(policy.effectiveVerificationStatus(org({ verificationStatus: "PENDING" })), "PENDING");
  });

  test("only an admin APPROVE reaches PUBLISHED", () => {
    for (const [action, rule] of Object.entries(policy.EVENT_TRANSITIONS)) {
      if (rule.to === "PUBLISHED") assert.deepEqual(rule.actors, ["ADMIN"], action);
    }
    assert.throws(() => policy.assertEventTransition("PENDING_REVIEW", "APPROVE", "ORGANIZER", null), /cannot APPROVE/);
    assert.equal(policy.assertEventTransition("PENDING_REVIEW", "APPROVE", "ADMIN", null), "PUBLISHED");
  });

  test("transition table: valid and invalid moves", () => {
    /** @type {Array<[any, any, any, string | null]>} */
    const valid = [
      ["DRAFT", "SUBMIT", "ORGANIZER", "DRAFT→PENDING_REVIEW"],
      ["PENDING_REVIEW", "WITHDRAW", "ORGANIZER", null],
      ["PENDING_REVIEW", "REQUEST_CHANGES", "ADMIN", null],
      ["PUBLISHED", "SUSPEND", "ADMIN", null],
      ["SUSPENDED", "REINSTATE", "ADMIN", null],
      ["PUBLISHED", "CANCEL", "ORGANIZER", null],
      ["PUBLISHED", "COMPLETE", "SYSTEM", null],
    ];
    for (const [from, action, role] of valid) {
      assert.doesNotThrow(() => policy.assertEventTransition(from, action, role, "a reason"), `${from} ${action} ${role}`);
    }
    const invalid = [
      ["PUBLISHED", "SUBMIT", "ORGANIZER"],
      ["DRAFT", "APPROVE", "ADMIN"],
      ["CANCELLED", "REINSTATE", "ADMIN"],
      ["COMPLETED", "CANCEL", "ORGANIZER"],
      ["SUSPENDED", "CANCEL", "ORGANIZER"],
      ["PUBLISHED", "COMPLETE", "ORGANIZER"],
    ];
    for (const [from, action, role] of invalid) {
      assert.throws(() => policy.assertEventTransition(/** @type {any} */ (from), /** @type {any} */ (action), /** @type {any} */ (role), "a reason"), `${from} ${action} ${role}`);
    }
  });

  test("reasons are required for negative decisions", () => {
    assert.throws(() => policy.assertEventTransition("PENDING_REVIEW", "REJECT", "ADMIN", null), /reason/);
    assert.throws(() => policy.assertVerificationTransition("UNDER_REVIEW", "REJECT", null), /reason/);
  });

  test("no event status is ever SOLD_OUT", () => {
    const statuses = new Set(Object.values(policy.EVENT_TRANSITIONS).flatMap((r) => [...r.from, r.to]));
    assert.ok(!statuses.has(/** @type {any} */ ("SOLD_OUT")));
  });

  test("organizer verification status is derived from the latest submission", () => {
    assert.equal(policy.deriveVerificationStatus(null), "NOT_STARTED");
    assert.equal(policy.deriveVerificationStatus("UNDER_REVIEW"), "PENDING");
    assert.equal(policy.deriveVerificationStatus("CHANGES_REQUESTED"), "CHANGES_REQUESTED");
    assert.equal(policy.deriveVerificationStatus("APPROVED"), "VERIFIED");
    assert.equal(policy.deriveVerificationStatus("REVOKED"), "REJECTED");
  });

  test("published events lock material fields", () => {
    assert.doesNotThrow(() => policy.assertEventEditable("PUBLISHED", ["description"]));
    assert.throws(() => policy.assertEventEditable("PUBLISHED", ["startsAt"]), /cannot change/);
    assert.throws(() => policy.assertEventEditable("PENDING_REVIEW", ["description"]), /Withdraw/);
  });

  test("separation of duties", () => {
    assert.throws(() => policy.assertNotOwnOrganizer(user({ id: "a" }), { ownerUserId: "a" }), /own/);
    assert.doesNotThrow(() => policy.assertNotOwnOrganizer(user({ id: "a" }), { ownerUserId: "b" }));
  });
});
