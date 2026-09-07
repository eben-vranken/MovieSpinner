import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';

/**
 * Film search for the lineage editor.
 *
 * Two scopes, because an edge only means something in one direction: `anchor`
 * is a film I have watched and rated 4 or better, `target` is a film in the
 * candidate pool that I have not seen.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const scope = url.searchParams.get('scope') === 'anchor' ? 'anchor' : 'target';
  if (query.length < 2) return NextResponse.json([]);

  const sql =
    scope === 'anchor'
      ? `SELECT t.tmdb_id, t.title, t.year, r.rating AS extra FROM ratings r
         JOIN film_matches m ON m.film_id = r.film_id
         JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id
         WHERE r.rating >= 4 AND t.title LIKE ?
         ORDER BY r.rating DESC, t.vote_count DESC LIMIT 12`
      : `SELECT t.tmdb_id, t.title, t.year, t.vote_count AS extra FROM pool p
         JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
         WHERE t.title LIKE ?
         ORDER BY t.vote_count DESC LIMIT 12`;

  const rows = db().prepare(sql).all(`%${query}%`) as {
    tmdb_id: number;
    title: string;
    year: number | null;
    extra: number | null;
  }[];

  return NextResponse.json(
    rows.map((row) => ({
      id: row.tmdb_id,
      title: row.title,
      year: row.year,
      note: scope === 'anchor' ? `${row.extra} stars` : `${row.extra ?? 0} votes`,
    })),
  );
}
