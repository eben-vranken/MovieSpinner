-- 001: Letterboxd ingest (build step 1).
--
-- Identity model:
--   Letterboxd's film-level exports (watched/ratings/watchlist/likes) all carry
--   the same stable short permalink per film, e.g. https://boxd.it/azpY. That is
--   the canonical key. Verified 1:1 with (name, year) across the whole export.
--
--   diary.csv is the exception: its "Letterboxd URI" is the *diary entry*
--   permalink, not the film's. Diary rows resolve to a film by (name, year).
--
-- Import model:
--   A Letterboxd export is a complete snapshot, not a delta. So every snapshot
--   table below is wiped and rewritten inside a single transaction on import.
--   `films` is the exception: it accumulates, because TMDB enrichment (step 2)
--   hangs off film_id and must survive re-imports.

-- Canonical film identity. Append-only; rows are never deleted by an import.
CREATE TABLE IF NOT EXISTS films (
  id            INTEGER PRIMARY KEY,
  lb_uri        TEXT    NOT NULL UNIQUE,  -- https://boxd.it/xxxx
  name          TEXT    NOT NULL,
  year          INTEGER,
  first_seen_at TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS films_name_year ON films (name, year);
CREATE INDEX IF NOT EXISTS films_year ON films (year);

-- One row per zip processed. Provenance + a hash so a re-import of the same
-- file is recognisable.
CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY,
  source_file   TEXT    NOT NULL,
  source_sha256 TEXT    NOT NULL,
  exported_at   TEXT,                    -- from the zip filename, when parseable
  imported_at   TEXT    NOT NULL,
  username      TEXT,
  counts_json   TEXT    NOT NULL
);

-- Anything the importer could not resolve or found surprising. Step 2 (TMDB
-- matching) writes here too. Nothing is ever dropped silently.
CREATE TABLE IF NOT EXISTS ingest_issues (
  id         INTEGER PRIMARY KEY,
  import_id  INTEGER NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,           -- e.g. 'diary.csv'
  severity   TEXT    NOT NULL,           -- 'error' | 'warn' | 'info'
  code       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  payload    TEXT                        -- raw row as JSON
);
CREATE INDEX IF NOT EXISTS ingest_issues_import ON ingest_issues (import_id);

-- ---------------------------------------------------------------------------
-- Snapshot tables. Replaced wholesale on every import so removals propagate.
-- ---------------------------------------------------------------------------

-- watched.csv. `added_date` is when the film entered the Letterboxd profile,
-- NOT when it was watched. Use diary_entries.watched_date for that.
CREATE TABLE IF NOT EXISTS watched (
  film_id    INTEGER PRIMARY KEY REFERENCES films (id) ON DELETE CASCADE,
  added_date TEXT
);

-- ratings.csv. 0.5-5.0 in half steps.
CREATE TABLE IF NOT EXISTS ratings (
  film_id    INTEGER PRIMARY KEY REFERENCES films (id) ON DELETE CASCADE,
  rating     REAL    NOT NULL CHECK (rating >= 0.5 AND rating <= 5.0),
  rated_date TEXT
);

-- likes/films.csv. A film can be liked without being logged as watched.
CREATE TABLE IF NOT EXISTS likes (
  film_id    INTEGER PRIMARY KEY REFERENCES films (id) ON DELETE CASCADE,
  liked_date TEXT
);

-- watchlist.csv.
CREATE TABLE IF NOT EXISTS watchlist (
  film_id    INTEGER PRIMARY KEY REFERENCES films (id) ON DELETE CASCADE,
  added_date TEXT
);

-- diary.csv. One row per viewing, so a film can appear many times.
CREATE TABLE IF NOT EXISTS diary_entries (
  id           INTEGER PRIMARY KEY,
  entry_uri    TEXT    NOT NULL UNIQUE,  -- per-entry permalink, not the film's
  film_id      INTEGER NOT NULL REFERENCES films (id) ON DELETE CASCADE,
  logged_date  TEXT    NOT NULL,
  watched_date TEXT    NOT NULL,
  rating       REAL,
  rewatch      INTEGER NOT NULL DEFAULT 0 CHECK (rewatch IN (0, 1)),
  tags         TEXT
);
CREATE INDEX IF NOT EXISTS diary_entries_film ON diary_entries (film_id);
CREATE INDEX IF NOT EXISTS diary_entries_watched_date ON diary_entries (watched_date);
