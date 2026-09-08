import { NextResponse } from 'next/server';
import { countryFilms } from '../../../lib/browse';

/**
 * What one country holds, for the click on the map.
 *
 * Fetched rather than shipped with the page. The map already knows every
 * country's counts, and putting the films behind those counts in the payload
 * would mean serving several thousand titles on every load so that one of them
 * could be looked at.
 *
 * `codes` is a list because a shape on the map can be several codes in the
 * data. The map is the one that knows which, so it sends them.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const codes = (params.get('codes') ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

  if (codes.length === 0) {
    return NextResponse.json({ error: 'No country codes given.' }, { status: 400 });
  }

  const films = countryFilms(codes);
  // The label the map drew, not the one Intl derives from the first code:
  // clicking Czechia should not come back titled "Czechoslovakia".
  const name = params.get('name')?.trim();
  return NextResponse.json(name ? { ...films, name } : films);
}
