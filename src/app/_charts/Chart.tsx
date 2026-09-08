import type { ReactNode } from 'react';

/**
 * The furniture every panel on the page shares.
 *
 * Three rules are enforced here rather than remembered in eighteen places:
 * a panel always has a title and a sentence saying what it is for, a chart with
 * two or more series always shows a legend, and every chart carries a table
 * twin behind a disclosure so no value is reachable only by hovering a mark.
 *
 * All of it renders on the server. There is no charting library and no client
 * bundle: these are bars and paths, and the hover layer is an SVG `<title>`,
 * which the browser turns into a real tooltip for free.
 */

export function Panel({
  title,
  hint,
  wide = false,
  children,
}: {
  title: string;
  hint?: string;
  /** Spans both columns on a wide screen. For maps, matrices and long lists. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-edge bg-panel p-5 ${wide ? 'lg:col-span-2' : ''}`}
    >
      <h3 className="text-xs tracking-[0.18em] text-muted uppercase">{title}</h3>
      {hint ? <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export interface SeriesKey {
  label: string;
  color: string;
}

/** Identity never rests on colour alone, so two or more series always get this. */
export function Legend({ series }: { series: SeriesKey[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
      {series.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-xs text-muted">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: entry.color }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The table twin. Collapsed by default so it does not compete with the chart,
 * but present on every panel, which is what keeps a colour-encoded value from
 * being the only way to read a number.
 */
export function TableView({
  columns,
  rows,
  label = 'the numbers',
}: {
  columns: string[];
  rows: (string | number)[][];
  label?: string;
}) {
  return (
    <details className="group mt-4">
      <summary className="cursor-pointer list-none text-xs text-muted hover:text-paper">
        <span className="group-open:hidden">Show {label}</span>
        <span className="hidden group-open:inline">Hide {label}</span>
      </summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-left text-muted">
              {columns.map((column, index) => (
                <th
                  key={column}
                  className={`py-1 pr-3 font-normal ${index === 0 ? '' : 'text-right'}`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-edge/50">
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className={`py-1 pr-3 ${index === 0 ? '' : 'text-right tabular-nums'}`}
                  >
                    {typeof cell === 'number' ? cell.toLocaleString() : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Compact form for a stat tile: 1,284 stays itself, 12,900 becomes 12.9K. */
export const compact = (value: number): string =>
  value >= 10000 ? `${(value / 1000).toFixed(1)}K` : value.toLocaleString();

export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-edge bg-panel px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      {/* Proportional figures on purpose: tabular-nums makes a three-digit
          number look loose at this size. */}
      <p className="mt-1 text-2xl leading-none font-semibold">
        {typeof value === 'number' ? compact(value) : value}
      </p>
      {note ? <p className="mt-1.5 text-xs text-muted">{note}</p> : null}
    </div>
  );
}
