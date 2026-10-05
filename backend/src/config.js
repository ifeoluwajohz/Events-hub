// Environment configuration. Fails fast in production when required values are missing.

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * @param {NodeJS.ProcessEnv} env
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";

  const config = {
    nodeEnv,
    isProduction,
    port: Number(env.PORT) || 4000,
    // Exact origins allowed by CORS. Production must list them explicitly.
    corsOrigins: list(env.CORS_ORIGINS),
    trustProxy: env.TRUST_PROXY === "true",
    clerk: {
      secretKey: env.CLERK_SECRET_KEY || "",
      publishableKey: env.CLERK_PUBLISHABLE_KEY || "",
      // Optional PEM public key: verifies session tokens without a network call.
      jwtKey: env.CLERK_JWT_KEY ? env.CLERK_JWT_KEY.replace(/\\n/g, "\n") : undefined,
      // Origins allowed to have issued the session token (Clerk "azp" claim).
      authorizedParties: list(env.CLERK_AUTHORIZED_PARTIES || env.CORS_ORIGINS),
    },
  };

  if (isProduction) {
    const missing = [];
    if (!config.clerk.secretKey) missing.push("CLERK_SECRET_KEY");
    if (!config.clerk.publishableKey) missing.push("CLERK_PUBLISHABLE_KEY");
    if (config.corsOrigins.length === 0) missing.push("CORS_ORIGINS");
    if (!env.DATABASE_URL) missing.push("DATABASE_URL");
    if (missing.length) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
  } else if (config.corsOrigins.length === 0) {
    config.corsOrigins = ["http://localhost:5173"];
  }

  return config;
}

module.exports = { loadConfig };
