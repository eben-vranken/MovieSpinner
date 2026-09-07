import { deleteLineageEdge } from '../actions';
import { db } from '../../lib/db';
import { loadLineage } from '../../engine/lineage';
import { EdgeForm } from './EdgeForm';

export const dynamic = 'force-dynamic';

interface EdgeRow {
  from_tmdb_id: number;
  to_tmdb_id: number;
  from_title: string | null;
  to_title: string | null;
  rationale: string;
  rating: number | null;
  to_year: number | null;
  in_pool: number;
  seen: number;
}

export default async function LineagePage() {
  const handle = db();
  // The CSV stays the source of truth, so the table is refreshed from it on
  // every visit. Edits made here get written straight back out again.
  loadLineage(handle);

  const edges = handle
    .prepare(
      `SELECT e.from_tmdb_id, e.to_tmdb_id, e.from_title, e.to_title, e.rationale,
              r.rating, t.year AS to_year,
              EXISTS (SELECT 1 FROM pool p WHERE p.tmdb_id = e.to_tmdb_id) AS in_pool,
              EXISTS (SELECT 1 FROM picks pk WHERE pk.tmdb_id = e.to_tmdb_id) AS seen
       FROM lineage_edges e
       LEFT JOIN film_matches m ON m.tmdb_id = e.from_tmdb_id
       LEFT JOIN ratings r ON r.film_id = m.film_id
       LEFT JOIN tmdb_films t ON t.tmdb_id = e.to_tmdb_id
       ORDER BY e.from_title, e.to_title`,
    )
    .all() as EdgeRow[];

  const byAnchor = new Map<string, EdgeRow[]>();
  for (const edge of edges) {
    const key = edge.from_title ?? String(edge.from_tmdb_id);
    byAnchor.set(key, [...(byAnchor.get(key) ?? []), edge]);
  }

  const live = edges.filter((edge) => (edge.rating ?? 0) >= 4).length;

  return (
    <>
      <h1 className="text-2xl font-semibold">Lineage</h1>
      <p className="mt-2 max-w-prose text-sm text-muted">
        {edges.length} edges from {byAnchor.size} films you love to films you have not seen.{' '}
        {live} of them come from something rated 4 or better, which is the bar that makes an edge
        count in the draw. Each one carries the sentence that appears on the card.
      </p>
      <p className="mt-2 max-w-prose text-xs text-muted">
        Changes here are written back to <code>data/lineage.csv</code>, which stays the committed
        source of truth. Editing the file by hand and editing it here are the same thing.
      </p>

      <div className="mt-8">
        <EdgeForm />
      </div>

      <div className="mt-12 space-y-8">
        {[...byAnchor].map(([anchor, group]) => {
          const rating = group[0]?.rating;
          return (
            <section key={anchor}>
              <h2 className="flex items-baseline gap-3 border-b border-edge pb-2">
                <span className="text-sm font-medium">{anchor}</span>
                <span className="text-xs text-muted">
                  {rating ? `${rating} stars` : 'not rated, so these edges are inert'}
                </span>
              </h2>
              <ul className="divide-y divide-edge/50">
                {group.map((edge) => (
                  <li
                    key={`${edge.from_tmdb_id}-${edge.to_tmdb_id}`}
                    className="flex items-start gap-4 py-3"
                  >
                    <div className="flex-1">
                      <p className="text-sm">
                        {edge.to_title ?? edge.to_tmdb_id}{' '}
                        <span className="text-muted">({edge.to_year ?? '?'})</span>
                        {edge.in_pool ? null : (
                          <span className="ml-2 text-xs text-muted">not in the pool</span>
                        )}
                        {edge.seen ? (
                          <span className="ml-2 text-xs text-accent">already offered</span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-sm text-muted">{edge.rationale}</p>
                    </div>
                    <form
                      action={deleteLineageEdge.bind(null, edge.from_tmdb_id, edge.to_tmdb_id)}
                    >
                      <button
                        type="submit"
                        className="text-xs text-muted hover:text-paper"
                        title="Remove this edge"
                      >
                        remove
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
