<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MovieSpinner

A personal blind-spot film picker. One user, no accounts, no auth, one page.

## Shape

Ten build steps, all done: ingest a Letterboxd zip, enrich against TMDB,
compute coverage, build a candidate pool, draw the daily slate, show it, sync
the RSS feed, chart the coverage, edit the lineage edges, and fold all of it
onto a single page. `README.md` explains each one and, more usefully, what went
wrong the first time.

The day is a **slate of five films, and you choose one**. It used to be one
film handed over with a skip button. The scoring did not change when that did:
the five are drawn from the same weighted distribution, without replacement, so
choosing among them is choosing among five blind spots rather than choosing
whether to have one.

There is also a **manual override**: search the pool and lock any of its films
in for today. It reaches the pool, never past it, so it changes which blind spot
you close and never whether you close one.

- `src/db/migrations/*.sql` is the schema. Add a migration, never edit an applied one.
- `src/cli/*.ts` are the pipeline commands. `npm run report` verifies steps 1 to 5.
- `src/app/page.tsx` is the entire UI. There is one route and no navigation;
  `_charts/`, `_slate/` and `_lineage/` are its private component folders.
- `src/lib/analytics.ts` loads every number the page draws, in one pass.
- `data/*.csv` are hand-curated and committed: overrides, movements, regions, lineage.

## Rules that matter

- **No reroll.** A day resolves to exactly one film and choosing is final.
  `persistPickRecord` is the single door into `picks` and refuses to overwrite;
  `persistSlate` refuses to redraw a slate. Do not add a way around either.
  Neither the slate nor the override relaxes this: they widen what you may
  choose, once. `lockInFilm` goes through `chooseFromSlate` and therefore
  through the same door, and it fails on a second use exactly as a second click
  does.
- **The override reaches the pool and no further.** `lockInFilm` refuses a film
  that is not in `pool`, and refuses one already picked on an earlier day. It
  scores the film with the same `scoreAll` the slate used, so a manual pick is
  still an explained pick, and appends it to the day's slate with `manual = 1`
  rather than replacing one of the five. Do not let it reach arbitrary
  `tmdb_films`: the pool boundary is what stops the override becoming "watch
  anything", which would make the rest of this project decorative.
  There is exactly one carve-out and it is not a reroll: `rechooseStalePick`
  replaces a chosen film that has fallen out of the pool after a rebuild, with
  another film **from that same day's slate**, and refuses in every other case.
  Disliking the film is not a qualifying condition. The superseded row is kept
  in `pick_redraws`. `unresolvePick` undoes a mis-clicked watched; the film does
  not change.
- **Nothing is dropped silently.** This now includes the four films you did not
  choose: they stay in `slates`. A film the engine offers repeatedly that you
  never take is real signal and deleting the losers would throw it away.
- **The CSVs are the source of truth**, not the tables built from them. Anything
  the UI writes must be written back out to the file.
- **Every tuning number lives in `src/engine/tuning.ts`.** No magic constants in
  the scoring path; the point is being able to read why a film was chosen.
  `slateSize` lives there too.
- **Charts follow one system.** Palette, mark specs and spacers are documented at
  the top of `src/app/_charts/plots.tsx` and the colours are CSS variables in
  `globals.css`, validated against the panel surface. Every chart carries a
  table twin, and two or more series always carry a legend. No charting
  library: these are rectangles and paths, rendered on the server.
- **Unmatched rows go to `ingest_issues` or `pool_unresolved` with a reason.**
- **The auteur pool lists are shaped, not trusted.** `src/pool/shape.ts` caps
  them at 10 films per director, drops entries under 10 votes or 45 minutes or
  with more than 3 credited directors, and then rescues films back if a movement
  falls under 15 or a seeded region under 25. Canon, Criterion, regional and
  lineage entries are exempt from all of it. Every drop is logged in
  `pool_dropped`; every rescue in `pool_cap_overrides`.
- Run `npm run typecheck` before calling anything done. `npm run simulate --
  --chooser findable` is the check that matters after touching the engine: it
  models a reader who always takes the most-voted film on the slate, and
  coverage must still close under it.
