import { migrate, openDb } from '../db/client';
import type { Db } from '../db/client';

/**
 * One database handle for the whole server process.
 *
 * better-sqlite3 is synchronous and Next re-evaluates modules on every hot
 * reload, so the handle is stashed on globalThis to avoid piling up open
 * connections during development.
 */
const globalForDb = globalThis as unknown as { moviespinnerDb?: Db };

export function db(): Db {
  if (!globalForDb.moviespinnerDb) {
    const handle = openDb();
    migrate(handle);
    globalForDb.moviespinnerDb = handle;
  }
  return globalForDb.moviespinnerDb;
}

// Re-exported so server components can keep reaching for it here. The
// implementation moved to a database-free module the client bundle can import.
export { posterUrl } from './poster';

export const today = (): string => new Date().toISOString().slice(0, 10);
