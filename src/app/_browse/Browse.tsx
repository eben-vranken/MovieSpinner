'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FilmGrid } from './FilmGrid';
import type { BrowseFilm, BrowsePage } from './types';

/**
 * The whole library as a wall, with the filters the charts imply.
 *
 * Every panel on this page ends in the same unanswered question. The matrix
 * says 1950s Eastern Europe is empty; the movements list says you have never
 * touched Cinema Novo; the availability bar says two thousand films are
 * nowhere. None of them will tell you *which films*, and until this tab there
 * was no way to ask -- the pool search wanted a title you already knew.
 *
 * So the filters are deliberately the same buckets the charts use: the decade
 * bands, the runtime bands, the vote bands, the movement slugs. A filter that
 * sliced the pool differently from the chart that sent you here would give two
 * answers to one question.
 *
 * Paging is a button rather than a scroll listener. Sixty posters is already a
 * screenful and a half, and a grid that grows while you are reading it is
 * harder to use than one that waits to be asked.
 */

export interface Facets {
  decades: string[];
  countries: { code: string; name: string; count: number; pool: number }[];
  genres: { key: string; label: string }[];
  languages: { key: string; label: string }[];
  movements: { slug: string; name: string }[];
  runtimes: { key: string; label: string }[];
  votes: { key: string; label: string }[];
  region: string;
  poolSize: number;
  watchedSize: number;
}

interface Filters {
  q: string;
  scope: 'pool' | 'watched' | 'all';
  decade: string;
  country: string;
  genre: string;
  language: string;
  movement: string;
  runtime: string;
  votes: string;
  availability: string;
  watchlist: boolean;
  sort: string;
}

const EMPTY: Filters = {
  q: '',
  scope: 'pool',
  decade: '',
  country: '',
  genre: '',
  language: '',
  movement: '',
  runtime: '',
  votes: '',
  availability: '',
  watchlist: false,
  sort: 'votes',
};

const SORTS: [string, string][] = [
  ['votes', 'Most voted'],
  ['rank', 'Canon rank'],
  ['year-asc', 'Oldest first'],
  ['year-desc', 'Newest first'],
  ['title', 'Title'],
  ['rating', 'Your rating'],
];

const toQuery = (filters: Filters, page: number): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === '' || value === false) continue;
    params.set(key, value === true ? '1' : String(value));
  }
  if (page > 1) params.set('page', String(page));
  return params.toString();
};

