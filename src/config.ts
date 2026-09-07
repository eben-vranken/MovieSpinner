import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE = path.join(process.cwd(), '.env');

if (fs.existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

export interface TmdbConfig {
  readToken: string;
  region: string;
}

export function tmdbConfig(): TmdbConfig {
  const readToken = process.env['TMDB_READ_TOKEN']?.trim();
  if (!readToken) {
    throw new Error(
      'TMDB_READ_TOKEN is not set. Copy .env.example to .env and fill it in.',
    );
  }
  return { readToken, region: process.env['TMDB_REGION']?.trim() || 'BE' };
}
