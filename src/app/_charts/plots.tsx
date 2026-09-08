/**
 * The chart vocabulary. Six forms, all server-rendered, no library.
 *
 * Shared specs, applied everywhere so the page reads as one system:
 *
 * - Marks are thin. Bars cap at 10px in a row list and 24px in a column chart;
 *   the leftover band is air, not a fatter bar.
 * - A mark's data-end is rounded 4px and its baseline end is square, so length
 *   is read from a flat start.
 * - Touching marks are separated by a 2px gap in the surface colour, never by a
 *   stroke drawn around them.
 * - Gridlines are solid hairlines one step off the surface. Never dashed.
 * - Labels are selective: the axis, the legend and the hover title carry the
 *   rest, and the table twin carries all of it.
 * - Text wears text tokens. A coloured mark sits beside a label; the label
 *   itself is never painted in the series colour.
 */

const BAR_GAP = 2;

/**
 * A count with its unit, singular when it should be.
 *
 * Only the first word is pluralised, so "films watched" reads "1 film watched"
 * and "times offered" reads "1 time offered". Every tooltip on the page goes
 * through here, because "1 films" in a tooltip is the kind of thing you stop
 * seeing after a week and a visitor never stops seeing.
 */
const withUnit = (value: number, unit: string): string => {
  if (!unit) return value.toLocaleString();
  if (value === 1) {
    const [head, ...rest] = unit.trim().split(' ');
    return ['1', (head ?? '').replace(/s$/, ''), ...rest].join(' ');
  }
  return `${value.toLocaleString()} ${unit.trim()}`;
};

/** Discrete sequential steps. Index 0 is "none" and deliberately recedes. */
export const GOLD_STEPS = [
  'var(--color-panel)',
  'var(--color-gold-1)',
  'var(--color-gold-2)',
  'var(--color-gold-3)',
  'var(--color-gold-4)',
  'var(--color-gold-5)',
];

export const VIZ = [
  'var(--color-viz-1)',
  'var(--color-viz-2)',
  'var(--color-viz-3)',
  'var(--color-viz-4)',
  'var(--color-viz-5)',
];

export interface Row {
  key: string;
  label: string;
  value: number;
  /** Optional second measure, shown as a muted trailing number, not a second bar. */
  note?: string;
  /** Marks the row as the interesting one: a zero, an outlier, today's pick. */
  highlight?: boolean;
}

/**
 * A horizontal bar list. The default form for named categories, because a name
 * reads left-to-right and a rotated axis label does not.
 *
 * One series, one colour. Colouring each bar by its own length would burn the
 * only free channel restating the length.
 */
