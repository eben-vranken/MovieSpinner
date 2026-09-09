import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import world from 'world-atlas/countries-110m.json' with { type: 'json' };
import { WorldMapClient } from './WorldMapClient';
import type { Shape } from './WorldMapClient';

/**
 * §7's world map: countries by films watched, and a way in.
 *
 * The projection, the topology and the paths stay on the server. What crosses
 * to the client is a list of rounded path strings with two counts each, plus
 * two static line paths -- d3-geo, topojson and the 100KB atlas never enter the
 * browser bundle, which is the same trade the rest of the charts make. Clicking
 * a country is a fetch, not a re-render of the map.
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
 *
 * Borders are a mesh, not a stroke on every country. Stroking each shape draws
 * every shared border twice and every coastline once, so the same line weight
 * lands at two different strengths depending on whether a country has a
 * neighbour -- which is exactly what made the map look untidy. The mesh draws
 * each border once, from one path, at one weight.
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

/**
 * The three shapes the atlas draws but ISO does not number.
 *
 * Natural Earth carries Somaliland, Kosovo and Northern Cyprus as their own
 * outlines; none of them has an ISO 3166-1 code, so TMDB's origin_country can
 * never name one and no row in the data can ever reach them. Drawn on their
 * own they are permanently empty slivers cut into a neighbour that does have
 * colour. So each is folded into the state it sits in: one shape, one fill,
 * one click target, and no line drawn down the middle of it.
 *
 * This is a rendering decision about which shapes can hold a number, not a
 * claim about anybody's borders. Delete an entry and that territory goes back
 * to being drawn separately.
 */
const FOLDED_INTO: Record<string, string> = {
  Somaliland: 'Somalia',
  Kosovo: 'Serbia',
  'N. Cyprus': 'Cyprus',
};

const unitOf = (name: string): string => FOLDED_INTO[name] ?? name;

/** One country as the analytics loader hands it over. */
export interface CountryRow {
  code: string;
  name: string;
  count: number;
  pool: number;
}

interface MapFeature {
  properties: { name: string };
}

const countries = (world as unknown as { objects: { countries: unknown } }).objects.countries;

const collection = feature(world as never, countries as never) as unknown as {
  features: MapFeature[];
  type: 'FeatureCollection';
};

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
const round = (d: string): string => d.replace(/\d+\.\d+/g, (value) => Number(value).toFixed(1));

const toPath = (geometry: unknown): string | null => {
  const d = path(geometry as never);
  return d === null ? null : round(d);
};

const boundary = (
  filter: (a: { properties: { name: string } }, b: { properties: { name: string } }) => boolean,
): string => toPath(mesh(world as never, countries as never, filter as never)) ?? '';

/** Every land border, once each. Folded territories keep no internal line. */
const BORDERS = boundary(
  (a, b) => a !== b && unitOf(a.properties.name) !== unitOf(b.properties.name),
);

/** Where land meets sea. Drawn a step lighter, so the world has an edge. */
const COASTLINE = boundary((a, b) => a === b);

export function WorldMap({ countries: rows }: { countries: CountryRow[] }) {
  const unitNames = new Set(
    collection.features.map((f) => unitOf(f.properties.name).toLowerCase()),
  );

  const watched = new Map<string, number>();
  const pool = new Map<string, number>();
  const codesByName = new Map<string, string[]>();
  const unmatched: string[] = [];

  for (const row of rows) {
    const label = unitOf(ALIASES[row.code] ?? row.name).toLowerCase();
    if (!unitNames.has(label)) {
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

  // One entry per unit rather than per outline, so a folded territory arrives
  // as another subpath of its state instead of a shape of its own.
  const byUnit = new Map<string, string[]>();
  for (const entry of collection.features) {
    const d = toPath(entry);
    if (!d) continue;
    const unit = unitOf(entry.properties.name);
    byUnit.set(unit, [...(byUnit.get(unit) ?? []), d]);
  }

  const shapes: Shape[] = [...byUnit].map(([name, paths]) => {
    const key = name.toLowerCase();
    return {
      id: name,
      name,
      d: paths.join(' '),
      watched: watched.get(key) ?? 0,
      pool: pool.get(key) ?? 0,
      codes: codesByName.get(key) ?? [],
    };
  });

  return (
    <WorldMapClient
      shapes={shapes}
      borders={BORDERS}
      coastline={COASTLINE}
      width={WIDTH}
      height={HEIGHT}
      max={max}
      drawn={watched.size}
      unmatched={unmatched}
    />
  );
}
