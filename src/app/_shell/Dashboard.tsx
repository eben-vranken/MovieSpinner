'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The sidebar, and the only navigation this app has.
 *
 * Still one route. The sections it switches between are server components,
 * rendered once and handed here as props, so choosing a tab is a swap of
 * already-rendered nodes rather than a fetch, a route change or a second read
 * of the database. That is the whole reason the split is done this way instead
 * of with real routes: `loadAnalytics` is one pass over every table on the
 * page, and paying for it per tab to save scrolling would be a bad trade.
 *
 * What the sidebar actually fixes is that the evidence had become a very long
 * column. Nineteen panels in one scroll means the answer to "how am I doing on
 * Eastern Europe" is somewhere below the ratings histogram, and you find it by
 * remembering roughly how far down it was.
 *
 * Two pieces of state live here because they are the two that are about looking
 * rather than about data: which section is open, and whether films you have
 * already seen are dimmed. The tab is in the URL hash so a view is a link you
 * can send yourself; the dim toggle is in localStorage because it is a
 * preference and not a place.
 */

export interface TabSpec {
  key: string;
  label: string;
  /** The count that makes the tab worth opening. Kept short -- it sits inline. */
  note?: string;
}

const DIM_KEY = 'moviespinner.dim-seen';

export function Dashboard({
  tabs,
  sections,
  footer,
}: {
  tabs: TabSpec[];
  sections: Record<string, ReactNode>;
  /** The maintenance block. Below every section rather than being one. */
  footer: ReactNode;
}) {
  const [active, setActive] = useState(tabs[0]?.key ?? '');
  const [dim, setDim] = useState(false);

  // Read after mount, not during render: both of these are browser state and
  // reading them on the server would be a hydration mismatch rather than a
  // head start.
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (tabs.some((tab) => tab.key === hash)) setActive(hash);
    try {
      if (window.localStorage.getItem(DIM_KEY) === 'on') setDim(true);
    } catch {
      // Private mode, or storage disabled. The toggle still works for the session.
    }
  }, [tabs]);

  const open = (key: string): void => {
    setActive(key);
    window.history.replaceState(null, '', `#${key}`);
    window.scrollTo({ top: 0 });
  };

  const toggleDim = (): void => {
    const next = !dim;
    setDim(next);
    try {
      window.localStorage.setItem(DIM_KEY, next ? 'on' : 'off');
    } catch {
      // Same as above: a preference that cannot be saved is still a preference.
    }
  };

  return (
    <div data-dim-seen={dim ? 'on' : 'off'} className="lg:grid lg:grid-cols-[13rem_1fr] lg:gap-10">
      <nav aria-label="Sections" className="lg:sticky lg:top-6 lg:self-start">
        {/* Horizontal and scrollable on a phone, a column on a desktop. Same
            list, same order, no second implementation. */}
        <ul className="-mx-6 flex gap-1 overflow-x-auto px-6 pb-3 lg:mx-0 lg:flex-col lg:px-0 lg:pb-0">
          {tabs.map((tab) => (
            <li key={tab.key} className="shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => open(tab.key)}
                aria-current={active === tab.key ? 'page' : undefined}
                className={`flex w-full items-baseline justify-between gap-3 rounded px-3 py-2 text-left text-sm transition ${
                  active === tab.key
                    ? 'bg-panel text-accent'
                    : 'text-muted hover:bg-panel/60 hover:text-paper'
                }`}
              >
                <span>{tab.label}</span>
                {tab.note ? (
                  <span className="hidden text-[11px] tabular-nums opacity-70 lg:inline">
                    {tab.note}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4 hidden border-t border-edge pt-4 lg:block">
          <button
            type="button"
            onClick={toggleDim}
            aria-pressed={dim}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-muted transition hover:bg-panel/60 hover:text-paper"
          >
            <span
              aria-hidden
              className={`inline-block h-3 w-6 shrink-0 rounded-full border transition ${
                dim ? 'border-accent bg-accent/40' : 'border-edge bg-panel'
              }`}
            >
              <span
                className={`block h-2.5 w-2.5 rounded-full transition ${
                  dim ? 'translate-x-3 bg-accent' : 'translate-x-0 bg-muted'
                }`}
              />
            </span>
            Dim what I have seen
          </button>
          <p className="mt-2 px-3 text-[11px] leading-relaxed text-muted opacity-70">
            Darkens the poster of any film already in your diary, so a wall of them reads as what
            is left rather than what is there.
          </p>
        </div>
      </nav>

      <div className="min-w-0">
        {/* The toggle again, for the widths where the sidebar is a strip of
            tabs and has nowhere to put it. */}
        <button
          type="button"
          onClick={toggleDim}
          aria-pressed={dim}
          className="mb-4 rounded border border-edge px-3 py-1.5 text-xs text-muted lg:hidden"
        >
          {dim ? 'Undim seen films' : 'Dim what I have seen'}
        </button>

        {sections[active] ?? null}

        <footer className="mt-16 border-t border-edge pt-6">{footer}</footer>
      </div>
    </div>
  );
}
