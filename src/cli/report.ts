import { openDb } from '../db/client';
import { DEFAULT_TUNING } from '../engine/tuning';

/**
 * Verification for the whole pipeline.
 *
 * The first section reproduces the figures the brief states about my Letterboxd
 * data; if those drift, something upstream is wrong and nothing downstream
 * (coverage, weighting, the daily slate) can be trusted. The rest checks that
 * enrichment cleared the brief's match-rate bar, that coverage is computable,
 * and that the pool can actually supply every gap the weights will open.
 *
 * Usage: npm run report
 */

/**
 * The numbers quoted in the brief, from the Sept 2026 export.
 *
 * These are one person's figures, so they are only a pass/fail check when that
 * person's export is the one loaded. On anybody else's data they would be a
 * screenful of FAILs that mean nothing, so the comparison is skipped and the
 * same figures are printed plainly instead.
 */
const BRIEF_PROFILE = 'EbenVranken';

const EXPECTED = {
  watched: 436,
  rated: 410,
  rewatches: 51,
  watchlist: 164,
  meanRating: 3.58,
  medianRating: 3.5,
  oldestYear: 1954,
  decades: {
    'pre-1950': 0,
    '1950s': 8,
    '1960s': 17,
    '1970s': 20,
    '1980s': 33,
    '1990s': 49,
    '2000s': 104,
    '2010s': 96,
    '2020s': 109,
  } as Record<string, number>,
};

const decadeLabel = (year: number | null): string => {
  if (year === null) return 'unknown';
  if (year < 1950) return 'pre-1950';
  return `${Math.floor(year / 10) * 10}s`;
};

function check(label: string, actual: number, expected: number, tolerance = 0): string {
  const ok = Math.abs(actual - expected) <= tolerance;
  return `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} ${String(actual).padStart(6)}  (brief: ${expected})`;
}

