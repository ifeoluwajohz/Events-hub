# Phase 3A: discovery, search and geospatial architecture

_Status: **proposal, awaiting approval.** No application code or schema has changed. Date: 2026-10-06._

Every performance number below was **measured** on a throwaway PostgreSQL 16 database (PostGIS 3.4, pg_trgm, earthdistance), using the real Phase 2B schema seeded with **200,000 events** (169,412 published) across 15 cities in Africa, Europe and North America. The scripts are in [`phase3/benchmark/`](./phase3/benchmark/) and can be re-run. No real database was touched.

Phase 3 builds the **discovery engine**; Phase 5 builds the experience on top of it. Nothing here redesigns the UI.

---

## A. Current search audit (state after Phase 2B)

### A.1 What exists

| Piece | Today |
|---|---|
| Search | `GET /public/events?q&location&category&from&to&price` → `listPublicEvents` (Prisma `contains, insensitive` = `ILIKE '%…%'`). Keywords match title, summary or description (OR). Location matches city, venue, address or region (OR). Sorted by start date only. |
| Location storage | `Event.venueName`, `addressLine`, `city`, `region`, `country` (free text) and `latitude`/`longitude` (nullable floats). No postal code, no normalized place, no geo index. |
| Geocoding | None. The OpenCage key was removed in Phase 0, and "Near me" shows a "not available yet" message. |
| Categories | `Category` table (name, slug, sortOrder, isActive), admin-managed, flat. **No categories exist yet**, so category filtering returns nothing. Events link to up to 5 categories. |
| Organizers | Public page by slug only; no organizer search or listing. |
| Saved / follows | Phase 2B tables with composite PKs and reverse indexes (details in section G). |
| Popularity | No signals recorded besides saves, follows and bookings; no trending. |

### A.2 Measured weaknesses

| # | Finding | Evidence |
|---|---|---|
| 1 | **Keyword search reads the whole published table when matches are rare or absent.** `ILIKE '%x%'` can't use an index, and it also scans full descriptions. | "hackathon" in Lagos (5 matches): **1,012 ms, read 169,407 rows**. |
| 2 | Common keywords are fast only because the scan stops at 21 hits. The cost grows with table size and query selectivity. | "film": 188 ms, read 32,821 rows. |
| 3 | **Location search is substring matching**, not geography. "Lagos" doesn't match an event in "Ikeja" (a district of Lagos). "York" matches "New York". No radius, no nearest-first. | By design of the query. |
| 4 | **No event currently has a city or coordinates.** Migrated events have only the legacy free-text `venue`. The live create-event form sends neither city nor coordinates. The API accepts organizer-typed `latitude`/`longitude` without any check. | Read from `backend/prisma/migrations/*backfill*`, `frontend/src/context/UserFlowContext.tsx`, `src/http/schemas.js`. |
| 5 | "Upcoming" uses `endsAt >= now OR (endsAt IS NULL AND startsAt >= now)`. The OR prevents a single index range. | Plans use `Event_status_date_idx` with a filter instead of a range. |
| 6 | No relevance ranking; results are always ordered by date. | Query shape. |
| 7 | **The home-page search sends a request on every keystroke**, including empty input (`location.trim() >= ""` is always true). | `HeroSection.tsx:18`. |
| 8 | **Every API response is `Cache-Control: no-store`**, including anonymous public discovery, so a CDN can't absorb read traffic. | `src/http/security.js:23`. |
| 9 | List responses carry the full event (description, all ticket types, gallery), too heavy for result lists. | `serializers.eventPublic` used for lists. |
| 10 | The price filter uses `every`/`some` ticket-type subqueries. That's fine now, but there's no index on `TicketType(eventId, status, priceMinor)`. | Schema. |
| 11 | Cursor pagination uses the event `id` with a date sort. That works, but it can't page relevance- or distance-sorted results. | Query shape. |
| 12 | Follower counts are computed with `count(*)` on every organizer page view. | `organizers.getPublicOrganizer`. |

---

## B. Proposed discovery architecture

