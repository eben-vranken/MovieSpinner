-- 004: store TMDB's origin_country.
--
-- tmdb_film_countries holds `production_countries`, which TMDB returns sorted
-- alphabetically by ISO code, not by significance. Treating its first entry as
-- "the" country put The Witch in Brazil (BR/CA/GB/US) and Blade Runner 2049 in
-- Canada (CA/GB/US), which quietly corrupts country coverage.
--
-- `origin_country` is the field that actually names the lead country, and it
-- says US for both. Production countries stay as they are, because the world
-- map in §7 genuinely wants every country a film was made in.

ALTER TABLE tmdb_films ADD COLUMN origin_country TEXT;

CREATE INDEX IF NOT EXISTS tmdb_films_origin ON tmdb_films (origin_country);
