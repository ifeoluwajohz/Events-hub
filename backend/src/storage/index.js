// Provider-neutral storage boundary. FileAsset rows record (storageProvider, storageKey,
// visibility); a provider adapter turns them into upload targets and URLs.
// No provider has been chosen yet (ROADMAP open decision), so only "external-url"
// (public image URLs, including migrated legacy pictures) is supported.
const { AppError } = require("../http/errors");

const storageNotConfigured = () =>
  new AppError(503, "STORAGE_NOT_CONFIGURED", "File uploads are not available yet");

/**
 * Public URL for an asset, or null when it is not publicly servable.
 * @param {{ storageProvider: string, storageKey: string, visibility: string, status: string }} asset
 */
function publicUrl(asset) {
  if (asset.visibility !== "PUBLIC" || asset.status !== "READY") return null;
  if (asset.storageProvider === "external-url") return asset.storageKey;
  return null;
}

/**
 * Short-lived URL for a PRIVATE asset (verification evidence). Requires a provider.
 * Callers must authorize and audit BEFORE calling this.
 * @param {{ storageProvider: string }} asset
 * @returns {Promise<{ url: string, expiresAt: Date }>}
 */
async function signedReadUrl(asset) {
  void asset;
  throw storageNotConfigured();
}

/**
 * Upload intent for a new private/public file. Requires a provider.
 * @returns {Promise<never>}
 */
async function createUploadIntent() {
  throw storageNotConfigured();
}

module.exports = { publicUrl, signedReadUrl, createUploadIntent, storageNotConfigured };
