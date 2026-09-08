import { Legend, Panel, StatTile, TableView } from './_charts/Chart';
import { BarRows, Columns, Diverging, Matrix, StackedBar, TimeArea, VIZ } from './_charts/plots';
import { WorldMap } from './_charts/WorldMap';
import { LineagePanel } from './_lineage/LineagePanel';
import { Setup } from './_setup/Setup';
import { ImportPanel } from './_setup/ImportPanel';
import { DangerZone } from './_setup/DangerZone';
import { Slate } from './_slate/Slate';
import { loadAnalytics } from '../lib/analytics';
import { ensureSlate } from '../lib/slate';
import type { SlateView } from '../lib/slate';
import { appStatus } from '../lib/status';

export const dynamic = 'force-dynamic';

/**
 * The whole application.
 *
 * One route, two jobs. The top is the decision: five films drawn against your
 * gaps, one click, final for the day. Everything below it is the evidence --
 * what you have actually watched, what the pool can offer, and where the two
 * disagree -- because the point of the choice at the top is that it is informed
 * rather than random, and you cannot see that from a poster.
 *
 * Read on the server, drawn on the server. No charting library, and the only
 * client components are the three things that genuinely need to be interactive:
 * the pool search, the lineage film picker, and the import progress. Everything
 * else here is a rectangle, a path, or a table.
 *
 * On an install that has not been set up, this renders the setup screen
 * instead. That is not a nicety -- `ensureSlate`, `loadAnalytics` and
 * `tmdbConfig` all throw on an empty database, correctly, and the first thing a
 * new user needs is the page that says what to do rather than a stack trace.
 */

const DECADE_HINT =
  'Every watched film by decade, on the Letterboxd year. The pool column is what is available to fix a thin one.';

