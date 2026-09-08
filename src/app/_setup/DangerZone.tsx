'use client';

import { useState, useTransition } from 'react';
import { resetInstall } from '../actions';

/**
 * Reset the whole install, to see what a fresh clone looks like.
 *
 * Folded shut and last on the page, because it is the only control here that
 * destroys something an export cannot rebuild. The typed confirmation is not
 * theatre: this page has five other irreversible buttons on it and they are all
 * one click, so the thing that separates "settle today" from "delete four
 * hundred films" has to be more than a slightly redder button.
 *
 * It says what it deletes before you do it rather than after.
 */
export function DangerZone({ watched }: { watched: number }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [clearCaches, setClearCaches] = useState(false);
  const [clearExports, setClearExports] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-under"
      >
        Reset everything
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-under/40 bg-panel p-5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs tracking-[0.18em] text-under uppercase">Reset everything</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirmation('');
            setError(null);
          }}
          className="text-xs text-muted hover:text-paper"
        >
          cancel
        </button>
      </div>

      <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
        Empties the database and puts this install back to what someone sees the
        minute they clone it: the setup screen, asking for a TMDB key and an
        export. Written first, without asking, is a full copy of the database
        into <code>data/backups/</code>, so this is a mistake you can walk back.
      </p>

      <ul className="mt-3 space-y-1 text-xs text-muted">
        <li>
          <span className="text-under">Deleted</span> — your {watched.toLocaleString()} watched
          films, ratings, diary and watchlist; every TMDB match; the candidate pool; the coverage
          snapshots; and the log of every slate and pick.
        </li>
        <li>
          <span className="text-paper">Kept</span> — the schema, your <code>.env</code>, and the
          committed CSVs: movements, lineage edges, regions and match overrides.
        </li>
      </ul>

      <div className="mt-4 space-y-2">
        <label className="flex items-start gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={clearCaches}
            onChange={(event) => setClearCaches(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also clear the TMDB and scrape caches.{' '}
            <span className="text-muted/70">
              Off by default: the caches change nothing about how setup looks, only how long it
              takes. Tick this to sit through the same few minutes a stranger would.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={clearExports}
            onChange={(event) => setClearExports(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also delete the <code>letterboxd-*.zip</code> exports in <code>data/</code>.{' '}
            <span className="text-muted/70">
              You will need the zip again to re-import, so leave this off unless you have it
              elsewhere.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="Type RESET"
          autoComplete="off"
          aria-label="Type RESET to confirm"
          className="w-40 rounded border border-edge bg-ink px-3 py-2 text-sm outline-none focus:border-under"
        />
        <button
          type="button"
          disabled={pending || confirmation.trim().toUpperCase() !== 'RESET'}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await resetInstall(confirmation, { clearCaches, clearExports });
              // On success the revalidate swaps the whole page for the setup
              // screen, but this component is inside the part being replaced,
              // so a reload is the honest way to land on it.
              if (result.ok) window.location.reload();
              else setError(result.error);
            });
          }}
          className="rounded bg-under px-4 py-2 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-40"
        >
          {pending ? 'Resetting…' : 'Delete everything'}
        </button>
      </div>

      {error ? <p className="mt-3 text-xs text-under">{error}</p> : null}
    </div>
  );
}
