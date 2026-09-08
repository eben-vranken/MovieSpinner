import type { Db } from '../db/client';
import { SEEDED_REGIONS, SHORT_FORM_MOVEMENTS } from './composition';

/**
 * Deciding which of the seeded films actually belong in the pool.
 *
 * The lists that feed step 4 are not comparable. TSPDT, Criterion, the regional
 * discover queries and the lineage edges each make a claim about a specific
 * film. The auteur lists make no claim at all: they pull a director's entire
 * filmography because that was the cheapest way to guarantee every movement had
 * something to draw. It worked, and it left 43% of the pool as complete
 * filmographies, which is why Umberto Lenzi had 46 entries and Robert Bresson
 * had 9.
 *
 * So the auteur expansion gets constraints and the other sources get none. A
 * film any other list argues for is exempt from all of this.
 */

export interface ShapeConfig {
  /**
   * Films shorter than this are not a day's viewing whatever their source, and
   * this floor predates the auteur problem. A film a lineage edge argues for is
   * exempt, because that edge is a written argument about that exact film:
   * Night and Fog is 32 minutes and belongs here.
   */
  featureRuntime: number;
  /** Auteur-only films kept per director. */
  auteurCap: number;
  /** Auteur-only films below this vote count are filmography noise. */
  minVotes: number;
  /** Auteur-only films shorter than this are not a day's viewing. */
  minRuntime: number;
  /** No movement may end up below this. */
  movementFloor: number;
  /** No seeded region may end up below this. */
  regionFloor: number;
  /**
   * Above this many credited directors an auteur-only entry is an anthology or
   * a compilation, not a film by any of them. It also defeats the cap outright:
   * a film is kept if it is in the top slice for any of its directors, so "The
   * King of Ads" with 49 credited directors sailed straight through. Genuine
   * co-directions (the Coens, Powell and Pressburger, the Dardennes) have two
   * or three.
   */
  maxDirectors: number;
  /**
   * A rescue may not go below this many votes. Without it, holding a small
   * movement at its floor imported things like "The King of Ads, Part 2" with a
   * single vote, which is exactly the noise the floors exist to remove. A
   * movement that cannot reach its floor with real films is reported instead.
   */
  rescueMinVotes: number;
}

export const DEFAULT_SHAPE: ShapeConfig = {
  featureRuntime: 40,
  auteurCap: 10,
  minVotes: 10,
  minRuntime: 45,
  movementFloor: 15,
  regionFloor: 25,
  rescueMinVotes: 3,
  maxDirectors: 3,
};

export interface PoolCandidate {
  tmdbId: number;
  title: string;
  year: number | null;
  runtime: number | null;
  votes: number;
  country: string | null;
  kinds: string[];
  listCount: number;
  tspdtRank: number | null;
  bestPosition: number | null;
  onWatchlist: boolean;
  movements: string[];
  /** Only directors named in movement-directors.csv; those drove the expansion. */
  auteurDirectors: { id: number; name: string }[];
  /** Everyone TMDB credits as director, which is how anthologies give themselves away. */
  creditedDirectors: number;
}

export interface Dropped {
  tmdbId: number;
  title: string;
  year: number | null;
  reason: 'short' | 'few-votes' | 'auteur-cap' | 'anthology';
  detail: string;
}

/** A film admitted despite a rule, because a bucket was about to starve. */
export interface Rescue {
  tmdbId: number;
  title: string;
  votes: number;
  because: string;
}

export interface ShapeResult {
  kept: PoolCandidate[];
  dropped: Dropped[];
  rescued: Rescue[];
  /** Buckets no amount of rescuing could lift. These need a human, not a knob. */
  unreachable: string[];
  perDirector: { name: string; personId: number; kept: number; dropped: number }[];
}

const isAuteurOnly = (film: PoolCandidate): boolean =>
  film.kinds.length > 0 && film.kinds.every((kind) => kind === 'auteur');

const hasLineage = (film: PoolCandidate): boolean => film.kinds.includes('lineage');

/**
 * Better films first. TSPDT rank is the strongest claim anyone makes about a
 * film; after that, how many lists noticed it; after that, how many people have
 * seen it. Ties break on year so the result is stable across runs.
 */
function rank(a: PoolCandidate, b: PoolCandidate): number {
  if (a.tspdtRank !== null || b.tspdtRank !== null) {
    return (a.tspdtRank ?? Number.MAX_SAFE_INTEGER) - (b.tspdtRank ?? Number.MAX_SAFE_INTEGER);
  }
  if (a.listCount !== b.listCount) return b.listCount - a.listCount;
  if (a.votes !== b.votes) return b.votes - a.votes;
  return (a.year ?? 0) - (b.year ?? 0);
}

/**
 * A short auteur entry is only noise if shorts are not the form. Silent-era,
 * surrealist and montage films are routinely under 45 minutes, and dropping them
 * would gut exactly the movements step 4 existed to populate.
 */
const shortsAreTheForm = (film: PoolCandidate): boolean =>
  film.movements.some((movement) => SHORT_FORM_MOVEMENTS.has(movement));

