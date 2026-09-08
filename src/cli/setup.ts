import fs from 'node:fs';
import path from 'node:path';
import { migrate, openDb } from '../db/client';
import { latestRun, runPipeline, STAGES } from '../setup/pipeline';
import { dataDir } from '../paths';

/**
 * The whole first run in one command: import, enrich, coverage, pool.
 *
 * The four steps still exist separately and are still the right thing to reach
 * for when one of them is misbehaving -- they print far more about what they
 * did. This is for the case where you just got the project, have an export, and
 * want it working: the same job the upload box on the page runs, with the same
 * progress written to the same table.
 *
 * Usage:
 *   npm run setup                     # newest letterboxd-*.zip in ./data
 *   npm run setup -- <zip-or-dir>     # a specific export
 */

function newestExport(): string {
  const dir = dataDir();
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => /^letterboxd-.*\.zip$/i.test(name))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const newest = candidates[0];
  if (!newest) {
    throw new Error(
      `No letterboxd-*.zip found in ${dir}.\n` +
        'Ask Letterboxd for your data at letterboxd.com/settings/data, put the zip there, ' +
        'or pass a path: npm run setup -- path/to/export.zip',
    );
  }
  return newest;
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? newestExport();
  const db = openDb();
  migrate(db);

  console.log(`\nSetting up from ${path.basename(source)}\n`);
  for (const [index, stage] of STAGES.entries()) {
    console.log(`  ${index + 1}. ${stage.label.padEnd(28)} ${stage.note}`);
  }
  console.log(
    '\nThe TMDB steps are the slow ones and their responses are cached on disk,\n' +
      'so a second run is much faster than the first.\n',
  );

  // Progress lives in setup_runs, so this just reads it back on a timer rather
  // than threading a second callback through the pipeline.
  let last = '';
  const timer = setInterval(() => {
    const run = latestRun(db);
    if (!run || run.status !== 'running') return;
    const line = `  ${run.stage.padEnd(9)} ${run.detail ?? ''}`;
    if (line !== last) {
      last = line;
      console.log(line);
    }
  }, 1000);

  const started = Date.now();
  const run = await runPipeline(db, source);
  clearInterval(timer);

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (run.status === 'failed') {
    console.log(`\nFailed after ${seconds}s during "${run.stage}".`);
    console.log(`  ${run.error}\n`);
    console.log('Run that step on its own to see more:');
    console.log(`  npm run ${run.stage === 'import' ? 'import' : run.stage}\n`);
    db.close();
    process.exitCode = 1;
    return;
  }

  console.log(`\nReady in ${seconds}s. ${run.detail}.`);
  console.log(`  profile   ${run.username ?? '(unknown)'}`);
  console.log('\nStart it with  npm run dev  and open http://localhost:3000');
  console.log('Or see today’s five right here:  npm run slate\n');
  db.close();
}

void main();
