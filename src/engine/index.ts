import type { Db } from '../db/client';
import { dayOf } from '../lib/day';
import { decadeLabel } from '../coverage';
import { loadCandidates, loadTaste } from './candidates';
import type { Candidate, Taste } from './candidates';
import { randomForSeed, weightedPick } from './random';
import { DEFAULT_TUNING, gapScore, voteCurve } from './tuning';
import type { Tuning } from './tuning';

export type { Candidate } from './candidates';
export { DEFAULT_TUNING } from './tuning';
export type { Tuning } from './tuning';

export type PickKind = 'blind-spot' | 'junk-valve';

/** What the draw knew when it ran. Mutable, so a simulation can roll it forward. */
export interface EngineState {
  coverage: {
    decade: Map<string, number>;
    country: Map<string, number>;
    director: Map<number, number>;
    movement: Map<string, number>;
  };
  /** Recent picks, newest last, for the cooldown windows. */
  history: { date: string; country: string | null; directors: number[]; decade: string }[];
  /** tmdb_id to the date it was skipped. */
  skipped: Map<number, string>;
  /** Picked and not skipped. These never come back. */
  taken: Set<number>;
}

export interface Reason {
  decade: number;
  country: number;
  director: number;
  movement: number;
  blended: number;
  stature: number;
  findability: number;
  lineage: number;
  watchlist: number;
  cooldown: number;
  skip: number;
  taste?: number;
  familiarity?: number;
}

/**
 * How much the pool's own opinion of a film is worth.
 *
 * Being ranked 12th in TSPDT and being the fortieth most-voted Indonesian film
 * are not the same claim, and before this existed the draw treated them
 * identically. TSPDT rank is the strongest signal available, so it scales; the
 * rest are flat by kind.
 */
export function statureOf(candidate: Candidate, tuning: Tuning): number {
  const { stature } = tuning;
  const byKind: Record<string, number> = {
    canon: stature.tspdtWorst,
    regional: stature.regional,
    collection: stature.collection,
    lineage: stature.lineage,
    auteur: stature.auteur,
  };

  // A film's best claim wins. Being both a TSPDT entry and the fortieth
  // most-voted Indonesian film should be scored as the former.
  let best =
    candidate.tspdtRank !== null
      ? stature.tspdtBest +
        (stature.tspdtWorst - stature.tspdtBest) *
          Math.min(1, Math.max(0, (candidate.tspdtRank - 1) / 999))
      : 0;
  for (const kind of candidate.kinds) best = Math.max(best, byKind[kind] ?? 0);
  if (candidate.lineage) best = Math.max(best, stature.lineage);
  if (best === 0) best = stature.auteur;

  // Agreement across lists is a small, honest bonus on top.
  return best * (1 + tuning.listCountBonus * Math.max(0, candidate.listCount - 1));
}

export interface Scored {
  candidate: Candidate;
  weight: number;
  reason: Reason;
}

