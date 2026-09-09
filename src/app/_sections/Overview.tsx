import { StatTile } from '../_charts/Chart';
import type { Analytics } from '../../lib/analytics';

/**
 * The figures that frame the day, directly under the slate.
 *
 * One hero number and six tiles, and nothing here is a chart. It is the summary
 * a person wants before deciding whether to go and look at the evidence: how
 * much is watched, how much is left, and whether today's choice was made.
 */
export function Overview({ data, streak }: { data: Analytics; streak: number }) {
  const { totals } = data;
  const emptyMovements = data.movements.filter((row) => row.watched === 0).length;
  const seenOnce = data.directorDepth.find((row) => row.films === 1)?.directors ?? 0;
  const streamable = data.availability[0]?.films ?? 0;

  return (
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
          {totals.mapped} of them carry TMDB metadata, which is the set every panel except the
          decade chart can actually count. {totals.countries} countries, {totals.directors}{' '}
          directors, {totals.movementsTouched} of {totals.movementsTotal} movements touched.
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
          value={emptyMovements}
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
          note={
            totals.roundsPlayed > totals.daysPlayed
              ? `${totals.roundsPlayed} rounds, ${totals.chosen} films chosen`
              : `${totals.filmsOffered} films offered, ${totals.chosen} chosen`
          }
        />
        <StatTile
          label="Streak"
          value={streak}
          note={`${totals.watchedFromSlate} watched from a slate`}
        />
      </div>
    </section>
  );
}
