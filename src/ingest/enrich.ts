import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client';
import { TmdbClient } from '../tmdb/client';
import { compareCandidates, FUZZY_FLOOR, rankCandidates, resolveTies, yearOf } from '../tmdb/match';
import type { MatchMethod, ScoredCandidate } from '../tmdb/match';
import { OFFER_TYPES } from '../tmdb/types';
import type { TmdbMovieDetail } from '../tmdb/types';

export const OVERRIDES_FILE = path.join(process.cwd(), 'data', 'tmdb-overrides.csv');

interface FilmRow {
  id: number;
  lb_uri: string;
  name: string;
  year: number | null;
}

interface Decision {
  film: FilmRow;
  tmdbId: number | null;
  method: MatchMethod;
  score: number | null;
  confirmed: boolean;
  candidates: ScoredCandidate[];
}

export interface EnrichOptions {
  /** Re-match and re-fetch films that already have a confirmed match. */
  all?: boolean;
  /** Bypass the on-disk response cache. */
  refresh?: boolean;
  /** Stop after this many films. Useful for a smoke test. */
  limit?: number;
  region?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EnrichResult {
  attempted: number;
  byMethod: Record<MatchMethod, number>;
  /** Matched, over the films that can be matched at all. */
  matchRate: number;
  /** Pinned to no TMDB id on purpose: TV series, shorts TMDB has never heard of. */
  excluded: number;
  needsReview: Decision[];
  unmatched: Decision[];
  duplicates: { tmdbId: number; films: string[] }[];
  requests: number;
  cacheHits: number;
}

/**
 * Loads manual resolutions from data/tmdb-overrides.csv.
 *
 * The file is the escape hatch the brief asks for: obscure titles and shorts
 * that search will never find get pinned by hand here, and because it is keyed
 * on the Letterboxd permalink it survives deleting the database.
 */
export function loadOverrides(db: Db, file: string = OVERRIDES_FILE): number {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, 'lb_uri,tmdb_id,note\n');
    return 0;
  }

  const rows = parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string | undefined>[];

  const upsert = db.prepare(
    `INSERT INTO film_match_overrides (lb_uri, tmdb_id, note) VALUES (?, ?, ?)
     ON CONFLICT (lb_uri) DO UPDATE SET tmdb_id = excluded.tmdb_id, note = excluded.note`,
  );

  const write = db.transaction((entries: typeof rows) => {
    db.prepare('DELETE FROM film_match_overrides').run();
    let count = 0;
    for (const row of entries) {
      const lbUri = row['lb_uri']?.trim();
      if (!lbUri) continue;
      const raw = row['tmdb_id']?.trim();
      const tmdbId = raw ? Number.parseInt(raw, 10) : null;
      upsert.run(lbUri, Number.isFinite(tmdbId) ? tmdbId : null, row['note']?.trim() ?? null);
      count += 1;
    }
    return count;
  });

  return write(rows);
}

/** Search TMDB and decide what, if anything, this film is. */
async function decide(client: TmdbClient, film: FilmRow, override?: { tmdb_id: number | null }): Promise<Decision> {
  if (override) {
    return {
      film,
      tmdbId: override.tmdb_id,
      method: 'override',
      score: 1,
      confirmed: true,
      candidates: [],
    };
  }

  // First pass with the year filter, which is what TMDB is best at. If nothing
  // convincing comes back, widen to a title-only search: Letterboxd years are
  // occasionally a year off, and the filter hides the right answer entirely.
  const withYear = await client.searchMovie(film.name, film.year);
  let ranked = rankCandidates(film.name, film.year, withYear.results ?? []);
  let best = resolveTies(ranked);

  if (!best || (best.method !== 'exact' && best.method !== 'near')) {
    const withoutYear = await client.searchMovie(film.name, null);
    const merged = new Map<number, ScoredCandidate>();
    for (const candidate of [...ranked, ...rankCandidates(film.name, film.year, withoutYear.results ?? [])]) {
      const existing = merged.get(candidate.tmdbId);
      if (!existing || candidate.score > existing.score) merged.set(candidate.tmdbId, candidate);
    }
    ranked = [...merged.values()].sort(compareCandidates);
    best = resolveTies(ranked);
  }

  const candidates = ranked.slice(0, 5);

  if (!best) {
    return { film, tmdbId: null, method: 'unmatched', score: null, confirmed: false, candidates };
  }
  if (best.method === 'exact' || best.method === 'near') {
    return {
      film,
      tmdbId: best.tmdbId,
      method: best.method,
      score: best.score,
      confirmed: true,
      candidates,
    };
  }
  if (best.score >= FUZZY_FLOOR) {
    // Plausible, not certain. Recorded so the metadata is usable, but left
    // unconfirmed so `npm run matches` keeps nagging about it.
    return { film, tmdbId: best.tmdbId, method: 'fuzzy', score: best.score, confirmed: false, candidates };
  }
  return { film, tmdbId: null, method: 'unmatched', score: best.score, confirmed: false, candidates };
}

