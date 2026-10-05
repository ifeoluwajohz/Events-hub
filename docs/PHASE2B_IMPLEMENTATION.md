# Phase 2B: backend foundation (implementation record)

_Status: implemented on branch `claude/compassionate-brahmagupta-e6hxrg` and tested against local throwaway databases only. **No real or production database has been migrated.**_

The design is in [`PHASE2_ARCHITECTURE.md`](./PHASE2_ARCHITECTURE.md). This document records what was built, where it deviates from the design, and what's left.

## 1. Architecture as built

```
Browser (Clerk) ── Bearer <Clerk session JWT> ──▶ Express
  requestId · security headers · CORS allow-list · JSON 100kb · rate limit
  clerkMiddleware        verifies signature, expiry, authorized party (azp)
  requireUser            Clerk sub → canonical User (create / verified-email legacy link)
  router by audience     /public · /me · /organizer · /admin (requireAdmin mounted once)
  route()                zod validation of params/query/body (unknown fields rejected)
  services               owner-scoped queries, transactions, policy checks, audit rows
  policy/                single source of capabilities, ownership and state transitions
  serializers            allow-list responses (no PII or internals leak)
  errorHandler           { error: { code, message } }, never stack traces or DB internals
```

**Removed:** `firebase-admin`, `jsonwebtoken`, `JWT_SECRET`, the Firebase service account, `/user/*`, `/event/*`, `/search/*`, all legacy controllers, routes and middleware. There's now one authentication system.

## 2. API (all responses: `{ data }` or `{ data, nextCursor }`; errors: `{ error: { code, message, details? } }`)

| Area | Endpoints |
|---|---|
| Public | `GET /public/events?q&location&category&from&to&price=free\|paid&cursor&limit` (published, upcoming; search uses OR across fields), `GET /public/events/:idOrSlug`, `GET /public/organizers/:slug`, `GET /public/categories` |
| Me | `GET/PATCH /me`; `GET/POST /me/bookings` (free only; body `{eventId, items[], idempotencyKey}`), `GET /me/bookings/:id`, `POST /me/bookings/:id/cancel`; `GET /me/tickets`, `GET /me/tickets/:id`; `GET /me/saved-events`, `PUT/DELETE /me/saved-events/:eventId`; `GET /me/follows`, `PUT/DELETE /me/follows/:organizerId`; `GET/POST /me/reports` |
| Organizer | `POST/GET/PATCH /organizer`; `POST /organizer/uploads` (503 until a storage provider exists); `GET /organizer/verification`, `GET /organizer/verification/requirements?country&type`, `POST /organizer/verification/submissions`, `POST …/:id/withdraw`; `GET/POST /organizer/events`, `GET/PATCH /organizer/events/:id`, `POST …/:id/{submit,withdraw,cancel}`, `GET …/:id/history`, `POST …/:id/ticket-types`, `PATCH …/:id/ticket-types/:ticketTypeId`, `POST …/:id/media`, `DELETE …/:id/media/:assetId`, `GET …/:id/attendees`, `POST …/:id/check-in` |
| Admin (non-admins get 404) | `GET /admin/verification-submissions`, `GET …/:id` (audited), `GET …/:id/evidence/:evidenceId` (audited), `POST …/:id/decisions`; `GET /admin/organizers`, `POST /admin/organizers/:id/{suspend,reinstate}`; `GET /admin/events`, `GET /admin/events/:id`, `POST /admin/events/:id/moderation`, `POST /admin/jobs/complete-events`; `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/{suspend,reinstate,platform-role}`; `GET /admin/reports`, `POST /admin/reports/:id/status`; `GET/POST/PATCH /admin/categories`; `GET /admin/audit-logs` |

## 3. Approved decisions: where they are enforced

