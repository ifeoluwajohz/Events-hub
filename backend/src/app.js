const express = require("express");
const { requestId, securityHeaders, corsPolicy, rateLimits } = require("./http/security");
const { errorHandler, notFoundHandler } = require("./http/errors");
const { publicRouter } = require("./routes/public");
const { meRouter } = require("./routes/me");
const { organizerRouter } = require("./routes/organizer");
const { adminRouter } = require("./routes/admin");

/**
 * @param {{ config: ReturnType<typeof import("./config").loadConfig>, identity: import("./auth/identity").IdentityProvider, log?: (entry: object) => void }} deps
 */
function createApp({ config, identity, log }) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(requestId);
  app.use(securityHeaders(config));
  app.use(corsPolicy(config));
  app.use(express.json({ limit: "100kb" }));
  app.use(rateLimits.global());
  // Verifies the Clerk session token when present; routes decide whether one is required.
  app.use(identity.middleware);

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use("/public", publicRouter());
  app.use("/me", meRouter(identity));
  app.use("/organizer", organizerRouter(identity));
  app.use("/admin", adminRouter(identity));

  app.use(notFoundHandler);
  app.use(errorHandler({ log }));
  return app;
}

module.exports = { createApp };
