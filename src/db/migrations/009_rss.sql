-- 009: the RSS delta (build step 7).
--
-- §3 sets this up as tier 2: the zip export stays the source of truth, and the
-- feed exists so that watching yesterday's pick marks it complete without me
-- touching anything. Letterboxd's feed carries <tmdb:movieId> on every item,
-- so this is an exact join rather than another title-matching problem.
--
-- Entries are kept rather than consumed, so a sync can be re-run safely and so
-- there is a record of what the feed said when a pick got resolved.

CREATE TABLE IF NOT EXISTS rss_entries (
  guid         TEXT PRIMARY KEY,          -- letterboxd-watch-123456, stable per entry
  tmdb_id      INTEGER,
  film_title   TEXT    NOT NULL,
  film_year    INTEGER,
  watched_date TEXT,
  rating       REAL,
  rewatch      INTEGER NOT NULL DEFAULT 0,
  liked        INTEGER NOT NULL DEFAULT 0,
  link         TEXT,
  first_seen   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS rss_entries_tmdb ON rss_entries (tmdb_id, watched_date);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY,
  ran_at      TEXT    NOT NULL,
  entries     INTEGER NOT NULL,
  new_entries INTEGER NOT NULL,
  resolved    INTEGER NOT NULL,          -- picks auto-marked watched
  note        TEXT
);
