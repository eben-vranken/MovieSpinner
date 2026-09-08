<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MovieSpinner

A personal blind-spot film picker. One user, no accounts, no auth, one page.

## Shape

Eleven build steps, all done: ingest a Letterboxd zip, enrich against TMDB,
compute coverage, build a candidate pool, draw the daily slate, show it, sync
the RSS feed, chart the coverage, edit the lineage edges, fold all of it onto a
single page, and make it set itself up for a stranger. `README.md` explains each
one and, more usefully, what went wrong the first time.

The day is a **slate of five films, and you choose one**. It used to be one
film handed over with a skip button. The scoring did not change when that did:
the five are drawn from the same weighted distribution, without replacement, so
choosing among them is choosing among five blind spots rather than choosing
whether to have one.

There is also a **manual override**: search the pool and lock any of its films
in for today. It reaches the pool, never past it, so it changes which blind spot
you close and never whether you close one.

And an optional **campaign mode**. Commit to a director, movement or country and
the five stop being five scattered gaps and become the next five films of that
subject, in order, until it is finished or you stop. The default draw is
breadth-first and very good at it, which is exactly why depth needs its own
mode: the cooldown multiplies a director seen inside a fortnight by 0.06, so
nobody was ever going to work through a filmography by accident.

- `src/db/migrations/*.sql` is the schema. Add a migration, never edit an applied one.
- `src/cli/*.ts` are the pipeline commands. `npm run report` verifies steps 1 to 5.
- `src/app/page.tsx` is the entire UI. There is still one route: `_shell/`
  holds a sidebar that switches between server-rendered sections, which is not
  navigation -- every section is rendered in the same pass and the shell shows
  one at a time. `_sections/` holds those sections, and `_charts/`, `_slate/`,
  `_campaign/`, `_lineage/` and `_browse/` are its private component folders.
- `src/lib/browse.ts` reads the library as a list rather than as a chart: the
  pool and the watched set, unioned, filtered on the same buckets the charts
  are cut by. `/api/pool` is the browse tab, `/api/country` is the click on the
  world map. Both are read-only and neither can choose a film.
- `src/lib/analytics.ts` loads every number the page draws, in one pass.
- `src/setup/pipeline.ts` runs import → enrich → coverage → pool as one job,
  writing progress to `setup_runs`. The page's upload box and `npm run setup`
  both call it.
- `src/setup/reset.ts` empties every table back to a fresh clone, for checking
  the first-run experience. The footer's danger zone and `npm run reset` both
  call it.
- `data/*.csv` are hand-curated and committed: overrides, movements, regions, lineage.

## Rules that matter

- **No reroll.** A day resolves to exactly one film and choosing is final.
  `persistPickRecord` is the single door into `picks` and refuses to overwrite;
  `persistSlate` refuses to redraw a slate. Do not add a way around either.
  Neither the slate nor the override relaxes this: they widen what you may
  choose, once. `lockInFilm` goes through `chooseFromSlate` and therefore
  through the same door, and it fails on a second use exactly as a second click
  does.
- **A campaign never reshapes a slate that already exists.** It applies to the
  next slate drawn, never today's -- checked in `ensureSlate`, which only draws
  when the day has no rows. Without that rule, "start a campaign, look, abandon
  it" would be a reroll with extra steps. Ending one does not touch today's
  slate either. One campaign at a time, enforced by a partial unique index
  rather than by code. Campaign slates are deterministic (`drawCampaignSlate`
  is a queue, not a sample) and suspend the junk valve.
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
- **Browsing is looking, not choosing.** The browse tab and the map's country
  panel read; they never write. The only doors into `picks` are still
  `chooseFromSlate` and `lockInFilm`, and neither is reachable from a poster
  wall -- a grid of four thousand films with a "choose" button on each would be
  the reroll this project spent eleven steps not having. The dim-what-I-have-
  seen toggle is CSS keyed off `data-seen`, so it works the same on a
  server-rendered grid and a fetched one.
- **Charts follow one system.** Palette, mark specs and spacers are documented at
  the top of `src/app/_charts/plots.tsx` and the colours are CSS variables in
  `globals.css`, validated against the panel surface. Every chart carries a
  table twin, and two or more series always carry a legend. No charting
  library: these are rectangles and paths, rendered on the server.
- **A dead source degrades the pool, it does not fail the build.** Both scraped
  canon sources go through `fromSource` in `src/pool/index.ts`: on failure the
  previous build's entries stay in `pool_list_entries` and the failure is
  returned in `PoolResult.failures`, never swallowed. criterion.com in
  particular rejects Node's TLS fingerprint about 90% of the time at random, so
  `fetchCriterion` retries 25 times. Do not "fix" that by impersonating a
  browser.
- **Unmatched rows go to `ingest_issues` or `pool_unresolved` with a reason.**
- **The auteur pool lists are shaped, not trusted.** `src/pool/shape.ts` caps
  them at 10 films per director, drops entries under 10 votes or 45 minutes or
  with more than 3 credited directors, and then rescues films back if a movement
  falls under 15 or a seeded region under 25. Canon, Criterion, regional and
  lineage entries are exempt from all of it. Every drop is logged in
  `pool_dropped`; every rescue in `pool_cap_overrides`.
- **Reset empties rows, never the file, and always backs up first.** The db
  handle is a singleton on `globalThis`; deleting the file under it leaves every
  later query pointed at nothing. `schema_migrations` is the one table kept, or
  the next boot re-runs every migration against a schema that already exists.
  `VACUUM` alone does not shrink the file in WAL mode -- the checkpoint after it
  is what does. The backup into `data/backups/` is not optional and not a
  prompt: it is what makes a one-click wipe recoverable.
- **This has to work on an empty database.** The database is gitignored, so
  anyone who clones this starts with nothing and no TMDB token. `appStatus()` in
  `src/lib/status.ts` is the only thing the page may call before checking
  readiness, and it never throws; everything else (`tmdbConfig`, `ensureSlate`,
  `loadAnalytics`) throws on an empty install and is right to. If you add an
  entry point, check readiness first.
- **Do not hardcode this user's figures into a check.** `report.ts` and
  `coverage.ts` compare against the brief only when the loaded profile is
  `BRIEF_PROFILE`; on anyone else's export they print the numbers without a
  verdict. A check that fails on a stranger's correct data is worse than no
  check.
- Run `npm run typecheck` before calling anything done. `npm run simulate --
  --chooser findable` is the check that matters after touching the engine: it
  models a reader who always takes the most-voted film on the slate, and
  coverage must still close under it.
