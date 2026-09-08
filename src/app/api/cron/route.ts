import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { sync } from '../../../sync';
import { letterboxdUser } from '../../../setup/pipeline';

/**
 * The daily job as an HTTP endpoint, for Vercel Cron or any scheduler that can
 * make a request. The CLI (`npm run sync`) does exactly the same work.
 *
 * Guarded by CRON_SECRET when one is set. This is a single-user app with no
 * accounts, so an unguarded endpoint that writes to the database would be the
 * one genuinely careless thing in it.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env['CRON_SECRET'];
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const handle = db();
    const result = await sync(handle, letterboxdUser(handle));
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'sync failed' },
      { status: 500 },
    );
  }
}
