/**
 * TMDB poster URLs, with no database behind them.
 *
 * This lives apart from `lib/db` because the browse grid and the country panel
 * are client components: importing the helper from `lib/db` would drag
 * better-sqlite3 into the client graph for the sake of a string template.
 */
export type PosterSize = 'w92' | 'w154' | 'w185' | 'w342' | 'w500';

export const posterUrl = (path: string | null, size: PosterSize | string = 'w500'): string | null =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
