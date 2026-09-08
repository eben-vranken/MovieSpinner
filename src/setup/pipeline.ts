import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client';
import { tmdbConfig } from '../config';
import { computeCoverage, loadMovements, snapshotCoverage } from '../coverage';
import { enrich } from '../ingest/enrich';
import { importExport } from '../ingest/import';
import { readExport } from '../ingest/letterboxd';
import { loadLineage } from '../engine/lineage';
import { buildPool } from '../pool';
import { dataPath } from '../paths';

/**
 * The four steps between a Letterboxd zip and a working app, run as one job.
 *
 * `npm run import && npm run enrich && npm run coverage && npm run pool` does
 * exactly this and stays the supported way to do it. This exists because the
 * person you hand the project to does not necessarily want a terminal, and
 * because the middle two steps are minutes of network calls that a browser has
 * to be told about rather than left to guess at.
 *
 * Progress goes to `setup_runs` rather than to memory, so closing the tab
 * halfway through loses nothing and a failure at step 3 of 4 leaves a record
 * saying so.
 *
 * Only one run at a time, enforced in the database rather than with a module
 * variable: two concurrent pool builds would fight over the same tables, and a
 * module variable would not survive the hot reload that dev mode does on every
 * save.
 */

export type Stage = 'import' | 'enrich' | 'coverage' | 'pool' | 'ready';

export interface SetupRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  stage: Stage;
  detail: string | null;
  done: number;
  total: number;
  error: string | null;
  sourceFile: string | null;
  username: string | null;
}

/** The stages in order, so the UI can draw a checklist rather than a spinner. */
export const STAGES: { key: Stage; label: string; note: string }[] = [
  { key: 'import', label: 'Read the export', note: 'Watched, ratings, diary, watchlist, likes.' },
  {
    key: 'enrich',
    label: 'Match against TMDB',
    note: 'Every film, for country, director, runtime and where to watch it. The slow one.',
  },
  { key: 'coverage', label: 'Count the coverage', note: 'Decade, country, director, movement.' },
  {
    key: 'pool',
    label: 'Build the candidate pool',
    note: 'Canon, Criterion, regional and auteur lists, minus everything you have seen.',
  },
];

