'use server';

import { revalidatePath } from 'next/cache';
import { resolvePick } from '../engine';
import { rewriteLineageFile } from '../engine/lineage-write';
import { db } from '../lib/db';

/** §4: no reroll. The only two things you can do to a pick are these. */
export async function markPick(date: string, status: 'watched' | 'skipped'): Promise<void> {
  resolvePick(db(), date, status);
  revalidatePath('/');
  revalidatePath('/dashboard');
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

  rewriteLineageFile(handle);
  revalidatePath('/lineage');
}

export async function deleteLineageEdge(from: number, to: number): Promise<void> {
  const handle = db();
  handle.prepare('DELETE FROM lineage_edges WHERE from_tmdb_id = ? AND to_tmdb_id = ?').run(from, to);
  rewriteLineageFile(handle);
  revalidatePath('/lineage');
}