```
            ┌──────────── /public (anonymous, cacheable) ───────────┐
 Browser ──▶│ /search  /events/nearby  /events/trending  /categories │──▶ SearchService ──▶ PostgreSQL
            │ /organizers  /places  /seo/*  /sitemaps/*              │      (SQL builder,       ├─ Event (+ search_tsv, geo, listUntil)
            └────────────────────────────────────────────────────────┘       keyset cursors)    ├─ Place (cities)
            ┌──────────── /me (authenticated, never cached) ────────┐                           ├─ Category (tree)
            │ saved/follow lookups for result lists                 │──▶ engagement services    ├─ EventStats / EventDailyStat
            └────────────────────────────────────────────────────────┘                           └─ (TicketType, Organizer …)
 Jobs:  trending-score (every 10–15 min) · complete-events (existing)
```

The design principles:
1. **PostgreSQL stays the single source of truth and the search engine** for this phase. The measurements show it's fast enough when indexed correctly (section F).
2. **Search lives behind one `SearchService`**, which builds parameterized SQL. Routes never write SQL. Swapping the geo implementation (PostGIS ↔ earthdistance) or adding an external engine later is local to that service.
3. **Public endpoints are anonymous and cacheable.** Personal state (saved, followed) comes from separate `/me` batch lookups, so personalization never breaks the cache.
4. **Location is captured as structured data, never guessed** (section C). Events without trustworthy coordinates are simply excluded from nearby search and reported. This follows the fail-closed guardrail.

---

## C. Location model and geospatial strategy

### C.1 Location model

The location stays **embedded on `Event`** (one row, one index set, and the historical record survives later venue changes). It gets these fields:

| Field | Purpose | Status |
|---|---|---|
| `venueName`, `addressLine`, `region` (state), `country` (ISO-2) | Display and filters | exist |
| `city` | Display label | exists |
| `postalCode` | Address completeness | **new** |
| `placeId` → `Place` | Normalized city: city pages, city search, "popular locations", default timezone | **new** |
| `latitude`, `longitude` | Source of truth for coordinates | exist |
| `locationPrecision` | `ADDRESS` \| `CITY` \| `NONE`. Says whether coordinates are exact or a city centre, so a city centre is never shown as an exact pin. | **new** |
| `locationSource` | `ORGANIZER_PIN` \| `PLACE_CENTROID` \| `GEOCODER` \| `LEGACY` (provenance) | **new** |
| `geog` (PostGIS) **or** earth-cube expression | Spatial index target, **derived** from lat/lng (by trigger; never written by the app) | **new** |
| `timezone` | IANA zone; defaults from `Place` | exists |
| `listUntil` | `coalesce(endsAt, startsAt)`, so "upcoming" is a single index range (finding A.2-5) | **new**, by trigger |

**`Place` (new reference table)** holds cities seeded from **GeoNames `cities15000`**: about 26,000 cities worldwide with population ≥ 15k, licensed CC BY 4.0, with no API cost. Columns:
- `geonameId` (unique), `name`, `asciiName`, `slug`
- `countryCode`, `admin1Name` (state)
- `latitude`, `longitude`, `timezone`, `population`
- `geog`

It lets the platform, **without any geocoding provider**:
- Offer location autocomplete ("Lag…" → "Lagos, Nigeria"), via a trigram index on `asciiName`.
- Search by city as **centre + radius** (catches Ikeja, Yaba and Lekki for "Lagos") instead of matching text.
- Label "Near me" results by finding the **nearest city** to the browser's coordinates (index KNN, 0.6 ms class).
- Serve city and country pages for SEO (`/events/ng/lagos`) and "popular locations".
- Default an event's timezone.

**How coordinates get onto events (no guessing):**
- **MVP, no provider:** the organizer picks the city from `Place` (`precision = CITY`, `source = PLACE_CENTROID`) and may optionally drop a pin later (`ADDRESS`, `ORGANIZER_PIN`) once a map exists in Phase 5.
- **Later:** a server-side geocoder turns the address into exact coordinates (`GEOCODER`). The key stays in the backend; the provider is an open decision (O.3).
- **Migrated and existing events** keep NULL coordinates and `precision = NONE` until an organizer or admin selects the city. **The migration doesn't guess a city from free text.** The report lists how many events are affected.
- **Online events** have no coordinates. Nearby search excludes them by default; `mode=online` finds them.

