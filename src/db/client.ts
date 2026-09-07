import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'moviespinner.db');

// Resolved from the working directory rather than the module's own location.
// The same file is loaded by tsx as ESM and bundled by Next as a server module,
// and neither __dirname nor import.meta.url survives both intact.
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

export function openDb(dbPath: string = DEFAULT_DB_PATH): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Applies every migration in src/db/migrations that has not run yet, in
 * filename order, each in its own transaction.
 *
 * Foreign keys are switched off for the duration because table rebuilds (the
 * create-copy-drop-rename dance SQLite needs for anything ALTER TABLE cannot
 * express) would otherwise trip referential checks mid-migration. The pragma
 * cannot be changed inside a transaction, hence the toggling out here.
 */
export function migrate(db: Db, { verbose = false } = {}): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             name       TEXT PRIMARY KEY,
             applied_at TEXT NOT NULL
           )`);

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  const pending = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') && !applied.has(file))
    .sort();

  if (pending.length === 0) return [];

  const hadForeignKeys = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          file,
          new Date().toISOString(),
        );
      })();
      if (verbose) console.log(`  migrated ${file}`);

      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`${file} left ${violations.length} foreign key violation(s)`);
      }
    }
  } finally {
    if (hadForeignKeys) db.pragma('foreign_keys = ON');
  }

  return pending;
}

export { DEFAULT_DB_PATH, MIGRATIONS_DIR };
