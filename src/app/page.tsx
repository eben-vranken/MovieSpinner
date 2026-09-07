import Image from 'next/image';
import { markPick } from './actions';
import { db, posterUrl } from '../lib/db';
import { ensurePick, reasonSentence } from '../lib/pick';
import type { PickView } from '../lib/pick';

export const dynamic = 'force-dynamic';

const countryName = (code: string | null): string => {
  if (!code) return 'Unknown';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

function Availability({ pick }: { pick: PickView }) {
  if (pick.streaming.length > 0) {
    return (
      <p className="text-sm">
        <span className="text-muted">In {pick.region}: </span>
        <span className="text-paper">{pick.streaming.join(', ')}</span>
      </p>
    );
  }
  if (pick.rentBuy.length > 0) {
    return (
      <p className="text-sm">
        <span className="text-muted">In {pick.region}: rent or buy on </span>
        <span className="text-paper">{pick.rentBuy.slice(0, 4).join(', ')}</span>
      </p>
    );
  }
  return (
    <p className="text-sm text-muted">
      Not on any service tracked in {pick.region}. That is what the skip is for.
    </p>
  );
}

/** The last fortnight, so today has some context without becoming a feed. */
function RecentPicks() {
  const rows = db()
    .prepare(
      `SELECT p.pick_date, p.status, p.kind, t.title, t.year FROM picks p
       JOIN tmdb_films t ON t.tmdb_id = p.tmdb_id
       ORDER BY p.pick_date DESC LIMIT 15`,
    )
    .all() as { pick_date: string; status: string; kind: string; title: string; year: number }[];

  if (rows.length <= 1) return null;

  return (
    <section className="mt-14">
      <h2 className="mb-3 text-xs tracking-[0.2em] text-muted uppercase">Recently</h2>
      <ul className="divide-y divide-edge border-y border-edge">
        {rows.slice(1).map((row) => (
          <li key={row.pick_date} className="flex items-baseline gap-4 py-2 text-sm">
            <span className="w-24 shrink-0 tabular-nums text-muted">{row.pick_date}</span>
            <span className="flex-1 truncate">
              {row.title} <span className="text-muted">({row.year})</span>
            </span>
            <span
              className={
                row.status === 'watched'
                  ? 'text-accent'
                  : row.status === 'skipped'
                    ? 'text-muted line-through'
                    : 'text-muted'
              }
            >
              {row.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function TodayPage() {
  let pick: PickView;
  try {
    pick = ensurePick();
  } catch (error) {
    return (
      <p className="text-sm text-muted">
        {error instanceof Error ? error.message : 'Could not produce a pick.'}
      </p>
    );
  }

  const poster = posterUrl(pick.posterPath, 'w500');
  const runtime = pick.runtime ? `${pick.runtime} min` : 'runtime unknown';

  return (
    <>
      <div className="flex items-baseline justify-between">
        <p className="text-xs tracking-[0.2em] text-muted uppercase">
          {pick.date}
          {pick.kind === 'junk-valve' ? ' · junk valve' : ''}
        </p>
        {pick.streak > 0 ? (
          <p className="text-xs text-muted">{pick.streak} day streak</p>
        ) : null}
      </div>

      <article className="mt-6 grid gap-8 sm:grid-cols-[220px_1fr]">
        <div className="overflow-hidden rounded border border-edge bg-panel">
          {poster ? (
            <Image
              src={poster}
              alt=""
              width={500}
              height={750}
              priority
              className="h-auto w-full"
            />
          ) : (
            <div className="flex aspect-2/3 items-center justify-center text-xs text-muted">
              no poster
            </div>
          )}
        </div>

        <div>
          <h1 className="text-3xl leading-tight font-semibold">
            {pick.title}{' '}
            <span className="font-normal text-muted">({pick.year ?? '?'})</span>
          </h1>
          <p className="mt-2 text-sm text-paper">
            {pick.directors.join(', ') || 'Director unknown'}
          </p>
          <p className="mt-1 text-sm text-muted">
            {countryName(pick.country)} · {runtime}
            {pick.genres.length > 0 ? ` · ${pick.genres.slice(0, 3).join(', ')}` : ''}
          </p>
          {pick.movements.length > 0 ? (
            <p className="mt-3 flex flex-wrap gap-2">
              {pick.movements.map((movement) => (
                <span
                  key={movement}
                  className="rounded border border-edge px-2 py-0.5 text-xs text-muted"
                >
                  {movement}
                </span>
              ))}
            </p>
          ) : null}

          {/* The lineage sentence is the whole point of §5, so it gets the emphasis. */}
          {pick.lineageRationale ? (
            <blockquote className="mt-6 border-l-2 border-accent pl-4">
              <p className="text-lg leading-snug text-paper">{pick.lineageRationale}</p>
              {pick.lineageFromTitle ? (
                <p className="mt-1 text-xs text-muted">because you loved {pick.lineageFromTitle}</p>
              ) : null}
            </blockquote>
          ) : (
            <p className="mt-6 text-sm text-muted">{reasonSentence(pick)}</p>
          )}

          {pick.overview ? (
            <p className="mt-5 max-w-prose text-sm leading-relaxed text-muted">{pick.overview}</p>
          ) : null}

          <div className="mt-6">
            <Availability pick={pick} />
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {pick.status === 'pending' ? (
              <>
                <form action={markPick.bind(null, pick.date, 'watched')}>
                  <button
                    type="submit"
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-ink hover:opacity-90"
                  >
                    Watched it
                  </button>
                </form>
                <form action={markPick.bind(null, pick.date, 'skipped')}>
                  <button
                    type="submit"
                    className="rounded border border-edge px-4 py-2 text-sm text-muted hover:text-paper"
                  >
                    Skip
                  </button>
                </form>
                <span className="text-xs text-muted">No reroll. Tomorrow is a different film.</span>
              </>
            ) : (
              <p className="text-sm text-muted">
                Marked <span className="text-paper">{pick.status}</span>.
              </p>
            )}
          </div>

          <p className="mt-6 text-xs text-muted">
            1 of {pick.poolSize.toLocaleString()} candidates, drawn at{' '}
            {(pick.share * 100).toFixed(2)}% probability ·{' '}
            <a
              className="underline hover:text-paper"
              href={`https://www.themoviedb.org/movie/${pick.tmdbId}`}
              target="_blank"
              rel="noreferrer"
            >
              TMDB
            </a>
          </p>
        </div>
      </article>

      <RecentPicks />
    </>
  );
}
