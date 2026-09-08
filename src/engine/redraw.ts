import type { Db } from '../db/client';
import { isPickStale, persistPickRecord } from './index';
import type { PickKind } from './index';

export interface RedrawResult {
  date: string;
  from: { tmdbId: number; title: string };
  to: { tmdbId: number; title: string };
}

/**
 * Replaces a chosen film that is no longer in the candidate pool.
 *
 * This is the single crack in the no-reroll rule and it is deliberately shaped
 * so it cannot be used as one. It refuses unless the film has actually fallen
 * out of the pool, which only happens when the pool is rebuilt underneath a
 * pick. Disliking the film is not a qualifying condition and never will be.
 *
 * With a slate, the repair is better than it used to be. The old version had to
 * draw a fresh film out of nowhere, which meant a stale day silently got a pick
 * from a different mechanism than every other day. Now the other four films you
 * were offered that morning are still sitting there, so the replacement comes
 * off the same slate you originally chose from -- you re-choose rather than
 * being handed something.
 *
 * The superseded row is copied into `pick_redraws` in the same transaction, so
 * the history says what changed instead of quietly showing a different film
 * than it did yesterday.
 */
export function rechooseStalePick(db: Db, date: string, tmdbId: number): RedrawResult {
  const existing = db
    .prepare(
      `SELECT p.tmdb_id, p.status, t.title FROM picks p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id WHERE p.pick_date = ?`,
    )
    .get(date) as { tmdb_id: number; status: string; title: string } | undefined;

  if (!existing) throw new Error(`There is no pick on ${date} to replace.`);
  if (!isPickStale(db, date)) {
    throw new Error(
      `${existing.title} is still in the pool, so ${date} is not stale. There is no reroll.`,
    );
  }
  if (tmdbId === existing.tmdb_id) {
    throw new Error(`${existing.title} is the film that went stale. Choose a different one.`);
  }

  const replacement = db
    .prepare(
      `SELECT s.*, t.title,
              EXISTS (SELECT 1 FROM pool p WHERE p.tmdb_id = s.tmdb_id) AS in_pool
       FROM slates s JOIN tmdb_films t ON t.tmdb_id = s.tmdb_id
       WHERE s.slate_date = ? AND s.tmdb_id = ?`,
    )
    .get(date, tmdbId) as
    | {
        tmdb_id: number;
        kind: PickKind;
        seed: string;
        weight: number;
        share: number;
        top_share: number;
        pool_size: number;
        reason_json: string;
        lineage_from: number | null;
        lineage_rationale: string | null;
        title: string;
        in_pool: number;
      }
    | undefined;

  if (!replacement) throw new Error(`${tmdbId} was not on the slate for ${date}.`);
  // Swapping one film that fell out of the pool for another would repair
  // nothing, and next rebuild you would be back here.
  if (replacement.in_pool === 0) {
    throw new Error(`${replacement.title} is not in the pool either.`);
  }

  return db.transaction(() => {
    // The old row has to go before the insert, or persistPickRecord would
    // refuse the replacement -- which is exactly what it should do everywhere
    // except right here.
    db.prepare('DELETE FROM picks WHERE pick_date = ?').run(date);

    persistPickRecord(db, {
      date,
      tmdbId: replacement.tmdb_id,
      kind: replacement.kind,
      seed: replacement.seed,
      weight: replacement.weight,
      share: replacement.share,
      topShare: replacement.top_share,
      poolSize: replacement.pool_size,
      reason: replacement.reason_json,
      lineageFrom: replacement.lineage_from,
      lineageRationale: replacement.lineage_rationale,
    });

    db.prepare(
      `INSERT INTO pick_redraws
         (pick_date, old_tmdb_id, old_title, old_status, new_tmdb_id, new_title, reason, redrawn_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      date,
      existing.tmdb_id,
      existing.title,
      existing.status,
      replacement.tmdb_id,
      replacement.title,
      'the film was no longer in the pool after a rebuild',
      new Date().toISOString(),
    );

    return {
      date,
      from: { tmdbId: existing.tmdb_id, title: existing.title },
      to: { tmdbId: replacement.tmdb_id, title: replacement.title },
    };
  })();
}
