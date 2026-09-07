import { migrate, openDb } from '../db/client';
import { loadMovements } from '../coverage';
import { createEngine, draw, loadState, persistPick, resolvePick } from '../engine';
import { loadLineage } from '../engine/lineage';
import { tmdbConfig } from '../config';

/**
 * Today's film. Generated once, written down, never recomputed.
 *
 * Usage:
 *   npm run pick                 # show today's pick, generating it if needed
 *   npm run pick -- --watched    # mark it watched
 *   npm run pick -- --skip       # record a skip; it returns at reduced weight
 *   npm run pick -- --date 2026-09-10
 *   npm run pick -- --history 14
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

function main(): void {
  const { region } = tmdbConfig();
  const db = openDb();
  migrate(db);
  loadMovements(db);
  loadLineage(db);

  const date = arg('date', new Date().toISOString().slice(0, 10));

  if (process.argv.includes('--history')) {
    const limit = Number.parseInt(arg('history', '14'), 10);
    const rows = db
      .prepare(
        `SELECT p.pick_date, p.kind, p.status, t.title, t.year FROM picks p
         JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
         ORDER BY p.pick_date DESC LIMIT ?`,
      )
      .all(limit) as { pick_date: string; kind: string; status: string; title: string; year: number }[];
    if (rows.length === 0) console.log('No picks yet.');
    for (const row of rows) {
      console.log(
        `  ${row.pick_date}  ${row.status.padEnd(8)} ${(row.title + ` (${row.year})`).padEnd(46)}` +
          (row.kind === 'junk-valve' ? 'junk valve' : ''),
      );
    }
    db.close();
    return;
  }

  if (process.argv.includes('--watched') || process.argv.includes('--skip')) {
    const status = process.argv.includes('--skip') ? 'skipped' : 'watched';
    resolvePick(db, date, status);
    console.log(
      status === 'skipped'
        ? `Skipped. It goes back in the pool at reduced weight for 90 days.`
        : `Marked watched.`,
    );
    db.close();
    return;
  }

  let existing = db
    .prepare(
      `SELECT p.*, t.title, t.year, t.runtime, t.overview, t.origin_country, t.poster_path
       FROM picks p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE p.pick_date = ?`,
    )
    .get(date) as Record<string, unknown> | undefined;

  if (!existing) {
    const engine = createEngine(db);
    const result = draw(engine, loadState(db), date);
    persistPick(db, result);
    existing = db
      .prepare(
        `SELECT p.*, t.title, t.year, t.runtime, t.overview, t.origin_country, t.poster_path
         FROM picks p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE p.pick_date = ?`,
      )
      .get(date) as Record<string, unknown>;
  }

  const pick = existing as {
    tmdb_id: number;
    kind: string;
    status: string;
    share: number;
    pool_size: number;
    reason_json: string;
    lineage_rationale: string | null;
    title: string;
    year: number;
    runtime: number | null;
    overview: string | null;
    origin_country: string | null;
  };

  const directors = (
    db
      .prepare(
        `SELECT p.name FROM tmdb_film_crew c JOIN tmdb_people p ON p.person_id = c.person_id
         WHERE c.tmdb_id = ? AND c.job = 'Director'`,
      )
      .all(pick.tmdb_id) as { name: string }[]
  ).map((row) => row.name);

  const movements = (
    db
      .prepare(
        `SELECT m.name FROM film_movements fm JOIN movements m ON m.slug = fm.movement
         WHERE fm.tmdb_id = ?`,
      )
      .all(pick.tmdb_id) as { name: string }[]
  ).map((row) => row.name);

  const providers = (
    db
      .prepare(
        `SELECT DISTINCT provider_name, offer_type FROM tmdb_watch_providers
         WHERE tmdb_id = ? AND region = ? ORDER BY offer_type`,
      )
      .all(pick.tmdb_id, region) as { provider_name: string; offer_type: string }[]
  );

  console.log(`\n  ${date}${pick.kind === 'junk-valve' ? '   (junk valve: today is not homework)' : ''}`);
  console.log(`\n  ${pick.title} (${pick.year})`);
  console.log(`  ${directors.join(', ') || 'director unknown'}`);
  console.log(
    `  ${pick.origin_country ?? '??'}  ${pick.runtime ? `${pick.runtime} minutes` : 'runtime unknown'}` +
      (movements.length > 0 ? `  ${movements.join(', ')}` : ''),
  );

  if (pick.lineage_rationale) console.log(`\n  ${pick.lineage_rationale}`);
  else if (pick.kind !== 'junk-valve') {
    const reason = JSON.parse(pick.reason_json) as Record<string, number>;
    const named: [string, number][] = [
      ['decade', reason['decade'] ?? 1],
      ['country', reason['country'] ?? 1],
      ['director', reason['director'] ?? 1],
      ['movement', reason['movement'] ?? 1],
    ];
    const strongest = named.sort((a, b) => b[1] - a[1])[0];
    console.log(`\n  Picked mostly on the ${strongest?.[0]} gap.`);
  }

  if (pick.overview) console.log(`\n  ${pick.overview}`);

  const flatrate = providers.filter((p) => p.offer_type === 'flatrate').map((p) => p.provider_name);
  const rentBuy = providers.filter((p) => p.offer_type !== 'flatrate').map((p) => p.provider_name);
  console.log(
    `\n  In ${region}: ` +
      (flatrate.length > 0
        ? flatrate.join(', ')
        : rentBuy.length > 0
          ? `rent or buy on ${[...new Set(rentBuy)].slice(0, 4).join(', ')}`
          : 'not available on any tracked service'),
  );
  console.log(
    `\n  1 of ${pick.pool_size} candidates, drawn at ${(pick.share * 100).toFixed(2)}% probability.` +
      `  Status: ${pick.status}.`,
  );
  console.log(`  https://www.themoviedb.org/movie/${pick.tmdb_id}\n`);

  db.close();
}

main();