export interface DrawResult {
  date: string;
  kind: PickKind;
  seed: string;
  chosen: Scored;
  /** The chosen film's probability in this draw, and the best film's. */
  share: number;
  topShare: number;
  poolSize: number;
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const bump = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

export function loadState(db: Db): EngineState {
  const coverage = {
    decade: new Map<string, number>(),
    country: new Map<string, number>(),
    director: new Map<number, number>(),
    movement: new Map<string, number>(),
  };

  for (const row of db
    .prepare('SELECT f.year FROM watched w JOIN films f ON f.id = w.film_id')
    .all() as { year: number | null }[]) {
    bump(coverage.decade, decadeLabel(row.year));
  }
  for (const row of db
    .prepare(
      `SELECT t.origin_country AS c FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_films t ON t.tmdb_id = m.tmdb_id WHERE t.origin_country IS NOT NULL`,
    )
    .all() as { c: string }[]) {
    bump(coverage.country, row.c);
  }
  for (const row of db
    .prepare(
      `SELECT c.person_id AS p FROM watched w
       JOIN film_matches m ON m.film_id = w.film_id
       JOIN tmdb_film_crew c ON c.tmdb_id = m.tmdb_id AND c.job = 'Director'`,
    )
    .all() as { p: number }[]) {
    bump(coverage.director, row.p);
  }
  for (const row of db
    .prepare(
      `SELECT fm.movement AS m FROM watched w
       JOIN film_matches fmatch ON fmatch.film_id = w.film_id
       JOIN film_movements fm ON fm.tmdb_id = fmatch.tmdb_id`,
    )
    .all() as { m: string }[]) {
    bump(coverage.movement, row.m);
  }

  // Cooldown only cares about the last few weeks, so only those rows are read.
  const history = (
    db
      .prepare(
        `SELECT p.pick_date, t.origin_country, t.year FROM picks p
         JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
         ORDER BY p.pick_date DESC LIMIT 40`,
      )
      .all() as { pick_date: string; origin_country: string | null; year: number | null }[]
  ).reverse();

  // Every director picked on that date, not just the one film's. A day can hold
  // several rounds now, and the cooldown asks "have I seen this director
  // lately", which is a question about the day rather than about the round.
  const directorsOf = db.prepare(
    `SELECT c.person_id FROM picks p
     JOIN tmdb_film_crew c ON c.tmdb_id = p.tmdb_id AND c.job = 'Director'
     WHERE p.pick_date = ?`,
  );

  const skipped = new Map<number, string>();
  const taken = new Set<number>();
  for (const row of db.prepare('SELECT tmdb_id, status, pick_date FROM picks').all() as {
    tmdb_id: number;
    status: string;
    pick_date: string;
  }[]) {
    if (row.status === 'skipped') skipped.set(row.tmdb_id, row.pick_date);
    else taken.add(row.tmdb_id);
  }

  return {
    coverage,
    history: history.map((row) => ({
      date: row.pick_date,
      country: row.origin_country,
      decade: decadeLabel(row.year),
      directors: (directorsOf.all(row.pick_date) as { person_id: number }[]).map(
        (person) => person.person_id,
      ),
    })),
    skipped,
    taken,
  };
}

/** Applies a pick to the state, so a simulation can carry on from it. */
export function applyPick(state: EngineState, date: string, candidate: Candidate, skipped: boolean): void {
  if (skipped) {
    state.skipped.set(candidate.tmdbId, date);
  } else {
    state.taken.add(candidate.tmdbId);
    state.skipped.delete(candidate.tmdbId);
    bump(state.coverage.decade, candidate.decade);
    if (candidate.country) bump(state.coverage.country, candidate.country);
    for (const id of candidate.directors) bump(state.coverage.director, id);
    for (const movement of candidate.movements) bump(state.coverage.movement, movement);
  }

  state.history.push({
    date,
    country: candidate.country,
    decade: candidate.decade,
    directors: candidate.directors,
  });
  if (state.history.length > 40) state.history.shift();
}

/** Multiplier for a film whose country, director or decade came up too recently. */
function cooldownFactor(
  candidate: Candidate,
  state: EngineState,
  date: string,
  tuning: Tuning,
): number {
  let factor = 1;
  for (const entry of state.history) {
    const age = daysBetween(entry.date, date);
    if (age < 0) continue;
    if (candidate.country && entry.country === candidate.country && age < tuning.cooldown.countryDays) {
      factor *= tuning.cooldown.factor;
    }
    if (entry.decade === candidate.decade && age < tuning.cooldown.decadeDays) {
      factor *= tuning.cooldown.factor;
    }
    if (
      age < tuning.cooldown.directorDays &&
      candidate.directors.some((id) => entry.directors.includes(id))
    ) {
      factor *= tuning.cooldown.factor;
    }
  }
  return factor;
}

function skipFactor(candidate: Candidate, state: EngineState, date: string, tuning: Tuning): number {
  const skippedOn = state.skipped.get(candidate.tmdbId);
  if (!skippedOn) return 1;
  const age = daysBetween(skippedOn, date);
  if (age >= tuning.skip.days) return 1;
  // Climbs back on a curve rather than a line, so the fortnight after a skip
  // stays close to the floor. A film reappearing three days after being skipped
  // would feel like the reroll this project refuses to have.
  const recovery = (Math.max(0, age) / tuning.skip.days) ** 2;
  return tuning.skip.factor + (1 - tuning.skip.factor) * recovery;
}

export function scoreBlindSpot(
  candidate: Candidate,
  state: EngineState,
  date: string,
  tuning: Tuning,
): Scored {
  const { saturation, dimensionWeight } = tuning;

  const decade = gapScore(state.coverage.decade.get(candidate.decade) ?? 0, saturation.decade, tuning);
  const country = candidate.country
    ? gapScore(state.coverage.country.get(candidate.country) ?? 0, saturation.country, tuning)
    : 1;

  // A film with several directors or movements is worth its biggest hole, not
  // its average one. Seeing it closes the widest gap it touches.
  const director =
    candidate.directors.length === 0
      ? 1
      : Math.max(
          ...candidate.directors.map((id) =>
            gapScore(state.coverage.director.get(id) ?? 0, saturation.director, tuning),
          ),
        );
  const movement =
    candidate.movements.length === 0
      ? 1
      : Math.max(
          ...candidate.movements.map((slug) =>
            gapScore(state.coverage.movement.get(slug) ?? 0, saturation.movement, tuning),
          ),
        );

  const totalWeight =
    dimensionWeight.decade + dimensionWeight.country + dimensionWeight.director + dimensionWeight.movement;
  const blended =
    (decade * dimensionWeight.decade +
      country * dimensionWeight.country +
      director * dimensionWeight.director +
      movement * dimensionWeight.movement) /
    totalWeight;

  const stature = statureOf(candidate, tuning);
  const findability = voteCurve(
    candidate.voteCount,
    tuning.findability.fullVotes,
    tuning.findability.floor,
  );
  const lineage = candidate.lineage ? tuning.lineageBonus : 1;
  const watchlist = candidate.onWatchlist ? tuning.watchlistBonus : 1;
  const cooldown = cooldownFactor(candidate, state, date, tuning);
  const skip = skipFactor(candidate, state, date, tuning);

  return {
    candidate,
    weight:
      blended ** tuning.sharpness * stature * findability * lineage * watchlist * cooldown * skip,
    reason: {
      decade, country, director, movement, blended, stature, findability,
      lineage, watchlist, cooldown, skip,
    },
  };
}

/**
 * §6's junk valve. Once a week the blind-spot weighting is ignored entirely and
 * the draw goes looking for something I would simply enjoy. Nothing here is
 * learned: it is my own rating history, averaged by genre, director and decade,
 * shrunk toward my overall mean so a genre I rated twice cannot dominate.
 */
export function scoreJunkValve(
  candidate: Candidate,
  state: EngineState,
  date: string,
  tuning: Tuning,
  taste: Taste,
): Scored {
  const normalise = (rating: number): number => Math.max(0, Math.min(1, (rating - 1) / 4));

  const genre =
    candidate.genres.length === 0
      ? normalise(taste.overallMean)
      : normalise(
          candidate.genres.reduce(
            (sum, id) => sum + (taste.byGenre.get(id) ?? taste.overallMean),
            0,
          ) / candidate.genres.length,
        );
  const director =
    candidate.directors.length === 0
      ? normalise(taste.overallMean)
      : normalise(
          Math.max(
            ...candidate.directors.map((id) => taste.byDirector.get(id) ?? taste.overallMean),
          ),
        );
  const decade = normalise(taste.byDecade.get(candidate.decade) ?? taste.overallMean);
  // Crowd score shrunk by vote count, so a 9.5 from eleven people means nothing.
  const crowd =
    (candidate.voteAverage * candidate.voteCount + 6.2 * 300) / (candidate.voteCount + 300) / 10;

  const enjoyment = 0.35 * genre + 0.2 * director + 0.1 * decade + 0.35 * crowd;

  // Familiarity is what makes this a junk valve rather than another obscurity
  // machine. Without it every Sunday came back with something like a 1919
  // German film nobody has rated, which is the exact opposite of the point.
  const familiarity = voteCurve(candidate.voteCount, tuning.familiarityVotes);
  const skip = skipFactor(candidate, state, date, tuning);

  return {
    candidate,
    weight: enjoyment ** tuning.tasteSharpness * familiarity ** tuning.familiarityExponent * skip,
    reason: {
      decade: 0,
      country: 0,
      director: 0,
      movement: 0,
      blended: 0,
      stature: 1,
      findability: 1,
      lineage: 1,
      watchlist: 1,
      cooldown: 1,
      skip,
      taste: enjoyment,
      familiarity,
    },
  };
}

export interface Engine {
  candidates: Candidate[];
  taste: Taste;
  tuning: Tuning;
}

export function createEngine(db: Db, tuning: Tuning = DEFAULT_TUNING): Engine {
  return { candidates: loadCandidates(db), taste: loadTaste(db, tuning.tastePrior), tuning };
}

export const isJunkValveDay = (date: string, tuning: Tuning): boolean =>
  new Date(`${date}T00:00:00Z`).getUTCDay() === tuning.junkValveWeekday;

/**
 * The draw for one date.
 *
 * Deterministic in the seed and the state it is handed. §4 requires the result
 * to be written down immediately, because recomputing it later against a
 * changed watched set would silently produce a different film and quietly break
 * the no-reroll rule.
 */
/**
 * Every still-available candidate, scored for one date.
 *
 * Split out of `draw` so the slate can score the pool exactly the way a single
 * pick does. A slate that scored films differently from the one-a-day draw
 * would quietly be a second engine, and the whole point of §10 is that there is
 * one readable set of rules.
 */
export function scoreAll(
  engine: Engine,
  state: EngineState,
  date: string,
): { kind: PickKind; scored: Scored[] } {
  const kind: PickKind = isJunkValveDay(date, engine.tuning) ? 'junk-valve' : 'blind-spot';
  const available = engine.candidates.filter((candidate) => !state.taken.has(candidate.tmdbId));

  return {
    kind,
    scored: available.map((candidate) =>
      kind === 'junk-valve'
        ? scoreJunkValve(candidate, state, date, engine.tuning, engine.taste)
        : scoreBlindSpot(candidate, state, date, engine.tuning),
    ),
  };
}

export function draw(engine: Engine, state: EngineState, date: string): DrawResult {
  const { kind, scored } = scoreAll(engine, state, date);

  const weights = scored.map((entry) => entry.weight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const seed = `moviespinner:${kind}:${date}`;
  const index = weightedPick(weights, randomForSeed(seed));
  if (index < 0) throw new Error(`No candidate had any weight on ${date}`);

  const chosen = scored[index]!;
  return {
    date,
    kind,
    seed,
    chosen,
    share: chosen.weight / total,
    topShare: Math.max(...weights) / total,
    poolSize: scored.length,
  };
}

/** One row of `picks`, already flattened. `reason` is the serialised breakdown. */
export interface PickRecord {
  date: string;
  /** Which of the day's rounds this settles. Round 1 is the day's first slate. */
  round: number;
  tmdbId: number;
  kind: PickKind;
  seed: string;
  weight: number;
  share: number;
  topShare: number;
  poolSize: number;
  reason: string;
  lineageFrom: number | null;
  lineageRationale: string | null;
}

/**
 * The one door into `picks`, and the one place that refuses to overwrite.
 *
 * Every caller goes through here on purpose: a film drawn as the day's single
 * pick, a film chosen off a slate and a film locked in by hand are the same
 * commitment, and having three inserts would mean having three chances to
 * forget the guard.
 *
 * The guard is now keyed on (date, round) rather than on date. That is not a
 * loosening of it: a round still resolves to exactly one film and choosing is
 * still final. What changed is that a day can hold more than one round, and a
 * later round only exists because the earlier one was watched -- so reaching
 * this a second time on the same day means you finished a film, not that you
 * changed your mind about one.
 */
export function persistPickRecord(db: Db, record: PickRecord): void {
  const existing = db
    .prepare('SELECT tmdb_id FROM picks WHERE pick_date = ? AND round = ?')
    .get(record.date, record.round);
  if (existing) {
    throw new Error(
      `${record.date} round ${record.round} already has a pick. There is no reroll.`,
    );
  }

  db.prepare(
    `INSERT INTO picks
       (pick_date, round, tmdb_id, kind, seed, weight, share, top_share, pool_size, reason_json,
        lineage_from, lineage_rationale, status, created_at)
     VALUES (@date, @round, @tmdbId, @kind, @seed, @weight, @share, @topShare, @poolSize, @reason,
             @lineageFrom, @lineageRationale, 'pending', @createdAt)`,
  ).run({ ...record, createdAt: new Date().toISOString() });
}

/** Writes a draw down. Refuses to overwrite, because that would be a reroll. */
export function persistPick(db: Db, result: DrawResult): void {
  persistPickRecord(db, {
    date: result.date,
    round: 1,
    tmdbId: result.chosen.candidate.tmdbId,
    kind: result.kind,
    seed: result.seed,
    weight: result.chosen.weight,
    share: result.share,
    topShare: result.topShare,
    poolSize: result.poolSize,
    reason: JSON.stringify(result.chosen.reason),
    lineageFrom: result.chosen.candidate.lineage?.fromTmdbId ?? null,
    lineageRationale: result.chosen.candidate.lineage?.rationale ?? null,
  });
}

/**
 * Whether a pick points at a film the current pool no longer contains.
 *
 * The only condition under which a redraw is allowed. Rebuilding the pool can
 * strand a pick on a film that is no longer a candidate, and that is a stale
 * record rather than a choice anyone made.
 */
export function isPickStale(db: Db, date: string, round = 1): boolean {
  const row = db
    .prepare(
      `SELECT p.tmdb_id, EXISTS (SELECT 1 FROM pool WHERE tmdb_id = p.tmdb_id) AS in_pool
       FROM picks p WHERE p.pick_date = ? AND p.round = ?`,
    )
    .get(date, round) as { tmdb_id: number; in_pool: number } | undefined;
  return row !== undefined && row.in_pool === 0;
}

/**
 * Puts a resolved pick back to pending.
 *
 * This is not a reroll and does not touch which film was drawn. It exists
 * because "watched" and "skip" sit next to each other and a misclick should not
 * need a database edit to undo.
 */
export function unresolvePick(db: Db, date: string, round = 1): void {
  // A later round only exists because this one was watched, so un-watching it
  // would leave the day holding a slate it never earned.
  //
  // Read from `slates` rather than `picks`: the later round is unearned the
  // moment it is *drawn*, and it may well have been drawn and not yet chosen
  // from -- which is exactly the window in which this would otherwise slip
  // through.
  const later = db
    .prepare('SELECT MAX(round) AS n FROM slates WHERE slate_date = ?')
    .get(date) as { n: number | null } | undefined;
  if ((later?.n ?? round) > round) {
    throw new Error(
      `${date} has a round ${later?.n} that this one earned. Undo that first.`,
    );
  }

  const changed = db
    .prepare(
      `UPDATE picks SET status = 'pending', resolved_on = NULL
       WHERE pick_date = ? AND round = ? AND status <> 'pending'`,
    )
    .run(date, round).changes;
  if (changed === 0) throw new Error(`No resolved pick on ${date} round ${round}`);
}

export function resolvePick(
  db: Db,
  date: string,
  status: 'watched' | 'skipped',
  round = 1,
): void {
  const changed = db
    .prepare(
      `UPDATE picks SET status = ?, resolved_on = ?
       WHERE pick_date = ? AND round = ? AND status = 'pending'`,
    )
    .run(status, dayOf(), date, round).changes;
  if (changed === 0) throw new Error(`No pending pick on ${date} round ${round}`);
}
