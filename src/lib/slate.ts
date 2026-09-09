import { tmdbConfig } from '../config';
import { loadMovements } from '../coverage';
import { createEngine, loadState } from '../engine';
import { loadLineage } from '../engine/lineage';
import { activeCampaign, drawCampaignSlate, endCampaign } from '../engine/campaign';
import { currentRound, drawSlate, offeredOn, persistSlate } from '../engine/slate';
import { db, today } from './db';

/** One film on the slate, with everything its card renders. */
export interface FilmCard {
  position: number;
  tmdbId: number;
  /** IMDb id, which is the id Stremio addresses a film by. Null on a few. */
  imdbId: string | null;
  title: string;
  year: number | null;
  runtime: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  country: string | null;
  language: string | null;
  voteAverage: number;
  voteCount: number;
  directors: string[];
  movements: string[];
  genres: string[];
  lineageRationale: string | null;
  lineageFromTitle: string | null;
  reason: Record<string, number>;
  /** Probability of this film at the moment it was drawn onto the slate. */
  share: number;
  streaming: string[];
  rentBuy: string[];
  /** Rank in TSPDT's 1000, when it is in there. */
  tspdtRank: number | null;
  /** Which source lists put it in the pool. */
  kinds: string[];
  /** Still a candidate. A false here is what makes a re-choice legal. */
  inPool: boolean;
  /** Locked in by hand rather than drawn onto the slate. */
  manual: boolean;
  /** Earlier days this film was offered and passed over. */
  timesPassed: number;
}

/** A film settled in an earlier round of the same day. */
export interface EarlierPick {
  round: number;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  directors: string[];
  status: 'pending' | 'watched' | 'skipped';
}

export interface SlateView {
  date: string;
  /** Which round these five belong to. Round 1 is the day's first slate. */
  round: number;
  kind: 'blind-spot' | 'junk-valve';
  poolSize: number;
  region: string;
  films: FilmCard[];
  /** The film chosen in this round, once one has been. */
  chosen: { tmdbId: number; status: 'pending' | 'watched' | 'skipped' } | null;
  /** The chosen film has fallen out of the pool, so re-choosing is allowed. */
  chosenIsStale: boolean;
  streak: number;
  /** Set when these five came from a campaign queue rather than a draw. */
  campaignId: number | null;
  /** Films already settled today, oldest first. Empty on a single-round day. */
  earlier: EarlierPick[];
  /**
   * This round's film is watched, so another five can be drawn.
   *
   * The one condition, and the whole reason a second round is not a reroll:
   * you reach it by having watched something, never by disliking something.
   */
  canDrawAnother: boolean;
}

interface SlateRow {
  position: number;
  tmdb_id: number;
  kind: 'blind-spot' | 'junk-valve';
  share: number;
  pool_size: number;
  reason_json: string;
  lineage_from: number | null;
  lineage_rationale: string | null;
  imdb_id: string | null;
  title: string;
  year: number | null;
  runtime: number | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  origin_country: string | null;
  original_language: string | null;
  vote_average: number | null;
  vote_count: number | null;
  in_pool: number;
  tspdt_rank: number | null;
  kinds: string | null;
  times_passed: number;
  manual: number;
  campaign_id: number | null;
}

const SELECT_SLATE = `
  SELECT s.position, s.tmdb_id, s.kind, s.share, s.pool_size, s.reason_json,
         s.lineage_from, s.lineage_rationale, s.manual, s.campaign_id,
         t.imdb_id, t.title, t.year, t.runtime, t.overview, t.poster_path, t.backdrop_path,
         t.origin_country, t.original_language, t.vote_average, t.vote_count,
         EXISTS (SELECT 1 FROM pool p WHERE p.tmdb_id = s.tmdb_id) AS in_pool,
         (SELECT e.position FROM pool_list_entries e
          WHERE e.tmdb_id = s.tmdb_id AND e.list_slug = 'tspdt-1000') AS tspdt_rank,
         (SELECT p.kinds FROM pool p WHERE p.tmdb_id = s.tmdb_id) AS kinds,
         (SELECT COUNT(*) FROM slates older
          WHERE older.tmdb_id = s.tmdb_id AND older.slate_date < s.slate_date
            AND NOT EXISTS (SELECT 1 FROM picks pk
                            WHERE pk.pick_date = older.slate_date
                              AND pk.tmdb_id = older.tmdb_id)) AS times_passed
  FROM slates s JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
  WHERE s.slate_date = ? AND s.round = ?
  ORDER BY s.position`;

