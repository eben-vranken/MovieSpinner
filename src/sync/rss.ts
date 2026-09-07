/**
 * Reads the public Letterboxd RSS feed.
 *
 * No auth, no API application, roughly the last fifty diary entries. §3 is
 * explicit that Letterboxd's real API is request-only and should not be built
 * against, so this is the whole of tier 2.
 */

export interface RssEntry {
  guid: string;
  tmdbId: number | null;
  title: string;
  year: number | null;
  watchedDate: string | null;
  rating: number | null;
  rewatch: boolean;
  liked: boolean;
  link: string | null;
}

export const feedUrl = (username: string): string =>
  `https://letterboxd.com/${username}/rss/`;

const decode = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const tag = (item: string, name: string): string | null => {
  const match = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return match?.[1] ? decode(match[1]) : null;
};

export function parseFeed(xml: string): RssEntry[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  return items.flatMap((item) => {
    // A guid is present on every diary entry. Items without one are the
    // occasional list or review-only post, which this does not care about.
    const guid = tag(item, 'guid');
    const title = tag(item, 'letterboxd:filmTitle');
    if (!guid || !title) return [];

    const number = (name: string): number | null => {
      const raw = tag(item, name);
      const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : null;
    };

    return [
      {
        guid,
        tmdbId: number('tmdb:movieId'),
        title,
        year: number('letterboxd:filmYear'),
        watchedDate: tag(item, 'letterboxd:watchedDate'),
        rating: number('letterboxd:memberRating'),
        rewatch: tag(item, 'letterboxd:rewatch')?.toLowerCase() === 'yes',
        liked: tag(item, 'letterboxd:memberLike')?.toLowerCase() === 'yes',
        link: tag(item, 'link'),
      },
    ];
  });
}

export async function fetchFeed(username: string): Promise<RssEntry[]> {
  const response = await fetch(feedUrl(username), {
    headers: { 'user-agent': 'MovieSpinner (personal use)' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Letterboxd RSS returned ${response.status}`);
  return parseFeed(await response.text());
}
