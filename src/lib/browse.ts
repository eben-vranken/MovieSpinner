import { tmdbConfig } from '../config';
import { countryName, languageName } from './analytics';
import { db } from './db';
import type { BrowseFilm, BrowsePage, CountryFilms } from '../app/_browse/types';

/**
 * Reading the library as a list rather than as a chart.
 *
 * Every other read in this project answers "how much" -- how many films from
 * Poland, how many before 1950. This one answers "which", which is the question
 * you actually have once a chart has told you a cell is empty. It is the same
 * two sets the charts count, unioned: the candidate pool, and the watched films
 * that carry a TMDB match.
 *
 * The two sets are kept apart in the SQL rather than merged in TypeScript so
 * the filters, the sort and the count all run over the same rows the page will
 * draw. A watched film and a pool film are never the same row -- the pool
 * excludes watched films by construction -- so the union is disjoint except on
 * a stale pool, which the `all` scope resolves in favour of watched.
 *
 * On cost: a scan of the pool and the watched set with a few indexed EXISTS
 * lookups. No FTS table and no cache, for the same reason the pool search does
 * without them -- at this size both would be another copy of the truth to keep
 * honest, and neither is the slow part.
 */

export type Scope = 'pool' | 'watched' | 'all';
export type Sort = 'votes' | 'year-desc' | 'year-asc' | 'title' | 'rank' | 'rating';
export type Availability = 'flatrate' | 'rent' | 'any' | 'none';

export interface BrowseQuery {
  q?: string;
  scope?: Scope;
  decade?: string;
  country?: string;
  language?: string;
  genre?: string;
  movement?: string;
  availability?: Availability;
  runtime?: string;
  votes?: string;
  watchlist?: boolean;
  sort?: Sort;
  page?: number;
  perPage?: number;
}

/** The runtime bands the analytics chart uses, as filter ranges. */
export const RUNTIME_FILTERS: Record<string, [number, number]> = {
  short: [0, 44],
  brief: [45, 74],
  normal: [75, 104],
  long: [105, 134],
  longer: [135, 179],
  epic: [180, 100000],
};

/** The vote bands the obscurity chart uses, as filter ranges. */
export const VOTE_FILTERS: Record<string, [number, number]> = {
  none: [0, 0],
  tiny: [1, 49],
  small: [50, 199],
  some: [200, 999],
  known: [1000, 9999],
  famous: [10000, 100000000],
};

/**
 * The two arms of the union.
 *
 * Only the columns the filters and the sort need are carried here. Directors,
 * list membership and rank are correlated subqueries in the outer projection
 * instead, where SQLite runs them for the rows that survived the LIMIT rather
 * than for every row in both sets.
 */
const POOL_ARM = `
  SELECT t.tmdb_id AS id, t.title, t.year, t.poster_path, t.runtime,
         t.origin_country, t.original_language, COALESCE(t.vote_count, 0) AS votes,
         0 AS seen, NULL AS rating, 1 AS in_pool, p.on_watchlist
  FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id`;

const SEEN_ARM = `
  SELECT t.tmdb_id AS id, t.title, t.year, t.poster_path, t.runtime,
         t.origin_country, t.original_language, COALESCE(t.vote_count, 0) AS votes,
         1 AS seen, MAX(r.rating) AS rating,
         EXISTS (SELECT 1 FROM pool p WHERE p.tmdb_id = t.tmdb_id) AS in_pool,
         0 AS on_watchlist
  FROM watched w
  JOIN film_matches m ON m.film_id = w.film_id
  JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id
  LEFT JOIN ratings r ON r.film_id = w.film_id
  GROUP BY t.tmdb_id`;

/** A pool film that is also watched is a stale pool row; the watched arm wins. */
const POOL_ARM_UNSEEN = `${POOL_ARM}
  WHERE NOT EXISTS (SELECT 1 FROM film_matches m2 JOIN watched w2 ON w2.film_id = m2.film_id
                    WHERE m2.tmdb_id = t.tmdb_id)`;

const baseFor = (scope: Scope): string => {
  if (scope === 'pool') return POOL_ARM;
  if (scope === 'watched') return SEEN_ARM;
  return `${POOL_ARM_UNSEEN} UNION ALL ${SEEN_ARM}`;
};

