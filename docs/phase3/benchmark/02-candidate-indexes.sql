CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS cube; CREATE EXTENSION IF NOT EXISTS earthdistance; CREATE EXTENSION IF NOT EXISTS postgis;
\timing on
-- full-text: weighted, 'simple' config (no English-only stemming), generated so the app never writes it
ALTER TABLE "Event" ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
  setweight(to_tsvector('simple', coalesce("shortDescription",'')), 'B') ||
  setweight(to_tsvector('simple', coalesce(venue,'') || ' ' || coalesce(city,'')), 'C') ||
  setweight(to_tsvector('simple', coalesce("longDescription",'')), 'D')) STORED;
CREATE INDEX event_search_tsv_gin ON "Event" USING gin (search_tsv) WHERE status = 'PUBLISHED';
-- typo/prefix tolerance on titles
CREATE INDEX event_title_trgm ON "Event" USING gin (lower(title) gin_trgm_ops) WHERE status = 'PUBLISHED';
-- normalized city browse
ALTER TABLE "Event" ADD COLUMN city_key text GENERATED ALWAYS AS (lower(country) || ':' || lower(city)) STORED;
CREATE INDEX event_city_upcoming ON "Event"(city_key, "date") WHERE status = 'PUBLISHED';
-- geo option B2: earthdistance (contrib)
CREATE INDEX event_earth_gist ON "Event" USING gist (ll_to_earth(latitude, longitude)) WHERE status = 'PUBLISHED' AND latitude IS NOT NULL;
-- geo option A: PostGIS geography generated from lat/lng
ALTER TABLE "Event" ADD COLUMN geog geography(Point,4326) GENERATED ALWAYS AS (
  CASE WHEN latitude IS NULL OR longitude IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography END) STORED;
CREATE INDEX event_geog_gist ON "Event" USING gist (geog) WHERE status = 'PUBLISHED';
ANALYZE "Event";
SELECT pg_size_pretty(pg_relation_size('event_search_tsv_gin')) tsv, pg_size_pretty(pg_relation_size('event_title_trgm')) trgm, pg_size_pretty(pg_relation_size('event_earth_gist')) earth, pg_size_pretty(pg_relation_size('event_geog_gist')) geog, pg_size_pretty(pg_relation_size('"Event"')) heap;
