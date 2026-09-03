/**
 * GET /api/document/:caseId
 *
 * Streams the filled + accessibility-tagged application PDF for a case.
 * The three Nutrient server keys stay on this side of the wire; the browser
 * only ever sees this same-origin URL, which is what the Nutrient Viewer loads.
 */

import { NextResponse } from 'next/server';

import { DEMO_CASE_ID } from '../../../../lib/contract';
import { loadCaseInputs } from '../_lib/case-inputs';
import { requireDocumentToken } from '../_lib/public-url';
import { finalizeDocument } from '../_lib/generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const { caseId } = await params;

  const denied = requireDocumentToken(request, caseId || DEMO_CASE_ID);
  if (denied) return denied;

  try {
    const inputs = await loadCaseInputs(caseId || DEMO_CASE_ID);
    const doc = await finalizeDocument({
      caseId: inputs.caseId,
      answers: inputs.answers,
      sourceUrl: inputs.sourceUrl,
      instantJson: inputs.instantJson,
    });

    const body = new Uint8Array(doc.pdfBytes.byteLength);
    body.set(doc.pdfBytes);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(body.byteLength),
        'Content-Disposition': `inline; filename="cedars-financial-assistance-${caseId}.pdf"`,
        'Cache-Control': 'private, max-age=300',
        'X-AccessForm-Document-Origin': doc.origin,
        'X-AccessForm-Accessibility-Status': doc.accessibilityStatus,
        'X-AccessForm-Fields-Filled': String(doc.fieldsFilled),
        'X-AccessForm-Version-Hash': doc.versionHash,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'document_unavailable', message },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
