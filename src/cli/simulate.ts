import { migrate, openDb } from '../db/client';
import { loadMovements } from '../coverage';
import { applyPick, createEngine, draw, loadState, statureOf, DEFAULT_TUNING } from '../engine';
import { loadLineage } from '../engine/lineage';
import { randomForSeed } from '../engine/random';

/**
 * §9 of the brief: "Make it CLI-testable: simulate a year of picks and eyeball
 * the distribution before building any UI. This is where the project succeeds
 * or fails."
 *
 * Nothing is written to the database. The simulation rolls a copy of the state
 * forward, assuming I watch what I am given, so coverage closes and cooldowns
 * fire exactly as they would in real use.
 *
 * Usage:
 *   npm run simulate
 *   npm run simulate -- --days 365 --skip-rate 0.15 --start 2026-09-08
 *   npm run simulate -- --list        # print every pick, not just the first weeks
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const pct = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`;

function histogram(counts: Map<string, number>, limit = 12, per = 1): string[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => `    ${String(n).padStart(3)}  ${key.padEnd(28)}${'#'.repeat(Math.round(n / per))}`);
}

function main(): void {
  const db = openDb();
  migrate(db);
  loadMovements(db);
  const lineage = loadLineage(db);
  for (const problem of lineage.problems) console.log(`  warning: ${problem}`);

  const days = Number.parseInt(arg('days', '365'), 10);
  const skipRate = Number.parseFloat(arg('skip-rate', '0'));
  const start = arg('start', new Date().toISOString().slice(0, 10));

  const engine = createEngine(db, DEFAULT_TUNING);
  const state = loadState(db);

  if (engine.candidates.length === 0) {
    console.log('The pool is empty. Run: npm run pool');
    db.close();
    return;
  }

  const before = {
    decade: new Map(state.coverage.decade),
    country: new Map(state.coverage.country),
    movement: new Map(state.coverage.movement),
  };

  console.log(
    `Simulating ${days} days from ${start}, ${engine.candidates.length} films in the pool, ` +
      `${lineage.edges} lineage edges` +
      (skipRate > 0 ? `, skipping ${(skipRate * 100).toFixed(0)}% of picks` : ', watching everything'),
  );

  const skipDice = randomForSeed(`simulate-skips:${start}:${days}`);
  const picks: {
    date: string;
    tmdbId: number;
    provenance: string;
    stature: number;
    votes: number;
    title: string;
    year: number | null;
    kind: string;
    country: string | null;
    decade: string;
    directors: string[];
    movements: string[];
    runtime: number | null;
    share: number;
    topShare: number;
    lineage?: { fromTitle: string; rationale: string };
    skipped: boolean;
  }[] = [];

  for (let day = 0; day < days; day += 1) {
    const date = addDays(start, day);
    const result = draw(engine, state, date);
    const skipped = skipRate > 0 && skipDice() < skipRate;
    const candidate = result.chosen.candidate;
    picks.push({
      date,
      tmdbId: candidate.tmdbId,
      provenance:
        candidate.tspdtRank !== null
          ? `TSPDT ${candidate.tspdtRank <= 250 ? 'top 250' : candidate.tspdtRank <= 500 ? '251-500' : '501-1000'}`
          : candidate.kinds.includes('lineage')
            ? 'lineage'
            : candidate.kinds.includes('collection')
              ? 'Criterion'
              : candidate.kinds.includes('auteur')
                ? 'auteur list'
                : 'regional list',
      stature: statureOf(candidate, engine.tuning),
      votes: candidate.voteCount,
      title: result.chosen.candidate.title,
      year: result.chosen.candidate.year,
      kind: result.kind,
      country: result.chosen.candidate.country,
      decade: result.chosen.candidate.decade,
      directors: result.chosen.candidate.directorNames,
      movements: result.chosen.candidate.movements,
      runtime: result.chosen.candidate.runtime,
      share: result.share,
      topShare: result.topShare,
      lineage: result.chosen.candidate.lineage,
      skipped,
    });
    applyPick(state, date, result.chosen.candidate, skipped);
  }

  const showAll = process.argv.includes('--list');
  const preview = showAll ? picks : picks.slice(0, 21);
  console.log(`\nFirst ${preview.length} picks:`);
  for (const pick of preview) {
    const tag = pick.kind === 'junk-valve' ? ' [junk valve]' : '';
    const runtime = pick.runtime ? `${pick.runtime}m` : '?';
    console.log(
      `  ${pick.date}  ${(pick.title + ` (${pick.year ?? '?'})`).padEnd(46)}` +
        `${(pick.country ?? '--').padEnd(3)} ${runtime.padStart(5)}${tag}`,
    );
    if (pick.lineage) console.log(`             ${pick.lineage.rationale}`);
    else if (pick.skipped) console.log('             (skipped in this simulation)');
  }

  // --- distribution ---------------------------------------------------------
  const watched = picks.filter((pick) => !pick.skipped);
  const byDecade = new Map<string, number>();
  const byCountry = new Map<string, number>();
  const byMovement = new Map<string, number>();
  const byDirector = new Map<string, number>();
  const byFilm = new Map<number, number>();
  const byProvenance = new Map<string, number>();
  for (const pick of picks) {
    byProvenance.set(pick.provenance, (byProvenance.get(pick.provenance) ?? 0) + 1);
  }
  for (const pick of watched) {
    byDecade.set(pick.decade, (byDecade.get(pick.decade) ?? 0) + 1);
    byCountry.set(pick.country ?? '--', (byCountry.get(pick.country ?? '--') ?? 0) + 1);
    for (const movement of pick.movements) {
      byMovement.set(movement, (byMovement.get(movement) ?? 0) + 1);
    }
    for (const director of pick.directors) {
      byDirector.set(director, (byDirector.get(director) ?? 0) + 1);
    }
    byFilm.set(pick.tmdbId, (byFilm.get(pick.tmdbId) ?? 0) + 1);
  }

  console.log(`\nOver ${days} days, ${watched.length} watched:`);
  console.log('\n  Decade:');
  for (const line of histogram(byDecade, 12, 2)) console.log(line);
  console.log('\n  Country (top 12):');
  for (const line of histogram(byCountry, 12, 1)) console.log(line);
  console.log('\n  Movement (top 12):');
  for (const line of histogram(byMovement, 12, 2)) console.log(line);

  // Provenance is the check on quality rather than spread. A year made mostly of
  // regional-list filler would score perfectly on every distribution above and
  // still be a bad year of films.
  console.log('\n  Where the picks came from:');
  for (const line of histogram(byProvenance, 8, 2)) console.log(line);
  const obscure = picks.filter((pick) => pick.votes < 100).length;
  console.log(`    ${obscure} pick(s) had fewer than 100 TMDB votes (${pct(obscure, picks.length)})`);

  console.log('\n  Junk valve served:');
  for (const pick of picks.filter((entry) => entry.kind === 'junk-valve').slice(0, 8)) {
    console.log(
      `    ${(pick.title + ` (${pick.year ?? '?'})`).padEnd(44)} ${String(pick.votes).padStart(6)} votes`,
    );
  }

  // --- health checks --------------------------------------------------------
  const lineagePicks = picks.filter((pick) => pick.lineage).length;
  const junkPicks = picks.filter((pick) => pick.kind === 'junk-valve').length;
  const repeats = [...byFilm.values()].filter((n) => n > 1).length;
  const maxDirector = Math.max(0, ...byDirector.values());
  const meanTopShare = picks.reduce((sum, pick) => sum + pick.topShare, 0) / picks.length;
  const meanShare = picks.reduce((sum, pick) => sum + pick.share, 0) / picks.length;
  const longFilms = watched.filter((pick) => (pick.runtime ?? 0) >= 150).length;

  console.log('\nHealth checks:');
  console.log(`  ${repeats === 0 ? 'PASS' : 'FAIL'}  no film picked twice            ${repeats} repeats`);
  console.log(
    `  ${meanTopShare < 0.05 ? 'PASS' : 'WARN'}  the draw stays a surprise       ` +
      `best-weighted film averages ${pct(meanTopShare, 1)} of the draw`,
  );
  console.log(
    `        the chosen film averaged        ${pct(meanShare, 1)}, so it is rarely the favourite`,
  );
  console.log(
    `  ${lineagePicks > days / 30 ? 'PASS' : 'WARN'}  lineage reaches the card        ` +
      `${lineagePicks} picks arrived with a reason (${pct(lineagePicks, days)})`,
  );
  console.log(`        junk valve fired                ${junkPicks} times (${pct(junkPicks, days)})`);
  console.log(`        most films by one director      ${maxDirector}`);
  console.log(`        150 minutes or longer           ${longFilms} (${pct(longFilms, watched.length)})`);

  // --- what actually closed -------------------------------------------------
  console.log('\nCoverage closing:');
  const closing = (label: string, now: Map<string, number>, was: Map<string, number>, keys: string[]): void => {
    console.log(`  ${label}:`);
    for (const key of keys) {
      const from = was.get(key) ?? 0;
      const to = now.get(key) ?? 0;
      if (to === from) continue;
      console.log(`    ${key.padEnd(28)} ${String(from).padStart(3)} -> ${String(to).padStart(3)}  +${to - from}`);
    }
  };
  closing('Decade', state.coverage.decade, before.decade, [
    'pre-1950',
    '1950s',
    '1960s',
    '1970s',
    '1980s',
    '1990s',
    '2000s',
    '2010s',
    '2020s',
  ]);

  const movementsClosed = [...state.coverage.movement]
    .filter(([key, count]) => count > 0 && (before.movement.get(key) ?? 0) === 0)
    .map(([key]) => key);
  console.log(
    `\n  Movements that went from zero to something: ${movementsClosed.length}` +
      (movementsClosed.length > 0 ? `\n    ${movementsClosed.join(', ')}` : ''),
  );

  const countriesOpened = [...state.coverage.country]
    .filter(([key, count]) => count > 0 && (before.country.get(key) ?? 0) === 0)
    .map(([key]) => key);
  console.log(
    `  Countries seen for the first time: ${countriesOpened.length}` +
      (countriesOpened.length > 0 ? `\n    ${countriesOpened.join(' ')}` : ''),
  );

  db.close();
}

main();
