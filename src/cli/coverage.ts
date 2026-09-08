import { migrate, openDb } from '../db/client';
import { computeCoverage, DECADE_ORDER, loadMovements, snapshotCoverage } from '../coverage';
import type { Bucket } from '../coverage';

/**
 * Build step 3. Prints current coverage across the four dimensions the weighting
 * in step 5 will consume, and sanity-checks the decade grid against §2 of the
 * brief.
 *
 * Usage:
 *   npm run coverage
 *   npm run coverage -- --snapshot   # also record today's numbers for §7
 */

/**
 * The decade counts the brief quotes, so drift is caught here too -- but only
 * on the export they describe. On anybody else's data they are somebody else's
 * numbers, and comparing against them would report a wall of failures about
 * nothing. Checked against the imported profile below.
 */
const BRIEF_PROFILE = 'EbenVranken';

const EXPECTED_DECADES: Record<string, number> = {
  'pre-1950': 0,
  '1950s': 8,
  '1960s': 17,
  '1970s': 20,
  '1980s': 33,
  '1990s': 49,
  '2000s': 104,
  '2010s': 96,
  '2020s': 109,
};

/**
 * The regions §2 of the brief names as blind spots and §6 says to seed the pool
 * with. Grouped so the report answers "how bad is it, really" in one line each
 * rather than making me read 40 rows of a country table.
 */
const REGIONS: [string, string[]][] = [
  ['India', ['IN']],
  ['Iran', ['IR']],
  ['Latin America', ['AR', 'BR', 'MX', 'CL', 'CO', 'PE', 'CU', 'UY', 'VE', 'BO', 'EC', 'GT']],
  ['Africa', ['SN', 'ML', 'BF', 'DZ', 'MA', 'EG', 'TN', 'ZA', 'NG', 'ET', 'TD', 'MR', 'GH', 'KE', 'AO']],
  ['Southeast Asia', ['TH', 'PH', 'ID', 'VN', 'MY', 'SG', 'KH', 'MM']],
  ['Middle East beyond Iran', ['TR', 'LB', 'IL', 'SY', 'IQ', 'JO', 'AE', 'PS']],
  ['Eastern Europe', ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'RS', 'HR', 'XC', 'YU']],
  ['Nordics', ['SE', 'NO', 'DK', 'FI', 'IS']],
];

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code: string): string => {
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
};

const bar = (count: number, per: number): string => '#'.repeat(Math.round(count / per));

