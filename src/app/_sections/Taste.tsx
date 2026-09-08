import { Legend, Panel, TableView } from '../_charts/Chart';
import { BarRows, Columns, Diverging, TimeArea, VIZ } from '../_charts/plots';
import type { Analytics } from '../../lib/analytics';

/**
 * What you actually do, as opposed to what you are missing.
 *
 * Cadence, ratings, depth by director, runtime and the two skews. The skews are
 * the ones that matter to the engine: they are the only panels that measure
 * your watching against what the pool could have given you instead.
 */
export function Taste({ data }: { data: Analytics }) {
  const { totals } = data;
  const deepest = data.directorDepth.at(-1);
  const seenOnce = data.directorDepth.find((row) => row.films === 1)?.directors ?? 0;

  return (
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
          rows={data.genres.map((row) => [row.label, row.watched, row.pool, row.skew.toFixed(1)])}
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
  );
}
