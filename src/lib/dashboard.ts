import { computeCoverage, loadMovements, DECADE_ORDER } from '../coverage';
import type { Coverage } from '../coverage';
import { db } from './db';

/**
 * Everything the coverage dashboard reads.
 *
 * §7 is explicit that the metric is coverage closing rather than films watched,
 * and that historical trend matters more than current state. So almost
 * everything here is paired with where it was at the earliest snapshot.
 */

export interface DecadeCell {
  key: string;
  now: number;
  then: number;
  inPool: number;
}

export interface CountryRow {
  code: string;
  name: string;
  count: number;
}

export interface MovementRow {
  slug: string;
  name: string;
  region: string | null;
  period: string;
  now: number;
  then: number;
  inPool: number;
}

export interface RegionRow {
  label: string;
  watched: number;
  inPool: number;
  countriesSeen: number;
  countriesAvailable: number;
}

export interface Dashboard {
  totalWatched: number;
  mapped: number;
  decades: DecadeCell[];
  countries: CountryRow[];
  directorDepth: { films: number; directors: number }[];
  directorsSeenOnce: number;
  directorsTotal: number;
  topDirectors: { name: string; count: number }[];
  movements: MovementRow[];
  regions: RegionRow[];
  poolSize: number;
  snapshots: { takenOn: string; watched: number }[];
  picks: { total: number; watched: number; skipped: number; pending: number };
  streak: number;
  recentSkips: { date: string; title: string; year: number | null }[];
}

/** The regions §2 names as blind spots, grouped for the progress panel. */
export const REGION_GROUPS: [string, string[]][] = [
  ['India', ['IN']],
  ['Iran', ['IR']],
  ['Africa', ['SN', 'ML', 'BF', 'DZ', 'MA', 'EG', 'TN', 'ZA', 'NG', 'ET', 'TD', 'MR', 'GH', 'KE', 'AO', 'CM', 'CI']],
  ['Latin America', ['AR', 'BR', 'MX', 'CL', 'CO', 'PE', 'CU', 'UY', 'VE', 'BO', 'EC', 'GT']],
  ['Southeast Asia', ['TH', 'PH', 'ID', 'VN', 'MY', 'SG', 'KH', 'MM']],
  ['East Asia beyond Japan', ['CN', 'HK', 'TW', 'KR']],
  ['Middle East beyond Iran', ['TR', 'LB', 'IL', 'SY', 'IQ', 'JO', 'AE', 'PS', 'QA']],
  ['Eastern Europe', ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'RS', 'HR', 'XC', 'YU', 'SU', 'RU', 'EE', 'BA']],
  ['Nordics', ['SE', 'NO', 'DK', 'FI', 'IS']],
];

