-- 006: automatic movement tagging.
--
-- Hand-tagging films to movements works at 429 watched films and does not work
-- at 3,200 pool films. But a movement dimension that only covers what I have
-- already seen is useless to the engine, which needs to know what the pool can
-- offer for a movement sitting at zero.
--
-- The fix is to hand-curate one level up. Movements are largely defined by their
-- directors, so data/movement-directors.csv names them and any film by one of
-- them inside the movement's period gets tagged. That is far less work than
-- tagging films, and far more reliable than inferring a movement from genre.
--
-- A few movements are periods and places rather than auteur groups: the silent
-- era is every film before 1930, classical Hollywood is American studio output
-- between 1930 and 1948. Those use auto_rule = 'period'.

ALTER TABLE movements ADD COLUMN auto_rule TEXT NOT NULL DEFAULT 'directors';
ALTER TABLE movements ADD COLUMN rule_countries TEXT;

-- How a tag got there, so a suspicious cell can be traced back.
ALTER TABLE film_movements ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS movement_directors (
  movement  TEXT    NOT NULL REFERENCES movements (slug) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  person_id INTEGER,
  PRIMARY KEY (movement, name)
);
CREATE INDEX IF NOT EXISTS movement_directors_person ON movement_directors (person_id);