function Select({
  label,
  value,
  onChange,
  options,
  any,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
  /** The do-not-filter row. Omitted where the control always has an answer. */
  any?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] tracking-[0.14em] text-muted uppercase">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`rounded border bg-panel px-2 py-1.5 text-xs outline-none focus:border-accent ${
          value ? 'border-accent/60 text-paper' : 'border-edge text-muted'
        }`}
      >
        {any ? <option value="">{any}</option> : null}
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Browse({ facets }: { facets: Facets }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [films, setFilms] = useState<BrowseFilm[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void =>
    setFilters((current) => ({ ...current, [key]: value }));

  // What "clear" would actually clear. The sort is not a filter, and the pool
  // is the resting scope rather than a choice you made.
  const active = useMemo(
    () =>
      Object.entries(filters).filter(([key, value]) => {
        if (key === 'sort') return false;
        if (key === 'scope') return value !== 'pool';
        return value !== '' && value !== false;
      }).length,
    [filters],
  );

  // One effect for the first page of any filter change. The typed query is
  // debounced and the rest are not, because a select fires once and a keystroke
  // fires per letter; both abort whatever is still in flight.
  useEffect(() => {
    const controller = new AbortController();
    const delay = filters.q.trim().length > 0 ? 250 : 0;
    setLoading(true);
    setError(null);

    timer.current = setTimeout(() => {
      fetch(`/api/pool?${toQuery(filters, 1)}`, { signal: controller.signal })
        .then((response) => (response.ok ? (response.json() as Promise<BrowsePage>) : null))
        .then((result) => {
          if (!result) {
            setError('Could not read the pool.');
          } else {
            setFilms(result.films);
            setTotal(result.total);
            setPage(1);
          }
          setLoading(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setError('Could not read the pool.');
            setLoading(false);
          }
        });
    }, delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      controller.abort();
    };
  }, [filters]);

  const loadMore = (): void => {
    setAppending(true);
    fetch(`/api/pool?${toQuery(filters, page + 1)}`)
      .then((response) => (response.ok ? (response.json() as Promise<BrowsePage>) : null))
      .then((result) => {
        if (result) {
          // Keyed by id rather than concatenated blindly: a page boundary can
          // repeat a row if the underlying set moves, and a duplicate key in a
          // grid is a React warning and a phantom film.
          setFilms((current) => {
            const seen = new Set(current.map((film) => film.id));
            return [...current, ...result.films.filter((film) => !seen.has(film.id))];
          });
          setPage(result.page);
        }
        setAppending(false);
      })
      .catch(() => setAppending(false));
  };

  const countryOptions: [string, string][] = facets.countries.map((row) => [
    row.code,
    `${row.name} — ${row.count} seen, ${row.pool} in pool`,
  ]);

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xs tracking-[0.2em] text-muted uppercase">Browse</h2>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            The {facets.poolSize.toLocaleString()} films still in the candidate pool, and the{' '}
            {facets.watchedSize.toLocaleString()} you have already seen, on the same filters the
            charts are cut by. This is the answer to every chart that told you a cell was empty
            without saying what was in it.
          </p>
        </div>
        <p className="text-xs text-muted">
          {loading ? 'counting…' : `${total.toLocaleString()} films match`}
        </p>
      </div>

      {/* ---- the filter bar --------------------------------------------- */}
      <div className="mt-5 rounded-lg border border-edge bg-panel p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1">
            <span className="text-[10px] tracking-[0.14em] text-muted uppercase">Title</span>
            <input
              value={filters.q}
              onChange={(event) => set('q', event.target.value)}
              placeholder="Two letters is enough"
              autoComplete="off"
              className="rounded border border-edge bg-panel px-2 py-1.5 text-xs outline-none focus:border-accent"
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] tracking-[0.14em] text-muted uppercase">Set</span>
            <div className="flex overflow-hidden rounded border border-edge">
              {(
                [
                  ['pool', 'Pool'],
                  ['watched', 'Seen'],
                  ['all', 'Both'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => set('scope', key)}
                  className={`px-3 py-1.5 text-xs transition ${
                    filters.scope === key
                      ? 'bg-accent text-ink'
                      : 'text-muted hover:bg-edge hover:text-paper'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Select
            label="Decade"
            value={filters.decade}
            onChange={(value) => set('decade', value)}
            any="Any decade"
            options={facets.decades.map((key) => [key, key.replace('pre-', 'before ')])}
          />
          <Select
            label="Country"
            value={filters.country}
            onChange={(value) => set('country', value)}
            any="Any country"
            options={countryOptions}
          />
          <Select
            label="Movement"
            value={filters.movement}
            onChange={(value) => set('movement', value)}
            any="Any movement"
            options={facets.movements.map((row) => [row.slug, row.name])}
          />
          <Select
            label="Genre"
            value={filters.genre}
            onChange={(value) => set('genre', value)}
            any="Any genre"
            options={facets.genres.map((row) => [row.key, row.label])}
          />
          <Select
            label="Language"
            value={filters.language}
            onChange={(value) => set('language', value)}
            any="Any language"
            options={facets.languages.map((row) => [row.key, row.label])}
          />
          <Select
            label="Runtime"
            value={filters.runtime}
            onChange={(value) => set('runtime', value)}
            any="Any length"
            options={facets.runtimes.map((row) => [row.key, row.label])}
          />
          <Select
            label="Obscurity"
            value={filters.votes}
            onChange={(value) => set('votes', value)}
            any="Any vote count"
            options={facets.votes.map((row) => [row.key, row.label])}
          />
          <Select
            label={`Where (${facets.region})`}
            value={filters.availability}
            onChange={(value) => set('availability', value)}
            any="Anywhere or not"
            options={[
              ['flatrate', 'On a subscription'],
              ['rent', 'Rent or buy'],
              ['any', 'Reachable at all'],
              ['none', 'Nowhere tracked'],
            ]}
          />
          <Select
            label="Sort"
            value={filters.sort}
            onChange={(value) => set('sort', value)}
            options={SORTS}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={filters.watchlist}
              onChange={(event) => set('watchlist', event.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            On my watchlist
          </label>
          {active > 0 ? (
            <button
              type="button"
              onClick={() => setFilters({ ...EMPTY, sort: filters.sort })}
              className="text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-paper"
            >
              Clear {active} filter{active === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>
      </div>

      {/* ---- the wall ---------------------------------------------------- */}
      <div className="mt-5">
        {error ? (
          <p className="py-8 text-xs text-under">{error}</p>
        ) : loading ? (
          <p className="py-8 text-xs text-muted">Reading the pool…</p>
        ) : (
          <>
            <FilmGrid
              films={films}
              empty="Nothing matches those filters. That is either a blind spot with no candidates behind it, or one filter too many."
            />
            {films.length < total ? (
              <div className="mt-6 flex items-center gap-4">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={appending}
                  className="rounded border border-edge px-4 py-2 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {appending ? 'Loading…' : 'Show more'}
                </button>
                <span className="text-xs text-muted">
                  {films.length.toLocaleString()} of {total.toLocaleString()}
                </span>
              </div>
            ) : films.length > 0 ? (
              <p className="mt-6 text-xs text-muted">
                All {total.toLocaleString()} of them.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