/**
 * Draws one round and writes it down.
 *
 * Shared by the first read of a day and by every round earned after it, so a
 * second slate comes from the same mechanism as the first: same scoring, same
 * campaign handling, same refusal to overwrite. The only thing a later round
 * does differently is exclude what the day has already offered.
 */
function drawRound(handle: ReturnType<typeof db>, date: string, round: number): void {
  loadMovements(handle);
  loadLineage(handle);
  const engine = createEngine(handle);
  if (engine.candidates.length === 0) {
    throw new Error('The candidate pool is empty. Run `npm run pool` first.');
  }

  const state = loadState(handle);
  const campaign = activeCampaign(handle);
  const exclude = round > 1 ? offeredOn(handle, date) : undefined;
  const options = { round, ...(exclude ? { exclude } : {}) };

  // A campaign only ever shapes a slate that does not exist yet. This is the
  // whole reason it is safe: if starting one could reshape today's five, then
  // "start a campaign, look, abandon it" would be a reroll with extra steps.
  // A slate, once drawn, belongs to the round it was drawn for.
  let result;
  if (campaign) {
    try {
      result = drawCampaignSlate(engine, state, date, campaign, options);
    } catch {
      // The subject ran dry. The campaign is finished rather than broken, so
      // it is closed and the round falls back to an ordinary weighted draw.
      endCampaign(handle, 'completed', date);
      result = drawSlate(engine, state, date, options);
    }
  } else {
    result = drawSlate(engine, state, date, options);
  }

  persistSlate(handle, result);
}

/**
 * A second film tonight, and a third, for as long as you keep watching them.
 *
 * The guard is the entire feature. A round only opens when the round before it
 * was **watched** -- not chosen, watched. That is the line between "I finished
 * a film, give me another" and "I do not fancy this one, give me another", and
 * the second of those is the thing this project has refused from the start.
 * Nothing about the earlier round changes: its film stays chosen, stays in the
 * log, and stays yours. A day grows; it never gets rewritten.
 */
export function drawNextRound(date: string = today()): SlateView {
  const handle = db();
  const round = currentRound(handle, date);
  if (round === 0) return ensureSlate(date);

  const pick = handle
    .prepare('SELECT tmdb_id, status FROM picks WHERE pick_date = ? AND round = ?')
    .get(date, round) as { tmdb_id: number; status: string } | undefined;

  if (!pick) {
    throw new Error(
      `Round ${round} is still open. Choose one of its films before asking for another five.`,
    );
  }
  if (pick.status !== 'watched') {
    throw new Error(
      'Mark the film you chose as watched first. Another round is what watching one earns; ' +
        'it is not a way to be handed a different five.',
    );
  }

  drawRound(handle, date, round + 1);
  return ensureSlate(date);
}

/**
 * The round you are currently being asked to choose from, drawn on first read.
 *
 * Generate-on-read is safe because `persistSlate` refuses to overwrite, exactly
 * as `persistPick` does: two tabs opened at midnight cannot produce two
 * different slates. It only ever draws round 1 -- later rounds are earned
 * through `drawNextRound` and never conjured by opening the page, or a day
 * would quietly deal itself a new five every time you looked at it.
 */
