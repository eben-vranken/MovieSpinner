import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client';

/**
 * Build step 3: what my coverage actually looks like across decade, country,
 * director and movement.
 *
 * This module only counts. The weighting that turns a count into a probability
 * lives in the engine (step 5), because the brief wants that logic readable and
 * hand-tuned in one place rather than smeared across the codebase.
 *
 * Two universes are in play, deliberately:
 *
 * - **Decade** counts all 436 watched films using the Letterboxd year, which is
 *   always present. That keeps the decade grid reproducing §2 of the brief
 *   exactly, wall and all.
 * - **Country, director and movement** can only count films with a TMDB match,
 *   so they run over 429. The seven missing are television entries and two films
 *   TMDB has never heard of. `mapped` and `total` are both reported so the gap
 *   stays visible rather than quietly changing the denominator.
 *
 * Country has two readings and both are returned. `country` is the lead country,
 * one per film, and is what gap scoring should use. `countryAny` counts every
 * production country, which is what the world map in §7 wants, because there a
 * co-production should light up each partner.
 */

export const MOVEMENTS_FILE = path.join(process.cwd(), 'data', 'movements.csv');
export const FILM_MOVEMENTS_FILE = path.join(process.cwd(), 'data', 'film-movements.csv');
export const MOVEMENT_DIRECTORS_FILE = path.join(process.cwd(), 'data', 'movement-directors.csv');

/**
 * Folds a person's name to something comparable across sources. Removing every
 * non-alphanumeric is what makes "F.W. Murnau", "Wong Kar-Wai" and
 * "Krzysztof Kieslowski" line up with however TMDB spells them.
 */
const normalizeName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export type Dimension = 'decade' | 'country' | 'director' | 'movement';

export interface Bucket {
  key: string;
  label: string;
  count: number;
}

export interface Coverage {
  total: number;
  mapped: number;
  decade: Bucket[];
  country: Bucket[];
  /** Every production country counts, so co-productions appear in each. */
  countryAny: Bucket[];
  director: Bucket[];
  movement: Bucket[];
}

export const decadeLabel = (year: number | null): string => {
  if (year === null) return 'unknown';
  if (year < 1950) return 'pre-1950';
  return `${Math.floor(year / 10) * 10}s`;
};

export const DECADE_ORDER = [
  'pre-1950',
  '1950s',
  '1960s',
  '1970s',
  '1980s',
  '1990s',
  '2000s',
  '2010s',
  '2020s',
];

interface LoadResult {
  movements: number;
  /** Tags written by hand in film-movements.csv. */
  manual: number;
  /** Tags derived from a movement's director list. */
  fromDirectors: number;
  /** Tags derived from a period (and place) rule. */
  fromPeriod: number;
  taggings: number;
  /** Director names in the CSV that no film in the database is credited to. */
  unknownDirectors: string[];
  problems: string[];
}

/**
 * Reloads the hand-curated movement taxonomy and its film tags from CSV.
 *
 * Both files are committed. §11 of the brief left movement sourcing open
 * between hand-curation, Wikipedia scraping and dropping the dimension; this is
 * the hand-curated answer, because the other two either produce tags you cannot
 * trust or throw away the most interesting axis on the dashboard.
 */
