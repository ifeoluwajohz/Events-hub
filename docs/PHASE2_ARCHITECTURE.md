# Phase 2A: data model and backend architecture proposal

_Status: **proposal, awaiting approval.** Nothing in `backend/` has been changed. Date: 2026-10-05._

Companion files:
- [`phase2/proposed-schema.prisma`](./phase2/proposed-schema.prisma): the full proposed schema. It passes `prisma validate` and isn't wired into the app.
- [`phase2/inspect-db.sql`](./phase2/inspect-db.sql): a **read-only** script that reports the real database's shape (counts and column names only, no personal data). Section O explains why it's needed.

Authoritative product direction: [`ROADMAP.md`](./ROADMAP.md).

---

## Contents

A. Current schema assessment · B. Proposed domain model · C. Entity relationships · D. Proposed models and enums · E. Migration strategy · F. Existing-data migration · G. Authentication · H. Authorization · I. Authorization matrix · J. API contract changes · K. Indexing · L. Constraints and invariants · M. Security · N. Testing · O. Risks and decisions · P. Phase 2 implementation sequence

---

## A. Current schema assessment

### A.1 Method

I replayed all five committed migrations into a throwaway local PostgreSQL 16 database, loaded a small fixture, and used `prisma migrate diff` to compare that database with `schema.prisma` and with the proposal. No real database was touched.

### A.2 Headline finding: `schema.prisma` doesn't match the migrations

`schema.prisma` was edited (towards Clerk) **without generating a migration**. The migration history and the controllers agree with each other, but the schema doesn't match either:

| Concept | Migrations, and what the controllers use | `schema.prisma` today |
|---|---|---|
| External identity | `User.firebaseUid` | `User.ClerkId` |
| User names | `name`, `prefferedName` (unique), `profilePicture` (NOT NULL) | `Fullname`, `Username` |
| Event text | `shortDescription`, `longDescription` | `preview`, `description` |
| Event owner | `Event.adminId` → `Admin.userId` | `Event.AdminId` → `Admin.id` |
| Event images | `Picture` table, `Event.pictureId` | `EventImages` table, `Event.ImageId` |
| Capacity | **dropped** in migration 2 | `capacity` present |

The consequences:
- The Prisma client is generated from `schema.prisma`, so every controller query that uses the migration column names throws at runtime.
- **Running `prisma migrate dev` today would generate a destructive migration.** It would drop `firebaseUid`, `email`, `name`, `profilePicture`, the event descriptions, `adminId`, and the `Picture` table. Its new NOT NULL columns would also fail on any table that has rows.
- **The real database's shape is unknown.** It probably matches the migrations, but if someone ran `prisma db push`, it could match `schema.prisma` instead. This is the main blocker (O.1).

### A.3 Models (as built by migrations)

| Model | Purpose today | Problems |
|---|---|---|
| `User` | Account created by `/user/loginUser` from a Firebase token | `firebaseUid` identity; `profilePicture` NOT NULL but code writes null; `prefferedName` globally unique; `role` used as "can create events" |
| `Admin` | 1:1 with User. **Owns events** | `loginUser` creates an Admin row for **every** new user, so Admin rows don't identify organizers. No fields beyond timestamps |
| `Event` | Event plus inline price and inventory | `eventType`, `price` (Float) and `availableTickets` inline; no status, slug, timezone, end time, location fields or currency; capacity lost |
| `Picture` | Display URL plus preview URLs | Not provider-aware; no ownership |
| `Booking` | Order header | `totalAmount` Float, trusted from the client; `quantity` inline; `isActive`/`refundStatus` unused; status never moves past PENDING |
| `Ticket` | Pre-generated inventory slots (`AVAILABLE`/`BOOKED`) | **Never created by any mounted code.** The concept doesn't match an issued QR credential |
| `Category` / `EventCategory` | Taxonomy | No `(eventId, categoryId)` uniqueness; no slug; the controller writes `categories: { connect }` (wrong for a join model) |
| `EventReview` | Attendee star ratings | Name collides with "event review" (moderation); POST route is behind `AdminMiddleware` and trusts `userId` from the body |
| `Payment`, `DiscountCode` | Unused | Float money |
| Enums | `Role`, `TicketStatus`, `PaymentStatus`, `EventType`, `BookingStatus`, **`EventStatus` (unused)**, **`AttendanceStatus` (unused)** | |

There are also redundant indexes: `Event_id_key` and `Picture_id_key` (both duplicate the PK), `Category_name_idx` (duplicates the unique index), and the 5-column `Event(adminId, title, date, venue, shortDescription)` index, which serves no query.

### A.4 Authentication today

| Layer | Behaviour |
|---|---|
| Frontend | Clerk (`@clerk/clerk-react`). Sends `Bearer ${localStorage.jwt}`, **which nothing ever sets**, so every protected call sends `Bearer null` |
| Frontend → backend login | **No frontend code calls `/user/loginUser`.** Since the Clerk switch, the app can't create `User` rows at all |
| Backend | `/user/loginUser` verifies a **Firebase** ID token and mints its own 7-day HS256 JWT (`JWT_SECRET`). `UserMiddleware`/`AdminMiddleware` verify that JWT |
| Unused | `@clerk/express` is installed but never imported. `AdminController.js` re-initialises Firebase from a path that doesn't exist, and `AdminRoute`/`TicketRoute` aren't mounted |
| ID mismatch | The frontend sends Clerk ids (`user_…`) as `userId` and in URLs, but the DB uses cuid `User.id` |

### A.5 Authorization today

