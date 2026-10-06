# The Event: product direction and roadmap

_Adopted 2026-10-03._ This is the reference for every phase after stabilisation. `AUDIT.md` describes where the code is today; this describes where it's going and in what order.

## 1. Product direction

The Event is an **event discovery ecosystem**, not "a website with event cards". It serves three audiences, and all three are part of the core product from the start:

| Audience | Core jobs |
|---|---|
| **Attendee** | Discover nearby or anywhere, search, filter, evaluate, save, share, book, hold QR tickets, manage bookings, follow organizers |
| **Organizer** | Onboard, **get verified**, create/manage events, media, ticket types, bookings, attendees, check-in, analytics, organizer profile |
| **Platform admin** | Users, organizers, **verification queue**, event moderation, categories, reports, roles, settings, platform analytics |

**Ground rules (binding on every phase):**
1. **The UI never invents backend behaviour.** Every UI feature is traced as: UI requirement → data → API → authorization → model → implementation (section 4).
2. **No fake functionality or false trust signals.** No hard-coded metrics, decorative verification badges, or filters the API can't serve.
3. **The server is the source of truth** for price, availability, ownership, ticket validity, verification status and event status.
4. The existing UI is the **starting point, not the destination**.

## 2. Phase order

| Phase | Scope | Status |
|---|---|---|
| 0 | Security and credential remediation | Code done; **credential rotation pending (owner)** |
| 1 | Build stabilisation and CI | Done (`5cf2a46`) |
| 2 | Auth, database and backend foundation, **including the full role/organizer/verification/status model** (section 3) | 2A designed; **2B implemented and tested** ([`PHASE2B_IMPLEMENTATION.md`](./PHASE2B_IMPLEMENTATION.md)); production migration pending |
| 3 | Discovery and search architecture (geo, filters, pagination) | 3A designed, measured on 200k events ([`PHASE3_DISCOVERY.md`](./PHASE3_DISCOVERY.md)); awaiting approval |
| 4 | Booking and ticketing architecture and security (ticket types, atomic booking, payments, check-in) | |
| 5 | **Complete UI/UX redesign** of every surface (section 5) | |
| 6 | Polish: performance, accessibility, SEO, analytics | |
| 7 | Production QA and deployment | |

This replaces phases 5–6 in `AUDIT.md` §6. The full redesign waits until phases 2–4 have built the data, auth and APIs it depends on.

## 3. What this means for Phase 2 (data model)

> Detailed proposal: [`PHASE2_ARCHITECTURE.md`](./PHASE2_ARCHITECTURE.md) (Phase 2A, awaiting approval).

The directive changes Phase 2's scope. Building only today's features would force a second schema migration later. The decisive issue:

> **Today "admin" means "event creator."** `RoleSelectionPage` asks attendees whether they're an "admin", `switchRole` lets anyone become one, and events belong to an `Admin` row. The product needs three separate concepts.

Phase 2 schema targets (names indicative, finalised in Phase 2):

| Concept | Model | Key fields | Notes |
|---|---|---|---|
| Identity | `User` | `clerkId`, email, name, avatar, `platformRole` (`USER` \| `ADMIN`), `status` (`ACTIVE` \| `SUSPENDED`) | Platform admin is **assigned server-side only**; there's no self-serve role switching |
| Organizer | `OrganizerProfile` (1:1 `User`, optional) | displayName, slug, bio, contact, org/business info, `verificationStatus` | Replaces `Admin`. Any user can create one |
| Verification | `VerificationSubmission` | organizerId, submitted data, document refs, `status` (`SUBMITTED` \| `UNDER_REVIEW` \| `CHANGES_REQUESTED` \| `APPROVED` \| `REJECTED`), reviewerId, reason, timestamps | Kept as history; the profile status is derived from the latest decision. Organizer status: `NOT_STARTED` \| `PENDING` \| `VERIFIED` \| `REJECTED` \| `SUSPENDED` |
| Event | `Event` | organizerId, slug, `status` (`DRAFT` \| `PENDING_REVIEW` \| `PUBLISHED` \| `CANCELLED` \| `SUSPENDED` \| `COMPLETED`), startsAt, endsAt, timezone, venue, lat/lng, city, country, cover + gallery | "Sold out" is **derived** from inventory, not stored |
| Tickets | `TicketType` | eventId, name, price (integer minor units), currency, quantity, sold, sales window | Replaces `Event.price`/`availableTickets` (lands in Phase 4) |
| Ticket | `Ticket` | bookingId, ticketTypeId, holder, code (QR payload), `status`, `checkedInAt` | |
| Saved | `SavedEvent` | userId, eventId, unique(userId, eventId) | |
| Follow | `OrganizerFollow` | userId, organizerId, unique | |
| Moderation | `Report` | reporterId, target (event/organizer), reason, `status`, resolution | |
| Audit | `AuditLog` | actorId, action, target, before/after, timestamp | **Every privileged admin action is logged** |
| Taxonomy | `Category` | name, slug, icon, sort order | Admin-managed |

