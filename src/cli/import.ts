import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH, migrate, openDb } from '../db/client';
import { importExport } from '../ingest/import';
import { readExport } from '../ingest/letterboxd';

/**
 * Usage:
 *   npm run import                    # newest export zip in ./data
 *   npm run import -- <zip-or-dir>    # a specific export
 */

function newestExportInDataDir(): string {
  const dir = path.join(process.cwd(), 'data');
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /^letterboxd-.*\.zip$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const newest = candidates[0];
  if (!newest) {
    throw new Error(`No letterboxd-*.zip found in ${dir}. Pass a path explicitly.`);
  }
  return newest;
}

function main(): void {
  const source = process.argv[2] ?? newestExportInDataDir();

  const data = readExport(source);
  console.log(`Reading ${path.basename(source)}`);
  console.log(`  profile:   ${data.username ?? '(unknown)'}`);
  console.log(`  exported:  ${data.exportedAt ?? '(unknown)'}`);
  console.log(
    `  parsed:    ${data.watched.length} watched, ${data.ratings.length} ratings, ` +
      `${data.diary.length} diary, ${data.watchlist.length} watchlist, ${data.likes.length} likes`,
  );

  const db = openDb();
  migrate(db);
  const result = importExport(db, data);
  db.close();

  console.log(`\nImported into ${path.relative(process.cwd(), DEFAULT_DB_PATH)} (import #${result.importId})`);
  for (const [table, n] of Object.entries(result.counts)) {
    console.log(`  ${table.padEnd(14)} ${n}`);
  }

  const bySeverity = result.issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue.severity] = (acc[issue.severity] ?? 0) + 1;
    return acc;
  }, {});

  if (result.issues.length === 0) {
    console.log('\nNo issues.');
  } else {
    console.log(
      `\n${result.issues.length} issue(s): ` +
        Object.entries(bySeverity)
          .map(([severity, n]) => `${n} ${severity}`)
          .join(', '),
    );
    for (const issue of result.issues) {
      console.log(`  [${issue.severity}] ${issue.source}: ${issue.message}`);
    }
  }

  if (bySeverity['error']) {
    process.exitCode = 1;
  }
}

main();
