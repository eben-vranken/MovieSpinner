import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a Letterboxd data export (the zip you get from
 * letterboxd.com/settings/data/) into typed rows. No database concerns here.
 */

/** The entries this importer reads, in a fixed order (used for hashing too). */
export const EXPORT_FILES = [
  'profile.csv',
  'watched.csv',
  'ratings.csv',
  'diary.csv',
  'watchlist.csv',
  'likes/films.csv',
] as const;

export interface FilmRef {
  /** Stable film permalink, e.g. https://boxd.it/azpY */
  lbUri: string;
  name: string;
  year: number | null;
}

export interface DatedFilmRow extends FilmRef {
  date: string | null;
}

export interface RatingRow extends DatedFilmRow {
  rating: number;
}

export interface DiaryRow {
  /** Permalink of the diary *entry*, not the film. */
  entryUri: string;
  name: string;
  year: number | null;
  loggedDate: string;
  watchedDate: string;
  rating: number | null;
  rewatch: boolean;
  tags: string | null;
}

export interface LetterboxdExport {
  sourceFile: string;
  username: string | null;
  /** UTC timestamp encoded in the export filename, when present. */
  exportedAt: string | null;
  watched: DatedFilmRow[];
  ratings: RatingRow[];
  likes: DatedFilmRow[];
  watchlist: DatedFilmRow[];
  diary: DiaryRow[];
}

type RawRow = Record<string, string | undefined>;

/** Reads either a Letterboxd export zip or an already-extracted directory. */
interface ExportSource {
  read(entry: string): string | null;
}

function zipSource(zipPath: string): ExportSource {
  const zip = new AdmZip(zipPath);
  const byName = new Map<string, AdmZip.IZipEntry>();
  for (const entry of zip.getEntries()) {
    byName.set(entry.entryName.split('\\').join('/'), entry);
  }
  return {
    read: (entry) => byName.get(entry)?.getData().toString('utf8') ?? null,
  };
}

function dirSource(dir: string): ExportSource {
  return {
    read: (entry) => {
      const file = path.join(dir, entry);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    },
  };
}

function parseCsv(text: string | null): RawRow[] {
  if (text === null) return [];
  return parse(text.replace(/^\uFEFF/, ''), {
    columns: true,
    skip_empty_lines: true,
    trim: false,
    relax_column_count: true,
  }) as RawRow[];
}

function str(row: RawRow, column: string): string | null {
  const value = row[column]?.trim();
  return value ? value : null;
}

function int(row: RawRow, column: string): number | null {
  const value = str(row, column);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(row: RawRow, column: string): number | null {
  const value = str(row, column);
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Letterboxd names exports like letterboxd-user-2026-09-07-18-31-utc.zip */
function exportedAtFromFilename(file: string): string | null {
  const match = path
    .basename(file)
    .match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-utc/i);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:00Z`;
}

function toFilmRows(rows: RawRow[]): DatedFilmRow[] {
  return rows.flatMap((row) => {
    const lbUri = str(row, 'Letterboxd URI');
    const name = str(row, 'Name');
    // A row without a permalink or a title has no identity we can key on.
    if (!lbUri || !name) return [];
    return [{ lbUri, name, year: int(row, 'Year'), date: str(row, 'Date') }];
  });
}

export function readExport(source: string): LetterboxdExport {
  const stat = fs.statSync(source);
  const reader = stat.isDirectory() ? dirSource(source) : zipSource(source);

  const profile = parseCsv(reader.read('profile.csv'));

  const ratings: RatingRow[] = parseCsv(reader.read('ratings.csv')).flatMap((row) => {
    const lbUri = str(row, 'Letterboxd URI');
    const name = str(row, 'Name');
    const rating = num(row, 'Rating');
    if (!lbUri || !name || rating === null) return [];
    return [{ lbUri, name, year: int(row, 'Year'), date: str(row, 'Date'), rating }];
  });

  const diary: DiaryRow[] = parseCsv(reader.read('diary.csv')).flatMap(
    (row) => {
      const entryUri = str(row, 'Letterboxd URI');
      const name = str(row, 'Name');
      const watchedDate = str(row, 'Watched Date');
      const loggedDate = str(row, 'Date');
      if (!entryUri || !name || !watchedDate || !loggedDate) return [];
      return [
        {
          entryUri,
          name,
          year: int(row, 'Year'),
          loggedDate,
          watchedDate,
          rating: num(row, 'Rating'),
          rewatch: str(row, 'Rewatch')?.toLowerCase() === 'yes',
          tags: str(row, 'Tags'),
        },
      ];
    },
  );

  return {
    sourceFile: path.resolve(source),
    username: profile[0] ? str(profile[0], 'Username') : null,
    exportedAt: exportedAtFromFilename(source),
    watched: toFilmRows(parseCsv(reader.read('watched.csv'))),
    ratings,
    likes: toFilmRows(parseCsv(reader.read('likes/films.csv'))),
    watchlist: toFilmRows(parseCsv(reader.read('watchlist.csv'))),
    diary,
  };
}
