import type { Db } from '../db/client';
import { persistMovie } from '../ingest/enrich';
import { TmdbClient } from '../tmdb/client';
import type { TmdbMovieDetail } from '../tmdb/types';
import type { RssEntry } from './rss';

/**
 * Folds the RSS feed into the same tier-1 tables a zip import writes:
 * `films`, `film_matches`, `watched`, `diary_entries`, `ratings`, `likes`,
 * plus an immediate, scoped pool exclusion.
 *
 * This is the thing that used to be deliberately skipped -- the feed only
 * ever holds the last ~50 diary entries, so backfilling coverage from it was
 * judged too easy to let drift. What makes it safe now is that every entry
 * carries an exact tmdb:movieId, so there is no fuzzy title matching to get
 * wrong, and every write below is ON CONFLICT-safe, so re-running this over
 * the same entries on every sync is free and self-healing rather than a
 * second source of truth to keep in step with the first.
 *
 * A film already known (rated, watchlisted, or previously synced) is found
 * by tmdb_id through film_matches and reused. A film that is not -- the
 * common case, since most of what gets watched off this app's own pool was
 * never in a Letterboxd export -- gets a synthetic `films` row keyed on
 * `rss:<tmdbId>` rather than a real Letterboxd permalink. `import.ts`
 * reconciles that placeholder back onto the real one the next time a full
 * zip import sees the same film.
 */

export interface MergeResult {
  filmsBackfilled: number;
  watchedAdded: number;
  ratingsAdded: number;
  poolExcluded: number;
  failures: string[];
}

const EMPTY: MergeResult = {
  filmsBackfilled: 0,
  watchedAdded: 0,
  ratingsAdded: 0,
  poolExcluded: 0,
  failures: [],
};

