/**
 * SMS delivery — lib/delivery/sms.ts (M1_MODULES.sendSummary / buildSummaryMessage).
 *
 * The text a caller receives carries a LINK and a CHECKLIST, never the answers:
 * no name, no amounts, no phone number, no claim of outcome.
 *
 *   AccessForm: your <program> application is filled and ready to review: <link>
 *   Still needed: <a>; <b>; <c>; +N more          (omitted when nothing is missing)
 *   Next: <one sentence from program.submission_instructions>
 *   Nothing has been sent to <organization>. You decide what to send.
 *
 * `buildSummaryMessage` is pure and deterministic and never exceeds
 * SMS_MAX_CHARS. Fit order (contract §3.5): shorten next_steps, then drop the
 * program name from the link line, then collapse the missing list to
 * "+N more", then shorten next_steps again — the link line is never cut.
 *
 * `sendSummary` writes a `queued` deliveries row, applies the guards (demo
 * mode → skipped; trial account → only TWILIO_TEST_MOBILE, else skipped; no
 * credentials → failed), calls Twilio, and records the outcome row. It returns
 * the final Delivery. A `skipped`/`failed` delivery is never reported as sent.
 */

import { humanizeRequirementLabel } from '../interview/labels';
import { isDemoMode } from '../adapters/env';
import {
  SMS_MAX_CHARS,
  SMS_MAX_MISSING_ITEMS,
  SMS_TEMPLATE,
  type BuildSummaryMessageInput,
  type Delivery,
  type Requirement,
  type SendSummaryInput,
} from '../contract';
import { createDelivery, type DeliveryWrite } from './deliveries';
import { isE164, maskPhone, sendSms, twilioCredentials } from './twilio';

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

/** Contract input plus the two optional labels the product copy uses. */
export interface SummaryMessageInput extends BuildSummaryMessageInput {
  /** e.g. "Cedars-Sinai Financial Assistance Application". Omit → generic line. */
  program_name?: string;
  /** e.g. "Cedars-Sinai Medical Center". Omit → generic footer. */
  organization?: string;
}

export const SMS_PROGRAM_LINK_TEMPLATE =
  'AccessForm: your {program} application is filled and ready to review: {document_url}' as const;
export const SMS_ORGANIZATION_FOOTER_TEMPLATE =
  'Nothing has been sent to {organization}. You decide what to send.' as const;

/** ASCII on purpose: "…" is not GSM-7 and would force UCS-2 (70-char segments). */
const ELLIPSIS = '...';
/** Room the "Next:" sentence should get before we start dropping other things. */
const NEXT_STEPS_COMFORT = 80;
const NEXT_STEPS_FLOOR = 40;
/** Below this a cut sentence stops being useful; drop a label before going lower. */
const NEXT_STEPS_MIN = 24;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** First sentence of the instructions, so "Next:" is one sentence. */
function firstSentence(value: string): string {
  const text = oneLine(value);
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  return match ? match[1] : text;
}

/** "Cedars-Sinai Financial Assistance Application" -> "Cedars-Sinai Financial Assistance". */
function programLabel(name: string): string {
  return oneLine(name).replace(/\s+(application|application form|form)\s*$/i, '').trim();
}

/** Cut at a word boundary and append "..."; "" when nothing sensible fits. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const room = max - ELLIPSIS.length;
  if (room < 8) return '';
  const head = value.slice(0, room);
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.floor(room / 2) ? head.slice(0, space) : head;
  return cut.replace(/[\s,;:]+$/, '') + ELLIPSIS;
}

function missingLabels(missing: readonly Requirement[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const r of missing) {
    if (r.status !== 'missing') continue;
    const label = oneLine(humanizeRequirementLabel(r.label));
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function missingLine(labels: readonly string[], shown: number): string | null {
  if (labels.length === 0) return null;
  const head = labels.slice(0, shown);
  const rest = labels.length - head.length;
  let items = head.join('; ');
  if (rest > 0) {
    const more = SMS_TEMPLATE.more.replace('{n}', String(rest));
    items = head.length > 0 ? items + more : more.replace(/^;\s*/, '');
  }
  return SMS_TEMPLATE.missing.replace('{items}', items);
}