| Endpoint | Guard | Real check | Hole |
|---|---|---|---|
| `DELETE /event/delete/:id` | **none** | none | Anyone deletes any event |
| `PUT /user/switchRole` | user JWT | none | Any user becomes ADMIN (= event creator) |
| `PUT /user/updateUser/:id` | **none** | none | Unauthenticated write (and broken: `data: { userData }`) |
| `GET /event/:id/bookedAll` | user JWT | uses URL `:id` | Read anyone's bookings |
| `DELETE /event/:id/bookedDelete` | user JWT | uses URL `:id` | Delete anyone's bookings (inventory isn't restored) |
| `GET /event/:id/bookedOne`, `DELETE /event/:id/cancelTicket` | user JWT | none | Read/cancel any booking |
| `POST /event/:id/bookings` | user JWT | trusts `userId` and `totalAmount` from the body | Book as another user, at any price; overselling race |
| `POST /event/create` | `AdminMiddleware` | **doesn't check role** | Any JWT holder creates events |
| `POST /event/:id/reviews` | `AdminMiddleware` | trusts body `userId` | Wrong guard; impersonation |

The fix is structural: identity comes only from the verified session; ownership is checked by scoped queries; capabilities come from the DB.

### A.6 Event and booking lifecycles today

- **Event:** there's no lifecycle. An event is public from the moment it's inserted and can be hard-deleted.
- **Booking:** `PENDING` forever. It's created and inventory is decremented in two separate statements (a race); deleting restores inventory, while bulk delete doesn't. No tickets are issued, and the QR page encodes the booking id.

### A.7 Data that a migration would lose or transform

