// Clerk is the only identity provider. This module is the boundary: it verifies
// the session token (clerkMiddleware) and looks up profile data by Clerk user id.
const { clerkMiddleware, getAuth, createClerkClient } = require("@clerk/express");

/**
 * @typedef {{ email: string | null, emailVerified: boolean, name: string | null, avatarUrl: string | null }} IdentityProfile
 * @typedef {{
 *   middleware: import("express").RequestHandler,
 *   getSubject: (req: import("express").Request) => string | null,
 *   getProfile: (clerkUserId: string) => Promise<IdentityProfile>,
 * }} IdentityProvider
 */

/**
 * @param {{ secretKey: string, publishableKey: string, jwtKey?: string, authorizedParties: string[] }} clerk
 * @param {{ getProfile?: IdentityProvider["getProfile"] }} [overrides] tests replace only the profile lookup
 * @returns {IdentityProvider}
 */
function createClerkIdentity(clerk, overrides = {}) {
  const clerkClient = createClerkClient({ secretKey: clerk.secretKey, publishableKey: clerk.publishableKey });

  /** @type {IdentityProvider["getProfile"]} */
  const getProfile = async (clerkUserId) => {
    const u = await clerkClient.users.getUser(clerkUserId);
    const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) || null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    return {
      email: primary ? primary.emailAddress.trim().toLowerCase() : null,
      emailVerified: Boolean(primary && primary.verification && primary.verification.status === "verified"),
      name: name || null,
      avatarUrl: u.imageUrl || null,
    };
  };

  return {
    middleware: clerkMiddleware({
      clerkClient,
      secretKey: clerk.secretKey,
      publishableKey: clerk.publishableKey,
      jwtKey: clerk.jwtKey,
      authorizedParties: clerk.authorizedParties.length ? clerk.authorizedParties : undefined,
    }),
    getSubject: (req) => getAuth(req).userId || null,
    getProfile: overrides.getProfile || getProfile,
  };
}

module.exports = { createClerkIdentity };
