import { loadMovements } from '../coverage';
import { createEngine, loadState } from '../engine';
import { activeCampaign, campaignQueue, endCampaign } from '../engine/campaign';
import type { Campaign, CampaignKind, CampaignOrdering } from '../engine/campaign';
import { loadLineage } from '../engine/lineage';
import { DEFAULT_TUNING } from '../engine/tuning';
import { countryName } from './analytics';
import { db, today } from './db';

/**
 * The campaign, as the page needs it.
 *
 * Progress is computed rather than stored. A counter would have to be kept in
 * step with picks, redraws, re-imports and pool rebuilds, and would be wrong
 * after any of them; counting the rows is cheap and cannot drift.
 */

export interface CampaignFilm {
  tmdbId: number;
  title: string;
  year: number | null;
  taken: boolean;
  /** The date it was chosen, when it was. */
  takenOn: string | null;
}

export interface CampaignView {
  campaign: Campaign;
  /** Films in the pool for this subject, chosen ones included. */
  total: number;
  taken: number;
  remaining: number;
  /** Days this campaign has been running, inclusive. */
  days: number;
  /** The full run in order, so the page can show a curriculum rather than a count. */
  films: CampaignFilm[];
}

/** A subject you could commit to, with enough films to be worth it. */
export interface CampaignOption {
  kind: CampaignKind;
  subject: string;
  label: string;
  /** Unseen films in the pool. */
  available: number;
  /** How many you have already watched, for context on how deep you are. */
  watched: number;
  /** A hint at the calibre of what is waiting. */
  best: string | null;
}

