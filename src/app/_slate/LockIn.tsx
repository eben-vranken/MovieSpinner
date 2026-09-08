'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { lockInFilm } from '../actions';

/**
 * The manual override: search the pool, lock one in for today.
 *
 * The one client component on the page, because a search box is genuinely
 * interactive and everything else here is not.
 *
 * Three things it does to stay quick over 4,470 films. It waits until you have
 * typed two characters, so the first keystroke never fires a request. It
 * debounces by 200ms, so a typed word costs one round trip rather than one per
 * letter. And it aborts the in-flight request when the query moves on, which
 * also fixes the out-of-order bug you get without it -- a slow response for
 * "sol" landing after a fast one for "solaris" and overwriting it.
 *
 * Results carry year, director and country because the pool has two films
 * called Solaris and picking the wrong one is a decision you cannot take back.
 */

interface Hit {
  id: number;
  title: string;
  year: number | null;
  note: string;
  detail?: string;
}

export function LockIn({ date, poolSize }: { date: string; poolSize: number }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [chosen, setChosen] = useState<Hit | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (chosen || query.trim().length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    timer.current = setTimeout(() => {
      fetch(`/api/films?scope=target&q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
      })
        .then((response) => response.json() as Promise<Hit[]>)
        .then((results) => {
          setHits(results);
          setSearching(false);
        })
        .catch(() => {
          // An abort is the expected path on every keystroke, not a failure.
          if (!controller.signal.aborted) {
            setHits([]);
            setSearching(false);
          }
        });
    }, 200);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      controller.abort();
    };
  }, [query, chosen]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-paper"
      >
        Or lock in something else from the pool
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-edge bg-panel/40 p-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs tracking-[0.18em] text-muted uppercase">Lock one in yourself</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setChosen(null);
            setQuery('');
            setError(null);
          }}
          className="text-xs text-muted hover:text-paper"
        >
          close
        </button>
      </div>
      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
        Any of the {poolSize.toLocaleString()} films still in the candidate pool, not just
        today&rsquo;s five. It is scored the same way, so the card still says which gap it closes.
        Locking one in settles the day, and the day cannot be unsettled.
      </p>

      {chosen ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-edge bg-panel px-3 py-2">
            <span className="text-sm">
              {chosen.title} <span className="text-muted">({chosen.year ?? '?'})</span>
            </span>
            {chosen.detail ? <span className="text-xs text-muted">{chosen.detail}</span> : null}
            <button
              type="button"
              onClick={() => {
                setChosen(null);
                setQuery('');
                setError(null);
              }}
              className="ml-auto text-xs text-muted hover:text-paper"
            >
              change
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await lockInFilm(date, chosen.id);
                  // On success the revalidate re-renders the page with the
                  // chosen film in place, so there is nothing to do here.
                  if (!result.ok) setError(result.error);
                });
              }}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Locking in…' : `Lock in ${chosen.title} for today`}
            </button>
            <span className="text-xs text-muted">This is final, like choosing one of the five.</span>
          </div>
        </div>
      ) : (
        <div className="relative mt-3">
          <label htmlFor={inputId} className="sr-only">
            Search the candidate pool
          </label>
          <input
            id={inputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the pool — try Solaris"
            autoComplete="off"
            className="w-full rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {query.trim().length >= 2 && !searching && hits.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              Nothing in the pool matches. It may be a film you have already seen, or one no source
              list carries.
            </p>
          ) : null}
          {hits.length > 0 ? (
            <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded border border-edge bg-panel shadow-lg">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(hit)}
                    className="w-full px-3 py-2 text-left hover:bg-edge"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="flex-1 truncate text-sm">
                        {hit.title} <span className="text-muted">({hit.year ?? '?'})</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted">{hit.note}</span>
                    </span>
                    {hit.detail ? (
                      <span className="mt-0.5 block truncate text-xs text-muted">{hit.detail}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {error ? <p className="mt-3 text-xs text-under">{error}</p> : null}
    </div>
  );
}