export default async function Page() {
  // Cheap, and it never throws. Everything below it assumes a full database.
  const status = appStatus();
  if (status.readiness !== 'ready') return <Setup status={status} />;

  const data = loadAnalytics();

  let slate: SlateView | null = null;
  let slateError: string | null = null;
  try {
    slate = ensureSlate();
  } catch (error) {
    slateError = error instanceof Error ? error.message : 'Could not produce a slate.';
  }

  const { totals } = data;
  const wall = data.decades.filter((row) => row.key === 'pre-1950' || row.key === '1950s');
  const preWar = wall[0]?.watched ?? 0;
  const preSixty = preWar + (wall[1]?.watched ?? 0);
  const emptyMovements = data.movements.filter((row) => row.watched === 0);
  const deepest = data.directorDepth.at(-1);
  const seenOnce = data.directorDepth.find((row) => row.films === 1)?.directors ?? 0;
  const streamable = data.availability[0]?.films ?? 0;

  return (
    <div className="space-y-12">
      {slate ? (
        <Slate slate={slate} />
      ) : (
        <p className="rounded border border-edge bg-panel p-5 text-sm text-muted">{slateError}</p>
      )}

      {/* ---- the headline row ------------------------------------------- */}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.2em] text-muted uppercase">Films watched</p>
            {/* The hero figure. Exactly one per view, same sans as everything
                else, proportional figures. */}
            <p className="mt-1 text-5xl leading-none font-semibold">
              {totals.watched.toLocaleString()}
            </p>
          </div>
          <p className="max-w-md text-xs leading-relaxed text-muted">
            {totals.mapped} of them carry TMDB metadata, which is the set every panel below
            except the decade chart can actually count. {totals.countries} countries,{' '}
            {totals.directors} directors, {totals.movementsTouched} of {totals.movementsTotal}{' '}
            movements touched.
          </p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="Candidate pool"
            value={totals.poolSize}
            note={`unseen, ${totals.watchlist} of them on your watchlist`}
          />
          <StatTile
            label="Watchable tonight"
            value={streamable}
            note={`on a subscription in ${totals.region}`}
          />
          <StatTile
            label="Movements untouched"
            value={emptyMovements.length}
            note={`of ${totals.movementsTotal}`}
          />
          <StatTile
            label="Directors seen once"
            value={seenOnce}
            note={`of ${totals.directors} — depth, not breadth`}
          />
          <StatTile
            label="Days played"
            value={totals.daysPlayed}
            note={`${totals.filmsOffered} films offered, ${totals.chosen} chosen`}
          />
          <StatTile
            label="Streak"
            value={slate?.streak ?? 0}
            note={`${totals.watchedFromSlate} watched from a slate`}
          />
        </div>
      </section>

      {/* ---- coverage ---------------------------------------------------- */}
      <section>
        <h2 className="mb-4 text-xs tracking-[0.2em] text-muted uppercase">Coverage</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="By decade"
            hint={`${DECADE_HINT} The wall: ${preWar} films before 1950, ${preSixty} before 1960.`}
          >
            <Columns
              rows={data.decades.map((row) => ({
                key: row.key,
                label: row.key.replace('pre-', '<'),
                value: row.watched,
                highlight: row.key === 'pre-1950',
              }))}
              unit="films"
            />
            <TableView
              columns={['Decade', 'Watched', 'At first snapshot', 'In pool']}
              rows={data.decades.map((row) => [row.key, row.watched, row.then, row.pool])}
            />
          </Panel>

          <Panel
            title="Decade skew"
            hint="Share of what you have watched minus share of what the pool holds, in points. This is the chart that says where the engine should be aiming, and it is not the same answer as the raw counts next door."
          >
            <Diverging
              rows={data.decadeSkew.map((row) => ({
                key: row.key,
                label: row.key.replace('pre-', 'before '),
                value: row.skew,
                note: `${row.watched} / ${row.pool}`,
              }))}
              positive="Over-watched"
              negative="Blind spot"
            />
            <TableView
              columns={['Decade', 'Watched', 'In pool', 'Skew (pts)']}
              rows={data.decadeSkew.map((row) => [
                row.key,
                row.watched,
                row.pool,
                row.skew.toFixed(1),
              ])}
            />
          </Panel>

          <Panel
            title="World"
            hint="Every country by films watched, on a log scale so the United States does not flatten everything else into one shade."
            wide
          >
            <WorldMap countries={data.countries} />
            <TableView
              columns={['Country', 'Films']}
              rows={data.countries.map((row) => [row.name, row.count])}
              label={`all ${data.countries.length} countries`}
            />
          </Panel>

          <Panel
            title="Region by decade"
            hint="The densest panel here, and usually the most useful. A blind spot is rarely a whole region — it is a region in a particular era, and only this view can show that."
            wide
          >
            <Matrix
              columns={data.decades.map((row) => row.key)}
              rows={data.regionByDecade.map((row) => ({
                label: row.region,
                cells: row.cells.map((cell) => ({ key: cell.decade, value: cell.value })),
              }))}
              unit="films"
            />
          </Panel>

          <Panel
            title="Regions the brief names"
            hint="Measured in countries reached rather than percent of pool cleared. A pool percentage resets the moment the pool grows; a country you have finally seen something from stays seen."
          >
            <BarRows
              rows={data.regions.map((row) => ({
                key: row.label,
                label: row.label,
                value: row.watched,
                note: `${row.countriesSeen}/${row.countriesAvailable}`,
                highlight: row.watched === 0,
              }))}
              unit="films watched"
            />
            <p className="mt-3 text-xs text-muted">
              Trailing column is countries seen of countries the pool can offer.
            </p>
            <TableView
              columns={['Region', 'Watched', 'In pool', 'Countries seen', 'Countries available']}
              rows={data.regions.map((row) => [
                row.label,
                row.watched,
                row.pool,
                row.countriesSeen,
                row.countriesAvailable,
              ])}
            />
          </Panel>

          <Panel
            title="Movements"
            hint={`A zero here is the most informative cell on the page: ${emptyMovements.length} of ${totals.movementsTotal} movements are untouched. The trailing number is how many films the pool holds for it, which is what proves the engine has something to draw when it aims there.`}
          >
            <div className="max-h-96 overflow-y-auto pr-2">
              <BarRows
                rows={data.movements.map((row) => ({
                  key: row.slug,
                  label: row.name,
                  value: row.watched,
                  note: String(row.pool),
                  highlight: row.watched === 0,
                }))}
                unit="films watched"
              />
            </div>
            <TableView
              columns={['Movement', 'Period', 'Watched', 'In pool']}
              rows={data.movements.map((row) => [row.name, row.period, row.watched, row.pool])}
            />
          </Panel>
        </div>
      </section>

      {/* ---- taste ------------------------------------------------------- */}
      <section>
        <h2 className="mb-4 text-xs tracking-[0.2em] text-muted uppercase">Habit and taste</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Films logged per month"
            hint={`${totals.logged} diary entries, on the night watched rather than the night typed in. Only the peak and the latest month are labelled; the rest are on hover and in the table.`}
            wide
          >
            <TimeArea
              points={data.cadence.map((row) => ({ label: row.month, value: row.films }))}
              unit="films"
            />
            <TableView
              columns={['Month', 'Films']}
              rows={data.cadence.map((row) => [row.month, row.films])}
              label={`all ${data.cadence.length} months`}
            />
          </Panel>

          <Panel
            title="Ratings"
            hint={`${totals.rated} of ${totals.watched} watched films carry a rating. This distribution is the whole input to the Sunday junk valve — there is no model behind it.`}
          >
            <Columns
              rows={data.ratings.map((row) => ({
                key: String(row.rating),
                label: String(row.rating),
                value: row.count,
              }))}
              unit="films"
            />
            <TableView
              columns={['Rating', 'Films']}
              rows={data.ratings.map((row) => [row.rating, row.count])}
            />
          </Panel>

          <Panel
            title="Director depth"
            hint={`${seenOnce} of ${totals.directors} directors seen exactly once (${Math.round((seenOnce / Math.max(1, totals.directors)) * 100)}%). That share falling is the sign depth is building rather than breadth.${deepest ? ` The deepest is ${deepest.films} films.` : ''}`}
          >
            <Columns
              rows={data.directorDepth.map((row) => ({
                key: String(row.films),
                label: String(row.films),
                value: row.directors,
              }))}
              unit="directors"
              labelEvery={data.directorDepth.length > 14 ? 2 : 1}
            />
            <p className="mt-2 text-xs text-muted">Films by one director, along the bottom.</p>
            <TableView
              columns={['Films by one director', 'Directors']}
              rows={data.directorDepth.map((row) => [row.films, row.directors])}
            />
          </Panel>

          <Panel title="Most watched directors" hint="The top of the depth chart, by name.">
            <BarRows
              rows={data.topDirectors.map((row) => ({
                key: row.name,
                label: row.name,
                value: row.count,
              }))}
              unit="films"
            />
          </Panel>

          <Panel
            title="Runtime"
            hint="What you watch against what the pool holds, as two small multiples rather than one chart with two scales. The pool skews short because the silent and avant-garde movements are full of films under 45 minutes."
          >
            <Legend
              series={[
                { label: 'Watched', color: VIZ[0]! },
                { label: 'In pool', color: VIZ[1]! },
              ]}
            />
            <Columns
              rows={data.runtime.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.watched,
              }))}
              color={VIZ[0]}
              height={110}
              unit="watched"
            />
            <div className="mt-3">
              <Columns
                rows={data.runtime.map((row) => ({
                  key: row.key,
                  label: row.label,
                  value: row.pool,
                }))}
                color={VIZ[1]}
                height={110}
                unit="in pool"
              />
            </div>
            <TableView
              columns={['Runtime', 'Watched', 'In pool']}
              rows={data.runtime.map((row) => [row.label, row.watched, row.pool])}
            />
          </Panel>

          <Panel
            title="Genre skew"
            hint="Share of your watching minus share of the pool. Positive is a genre you reach for; negative is one the pool is full of and you are not taking."
          >
            <Diverging
              rows={data.genres.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.skew,
                note: `${row.watched} / ${row.pool}`,
              }))}
              positive="You reach for it"
              negative="Pool has more"
            />
            <TableView
              columns={['Genre', 'Watched', 'In pool', 'Skew (pts)']}
              rows={data.genres.map((row) => [
                row.label,
                row.watched,
                row.pool,
                row.skew.toFixed(1),
              ])}
            />
          </Panel>

          <Panel
            title="Language skew"
            hint="The same measure on original language. English being deeply negative is the project working: the pool is deliberately not in English."
          >
            <Diverging
              rows={data.languages.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.skew,
                note: `${row.watched} / ${row.pool}`,
              }))}
              positive="You watch more"
              negative="Pool has more"
            />
            <TableView
              columns={['Language', 'Watched', 'In pool', 'Skew (pts)']}
              rows={data.languages.map((row) => [
                row.label,
                row.watched,
                row.pool,
                row.skew.toFixed(1),
              ])}
            />
          </Panel>
        </div>
      </section>

      {/* ---- the pool ---------------------------------------------------- */}
      <section>
        <h2 className="mb-4 text-xs tracking-[0.2em] text-muted uppercase">The pool</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Where the pool comes from"
            hint="Films can appear on several lists, so these sum to more than the pool. Which list a film is on is also what sets its stature in the draw — a TSPDT entry outweighs a bare auteur filmography entry."
          >
            <StackedBar
              segments={data.poolSources.map((row, index) => ({
                key: row.key,
                label: row.label,
                value: row.value,
                color: VIZ[index % VIZ.length]!,
              }))}
            />
          </Panel>

          <Panel
            title="Can you actually watch it?"
            hint={`Every pool film against the services tracked in ${totals.region}. The bottom segment is the honest one: a film you cannot reach is a film you will pass over however well it scores.`}
          >
            <StackedBar
              segments={[
                {
                  key: 'flatrate',
                  label: data.availability[0]!.label,
                  value: data.availability[0]!.films,
                  color: VIZ[2]!,
                },
                {
                  key: 'rent',
                  label: data.availability[1]!.label,
                  value: data.availability[1]!.films,
                  color: VIZ[3]!,
                },
                {
                  key: 'none',
                  label: data.availability[2]!.label,
                  value: data.availability[2]!.films,
                  color: 'var(--color-edge)',
                },
              ]}
            />
          </Panel>

          <Panel
            title="How obscure is the pool?"
            hint="Pool films by TMDB vote count. The engine's findability curve reads exactly this: it does not exclude the thin end, it just stops a year of picks being made entirely of it."
          >
            <Columns
              rows={data.poolVotes.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.films,
              }))}
              unit="films"
            />
            <TableView
              columns={['Votes', 'Films']}
              rows={data.poolVotes.map((row) => [row.label, row.films])}
            />
          </Panel>

          <Panel
            title="Agreement across lists"
            hint="How many source lists include each pool film. The long first bar is why list overlap is a small bonus in the scoring rather than the thing that carries it — it has almost nothing to discriminate with."
          >
            <Columns
              rows={data.poolListCount.map((row) => ({
                key: String(row.lists),
                label: String(row.lists),
                value: row.films,
              }))}
              unit="films"
            />
            <p className="mt-2 text-xs text-muted">Lists agreeing on one film, along the bottom.</p>
          </Panel>

          <Panel
            title="What the shaper threw out"
            hint="Nothing is dropped silently. Every film the pool shaper removed is logged with a reason, and the rescues back in are logged too — otherwise a capped director looks identical to a director nobody listed."
            wide
          >
            <BarRows
              rows={data.poolDropped.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.value,
              }))}
              color="var(--color-viz-2)"
              unit="films dropped"
            />
            <p className="mt-3 text-xs text-muted">
              {data.issues.unresolved} pool entries never resolved to a TMDB id ·{' '}
              {data.issues.capOverrides} directors rescued past the cap ·{' '}
              {data.issues.excluded} films excluded by hand · {data.issues.ingest} ingest issues.
            </p>
          </Panel>
        </div>
      </section>

      {/* ---- the log ----------------------------------------------------- */}
      <section>
        <h2 className="mb-4 text-xs tracking-[0.2em] text-muted uppercase">The log</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Every slate so far"
            hint={`What you were offered and what you took. The four you passed on each day are kept on purpose — a film the engine offers over and over that you never take is the most interesting thing this table records. A ★ marks a film you locked in yourself${totals.lockedIn > 0 ? `; ${totals.lockedIn} so far` : ', which has not happened yet'}.`}
            wide
          >
            {data.slateLog.length === 0 ? (
              <p className="text-xs text-muted">No slates yet. Today is the first.</p>
            ) : (
              <ul className="max-h-96 space-y-3 overflow-y-auto pr-2">
                {data.slateLog.map((day) => (
                  <li key={day.date} className="border-b border-edge/50 pb-3 last:border-0">
                    <p className="flex items-baseline gap-3 text-xs">
                      <span className="tabular-nums text-muted">{day.date}</span>
                      {day.kind === 'junk-valve' ? (
                        <span className="text-muted">junk valve</span>
                      ) : null}
                      <span
                        className={day.status === 'watched' ? 'text-accent' : 'text-muted'}
                      >
                        {day.status ?? 'nothing chosen'}
                      </span>
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {day.films.map((film) => (
                        <li
                          key={film.tmdbId}
                          className={film.chosen ? 'text-paper' : 'text-muted line-through'}
                        >
                          {film.title} <span className="opacity-70">({film.year ?? '?'})</span>
                          {film.manual ? (
                            <span className="ml-1 text-accent" title="locked in by hand">
                              ★
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Offered and passed over"
            hint="Films that have come up more than once and never been chosen. Worth a look: either the engine is wrong about them or you are."
          >
            {data.passedOver.length === 0 ? (
              <p className="text-xs text-muted">
                Nothing has come up twice yet. This fills in as the log grows.
              </p>
            ) : (
              <BarRows
                rows={data.passedOver.map((row) => ({
                  key: String(row.tmdbId),
                  label: `${row.title} (${row.year ?? '?'})`,
                  value: row.times,
                }))}
                color="var(--color-viz-5)"
                unit="times offered"
              />
            )}
          </Panel>

          <Panel
            title="Coverage over time"
            hint="Snapshots of the watched total, taken by `npm run coverage -- --snapshot`. §7 wants change rather than position, and that only works if snapshotting starts long before it has anything to show."
          >
            {data.snapshots.length > 1 ? (
              <TimeArea
                points={data.snapshots.map((row) => ({
                  label: row.takenOn,
                  value: row.watched,
                }))}
                unit="films"
              />
            ) : (
              <p className="text-xs text-muted">
                {data.snapshots.length} snapshot on file
                {data.snapshots[0] ? `, taken ${data.snapshots[0].takenOn}` : ''}. Two are needed
                before there is a line to draw. Run{' '}
                <code>npm run coverage -- --snapshot</code> monthly.
              </p>
            )}
          </Panel>

          <Panel
            title="Lineage"
            hint="The only panel you write to. Every other number here is derived; an edge is a claim only a person can make."
            wide
          >
            <LineagePanel lineage={data.lineage} />
          </Panel>
        </div>
      </section>

      {/* Re-importing is a maintenance job, not a daily one, so it lives at the
          bottom folded shut. Letterboxd exports are a manual request and most
          people will do this every few months at most. */}
      <footer className="border-t border-edge pt-6">
        <ImportPanel status={status} compact />
        <p className="mt-3 text-xs text-muted">
          {status.lastImport?.username ? `${status.lastImport.username} · ` : ''}
          {status.watched.toLocaleString()} films from an export imported{' '}
          {status.lastImport?.importedAt.slice(0, 10) ?? 'at some point'}. The daily sync reads the
          RSS feed; a full export refresh is the only way to update the coverage numbers.
        </p>
        {/* Last thing on the page, and the only one that deletes something an
            export cannot rebuild. */}
        <div className="mt-8">
          <DangerZone watched={status.watched} />
        </div>
      </footer>
    </div>
  );
}
