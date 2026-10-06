UPDATE "Event" SET title = 'Lagos Hackathon '||id WHERE id IN (SELECT id FROM "Event" WHERE status='PUBLISHED' AND city='Lagos' AND "date" > now() ORDER BY id LIMIT 5);
ANALYZE "Event";
\echo === CURRENT rare: hackathon + lagos (ILIKE)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND (e."endsAt" >= now() OR (e."endsAt" IS NULL AND e."date" >= now()))
  AND (e.title ILIKE '%hackathon%' OR e."shortDescription" ILIKE '%hackathon%' OR e."longDescription" ILIKE '%hackathon%')
  AND (e.city ILIKE '%lagos%' OR e.venue ILIKE '%lagos%' OR e."addressLine" ILIKE '%lagos%' OR e.region ILIKE '%lagos%')
ORDER BY e."date", e.id LIMIT 21;
\echo === NEW rare: hackathon in ng:lagos (FTS + city key)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND e.search_tsv @@ websearch_to_tsquery('simple','hackathon') AND e.city_key='ng:lagos' AND e."date" >= now()
ORDER BY ts_rank_cd(e.search_tsv, websearch_to_tsquery('simple','hackathon')) DESC, e."date", e.id LIMIT 21;
\echo === CURRENT common: film anywhere (ILIKE)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND (e."endsAt" >= now() OR (e."endsAt" IS NULL AND e."date" >= now()))
  AND (e.title ILIKE '%film%' OR e."shortDescription" ILIKE '%film%' OR e."longDescription" ILIKE '%film%')
ORDER BY e."date", e.id LIMIT 21;
\echo === NEW common: film anywhere, ranked (FTS)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND e.search_tsv @@ websearch_to_tsquery('simple','film') AND e."date" >= now()
ORDER BY ts_rank_cd(e.search_tsv, websearch_to_tsquery('simple','film')) DESC, e."date", e.id LIMIT 21;
\echo === NEW common: film anywhere, date order (FTS filter only)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND e.search_tsv @@ websearch_to_tsquery('simple','film') AND e."date" >= now()
ORDER BY e."date", e.id LIMIT 21;
\echo === FTS rare: hackathon in lagos (city key)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND e.search_tsv @@ websearch_to_tsquery('simple','hackathon') AND e.city_key='ng:lagos' AND e."date" >= now()
ORDER BY ts_rank_cd(e.search_tsv, websearch_to_tsquery('simple','hackathon')) DESC, e."date", e.id LIMIT 21;
\echo === FTS common: jazz anywhere, relevance + date
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e
WHERE e.status='PUBLISHED' AND e.search_tsv @@ websearch_to_tsquery('simple','jazz night') AND e."date" >= now()
ORDER BY ts_rank_cd(e.search_tsv, websearch_to_tsquery('simple','jazz night')) DESC, e."date", e.id LIMIT 21;
\echo === city browse: kigali upcoming
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e.city_key='rw:kigali' AND e."date" >= now() ORDER BY e."date", e.id LIMIT 21;
\echo === typo: hackaton (trigram on title)
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND lower(e.title) % 'hackaton' ORDER BY similarity(lower(e.title),'hackaton') DESC LIMIT 10;
\echo === nearby B1: naive haversine, 10km of Yaba Lagos
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e."date">=now()
 AND 6371*2*asin(sqrt(power(sin(radians(e.latitude-6.5095)/2),2)+cos(radians(6.5095))*cos(radians(e.latitude))*power(sin(radians(e.longitude-3.3711)/2),2))) <= 10
ORDER BY e."date" LIMIT 21;
\echo === nearby B2: earthdistance GiST
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e.latitude IS NOT NULL AND e."date">=now()
 AND earth_box(ll_to_earth(6.5095,3.3711), 10000) @> ll_to_earth(e.latitude, e.longitude)
 AND earth_distance(ll_to_earth(6.5095,3.3711), ll_to_earth(e.latitude, e.longitude)) <= 10000
ORDER BY e."date" LIMIT 21;
\echo === nearby A: PostGIS ST_DWithin, date order
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e."date">=now()
 AND ST_DWithin(e.geog, ST_SetSRID(ST_MakePoint(3.3711,6.5095),4326)::geography, 10000)
ORDER BY e."date" LIMIT 21;
\echo === nearby A: PostGIS KNN, nearest first
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e."date">=now()
ORDER BY e.geog <-> ST_SetSRID(ST_MakePoint(3.3711,6.5095),4326)::geography LIMIT 21;
\echo === sparse point (Kano, no events): naive haversine
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e."date">=now()
 AND 6371*2*asin(sqrt(power(sin(radians(e.latitude-12.0)/2),2)+cos(radians(12.0))*cos(radians(e.latitude))*power(sin(radians(e.longitude-8.52)/2),2))) <= 25
ORDER BY e."date" LIMIT 21;
\echo === sparse point: earthdistance GiST
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e.latitude IS NOT NULL AND e."date">=now()
 AND earth_box(ll_to_earth(12.0,8.52), 25000) @> ll_to_earth(e.latitude, e.longitude) AND earth_distance(ll_to_earth(12.0,8.52), ll_to_earth(e.latitude, e.longitude)) <= 25000
ORDER BY e."date" LIMIT 21;
\echo === sparse point: PostGIS
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT e.id FROM "Event" e WHERE e.status='PUBLISHED' AND e."date">=now()
 AND ST_DWithin(e.geog, ST_SetSRID(ST_MakePoint(8.52,12.0),4326)::geography, 25000) ORDER BY e."date" LIMIT 21;
