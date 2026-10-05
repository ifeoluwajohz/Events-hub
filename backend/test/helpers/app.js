// API test harness. Real Clerk token verification (clerkMiddleware with a local RSA key),
// real Express app, real Postgres (one database per test file). Only Clerk's profile
// lookup (a network call) is replaced, by an in-memory directory.
const crypto = require("node:crypto");
const request = require("supertest");
const { createDatabase, dropDatabase, migrateDeploy } = require("./database");

const ORIGIN = "http://localhost:5173";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Signs a Clerk-shaped session token.
 * @param {string} sub Clerk user id
 * @param {{ key?: crypto.KeyObject, expired?: boolean, azp?: string }} [opts]
 */
function token(sub, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "RS256", typ: "JWT", kid: "test" });
  const payload = b64({
    sub,
    sid: `sess_${sub}`,
    iss: "https://test.clerk.accounts.dev",
    azp: opts.azp || ORIGIN,
    iat: now - 5,
    nbf: now - 5,
    exp: opts.expired ? now - 10 : now + 300,
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), opts.key || privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

/** In-memory stand-in for Clerk's user directory. */
const directory = new Map();
/** @param {string} sub @param {{ email?: string|null, emailVerified?: boolean, name?: string|null }} p */
function setProfile(sub, p) {
  directory.set(sub, { email: p.email ?? null, emailVerified: p.emailVerified ?? true, name: p.name ?? null, avatarUrl: null });
}

async function setup() {
  const db = await createDatabase("evt_api");
  migrateDeploy(db.url);
  process.env.DATABASE_URL = db.url;
  process.env.RATE_LIMIT_SCALE = process.env.RATE_LIMIT_SCALE || "100";

  const { loadConfig } = require("../../src/config");
  const { createApp } = require("../../src/app");
  const { createClerkIdentity } = require("../../src/auth/identity");
  const { getPrisma, disconnect } = require("../../src/db");

  const config = loadConfig({ NODE_ENV: "test", CORS_ORIGINS: ORIGIN });
  config.clerk = {
    publishableKey: `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64")}`,
    secretKey: "sk_test_not_used",
    jwtKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    authorizedParties: [ORIGIN],
  };
  const identity = createClerkIdentity(config.clerk, {
    getProfile: async (sub) => directory.get(sub) || { email: null, emailVerified: false, name: null, avatarUrl: null },
  });
  const app = createApp({ config, identity, log: () => {} });
  const prisma = getPrisma();

  /** @param {string} sub */
  const as = (sub) => {
    const auth = (r) => (sub ? r.set("Authorization", `Bearer ${token(sub)}`) : r);
    return {
      get: (url) => auth(request(app).get(url)),
      post: (url, body) => auth(request(app).post(url)).send(body ?? {}),
      put: (url, body) => auth(request(app).put(url)).send(body ?? {}),
      patch: (url, body) => auth(request(app).patch(url)).send(body ?? {}),
      delete: (url) => auth(request(app).delete(url)),
    };
  };

  // ── Persona factories (setup shortcuts; the flows themselves are tested separately) ──
  let n = 0;
  /** Signed-in attendee. */
  async function attendee(name = "attendee") {
    n += 1;
    const sub = `user_${name}_${n}`;
    setProfile(sub, { email: `${name}${n}@example.test`, name: `${name} ${n}` });
    const res = await as(sub).get("/me");
    if (res.status !== 200) throw new Error(`provision failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { sub, id: res.body.data.id, api: as(sub) };
  }
  /** Attendee with an organizer profile (unverified). */
  async function organizer(name = "organizer") {
    const p = await attendee(name);
    const res = await p.api.post("/organizer", { displayName: `${name} Events`, country: "NG" });
    if (res.status !== 201) throw new Error(`organizer failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { ...p, organizerId: res.body.data.id };
  }
  /** Organizer marked VERIFIED directly (the real flow is covered in verification tests). */
  async function verifiedOrganizer(name = "verified") {
    const p = await organizer(name);
    await prisma.organizer.update({ where: { id: p.organizerId }, data: { verificationStatus: "VERIFIED", verifiedAt: new Date() } });
    return p;
  }
  /** Platform admin, granted as the CLI would. */
  async function admin(name = "admin") {
    const p = await attendee(name);
    await prisma.user.update({ where: { id: p.id }, data: { platformRole: "ADMIN" } });
    return p;
  }

  const future = (days = 30) => new Date(Date.now() + days * 86400000).toISOString();
  /** A valid event body. */
  const eventBody = (overrides = {}) => ({
    title: "Lagos Tech Meetup",
    summary: "Monthly meetup",
    description: "Talks, demos and networking.",
    startsAt: future(),
    timezone: "Africa/Lagos",
    venueName: "Yaba Hub",
    city: "Lagos",
    country: "NG",
    currency: "NGN",
    ticketTypes: [{ name: "General admission", priceMinor: 0, quantityTotal: 100 }],
    ...overrides,
  });

  /** Creates and publishes an event through the real submit → approve flow. */
  async function publishedEvent(org, reviewer, overrides = {}) {
    const created = await org.api.post("/organizer/events", eventBody(overrides));
    if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
    const id = created.body.data.id;
    const sub = await org.api.post(`/organizer/events/${id}/submit`);
    if (sub.status !== 200) throw new Error(`submit failed: ${JSON.stringify(sub.body)}`);
    const ok = await reviewer.api.post(`/admin/events/${id}/moderation`, { action: "APPROVE" });
    if (ok.status !== 200) throw new Error(`approve failed: ${JSON.stringify(ok.body)}`);
    return ok.body.data;
  }

  async function teardown() {
    await disconnect();
    await dropDatabase(db.name);
  }

  return { app, prisma, as, token, setProfile, attendee, organizer, verifiedOrganizer, admin, eventBody, publishedEvent, future, teardown };
}

let keyCounter = 0;
const idemKey = () => `test-key-${Date.now()}-${++keyCounter}`;

module.exports = { setup, token, ORIGIN, idemKey, otherKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey };
