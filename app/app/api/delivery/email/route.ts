/**
 * POST /api/delivery/email  { case_id, approved_by: 'browser' | 'voice', dry_run? }
 *
 * "Approve and send": records the person's approval as an event, then emails
 * the filled application to the program's published intake address — but
 * only when an email provider is configured. Without one the approval is still
 * recorded and the delivery is written as `skipped: no_provider`. The word
 * "sent" appears only after the provider returned a message id.
 *
 * Dry run — ANY of: body `dry_run: true`, query `?dry_run=1`, env `DRY_RUN=1`
 * — writes nothing and reports what would happen (masked destination, subject,
 * attachment names, and the guard that would stop it).
 */

import { NextResponse } from 'next/server';

import { serverSecret } from '../../../../lib/adapters/env';
import { approveAndSend } from '../../../../lib/delivery/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface EmailBody {
  case_id?: unknown;
  approved_by?: unknown;
  dry_run?: unknown;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

export async function POST(request: Request): Promise<Response> {
  let body: EmailBody = {};
  try {
    body = (await request.json()) as EmailBody;
  } catch {
    body = {};
  }
  const caseId =
    typeof body.case_id === 'string' || typeof body.case_id === 'number' ? String(body.case_id).trim() : '';
  const approvedBy = body.approved_by === 'voice' ? 'voice' : body.approved_by === 'browser' ? 'browser' : null;
  const dryRun =
    truthy(body.dry_run) ||
    truthy(new URL(request.url).searchParams.get('dry_run')) ||
    truthy(serverSecret('DRY_RUN'));

  if (!caseId) {
    return NextResponse.json({ error: 'invalid_body', message: 'case_id is required' }, { status: 400 });
  }
  if (!approvedBy) {
    return NextResponse.json(
      { error: 'invalid_body', message: "approved_by must be 'browser' or 'voice'" },
      { status: 400 },
    );
  }

  try {
    const result = await approveAndSend({ case_id: caseId, approved_by: approvedBy, dry_run: dryRun });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: 'case_unavailable', message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function GET(): Response {
  return NextResponse.json({
    ok: true,
    endpoint: 'approve-and-send',
    provider_configured: Boolean(serverSecret('RESEND_API_KEY') && serverSecret('SUBMISSION_FROM_EMAIL')),
  });
}