interface Layout {
  withProgram: boolean;
  withOrganization: boolean;
  /** How many missing labels to list (the rest become "+N more"). */
  shown: number;
  /** Minimum room the "Next:" sentence must get for this layout to be accepted. */
  nextFloor: number;
}

/** Lines other than "Next:", for a layout. */
function fixedLines(input: SummaryMessageInput, labels: readonly string[], layout: Layout): { head: string[]; footer: string } {
  const url = oneLine(input.document_url);
  const program = input.program_name ? programLabel(input.program_name) : '';
  const link =
    layout.withProgram && program
      ? SMS_PROGRAM_LINK_TEMPLATE.replace('{program}', program).replace('{document_url}', url)
      : SMS_TEMPLATE.link.replace('{document_url}', url);
  const organization = input.organization ? oneLine(input.organization) : '';
  const footer =
    layout.withOrganization && organization
      ? SMS_ORGANIZATION_FOOTER_TEMPLATE.replace('{organization}', organization)
      : SMS_TEMPLATE.footer;
  const missing = missingLine(labels, layout.shown);
  return { head: missing ? [link, missing] : [link], footer };
}

/**
 * Try a layout: give "Next:" whatever room is left under the cap. Returns the
 * message when it fits and the sentence got at least `nextFloor`, else null.
 */
function attempt(input: SummaryMessageInput, labels: readonly string[], layout: Layout, sentence: string): string | null {
  const { head, footer } = fixedLines(input, labels, layout);
  const nextPrefix = SMS_TEMPLATE.next.replace('{next_steps}', '');
  const fixedLength = head.join('\n').length + 1 + footer.length; // +1 newline before footer
  const room = SMS_MAX_CHARS - fixedLength - 1 - nextPrefix.length; // -1 newline before Next
  // The floor only matters when the sentence would have to be cut.
  if (sentence && room >= 1 && (room >= sentence.length || room >= layout.nextFloor)) {
    const next = truncate(sentence, room);
    if (next) return [...head, nextPrefix + next, footer].join('\n');
  }
  if (!sentence || layout.nextFloor === 0) {
    const noNext = [...head, footer].join('\n');
    if (noNext.length <= SMS_MAX_CHARS) return noNext;
  }
  return null;
}

/**
 * Pure. Output ≤ SMS_MAX_CHARS. Contains no personal data by construction:
 * only the link, requirement labels, the program's instructions and fixed copy.
 *
 * Priority when space is short: link > missing labels > next step > extra
 * copy (program name, organization). The link line is never cut.
 */
