import { deleteLineageEdge } from '../actions';
import { EdgeForm } from './EdgeForm';
import type { Analytics } from '../../lib/analytics';

/**
 * The hand-authored edges, folded onto the single page.
 *
 * This is the one panel you write to rather than read. Everything else is
 * derived from Letterboxd and TMDB; an edge is a claim only a person can make,
 * and it is the difference between "1930s Germany: 0% covered" and "you loved
 * Blade Runner and have never seen where it came from".
 *
 * Edits go straight back out to data/lineage.csv, which stays the committed
 * source of truth. Editing the file by hand and editing it here are the same
 * thing, in both directions.
 */
export function LineagePanel({ lineage }: { lineage: Analytics['lineage'] }) {
  const byAnchor = new Map<string, Analytics['lineage']>();
  for (const edge of lineage) {
    const key = edge.fromTitle ?? String(edge.fromTmdbId);
    byAnchor.set(key, [...(byAnchor.get(key) ?? []), edge]);
  }

  // An edge only fires in the draw when its anchor is rated 4 or better, so an
  // edge from a film you never rated is inert. Saying how many are live is more
  // useful than the raw total.
  const live = lineage.filter((edge) => (edge.rating ?? 0) >= 4).length;
  const reachable = lineage.filter((edge) => edge.inPool).length;

  return (
    <div>
      <p className="text-xs leading-relaxed text-muted">
        {lineage.length} edges from {byAnchor.size} films you love to films you have not seen.{' '}
        {live} come from something rated 4 or better, which is the bar that makes an edge count
        in the draw; {reachable} point at a film still in the pool. Changes here are written
        back to <code>data/lineage.csv</code>.
      </p>

      <div className="mt-5">
        <EdgeForm />
      </div>

      <details className="mt-6">
        <summary className="cursor-pointer list-none text-xs text-muted hover:text-paper">
          Show all {lineage.length} edges
        </summary>
        <div className="mt-4 max-h-[32rem] space-y-6 overflow-y-auto pr-2">
          {[...byAnchor].map(([anchor, group]) => {
            const rating = group[0]?.rating;
            return (
              <section key={anchor}>
                <h4 className="flex items-baseline gap-3 border-b border-edge pb-1.5">
                  <span className="text-sm font-medium">{anchor}</span>
                  <span className="text-xs text-muted">
                    {rating ? `${rating} stars` : 'not rated, so these edges are inert'}
                  </span>
                </h4>
                <ul className="divide-y divide-edge/50">
                  {group.map((edge) => (
                    <li
                      key={`${edge.fromTmdbId}-${edge.toTmdbId}`}
                      className="flex items-start gap-4 py-2"
                    >
                      <div className="flex-1">
                        <p className="text-xs">
                          {edge.toTitle ?? edge.toTmdbId}
                          {edge.inPool ? null : (
                            <span className="ml-2 text-muted">not in the pool</span>
                          )}
                          {edge.offered ? (
                            <span className="ml-2 text-accent">already offered</span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">{edge.rationale}</p>
                      </div>
                      <form action={deleteLineageEdge.bind(null, edge.fromTmdbId, edge.toTmdbId)}>
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
      </details>
    </div>
  );
}
