'use client';

import { useState, useTransition } from 'react';
import { refreshFromFeed } from '../actions';

/**
 * The manual trigger for the same job the cron already runs on a schedule --
 * read the Letterboxd feed, fold anything newly watched into coverage, Taste,
 * Browse and the pool, close out today's pick if it shows watched. Useful the
 * evening you don't want to wait for the schedule.
 *
 * It only ever knows about the last ~50 diary entries, so it's a supplement
 * to re-importing the export occasionally, not a replacement for it.
 */
export function Refresh() {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            const outcome = await refreshFromFeed();
            setResult(
              outcome.ok ? { ok: true, message: outcome.summary } : { ok: false, message: outcome.error },
            );
          });
        }}
        className="rounded border border-edge px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {pending ? 'Refreshing…' : 'Refresh from Letterboxd'}
      </button>
      {result ? (
        <span className={`text-xs ${result.ok ? 'text-muted' : 'text-under'}`}>{result.message}</span>
      ) : null}
    </div>
  );
}
