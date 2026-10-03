# The Event: codebase and product audit

_Audit date: 2026-10-03 · Commit audited: `dc55a0e`_

**In short:** the product idea and the UI layout are a reasonable start. The app doesn't work end to end yet, though. The frontend doesn't build, login can't succeed, search almost never returns results, and two private credentials are committed to git. The codebase is small (about 3,500 lines of frontend and 600 of backend), so the cheapest path is to **stabilise, then rebuild the data and auth layer properly, and keep and restyle the existing screens.** A full rewrite isn't needed.

---

## 0. Do this first: leaked credentials

| File | What it is | Risk |
|---|---|---|
| `.env` (repo root) | Environment secrets (committed in the initial commit) | Anyone with repo access can read them |
| `backend/configs/serviceAccountKey.json` | **Firebase Admin service-account private key** | Full admin access to Firebase project `theevent-77725` |
| `frontend/src/context/EventContext.tsx`, `EventSearchByLocation.tsx` | OpenCage geocoding API key hard-coded | Quota abuse and billing |

Deleting these files isn't enough, because they remain in git history. You need to:
1. **Revoke and rotate** the Firebase service-account key (Google Cloud console → IAM → Service accounts → Keys), plus every value in `.env` (DB password, `JWT_SECRET`, Clerk secret).
2. Rotate the OpenCage key and move the geocoding call to the backend.
3. Untrack the files (`git rm --cached`), add `*.env`, `serviceAccountKey.json` to `.gitignore`, and load secrets from environment variables only.
4. Optionally purge history with `git filter-repo`. Rotation is what actually protects you.

---

## 1. Current state

**Stack**
- Frontend: React 18, Vite 6, TypeScript, Tailwind 3, React Router 7, Clerk (auth), shadcn/Radix (partially set up)
- Backend: Express 4 (CommonJS JS), Prisma 6, PostgreSQL, firebase-admin + jsonwebtoken (auth)
- No tests, CI, linting in the backend, or README.

**Architecture as built**
```
React (Clerk login) ──fetch──> Express ──Prisma──> Postgres
                     ▲  sends "Bearer <localStorage.jwt>"
                     │  …which nothing ever sets
Express verifies its own JWT, minted from a *Firebase* ID token
```
The project is partway through migrating from Firebase Auth to Clerk. The frontend uses Clerk, but the backend still expects Firebase, and the Prisma schema has a `ClerkId` column that no code writes to.

---

## 2. Problems, ranked

### P0: Broken (nothing works end to end)

| # | Problem | Where | Effect |
|---|---|---|---|
| 1 | **Frontend doesn't build.** `tsc` reports 33 errors, and `vite build` fails on `import "./components/Faq"` when the file is `FAQ.tsx` (Linux is case-sensitive). It also imports the non-existent `context/AuthContext` and the `firebase` package, which isn't installed. | `App.tsx`, `Home.tsx`, `AccountPage.tsx`, `EventSearchByLocation.tsx`, `firebaseConfig.ts` | It can't deploy to Vercel, Netlify or any other Linux CI |
| 2 | **Schema and code disagree.** The controllers use `firebaseUid`, `name`, `profilePicture`, `shortDescription`, `longDescription`, `prefferedName` and `admin.userId`. None of these exist in `schema.prisma`, which has `ClerkId`, `Fullname`, `preview`, `description` and `Admin.id`. | `UserController`, `EventController`, `searchController` | Prisma throws at runtime: login, event creation and location search all fail |
| 3 | **Auth can't succeed.** Nothing calls `localStorage.setItem("jwt")`, so every protected request sends `Bearer null` and gets a 401. The frontend also sends Clerk's `user.id` (`user_…`) as `userId`, which doesn't match DB IDs (cuid). | `EventContext`, `OrderButton`, `Events.tsx`, middleware | Booking, "my tickets" and create-event all fail |
| 4 | **firebase-admin is initialised in two controllers.** `AdminController` also requires `../config/…`, a path that doesn't exist. | `UserController.js:8`, `AdminController.js:7` | A crash as soon as the admin routes are mounted |
| 5 | **Keyword search uses AND instead of OR.** `/search/byLocation` requires both the title and the venue to contain the term. | `searchController.js:12` | Results are almost always empty |
| 6 | **"Near me" can't match.** It reverse-geocodes to a full address ("12 Allen Ave, Ikeja, Lagos, Nigeria") and then checks whether `venue` *contains* that whole string. | `EventContext.tsx:63` | Near-me search never returns anything |

### P0: Security

