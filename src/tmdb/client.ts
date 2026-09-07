import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmdbConfig } from '../config';
import type { TmdbMovieDetail, TmdbSearchResponse, TmdbSearchResult } from './types';

const BASE_URL = 'https://api.themoviedb.org/3';
const CACHE_DIR = path.join(process.cwd(), 'data', 'tmdb-cache');

export interface ClientOptions {
  /** Ignore the on-disk cache and re-fetch. */
  refresh?: boolean;
  /** Concurrent in-flight requests. TMDB tolerates far more; this is polite. */
  concurrency?: number;
  /** Only this region's watch providers are cached. Defaults to TMDB_REGION. */
  region?: string;
}

/** Carries the status code so callers can tell "deleted" from "broken". */
export class TmdbHttpError extends Error {
  constructor(readonly status: number, readonly endpoint: string, body: string) {
    super(`TMDB ${status} on ${endpoint}: ${body}`);
    this.name = 'TmdbHttpError';
  }
}

export interface ClientStats {
  requests: number;
  cacheHits: number;
  retries: number;
}

/**
 * A thin TMDB client with an on-disk response cache.
 *
 * Every response is written to data/tmdb-cache as JSON, so re-running
 * enrichment costs nothing and the matcher can be re-tuned without touching
 * the network. The brief is explicit about this: there is no reason to fetch a
 * 1954 film's metadata twice.
 */
export class TmdbClient {
  readonly stats: ClientStats = { requests: 0, cacheHits: 0, retries: 0 };
  private readonly token: string;
  private readonly refresh: boolean;
  private readonly limit: number;
  private readonly region: string;
  private inFlight = 0;
  private queue: (() => void)[] = [];

  constructor(options: ClientOptions = {}) {
    const config = tmdbConfig();
    this.token = config.readToken;
    this.region = options.region ?? config.region;
    this.refresh = options.refresh ?? false;
    this.limit = options.concurrency ?? 6;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  searchMovie(query: string, year?: number | null): Promise<TmdbSearchResponse> {
    const params = new URLSearchParams({ query, include_adult: 'true' });
    if (year) params.set('year', String(year));
    return this.get<TmdbSearchResponse>('/search/movie', params, this.cachePath('search', `${query}::${year ?? ''}`));
  }

  /**
   * Resolves an IMDb id to a TMDB film. TSPDT publishes IMDb ids, which makes
   * that whole list an exact join rather than a thousand fuzzy title matches.
   */
  async findByImdb(imdbId: string): Promise<TmdbSearchResult | undefined> {
    const params = new URLSearchParams({ external_source: 'imdb_id' });
    const body = await this.get<{ movie_results?: TmdbSearchResult[] }>(
      `/find/${imdbId}`,
      params,
      this.cachePath('find', imdbId),
    );
    return body.movie_results?.[0];
  }

  /** Resolves a director's name to a TMDB person. */
  async searchPerson(name: string): Promise<{ id: number; name: string } | undefined> {
    const params = new URLSearchParams({ query: name });
    const body = await this.get<{ results?: { id: number; name: string }[] }>(
      '/search/person',
      params,
      this.cachePath('person-search', name),
    );
    return body.results?.[0];
  }

  /** Everything a person is credited on, so a director's filmography is one call. */
  personCredits(personId: number): Promise<{
    crew?: { id: number; job: string; title: string; release_date?: string }[];
  }> {
    return this.get(
      `/person/${personId}/movie_credits`,
      new URLSearchParams(),
      this.cachePath('person-credits', String(personId)),
    );
  }

  /** One page of /discover/movie. Used to seed regional depth into the pool. */
  discover(params: Record<string, string>): Promise<TmdbSearchResponse> {
    const query = new URLSearchParams(params);
    return this.get<TmdbSearchResponse>(
      '/discover/movie',
      query,
      this.cachePath('discover', query.toString()),
    );
  }

  movie(id: number): Promise<TmdbMovieDetail> {
    const params = new URLSearchParams({
      append_to_response: 'credits,watch/providers',
    });
    return this.get<TmdbMovieDetail>(
      `/movie/${id}`,
      params,
      this.cachePath('movie', String(id)),
      (detail) => trimMovie(detail, this.region),
    );
  }

  private cachePath(kind: string, key: string): string {
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    const dir = path.join(CACHE_DIR, kind);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${hash}.json`);
  }

  private async get<T>(
    endpoint: string,
    params: URLSearchParams,
    cacheFile: string,
    trim?: (body: T) => T,
  ): Promise<T> {
    if (!this.refresh && fs.existsSync(cacheFile)) {
      this.stats.cacheHits += 1;
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as T;
    }

    const raw = (await this.withSlot(() => this.fetchWithRetry(endpoint, params))) as T;
    const body = trim ? trim(raw) : raw;
    fs.writeFileSync(cacheFile, JSON.stringify(body));
    return body;
  }

  private async fetchWithRetry(endpoint: string, params: URLSearchParams): Promise<unknown> {
    const url = `${BASE_URL}${endpoint}?${params.toString()}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      this.stats.requests += 1;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, accept: 'application/json' },
      });

      if (response.ok) return response.json();

      // 429 carries Retry-After; 5xx gets exponential backoff. Anything else
      // (401 bad token, 404 unknown id) is not worth retrying.
      if (response.status === 429 || response.status >= 500) {
        this.stats.retries += 1;
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 500;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      const text = await response.text().catch(() => '');
      throw new TmdbHttpError(response.status, endpoint, text.slice(0, 200));
    }

    throw new Error(`TMDB kept failing on ${endpoint} after 5 attempts`);
  }

  /** Minimal concurrency gate so a 600-film run does not open 600 sockets. */
  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }
}

/**
 * Shrinks a movie response before it is cached.
 *
 * Untrimmed, 600 films came to 48MB on disk. Almost all of it was watch
 * providers for every country on earth (25MB) and full cast and crew lists
 * (830 people on Blade Runner 2049). Only one region's providers are ever read,
 * the cast is never read at all, and of the crew only a handful of jobs are
 * plausibly interesting later, so the rest is dropped on the way in.
 *
 * The consequence to know about: changing TMDB_REGION means re-fetching with
 * `npm run enrich -- --refresh`, because other regions were never stored.
 */
export const KEPT_CREW_JOBS = new Set([
  'Director',
  'Writer',
  'Screenplay',
  'Story',
  'Novel',
  'Director of Photography',
  'Original Music Composer',
]);

export function trimMovie(detail: TmdbMovieDetail, region: string): TmdbMovieDetail {
  const { credits, ['watch/providers']: providers, ...rest } = detail;
  const regional = providers?.results?.[region];
  return {
    ...rest,
    ...(credits
      ? {
          credits: {
            crew: (credits.crew ?? []).filter((member) => KEPT_CREW_JOBS.has(member.job)),
          },
        }
      : {}),
    ...(providers ? { 'watch/providers': { results: regional ? { [region]: regional } : {} } } : {}),
  };
}

export { CACHE_DIR };
