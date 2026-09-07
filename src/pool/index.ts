import type { Db } from '../db/client';
import { loadLineage, LINEAGE_FILE } from '../engine/lineage';
import { persistMovie } from '../ingest/enrich';
import { TmdbClient, TmdbHttpError } from '../tmdb/client';
import { rankCandidates, resolveTies } from '../tmdb/match';
import {
  fetchCriterion,
  fetchTspdt,
  readMovementDirectors,
  readRegions,
  CRITERION_URL,
  TSPDT_URL,
} from './sources';
import type { SourceEntry } from './sources';

/**
 * Build step 4: seed the candidate lists, dedupe, exclude watched.
 *
 * The pool is deliberately uncapped. A cap would need raising the moment it was
 * cleared, and "percent of pool cleared" is a progress bar that resets. Progress
 * is reported against movements and regions instead, which close and stay
 * closed.
 *
 * The three source kinds do different jobs and it is worth keeping them
 * distinct:
 *
 * - **TSPDT 1000** is the critical canon, and it publishes IMDb ids, so it
 *   resolves exactly rather than through title matching.
 * - **The Criterion Collection** is a distribution list rather than a canon. It
 *   is broader, weirder, and overlaps the canon heavily.
 * - **Regional discover queries** are the part §6 insists on. Without them the
 *   country weights would generate demand the pool cannot supply. They are also
 *   the only source that can answer "how many Senegalese films are there even
 *   available", which turns out to be the real constraint.
 */

export interface ListReport {
  slug: string;
  name: string;
  kind: string;
  entries: number;
  resolved: number;
  unresolved: number;
}

export interface PoolResult {
  lists: ListReport[];
  poolSize: number;
  distinctFromLists: number;
  alreadyWatched: number;
  onWatchlist: number;
  requests: number;
  cacheHits: number;
}

interface ResolvedEntry {
  tmdbId: number;
  position: number | null;
  title: string;
  year: number | null;
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Turns source rows into TMDB ids.
 *
 * An IMDb id short-circuits everything. Without one it falls back to the same
 * matcher the Letterboxd import uses, at the same confidence bar: only exact
 * and near titles are accepted, because a pool seeded with plausible-looking
 * wrong films would poison every draw afterwards and nobody would notice.
 */
async function resolveEntries(
  client: TmdbClient,
  entries: SourceEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ resolved: ResolvedEntry[]; unresolved: (SourceEntry & { reason: string })[] }> {
  const resolved: ResolvedEntry[] = [];
  const unresolved: (SourceEntry & { reason: string })[] = [];
  let done = 0;

  await mapPool(entries, 10, async (entry) => {
    if (entry.isSet) {
      unresolved.push({ ...entry, reason: 'box set or compilation, not a single film' });
      done += 1;
      onProgress?.(done, entries.length);
      return;
    }
    if (entry.imdbId) {
      const hit = await client.findByImdb(entry.imdbId);
      if (hit) {
        resolved.push({ tmdbId: hit.id, position: entry.position, title: entry.title, year: entry.year });
      } else {
        unresolved.push({ ...entry, reason: `IMDb ${entry.imdbId} has no TMDB movie` });
      }
    } else {
      const search = await client.searchMovie(entry.title, entry.year);
      let best = resolveTies(rankCandidates(entry.title, entry.year, search.results ?? []));
      if (!best || (best.method !== 'exact' && best.method !== 'near')) {
        const wide = await client.searchMovie(entry.title, null);
        best = resolveTies(rankCandidates(entry.title, entry.year, wide.results ?? []));
      }
      if (best && (best.method === 'exact' || best.method === 'near')) {
        resolved.push({ tmdbId: best.tmdbId, position: entry.position, title: entry.title, year: entry.year });
      } else {
        unresolved.push({ ...entry, reason: best ? `best guess only scored ${best.score.toFixed(2)}` : 'no search results' });
      }
    }
    done += 1;
    onProgress?.(done, entries.length);
  });

  return { resolved, unresolved };
}

function writeList(
  db: Db,
  list: { slug: string; name: string; kind: string; source: string; note: string | null },
  resolved: ResolvedEntry[],
  unresolved: (SourceEntry & { reason: string })[],
  totalEntries: number,
): ListReport {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO pool_lists (slug, name, kind, source, note, entries, resolved, loaded_at)
       VALUES (@slug, @name, @kind, @source, @note, @entries, @resolved, @loadedAt)
       ON CONFLICT (slug) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, source = excluded.source,
         note = excluded.note, entries = excluded.entries, resolved = excluded.resolved,
         loaded_at = excluded.loaded_at`,
    ).run({
      ...list,
      entries: totalEntries,
      resolved: resolved.length,
      loadedAt: new Date().toISOString(),
    });

    db.prepare('DELETE FROM pool_list_entries WHERE list_slug = ?').run(list.slug);
    db.prepare('DELETE FROM pool_unresolved WHERE list_slug = ?').run(list.slug);

    const insert = db.prepare(
      `INSERT INTO pool_list_entries (list_slug, tmdb_id, position, title, year)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (list_slug, tmdb_id) DO UPDATE SET
         position = MIN(position, excluded.position)`,
    );
    for (const entry of resolved) {
      insert.run(list.slug, entry.tmdbId, entry.position, entry.title, entry.year);
    }

    const miss = db.prepare(
      `INSERT INTO pool_unresolved (list_slug, title, year, position, reason)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const entry of unresolved) {
      miss.run(list.slug, entry.title, entry.year, entry.position, entry.reason);
    }
  })();

  return {
    slug: list.slug,
    name: list.name,
    kind: list.kind,
    entries: totalEntries,
    resolved: resolved.length,
    // Box sets are not films, so they are not matching failures either.
    unresolved: unresolved.filter((entry) => !entry.isSet).length,
  };
}

