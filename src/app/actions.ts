'use server';

import { revalidatePath } from 'next/cache';
import { resolvePick, unresolvePick } from '../engine';
import { chooseFromSlate } from '../engine/choose';
import { lockInFilm as lockIn } from '../engine/lock';
import { rechooseStalePick } from '../engine/redraw';
import { rewriteLineageFile } from '../engine/lineage-write';
import { db } from '../lib/db';
import { isRunning, runPipeline, saveUpload } from '../setup/pipeline';

/**
 * Everything the page can do to a day.
 *
 * There are five verbs and no sixth. You choose one of the five films, you lock
 * in a different one from the pool by hand, you mark it watched, you undo a
 * misclick, and -- only when the pool has been rebuilt out from under a film
 * you already chose -- you re-choose from that same day's slate.
 *
 * None of them can change which five films you were offered, and every one of
 * them still ends at `persistPickRecord`, which refuses to overwrite. The
 * override widens what you may choose; it does not let you choose twice.
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

export async function markWatched(date: string): Promise<void> {
  resolvePick(db(), date, 'watched');
  revalidatePath('/');
}

/** Undo a misclick. The film does not change, only the bookkeeping about it. */
export async function undoWatched(date: string): Promise<void> {
  unresolvePick(db(), date);
  revalidatePath('/');
}

/**
 * Replaces a chosen film that is no longer in the pool with another from the
 * same slate. Refuses unless the film has genuinely fallen out, which is what
 * keeps this from being the reroll the project does not have.
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
