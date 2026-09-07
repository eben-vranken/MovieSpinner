import { loadDashboard } from '../../lib/dashboard';
import { currentStreak } from '../../lib/pick';
import { WorldMap } from './WorldMap';

export const dynamic = 'force-dynamic';

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-14">
      <h2 className="text-xs tracking-[0.2em] text-muted uppercase">{title}</h2>
      {hint ? <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Bar = ({ value, max }: { value: number; max: number }) => (
  <span
    className="inline-block h-2 rounded-sm bg-accent"
    style={{ width: `${max === 0 ? 0 : (value / max) * 100}%` }}
  />
);

export default async function DashboardPage() {
  const data = loadDashboard();
  const streak = currentStreak();
  const maxDecade = Math.max(...data.decades.map((cell) => cell.now), 1);
  const wall = data.decades.filter((cell) => cell.key === 'pre-1950' || cell.key === '1950s');
  const movementsTouched = data.movements.filter((row) => row.now > 0).length;

  return (
    <>
      <h1 className="text-2xl font-semibold">Coverage</h1>
      <p className="mt-2 max-w-prose text-sm text-muted">
        {data.totalWatched} films watched, {data.mapped} of them with metadata.{' '}
        {movementsTouched} of {data.movements.length} movements touched.{' '}
        {data.countries.length} countries.
      </p>

      {/* The hero. §7 wants the pre-1954 wall visible and shrinking. */}
      <Section
        title="Decade"
        hint={`The wall: ${wall[0]?.now ?? 0} films before 1950, ${(wall[0]?.now ?? 0) + (wall[1]?.now ?? 0)} before 1960. The pool column is what is available to fix it.`}
      >
        <table className="w-full text-sm">
          <tbody>
            {data.decades.map((cell) => {
              const gained = cell.now - cell.then;
              return (
                <tr key={cell.key} className="border-b border-edge/60">
                  <td className="w-24 py-2 text-muted">{cell.key}</td>
                  <td className="w-14 py-2 text-right tabular-nums">{cell.now}</td>
                  <td className="w-16 py-2 text-right text-xs tabular-nums text-accent">
                    {gained > 0 ? `+${gained}` : ''}
                  </td>
                  <td className="py-2 pl-4">
                    <Bar value={cell.now} max={maxDecade} />
                  </td>
                  <td className="w-24 py-2 text-right text-xs tabular-nums text-muted">
                    {cell.inPool} in pool
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="World" hint="Every country by films watched, on a log scale.">
        <WorldMap countries={data.countries} />
      </Section>

      <Section
        title="Progress"
        hint="Measured against movements and regions rather than percent of pool cleared. A pool percentage resets the moment the pool grows; these close and stay closed."
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted uppercase">
              <th className="py-2 font-normal">Region</th>
              <th className="py-2 text-right font-normal">Watched</th>
              <th className="py-2 text-right font-normal">Countries</th>
              <th className="py-2 text-right font-normal">In pool</th>
            </tr>
          </thead>
          <tbody>
            {data.regions.map((row) => (
              <tr key={row.label} className="border-t border-edge/60">
                <td className="py-2">{row.label}</td>
                <td
                  className={`py-2 text-right tabular-nums ${row.watched === 0 ? 'text-muted' : ''}`}
                >
                  {row.watched}
                </td>
                <td className="py-2 text-right text-xs tabular-nums text-muted">
                  {row.countriesSeen} of {row.countriesAvailable}
                </td>
                <td className="py-2 text-right text-xs tabular-nums text-muted">{row.inPool}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Movements"
        hint="A zero here is the most informative cell on this page. The pool column proves the engine has something to draw when it aims at one."
      >
        <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {data.movements.map((row) => (
            <li key={row.slug} className="flex items-baseline gap-3 border-b border-edge/40 py-1.5">
              <span className={`w-8 text-right tabular-nums ${row.now === 0 ? 'text-muted' : 'text-accent'}`}>
                {row.now}
              </span>
              <span className="flex-1 truncate text-sm">{row.name}</span>
              <span className="text-xs tabular-nums text-muted">{row.inPool}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Director depth"
        hint={`${data.directorsSeenOnce} of ${data.directorsTotal} directors seen exactly once (${Math.round((data.directorsSeenOnce / Math.max(1, data.directorsTotal)) * 100)}%). That share falling is the sign depth is building.`}
      >
        <div className="grid gap-8 sm:grid-cols-2">
          <table className="text-sm">
            <tbody>
              {data.directorDepth.map((row) => (
                <tr key={row.films}>
                  <td className="w-20 py-1 text-muted">
                    {row.films} film{row.films === 1 ? '' : 's'}
                  </td>
                  <td className="w-12 py-1 text-right tabular-nums">{row.directors}</td>
                  <td className="w-40 py-1 pl-3">
                    <Bar
                      value={row.directors}
                      max={Math.max(...data.directorDepth.map((entry) => entry.directors), 1)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ol className="text-sm">
            {data.topDirectors.map((row) => (
              <li key={row.name} className="flex justify-between border-b border-edge/40 py-1">
                <span className="truncate">{row.name}</span>
                <span className="tabular-nums text-muted">{row.count}</span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <Section title="Picks" hint="Kept low-key on purpose.">
        <div className="flex flex-wrap gap-x-10 gap-y-3 text-sm">
          <span>
            <span className="text-muted">Streak </span>
            <span className="tabular-nums">{streak}</span>
          </span>
          <span>
            <span className="text-muted">Watched </span>
            <span className="tabular-nums">{data.picks.watched}</span>
          </span>
          <span>
            <span className="text-muted">Skipped </span>
            <span className="tabular-nums">{data.picks.skipped}</span>
          </span>
          <span>
            <span className="text-muted">Pending </span>
            <span className="tabular-nums">{data.picks.pending}</span>
          </span>
          <span>
            <span className="text-muted">Pool </span>
            <span className="tabular-nums">{data.poolSize.toLocaleString()}</span>
          </span>
        </div>
        {data.recentSkips.length > 0 ? (
          <ul className="mt-4 text-sm text-muted">
            {data.recentSkips.map((row) => (
              <li key={row.date} className="py-0.5">
                <span className="tabular-nums">{row.date}</span> skipped {row.title} ({row.year})
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-4 text-xs text-muted">
          {data.snapshots.length} coverage snapshot{data.snapshots.length === 1 ? '' : 's'} on file
          {data.snapshots[0] ? `, first ${data.snapshots[0].takenOn}` : ''}. Run{' '}
          <code>npm run coverage -- --snapshot</code> monthly to build the trend.
        </p>
      </Section>
    </>
  );
}