export function BarRows({
  rows,
  color = 'var(--color-gold-4)',
  unit = '',
  max,
}: {
  rows: Row[];
  color?: string;
  unit?: string;
  max?: number;
}) {
  const ceiling = Math.max(1, max ?? Math.max(...rows.map((row) => row.value), 0));

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3 text-xs">
          <span
            className={`w-36 shrink-0 truncate ${row.highlight ? 'text-paper' : 'text-muted'}`}
            title={row.label}
          >
            {row.label}
          </span>
          <span className="relative h-2.5 flex-1 rounded-sm bg-edge/40">
            <span
              className="absolute inset-y-0 left-0 rounded-r-sm"
              style={{
                width: `${Math.max(row.value > 0 ? 1.5 : 0, (row.value / ceiling) * 100)}%`,
                background: row.value === 0 ? 'transparent' : color,
              }}
            >
              <title>{`${row.label}: ${withUnit(row.value, unit)}`}</title>
            </span>
          </span>
          <span
            className={`w-10 shrink-0 text-right tabular-nums ${
              row.value === 0 ? 'text-muted' : 'text-paper'
            }`}
          >
            {row.value.toLocaleString()}
          </span>
          {row.note !== undefined ? (
            <span className="w-16 shrink-0 text-right tabular-nums text-muted">{row.note}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A column chart, for categories with a natural order along an axis: decades,
 * ratings, runtime bands. Anything you would be annoyed to see alphabetised.
 */
export function Columns({
  rows,
  color = 'var(--color-gold-4)',
  height = 150,
  unit = '',
  labelEvery = 1,
}: {
  rows: Row[];
  color?: string;
  height?: number;
  unit?: string;
  /** Draw every nth tick label, for axes too dense to label fully. */
  labelEvery?: number;
}) {
  const width = 640;
  const axis = 20;
  const plot = height - axis;
  const ceiling = Math.max(1, ...rows.map((row) => row.value));
  const band = width / Math.max(1, rows.length);
  const barWidth = Math.min(24, band - BAR_GAP);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label={rows.map((row) => `${row.label} ${row.value}`).join(', ')}
    >
      {/* Two hairlines rather than a full grid. The bars carry the comparison;
          the grid is only there so the eye has a baseline and a ceiling. */}
      {[0, 0.5, 1].map((fraction) => (
        <line
          key={fraction}
          x1={0}
          x2={width}
          y1={plot - fraction * plot}
          y2={plot - fraction * plot}
          stroke="var(--color-edge)"
          strokeWidth={1}
        />
      ))}
      {rows.map((row, index) => {
        const barHeight = (row.value / ceiling) * plot;
        const x = index * band + (band - barWidth) / 2;
        return (
          <g key={row.key}>
            {/* Rounded data-end, square baseline: the rect is drawn with a
                radius and the bottom 4px squared off by a second rect. */}
            {row.value > 0 ? (
              <>
                <rect
                  x={x}
                  y={plot - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx={4}
                  fill={row.highlight ? 'var(--color-accent)' : color}
                />
                <rect
                  x={x}
                  y={plot - Math.min(barHeight, 4)}
                  width={barWidth}
                  height={Math.min(barHeight, 4)}
                  fill={row.highlight ? 'var(--color-accent)' : color}
                />
              </>
            ) : null}
            <rect
              x={index * band}
              y={0}
              width={band}
              height={plot}
              fill="transparent"
              pointerEvents="all"
            >
              <title>{`${row.label}: ${withUnit(row.value, unit)}`}</title>
            </rect>
            {index % labelEvery === 0 ? (
              <text
                x={index * band + band / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize={9}
                fill="var(--color-muted)"
              >
                {row.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Diverging bars around a zero rule.
 *
 * Only ever used for a quantity that really has a sign. Here that is always the
 * same thing: the share of what I watch minus the share of what the pool holds,
 * so right of the line means over-represented and left means a gap.
 */
export function Diverging({
  rows,
  positive = 'Over-represented',
  negative = 'Under-represented',
}: {
  rows: { key: string; label: string; value: number; note?: string }[];
  positive?: string;
  negative?: string;
}) {
  const extent = Math.max(1, ...rows.map((row) => Math.abs(row.value)));

  return (
    <div>
      <div className="mb-2 flex justify-between text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--color-under)' }}
          />
          {negative}
        </span>
        <span className="flex items-center gap-1.5">
          {positive}
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--color-over)' }}
          />
        </span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const magnitude = (Math.abs(row.value) / extent) * 50;
          const over = row.value >= 0;
          return (
            <li key={row.key} className="flex items-center gap-3 text-xs">
              <span className="w-28 shrink-0 truncate text-muted" title={row.label}>
                {row.label}
              </span>
              <span className="relative h-2.5 flex-1">
                <span className="absolute inset-y-0 left-1/2 w-px bg-edge" aria-hidden />
                <span
                  className={`absolute inset-y-0 ${over ? 'rounded-r-sm' : 'rounded-l-sm'}`}
                  style={{
                    left: over ? '50%' : `${50 - magnitude}%`,
                    width: `${magnitude}%`,
                    background: over ? 'var(--color-over)' : 'var(--color-under)',
                  }}
                >
                  <title>{`${row.label}: ${over ? '+' : ''}${row.value.toFixed(1)} points`}</title>
                </span>
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-paper">
                {over ? '+' : ''}
                {row.value.toFixed(1)}
              </span>
              {row.note !== undefined ? (
                <span className="w-20 shrink-0 text-right text-muted">{row.note}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One horizontal bar split into parts. Part-to-whole at a glance, capped at a
 * handful of segments; past that the classes blur and it should be a list.
 *
 * Segments are separated by a 2px gap in the surface colour rather than a
 * stroke, which is the same spacer the bar lists use.
 */
export function StackedBar({
  segments,
}: {
  segments: { key: string; label: string; value: number; color: string }[];
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return <p className="text-xs text-muted">Nothing to show yet.</p>;

  return (
    <div>
      <div className="flex h-6 w-full gap-[2px] overflow-hidden rounded-sm">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className="h-full first:rounded-l-sm last:rounded-r-sm"
            style={{ width: `${(segment.value / total) * 100}%`, background: segment.color }}
          >
            <title>
              {`${segment.label}: ${segment.value.toLocaleString()} (${((segment.value / total) * 100).toFixed(1)}%)`}
            </title>
          </span>
        ))}
      </div>
      <ul className="mt-3 space-y-1">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-baseline gap-2 text-xs">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: segment.color }}
            />
            <span className="flex-1 text-muted">{segment.label}</span>
            <span className="tabular-nums text-paper">{segment.value.toLocaleString()}</span>
            <span className="w-12 text-right tabular-nums text-muted">
              {((segment.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A line over time with a 10% wash beneath it.
 *
 * One series, so no legend: the panel title says what is plotted. Only the
 * endpoint and the peak are directly labelled, because a number on every month
 * would be unreadable and go unread.
 */
export function TimeArea({
  points,
  height = 140,
  color = 'var(--color-gold-4)',
  unit = '',
}: {
  points: { label: string; value: number }[];
  height?: number;
  color?: string;
  unit?: string;
}) {
  if (points.length < 2) {
    return <p className="text-xs text-muted">Not enough history yet to draw a trend.</p>;
  }

  const width = 640;
  const axis = 18;
  const plot = height - axis;
  const ceiling = Math.max(1, ...points.map((point) => point.value));
  const step = width / (points.length - 1);
  const at = (index: number, value: number): [number, number] => [
    index * step,
    plot - (value / ceiling) * plot,
  ];

  const line = points
    .map((point, index) => {
      const [x, y] = at(index, point.value);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const area = `${line} L${width},${plot} L0,${plot} Z`;

  const peakIndex = points.reduce(
    (best, point, index) => (point.value > points[best]!.value ? index : best),
    0,
  );
  const lastIndex = points.length - 1;
  // The peak and the endpoint are the two points worth naming. If they are the
  // same month, or adjacent, only one label is drawn so they cannot collide.
  const labelled = lastIndex - peakIndex > 2 ? [peakIndex, lastIndex] : [lastIndex];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label={`${points.length} periods, peak ${points[peakIndex]!.value} in ${points[peakIndex]!.label}`}
    >
      <line x1={0} x2={width} y1={plot} y2={plot} stroke="var(--color-edge)" strokeWidth={1} />
      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {points.map((point, index) => {
        const [x] = at(index, point.value);
        return (
          <rect key={point.label} x={x - step / 2} y={0} width={step} height={plot} fill="transparent">
            <title>{`${point.label}: ${withUnit(point.value, unit)}`}</title>
          </rect>
        );
      })}

      {labelled.map((index) => {
        const point = points[index]!;
        const [x, y] = at(index, point.value);
        return (
          <g key={point.label}>
            {/* 2px surface ring, so the marker stays legible over the line. */}
            <circle cx={x} cy={y} r={4} fill={color} stroke="var(--color-panel)" strokeWidth={2} />
            <text
              x={Math.min(x, width - 4)}
              y={y - 9}
              textAnchor={index === lastIndex ? 'end' : 'middle'}
              fontSize={10}
              fill="var(--color-paper)"
            >
              {point.value}
            </text>
          </g>
        );
      })}

      <text x={0} y={height - 4} fontSize={9} fill="var(--color-muted)">
        {points[0]!.label}
      </text>
      <text x={width} y={height - 4} textAnchor="end" fontSize={9} fill="var(--color-muted)">
        {points[lastIndex]!.label}
      </text>
    </svg>
  );
}

/** Which of the five sequential steps a value falls into. 0 is its own class. */
export const goldStep = (value: number, max: number): number => {
  if (value <= 0) return 0;
  // Log-spaced, because coverage counts are long-tailed: linear bins would put
  // everything except the top one or two cells in the same shade.
  const intensity = Math.log10(1 + value) / Math.log10(1 + Math.max(1, max));
  return 1 + Math.min(4, Math.floor(intensity * 5));
};

/**
 * A heatmap. Rows down the side, columns across the top, five sequential steps
 * plus an explicit "none" so an empty cell reads as empty rather than as small.
 *
 * Capped at six colour classes on purpose: past about seven, adjacent classes
 * stop being distinguishable and it should be a table instead.
 */
export function Matrix({
  columns,
  rows,
  unit = '',
}: {
  columns: string[];
  rows: { label: string; cells: { key: string; value: number }[] }[];
  unit?: string;
}) {
  const max = Math.max(1, ...rows.flatMap((row) => row.cells.map((cell) => cell.value)));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-[2px] text-xs">
        <thead>
          <tr>
            <th className="w-40" />
            {columns.map((column) => (
              <th key={column} className="pb-1 text-center font-normal text-muted">
                {column.replace('pre-', '<')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="pr-2 text-right text-muted">{row.label}</td>
              {row.cells.map((cell) => {
                const step = goldStep(cell.value, max);
                return (
                  <td
                    key={cell.key}
                    className="h-7 rounded-sm text-center tabular-nums"
                    style={{
                      background: GOLD_STEPS[step],
                      // The top two steps are light enough that ink beats paper
                      // on them; picked by the fill's luminance, not by taste.
                      color: step >= 4 ? 'var(--color-ink)' : 'var(--color-paper)',
                      opacity: cell.value === 0 ? 0.45 : 1,
                    }}
                    title={`${row.label}, ${cell.key}: ${withUnit(cell.value, unit)}`}
                  >
                    {cell.value || ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span>none</span>
        {GOLD_STEPS.map((step, index) => (
          <span
            key={step}
            aria-hidden
            className="inline-block h-3 w-6 rounded-sm"
            style={{ background: step, opacity: index === 0 ? 0.45 : 1 }}
          />
        ))}
        <span>{max}</span>
      </div>
    </div>
  );
}