export function buildSummaryMessage(input: SummaryMessageInput): string {
  const labels = missingLabels(input.missing);
  const sentence = firstSentence(input.next_steps);
  const all = SMS_MAX_MISSING_ITEMS;

  // Outermost: how many labels survive. Then how short "Next:" may get.
  // Innermost: the optional copy (program name, organization) — first to go.
  const copies: Array<Pick<Layout, 'withProgram' | 'withOrganization'>> = [
    { withProgram: true, withOrganization: true },
    { withProgram: false, withOrganization: true },
    { withProgram: false, withOrganization: false },
  ];
  const layouts: Layout[] = [];
  for (let shown = all; shown >= 0; shown -= 1) {
    for (const nextFloor of [NEXT_STEPS_COMFORT, NEXT_STEPS_FLOOR, NEXT_STEPS_MIN]) {
      for (const copy of copies) layouts.push({ ...copy, shown, nextFloor });
    }
  }
  // Last resort: no "Next:" line at all, still preferring more labels.
  for (let shown = all; shown >= 0; shown -= 1) {
    layouts.push({ withProgram: false, withOrganization: false, shown, nextFloor: 0 });
  }

  for (const layout of layouts) {
    const message = attempt(input, labels, layout, sentence);
    if (message) return message;
  }
  // Only reachable with an absurdly long URL: keep the link, cut the tail.
  const bare = fixedLines(input, labels, { withProgram: false, withOrganization: false, shown: 0, nextFloor: 0 });
  return [...bare.head, bare.footer].join('\n').slice(0, SMS_MAX_CHARS);
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export const TRIAL_GUARD_ERROR = 'trial account: only the verified test number may receive SMS' as const;
export const DEMO_SKIP_ERROR = 'demo mode: SMS not attempted' as const;
export const TO_EQUALS_FROM_ERROR =
  'destination equals the Twilio from-number; set TWILIO_TEST_MOBILE to a verified mobile that is not the sending number' as const;

export interface SendSummaryOptions {
  /** Pre-built body (from buildSummaryMessage). Built from `input` when absent. */
  message?: string;
  program_name?: string;
  organization?: string;
}

export interface SendSummaryOutcome {
  delivery: Delivery;
  /** Whether the FINAL row reached Xano. */
  persisted: boolean;
  /** Xano write error for the final row, "" when persisted. */
  persist_error: string;
  to_masked: string;
}

/** Same as sendSummary but also says whether the row landed in Xano. */
export async function sendSummaryDetailed(
  input: SendSummaryInput,
  options: SendSummaryOptions = {},
): Promise<SendSummaryOutcome> {
  const message =
    options.message ??
    buildSummaryMessage({
      document_url: input.document_url,
      missing: input.missing,
      next_steps: input.next_steps,
      program_name: options.program_name,
      organization: options.organization,
    });
  const to = input.to.trim();
  const base = { channel: 'sms' as const, to, message, document_url: input.document_url };

  const finish = (write: DeliveryWrite): SendSummaryOutcome => ({
    delivery: write.delivery,
    persisted: write.persisted,
    persist_error: write.error,
    to_masked: maskPhone(to),
  });

  // Invalid destination: no provider call, one failed row.
  if (!isE164(to)) {
    return finish(await createDelivery(input.case_id, { ...base, status: 'failed', error: 'destination is not an E.164 number' }));
  }

  // Demo mode: no Twilio call, one skipped row.
  if (isDemoMode()) {
    return finish(await createDelivery(input.case_id, { ...base, status: 'skipped', error: DEMO_SKIP_ERROR }));
  }

  const creds = twilioCredentials();
  if (!creds) {
    return finish(await createDelivery(input.case_id, { ...base, status: 'failed', error: 'Twilio credentials are not configured' }));
  }

  // Trial guard: the account can only text the one verified number.
  if (!creds.testMobile || to !== creds.testMobile) {
    return finish(await createDelivery(input.case_id, { ...base, status: 'skipped', error: TRIAL_GUARD_ERROR }));
  }
  // Twilio rejects To == From (error 21266); say so before spending the call.
  if (to === creds.from) {
    return finish(await createDelivery(input.case_id, { ...base, status: 'failed', error: TO_EQUALS_FROM_ERROR }));
  }

  // queued row → Twilio → final row (edit-in-place on provider_id when sent).
  await createDelivery(input.case_id, { ...base, status: 'queued' });
  const result = await sendSms(creds, { to, body: message });
  if (result.ok && result.sid) {
    return finish(await createDelivery(input.case_id, { ...base, status: 'sent', provider_id: result.sid }));
  }
  return finish(await createDelivery(input.case_id, { ...base, status: 'failed', error: result.error || 'Twilio did not return a message SID' }));
}

/** Contract signature (SendSummaryFn). */
export async function sendSummary(input: SendSummaryInput): Promise<Delivery> {
  const outcome = await sendSummaryDetailed(input);
  return outcome.delivery;
}
