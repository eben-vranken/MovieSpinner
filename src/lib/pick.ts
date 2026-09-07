import { tmdbConfig } from '../config';
import { loadMovements } from '../coverage';
import { createEngine, draw, loadState, persistPick } from '../engine';
import { loadLineage } from '../engine/lineage';
import { db, today } from './db';

/** Everything the daily card renders. */
export interface PickView {
  date: string;
  tmdbId: number;
  kind: 'blind-spot' | 'junk-valve';
  status: 'pending' | 'watched' | 'skipped';
  title: string;
  year: number | null;
  runtime: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  country: string | null;
  directors: string[];
  movements: string[];
  genres: string[];
  lineageRationale: string | null;
  lineageFromTitle: string | null;
  reason: Record<string, number>;
  share: number;
  poolSize: number;
  region: string;
  streaming: string[];
  rentBuy: string[];
  /** Populated only once the pick is resolved, so the card can show the streak. */
  streak: number;
}

interface PickRow {
  pick_date: string;
  tmdb_id: number;
  kind: 'blind-spot' | 'junk-valve';
  status: 'pending' | 'watched' | 'skipped';
  share: number;
  pool_size: number;
  reason_json: string;
  lineage_rationale: string | null;
  lineage_from: number | null;
  title: string;
  year: number | null;
  runtime: number | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  origin_country: string | null;
}

const SELECT_PICK = `
  SELECT p.pick_date, p.tmdb_id, p.kind, p.status, p.share, p.pool_size, p.reason_json,
         p.lineage_rationale, p.lineage_from,
         t.title, t.year, t.runtime, t.overview, t.poster_path, t.backdrop_path, t.origin_country
  FROM picks p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
  WHERE p.pick_date = ?`;

/**
 * Today's film, generated on first read and never again.
 *
 * The generate-on-read is safe precisely because `persistPick` refuses to
 * overwrite: two tabs opening at midnight cannot produce two different films.
 */
export function ensurePick(date: string = today()): PickView {
  const handle = db();
  let row = handle.prepare(SELECT_PICK).get(date) as PickRow | undefined;

  if (!row) {
    loadMovements(handle);
    loadLineage(handle);
    const engine = createEngine(handle);
    if (engine.candidates.length === 0) {
      throw new Error('The candidate pool is empty. Run `npm run pool` first.');
    }
    persistPick(handle, draw(engine, loadState(handle), date));
    row = handle.prepare(SELECT_PICK).get(date) as PickRow;
  }

  const { region } = tmdbConfig();
  const list = <T>(sql: string, ...args: unknown[]): T[] => handle.prepare(sql).all(...args) as T[];

  const directors = list<{ name: string }>(
    `SELECT p.name FROM tmdb_film_crew c JOIN tmdb_people p ON p.person_id = c.person_id
     WHERE c.tmdb_id = ? AND c.job = 'Director'`,
    row.tmdb_id,
  ).map((entry) => entry.name);

  const movements = list<{ name: string }>(
    `SELECT m.name FROM film_movements fm JOIN movements m ON m.slug = fm.movement
     WHERE fm.tmdb_id = ? ORDER BY m.sort_order`,
    row.tmdb_id,
  ).map((entry) => entry.name);

  const genres = list<{ name: string }>(
    'SELECT name FROM tmdb_film_genres WHERE tmdb_id = ?',
    row.tmdb_id,
  ).map((entry) => entry.name);

  const providers = list<{ provider_name: string; offer_type: string }>(
    `SELECT DISTINCT provider_name, offer_type FROM tmdb_watch_providers
     WHERE tmdb_id = ? AND region = ?`,
    row.tmdb_id,
    region,
  );

  const lineageFrom = row.lineage_from
    ? (handle
        .prepare('SELECT from_title FROM lineage_edges WHERE from_tmdb_id = ? AND to_tmdb_id = ?')
        .get(row.lineage_from, row.tmdb_id) as { from_title: string | null } | undefined)
    : undefined;

  return {
    date: row.pick_date,
    tmdbId: row.tmdb_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    year: row.year,
    runtime: row.runtime,
    overview: row.overview,
    posterPath: row.poster_path,
    backdropPath: row.backdrop_path,
    country: row.origin_country,
    directors,
    movements,
    genres,
    lineageRationale: row.lineage_rationale,
    lineageFromTitle: lineageFrom?.from_title ?? null,
    reason: JSON.parse(row.reason_json) as Record<string, number>,
    share: row.share,
    poolSize: row.pool_size,
    region,
    streaming: providers.filter((p) => p.offer_type === 'flatrate').map((p) => p.provider_name),
    rentBuy: [
      ...new Set(providers.filter((p) => p.offer_type !== 'flatrate').map((p) => p.provider_name)),
    ],
    streak: currentStreak(),
  };
}

/**
 * Consecutive resolved days ending today. Skips break it, because a skip is a
 * decision not to watch. §7 asks for this to stay low-key, so it is one number.
 */
export function currentStreak(): number {
  const rows = db()
    .prepare(`SELECT pick_date, status FROM picks ORDER BY pick_date DESC`)
    .all() as { pick_date: string; status: string }[];

  let streak = 0;
  let expected: string | null = null;
  for (const row of rows) {
    if (row.status !== 'watched') break;
    if (expected !== null && row.pick_date !== expected) break;
    streak += 1;
    expected = new Date(Date.parse(`${row.pick_date}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return streak;
}

/** The plain-language version of why a blind-spot film came up. */
export function reasonSentence(pick: PickView): string {
  if (pick.kind === 'junk-valve') {
    return 'Sunday. No homework today, just something the ratings say you would enjoy.';
  }
  const named: [string, number, string][] = [
    ['decade', pick.reason['decade'] ?? 1, `the ${pick.year ? `${Math.floor(pick.year / 10) * 10}s` : 'decade'}`],
    ['country', pick.reason['country'] ?? 1, 'that country'],
    ['director', pick.reason['director'] ?? 1, 'this director'],
    ['movement', pick.reason['movement'] ?? 1, pick.movements[0] ?? 'this movement'],
  ];
  const strongest = named.sort((a, b) => b[1] - a[1])[0];
  if (!strongest || strongest[1] <= 1.05) return 'A gap across several dimensions at once.';
  return `Mostly ${strongest[2]}, where your coverage is thinnest.`;
}
