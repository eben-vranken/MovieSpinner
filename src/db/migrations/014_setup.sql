-- 014: first-run setup.
--
-- Everything before this assumed the database was already full: the import ran
-- from a terminal, on a zip that was already sitting in ./data, by the person
-- who wrote the project. Handing it to somebody else breaks all three of those
-- assumptions at once. They have their own export, no terminal open, and a
-- completely empty database.
--
-- Importing is not one step, which is the awkward part. A usable app needs
-- four: read the zip, match every film against TMDB, count the coverage, and
-- build the candidate pool. The first is instant and the other three are
-- minutes of network, so the browser cannot simply wait for a server action to
-- come back -- it needs something to show while it runs, and something to read
-- if the tab is closed and reopened halfway through.
--
-- Hence a table rather than an in-memory job. Progress written here survives a
-- reload, is visible to `npm run report`, and leaves a record of what happened
-- if a run fails at 3 of 4. It is the same reasoning as `picks` being a log
-- rather than a computation.

CREATE TABLE IF NOT EXISTS setup_runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  status       TEXT    NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'done', 'failed')),
  -- Which of the four steps is in flight. 'ready' is the terminal state.
  stage        TEXT    NOT NULL,
  -- One line of human-readable detail: "matching 412 of 597 films".
  detail       TEXT,
  -- Progress within the current stage. Both zero when a stage cannot count
  -- itself, which is most of the pool build.
  done         INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  source_file  TEXT,
  username     TEXT
);

CREATE INDEX IF NOT EXISTS setup_runs_status ON setup_runs (status);

-- A run that was in flight when the process died is not running any more, it
-- just never got to say so. Marking those failed at startup is handled in
-- code; this index is what makes finding them cheap.
