import { ImportPanel } from './ImportPanel';
import type { AppStatus } from '../../lib/status';

/**
 * What a fresh install sees instead of the dashboard.
 *
 * Three things can be missing and they block each other in order: TMDB
 * credentials, an export, and the derived tables built from the two. Showing
 * all three at once as a checklist is better than showing one error at a time,
 * because the first question anybody has is "how much is left".
 */

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
          done ? 'bg-accent text-ink' : 'border border-edge text-muted'
        }`}
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className={`text-sm font-medium ${done ? 'text-muted' : 'text-paper'}`}>{title}</h2>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}

export function Setup({ status }: { status: AppStatus }) {
  const hasData = status.watched > 0;

  return (
    <div className="mx-auto max-w-2xl py-6">
      <h1 className="text-2xl font-semibold">Set this up</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        MovieSpinner reads your Letterboxd history, works out where your film education is
        thinnest, and offers five films a day aimed at those gaps. It needs your data and a TMDB
        key to do any of that. Both stay on this machine.
      </p>

      <ol className="mt-8 space-y-8">
        <Step n={1} title="Give it a TMDB key" done={status.configured}>
          {status.configured ? (
            <p className="text-xs text-muted">
              Configured. Region <span className="text-paper">{status.region}</span>, which is what
              the &ldquo;where can I watch this&rdquo; line on each card uses.
            </p>
          ) : (
            <div className="text-xs leading-relaxed text-muted">
              <p>
                Free, and takes a minute. Sign in at{' '}
                <a
                  href="https://www.themoviedb.org/settings/api"
                  target="_blank"
                  rel="noreferrer"
                  className="text-paper underline hover:text-accent"
                >
                  themoviedb.org/settings/api
                </a>{' '}
                and copy the <em>API Read Access Token</em>. Then, in the project folder:
              </p>
              <pre className="mt-2 overflow-x-auto rounded border border-edge bg-ink/60 p-3 text-[11px] text-paper">
                {`cp .env.example .env

# then edit .env:
TMDB_READ_TOKEN=eyJhbGciOi...
TMDB_REGION=BE          # your country, for streaming availability`}
              </pre>
              <p className="mt-2">
                Restart <code>npm run dev</code> afterwards, and this step ticks.
              </p>
            </div>
          )}
        </Step>

        <Step n={2} title="Import your Letterboxd export" done={hasData}>
          {status.configured ? (
            <ImportPanel status={status} />
          ) : (
            <p className="text-xs text-muted">
              Waiting on the TMDB key above — matching your films is the second thing the import
              does, so there is no point starting without it.
            </p>
          )}
        </Step>

        <Step
          n={3}
          title="Let it build your coverage and candidate pool"
          done={status.readiness === 'ready'}
        >
          <p className="text-xs leading-relaxed text-muted">
            {status.readiness === 'ready'
              ? `Done. ${status.poolSize.toLocaleString()} candidate films.`
              : hasData
                ? 'Runs automatically after the import. A few minutes, mostly TMDB lookups: every film you have seen, then the canon, Criterion, regional and auteur lists that make up the pool.'
                : 'Runs automatically after the import, and takes a few minutes.'}
          </p>
        </Step>
      </ol>

      {/* Someone who imported before this screen existed, or whose run failed
          partway, has data but no pool. The CLI is the honest answer there:
          it says exactly which step is unhappy and why. */}
      {hasData && status.readiness !== 'ready' && status.run?.status !== 'running' ? (
        <div className="mt-10 rounded border border-edge bg-panel p-4">
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Finish it by hand</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Your history is loaded ({status.watched.toLocaleString()} films
            {status.matched > 0 ? `, ${status.matched.toLocaleString()} matched` : ''}) but the
            derived tables are not built. Re-importing above runs everything again, or:
          </p>
          <pre className="mt-2 overflow-x-auto rounded border border-edge bg-ink/60 p-3 text-[11px] text-paper">
            {status.matched === 0
              ? 'npm run enrich && npm run coverage && npm run pool'
              : 'npm run coverage && npm run pool'}
          </pre>
        </div>
      ) : null}

      <p className="mt-10 text-xs leading-relaxed text-muted">
        Everything is a local SQLite file in <code>data/</code>. There are no accounts and no
        server: the only outbound calls are to TMDB, for film metadata. Delete{' '}
        <code>data/moviespinner.db</code> to start over.
      </p>
    </div>
  );
}
