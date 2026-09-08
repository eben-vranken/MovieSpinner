import type { Db } from '../db/client';
import { decadeLabel } from '../coverage';

/** Everything the draw needs about one pool film, loaded once and scored in memory. */
export interface Candidate {
  tmdbId: number;
  title: string;
  year: number | null;
  decade: string;
  runtime: number | null;
  country: string | null;
  directors: number[];
  directorNames: string[];
  movements: string[];
  genres: number[];
  onWatchlist: boolean;
  voteAverage: number;
  voteCount: number;
  /** Which kinds of list put this film in the pool: canon, collection, ... */
  kinds: string[];
  /** Rank in TSPDT's 1000, when it is in there. The strongest quality signal. */
  tspdtRank: number | null;
  /** How many source lists include this film. Thin signal, but real. */
  listCount: number;
  /** Set when a film I rated 4 or better points at this one. */
  lineage?: { fromTmdbId: number; fromTitle: string; rationale: string };
}

/**
 * My rating history, reduced to averages the junk valve can read.
 *
 * Shrunk toward my overall mean so a genre I have rated twice does not outrank
 * one I have rated forty times. This is a deliberate, readable estimate rather
 * than a model: §10 rules out recommendation ML, and the point is to be able to
 * say out loud why Sunday's film was chosen.
 */
export interface Taste {
  overallMean: number;
  byGenre: Map<number, number>;
  byDirector: Map<number, number>;
  byDecade: Map<string, number>;
}

interface Averaged {
  sum: number;
  count: number;
}

const shrink = (stat: Averaged | undefined, prior: number, mean: number): number => {
  if (!stat) return mean;
  return (stat.sum + prior * mean) / (stat.count + prior);
};

export function loadTaste(db: Db, prior: number): Taste {
  const rated = db
    .prepare(
      `SELECT r.rating, t.tmdb_id, t.year FROM ratings r
       JOIN film_matches m ON m.film_id = r.film_id
       JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id`,
    )
    .all() as { rating: number; tmdb_id: number; year: number | null }[];

  const overallMean =
    rated.length === 0 ? 3.5 : rated.reduce((sum, row) => sum + row.rating, 0) / rated.length;

  const genresByFilm = new Map<number, number[]>();
  for (const row of db.prepare('SELECT tmdb_id, genre_id FROM tmdb_film_genres').all() as {
    tmdb_id: number;
    genre_id: number;
  }[]) {
    genresByFilm.set(row.tmdb_id, [...(genresByFilm.get(row.tmdb_id) ?? []), row.genre_id]);
  }

  const directorsByFilm = new Map<number, number[]>();
  for (const row of db
    .prepare("SELECT tmdb_id, person_id FROM tmdb_film_crew WHERE job = 'Director'")
    .all() as { tmdb_id: number; person_id: number }[]) {
    directorsByFilm.set(row.tmdb_id, [...(directorsByFilm.get(row.tmdb_id) ?? []), row.person_id]);
  }

  const genre = new Map<number, Averaged>();
  const director = new Map<number, Averaged>();
  const decade = new Map<string, Averaged>();
  const add = <K>(map: Map<K, Averaged>, key: K, rating: number): void => {
    const current = map.get(key) ?? { sum: 0, count: 0 };
    current.sum += rating;
    current.count += 1;
    map.set(key, current);
  };

  for (const row of rated) {
    for (const id of genresByFilm.get(row.tmdb_id) ?? []) add(genre, id, row.rating);
    for (const id of directorsByFilm.get(row.tmdb_id) ?? []) add(director, id, row.rating);
    add(decade, decadeLabel(row.year), row.rating);
  }

  const collapse = <K>(map: Map<K, Averaged>): Map<K, number> =>
    new Map([...map].map(([key, stat]) => [key, shrink(stat, prior, overallMean)]));

  return {
    overallMean,
    byGenre: collapse(genre),
    byDirector: collapse(director),
    byDecade: collapse(decade),
  };
}