/** Directors, lists and rank: affordable because they run after the LIMIT. */
const OUTER = `
  b.*,
  (SELECT group_concat(pe.name, ', ') FROM tmdb_film_crew c
   JOIN tmdb_people pe ON pe.person_id = c.person_id
   WHERE c.tmdb_id = b.id AND c.job = 'Director') AS directors,
  (SELECT COUNT(*) FROM pool_list_entries e WHERE e.tmdb_id = b.id) AS list_count,
  (SELECT MIN(e.position) FROM pool_list_entries e
   WHERE e.tmdb_id = b.id AND e.position IS NOT NULL) AS best_rank`;

interface DbRow {
  id: number;
  title: string;
  year: number | null;
  poster_path: string | null;
  runtime: number | null;
  origin_country: string | null;
  original_language: string | null;
  votes: number;
  seen: number;
  rating: number | null;
  in_pool: number;
  on_watchlist: number;
  directors: string | null;
  list_count: number;
  best_rank: number | null;
}

const toFilm = (row: DbRow): BrowseFilm => ({
  id: row.id,
  title: row.title,
  year: row.year,
  posterPath: row.poster_path,
  runtime: row.runtime,
  country: row.origin_country,
  countryName: row.origin_country ? countryName(row.origin_country) : null,
  language: row.original_language ? languageName(row.original_language) : null,
  votes: row.votes,
  directors: row.directors ? row.directors.split(', ').filter(Boolean) : [],
  seen: row.seen === 1,
  rating: row.rating,
  inPool: row.in_pool === 1,
  onWatchlist: row.on_watchlist === 1,
  listCount: row.list_count,
  bestRank: row.best_rank,
});

/**
 * Nulls last on every sort that can produce them. An undated film at the top of
 * a list sorted by year, or an unrated one at the top of a list sorted by
 * rating, is the absence of a value being read as an extreme value.
 */
const ORDER: Record<Sort, string> = {
  votes: 'b.votes DESC, b.title',
  'year-desc': 'b.year IS NULL, b.year DESC, b.title',
  'year-asc': 'b.year IS NULL, b.year, b.title',
  title: 'b.title',
  rating: 'b.rating IS NULL, b.rating DESC, b.votes DESC',
  rank: 'sort_rank IS NULL, sort_rank, b.votes DESC',
};

/** The WHERE clause, built once and used by both the count and the page. */
function conditions(query: BrowseQuery): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];

  const term = query.q?.trim();
  if (term && term.length >= 2) {
    clauses.push('b.title LIKE ?');
    args.push(`%${term}%`);
  }

  if (query.decade) {
    if (query.decade === 'pre-1950') {
      clauses.push('b.year IS NOT NULL AND b.year < 1950');
    } else {
      const start = Number.parseInt(query.decade, 10);
      if (Number.isFinite(start)) {
        clauses.push('b.year >= ? AND b.year <= ?');
        args.push(start, start + 9);
      }
    }
  }

  if (query.country) {
    clauses.push('b.origin_country = ?');
    args.push(query.country);
  }

  if (query.language) {
    clauses.push('b.original_language = ?');
    args.push(query.language);
  }

  if (query.genre) {
    clauses.push('EXISTS (SELECT 1 FROM tmdb_film_genres g WHERE g.tmdb_id = b.id AND g.name = ?)');
    args.push(query.genre);
  }

  if (query.movement) {
    clauses.push(
      'EXISTS (SELECT 1 FROM film_movements fm WHERE fm.tmdb_id = b.id AND fm.movement = ?)',
    );
    args.push(query.movement);
  }

  // Availability is regional and the region is configuration, not a parameter:
  // a filter that quietly asked a different region than the slate cards do
  // would be two answers to one question.
  if (query.availability) {
    const { region } = tmdbConfig();
    const offer = (type: string): string =>
      `EXISTS (SELECT 1 FROM tmdb_watch_providers wp WHERE wp.tmdb_id = b.id AND wp.region = ?${type})`;

    if (query.availability === 'none') clauses.push(`NOT ${offer('')}`);
    else if (query.availability === 'any') clauses.push(offer(''));
    else if (query.availability === 'rent') clauses.push(offer(" AND wp.offer_type IN ('rent','buy')"));
    else clauses.push(offer(" AND wp.offer_type = 'flatrate'"));
    args.push(region);
  }

  const runtime = query.runtime ? RUNTIME_FILTERS[query.runtime] : undefined;
  if (runtime) {
    clauses.push('b.runtime IS NOT NULL AND b.runtime >= ? AND b.runtime <= ?');
    args.push(runtime[0], runtime[1]);
  }

  const votes = query.votes ? VOTE_FILTERS[query.votes] : undefined;
  if (votes) {
    clauses.push('b.votes >= ? AND b.votes <= ?');
    args.push(votes[0], votes[1]);
  }

  if (query.watchlist) clauses.push('b.on_watchlist = 1');

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

