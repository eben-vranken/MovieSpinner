import { Browse } from './_browse/Browse';
import type { Facets } from './_browse/Browse';
import { CampaignPanel } from './_campaign/CampaignPanel';
import { Coverage } from './_sections/Coverage';
import { Log } from './_sections/Log';
import { Overview } from './_sections/Overview';
import { PoolShape } from './_sections/PoolShape';
import { Taste } from './_sections/Taste';
import { Dashboard } from './_shell/Dashboard';
import type { TabSpec } from './_shell/Dashboard';
import { LineagePanel } from './_lineage/LineagePanel';
import { Setup } from './_setup/Setup';
import { ImportPanel } from './_setup/ImportPanel';
import { DangerZone } from './_setup/DangerZone';
import { Slate } from './_slate/Slate';
import { loadAnalytics } from '../lib/analytics';
import { completeIfFinished, loadCampaign } from '../lib/campaign';
import { ensureSlate } from '../lib/slate';
import type { SlateView } from '../lib/slate';
import { appStatus } from '../lib/status';

export const dynamic = 'force-dynamic';

/**
 * The whole application.
 *
 * One route, two jobs. The top is the decision: five films drawn against your
 * gaps, one click, final for the day. Everything behind the sidebar is the
 * evidence -- what you have actually watched, what the pool can offer, and
 * where the two disagree -- because the point of the choice is that it is
 * informed rather than random, and you cannot see that from a poster.
 *
 * The sidebar is not navigation. There is still one route and one read of the
 * database: every section below is rendered on the server in this pass and
 * handed to the shell, which shows one at a time. What it buys is that the
 * evidence stopped being a nineteen-panel scroll where you found the region
 * matrix by remembering how far down it was.
 *
 * Read on the server, drawn on the server. The client components are the ones
 * that genuinely need to be interactive: the pool search, the lineage picker,
 * the import progress, the browse grid, and the map now that a country can be
 * opened. Everything else is a rectangle, a path, or a table.
 *
 * On an install that has not been set up, this renders the setup screen
 * instead. That is not a nicety -- `ensureSlate`, `loadAnalytics` and
 * `tmdbConfig` all throw on an empty database, correctly, and the first thing a
 * new user needs is the page that says what to do rather than a stack trace.
 */
export default async function Page() {
  // Cheap, and it never throws. Everything below it assumes a full database.
  const status = appStatus();
  if (status.readiness !== 'ready') return <Setup status={status} />;

  const data = loadAnalytics();

  // Before the slate is read, because a campaign that ran out of films should
  // be closed before it is asked for another five it does not have.
  completeIfFinished();

  let slate: SlateView | null = null;
  let slateError: string | null = null;
  try {
    slate = ensureSlate();
  } catch (error) {
    slateError = error instanceof Error ? error.message : 'Could not produce a slate.';
  }

  const { totals } = data;
  const campaign = loadCampaign();

  // The browse filters are the chart buckets, handed over as they are. Deriving
  // them from the analytics pass rather than querying for them again is what
  // keeps a filter from being able to disagree with the panel that sent you.
  const facets: Facets = {
    decades: data.decades.map((row) => row.key),
    countries: data.countries,
    genres: data.genres.map((row) => ({ key: row.key, label: row.label })),
    languages: data.languages.map((row) => ({ key: row.key, label: row.label })),
    movements: data.movements.map((row) => ({ slug: row.slug, name: row.name })),
    runtimes: data.runtime.map((row) => ({ key: row.key, label: row.label })),
    votes: data.poolVotes.map((row) => ({ key: row.key, label: row.label })),
    region: totals.region,
    poolSize: totals.poolSize,
    watchedSize: totals.mapped,
  };

  const tabs: TabSpec[] = [
    { key: 'today', label: 'Today', note: slate?.chosen ? 'chosen' : 'open' },
    { key: 'coverage', label: 'Coverage', note: `${totals.countries} countries` },
    { key: 'browse', label: 'Browse', note: `${totals.poolSize.toLocaleString()} films` },
    { key: 'taste', label: 'Habit & taste', note: `${totals.rated} rated` },
    { key: 'pool', label: 'The pool', note: `${data.poolSources.length} sources` },
    { key: 'log', label: 'The log', note: `${totals.daysPlayed} days` },
    { key: 'lineage', label: 'Lineage', note: `${data.lineage.length} edges` },
  ];

  const sections: Record<string, React.ReactNode> = {
    today: (
      <div className="space-y-10">
        {slate ? (
          <Slate slate={slate} campaign={campaign} />
        ) : (
          <p className="rounded border border-edge bg-panel p-5 text-sm text-muted">{slateError}</p>
        )}

        {/* Directly under the slate, because a running campaign is the frame
            for the day rather than a setting. Folded shut when there is none. */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <CampaignPanel
            view={campaign}
            seenOnce={data.directorDepth.find((row) => row.films === 1)?.directors ?? 0}
          />
        </section>

        <Overview data={data} streak={slate?.streak ?? 0} />
      </div>
    ),
    coverage: <Coverage data={data} />,
    browse: <Browse facets={facets} />,
    taste: <Taste data={data} />,
    pool: <PoolShape data={data} />,
    log: <Log data={data} />,
    lineage: (
      <section className="rounded-lg border border-edge bg-panel p-5">
        <h2 className="text-xs tracking-[0.2em] text-muted uppercase">Lineage</h2>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          The only panel you write to. Every other number on this page is derived; an edge is a
          claim only a person can make, and it is written back out to
          <code className="mx-1">data/lineage.csv</code> because the file is the source of truth.
        </p>
        <div className="mt-4">
          <LineagePanel lineage={data.lineage} />
        </div>
      </section>
    ),
  };

  return (
    <Dashboard
      tabs={tabs}
      sections={sections}
      footer={
        <>
          {/* Re-importing is a maintenance job, not a daily one, so it sits
              under every section rather than being one of them. Letterboxd
              exports are a manual request and most people will do this every
              few months at most. */}
          <ImportPanel status={status} compact />
          <p className="mt-3 text-xs text-muted">
            {status.lastImport?.username ? `${status.lastImport.username} · ` : ''}
            {status.watched.toLocaleString()} films from an export imported{' '}
            {status.lastImport?.importedAt.slice(0, 10) ?? 'at some point'}. The daily sync reads
            the RSS feed; a full export refresh is the only way to update the coverage numbers.
          </p>
          {/* Last thing on the page, and the only one that deletes something an
              export cannot rebuild. */}
          <div className="mt-8">
            <DangerZone watched={status.watched} />
          </div>
        </>
      }
    />
  );
}
