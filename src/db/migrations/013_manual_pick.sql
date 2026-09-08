-- 013: the manual override.
--
-- The slate answers "what should I watch tonight" with five candidates. It does
-- not answer "I want to watch Solaris tonight", and that is a real thing to
-- want -- often because you already know what the gap is and do not need the
-- engine to find it for you.
--
-- So a film can be locked in by hand. The constraint that keeps this from
-- dissolving the whole project is that it can only be locked in **from the
-- candidate pool**: 4,470 films you have not seen, already filtered by the
-- canon, collection, regional, auteur and lineage sources and already shaped.
-- You can override which blind spot you close tonight. You cannot override it
-- into a rewatch of something comfortable, because comfortable films are not in
-- the pool.
--
-- Everything else still holds. A day resolves to one film, choosing is final,
-- and a manual pick goes through the same `persistPickRecord` door that refuses
-- to overwrite. It is scored by the same engine at the moment it is locked in,
-- so the card can still say which gap it closes and how it ranked -- a manual
-- pick is not an unexplained pick.
--
-- The film is appended to the day's slate rather than replacing one of the
-- five. Replacing would destroy what the engine offered, and the whole reason
-- the losers are kept is to be able to ask later what was on the table. A day
-- with an override reads honestly: five drawn, one added by hand, that one
-- taken.

ALTER TABLE slates ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;

-- Slate rows are already unique on (slate_date, tmdb_id), so a film the engine
-- happened to offer today cannot also be added as a manual row. Locking in one
-- of the five is just choosing it, which is what the buttons are for.
CREATE INDEX IF NOT EXISTS slates_manual ON slates (manual) WHERE manual = 1;
