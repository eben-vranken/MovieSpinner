import { Panel } from '../_charts/Chart';
import { TimeArea } from '../_charts/plots';
import { posterUrl } from '../../lib/poster';
import type { Analytics } from '../../lib/analytics';

/**
 * Everything the app has done, kept.
 *
 * The four films you did not choose each day are here on purpose: a film the
 * engine offers over and over that you never take is the most interesting thing
 * this section records, and deleting the losers would throw that away.
 *
 * Drawn as posters rather than as a row of titles, because the question it
 * actually answers is "what have I been turning down", and the fourth title in
 * a line of five titles is not a film anybody recognises. The ones you passed
 * over are dimmed rather than struck through -- they are still the record, and
 * hovering brings one back so it can be read.
 *
 * Rounds are nested under their date. A day that held two films is two slates
 * on one date, and repeating the date above each of them was most of what made
 * this list hard to scan.
 */

interface LogFilm {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

/** Small caps chip. The log's only label, used for every kind of label. */
function Tag({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] leading-none tracking-wide uppercase ${
        accent ? 'border-accent/60 text-accent' : 'border-edge text-muted'
      }`}
    >
      {children}
    </span>
  );
}

/**
 * One film, poster first.
 *
 * Links out to TMDB like every other poster on the page, so the log is
 * something you can read your way out of rather than a dead end.
 */
function FilmCard({
  film,
  badge,
  chosen = false,
  dimmed = false,
}: {
  film: LogFilm;
  badge?: string;
  chosen?: boolean;
  dimmed?: boolean;
}) {
  const poster = posterUrl(film.posterPath, 'w185');

  return (
    <li className="group min-w-0">
      <a
        href={`https://www.themoviedb.org/movie/${film.tmdbId}`}
        target="_blank"
        rel="noreferrer"
        className="block focus:outline-none"
      >
        <div
          className={`relative overflow-hidden rounded border bg-edge/30 transition ${
            chosen ? 'border-accent' : 'border-edge group-hover:border-accent group-focus:border-accent'
          }`}
        >
          {poster ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              width={185}
              height={278}
              className={`aspect-2/3 h-auto w-full object-cover transition group-hover:opacity-100 ${
                dimmed ? 'opacity-40' : ''
              }`}
            />
          ) : (
            <div
              className={`flex aspect-2/3 items-center justify-center px-1 text-center text-[10px] leading-tight text-muted transition group-hover:opacity-100 ${
                dimmed ? 'opacity-40' : ''
              }`}
            >
              {film.title}
            </div>
          )}

          {badge ? (
            <span
              className={`absolute top-1 left-1 rounded bg-ink/85 px-1.5 py-0.5 text-[10px] leading-none tracking-wide ${
                chosen ? 'text-accent' : 'text-muted'
              }`}
            >
              {badge}
            </span>
          ) : null}
        </div>

        <p
          className={`mt-1 truncate text-[11px] leading-snug transition group-hover:text-accent ${
            dimmed ? 'text-muted' : 'text-paper'
          }`}
          title={film.title}
        >
          {film.title}
        </p>
        <p className="truncate text-[11px] text-muted tabular-nums">{film.year ?? '?'}</p>
      </a>
    </li>
  );
}

const STATUS: Record<string, string> = {
  watched: 'watched',
  pending: 'chosen, not watched',
};

export function Log({ data }: { data: Analytics }) {
  const { totals } = data;

  // The log arrives one row per round, newest first. Folding it back onto the
  // date here rather than in the query keeps the ordering the SQL already
  // guarantees and costs one pass over a list that is days long, not films.
  const days: { date: string; rounds: Analytics['slateLog'] }[] = [];
  for (const round of data.slateLog) {
    const last = days.at(-1);
    if (last && last.date === round.date) last.rounds.push(round);
    else days.push({ date: round.date, rounds: [round] });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Every slate so far"
        hint={`What you were offered and what you took, newest first. The films you passed on are kept on purpose and dimmed rather than dropped. ★ marks one you locked in yourself${totals.lockedIn > 0 ? ` — ${totals.lockedIn} so far` : ', which has not happened yet'}.`}
        wide
      >
        {days.length === 0 ? (
          <p className="text-xs text-muted">No slates yet. Today is the first.</p>
        ) : (
          <ol className="max-h-[34rem] space-y-5 overflow-y-auto pr-1">
            {days.map((day) => (
              <li
                key={day.date}
                className="flex flex-col gap-2 border-b border-edge/50 pb-5 last:border-0 last:pb-0 sm:flex-row sm:gap-6"
              >
                {/* The date sits beside the slates rather than above each of
                    them, which is what stops a two-round day reading as two
                    unrelated days. */}
                <p className="text-[11px] tracking-[0.18em] text-muted uppercase tabular-nums sm:w-24 sm:shrink-0 sm:pt-1">
                  {day.date}
                </p>

                <div className="min-w-0 flex-1 space-y-4">
                  {day.rounds.map((round) => (
                    <div key={round.round}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {round.round > 1 ? <Tag accent>round {round.round}</Tag> : null}
                        {/* blind-spot is every other row, so only the valve is
                            worth a chip. */}
                        {round.kind === 'junk-valve' ? <Tag>junk valve</Tag> : null}
                        <Tag accent={round.status === 'watched'}>
                          {round.status ? (STATUS[round.status] ?? round.status) : 'nothing chosen'}
                        </Tag>
                      </div>

                      {/* Capped rather than filling the panel: five posters
                          across a full-width panel are the size of the slate
                          itself, and this is a log you scan. */}
                      <ul className="mt-2 grid max-w-2xl grid-cols-5 gap-2 sm:gap-3">
                        {round.films.map((film) => (
                          <FilmCard
                            key={film.tmdbId}
                            film={film}
                            chosen={film.chosen}
                            dimmed={!film.chosen}
                            badge={
                              film.chosen ? (film.manual ? '★ chosen' : 'chosen') : undefined
                            }
                          />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title="Offered and passed over"
        hint="Films that have come up more than once and never been chosen, most-offered first. Worth a look: either the engine is wrong about them or you are."
      >
        {data.passedOver.length === 0 ? (
          <p className="text-xs text-muted">
            Nothing has come up twice yet. This fills in as the log grows.
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            {data.passedOver.map((film) => (
              <FilmCard key={film.tmdbId} film={film} badge={`${film.times}×`} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Coverage over time"
        hint="Snapshots of the watched total, taken by `npm run coverage -- --snapshot`. §7 wants change rather than position, and that only works if snapshotting starts long before it has anything to show."
      >
        {data.snapshots.length > 1 ? (
          <TimeArea
            points={data.snapshots.map((row) => ({ label: row.takenOn, value: row.watched }))}
            unit="films"
          />
        ) : (
          <p className="text-xs text-muted">
            {data.snapshots.length} snapshot on file
            {data.snapshots[0] ? `, taken ${data.snapshots[0].takenOn}` : ''}. Two are needed before
            there is a line to draw. Run <code>npm run coverage -- --snapshot</code> monthly.
          </p>
        )}
      </Panel>
    </div>
  );
}
