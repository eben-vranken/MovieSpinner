import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the candidate pool comes from.
 *
 * Two of the three sources are scraped web pages, so both are cached to disk on
 * first fetch. A personal tool should not hammer someone else's site every time
 * it rebuilds a table, and it means the pool can be rebuilt offline.
 */

const CACHE_DIR = path.join(process.cwd(), 'data', 'pool-cache');
export const REGIONS_FILE = path.join(process.cwd(), 'data', 'pool-regions.csv');
export const MOVEMENT_DIRECTORS_FILE = path.join(process.cwd(), 'data', 'movement-directors.csv');

export interface SourceEntry {
  position: number | null;
  title: string;
  year: number | null;
  /** TSPDT publishes these, which turns matching into an exact join. */
  imdbId?: string;
  /**
   * Criterion's list mixes single films with box sets ("Eclipse Series 42:
   * Silent Ozu", "The Koker Trilogy"). A set is not a film and will never match,
   * so it is marked here rather than counted as a matching failure.
   */
  isSet?: boolean;
}

export interface RegionConfig {
  country: string;
  name: string;
  minVotes: number;
  limit: number;
  note: string | null;
}

async function fetchCached(url: string, file: string, refresh: boolean): Promise<string> {
  const cacheFile = path.join(CACHE_DIR, file);
  if (!refresh && fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (MovieSpinner, personal use)' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = await response.text();
  fs.writeFileSync(cacheFile, body);
  return body;
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const TSPDT_URL = 'https://theyshootpictures.com/gf1000_all1000films_table.php';

/**
 * They Shoot Pictures Don't They, the 1000 Greatest Films.
 *
 * The visible page loads its table from a separate PHP endpoint, and that table
 * carries an IMDb id per row. That is the whole reason this list resolves
 * perfectly while Criterion needs title matching.
 */
export async function fetchTspdt(refresh = false): Promise<SourceEntry[]> {
  const html = await fetchCached(TSPDT_URL, 'tspdt.html', refresh);
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];

  return rows.flatMap((row) => {
    const cells = (row.match(/<td>[\s\S]*?<\/td>/g) ?? []).map(stripTags);
    // Pos, previous rank, title, director, year, country, mins, imdb, dirlink
    const [position, , title, , year, , , imdbId] = cells;
    if (!title || !position) return [];
    const rank = Number.parseInt(position, 10);
    return [
      {
        position: Number.isFinite(rank) ? rank : null,
        title,
        year: Number.parseInt(year ?? '', 10) || null,
        imdbId: /^tt\d+$/.test(imdbId ?? '') ? imdbId : undefined,
      },
    ];
  });
}

export const CRITERION_URL = 'https://www.criterion.com/shop/browse/list?sort=spine_number';

/** The Criterion Collection, ordered by spine number. No external ids on offer. */
export async function fetchCriterion(refresh = false): Promise<SourceEntry[]> {
  const html = await fetchCached(CRITERION_URL, 'criterion.html', refresh);
  const rows = html.match(/<tr class="gridFilm"[\s\S]*?<\/tr>/g) ?? [];

  return rows.flatMap((row) => {
    const cell = (className: string): string | null => {
      const match = row.match(new RegExp(`<td class="${className}">([\\s\\S]*?)</td>`));
      return match?.[1] ? stripTags(match[1]) : null;
    };
    const title = cell('g-title');
    if (!title) return [];
    const spine = Number.parseInt(cell('g-spine') ?? '', 10);
    const year = Number.parseInt(cell('g-year') ?? '', 10) || null;
    return [
      {
        position: Number.isFinite(spine) ? spine : null,
        title,
        year,
        // Every single film in this list carries a year and every box set omits
        // one, which is a cleaner signal than pattern-matching the titles.
        isSet: year === null,
      },
    ];
  });
}

export interface MovementDirectors {
  slug: string;
  name: string;
  start: number | null;
  end: number | null;
  directors: string[];
}

/**
 * Pairs each movement with its directors and its period.
 *
 * The period comes from the movements table rather than the CSV, so the two
 * files cannot drift: a movement's dates are defined in exactly one place.
 */
export function readMovementDirectors(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  file: string = MOVEMENT_DIRECTORS_FILE,
): MovementDirectors[] {
  if (!fs.existsSync(file)) return [];

  const rows = parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string | undefined>[];

  const byMovement = new Map<string, string[]>();
  for (const row of rows) {
    const movement = row['movement']?.trim();
    const director = row['director']?.trim();
    if (!movement || !director) continue;
    byMovement.set(movement, [...(byMovement.get(movement) ?? []), director]);
  }

  const meta = db
    .prepare('SELECT slug, name, period_start, period_end FROM movements')
    .all() as { slug: string; name: string; period_start: number | null; period_end: number | null }[];
  const metaBySlug = new Map(meta.map((m) => [m.slug, m]));

  return [...byMovement].flatMap(([slug, directors]) => {
    const info = metaBySlug.get(slug);
    if (!info) return [];
    return [{ slug, name: info.name, start: info.period_start, end: info.period_end, directors }];
  });
}

/** The hand-tuned regional seeding config. */
export function readRegions(file: string = REGIONS_FILE): RegionConfig[] {
  const rows = parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string | undefined>[];

  return rows.flatMap((row) => {
    const country = row['country']?.trim();
    if (!country) return [];
    return [
      {
        country,
        name: row['name']?.trim() || country,
        minVotes: Number.parseInt(row['min_votes'] ?? '', 10) || 10,
        limit: Number.parseInt(row['limit'] ?? '', 10) || 25,
        note: row['note']?.trim() || null,
      },
    ];
  });
}
