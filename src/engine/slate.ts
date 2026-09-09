import type { Db } from '../db/client';
import { scoreAll } from './index';
import type { Engine, EngineState, PickKind, Scored } from './index';
import { randomForSeed, weightedPick } from './random';

/**
 * The daily slate: five films drawn from the same scoring the single pick used.
 *
 * Drawing five instead of one is the only change. The weights are identical, so
 * a slate still leans at the decade, country, director and movement you have
 * least of; you simply get to say which of the five gaps you feel like closing
 * tonight.
 *
 * Sampling is without replacement, which is why this cannot just call `draw`
 * five times: the same date seed would return the same film every time. Each
 * pick removes its film from the running total, so `share` below is the film's
 * probability *at the moment it came up*, not its probability in the original
 * pool. Position 0 is therefore drawn from the full distribution and position 4
 * from a slightly depleted one, which is the honest number to record and the
 * one the page shows.
 */

export interface SlateEntry {
  position: number;
  scored: Scored;
  /** Probability of this film at the moment it was drawn. */
  share: number;
}

export interface SlateResult {
  date: string;
  /** Which of the day's rounds this is. Round 1 is the day's first slate. */
  round: number;
  kind: PickKind;
  seed: string;
  entries: SlateEntry[];
  /** The best-weighted film's probability in the undepleted pool. */
  topShare: number;
  poolSize: number;
  /** Set when the five came from a campaign queue rather than a weighted draw. */
  campaignId?: number;
}

/**
 * What a later round needs to know that the first one does not.
 *
 * `exclude` is the day's earlier rounds. A film is offered at most once a day,
 * so round 2 is five films you have not been shown today rather than the four
 * you passed over plus one -- being handed the same near-slate again would make
 * a second round feel like a reroll even though it is not one.
 */
export interface DrawOptions {
  round?: number;
  size?: number;
  exclude?: ReadonlySet<number>;
}

export function drawSlate(
  engine: Engine,
  state: EngineState,
  date: string,
  { round = 1, size = engine.tuning.slateSize, exclude }: DrawOptions = {},
): SlateResult {
  const { kind, scored: everything } = scoreAll(engine, state, date);
  const scored =
    exclude && exclude.size > 0
      ? everything.filter((entry) => !exclude.has(entry.candidate.tmdbId))
      : everything;
  if (scored.length === 0) throw new Error(`Nothing was available to draw on ${date}`);

  // A separate seed namespace from the old one-a-day draw. Reusing that seed
  // would make position 0 of the slate identical to the film the previous
  // version of this app would have handed over, which looks like a bug the
  // first time you notice it and is not worth the coincidence.
  //
  // Round 1 keeps the bare date seed it has always had, so every slate already
  // drawn and every simulation still reproduces exactly. Later rounds are a
  // suffix rather than a different scheme, because a second round drawn from
  // the same stream would hand back the same five films minus the taken one.
  const seed = `moviespinner:slate:${kind}:${date}${round > 1 ? `:r${round}` : ''}`;
  const random = randomForSeed(seed);

  const weights = scored.map((entry) => entry.weight);
  const fullTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(fullTotal > 0)) throw new Error(`No candidate had any weight on ${date}`);

  // Copied, because each draw zeroes the film it took so it cannot come up again.
  const remaining = [...weights];
  let remainingTotal = fullTotal;
  const entries: SlateEntry[] = [];

  for (let position = 0; position < Math.min(size, scored.length); position += 1) {
    const index = weightedPick(remaining, random);
    if (index < 0) break; // Everything left weighs nothing. A short slate beats a fake one.

    const weight = remaining[index]!;
    entries.push({ position, scored: scored[index]!, share: weight / remainingTotal });

    remaining[index] = 0;
    remainingTotal -= weight;
  }

  return {
    date,
    round,
    kind,
    seed,
    entries,
    topShare: Math.max(...weights) / fullTotal,
    poolSize: scored.length,
  };
}

/**
 * Writes a slate down.
 *
 * Refuses to overwrite for the same reason `persistPick` does: a slate
 * recomputed tomorrow against a grown watched set would offer a different five
 * films, and "here are today's five" would silently become "here are five films
 * as of whenever you last looked".
 *
 * Keyed on (date, round), so a day's second round is a new slate rather than an
 * overwrite of its first. The refusal is unchanged in strength -- a round that
 * has been drawn can never be drawn again.
 */
export function persistSlate(db: Db, result: SlateResult): void {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM slates WHERE slate_date = ? AND round = ?')
    .get(result.date, result.round) as { n: number };
  if (existing.n > 0) {
    throw new Error(`${result.date} already has a slate for round ${result.round}.`);
  }

  const insert = db.prepare(
    `INSERT INTO slates
       (slate_date, round, tmdb_id, position, kind, seed, weight, share, top_share, pool_size,
        reason_json, lineage_from, lineage_rationale, created_at, campaign_id)
     VALUES (@date, @round, @tmdbId, @position, @kind, @seed, @weight, @share, @topShare,
             @poolSize, @reason, @lineageFrom, @lineageRationale, @createdAt, @campaignId)`,
  );

  const createdAt = new Date().toISOString();
  db.transaction(() => {
    for (const entry of result.entries) {
      insert.run({
        date: result.date,
        round: result.round,
        tmdbId: entry.scored.candidate.tmdbId,
        position: entry.position,
        kind: result.kind,
        seed: result.seed,
        weight: entry.scored.weight,
        share: entry.share,
        topShare: result.topShare,
        poolSize: result.poolSize,
        reason: JSON.stringify(entry.scored.reason),
        lineageFrom: entry.scored.candidate.lineage?.fromTmdbId ?? null,
        lineageRationale: entry.scored.candidate.lineage?.rationale ?? null,
        createdAt,
        campaignId: result.campaignId ?? null,
      });
    }
  })();
}

/**
 * The highest round drawn on a date. Zero when the day has no slate at all.
 *
 * "The current round" is always the last one drawn, never the last one
 * resolved: a round you have been offered and not chosen from is still the
 * round you are in, and skipping past it is the reroll this project does not
 * have.
 */
export function currentRound(db: Db, date: string): number {
  const row = db.prepare('SELECT MAX(round) AS n FROM slates WHERE slate_date = ?').get(date) as
    | { n: number | null }
    | undefined;
  return row?.n ?? 0;
}

/** Every film already offered on a date, so a later round does not repeat one. */
export function offeredOn(db: Db, date: string): Set<number> {
  return new Set(
    (db.prepare('SELECT tmdb_id FROM slates WHERE slate_date = ?').all(date) as {
      tmdb_id: number;
    }[]).map((row) => row.tmdb_id),
  );
}
