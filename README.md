# MovieSpinner

A daily blind-spot film picker. One film a day, locked, chosen to fill gaps in
my film education rather than to match my taste. See the project brief for the
full design.

All nine build steps are done: ingest, enrich, coverage, pool, engine, daily
card, RSS sync, dashboard, lineage editor.

```
npm install
cp .env.example .env    # TMDB credentials
npm run import && npm run enrich && npm run coverage && npm run pool
npm run dev             # http://localhost:3000
```

## Running it

```
npm install
cp .env.example .env        # then fill in your TMDB credentials

npm run import              # newest letterboxd-*.zip in ./data
npm run enrich              # match everything to TMDB, cache the metadata
npm run matches             # anything TMDB matching could not settle
npm run coverage            # decade / country / director / movement
npm run pool                # build the candidate pool and check its supply
npm run simulate            # a year of picks, without writing anything down
npm run pick                # today's film, generated once and locked
npm run sync                # read the Letterboxd feed, close out watched picks
npm run report              # verification for the whole pipeline
npm run dev                 # the app
npm run typecheck
```

Both `import` and `enrich` are safe to re-run. The database lands at
`data/moviespinner.db`; delete it and re-run those two and everything rebuilds,
with `enrich` making zero network calls because the TMDB responses are cached
on disk.

Useful flags:

```
npm run import -- <path>        # a specific zip, or an extracted directory
npm run enrich -- --all         # re-match everything, cache still used
npm run enrich -- --refresh     # ignore the cache and re-fetch from TMDB
npm run enrich -- --limit 20    # smoke test
npm run matches -- --write      # seed data/tmdb-overrides.csv with stubs
npm run coverage -- --snapshot  # record today's numbers for the trend
npm run pool -- --report        # print the current pool without rebuilding
npm run pool -- --refresh       # re-scrape the canon pages and re-fetch TMDB
npm run simulate -- --days 365 --skip-rate 0.2 --list
npm run pick -- --watched       # mark today watched
npm run pick -- --skip          # record a skip; it returns at reduced weight
npm run pick -- --history 14
```

## Where things stand

```
PASS  watched films             436       PASS  match rate      100.0% of 584 matchable
PASS  rated films               410       PASS  awaiting review 0
PASS  rewatches                  51             exact 540, near 40, override 17
PASS  watchlist                 164             excluded on purpose 13
PASS  mean rating              3.58             runtime  583/584   country 584/584
PASS  median rating             3.5             director 581/584   poster  583/584
PASS  oldest film year         1954             BE subscription 301 films
PASS  all nine decade buckets           PASS  snapshots       1
                                              movements  20 of 42 touched
PASS  every movement supplied           PASS  pre-1950 supply  917 films
      pool 5532 films, uncapped               against 0 watched
PASS  every edge target in pool         PASS  no film picked twice
      104 lineage edges, 88 live              in a simulated year
PASS  RSS sync                          PASS  all nine build steps
      50 feed entries, exact TMDB ids         verified
```

`npm run report` prints that and exits nonzero if any of it drifts.

## Layout