export function ensureSlate(date: string = today()): SlateView {
  const handle = db();
  let round = currentRound(handle, date);
  if (round === 0) {
    drawRound(handle, date, 1);
    round = 1;
  }

  const rows = handle.prepare(SELECT_SLATE).all(date, round) as SlateRow[];

  const { region } = tmdbConfig();
  const ids = rows.map((row) => row.tmdb_id);
  const placeholders = ids.map(() => '?').join(',');

  // One query per dimension for the whole slate rather than five queries per
  // dimension. Five films is small enough that it would not matter on its own;
  // the shape matters because every other loader on this page works this way.
  const group = (sql: string): Map<number, string[]> => {
    const map = new Map<number, string[]>();
    if (ids.length === 0) return map;
    for (const row of handle.prepare(sql).all(...ids) as { tmdb_id: number; value: string }[]) {
      map.set(row.tmdb_id, [...(map.get(row.tmdb_id) ?? []), row.value]);
    }
    return map;
  };

  const directors = group(
    `SELECT c.tmdb_id, p.name AS value FROM tmdb_film_crew c
     JOIN tmdb_people p ON p.person_id = c.person_id
     WHERE c.job = 'Director' AND c.tmdb_id IN (${placeholders})`,
  );
  const movements = group(
    `SELECT fm.tmdb_id, m.name AS value FROM film_movements fm
     JOIN movements m ON m.slug = fm.movement
     WHERE fm.tmdb_id IN (${placeholders}) ORDER BY m.sort_order`,
  );
  const genres = group(
    `SELECT tmdb_id, name AS value FROM tmdb_film_genres WHERE tmdb_id IN (${placeholders})`,
  );

  const providers = new Map<number, { name: string; flatrate: boolean }[]>();
  if (ids.length > 0) {
    const offers = handle
      .prepare(
        `SELECT DISTINCT tmdb_id, provider_name, offer_type FROM tmdb_watch_providers
         WHERE region = ? AND tmdb_id IN (${placeholders})`,
      )
      .all(region, ...ids) as { tmdb_id: number; provider_name: string; offer_type: string }[];
    for (const row of offers) {
      providers.set(row.tmdb_id, [
        ...(providers.get(row.tmdb_id) ?? []),
        { name: row.provider_name, flatrate: row.offer_type === 'flatrate' },
      ]);
    }
  }

  const anchorTitle = handle.prepare(
    'SELECT from_title FROM lineage_edges WHERE from_tmdb_id = ? AND to_tmdb_id = ?',
  );

  const films: FilmCard[] = rows.map((row) => {
    const offers = providers.get(row.tmdb_id) ?? [];
    const anchor = row.lineage_from
      ? (anchorTitle.get(row.lineage_from, row.tmdb_id) as { from_title: string | null } | undefined)
      : undefined;

    return {
      position: row.position,
      tmdbId: row.tmdb_id,
      imdbId: row.imdb_id,
      title: row.title,
      year: row.year,
      runtime: row.runtime,
      overview: row.overview,
      posterPath: row.poster_path,
      backdropPath: row.backdrop_path,
      country: row.origin_country,
      language: row.original_language,
      voteAverage: row.vote_average ?? 0,
      voteCount: row.vote_count ?? 0,
      directors: directors.get(row.tmdb_id) ?? [],
      movements: movements.get(row.tmdb_id) ?? [],
      genres: genres.get(row.tmdb_id) ?? [],
      lineageRationale: row.lineage_rationale,
      lineageFromTitle: anchor?.from_title ?? null,
      reason: JSON.parse(row.reason_json) as Record<string, number>,
      share: row.share,
      streaming: offers.filter((offer) => offer.flatrate).map((offer) => offer.name),
      rentBuy: [...new Set(offers.filter((offer) => !offer.flatrate).map((offer) => offer.name))],
      tspdtRank: row.tspdt_rank,
      kinds: (row.kinds ?? '').split(',').filter(Boolean),
      inPool: row.in_pool === 1,
      manual: row.manual === 1,
      timesPassed: row.times_passed,
    };
  });

  const pick = handle
    .prepare('SELECT tmdb_id, status FROM picks WHERE pick_date = ? AND round = ?')
    .get(date, round) as
    | { tmdb_id: number; status: 'pending' | 'watched' | 'skipped' }
    | undefined;

  // Everything already settled today. On a one-round day this is empty and
  // costs one indexed lookup, which is the right price for not having a second
  // code path for the ordinary case.
  const earlier = (
    handle
      .prepare(
        `SELECT pk.round, pk.tmdb_id, pk.status, t.title, t.year, t.poster_path,
                (SELECT group_concat(pe.name, ', ') FROM tmdb_film_crew c
                 JOIN tmdb_people pe ON pe.person_id = c.person_id
                 WHERE c.tmdb_id = pk.tmdb_id AND c.job = 'Director') AS directors
         FROM picks pk JOIN tmdb_films t ON t.tmdb_id = pk.tmdb_id
         WHERE pk.pick_date = ? AND pk.round < ?
         ORDER BY pk.round`,
      )
      .all(date, round) as {
      round: number;
      tmdb_id: number;
      status: 'pending' | 'watched' | 'skipped';
      title: string;
      year: number | null;
      poster_path: string | null;
      directors: string | null;
    }[]
  ).map(
    (row): EarlierPick => ({
      round: row.round,
      tmdbId: row.tmdb_id,
      title: row.title,
      year: row.year,
      posterPath: row.poster_path,
      directors: row.directors ? row.directors.split(', ').filter(Boolean) : [],
      status: row.status,
    }),
  );

  return {
    date,
    round,
    kind: rows[0]?.kind ?? 'blind-spot',
    poolSize: rows[0]?.pool_size ?? 0,
    region,
    films,
    chosen: pick ? { tmdbId: pick.tmdb_id, status: pick.status } : null,
    chosenIsStale: pick
      ? films.find((film) => film.tmdbId === pick.tmdb_id)?.inPool === false
      : false,
    streak: currentStreak(),
    campaignId: rows[0]?.campaign_id ?? null,
    earlier,
    // Watched, not merely chosen. A pending film is an evening still in
    // progress, and a stale one is a record being repaired rather than a film
    // that was seen.
    canDrawAnother:
      pick?.status === 'watched' &&
      films.find((film) => film.tmdbId === pick.tmdb_id)?.inPool !== false,
  };
}

