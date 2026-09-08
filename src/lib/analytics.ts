import { tmdbConfig } from '../config';
import { computeCoverage, decadeLabel, loadMovements, DECADE_ORDER } from '../coverage';
import { REGION_GROUPS } from './regions';
import { db } from './db';

/**
 * Every number the single page draws, loaded in one pass.
 *
 * The page is one route, so it is also one read of the database. Each block
 * below is a panel; nothing here is shared with the engine, because a chart
 * that quietly recomputed a weight would be a second, unreviewed copy of the
 * scoring rules.
 *
 * Two universes are in play throughout and it matters which is which. Decade
 * counts every watched film using the Letterboxd year, which is always there.
 * Everything keyed on country, director, language or runtime can only count
 * films with a TMDB match, so those run over a smaller set. Both totals are
 * returned so the gap stays visible rather than silently changing denominators.
 */

export interface Cell {
  key: string;
  label: string;
  value: number;
}

/** A bucket compared against what the pool could supply. */
export interface Against {
  key: string;
  label: string;
  watched: number;
  pool: number;
  /** Watched share minus pool share, in points. Positive means over-represented. */
  skew: number;
}

export interface Analytics {
  totals: {
    watched: number;
    mapped: number;
    rated: number;
    logged: number;
    countries: number;
    directors: number;
    movementsTouched: number;
    movementsTotal: number;
    poolSize: number;
    watchlist: number;
    daysPlayed: number;
    filmsOffered: number;
    chosen: number;
    watchedFromSlate: number;
    lockedIn: number;
    region: string;
  };
  decades: { key: string; watched: number; then: number; pool: number }[];
  decadeSkew: Against[];
  /**
   * Every country either set touches, watched count beside pool count. The
   * pool column is what makes the map clickable everywhere it has something to
   * say: a country you have seen nothing from is exactly the one worth opening.
   */
  countries: { code: string; name: string; count: number; pool: number }[];
  regions: {
    label: string;
    watched: number;
    pool: number;
    countriesSeen: number;
    countriesAvailable: number;
  }[];
  /** Decade down the side, region across the top. The densest panel on the page. */
  regionByDecade: { region: string; cells: { decade: string; value: number }[] }[];
  movements: {
    slug: string;
    name: string;
    period: string;
    watched: number;
    then: number;
    pool: number;
  }[];
  directorDepth: { films: number; directors: number }[];
  topDirectors: { name: string; count: number }[];
  ratings: { rating: number; count: number }[];
  cadence: { month: string; films: number }[];
  runtime: { key: string; label: string; watched: number; pool: number }[];
  poolSources: Cell[];
  poolListCount: { lists: number; films: number }[];
  poolVotes: { key: string; label: string; films: number }[];
  poolDropped: Cell[];
  genres: Against[];
  languages: Against[];
  availability: { key: string; label: string; films: number }[];
  snapshots: { takenOn: string; watched: number }[];
  slateLog: {
    date: string;
    kind: string;
    films: {
      tmdbId: number;
      title: string;
      year: number | null;
      chosen: boolean;
      manual: boolean;
    }[];
    status: string | null;
  }[];
  passedOver: { tmdbId: number; title: string; year: number | null; times: number }[];
  lineage: {
    fromTmdbId: number;
    toTmdbId: number;
    fromTitle: string | null;
    toTitle: string | null;
    rationale: string;
    rating: number | null;
    inPool: boolean;
    offered: boolean;
  }[];
  issues: { ingest: number; unresolved: number; capOverrides: number; excluded: number };
}