| Path | What it does |
|---|---|
| `src/db/migrations/*.sql` | Schema, applied in filename order, reasoning inline |
| `src/db/client.ts` | Connection, pragmas, migration runner |
| `src/ingest/letterboxd.ts` | Zip/CSV to typed rows. No database knowledge |
| `src/ingest/import.ts` | Rows to database, in one transaction |
| `src/ingest/enrich.ts` | TMDB matching and metadata persistence |
| `src/tmdb/client.ts` | TMDB HTTP, retry, on-disk response cache |
| `src/tmdb/match.ts` | Title normalisation and candidate scoring |
| `src/cli/*.ts` | The seven npm scripts |
| `src/coverage/index.ts` | Coverage counting, movement tagging, snapshots |
| `src/pool/sources.ts` | Scrapers and config readers for the pool sources |
| `src/pool/index.ts` | Resolve, dedupe, exclude watched, materialise |
| `src/engine/tuning.ts` | Every number the draw depends on, in one file |
| `src/engine/index.ts` | Gap scores, cooldowns, the draw, persistence |
| `src/engine/random.ts` | Seeded PRNG, so a date always gives the same film |
| `src/sync/rss.ts` | Letterboxd feed reader. No auth, no API application |
| `src/app/page.tsx` | The daily card |
| `src/app/dashboard/` | Coverage, the world map, movements, regions |
| `src/app/lineage/` | The edge editor, writing back to the CSV |
| `data/tmdb-overrides.csv` | Manual match resolutions. Committed on purpose |
| `data/movements.csv` | The hand-curated movement taxonomy |
| `data/film-movements.csv` | Films tagged to a movement by hand |
| `data/movement-directors.csv` | Who defines each movement. Tags films and seeds the pool |
| `data/pool-regions.csv` | Per-country regional seeding config |
| `data/lineage.csv` | 104 hand-authored edges, each with its sentence |

## Step 1: ingest

Parses a Letterboxd export zip into SQLite and reproduces every figure the
brief quotes from the Sept 2026 export.

**Film identity is the Letterboxd permalink.** `watched.csv`, `ratings.csv`,
`watchlist.csv` and `likes/films.csv` all carry the same stable short link per
film (`https://boxd.it/azpY`). Across this export it is exactly 1:1 with
`(name, year)`, so it is safe as the canonical key and survives title
corrections.

`diary.csv` is the exception. Its `Letterboxd URI` column is the *diary entry*
permalink, not the film's, so diary rows are matched onto a film by
`(name, year)`. All 411 resolved.

**An export is a snapshot, not a delta.** So every snapshot table (`watched`,
`ratings`, `likes`, `watchlist`, `diary_entries`) is emptied and rebuilt inside
a single transaction. Re-importing is idempotent, and unlike a plain upsert it
also propagates *removals*. Verified both ways.

`films` is the exception: it accumulates and is never deleted from, because
TMDB metadata hangs off `film_id` and has to outlive re-imports. Same for
`imports` and `ingest_issues`, which are an append-only provenance log.

**Nothing is dropped silently.** `ingest_issues` collects anything unresolved or
odd, tagged with a stage, a severity and the raw row as JSON. The current export
produces five:

- `[REC]³ Genesis` (2012) is liked but never logged as watched. A Letterboxd
  quirk, harmless. It is why the film union is 597 and not 596.
- Four films sit on the watchlist *and* in the watched set: Jennifer's Body,
  Last Night in Soho, In the Mood for Love, Swing Girls. Flagged because §6 of
  the brief gives watchlist films a pool bonus and excludes watched films.
  **Excluded wins** — a bonus must never resurrect a film I have already seen.

## Step 2: enrich

Matches all 597 films to TMDB and caches metadata, posters and Belgian watch
providers. 580 matched automatically, 4 pinned by hand, 13 excluded on purpose.
100% of what can be matched, against the brief's >90% bar.

**Three match tiers, and only two of them are trusted.** `exact` is an identical
normalised title and the same year. `near` is an identical title within one year,
because Letterboxd and TMDB disagree about festival versus theatrical release
often enough that a year of slack is normal. Both are written as confirmed.
`fuzzy` is anything else plausible: it is written, but left unconfirmed so
`npm run matches` keeps nagging. Nothing guessy ever silently becomes truth.

Three matcher details that were not obvious until the data disagreed:

- **A candidate with no release date is penalised, not treated as neutral.**
  Those records are almost always unreleased stubs, and left neutral they beat
  the real film on title alone. An empty "Precious" outranked *Precious: Based
  on the Novel Push by Sapphire* until this changed.
- **Subtitles get stripped on both sides.** Letterboxd says "Wake Up Dead Man",
  TMDB says "Wake Up Dead Man: A Knives Out Mystery".
