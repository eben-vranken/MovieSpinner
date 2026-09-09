'use client';

import { useState, useTransition } from 'react';
import { drawAnotherRound } from '../actions';

/**
 * The second film of the evening, and the third.
 *
 * Only rendered once the round's film is marked watched, because that is the
 * only state in which it is allowed to do anything -- the server refuses
 * otherwise and would be right to. Showing it earlier and letting it fail would
 * teach the button as a thing that sometimes works, which is worse than a
 * button that appears when it is true.
 *
 * A client component for the same reason `LockIn` is one: the refusal is worth
 * reading. "Mark the film you chose as watched first" is the sentence that
 * explains the whole rule, and a thrown error would be replaced by a generic
 * one in a production build.
 */
export function NextRound({ date, round }: { date: string; round: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-6 border-t border-edge/60 pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await drawAnotherRound(date);
              // On success the revalidate re-renders the page on the new round,
              // so there is nothing to do here.
              if (!result.ok) setError(result.error);
            });
          }}
          className="rounded border border-accent px-4 py-2 text-sm text-accent hover:bg-accent hover:text-ink disabled:opacity-50"
        >
          {pending ? 'Drawing…' : 'Another five tonight'}
        </button>
        <span className="max-w-md text-xs leading-relaxed text-muted">
          {round === 1
            ? 'A second film, drawn against the gaps you have left after this one. It is a new slate, not a second chance at this one.'
            : `Round ${round + 1}. The films you have already watched today stay exactly as they are.`}
        </span>
      </div>
      {error ? <p className="mt-3 text-xs text-under">{error}</p> : null}
    </div>
  );
}
