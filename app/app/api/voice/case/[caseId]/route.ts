/**
 * GET /api/voice/case/:caseId — authoritative case state for the browser.
 *
 * The live voice adapter re-reads this after every tool result so /live never
 * has to recompute completeness itself. Returns the full bundle plus the
 * progress and completeness summaries Xano is responsible for.
 */

import { NextResponse } from 'next/server';
import { computeCompleteness, computeProgress, getBundle } from '../../../../../lib/voice/case-store';
import { getXanoAdapter } from '../../../../../lib/voice/xano-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const { caseId } = await context.params;
  const xano = getXanoAdapter();

  try {
    const bundle = await xano.getCase(caseId);
    const progress = await xano.getCaseProgress(caseId).catch(() => computeProgress(bundle));
    const completeness = computeCompleteness(bundle);
    return NextResponse.json({ bundle, progress, completeness, events: bundle.events });
  } catch (error) {
    const fallback = getBundle(caseId);
    if (!fallback) {
      return NextResponse.json(
        { error: `Unknown case "${caseId}"`, detail: (error as Error).message },
        { status: 404 },
      );
    }
    return NextResponse.json({
      bundle: fallback,
      progress: computeProgress(fallback),
      completeness: computeCompleteness(fallback),
      events: fallback.events,
    });
  }
}
