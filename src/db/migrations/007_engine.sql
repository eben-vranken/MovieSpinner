-- 007: lineage and the daily pick (build step 5).
--
-- §4 is emphatic that a pick is generated once and written down, never
-- recomputed. If it were derived lazily it would change retroactively as the
-- watched set grows, and the whole no-reroll premise would be a fiction. So
-- `picks` is a log, not a view, and nothing recomputes a row once it exists.

-- Hand-authored edges from a film I rated highly to one I have not seen, each
-- carrying the sentence that gets shown on the card. §5 calls this the part that
-- makes the app not a canon shuffler, and it is the only thing here TMDB cannot
-- supply.
CREATE TABLE IF NOT EXISTS lineage_edges (
  from_tmdb_id INTEGER NOT NULL,
  to_tmdb_id   INTEGER NOT NULL,
  from_title   TEXT,
  to_title     TEXT,
  rationale    TEXT    NOT NULL,
  PRIMARY KEY (from_tmdb_id, to_tmdb_id)
);
CREATE INDEX IF NOT EXISTS lineage_edges_to ON lineage_edges (to_tmdb_id);

CREATE TABLE IF NOT EXISTS picks (
  pick_date         TEXT    PRIMARY KEY,     -- YYYY-MM-DD, one pick per day
  tmdb_id           INTEGER NOT NULL REFERENCES tmdb_films (tmdb_id),
  kind              TEXT    NOT NULL,        -- blind-spot | junk-valve
  seed              TEXT    NOT NULL,        -- what the PRNG was seeded from
  weight            REAL    NOT NULL,
  share             REAL    NOT NULL,        -- this film's probability in that draw
  top_share         REAL    NOT NULL,        -- the best-weighted film's probability
  pool_size         INTEGER NOT NULL,
  reason_json       TEXT    NOT NULL,        -- per-dimension breakdown, readable
  lineage_from      INTEGER,                 -- the anchor film, when an edge fired
  lineage_rationale TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'watched', 'skipped')),
  resolved_on       TEXT,
  created_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS picks_tmdb ON picks (tmdb_id);
CREATE INDEX IF NOT EXISTS picks_status ON picks (status);
