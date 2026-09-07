import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json' with { type: 'json' };
import type { CountryRow } from '../../lib/dashboard';

/**
 * §7's world map: countries by films watched.
 *
 * Rendered as plain SVG on the server. A charting library would be a dependency
 * and a client bundle for something that is one projection and 177 paths.
 *
 * Country identity is matched by name rather than code, because world-atlas
 * carries numeric ISO ids and the database carries alpha-2. Names line up for
 * 83 of the 94 codes in the data; the rest are aliased below, and anything that
 * still misses is listed under the map instead of being silently dropped.
 */

const ALIASES: Record<string, string> = {
  US: 'United States of America',
  TR: 'Turkey',
  BA: 'Bosnia and Herz.',
  CG: 'Congo',
  PS: 'Palestine',
  XC: 'Czechia',
  SU: 'Russia',
  CZ: 'Czechia',
  KR: 'South Korea',
  GB: 'United Kingdom',
};

interface MapFeature {
  id: string;
  properties: { name: string };
}

const collection = feature(
  world as never,
  (world as unknown as { objects: { countries: unknown } }).objects.countries as never,
) as unknown as { features: MapFeature[]; type: 'FeatureCollection' };

const WIDTH = 900;
const HEIGHT = 420;

const projection = geoNaturalEarth1().fitSize([WIDTH, HEIGHT], collection as never);
const toPath = geoPath(projection);

export function WorldMap({ countries }: { countries: CountryRow[] }) {
  const byName = new Map<string, number>();
  const unmatched: string[] = [];

  const featureNames = new Set(collection.features.map((f) => f.properties.name.toLowerCase()));
  for (const row of countries) {
    const label = (ALIASES[row.code] ?? row.name).toLowerCase();
    if (!featureNames.has(label)) {
      unmatched.push(`${row.name} (${row.count})`);
      continue;
    }
    byName.set(label, (byName.get(label) ?? 0) + row.count);
  }

  const max = Math.max(1, ...byName.values());
  // Log scale, because the United States would otherwise flatten everything
  // else into the same shade of nothing.
  const shade = (count: number): string => {
    if (count === 0) return 'var(--color-panel)';
    const intensity = Math.log10(1 + count) / Math.log10(1 + max);
    return `color-mix(in oklab, var(--color-accent) ${Math.round(18 + intensity * 82)}%, var(--color-panel))`;
  };

  return (
    <figure>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label="World map of countries by films watched"
      >
        {collection.features.map((entry) => {
          const count = byName.get(entry.properties.name.toLowerCase()) ?? 0;
          const d = toPath(entry as never);
          if (!d) return null;
          return (
            <path
              key={entry.id}
              d={d}
              fill={shade(count)}
              stroke="var(--color-ink)"
              strokeWidth={0.4}
            >
              <title>{`${entry.properties.name}: ${count} ${count === 1 ? 'film' : 'films'}`}</title>
            </path>
          );
        })}
      </svg>
      <figcaption className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span>
          {byName.size} countries on the map, darkest is {max}
        </span>
        {unmatched.length > 0 ? <span>Not drawable: {unmatched.join(', ')}</span> : null}
      </figcaption>
    </figure>
  );
}
