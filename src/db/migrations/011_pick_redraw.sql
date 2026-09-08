-- 011: superseded picks.
--
-- A pick is never recomputed and never rerolled. There is one exception, and it
-- is not about disliking a film: when the pool itself is rebuilt, a pick can be
-- left pointing at a film the current pool no longer contains. That happened to
-- 2026-09-07, drawn from the pool before the auteur expansion was capped.
--
-- Redrawing in that case repairs a stale record. Redrawing because you fancy
-- something else is the thing the whole project refuses to allow, so the button
-- only exists while the film is genuinely gone. The old row is kept here rather
-- than deleted, because a pick that vanished without trace would be worse than
-- one that changed.

CREATE TABLE IF NOT EXISTS pick_redraws (
  id           INTEGER PRIMARY KEY,
  pick_date    TEXT    NOT NULL,
  old_tmdb_id  INTEGER NOT NULL,
  old_title    TEXT,
  old_status   TEXT    NOT NULL,
  new_tmdb_id  INTEGER NOT NULL,
  new_title    TEXT,
  reason       TEXT    NOT NULL,
  redrawn_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS pick_redraws_date ON pick_redraws (pick_date);
