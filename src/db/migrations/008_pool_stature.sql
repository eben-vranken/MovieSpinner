-- 008: record where a pool film came from, and how highly it was ranked.
--
-- The first simulated year served up "Temple of the White Elephant", "Dead Mine"
-- and a 17-minute Romanian short. All were technically in the pool and all were
-- a waste of a day. The gap weighting was working; it just had no idea that some
-- of its candidates are canon and some are the fortieth most-voted film from a
-- small country.
--
-- So the pool now carries which kinds of list produced a film. A film in TSPDT
-- or Criterion, or one a lineage edge argues for, outranks one that is only
-- present because a discover query needed to fill out a country.

ALTER TABLE pool ADD COLUMN kinds TEXT NOT NULL DEFAULT '';
