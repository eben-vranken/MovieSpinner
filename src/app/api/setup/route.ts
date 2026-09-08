import { NextResponse } from 'next/server';
import { appStatus } from '../../../lib/status';

/**
 * Setup progress, for the browser to poll while the pipeline runs.
 *
 * A route handler rather than a server action because the client polls it every
 * two seconds and a server action would re-render the whole page each time --
 * which, mid-import, means re-reading a database the pipeline is writing to.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const status = appStatus();
  return NextResponse.json(status, {
    headers: { 'cache-control': 'no-store' },
  });
}