- **Tier beats score.** An exact title within a year is a better answer than a
  higher-scoring near-title that nails the year, or "Millennium Actress: Tracks"
  (2001) wins over the actual *Millennium Actress* (TMDB 2002, Letterboxd 2001).

**The cache is trimmed on the way in.** Untrimmed, 600 films came to 48MB:
watch providers for every country on earth, plus full cast and crew (830 people
on *Blade Runner 2049*). Only the configured region's providers and a handful of
crew jobs are kept, which brings it to 6MB. Changing `TMDB_REGION` therefore
needs `npm run enrich -- --refresh`.

### The 17 films TMDB matching could not settle

They are listed with a reason in `data/tmdb-overrides.csv`, which is committed
and which `enrich` reloads on every run. Four are real films TMDB files under a
different title or year:

| Film | TMDB | Why it missed |
|---|---|---|
| Nausicaä of the Valley of the Wind | 81 | TMDB's English title is the butchered US cut, *Warriors of the Wind* |
| Terrifier | 420634 | Letterboxd uses the 2016 festival year, TMDB the 2018 release |
| Precious | 25793 | TMDB carries the full *Based on the Novel Push by Sapphire* title |
| Wake Up Dead Man | 812583 | TMDB carries the full *A Knives Out Mystery* title |

Two are simply not on TMDB: *David Lynch Cooks Quinoa* (2007) and *The Legend
of Pipi* (2022). The first is a short. The second I could not identify at all
and is worth a manual look.

**The other eleven are television, not film**, which is why `/search/movie` was
never going to find them: Neon Genesis Evangelion, Cowboy Bebop, Serial
Experiments Lain, Gunbuster, Record of Lodoss War, The Haunting of Hill House,
The Queen's Gambit, Devs, The Gene, The Beatles: Get Back, The Green Planet.
They are pinned to no TMDB id with a note, so they stop being reported as
failures. Seven of the eleven are in the watched set; the rest are watchlist
only. See step 3 for how they are counted.

### Two matcher bugs found while reading step 3's output

Both were matches that looked fine in the summary and were wrong in the data.

**Exact title plus exact year is not proof.** TMDB is full of obscure films
sharing a title, and when one lands on Letterboxd's year it beats the famous one
whose TMDB year is a year off. A 6-vote Russian *The Witch* beat Eggers' (7853
votes); a no-vote Lebanese *Talk to Me* beat the Philippou brothers'. Seven
matches were wrong this way, including *Split*, *Boys Don't Cry* and *Obsession*.
Now a rival one year off wins if it is overwhelmingly better known, on a
deliberately steep margin, because picking the famous film when the obscure one
was meant is the worse error.

**`production_countries` is sorted alphabetically, not by significance.** Using
its first entry as the lead country filed *The Witch* under Brazil (BR/CA/GB/US)
and *Blade Runner 2049* under Canada. TMDB's `origin_country` is the field that
actually names the lead country and says US for both. Correcting it moved 62
films into the US column and cut Latin America from 6 to 3.

## Step 3: coverage

```
Decade      pre-1950 0 | 1950s 8 | 1960s 17 | 1970s 20 | 1980s 33
            1990s 49 | 2000s 104 | 2010s 96 | 2020s 109
Country     US 275, GB 50, JP 36, FR 11, DE 10, KR 10, then a cliff
Director    338 distinct, 268 of them seen exactly once
Movement    19 of 42 touched, 23 with nothing at all
```

**Movement is hand-curated**, which settles that open question from §11. The
taxonomy lives in `data/movements.csv` (42 movements, each with a period, a
region and a note) and the tags in `data/film-movements.csv` (54 films). Both
are committed, reloaded on every run, and keyed by `tmdb_id` so the step 4
candidate pool can be tagged with the same files. Wikipedia scraping would
produce tags nobody can trust and dropping the dimension throws away the most
interesting axis on the dashboard.