export const countryName = (code: string): string => {
  if (code === 'XC') return 'Czechoslovakia';
  if (code === 'SU') return 'Soviet Union';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * TMDB uses a handful of codes Intl does not recognise. "cn" is theirs for
 * Cantonese, which is not an ISO language code at all -- left alone it renders
 * as the bare string "cn" next to Japanese and Persian, which looks like a bug
 * rather than the upstream quirk it is.
 */
const LANGUAGE_ALIASES: Record<string, string> = { cn: 'Cantonese', xx: 'No dialogue' };

export const languageName = (code: string): string => {
  const alias = LANGUAGE_ALIASES[code];
  if (alias) return alias;
  try {
    return LANGUAGE_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
};

/** Runtime bands. Under 45 is the short-film cut the pool shaper already uses. */
const RUNTIME_BANDS: [string, string, number, number][] = [
  ['short', 'under 45m', 0, 44],
  ['brief', '45–74m', 45, 74],
  ['normal', '75–104m', 75, 104],
  ['long', '105–134m', 105, 134],
  ['longer', '135–179m', 135, 179],
  ['epic', '3 hours +', 180, 100000],
];

/** Vote-count bands, log-spaced, because findability is a log curve in the engine. */
const VOTE_BANDS: [string, string, number, number][] = [
  ['none', 'no votes', 0, 0],
  ['tiny', '1–49', 1, 49],
  ['small', '50–199', 50, 199],
  ['some', '200–999', 200, 999],
  ['known', '1k–9.9k', 1000, 9999],
  ['famous', '10k +', 10000, 100000000],
];

const share = (value: number, total: number): number => (total === 0 ? 0 : (value / total) * 100);

export function loadAnalytics(): Analytics {
  const handle = db();
  loadMovements(handle);
  const coverage = computeCoverage(handle);
  const { region } = tmdbConfig();

  const scalar = (sql: string, ...args: unknown[]): number =>
    (handle.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;
  const rows = <T>(sql: string, ...args: unknown[]): T[] => handle.prepare(sql).all(...args) as T[];
  const toMap = (list: { k: string; n: number }[]): Map<string, number> =>
    new Map(list.map((row) => [row.k, row.n]));

  // --- the "then" column ----------------------------------------------------
  // The earliest snapshot. With one snapshot on file this equals today and the
  // deltas render as nothing, which is correct: there is no trend yet.
  const earliest = handle
    .prepare('SELECT taken_on FROM coverage_snapshot_meta ORDER BY taken_on LIMIT 1')
    .get() as { taken_on: string } | undefined;

  const thenOf = (dimension: string): Map<string, number> =>
    new Map(
      earliest
        ? rows<{ bucket: string; count: number }>(
            'SELECT bucket, count FROM coverage_snapshots WHERE taken_on = ? AND dimension = ?',
            earliest.taken_on,
            dimension,
          ).map((row) => [row.bucket, row.count])
        : [],
    );

  // --- decade ---------------------------------------------------------------
  const poolByDecade = toMap(
    rows<{ k: string; n: number }>(
      `SELECT CASE WHEN t.year < 1950 THEN 'pre-1950'
                   ELSE CAST((t.year / 10) * 10 AS TEXT) || 's' END AS k,
              COUNT(*) AS n
       FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.year IS NOT NULL GROUP BY k`,
    ),
  );
  const thenDecade = thenOf('decade');
  const watchedByDecade = new Map(coverage.decade.map((bucket) => [bucket.key, bucket.count]));

  const poolTotal = scalar('SELECT COUNT(*) AS n FROM pool');
  const poolDatedTotal = [...poolByDecade.values()].reduce((sum, n) => sum + n, 0);

  const decades = DECADE_ORDER.map((key) => ({
    key,
    watched: watchedByDecade.get(key) ?? 0,
    then: thenDecade.get(key) ?? 0,
    pool: poolByDecade.get(key) ?? 0,
  }));

  // Share against share, not count against count. The pool is ten times the
  // size of the watched set, so raw counts on one axis would say nothing except
  // that the pool is bigger.
  const decadeSkew: Against[] = decades.map((row) => ({
    key: row.key,
    label: row.key,
    watched: row.watched,
    pool: row.pool,
    skew: share(row.watched, coverage.total) - share(row.pool, poolDatedTotal),
  }));

  // --- country and region ---------------------------------------------------
  const poolByCountry = toMap(
    rows<{ k: string; n: number }>(
      `SELECT t.origin_country AS k, COUNT(*) AS n FROM pool p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.origin_country IS NOT NULL GROUP BY k`,
    ),
  );
  const watchedByCountry = new Map(coverage.country.map((bucket) => [bucket.key, bucket.count]));

  const regions = REGION_GROUPS.map(([label, codes]) => ({
    label,
    watched: codes.reduce((sum, code) => sum + (watchedByCountry.get(code) ?? 0), 0),
    pool: codes.reduce((sum, code) => sum + (poolByCountry.get(code) ?? 0), 0),
    countriesSeen: codes.filter((code) => (watchedByCountry.get(code) ?? 0) > 0).length,
    countriesAvailable: codes.filter((code) => (poolByCountry.get(code) ?? 0) > 0).length,
  }));

  // Every watched film as (country, decade), folded into the region groups. The
  // matrix is the one view that shows *when* a region was covered, which is
  // usually the actual shape of a blind spot: plenty of 1990s Japan, no 1950s.
  const watchedPairs = rows<{ country: string; year: number | null }>(
    `SELECT t.origin_country AS country, t.year FROM watched w
     JOIN film_matches m ON m.film_id = w.film_id
     JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id
     WHERE t.origin_country IS NOT NULL`,
  );
  const regionOf = new Map<string, string>();
  for (const [label, codes] of REGION_GROUPS) for (const code of codes) regionOf.set(code, label);

  const matrix = new Map<string, Map<string, number>>();
  for (const pair of watchedPairs) {
    const label = regionOf.get(pair.country) ?? 'Elsewhere';
    const decade = decadeLabel(pair.year);
    const row = matrix.get(label) ?? new Map<string, number>();
    row.set(decade, (row.get(decade) ?? 0) + 1);
    matrix.set(label, row);
  }
  const regionByDecade = [...REGION_GROUPS.map(([label]) => label), 'Elsewhere'].map((label) => ({
    region: label,
    cells: DECADE_ORDER.map((decade) => ({
      decade,
      value: matrix.get(label)?.get(decade) ?? 0,
    })),
  }));

  // --- movements ------------------------------------------------------------
  const poolByMovement = toMap(
    rows<{ k: string; n: number }>(
      `SELECT fm.movement AS k, COUNT(*) AS n FROM pool p
       JOIN film_movements fm ON fm.tmdb_id = p.tmdb_id GROUP BY k`,
    ),
  );
  const thenMovement = thenOf('movement');
  const movementNow = new Map(coverage.movement.map((bucket) => [bucket.key, bucket.count]));

  const movements = rows<{
    slug: string;
    name: string;
    period_start: number | null;
    period_end: number | null;
  }>('SELECT slug, name, period_start, period_end FROM movements ORDER BY sort_order').map(
    (row) => ({
      slug: row.slug,
      name: row.name,
      period: `${row.period_start ?? '?'}–${row.period_end ?? '?'}`,
      watched: movementNow.get(row.slug) ?? 0,
      then: thenMovement.get(row.slug) ?? 0,
      pool: poolByMovement.get(row.slug) ?? 0,
    }),
  );

  // --- directors ------------------------------------------------------------
  const depth = new Map<number, number>();
  for (const bucket of coverage.director) {
    depth.set(bucket.count, (depth.get(bucket.count) ?? 0) + 1);
  }

  // --- ratings and cadence --------------------------------------------------
  const ratings = rows<{ rating: number; n: number }>(
    'SELECT rating, COUNT(*) AS n FROM ratings GROUP BY rating ORDER BY rating',
  ).map((row) => ({ rating: row.rating, count: row.n }));

  // watched_date is the night it was seen; logged_date is when it was typed in.
  // The former is the one that describes a viewing habit.
  const cadence = rows<{ month: string; n: number }>(
    `SELECT substr(COALESCE(watched_date, logged_date), 1, 7) AS month, COUNT(*) AS n
     FROM diary_entries
     WHERE COALESCE(watched_date, logged_date) IS NOT NULL
     GROUP BY month ORDER BY month`,
  ).map((row) => ({ month: row.month, films: row.n }));

  // --- runtime --------------------------------------------------------------
  const bandCounts = (sql: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows<{ runtime: number }>(sql)) {
      const band = RUNTIME_BANDS.find(([, , lo, hi]) => row.runtime >= lo && row.runtime <= hi);
      if (band) counts.set(band[0], (counts.get(band[0]) ?? 0) + 1);
    }
    return counts;
  };
  const watchedRuntime = bandCounts(
    `SELECT t.runtime FROM watched w JOIN film_matches m ON m.film_id = w.film_id
     JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id WHERE t.runtime > 0`,
  );
  const poolRuntime = bandCounts(
    `SELECT t.runtime FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE t.runtime > 0`,
  );
  const runtime = RUNTIME_BANDS.map(([key, label]) => ({
    key,
    label,
    watched: watchedRuntime.get(key) ?? 0,
    pool: poolRuntime.get(key) ?? 0,
  }));

  // --- pool shape -----------------------------------------------------------
  const poolSources = rows<{ kind: string; n: number }>(
    `SELECT l.kind, COUNT(DISTINCT e.tmdb_id) AS n
     FROM pool_list_entries e
     JOIN pool_lists l ON l.slug = e.list_slug
     JOIN pool p ON p.tmdb_id = e.tmdb_id
     GROUP BY l.kind ORDER BY n DESC`,
  ).map((row) => ({ key: row.kind, label: row.kind, value: row.n }));

  const poolListCount = rows<{ lists: number; n: number }>(
    'SELECT list_count AS lists, COUNT(*) AS n FROM pool GROUP BY lists ORDER BY lists',
  ).map((row) => ({ lists: row.lists, films: row.n }));

  const poolVoteRows = rows<{ votes: number }>(
    `SELECT COALESCE(t.vote_count, 0) AS votes FROM pool p
     JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id`,
  );
  const poolVotes = VOTE_BANDS.map(([key, label, lo, hi]) => ({
    key,
    label,
    films: poolVoteRows.filter((row) => row.votes >= lo && row.votes <= hi).length,
  }));

  const poolDropped = rows<{ reason: string; n: number }>(
    'SELECT reason, COUNT(*) AS n FROM pool_dropped GROUP BY reason ORDER BY n DESC',
  ).map((row) => ({ key: row.reason, label: row.reason, value: row.n }));

  // --- genres and languages -------------------------------------------------
  const watchedGenres = toMap(
    rows<{ k: string; n: number }>(
      `SELECT g.name AS k, COUNT(*) AS n FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_film_genres g ON g.tmdb_id = m.tmdb_id GROUP BY k`,
    ),
  );
  const poolGenres = toMap(
    rows<{ k: string; n: number }>(
      `SELECT g.name AS k, COUNT(*) AS n FROM pool p
       JOIN tmdb_film_genres g ON g.tmdb_id = p.tmdb_id GROUP BY k`,
    ),
  );
  const watchedGenreTotal = [...watchedGenres.values()].reduce((sum, n) => sum + n, 0);
  const poolGenreTotal = [...poolGenres.values()].reduce((sum, n) => sum + n, 0);

  const genres: Against[] = [...new Set([...watchedGenres.keys(), ...poolGenres.keys()])]
    .map((key) => {
      const watched = watchedGenres.get(key) ?? 0;
      const pool = poolGenres.get(key) ?? 0;
      return {
        key,
        label: key,
        watched,
        pool,
        skew: share(watched, watchedGenreTotal) - share(pool, poolGenreTotal),
      };
    })
    .sort((a, b) => b.watched - a.watched)
    .slice(0, 14);

  const watchedLanguages = toMap(
    rows<{ k: string; n: number }>(
      `SELECT t.original_language AS k, COUNT(*) AS n FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id
       WHERE t.original_language IS NOT NULL GROUP BY k`,
    ),
  );
  const poolLanguages = toMap(
    rows<{ k: string; n: number }>(
      `SELECT t.original_language AS k, COUNT(*) AS n FROM pool p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.original_language IS NOT NULL GROUP BY k`,
    ),
  );
  const watchedLangTotal = [...watchedLanguages.values()].reduce((sum, n) => sum + n, 0);
  const poolLangTotal = [...poolLanguages.values()].reduce((sum, n) => sum + n, 0);

  const languages: Against[] = [...new Set([...watchedLanguages.keys(), ...poolLanguages.keys()])]
    .map((key) => {
      const watched = watchedLanguages.get(key) ?? 0;
      const pool = poolLanguages.get(key) ?? 0;
      return {
        key,
        label: languageName(key),
        watched,
        pool,
        skew: share(watched, watchedLangTotal) - share(pool, poolLangTotal),
      };
    })
    .sort((a, b) => b.watched + b.pool - (a.watched + a.pool))
    .slice(0, 14);

  // --- availability ---------------------------------------------------------
  // The one number that decides whether a slate is actionable tonight. A film
  // you cannot reach is a film you will pass over, however well it scores.
  const streamable = scalar(
    `SELECT COUNT(DISTINCT p.tmdb_id) AS n FROM pool p
     JOIN tmdb_watch_providers wp ON wp.tmdb_id = p.tmdb_id
     WHERE wp.region = ? AND wp.offer_type = 'flatrate'`,
    region,
  );
  const anyOffer = scalar(
    `SELECT COUNT(DISTINCT p.tmdb_id) AS n FROM pool p
     JOIN tmdb_watch_providers wp ON wp.tmdb_id = p.tmdb_id
     WHERE wp.region = ?`,
    region,
  );
  const availability = [
    { key: 'flatrate', label: 'On a subscription', films: streamable },
    { key: 'rent', label: 'Rent or buy only', films: anyOffer - streamable },
    { key: 'none', label: 'Nowhere tracked', films: poolTotal - anyOffer },
  ];

  // --- the slate log --------------------------------------------------------
  const slateRows = rows<{
    slate_date: string;
    kind: string;
    tmdb_id: number;
    title: string;
    year: number | null;
    chosen: number;
    manual: number;
    status: string | null;
  }>(
    `SELECT s.slate_date, s.kind, s.tmdb_id, t.title, t.year, s.manual,
            (pk.tmdb_id IS NOT NULL) AS chosen, pk.status
     FROM slates s
     JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
     LEFT JOIN picks pk ON pk.pick_date = s.slate_date AND pk.tmdb_id = s.tmdb_id
     ORDER BY s.slate_date DESC, s.position`,
  );

  const slateLog: Analytics['slateLog'] = [];
  for (const row of slateRows) {
    let day = slateLog.find((entry) => entry.date === row.slate_date);
    if (!day) {
      day = { date: row.slate_date, kind: row.kind, films: [], status: null };
      slateLog.push(day);
    }
    day.films.push({
      tmdbId: row.tmdb_id,
      title: row.title,
      year: row.year,
      chosen: row.chosen === 1,
      manual: row.manual === 1,
    });
    if (row.chosen === 1) day.status = row.status;
  }

  const passedOver = rows<{ tmdb_id: number; title: string; year: number | null; times: number }>(
    `SELECT s.tmdb_id, t.title, t.year, COUNT(*) AS times
     FROM slates s JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
     WHERE NOT EXISTS (SELECT 1 FROM picks pk
                       WHERE pk.pick_date = s.slate_date AND pk.tmdb_id = s.tmdb_id)
     GROUP BY s.tmdb_id HAVING times > 1
     ORDER BY times DESC, t.title LIMIT 12`,
  ).map((row) => ({ tmdbId: row.tmdb_id, title: row.title, year: row.year, times: row.times }));

  // --- lineage --------------------------------------------------------------
  const lineage = rows<{
    from_tmdb_id: number;
    to_tmdb_id: number;
    from_title: string | null;
    to_title: string | null;
    rationale: string;
    rating: number | null;
    in_pool: number;
    offered: number;
  }>(
    `SELECT e.from_tmdb_id, e.to_tmdb_id, e.from_title, e.to_title, e.rationale,
            r.rating,
            EXISTS (SELECT 1 FROM pool p WHERE p.tmdb_id = e.to_tmdb_id) AS in_pool,
            EXISTS (SELECT 1 FROM slates s WHERE s.tmdb_id = e.to_tmdb_id) AS offered
     FROM lineage_edges e
     LEFT JOIN film_matches m ON m.tmdb_id = e.from_tmdb_id
     LEFT JOIN ratings r ON r.film_id = m.film_id
     ORDER BY e.from_title, e.to_title`,
  ).map((row) => ({
    fromTmdbId: row.from_tmdb_id,
    toTmdbId: row.to_tmdb_id,
    fromTitle: row.from_title,
    toTitle: row.to_title,
    rationale: row.rationale,
    rating: row.rating,
    inPool: row.in_pool === 1,
    offered: row.offered === 1,
  }));

  return {
    totals: {
      watched: coverage.total,
      mapped: coverage.mapped,
      rated: scalar('SELECT COUNT(*) AS n FROM ratings'),
      logged: scalar('SELECT COUNT(*) AS n FROM diary_entries'),
      countries: coverage.country.length,
      directors: coverage.director.length,
      movementsTouched: movements.filter((row) => row.watched > 0).length,
      movementsTotal: movements.length,
      poolSize: poolTotal,
      watchlist: scalar('SELECT COUNT(*) AS n FROM watchlist'),
      daysPlayed: scalar('SELECT COUNT(DISTINCT slate_date) AS n FROM slates'),
      filmsOffered: scalar('SELECT COUNT(*) AS n FROM slates'),
      chosen: scalar('SELECT COUNT(*) AS n FROM picks'),
      watchedFromSlate: scalar("SELECT COUNT(*) AS n FROM picks WHERE status = 'watched'"),
      lockedIn: scalar(
        `SELECT COUNT(*) AS n FROM picks pk
         JOIN slates s ON s.slate_date = pk.pick_date AND s.tmdb_id = pk.tmdb_id
         WHERE s.manual = 1`,
      ),
      region,
    },
    decades,
    decadeSkew,
    countries: [...new Set([...watchedByCountry.keys(), ...poolByCountry.keys()])]
      .map((code) => ({
        code,
        name: countryName(code),
        count: watchedByCountry.get(code) ?? 0,
        pool: poolByCountry.get(code) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || b.pool - a.pool || a.name.localeCompare(b.name)),
    regions,
    regionByDecade,
    movements,
    directorDepth: [...depth]
      .sort((a, b) => a[0] - b[0])
      .map(([films, directors]) => ({ films, directors })),
    topDirectors: coverage.director
      .slice(0, 12)
      .map((bucket) => ({ name: bucket.label, count: bucket.count })),
    ratings,
    cadence,
    runtime,
    poolSources,
    poolListCount,
    poolVotes,
    poolDropped,
    genres,
    languages,
    availability,
    snapshots: rows<{ taken_on: string; watched_total: number }>(
      'SELECT taken_on, watched_total FROM coverage_snapshot_meta ORDER BY taken_on',
    ).map((row) => ({ takenOn: row.taken_on, watched: row.watched_total })),
    slateLog,
    passedOver,
    lineage,
    issues: {
      ingest: scalar('SELECT COUNT(*) AS n FROM ingest_issues'),
      unresolved: scalar('SELECT COUNT(*) AS n FROM pool_unresolved'),
      capOverrides: scalar('SELECT COUNT(*) AS n FROM pool_cap_overrides'),
      excluded: scalar('SELECT COUNT(*) AS n FROM pool_excluded'),
    },
  };
}
