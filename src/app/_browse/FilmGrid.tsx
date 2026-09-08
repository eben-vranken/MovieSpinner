'use client';

import { posterUrl } from '../../lib/poster';
import type { BrowseFilm } from './types';

/**
 * A wall of posters, used by the browse tab and by the country panel.
 *
 * Plain `<img>` rather than `next/image`, and the one place on this page that
 * departs from it. The slate shows five posters and wants every one of them
 * optimised and preloaded; this shows sixty at a time from a CDN that already
 * serves the exact width asked for, and routing that through the image
 * optimiser would mean sixty server-side transcodes to produce the same bytes.
 * Native lazy loading covers the rest.
 *
 * `data-seen` on the card is the whole implementation of the dim toggle. The
 * rule lives in globals.css and keys off an attribute on the shell, so a
 * server-rendered grid dims exactly like a fetched one and neither needs to
 * know the toggle exists.
 */

const STAR = '★';

/** A rating as stars, halves included, because 3.5 is not "3 or 4". */
const stars = (rating: number): string =>
  `${STAR.repeat(Math.floor(rating))}${rating % 1 >= 0.5 ? '½' : ''}`;

function Card({ film }: { film: BrowseFilm }) {
  const poster = posterUrl(film.posterPath, 'w342');
  const meta = [film.year ?? '?', film.countryName, film.runtime ? `${film.runtime}m` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <li data-seen={film.seen ? 'true' : undefined} className="group">
      <a
        href={`https://www.themoviedb.org/movie/${film.id}`}
        target="_blank"
        rel="noreferrer"
        className="block focus:outline-none"
      >
        <div className="poster relative overflow-hidden rounded border border-edge bg-edge/30 transition group-hover:border-accent group-focus:border-accent">
          {poster ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              width={342}
              height={513}
              className="aspect-2/3 h-auto w-full object-cover"
            />
          ) : (
            <div className="flex aspect-2/3 items-center justify-center text-xs text-muted">
              no poster
            </div>
          )}

          {film.seen ? (
            <span className="absolute top-1 left-1 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] tracking-wide text-accent">
              {film.rating ? stars(film.rating) : 'seen'}
            </span>
          ) : null}
          {film.onWatchlist ? (
            <span className="absolute top-1 right-1 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] tracking-wide text-muted uppercase">
              list
            </span>
          ) : null}
        </div>
      </a>

      <p className="mt-1.5 truncate text-xs leading-snug group-hover:text-accent" title={film.title}>
        {film.title}
      </p>
      <p className="truncate text-[11px] text-muted" title={meta}>
        {meta}
      </p>
      <p
        className="truncate text-[11px] text-muted opacity-80"
        title={film.directors.join(', ')}
      >
        {film.directors.join(', ') || 'Director unknown'}
      </p>
    </li>
  );
}

export function FilmGrid({ films, empty = 'Nothing matches.' }: { films: BrowseFilm[]; empty?: string }) {
  if (films.length === 0) return <p className="py-6 text-xs text-muted">{empty}</p>;

  return (
    <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
      {films.map((film) => (
        <Card key={film.id} film={film} />
      ))}
    </ul>
  );
}
