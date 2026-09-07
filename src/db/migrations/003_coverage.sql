-- 003: coverage (build step 3).
--
-- Three of the four coverage dimensions the brief asks for fall straight out of
-- what TMDB already gave us: decade from the year, country from
-- tmdb_film_countries, director from tmdb_film_crew. Movement has no source at
-- all, which was §11's open question, so it lives here as hand-curated data
-- loaded from two committed CSVs.

-- The taxonomy. Seeded from data/movements.csv and reloaded on every coverage
-- run. Every movement gets a row even at zero films watched, because a zero is
-- the most informative cell on the dashboard.
CREATE TABLE IF NOT EXISTS movements (
  slug         TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  period_start INTEGER,
  period_end   INTEGER,
  region       TEXT,
  note         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- Membership. Keyed by tmdb_id rather than film_id so the step 4 candidate pool
-- can be tagged with the same file, before those films exist in `films`.
CREATE TABLE IF NOT EXISTS film_movements (
  tmdb_id  INTEGER NOT NULL,
  movement TEXT    NOT NULL REFERENCES movements (slug) ON DELETE CASCADE,
  PRIMARY KEY (tmdb_id, movement)
);
CREATE INDEX IF NOT EXISTS film_movements_movement ON film_movements (movement);

-- §7 of the brief: "Snapshot the coverage numbers monthly so the dashboard can
-- show change, not just position." Started now rather than at step 8, because a
-- history that begins the day the dashboard is built is a history of nothing.
--
-- One row per bucket per snapshot. `taken_on` is a date, and re-running on the
-- same day overwrites rather than duplicating.
CREATE TABLE IF NOT EXISTS coverage_snapshots (
  taken_on  TEXT    NOT NULL,
  dimension TEXT    NOT NULL,   -- decade | country | director | movement
  bucket    TEXT    NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (taken_on, dimension, bucket)
);
CREATE INDEX IF NOT EXISTS coverage_snapshots_dimension ON coverage_snapshots (dimension, bucket);

-- Context for each snapshot, so a bucket count can be read as a share later.
CREATE TABLE IF NOT EXISTS coverage_snapshot_meta (
  taken_on       TEXT PRIMARY KEY,
  watched_total  INTEGER NOT NULL,
  watched_mapped INTEGER NOT NULL,
  taken_at       TEXT    NOT NULL
);