Every movement gets a row even at zero, because on this dashboard a zero is the
most informative cell. The untouched 23 include silent era, German Expressionism,
Soviet Montage, Italian Neorealism, prewar Japanese, Indian Parallel Cinema,
Iranian New Wave, Third Cinema, Cinema Novo and postcolonial African cinema.

**Two universes, on purpose.** Decade counts all 436 watched films on the
Letterboxd year, so the grid keeps reproducing §2 exactly, wall and all. Country,
director and movement can only count the 429 with TMDB metadata; the seven
missing are the television entries and the two films TMDB lacks. Both numbers
are printed so the denominator never changes quietly. That is the answer to the
TV question: television stays in the watched history and out of the coverage
dimensions it cannot contribute to.

**Country is reported two ways.** The lead country is one per film and is what
gap scoring in step 5 should use. Counting every production country is what the
world map in §7 wants, and it flatters: Latin America reads 3 as lead country
and 9 in any role, because Herzog shooting *Fitzcarraldo* in Peru lands in the
PE bucket. The report prints both side by side.

**Snapshots start now, not at step 8.** §7 wants change over time, and a history
that begins the day the dashboard is built is a history of nothing. `npm run
coverage -- --snapshot` writes one row per bucket per day into
`coverage_snapshots`, replacing any snapshot already taken that day.

## Step 4: candidate pool

6,179 films, uncapped. Four kinds of source, doing different jobs:

| Source | Films | How it resolves |
|---|---|---|
| TSPDT 1000 | 993 / 1000 | Publishes IMDb ids, so it is an exact join |
| The Criterion Collection | 1630 / 1710 | Title matched at the same confidence bar as the import |
| 49 regional lists | 1358 | TMDB `discover` by origin country, hand-tuned per country |
| 39 auteur lists | 3707 | Every film by a movement's directors, inside its period |

115 already-watched films were excluded, 69 pool films are on my watchlist.

**Uncapped, and progress is measured against movements and regions instead.**
Percent of pool cleared is a progress bar that resets the moment you clear it
and raise the cap. Movements and regions close and stay closed, and a filled
cell means something concrete.

**Sight and Sound is not a separate list.** The BFI page renders only about 30
of its 100 entries server-side and loads the rest through a JS API that would
need reverse-engineering, which is a fragile thing for a personal tool to depend
on. It costs almost nothing in practice: the poll is one of TSPDT's primary
sources, so its films are already in the pool through a list that publishes IMDb
ids. What is lost is Sight and Sound as an independent vote in the
"how many lists agree" signal.

**The auteur lists exist because the canon was not enough.** With only TSPDT,
Criterion and the regional queries, Spaghetti Western had zero pool films and
Cinema of Moral Anxiety had zero, so the engine would have been pointing at gaps
it could never fill. `data/movement-directors.csv` already names who defines each
movement, so the same file now seeds the pool with their filmographies. Every
movement is supplied; the thinnest is Cinema du look at 16 films.

**Criterion mixes films and box sets.** "Eclipse Series 42: Silent Ozu",
"The Koker Trilogy" and "Olivier's Shakespeare" will never match a film. Every
single film in that list carries a year and every box set omits one, which is a
cleaner signal than pattern-matching titles. Separating them takes the apparent
miss rate from 13% to 5%: 162 sets skipped, 80 genuinely unmatched.

TSPDT's 7 misses are all television (Berlin Alexanderplatz, Heimat, Scenes from
a Marriage, Twin Peaks: The Return), the same film/TV boundary as step 2.

### Supply against gaps

This is the check §6 demands, made numeric before any engine exists. Watched on
the left, available in the pool on the right:

