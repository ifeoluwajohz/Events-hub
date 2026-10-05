const crypto = require("node:crypto");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");

/** @type {import("express").RequestHandler} */
function requestId(req, res, next) {
  const incoming = req.get("x-request-id");
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  /** @type {any} */ (req).id = id;
  res.setHeader("X-Request-Id", id);
  next();
}

// Minimal headers for a JSON API (no HTML is served, so no CSP needed).
/** @param {{ isProduction: boolean }} config */
function securityHeaders(config) {
  /** @type {import("express").RequestHandler} */
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Cache-Control", "no-store");
    if (config.isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

// Exact-origin allow-list. Auth uses bearer tokens, so credentials are not needed.
/** @param {{ corsOrigins: string[] }} config */
function corsPolicy(config) {
  const allowed = new Set(config.corsOrigins);
  return cors({
    origin: (origin, callback) => callback(null, !origin || allowed.has(origin)),
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    maxAge: 600,
  });
}

/**
 * @param {number} windowMs
 * @param {number} limit
 * @param {string} name
 */
const limiter = (windowMs, limit, name) =>
  rateLimit({
    windowMs,
    // RATE_LIMIT_SCALE (default 1) lets test suites raise limits without disabling them.
    limit: Math.ceil(limit * (Number(process.env.RATE_LIMIT_SCALE) || 1)),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Per authenticated user when known, otherwise per IP.
    keyGenerator: (req) => {
      const user = /** @type {any} */ (req).user;
      return user ? `${name}:u:${user.id}` : `${name}:ip:${req.ip}`;
    },
    handler: (req, res) =>
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests, slow down" } }),
  });

const rateLimits = {
  global: () => limiter(60 * 1000, 300, "global"),
  booking: () => limiter(60 * 1000, 20, "booking"),
  reports: () => limiter(60 * 60 * 1000, 20, "reports"),
  verification: () => limiter(60 * 60 * 1000, 10, "verification"),
};

module.exports = { requestId, securityHeaders, corsPolicy, rateLimits };
