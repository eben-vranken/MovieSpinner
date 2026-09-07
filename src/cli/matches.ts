import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/client';
import { OVERRIDES_FILE } from '../ingest/enrich';
import type { ScoredCandidate } from '../tmdb/match';

/**
 * The manual resolution path the brief asks for.
 *
 * Prints every film TMDB matching could not settle, with the runners-up the
 * matcher considered, and appends a stub line per film to
 * data/tmdb-overrides.csv. Fill in the tmdb_id column, re-run `npm run enrich`,
 * and the override wins.
 *
 * Usage:
 *   npm run matches            # list what needs a human
 *   npm run matches -- --write # also append stubs to the overrides CSV
 */

interface Row {
  film_id: number;
  lb_uri: string;
  name: string;
  year: number | null;
  method: string;
  score: number | null;
  candidates_json: string | null;
}

function main(): void {
  const db = openDb();

  const rows = db
    .prepare(
      `SELECT m.film_id, f.lb_uri, f.name, f.year, m.method, m.score, m.candidates_json
       FROM film_matches m JOIN films f ON f.id = m.film_id
       WHERE m.confirmed = 0
       ORDER BY m.method, f.year`,
    )
    .all() as Row[];

  const never = db
    .prepare(
      `SELECT f.lb_uri, f.name, f.year FROM films f
       LEFT JOIN film_matches m ON m.film_id = f.id
       WHERE m.film_id IS NULL`,
    )
    .all() as { lb_uri: string; name: string; year: number | null }[];

  if (rows.length === 0 && never.length === 0) {
    console.log('Every film has a confirmed TMDB match. Nothing to review.');
    db.close();
    return;
  }

  if (never.length > 0) {
    console.log(`${never.length} film(s) never attempted. Run: npm run enrich\n`);
  }

  for (const row of rows) {
    console.log(`${row.name} (${row.year ?? '?'})  [${row.method}${row.score ? ` ${row.score.toFixed(2)}` : ''}]`);
    console.log(`  ${row.lb_uri}`);
    const candidates = row.candidates_json
      ? (JSON.parse(row.candidates_json) as ScoredCandidate[])
      : [];
    if (candidates.length === 0) {
      console.log('  no candidates returned by search');
    }
    for (const candidate of candidates) {
      console.log(
        `  ${String(candidate.tmdbId).padStart(8)}  ${candidate.score.toFixed(2)}  ` +
          `${candidate.title} (${candidate.year ?? '?'})  https://themoviedb.org/movie/${candidate.tmdbId}`,
      );
    }
    console.log('');
  }

  if (process.argv.includes('--write')) {
    const existing = fs.existsSync(OVERRIDES_FILE)
      ? fs.readFileSync(OVERRIDES_FILE, 'utf8')
      : 'lb_uri,tmdb_id,note\n';
    const lines = [existing.trimEnd()];
    let added = 0;
    for (const row of [...rows, ...never]) {
      if (existing.includes(row.lb_uri)) continue;
      lines.push(`${row.lb_uri},,"${row.name.replace(/"/g, '""')} (${row.year ?? '?'})"`);
      added += 1;
    }
    fs.writeFileSync(OVERRIDES_FILE, `${lines.join('\n')}\n`);
    console.log(
      `Appended ${added} stub row(s) to ${path.relative(process.cwd(), OVERRIDES_FILE)}. ` +
        'Fill in tmdb_id, then re-run npm run enrich.',
    );
  } else {
    console.log(`${rows.length + never.length} film(s) need a decision. ` +
      'Run `npm run matches -- --write` to seed the overrides CSV.');
  }

  db.close();
}

main();
