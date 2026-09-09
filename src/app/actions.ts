'use server';

import { revalidatePath } from 'next/cache';
import { resolvePick, unresolvePick } from '../engine';
import { activeCampaign, endCampaign, startCampaign } from '../engine/campaign';
import type { CampaignKind, CampaignOrdering } from '../engine/campaign';
import { chooseFromSlate } from '../engine/choose';
import { lockInFilm as lockIn } from '../engine/lock';
import { rechooseStalePick } from '../engine/redraw';
import { rewriteLineageFile } from '../engine/lineage-write';
import { db, today } from '../lib/db';
import { drawNextRound } from '../lib/slate';
import { isRunning, letterboxdUser, runPipeline, saveUpload } from '../setup/pipeline';
import { resetEverything } from '../setup/reset';
import { sync } from '../sync';

/**
 * Everything the page can do to a day.
 *
 * There are six verbs and no seventh. You choose one of the five films, you
 * lock in a different one from the pool by hand, you mark it watched, you undo
 * a misclick, you ask for another five once you have watched the last one, and
 * -- only when the pool has been rebuilt out from under a film you already
 * chose -- you re-choose from that same round's slate.
 *
 * None of them can change which films you were offered, and every one of them
 * still ends at `persistPickRecord`, which refuses to overwrite. The override
 * widens what you may choose; the next round widens how many evenings a day
 * can hold. Neither lets you choose twice for the same round.
 */

/** Commit to one of today's five. Final: `persistPickRecord` refuses a second. */
export async function chooseFilm(date: string, tmdbId: number): Promise<void> {
  chooseFromSlate(db(), date, tmdbId);
  revalidatePath('/');
}

/**
 * The manual override: any film in the pool, locked in for today.
 *
 * Deliberately not restricted to the slate. The engine's job is to find the gap
 * when you do not know it; when you do know it, insisting you wait for it to
 * come up would be the tool getting in the way. It is still one film, still
 * scored, still final.
 *
 * Returns its failure rather than throwing it. The refusals here are the useful
 * kind -- "that is not in the pool", "today already has a pick" -- and a thrown
 * error would be replaced by a generic message in a production build, which is
 * the one place the wording matters. The other actions can throw because their
 * failures are unreachable through the UI.
 */
export type LockResult = { ok: true; title: string } | { ok: false; error: string };

export async function lockInFilm(date: string, tmdbId: number): Promise<LockResult> {
  try {
    const { title } = lockIn(db(), date, tmdbId);
    revalidatePath('/');
    return { ok: true, title };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'Could not lock that in.' };
  }
}

export async function markWatched(date: string, round: number): Promise<void> {
  resolvePick(db(), date, 'watched', round);
  revalidatePath('/');
}

/** Undo a misclick. The film does not change, only the bookkeeping about it. */
export async function undoWatched(date: string, round: number): Promise<void> {
  unresolvePick(db(), date, round);
  revalidatePath('/');
}

/**
 * Another five, because you watched the last one.
 *
 * The only way a day gets a second film, and it costs exactly one thing: the
 * film you chose has to be marked watched. That is what separates this from a
 * reroll -- you are not swapping tonight's film for a different one, you are
 * saying tonight had room for two. Nothing about the earlier round moves.
 *
 * Returns its refusal rather than throwing it, like `lockInFilm` does, because
 * the refusals are the informative kind: the round is still open, or the film
 * is chosen but not watched yet.
 */
export type RoundResult = { ok: true; round: number } | { ok: false; error: string };

export async function drawAnotherRound(date: string): Promise<RoundResult> {
  try {
    const slate = drawNextRound(date);
    revalidatePath('/');
    return { ok: true, round: slate.round };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : 'Could not draw another round.',
    };
  }
}

/**
 * Replaces a chosen film that is no longer in the pool with another from the
 * same slate. Refuses unless the film has genuinely fallen out, which is what
 * keeps this from being the reroll the project does not have. The round is read
 * off the replacement's slate row rather than passed in.
 */
export async function rechooseFilm(date: string, tmdbId: number): Promise<void> {
  rechooseStalePick(db(), date, tmdbId);
  revalidatePath('/');
}

export type UploadResult = { ok: true } | { ok: false; error: string };

/**
 * Takes a Letterboxd export and starts the four-step pipeline behind it.
 *
 * Deliberately does not await the pipeline. Matching a few hundred films and
 * building the pool is minutes of network calls; holding the request open for
 * that would hit every proxy timeout between here and the browser, and would
 * give the page nothing to show in the meantime. The run writes its progress to
 * `setup_runs` and the page polls for it instead.
 *
 * The upload itself is awaited, so a failure to read or save the zip is
 * reported here rather than surfacing thirty seconds later as a failed run.
 */
export async function importExportFile(formData: FormData): Promise<UploadResult> {
  const file = formData.get('export');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose your Letterboxd export zip first.' };
  }
  // Letterboxd exports are well under this; anything larger is not one, and
  // reading it into memory to find that out would be the wrong order.
  if (file.size > 100 * 1024 * 1024) {
    return { ok: false, error: 'That file is over 100MB, which is not a Letterboxd export.' };
  }

  const handle = db();
  if (isRunning(handle)) {
    return { ok: false, error: 'An import is already running. Let it finish.' };
  }

  let saved: string;
  try {
    saved = saveUpload(Buffer.from(await file.arrayBuffer()), file.name);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'Could not save the file.' };
  }

  try {
    // Started, not awaited. runPipeline catches its own failures into the run
    // row, so the only thing that can reject here is the pre-flight check.
    void runPipeline(handle, saved);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'Could not start.' };
  }

  revalidatePath('/');
  return { ok: true };
}

