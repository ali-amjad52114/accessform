/**
 * GET /api/document/:caseId/status
 *
 * Metadata about the generated application: where the bytes came from, how many
 * fields were written, and whether the Nutrient accessibility pass actually ran.
 * Nothing here ever asserts that the application was submitted or approved.
 *
 * `?cached=1` answers from the disk cache / bundled fixture without touching
 * the network, which is what the /review server render uses.
 */

import { NextResponse } from 'next/server';

import { DEMO_CASE_ID } from '../../../../../lib/contract';
import { loadCaseInputs } from '../../_lib/case-inputs';
import { describeDocument } from '../../_lib/generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const { caseId } = await params;
  const cachedOnly = new URL(request.url).searchParams.get('cached') === '1';

  try {
    const inputs = await loadCaseInputs(caseId || DEMO_CASE_ID);
    const doc = await describeDocument({
      caseId: inputs.caseId,
      answers: inputs.answers,
      sourceUrl: inputs.sourceUrl,
      instantJson: inputs.instantJson,
      cachedOnly,
    });
    return NextResponse.json(doc, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'document_unavailable', message },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