const row = (db: Db, id: number): SetupRun => {
  const found = db.prepare('SELECT * FROM setup_runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!found) throw new Error(`No setup run ${id}`);
  return {
    id: found['id'] as number,
    startedAt: found['started_at'] as string,
    finishedAt: (found['finished_at'] as string | null) ?? null,
    status: found['status'] as SetupRun['status'],
    stage: found['stage'] as Stage,
    detail: (found['detail'] as string | null) ?? null,
    done: found['done'] as number,
    total: found['total'] as number,
    error: (found['error'] as string | null) ?? null,
    sourceFile: (found['source_file'] as string | null) ?? null,
    username: (found['username'] as string | null) ?? null,
  };
};

/** The newest run, whatever its state. What the page reads on every load. */
export function latestRun(db: Db): SetupRun | null {
  const found = db.prepare('SELECT id FROM setup_runs ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined;
  return found ? row(db, found.id) : null;
}

/**
 * A run still marked running from a process that is no longer alive.
 *
 * There is no way to tell "in flight" from "the server was restarted" by
 * looking at the row, so this is called once when the app starts: anything
 * still running at that point belongs to a dead process by definition.
 */
export function failStaleRuns(db: Db): number {
  return db
    .prepare(
      `UPDATE setup_runs
       SET status = 'failed', finished_at = ?, error = 'The server restarted while this was running.'
       WHERE status = 'running'`,
    )
    .run(new Date().toISOString()).changes;
}

export function isRunning(db: Db): boolean {
  return (
    (db.prepare("SELECT COUNT(*) AS n FROM setup_runs WHERE status = 'running'").get() as {
      n: number;
    }).n > 0
  );
}

/**
 * Saves an uploaded export next to the database.
 *
 * Kept as a real file rather than a temporary one because `imports` records the
 * path and its SHA-256, and a provenance record pointing at a file that was
 * deleted a second later is not provenance. It also means `npm run import` with
 * no arguments picks up the same zip, since that looks for the newest
 * `letterboxd-*.zip` in the data directory.
 */
export function saveUpload(bytes: Buffer, filename: string): string {
  const safe = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const named = /^letterboxd-.*\.zip$/i.test(safe)
    ? safe
    : `letterboxd-upload-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

  const target = dataPath(named);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

/**
 * Runs the four steps. Resolves when the pipeline finishes or fails; the caller
 * is expected not to await it, and to watch `setup_runs` instead.
 */
export async function runPipeline(db: Db, zipPath: string): Promise<SetupRun> {
  if (isRunning(db)) throw new Error('A setup run is already in progress.');

  // Fails before writing a run row if TMDB is not configured, because two of
  // the four steps are nothing but TMDB calls and finding that out at step 2
  // wastes the upload and looks like a crash.
  const { region } = tmdbConfig();

  const id = Number(
    db
      .prepare(
        `INSERT INTO setup_runs (started_at, status, stage, detail, source_file)
         VALUES (?, 'running', 'import', 'reading the export', ?)`,
      )
      .run(new Date().toISOString(), zipPath).lastInsertRowid,
  );

  const update = (fields: Partial<Record<string, unknown>>): void => {
    const keys = Object.keys(fields);
    db.prepare(
      `UPDATE setup_runs SET ${keys.map((key) => `${key} = @${key}`).join(', ')} WHERE id = @id`,
    ).run({ ...fields, id });
  };

  // Progress is written on a timer rather than on every callback. Enrichment
  // fires one per film, and a synchronous write per film would spend more time
  // in SQLite than in the network calls it is reporting on.
  let lastWrite = 0;
  const throttled = (fields: Record<string, unknown>): void => {
    const now = Date.now();
    if (now - lastWrite < 400) return;
    lastWrite = now;
    update(fields);
  };

  try {
    // --- 1. import ----------------------------------------------------------
    const data = readExport(zipPath);
    const imported = importExport(db, data);
    update({
      username: imported.username,
      detail: `${imported.counts['watched'] ?? 0} watched, ${imported.counts['ratings'] ?? 0} rated`,
    });

    // --- 2. enrich ----------------------------------------------------------
    update({ stage: 'enrich', detail: 'matching films against TMDB', done: 0, total: 0 });
    const enriched = await enrich(db, {
      region,
      onProgress: (done, total) =>
        throttled({ done, total, detail: `matched ${done} of ${total} films` }),
    });
    update({
      done: enriched.attempted,
      total: enriched.attempted,
      detail: `${(enriched.matchRate * 100).toFixed(1)}% matched, ${enriched.requests} requests`,
    });

    // --- 3. coverage --------------------------------------------------------
    update({ stage: 'coverage', detail: 'counting coverage', done: 0, total: 0 });
    loadMovements(db);
    const coverage = computeCoverage(db);
    // The first snapshot has to be taken now. §7 wants change over time, and a
    // trend that only starts the first time somebody remembers to run a CLI
    // flag starts months late.
    snapshotCoverage(db, coverage);
    update({ detail: `${coverage.total} films, ${coverage.country.length} countries` });

    // --- 4. pool ------------------------------------------------------------
    update({ stage: 'pool', detail: 'building the candidate pool', done: 0, total: 0 });
    loadLineage(db);
    const pool = await buildPool(db, { region, onStage: (message) => update({ detail: message }) });

    update({
      stage: 'ready',
      status: 'done',
      finished_at: new Date().toISOString(),
      detail: `${pool.poolSize} candidate films`,
      done: pool.poolSize,
      total: pool.poolSize,
    });
  } catch (cause) {
    update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  return row(db, id);
}

/**
 * Whose feed the daily sync should read.
 *
 * `LETTERBOXD_USER` wins when it is set, but it should rarely need to be: the
 * import already recorded the username from the export's profile.csv, and that
 * is by definition the right person. The previous fallback was a hardcoded
 * username, which on somebody else's install would have quietly synced their
 * app against a stranger's diary.
 */
export function letterboxdUser(db: Db): string {
  const configured = process.env['LETTERBOXD_USER']?.trim();
  if (configured) return configured;

  const imported = (
    db.prepare('SELECT username FROM imports WHERE username IS NOT NULL ORDER BY id DESC LIMIT 1').get() as
      | { username: string }
      | undefined
  )?.username;

  if (!imported) {
    throw new Error(
      'No Letterboxd username. Import an export first, or set LETTERBOXD_USER in .env.',
    );
  }
  return imported;
}