export type ResetResponse =
  | { ok: true; rows: number; tables: number; backup: string | null; filesDeleted: string[] }
  | { ok: false; error: string };

/**
 * Wipes the install back to a fresh clone.
 *
 * Exists so the first-run experience can be checked without a second machine.
 * It really does delete everything, the pick log included, so it takes a typed
 * confirmation rather than a click -- not as ceremony, but because it sits on
 * the same page as five buttons that are also irreversible and much smaller.
 *
 * A backup is written first, without asking. It is a few megabytes and it turns
 * an unrecoverable mistake into a file copy.
 */
export async function resetInstall(
  confirmation: string,
  options: { clearCaches?: boolean; clearExports?: boolean } = {},
): Promise<ResetResponse> {
  if (confirmation.trim().toUpperCase() !== 'RESET') {
    return { ok: false, error: 'Type RESET to confirm.' };
  }
  if (isRunning(db())) {
    return { ok: false, error: 'An import is running. Let it finish before resetting.' };
  }

  try {
    const result = await resetEverything(db(), options);
    revalidatePath('/');
    return {
      ok: true,
      rows: result.rows,
      tables: result.tables,
      backup: result.backup,
      filesDeleted: result.filesDeleted,
    };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'Reset failed.' };
  }
}

export type CampaignResponse = { ok: true } | { ok: false; error: string };

/**
 * Commit to a director, movement or country.
 *
 * Takes effect on the **next** slate, never today's. Today's five were drawn
 * this morning and belong to today; reshaping them now would make starting a
 * campaign a way to get a different set of films this evening, which is the one
 * thing this whole project refuses to allow.
 */
export async function beginCampaign(
  kind: CampaignKind,
  subject: string,
  label: string,
  ordering: CampaignOrdering,
): Promise<CampaignResponse> {
  try {
    startCampaign(db(), { kind, subject, label, ordering }, today());
    revalidatePath('/');
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : 'Could not start the campaign.',
    };
  }
}

/**
 * Stop a campaign early.
 *
 * Also does not touch today's slate. If a campaign slate is on the table it
 * stays there and stays choosable -- ending a campaign is not a reroll either.
 */
export async function stopCampaign(): Promise<CampaignResponse> {
  const handle = db();
  if (!activeCampaign(handle)) return { ok: false, error: 'No campaign is running.' };
  endCampaign(handle, 'abandoned', today());
  revalidatePath('/');
  return { ok: true };
}

export async function addLineageEdge(formData: FormData): Promise<void> {
  const from = Number.parseInt(String(formData.get('from') ?? ''), 10);
  const to = Number.parseInt(String(formData.get('to') ?? ''), 10);
  const rationale = String(formData.get('rationale') ?? '').trim();
  if (!Number.isFinite(from) || !Number.isFinite(to) || !rationale) return;
  if (from === to) return;

  const handle = db();
  const title = (id: number): string | null =>
    (handle.prepare('SELECT title FROM tmdb_films WHERE tmdb_id = ?').get(id) as
      | { title: string }
      | undefined)?.title ?? null;

  handle
    .prepare(
      `INSERT INTO lineage_edges (from_tmdb_id, to_tmdb_id, from_title, to_title, rationale)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (from_tmdb_id, to_tmdb_id) DO UPDATE SET rationale = excluded.rationale`,
    )
    .run(from, to, title(from), title(to), rationale);

  // The CSV stays the source of truth, so an edge added here is written back
  // out immediately rather than living only in the database.
  rewriteLineageFile(handle);
  revalidatePath('/');
}

export async function deleteLineageEdge(from: number, to: number): Promise<void> {
  const handle = db();
  handle
    .prepare('DELETE FROM lineage_edges WHERE from_tmdb_id = ? AND to_tmdb_id = ?')
    .run(from, to);
  rewriteLineageFile(handle);
  revalidatePath('/');
}

export type RefreshResult = { ok: true; summary: string } | { ok: false; error: string };

/**
 * The manual version of the same job the cron runs: read the Letterboxd
 * feed, fold anything newly watched into coverage/Taste/Browse/the pool, and
 * close out today's pick if the feed shows it watched. See `sync()` in
 * src/sync/index.ts for what "fold in" means -- it is the same merge either
 * way, just triggered by a click instead of a schedule.
 */
export async function refreshFromFeed(): Promise<RefreshResult> {
  try {
    const handle = db();
    const result = await sync(handle, letterboxdUser(handle));
    revalidatePath('/');

    const parts = [
      `checked ${result.entries} recent entries`,
      result.merge.watchedAdded > 0 ? `${result.merge.watchedAdded} newly watched merged in` : null,
      result.resolved.length > 0 ? `${result.resolved.length} pick${result.resolved.length === 1 ? '' : 's'} closed out` : null,
      result.merge.failures.length > 0 ? `${result.merge.failures.length} TMDB lookup(s) failed, will retry next sync` : null,
    ].filter(Boolean);

    return { ok: true, summary: parts.join(', ') };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'Could not read the feed.' };
  }
}
