import type { Db } from '../db/client';
import { persistPickRecord } from './index';
import type { PickKind } from './index';

/**
 * Choosing a film off today's slate.
 *
 * This is where the product changed and the rule did not. The engine used to
 * hand over one film; it now hands over five and you pick. But a day still
 * resolves to exactly one film and choosing is still final, because
 * `persistPickRecord` refuses to overwrite an existing row. Clicking a second
 * film after you have already chosen is a reroll wearing a different hat, and
 * it fails here rather than being politely disabled in the UI.
 *
 * Nothing is recomputed. The weight, share and reason written into `picks` are
 * the ones recorded when the slate was drawn, so the card can say what the
 * engine actually thought at the time instead of what it would think now.
 */

interface SlateRow {
  tmdb_id: number;
  kind: PickKind;
  seed: string;
  weight: number;
  share: number;
  top_share: number;
  pool_size: number;
  reason_json: string;
  lineage_from: number | null;
  lineage_rationale: string | null;
}

export function chooseFromSlate(db: Db, date: string, tmdbId: number): void {
  const row = db
    .prepare('SELECT * FROM slates WHERE slate_date = ? AND tmdb_id = ?')
    .get(date, tmdbId) as SlateRow | undefined;

  // Not "film not found": a film that was never offered cannot be chosen, and
  // saying so is more useful than a foreign key error two layers down.
  if (!row) throw new Error(`${tmdbId} was not on the slate for ${date}.`);

  persistPickRecord(db, {
    date,
    tmdbId: row.tmdb_id,
    kind: row.kind,
    seed: row.seed,
    weight: row.weight,
    share: row.share,
    topShare: row.top_share,
    poolSize: row.pool_size,
    reason: row.reason_json,
    lineageFrom: row.lineage_from,
    lineageRationale: row.lineage_rationale,
  });
}
