-- 016: more than one film a day.
--
-- A day used to resolve to exactly one film. It now resolves to one film *per
-- round*, and a day can have as many rounds as you earn. This is the biggest
-- thing this project has relaxed, so it is worth being exact about what it
-- relaxes and what it does not.
--
-- What stays, and it is the whole rule: **a round resolves to exactly one film
-- and choosing is final.** `persistPickRecord` still refuses to overwrite, it
-- just keys on (date, round) instead of date. `persistSlate` still refuses to
-- redraw, keyed the same way. Nothing you have chosen can be un-chosen, swapped
-- or hidden, and the four films you passed over in every round are all kept.
--
-- What changes: a second round exists at all. It is not free and it is not a
-- reroll, because of one guard -- **round N+1 unlocks only when round N's pick
-- is marked watched.** That is the difference between "I watched a film, give
-- me another" and "I do not fancy this one, give me another", and it is the
-- entire distinction the no-reroll rule was ever protecting. You cannot reach a
-- new five by disliking the old five; you reach it by having watched one.
--
-- Two consequences worth naming:
--
-- A pending pick blocks the day. If you choose a film and never mark it, that
-- is where the day stops, exactly as it did when a day was one film. The
-- streak has always read an unmarked evening as an evening that did not
-- happen, and it still does.
--
-- A film is still offered at most once a day. `slates` keeps its
-- (slate_date, tmdb_id) key, and the draw for a later round excludes everything
-- already on the day's slate -- so round 2 is five films you have not been
-- shown today rather than the same four with a new one. That also means every
-- query that joins picks to slates on (date, tmdb_id) is still unambiguous, and
-- none of them had to learn about rounds.

-- Round 1 is the day's first slate, which is every slate that exists today.
ALTER TABLE slates ADD COLUMN round INTEGER NOT NULL DEFAULT 1;

-- Position was unique per day; it is now unique per round. A duplicate here
-- would still mean the sampler is broken rather than the data being unusual.
DROP INDEX IF EXISTS slates_position;
CREATE UNIQUE INDEX IF NOT EXISTS slates_round_position
  ON slates (slate_date, round, position);
CREATE INDEX IF NOT EXISTS slates_round ON slates (slate_date, round);

-- --- picks, rebuilt on (pick_date, round) ---------------------------------
--
-- `pick_date` was the primary key, which is the schema saying "one pick a day"
-- rather than any code saying it. That is the right place for the constraint
-- and it is still the right place, so the constraint moves rather than being
-- dropped: one pick per round, enforced by SQLite and not by a guard someone
-- can forget.
--
-- Rebuilt rather than altered because SQLite cannot widen a primary key in
-- place. Every existing pick becomes round 1 of its day, which is what it was.
CREATE TABLE picks_new (
  pick_date         TEXT    NOT NULL,        -- YYYY-MM-DD
  round             INTEGER NOT NULL DEFAULT 1,
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
  created_at        TEXT    NOT NULL,
  PRIMARY KEY (pick_date, round)
);

INSERT INTO picks_new
  (pick_date, round, tmdb_id, kind, seed, weight, share, top_share, pool_size,
   reason_json, lineage_from, lineage_rationale, status, resolved_on, created_at)
SELECT pick_date, 1, tmdb_id, kind, seed, weight, share, top_share, pool_size,
       reason_json, lineage_from, lineage_rationale, status, resolved_on, created_at
FROM picks;

DROP TABLE picks;
ALTER TABLE picks_new RENAME TO picks;

CREATE INDEX IF NOT EXISTS picks_tmdb ON picks (tmdb_id);
CREATE INDEX IF NOT EXISTS picks_status ON picks (status);

-- A stale-pick repair belongs to the round it repaired, or the history stops
-- being able to say which of a day's films actually changed.
ALTER TABLE pick_redraws ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
