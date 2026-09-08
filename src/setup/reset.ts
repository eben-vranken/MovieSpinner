import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client';
import { dataDir, dataPath } from '../paths';

/**
 * Put this install back to how it looks to somebody who just cloned it.
 *
 * The point is being able to check the first-run experience without finding a
 * second machine. It is genuinely destructive: the whole database goes,
 * including the pick log, which is the one thing an export cannot rebuild.
 *
 * Rows are deleted rather than the file, because `src/lib/db.ts` keeps one
 * open handle on `globalThis` for the life of the process. Deleting the file
 * out from under that handle leaves every later query talking to a file that
 * is no longer there; emptying the tables leaves the handle valid and the
 * schema already migrated, which is exactly the state a fresh `migrate()`
 * would have produced anyway.
 *
 * `schema_migrations` is the one table kept. Clearing it would make the next
 * startup re-run all fourteen migrations against a schema that already has
 * every table, and `CREATE TABLE IF NOT EXISTS` would paper over that right up
 * until the first `ALTER TABLE`.
 */

export interface ResetOptions {
  /**
   * Also delete the TMDB response cache and the scraped list pages.
   *
   * Off by default. The caches change nothing about what the setup flow looks
   * like, only how long it takes -- with them the re-import is seconds, without
   * them it is the same several minutes a stranger would wait. Turn it on when
   * the timing is the thing being checked.
   */
  clearCaches?: boolean;
  /** Also delete uploaded//existing letterboxd-*.zip exports from the data dir. */
  clearExports?: boolean;
}

export interface ResetResult {
  backup: string | null;
  tables: number;
  rows: number;
  filesDeleted: string[];
}

/** Tables that describe the schema rather than the data in it. */
const KEEP = new Set(['schema_migrations']);

const listTables = (db: Db): string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !KEEP.has(name));

/**
 * A copy of the database before it is emptied.
 *
 * Not offered as a choice and not surfaced as a feature: it is what makes a
 * one-click "delete everything" a decision you can walk back from, and it costs
 * a few megabytes. `backup()` rather than a file copy because the database runs
 * in WAL mode, where the newest writes live in a sidecar file and a plain copy
 * of the .db would silently miss them.
 */
export async function backupDatabase(db: Db): Promise<string | null> {
  try {
    const dir = dataPath('backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `moviespinner-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await db.backup(target);
    return target;
  } catch {
    // A failed backup must not stop the reset: the user asked for the data to
    // go, and refusing because the safety net could not be hung would be a
    // strange way to honour that.
    return null;
  }
}

export async function resetEverything(db: Db, options: ResetOptions = {}): Promise<ResetResult> {
  const backup = await backupDatabase(db);
  const tables = listTables(db);

  let rows = 0;
  // Foreign keys off for the duration: the tables reference each other and
  // there is no delete order that satisfies every constraint at every step.
  // The pragma cannot change inside a transaction, hence the toggling here.
  const hadForeignKeys = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const table of tables) {
        rows += db.prepare(`DELETE FROM "${table}"`).run().changes;
      }
      // Autoincrement counters live here. Left alone, a reset install would
      // hand out import id 12 and setup run id 5, which makes a "fresh" install
      // look like it has a history.
      const hasSequence = db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
        .get();
      if (hasSequence) db.prepare('DELETE FROM sqlite_sequence').run();
    })();
  } finally {
    if (hadForeignKeys) db.pragma('foreign_keys = ON');
  }

  // Outside the transaction, because SQLite refuses to vacuum inside one.
  // Without it the file keeps the pages of the data that was just deleted, and
  // an "empty" install would sit there at nine megabytes.
  db.exec('VACUUM');

  // And in WAL mode the vacuumed result lands in the -wal sidecar, so the .db
  // on disk keeps its old size until something checkpoints it. Measured on a
  // full install: 9,156KB before, still 9,156KB after the VACUUM alone, 360KB
  // once this runs.
  db.pragma('wal_checkpoint(TRUNCATE)');

  const filesDeleted: string[] = [];
  const remove = (target: string): void => {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    filesDeleted.push(path.relative(process.cwd(), target));
  };

  if (options.clearCaches) {
    remove(dataPath('tmdb-cache'));
    remove(dataPath('pool-cache'));
  }

  if (options.clearExports) {
    for (const name of fs.readdirSync(dataDir())) {
      if (/^letterboxd-.*\.zip$/i.test(name)) remove(dataPath(name));
    }
  }

  return { backup, tables: tables.length, rows, filesDeleted };
}
