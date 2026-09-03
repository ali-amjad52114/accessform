/**
 * Approve and send — emailing the filled application to the program.
 *
 * This module sends NOTHING unless an operator has configured a provider
 * (`RESEND_API_KEY` + `SUBMISSION_FROM_EMAIL`), and it never records "sent"
 * without the provider returning a message id. Every path writes an honest
 * outcome:
 *
 *   sent     provider accepted the message (id returned)
 *   skipped  not attempted: demo mode, no provider, or no destination
 *   failed   provider or document error
 *
 * Order of operations, mirroring the SMS rail in ./sms.ts:
 *   1. `approval_recorded` event (the person said yes)
 *   2. destination from programs.submission_instructions or an env override
 *   3. body + attachments (filled PDF, or official PDF + answers.txt for flat forms)
 *   4. provider call (guarded)
 *   5. deliveries row (channel "email") + outcome event
 *
 * Server-only.
 */

import { getXanoAdapter } from '../adapters';
import { isDemoMode, serverSecret } from '../adapters/env';
import {
  NEED_CATEGORY_LABELS,
  type CaseBundle,
  type Delivery,
  type DeliveryStatus,
  type Id,
  type NeedCategory,
  type Requirement,
} from '../contract';
import { humanizeRequirementLabel } from '../interview/labels';
import { fetchSourcePdf, finalizeDocument } from '../../app/api/document/_lib/generate';
import { loadCaseInputs } from '../../app/api/document/_lib/case-inputs';
import { buildPublicDocumentUrl } from '../../app/api/document/_lib/public-url';
import { createDelivery, wouldBeDelivery } from './deliveries';

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export interface EmailAttachment {
  filename: string;
  /** Raw bytes; encoded per provider at send time. */
  content: Uint8Array;
  contentType: string;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: EmailAttachment[];
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ id: string }>;
}

const RESEND_URL = 'https://api.resend.com/emails';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Minimal Resend client. Only a 2xx with an id counts as sent. */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<{ id: string }> {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: toBase64(a.content),
          content_type: a.contentType,
        })),
      }),
    });
    const text = await response.text();
    let payload: { id?: string; message?: string; name?: string } = {};
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      /* non-JSON error body */
    }
    if (!response.ok || !payload.id) {
      const detail = payload.message ?? payload.name ?? (text.slice(0, 200) || 'no message id returned');
      throw new Error(`Resend ${response.status}: ${detail}`);
    }
    return { id: payload.id };
  }
}

export interface EmailProviderConfig {
  provider: EmailProvider | null;
  from: string;
  /** Why there is no provider; "" when configured. */
  reason: string;
}

export function emailProviderFromEnv(): EmailProviderConfig {
  const apiKey = serverSecret('RESEND_API_KEY');
  const from = serverSecret('SUBMISSION_FROM_EMAIL') ?? '';
  if (!apiKey || !from) {
    return { provider: null, from, reason: 'no_provider' };
  }
  return { provider: new ResendProvider(apiKey), from, reason: '' };
}

/* ------------------------------------------------------------------ */
/* Destination                                                         */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function extractEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(EMAIL_RE);
  return match ? match[0].toLowerCase() : null;
}

function overrideFor(programId: string | undefined): string | null {
  if (!programId) return null;
  const raw = serverSecret('SUBMISSION_EMAIL_OVERRIDES');
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const value = map[programId];
    return typeof value === 'string' ? extractEmail(value) : null;
  } catch {
    console.warn('[delivery/email] SUBMISSION_EMAIL_OVERRIDES is not valid JSON');
    return null;
  }
}