| Decision | Enforcement | Test |
|---|---|---|
| Legacy link only on verified, exact email; ambiguity refused | `src/auth/currentUser.js`; 409 `ACCOUNT_LINK_CONFLICT` and audit | `auth.test.js` (linked / unverified / different email / taken / takeover) |
| Upcoming legacy events → `PENDING_REVIEW` | backfill migration | `migration.test.js` |
| NGN / Africa/Lagos only where absent | backfill `coalesce`; API requires explicit currency and timezone | `migration.test.js`, `events.test.js` (GHS / Africa/Accra) |
| Free-only booking in 2B | `PAID_CHECKOUT_UNAVAILABLE` | `bookings.test.js` |
| Verification history permanent | append-only and immutability triggers; status derived from history | `verification.test.js` |
| Admin row ≠ verification, admin, paid or publish rights | backfill sets `NOT_STARTED`, `platformRole = USER` | `migration.test.js`, `auth.test.js` |
| No self-promotion to admin | no endpoint; `/me` is strict; CLI bootstrap only | `authorization.test.js` |
| Every event moderated; no `SOLD_OUT` status | `policy.EVENT_TRANSITIONS` (only admin APPROVE → PUBLISHED); sold-out derived | `policy.test.js`, `events.test.js` |
| Expand → backfill → validate; no contract yet | 3 migrations; legacy tables and columns retained | `migration.test.js` |

## 4. Deviations from the Phase 2A proposal (and why)

| Proposal | Built | Reason |
|---|---|---|
| Rename columns (`firebaseUid → legacyFirebaseUid`, `shortDescription → summary`…) | Renamed in Prisma only (`@map`); DB names unchanged | Zero-DDL, so the legacy schema stays intact for the contract phase |
| `EventCategory` composite PK | Keeps its `id` PK plus a unique `(eventId, categoryId)` | Changing a PK is destructive; uniqueness is what mattered |
| Verification status `SUPERSEDED` | Dropped; added `REVOKED`; resubmissions linked by `supersedesId` | Keeping the decided status (REJECTED / CHANGES_REQUESTED) on the old submission preserves history better |
| `TicketStatus` = VALID / CANCELLED | Legacy values AVAILABLE / BOOKED kept in the enum (never written) | Removing enum values is destructive (contract phase) |
| New ticket columns NOT NULL | `ticketTypeId`, `code`, `holderUserId`, `bookingId` remain nullable in the DB; the API always sets them | Legacy FK actions (`SET NULL`) are unchanged until the contract phase |
| Booking at `POST /events/:id/bookings` | `POST /me/bookings` | Keeps all user-owned writes under `/me` |
| Report creation audited | Not audited (reports are their own record) | The audit log is for privileged actions; there is no "user" actor role |
| Admins can create events | Only through their own organizer profile; never moderate their own | Separation of duties (Phase 2A §I) |

## 5. Frontend changes (contract only, no redesign)

- One API client (`src/lib/api.ts`) that sends the Clerk session token. All `localStorage.jwt`, client-sent user IDs and client-sent prices are gone.
- Search, event details, booking (`OrderButton`), my bookings and the ticket page use the new endpoints and field names. Layouts are unchanged.
- **The QR code now encodes the ticket's random code** (it used to be a backend URL containing the booking ID).
- The create-event flow creates an organizer profile when needed, creates the event with a General Admission ticket type, and **submits it for review**. Two inputs were added (number of tickets; price for paid events), and API errors are shown.
- "Admin" in the role picker now reads "Organizer", because "admin" means platform admin.
- Removed: the "Delete all tickets" button (endpoint removed), the dead `CreateEventForm` / `UpdateEventForm` / `EventBookingContext` (unrouted; they called endpoints that never existed).

## 6. Remaining blockers and follow-ups

| Item | Status |
|---|---|
| **Credential rotation (Phase 0)** | **Not done. Production blocker.** See `SECURITY.md` §3. The Firebase service account is no longer used at all, so its keys can simply be deleted. |
| **Production database migration** | **Not performed.** Follow `backend/prisma/README.md`: inspect, back up, rehearse on a restored copy, then deploy. |
| Clerk configuration | Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CORS_ORIGINS` (and optionally `CLERK_JWT_KEY`) on the API host. Admin accounts should enable MFA in Clerk. |
| Storage provider | Undecided. Verification **file** evidence and image uploads return `STORAGE_NOT_CONFIGURED`; required-document verification can't be completed until a provider is chosen. Event images use https URLs meanwhile. |
| Payment provider | Phase 4. Paid ticket types exist and are guarded; checkout is refused. |
| Maps / geocoding | Phase 3. Lat/lng columns exist; "Near me" still shows a fallback message. |
| Clerk webhooks (`user.deleted` / `user.updated`) | Not implemented; profiles sync lazily (hourly) on request. |
| Contract migration (drop legacy tables and columns) | Needs explicit approval after 2B runs in production. |
| Scheduled job | `npm run jobs:complete-events` must be scheduled on the host. |