export function browseFilms(query: BrowseQuery): BrowsePage {
  const handle = db();
  const scope: Scope = query.scope ?? 'pool';
  const perPage = Math.min(120, Math.max(12, query.perPage ?? 60));
  const page = Math.max(1, query.page ?? 1);
  const sort: Sort = query.sort ?? 'votes';

  const base = baseFor(scope);
  const { sql: where, args } = conditions(query);

  // `best_rank` lives in the outer projection, so sorting by it needs the
  // subquery here too. Every other sort reads a column the base already has.
  const orderBy = ORDER[sort] ?? ORDER.votes;
  // Aliased apart from the outer projection's `best_rank`, which computes the
  // same thing: two columns of one name in one result set is a coin toss over
  // which one the driver hands back.
  const rankColumn =
    sort === 'rank'
      ? `, (SELECT MIN(e.position) FROM pool_list_entries e
            WHERE e.tmdb_id = b.id AND e.position IS NOT NULL) AS sort_rank`
      : '';

  const total =
    (
      handle.prepare(`SELECT COUNT(*) AS n FROM (${base}) b ${where}`).get(...args) as
        | { n: number }
        | undefined
    )?.n ?? 0;

  const rows = handle
    .prepare(
      `SELECT ${OUTER} FROM (SELECT b.*${rankColumn} FROM (${base}) b ${where}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?) b`,
    )
    .all(...args, perPage, (page - 1) * perPage) as DbRow[];

  return { films: rows.map(toFilm), total, page, perPage };
}

/**
 * One country, both sides of it.
 *
 * The map hands over every code that folded into the shape you clicked, because
 * one outline can be several codes in the data: Czechia is drawn once and the
 * database holds both CZ and XC for it, and dropping the historical code would
 * empty the panel for exactly the films this project cares most about.
 *
 * Watched films come back best-rated first, which is the order you want when
 * the question is "what have I seen from here". Pool films come back by vote
 * count, which is the order you want when the question is "what next".
 */
export function countryFilms(codes: string[], limit = 200): CountryFilms {
  const handle = db();
  const clean = [...new Set(codes.filter((code) => /^[A-Z]{2}$/.test(code)))];
  if (clean.length === 0) {
    return { code: '', name: '', watched: [], pool: [], watchedTotal: 0, poolTotal: 0 };
  }

  const holes = clean.map(() => '?').join(', ');
  const count = (base: string): number =>
    (
      handle
        .prepare(`SELECT COUNT(*) AS n FROM (${base}) b WHERE b.origin_country IN (${holes})`)
        .get(...clean) as { n: number } | undefined
    )?.n ?? 0;

  const listOf = (base: string, order: string): BrowseFilm[] =>
    (
      handle
        .prepare(
          `SELECT ${OUTER} FROM (SELECT b.* FROM (${base}) b
             WHERE b.origin_country IN (${holes}) ORDER BY ${order} LIMIT ?) b`,
        )
        .all(...clean, limit) as DbRow[]
    ).map(toFilm);

  return {
    code: clean[0]!,
    name: countryName(clean[0]!),
    watched: listOf(SEEN_ARM, ORDER.rating),
    pool: listOf(POOL_ARM, ORDER.votes),
    watchedTotal: count(SEEN_ARM),
    poolTotal: count(POOL_ARM),
  };
}