### C.2 Geospatial options

| | A. PostGIS | B1. Plain lat/lng maths | B2. `cube` + `earthdistance` (contrib) | C. External engine (Algolia / Typesense / Elastic) |
|---|---|---|---|---|
| Nearby, dense area (Lagos, 10 km) | 19.7 ms (radius) / **0.56 ms** (nearest-first) | 22.5 ms | 9.1 ms | very fast |
| Nearby, sparse area (Kano, 25 km, 0 results) | **0.19 ms** | **268 ms, read 141,130 rows** | **0.11 ms** | very fast |
| Nearest-first ordering (KNN) | yes, indexed | no | no (sort after filter) | yes |
| Polygons later (city boundaries, regions) | yes | no | no | partial |
| Accuracy | geodesic | spherical formula | spherical (fine for events) | provider-defined |
| Availability | Needs the extension on the host (most managed Postgres have it; must confirm, O.1) | Always | Contrib, almost universal | Separate service |
| Prisma fit | `Unsupported("geography(Point,4326)")` + GiST. **Verified: drift check stays clean** and the client generates. Queries are raw SQL. | native | expression index (raw SQL) | outside Prisma |
| Cost and complexity | low; free | lowest; doesn't scale | low; free | **high**: hosting/fees, a sync pipeline, a second source of truth, and visibility rules re-implemented outside the API |

**Recommendation:**
- **MVP and scale:** **A (PostGIS)** if the host supports it, because it's the only option with indexed nearest-first and room for polygons. Otherwise **B2 (earthdistance)**, measured in the same performance class for radius search. The choice is isolated in one `geo` module, so it's reversible.
- **Never B1:** it collapses on sparse queries.
- **C is deferred** until the triggers in section H appear. When it comes, Postgres remains the source of truth and the authorization filter: the engine returns ids, and Postgres hydrates them and re-checks visibility.

---

## D. Category model

**A table, not an enum.**
- Admins change the taxonomy without a deploy or migration.
- It carries metadata for SEO and UI (slug, description, icon, sort order, active flag).
- It's already the Phase 2B model.

An enum would need a migration for every change and can't hold metadata.

| Change | Detail |
|---|---|
| `Category.parentId` (self-relation) | **Two levels max** (top-level → subcategory, e.g. Music → Afrobeats). Enforced in the service. |
| `description`, `icon` | SEO and UI metadata |
| `EventCategory.isPrimary` | **Exactly one primary per event**, required at submit for **new** events. Migrated events are exempt (no guessing). Primary drives cards, SEO and "browse by category". |
| Seed (reference data, idempotent by slug) | `music`, `business`, `tech`, `sports`, `arts`, `food`, `fashion`, `education`, `community`, `other` |
| Filtering | `category=music` includes subcategories (two-level join, indexed by `EventCategory(categoryId)`). |
| Migration safety | Existing categories are kept. If an existing category conflicts with a seed slug or name, the seed **stops and reports** rather than merging (fail closed). |

---

## E. Filters and search APIs

### E.1 Filter model (backend support only; no UI built)

