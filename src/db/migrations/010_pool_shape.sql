-- 010: record why a film was left out of the pool.
--
-- Step 4 built a pool that looked healthy on every coverage measure and was
-- badly distributed underneath: 43% of it was 38 complete filmographies, so a
-- draw met Umberto Lenzi five times for every Robert Bresson. Fixing that means
-- dropping films, and this project's standing rule is that nothing is dropped
-- silently.
--
-- Rebuilt on every pool run, like `pool` itself.

CREATE TABLE IF NOT EXISTS pool_dropped (
  tmdb_id INTEGER PRIMARY KEY,
  title   TEXT,
  year    INTEGER,
  reason  TEXT NOT NULL,      -- watched | short | few-votes | auteur-cap
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS pool_dropped_reason ON pool_dropped (reason);

-- Where a director's cap had to be raised above the default to stop a movement
-- or a region falling through its floor. Worth keeping visible: it is the list
-- of places the simple rule was not good enough.
CREATE TABLE IF NOT EXISTS pool_cap_overrides (
  person_id INTEGER NOT NULL,
  name      TEXT    NOT NULL,
  cap       INTEGER NOT NULL,
  because   TEXT    NOT NULL,
  PRIMARY KEY (person_id, because)
);
