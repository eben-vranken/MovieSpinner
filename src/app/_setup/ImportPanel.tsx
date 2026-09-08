'use client';

import { useEffect, useRef, useState } from 'react';
import { importExportFile } from '../actions';
import type { AppStatus } from '../../lib/status';
import type { SetupRun, Stage } from '../../setup/pipeline';

/**
 * Upload a Letterboxd export and watch the four steps run.
 *
 * The progress display is a checklist rather than a percentage bar, because
 * three of the four steps cannot honestly report a percentage -- the pool build
 * is a dozen scrapes and a few thousand lookups with no meaningful denominator.
 * Only the TMDB matching step knows how many films it has left, so only it gets
 * a bar. Everything else says which step it is on and what it is doing.
 *
 * Polling, not streaming. The run writes to `setup_runs`, and one request every
 * two seconds is a cheaper and far less fragile way to follow a five-minute job
 * than holding a connection open across it.
 */

const STAGE_LABELS: { key: Stage; label: string; note: string }[] = [
  { key: 'import', label: 'Read the export', note: 'Watched, ratings, diary, watchlist, likes.' },
  {
    key: 'enrich',
    label: 'Match against TMDB',
    note: 'Country, director, runtime and where to watch each film. The slow step.',
  },
  { key: 'coverage', label: 'Count the coverage', note: 'Decade, country, director, movement.' },
  {
    key: 'pool',
    label: 'Build the candidate pool',
    note: 'Canon, Criterion, regional and auteur lists, minus everything you have seen.',
  },
];

const stageIndex = (stage: Stage): number =>
  stage === 'ready' ? STAGE_LABELS.length : STAGE_LABELS.findIndex((entry) => entry.key === stage);

function Progress({ run }: { run: SetupRun }) {
  const current = stageIndex(run.stage);

  return (
    <ol className="mt-4 space-y-2">
      {STAGE_LABELS.map((entry, index) => {
        const done = index < current;
        const active = index === current && run.status === 'running';
        const failed = index === current && run.status === 'failed';
        const showBar = active && entry.key === 'enrich' && run.total > 0;

        return (
          <li key={entry.key} className="flex gap-3">
            <span
              aria-hidden
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                done
                  ? 'bg-accent text-ink'
                  : failed
                    ? 'bg-under text-ink'
                    : active
                      ? 'border border-accent text-accent'
                      : 'border border-edge text-muted'
              }`}
            >
              {done ? '✓' : failed ? '!' : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm ${active || done ? 'text-paper' : 'text-muted'}`}>
                {entry.label}
                {active ? <span className="ml-2 text-xs text-accent">running</span> : null}
              </p>
              <p className="text-xs text-muted">
                {active && run.detail ? run.detail : entry.note}
              </p>
              {showBar ? (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-sm bg-edge">
                  <div
                    className="h-full rounded-sm bg-accent transition-all"
                    style={{ width: `${Math.min(100, (run.done / run.total) * 100)}%` }}
                  />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ImportPanel({
  status,
  compact = false,
}: {
  status: AppStatus;
  /** The bottom-of-page version, once the app already has data. */
  compact?: boolean;
}) {
  const [run, setRun] = useState<SetupRun | null>(status.run);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!compact);
  const [filename, setFilename] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const running = run?.status === 'running';
  // A failed run that has since been resolved -- by re-running a step in a
  // terminal, say -- is history, not a problem. If the app is ready, the
  // failure has been dealt with by definition, so it stops being a banner.
  // On the setup screen, where nothing is ready, it still very much is one.
  const showFailure = run?.status === 'failed' && status.readiness !== 'ready';

  useEffect(() => {
    if (!running) return;

    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch('/api/setup', { cache: 'no-store' });
        const next = (await response.json()) as AppStatus;
        if (cancelled) return;
        setRun(next.run);
        // The page was rendered against an empty database, so the only way to
        // show the slate and the charts is to fetch it again from the server.
        if (next.run?.status === 'done' && next.readiness === 'ready') {
          window.location.reload();
        }
      } catch {
        // A dropped poll is not a failed import. The next tick will say.
      }
    };

    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running]);

  if (compact && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-paper"
      >
        Import a newer Letterboxd export
      </button>
    );
  }

  return (
    <div className={compact ? '' : 'rounded-lg border border-edge bg-panel p-6'}>
      {compact ? (
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Import an export</p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-muted hover:text-paper"
          >
            close
          </button>
        </div>
      ) : (
        <>
          <h2 className="text-lg font-semibold">Import your Letterboxd export</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
            Ask Letterboxd for your data at{' '}
            <a
              href="https://letterboxd.com/settings/data/"
              target="_blank"
              rel="noreferrer"
              className="text-paper underline hover:text-accent"
            >
              letterboxd.com/settings/data
            </a>
            . It emails you a zip. Drop that in below and this builds everything from it: your
            coverage across decades, countries, directors and movements, then a pool of films you
            have not seen, then five of them a day chosen to fill the widest gaps.
          </p>
        </>
      )}

      {status.lastImport ? (
        <p className={`${compact ? '' : 'mt-3'} text-xs text-muted`}>
          Currently loaded:{' '}
          <span className="text-paper">{status.lastImport.username ?? 'unknown profile'}</span>,{' '}
          {status.watched.toLocaleString()} films, imported{' '}
          {status.lastImport.importedAt.slice(0, 10)}. Importing again replaces it.
        </p>
      ) : null}

      {run && (running || showFailure) ? (
        <div className="mt-4 rounded border border-edge bg-ink/40 p-4">
          <Progress run={run} />
          {showFailure ? (
            <div className="mt-4 border-t border-edge pt-3">
              <p className="text-sm text-under">{run.error ?? 'The import failed.'}</p>
              <p className="mt-1 text-xs text-muted">
                Nothing is half-written: the steps that finished are kept and re-running picks up
                from the export again. If it keeps failing, <code>npm run import</code> then{' '}
                <code>npm run enrich</code> in a terminal will say more.
              </p>
            </div>
          ) : (
            <p className="mt-4 border-t border-edge pt-3 text-xs text-muted">
              This takes a few minutes, mostly on the TMDB step. You can close the tab — it keeps
              running, and this page picks it back up.
            </p>
          )}
        </div>
      ) : null}

      {!running ? (
        <form
          ref={formRef}
          action={async (formData) => {
            setBusy(true);
            setError(null);
            const result = await importExportFile(formData);
            setBusy(false);
            if (result.ok) {
              // Poll immediately rather than waiting for the first interval, so
              // the checklist appears the moment the upload lands.
              const response = await fetch('/api/setup', { cache: 'no-store' });
              setRun(((await response.json()) as AppStatus).run);
              formRef.current?.reset();
              setFilename(null);
            } else {
              setError(result.error);
            }
          }}
          className="mt-4 flex flex-wrap items-center gap-3"
        >
          <label className="cursor-pointer rounded border border-edge bg-panel px-3 py-2 text-sm text-muted hover:border-accent hover:text-paper">
            <input
              type="file"
              name="export"
              accept=".zip,application/zip"
              required
              className="sr-only"
              onChange={(event) => setFilename(event.target.files?.[0]?.name ?? null)}
            />
            {filename ?? 'Choose your export zip'}
          </label>
          <button
            type="submit"
            disabled={busy || !filename}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Uploading…' : 'Import'}
          </button>
          {!compact ? (
            <span className="text-xs text-muted">
              Nothing leaves this machine except TMDB lookups.
            </span>
          ) : null}
        </form>
      ) : null}

      {error ? <p className="mt-3 text-xs text-under">{error}</p> : null}
    </div>
  );
}
