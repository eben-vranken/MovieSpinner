import type { Db } from '../db/client';
import { loadMovements } from '../coverage';
import { createEngine, loadState, scoreAll } from './index';
import { loadLineage } from './lineage';
import { chooseFromSlate } from './choose';

/**
 * Locking a film in by hand.
 *
 * The slate answers "what should I watch tonight". This answers "I want to
 * watch Solaris tonight", which is a different and equally legitimate question
 * -- usually asked when you already know the gap and do not need the engine to
 * find it for you.
 *
 * Three things keep it from dissolving the project:
 *
 * 1. **It can only reach into the pool.** 4,470 films you have not seen, already
 *    filtered and shaped. You override which blind spot you close, never
 *    whether you close one.
 * 2. **It is scored, not waved through.** The film goes through the same
 *    `scoreAll` the slate used, on the same date, against the same state, so
 *    the card still says which gap it closes and what it would have weighed.
 *    A manual pick is not an unexplained pick.
 * 3. **It is still one film, still final.** It goes through `chooseFromSlate`,
 *    which goes through `persistPickRecord`, which refuses to overwrite. Locking
 *    in after you have already chosen fails, exactly as a second click does.
 *
 * The film is appended to the day's slate as a manual row rather than replacing
 * one of the five, so the log keeps saying what was actually on the table.
 */
export function lockInFilm(db: Db, date: string, tmdbId: number): { title: string } {
  const film = db
    .prepare(
      `SELECT t.title, EXISTS (SELECT 1 FROM pool p WHERE p.tmdb_id = t.tmdb_id) AS in_pool
       FROM tmdb_films t WHERE t.tmdb_id = ?`,
    )
    .get(tmdbId) as { title: string; in_pool: number } | undefined;

  if (!film) throw new Error(`No film with TMDB id ${tmdbId}.`);
  if (film.in_pool === 0) {
    throw new Error(
      `${film.title} is not in the candidate pool, so it cannot be locked in. ` +
        'The override picks which blind spot to close, not whether to close one.',
    );
  }

  // Already on today's slate: locking it in is just choosing it. Falling through
  // to the append below would violate the (slate_date, tmdb_id) key, and the
  // error would be about an index rather than about what you did.
  const already = db
    .prepare('SELECT 1 AS ok FROM slates WHERE slate_date = ? AND tmdb_id = ?')
    .get(date, tmdbId);
  if (already) {
    chooseFromSlate(db, date, tmdbId);
    return { title: film.title };
  }

  // Fail before scoring rather than after. Scoring the whole pool to then be
  // told the day is settled would be slow and confusing in equal measure.
  const taken = db.prepare('SELECT tmdb_id FROM picks WHERE pick_date = ?').get(date);
  if (taken) throw new Error(`${date} already has a pick. There is no reroll.`);

  loadMovements(db);
  loadLineage(db);
  const engine = createEngine(db);
  const state = loadState(db);
  const { kind, scored } = scoreAll(engine, state, date);

  const entry = scored.find((candidate) => candidate.candidate.tmdbId === tmdbId);
  // In the pool but not scoreable means it is already taken by an earlier pick,
  // which `scoreAll` filters out. That is a genuine refusal, not a gap.
  if (!entry) {
    throw new Error(`${film.title} has already been picked on an earlier day.`);
  }

  const total = scored.reduce((sum, candidate) => sum + candidate.weight, 0);
  const topShare = total === 0 ? 0 : Math.max(...scored.map((c) => c.weight)) / total;

  const nextPosition =
    ((db.prepare('SELECT MAX(position) AS n FROM slates WHERE slate_date = ?').get(date) as
      | { n: number | null }
      | undefined)?.n ?? -1) + 1;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO slates
         (slate_date, tmdb_id, position, kind, seed, weight, share, top_share, pool_size,
          reason_json, lineage_from, lineage_rationale, created_at, manual)
       VALUES (@date, @tmdbId, @position, @kind, @seed, @weight, @share, @topShare, @poolSize,
               @reason, @lineageFrom, @lineageRationale, @createdAt, 1)`,
    ).run({
      date,
      tmdbId,
      position: nextPosition,
      kind,
      // The seed says where the film came from. A manual pick came from you,
      // and recording the date seed would imply the draw produced it.
      seed: `moviespinner:manual:${date}`,
      weight: entry.weight,
      share: total === 0 ? 0 : entry.weight / total,
      topShare,
      poolSize: scored.length,
      reason: JSON.stringify(entry.reason),
      lineageFrom: entry.candidate.lineage?.fromTmdbId ?? null,
      lineageRationale: entry.candidate.lineage?.rationale ?? null,
      createdAt: new Date().toISOString(),
    });

    chooseFromSlate(db, date, tmdbId);
  })();

  return { title: film.title };
}