/**
 * Consecutive days ending today on which a chosen film was actually watched.
 *
 * A day you chose nothing and a day you chose and never marked it both break
 * the streak, because from the outside they are the same thing: the evening did
 * not happen.
 *
 * Counted per day rather than per pick, now that a day can hold several. A
 * double bill is one day of the streak and not two -- the streak measures
 * evenings kept, and watching two films is one evening kept well. The day
 * counts if anything on it was watched, so a second round left pending after a
 * first round watched does not retroactively erase the film you did watch.
 */
export function currentStreak(): number {
  const rows = db()
    .prepare(
      `SELECT pick_date, MAX(status = 'watched') AS closed
       FROM picks GROUP BY pick_date ORDER BY pick_date DESC`,
    )
    .all() as { pick_date: string; closed: number }[];

  let streak = 0;
  let expected: string | null = null;
  for (const row of rows) {
    if (row.closed !== 1) break;
    if (expected !== null && row.pick_date !== expected) break;
    streak += 1;
    expected = new Date(Date.parse(`${row.pick_date}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return streak;
}

/** The plain-language version of why a film is on the slate at all. */
export function reasonSentence(film: FilmCard, kind: 'blind-spot' | 'junk-valve'): string {
  // A manual pick still gets scored, so the gap sentence below would be true --
  // but it would also be a lie about how the film got here. It got here because
  // you went and found it.
  if (film.manual) return 'You picked this one yourself.';
  if (kind === 'junk-valve') {
    return 'Sunday. No homework, just something your own ratings say you would enjoy.';
  }
  const named: [number, string][] = [
    [
      film.reason['decade'] ?? 1,
      film.year ? `the ${Math.floor(film.year / 10) * 10}s` : 'that decade',
    ],
    [film.reason['country'] ?? 1, 'that country'],
    [film.reason['director'] ?? 1, 'this director'],
    [film.reason['movement'] ?? 1, film.movements[0] ?? 'this movement'],
  ];
  const strongest = named.sort((a, b) => b[0] - a[0])[0];
  if (!strongest || strongest[0] <= 1.05) return 'A gap across several dimensions at once.';
  return `Mostly ${strongest[1]}, where your coverage is thinnest.`;
}
