import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';

/**
 * Film search. Two consumers, two scopes.
 *
 * `anchor` is for the lineage editor: a film I have watched and rated 4 or
 * better, since an edge only means something from something I loved.
 * `target` is the candidate pool -- 4,470 films I have not seen -- used both by
 * the lineage editor and by the manual override on the slate.
 *
 * On ranking, which is the part that actually matters here. The pool has two
 * films called Solaris, Tarkovsky's and Soderbergh's, and a search that returns
 * them as two identical rows called "Solaris" is useless however fast it is. So
 * every row carries year, director and country, and ordering puts an exact
 * title match first, then a prefix match, then anything else, breaking ties on
 * vote count. Typing "solaris" surfaces both, labelled, with the 1972 one
 * first because more people have logged it.
 *
 * On speed: a substring search cannot use an index, so this is a scan of the
 * 4,470 pool rows either way. Measured, that is 2.5ms for a selective term and
 * 4.3ms for "a", which is not the bottleneck and not worth an FTS table for a
 * single-user app. The costs actually worth avoiding are on either side of it:
 * the round trip, which the client debounces to one per typed word, and the
 * director lookup, which is a correlated subquery in the projection so it runs
 * for the twelve rows that survive the LIMIT rather than for all 4,470.
 */
export const dynamic = 'force-dynamic';

export interface FilmHit {
  id: number;
  title: string;
  year: number | null;
  note: string;
  /** Set on pool results, so the override can show what it is you are locking in. */
  detail?: string;
}

const countryName = (code: string | null): string | null => {
  if (!code) return null;
  if (code === 'XC') return 'Czechoslovakia';
  if (code === 'SU') return 'Soviet Union';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const scope = url.searchParams.get('scope') === 'anchor' ? 'anchor' : 'target';
  if (query.length < 2) return NextResponse.json([]);

  const like = `%${query}%`;
  const prefix = `${query}%`;

  if (scope === 'anchor') {
    const rows = db()
      .prepare(
        `SELECT t.tmdb_id, t.title, t.year, r.rating FROM ratings r
         JOIN film_matches m ON m.film_id = r.film_id
         JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id
         WHERE r.rating >= 4 AND t.title LIKE ?
         ORDER BY (t.title = ?) DESC, (t.title LIKE ?) DESC, r.rating DESC, t.vote_count DESC
         LIMIT 12`,
      )
      .all(like, query, prefix) as {
      tmdb_id: number;
      title: string;
      year: number | null;
      rating: number | null;
    }[];

    return NextResponse.json(
      rows.map(
        (row): FilmHit => ({
          id: row.tmdb_id,
          title: row.title,
          year: row.year,
          note: `${row.rating} stars`,
        }),
      ),
    );
  }

  // The director subquery is correlated but runs only for the twelve rows that
  // survive the limit, because SQLite evaluates the projection last.
  const rows = db()
    .prepare(
      `SELECT t.tmdb_id, t.title, t.year, t.vote_count, t.runtime, t.origin_country,
              (SELECT group_concat(pe.name, ', ') FROM tmdb_film_crew c
               JOIN tmdb_people pe ON pe.person_id = c.person_id
               WHERE c.tmdb_id = t.tmdb_id AND c.job = 'Director') AS directors
       FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.title LIKE ?
       ORDER BY (t.title = ?) DESC, (t.title LIKE ?) DESC, t.vote_count DESC
       LIMIT 12`,
    )
    .all(like, query, prefix) as {
    tmdb_id: number;
    title: string;
    year: number | null;
    vote_count: number | null;
    runtime: number | null;
    origin_country: string | null;
    directors: string | null;
  }[];

  return NextResponse.json(
    rows.map((row): FilmHit => {
      const parts = [
        row.directors,
        countryName(row.origin_country),
        row.runtime ? `${row.runtime}m` : null,
      ].filter(Boolean);
      return {
        id: row.tmdb_id,
        title: row.title,
        year: row.year,
        note: `${(row.vote_count ?? 0).toLocaleString()} votes`,
        detail: parts.join(' · '),
      };
    }),
  );
}
