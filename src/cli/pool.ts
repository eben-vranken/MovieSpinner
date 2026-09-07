import { migrate, openDb } from '../db/client';
import { tmdbConfig } from '../config';
import { computeCoverage, loadMovements } from '../coverage';
import { buildPool } from '../pool';

/**
 * Build step 4. Seeds the candidate lists, dedupes, excludes watched, and then
 * answers the question §6 of the brief actually cares about: can the pool supply
 * what the weights are going to demand?
 *
 * Usage:
 *   npm run pool
 *   npm run pool -- --refresh   # re-scrape the canon pages and re-fetch TMDB
 *   npm run pool -- --report    # skip rebuilding, just print the current pool
 */

const REGIONS: [string, string[]][] = [
  ['India', ['IN']],
  ['Iran', ['IR']],
  ['Latin America', ['AR', 'BR', 'MX', 'CL', 'CO', 'PE', 'CU', 'UY', 'VE', 'BO', 'EC', 'GT']],
  ['Africa', ['SN', 'ML', 'BF', 'DZ', 'MA', 'EG', 'TN', 'ZA', 'NG', 'ET', 'TD', 'MR', 'GH', 'KE', 'AO']],
  ['Southeast Asia', ['TH', 'PH', 'ID', 'VN', 'MY', 'SG', 'KH', 'MM']],
  ['East Asia beyond Japan', ['CN', 'HK', 'TW', 'KR']],
  ['Middle East beyond Iran', ['TR', 'LB', 'IL', 'SY', 'IQ', 'JO', 'AE', 'PS']],
  ['Eastern Europe', ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'RS', 'HR', 'XC', 'YU', 'SU', 'RU']],
  ['Nordics', ['SE', 'NO', 'DK', 'FI', 'IS']],
];

const bar = (count: number, per: number): string => '#'.repeat(Math.min(60, Math.round(count / per)));

