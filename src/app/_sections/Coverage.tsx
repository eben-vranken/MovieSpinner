import { Panel, TableView } from '../_charts/Chart';
import { BarRows, Columns, Diverging, Matrix } from '../_charts/plots';
import { WorldMap } from '../_charts/WorldMap';
import type { Analytics } from '../../lib/analytics';

/**
 * Where the gaps are.
 *
 * Six panels that all answer the same question along different axes: decade,
 * skew against the pool, country, region by era, the regions the brief names,
 * and movements. The map is the one that can be opened -- every other panel
 * here counts, and clicking a country is how you get from a count to the films
 * behind it.
 */

const DECADE_HINT =
  'Every watched film by decade, on the Letterboxd year. The pool column is what is available to fix a thin one.';

export function Coverage({ data }: { data: Analytics }) {
  const wall = data.decades.filter((row) => row.key === 'pre-1950' || row.key === '1950s');
  const preWar = wall[0]?.watched ?? 0;
  const preSixty = preWar + (wall[1]?.watched ?? 0);
  const emptyMovements = data.movements.filter((row) => row.watched === 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="World"
        hint="Every country by films watched, on a log scale so the United States does not flatten everything else into one shade. Click a country to see the films behind its shade — what you have seen from there, and what the pool still holds."
        wide
      >
        <WorldMap countries={data.countries} />
        <TableView
          columns={['Country', 'Watched', 'In pool']}
          rows={data.countries.map((row) => [row.name, row.count, row.pool])}
          label={`all ${data.countries.length} countries`}
        />
      </Panel>

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
          rows={data.decadeSkew.map((row) => [row.key, row.watched, row.pool, row.skew.toFixed(1)])}
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
        hint={`A zero here is the most informative cell on the page: ${emptyMovements.length} of ${data.totals.movementsTotal} movements are untouched. The trailing number is how many films the pool holds for it, which is what proves the engine has something to draw when it aims there.`}
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
  );
}
