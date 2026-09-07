<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MovieSpinner

A personal daily blind-spot film picker. One user, no accounts, no auth.

## Shape

Nine build steps, all done: ingest a Letterboxd zip, enrich against TMDB,
compute coverage, build a candidate pool, draw a daily pick, show it, sync the
RSS feed, chart the coverage, edit the lineage edges. `README.md` explains each
one and, more usefully, what went wrong the first time.

- `src/db/migrations/*.sql` is the schema. Add a migration, never edit an applied one.
- `src/cli/*.ts` are the pipeline commands. `npm run report` verifies steps 1 to 5.
- `src/app` is the Next.js UI; everything under it reads the database directly.
- `data/*.csv` are hand-curated and committed: overrides, movements, regions, lineage.

## Rules that matter

- **No reroll.** `persistPick` refuses to overwrite a pick. Do not add a way around it.
- **The CSVs are the source of truth**, not the tables built from them. Anything
  the UI writes must be written back out to the file.
- **Every tuning number lives in `src/engine/tuning.ts`.** No magic constants in
  the scoring path; the point is being able to read why a film was chosen.
- **Nothing is dropped silently.** Unmatched rows go to `ingest_issues` or
  `pool_unresolved` with a reason.
- Run `npm run typecheck` before calling anything done.