| Item | Treatment proposed |
|---|---|
| `Admin` rows | Only rows **owning ≥1 event** become `Organizer`s; the rest (artefacts of `loginUser`) are dropped. They hold only timestamps, so nothing meaningful is lost |
| `User.role = ADMIN` | **Not** carried over as platform admin (it meant "event creator"). Everyone starts as `platformRole = USER` |
| `Event.price` (Float, major units) | → `TicketType.priceMinor` (integer minor units), rounding half-up to 2dp. The inspection script counts any rows with >2dp |
| `eventType` + `price` + `availableTickets` | → one "General admission" `TicketType` per event; `quantityTotal = availableTickets + booked`, `quantitySold = booked` |
| Original capacity | **Already lost** (dropped in migration `20241231072753`). Reconstructed as above |
| `Picture` | → `FileAsset` (`storageProvider = "external-url"`, URL as the key) plus `EventMedia` (COVER/GALLERY). Nothing lost |
| `prefferedName` uniqueness | Dropped (display names aren't identities). Value kept as `displayName` |
| `firebaseUid` | Renamed `legacyFirebaseUid`, kept for one-time account linking (G.5), dropped later |
| `Ticket` rows | Expected to be empty (no code creates them). If any `AVAILABLE` rows exist, they're unsold placeholders and would be deleted. **Stop if count > 0** |
| `Booking.isActive`, `refundStatus` | Unused. Dropped only if the inspection shows they're all default/null |
| `EventReview` | Renamed `EventRating`, no data loss |

---

## B. Proposed domain model

The domain splits into six bounded areas. Every model below exists because a ROADMAP feature depends on it.

| Model | Why it exists | Owner | Mutable? | Lifecycle | Feature that needs it |
|---|---|---|---|---|---|
| `User` | Canonical application account, linked to Clerk | self (profile fields), admin (status/role) | mutable | ACTIVE ↔ SUSPENDED → DEACTIVATED | everything |
| `PlatformRole` (enum on `User`) | Platform admin capability | admin service / CLI only | mutable, **audited** | USER ↔ ADMIN | admin console |
| `Organizer` | Optional capability that **owns events**. Separate from User so teams (`OrganizerMember`) can be added later without moving events | `ownerUserId` | mutable | status ACTIVE ↔ SUSPENDED; verification NOT_STARTED → … | organizer onboarding, profile, dashboard |
| `OrganizerStatusChange` | Suspension/reinstatement history | admin | **historical, append-only** | — | admin organizer management |
| `VerificationSubmission` | One immutable verification attempt with a country/requirement snapshot | organizer | status only | SUBMITTED → UNDER_REVIEW → APPROVED / REJECTED / CHANGES_REQUESTED; WITHDRAWN; SUPERSEDED by resubmission | organizer verification |
| `VerificationEvidence` | Evidence items within a submission (file or declared value) | organizer | **immutable** | — | verification, admin review |
| `VerificationDecision` | Review history: who, what, when, why | admin | **append-only** | — | admin verification queue, audit |
| `FileAsset` | Provider-neutral file record (public images, private evidence) | uploader | status only | PENDING_UPLOAD → READY → DELETED | media upload, verification documents |
| `Event` | The event, with an explicit lifecycle | organizer | mutable (state-gated) | see the state machine below | discovery, details, management |
| `EventMedia` | Ordered cover and gallery images | organizer (via event) | mutable | — | event details, cards |
| `Category` / `EventCategory` | Admin-managed taxonomy | admin / organizer | mutable | active flag | browse by category |
| `EventModerationAction` | **Every** event status transition: actor, reason, from/to | organizer / admin / system | **append-only** | — | moderation, organizer feedback, audit |
| `TicketType` | Price, inventory and sales window per tier; carries the free/paid distinction | organizer | mutable (state-gated) | ACTIVE / HIDDEN / ARCHIVED | ticketing, checkout, paid-ticket rule |
| `Booking` + `BookingItem` | Order with a server-computed price snapshot | attendee | status only | PENDING → CONFIRMED / CANCELLED / EXPIRED | checkout, my bookings |
| `Ticket` | **Issued** admission credential with an unguessable QR code and check-in state | attendee (holder) | status + check-in | VALID → CANCELLED; checkedInAt | my tickets, QR, check-in |
| `SavedEvent` | Saved events | attendee | create/delete | — | saved events, recommendations |
| `OrganizerFollow` | Following organizers | attendee | create/delete | — | follow, recommendations |
| `Report` | User reports against an event, organizer or user | reporter → admin | status | OPEN → UNDER_REVIEW → ACTION_TAKEN / DISMISSED | trust & safety, admin reports |
| `AuditLog` | Cross-cutting record of every privileged action | system | **append-only** | — | admin audit, incident response |
| `EventRating` | Renamed `EventReview` (attendee stars) | attendee | mutable | — | later: post-event ratings |
| `Payment`, `DiscountCode` | Kept unchanged; reworked in Phase 4 | — | — | — | checkout (Phase 4) |

**Why reuse vs. new:**
- **Reused:** `User`, `Event`, `Booking`, `Ticket`, `Category`, `EventCategory`, `Payment`, `DiscountCode`. They're reshaped in place, preserving IDs (booking IDs appear in ticket URLs).
- **Replaced:** `Admin` → `Organizer`. Its semantics were wrong and it has no data worth keeping beyond ownership.
- **Migrated:** `Picture` → `FileAsset` + `EventMedia`. The existing model can't represent private files or providers.

### B.1 Event lifecycle (the API enforces it; the DB records every step)

```
          submit (organizer)            approve (admin)
 DRAFT ───────────────────▶ PENDING_REVIEW ─────────────▶ PUBLISHED ──(endsAt passed, job)──▶ COMPLETED
   ▲   ◀─────────────────────    │  │                         │  │
   │     withdraw (organizer)    │  │ request_changes/reject  │  │ suspend (admin)
   │                             │  └──────▶ DRAFT            │  ▼
   │                             │      (reason recorded)     │ SUSPENDED ──reinstate (admin)──▶ PUBLISHED
   └─────────────────────────────┘                            │
                                     cancel (organizer/admin) ▼
                         DRAFT / PENDING_REVIEW / PUBLISHED ──▶ CANCELLED (terminal)
```

- **There is no path to `PUBLISHED` except an admin `APPROVE`.** Verified organizers may later get a *faster queue* (prioritised by `Organizer.verificationStatus`), but never a bypass.
- `REJECT` and `REQUEST_CHANGES` both return the event to `DRAFT`, and the moderation record says which happened. I didn't add a separate `REJECTED` event status (O.6).
- **Sold out is derived:** every ACTIVE ticket type has `quantitySold = quantityTotal`. It's never stored.

### B.2 Verification lifecycle

```
NOT_STARTED ──submit──▶ PENDING ──(admin START_REVIEW: submission UNDER_REVIEW)──▶ ┬─ APPROVE ──────────▶ VERIFIED ──REVOKE──▶ REJECTED
                           ▲                                                      ├─ REQUEST_CHANGES ─▶ CHANGES_REQUESTED ─┐
                           └────────────── resubmit (new submission, supersedes previous) ◀────────────────────────────────┤
                                                                                  └─ REJECT ──────────▶ REJECTED ──────────┘
```

Suspension is held **separately**, on `Organizer.status` (ACTIVE/SUSPENDED) with its own history. The API exposes an **effective status** that matches the roadmap's five values: `NOT_STARTED | PENDING | VERIFIED | REJECTED | SUSPENDED`, plus `CHANGES_REQUESTED`. O.5 explains why storage differs from presentation.

---

## C. Entity relationships

```
User 1──0..1 Organizer 1──* Event 1──* TicketType 1──* BookingItem *──1 Booking *──1 User
 │              │  │          │  └──* EventMedia *──1 FileAsset        │
 │              │  │          ├──* EventCategory *──1 Category          └──* Ticket (holder → User, type → TicketType)
 │              │  │          ├──* EventModerationAction (actor → User)
 │              │  │          ├──* SavedEvent *──1 User
 │              │  │          └──* Report
 │              │  ├──* VerificationSubmission 1──* VerificationEvidence ──0..1 FileAsset (PRIVATE)
 │              │  │        └──* VerificationDecision (reviewer → User[ADMIN])
 │              │  ├──* OrganizerStatusChange (actor → User[ADMIN])
 │              │  └──* OrganizerFollow *──1 User
 └──* AuditLog (actor)
```

- **Ownership chain:** `Event.organizerId → Organizer.ownerUserId → User`. Ownership of ticket types, media, moderation history, attendees and tickets flows through the event. There's no `userId` on `Event`.
- **FK delete behaviour:**
  - `Restrict` everywhere history matters. Events, users and organizers are never hard-deleted once anything references them.
  - `Cascade` only for pure join rows (`SavedEvent`, `OrganizerFollow`, `EventCategory`, `EventMedia`).
  - `SetNull` for optional pointers (logo, `checkedInBy`).

---

## D. Proposed models and enums

The full, validated Prisma source is in [`phase2/proposed-schema.prisma`](./phase2/proposed-schema.prisma). Summary of the enums:

| Enum | Values | Replaces |
|---|---|---|
| `PlatformRole` | USER, ADMIN | `Role` (whose ADMIN meant event creator) |
| `UserStatus` | ACTIVE, SUSPENDED, DEACTIVATED | — |
| `OrganizerType` | INDIVIDUAL, BUSINESS, NON_PROFIT | — |
| `OrganizerStatus` | ACTIVE, SUSPENDED | — |
| `OrganizerVerificationStatus` | NOT_STARTED, PENDING, CHANGES_REQUESTED, VERIFIED, REJECTED | — |
| `VerificationSubmissionStatus` | SUBMITTED, UNDER_REVIEW, CHANGES_REQUESTED, APPROVED, REJECTED, WITHDRAWN, SUPERSEDED | — |
| `EvidenceKind` | GOVERNMENT_ID, BUSINESS_REGISTRATION, PROOF_OF_ADDRESS, TAX_ID, WEB_PRESENCE, SOCIAL_PROFILE, OTHER | — |
| `VerificationAction` | START_REVIEW, APPROVE, REQUEST_CHANGES, REJECT, REVOKE | — |
| `AssetPurpose` / `AssetVisibility` / `AssetStatus` | EVENT_IMAGE, ORGANIZER_LOGO, VERIFICATION_EVIDENCE / PUBLIC, PRIVATE / PENDING_UPLOAD, READY, DELETED | `Picture` |
| `EventStatus` | DRAFT, PENDING_REVIEW, PUBLISHED, CANCELLED, SUSPENDED, COMPLETED | unused `EventStatus` (UPCOMING…) |
| `AttendanceMode` | IN_PERSON, ONLINE, HYBRID | — (also feeds schema.org SEO) |
| `ModerationAction` | SUBMIT, WITHDRAW, APPROVE, REQUEST_CHANGES, REJECT, SUSPEND, REINSTATE, CANCEL, COMPLETE, MIGRATED | — |
| `ActorRole` | ORGANIZER, ADMIN, SYSTEM | — |
| `TicketTypeStatus` | ACTIVE, HIDDEN, ARCHIVED | `EventType` |
| `BookingStatus` | PENDING, CONFIRMED, CANCELLED, **EXPIRED** | adds a value |
| `TicketStatus` | VALID, CANCELLED (check-in is `checkedInAt`) | AVAILABLE/BOOKED/CANCELLED |
| `ReportReason` / `ReportStatus` | SCAM_OR_FRAUD … OTHER / OPEN, UNDER_REVIEW, ACTION_TAKEN, DISMISSED | — |
| (dropped) | `AttendanceStatus`, `EventType`, `Role` | |

**Country-aware verification without a Nigeria-shaped table:**
- Requirements live in a **versioned requirement-set config** keyed by `(country, organizerType)`. For example, `NG-BUSINESS@2026-10` requires `gov_id` + `business_registration` + `web_presence`, with a `DEFAULT` set as the fallback.
- Each submission stores `country`, `organizerType` and `requirementSetVersion`, so a decision can always be explained against the rules that applied at the time.
- Evidence rows are generic: `requirementKey`, `kind`, and either a file or a declared value.
- Declared business details go in `declaredData` (JSON, admin-only) rather than country-specific columns.
- The config can move into a DB table when the admin settings UI exists (Phase 5). That's cheap, because rows reference requirement keys as strings.

**"Evidence considered" by a decision:** submissions are immutable once submitted, and changes require a new submission. So a decision → its submission → that submission's evidence set is exactly what the reviewer saw. That needs no extra join table.

**Provider-neutral storage boundary:**
- `FileAsset` stores `storageProvider` + `storageKey` + `visibility`. The API will issue *upload intents* and *signed read URLs* through a small `StorageAdapter` interface, so choosing S3, R2, Cloudinary or similar later only means adding an adapter.
- Migrated `Picture` URLs use `storageProvider = "external-url"`.

---

## E. Migration strategy

**Never on any shared database:** `migrate reset`, `db push`, `--accept-data-loss`, or `migrate dev`. Prisma would auto-generate the destructive script measured in A.2/E.1.

### E.1 Why it must be hand-written

Diffing the current migrated database against the proposal with `prisma migrate diff` produces a 676-line script that **drops 3 tables (`Admin`, `Picture`, `EventReview`) and 22 columns**. Prisma reads renames as drop-and-add. So migrations are created with `prisma migrate dev --create-only` against a **local** database, then hand-edited.

### E.2 Steps

| Step | Kind | Contents | Reversible |
|---|---|---|---|
| **M0 Baseline realignment** | none (schema file only) | Rewrite `schema.prisma` to describe exactly what the migrations built, then confirm `migrate diff` is **empty**. This fixes the drift without touching the DB. If the real DB turns out to be in the `db push` shape, we baseline from introspection instead (`migrate resolve --applied`) | yes |
| **M1 Expand** | additive | New enums and tables; new **nullable** columns; `ALTER … RENAME COLUMN` for pure renames (`firebaseUid→legacyFirebaseUid`, `shortDescription→summary`, `longDescription→description`, `date→startsAt`, `venue→venueName`, `profilePicture→avatarUrl` + DROP NOT NULL); `EventReview→EventRating` table rename; `BookingStatus ADD VALUE 'EXPIRED'` | yes (down-script) |
| **M2 Backfill** | data, idempotent | Section F, inside one transaction, ending with verification queries that **raise an exception** (and roll back) if any invariant fails | yes (in-transaction) |
| **M3 Tighten** | constraints | NOT NULL on backfilled columns (`Event.organizerId`, `slug`, `timezone`, `currency`, `Booking.totalMinor`…); CHECK constraints; append-only triggers; new indexes; drop the redundant indexes | yes |
| **M4 Contract** | **destructive** | Drop `Admin`, `Picture`, `Event.adminId/eventType/price/availableTickets/pictureId`, `User.role`, `Booking.quantity/totalAmount/isActive/refundStatus`, old enums. Rebuild `TicketStatus` | **no**: separate release, **explicit approval**, after a backup and a week of running |

M1–M3 ship together with the new code (2B). The app is pre-launch and has no working write paths, so I'm not proposing dual-write expand/contract. M4 is deliberately later.

### E.3 Rehearsal protocol (before any real database)

1. Owner runs `phase2/inspect-db.sql` (read-only) and shares the output (counts only).
2. `pg_dump` the real DB, then restore it into a local or staging database. **Never rehearse on production.**
3. `prisma migrate deploy` M1–M3 against the restored copy, and run the verification queries (F.3).
4. Smoke-test the new API against the copy.
5. Take a fresh `pg_dump` of production, then `migrate deploy` with the same artefacts.

### E.4 Objects Prisma can't express

CHECK constraints, the append-only triggers and the `Report` exactly-one-target CHECK go in raw SQL inside migrations, documented in `backend/prisma/README.md`. Prisma's diff ignores CHECKs and triggers. A new CI job runs `prisma migrate diff --from-migrations --to-schema-datamodel` against a Postgres service container and **fails on any drift**. That job would have caught the A.2 problem.

---

## F. Existing-data migration (M2 backfill)

All in one transaction, in this order:

1. **Users**
   - `displayName = coalesce(prefferedName, name)`. `name` is kept, so nothing is lost.
   - `platformRole = 'USER'` for **everyone**, regardless of the old `role`.
   - `status = 'ACTIVE'`.
   - `email = lower(email)`. Abort if lower-casing creates duplicates; the inspection script counts them.
2. **Organizers**
   - For each `Admin` that owns ≥1 event, create an `Organizer`:
     - `ownerUserId = Admin.userId`
     - `displayName = coalesce(displayName, name, 'Organizer')`
     - `slug` = slugified name + short random suffix
     - `verificationStatus = 'NOT_STARTED'`
   - Write `AuditLog(actorRole=SYSTEM, action='migration.organizer.created')`.
3. **Events**
   - `organizerId` = that organizer.
   - `slug` = slugified title + suffix.
   - `timezone` and `currency` = approved defaults (O.4).
   - `endsAt = NULL`.
   - `status`:
     - `startsAt < now()` → **COMPLETED**
     - otherwise → **PENDING_REVIEW** (recommended, O.3)
   - Insert `EventModerationAction(action='MIGRATED', actorRole=SYSTEM, toStatus=…)`.
4. **Ticket types:** one "General admission" per event.
   - `priceMinor = eventType='PAID' ? round(price*100) : 0`
   - `quantitySold = Σ quantity of non-cancelled bookings`
   - `quantityTotal = availableTickets + quantitySold`
   - **Abort** if a PAID event has a null or ≤0 price; the inspection counts these first.
   - Paid ticket types on unverified organizers are **kept but not sellable**. Checkout enforces "organizer VERIFIED and ACTIVE", so the rule holds without deleting data.
5. **Bookings**
   - `currency` = the event currency.
   - `totalMinor = round(totalAmount*100)`.
   - One `BookingItem(quantity, unitPriceMinor = the ticket type price)`.
   - Status unchanged.
6. **Media:** each `Picture` → `FileAsset(PUBLIC, external-url, url)` for the display picture and each preview, then `EventMedia(COVER/GALLERY, position)`.
7. **Categories:** `slug` from name. Abort on case-insensitive duplicates. Drop duplicate `(eventId, categoryId)` rows before adding the composite PK; the inspection counts them first.
8. **Tickets:** if any `Ticket` rows exist, **stop**. They need a decision (O.1). Tickets for confirmed bookings get issued in Phase 4.

### F.3 Verification queries (abort the transaction on failure)

- Every event has a non-null organizer, slug, timezone, currency and at least one ticket type.
- Σ `quantityTotal` == old Σ (`availableTickets` + booked).
- Booking count unchanged.
- Σ `totalMinor` == Σ round(`totalAmount`*100).
- Counts: Organizers == `admins_owning_events`; FileAssets == pictures × (1 + previews).
- Zero `platformRole = ADMIN` after M2.

---

## G. Authentication architecture

### G.1 Target flow

```
Browser (Clerk session) ──Authorization: Bearer <Clerk session JWT>──▶ Express
   clerkMiddleware()            verifies the JWT signature and expiry (networkless JWKS)
   requireUser                  getAuth(req).userId (Clerk "sub")
                                 → User where clerkUserId = sub
                                   (first request: provision, G.3)
                                 → reject if status ≠ ACTIVE
                                 → req.user = canonical User
                                   (with organizer, platformRole)
   route handler / policy        uses req.user only; never ids from the body or URL
```

### G.2 Identity rules

- **Canonical external identity:** Clerk user id, stored in `User.clerkUserId` (unique).
- **Internal identity:** `User.id` (cuid). Every foreign key uses this.
- Email is a **contact attribute, not an identity key**. Emails change and can be re-used.
- The frontend never sends a user id, organizer id or role. Routes use `/me/...` or `/organizer/...`, resolved server-side.

### G.3 Provisioning

- On the first authenticated request, upsert by `clerkUserId` (the unique constraint makes concurrent first requests safe).
- Fetch the profile with `clerkClient.users.getUser(sub)`: primary email and its **verification status**, name, avatar.
- Profile fields are refreshed lazily, at most every N minutes. Clerk webhooks (`user.updated`, `user.deleted`, verified with the signing secret) come in 2C, so deletions are handled without waiting for a login.

### G.4 What gets removed

`firebase-admin`, `jsonwebtoken`, `JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_*`, `/user/loginUser`, `UserMiddleware`/`AdminMiddleware`, `AdminController.js`, `AdminRoute.js`, `TicketRoute.js`, `TicketController.js`. On the frontend: the `localStorage.jwt` reads, replaced by one API client that attaches `await getToken()`. **After this there's one auth system, not two.**

### G.5 Legacy Firebase users (decision O.2)

Existing rows have `legacyFirebaseUid` and no `clerkUserId`. The recommended linking rule:
- On first Clerk login, if the Clerk primary email is **verified** and exactly matches an **unlinked** legacy row, link that row by setting `clerkUserId`. This preserves the user's bookings and events.
- Write `AuditLog('user.legacy_link')`.
- Never link on an unverified email.

### G.6 New backend env

`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` (later also `CLERK_WEBHOOK_SIGNING_SECRET`). If the Clerk secret key was in the leaked `.env`, it **must be rotated first**.

### G.7 Admin hardening

Admin accounts must have **MFA enabled in Clerk**. Admin routes also require a session with recent factor verification (Clerk `fva` claim) for destructive actions. That gets added once the claim is confirmed in your Clerk instance.

---

## H. Authorization architecture

Every request answers five questions, in order:

| # | Question | Mechanism |
|---|---|---|
| 1 | Who is it? | `requireUser` (G.1), from the session only |
| 2 | What can they do? | Capabilities derived from DB state: `isAdmin = platformRole==ADMIN && status==ACTIVE`; `organizer = user.organizer` (if ACTIVE); `verified = organizer.verificationStatus==VERIFIED` |
| 3 | Which resource? | Loaded with an **owner-scoped query**, e.g. `event.findFirst({ where: { id, organizer: { ownerUserId: req.user.id } } })`. Not found or not owned → **404** (no existence leak) |
| 4 | Do they control it? | Implied by #3, or by `isAdmin` on admin routes |
| 5 | Is the state compatible? | Pure functions, e.g. `assertTransition(event.status, action, actorRole)`, `assertCanSetPrice(organizer, priceMinor)` |

**Implementation shape:**
- `src/auth/` (Clerk + `requireUser` + `requireAdmin`)
- `src/policy/` (pure, unit-tested capability and transition rules, **one place**)
- `src/services/` (transactions; every privileged mutation writes `AuditLog` in the same transaction)
- Routers split by audience: `/public`, `/me`, `/organizer`, `/admin`. The admin router mounts `requireAdmin` once, so a forgotten guard can't expose an admin route.

**Admin bootstrap:**
- No HTTP endpoint can create the first admin. An operator runs a CLI with DB access, `npm run admin:grant -- --email you@…`, which writes `AuditLog(actorRole=SYSTEM)`.
- Later admin-to-admin grants go through an audited admin endpoint. The last remaining admin can't demote themselves.

---

## I. Authorization matrix

The roadmap's starting matrix, adjusted. "Organizer" means a user with an ACTIVE organizer profile.

| Capability | Attendee | Organizer (unverified) | Verified organizer | Platform admin | Notes |
|---|:-:|:-:|:-:|:-:|---|
| Browse published events | ✓ | ✓ | ✓ | ✓ | Anonymous too |
| Save events / follow organizers | ✓ | ✓ | ✓ | ✓ | Signed in |
| Book free tickets | ✓ | ✓ | ✓ | ✓ | Not on own events (prevents inventory games) |
| Book paid tickets | Phase 4 | Phase 4 | Phase 4 | Phase 4 | |
| View/cancel **own** bookings and tickets | ✓ | ✓ | ✓ | ✓ | Owner-scoped |
| Report an event/organizer/user | ✓ | ✓ | ✓ | ✓ | Rate-limited |
| **Create organizer profile** | ✓ | — | — | ✓ | *Added.* This is how an attendee becomes an organizer |
| Submit / resubmit verification | — | ✓ | — (already verified) | own profile only | *Added* |
| Create event | — | ✓ | ✓ | **only via own organizer profile** | *Changed:* admins aren't implicitly organizers |
| Edit own event | — | ✓ | ✓ | own only | State-gated: free in DRAFT; locked in PENDING_REVIEW (withdraw first); material fields locked once PUBLISHED (O.8) |
| Submit event for review | — | ✓ | ✓ | own only | Requires ≥1 ticket type and a future start |
| Publish event directly | — | — | — | — | *Changed:* **nobody**. PUBLISHED only via admin APPROVE |
| Cancel own event | — | ✓ | ✓ | own only | Cancelling with bookings triggers refunds in Phase 4 |
| Create free ticket types | — | ✓ | ✓ | own only | |
| Create paid ticket types | — | — | ✓ | **own only, if own organizer is verified** | *Changed:* no admin bypass |
| View own events' attendees / check in tickets | — | ✓ | ✓ | own only | Minimal attendee data (O.10) |
| Moderate events | — | — | — | ✓ | *Changed:* **not events of an organizer the admin owns** (separation of duties) |
| Edit **another** organizer's event content | — | — | — | — | *Added:* admins change status, not content |
| Review organizer verification | — | — | — | ✓ | Not their own organizer |
| View verification evidence | — | own (metadata) | own (metadata) | ✓ (each view audited) | |
| Suspend/reinstate organizers and users | — | — | — | ✓ | Reason required; audited |
| Grant/revoke platform admin | — | — | — | ✓ | Audited; can't remove the last admin; bootstrap via CLI |
| Manage categories | — | — | — | ✓ | |
| Review reports | — | — | — | ✓ | |
| View audit logs | — | — | — | ✓ | Read-only for everyone; nobody can edit them |

**A suspended user** can do nothing beyond read-only access to their own tickets. **A suspended organizer** can't create, edit, submit or check in, and its events are hidden.

---

## J. API contract changes

Response envelope: `{ data }` on success and `{ error: { code, message, details? } }` on error. Bodies are validated with zod. List endpoints use cursor pagination (`?cursor&limit`).

| New endpoint | Auth | Replaces | Phase |
|---|---|---|---|
| `GET /me`, `PATCH /me` | user | `/user/getUser`, `/user/updateUser/:id`, `/user/loginUser` | 2B |
| `GET /me/bookings`, `GET /me/bookings/:id`, `POST /me/bookings/:id/cancel` | user, owner-scoped | `/event/:id/bookedAll`, `bookedOne`, `cancelTicket`; **`bookedDelete` removed** (bulk-delete of history is not a feature) | 2B |
| `POST /events/:id/bookings` `{ items:[{ticketTypeId, quantity}], idempotencyKey }` | user | `/event/:id/bookings` (no client `userId`/price) | 2B (free only), 4 (paid) |
| `GET /events`, `GET /events/:idOrSlug`, `GET /categories` | public | `/event`, `/event/:id`, `/search/*` (published only) | 2B minimal, 3 full |
| `PUT/DELETE /me/saved-events/:eventId`, `GET /me/saved-events` | user | — | 2D |
| `PUT/DELETE /me/follows/:organizerId`, `GET /organizers/:slug` | user / public | — | 2D |
| `POST /organizer`, `GET/PATCH /organizer` | user | `/user/switchRole` (**removed**) | 2C |
| `GET /organizer/verification`, `GET /organizer/verification/requirements?country&type`, `POST /organizer/verification/submissions`, `POST …/:id/withdraw` | organizer | — | 2C |
| `GET/POST /organizer/events`, `GET/PATCH /organizer/events/:id`, `POST …/:id/{submit,withdraw,cancel}`, `…/:id/ticket-types` CRUD, `…/:id/history` | organizer, owner-scoped | `/event/create`, `/events/create_event/:id` (never existed), **`DELETE /event/delete/:id` removed** | 2C |
| `GET /admin/verification-submissions?status`, `GET …/:id`, `POST …/:id/decisions` | admin | — | 2C |
| `GET /admin/events?status`, `POST /admin/events/:id/moderation {action, reason}` | admin | — | 2C |
| `GET /admin/users`, `PATCH /admin/users/:id {status|platformRole}`, `POST /admin/organizers/:id/{suspend,reinstate}` | admin | — | 2D |
| `POST /reports`, `GET /admin/reports`, `POST /admin/reports/:id/resolve` | user / admin | — | 2D |
| `GET /admin/audit-logs` | admin | — | 2D |
| `GET/POST/PATCH /admin/categories` | admin | — | 2D |

**Frontend changes required by the contract (2B):** a single `api` client with `getToken()`; remove every `user.id`/`userId` from URLs and bodies; update the 12 call sites listed in A.4. **No visual redesign.**

---

## K. Indexing strategy

| Query | Index |
|---|---|
| Public listing by date | `Event(status, startsAt)` |
| City browse (Phase 3 adds PostGIS GiST and full-text) | `Event(country, city, startsAt)` |
| Organizer dashboard | `Event(organizerId, status)` |
| Moderation queue (oldest first) | `Event(status, submittedAt)` |
| Event page by slug | `Event(slug)` unique |
| Event history / actor history | `EventModerationAction(eventId, createdAt)`, `(actorId, createdAt)` |
| Verification queue | `VerificationSubmission(status, submittedAt)`; organizer history `(organizerId, submittedAt)` |
| Decisions per submission / per reviewer | `VerificationDecision(submissionId, createdAt)`, `(reviewerId, createdAt)` |
| My bookings / event bookings | `Booking(userId, bookingDate)`, `Booking(eventId, status)`; idempotency `unique(userId, idempotencyKey)` |
| QR lookup / check-in / my tickets | `Ticket(code)` unique, `Ticket(eventId, status)`, `Ticket(holderUserId)` |
| Saved / follows (both directions) | composite PKs + `SavedEvent(eventId)`, `OrganizerFollow(organizerId)` |
| Category browse | `EventCategory(categoryId)`; PK `(eventId, categoryId)` |
| Reports queue | `Report(status, createdAt)`, `(eventId)`, `(organizerId)` |
| Audit by target / actor / action | `AuditLog(targetType, targetId, createdAt)`, `(actorId, createdAt)`, `(action, createdAt)` |
| **Dropped** | `Event_id_key`, `Picture_id_key`, `Category_name_idx`, the 5-column `Event` index |

---

## L. Constraints and invariants

Each is enforced at **DB** level, **service** level, or both.

| # | Invariant | Where |
|---|---|---|
| 1 | `User.clerkUserId` unique; identity never taken from client input | DB + auth |
| 2 | `platformRole` changes only via the admin service or CLI, always with an `AuditLog` row in the same transaction | service |
| 3 | At most one organizer per user (`ownerUserId` unique) | DB |
| 4 | `Organizer.verificationStatus` changes **only** together with an inserted `VerificationDecision` (or a new submission) in one transaction | service |
| 5 | `VerificationDecision`, `EventModerationAction`, `OrganizerStatusChange`, `AuditLog` are **append-only** | DB trigger (`BEFORE UPDATE OR DELETE … RAISE`) |
| 6 | `VerificationEvidence` immutable; submissions immutable except `status` | DB trigger + service |
| 7 | Event status changes only through `assertTransition`, each writing an `EventModerationAction` | service |
| 8 | `PUBLISHED` only via admin `APPROVE`; `publishedAt` set exactly then | service |
| 9 | Admin can't moderate or verify an organizer they own | policy |
| 10 | `TicketType.priceMinor >= 0`, `quantityTotal >= 0`, `0 <= quantitySold <= quantityTotal`, `minPerOrder >= 1`, `maxPerOrder >= minPerOrder` | DB CHECK |
| 11 | `priceMinor > 0` requires the owning organizer to be VERIFIED and ACTIVE at create/update, at submit, at approve, **and at checkout** | service |
| 12 | Inventory changes only via a conditional `UPDATE … SET quantitySold = quantitySold + n WHERE quantitySold + n <= quantityTotal` | service |
| 13 | Booking price computed server-side from `TicketType`; one currency per event (`Booking.currency = Event.currency`) | service |
| 14 | `Ticket.code` random, ≥128 bits, unique; never derived from ids | DB + service |
| 15 | `Report` has exactly one target (`num_nonnulls(eventId, organizerId, targetUserId) = 1`) | DB CHECK |
| 16 | Events, users and organizers with references are never hard-deleted (Restrict FKs); "delete" means a status change | DB |
| 17 | Public endpoints return only `PUBLISHED`, `COMPLETED` and (direct link only) `CANCELLED` events | service |

---

## M. Security considerations

1. **Credential rotation (Phase 0) is still outstanding and gates the 2B deploy.** In particular, any Clerk secret that was in the leaked `.env` must be rotated before the backend starts trusting Clerk.
2. **Verification evidence is the most sensitive data in the system** (government IDs).
   - Private bucket only; short-lived signed URLs.
   - Every view is audited (`verification.evidence.view`).
   - Never sent to the organizer's public profile.
   - A retention policy is needed: delete files N days after a final decision, keeping the decision record. This has legal implications (Nigeria's NDPA, GDPR for EU users); see O.9.
3. `declaredData` (JSON) holds PII. It's excluded from every non-admin serializer. Serializers are allow-lists, never `...row`.
4. **Attendee privacy:** organizers see attendee display name, ticket type, booking date and check-in only. Email is shared only if the attendee opts in (O.10).
5. **No enumeration:** non-owned resources return 404. Slugs and ticket codes are unguessable where it matters.
6. **Hardening:**
   - CORS allow-list (no `*` with credentials); `helmet`.
   - Rate limits on auth'd writes, reports, verification submissions and booking.
   - A central error handler that never returns raw Prisma/stack messages.
   - Request ids propagated into `AuditLog.requestId`.
7. **Admin:** MFA required, a separate router, separation of duties (invariant 9), and an append-only audit.
8. **Webhooks** (2C): verify Clerk/Svix signatures; idempotent handlers.
9. **Migration safety:** backups, a rehearsal on a restored copy, and verification queries that abort the transaction (E.3, F.3).

---

## N. Testing strategy

| Layer | Tooling | What |
|---|---|---|
| Policy / state machines | Vitest, pure unit tests | Every allowed and forbidden event transition × actor role; verification transitions; paid-ticket rule; separation of duties |
| Authorization matrix | Vitest + supertest against the real Express app and a **real Postgres** (CI service container) | **Table-driven from section I**: every capability × persona (anonymous, attendee, unverified organizer, verified organizer, suspended organizer, admin, suspended user) → expected status. Includes IDOR probes with another user's ids |
| Auth boundary | Inject a test `requireUser` (Clerk `getAuth` stubbed) | Provisioning idempotency (parallel first requests), suspended users rejected, legacy-link rule (verified vs unverified email) |
| Migrations | Fixture DB in the **old** shape (users with/without preferred name, Admin rows with/without events, paid/free/past/future events, bookings incl. cancelled, pictures with previews) → `migrate deploy` → F.3 assertions | Run in CI on every change to `prisma/migrations` |
| Drift | `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` | Fails CI on any schema/migration mismatch |
| Concurrency | N parallel bookings against `quantityTotal = k` | Exactly k succeed; never oversold |
| Audit | Every admin mutation test asserts exactly one matching `AuditLog` row | |
| Append-only | Attempt UPDATE/DELETE on history tables | DB raises |

---

## O. Risks and unresolved decisions

### Blockers (need input before 2B migrations can be finalised)

| # | Item | Why it blocks | What I need |
|---|---|---|---|
| **O.1** | **The real database's shape and contents are unknown** (migration shape vs. `db push` shape; how many rows; whether `Ticket` has rows) | The backfill and its abort conditions depend on it | Run `docs/phase2/inspect-db.sql` read-only (`psql "$DATABASE_URL" -f docs/phase2/inspect-db.sql`) and paste the output. It contains counts and column names only. Or tell me the DB is disposable |
| **O.2** | Legacy Firebase users → Clerk | Identity mapping | Approve **auto-link on a verified, exactly matching email** (recommended) vs. **no linking** (legacy rows orphaned) |

### Product decisions, with my recommendation

| # | Decision | Recommendation |
|---|---|---|
| O.3 | Status of existing future events after migration | **PENDING_REVIEW** (consistent with "every event is moderated"). Alternative: grandfather them as PUBLISHED |
| O.4 | Default currency and timezone for existing events | `NGN` and `Africa/Lagos`. Confirm |
| O.5 | Verification storage | Keep **suspension separate** (`Organizer.status`) and add **CHANGES_REQUESTED**; the API shows the roadmap's statuses. Otherwise unsuspending would forget whether the organizer was verified |
| O.6 | Event rejection | `REJECT`/`REQUEST_CHANGES` both return to **DRAFT**, with the reason in history; no `REJECTED` event status. Alternative: a terminal `REJECTED` |
| O.7 | Admin separation of duties | Admins can't moderate or verify organizers they own, and admins aren't implicit organizers |
| O.8 | Editing published events | Phase 2: **lock material fields** (date/time, venue, ticket prices/quantities down) after publish. Organizers can still edit description and media. A proper revision-review workflow comes later |
| O.9 | Verification evidence retention | Delete evidence files N days after a final decision (suggest 90), keeping decision records. Get local legal advice |
| O.10 | Attendee data visible to organizers | Name, ticket type, booking date and check-in; **email only with attendee opt-in** |
| O.11 | Booking in 2B | Once auth works, today's insecure booking code becomes reachable, so it can't ship as is. Recommend **free-ticket booking, rewritten safely** (server price, atomic inventory, idempotency) in 2B; paid stays disabled until Phase 4 |
| O.12 | M4 contract (drops) | A separate, later release with explicit approval |

### Other risks

- **External:** the Clerk instance must issue session tokens to the backend's domain, with email collection enabled. That's checked in the Clerk dashboard (owner).
- **Schedule:** 2B–2D is substantial. Section P splits it so each slice is shippable and testable.
- **Floating-point money** in the existing data: rounding is handled in F, and the inspection reports how many rows are affected.

---

## P. Phase 2 implementation sequence

Each slice ends green in CI. Nothing reaches a real DB without the E.3 rehearsal.

**2B: foundation (needs O.1, O.2, O.3, O.4, O.11)**
1. **Test harness first:** Vitest + supertest + Postgres in CI; the drift check job (would fail today, proving it works); migration fixture tests.
2. **M0:** realign `schema.prisma` to the migrations (empty diff). Delete the dead `AdminController`/`AdminRoute`/`TicketController`/`TicketRoute`.
3. **M1–M3:** hand-written expand, backfill and tighten migrations, plus verification queries; rehearse on the fixture DB.
4. **Platform plumbing:** Prisma singleton, zod, error handler, request ids, helmet, CORS allow-list, rate limiting, router split by audience.
5. **Clerk auth:** `clerkMiddleware`, `requireUser` (provision and link), `requireAdmin`, `admin:grant` CLI. Remove Firebase and the custom JWT.
6. **Policy module and `AuditLog` service.**
7. **Endpoints:** `/me`, `/me/bookings*`, public `/events` (published only), `/categories`, safe free booking.
8. **Frontend contract update:** API client with `getToken()`; remove client-supplied ids. No redesign.
9. **Rehearse on a restored copy**, then deploy (after Phase 0 rotation).

**2C: organizer, verification and moderation:** organizer profile; verification requirement sets plus submissions (evidence values now, files once storage is chosen); admin verification decisions; organizer event CRUD with the lifecycle; ticket types with the paid-ticket rule; admin moderation; Clerk webhooks.

**2D: engagement and admin core:** saved events, follows, reports, admin users/organizers (suspend, roles), categories admin, audit log read API.

**Later (separate approval):** M4 contract migration.

**Recommended next step:** answer O.1 (run the inspection script, or confirm the DB is disposable) and O.2–O.4 and O.11. With those, I'll start 2B at step 1.
