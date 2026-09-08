import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the mutable state lives.
 *
 * Everything the app owns is in one directory: the SQLite file, the curated
 * CSVs, and the two response caches. Locally that is `./data`. On a host it is
 * a mounted volume, because this app writes on nearly every request and a
 * read-only filesystem cannot run it.
 *
 * The CSVs are shipped inside the image at `seed-data/` and copied across on
 * first boot, so a fresh volume comes up with the curated movement, lineage and
 * override files already in place rather than empty.
 */

export const dataDir = (): string =>
  process.env['MOVIESPINNER_DATA_DIR']?.trim() || path.join(process.cwd(), 'data');

export const dataPath = (...segments: string[]): string => path.join(dataDir(), ...segments);

/** Files that ship with the image and must exist before anything reads them. */
export const SEEDED_FILES = [
  'tmdb-overrides.csv',
  'movements.csv',
  'film-movements.csv',
  'movement-directors.csv',
  'pool-regions.csv',
  'lineage.csv',
];

/**
 * Copies any missing curated file from the image into the data directory.
 * Never overwrites: an edge added through the lineage editor lives in the
 * volume's copy and must survive a redeploy.
 */
export function seedDataDir(seedDir = path.join(process.cwd(), 'seed-data')): string[] {
  if (!fs.existsSync(seedDir)) return [];
  const target = dataDir();
  fs.mkdirSync(target, { recursive: true });

  const copied: string[] = [];
  for (const name of SEEDED_FILES) {
    const from = path.join(seedDir, name);
    const to = path.join(target, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copied.push(name);
    }
  }
  return copied;
}
