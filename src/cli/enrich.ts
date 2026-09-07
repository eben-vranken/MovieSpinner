import { tmdbConfig } from '../config';
import { migrate, openDb } from '../db/client';
import { enrich } from '../ingest/enrich';

/**
 * Usage:
 *   npm run enrich                # match everything still unresolved
 *   npm run enrich -- --all       # re-match everything, cache still used
 *   npm run enrich -- --refresh   # ignore the on-disk cache, re-fetch TMDB
 *   npm run enrich -- --limit 20  # smoke test
 */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const { region } = tmdbConfig();
  const db = openDb();
  migrate(db, { verbose: true });

  const limitArg = value('limit');
  const started = Date.now();
  let lastLogged = 0;

  const result = await enrich(db, {
    all: flag('all'),
    refresh: flag('refresh'),
    limit: limitArg ? Number.parseInt(limitArg, 10) : undefined,
    region,
    onProgress: (done, total) => {
      if (done === total || done - lastLogged >= 50) {
        lastLogged = done;
        process.stdout.write(`  matching ${done}/${total}\r`);
      }
    },
  });

  process.stdout.write(' '.repeat(40) + '\r');
  console.log(`Matched ${result.attempted} film(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${result.requests} TMDB request(s), ${result.cacheHits} cache hit(s)\n`);

  console.log('Match method across all films:');
  for (const [method, count] of Object.entries(result.byMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method.padEnd(10)} ${String(count).padStart(4)}`);
  }

  const rate = result.matchRate * 100;
  console.log(
    `\nMatch rate: ${rate.toFixed(1)}% of matchable films` +
      (result.excluded > 0 ? `, ${result.excluded} excluded by override` : '') +
      '   (brief requires >90% before step 3)',
  );

  if (result.duplicates.length > 0) {
    console.log(`\n${result.duplicates.length} TMDB id(s) claimed by more than one film:`);
    for (const dup of result.duplicates) {
      console.log(`  ${dup.tmdbId}: ${dup.films.join(' / ')}`);
    }
  }

  if (result.unmatched.length > 0 || result.needsReview.length > 0) {
    console.log(
      `\n${result.unmatched.length} unmatched, ${result.needsReview.length} needing review.` +
        ' Run: npm run matches',
    );
  }

  db.close();
  if (rate < 90) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