export function shapePool(
  candidates: PoolCandidate[],
  config: ShapeConfig = DEFAULT_SHAPE,
): ShapeResult {
  const dropped: Dropped[] = [];
  const protectedFilms: PoolCandidate[] = [];
  const eligible: PoolCandidate[] = [];
  // Auteur films the floors rejected. Held rather than discarded, because a
  // movement about to fall through its floor is a better reason to keep a
  // low-vote film than the floor is to drop it.
  const demoted = new Map<number, { film: PoolCandidate; why: Dropped }>();

  for (const film of candidates) {
    // The feature floor is older than the auteur problem and applies to every
    // source. Only a lineage edge overrides it.
    const runtime = film.runtime ?? 0;
    if (runtime > 0 && runtime < config.featureRuntime && !hasLineage(film)) {
      dropped.push({
        tmdbId: film.tmdbId,
        title: film.title,
        year: film.year,
        reason: 'short',
        detail: `${runtime} minutes, under the ${config.featureRuntime} minute feature floor`,
      });
      continue;
    }
    if (!isAuteurOnly(film)) {
      protectedFilms.push(film);
      continue;
    }
    if (film.creditedDirectors > config.maxDirectors) {
      dropped.push({
        tmdbId: film.tmdbId,
        title: film.title,
        year: film.year,
        reason: 'anthology',
        detail: `${film.creditedDirectors} credited directors, auteur-only`,
      });
      continue;
    }
    if (film.votes < config.minVotes) {
      demoted.set(film.tmdbId, {
        film,
        why: {
          tmdbId: film.tmdbId,
          title: film.title,
          year: film.year,
          reason: 'few-votes',
          detail: `${film.votes} votes, auteur-only`,
        },
      });
      continue;
    }
    if (runtime > 0 && runtime < config.minRuntime && !shortsAreTheForm(film)) {
      demoted.set(film.tmdbId, {
        film,
        why: {
          tmdbId: film.tmdbId,
          title: film.title,
          year: film.year,
          reason: 'short',
          detail: `${runtime} minutes, auteur-only`,
        },
      });
      continue;
    }
    eligible.push(film);
  }

  // --- the cap ---------------------------------------------------------------
  const kept = new Set<number>(protectedFilms.map((film) => film.tmdbId));
  const byDirector = new Map<number, PoolCandidate[]>();
  for (const film of eligible) {
    // A film with no named movement-director cannot be capped by director, so it
    // rides on its own merits. In practice these are co-directed entries where
    // only the collaborator is on the list.
    if (film.auteurDirectors.length === 0) {
      kept.add(film.tmdbId);
      continue;
    }
    for (const person of film.auteurDirectors) {
      byDirector.set(person.id, [...(byDirector.get(person.id) ?? []), film]);
    }
  }
  for (const [, films] of byDirector) {
    // Kept if it is in the top slice for any of its directors, so a co-direction
    // is not dropped because one collaborator happens to be oversubscribed.
    for (const film of [...films].sort(rank).slice(0, config.auteurCap)) kept.add(film.tmdbId);
  }

  // --- rescue anything the rules starved -------------------------------------
  // Raising the per-director cap was the obvious lever and the wrong one: the
  // three movements that fell through the floor had lost their films to the vote
  // floor, not the cap, so a bigger cap changed nothing at all. This admits
  // exactly enough films to a starving bucket, best first, whichever rule
  // excluded them.
  const countryToRegion = new Map<string, string>();
  for (const [label, codes] of SEEDED_REGIONS) {
    for (const code of codes) countryToRegion.set(code, label);
  }

  const spare = [...eligible, ...[...demoted.values()].map((entry) => entry.film)];
  const buckets: { because: string; belongs: (film: PoolCandidate) => boolean; floor: number }[] = [
    ...[...new Set(candidates.flatMap((film) => film.movements))].map((movement) => ({
      because: `movement ${movement}`,
      belongs: (film: PoolCandidate) => film.movements.includes(movement),
      floor: config.movementFloor,
    })),
    ...SEEDED_REGIONS.map(([label]) => ({
      because: `region ${label}`,
      belongs: (film: PoolCandidate) =>
        film.country ? countryToRegion.get(film.country) === label : false,
      floor: config.regionFloor,
    })),
  ];

  const rescued: Rescue[] = [];
  const unreachable: string[] = [];
  for (const bucket of buckets) {
    const members = candidates.filter((film) => bucket.belongs(film));
    let have = members.filter((film) => kept.has(film.tmdbId)).length;
    if (have >= bucket.floor) continue;

    for (const film of spare
      .filter(
        (entry) =>
          !kept.has(entry.tmdbId) &&
          bucket.belongs(entry) &&
          entry.votes >= config.rescueMinVotes,
      )
      .sort(rank)) {
      if (have >= bucket.floor) break;
      kept.add(film.tmdbId);
      have += 1;
      rescued.push({
        tmdbId: film.tmdbId,
        title: film.title,
        votes: film.votes,
        because: `${bucket.because} below ${bucket.floor}`,
      });
    }
    if (have < bucket.floor) {
      // Not a tuning failure. Cinema du look is three directors over fourteen
      // years; there is no cap setting that produces fifteen good films.
      unreachable.push(`${bucket.because}: ${have} of ${bucket.floor}`);
    }
  }

  // --- account for everything that did not make it ---------------------------
  const perDirector = new Map<number, { name: string; kept: number; dropped: number }>();
  const allAuteur = [...eligible, ...[...demoted.values()].map((entry) => entry.film)];
  for (const film of allAuteur) {
    const survived = kept.has(film.tmdbId);
    for (const person of film.auteurDirectors) {
      const entry = perDirector.get(person.id) ?? { name: person.name, kept: 0, dropped: 0 };
      if (survived) entry.kept += 1;
      else entry.dropped += 1;
      perDirector.set(person.id, entry);
    }
    if (survived) continue;
    const demotion = demoted.get(film.tmdbId);
    dropped.push(
      demotion
        ? demotion.why
        : {
            tmdbId: film.tmdbId,
            title: film.title,
            year: film.year,
            reason: 'auteur-cap',
            detail:
              film.auteurDirectors.map((person) => person.name).join(', ') ||
              'over the per-director cap',
          },
    );
  }

  return {
    kept: candidates.filter((film) => kept.has(film.tmdbId)),
    dropped,
    rescued,
    unreachable,
    perDirector: [...perDirector]
      .map(([personId, entry]) => ({ personId, ...entry }))
      .sort((a, b) => b.dropped - a.dropped),
  };
}

