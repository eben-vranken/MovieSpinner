import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json' with { type: 'json' };
import { WorldMapClient } from './WorldMapClient';
import type { Shape } from './WorldMapClient';

/**
 * §7's world map: countries by films watched, and now a way in.
 *
 * The projection, the topology and the 177 paths stay on the server. What
 * crosses to the client is a list of rounded path strings and two counts each
 * -- d3-geo, topojson and the 100KB atlas never enter the browser bundle, which
 * is the same trade the rest of the charts make. Clicking a country is a fetch,
 * not a re-render of the map.
 *
 * Country identity is matched by name rather than code, because world-atlas
 * carries numeric ISO ids and the database carries alpha-2. Names line up for
 * most of the codes in the data; the rest are aliased below, and anything that
 * still misses is listed under the map instead of being silently dropped.
 *
 * Several codes can land on one shape, which is the whole reason `codes` is a
 * list: Czechia is drawn once and the data holds both CZ and XC for it, and
 * the Soviet films are on the Russia outline. Folding them together here is
 * what lets the click ask for all of them at once.
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

/** One country as the analytics loader hands it over. */
export interface CountryRow {
  code: string;
  name: string;
  count: number;
  pool: number;
}

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
const path = geoPath(projection);

/**
 * The map at one decimal place.
 *
 * geoPath emits full float precision, which is roughly 1/1000th of a pixel at
 * this size -- invisible, and about 80KB of it. Rounded coordinates are also
 * served twice, once in the HTML and once in the RSC payload, so the saving
 * counts double.
 */
const toPath = (entry: MapFeature): string | null => {
  const d = path(entry as never);
  return d === null ? null : d.replace(/\d+\.\d+/g, (value) => Number(value).toFixed(1));
};

export function WorldMap({ countries }: { countries: CountryRow[] }) {
  const featureNames = new Set(collection.features.map((f) => f.properties.name.toLowerCase()));

  const watched = new Map<string, number>();
  const pool = new Map<string, number>();
  const codesByName = new Map<string, string[]>();
  const unmatched: string[] = [];

  for (const row of countries) {
    const label = (ALIASES[row.code] ?? row.name).toLowerCase();
    if (!featureNames.has(label)) {
      // Only worth reporting where there is something to lose. A pool-only
      // country the projection cannot draw is a gap in the atlas, not in you.
      if (row.count > 0) unmatched.push(`${row.name} (${row.count})`);
      continue;
    }
    watched.set(label, (watched.get(label) ?? 0) + row.count);
    pool.set(label, (pool.get(label) ?? 0) + row.pool);
    codesByName.set(label, [...(codesByName.get(label) ?? []), row.code]);
  }

  const max = Math.max(1, ...watched.values());

  const shapes: Shape[] = [];
  for (const entry of collection.features) {
    const d = toPath(entry);
    if (!d) continue;
    const key = entry.properties.name.toLowerCase();
    shapes.push({
      id: entry.id,
      name: entry.properties.name,
      d,
      watched: watched.get(key) ?? 0,
      pool: pool.get(key) ?? 0,
      codes: codesByName.get(key) ?? [],
    });
  }

  return (
    <WorldMapClient
      shapes={shapes}
      width={WIDTH}
      height={HEIGHT}
      max={max}
      drawn={watched.size}
      unmatched={unmatched}
    />
  );
}
