# Security notes and credential remediation

_Last updated: 2026-10-03 (Phase 0)._ This file never contains secret values.

## 1. Incident summary

Credentials were committed to this repository and pushed to GitHub. **Treat every one of them as compromised.** Removing them from the current files doesn't make them safe, because **they remain in git history** (see section 4), and anyone who cloned or forked the repo already has them.

| Location (as committed) | Credential type | In git since | Status |
|---|---|---|---|
| `.env` (repo root) | Environment secrets (contents not inspected; assume DB URL, JWT secret and any API keys) | `b2d1fa1`, 2024-12-05 | Untracked in Phase 0. **Still in history** |
| `backend/configs/serviceAccountKey.json` | **Firebase Admin service-account private key** (project `theevent-77725`) | `4f52a9e`, 2024-12-20 | Untracked in Phase 0. **Still in history** |
| `frontend/src/context/EventContext.tsx` | OpenCage geocoding API key (hard-coded) | `b4ec42a`, 2025-01-06 | Removed from source. **Still in history** |
| `frontend/src/components/EventSearchByLocation.tsx` | Same OpenCage key | same | Dead file deleted. **Still in history** |
| `frontend/src/config/firebaseConfig.ts` | Firebase **web** config (`apiKey`, `appId`, …) | — | Dead file deleted. Not a secret by design, but see 3.4 |

The Clerk **publishable** key (`pk_…`) is public by design and is read from env, so it isn't on this list.

## 2. What Phase 0 changed

- `git rm --cached` on `.env` and `backend/configs/serviceAccountKey.json`, so they're no longer tracked. Local copies are left on disk and are now ignored.
- `.gitignore` now ignores `.env`, `.env.*` (except `.env.example`), `serviceAccountKey.json`, `*service-account*.json`, `*.pem` and `*.p12`.
- `backend/configs/firebaseAdmin.js` is now the single place the Firebase Admin SDK is initialised. It reads the key from `FIREBASE_SERVICE_ACCOUNT_JSON` (raw JSON or base64), or from a file at `FIREBASE_SERVICE_ACCOUNT_PATH` outside git. `UserController.js` uses it instead of `require`-ing the key file. Token verification logic is unchanged.
- The OpenCage key was removed from the frontend. The "📍 Near me" button now shows *"Searching by your current location isn't available yet. Please type your city instead."* In practice it never returned results anyway: it searched venues for the full street address. Geocoding will move behind the backend (Phase 3), so no key ships to browsers.
- `frontend/.env.example` and `backend/.env.example` list every variable the code reads, with no values.
- CI (`.github/workflows/ci.yml`) has a `secrets-guard` job that fails if an env or service-account file is ever tracked again.

**Not done (needs you; see section 3):** no credential has been revoked or rotated, and git history has not been rewritten.

## 3. Required actions (owner)

Do these **before** the next deploy. Order matters: rotate first, then update your hosting env vars.

> ⚠️ **Before you `git pull` this branch:** pulling a commit that untracks a file **deletes your local copy**. If you still need your local `.env` or key file, copy them somewhere outside the repo first. You're replacing their values anyway.

### 3.1 Firebase service-account key: revoke and replace
1. Google Cloud Console → project **theevent-77725** → *IAM & Admin* → *Service accounts*.
2. Open the Firebase Admin SDK service account → *Keys*. **Delete every existing key**, including the one committed here.
3. *Add key → Create new key → JSON*. Store it in a password manager. **Don't put it in the repo.**
4. Hosting: set `FIREBASE_SERVICE_ACCOUNT_JSON` to the JSON or its base64 (`base64 -w0 key.json`). Local dev: save it outside the repo and set `FIREBASE_SERVICE_ACCOUNT_PATH`, or place it at `backend/configs/serviceAccountKey.json` (gitignored).
5. Check the service account's audit logs (Cloud Logging) for activity since **2024-12-20** that you don't recognise.

### 3.2 Everything that was in `.env`
For each value that was in the committed `.env`:
- **Database (`DATABASE_URL`)**: change the DB user's password at your provider, or create a new user and drop the old one. Update `DATABASE_URL` in hosting. If the provider supports it, restrict network access.
- **`JWT_SECRET`**: generate a new one (`openssl rand -base64 48`). This logs out every existing session, which is intended.
- **Clerk secret key (`sk_…`)**, if present: Clerk Dashboard → *API Keys* → roll the secret key.
- **Any other API keys** in that file: revoke and reissue at each provider.

### 3.3 OpenCage API key
OpenCage dashboard → *API keys* → delete the exposed key. When geocoding moves to the backend, create a new key and keep it server-side only (`OPENCAGE_API_KEY` in backend env).

### 3.4 Firebase web config (lower priority)
Firebase web API keys identify the project and aren't secrets, but since this project is being retired in favour of Clerk, check Firebase Console → *Authentication* and *Security Rules* for anything left open. If Firebase Auth is no longer needed once Phase 2 lands, disable it.

### 3.5 GitHub
- Check *Settings → Security → Secret scanning* alerts on the repo and close them once rotated.
- Check *Insights → Forks*. Forks keep the leaked history; rotation is the only real fix.

## 4. Git history

The credentials are **still present in git history** on `main` and on this branch (first commits: `b2d1fa1`, `4f52a9e`, `b4ec42a`). Phase 0 deliberately **did not** rewrite history, because that requires a force-push and coordination with everyone who has a clone.

Once rotation is done, the old values are useless, so history cleanup is optional hygiene. If you want it, approve it explicitly. The process is roughly: `git filter-repo --invert-paths --path .env --path backend/configs/serviceAccountKey.json` plus `--replace-text` for the OpenCage key, then a coordinated force-push of every branch, then asking GitHub Support to purge cached views.

## 5. Secret-handling rules (going forward)

1. Real values live only in a local `.env` / `.env.local` (gitignored) or the hosting provider's env settings.
2. Add every new variable to the matching `.env.example` with **no value**.
3. Anything prefixed `VITE_` is shipped to every browser. **Never put a secret behind `VITE_`.** Third-party calls that need a secret key go through the backend.
4. Don't paste secrets into issues, PRs, commit messages or logs.
5. If a secret leaks: rotate first, clean up second.

## 6. Security work deferred to Phase 2

These are known, documented in `docs/AUDIT.md` §2, and **intentionally not fixed in Phase 0/1**:

- **Auth migration:** the backend still verifies Firebase ID tokens and mints its own JWT; the frontend uses Clerk and never stores that JWT, so authenticated API calls send `Bearer null`. Fix: `@clerk/express` on the backend. This also retires the Firebase service account entirely.
- `DELETE /event/delete/:id` is **unauthenticated**.
- `PUT /user/switchRole` lets any user become ADMIN; `AdminMiddleware` never checks the role.
- IDOR: booking read/delete endpoints trust the `:id` in the URL rather than the authenticated user.
- `PUT /user/updateUser/:id` is unauthenticated.
- Booking and review endpoints trust client-sent `userId` and `totalAmount`.
- Booking is not atomic (overselling race).
- `cors({ origin: '*', credentials: true })`, no helmet, no rate limiting, no input validation; raw error messages returned to clients.
- `AdminController.js` (not mounted) still initialises its own Firebase app from a non-existent path. Remove or rewire it when admin routes are rebuilt.
- `/accountconfig` profile editing and role switching were removed from the UI in Phase 1 (they depended on a deleted Firebase `AuthContext` and crashed). They'll come back on top of the Clerk-backed API.
