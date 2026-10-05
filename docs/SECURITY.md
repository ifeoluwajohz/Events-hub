# Security notes and credential remediation

_Last updated: 2026-10-05 (Phase 2B)._ This file never contains secret values.

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

### 3.1 Firebase service-account key: revoke (no replacement needed)
Since Phase 2B the backend no longer uses Firebase at all (authentication is Clerk), so the leaked key doesn't need a successor.
1. Google Cloud Console → project **theevent-77725** → *IAM & Admin* → *Service accounts*.
2. Open the Firebase Admin SDK service account → *Keys*. **Delete every key**, including the one committed here. Don't create a new one.
3. Check the service account's audit logs (Cloud Logging) for activity since **2024-12-20** that you don't recognise.
4. Remove `FIREBASE_SERVICE_ACCOUNT_*` from your hosting env and delete any local `serviceAccountKey.json`.

### 3.2 Everything that was in `.env`
For each value that was in the committed `.env`:
- **Database (`DATABASE_URL`)**: change the DB user's password at your provider, or create a new user and drop the old one. Update `DATABASE_URL` in hosting. If the provider supports it, restrict network access.
- **`JWT_SECRET`**: no longer used since Phase 2B. Remove it from hosting; no replacement needed.
- **Clerk secret key (`sk_…`)**, if present: Clerk Dashboard → *API Keys* → **roll the secret key**. This is now critical: since Phase 2B the backend trusts Clerk for every request. Then set `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` on the API host.
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

## 6. Phase 2 security status

Fixed in Phase 2B (verified by `backend/test/*.test.js`):

- **One auth system.** The backend verifies Clerk session tokens (signature, expiry, authorized party) and derives the user from them. Firebase verification and the custom JWT are removed.
- **No client-supplied identity.** User, organizer, role and price are never taken from the request. Unknown body fields are rejected.
- **Ownership checks.** Bookings, tickets, events and verification data are loaded through owner-scoped queries; other people's resources return 404.
- **No self-promotion.** Platform admin is granted only by the `admin:grant` CLI or by an existing admin; every change is audited, and the last admin can't be removed.
- **Admin routes.** A single guarded router; non-admins get 404.
- **Booking.** Server-side pricing, an atomic conditional inventory update (no overselling under concurrency), and idempotency keys.
- **Everything else.** The unauthenticated delete and update endpoints, `switchRole` and bulk booking deletion are gone. CORS is an exact allow-list without credentials; security headers, rate limits and zod validation are in place; errors never expose stack traces or database messages.
- **Verification evidence.** Admin-only, every view audited (including failed ones), and never public. The append-only triggers protect the history and audit tables.

Still open:
- **Credential rotation (section 3)**: production blocker.
- **Admin MFA**: enable it in Clerk for every admin account (configuration, not code).
- **Clerk webhooks** for `user.deleted` / `user.updated`: profiles currently sync lazily.
- **Evidence retention policy** (delete files N days after a final decision): needs legal input; no files can be stored until a storage provider is chosen.
- **Rate limits are in memory**, so they apply per instance. Use a shared store if the API is scaled horizontally.
