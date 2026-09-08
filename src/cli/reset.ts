import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DEFAULT_DB_PATH, migrate, openDb } from '../db/client';
import { resetEverything } from '../setup/reset';
import { dataPath } from '../paths';

/**
 * Empty this install, or put a backup back.
 *
 * Usage:
 *   npm run reset                  # asks for confirmation first
 *   npm run reset -- --yes         # skip the prompt
 *   npm run reset -- --caches      # also drop the TMDB and scrape caches
 *   npm run reset -- --exports     # also delete the letterboxd-*.zip files
 *   npm run reset -- --list        # show the backups taken so far
 *   npm run reset -- --restore <name>
 */

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const backupsDir = (): string => dataPath('backups');

function listBackups(): { name: string; size: number; taken: Date }[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, taken: stat.mtime };
    })
    .sort((a, b) => b.taken.getTime() - a.taken.getTime());
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

async function main(): Promise<void> {
  if (has('list')) {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log(`\nNo backups in ${path.relative(process.cwd(), backupsDir())}.\n`);
      return;
    }
    console.log(`\nBackups in ${path.relative(process.cwd(), backupsDir())}:\n`);
    for (const backup of backups) {
      console.log(`  ${backup.name}   ${mb(backup.size).padStart(8)}   ${backup.taken.toISOString()}`);
    }
    console.log('\nRestore one with:  npm run reset -- --restore <name>\n');
    return;
  }

  if (has('restore')) {
    const name = arg('restore');
    if (!name) {
      console.log('Which one? npm run reset -- --list');
      process.exitCode = 1;
      return;
    }
    const source = path.join(backupsDir(), path.basename(name));
    if (!fs.existsSync(source)) {
      console.log(`No backup called ${path.basename(name)}. npm run reset -- --list`);
      process.exitCode = 1;
      return;
    }

    // The app must not be running: it holds the database open, and replacing
    // the file under a live handle leaves that process reading a file that no
    // longer exists. The WAL sidecars go too, or SQLite will replay the old
    // journal on top of the restored file and undo the restore.
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${DEFAULT_DB_PATH}${suffix}`;
      if (fs.existsSync(target)) fs.rmSync(target);
    }
    fs.copyFileSync(source, DEFAULT_DB_PATH);
    console.log(`\nRestored ${path.basename(name)}. Stop and restart the app if it is running.\n`);
    return;
  }

  const clearCaches = has('caches');
  const clearExports = has('exports');

  const db = openDb();
  migrate(db);
  const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const watched = scalar('SELECT COUNT(*) AS n FROM watched');
  const picks = scalar('SELECT COUNT(*) AS n FROM picks');

  console.log('\nThis empties the database:');
  console.log(`  ${watched} watched films, their ratings, diary and watchlist`);
  console.log('  every TMDB match, the candidate pool, the coverage snapshots');
  console.log(`  the log of every slate, and ${picks} pick(s)`);
  if (clearCaches) console.log('  the TMDB response cache and the scraped list pages');
  if (clearExports) console.log('  every letterboxd-*.zip in the data directory');
  console.log('\nKept: the schema, your .env, and the committed CSVs.');
  console.log('A full copy of the database goes to data/backups/ first.\n');

  if (!has('yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type RESET to confirm: ');
    rl.close();
    if (answer.trim().toUpperCase() !== 'RESET') {
      console.log('\nLeft alone.\n');
      db.close();
      return;
    }
  }

  const result = await resetEverything(db, { clearCaches, clearExports });
  db.close();

  console.log(`\nCleared ${result.rows.toLocaleString()} rows from ${result.tables} tables.`);
  if (result.backup) {
    console.log(`Backup:  ${path.relative(process.cwd(), result.backup)}`);
    console.log('Undo:    npm run reset -- --restore ' + path.basename(result.backup));
  } else {
    console.log('The backup could not be written, so this one is not undoable.');
  }
  for (const file of result.filesDeleted) console.log(`Deleted: ${file}`);
  console.log('\nThis install is now what a fresh clone looks like.');
  console.log('Start it with  npm run dev  to see the setup screen.\n');
}

void main();
