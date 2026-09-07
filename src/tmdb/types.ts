/** The slices of TMDB's responses this project actually reads. */

export interface TmdbSearchResult {
  id: number;
  vote_average?: number;
  title: string;
  original_title?: string;
  release_date?: string;
  popularity?: number;
  vote_count?: number;
  poster_path?: string | null;
}

export interface TmdbSearchResponse {
  page: number;
  total_results: number;
  results: TmdbSearchResult[];
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
}

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
}

export interface TmdbRegionProviders {
  link?: string;
  flatrate?: TmdbProvider[];
  free?: TmdbProvider[];
  ads?: TmdbProvider[];
  rent?: TmdbProvider[];
  buy?: TmdbProvider[];
}

export interface TmdbMovieDetail {
  id: number;
  imdb_id?: string | null;
  title: string;
  original_title?: string;
  original_language?: string;
  release_date?: string;
  runtime?: number | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string | null;
  popularity?: number;
  vote_average?: number;
  vote_count?: number;
  genres?: { id: number; name: string }[];
  /** Every production country, alphabetical by ISO code, not by significance. */
  production_countries?: { iso_3166_1: string; name: string }[];
  /** The lead country. Unlike production_countries this is actually ordered. */
  origin_country?: string[];
  credits?: { crew?: TmdbCrewMember[] };
  'watch/providers'?: { results?: Record<string, TmdbRegionProviders> };
}

export const OFFER_TYPES = ['flatrate', 'free', 'ads', 'rent', 'buy'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
