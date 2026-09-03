/**
 * POST /api/delivery/send  { case_id, to, dry_run? }
 *
 * Builds the SMS for a case (link + still-needed checklist + next step) and,
 * unless dry-run, sends it through Twilio and records a deliveries row.
 *
 * Dry run — ANY of: body `dry_run: true`, query `?dry_run=1`, env `DRY_RUN=1`
 * — returns the exact message, its length, the masked destination, the Twilio
 * account check and what the trial guard WOULD do. Nothing is sent and no
 * deliveries row is written.
 *
 * The body never contains the caller's answers; it is safe to print.
 */

import { NextResponse } from 'next/server';

import { getXanoAdapter } from '../../../../lib/adapters';
import { serverSecret } from '../../../../lib/adapters/env';
import {
  CATALOG_SUBMISSION_INSTRUCTIONS,
  SMS_MAX_CHARS,
  type Requirement,
} from '../../../../lib/contract';
import {
  buildSummaryMessage,
  sendSummaryDetailed,
  TO_EQUALS_FROM_ERROR,
  TRIAL_GUARD_ERROR,
} from '../../../../lib/delivery/sms';
import { checkTwilioAccount, isE164, maskPhone, twilioCredentials } from '../../../../lib/delivery/twilio';
import { buildPublicDocumentUrl } from '../../document/_lib/public-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC_NEXT_STEPS = 'Review the form, sign where marked, and hand it in the way the organization asks.';

interface SendBody {
  case_id?: unknown;
  to?: unknown;
  dry_run?: unknown;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

export async function POST(request: Request): Promise<Response> {
  let body: SendBody = {};
  try {
    body = (await request.json()) as SendBody;
  } catch {
    body = {};
  }
  const caseId = typeof body.case_id === 'string' || typeof body.case_id === 'number' ? String(body.case_id).trim() : '';
  const toRaw = typeof body.to === 'string' ? body.to.trim() : '';
  const to = toRaw || serverSecret('TWILIO_TEST_MOBILE') || '';
  const dryRun =
    truthy(body.dry_run) ||
    truthy(new URL(request.url).searchParams.get('dry_run')) ||
    truthy(serverSecret('DRY_RUN'));

  if (!caseId) {
    return NextResponse.json({ error: 'case_id is required' }, { status: 400 });
  }
  if (!to || !isE164(to)) {
    return NextResponse.json({ error: 'to must be an E.164 number, e.g. +14155550123' }, { status: 400 });
  }

  // Inputs from the system of record: program label, what is still missing, how to hand it in.
  let bundle;
  try {
    bundle = await getXanoAdapter().getCase(caseId);
  } catch (error) {
    return NextResponse.json(
      { error: 'case_unavailable', message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
  const program = bundle.program;
  const programName = program?.name ?? '';
  const organization = bundle.organization?.name || bundle.hospital?.name || '';
  const missing: Requirement[] = bundle.requirements.filter((r) => r.status === 'missing');
  const nextSteps =
    (program?.submission_instructions && program.submission_instructions.trim()) ||
    (program?.source_domain ? CATALOG_SUBMISSION_INSTRUCTIONS[program.source_domain] : undefined) ||
    GENERIC_NEXT_STEPS;

  const link = buildPublicDocumentUrl(caseId);
  const message = buildSummaryMessage({
    document_url: link.url,
    missing,
    next_steps: nextSteps,
    program_name: programName,
    organization,
  });

  const creds = twilioCredentials();
  const trialGuard = !creds
    ? 'no_credentials'
    : !creds.testMobile || to !== creds.testMobile
      ? 'would_skip'
      : to === creds.from
        ? 'to_equals_from'
        : 'would_send';
  const trialGuardNote =
    trialGuard === 'would_skip' ? TRIAL_GUARD_ERROR : trialGuard === 'to_equals_from' ? TO_EQUALS_FROM_ERROR : '';

  if (dryRun) {
    const account = creds ? await checkTwilioAccount(creds) : null;
    return NextResponse.json(
      {
        dry_run: true,
        sent: false,
        case_id: caseId,
        to_masked: maskPhone(to),
        message,
        length: message.length,
        max_chars: SMS_MAX_CHARS,
        document_url: link.url,
        link_absolute: link.absolute,
        link_signed: link.signed,
        missing: missing.map((r) => r.label),
        trial_guard: trialGuard,
        trial_guard_note: trialGuardNote,
        twilio: account
          ? {
              ok: account.ok,
              account_status: account.accountStatus,
              account_type: account.accountType,
              auth: account.authKind,
              from: account.from,
              from_sms_capable: account.fromSmsCapable,
              error: account.error,
            }
          : null,
        note: 'Dry run: nothing was sent and no deliveries row was written.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!link.absolute) {
    return NextResponse.json(
      { error: 'no_public_base_url', message: 'PUBLIC_BASE_URL is not set, so the document link would not open from a phone. Nothing was sent.' },
      { status: 409 },
    );
  }

  const outcome = await sendSummaryDetailed(
    { case_id: caseId, to, document_url: link.url, missing, next_steps: nextSteps },
    { message },
  );
  const status = outcome.delivery.status;
  const note =
    status === 'sent'
      ? 'A text is on its way. Nothing has been submitted to the organization.'
      : `The text was not sent (${status}${outcome.delivery.error ? `: ${outcome.delivery.error}` : ''}). The review link is still available.`;

  return NextResponse.json(
    {
      dry_run: false,
      sent: status === 'sent',
      case_id: caseId,
      delivery_id: outcome.delivery.id,
      status,
      provider_id: outcome.delivery.provider_id,
      error: outcome.delivery.error,
      to_masked: outcome.to_masked,
      message,
      length: message.length,
      document_url: link.url,
      persisted: outcome.persisted,
      persist_error: outcome.persist_error,
      note,
    },
    { status: status === 'failed' ? 502 : 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