export function loadMovements(db: Db): LoadResult {
  const problems: string[] = [];

  const readCsv = (file: string): Record<string, string | undefined>[] => {
    if (!fs.existsSync(file)) {
      problems.push(`${path.basename(file)} is missing`);
      return [];
    }
    return parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), {
      columns: true,
      skip_empty_lines: true,
    }) as Record<string, string | undefined>[];
  };

  const movementRows = readCsv(MOVEMENTS_FILE);
  const tagRows = readCsv(FILM_MOVEMENTS_FILE);
  const directorRows = readCsv(MOVEMENT_DIRECTORS_FILE);
  const unknownDirectors: string[] = [];
  let fromDirectors = 0;
  let fromPeriod = 0;

  const write = db.transaction(() => {
    db.prepare('DELETE FROM movement_directors').run();
    db.prepare('DELETE FROM film_movements').run();
    db.prepare('DELETE FROM movements').run();

    const insertMovement = db.prepare(
      `INSERT INTO movements
         (slug, name, period_start, period_end, region, note, sort_order, auto_rule, rule_countries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const slugs = new Set<string>();
    const periods = new Map<string, { start: number | null; end: number | null; rule: string; countries: string[] }>();
    for (const [index, row] of movementRows.entries()) {
      const slug = row['slug']?.trim();
      const name = row['name']?.trim();
      if (!slug || !name) {
        problems.push(`movements.csv row ${index + 2} has no slug or name`);
        continue;
      }
      const num = (key: string): number | null => {
        const raw = row[key]?.trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      };
      const rule = row['auto_rule']?.trim() || 'directors';
      const countries = (row['rule_countries']?.trim() || '')
        .split(';')
        .map((code) => code.trim())
        .filter(Boolean);
      insertMovement.run(
        slug,
        name,
        num('period_start'),
        num('period_end'),
        row['region']?.trim() ?? null,
        row['note']?.trim() ?? null,
        num('sort_order') ?? index,
        rule,
        countries.join(';') || null,
      );
      slugs.add(slug);
      periods.set(slug, { start: num('period_start'), end: num('period_end'), rule, countries });
    }

    // --- hand-written film tags ---------------------------------------------
    const insertTag = db.prepare(
      `INSERT INTO film_movements (tmdb_id, movement, source) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    let manual = 0;
    for (const [index, row] of tagRows.entries()) {
      const tmdbId = Number.parseInt(row['tmdb_id']?.trim() ?? '', 10);
      const movement = row['movement']?.trim();
      if (!Number.isFinite(tmdbId) || !movement) {
        problems.push(`film-movements.csv row ${index + 2} is incomplete`);
        continue;
      }
      // An unknown slug is a typo, not a new movement. Say so rather than
      // letting a foreign key error surface from three layers down.
      if (!slugs.has(movement)) {
        problems.push(
          `film-movements.csv row ${index + 2}: "${movement}" is not in movements.csv`,
        );
        continue;
      }
      insertTag.run(tmdbId, movement, 'manual');
      manual += 1;
    }

    // --- director rules ------------------------------------------------------
    // Names are resolved against the people TMDB has actually credited, so a
    // typo or an unexpected spelling surfaces as an unknown name rather than
    // silently tagging nothing.
    const peopleByName = new Map<string, number[]>();
    for (const person of db.prepare('SELECT person_id, name FROM tmdb_people').all() as {
      person_id: number;
      name: string;
    }[]) {
      const key = normalizeName(person.name);
      peopleByName.set(key, [...(peopleByName.get(key) ?? []), person.person_id]);
    }

    const insertDirector = db.prepare(
      'INSERT INTO movement_directors (movement, name, person_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    );
    const tagByDirector = db.prepare(
      `INSERT INTO film_movements (tmdb_id, movement, source)
       SELECT t.tmdb_id, @movement, 'director'
       FROM tmdb_films t
       JOIN tmdb_film_crew c ON c.tmdb_id = t.tmdb_id AND c.job = 'Director' AND c.person_id = @personId
       WHERE t.year IS NOT NULL
         AND (@start IS NULL OR t.year >= @start)
         AND (@end IS NULL OR t.year <= @end)
       ON CONFLICT DO NOTHING`,
    );

    for (const [index, row] of directorRows.entries()) {
      const movement = row['movement']?.trim();
      const name = row['director']?.trim();
      if (!movement || !name) {
        problems.push(`movement-directors.csv row ${index + 2} is incomplete`);
        continue;
      }
      if (!slugs.has(movement)) {
        problems.push(
          `movement-directors.csv row ${index + 2}: "${movement}" is not in movements.csv`,
        );
        continue;
      }
      const ids = peopleByName.get(normalizeName(name)) ?? [];
      if (ids.length === 0) {
        insertDirector.run(movement, name, null);
        unknownDirectors.push(`${name} (${movement})`);
        continue;
      }
      const period = periods.get(movement);
      for (const personId of ids) {
        insertDirector.run(movement, name, personId);
        fromDirectors += tagByDirector.run({
          movement,
          personId,
          start: period?.start ?? null,
          end: period?.end ?? null,
        }).changes;
      }
    }

    // --- period rules --------------------------------------------------------
    const tagByPeriod = db.prepare(
      `INSERT INTO film_movements (tmdb_id, movement, source)
       SELECT t.tmdb_id, @movement, 'period' FROM tmdb_films t
       WHERE t.year IS NOT NULL
         AND (@start IS NULL OR t.year >= @start)
         AND (@end IS NULL OR t.year <= @end)
       ON CONFLICT DO NOTHING`,
    );
    for (const [slug, period] of periods) {
      if (period.rule !== 'period') continue;
      if (period.countries.length === 0) {
        fromPeriod += tagByPeriod.run({ movement: slug, start: period.start, end: period.end }).changes;
        continue;
      }
      const placeholders = period.countries.map(() => '?').join(',');
      fromPeriod += db
        .prepare(
          `INSERT INTO film_movements (tmdb_id, movement, source)
           SELECT t.tmdb_id, ?, 'period' FROM tmdb_films t
           WHERE t.year IS NOT NULL AND t.year >= ? AND t.year <= ?
             AND t.origin_country IN (${placeholders})
           ON CONFLICT DO NOTHING`,
        )
        .run(slug, period.start, period.end, ...period.countries).changes;
    }

    return manual;
  });

  const manual = write();
  return {
    movements: movementRows.length,
    manual,
    fromDirectors,
    fromPeriod,
    taggings: manual + fromDirectors + fromPeriod,
    unknownDirectors,
    problems,
  };
}

const tally = (rows: { key: string; label?: string | null }[]): Bucket[] => {
  const counts = new Map<string, Bucket>();
  for (const row of rows) {
    const existing = counts.get(row.key);
    if (existing) existing.count += 1;
    else counts.set(row.key, { key: row.key, label: row.label ?? row.key, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

export function computeCoverage(db: Db): Coverage {
  // Decade runs over every watched film, matched or not, on the Letterboxd year.
  const watchedYears = db
    .prepare('SELECT f.year FROM watched w JOIN films f ON f.id = w.film_id')
    .all() as { year: number | null }[];

  const decadeCounts = new Map(DECADE_ORDER.map((key) => [key, 0]));
  for (const row of watchedYears) {
    const key = decadeLabel(row.year);
    decadeCounts.set(key, (decadeCounts.get(key) ?? 0) + 1);
  }
  const decade: Bucket[] = [...decadeCounts].map(([key, count]) => ({ key, label: key, count }));

  const mapped = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM watched w
         JOIN film_matches m ON m.film_id = w.film_id
         WHERE m.tmdb_id IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;

  // The lead country, one per film, from TMDB's origin_country. Not the first
  // production country: TMDB sorts those alphabetically, which files The Witch
  // under Brazil and Blade Runner 2049 under Canada.
  const primaryCountries = db
    .prepare(
      `SELECT t.origin_country AS key FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id
       WHERE t.origin_country IS NOT NULL`,
    )
    .all() as { key: string }[];

  const allCountries = db
    .prepare(
      `SELECT c.country AS key FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_film_countries c ON c.tmdb_id = m.tmdb_id`,
    )
    .all() as { key: string }[];

  const directors = db
    .prepare(
      `SELECT cr.person_id AS key, p.name AS label FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_film_crew cr ON cr.tmdb_id = m.tmdb_id AND cr.job = 'Director'
       JOIN tmdb_people p ON p.person_id = cr.person_id`,
    )
    .all() as { key: number; label: string }[];

  const movementHits = db
    .prepare(
      `SELECT fm.movement AS key FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN film_movements fm ON fm.tmdb_id = m.tmdb_id`,
    )
    .all() as { key: string }[];

  // Every movement gets a row even at zero, because on this dashboard a zero is
  // the most informative cell there is.
  const counted = new Map(tally(movementHits).map((bucket) => [bucket.key, bucket.count]));
  const movement = (
    db
      .prepare('SELECT slug, name FROM movements ORDER BY sort_order, name')
      .all() as { slug: string; name: string }[]
  ).map((row) => ({ key: row.slug, label: row.name, count: counted.get(row.slug) ?? 0 }));

  return {
    total: watchedYears.length,
    mapped,
    decade,
    country: tally(primaryCountries),
    countryAny: tally(allCountries),
    director: tally(directors.map((row) => ({ key: String(row.key), label: row.label }))),
    movement,
  };
}

/**
 * Writes today's coverage into the snapshot tables, replacing any snapshot
 * already taken today. §7 of the brief wants change over time, not just
 * position, and that only works if snapshotting starts long before the
 * dashboard does.
 */
export function snapshotCoverage(db: Db, coverage: Coverage, on = new Date()): string {
  const takenOn = on.toISOString().slice(0, 10);

  db.transaction(() => {
    db.prepare('DELETE FROM coverage_snapshots WHERE taken_on = ?').run(takenOn);
    const insert = db.prepare(
      'INSERT INTO coverage_snapshots (taken_on, dimension, bucket, count) VALUES (?, ?, ?, ?)',
    );
    const dimensions: [Dimension, Bucket[]][] = [
      ['decade', coverage.decade],
      ['country', coverage.country],
      ['director', coverage.director],
      ['movement', coverage.movement],
    ];
    for (const [dimension, buckets] of dimensions) {
      for (const bucket of buckets) {
        insert.run(takenOn, dimension, dimension === 'director' ? bucket.label : bucket.key, bucket.count);
      }
    }
    db.prepare(
      `INSERT INTO coverage_snapshot_meta (taken_on, watched_total, watched_mapped, taken_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (taken_on) DO UPDATE SET
         watched_total = excluded.watched_total,
         watched_mapped = excluded.watched_mapped,
         taken_at = excluded.taken_at`,
    ).run(takenOn, coverage.total, coverage.mapped, new Date().toISOString());
  })();

  return takenOn;
}
