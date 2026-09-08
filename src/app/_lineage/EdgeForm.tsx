'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { addLineageEdge } from '../actions';

interface Hit {
  id: number;
  title: string;
  year: number | null;
  note: string;
}

/** A search box that resolves to one tmdb_id, since an edge is two ids and a sentence. */
function FilmPicker({
  name,
  scope,
  label,
  hint,
}: {
  name: string;
  scope: 'anchor' | 'target';
  label: string;
  hint: string;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [chosen, setChosen] = useState<Hit | null>(null);
  const listId = useId();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (chosen || query.trim().length < 2) {
      setHits([]);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const controller = new AbortController();
      fetch(`/api/films?scope=${scope}&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((response) => response.json() as Promise<Hit[]>)
        .then(setHits)
        .catch(() => setHits([]));
    }, 200);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, scope, chosen]);

  return (
    <div>
      <label htmlFor={listId} className="block text-xs tracking-wide text-muted uppercase">
        {label}
      </label>
      <p className="mt-1 text-xs text-muted">{hint}</p>
      {chosen ? (
        <div className="mt-2 flex items-center gap-3 rounded border border-edge bg-panel px-3 py-2">
          <span className="flex-1 text-sm">
            {chosen.title} <span className="text-muted">({chosen.year ?? '?'})</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setChosen(null);
              setQuery('');
            }}
            className="text-xs text-muted hover:text-paper"
          >
            change
          </button>
          <input type="hidden" name={name} value={chosen.id} />
        </div>
      ) : (
        <div className="relative mt-2">
          <input
            id={listId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a title"
            autoComplete="off"
            className="w-full rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {hits.length > 0 ? (
            <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border border-edge bg-panel">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(hit)}
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-edge"
                  >
                    <span className="flex-1 truncate">
                      {hit.title} <span className="text-muted">({hit.year ?? '?'})</span>
                    </span>
                    <span className="text-xs text-muted">{hit.note}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function EdgeForm() {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await addLineageEdge(formData);
        formRef.current?.reset();
        // The pickers hold their own state, so a reload is the honest way to
        // clear them rather than threading keys through every child.
        window.location.reload();
      }}
      className="rounded border border-edge bg-panel/40 p-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <FilmPicker
          name="from"
          scope="anchor"
          label="From"
          hint="Something you rated 4 or better. Only those count."
        />
        <FilmPicker
          name="to"
          scope="target"
          label="To"
          hint="A film in the pool you have not seen."
        />
      </div>
      <div className="mt-5">
        <label htmlFor="rationale" className="block text-xs tracking-wide text-muted uppercase">
          Rationale
        </label>
        <p className="mt-1 text-xs text-muted">
          One sentence. This is what appears on the card, and it is the difference between a
          coverage percentage and a reason.
        </p>
        <textarea
          id="rationale"
          name="rationale"
          rows={2}
          required
          className="mt-2 w-full rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          placeholder="Half of what you love about Blade Runner's city was built in 1927."
        />
      </div>
      <button
        type="submit"
        className="mt-4 rounded bg-accent px-4 py-2 text-sm font-medium text-ink hover:opacity-90"
      >
        Add edge
      </button>
    </form>
  );
}
