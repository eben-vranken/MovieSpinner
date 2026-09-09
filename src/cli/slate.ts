import { migrate, openDb } from '../db/client';
import { loadMovements } from '../coverage';
import { createEngine, loadState, resolvePick, unresolvePick } from '../engine';
import { chooseFromSlate } from '../engine/choose';
import { lockInFilm } from '../engine/lock';
import { activeCampaign, campaignQueue, endCampaign, startCampaign } from '../engine/campaign';
import type { CampaignKind, CampaignOrdering } from '../engine/campaign';
import { currentRound, drawSlate, offeredOn, persistSlate } from '../engine/slate';
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
 *   npm run slate                      # show the current round, drawing it if needed
 *   npm run slate -- --choose 1234     # commit to a tmdb_id from the current round
 *   npm run slate -- --find solaris    # search the pool by title
 *   npm run slate -- --lock 593        # lock in any pool film, on or off the slate
 *   npm run slate -- --watched         # mark the chosen film watched
 *   npm run slate -- --again           # another five, once this round is watched
 *   npm run slate -- --round 1         # look back at an earlier round of the day
 *   npm run slate -- --undo            # put a mis-clicked watched back to pending
 *   npm run slate -- --rechoose 1234   # replace a pick stranded by a pool rebuild
 *   npm run slate -- --date 2026-09-10
 *   npm run slate -- --history 14
 *
 * Campaign mode:
 *   npm run slate -- --campaigns director        # subjects worth committing to
 *   npm run slate -- --campaign director:5219    # commit (kind:subject)
 *   npm run slate -- --campaign movement:silent-era --order canonical
 *   npm run slate -- --campaign-status
 *   npm run slate -- --end-campaign
 */

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

