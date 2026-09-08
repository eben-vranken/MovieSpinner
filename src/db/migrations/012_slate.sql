-- 012: the daily slate.
--
-- The app used to hand over exactly one film a day and the only thing you could
-- do with it was accept it or skip it. It now hands over five and you choose
-- one. That is a bigger change to the product than it looks, so it is worth
-- being precise about what it does and does not relax.
--
-- What stays: a day still resolves to exactly one film, `picks` is still the
-- log of that, and `persistPick` still refuses to overwrite a row. Choosing is
-- the commitment; there is no reroll and no un-choosing. The slate itself is
-- drawn once from a date-seeded stream and frozen here, so reloading the page
-- cannot shuffle it and a rebuilt pool cannot retroactively change what you
-- were offered on a past day.
--
-- What changes: the engine no longer decides which single film you get, it
-- decides which five you get to decide between. The weighting is unchanged --
-- the same blind-spot scoring, drawn five times without replacement -- so a
-- slate is still pointed at your gaps rather than being a shuffle.
--
-- The four films you did not choose are kept. A film the engine offers over and
-- over and you never take is the most interesting thing this table records, and
-- deleting the losers would throw it away.

CREATE TABLE IF NOT EXISTS slates (
  slate_date        TEXT    NOT NULL,          -- YYYY-MM-DD
  tmdb_id           INTEGER NOT NULL REFERENCES tmdb_films (tmdb_id),
  position          INTEGER NOT NULL,          -- 0-based, the order it was drawn
  kind              TEXT    NOT NULL,          -- blind-spot | junk-valve
  seed              TEXT    NOT NULL,          -- what the PRNG was seeded from
  weight            REAL    NOT NULL,
  share             REAL    NOT NULL,          -- this film's probability at the moment it was drawn
  top_share         REAL    NOT NULL,          -- the best-weighted film's probability
  pool_size         INTEGER NOT NULL,
  reason_json       TEXT    NOT NULL,          -- per-dimension breakdown, readable
  lineage_from      INTEGER,
  lineage_rationale TEXT,
  created_at        TEXT    NOT NULL,
  PRIMARY KEY (slate_date, tmdb_id)
);

-- One film per position per day. The draw is without replacement, so a
-- duplicate here would mean the sampler is broken rather than the data being
-- unusual, and it should fail loudly at insert time.
CREATE UNIQUE INDEX IF NOT EXISTS slates_position ON slates (slate_date, position);
CREATE INDEX IF NOT EXISTS slates_tmdb ON slates (tmdb_id);

-- --- carrying the old picks across ----------------------------------------
--
-- Two kinds of row exist in `picks` from the one-a-day era and they mean
-- different things, so they are treated differently.
--
-- A *resolved* pick is a decision a person made: they were shown a film and
-- they watched it or passed on it. That is preserved exactly, as a slate of one
-- film which was chosen. The log then reads truthfully -- those days really did
-- offer one film and really did take it -- instead of pretending five were on
-- offer when they were not.
INSERT OR IGNORE INTO slates
  (slate_date, tmdb_id, position, kind, seed, weight, share, top_share, pool_size,
   reason_json, lineage_from, lineage_rationale, created_at)
SELECT pick_date, tmdb_id, 0, kind, seed, weight, share, top_share, pool_size,
       reason_json, lineage_from, lineage_rationale, created_at
FROM picks
WHERE status <> 'pending';

-- A *pending* pick is not a decision. It is what the old engine drew the moment
-- someone opened the page, before anyone chose anything -- and choosing is the
-- entire thing this version moved into the reader's hands. Keeping it would
-- pre-decide a day that nobody has decided, so an unresolved pick is dropped
-- and that date draws a real slate on the next read.
--
-- Nothing a person did is lost here: by definition these rows record no action.
-- Resolved picks, including skips from the old model, are untouched above.
DELETE FROM picks WHERE status = 'pending';
