'use client';

import { useEffect, useState, useTransition } from 'react';
import { beginCampaign, stopCampaign } from '../actions';
import type { CampaignKind, CampaignOrdering, CampaignView } from '../../lib/campaign';

/**
 * Campaign mode: commit to one subject and work through it.
 *
 * Optional, and off by default, because the ordinary blind-spot draw is the
 * right default -- it is what finds the gaps you did not know you had. This is
 * for when you already know, and want to stop skating.
 *
 * The panel is two states. Running: the curriculum, in order, with what you
 * have already taken struck through, so it reads as a course rather than a
 * counter. Not running: a picker over the three dimensions the engine tracks,
 * sorted so the ones worth committing to surface first.
 */

interface Option {
  kind: CampaignKind;
  subject: string;
  label: string;
  available: number;
  watched: number;
  best: string | null;
}

const KINDS: { key: CampaignKind; label: string; note: string }[] = [
  { key: 'director', label: 'Director', note: 'A filmography, in release order. The deepest kind.' },
  { key: 'movement', label: 'Movement', note: 'Watch one emerge, film by film.' },
  { key: 'country', label: 'Country', note: 'Broadest. Good for a region you have never touched.' },
];

function Running({ view }: { view: CampaignView }) {
  const [pending, startTransition] = useTransition();
  const { campaign, taken, total, remaining, days } = view;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-sm">
            <span className="text-accent">{campaign.label}</span>
            <span className="text-muted"> · {campaign.kind}</span>
          </p>
          <p className="mt-1 text-xs text-muted">
            {taken} of {total} watched, {remaining} to go · day {days} · {campaign.ordering}
          </p>
        </div>
        <form
          action={() => {
            startTransition(async () => {
              await stopCampaign();
              window.location.reload();
            });
          }}
        >
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-edge px-3 py-1 text-xs text-muted hover:text-paper disabled:opacity-50"
          >
            {pending ? 'Ending…' : 'End campaign'}
          </button>
        </form>
      </div>

      {/* A meter rather than a number: the point of a campaign is that it has
          an end, and the bar is the only thing on the page that shows one. */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-sm bg-edge">
        <div
          className="h-full rounded-sm bg-accent"
          style={{ width: `${total === 0 ? 0 : (taken / total) * 100}%` }}
        />
      </div>

      <ol className="mt-4 max-h-72 space-y-1 overflow-y-auto pr-2">
        {view.films.map((film, index) => (
          <li
            key={film.tmdbId}
            className={`flex items-baseline gap-3 text-xs ${film.taken ? 'text-muted' : ''}`}
          >
            <span className="w-6 shrink-0 text-right tabular-nums text-muted">{index + 1}</span>
            <span className={`flex-1 truncate ${film.taken ? 'line-through' : 'text-paper'}`}>
              {film.title} <span className="text-muted">({film.year ?? '?'})</span>
            </span>
            {film.takenOn ? (
              <span className="shrink-0 tabular-nums text-muted">{film.takenOn}</span>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="mt-3 text-xs text-muted">
        The next five of these are today&rsquo;s slate. Ending the campaign does not change a
        slate that has already been drawn.
      </p>
    </div>
  );
}

function Picker() {
  const [kind, setKind] = useState<CampaignKind>('director');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [ordering, setOrdering] = useState<CampaignOrdering>('chronological');
  const [chosen, setChosen] = useState<Option | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/campaigns?kind=${kind}&q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((response) => response.json() as Promise<Option[]>)
        .then((results) => {
          setOptions(results);
          setLoading(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, query]);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {KINDS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setKind(entry.key);
              setChosen(null);
            }}
            className={`rounded border px-3 py-1.5 text-xs ${
              kind === entry.key
                ? 'border-accent text-accent'
                : 'border-edge text-muted hover:text-paper'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{KINDS.find((e) => e.key === kind)?.note}</p>

      {kind !== 'country' ? (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={kind === 'director' ? 'Filter by name — try Ozu' : 'Filter movements'}
          autoComplete="off"
          aria-label="Filter campaign subjects"
          className="mt-3 w-full rounded border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
        />
      ) : null}

      <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-2">
        {loading && options.length === 0 ? (
          <li className="text-xs text-muted">Loading…</li>
        ) : options.length === 0 ? (
          <li className="text-xs text-muted">
            Nothing with at least four unseen films in the pool matches.
          </li>
        ) : (
          options.map((option) => (
            <li key={`${option.kind}-${option.subject}`}>
              <button
                type="button"
                onClick={() => setChosen(option)}
                className={`w-full rounded border px-3 py-2 text-left ${
                  chosen?.subject === option.subject
                    ? 'border-accent bg-panel'
                    : 'border-edge/60 hover:border-edge hover:bg-panel'
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="flex-1 truncate text-sm">{option.label}</span>
                  <span className="shrink-0 text-xs text-accent">{option.available} unseen</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {option.watched > 0 ? `${option.watched} watched · ` : 'none watched · '}
                  {option.best ? `incl. ${option.best}` : 'no standout'}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>

      {chosen ? (
        <div className="mt-4 border-t border-edge pt-4">
          <p className="text-sm">
            Commit to <span className="text-accent">{chosen.label}</span> — {chosen.available}{' '}
            films.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(['chronological', 'canonical'] as CampaignOrdering[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setOrdering(value)}
                className={`rounded border px-3 py-1.5 text-xs ${
                  ordering === value
                    ? 'border-accent text-accent'
                    : 'border-edge text-muted hover:text-paper'
                }`}
              >
                {value === 'chronological' ? 'In release order' : 'Best regarded first'}
              </button>
            ))}
          </div>
          <p className="mt-2 max-w-prose text-xs text-muted">
            {ordering === 'chronological'
              ? 'How a body of work actually makes sense — you watch it develop.'
              : 'The peaks first. Good when you want to know if it is for you before committing.'}
          </p>

          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await beginCampaign(
                  chosen.kind,
                  chosen.subject,
                  chosen.label,
                  ordering,
                );
                if (result.ok) window.location.reload();
                else setError(result.error);
              });
            }}
            className="mt-4 rounded bg-accent px-4 py-2 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Starting…' : `Start the ${chosen.label} campaign`}
          </button>
          <p className="mt-2 text-xs text-muted">
            Starts with tomorrow&rsquo;s slate. Today&rsquo;s five were already drawn and stay as
            they are.
          </p>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-xs text-under">{error}</p> : null}
    </div>
  );
}

export function CampaignPanel({
  view,
  seenOnce,
}: {
  view: CampaignView | null;
  /** Directors seen exactly once. The argument for this mode, in one number. */
  seenOnce: number;
}) {
  const [open, setOpen] = useState(false);

  // A running campaign is the frame for the whole day, so it is always shown.
  // The picker is not: most days you are not starting one.
  if (view) return <Running view={view} />;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-paper"
      >
        Start a campaign — go deep on one director, movement or country
      </button>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs tracking-[0.18em] text-muted uppercase">Start a campaign</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted hover:text-paper"
        >
          close
        </button>
      </div>
      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
        The daily draw is breadth-first, and it is why you have seen {seenOnce} directors exactly
        once. A campaign inverts that: the five become the next five of one subject, in order,
        until you finish it or stop. Still one film a day, still final.
      </p>
      <div className="mt-4">
        <Picker />
      </div>
    </div>
  );
}
