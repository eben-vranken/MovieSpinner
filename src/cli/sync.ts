import { migrate, openDb } from '../db/client';
import { sync } from '../sync';
import { letterboxdUser } from '../setup/pipeline';

/**
 * The daily job. Reads the Letterboxd feed, closes out picks that have been
 * watched, and makes sure today has a slate waiting.
 *
 * Usage:
 *   npm run sync
 *   npm run sync -- --user someoneelse --no-generate
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

async function main(): Promise<void> {
  const db = openDb();
  migrate(db);
  // Defaults to the profile the last import came from, so this works on a
  // fresh install without anyone setting an environment variable.
  const username = arg('user', '') || letterboxdUser(db);

  const result = await sync(db, username, { generate: !process.argv.includes('--no-generate') });

  console.log(`Read ${result.entries} entries from ${username}'s feed, ${result.newEntries} new.`);
  if (result.merge.watchedAdded > 0 || result.merge.filmsBackfilled > 0) {
    console.log(
      `  merged ${result.merge.watchedAdded} newly watched (${result.merge.filmsBackfilled} backfilled from TMDB, ` +
        `${result.merge.ratingsAdded} ratings, ${result.merge.poolExcluded} dropped from the pool).`,
    );
  }
  for (const failure of result.merge.failures) console.log(`  merge failed: ${failure}`);
  if (result.resolved.length === 0) {
    console.log('No pending pick matched anything in the feed.');
  } else {
    for (const row of result.resolved) {
      console.log(`  closed ${row.date}: ${row.title}, watched ${row.watchedOn ?? 'recently'}`);
    }
  }
  if (result.generated) console.log(`Generated the pick for ${result.generated}.`);
  if (result.unmatched.length > 0) {
    console.log(`  ${result.unmatched.length} feed entry(s) had no TMDB id: ${result.unmatched.join(', ')}`);
  }
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
