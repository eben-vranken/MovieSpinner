import Image from 'next/image';
import { chooseFilm, markWatched, rechooseFilm, undoWatched } from '../actions';
import { LockIn } from './LockIn';
import { posterUrl } from '../../lib/db';
import { reasonSentence } from '../../lib/slate';
import type { FilmCard, SlateView } from '../../lib/slate';
import type { CampaignView } from '../../lib/campaign';

/**
 * The top of the page: five films, and the one you took.
 *
 * The interaction is a single click and it is final. There is no confirm step,
 * because a confirm would imply the choice is reversible and it is not -- the
 * five are drawn once for the day and choosing one closes the day. What the
 * card owes you in exchange is enough information to choose without clicking:
 * who made it, where it is from, how long it is, why the engine put it in front
 * of you, and whether you can actually watch it tonight.
 *
 * Underneath the five sits the manual override, folded away until asked for.
 * The five are the recommendation, so they get the space; searching the pool
 * yourself is the answer to a different question and should not compete with
 * them for attention on a day you have not asked it.
 */

const countryName = (code: string | null): string => {
  if (!code) return 'Unknown';
  if (code === 'XC') return 'Czechoslovakia';
  if (code === 'SU') return 'Soviet Union';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Where to watch it, in the configured region. */
function Availability({ film, region }: { film: FilmCard; region: string }) {
  if (film.streaming.length > 0) {
    return (
      <p className="text-xs">
        <span className="text-accent">▸ </span>
        <span className="text-paper">{film.streaming.slice(0, 3).join(', ')}</span>
      </p>
    );
  }
  if (film.rentBuy.length > 0) {
    return (
      <p className="text-xs text-muted">Rent or buy: {film.rentBuy.slice(0, 3).join(', ')}</p>
    );
  }
  return <p className="text-xs text-muted">Not on any service tracked in {region}.</p>;
}

function Poster({
  film,
  size,
  priority = false,
}: {
  film: FilmCard;
  size: 'w342' | 'w500';
  priority?: boolean;
}) {
  const poster = posterUrl(film.posterPath, size);
  if (!poster) {
    return (
      <div className="flex aspect-2/3 items-center justify-center rounded bg-edge/40 text-xs text-muted">
        no poster
      </div>
    );
  }
  return (
    <Image
      src={poster}
      alt=""
      width={size === 'w500' ? 500 : 342}
      height={size === 'w500' ? 750 : 513}
      priority={priority}
      className="h-auto w-full rounded"
    />
  );
}

/** The tags that say what kind of claim the pool is making about this film. */
function Provenance({ film }: { film: FilmCard }) {
  const claims: string[] = [];
  if (film.manual) claims.push('your pick');
  if (film.tspdtRank) claims.push(`TSPDT #${film.tspdtRank}`);
  for (const kind of film.kinds) if (kind !== 'canon') claims.push(kind);
  if (film.lineageRationale) claims.push('lineage');
  if (claims.length === 0) return null;

  return (
    <p className="flex flex-wrap gap-1">
      {claims.slice(0, 3).map((claim) => (
        <span
          key={claim}
          className="rounded border border-edge px-1.5 py-0.5 text-[10px] tracking-wide text-muted uppercase"
        >
          {claim}
        </span>
      ))}
    </p>
  );
}

function ChoiceCard({
  film,
  slate,
  action,
}: {
  film: FilmCard;
  slate: SlateView;
  action: (date: string, tmdbId: number) => Promise<void>;
}) {
  const runtime = film.runtime ? `${film.runtime}m` : '?';

  return (
    <form action={action.bind(null, slate.date, film.tmdbId)} className="contents">
      <button
        type="submit"
        className="group flex flex-col rounded-lg border border-edge bg-panel p-3 text-left transition hover:border-accent focus:border-accent focus:outline-none"
      >
        <Poster film={film} size="w342" priority={film.position < 3} />

        <p className="mt-3 text-sm leading-snug font-medium group-hover:text-accent">
          {film.title}
        </p>
        <p className="text-xs text-muted">
          {film.year ?? '?'} · {countryName(film.country)} · {runtime}
        </p>
        <p className="mt-1 truncate text-xs text-muted" title={film.directors.join(', ')}>
          {film.directors.join(', ') || 'Director unknown'}
        </p>

        <div className="mt-2 flex-1">
          <Provenance film={film} />
        </div>

        {/* The lineage sentence is the whole reason §5 exists, so where there is
            one it replaces the generic explanation rather than sitting under it. */}
        <p className="mt-3 text-xs leading-relaxed text-paper">
          {film.lineageRationale ?? reasonSentence(film, slate.kind)}
        </p>
        {film.lineageFromTitle ? (
          <p className="mt-1 text-[11px] text-muted">because you loved {film.lineageFromTitle}</p>
        ) : null}

        <div className="mt-3 border-t border-edge/60 pt-2">
          <Availability film={film} region={slate.region} />
          <p className="mt-1 text-[11px] text-muted">
            {/* In a campaign the film was next in a queue, not drawn from a
                distribution, so quoting a probability would be a fiction. */}
            {slate.campaignId
              ? `next up · ${(film.share * 100).toFixed(2)}% in a normal draw`
              : `drawn at ${(film.share * 100).toFixed(2)}%`}
            {film.timesPassed > 0
              ? ` · passed over ${film.timesPassed} time${film.timesPassed === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>

        <span className="mt-3 rounded border border-edge px-3 py-1.5 text-center text-xs text-muted group-hover:border-accent group-hover:text-accent">
          Choose this
        </span>
      </button>
    </form>
  );
}

/** The film you took, once you have taken one. */
function Chosen({ film, slate }: { film: FilmCard; slate: SlateView }) {
  const runtime = film.runtime ? `${film.runtime} min` : 'runtime unknown';

  return (
    <article className="grid gap-6 rounded-lg border border-edge bg-panel p-5 sm:grid-cols-[180px_1fr]">
      <div>
        <Poster film={film} size="w500" priority />
      </div>
      <div>
        <h2 className="text-2xl leading-tight font-semibold">
          {film.title} <span className="font-normal text-muted">({film.year ?? '?'})</span>
        </h2>
        <p className="mt-1 text-sm">{film.directors.join(', ') || 'Director unknown'}</p>
        <p className="mt-1 text-sm text-muted">
          {countryName(film.country)} · {runtime}
          {film.genres.length > 0 ? ` · ${film.genres.slice(0, 3).join(', ')}` : ''}
        </p>

        {film.movements.length > 0 ? (
          <p className="mt-3 flex flex-wrap gap-2">
            {film.movements.map((movement) => (
              <span
                key={movement}
                className="rounded border border-edge px-2 py-0.5 text-xs text-muted"
              >
                {movement}
              </span>
            ))}
          </p>
        ) : null}

        {film.lineageRationale ? (
          <blockquote className="mt-4 border-l-2 border-accent pl-4">
            <p className="text-base leading-snug">{film.lineageRationale}</p>
            {film.lineageFromTitle ? (
              <p className="mt-1 text-xs text-muted">because you loved {film.lineageFromTitle}</p>
            ) : null}
          </blockquote>
        ) : (
          <p className="mt-4 text-sm text-muted">{reasonSentence(film, slate.kind)}</p>
        )}

        {film.overview ? (
          <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted">{film.overview}</p>
        ) : null}

        <div className="mt-4">
          <Availability film={film} region={slate.region} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {slate.chosen?.status === 'watched' ? (
            <>
              <p className="text-sm text-accent">Watched.</p>
              <form action={undoWatched.bind(null, slate.date)}>
                <button
                  type="submit"
                  className="rounded border border-edge px-3 py-1 text-xs text-muted hover:text-paper"
                >
                  Undo
                </button>
              </form>
            </>
          ) : (
            <>
              <form action={markWatched.bind(null, slate.date)}>
                <button
                  type="submit"
                  className="rounded bg-accent px-4 py-2 text-sm font-medium text-ink hover:opacity-90"
                >
                  Watched it
                </button>
              </form>
              <span className="text-xs text-muted">
                Chosen for today. The other four are gone until they come up again.
              </span>
            </>
          )}
        </div>

        <p className="mt-4 text-xs text-muted">
          {film.manual
            ? `Locked in by hand from ${slate.poolSize.toLocaleString()} candidates. The draw would have weighted it at ${(film.share * 100).toFixed(2)}%`
            : `1 of ${slate.poolSize.toLocaleString()} candidates, drawn onto the slate at ${(film.share * 100).toFixed(2)}%`}{' '}
          ·{' '}
          <a
            className="underline hover:text-paper"
            href={`https://www.themoviedb.org/movie/${film.tmdbId}`}
            target="_blank"
            rel="noreferrer"
          >
            TMDB
          </a>
        </p>
      </div>
    </article>
  );
}

/** The four you did not take, kept visible but out of the way. */
function PassedOver({ films }: { films: FilmCard[] }) {
  if (films.length === 0) return null;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer list-none text-xs text-muted hover:text-paper">
        The {films.length} you passed on today
      </summary>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {films.map((film) => (
          <li
            key={film.tmdbId}
            className="rounded border border-edge/60 px-3 py-2 text-xs text-muted"
          >
            <span className="text-paper">{film.title}</span> ({film.year ?? '?'})
            <br />
            {film.directors[0] ?? 'Director unknown'}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Slate({ slate, campaign }: { slate: SlateView; campaign: CampaignView | null }) {
  const chosen = slate.chosen
    ? slate.films.find((film) => film.tmdbId === slate.chosen?.tmdbId)
    : undefined;
  // Only true when *this* slate came from the campaign. A campaign started
  // today does not retroactively claim a slate drawn this morning.
  const onCampaign = campaign !== null && slate.campaignId === campaign.campaign.id;

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xs tracking-[0.2em] text-muted uppercase">
            {slate.date}
            {onCampaign
              ? ` · ${campaign.campaign.label} campaign`
              : slate.kind === 'junk-valve'
                ? ' · junk valve'
                : ' · blind spot'}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {chosen && !slate.chosenIsStale
              ? onCampaign
                ? `Chosen. ${campaign.remaining} left in the campaign.`
                : 'Chosen. Tomorrow brings five more.'
              : onCampaign
                ? `The next ${slate.films.length} of ${campaign.campaign.label}, in ${campaign.campaign.ordering === 'chronological' ? 'release' : 'canonical'} order. Pick one — the choice is final for today.`
                : `Five films, weighted at the gaps in your coverage. Pick one — the choice is final for today.`}
          </p>
        </div>
        {slate.streak > 0 ? (
          <p className="text-xs text-muted">{slate.streak} day streak</p>
        ) : null}
      </div>

      {/* The one case where choosing again is allowed. A rebuilt pool can strand
          a pick on a film that is no longer a candidate, which is a broken
          record rather than a decision anyone made. The other four films from
          that morning are still here, so the repair is to re-choose from the
          same slate rather than be handed something from a different draw. */}
      {slate.chosenIsStale && chosen ? (
        <div className="mt-4 rounded border border-edge bg-ink/40 p-4">
          <p className="text-sm">
            {chosen.title} has fallen out of the candidate pool since you chose it.
          </p>
          <p className="mt-1 text-xs text-muted">
            The pool was rebuilt underneath this pick, so it is stale rather than chosen. Pick
            another film from the same slate below; the swap is recorded.
          </p>
        </div>
      ) : null}

      <div className="mt-5">
        {chosen && !slate.chosenIsStale ? (
          <>
            <Chosen film={chosen} slate={slate} />
            <PassedOver films={slate.films.filter((film) => film.tmdbId !== chosen.tmdbId)} />
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {slate.films
                .filter((film) => !slate.chosenIsStale || film.inPool)
                .map((film) => (
                  <ChoiceCard
                    key={film.tmdbId}
                    film={film}
                    slate={slate}
                    action={slate.chosenIsStale ? rechooseFilm : chooseFilm}
                  />
                ))}
            </div>
            {/* Not offered while a stale pick is being repaired: that day has
                already had its film chosen, and the repair is to swap within
                the slate rather than to reopen the whole pool. */}
            {slate.chosenIsStale ? null : (
              <LockIn date={slate.date} poolSize={slate.poolSize} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
