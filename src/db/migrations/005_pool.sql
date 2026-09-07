-- 005: the candidate pool (build step 4).
--
-- The pool is seeded from several lists and then deduped. Membership is kept
-- per list rather than collapsed, because "how many lists agree on this film" is
-- a real signal the engine can use, and because a list can be reloaded or
-- dropped without rebuilding everything else.
--
-- Everything here keys on tmdb_id, which is why the TMDB cache in 002 was built
-- that way: a pool film that is not in my Letterboxd data still gets its
-- metadata, director, country and Belgian providers from the same tables.

CREATE TABLE IF NOT EXISTS pool_lists (
  slug      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,          -- canon | collection | regional
  source    TEXT,                   -- URL, or the discover query that built it
  note      TEXT,
  entries   INTEGER NOT NULL DEFAULT 0,
  resolved  INTEGER NOT NULL DEFAULT 0,
  loaded_at TEXT
);

-- One row per (list, film). `position` is the list's own ordering where it has
-- one: TSPDT rank, Criterion spine number. Null for unordered lists.
CREATE TABLE IF NOT EXISTS pool_list_entries (
  list_slug TEXT    NOT NULL REFERENCES pool_lists (slug) ON DELETE CASCADE,
  tmdb_id   INTEGER NOT NULL,
  position  INTEGER,
  title     TEXT,                   -- as the source wrote it, for debugging
  year      INTEGER,
  PRIMARY KEY (list_slug, tmdb_id)
);
CREATE INDEX IF NOT EXISTS pool_list_entries_tmdb ON pool_list_entries (tmdb_id);

-- Source rows that could not be resolved to a TMDB id. Kept rather than dropped,
-- same rule as everywhere else in this project.
CREATE TABLE IF NOT EXISTS pool_unresolved (
  list_slug TEXT NOT NULL REFERENCES pool_lists (slug) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  year      INTEGER,
  position  INTEGER,
  reason    TEXT,
  PRIMARY KEY (list_slug, title, year)
);

-- The deduped, watched-excluded candidate pool. Rebuilt from pool_list_entries
-- on every run, so it is derived state and safe to drop.
CREATE TABLE IF NOT EXISTS pool (
  tmdb_id      INTEGER PRIMARY KEY REFERENCES tmdb_films (tmdb_id),
  list_count   INTEGER NOT NULL,    -- how many source lists include it
  best_rank    INTEGER,             -- best position across ordered lists
  on_watchlist INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_list_count ON pool (list_count);

-- Films a list proposed that are already watched. Not in the pool, but counted
-- so the report can say how much of each list is already cleared.
CREATE TABLE IF NOT EXISTS pool_excluded (
  tmdb_id INTEGER PRIMARY KEY,
  reason  TEXT NOT NULL             -- watched
);
