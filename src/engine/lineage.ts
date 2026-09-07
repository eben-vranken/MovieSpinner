import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client';

/**
 * The hand-authored edge list from §5.
 *
 * Committed, reloaded on every run, and keyed by tmdb_id on both ends. This is
 * the one part of the project TMDB genuinely cannot supply, and the sentence in
 * each row is the difference between "1930s Germany: 0% covered" and "you love
 * Blade Runner and have never seen where it came from".
 */

export const LINEAGE_FILE = path.join(process.cwd(), 'data', 'lineage.csv');

export interface LineageLoad {
  edges: number;
  /** Distinct films an edge points at. These are also seeded into the pool. */
  targets: number[];
  problems: string[];
}

export function loadLineage(db: Db, file: string = LINEAGE_FILE): LineageLoad {
  const problems: string[] = [];
  if (!fs.existsSync(file)) {
    return { edges: 0, targets: [], problems: [`${path.basename(file)} is missing`] };
  }

  const rows = parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string | undefined>[];

  const targets = new Set<number>();
  const write = db.transaction(() => {
    db.prepare('DELETE FROM lineage_edges').run();
    const insert = db.prepare(
      `INSERT INTO lineage_edges (from_tmdb_id, to_tmdb_id, from_title, to_title, rationale)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    let count = 0;
    for (const [index, row] of rows.entries()) {
      const from = Number.parseInt(row['from_tmdb_id'] ?? '', 10);
      const to = Number.parseInt(row['to_tmdb_id'] ?? '', 10);
      const rationale = row['rationale']?.trim();
      if (!Number.isFinite(from) || !Number.isFinite(to) || !rationale) {
        problems.push(`lineage.csv row ${index + 2} is incomplete`);
        continue;
      }
      if (from === to) {
        problems.push(`lineage.csv row ${index + 2} points a film at itself`);
        continue;
      }
      insert.run(from, to, row['from_title']?.trim() ?? null, row['to_title']?.trim() ?? null, rationale);
      targets.add(to);
      count += 1;
    }
    return count;
  });

  return { edges: write(), targets: [...targets], problems };
}
