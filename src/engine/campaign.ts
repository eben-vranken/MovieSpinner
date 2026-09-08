import type { Db } from '../db/client';
import { scoreAll } from './index';
import type { Engine, EngineState, Scored } from './index';
import type { SlateResult } from './slate';

/**
 * Campaign mode: the daily five, but in order, on one subject.
 *
 * The blind-spot draw is breadth-first by design and it is very good at it --
 * which is exactly the problem it creates. 268 of 338 directors seen once, and
 * a cooldown that multiplies a director seen inside a fortnight by 0.06. You
 * cannot build depth against that, and depth is what the word cinephile is
 * pointing at.
 *
 * So a campaign inverts it for as long as you want. Same five films a day, same
 * one choice, same finality -- but the five are the next five of a filmography,
 * a movement or a country, in an order that makes them add up.
 *
 * The draw here is **deterministic**. There is no seed and no weighting,
 * because "the next five in order" is not a sample, it is a queue. Films are
 * still scored, so the card can say what the engine thinks of each one and the
 * pick record keeps the same shape as every other day, but the score decides
 * nothing.
 */

export type CampaignKind = 'director' | 'movement' | 'country';
export type CampaignOrdering = 'chronological' | 'canonical';
export type CampaignStatus = 'active' | 'completed' | 'abandoned';

export interface Campaign {
  id: number;
  kind: CampaignKind;
  subject: string;
  label: string;
  ordering: CampaignOrdering;
  startedOn: string;
  endedOn: string | null;
  status: CampaignStatus;
}

const toCampaign = (row: Record<string, unknown>): Campaign => ({
  id: row['id'] as number,
  kind: row['kind'] as CampaignKind,
  subject: row['subject'] as string,
  label: row['label'] as string,
  ordering: row['ordering'] as CampaignOrdering,
  startedOn: row['started_on'] as string,
  endedOn: (row['ended_on'] as string | null) ?? null,
  status: row['status'] as CampaignStatus,
});

export function activeCampaign(db: Db): Campaign | null {
  const row = db.prepare("SELECT * FROM campaigns WHERE status = 'active'").get() as
    | Record<string, unknown>
    | undefined;
  return row ? toCampaign(row) : null;
}

export function campaignHistory(db: Db, limit = 20): Campaign[] {
  return (
    db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT ?').all(limit) as Record<
      string,
      unknown
    >[]
  ).map(toCampaign);
}

/** Whether a scored candidate belongs to this campaign's subject. */
const matches = (scored: Scored, kind: CampaignKind, subject: string): boolean => {
  const film = scored.candidate;
  if (kind === 'director') return film.directors.some((id) => String(id) === subject);
  if (kind === 'movement') return film.movements.includes(subject);
  return film.country === subject;
};

/**
 * The campaign's remaining films, in the order they should be watched.
 *
 * Chronological is the default because a body of work is an argument that
 * develops, and watching it out of order is reading the chapters shuffled. A
 * film with no year sorts last rather than first: an unknown date is not 1900.
 *
 * Canonical exists for the other mood -- the peaks rather than the development
 * -- and sorts by TSPDT rank where there is one, then by how widely a film is
 * known, which is the only quality signal left once the canon runs out.
 */
export function campaignQueue(
  engine: Engine,
  state: EngineState,
  date: string,
  campaign: Pick<Campaign, 'kind' | 'subject' | 'ordering'>,
): Scored[] {
  const { scored } = scoreAll(engine, state, date);
  const mine = scored.filter((entry) => matches(entry, campaign.kind, campaign.subject));

  if (campaign.ordering === 'canonical') {
    return mine.sort((a, b) => {
      const rankA = a.candidate.tspdtRank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.candidate.tspdtRank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return b.candidate.voteCount - a.candidate.voteCount;
    });
  }

  return mine.sort((a, b) => {
    const yearA = a.candidate.year ?? Number.MAX_SAFE_INTEGER;
    const yearB = b.candidate.year ?? Number.MAX_SAFE_INTEGER;
    if (yearA !== yearB) return yearA - yearB;
    return a.candidate.title.localeCompare(b.candidate.title);
  });
}

/**
 * The next `size` films of a campaign, as a slate.
 *
 * Returns the same shape a weighted draw does, so everything downstream --
 * persisting, choosing, the card, the log -- is unchanged. `share` is the
 * probability the film *would* have had in an ordinary draw. It decided
 * nothing here, but recording it keeps the pick row honest and lets the card
 * say what the engine made of a film you picked for other reasons.
 */
export function drawCampaignSlate(
  engine: Engine,
  state: EngineState,
  date: string,
  campaign: Campaign,
  size: number = engine.tuning.slateSize,
): SlateResult {
  const queue = campaignQueue(engine, state, date, campaign);
  if (queue.length === 0) {
    throw new Error(`The ${campaign.label} campaign has no films left.`);
  }

  const { scored } = scoreAll(engine, state, date);
  const total = scored.reduce((sum, entry) => sum + entry.weight, 0);
  const topShare = total === 0 ? 0 : Math.max(...scored.map((entry) => entry.weight)) / total;

  return {
    date,
    // A campaign day is still blind-spot work, and it suspends the junk valve:
    // Sunday off is a release valve for homework you did not choose, and this
    // is homework you did.
    kind: 'blind-spot',
    // No PRNG involved, so the seed records what actually selected these films.
    seed: `moviespinner:campaign:${campaign.id}:${date}`,
    entries: queue.slice(0, size).map((entry, position) => ({
      position,
      scored: entry,
      share: total === 0 ? 0 : entry.weight / total,
    })),
    topShare,
    poolSize: queue.length,
  };
}

export function startCampaign(
  db: Db,
  input: { kind: CampaignKind; subject: string; label: string; ordering: CampaignOrdering },
  date: string,
): Campaign {
  if (activeCampaign(db)) {
    throw new Error('A campaign is already running. End it before starting another.');
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO campaigns (kind, subject, label, ordering, started_on, status, created_at)
         VALUES (@kind, @subject, @label, @ordering, @date, 'active', @createdAt)`,
      )
      .run({ ...input, date, createdAt: new Date().toISOString() }).lastInsertRowid,
  );

  return toCampaign(
    db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

/**
 * Ends a campaign, either because it ran out of films or because you stopped.
 *
 * Does not touch today's slate. If a campaign slate is already on the table it
 * stays there and stays choosable -- ending a campaign is not a way to get five
 * different films this evening.
 */
export function endCampaign(db: Db, status: 'completed' | 'abandoned', date: string): Campaign | null {
  const current = activeCampaign(db);
  if (!current) return null;

  db.prepare('UPDATE campaigns SET status = ?, ended_on = ? WHERE id = ?').run(
    status,
    date,
    current.id,
  );
  return { ...current, status, endedOn: date };
}
