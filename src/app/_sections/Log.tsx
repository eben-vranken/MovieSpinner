import { Panel } from '../_charts/Chart';
import { BarRows, TimeArea } from '../_charts/plots';
import type { Analytics } from '../../lib/analytics';

/**
 * Everything the app has done, kept.
 *
 * The four films you did not choose each day are here on purpose: a film the
 * engine offers over and over that you never take is the most interesting thing
 * this table records, and deleting the losers would throw that away.
 */
export function Log({ data }: { data: Analytics }) {
  const { totals } = data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Every slate so far"
        hint={`What you were offered and what you took. The four you passed on each day are kept on purpose. A ★ marks a film you locked in yourself${totals.lockedIn > 0 ? `; ${totals.lockedIn} so far` : ', which has not happened yet'}.`}
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
                  {day.kind === 'junk-valve' ? <span className="text-muted">junk valve</span> : null}
                  <span className={day.status === 'watched' ? 'text-accent' : 'text-muted'}>
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
            points={data.snapshots.map((row) => ({ label: row.takenOn, value: row.watched }))}
            unit="films"
          />
        ) : (
          <p className="text-xs text-muted">
            {data.snapshots.length} snapshot on file
            {data.snapshots[0] ? `, taken ${data.snapshots[0].takenOn}` : ''}. Two are needed before
            there is a line to draw. Run <code>npm run coverage -- --snapshot</code> monthly.
          </p>
        )}
      </Panel>
    </div>
  );
}
