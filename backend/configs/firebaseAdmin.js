const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Load the Firebase service-account credential without keeping it in git.
// Preferred: FIREBASE_SERVICE_ACCOUNT_JSON holds the full JSON (or its base64).
// Local fallback: a gitignored file at FIREBASE_SERVICE_ACCOUNT_PATH,
// defaulting to backend/configs/serviceAccountKey.json.
const loadServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const json = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  }

  const filePath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  throw new Error(
    "Firebase service account not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON " +
      "or place the key file at FIREBASE_SERVICE_ACCOUNT_PATH (see backend/.env.example)."
  );
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
  });
}

// Export the admin object for use in other files
module.exports = admin;
