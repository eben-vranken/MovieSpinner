import type { Db } from '../db/client';
import { loadMovements } from '../coverage';
import { createEngine, loadState } from '../engine';
import { drawSlate, persistSlate } from '../engine/slate';
import { loadLineage } from '../engine/lineage';
import { tmdbConfig } from '../config';
import { mergeWatched } from './merge';
import type { MergeResult } from './merge';
import { fetchFeed } from './rss';
import type { RssEntry } from './rss';

export interface SyncResult {
  entries: number;
  newEntries: number;
  resolved: { date: string; title: string; watchedOn: string | null }[];
  generated: string | null;
  unmatched: string[];
  merge: MergeResult;
}

/**
 * One daily run: read the feed, record what is new, fold anything newly
 * watched into the same tables a zip import writes, close out any pending
 * pick the feed says I watched, and make sure today has a slate to choose
 * from.
 *
 * Coverage, Taste, Browse and the pool all read those tables live, so this
 * is what keeps them current without a re-import -- as long as sync runs at
 * least once before fifty *new* diary entries pile up. `mergeWatched` (see
 * src/sync/merge.ts) is what makes feeding them from a 50-entry feed safe:
 * every entry carries an exact tmdb:movieId rather than a guessed title
 * match, and every write it makes is ON CONFLICT-safe, so running it over
 * the same entries on every sync is idempotent rather than a second source
 * of truth to keep in step with the zip.
 */
export async function sync(
  db: Db,
  username: string,
  options: { date?: string; generate?: boolean } = {},
): Promise<SyncResult> {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const feed = await fetchFeed(username);
  const now = new Date().toISOString();

  const insert = db.prepare(
    `INSERT INTO rss_entries
       (guid, tmdb_id, film_title, film_year, watched_date, rating, rewatch, liked, link, first_seen)
     VALUES (@guid, @tmdbId, @title, @year, @watchedDate, @rating, @rewatch, @liked, @link, @firstSeen)
     ON CONFLICT (guid) DO NOTHING`,
  );

  let newEntries = 0;
  const unmatched: string[] = [];
  db.transaction((rows: RssEntry[]) => {
    for (const entry of rows) {
      newEntries += insert.run({
        guid: entry.guid,
        tmdbId: entry.tmdbId,
        title: entry.title,
        year: entry.year,
        watchedDate: entry.watchedDate,
        rating: entry.rating,
        rewatch: entry.rewatch ? 1 : 0,
        liked: entry.liked ? 1 : 0,
        link: entry.link,
        firstSeen: now,
      }).changes;
      if (entry.tmdbId === null) unmatched.push(`${entry.title} (${entry.year ?? '?'})`);
    }
  })(feed);

  // Runs over every fetched entry, not just the ones that were new to
  // rss_entries just now -- everything in mergeWatched is ON CONFLICT-safe,
  // so this is free to repeat and self-heals a previous run that only got
  // partway through (e.g. a TMDB fetch that failed mid-sync).
  const merge = await mergeWatched(db, feed, tmdbConfig().region);

  // A pending pick closes when the feed shows that film watched on or after the
  // day it was offered. Watching it earlier and logging it late would be a
  // different thing, and is left to the manual button.
  const pending = db
    .prepare(
      `SELECT p.pick_date, p.round, p.tmdb_id, t.title FROM picks p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE p.status = 'pending'`,
    )
    .all() as { pick_date: string; round: number; tmdb_id: number; title: string }[];

  const resolved: SyncResult['resolved'] = [];
  const findWatch = db.prepare(
    `SELECT watched_date FROM rss_entries
     WHERE tmdb_id = ? AND (watched_date IS NULL OR watched_date >= ?)
     ORDER BY watched_date DESC LIMIT 1`,
  );
  // Per round, not per day: a day can hold several picks and closing the wrong
  // one would credit this evening's film to this afternoon's.
  const close = db.prepare(
    `UPDATE picks SET status = 'watched', resolved_on = ?
     WHERE pick_date = ? AND round = ? AND status = 'pending'`,
  );

  db.transaction(() => {
    for (const pick of pending) {
      const hit = findWatch.get(pick.tmdb_id, pick.pick_date) as
        | { watched_date: string | null }
        | undefined;
      if (!hit) continue;
      close.run(hit.watched_date ?? date, pick.pick_date, pick.round);
      resolved.push({ date: pick.pick_date, title: pick.title, watchedOn: hit.watched_date });
    }
  })();

  // The cron draws the day's slate as well as reading the feed, so the five are
  // already waiting rather than being conjured by whoever opens the page.
  //
  // It draws round 1 and stops there. It cannot choose for you -- that is the
  // whole point of the slate -- so a day the cron has prepared and nobody has
  // opened has five films and no pick, which is exactly right. It cannot deal a
  // second round either: a round is earned by watching the one before it, and a
  // scheduled job has no way to know whether you did.
  let generated: string | null = null;
  if (options.generate !== false) {
    const exists = db.prepare('SELECT 1 AS ok FROM slates WHERE slate_date = ?').get(date);
    if (!exists) {
      loadMovements(db);
      loadLineage(db);
      const engine = createEngine(db);
      if (engine.candidates.length > 0) {
        persistSlate(db, drawSlate(engine, loadState(db), date));
        generated = date;
      }
    }
  }

  const note = [
    merge.watchedAdded > 0 ? `merged ${merge.watchedAdded} newly watched` : null,
    generated ? `drew the slate for ${generated}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  db.prepare(
    `INSERT INTO sync_runs (ran_at, entries, new_entries, resolved, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(now, feed.length, newEntries, resolved.length, note || null);

  return {
    entries: feed.length,
    newEntries,
    resolved,
    generated,
    unmatched: [...new Set(unmatched)],
    merge,
  };
}
