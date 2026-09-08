import { NextResponse } from 'next/server';
import { browseFilms } from '../../../lib/browse';
import type { Availability, Scope, Sort } from '../../../lib/browse';

/**
 * The browse tab's one endpoint.
 *
 * `/api/films` answers "which film did you mean", twelve rows at a time, for a
 * search box. This answers "show me everything that matches", paged, for a
 * grid. They are different enough in shape -- filters, a total, a page number,
 * posters -- that folding them together would make both worse.
 *
 * Every parameter is optional and anything unrecognised is dropped rather than
 * rejected: an unknown sort falls back to vote count instead of returning a 400
 * that the grid would have to render as an error state.
 */
export const dynamic = 'force-dynamic';

const SCOPES: Scope[] = ['pool', 'watched', 'all'];
const SORTS: Sort[] = ['votes', 'year-desc', 'year-asc', 'title', 'rank', 'rating'];
const AVAILABILITY: Availability[] = ['flatrate', 'rent', 'any', 'none'];

const oneOf = <T extends string>(value: string | null, allowed: T[]): T | undefined =>
  value !== null && (allowed as string[]).includes(value) ? (value as T) : undefined;

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const text = (key: string): string | undefined => params.get(key)?.trim() || undefined;

  const page = Number.parseInt(params.get('page') ?? '1', 10);

  return NextResponse.json(
    browseFilms({
      q: text('q'),
      scope: oneOf(params.get('scope'), SCOPES) ?? 'pool',
      decade: text('decade'),
      country: text('country'),
      language: text('language'),
      genre: text('genre'),
      movement: text('movement'),
      availability: oneOf(params.get('availability'), AVAILABILITY),
      runtime: text('runtime'),
      votes: text('votes'),
      watchlist: params.get('watchlist') === '1',
      sort: oneOf(params.get('sort'), SORTS) ?? 'votes',
      page: Number.isFinite(page) ? page : 1,
      perPage: 60,
    }),
  );
}