```
  0 / 1013  pre-1950            0 /  196  India
  8 /  653  1950s               0 /  174  Iran
 17 /  946  1960s               0 /  193  Africa
 20 /  779  1970s               0 /  132  Southeast Asia
 33 /  524  1980s               3 /  423  Latin America
                                1 /   75  Middle East beyond Iran
```

Senegal really is the constraint the brief predicted: TMDB has 11 Senegalese
films with any meaningful vote count. That is now a number rather than a guess,
and the engine can be told about it rather than discovering it by serving the
same four films forever.

## Movement tagging, revisited

Hand-tagging films works at 429 watched films and does not work at 6,179 pool
films. So the curation moved up a level: movements are largely defined by their
directors, and `data/movement-directors.csv` names them. Any film by one of those
directors inside the movement's period gets tagged.

A few movements are periods and places rather than auteur groups, and those use
`auto_rule = period`: the silent era is everything before 1930, classical
Hollywood is American output between 1930 and 1948.

That produces 4,358 tags from 54 hand-written ones, and `film_movements.source`
records which rule produced each so a suspicious cell can be traced. Director
names are resolved against people TMDB has actually credited, so a typo surfaces
as an unknown name rather than silently tagging nothing.

## Step 5: the engine

A year of picks, simulated. Nothing about this is written down until `npm run
pick` runs for real.

```
Decade    1960s 47 | pre-1950 44 | 2000s 44 | 1990s 42 | 2010s 42
          1970s 40 | 1980s 37 | 1950s 37 | 2020s 32
Country   US 43, IT 25, FR 24, JP 18, DE 17, MX 13, GB 13, SU 12, HK 12, IN 11
Movement  silent era 15, African 11, Iranian New Wave 10, Mexican Golden Age 9

PASS  no film picked twice        0 repeats
PASS  the draw stays a surprise   best-weighted film averages 2.3% of the draw
PASS  lineage reaches the card    41 picks arrived with a reason (11.2%)
      junk valve fired            52 times, one a week
      most films by one director  6
      150 minutes or longer       30 (8.2%)

Over one year: all 22 untouched movements open, 41 countries seen for the
first time, and pre-1950 goes from 0 films to 44.
```

**Locked and deterministic.** The seed is a hash of the date string, so a given
date always produces the same film. `persistPick` refuses to overwrite an
existing row, which is the no-reroll rule enforced in code rather than by
convention. Verified: same date twice gives the same film, the next day differs,
and a second write is rejected.

**Weighting, in one file.** `src/engine/tuning.ts` holds every number. The gap
score per dimension saturates smoothly toward a baseline rather than falling off
a cliff, per §4. The brief suggests a bucket is closed around 8 films; that is
right for a movement and wrong for a decade, so the shape is the brief's and the
number is per dimension: decade 25, country 12, director 4, movement 8.

The four gap scores are blended, then raised to a single sharpness exponent.
That exponent is the only dial between "the top film always wins" and "it is a
shuffle", and at 2.2 the best-weighted film takes 2.3% of the draw. Multiplying
the four scores instead would have given a 250x spread and made the pick
predictable, which §4 explicitly warns against.

### What the first simulation got wrong

Running it is what found these. The brief was right to insist on it.

**It served "Temple of the White Elephant" and a 17-minute Romanian short.**
The gap weighting was working perfectly and had no idea that some of its
candidates are canon and some are the fortieth most-voted film from a small
country. Two fixes: shorts under 40 minutes left the pool, and every film now
carries a **stature** factor from where it came from. A TSPDT film scales from
2.4 at rank 1 to 1.4 at rank 1000; Criterion is 1.45, an auteur list 0.9, a
regional discover query 0.45. Films with almost no TMDB votes get a gentle
findability discount, floored at 0.45 so a Souleymane Cissé film with sixty
votes still comes through.

