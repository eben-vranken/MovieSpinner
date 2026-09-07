import fs from 'node:fs';
import type { Db } from '../db/client';
import { LINEAGE_FILE } from './lineage';

/**
 * Writes the edge table back out to data/lineage.csv.
 *
 * The CSV is the committed artifact and every run reloads from it, so an edge
 * added in the UI that only lived in the database would vanish the next time
 * anything called loadLineage. Editing in the app and editing the file by hand
 * therefore stay the same thing.
 */
export function rewriteLineageFile(db: Db, file: string = LINEAGE_FILE): number {
  const rows = db
    .prepare(
      `SELECT from_tmdb_id, to_tmdb_id, from_title, to_title, rationale
       FROM lineage_edges ORDER BY from_title, to_title`,
    )
    .all() as {
    from_tmdb_id: number;
    to_tmdb_id: number;
    from_title: string | null;
    to_title: string | null;
    rationale: string;
  }[];

  const escape = (value: string | null): string => `"${(value ?? '').replace(/"/g, '""')}"`;
  const lines = ['from_tmdb_id,to_tmdb_id,from_title,to_title,rationale'];
  for (const row of rows) {
    lines.push(
      [
        row.from_tmdb_id,
        row.to_tmdb_id,
        escape(row.from_title),
        escape(row.to_title),
        escape(row.rationale),
      ].join(','),
    );
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return rows.length;
}
