import { db } from './db';
import { failStaleRuns, latestRun } from '../setup/pipeline';
import type { SetupRun } from '../setup/pipeline';

/**
 * What state this install is in, before anything tries to draw a slate.
 *
 * The app used to be allowed to assume a full database, because the only person
 * who ran it was the person who had already run the pipeline. Handed to someone
 * else it starts empty, and every entry point -- `ensureSlate`, `loadAnalytics`,
 * even `tmdbConfig` -- throws on an empty install. Throwing is right; crashing
 * the page is not, because the one thing a new user needs is the screen that
 * tells them what to do next.
 *
 * So the page asks this first and renders setup instead of charts when the
 * answer is anything but `ready`.
 */

export type Readiness = 'no-config' | 'empty' | 'needs-enrich' | 'needs-pool' | 'ready';

export interface AppStatus {
  readiness: Readiness;
  /** TMDB_READ_TOKEN is set. Nothing works without it. */
  configured: boolean;
  region: string | null;
  films: number;
  watched: number;
  /** Films with a resolved TMDB match. */
  matched: number;
  poolSize: number;
  lastImport: { username: string | null; importedAt: string; exportedAt: string | null } | null;
  run: SetupRun | null;
}

/**
 * Checked once per process rather than per request.
 *
 * A run left marked running belongs to a process that no longer exists, but
 * that is only knowable at startup -- mid-session it would mean killing a job
 * that is genuinely in flight.
 */
const globalForSetup = globalThis as unknown as { moviespinnerSweptRuns?: boolean };

export function appStatus(): AppStatus {
  const handle = db();

  if (!globalForSetup.moviespinnerSweptRuns) {
    globalForSetup.moviespinnerSweptRuns = true;
    failStaleRuns(handle);
  }

  // Read directly rather than through tmdbConfig, which throws by design. Here
  // a missing token is a state to render, not an error to raise.
  const token = process.env['TMDB_READ_TOKEN']?.trim();
  const region = process.env['TMDB_REGION']?.trim() || 'BE';

  const scalar = (sql: string): number =>
    (handle.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;

  const films = scalar('SELECT COUNT(*) AS n FROM films');
  const watched = scalar('SELECT COUNT(*) AS n FROM watched');
  const matched = scalar('SELECT COUNT(*) AS n FROM film_matches WHERE tmdb_id IS NOT NULL');
  const poolSize = scalar('SELECT COUNT(*) AS n FROM pool');

  const lastImport =
    (handle
      .prepare('SELECT username, imported_at, exported_at FROM imports ORDER BY id DESC LIMIT 1')
      .get() as
      | { username: string | null; imported_at: string; exported_at: string | null }
      | undefined) ?? undefined;

  const run = latestRun(handle);

  // Ordered by what blocks what. No token blocks everything; no films blocks
  // matching; no matches blocks the pool; no pool blocks the draw.
  const readiness: Readiness = !token
    ? 'no-config'
    : watched === 0
      ? 'empty'
      : matched === 0
        ? 'needs-enrich'
        : poolSize === 0
          ? 'needs-pool'
          : 'ready';

  return {
    readiness,
    configured: Boolean(token),
    region: token ? region : null,
    films,
    watched,
    matched,
    poolSize,
    lastImport: lastImport
      ? {
          username: lastImport.username,
          importedAt: lastImport.imported_at,
          exportedAt: lastImport.exported_at,
        }
      : null,
    run,
  };
}
