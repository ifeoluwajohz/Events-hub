-- Phase 3A benchmark (throwaway database only). Requires: migrated schema, pg_trgm, cube, earthdistance, postgis.
-- Usage: psql -d bench -f 01-seed-200k-events.sql; -f 02-candidate-indexes.sql; -f 03-queries.sql
INSERT INTO "User"(id,"clerkUserId",email,name,"updatedAt") SELECT 'u'||g,'user_'||g,'u'||g||'@x.test','Org '||g,now() FROM generate_series(1,2000) g;
INSERT INTO "Organizer"(id,"ownerUserId",slug,"displayName","verificationStatus","updatedAt") SELECT 'o'||g,'u'||g,'org-'||g,'Organizer '||g, CASE WHEN g%5=0 THEN 'VERIFIED' ELSE 'NOT_STARTED' END::"OrganizerVerificationStatus",now() FROM generate_series(1,2000) g;
CREATE TEMP TABLE cities(i int, city text, cc text, lat float8, lng float8, tz text);
INSERT INTO cities VALUES (0,'Lagos','NG',6.5244,3.3792,'Africa/Lagos'),(1,'Abuja','NG',9.0765,7.3986,'Africa/Lagos'),(2,'Ibadan','NG',7.3775,3.9470,'Africa/Lagos'),(3,'Port Harcourt','NG',4.8156,7.0498,'Africa/Lagos'),(4,'Accra','GH',5.6037,-0.1870,'Africa/Accra'),(5,'Kumasi','GH',6.6885,-1.6244,'Africa/Accra'),(6,'Nairobi','KE',-1.2921,36.8219,'Africa/Nairobi'),(7,'Johannesburg','ZA',-26.2041,28.0473,'Africa/Johannesburg'),(8,'Cape Town','ZA',-33.9249,18.4241,'Africa/Johannesburg'),(9,'London','GB',51.5072,-0.1276,'Europe/London'),(10,'Manchester','GB',53.4808,-2.2426,'Europe/London'),(11,'New York','US',40.7128,-74.0060,'America/New_York'),(12,'Houston','US',29.7604,-95.3698,'America/Chicago'),(13,'Toronto','CA',43.6532,-79.3832,'America/Toronto'),(14,'Kigali','RW',-1.9441,30.0619,'Africa/Kigali');
CREATE TEMP TABLE words(i int, w text); INSERT INTO words SELECT row_number() over()-1, w FROM unnest(string_to_array('jazz,afrobeats,tech,startup,meetup,conference,fashion,week,food,festival,art,exhibition,comedy,night,book,club,football,watch,party,gospel,concert,yoga,workshop,career,fair,film,premiere,wine,tasting,hackathon,design,summit,marathon,charity,gala,poetry,slam,market,crafts,dance',',')) w;
INSERT INTO "Event"(id,"organizerId",slug,title,"shortDescription","longDescription",status,"date","endsAt",timezone,venue,city,country,latitude,longitude,currency,"publishedAt","updatedAt")
SELECT 'e'||g, 'o'||(1+g%2000), 'ev-'||g,
  initcap(w1.w||' '||w2.w||' '||w3.w), 'A '||w1.w||' and '||w2.w||' gathering in '||c.city,
  repeat('Join us for '||w1.w||' '||w2.w||' with friends, music and food. ',6),
  CASE WHEN g%10=0 THEN 'DRAFT' WHEN g%17=0 THEN 'COMPLETED' ELSE 'PUBLISHED' END::"EventLifecycleStatus",
  now() + ((g%540)-90)*interval '1 day', NULL, c.tz, 'Venue '||(g%300), c.city, c.cc,
  c.lat + (random()-0.5)*0.4, c.lng + (random()-0.5)*0.4, 'NGN', now(), now()
FROM generate_series(1,200000) g
JOIN cities c ON c.i = g%15
JOIN words w1 ON w1.i = (g*7)%40 JOIN words w2 ON w2.i = (g*13)%40 JOIN words w3 ON w3.i = (g*29)%40;
INSERT INTO "TicketType"(id,"eventId",name,"priceMinor","quantityTotal","quantitySold","updatedAt")
SELECT 't'||id, id, 'General admission', CASE WHEN substr(id,2)::int%3=0 THEN 500000 ELSE 0 END, 100, (substr(id,2)::int%120)::int%101, now() FROM "Event";
ANALYZE;