/** Reads everything shapePool needs out of the staged list entries. */
export function loadPoolCandidates(db: Db): PoolCandidate[] {
  const films = db
    .prepare(
      `SELECT e.tmdb_id, t.title, t.year, t.runtime, t.vote_count, t.origin_country,
              COUNT(DISTINCT e.list_slug) AS list_count,
              MIN(e.position) AS best_position,
              (SELECT GROUP_CONCAT(DISTINCT l2.kind) FROM pool_list_entries e2
               JOIN pool_lists l2 ON l2.slug = e2.list_slug WHERE e2.tmdb_id = e.tmdb_id) AS kinds,
              (SELECT e3.position FROM pool_list_entries e3
               WHERE e3.tmdb_id = e.tmdb_id AND e3.list_slug = 'tspdt-1000') AS tspdt_rank,
              EXISTS (SELECT 1 FROM watchlist wl JOIN film_matches m ON m.film_id = wl.film_id
                      WHERE m.tmdb_id = e.tmdb_id) AS on_watchlist,
              (SELECT COUNT(*) FROM tmdb_film_crew c
               WHERE c.tmdb_id = e.tmdb_id AND c.job = 'Director') AS credited_directors
       FROM pool_list_entries e
       JOIN tmdb_films t ON t.tmdb_id = e.tmdb_id
       WHERE e.tmdb_id NOT IN (SELECT tmdb_id FROM pool_excluded)
       GROUP BY e.tmdb_id`,
    )
    .all() as {
    tmdb_id: number;
    title: string;
    year: number | null;
    runtime: number | null;
    vote_count: number | null;
    origin_country: string | null;
    list_count: number;
    best_position: number | null;
    kinds: string | null;
    tspdt_rank: number | null;
    on_watchlist: number;
    credited_directors: number;
  }[];

  const movements = new Map<number, string[]>();
  for (const row of db.prepare('SELECT tmdb_id, movement FROM film_movements').all() as {
    tmdb_id: number;
    movement: string;
  }[]) {
    movements.set(row.tmdb_id, [...(movements.get(row.tmdb_id) ?? []), row.movement]);
  }

  const auteurDirectors = new Map<number, { id: number; name: string }[]>();
  for (const row of db
    .prepare(
      `SELECT DISTINCT c.tmdb_id, c.person_id, p.name FROM tmdb_film_crew c
       JOIN tmdb_people p ON p.person_id = c.person_id
       WHERE c.job = 'Director'
         AND c.person_id IN (SELECT person_id FROM movement_directors WHERE person_id IS NOT NULL)`,
    )
    .all() as { tmdb_id: number; person_id: number; name: string }[]) {
    auteurDirectors.set(row.tmdb_id, [
      ...(auteurDirectors.get(row.tmdb_id) ?? []),
      { id: row.person_id, name: row.name },
    ]);
  }

  return films.map((film) => ({
    tmdbId: film.tmdb_id,
    title: film.title,
    year: film.year,
    runtime: film.runtime,
    votes: film.vote_count ?? 0,
    country: film.origin_country,
    kinds: (film.kinds ?? '').split(',').filter(Boolean),
    listCount: film.list_count,
    tspdtRank: film.tspdt_rank,
    bestPosition: film.best_position,
    onWatchlist: film.on_watchlist === 1,
    movements: movements.get(film.tmdb_id) ?? [],
    auteurDirectors: auteurDirectors.get(film.tmdb_id) ?? [],
    creditedDirectors: film.credited_directors,
  }));
}