function main(): void {
  const db = openDb();
  migrate(db);

  const load = loadMovements(db);
  for (const problem of load.problems) console.log(`  warning: ${problem}`);

  const coverage = computeCoverage(db);
  const unmapped = coverage.total - coverage.mapped;

  console.log('MovieSpinner: coverage');
  console.log(
    `${coverage.total} films watched, ${coverage.mapped} with TMDB metadata` +
      (unmapped > 0 ? ` (${unmapped} television or unfindable, excluded below the decade grid)` : ''),
  );

  // --- decade, the hero visual ---------------------------------------------
  console.log('\nDecade  (all watched films, on the Letterboxd year)');
  const byDecade = new Map(coverage.decade.map((b) => [b.key, b.count]));
  const profile = (
    db.prepare('SELECT username FROM imports ORDER BY id DESC LIMIT 1').get() as
      | { username: string | null }
      | undefined
  )?.username;
  const isBriefProfile = profile === BRIEF_PROFILE;

  let decadesOk = true;
  for (const key of DECADE_ORDER) {
    const count = byDecade.get(key) ?? 0;
    const expected = EXPECTED_DECADES[key];
    const ok = expected === undefined || count === expected;
    if (!isBriefProfile) {
      console.log(`        ${key.padEnd(9)} ${String(count).padStart(4)}  ${bar(count, 3)}`);
      continue;
    }
    if (!ok) decadesOk = false;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(9)} ${String(count).padStart(4)}  ${bar(count, 3)}`,
    );
  }

  const preWall = (byDecade.get('pre-1950') ?? 0) + (byDecade.get('1950s') ?? 0);
  console.log(
    `\n  The wall: ${byDecade.get('pre-1950') ?? 0} films before 1950, ${preWall} before 1960.` +
      ` ${(((byDecade.get('2010s') ?? 0) + (byDecade.get('2020s') ?? 0)) / coverage.total * 100).toFixed(0)}% of everything is 2010 or later.`,
  );

  // --- country --------------------------------------------------------------
  const countryTotal = coverage.country.reduce((sum, b) => sum + b.count, 0);
  console.log(`\nCountry  (lead country, ${coverage.country.length} distinct)`);
  for (const bucket of coverage.country.slice(0, 12)) {
    console.log(
      `  ${String(bucket.count).padStart(4)}  ${bucket.key}  ${countryName(bucket.key).padEnd(22)} ${bar(bucket.count, 4)}`,
    );
  }
  const tail = coverage.country.slice(12).reduce((sum, b) => sum + b.count, 0);
  console.log(`  ${String(tail).padStart(4)}        everywhere else (${coverage.country.length - 12} countries)`);

  const anyCountry = new Map(coverage.countryAny.map((b) => [b.key, b.count]));
  console.log('\n  Regions the brief calls out  (as lead country / in any role):');
  // Two numbers per region on purpose. Counting every production country makes
  // Latin America look four times healthier than it is, because Herzog shooting
  // Fitzcarraldo in Peru lands in the PE bucket. The primary count is the honest
  // one; the second number is how often the region shows up at all.
  const primaryCountry = new Map(coverage.country.map((b) => [b.key, b.count]));
  for (const [label, codes] of REGIONS) {
    const primary = codes.reduce((sum, code) => sum + (primaryCountry.get(code) ?? 0), 0);
    const any = codes.reduce((sum, code) => sum + (anyCountry.get(code) ?? 0), 0);
    const present = codes.filter((code) => primaryCountry.has(code));
    console.log(
      `    ${String(primary).padStart(3)} / ${String(any).padEnd(4)} ${label.padEnd(24)}` +
        (primary === 0
          ? any === 0
            ? 'nothing at all'
            : 'only ever as a co-production partner'
          : present.map((c) => `${c}:${primaryCountry.get(c)}`).join(' ')),
    );
  }
  console.log(`\n  ${countryTotal} films have a lead country on file.`);

  // --- director -------------------------------------------------------------
  console.log(`\nDirector  (${coverage.director.length} distinct)`);
  const depth = new Map<number, number>();
  for (const bucket of coverage.director) {
    depth.set(bucket.count, (depth.get(bucket.count) ?? 0) + 1);
  }
  console.log('  films per director:');
  for (const films of [...depth.keys()].sort((a, b) => a - b)) {
    const directors = depth.get(films) ?? 0;
    console.log(
      `    ${String(films).padStart(2)} film${films === 1 ? ' ' : 's'}  ${String(directors).padStart(4)} directors  ${bar(directors, 4)}`,
    );
  }
  const once = depth.get(1) ?? 0;
  console.log(
    `  ${once} of ${coverage.director.length} directors (${((once / coverage.director.length) * 100).toFixed(0)}%)` +
      ' seen exactly once. That share falling is the sign depth is building.',
  );
  console.log('  deepest:');
  for (const bucket of coverage.director.slice(0, 8)) {
    console.log(`    ${String(bucket.count).padStart(3)}  ${bucket.label}`);
  }

  // --- movement -------------------------------------------------------------
  console.log(
    `\nMovement  (${load.movements} hand-curated; ${load.taggings} tags: ` +
      `${load.manual} by hand, ${load.fromDirectors} by director, ${load.fromPeriod} by period)`,
  );
  if (load.unknownDirectors.length > 0) {
    console.log(
      `  ${load.unknownDirectors.length} named director(s) still have no film in the database: ` +
        load.unknownDirectors.slice(0, 5).join(', ') +
        (load.unknownDirectors.length > 5 ? ', ...' : ''),
    );
  }
  const covered = coverage.movement.filter((b) => b.count > 0);
  const empty = coverage.movement.filter((b) => b.count === 0);
  for (const bucket of coverage.movement) {
    const flag = bucket.count === 0 ? '  <-- nothing' : '';
    console.log(`  ${String(bucket.count).padStart(3)}  ${bucket.label.padEnd(30)}${bar(bucket.count, 1)}${flag}`);
  }
  console.log(
    `\n  ${covered.length} movements touched, ${empty.length} untouched.` +
      ' Untouched ones are where the engine should be pointing me.',
  );

  if (process.argv.includes('--snapshot')) {
    const takenOn = snapshotCoverage(db, coverage);
    const history = db
      .prepare('SELECT COUNT(*) AS n FROM coverage_snapshot_meta')
      .get() as { n: number };
    console.log(`\nSnapshot recorded for ${takenOn}. ${history.n} snapshot(s) on file.`);
  } else {
    console.log('\nRun with --snapshot to record these numbers for the dashboard trend.');
  }

  db.close();
  if (!decadesOk) {
    console.log('\nThe decade grid no longer matches the brief. Something upstream changed.');
    process.exitCode = 1;
  }
}

main();