interface Offer {
  position: number;
  round: number;
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
  SELECT s.position, s.round, s.tmdb_id, s.kind, s.share, s.pool_size, s.reason_json,
         s.lineage_rationale, t.title, t.year, t.runtime, t.overview, t.origin_country,
         (pk.tmdb_id IS NOT NULL) AS chosen
  FROM slates s
  JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
  LEFT JOIN picks pk ON pk.pick_date = s.slate_date AND pk.tmdb_id = s.tmdb_id
  WHERE s.slate_date = ? AND s.round = ? ORDER BY s.position`;

function main(): void {
  const { region } = tmdbConfig();
  const db = openDb();
  migrate(db);
  loadMovements(db);
  loadLineage(db);

  const date = arg('date', new Date().toISOString().slice(0, 10));

  if (process.argv.includes('--campaigns')) {
    const kind = (arg('campaigns', 'director') as CampaignKind) ?? 'director';
    const min = 4;
    const rows =
      kind === 'director'
        ? (db
            .prepare(
              `SELECT pe.person_id AS subject, pe.name AS label, COUNT(DISTINCT p.tmdb_id) AS n
               FROM pool p JOIN tmdb_film_crew c ON c.tmdb_id = p.tmdb_id AND c.job = 'Director'
               JOIN tmdb_people pe ON pe.person_id = c.person_id
               GROUP BY pe.person_id HAVING n >= ? ORDER BY n DESC LIMIT 30`,
            )
            .all(min) as { subject: string | number; label: string; n: number }[])
        : kind === 'movement'
          ? (db
              .prepare(
                `SELECT m.slug AS subject, m.name AS label, COUNT(DISTINCT p.tmdb_id) AS n
                 FROM movements m JOIN film_movements f ON f.movement = m.slug
                 JOIN pool p ON p.tmdb_id = f.tmdb_id
                 GROUP BY m.slug HAVING n >= ? ORDER BY n DESC LIMIT 30`,
              )
              .all(min) as { subject: string | number; label: string; n: number }[])
          : (db
              .prepare(
                `SELECT t.origin_country AS subject, t.origin_country AS label,
                        COUNT(DISTINCT p.tmdb_id) AS n
                 FROM pool p JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
                 WHERE t.origin_country IS NOT NULL
                 GROUP BY t.origin_country HAVING n >= ? ORDER BY n DESC LIMIT 30`,
              )
              .all(min) as { subject: string | number; label: string; n: number }[]);

    console.log(`
  ${kind} campaigns with at least ${min} unseen films:
`);
    for (const row of rows) {
      console.log(
        `    ${String(row.n).padStart(4)}  ${kind}:${String(row.subject).padEnd(16)} ${row.label}`,
      );
    }
    console.log('\n  Commit with:  npm run slate -- --campaign <kind>:<subject>\n');
    db.close();
    return;
  }

  if (process.argv.includes('--campaign-status')) {
    const current = activeCampaign(db);
    if (!current) {
      console.log('\n  No campaign running. See options:  npm run slate -- --campaigns director\n');
      db.close();
      return;
    }
    loadMovements(db);
    const queue = campaignQueue(createEngine(db), loadState(db), date, current);
    console.log(`
  ${current.label} (${current.kind}, ${current.ordering})`);
    console.log(`  started ${current.startedOn} · ${queue.length} films left
`);
    for (const entry of queue.slice(0, 10)) {
      console.log(`    ${entry.candidate.year ?? '????'}  ${entry.candidate.title}`);
    }
    console.log('');
    db.close();
    return;
  }

  if (process.argv.includes('--end-campaign')) {
    const ended = endCampaign(db, 'abandoned', date);
    console.log(ended ? `Ended the ${ended.label} campaign.` : 'No campaign was running.');
    db.close();
    return;
  }

  if (process.argv.includes('--campaign')) {
    const [kind, ...rest] = arg('campaign', '').split(':');
    const subject = rest.join(':');
    if (!kind || !subject) {
      console.log('Use --campaign <kind>:<subject>, e.g. --campaign director:5219');
      db.close();
      return;
    }
    const label =
      kind === 'director'
        ? ((db.prepare('SELECT name FROM tmdb_people WHERE person_id = ?').get(subject) as
            | { name: string }
            | undefined)?.name ?? subject)
        : kind === 'movement'
          ? ((db.prepare('SELECT name FROM movements WHERE slug = ?').get(subject) as
              | { name: string }
              | undefined)?.name ?? subject)
          : subject;

    const ordering = (arg('order', 'chronological') as CampaignOrdering) ?? 'chronological';
    const started = startCampaign(
      db,
      { kind: kind as CampaignKind, subject, label, ordering },
      date,
    );
    console.log(
      `
  Committed to ${started.label} (${started.ordering}).` +
        `
  Starts with the next slate; today's five, if drawn, stay as they are.
`,
    );
    db.close();
    return;
  }

  if (process.argv.includes('--history')) {
    const limit = Number.parseInt(arg('history', '14'), 10);
    const rows = db
      .prepare(
        `SELECT s.slate_date, s.round, s.kind, t.title, t.year,
                (pk.tmdb_id IS NOT NULL) AS chosen, pk.status
         FROM slates s
         JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
         LEFT JOIN picks pk ON pk.pick_date = s.slate_date AND pk.tmdb_id = s.tmdb_id
         WHERE s.slate_date IN (SELECT DISTINCT slate_date FROM slates
                                ORDER BY slate_date DESC LIMIT ?)
         ORDER BY s.slate_date DESC, s.round, s.position`,
      )
      .all(limit) as {
      slate_date: string;
      round: number;
      kind: string;
      title: string;
      year: number | null;
      chosen: number;
      status: string | null;
    }[];

    if (rows.length === 0) console.log('No slates yet.');
    let current = '';
    for (const row of rows) {
      const heading = `${row.slate_date}#${row.round}`;
      if (heading !== current) {
        current = heading;
        console.log(
          `\n  ${row.slate_date}${row.round > 1 ? `  round ${row.round}` : ''}` +
            `${row.kind === 'junk-valve' ? '  (junk valve)' : ''}`,
        );
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

  // Which round the day is on. Every verb below acts on that one unless
  // --round names an earlier one, because the round you are being asked to
  // choose from is the only one with anything open.
  const drawn = currentRound(db, date);
  const round = Math.max(1, Number.parseInt(arg('round', String(Math.max(1, drawn))), 10) || 1);

  if (process.argv.includes('--undo')) {
    unresolvePick(db, date, round);
    console.log(
      `${date} round ${round} is pending again. ` +
        'The film is unchanged; only the bookkeeping was undone.',
    );
    db.close();
    return;
  }

  if (process.argv.includes('--watched')) {
    resolvePick(db, date, 'watched', round);
    console.log('Marked watched. Another five with:  npm run slate -- --again');
    db.close();
    return;
  }

  // Another five, and the guard that makes it not a reroll: the round before it
  // has to have been watched, not merely chosen.
  if (process.argv.includes('--again')) {
    if (drawn === 0) {
      console.log(`${date} has no slate yet. Run npm run slate first.`);
      db.close();
      return;
    }
    const pick = db
      .prepare('SELECT status FROM picks WHERE pick_date = ? AND round = ?')
      .get(date, drawn) as { status: string } | undefined;

    if (!pick) {
      console.log(`Round ${drawn} is still open. Choose one of its films first.`);
      db.close();
      return;
    }
    if (pick.status !== 'watched') {
      console.log(
        'Mark the film you chose as watched first. Another round is what watching one earns;' +
          ' it is not a way to be handed a different five.',
      );
      db.close();
      return;
    }

    const engine = createEngine(db);
    persistSlate(
      db,
      drawSlate(engine, loadState(db), date, {
        round: drawn + 1,
        exclude: offeredOn(db, date),
      }),
    );
    console.log(`Round ${drawn + 1} drawn. Show it with:  npm run slate`);
    db.close();
    return;
  }

  // The slate is generated on first read, exactly as the page does it -- round
  // 1 and no further. Later rounds are earned through --again rather than
  // conjured by looking, or the day would deal itself a new five every time.
  let offers = db.prepare(SELECT).all(date, round) as Offer[];
  if (offers.length === 0 && drawn === 0) {
    const engine = createEngine(db);
    if (engine.candidates.length === 0) {
      console.log('The candidate pool is empty. Run: npm run pool');
      db.close();
      return;
    }
    persistSlate(db, drawSlate(engine, loadState(db), date));
    offers = db.prepare(SELECT).all(date, 1) as Offer[];
  }
  if (offers.length === 0) {
    console.log(`${date} has no round ${round}.`);
    db.close();
    return;
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
    `\n  ${date}${first && first.round > 1 ? `   round ${first.round}` : ''}` +
      `${first?.kind === 'junk-valve' ? '   (junk valve: today is not homework)' : ''}` +
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
  const status = chosen
    ? (
        db
          .prepare('SELECT status FROM picks WHERE pick_date = ? AND round = ?')
          .get(date, round) as { status: string } | undefined
      )?.status
    : undefined;
  console.log(
    !chosen
      ? `\n  Choose one:  npm run slate -- --choose <tmdb_id>\n`
      : status === 'watched'
        ? `\n  Watched: ${chosen.title}. Another five:  npm run slate -- --again\n`
        : `\n  Chosen: ${chosen.title}. Mark it:  npm run slate -- --watched\n`,
  );

  db.close();
}

main();