| # | Problem | Where |
|---|---|---|
| 7 | `DELETE /event/delete/:id` has **no auth at all**, so anyone can delete any event | `EventRoute.js:33` |
| 8 | Authorisation trusts the URL instead of the token (IDOR). `/:id/bookedAll`, `/:id/bookedDelete` and `/:id/cancelTicket` act on whatever ID is in the URL, so any logged-in user can read or delete anyone's bookings | `EventController.js:107-193` |
| 9 | `PUT /user/updateUser/:id` is unauthenticated (and broken: `data: { userData }`) | `UserController.js:92` |
| 10 | `PUT /user/switchRole` lets **any user make themselves ADMIN**, and `AdminMiddleware` never checks the role | `UserController.js:122`, `AdminMiddleware.js` |
| 11 | Booking trusts the client-sent `userId` and `totalAmount`; reviews trust the client-sent `userId` | `EventController.js:62`, `:30` |
| 12 | `cors({ origin: '*', credentials: true })`, with no rate limiting, input validation or helmet | `index.js:10` |
| 13 | Raw `error.message` (including Prisma internals) is returned to clients | most controllers |

### P1: Correctness and data integrity

- **Overselling race.** Booking reads `availableTickets` and then writes `available - quantity` in two separate queries with no transaction or row lock. Concurrent bookings can oversell. Use a single conditional update (`updateMany where availableTickets >= qty, decrement`) inside `$transaction`.
- Cancelling restores tickets but deleting *all* bookings doesn't.
- Search returns **404 for "no results"**. The frontend expects an array, so the empty state never renders. Empty results should return `200 []`.
- Stub endpoints return fake success: `updateEvent`, `deleteEvent` and every admin ticket/booking handler. `getAllTicket` and `deleteTicket` call `req.status` / `req.staus`, which crash.
- Three separate `new PrismaClient()` instances; use a shared singleton.
- The backend's default `PORT` is **5173**, the same as Vite's dev server.
- `Event` has no lat/lng, city, country, end time, timezone or status; `EventStatus` is defined but unused. `EventCategory` lacks a unique `(eventId, categoryId)` constraint. Money is stored as `Float`, which should be integer minor units or `Decimal`.

### P1: Frontend and UX

- **The loading states never render.** In `Events.tsx` and `EventDetails.tsx`, `{loading && (…)}` is written as a bare statement, not returned JSX. Users see "Event not found" while the page is still loading.
- The **Hero search button does nothing**. Searching happens on *every keystroke*, including an empty string (`location.trim() >= ""` is always true), so it fires a request per character with no debounce.
- **Every nav link is dead.** `/Top cities`, `/Find a event`, `/Create An Event` and `/Blogs` have no routes, and neither do the category tiles (`/Arts`…), `/login`, `/admin-questions` or `/user/userInfo/:id`. There's also no 404 page.
- The brand is inconsistent: the navbar says **"Tickets Hub"**, `<title>` says **"TheEvent"**, and the repo is **Events-hub**.
- Event images are broken: the schema stores an `EventImages` relation, while the UI reads `event.image` or `event.imageUrl`.
- Loading spinners are `absolute inset-0` overlays or `h-screen`, so they jump around or cover the whole page. There are no skeletons.
- Data fetching uses ad-hoc `fetch` with no caching. The same "events near" UI is copy-pasted in three places (`HeroSection`, `EventSearchByLocation`, `EventsPage`), each with its own type definitions.
- Pagination happens client-side after fetching *all* events.
- A destructive "Delete All Tickets?" button sits under the user's tickets, behind only a browser `confirm()`.
- The countdown re-renders every second, so a seconds counter makes the details page busy.
- Accessibility problems: clickable `<p>` used as a "Sign In" button, icon-only hamburger without `aria-expanded`, no focus styles, and hot-linked icons8 images for icons even though lucide is installed.
- Dependencies are duplicated: two carousel libraries (`swiper`, `react-slick`) and two icon sets (`lucide-react`, `react-icons`). `react-router-dom` and `dotenv` sit in devDependencies.
- No SEO: the app is client-only and has no per-event `<title>` or OG tags, so shared event links show no preview.

---

## 3. What to keep

- **Prisma + Postgres.** It's the right choice, and the domain model (Event, Booking, Ticket, Category, Review, DiscountCode) is a good starting point.
- **Clerk for auth.** Finish the migration rather than going back to Firebase. It removes the custom JWT layer entirely.
- **React + Vite + Tailwind + shadcn/Radix.** Keep it, and commit fully to shadcn primitives.
- The page set (home, search results, event details, order, ticket with QR, my tickets, create-event wizard) is the right skeleton.

---

## 4. Recommended architecture

```
frontend (Vite/React, TS)
  ├─ TanStack Query        – fetching, caching, loading/error states
  ├─ api/ client           – one typed fetch wrapper, attaches Clerk session token
  ├─ shared types          – generated from backend zod schemas
  └─ shadcn/ui + tokens    – design system

backend (Express → TypeScript)
  ├─ @clerk/express         – clerkMiddleware + requireAuth; user resolved from token, never from URL/body
  ├─ zod                    – validate every body/query
  ├─ helmet, rate-limit, CORS allow-list
  ├─ routes → services → prisma (singleton)
  └─ central error handler  – no raw errors to clients

Postgres
  ├─ Event: lat, lng, city, country, startsAt, endsAt, timezone, status, slug
  ├─ PostGIS (or a lat/lng bounding box + haversine to start) for radius search
  └─ pg full-text (tsvector) on title/description for keyword search
```