async function main(): Promise<void> {
  const { region } = tmdbConfig();
  const db = openDb();
  migrate(db, { verbose: true });

  const reportOnly = process.argv.includes('--report');

  // The auteur lists are derived from the movements table, so the taxonomy has
  // to be loaded before the pool is built rather than after.
  loadMovements(db);

  if (!reportOnly) {
    const started = Date.now();
    const result = await buildPool(db, {
      refresh: process.argv.includes('--refresh'),
      region,
      onStage: (message) => console.log(`  ${message}`),
    });

    console.log(`\nBuilt in ${((Date.now() - started) / 1000).toFixed(0)}s. ` +
      `${result.requests} TMDB request(s), ${result.cacheHits} cache hit(s).\n`);

    console.log('Source lists:');
    for (const kind of ['canon', 'collection', 'lineage', 'regional', 'auteur']) {
      const group = result.lists.filter((l) => l.kind === kind);
      if (group.length === 0) continue;
      if (kind === 'regional' || kind === 'auteur') {
        const entries = group.reduce((s, l) => s + l.entries, 0);
        console.log(`  ${group.length} ${kind} lists, ${entries} films`);
        const thin = group.filter((l) => l.entries < 12).sort((a, b) => a.entries - b.entries);
        if (thin.length > 0) {
          console.log(
            `    thinnest: ${thin.slice(0, 8).map((l) => `${l.name} ${l.entries}`).join(', ')}`,
          );
        }
        continue;
      }
      for (const list of group) {
        const rate = list.entries === 0 ? 0 : (list.resolved / list.entries) * 100;
        console.log(
          `  ${list.name.padEnd(30)} ${String(list.resolved).padStart(4)}/${String(list.entries).padEnd(4)}` +
            ` resolved (${rate.toFixed(1)}%)` +
            (list.unresolved > 0 ? `, ${list.unresolved} not matched` : ''),
        );
      }
    }

    console.log(
      `\nPool: ${result.poolSize} films.` +
        ` ${result.distinctFromLists} distinct across all lists,` +
        ` ${result.alreadyWatched} already watched and excluded,` +
        ` ${result.onWatchlist} on my watchlist.`,
    );
  }

  loadMovements(db);
  const coverage = computeCoverage(db);
  const scalar = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;

  const poolSize = scalar('SELECT COUNT(*) AS n FROM pool');
  if (poolSize === 0) {
    console.log('\nPool is empty. Run: npm run pool');
    db.close();
    return;
  }

  // --- the supply check -----------------------------------------------------
  // §6: "If the engine weights by country gap while drawing from a Eurocentric
  // pool, it'll keep trying to send me to Senegal with four Senegalese films
  // available." This is that check, made numeric before any engine exists.
  console.log('\nSupply against gaps  (watched / in pool)');
  console.log('\n  By region:');
  for (const [label, codes] of REGIONS) {
    const placeholders = codes.map(() => '?').join(',');
    const watched = codes.reduce(
      (sum, code) => sum + (coverage.country.find((b) => b.key === code)?.count ?? 0),
      0,
    );
    const available = scalar(
      `SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.origin_country IN (${placeholders})`,
      ...codes,
    );
    const verdict = available === 0 ? 'nothing to draw' : available < 15 ? 'thin' : '';
    console.log(
      `    ${String(watched).padStart(3)} / ${String(available).padStart(4)}  ${label.padEnd(24)}${bar(available, 8)} ${verdict}`,
    );
  }

  console.log('\n  By decade:');
  for (const bucket of coverage.decade) {
    const available =
      bucket.key === 'pre-1950'
        ? scalar('SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE t.year < 1950')
        : scalar(
            'SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE t.year BETWEEN ? AND ?',
            Number.parseInt(bucket.key, 10),
            Number.parseInt(bucket.key, 10) + 9,
          );
    console.log(
      `    ${String(bucket.count).padStart(3)} / ${String(available).padStart(4)}  ${bucket.key.padEnd(24)}${bar(available, 8)}`,
    );
  }

  console.log('\n  By movement:');
  const thinMovements: string[] = [];
  for (const bucket of coverage.movement) {
    const available = scalar(
      'SELECT COUNT(*) AS n FROM pool p JOIN film_movements fm ON fm.tmdb_id = p.tmdb_id WHERE fm.movement = ?',
      bucket.key,
    );
    if (bucket.count === 0 && available < 5) thinMovements.push(`${bucket.label} (${available})`);
    console.log(
      `    ${String(bucket.count).padStart(3)} / ${String(available).padStart(4)}  ${bucket.label.padEnd(30)}${bar(available, 4)}`,
    );
  }
  if (thinMovements.length > 0) {
    console.log(
      `\n    Untouched and thinly supplied, so the engine cannot fix these on its own:\n      ${thinMovements.join(', ')}`,
    );
  }

  // --- availability ---------------------------------------------------------
  const streamable = scalar(
    `SELECT COUNT(DISTINCT p.tmdb_id) AS n FROM pool p
     JOIN tmdb_watch_providers w ON w.tmdb_id = p.tmdb_id
     WHERE w.region = ? AND w.offer_type = 'flatrate'`,
    region,
  );
  const anyOffer = scalar(
    `SELECT COUNT(DISTINCT p.tmdb_id) AS n FROM pool p
     JOIN tmdb_watch_providers w ON w.tmdb_id = p.tmdb_id WHERE w.region = ?`,
    region,
  );
  console.log(
    `\n  In ${region}: ${streamable} of ${poolSize} on a subscription service, ${anyOffer} available in any form.`,
  );

  const consensus = db
    .prepare('SELECT list_count, COUNT(*) AS n FROM pool GROUP BY list_count ORDER BY list_count DESC')
    .all() as { list_count: number; n: number }[];
  console.log('\n  Lists agreeing per film:');
  for (const row of consensus) {
    console.log(`    ${row.list_count} list${row.list_count === 1 ? ' ' : 's'}  ${String(row.n).padStart(4)} films`);
  }

  // Box sets are separated from real failures because lumping them together
  // made Criterion look like a 13% miss rate when it is closer to 5%.
  const unresolved = db
    .prepare(
      `SELECT list_slug,
              SUM(CASE WHEN reason LIKE 'box set%' THEN 1 ELSE 0 END) AS sets,
              SUM(CASE WHEN reason LIKE 'box set%' THEN 0 ELSE 1 END) AS misses
       FROM pool_unresolved GROUP BY list_slug ORDER BY misses DESC`,
    )
    .all() as { list_slug: string; sets: number; misses: number }[];
  if (unresolved.length > 0) {
    console.log('\n  Source rows not in the pool (kept in pool_unresolved, never dropped):');
    for (const row of unresolved) {
      console.log(
        `    ${row.list_slug.padEnd(16)} ${String(row.misses).padStart(3)} unmatched` +
          (row.sets > 0 ? `, ${row.sets} box sets skipped` : ''),
      );
    }
  }

  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