/** Loads the whole candidate pool with every dimension the weights read. */
export function loadCandidates(db: Db): Candidate[] {
  const films = db
    .prepare(
      `SELECT p.tmdb_id, p.on_watchlist, p.kinds, p.list_count, t.title, t.year, t.runtime, t.origin_country,
              t.vote_average, t.vote_count,
              (SELECT e.position FROM pool_list_entries e
               WHERE e.tmdb_id = p.tmdb_id AND e.list_slug = 'tspdt-1000') AS tspdt_rank
       FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id`,
    )
    .all() as {
    tmdb_id: number;
    on_watchlist: number;
    kinds: string | null;
    list_count: number;
    tspdt_rank: number | null;
    title: string;
    year: number | null;
    runtime: number | null;
    origin_country: string | null;
    vote_average: number | null;
    vote_count: number | null;
  }[];

  const byFilm = <T>(sql: string, key: (row: never) => [number, T]): Map<number, T[]> => {
    const map = new Map<number, T[]>();
    for (const row of db.prepare(sql).all() as never[]) {
      const [id, value] = key(row);
      map.set(id, [...(map.get(id) ?? []), value]);
    }
    return map;
  };

  const directors = byFilm<{ id: number; name: string }>(
    `SELECT c.tmdb_id, c.person_id, p.name FROM tmdb_film_crew c
     JOIN tmdb_people p ON p.person_id = c.person_id WHERE c.job = 'Director'`,
    (row: never) => {
      const r = row as unknown as { tmdb_id: number; person_id: number; name: string };
      return [r.tmdb_id, { id: r.person_id, name: r.name }];
    },
  );
  const movements = byFilm<string>('SELECT tmdb_id, movement FROM film_movements', (row: never) => {
    const r = row as unknown as { tmdb_id: number; movement: string };
    return [r.tmdb_id, r.movement];
  });
  const genres = byFilm<number>('SELECT tmdb_id, genre_id FROM tmdb_film_genres', (row: never) => {
    const r = row as unknown as { tmdb_id: number; genre_id: number };
    return [r.tmdb_id, r.genre_id];
  });

  // Only edges whose anchor I actually rated 4 or better count, per §5.
  const lineage = new Map<number, { fromTmdbId: number; fromTitle: string; rationale: string }>();
  for (const row of db
    .prepare(
      `SELECT e.to_tmdb_id, e.from_tmdb_id, e.from_title, e.rationale, r.rating
       FROM lineage_edges e
       JOIN film_matches m ON m.tmdb_id = e.from_tmdb_id
       JOIN ratings r ON r.film_id = m.film_id
       WHERE r.rating >= 4
       ORDER BY r.rating DESC`,
    )
    .all() as {
    to_tmdb_id: number;
    from_tmdb_id: number;
    from_title: string;
    rationale: string;
  }[]) {
    // Ordered by rating, so the strongest anchor wins when several point here.
    if (!lineage.has(row.to_tmdb_id)) {
      lineage.set(row.to_tmdb_id, {
        fromTmdbId: row.from_tmdb_id,
        fromTitle: row.from_title,
        rationale: row.rationale,
      });
    }
  }

  return films.map((film) => {
    const crew = directors.get(film.tmdb_id) ?? [];
    return {
      tmdbId: film.tmdb_id,
      title: film.title,
      year: film.year,
      decade: decadeLabel(film.year),
      runtime: film.runtime,
      country: film.origin_country,
      directors: crew.map((person) => person.id),
      directorNames: crew.map((person) => person.name),
      movements: movements.get(film.tmdb_id) ?? [],
      genres: genres.get(film.tmdb_id) ?? [],
      onWatchlist: film.on_watchlist === 1,
      voteAverage: film.vote_average ?? 0,
      voteCount: film.vote_count ?? 0,
      kinds: (film.kinds ?? '').split(',').filter(Boolean),
      listCount: film.list_count,
      tspdtRank: film.tspdt_rank,
      lineage: lineage.get(film.tmdb_id),
    };
  });
}
