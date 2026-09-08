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
  kind: PickKind;
  seed: string;
  entries: SlateEntry[];
  /** The best-weighted film's probability in the undepleted pool. */
  topShare: number;
  poolSize: number;
  /** Set when the five came from a campaign queue rather than a weighted draw. */
  campaignId?: number;
}

export function drawSlate(
  engine: Engine,
  state: EngineState,
  date: string,
  size: number = engine.tuning.slateSize,
): SlateResult {
  const { kind, scored } = scoreAll(engine, state, date);
  if (scored.length === 0) throw new Error(`Nothing was available to draw on ${date}`);

  // A separate seed namespace from the old one-a-day draw. Reusing that seed
  // would make position 0 of the slate identical to the film the previous
  // version of this app would have handed over, which looks like a bug the
  // first time you notice it and is not worth the coincidence.
  const seed = `moviespinner:slate:${kind}:${date}`;
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
 */
export function persistSlate(db: Db, result: SlateResult): void {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM slates WHERE slate_date = ?')
    .get(result.date) as { n: number };
  if (existing.n > 0) throw new Error(`${result.date} already has a slate.`);

  const insert = db.prepare(
    `INSERT INTO slates
       (slate_date, tmdb_id, position, kind, seed, weight, share, top_share, pool_size,
        reason_json, lineage_from, lineage_rationale, created_at, campaign_id)
     VALUES (@date, @tmdbId, @position, @kind, @seed, @weight, @share, @topShare, @poolSize,
             @reason, @lineageFrom, @lineageRationale, @createdAt, @campaignId)`,
  );

  const createdAt = new Date().toISOString();
  db.transaction(() => {
    for (const entry of result.entries) {
      insert.run({
        date: result.date,
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
