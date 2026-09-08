'use client';

import { useEffect, useRef, useState } from 'react';
import { FilmGrid } from '../_browse/FilmGrid';
import type { CountryFilms } from '../_browse/types';

/**
 * The map, once it can be clicked.
 *
 * Everything expensive happened on the server: this receives finished path
 * strings and two counts each. What it adds is the thing a choropleth is
 * otherwise bad at -- a shade tells you Poland is thin and then refuses to say
 * which four films you have seen from it, which is the only follow-up question
 * anyone actually has.
 *
 * Selection is local state and the films arrive by fetch, so the page around it
 * never re-renders. A country with no data on either side is not a control: it
 * is still drawn, still hoverable, and simply has nothing behind it.
 */

export interface Shape {
  id: string;
  name: string;
  d: string;
  watched: number;
  pool: number;
  /** Alpha-2 codes that folded into this outline. Empty means nothing to open. */
  codes: string[];
}

const films = (count: number): string => `${count} ${count === 1 ? 'film' : 'films'}`;

export function WorldMapClient({
  shapes,
  width,
  height,
  max,
  drawn,
  unmatched,
}: {
  shapes: Shape[];
  width: number;
  height: number;
  max: number;
  drawn: number;
  unmatched: string[];
}) {
  const [selected, setSelected] = useState<Shape | null>(null);
  const [data, setData] = useState<CountryFilms | null>(null);
  const [side, setSide] = useState<'watched' | 'pool'>('watched');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    // Open on the side that has something on it. Clicking a country you have
    // never watched anything from should show what the pool holds, not an
    // empty grid you then have to click past.
    setSide(selected.watched > 0 ? 'watched' : 'pool');

    fetch(
      `/api/country?codes=${selected.codes.join(',')}&name=${encodeURIComponent(selected.name)}`,
      { signal: controller.signal },
    )
      .then((response) => (response.ok ? (response.json() as Promise<CountryFilms>) : null))
      .then((result) => {
        if (result) setData(result);
        else setError('Could not read that country.');
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('Could not read that country.');
          setLoading(false);
        }
      });

    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return () => controller.abort();
  }, [selected]);

  // Log scale, because the United States would otherwise flatten everything
  // else into the same shade of nothing.
  const shade = (count: number): string => {
    if (count === 0) return 'var(--color-panel)';
    const intensity = Math.log10(1 + count) / Math.log10(1 + max);
    return `color-mix(in oklab, var(--color-accent) ${Math.round(18 + intensity * 82)}%, var(--color-panel))`;
  };

  const shown = data ? (side === 'watched' ? data.watched : data.pool) : [];
  const total = data ? (side === 'watched' ? data.watchedTotal : data.poolTotal) : 0;

  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label="World map of countries by films watched. Select a country to list its films."
      >
        {shapes.map((shape) => {
          const live = shape.codes.length > 0;
          const active = selected?.id === shape.id;
          return (
            <path
              key={shape.id}
              d={shape.d}
              fill={shade(shape.watched)}
              stroke={active ? 'var(--color-paper)' : 'var(--color-ink)'}
              strokeWidth={active ? 1.2 : 0.4}
              className={live ? 'cursor-pointer hover:stroke-paper' : undefined}
              role={live ? 'button' : undefined}
              tabIndex={live ? 0 : undefined}
              aria-label={live ? `${shape.name}, ${films(shape.watched)} watched` : undefined}
              onClick={live ? () => setSelected(active ? null : shape) : undefined}
              onKeyDown={
                live
                  ? (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      setSelected(active ? null : shape);
                    }
                  : undefined
              }
            >
              <title>
                {`${shape.name}: ${films(shape.watched)} watched${
                  shape.pool > 0 ? `, ${shape.pool} in pool` : ''
                }`}
              </title>
            </path>
          );
        })}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {drawn} countries on the map, darkest is {max}
        </span>
        <span>Click a country for its films.</span>
        {unmatched.length > 0 ? <span>Not drawable: {unmatched.join(', ')}</span> : null}
      </figcaption>

      {selected ? (
        <div ref={panel} className="mt-4 rounded-lg border border-edge bg-ink/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h4 className="text-sm font-medium">{data?.name ?? selected.name}</h4>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-muted hover:text-paper"
            >
              close
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                ['watched', `Seen · ${data?.watchedTotal ?? selected.watched}`],
                ['pool', `In pool · ${data?.poolTotal ?? selected.pool}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSide(key)}
                className={`rounded border px-3 py-1 text-xs transition ${
                  side === key
                    ? 'border-accent text-accent'
                    : 'border-edge text-muted hover:text-paper'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            {loading ? (
              <p className="py-6 text-xs text-muted">Reading {selected.name}…</p>
            ) : error ? (
              <p className="py-6 text-xs text-under">{error}</p>
            ) : (
              <>
                <FilmGrid
                  films={shown}
                  empty={
                    side === 'watched'
                      ? `Nothing watched from ${data?.name ?? selected.name} yet. That is the point of the panel.`
                      : `No candidates from ${data?.name ?? selected.name} in the pool, so the engine cannot offer you one.`
                  }
                />
                {shown.length > 0 ? (
                  <p className="mt-3 text-xs text-muted">
                    {shown.length < total
                      ? `First ${shown.length} of ${total}, `
                      : `All ${total}, `}
                    {side === 'watched' ? 'best rated first.' : 'most voted first.'}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </figure>
  );
}