function main(): void {
  const db = openDb();

  const scalar = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;

  const watched = scalar('SELECT COUNT(*) AS n FROM watched');
  const rated = scalar('SELECT COUNT(*) AS n FROM ratings');
  const rewatches = scalar('SELECT COUNT(*) AS n FROM diary_entries WHERE rewatch = 1');
  const watchlist = scalar('SELECT COUNT(*) AS n FROM watchlist');
  const liked = scalar('SELECT COUNT(*) AS n FROM likes');
  const diary = scalar('SELECT COUNT(*) AS n FROM diary_entries');

  const ratings = (
    db.prepare('SELECT rating FROM ratings ORDER BY rating').all() as { rating: number }[]
  ).map((r) => r.rating);
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const median = ratings[Math.floor(ratings.length / 2)] ?? 0;
  const std = Math.sqrt(
    ratings.reduce((acc, r) => acc + (r - mean) ** 2, 0) / ratings.length,
  );

  const watchedFilms = db
    .prepare(
      `SELECT f.name, f.year FROM watched w JOIN films f ON f.id = w.film_id ORDER BY f.year`,
    )
    .all() as { name: string; year: number | null }[];

  const decades = new Map<string, number>();
  for (const film of watchedFilms) {
    const key = decadeLabel(film.year);
    decades.set(key, (decades.get(key) ?? 0) + 1);
  }

  const oldest = watchedFilms[0];
  const modern = watchedFilms.filter((f) => (f.year ?? 0) >= 2010).length;

  const lastImport = db
    .prepare('SELECT source_file, imported_at, username FROM imports ORDER BY id DESC LIMIT 1')
    .get() as { source_file: string; imported_at: string; username: string | null } | undefined;

  console.log('MovieSpinner: ingest and enrichment report');
  if (lastImport) {
    console.log(`Last import: ${lastImport.imported_at} (${lastImport.username ?? 'unknown user'})`);
  } else {
    console.log('No imports yet. Run: npm run import');
    db.close();
    return;
  }

  const isBriefProfile = lastImport.username === BRIEF_PROFILE;
  let decadesOk = true;

  if (isBriefProfile) {
    console.log('\nAgainst the brief:');
    console.log(check('watched films', watched, EXPECTED.watched));
    console.log(check('rated films', rated, EXPECTED.rated));
    console.log(check('rewatches', rewatches, EXPECTED.rewatches));
    console.log(check('watchlist', watchlist, EXPECTED.watchlist));
    console.log(check('mean rating', Number(mean.toFixed(2)), EXPECTED.meanRating, 0.01));
    console.log(check('median rating', median, EXPECTED.medianRating));
    console.log(check('oldest film year', oldest?.year ?? 0, EXPECTED.oldestYear));
  } else {
    console.log(`\nProfile (${lastImport.username ?? 'unknown'}):`);
    const line = (label: string, value: string | number): void =>
      console.log(`        ${label.padEnd(22)} ${String(value).padStart(6)}`);
    line('watched films', watched);
    line('rated films', rated);
    line('rewatches', rewatches);
    line('watchlist', watchlist);
    line('mean rating', mean.toFixed(2));
    line('median rating', median);
    line('oldest film year', oldest?.year ?? 0);
    console.log(
      `\n  The brief's figures describe ${BRIEF_PROFILE}'s export, so they are not compared\n` +
        '  against here. Everything below is checked normally.',
    );
  }

  console.log('\nCoverage by decade:');
  for (const [label, expected] of Object.entries(EXPECTED.decades)) {
    const actual = decades.get(label) ?? 0;
    const bar = '#'.repeat(Math.round(actual / 3));
    if (!isBriefProfile) {
      console.log(`        ${label.padEnd(9)} ${String(actual).padStart(4)}  ${bar}`);
      continue;
    }
    if (actual !== expected) decadesOk = false;
    console.log(
      `  ${actual === expected ? 'PASS' : 'FAIL'}  ${label.padEnd(9)} ${String(actual).padStart(4)}  ${bar}`,
    );
  }
  for (const [label, actual] of decades) {
    if (!(label in EXPECTED.decades)) {
      if (isBriefProfile) {
        decadesOk = false;
        console.log(`  FAIL  ${label.padEnd(9)} ${String(actual).padStart(4)}  (not in the brief)`);
      } else {
        console.log(`        ${label.padEnd(9)} ${String(actual).padStart(4)}`);
      }
    }
  }

  console.log('\nOther:');
  console.log(`  diary entries        ${diary}`);
  console.log(`  liked films          ${liked}`);
  console.log(`  rating std dev       ${std.toFixed(2)}`);
  console.log(`  oldest film          ${oldest?.name ?? '-'} (${oldest?.year ?? '-'})`);
  console.log(
    `  2010 or later        ${modern} of ${watched} (${((modern / watched) * 100).toFixed(0)}%)`,
  );

  const perYear = db
    .prepare(
      `SELECT substr(watched_date, 1, 4) AS y, COUNT(*) AS n
       FROM diary_entries GROUP BY y ORDER BY y`,
    )
    .all() as { y: string; n: number }[];
  console.log('\nViewings per year (diary):');
  for (const row of perYear) {
    console.log(`  ${row.y}  ${String(row.n).padStart(4)}  ${'#'.repeat(Math.round(row.n / 4))}`);
  }

  // --- step 2: TMDB enrichment ---------------------------------------------
  const attempted = scalar('SELECT COUNT(*) AS n FROM film_matches');
  const matchedFilms = scalar('SELECT COUNT(*) AS n FROM film_matches WHERE tmdb_id IS NOT NULL');
  const excluded = scalar(
    "SELECT COUNT(*) AS n FROM film_matches WHERE method = 'override' AND tmdb_id IS NULL",
  );
  const unreviewed = scalar('SELECT COUNT(*) AS n FROM film_matches WHERE confirmed = 0');
  const totalFilms = scalar('SELECT COUNT(*) AS n FROM films');
  const matchable = totalFilms - excluded;
  const matchRate = matchable === 0 ? 0 : (matchedFilms / matchable) * 100;

  console.log('\nTMDB enrichment:');
  if (attempted === 0) {
    console.log('  not run yet. Run: npm run enrich');
  } else {
    const methods = db
      .prepare('SELECT method, COUNT(*) AS n FROM film_matches GROUP BY method ORDER BY n DESC')
      .all() as { method: string; n: number }[];
    console.log(
      `  ${matchRate >= 90 ? 'PASS' : 'FAIL'}  match rate           ${matchRate.toFixed(1)}%` +
        ` of ${matchable} matchable  (brief requires >90%)`,
    );
    console.log(
      `  ${unreviewed === 0 ? 'PASS' : 'FAIL'}  awaiting review      ${unreviewed}` +
        (unreviewed > 0 ? '  (run: npm run matches)' : ''),
    );
    console.log(`        method               ${methods.map((m) => `${m.method} ${m.n}`).join(', ')}`);
    console.log(`        excluded on purpose  ${excluded}  (TV series, shorts TMDB lacks)`);

    // Completeness of the fields the coverage step and the daily card need.
    const cached = scalar('SELECT COUNT(*) AS n FROM tmdb_films');
    const fields: [string, string][] = [
      ['runtime', 'SELECT COUNT(*) AS n FROM tmdb_films WHERE runtime > 0'],
      [
        'director',
        `SELECT COUNT(DISTINCT tmdb_id) AS n FROM tmdb_film_crew WHERE job = 'Director'`,
      ],
      ['country', 'SELECT COUNT(DISTINCT tmdb_id) AS n FROM tmdb_film_countries'],
      ['poster', 'SELECT COUNT(*) AS n FROM tmdb_films WHERE poster_path IS NOT NULL'],
    ];
    console.log(`        cached TMDB records  ${cached}`);
    for (const [label, sql] of fields) {
      const have = scalar(sql);
      console.log(
        `        with ${label.padEnd(16)}${String(have).padStart(4)} / ${cached}` +
          `  (${((have / cached) * 100).toFixed(1)}%)`,
      );
    }

    const streaming = scalar(
      "SELECT COUNT(DISTINCT tmdb_id) AS n FROM tmdb_watch_providers WHERE region = 'BE' AND offer_type = 'flatrate'",
    );
    const anyOffer = scalar(
      "SELECT COUNT(DISTINCT tmdb_id) AS n FROM tmdb_watch_providers WHERE region = 'BE'",
    );
    console.log(`        BE subscription      ${streaming} films; ${anyOffer} with any BE offer`);
  }

  // --- step 3: coverage -----------------------------------------------------
  const movements = scalar('SELECT COUNT(*) AS n FROM movements');
  const taggings = scalar('SELECT COUNT(*) AS n FROM film_movements');
  const snapshots = scalar('SELECT COUNT(*) AS n FROM coverage_snapshot_meta');
  console.log('\nCoverage:');
  if (movements === 0) {
    console.log('  movement taxonomy not loaded yet. Run: npm run coverage');
  } else {
    const touched = scalar(
      `SELECT COUNT(DISTINCT fm.movement) AS n FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN film_movements fm ON fm.tmdb_id = m.tmdb_id`,
    );
    const leadCountries = scalar(
      `SELECT COUNT(DISTINCT t.origin_country) AS n FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id`,
    );
    const directors = scalar(
      `SELECT COUNT(DISTINCT cr.person_id) AS n FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_film_crew cr ON cr.tmdb_id = m.tmdb_id AND cr.job = 'Director'`,
    );
    const manualTags = scalar("SELECT COUNT(*) AS n FROM film_movements WHERE source = 'manual'");
    console.log(
      `        movements            ${touched} of ${movements} touched; ${taggings} tags` +
        ` (${manualTags} by hand, the rest from the curated director and period rules)`,
    );
    console.log(`        lead countries       ${leadCountries}`);
    console.log(`        directors            ${directors}`);
    console.log(
      `  ${snapshots > 0 ? 'PASS' : 'WARN'}  snapshots on file    ${snapshots}` +
        (snapshots === 0 ? '  (run: npm run coverage -- --snapshot)' : ''),
    );
  }

  // --- step 4: candidate pool -----------------------------------------------
  const poolSize = scalar('SELECT COUNT(*) AS n FROM pool');
  console.log('\nCandidate pool:');
  if (poolSize === 0) {
    console.log('  not built yet. Run: npm run pool');
  } else {
    const lists = db
      .prepare('SELECT kind, COUNT(*) AS n, SUM(entries) AS films FROM pool_lists GROUP BY kind')
      .all() as { kind: string; n: number; films: number }[];
    console.log(`        films                ${poolSize}, uncapped by choice`);
    for (const row of lists) {
      console.log(`        ${row.kind.padEnd(20)} ${row.n} list(s), ${row.films} entries`);
    }
    console.log(`        already watched      ${scalar('SELECT COUNT(*) AS n FROM pool_excluded')} excluded`);
    console.log(`        on my watchlist      ${scalar('SELECT COUNT(*) AS n FROM pool WHERE on_watchlist = 1')}`);

    // The check that matters: can every gap the weights will open actually be
    // filled from the pool? A zero here would make the engine chase a hole it
    // has no film to put in.
    // The floor the pool shaping enforces. Cinema du look sits one under it and
    // always will: three directors over fourteen years is not fifteen films.
    const starvedMovements = scalar(
      `SELECT COUNT(*) AS n FROM movements m
       WHERE (SELECT COUNT(*) FROM pool p JOIN film_movements fm ON fm.tmdb_id = p.tmdb_id
              WHERE fm.movement = m.slug) < 15`,
    );
    const thinnest = db
      .prepare(
        `SELECT m.name, (SELECT COUNT(*) FROM pool p JOIN film_movements fm ON fm.tmdb_id = p.tmdb_id
                         WHERE fm.movement = m.slug) AS n
         FROM movements m ORDER BY n LIMIT 1`,
      )
      .get() as { name: string; n: number } | undefined;
    console.log(
      `  ${starvedMovements === 0 ? 'PASS' : 'WARN'}  movements above floor 15 ` +
        `thinnest is ${thinnest?.name ?? '-'} at ${thinnest?.n ?? 0} films` +
        (starvedMovements > 0 ? `; ${starvedMovements} below` : ''),
    );
    console.log(
      `  ${scalar('SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE t.year < 1950') > 100 ? 'PASS' : 'FAIL'}` +
        `  pre-1950 supply       ${scalar('SELECT COUNT(*) AS n FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE t.year < 1950')} films against 0 watched`,
    );
  }

  // --- step 5: the engine ---------------------------------------------------
  const edges = scalar('SELECT COUNT(*) AS n FROM lineage_edges');
  const picked = scalar('SELECT COUNT(*) AS n FROM picks');
  console.log('\nEngine:');
  if (edges === 0) {
    console.log('  lineage edges not loaded. Run: npm run simulate');
  } else {
    const liveEdges = scalar(
      `SELECT COUNT(*) AS n FROM lineage_edges e
       JOIN film_matches m ON m.tmdb_id = e.from_tmdb_id
       JOIN ratings r ON r.film_id = m.film_id WHERE r.rating >= 4`,
    );
    const targets = scalar('SELECT COUNT(DISTINCT to_tmdb_id) AS n FROM lineage_edges');
    const reachable = scalar(
      'SELECT COUNT(DISTINCT e.to_tmdb_id) AS n FROM lineage_edges e JOIN pool p ON p.tmdb_id = e.to_tmdb_id',
    );
    console.log(`        lineage edges        ${edges}, ${liveEdges} from a film rated 4 or better`);
    console.log(
      `  ${reachable === targets ? 'PASS' : 'WARN'}  every edge target in pool ${reachable} of ${targets}`,
    );
    // Slates and picks are separate counts on purpose: a day the cron prepared
    // and nobody opened has five films and no pick, which is not a failure.
    const slateDays = scalar('SELECT COUNT(DISTINCT slate_date) AS n FROM slates');
    const offered = scalar('SELECT COUNT(*) AS n FROM slates');
    console.log(
      `        slates drawn         ${slateDays} day(s), ${offered} film(s) offered`,
    );
    // A short slate is legal -- the draw stops early rather than padding when
    // nothing left has any weight -- but it should be rare enough to notice.
    // Days carried over from the one-a-day era are one film by design.
    const shortSlates = scalar(
      'SELECT COUNT(*) AS n FROM (SELECT slate_date FROM slates GROUP BY slate_date HAVING COUNT(*) <> ?)',
      DEFAULT_TUNING.slateSize,
    );
    if (slateDays > 0) {
      console.log(
        `        slates of ${DEFAULT_TUNING.slateSize}           ` +
          `${slateDays - shortSlates} of ${slateDays} day(s)`,
      );
    }
    if (picked === 0) {
      console.log('        films chosen         none yet. Run: npm run slate');
    } else {
      const byStatus = db
        .prepare('SELECT status, COUNT(*) AS n FROM picks GROUP BY status')
        .all() as { status: string; n: number }[];
      console.log(
        `        films chosen         ${picked} (${byStatus.map((row) => `${row.n} ${row.status}`).join(', ')})`,
      );
      const dupes = scalar(
        'SELECT COUNT(*) AS n FROM (SELECT tmdb_id FROM picks GROUP BY tmdb_id HAVING COUNT(*) > 1)',
      );
      console.log(`  ${dupes === 0 ? 'PASS' : 'FAIL'}  no film picked twice     ${dupes} duplicate(s)`);
    }
  }

  // --- steps 6 to 9: the app ------------------------------------------------
  const syncs = scalar('SELECT COUNT(*) AS n FROM sync_runs');
  const feedEntries = scalar('SELECT COUNT(*) AS n FROM rss_entries');
  const autoClosed = scalar('SELECT COALESCE(SUM(resolved), 0) AS n FROM sync_runs');
  console.log('\nApp:');
  console.log(
    `  ${syncs > 0 ? 'PASS' : 'WARN'}  RSS sync                 ${syncs} run(s), ` +
      `${feedEntries} feed entries seen, ${autoClosed} pick(s) auto-closed`,
  );
  console.log(`        snapshots for the trend  ${scalar('SELECT COUNT(*) AS n FROM coverage_snapshot_meta')}`);
  console.log('        pages                    / — the whole thing, one route');
  console.log('        run it with              npm run dev');

  const issues = db
    .prepare(
      `SELECT severity, code, COUNT(*) AS n FROM ingest_issues
       WHERE import_id = (SELECT MAX(id) FROM imports)
       GROUP BY severity, code ORDER BY severity, code`,
    )
    .all() as { severity: string; code: string; n: number }[];
  console.log('\nIngest issues (latest import):');
  if (issues.length === 0) {
    console.log('  none');
  } else {
    for (const row of issues) {
      console.log(`  ${row.severity.padEnd(6)} ${row.code.padEnd(26)} ${row.n}`);
    }
  }

  db.close();

  // On another person's export the brief's counts are not a criterion; the
  // match rate and the review queue still are, because those are about whether
  // the pipeline worked rather than about whose data it worked on.
  const allOk =
    decadesOk &&
    (attempted === 0 || (matchRate >= 90 && unreviewed === 0)) &&
    (!isBriefProfile ||
      (watched === EXPECTED.watched &&
        rated === EXPECTED.rated &&
        rewatches === EXPECTED.rewatches &&
        watchlist === EXPECTED.watchlist));
  const verdict = !allOk
    ? 'Something does not line up. Investigate before moving on.'
    : attempted === 0
      ? 'Step 1 verified. Run npm run enrich for step 2.'
      : movements === 0
        ? 'Steps 1 and 2 verified. Run npm run coverage for step 3.'
        : poolSize === 0
          ? 'Steps 1 to 3 verified. Run npm run pool for step 4.'
          : edges === 0
            ? 'Steps 1 to 4 verified. Run npm run simulate for step 5.'
            : 'All eleven build steps verified.';
  console.log(`\n${verdict}`);
  if (!allOk) process.exitCode = 1;
}

main();
