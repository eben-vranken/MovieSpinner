/**
 * Every number the draw depends on, in one file.
 *
 * §10 rules out recommendation ML on purpose: the point is to be able to read
 * the reason a film was picked. That only holds if the knobs live somewhere a
 * person can find them, so they live here and nowhere else.
 */

export interface Tuning {
  /**
   * Films in a bucket past which it counts as covered. §4 suggests around 8.
   * Eight is right for a movement and wrong for a decade, because the buckets
   * are not the same size: eight films in the 1970s is barely a start, while
   * eight films by one director is real depth. So the shape is the brief's and
   * the number is per dimension.
   */
  saturation: { decade: number; country: number; director: number; movement: number };
  /** Gap multiplier at zero coverage, decaying smoothly to 1 at saturation. */
  peak: number;
  /** How sharply the curve falls between empty and closed. */
  falloff: number;
  /** Relative say each dimension gets in the blended gap score. */
  dimensionWeight: { decade: number; country: number; director: number; movement: number };
  /**
   * Exponent on the blended score. This is the single dial between "the top
   * film almost always wins" and "it is basically a shuffle". Raise it and the
   * picks get more pointed and more repetitive; lower it and the blind-spot
   * weighting stops meaning anything.
   */
  sharpness: number;
  /** Multiplier for a film reachable by a lineage edge from something I loved. */
  lineageBonus: number;
  /** §6: watchlist films stay in the pool and get a small bonus. */
  watchlistBonus: number;
  /**
   * §4: don't hit the same country or director twice within ~14 days, or the
   * same decade twice within ~7. Multiply down hard rather than excluding, so a
   * genuinely exceptional candidate can still get through.
   */
  cooldown: { countryDays: number; directorDays: number; decadeDays: number; factor: number };
  /** §4: a skipped film returns to the pool at reduced weight for 90 days. */
  skip: { days: number; factor: number };
  /** §6: the junk valve. 0 is Sunday. */
  junkValveWeekday: number;
  /**
   * How many films the day offers.
   *
   * Five is a choice you can actually make; ten is a list you scroll past. It
   * also keeps the weighting meaningful: draw enough of the pool and the
   * scoring stops distinguishing anything, because you would be looking at a
   * sample large enough to contain something comfortable every single day.
   */
  slateSize: number;
  /**
   * How much a film's provenance is worth. The first simulated year served up
   * "Dead Mine" and "Temple of the White Elephant", both of which were in the
   * pool only because a discover query needed to fill out a country. The gap
   * weighting was right; it just could not tell canon from filler.
   *
   * A TSPDT-ranked film scales between these two by its rank.
   */
  stature: {
    tspdtBest: number;
    tspdtWorst: number;
    lineage: number;
    collection: number;
    auteur: number;
    regional: number;
  };
  /**
   * Per extra list that agrees on a film, beyond the first. Kept small on
   * purpose: 82% of the pool appears on exactly one list, so overlap has almost
   * nothing to discriminate with and cannot carry the weighting on its own. It
   * is real signal, just thin.
   */
  listCountBonus: number;
  /**
   * A film almost nobody has logged is usually a film you cannot actually find,
   * and a year of picks should not be half made of them. Gentle on purpose: a
   * Souleymane Cisse film with sixty votes is exactly the point of this project,
   * so the floor is high and stature does most of the sorting.
   */
  findability: { floor: number; fullVotes: number };
  /** Shrinkage for taste averages computed from few ratings. */
  tastePrior: number;
  /** Exponent on the junk-valve taste score. */
  tasteSharpness: number;
  /**
   * Votes at which a film counts as fully known, for the junk valve. Sunday is
   * supposed to be a film I would enjoy, and a film eleven people have rated is
   * not that whatever its average says.
   */
  familiarityVotes: number;
  /**
   * How hard familiarity bites. Without a steep exponent the sheer number of
   * films with a few hundred votes outweighs the handful with tens of thousands,
   * and Sunday lands on a 1942 film four people have rated.
   */
  familiarityExponent: number;
}

export const DEFAULT_TUNING: Tuning = {
  saturation: { decade: 25, country: 12, director: 4, movement: 8 },
  peak: 4,
  falloff: 1.5,
  dimensionWeight: { decade: 1, country: 1, director: 0.6, movement: 1.3 },
  sharpness: 2.2,
  lineageBonus: 6,
  watchlistBonus: 1.15,
  cooldown: { countryDays: 14, directorDays: 14, decadeDays: 7, factor: 0.06 },
  skip: { days: 90, factor: 0.2 },
  junkValveWeekday: 0,
  slateSize: 5,
  // Canon and the deliberate regional seeding rank highest: those are the two
  // sources that make a specific argument about a specific film for the reasons
  // this project exists. Collection and lineage sit in the middle, and lineage
  // gets its real weight from lineageBonus rather than from here. A bare auteur
  // entry ranks lowest, because the auteur lists never made a claim about the
  // individual film, only about its director.
  stature: { tspdtBest: 2.4, tspdtWorst: 1.4, lineage: 1.4, collection: 1.4, auteur: 0.7, regional: 2 },
  listCountBonus: 0.12,
  findability: { floor: 0.45, fullVotes: 800 },
  tastePrior: 6,
  tasteSharpness: 6,
  familiarityVotes: 20000,
  familiarityExponent: 7,
};

/** Shared shape for the two vote-count curves: 0 votes is low, plenty is 1. */
export function voteCurve(votes: number, fullVotes: number, floor = 0): number {
  const known = Math.min(1, Math.log10(1 + Math.max(0, votes)) / Math.log10(1 + fullVotes));
  return floor + (1 - floor) * known;
}

/**
 * How much a film in this bucket is worth, given how many I have already seen.
 *
 * Saturating rather than cliff-edged, per §4: a dimension should not stay
 * pinned at maximum forever, and it should not drop to nothing the moment a
 * counter crosses a threshold.
 */
export function gapScore(coverage: number, saturation: number, tuning: Tuning): number {
  const remaining = Math.max(0, 1 - coverage / saturation);
  return 1 + (tuning.peak - 1) * remaining ** tuning.falloff;
}
