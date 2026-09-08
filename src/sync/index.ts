import type { Db } from '../db/client';
import { loadMovements } from '../coverage';
import { createEngine, loadState } from '../engine';
import { drawSlate, persistSlate } from '../engine/slate';
import { loadLineage } from '../engine/lineage';
import { fetchFeed } from './rss';
import type { RssEntry } from './rss';

export interface SyncResult {
  entries: number;
  newEntries: number;
  resolved: { date: string; title: string; watchedOn: string | null }[];
  generated: string | null;
  unmatched: string[];
}

/**
 * One daily run: read the feed, record what is new, close out any pending pick
 * the feed says I watched, and make sure today has a slate to choose from.
 *
 * Deliberately does not touch coverage. The zip export is tier 1 and stays the
 * source of truth for what I have seen; this only knows about the last fifty
 * diary entries and would give a partial, drifting picture if it fed the
 * dimensions directly.
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

  // A pending pick closes when the feed shows that film watched on or after the
  // day it was offered. Watching it earlier and logging it late would be a
  // different thing, and is left to the manual button.
  const pending = db
    .prepare(
      `SELECT p.pick_date, p.tmdb_id, t.title FROM picks p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE p.status = 'pending'`,
    )
    .all() as { pick_date: string; tmdb_id: number; title: string }[];

  const resolved: SyncResult['resolved'] = [];
  const findWatch = db.prepare(
    `SELECT watched_date FROM rss_entries
     WHERE tmdb_id = ? AND (watched_date IS NULL OR watched_date >= ?)
     ORDER BY watched_date DESC LIMIT 1`,
  );
  const close = db.prepare(
    `UPDATE picks SET status = 'watched', resolved_on = ? WHERE pick_date = ? AND status = 'pending'`,
  );

  db.transaction(() => {
    for (const pick of pending) {
      const hit = findWatch.get(pick.tmdb_id, pick.pick_date) as
        | { watched_date: string | null }
        | undefined;
      if (!hit) continue;
      close.run(hit.watched_date ?? date, pick.pick_date);
      resolved.push({ date: pick.pick_date, title: pick.title, watchedOn: hit.watched_date });
    }
  })();

  // The cron draws the day's slate as well as reading the feed, so the five are
  // already waiting rather than being conjured by whoever opens the page.
  //
  // It draws the slate and stops there. It cannot choose for you -- that is the
  // whole point of the slate -- so a day the cron has prepared and nobody has
  // opened has five films and no pick, which is exactly right.
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

  db.prepare(
    `INSERT INTO sync_runs (ran_at, entries, new_entries, resolved, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(now, feed.length, newEntries, resolved.length, generated ? `drew the slate for ${generated}` : null);

  return { entries: feed.length, newEntries, resolved, generated, unmatched: [...new Set(unmatched)] };
}