**Authorization rules to enforce server-side from Phase 2:**
- Attendees see only their own bookings and tickets.
- Organizers see only their own events and their own attendees, with no contact details beyond what the event needs.
- Admin endpoints require `platformRole = ADMIN`. Status transitions (verification, moderation, suspension) are admin-only and audit-logged.
- Publishing rules, i.e. whether `DRAFT → PUBLISHED` goes through `PENDING_REVIEW`, depend on verification status and are decided in the API, not the UI (open question 1).

## 4. Feature dependency map

| UI feature | Data | API (indicative) | Authorization | Phase |
|---|---|---|---|---|
| Search/results + filters | Event geo, dates, category, ticket price range | `GET /events?q&lat&lng&radius&from&to&category&price&sort&cursor` | Public; published only | 3 |
| Event details | Event, organizer + verification, ticket types, related | `GET /events/:slug` | Public; published only (owner/admin may preview drafts) | 3 |
| Save / saved list | `SavedEvent` | `PUT/DELETE /me/saved/:eventId`, `GET /me/saved` | Self | 3 |
| Checkout | TicketType, Booking, Payment | `POST /bookings` (idempotent, server-priced) | Signed-in | 4 |
| My tickets / QR | Ticket, Booking | `GET /me/tickets`, `GET /me/tickets/:id` | Self | 4 |
| Organizer onboarding | `OrganizerProfile` | `POST/PATCH /organizer` | Self | 2 |
| Verification (organizer side) | `VerificationSubmission` | `POST /organizer/verification`, `GET …/history` | Self | 2 |
| Create event wizard | Event (draft), media, ticket types | `POST /organizer/events`, `PATCH …/:id`, `POST …/:id/publish` | Owner | 2–4 |
| Organizer dashboard | Aggregates over own bookings/tickets | `GET /organizer/stats` | Owner | 4 |
| Attendees + check-in | Ticket, Booking | `GET /organizer/events/:id/attendees`, `POST …/check-in` | Owner | 4 |
| Admin verification queue | `VerificationSubmission` | `GET /admin/verifications`, `POST …/:id/decision` | Admin + audit | 2 |
| Admin moderation | Event status, `Report` | `GET /admin/events?status=`, `POST …/:id/moderate` | Admin + audit | 3 |
| Admin users | User, roles, status | `GET /admin/users`, `PATCH …/:id` | Admin + audit | 2 |
| Admin overview | Real aggregates | `GET /admin/stats` | Admin | 4 |
| Recommendations | Saved, follows, history, location | TBD | Self | 6 |

## 5. Phase 5 redesign: required process

Phase 5 starts with a **UX architecture pass, before any page changes**:
1. Current sitemap
2. Proposed sitemap
3. Attendee, organizer and admin journeys
4. Information architecture, including navigation that separates attendee, organizer and admin areas (admin is a separate console, not the public site's look)
5. Design system: type scale, semantic colour tokens, spacing, radius, shadow
6. Component inventory
7. Page-by-page plan
8. Responsive strategy

Then implementation, in this order: landing → navigation → search → results → event details → booking → tickets → saved → profile → organizer onboarding → create event → organizer dashboard → event management → verification → admin dashboard → admin moderation → admin verification → settings → all responsive states.

**Surfaces in scope (none optional):** landing; global navigation (desktop and mobile); search/discovery with a filter sidebar on desktop and a bottom sheet on mobile; event card variants (grid, horizontal, compact, featured); event details; checkout; my tickets with upcoming, past and cancelled tabs and a QR detail; saved events; auth and onboarding (Clerk UI); attendee profile; organizer onboarding and verification; create-event wizard (basics, date, location, media, tickets, settings, preview, publish); organizer dashboard; event management; attendee management; admin dashboard, users, organizers, verification review, event moderation, categories, reports, settings.

**Design direction:** modern, clean, premium, fast, human, trustworthy, with its own identity. Avoid generic SaaS styling, heavy gradients and glassmorphism, over-rounded cards, decorative motion and template layouts. Use subtle, purposeful motion only.

**Definition of done for the redesign:** each of these journeys works end to end with loading, success, failure, empty, unauthorized and not-found states:
- **Attendee discovery:** landing → search → filter → event → save
- **Attendee booking:** search → event → ticket → checkout → confirmation → my ticket → QR
- **Organizer:** sign up → onboarding → verification → approved → dashboard → create → preview → publish → manage → attendees
- **Admin:** login → dashboard → verification queue → review → approve/reject → event moderation → user management

It also has to meet the quality bar: consistency, accessibility (keyboard, focus, labels, contrast, no colour-only status), mobile-first responsiveness, SEO for public event pages (titles, OG/Twitter meta, canonical, schema.org `Event`), and no duplicated UI logic.

## 6. Open product decisions

These need the owner's answer before or during Phase 2:

1. **Publishing policy:** may verified organizers publish directly, with only unverified ones going through review? Or does every event go through review?
2. **Can unverified organizers sell paid tickets,** or only host free events until verified?
3. **What verification evidence is required** (ID, business registration, social proof), and does it vary by country?
4. **Media storage provider** for event images and verification documents. Documents need private storage with signed URLs.
5. **Payment provider and payout model** (e.g. Paystack for NGN, Stripe), and whether the platform charges fees.
6. **Map and geocoding provider** for Phase 3.
7. **One product name:** "The Event" everywhere (navbar currently says "Tickets Hub").