/** The program's published intake address, or null. Never invented. */
export function resolveDestination(bundle: CaseBundle): string | null {
  const program = bundle.program;
  return (
    extractEmail(program?.submission_instructions) ??
    overrideFor(program ? String(program.id) : undefined)
  );
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

function categoryLabel(bundle: CaseBundle): string {
  const category = bundle.case.need_category as NeedCategory | undefined;
  const label = category ? NEED_CATEGORY_LABELS[category] : undefined;
  return label ?? 'Assistance';
}

function organizationName(bundle: CaseBundle): string {
  return bundle.organization?.name?.trim() || bundle.hospital?.name?.trim() || 'the program';
}

export interface ComposedEmail {
  subject: string;
  text: string;
  missing: string[];
}

export function composeSubmissionEmail(bundle: CaseBundle, missing: Requirement[], now = new Date()): ComposedEmail {
  const organization = organizationName(bundle);
  const label = categoryLabel(bundle);
  const programName = bundle.program?.name?.trim() || `${label} application`;
  const date = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const missingLabels = Array.from(
    new Set(missing.map((r) => humanizeRequirementLabel(r.label)).filter((l) => l.length > 0)),
  );

  const lines: string[] = [
    `To whom it may concern at ${organization},`,
    '',
    `Please find attached a ${programName} that the applicant prepared on ${date} with AccessForm, a voice assistant that helps people complete official forms.`,
    '',
    'The applicant reviewed the filled form and asked that it be sent to you.',
  ];
  if (missingLabels.length > 0) {
    lines.push(
      '',
      'The applicant will provide the following separately:',
      ...missingLabels.map((l) => `  - ${l}`),
    );
  }
  lines.push(
    '',
    'AccessForm does not assess eligibility and makes no representation about the outcome; that decision rests with your organization.',
    '',
    'Thank you.',
  );

  return {
    subject: `${label} application for ${organization} — prepared with AccessForm`,
    text: lines.join('\n'),
    missing: missingLabels,
  };
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

function answersText(bundle: CaseBundle): string {
  const rows = bundle.answers
    .map((a) => {
      const value = a.value_json;
      if (value === null || value === undefined || value === '') return null;
      const display = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
      const label = a.field_id.replace(/_+/g, ' ').replace(/[:\s]+$/g, '').trim();
      return `${label}: ${display}`;
    })
    .filter((row): row is string => row !== null);
  return [
    `Answers given to AccessForm for ${organizationName(bundle)}.`,
    'Copy each value into the matching box on the official form.',
    '',
    ...rows,
  ].join('\n');
}

async function buildAttachments(bundle: CaseBundle, caseId: Id): Promise<EmailAttachment[]> {
  const flat = bundle.program?.form_kind === 'flat_pdf';
  if (flat) {
    const url = bundle.program?.application_url;
    if (!url) throw new Error('flat_pdf program has no application_url');
    const official = await fetchSourcePdf(url);
    return [
      { filename: `official-application-${caseId}.pdf`, content: official, contentType: 'application/pdf' },
      {
        filename: 'answers.txt',
        content: new TextEncoder().encode(answersText(bundle)),
        contentType: 'text/plain',
      },
    ];
  }
  const inputs = await loadCaseInputs(caseId);
  const doc = await finalizeDocument({
    caseId: inputs.caseId,
    answers: inputs.answers,
    sourceUrl: inputs.sourceUrl,
    instantJson: inputs.instantJson,
  });
  if (doc.origin === 'fixture') throw new Error('refusing to email the demo fixture document');
  return [{ filename: `application-${caseId}.pdf`, content: doc.pdfBytes, contentType: 'application/pdf' }];
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type EmailOutcome = 'sent' | 'skipped' | 'failed';

export interface ApproveAndSendInput {
  case_id: Id;
  approved_by: 'browser' | 'voice';
  dry_run?: boolean;
}

export interface ApproveAndSendResult {
  outcome: EmailOutcome | 'dry_run';
  dry_run: boolean;
  case_id: Id;
  to_masked: string | null;
  subject: string;
  body_chars: number;
  attachments: string[];
  provider: string | null;
  /** The deliveries row (or the would-be row when Xano did not take it). */
  delivery: Delivery | null;
  persisted: boolean;
  error: string;
  events_written: string[];
}

async function appendEvent(
  caseId: Id,
  event: { actor: 'user' | 'xano'; event_type: string; message: string; metadata_json?: Record<string, unknown> },
  written: string[],
): Promise<void> {
  try {
    await getXanoAdapter().appendEvent(caseId, { ...event, metadata_json: event.metadata_json ?? {} });
    written.push(event.event_type);
  } catch (error) {
    console.warn(`[delivery/email] could not write ${event.event_type} for case ${caseId}:`, (error as Error).message);
  }
}

/**
 * Record the approval and, when a provider is configured, email the
 * application. Never throws for provider/document problems; those become a
 * `failed` outcome. Throws only when the case itself cannot be read.
 */
export async function approveAndSend(input: ApproveAndSendInput): Promise<ApproveAndSendResult> {
  const caseId = String(input.case_id);
  const dryRun = input.dry_run === true;
  const events: string[] = [];
  const bundle = await getXanoAdapter().getCase(caseId);

  const missing = bundle.requirements.filter((r) => r.status === 'missing');
  const composed = composeSubmissionEmail(bundle, missing);
  const destination = resolveDestination(bundle);
  const providerConfig = emailProviderFromEnv();
  const link = buildPublicDocumentUrl(caseId).url;

  const base = {
    channel: 'email' as const,
    to: destination ?? '',
    message: composed.text,
    document_url: link,
  };

  const attachmentNames = bundle.program?.form_kind === 'flat_pdf'
    ? [`official-application-${caseId}.pdf`, 'answers.txt']
    : [`application-${caseId}.pdf`];

  const result = (
    outcome: EmailOutcome | 'dry_run',
    extra: Partial<ApproveAndSendResult> = {},
  ): ApproveAndSendResult => ({
    outcome,
    dry_run: dryRun,
    case_id: caseId,
    to_masked: destination ? maskEmail(destination) : null,
    subject: composed.subject,
    body_chars: composed.text.length,
    attachments: attachmentNames,
    provider: providerConfig.provider?.name ?? null,
    delivery: null,
    persisted: false,
    error: '',
    events_written: events,
    ...extra,
  });

  if (dryRun) {
    const wouldBe = isDemoMode()
      ? 'demo_mode'
      : !destination
        ? 'no_destination'
        : !providerConfig.provider
          ? 'no_provider'
          : 'would_send';
    return result('dry_run', { error: wouldBe === 'would_send' ? '' : wouldBe });
  }

  // 1. The approval itself, before anything else.
  await appendEvent(
    caseId,
    {
      actor: 'user',
      event_type: 'approval_recorded',
      message: 'Approval recorded: send the application to the program',
      metadata_json: { approved_by: input.approved_by, at: new Date().toISOString(), channel: 'email' },
    },
    events,
  );

  /** Write the deliveries row; fall back to an event when Xano rejects it (enum not pushed yet). */
  const record = async (status: DeliveryStatus, extra: { provider_id?: string; error?: string }) => {
    // Xano's POST /cases/{id}/deliveries requires `to`; with no destination
    // there is no row worth writing — the outcome event carries the reason.
    if (!destination) {
      return { delivery: wouldBeDelivery(caseId, { ...base, status, ...extra }), persisted: false, error: '' };
    }
    const write = await createDelivery(caseId, { ...base, status, ...extra });
    if (!write.persisted) {
      await appendEvent(
        caseId,
        {
          actor: 'xano',
          event_type: 'email_delivery',
          message: `Email delivery ${status} (row not persisted)`,
          metadata_json: { ...base, to: destination ? maskEmail(destination) : '', status, ...extra, persist_error: write.error },
        },
        events,
      );
    }
    return write;
  };

  const finish = async (
    outcome: EmailOutcome,
    status: DeliveryStatus,
    extra: { provider_id?: string; error?: string },
    event: { event_type: string; message: string },
  ) => {
    const write = await record(status, extra);
    await appendEvent(
      caseId,
      {
        actor: 'xano',
        event_type: event.event_type,
        message: event.message,
        metadata_json: { status, to: destination ? maskEmail(destination) : null, error: extra.error ?? '', provider_id: extra.provider_id ?? '' },
      },
      events,
    );
    return result(outcome, { delivery: write.delivery, persisted: write.persisted, error: extra.error ?? '' });
  };

  // 2. Guards, in order of "cheapest reason not to send".
  if (isDemoMode()) {
    return finish('skipped', 'skipped', { error: 'demo_mode' }, { event_type: 'email_skipped', message: 'Email not attempted: demo mode' });
  }
  if (!destination) {
    return finish('skipped', 'skipped', { error: 'no_destination' }, { event_type: 'email_skipped', message: 'Email not attempted: the program has no published intake address' });
  }
  if (!providerConfig.provider) {
    return finish('skipped', 'skipped', { error: 'no_provider' }, { event_type: 'email_skipped', message: 'Email not attempted: no email provider configured' });
  }

  // 3. Attachments (the real filled document, never the fixture).
  let attachments: EmailAttachment[];
  try {
    attachments = await buildAttachments(bundle, caseId);
  } catch (error) {
    const message = (error as Error).message;
    return finish('failed', 'failed', { error: `document: ${message}` }, { event_type: 'email_failed', message: 'Email failed: the document could not be prepared' });
  }

  // 4. Provider. queued row → send → final row.
  await record('queued', {});
  try {
    const { id } = await providerConfig.provider.send({
      from: providerConfig.from,
      to: destination,
      subject: composed.subject,
      text: composed.text,
      attachments,
    });
    const domain = destination.split('@')[1] ?? '';
    return finish('sent', 'sent', { provider_id: id }, { event_type: 'application_emailed', message: `Application emailed to ${domain}` });
  } catch (error) {
    const message = (error as Error).message;
    return finish('failed', 'failed', { error: message }, { event_type: 'email_failed', message: 'Email failed: the provider rejected the message' });
  }
}
