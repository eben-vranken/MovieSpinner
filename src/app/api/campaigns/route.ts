import { NextResponse } from 'next/server';
import { campaignOptions } from '../../../lib/campaign';
import type { CampaignKind } from '../../../lib/campaign';

/**
 * Subjects you could commit to, for the campaign picker.
 *
 * A route handler rather than props on the page because the list is three
 * different queries over a few thousand rows and only one of them is ever on
 * screen. Loading all three on every dashboard render to populate a panel most
 * days nobody opens would be the wrong trade.
 */
export const dynamic = 'force-dynamic';

const KINDS = new Set(['director', 'movement', 'country']);

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const raw = url.searchParams.get('kind') ?? 'director';
  const kind = (KINDS.has(raw) ? raw : 'director') as CampaignKind;
  const query = (url.searchParams.get('q') ?? '').trim();

  return NextResponse.json(campaignOptions(kind, query), {
    headers: { 'cache-control': 'no-store' },
  });
}