| Filter | Parameter(s) | Implementation |
|---|---|---|
| Keywords | `q` | Postgres full-text (`websearch_to_tsquery('simple', q)`, prefix match on the last term) with a trigram fallback on titles for typos |
| Date | `from`, `to` (ISO) **or** `when=today\|tomorrow\|weekend\|this_week\|this_month` plus `tz` (IANA, the viewer's zone) | Presets resolved server-side in the viewer's timezone (O.6) |
| Distance | `lat`, `lng`, `radiusKm` (default 25, max 200) | Geo index; results carry `distanceKm` |
| City / country | `place=<placeId or ng/lagos>`, `country=NG` | City = place centre + radius (`placeId` for exact city pages); country = indexed equality |
| Category | `category=<slug>` (includes children) | `EventCategory` join |
| Organizer | `organizer=<slug>` | `organizerId` equality |
| Price | `price=free\|paid`; `priceMin`, `priceMax` **only with `currency=`** (amounts in different currencies can't be compared) | `EXISTS` on `TicketType` with a new index |
| Availability | `available=true` (hide sold out; derived, never stored) | `EXISTS (quantitySold < quantityTotal)` |
| Mode | `mode=in_person\|online\|hybrid` | `attendanceMode` |
| Trust | `verified=true` (verified organizers only) | Organizer join |
| Sort | `sort=relevance\|date\|distance\|popular` | Default: relevance with `q`, distance with `lat`/`lng`, otherwise date |

Unknown parameters are rejected (as in Phase 2B), so the UI can't silently rely on filters the backend doesn't support.

### E.2 Endpoints

Paths stay under the Phase 2B `/public` and `/me` boundaries. The paths you listed map as shown.

| Requested | Endpoint | Notes |
|---|---|---|
| `/search` | `GET /public/search` | All filters above. Keyset cursor. Returns **card** results (below). `GET /public/events` stays as a compatibility alias, so the current frontend keeps working. |
| `/events/nearby` | `GET /public/events/nearby?lat&lng&radiusKm&…` | Same service; `sort=distance`; online events excluded |
| `/events/trending` | `GET /public/events/trending?place\|lat,lng&category&window=7d` | Ordered by `EventStats.trendingScore` (section I) |
| `/events/category` | `GET /public/categories` (tree), `GET /public/categories/:slug/events` | Includes subcategories |
| `/organizers` | `GET /public/organizers?q&country&place&verified&sort=followers\|upcoming` | Trigram name search; active organizers only |
| (new) location | `GET /public/places?q=lag` (autocomplete), `GET /public/places/nearest?lat&lng`, `GET /public/places/popular?country` | Powered by `Place`; no provider |
| (new) personal state | `POST /me/saved-events/lookup {eventIds[]}`, `POST /me/follows/lookup {organizerIds[]}` | Lets the UI show "saved" or "following" on cached public results |
| (new) signals | `POST /public/events/:id/view`, `POST /public/events/:id/share {channel}` | Rate-limited beacons (section I) |
| (new) SEO | `GET /public/seo/events/:slug`, `/public/seo/organizers/:slug`, `/public/seo/places/:country/:city`, `GET /public/sitemaps/index.xml` (+ paged sitemaps) | Section J |

**Card shape** (list results; no description):
- `id`, `slug`, `title`, `summary`, `startsAt`, `timezone`, `coverImageUrl`
- `venueName`, `city`, `country`, `attendanceMode`
- `primaryCategory {slug, name}`, `organizer {slug, displayName, verified}`
- `isFree`, `priceFromMinor`, `currency`, `soldOut`
- `distanceKm` (geo queries only), `trendingRank` (trending only)

**Cursor:** opaque and signed, encoding `{sortKey…, id}` for keyset pagination. Works for relevance, date, distance and popularity sorts with no OFFSET.

### E.3 Query examples (the shape the SearchService will generate)

```sql
-- Keyword + city (relevance), measured 6.6 ms vs 1,012 ms today
SELECT e.id, ts_rank_cd(e.search_tsv, q) AS rank
FROM "Event" e, websearch_to_tsquery('simple', $1) q
WHERE e.status = 'PUBLISHED' AND e."listUntil" >= now()
  AND e.search_tsv @@ q
  AND e."placeId" = $2
ORDER BY rank DESC, e."date", e.id
LIMIT 21;

-- Nearby, nearest first (PostGIS KNN), measured 0.56 ms
SELECT e.id, ST_Distance(e.geog, p) / 1000 AS distance_km
FROM "Event" e, ST_SetSRID(ST_MakePoint($lng, $lat), 4326)::geography p
WHERE e.status = 'PUBLISHED' AND e."listUntil" >= now()
  AND ST_DWithin(e.geog, p, $radius_m)
ORDER BY e.geog <-> p, e.id
LIMIT 21;

-- Same with earthdistance (fallback), measured 9.1 ms / 0.11 ms sparse
SELECT e.id FROM "Event" e
WHERE e.status = 'PUBLISHED' AND e."listUntil" >= now()
  AND earth_box(ll_to_earth($lat, $lng), $radius_m) @> ll_to_earth(e.latitude, e.longitude)
  AND earth_distance(ll_to_earth($lat, $lng), ll_to_earth(e.latitude, e.longitude)) <= $radius_m
ORDER BY e."date", e.id
LIMIT 21;

-- Free events only (derived; no stored flag)
... AND EXISTS (SELECT 1 FROM "TicketType" t WHERE t."eventId" = e.id AND t.status = 'ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM "TicketType" t WHERE t."eventId" = e.id AND t.status = 'ACTIVE' AND t."priceMinor" > 0)
```

All queries are parameterized. The organizer-suspension rule (`organizer.status = 'ACTIVE'`) and the visibility rules from Phase 2B are applied by the service on every query.

---

## F. Indexes

| Purpose | Index (all **partial** `WHERE status = 'PUBLISHED'` unless noted) | Measured |
|---|---|---|
| Upcoming by date | `(listUntil, date)` replacing the OR predicate | — |
| Full-text | `GIN (search_tsv)`. Weights: title A, summary B, venue and city C, description D. `'simple'` config (no English-only stemming; multilingual-safe). | 4.7 MB / 200k events; keyword queries 6–14 ms |
| Typos and autocomplete on titles | `GIN (lower(title) gin_trgm_ops)` | "hackaton" → 71 ms (used as fallback only, when FTS finds too few) |
| City pages | `(placeId, listUntil)` | Kigali browse **1.3 ms** (vs 43 ms) |
| Country | `(country, listUntil)` | — |
| Nearby | `GIST (geog)` (A) or `GIST (ll_to_earth(lat, lng))` (B2) | 12–13 MB; 0.1–20 ms |
| Popular | `(trendingScore DESC)` and `(placeId, trendingScore DESC)` on `EventStats` (upcoming only) | — |
| Price / availability | `TicketType (eventId, status, priceMinor)` (not partial) | — |
| Category | existing `EventCategory(categoryId)`; add `(eventId) WHERE isPrimary` | — |
| Organizer search | `GIN (lower(displayName) gin_trgm_ops)` on `Organizer` | — |
| Places | `(countryCode, slug)` unique, `GIN (lower(asciiName) gin_trgm_ops)`, `GIST (geog)`, `(population DESC)` | — |
| Saved list | `SavedEvent (userId, createdAt DESC)` | — |

**Sorting:**
- Date sorts walk the `(…, date)` indexes and stop at the limit.
- Relevance sorts rank only the GIN candidates (bounded).
- Distance uses KNN with PostGIS, or a bounded radius set then sort with B2.

The radius is capped at 200 km so the candidate set stays bounded.

**Building them safely (measured lesson):** adding a *generated stored* column rewrote the whole 200k-row table in **12.7 s under an exclusive lock**. Production migrations will instead:
1. Add plain nullable columns, which is instant.
2. Maintain them with a `BEFORE INSERT/UPDATE` trigger.
3. Backfill in batches.
4. `CREATE INDEX CONCURRENTLY`, in its own non-transactional migration step.

---

## G. Saved events and followed organizers

**Saved events (Phase 2B review):**
- The composite PK `(userId, eventId)` already prevents duplicates, and `(eventId)` supports counts.
- Missing: `(userId, createdAt DESC)` for the "my saved" list ordering.
- API additions: a batch lookup (section E.2), plus a `saved` filter on `/me/saved-events` (upcoming / past).
- Scale: per-user lists are small. Per-event save counts move to `EventStats.savesTotal`, so popular events don't `count(*)` on every view.

**Follows:**
- The model is fine: composite PK and `(organizerId)`.
- Additions: `OrganizerStats` (`followersTotal`, `upcomingEventsTotal`), refreshed by the stats job; organizer search (section E.2); batch lookup.
- Feed later: "events from organizers I follow" is `OrganizerFollow ⋈ Event (organizerId, listUntil)`, served by the existing `Event(organizerId, status)` index plus `listUntil`. It doesn't need recommendations to work.

---

## H. Scalability plan

| Stage | Volume (rough) | Approach |
|---|---|---|
| **Now → MVP** | ≤ 1M events | Single Postgres, the indexes above, cached `/public` responses (`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate`, ETag; `/me` stays `no-store`), and a debounced frontend. The measured p95-class latencies are all under 20 ms at 200k events. |
| **Growth** | 1–10M events, heavy traffic | Read replica for `/public`; CDN; materialized city/category counts; stats jobs on a schedule. |
| **External engine trigger** | When any of these is true: p95 search > 200 ms at target load; typo tolerance and synonyms needed across languages; faceted counts needed at scale | Typesense or Meilisearch (self-hostable) fed by a **transactional outbox** table and a worker. The engine returns ids; Postgres hydrates them and re-applies visibility and authorization. |

---

## I. Trending and popularity foundation (no recommendation AI)

**Signals and how they're captured:**

| Signal | Source | Capture |
|---|---|---|
| Ticket bookings | `Ticket` (exists) | derived by the job |
| Saves | `SavedEvent.createdAt` (exists) | derived by the job |
| Organizer follows | `OrganizerFollow` (exists) | derived by the job |
| Views | **new** `POST /public/events/:id/view` beacon | Deduplicated per visitor per day. The visitor key is the user id when signed in, otherwise an HMAC of IP + user agent with a **daily-rotated salt**. **No raw IP is stored.** Bots filtered by user agent; rate-limited. |
| Shares | **new** `POST /public/events/:id/share {channel}` | Same dedupe |

**Tables:**
- `EventDailyStat (eventId, day)`: views, uniqueViews, shares, saves, tickets.
- `EventViewDedupe (day, eventId, visitorHash)`: purged after 2 days.
- `EventStats (eventId PK)`: savesTotal, ticketsTotal, views7d, shares7d, trendingScore, scoreUpdatedAt.
- `OrganizerStats (organizerId PK)`.

**Score** (job every 10–15 min, upcoming published events only):

```
trendingScore = Σ over last 14 days of  (5·tickets + 3·saves + 2·shares + 0.1·uniqueViews)_day · 0.5^(ageDays / 3)
```

That's a weighted, time-decayed sum, with weights in config so they can be tuned without a migration.

**Anti-gaming:**
- An organizer's own views, saves and tickets are excluded.
- Each user counts once per signal (the PKs guarantee it).
- Beacons are rate-limited.
- Per-event daily caps.
- Admin-suspended events are excluded.

**Trending by place** is the place filter plus `ORDER BY trendingScore`. These signals, plus follows and category affinity, are what Phase 6+ recommendations will consume. Nothing in Phase 3 makes personalized predictions.

---

## J. SEO (backend support only)

- **Stable URLs:** events by `slug` (exists; slugs become **immutable after first publish**), organizers by `slug`, cities by `country/city-slug` from `Place`.
- **Metadata endpoints** (`/public/seo/...`) return everything needed for `<title>`, description, canonical URL (`PUBLIC_SITE_URL` env), Open Graph and Twitter image, and **schema.org `Event` JSON-LD**:
  - `name`, `startDate`, `endDate`, `eventStatus` (`EventCancelled` for cancelled events), `eventAttendanceMode`
  - `location` (`Place` / `VirtualLocation`)
  - `offers` (price, currency, availability derived from inventory)
  - `organizer` (name, url)
  - `image`
  - Built only from real data: no invented ratings or availability.
- **Sitemaps:** a sitemap index plus paged event, organizer and city sitemaps. Only `PUBLISHED`/`COMPLETED` events; `lastmod` = `updatedAt`.
- **Rendering:** the frontend is a client-side SPA, so crawlers and link previews need server-rendered or prerendered HTML. That's a **frontend/hosting task (Phase 6)**. The backend endpoints above are what it will consume.

---

## K. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Database host may not offer PostGIS** | Design supports B2 (earthdistance), measured equivalent for radius search; one `geo` module. Needs your answer (O.1). |
| R2 | **No event has coordinates or a city today** (migrated and newly created) | Place-based city selection in the create flow; migrated events stay out of nearby and city search until completed; coverage counts in `migrate:report`. No guessing from free text. |
| R3 | Long table locks when adding columns and indexes | Trigger-maintained columns, batched backfill, `CREATE INDEX CONCURRENTLY` (section F) |
| R4 | `'simple'` text config: no stemming ("concerts" vs "concert") | Prefix matching on the last term, trigram fallback on titles; revisit per language later |
| R5 | Raw SQL loses Prisma's type safety | One SearchService, parameterized only, plus tests that assert results **and index usage** (`EXPLAIN`) on seeded data |
| R6 | Personalization vs caching | Public responses are anonymous; personal flags via `/me` batch lookups |
| R7 | Privacy of view tracking (NDPA/GDPR) | No raw IPs, daily-rotated salt, 2-day dedupe retention, aggregates only. Needs approval (O.4). |
| R8 | Trending manipulation | Exclusions, per-user uniqueness, caps, rate limits; weights in config |
| R9 | Timezone semantics of "this weekend" | Resolved in the viewer's IANA zone from `tz`; definition needs approval (O.6) |
| R10 | Multi-currency price ranges | Range filters require `currency`; free/paid works across currencies |
| R11 | GeoNames attribution and data size | CC BY 4.0 attribution in the About page; ~26k rows (a few MB); loaded by an idempotent seed script, not committed as a huge migration |
| R12 | Trigram typo fallback is the slowest path (71 ms) | Used only when full-text returns too few results; title-only; bounded |

---

## L. Recommended implementation order (Phase 3B)

1. **Benchmark and test harness:** seeded discovery fixture plus tests that assert results *and* that plans use the intended index (no seq scans on hot paths).
2. **Location foundation (migrations):**
   - Extension (PostGIS or cube/earthdistance per O.1).
   - `Place` table plus an idempotent GeoNames seed script.
   - Event location columns (`postalCode`, `placeId`, `locationPrecision`, `locationSource`, `listUntil`, geo column, `search_tsv`) via triggers, a batched backfill (`listUntil`, `search_tsv` only; **no coordinates invented**), and concurrent indexes.
   - `migrate:report` extended with location-coverage counts.
3. **Categories:** `parentId`, `isPrimary`, metadata, the 10-category seed (fail closed on conflicts), primary category required at submit for new events.
4. **SearchService:** filter model, keyset cursors, card serializer, `GET /public/search`, with `/public/events` as an alias.
5. **Discovery endpoints:** nearby, categories, organizers, places.
6. **Engagement:** saved/follow indexes, batch lookups, `OrganizerStats`.
7. **Signals and trending:** stats tables, view/share beacons, trending job, `/public/events/trending`.
8. **SEO and caching:** SEO endpoints, sitemaps, per-router `Cache-Control`.
9. **Contract-only frontend changes (needs approval, O.7):**
   - Debounce the search box.
   - Re-enable **"Near me" using the browser's own geolocation**: no API key; the coordinates go to `/events/nearby`, and the label comes from `/places/nearest`.
   - City autocomplete for the existing location box and the create-event form.
10. **Docs and CI:** drift check with the extension, benchmark assertions, runbook updates.

---

## M. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| O.1 | **Which database host, and does it support PostGIS?** | PostGIS if available, earthdistance otherwise |
| O.2 | Use the **GeoNames `cities15000`** dataset (CC BY 4.0, worldwide) for `Place`? | Yes, worldwide; attribution on the About page |
| O.3 | **Geocoding provider** for exact addresses? | Defer. MVP uses city selection, with an optional pin later. |
| O.4 | Record **anonymous views and shares** (hashed with a rotating salt, no IP stored, aggregates kept)? | Yes |
| O.5 | Approve the **10 top-level categories**, and a primary category required for new events? | Yes; subcategories added by admins later |
| O.6 | Defaults: radius **25 km** (max 200); **weekend = Friday 17:00 → Sunday 23:59** in the viewer's timezone | Yes |
| O.7 | Allow the three **contract-only frontend changes** in step 9 (debounce, Near me via browser geolocation, city autocomplete)? | Yes. They make Phase 3 usable without the Phase 5 redesign. |