**Search API (one endpoint instead of three):**
`GET /events?q=&lat=&lng=&radiusKm=&city=&from=&to=&category=&free=&cursor=`. It returns `{ items, nextCursor }` and always returns 200.

**Location:** the browser sends coordinates and the server queries by radius. Geocoding typed cities happens server-side, with the key held in env and the results cached. When location permission is denied, fall back to IP-based city detection or the typed city, and show a clear message.

---

## 5. UI/UX direction

User journey: **Discover → Search → Filter → Evaluate → Save/Share → Attend**

| Stage | Today | Change |
|---|---|---|
| Discover | Hero shows a location box, and below it CTAs for create, categories, a carousel and FAQ | Hero gets one combined search ("What" + "Where" + "When"), with "Near me" as a chip. Below it, real rows: *This weekend near you*, *Free events*, *By category* |
| Search | Fires on every keystroke, and the results show in the hero | A dedicated `/events?…` page with URL-driven state (shareable and back-button safe) |
| Filter | None | Date presets (today, weekend, this month), category, free/paid, distance. On mobile they go in a bottom sheet |
| Evaluate | Card shows title, date, type and venue, with no image | Card shows image, date block, title, venue and distance, and price or "Free". The details page gets a sticky CTA, map, organiser, end time, "Add to calendar" and refund info |
| Save/Share | Share only | Save (heart), share with OG preview, and add to calendar (.ics) |
| Attend | Ticket with QR | Keep it. Add an "Upcoming / Past" split and remove "Delete all" |

**Design system:** define tokens first (one brand colour with neutral scale, type scale, 4px spacing, radius, shadow), then build Button, Input, Select, Card/EventCard, Badge, Chip, Sheet/Drawer, Dialog, Skeleton, EmptyState and ErrorState. Every data view needs designed **loading, empty, error and permission-denied** states.

Pick **one name** and use it everywhere.

---

## 6. Implementation plan

**Phase 0: Secure (½ day).** Rotate and untrack secrets (section 0), lock down the open DELETE and `switchRole` routes.

**Phase 1: Make it build and run (1–2 days).**
- Fix the `Faq` import case, delete dead files (`firebaseConfig.ts`, `EventSearchByLocation.tsx`, unused `config/` forms), and fix the `@/` alias in `tsconfig`/`vite.config`.
- Fix the bare-statement loading states, and give every nav link a real route or remove it. Add a 404 page.
- Add `.env.example` files, a root README with setup steps, and a CI workflow (lint, typecheck, build).

**Phase 2: Auth and API foundation (2–3 days).**
- Replace firebase-admin and the custom JWT with `@clerk/express`, and upsert a `User` by `ClerkId` on first request.
- Derive the user from the token in every handler and remove the `:id`/`userId` from URLs and bodies. Gate admin routes on role and ownership.
- Use a Prisma singleton, zod validation, a central error handler, helmet, a CORS allow-list and rate limiting.
- Reconcile `schema.prisma` with the code and create one clean migration.

**Phase 3: Search and discovery (3–4 days).**
- Schema: lat/lng, city, country, startsAt/endsAt, timezone, status, slug, cover image URL.
- A single `/events` search endpoint with radius, date, category, free/paid filters and cursor pagination.
- Frontend: TanStack Query, the `/events` page with URL-driven filters, EventCard, skeletons and empty states.

**Phase 4: Booking integrity (1–2 days).** Atomic transactional booking, server-side pricing, idempotency key, and cancellation that restores stock. Add payment (Paystack/Stripe) only after this is solid.

**Phase 5: Design system and restyle (3–5 days).** Tokens, components, and a restyle of the existing pages (home, results, details, tickets, create wizard), with a mobile-first pass and accessibility fixes.

**Phase 6: Growth features.** Saved events, reminders, organiser pages, map view, add-to-calendar, OG/SEO (pre-render event pages or move to a framework with SSR), analytics.

---

## 7. Production checklist

- [ ] Secrets rotated; none in git; `.env.example` documents every variable
- [ ] `npm run build` and typecheck pass in CI on Linux
- [ ] Every mutating route authenticated; user taken from token; ownership/role checked
- [ ] Input validation on every route; consistent error shape; no stack traces to clients
- [ ] CORS allow-list, helmet, rate limiting
- [ ] Booking is atomic; overselling covered by a test
- [ ] Search returns 200 + empty list; paginated server-side; indexed
- [ ] Loading / empty / error / location-denied states on every data view
- [ ] Every link resolves; 404 page exists
- [ ] Lighthouse: performance ≥ 90 on mobile, accessibility ≥ 95
- [ ] Images sized and lazy-loaded; one icon library; one carousel
- [ ] Per-event title + OG meta for shared links
- [ ] Error monitoring (Sentry) and basic analytics
- [ ] DB backups; migrations run in deploy pipeline
- [ ] Tests: API integration (auth, booking, search) and a smoke E2E (search → details → book)