**The junk valve was another obscurity machine.** §6 wants Sunday to be a film I
would simply enjoy, and it was returning a 1919 German film four people have
rated. The taste score barely discriminated, because almost every pool film fell
back to my overall mean. Adding a familiarity curve on vote count, steeply
weighted, moved 1.2% of Sunday's probability onto films with under 100 votes
instead of 7%. Sunday now serves The Hunt, The Thin Red Line, The Wizard of Oz.

**A finding worth knowing:** horror is my *lowest*-rated genre at 3.22 across 141
films, and my decade averages run 1950s 3.92 down to 2020s 3.40. So the junk
valve, reading only my ratings, leans older and away from horror. That is what
the history says even though horror is the spine of what I watch. If it feels
wrong in practice, the fix is a genre weight in the tuning file, not a model.

### Lineage

104 hand-authored edges in `data/lineage.csv`, 88 of them from a film I rated 4
or better, which is the bar §5 sets. Every edge target is in the pool, including
32-minute *Night and Fog*: an edge is a written argument that this exact film
matters, and that outranks a blanket rule about runtime.

At a 6x bonus, lineage lands about 11% of days, roughly one a week, and each one
arrives with its sentence:

```
2026-09-19  The Devils (1971)  GB  112m
            Russell's religious horror, still hard to see and worth the effort.
2026-09-25  Martyrs (2008)     CA   99m
            If you want to know how far horror can actually go, this is the standard.
```

### Skips and cooldowns

A skip is recorded, not undone. The film returns at 0.2 weight recovering on a
curve over 90 days, so the fortnight after a skip stays near the floor. Over 800
simulated days with a skip every fifth pick, 25 films came back, the shortest gap
was 74 days and none returned inside two weeks.

Cooldowns multiply weight down hard rather than excluding: the same country or
director inside 14 days, the same decade inside 7, each costing a factor of 0.06.

## Steps 6 to 9: the app

Next.js App Router, server components reading SQLite directly, server actions
for the three things you can do. No client-side data fetching except the film
search in the lineage editor, and no state management, because there is no
state: the database is the state.

### The daily card (`/`)

Poster, title, year, director, country, runtime, movements, Belgian
availability, and either the lineage sentence or a plain-language version of
which gap the film fills. Two buttons, watched and skip, and a line of text
saying there is no reroll.

The pick is generated on first read and never again. That is safe precisely
because `persistPick` refuses to overwrite: two tabs opening at midnight cannot
produce two different films.

### RSS sync (`/api/cron`, `npm run sync`)

Letterboxd's feed carries `<tmdb:movieId>` on every item, so this is an exact
join rather than another title-matching problem. A pending pick closes when the
feed shows that film watched on or after the day it was offered.

The sync deliberately does **not** feed coverage. §3 makes the zip export tier 1
and the feed tier 2, and the feed only knows the last fifty diary entries; using
it for the dimensions would give a partial, drifting picture. It records what it
saw in `rss_entries` so a run is repeatable and a resolved pick can be traced.

The same job also generates the day's pick, so the card is already waiting
rather than being conjured by whoever opens the page.

**Scheduling.** Running locally, this is a Task Scheduler entry or a cron line
that does `cd` into the project and runs `npm run sync`. Deployed, `vercel.json`
already declares a 06:00 daily cron against `/api/cron`. Set `CRON_SECRET` if
you deploy it; the route is unguarded without one, and an unguarded endpoint
that writes to the database would be the one careless thing in this project.

### Dashboard (`/dashboard`)

The decade grid is the hero, with the wall stated in words above it and a column
showing what the pool has available to fix each row. Then the world map, then
progress, then movements, then director depth, then a deliberately small block
of streak and skip numbers.

Progress is measured against **movements and regions**, not percent of pool
cleared. A pool percentage resets the moment the pool grows; these close and
stay closed, and a filled cell means something concrete.

The map is plain server-rendered SVG over `world-atlas` with `d3-geo`. Country
identity is matched by name, because the atlas carries numeric ISO ids and the
database carries alpha-2; names line up for 83 of the 94 codes in the data and
the rest are aliased. Anything still unmatched is listed under the map rather
than silently dropped, which currently means Hong Kong, since it is a city and
the 110m atlas has no shape for it.