export function persistMovie(db: Db, detail: TmdbMovieDetail, region: string, now: string): void {
  db.prepare(
    `INSERT INTO tmdb_films
       (tmdb_id, imdb_id, title, original_title, original_language, release_date, year,
        runtime, poster_path, backdrop_path, overview, popularity, vote_average, vote_count,
        origin_country, fetched_at)
     VALUES (@tmdbId, @imdbId, @title, @originalTitle, @originalLanguage, @releaseDate, @year,
             @runtime, @posterPath, @backdropPath, @overview, @popularity, @voteAverage, @voteCount,
             @originCountry, @fetchedAt)
     ON CONFLICT (tmdb_id) DO UPDATE SET
       imdb_id = excluded.imdb_id, title = excluded.title,
       original_title = excluded.original_title, original_language = excluded.original_language,
       release_date = excluded.release_date, year = excluded.year, runtime = excluded.runtime,
       poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path,
       overview = excluded.overview, popularity = excluded.popularity,
       vote_average = excluded.vote_average, vote_count = excluded.vote_count,
       origin_country = excluded.origin_country, fetched_at = excluded.fetched_at`,
  ).run({
    tmdbId: detail.id,
    imdbId: detail.imdb_id ?? null,
    title: detail.title,
    originalTitle: detail.original_title ?? null,
    originalLanguage: detail.original_language ?? null,
    releaseDate: detail.release_date || null,
    year: yearOf(detail.release_date),
    runtime: detail.runtime ?? null,
    posterPath: detail.poster_path ?? null,
    backdropPath: detail.backdrop_path ?? null,
    overview: detail.overview ?? null,
    popularity: detail.popularity ?? null,
    voteAverage: detail.vote_average ?? null,
    voteCount: detail.vote_count ?? null,
    originCountry: detail.origin_country?.[0] ?? detail.production_countries?.[0]?.iso_3166_1 ?? null,
    fetchedAt: now,
  });

  db.prepare('DELETE FROM tmdb_film_crew WHERE tmdb_id = ?').run(detail.id);
  const upsertPerson = db.prepare(
    `INSERT INTO tmdb_people (person_id, name) VALUES (?, ?)
     ON CONFLICT (person_id) DO UPDATE SET name = excluded.name`,
  );
  const insertCrew = db.prepare(
    `INSERT INTO tmdb_film_crew (tmdb_id, person_id, job) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  for (const member of detail.credits?.crew ?? []) {
    if (member.job !== 'Director') continue;
    upsertPerson.run(member.id, member.name);
    insertCrew.run(detail.id, member.id, 'Director');
  }

  db.prepare('DELETE FROM tmdb_film_countries WHERE tmdb_id = ?').run(detail.id);
  const insertCountry = db.prepare(
    'INSERT INTO tmdb_film_countries (tmdb_id, country, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const countries = (detail.production_countries ?? []).map((c) => c.iso_3166_1);
  const fallback = detail.origin_country ?? [];
  (countries.length > 0 ? countries : fallback).forEach((country, index) => {
    insertCountry.run(detail.id, country, index);
  });

  db.prepare('DELETE FROM tmdb_film_genres WHERE tmdb_id = ?').run(detail.id);
  const insertGenre = db.prepare(
    'INSERT INTO tmdb_film_genres (tmdb_id, genre_id, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const genre of detail.genres ?? []) insertGenre.run(detail.id, genre.id, genre.name);

  db.prepare('DELETE FROM tmdb_watch_providers WHERE tmdb_id = ? AND region = ?').run(
    detail.id,
    region,
  );
  const insertProvider = db.prepare(
    `INSERT INTO tmdb_watch_providers
       (tmdb_id, region, offer_type, provider_id, provider_name, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const regional = detail['watch/providers']?.results?.[region];
  for (const offerType of OFFER_TYPES) {
    for (const provider of regional?.[offerType] ?? []) {
      insertProvider.run(
        detail.id,
        region,
        offerType,
        provider.provider_id,
        provider.provider_name,
        now,
      );
    }
  }
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function enrich(db: Db, options: EnrichOptions = {}): Promise<EnrichResult> {
  const region = options.region ?? 'BE';
  const now = new Date().toISOString();
  const client = new TmdbClient({ refresh: options.refresh, concurrency: options.concurrency });

  loadOverrides(db);

  // Confirmed matches are left alone unless --all is passed, so a second run
  // only chases the ones that failed.
  const films = db
    .prepare(
      `SELECT f.id, f.lb_uri, f.name, f.year
       FROM films f
       LEFT JOIN film_matches m ON m.film_id = f.id
       WHERE ${options.all ? '1 = 1' : 'm.film_id IS NULL OR m.confirmed = 0'}
       ORDER BY f.id
       ${options.limit ? `LIMIT ${Number(options.limit)}` : ''}`,
    )
    .all() as FilmRow[];

  const overrides = new Map(
    (
      db.prepare('SELECT lb_uri, tmdb_id FROM film_match_overrides').all() as {
        lb_uri: string;
        tmdb_id: number | null;
      }[]
    ).map((row) => [row.lb_uri, row]),
  );

  let done = 0;
  const decisions = await mapPool(films, options.concurrency ?? 6, async (film) => {
    const decision = await decide(client, film, overrides.get(film.lb_uri));
    done += 1;
    options.onProgress?.(done, films.length);
    return decision;
  });

  // Fetch each distinct film once, even if two Letterboxd rows point at it.
  const ids = [...new Set(decisions.map((d) => d.tmdbId).filter((id): id is number => id !== null))];
  const details = await mapPool(ids, options.concurrency ?? 6, (id) => client.movie(id));

  const write = db.transaction(() => {
    for (const detail of details) persistMovie(db, detail, region, now);

    const upsertMatch = db.prepare(
      `INSERT INTO film_matches (film_id, tmdb_id, method, score, confirmed, candidates_json, matched_at)
       VALUES (@filmId, @tmdbId, @method, @score, @confirmed, @candidates, @matchedAt)
       ON CONFLICT (film_id) DO UPDATE SET
         tmdb_id = excluded.tmdb_id, method = excluded.method, score = excluded.score,
         confirmed = excluded.confirmed, candidates_json = excluded.candidates_json,
         matched_at = excluded.matched_at`,
    );
    for (const decision of decisions) {
      upsertMatch.run({
        filmId: decision.film.id,
        tmdbId: decision.tmdbId,
        method: decision.method,
        score: decision.score,
        confirmed: decision.confirmed ? 1 : 0,
        candidates: decision.candidates.length > 0 ? JSON.stringify(decision.candidates) : null,
        matchedAt: now,
      });
    }

    // Enrichment failures share the ingest issue log, per §3 of the brief.
    db.prepare("DELETE FROM ingest_issues WHERE stage = 'enrich'").run();
    const insertIssue = db.prepare(
      `INSERT INTO ingest_issues (import_id, stage, source, severity, code, message, payload)
       VALUES (NULL, 'enrich', 'tmdb', ?, ?, ?, ?)`,
    );
    for (const decision of db
      .prepare(
        `SELECT f.name, f.year, f.lb_uri, m.method, m.score, m.candidates_json
         FROM film_matches m JOIN films f ON f.id = m.film_id
         WHERE m.confirmed = 0`,
      )
      .all() as {
      name: string;
      year: number | null;
      lb_uri: string;
      method: string;
      score: number | null;
      candidates_json: string | null;
    }[]) {
      insertIssue.run(
        decision.method === 'unmatched' ? 'error' : 'warn',
        decision.method === 'unmatched' ? 'tmdb_unmatched' : 'tmdb_needs_review',
        `${decision.name} (${decision.year ?? '?'}): ${
          decision.method === 'unmatched' ? 'no TMDB match' : 'fuzzy TMDB match, needs review'
        }`,
        JSON.stringify(decision),
      );
    }
  });
  write();

  const byMethod = Object.fromEntries(
    (
      db
        .prepare('SELECT method, COUNT(*) AS n FROM film_matches GROUP BY method')
        .all() as { method: MatchMethod; n: number }[]
    ).map((row) => [row.method, row.n]),
  ) as Record<MatchMethod, number>;

  const totalFilms = (db.prepare('SELECT COUNT(*) AS n FROM films').get() as { n: number }).n;
  const matched = (
    db.prepare('SELECT COUNT(*) AS n FROM film_matches WHERE tmdb_id IS NOT NULL').get() as {
      n: number;
    }
  ).n;
  // A film pinned to no TMDB id by an override is a decision, not a failure, so
  // it comes out of the denominator rather than counting against the rate.
  const excluded = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM film_matches WHERE method = 'override' AND tmdb_id IS NULL",
      )
      .get() as { n: number }
  ).n;
  const resolvable = totalFilms - excluded;

  const duplicates = (
    db
      .prepare(
        `SELECT m.tmdb_id AS tmdbId, GROUP_CONCAT(f.name, ' | ') AS films
         FROM film_matches m JOIN films f ON f.id = m.film_id
         WHERE m.tmdb_id IS NOT NULL
         GROUP BY m.tmdb_id HAVING COUNT(*) > 1`,
      )
      .all() as { tmdbId: number; films: string }[]
  ).map((row) => ({ tmdbId: row.tmdbId, films: row.films.split(' | ') }));

  return {
    attempted: films.length,
    byMethod,
    matchRate: resolvable === 0 ? 0 : matched / resolvable,
    excluded,
    needsReview: decisions.filter((d) => d.method === 'fuzzy'),
    unmatched: decisions.filter((d) => d.method === 'unmatched'),
    duplicates,
    requests: client.stats.requests,
    cacheHits: client.stats.cacheHits,
  };
}