export const countryName = (code: string): string => {
  if (code === 'XC') return 'Czechoslovakia';
  if (code === 'SU') return 'Soviet Union';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export function loadDashboard(): Dashboard {
  const handle = db();
  loadMovements(handle);
  const coverage: Coverage = computeCoverage(handle);

  const scalar = (sql: string, ...args: unknown[]): number =>
    (handle.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;
  const rows = <T>(sql: string, ...args: unknown[]): T[] =>
    handle.prepare(sql).all(...args) as T[];

  // The earliest snapshot is the "then" column everywhere. §7 wants change, and
  // a dashboard that only ever shows today's number cannot show any.
  const earliest = handle
    .prepare('SELECT taken_on FROM coverage_snapshot_meta ORDER BY taken_on LIMIT 1')
    .get() as { taken_on: string } | undefined;

  const thenOf = (dimension: string): Map<string, number> =>
    new Map(
      earliest
        ? rows<{ bucket: string; count: number }>(
            'SELECT bucket, count FROM coverage_snapshots WHERE taken_on = ? AND dimension = ?',
            earliest.taken_on,
            dimension,
          ).map((row) => [row.bucket, row.count])
        : [],
    );

  const thenDecade = thenOf('decade');
  const thenMovement = thenOf('movement');

  const poolByDecade = new Map(
    rows<{ bucket: string; n: number }>(
      `SELECT CASE WHEN t.year < 1950 THEN 'pre-1950'
                   ELSE CAST((t.year / 10) * 10 AS TEXT) || 's' END AS bucket,
              COUNT(*) AS n
       FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.year IS NOT NULL GROUP BY bucket`,
    ).map((row) => [row.bucket, row.n]),
  );

  const poolByMovement = new Map(
    rows<{ movement: string; n: number }>(
      `SELECT fm.movement, COUNT(*) AS n FROM pool p
       JOIN film_movements fm ON fm.tmdb_id = p.tmdb_id GROUP BY fm.movement`,
    ).map((row) => [row.movement, row.n]),
  );

  const poolByCountry = new Map(
    rows<{ c: string; n: number }>(
      `SELECT t.origin_country AS c, COUNT(*) AS n FROM pool p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.origin_country IS NOT NULL GROUP BY c`,
    ).map((row) => [row.c, row.n]),
  );

  const watchedByCountry = new Map(coverage.country.map((bucket) => [bucket.key, bucket.count]));

  const depth = new Map<number, number>();
  for (const bucket of coverage.director) {
    depth.set(bucket.count, (depth.get(bucket.count) ?? 0) + 1);
  }

  const movementMeta = rows<{
    slug: string;
    name: string;
    region: string | null;
    period_start: number | null;
    period_end: number | null;
  }>('SELECT slug, name, region, period_start, period_end FROM movements ORDER BY sort_order');
  const movementNow = new Map(coverage.movement.map((bucket) => [bucket.key, bucket.count]));

  const pickCounts = rows<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM picks GROUP BY status',
  );
  const statusCount = (status: string): number =>
    pickCounts.find((row) => row.status === status)?.n ?? 0;

  return {
    totalWatched: coverage.total,
    mapped: coverage.mapped,
    decades: DECADE_ORDER.map((key) => ({
      key,
      now: coverage.decade.find((bucket) => bucket.key === key)?.count ?? 0,
      then: thenDecade.get(key) ?? 0,
      inPool: poolByDecade.get(key) ?? 0,
    })),
    countries: coverage.country.map((bucket) => ({
      code: bucket.key,
      name: countryName(bucket.key),
      count: bucket.count,
    })),
    directorDepth: [...depth]
      .sort((a, b) => a[0] - b[0])
      .map(([films, directors]) => ({ films, directors })),
    directorsSeenOnce: depth.get(1) ?? 0,
    directorsTotal: coverage.director.length,
    topDirectors: coverage.director.slice(0, 10).map((bucket) => ({
      name: bucket.label,
      count: bucket.count,
    })),
    movements: movementMeta.map((row) => ({
      slug: row.slug,
      name: row.name,
      region: row.region,
      period: `${row.period_start ?? '?'}–${row.period_end ?? '?'}`,
      now: movementNow.get(row.slug) ?? 0,
      then: thenMovement.get(row.slug) ?? 0,
      inPool: poolByMovement.get(row.slug) ?? 0,
    })),
    regions: REGION_GROUPS.map(([label, codes]) => ({
      label,
      watched: codes.reduce((sum, code) => sum + (watchedByCountry.get(code) ?? 0), 0),
      inPool: codes.reduce((sum, code) => sum + (poolByCountry.get(code) ?? 0), 0),
      countriesSeen: codes.filter((code) => (watchedByCountry.get(code) ?? 0) > 0).length,
      countriesAvailable: codes.filter((code) => (poolByCountry.get(code) ?? 0) > 0).length,
    })),
    poolSize: scalar('SELECT COUNT(*) AS n FROM pool'),
    snapshots: rows<{ taken_on: string; watched_total: number }>(
      'SELECT taken_on, watched_total FROM coverage_snapshot_meta ORDER BY taken_on',
    ).map((row) => ({ takenOn: row.taken_on, watched: row.watched_total })),
    picks: {
      total: pickCounts.reduce((sum, row) => sum + row.n, 0),
      watched: statusCount('watched'),
      skipped: statusCount('skipped'),
      pending: statusCount('pending'),
    },
    streak: 0,
    recentSkips: rows<{ pick_date: string; title: string; year: number | null }>(
      `SELECT p.pick_date, t.title, t.year FROM picks p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE p.status = 'skipped' ORDER BY p.pick_date DESC LIMIT 6`,
    ).map((row) => ({ date: row.pick_date, title: row.title, year: row.year })),
  };
}