export async function mergeWatched(db: Db, entries: RssEntry[], region: string): Promise<MergeResult> {
  const candidates = entries.filter((e): e is RssEntry & { tmdbId: number } => e.tmdbId !== null);
  if (candidates.length === 0) return { ...EMPTY };

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const failures: string[] = [];

  const findMatch = db.prepare('SELECT film_id AS filmId FROM film_matches WHERE tmdb_id = ?');
  const hasTmdbFilm = db.prepare('SELECT 1 AS ok FROM tmdb_films WHERE tmdb_id = ?');

  // TMDB fetches are async; better-sqlite3 transactions are not, so every
  // network call has to happen before the write transaction opens (same
  // fetch-then-transact shape enrich() uses in src/ingest/enrich.ts).
  const details = new Map<number, TmdbMovieDetail>();
  const client = new TmdbClient({ region });
  const toFetch = [...new Set(candidates.map((e) => e.tmdbId))].filter(
    (id) => !findMatch.get(id) && !hasTmdbFilm.get(id),
  );
  for (const id of toFetch) {
    try {
      details.set(id, await client.movie(id));
    } catch (cause) {
      failures.push(`tmdb:${id}: ${cause instanceof Error ? cause.message : 'fetch failed'}`);
    }
  }

  const result: MergeResult = { filmsBackfilled: 0, watchedAdded: 0, ratingsAdded: 0, poolExcluded: 0, failures };

  const insertFilm = db.prepare(
    `INSERT INTO films (lb_uri, name, year, first_seen_at, updated_at)
     VALUES (@lbUri, @name, @year, @now, @now)
     ON CONFLICT (lb_uri) DO NOTHING`,
  );
  const insertMatch = db.prepare(
    `INSERT INTO film_matches (film_id, tmdb_id, method, score, confirmed, candidates_json, matched_at)
     VALUES (@filmId, @tmdbId, 'rss', 1, 1, NULL, @now)
     ON CONFLICT (film_id) DO NOTHING`,
  );
  const insertWatched = db.prepare(
    'INSERT INTO watched (film_id, added_date) VALUES (?, ?) ON CONFLICT (film_id) DO NOTHING',
  );
  const insertDiary = db.prepare(
    `INSERT INTO diary_entries (entry_uri, film_id, logged_date, watched_date, rating, rewatch, tags)
     VALUES (@entryUri, @filmId, @loggedDate, @watchedDate, @rating, @rewatch, NULL)
     ON CONFLICT (entry_uri) DO NOTHING`,
  );
  const insertRating = db.prepare(
    `INSERT INTO ratings (film_id, rating, rated_date) VALUES (?, ?, ?)
     ON CONFLICT (film_id) DO UPDATE SET rating = excluded.rating, rated_date = excluded.rated_date`,
  );
  const insertLike = db.prepare(
    'INSERT INTO likes (film_id, liked_date) VALUES (?, ?) ON CONFLICT (film_id) DO NOTHING',
  );
  const wasWatched = db.prepare('SELECT 1 AS ok FROM watched WHERE film_id = ?');

  const write = db.transaction((rows: (RssEntry & { tmdbId: number })[]) => {
    const newlyWatched: number[] = [];

    for (const entry of rows) {
      const detail = details.get(entry.tmdbId);
      if (detail) {
        persistMovie(db, detail, region, now);
        result.filmsBackfilled += 1;
      }

      let filmId = (findMatch.get(entry.tmdbId) as { filmId: number } | undefined)?.filmId;
      if (filmId === undefined) {
        if (!detail && !hasTmdbFilm.get(entry.tmdbId)) {
          // TMDB fetch failed and there is nothing cached either -- this one
          // waits for the next sync rather than being written half-formed.
          continue;
        }
        const lbUri = `rss:${entry.tmdbId}`;
        insertFilm.run({ lbUri, name: entry.title, year: entry.year, now });
        const film = db.prepare('SELECT id FROM films WHERE lb_uri = ?').get(lbUri) as { id: number };
        insertMatch.run({ filmId: film.id, tmdbId: entry.tmdbId, now });
        filmId = film.id;
      }

      const alreadyWatched = wasWatched.get(filmId);
      insertWatched.run(filmId, entry.watchedDate);
      if (!alreadyWatched) {
        result.watchedAdded += 1;
        newlyWatched.push(entry.tmdbId);
      }

      insertDiary.run({
        entryUri: entry.link ?? `rss:${entry.guid}`,
        filmId,
        loggedDate: today,
        watchedDate: entry.watchedDate ?? today,
        rating: entry.rating,
        rewatch: entry.rewatch ? 1 : 0,
      });

      if (entry.rating !== null) {
        insertRating.run(filmId, entry.rating, entry.watchedDate ?? today);
        result.ratingsAdded += 1;
      }
      if (entry.liked) insertLike.run(filmId, entry.watchedDate ?? today);
    }

    // Same derivation src/pool/index.ts's "deduping and excluding watched"
    // step makes on a full rebuild, just scoped to what changed just now so a
    // sync never has to trigger a full (network-dependent) pool rebuild.
    if (newlyWatched.length > 0) {
      const marks = newlyWatched.map(() => '?').join(', ');
      db.prepare(
        `INSERT INTO pool_excluded (tmdb_id, reason) SELECT tmdb_id, 'watched' FROM pool
         WHERE tmdb_id IN (${marks}) ON CONFLICT (tmdb_id) DO NOTHING`,
      ).run(...newlyWatched);
      db.prepare(
        `INSERT INTO pool_dropped (tmdb_id, title, year, reason, detail)
         SELECT p.tmdb_id, t.title, t.year, 'watched', 'already in the watched set'
         FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
         WHERE p.tmdb_id IN (${marks}) ON CONFLICT (tmdb_id) DO NOTHING`,
      ).run(...newlyWatched);
      result.poolExcluded = db.prepare(`DELETE FROM pool WHERE tmdb_id IN (${marks})`).run(...newlyWatched)
        .changes;
    }
  });

  write(candidates);
  return result;
}
