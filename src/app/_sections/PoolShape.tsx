import { Panel, TableView } from '../_charts/Chart';
import { BarRows, Columns, StackedBar, VIZ } from '../_charts/plots';
import type { Analytics } from '../../lib/analytics';

/**
 * What the engine has to work with.
 *
 * Five panels about the pool itself rather than about you: where it came from,
 * whether you can reach it, how obscure it is, how much the sources agree, and
 * what the shaper threw out. The browse tab is the same set of films with the
 * charts taken off.
 */
export function PoolShape({ data }: { data: Analytics }) {
  const { totals } = data;

  return (
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
          {data.issues.capOverrides} directors rescued past the cap · {data.issues.excluded} films
          excluded by hand · {data.issues.ingest} ingest issues.
        </p>
      </Panel>
    </div>
  );
}
