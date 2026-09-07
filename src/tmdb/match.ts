import type { TmdbSearchResult } from './types';

/**
 * Matching Letterboxd titles to TMDB.
 *
 * Letterboxd gives us a display title and a year and nothing else, so the join
 * is a string comparison and it will not be perfect. The tiers below exist so
 * that "probably right" never gets silently treated as "right": anything below
 * `near` lands in the review queue instead of the database.
 */

export type MatchMethod = 'override' | 'exact' | 'near' | 'fuzzy' | 'unmatched';

export interface ScoredCandidate {
  tmdbId: number;
  title: string;
  year: number | null;
  score: number;
  titleScore: number;
  yearDelta: number | null;
  /** TMDB vote count, used as a notability signal when titles collide. */
  votes: number;
  method: Exclude<MatchMethod, 'override' | 'unmatched'>;
}

/**
 * Fold a title down to something comparable.
 *
 * NFKD does real work here beyond accents: it turns the superscript in
 * "[REC]³ Genesis" into a plain 3, so the title lines up with TMDB's "[REC]³".
 */
export function normalizeTitle(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/&/g, ' and ')
    // "Godzilla × Kong" on Letterboxd is "Godzilla x Kong" on TMDB. NFKD does
    // not touch the multiplication sign, so do it here.
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  // Non-Latin titles fold to nothing; keep something comparable rather than ''.
  return folded || title.toLowerCase().trim();
}

/** Drops a trailing subtitle, so "Solaris: The Director's Cut" can still match. */
export function withoutSubtitle(title: string): string | null {
  const cut = title.split(/\s*[:–-]\s+/)[0];
  return cut && cut !== title && cut.length >= 4 ? cut : null;
}

/** Sorensen-Dice over character bigrams. Cheap and forgiving of word order. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const gram = s.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };

  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) {
    shared += Math.min(count, right.get(gram) ?? 0);
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

export const yearOf = (releaseDate?: string): number | null => {
  const year = Number.parseInt((releaseDate ?? '').slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
};

export function scoreCandidate(
  name: string,
  year: number | null,
  candidate: TmdbSearchResult,
): ScoredCandidate {
  const wanted = normalizeTitle(name);
  const wantedShort = withoutSubtitle(name);

  const forms = [candidate.title, candidate.original_title ?? '']
    .filter(Boolean)
    .map(normalizeTitle);

  let titleScore = 0;
  for (const form of forms) {
    titleScore = Math.max(titleScore, form === wanted ? 1 : similarity(wanted, form));
    if (wantedShort) {
      // A subtitle-stripped hit is good but never as good as the full title.
      titleScore = Math.max(titleScore, similarity(normalizeTitle(wantedShort), form) * 0.9);
    }
  }

  // The subtitle can also be on TMDB's side: Letterboxd says "Wake Up Dead
  // Man", TMDB says "Wake Up Dead Man: A Knives Out Mystery".
  for (const original of [candidate.title, candidate.original_title ?? '']) {
    const stripped = original ? withoutSubtitle(original) : null;
    if (stripped && normalizeTitle(stripped) === wanted) {
      titleScore = Math.max(titleScore, 0.95);
    }
  }

  const candidateYear = yearOf(candidate.release_date);
  const yearDelta =
    year === null || candidateYear === null ? null : Math.abs(candidateYear - year);

  // Letterboxd and TMDB disagree about release year often enough (festival vs
  // theatrical vs local release) that one year of slack is normal.
  //
  // A candidate with no release date at all is punished rather than treated as
  // neutral. Those entries are almost always unreleased stubs or duplicates,
  // and left neutral they outscore the real film on title alone.
  const yearScore =
    yearDelta === null ? 0.05 : yearDelta === 0 ? 1 : yearDelta === 1 ? 0.75 : yearDelta === 2 ? 0.3 : 0;

  let method: ScoredCandidate['method'] = 'fuzzy';
  if (titleScore === 1 && yearDelta === 0) method = 'exact';
  else if (titleScore === 1 && yearDelta !== null && yearDelta <= 1) method = 'near';

  return {
    tmdbId: candidate.id,
    title: candidate.title,
    year: candidateYear,
    titleScore,
    yearDelta,
    votes: candidate.vote_count ?? 0,
    score: 0.72 * titleScore + 0.28 * yearScore,
    method,
  };
}

/** Fuzzy matches below this are treated as no match at all. */
export const FUZZY_FLOOR = 0.82;

const TIER: Record<ScoredCandidate['method'], number> = { exact: 0, near: 1, fuzzy: 2 };

/**
 * Ranked best first, tier before score.
 *
 * The tier matters: a candidate whose title matches exactly and whose year is
 * within a year is a better answer than a higher-scoring near-title on the nose
 * for the year. Without it, "Millennium Actress: Tracks" (2001) beats the
 * actual "Millennium Actress" (TMDB says 2002, Letterboxd says 2001).
 */
export function rankCandidates(
  name: string,
  year: number | null,
  candidates: TmdbSearchResult[],
): ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(name, year, candidate))
    .sort(compareCandidates);
}

/** Best first. Exported so callers merging two searches can re-sort the union. */
export const compareCandidates = (a: ScoredCandidate, b: ScoredCandidate): number =>
  TIER[a.method] - TIER[b.method] || b.score - a.score;

/** A rival needs this many times the votes, plus a floor, to override the year. */
const NOTABILITY_RATIO = 5;
const NOTABILITY_FLOOR = 50;

/**
 * Picks the winner among title-exact candidates, letting notability override
 * the year when the gap is enormous.
 *
 * Title-and-year-exact normally beats title-and-year-off-by-one, and usually
 * that is right. But TMDB is full of obscure films that share a title, and when
 * one of them happens to land on Letterboxd's year it wins on a technicality: a
 * 6-vote Russian film called "The Witch" beat Eggers' 7853-vote one, and a
 * no-vote Lebanese "Talk to Me" beat the Philippou brothers'. Seven matches in
 * this library were wrong this way.
 *
 * So a rival one year off takes it if it is overwhelmingly better known. The
 * margin is deliberately steep, because the reverse mistake (picking the famous
 * film when the obscure one was meant) is the worse error.
 */
export function resolveTies(ranked: ScoredCandidate[]): ScoredCandidate | undefined {
  const best = ranked[0];
  if (!best || best.titleScore !== 1) return best;

  const contenders = ranked.filter(
    (c) => c.titleScore === 1 && c.yearDelta !== null && c.yearDelta <= 1,
  );
  let winner = best;
  for (const rival of contenders) {
    if (rival.votes > winner.votes * NOTABILITY_RATIO + NOTABILITY_FLOOR) winner = rival;
  }
  return winner;
}