Every dimension is paired with where it stood at the earliest snapshot, because
§7 asks for change rather than position. Run
`npm run coverage -- --snapshot` monthly and the "+n" column starts meaning
something.

### Lineage editor (`/lineage`)

Add an edge by searching for an anchor you rated 4 or better, searching for a
target in the pool, and writing the sentence. Edges are grouped by anchor and
show whether the target is in the pool and whether it has already been offered.

**Every change is written back to `data/lineage.csv`.** The file is the
committed source of truth and every run reloads from it, so an edge that only
lived in the database would vanish the next time anything called `loadLineage`.
Editing in the app and editing the file by hand are the same operation. Verified
by round trip: add, reload from disk, delete, reload, and the file comes back
byte-identical.

## Data shape

```
films (597)             canonical identity: lb_uri, name, year
├── watched (436)         1:1
├── ratings (410)         1:1, 0.5–5.0 in half steps
├── likes (300)           1:1
├── watchlist (164)       1:1
├── diary_entries (411)   1:many, one row per viewing, 51 rewatches
└── film_matches (597)    1:1 join to the TMDB cache, with method and confidence

tmdb_films (584)        cache keyed by tmdb_id, not film_id, so the step 4
├── tmdb_film_crew        candidate pool can reuse it instead of duplicating
├── tmdb_film_countries   every production country, alphabetical
├── tmdb_film_genres
└── tmdb_watch_providers  region BE

movements (42)          hand-curated taxonomy, from data/movements.csv
└── film_movements (54)   tagged by tmdb_id, from data/film-movements.csv

coverage_snapshots      one row per bucket per day, for the §7 trend

lineage_edges (104)     hand-authored, from data/lineage.csv
picks                   one row per day, written once, never recomputed

pool_lists (90)         four kinds: canon, collection, regional, auteur
└── pool_list_entries     membership kept per list, not collapsed
pool (6179)             deduped, watched excluded, watchlist flagged
pool_unresolved         source rows that did not resolve, never dropped
```

Diary viewings per year confirm the accelerating pace the brief describes:
24 (2022), 16 (2023), 39 (2024), 162 (2025), 170 (2026 through August).

## Open questions

Settled:

- **How to source movement tags.** Hand-curated, in two committed CSVs. See
  step 3.
- **Do TV series count toward coverage?** They stay in the watched history and
  out of the three dimensions they cannot contribute to. Both denominators are
  always printed.

- **Whether the candidate pool should be capped.** It is not. Progress is
  reported against movements and regions, which close and stay closed.

- **Whether a skipped film's lineage rationale is reshown.** It is. The reason a
  film went unwatched is rarely the reason it was offered, and a fresh angle
  would mean writing a second sentence for every edge to solve a problem nobody
  has yet.

Nothing from §11 is still open. One thing worth deciding later: availability in
Belgium is shown on the card but does not affect weighting, which is what §4 and
§7 describe. It does mean some picks cannot be watched the day they arrive, and
skip is the intended answer.

## Stack

Node + TypeScript throughout. SQLite via `better-sqlite3`, `csv-parse` and
`adm-zip` for ingest, `d3-geo` plus `world-atlas` for the map, Next.js and
Tailwind for the UI. No HTTP client dependency; Node's `fetch` is enough, and no
charting library, because everything here is a table or one SVG projection.

The pipeline is CLI-first and the UI reads the same database, which is why every
step could be verified before any of it was rendered.

**One thing to know before deploying.** `better-sqlite3` is a native module and
will not run on Vercel's serverless runtime. Locally this is a non-issue. Hosted,
it means either Turso/libSQL behind the same `src/db/client.ts` seam or a
long-lived host that can keep a file open. The rest of the app does not care
which.