export interface BuildOptions {
  /** Re-scrape the canon list pages and bypass the TMDB response cache. */
  refresh?: boolean;
  region?: string;
  onStage?: (message: string) => void;
}

export async function buildPool(db: Db, options: BuildOptions = {}): Promise<PoolResult> {
  const region = options.region ?? 'BE';
  const client = new TmdbClient({ refresh: options.refresh, concurrency: 10 });
  const stage = options.onStage ?? (() => {});
  const lists: ListReport[] = [];

  // --- canon: TSPDT ---------------------------------------------------------
  stage('fetching TSPDT 1000');
  const tspdt = await fetchTspdt(options.refresh);
  stage(`resolving ${tspdt.length} TSPDT entries by IMDb id`);
  const tspdtResolved = await resolveEntries(client, tspdt);
  lists.push(
    writeList(
      db,
      {
        slug: 'tspdt-1000',
        name: 'TSPDT 1000 Greatest Films',
        kind: 'canon',
        source: TSPDT_URL,
        note: 'Ranked. Publishes IMDb ids, so every row resolves exactly.',
      },
      tspdtResolved.resolved,
      tspdtResolved.unresolved,
      tspdt.length,
    ),
  );

  // --- collection: Criterion ------------------------------------------------
  stage('fetching the Criterion Collection');
  const criterion = await fetchCriterion(options.refresh);
  stage(`resolving ${criterion.length} Criterion entries by title`);
  const criterionResolved = await resolveEntries(client, criterion);
  lists.push(
    writeList(
      db,
      {
        slug: 'criterion',
        name: 'The Criterion Collection',
        kind: 'collection',
        source: CRITERION_URL,
        note: 'Ordered by spine number. Title matched, so a few percent will not resolve.',
      },
      criterionResolved.resolved,
      criterionResolved.unresolved,
      criterion.filter((entry) => !entry.isSet).length,
    ),
  );

  // --- regional -------------------------------------------------------------
  const regions = readRegions();
  stage(`seeding ${regions.length} regional lists`);
  for (const config of regions) {
    const entries: ResolvedEntry[] = [];
    // Sorted by vote count rather than rating: within a small national cinema
    // the well-known films are the canonical ones, while rating-sorted results
    // are dominated by concert films and children's compilations.
    for (let page = 1; page <= Math.ceil(config.limit / 20) && entries.length < config.limit; page += 1) {
      const response = await client.discover({
        with_origin_country: config.country,
        sort_by: 'vote_count.desc',
        'vote_count.gte': String(config.minVotes),
        include_adult: 'false',
        page: String(page),
      });
      for (const film of response.results ?? []) {
        if (entries.length >= config.limit) break;
        entries.push({
          tmdbId: film.id,
          position: null,
          title: film.title,
          year: Number.parseInt((film.release_date ?? '').slice(0, 4), 10) || null,
        });
      }
      if ((response.results ?? []).length === 0) break;
    }
    lists.push(
      writeList(
        db,
        {
          slug: `region-${config.country.toLowerCase()}`,
          name: config.name,
          kind: 'regional',
          source: `discover: with_origin_country=${config.country}, vote_count.gte=${config.minVotes}, limit ${config.limit}`,
          note: config.note,
        },
        entries,
        [],
        entries.length,
      ),
    );
  }

  // --- auteur lists, one per movement ---------------------------------------
  // The canon and regional lists between them left Spaghetti Western and Cinema
  // of Moral Anxiety with zero films in the pool, which would have the engine
  // pointing at a gap it could never fill. data/movement-directors.csv already
  // names who defines each movement, so the same file seeds the pool: every film
  // those directors made inside the movement's period.
  const movements = readMovementDirectors(db);
  stage(`seeding ${movements.length} auteur lists from the movement director lists`);
  for (const movement of movements) {
    const entries: ResolvedEntry[] = [];
    const unresolvedNames: (SourceEntry & { reason: string })[] = [];

    await mapPool(movement.directors, 8, async (name) => {
      const person = await client.searchPerson(name);
      if (!person) {
        unresolvedNames.push({ position: null, title: name, year: null, reason: 'no TMDB person' });
        return;
      }
      const credits = await client.personCredits(person.id);
      for (const credit of credits.crew ?? []) {
        if (credit.job !== 'Director') continue;
        const year = Number.parseInt((credit.release_date ?? '').slice(0, 4), 10) || null;
        if (year === null) continue;
        if (movement.start !== null && year < movement.start) continue;
        if (movement.end !== null && year > movement.end) continue;
        entries.push({ tmdbId: credit.id, position: null, title: credit.title, year });
      }
    });

    lists.push(
      writeList(
        db,
        {
          slug: `auteur-${movement.slug}`,
          name: `${movement.name} directors`,
          kind: 'auteur',
          source: 'data/movement-directors.csv, filtered to the movement period',
          note: `${movement.directors.length} directors`,
        },
        entries,
        unresolvedNames,
        entries.length,
      ),
    );
  }

  // --- lineage targets ------------------------------------------------------
  // An edge is a hand-written argument that I should see a particular film, so
  // it would be absurd for that film not to be in the pool. Four of them were
  // not, before this list existed.
  const lineage = loadLineage(db);
  if (lineage.edges > 0) {
    stage(`seeding ${lineage.targets.length} lineage targets`);
    lists.push(
      writeList(
        db,
        {
          slug: 'lineage',
          name: 'Lineage edge targets',
          kind: 'lineage',
          source: LINEAGE_FILE,
          note: `${lineage.edges} hand-authored edges`,
        },
        lineage.targets.map((tmdbId) => ({ tmdbId, position: null, title: '', year: null })),
        [],
        lineage.targets.length,
      ),
    );
  }

  // --- fetch metadata for everything the lists produced ----------------------
  const ids = (
    db.prepare('SELECT DISTINCT tmdb_id FROM pool_list_entries').all() as { tmdb_id: number }[]
  ).map((row) => row.tmdb_id);
  const missing = ids.filter(
    (id) =>
      !(
        db.prepare('SELECT 1 AS ok FROM tmdb_films WHERE tmdb_id = ?').get(id) as
          | { ok: number }
          | undefined
      ),
  );
  stage(`fetching TMDB metadata for ${missing.length} new films (${ids.length} in the lists)`);

  const now = new Date().toISOString();
  const batchSize = 200;
  const vanished: number[] = [];
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    // A 404 here means TMDB deleted the record after some list pointed at it.
    // That is one dead film, not a reason to abandon three thousand others.
    const details = await mapPool(batch, 10, async (id) => {
      try {
        return await client.movie(id);
      } catch (error) {
        if (error instanceof TmdbHttpError && error.status === 404) {
          vanished.push(id);
          return undefined;
        }
        throw error;
      }
    });
    db.transaction(() => {
      for (const detail of details) if (detail) persistMovie(db, detail, region, now);
    })();
    stage(`  stored ${Math.min(start + batchSize, missing.length)}/${missing.length}`);
  }

  if (vanished.length > 0) {
    stage(`${vanished.length} id(s) no longer exist on TMDB; dropping them from the lists`);
    const drop = db.prepare('DELETE FROM pool_list_entries WHERE tmdb_id = ?');
    db.transaction(() => {
      for (const id of vanished) drop.run(id);
    })();
  }

  // --- materialise the pool -------------------------------------------------
  stage('deduping and excluding watched');
  const result = db.transaction(() => {
    db.prepare('DELETE FROM pool').run();
    db.prepare('DELETE FROM pool_excluded').run();

    db.prepare(
      `INSERT INTO pool_excluded (tmdb_id, reason)
       SELECT DISTINCT e.tmdb_id, 'watched' FROM pool_list_entries e
       WHERE e.tmdb_id IN (
         SELECT m.tmdb_id FROM watched w JOIN film_matches m ON m.film_id = w.film_id
         WHERE m.tmdb_id IS NOT NULL
       )`,
    ).run();

    // A watchlist film stays in the pool and earns a bonus later. A watched film
    // never comes back, so exclusion is applied after the watchlist flag rather
    // than being something a bonus could override.
    // Shorts are excluded. The brief says runtime is a soft signal and that a
    // three-hour film on a weeknight is fine, but a seventeen-minute short is
    // not a day's film in the sense any of this is about. Films with no runtime
    // on record stay in rather than being punished for a missing field.
    db.prepare(
      `INSERT INTO pool (tmdb_id, list_count, best_rank, on_watchlist, kinds, added_at)
       SELECT e.tmdb_id,
              COUNT(DISTINCT e.list_slug),
              MIN(e.position),
              CASE WHEN e.tmdb_id IN (
                SELECT m.tmdb_id FROM watchlist wl JOIN film_matches m ON m.film_id = wl.film_id
                WHERE m.tmdb_id IS NOT NULL
              ) THEN 1 ELSE 0 END,
              (SELECT GROUP_CONCAT(DISTINCT l.kind) FROM pool_list_entries e2
               JOIN pool_lists l ON l.slug = e2.list_slug WHERE e2.tmdb_id = e.tmdb_id),
              ?
       FROM pool_list_entries e
       JOIN tmdb_films t ON t.tmdb_id = e.tmdb_id
       WHERE e.tmdb_id NOT IN (SELECT tmdb_id FROM pool_excluded)
         AND (t.runtime IS NULL OR t.runtime = 0 OR t.runtime >= 40
              -- A lineage edge is a hand-written argument that this exact film
              -- matters, which outranks a blanket rule about length. Night and
              -- Fog is thirty-two minutes and belongs in the pool.
              OR EXISTS (SELECT 1 FROM lineage_edges le WHERE le.to_tmdb_id = e.tmdb_id))
       GROUP BY e.tmdb_id`,
    ).run(now);

    const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      poolSize: scalar('SELECT COUNT(*) AS n FROM pool'),
      distinctFromLists: scalar('SELECT COUNT(DISTINCT tmdb_id) AS n FROM pool_list_entries'),
      alreadyWatched: scalar('SELECT COUNT(*) AS n FROM pool_excluded'),
      onWatchlist: scalar('SELECT COUNT(*) AS n FROM pool WHERE on_watchlist = 1'),
    };
  })();

  return {
    lists,
    ...result,
    requests: client.stats.requests,
    cacheHits: client.stats.cacheHits,
  };
}
