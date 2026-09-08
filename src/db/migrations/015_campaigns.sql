-- 015: campaign mode.
--
-- The dashboard has been saying this for a while and nobody was listening: 268
-- of 338 directors seen exactly once. The engine is not merely failing to build
-- depth, it is actively preventing it -- the cooldown multiplies a director seen
-- in the last fortnight by 0.06, so the same filmography twice in a month is
-- almost impossible. That is correct for a blind-spot machine and wrong for
-- becoming a cinephile, because nobody ever understood Ozu by watching one Ozu
-- every four months.
--
-- So: an optional mode you switch on. Pick a director, a movement or a country
-- and the daily five stop being five scattered gaps and become the next five
-- films of that subject, in order. Coverage still counts, the log still records
-- it, and you still choose one a day. What changes is that the days join up.
--
-- Three rules keep this from being an escape hatch:
--
--  * **It never touches a slate that already exists.** A campaign applies to the
--    next slate drawn, never today's. Otherwise "start a campaign" would be a
--    reroll with extra steps: don't like today's five, start a campaign, get
--    five different films, abandon it.
--  * **One at a time.** Enforced by the partial unique index below rather than
--    in code. Committing to two things is not committing.
--  * **The day is unchanged in every other way.** One film, chosen once, final.
--    A campaign slate goes through the same `persistSlate` and the same
--    `chooseFromSlate` as any other.
--
-- The junk valve is suspended while a campaign runs. Sunday off is a release
-- valve for homework you did not choose; homework you did choose does not need
-- one.

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY,
  -- Which of the coverage dimensions this campaign is about. Deliberately not
  -- decade: 650 pre-1950 films is a category, not a curriculum.
  kind        TEXT    NOT NULL CHECK (kind IN ('director', 'movement', 'country')),
  -- person_id, movement slug, or ISO country code, as text for all three.
  subject     TEXT    NOT NULL,
  -- Resolved at start time so the log stays readable even if the pool is
  -- rebuilt and the subject stops resolving.
  label       TEXT    NOT NULL,
  -- chronological: release order, which is how a body of work makes sense.
  -- canonical: best regarded first, for when you want the peaks and not the
  -- development.
  ordering    TEXT    NOT NULL DEFAULT 'chronological'
              CHECK (ordering IN ('chronological', 'canonical')),
  started_on  TEXT    NOT NULL,
  ended_on    TEXT,
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'completed', 'abandoned')),
  created_at  TEXT    NOT NULL
);

-- One active campaign, enforced by the database. A partial unique index is the
-- whole mechanism: 'completed' and 'abandoned' rows are unconstrained, so the
-- history piles up while only one row can ever be 'active'.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_one_active
  ON campaigns (status) WHERE status = 'active';

-- Which campaign a slate belongs to, if any. Null is an ordinary day, and the
-- overwhelming majority of rows will stay null.
ALTER TABLE slates ADD COLUMN campaign_id INTEGER REFERENCES campaigns (id);

CREATE INDEX IF NOT EXISTS slates_campaign ON slates (campaign_id);
