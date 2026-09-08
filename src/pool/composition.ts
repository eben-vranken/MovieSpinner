import type { Db } from '../db/client';

/**
 * What the pool is actually made of.
 *
 * Step 4 produced a pool that scored well on every coverage measure and was
 * badly distributed underneath: 43% of it was 38 complete filmographies, so a
 * probabilistic draw met Umberto Lenzi five times for every Robert Bresson.
 * Coverage totals cannot see that. This can, which is why it is a report rather
 * than a one-off query.
 */

export interface Composition {
  total: number;
  bySource: { kind: string; films: number }[];
  auteurOnly: number;
  auteurDirectors: number;
  perDirector: { name: string; personId: number; total: number; auteurOnly: number }[];
  byMovement: { slug: string; name: string; films: number }[];
  byRegion: { label: string; films: number }[];
  untagged: number;
  zeroVotes: number;
  underFortyFive: number;
  underHundredVotes: number;
  listCount: { count: number; films: number }[];
  watchedLeaks: number;
}

/** The regions pool-regions.csv deliberately seeds, grouped as §6 frames them. */
export const SEEDED_REGIONS: [string, string[]][] = [
  ['India', ['IN']],
  ['Iran', ['IR']],
  ['Africa', ['SN', 'ML', 'BF', 'DZ', 'MA', 'EG', 'TN', 'ZA', 'NG', 'ET', 'TD', 'MR', 'GH', 'KE', 'AO', 'CM', 'CI']],
  ['Latin America', ['AR', 'BR', 'MX', 'CL', 'CO', 'PE', 'CU', 'UY', 'VE', 'BO', 'EC', 'GT']],
  ['Southeast Asia', ['TH', 'PH', 'ID', 'VN', 'MY', 'SG', 'KH', 'MM']],
  ['East Asia beyond Japan', ['CN', 'HK', 'TW', 'KR']],
  ['Middle East beyond Iran', ['TR', 'LB', 'IL', 'SY', 'IQ', 'JO', 'AE', 'PS', 'QA']],
  ['Eastern Europe', ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'RS', 'HR', 'XC', 'YU', 'SU', 'RU', 'EE', 'BA']],
  ['Nordics', ['SE', 'NO', 'DK', 'FI', 'IS']],
];

/** Movements where a film under 45 minutes is the normal form, not an anomaly. */
export const SHORT_FORM_MOVEMENTS = new Set([
  'silent-era',
  'surrealism',
  'soviet-montage',
  'french-impressionism',
]);

export function composition(db: Db): Composition {
  const scalar = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;
  const rows = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

  // "auteur only" means the auteur lists are the sole reason the film is here.
  const AUTEUR_ONLY = `p.kinds = 'auteur'`;

  const perDirector = rows<{ name: string; person_id: number; total: number; auteur_only: number }>(
    `SELECT pe.name, pe.person_id,
            COUNT(*) AS total,
            SUM(CASE WHEN ${AUTEUR_ONLY} THEN 1 ELSE 0 END) AS auteur_only
     FROM pool p
     JOIN tmdb_film_crew c ON c.tmdb_id = p.tmdb_id AND c.job = 'Director'
     JOIN tmdb_people pe ON pe.person_id = c.person_id
     GROUP BY pe.person_id
     ORDER BY total DESC`,
  );

  const byCountry = new Map(
    rows<{ c: string; n: number }>(
      `SELECT t.origin_country AS c, COUNT(*) AS n FROM pool p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.origin_country IS NOT NULL GROUP BY c`,
    ).map((row) => [row.c, row.n]),
  );

  return {
    total: scalar('SELECT COUNT(*) AS n FROM pool'),
    bySource: rows<{ kind: string; films: number }>(
      `SELECT l.kind, COUNT(DISTINCT e.tmdb_id) AS films
       FROM pool_list_entries e
       JOIN pool_lists l ON l.slug = e.list_slug
       JOIN pool p ON p.tmdb_id = e.tmdb_id
       GROUP BY l.kind ORDER BY films DESC`,
    ),
    auteurOnly: scalar(`SELECT COUNT(*) AS n FROM pool p WHERE ${AUTEUR_ONLY}`),
    auteurDirectors: scalar(
      `SELECT COUNT(DISTINCT c.person_id) AS n FROM pool p
       JOIN tmdb_film_crew c ON c.tmdb_id = p.tmdb_id AND c.job = 'Director'
       WHERE ${AUTEUR_ONLY}`,
    ),
    perDirector: perDirector.map((row) => ({
      name: row.name,
      personId: row.person_id,
      total: row.total,
      auteurOnly: row.auteur_only,
    })),
    byMovement: rows<{ slug: string; name: string; films: number }>(
      `SELECT m.slug, m.name,
              (SELECT COUNT(*) FROM pool p JOIN film_movements fm ON fm.tmdb_id = p.tmdb_id
               WHERE fm.movement = m.slug) AS films
       FROM movements m ORDER BY m.sort_order`,
    ),
    byRegion: SEEDED_REGIONS.map(([label, codes]) => ({
      label,
      films: codes.reduce((sum, code) => sum + (byCountry.get(code) ?? 0), 0),
    })),
    untagged: scalar(
      `SELECT COUNT(*) AS n FROM pool p
       WHERE NOT EXISTS (SELECT 1 FROM film_movements fm WHERE fm.tmdb_id = p.tmdb_id)`,
    ),
    zeroVotes: scalar(
      `SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE COALESCE(t.vote_count, 0) = 0`,
    ),
    underFortyFive: scalar(
      `SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.runtime > 0 AND t.runtime < 45`,
    ),
    underHundredVotes: scalar(
      `SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE COALESCE(t.vote_count, 0) < 100`,
    ),
    listCount: rows<{ count: number; films: number }>(
      'SELECT list_count AS count, COUNT(*) AS films FROM pool GROUP BY list_count ORDER BY count',
    ),
    watchedLeaks: scalar(
      `SELECT COUNT(*) AS n FROM pool p
       WHERE p.tmdb_id IN (SELECT m.tmdb_id FROM watched w
                           JOIN film_matches m ON m.film_id = w.film_id
                           WHERE m.tmdb_id IS NOT NULL)`,
    ),
  };
}