export function loadCampaign(date: string = today()): CampaignView | null {
  const handle = db();
  const campaign = activeCampaign(handle);
  if (!campaign) return null;

  loadMovements(handle);
  loadLineage(handle);
  const engine = createEngine(handle);
  const state = loadState(handle);

  // The queue is what is *left*: scoreAll drops films already picked. The taken
  // half comes from the pick log, which is the only place that knows the order
  // they were actually watched in.
  const queue = campaignQueue(engine, state, date, campaign);

  const takenRows = handle
    .prepare(
      `SELECT p.tmdb_id, p.pick_date, t.title, t.year
       FROM picks p
       JOIN slates s ON s.slate_date = p.pick_date AND s.tmdb_id = p.tmdb_id
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE s.campaign_id = ?
       ORDER BY p.pick_date`,
    )
    .all(campaign.id) as { tmdb_id: number; pick_date: string; title: string; year: number | null }[];

  const films: CampaignFilm[] = [
    ...takenRows.map((row) => ({
      tmdbId: row.tmdb_id,
      title: row.title,
      year: row.year,
      taken: true,
      takenOn: row.pick_date,
    })),
    ...queue.map((entry) => ({
      tmdbId: entry.candidate.tmdbId,
      title: entry.candidate.title,
      year: entry.candidate.year,
      taken: false,
      takenOn: null,
    })),
  ];

  const days =
    Math.round(
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${campaign.startedOn}T00:00:00Z`)) / 86_400_000,
    ) + 1;

  return {
    campaign,
    total: films.length,
    taken: takenRows.length,
    remaining: queue.length,
    days: Math.max(1, days),
    films,
  };
}

/**
 * Ends the campaign if it has run out of films.
 *
 * Called before a slate is drawn rather than after a pick is made, because the
 * last pick of a campaign is still a pick and should be allowed to settle
 * normally. The campaign is over the next morning, which is also when you would
 * notice.
 */
export function completeIfFinished(date: string = today()): Campaign | null {
  const handle = db();
  const campaign = activeCampaign(handle);
  if (!campaign) return null;

  loadMovements(handle);
  loadLineage(handle);
  const remaining = campaignQueue(createEngine(handle), loadState(handle), date, campaign);
  if (remaining.length > 0) return null;

  return endCampaign(handle, 'completed', date);
}

/**
 * Subjects worth committing to, richest first.
 *
 * Only directors, movements and countries with at least `minFilms` unseen films
 * in the pool: a campaign of three is a double bill with a spare, and listing
 * every director with two unseen films would bury the ones that matter.
 */
export function campaignOptions(kind: CampaignKind, query = '', limit = 40): CampaignOption[] {
  const handle = db();
  loadMovements(handle);
  const min = DEFAULT_TUNING.campaign.minFilms;
  const like = `%${query.trim()}%`;

  if (kind === 'director') {
    return handle
      .prepare(
        `SELECT pe.person_id AS subject, pe.name AS label,
                COUNT(DISTINCT p.tmdb_id) AS available,
                (SELECT COUNT(DISTINCT w.film_id) FROM watched w
                 JOIN film_matches m ON m.film_id = w.film_id
                 JOIN tmdb_film_crew wc ON wc.tmdb_id = m.tmdb_id
                   AND wc.job = 'Director' AND wc.person_id = pe.person_id) AS watched,
                (SELECT t.title FROM pool p2
                 JOIN tmdb_film_crew c2 ON c2.tmdb_id = p2.tmdb_id
                   AND c2.job = 'Director' AND c2.person_id = pe.person_id
                 JOIN tmdb_films t ON t.tmdb_id = p2.tmdb_id
                 ORDER BY t.vote_count DESC LIMIT 1) AS best
         FROM pool p
         JOIN tmdb_film_crew c ON c.tmdb_id = p.tmdb_id AND c.job = 'Director'
         JOIN tmdb_people pe ON pe.person_id = c.person_id
         WHERE (@query = '' OR pe.name LIKE @like)
         GROUP BY pe.person_id
         HAVING available >= @min
         ORDER BY watched DESC, available DESC
         LIMIT @limit`,
      )
      .all({ query: query.trim(), like, min, limit })
      .map((row) => ({ ...(row as Omit<CampaignOption, 'kind' | 'subject'>), kind, subject: String((row as { subject: number }).subject) })) as CampaignOption[];
  }

  if (kind === 'movement') {
    return handle
      .prepare(
        `SELECT m.slug AS subject, m.name AS label,
                COUNT(DISTINCT p.tmdb_id) AS available,
                (SELECT COUNT(*) FROM watched w
                 JOIN film_matches fm ON fm.film_id = w.film_id
                 JOIN film_movements f2 ON f2.tmdb_id = fm.tmdb_id AND f2.movement = m.slug) AS watched,
                (SELECT t.title FROM pool p2
                 JOIN film_movements f3 ON f3.tmdb_id = p2.tmdb_id AND f3.movement = m.slug
                 JOIN tmdb_films t ON t.tmdb_id = p2.tmdb_id
                 ORDER BY t.vote_count DESC LIMIT 1) AS best
         FROM movements m
         JOIN film_movements fmv ON fmv.movement = m.slug
         JOIN pool p ON p.tmdb_id = fmv.tmdb_id
         WHERE (@query = '' OR m.name LIKE @like)
         GROUP BY m.slug
         HAVING available >= @min
         ORDER BY watched ASC, available DESC
         LIMIT @limit`,
      )
      .all({ query: query.trim(), like, min, limit })
      .map((row) => ({ ...(row as Omit<CampaignOption, 'kind'>), kind })) as CampaignOption[];
  }

  return handle
    .prepare(
      `SELECT t.origin_country AS subject, t.origin_country AS label,
              COUNT(DISTINCT p.tmdb_id) AS available,
              (SELECT COUNT(*) FROM watched w
               JOIN film_matches m ON m.film_id = w.film_id
               JOIN tmdb_films t2 ON t2.tmdb_id = m.tmdb_id
               WHERE t2.origin_country = t.origin_country) AS watched,
              (SELECT t3.title FROM pool p2
               JOIN tmdb_films t3 ON t3.tmdb_id = p2.tmdb_id
               WHERE t3.origin_country = t.origin_country
               ORDER BY t3.vote_count DESC LIMIT 1) AS best
       FROM pool p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       WHERE t.origin_country IS NOT NULL
       GROUP BY t.origin_country
       HAVING available >= @min
       ORDER BY watched ASC, available DESC
       LIMIT @limit`,
    )
    .all({ min, limit })
    .map((row) => {
      const entry = row as Omit<CampaignOption, 'kind'>;
      // The column holds an ISO code because that is what the pool is keyed on;
      // "Burkina Faso" is what you want to read when choosing one.
      return { ...entry, kind, label: countryName(entry.subject) };
    }) as CampaignOption[];
}

export type { Campaign, CampaignKind, CampaignOrdering };
