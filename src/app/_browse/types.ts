/**
 * One film as the browse grid draws it.
 *
 * Deliberately free of imports: it is shared by two route handlers, which run
 * on the server against SQLite, and by three client components, which must not
 * pull the database in behind it.
 *
 * `seen` and `inPool` are separate booleans rather than one enum because they
 * answer different questions and a film can be neither -- a watched film whose
 * TMDB match exists but which no source list carries is still drawn here when
 * you ask for a country's watched films.
 */
export interface BrowseFilm {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  runtime: number | null;
  country: string | null;
  countryName: string | null;
  language: string | null;
  votes: number;
  directors: string[];
  /** Watched, per the Letterboxd import. Drives the dim-what-I-have-seen toggle. */
  seen: boolean;
  /** Your rating, when there is one. Only ever set on a seen film. */
  rating: number | null;
  /** Still a candidate: unseen and on at least one source list. */
  inPool: boolean;
  onWatchlist: boolean;
  /** How many source lists carry it. Zero for a watched film. */
  listCount: number;
  /** Best position across the ordered lists — the TSPDT rank, usually. */
  bestRank: number | null;
}

/** A page of results, with the count the filters actually matched. */
export interface BrowsePage {
  films: BrowseFilm[];
  total: number;
  page: number;
  perPage: number;
}

/** What one country holds, on both sides of the line. */
export interface CountryFilms {
  code: string;
  name: string;
  watched: BrowseFilm[];
  pool: BrowseFilm[];
  watchedTotal: number;
  poolTotal: number;
}
