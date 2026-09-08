import { migrate, openDb } from '../db/client';
import { loadMovements } from '../coverage';
import { createEngine, loadState, resolvePick, unresolvePick } from '../engine';
import { chooseFromSlate } from '../engine/choose';
import { lockInFilm } from '../engine/lock';
import { drawSlate, persistSlate } from '../engine/slate';
import { rechooseStalePick } from '../engine/redraw';
import { loadLineage } from '../engine/lineage';
import { tmdbConfig } from '../config';

/**
 * Today's five films from the terminal.
 *
 * Same database, same rules, same finality as the page: the slate is generated
 * once and written down, and choosing off it is a one-way door. This exists so
 * the mechanism can be exercised without a browser, which is how everything
 * else in this project got checked.
 *
 * Usage:
 *   npm run slate                      # show today's five, drawing them if needed
 *   npm run slate -- --choose 1234     # commit to a tmdb_id from today's slate
 *   npm run slate -- --find solaris    # search the pool by title
 *   npm run slate -- --lock 593        # lock in any pool film, on or off the slate
 *   npm run slate -- --watched         # mark the chosen film watched
 *   npm run slate -- --undo            # put a mis-clicked watched back to pending
 *   npm run slate -- --rechoose 1234   # replace a pick stranded by a pool rebuild
 *   npm run slate -- --date 2026-09-10
 *   npm run slate -- --history 14
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

interface Offer {
  position: number;
  tmdb_id: number;
  kind: string;
  share: number;
  pool_size: number;
  reason_json: string;
  lineage_rationale: string | null;
  title: string;
  year: number | null;
  runtime: number | null;
  overview: string | null;
  origin_country: string | null;
  chosen: number;
}

const SELECT = `
  SELECT s.position, s.tmdb_id, s.kind, s.share, s.pool_size, s.reason_json, s.lineage_rationale,
         t.title, t.year, t.runtime, t.overview, t.origin_country,
         (pk.tmdb_id IS NOT NULL) AS chosen
  FROM slates s
  JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
  LEFT JOIN picks pk ON pk.pick_date = s.slate_date AND pk.tmdb_id = s.tmdb_id
  WHERE s.slate_date = ? ORDER BY s.position`;

function main(): void {
  const { region } = tmdbConfig();
  const db = openDb();
  migrate(db);
  loadMovements(db);
  loadLineage(db);

  const date = arg('date', new Date().toISOString().slice(0, 10));

  if (process.argv.includes('--history')) {
    const limit = Number.parseInt(arg('history', '14'), 10);
    const rows = db
      .prepare(
        `SELECT s.slate_date, s.kind, t.title, t.year, (pk.tmdb_id IS NOT NULL) AS chosen, pk.status
         FROM slates s
         JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
         LEFT JOIN picks pk ON pk.pick_date = s.slate_date AND pk.tmdb_id = s.tmdb_id
         WHERE s.slate_date IN (SELECT DISTINCT slate_date FROM slates
                                ORDER BY slate_date DESC LIMIT ?)
         ORDER BY s.slate_date DESC, s.position`,
      )
      .all(limit) as {
      slate_date: string;
      kind: string;
      title: string;
      year: number | null;
      chosen: number;
      status: string | null;
    }[];

    if (rows.length === 0) console.log('No slates yet.');
    let current = '';
    for (const row of rows) {
      if (row.slate_date !== current) {
        current = row.slate_date;
        console.log(`\n  ${current}${row.kind === 'junk-valve' ? '  (junk valve)' : ''}`);
      }
      const mark = row.chosen === 1 ? `> ${row.status ?? 'pending'}`.padEnd(10) : '  '.padEnd(10);
      console.log(`    ${mark}${row.title} (${row.year ?? '?'})`);
    }
    console.log('');
    db.close();
    return;
  }

  // Searching the pool from the terminal, so --lock has something to take an id
  // from. Same ranking as the box on the page: exact title first, then prefix,
  // then vote count, because the pool has two films called Solaris.
  if (process.argv.includes('--find')) {
    const term = arg('find', '').trim();
    if (term.length < 2) {
      console.log('Give it at least two characters: npm run slate -- --find solaris');
      db.close();
      return;
    }
    const hits = db
      .prepare(
        `SELECT t.tmdb_id, t.title, t.year, t.runtime, t.origin_country, t.vote_count,
                (SELECT group_concat(pe.name, ', ') FROM tmdb_film_crew c
                 JOIN tmdb_people pe ON pe.person_id = c.person_id
                 WHERE c.tmdb_id = t.tmdb_id AND c.job = 'Director') AS directors
         FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
         WHERE t.title LIKE ?
         ORDER BY (t.title = ?) DESC, (t.title LIKE ?) DESC, t.vote_count DESC
         LIMIT 12`,
      )
      .all(`%${term}%`, term, `${term}%`) as {
      tmdb_id: number;
      title: string;
      year: number | null;
      runtime: number | null;
      origin_country: string | null;
      vote_count: number | null;
      directors: string | null;
    }[];

    if (hits.length === 0) console.log(`Nothing in the pool matches "${term}".`);
    for (const hit of hits) {
      console.log(`\n  [${hit.tmdb_id}] ${hit.title} (${hit.year ?? '?'})`);
      console.log(
        `      ${hit.directors ?? 'director unknown'}  ` +
          `${hit.origin_country ?? '??'}  ${hit.runtime ? `${hit.runtime}m` : '?'}  ` +
          `${(hit.vote_count ?? 0).toLocaleString()} votes`,
      );
    }
    console.log('\n  Lock one in:  npm run slate -- --lock <tmdb_id>\n');
    db.close();
    return;
  }

  if (process.argv.includes('--rechoose')) {
    const tmdbId = Number.parseInt(arg('rechoose', ''), 10);
    const moved = rechooseStalePick(db, date, tmdbId);
    console.log(
      `${date}: ${moved.from.title} was no longer in the pool, replaced by ${moved.to.title}.`,
    );
    db.close();
    return;
  }

  if (process.argv.includes('--undo')) {
    unresolvePick(db, date);
    console.log(`${date} is pending again. The film is unchanged; only the bookkeeping was undone.`);
    db.close();
    return;
  }

  if (process.argv.includes('--watched')) {
    resolvePick(db, date, 'watched');
    console.log('Marked watched.');
    db.close();
    return;
  }

  // The slate is generated on first read, exactly as the page does it.
  let offers = db.prepare(SELECT).all(date) as Offer[];
  if (offers.length === 0) {
    const engine = createEngine(db);
    if (engine.candidates.length === 0) {
      console.log('The candidate pool is empty. Run: npm run pool');
      db.close();
      return;
    }
    persistSlate(db, drawSlate(engine, loadState(db), date));
    offers = db.prepare(SELECT).all(date) as Offer[];
  }

  // Deliberately after the slate is drawn. Locking in without one would leave a
  // day whose log says only "you watched this", losing the four the engine
  // would have offered -- which is the record worth keeping.
  if (process.argv.includes('--lock')) {
    const tmdbId = Number.parseInt(arg('lock', ''), 10);
    const locked = lockInFilm(db, date, tmdbId);
    console.log(`Locked in: ${locked.title}. That is ${date} settled -- there is no reroll.`);
    db.close();
    return;
  }

  if (process.argv.includes('--choose')) {
    const tmdbId = Number.parseInt(arg('choose', ''), 10);
    chooseFromSlate(db, date, tmdbId);
    const taken = offers.find((offer) => offer.tmdb_id === tmdbId);
    console.log(
      `Chosen: ${taken?.title ?? tmdbId}. That is ${date} settled -- there is no reroll.`,
    );
    db.close();
    return;
  }

  const first = offers[0];
  console.log(
    `\n  ${date}${first?.kind === 'junk-valve' ? '   (junk valve: today is not homework)' : ''}` +
      `   ${offers.length} of ${first?.pool_size ?? 0} candidates`,
  );

  const directorsOf = db.prepare(
    `SELECT p.name FROM tmdb_film_crew c JOIN tmdb_people p ON p.person_id = c.person_id
     WHERE c.tmdb_id = ? AND c.job = 'Director'`,
  );
  const providersOf = db.prepare(
    `SELECT DISTINCT provider_name, offer_type FROM tmdb_watch_providers
     WHERE tmdb_id = ? AND region = ? ORDER BY offer_type`,
  );

  for (const offer of offers) {
    const directors = (directorsOf.all(offer.tmdb_id) as { name: string }[]).map((row) => row.name);
    const providers = providersOf.all(offer.tmdb_id, region) as {
      provider_name: string;
      offer_type: string;
    }[];
    const flatrate = providers
      .filter((row) => row.offer_type === 'flatrate')
      .map((row) => row.provider_name);
    const rentBuy = [
      ...new Set(
        providers.filter((row) => row.offer_type !== 'flatrate').map((row) => row.provider_name),
      ),
    ];

    console.log(
      `\n  ${offer.chosen === 1 ? '>' : ' '} [${offer.tmdb_id}] ${offer.title} (${offer.year ?? '?'})`,
    );
    console.log(`      ${directors.join(', ') || 'director unknown'}`);
    console.log(
      `      ${offer.origin_country ?? '??'}  ` +
        `${offer.runtime ? `${offer.runtime} minutes` : 'runtime unknown'}  ` +
        `drawn at ${(offer.share * 100).toFixed(2)}%`,
    );
    if (offer.lineage_rationale) console.log(`      ${offer.lineage_rationale}`);
    console.log(
      `      In ${region}: ` +
        (flatrate.length > 0
          ? flatrate.join(', ')
          : rentBuy.length > 0
            ? `rent or buy on ${rentBuy.slice(0, 4).join(', ')}`
            : 'not available on any tracked service'),
    );
  }

  const chosen = offers.find((offer) => offer.chosen === 1);
  console.log(
    chosen
      ? `\n  Chosen: ${chosen.title}. Tomorrow brings five more.\n`
      : `\n  Choose one:  npm run slate -- --choose <tmdb_id>\n`,
  );

  db.close();
}

main();
