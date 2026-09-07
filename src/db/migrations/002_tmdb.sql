-- 002: TMDB enrichment (build step 2).
--
-- The TMDB cache is keyed by tmdb_id, not film_id, on purpose. Step 4 seeds a
-- candidate pool (Sight & Sound, TSPDT, Criterion, regional lists) of films
-- that are not in `films` at all, and those need the same metadata. Keying the
-- cache to TMDB means step 4 reuses everything here instead of duplicating it.
--
-- `film_matches` is the join between my Letterboxd films and that cache.

CREATE TABLE IF NOT EXISTS tmdb_films (
  tmdb_id           INTEGER PRIMARY KEY,
  imdb_id           TEXT,
  title             TEXT NOT NULL,
  original_title    TEXT,
  original_language TEXT,
  release_date      TEXT,
  year              INTEGER,
  runtime           INTEGER,          -- minutes; null for some shorts
  poster_path       TEXT,
  backdrop_path     TEXT,
  overview          TEXT,
  popularity        REAL,
  vote_average      REAL,
  vote_count        INTEGER,
  fetched_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tmdb_films_year ON tmdb_films (year);

CREATE TABLE IF NOT EXISTS tmdb_people (
  person_id INTEGER PRIMARY KEY,
  name      TEXT NOT NULL
);

-- Only directors are written today. The `job` column leaves room for writers,
-- cinematographers and composers later without a migration.
CREATE TABLE IF NOT EXISTS tmdb_film_crew (
  tmdb_id   INTEGER NOT NULL REFERENCES tmdb_films (tmdb_id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES tmdb_people (person_id),
  job       TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, person_id, job)
);
CREATE INDEX IF NOT EXISTS tmdb_film_crew_person ON tmdb_film_crew (person_id, job);

-- ISO 3166-1 alpha-2, every production country a film lists. TMDB returns these
-- sorted alphabetically by code, so `position` records the order it gave and
-- means nothing about significance. The lead country is tmdb_films.origin_country
-- (migration 004).
CREATE TABLE IF NOT EXISTS tmdb_film_countries (
  tmdb_id  INTEGER NOT NULL REFERENCES tmdb_films (tmdb_id) ON DELETE CASCADE,
  country  TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, country)
);
CREATE INDEX IF NOT EXISTS tmdb_film_countries_country ON tmdb_film_countries (country);

CREATE TABLE IF NOT EXISTS tmdb_film_genres (
  tmdb_id  INTEGER NOT NULL REFERENCES tmdb_films (tmdb_id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, genre_id)
);

-- Belgian availability, per §3 of the brief. Refreshed independently of the
-- rest of the metadata because it goes stale fast.
CREATE TABLE IF NOT EXISTS tmdb_watch_providers (
  tmdb_id       INTEGER NOT NULL REFERENCES tmdb_films (tmdb_id) ON DELETE CASCADE,
  region        TEXT    NOT NULL,
  offer_type    TEXT    NOT NULL,      -- flatrate | free | ads | rent | buy
  provider_id   INTEGER NOT NULL,
  provider_name TEXT    NOT NULL,
  fetched_at    TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, region, offer_type, provider_id)
);

-- One row per Letterboxd film, matched or not. `method` records how confident
-- the match is; anything not confirmed shows up in `npm run matches`.
CREATE TABLE IF NOT EXISTS film_matches (
  film_id         INTEGER PRIMARY KEY REFERENCES films (id) ON DELETE CASCADE,
  tmdb_id         INTEGER REFERENCES tmdb_films (tmdb_id),
  method          TEXT    NOT NULL,    -- override | exact | near | fuzzy | unmatched
  score           REAL,
  confirmed       INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  candidates_json TEXT,                -- runners-up, to make manual review cheap
  matched_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS film_matches_tmdb ON film_matches (tmdb_id);
CREATE INDEX IF NOT EXISTS film_matches_method ON film_matches (method);

-- Manual resolutions, loaded from data/tmdb-overrides.csv on every enrich run.
-- Keyed by the Letterboxd permalink rather than film_id so the file survives
-- deleting and rebuilding the database. A null tmdb_id means "deliberately
-- unmatchable", which stops it being reported as a failure forever.
CREATE TABLE IF NOT EXISTS film_match_overrides (
  lb_uri  TEXT PRIMARY KEY,
  tmdb_id INTEGER,
  note    TEXT
);

-- ---------------------------------------------------------------------------
-- Rebuild ingest_issues so non-import stages (enrichment, and later the pick
-- engine) can log to the same table. import_id becomes nullable and a `stage`
-- column says which part of the pipeline spoke.
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_issues_v2 (
  id         INTEGER PRIMARY KEY,
  import_id  INTEGER REFERENCES imports (id) ON DELETE CASCADE,
  stage      TEXT    NOT NULL DEFAULT 'import',
  source     TEXT    NOT NULL,
  severity   TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  payload    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO ingest_issues_v2 (id, import_id, stage, source, severity, code, message, payload)
SELECT id, import_id, 'import', source, severity, code, message, payload FROM ingest_issues;

DROP TABLE ingest_issues;
ALTER TABLE ingest_issues_v2 RENAME TO ingest_issues;

CREATE INDEX IF NOT EXISTS ingest_issues_import ON ingest_issues (import_id);
CREATE INDEX IF NOT EXISTS ingest_issues_stage ON ingest_issues (stage, severity);
