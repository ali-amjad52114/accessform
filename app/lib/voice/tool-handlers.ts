/**
 * The M1 voice tools, server side.
 *
 * `M1VoiceToolHandlers` (from the contract) is keyed by the exact names Vapi
 * calls: create_case, resolve_need, discover_program, get_next_question,
 * save_answer, validate_case, finalize_document, send_summary, and the
 * get_case_progress alias. Everything here runs on the server and goes through
 * the Xano bridge for the system of record; judgment steps go through the
 * binding M1 modules (lib/need, lib/discovery, lib/forms, lib/interview,
 * lib/delivery) and the registered document adapter.
 *
 * Product rules encoded here:
 * - Need first. A case is opened from the caller's own words; no organization
 *   or bill is required to start.
 * - Never substitute one organization's form for another. `found: true` only
 *   ever comes from the discovery module's verified result.
 * - Completeness, next question and progress come from Xano. Nothing here
 *   recomputes them (the fixture store answers only in demo mode).
 * - Accessibility status is literal (`preserved` is not "processed").
 * - No fixtures outside demo mode.
 * - Nothing in this file may return copy that claims eligibility, approval,
 *   submission, or a signature.
 */

import { createHash } from 'node:crypto';

import {
  DEMO_FILLED_PDF_PATH,
  FORBIDDEN_FIELD_PATTERNS,
  INSTANT_JSON_FIELD_TYPE,
  INSTANT_JSON_FORMAT,
  M1_VOICE_TOOL_NAMES,
  NEED_CATEGORIES,
  NEED_CATEGORY_LABELS,
  NEED_CONFIDENCE_FLOOR,
  PUBLIC_BASE_URL_ENV,
  SAFE_COPY,
  type AccessibilityStatus,
  type Answer,
  type CaseBundle,
  type CaseDocument,
  type CreateCaseInput,
  type CreateCaseM1Request,
  type CreateCaseToolInput,
  type CreateCaseToolResult,
  type DeliveryStatus,
  type DiscoverProgramToolInput,
  type DiscoverProgramToolResult,
  type FinalizeDocumentToolInput,
  type FinalizeDocumentToolResult,
  type FinalizedDocument,
  type FormSchemaField,
  type GetNextQuestionToolInput,
  type GetNextQuestionToolResult,
  type Id,
  type InstantJson,
  type InterviewProgress,
  type M1VoiceToolHandlers,
  type M1VoiceToolName,
  type NeedCategory,
  type NeedResolution,
  type NextQuestion,
  type NextQuestionResponse,
  type ResolveNeedToolInput,
  type ResolveNeedToolResult,
  type ResolvedProgram,
  type SaveAnswerM1ToolInput,
  type SaveAnswerToolResult,
  type SaveDocumentInput,
  type SendSummaryToolInput,
  type SendSummaryToolResult,
  type ValidateCaseToolInput,
  type ValidateCaseToolResult,
} from '../contract';
import { buildPublicDocumentUrl, signedDocumentPath } from '../../app/api/document/_lib/public-url';
import { sendSummary } from '../delivery/sms';
import { resolveProgram } from '../discovery/resolve-program';
import { mapAnswers } from '../forms/map-answers';
import { understandForm } from '../forms/understand-form';
import { humanizeRequirementLabel } from '../interview/labels';
import { nextQuestion } from '../interview/next-question';
import { resolveNeed } from '../need/resolve-need';
import { getNutrientAdapter } from './adapter-registry';
import * as fixtures from './case-store';
import { interviewPlanAsFormSchema, resolveField } from './form-plan';
import { getXanoAdapter } from './xano-bridge';

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** Generic replacements for the hospital-specific SAFE_COPY lines. */
const COPY = {
  caseOpened: 'Case opened. Nothing has been sent anywhere.',
  notSubmitted: 'Not submitted. The organization decides approval.',
  disclaimer: (organization: string) =>
    `AccessForm cannot determine eligibility. ${organization} makes that decision.`,
  foundNote:
    'Official source verified. Say you found the current official form, then call get_next_question.',
  foundNonPdfNote:
    'Official source verified, but this application is not a fillable PDF, so you cannot fill it on this call. ' +
    'Tell the caller plainly where the official form is and what the next step is. Do NOT start an interview ' +
    'and do NOT call save_answer, validate_case or finalize_document. You may call send_summary to text them the link.',
  notFoundNote:
    'Tell the caller plainly that you could not verify an official form for that organization or place, ' +
    'so you cannot fill one for them yet. Do NOT continue the interview and do NOT call save_answer, ' +
    'validate_case or finalize_document for this case. Offer to note their situation and end the call.',
  clarifyNote:
    'You are not sure what the caller needs yet. Ask the clarifying question, listen, then call resolve_need again ' +
    'with everything the caller has said so far.',
  resolvedNote:
    'Need understood. If you do not yet know where the caller is, ask "where are you right now?" (a city or ZIP is enough), ' +
    'then call discover_program with this category, the organization they named (if any) and that location.',
  genericNextSteps: 'Review the filled form, sign it yourself, and send it to the organization.',
} as const;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Mirrors lib/adapters/env.ts without importing the adapter layer. */
function isDemoMode(): boolean {
  const raw = (process.env.NEXT_PUBLIC_DEMO_MODE ?? '').trim().toLowerCase();
  if (!raw) return true;
  return raw !== 'false' && raw !== '0';
}

function xanoBaseUrl(): string | null {
  const base =
    process.env.XANO_API_BASE ??
    process.env.XANO_BASE_URL ??
    process.env.NEXT_PUBLIC_XANO_API_BASE ??
    '';
  return base ? base.replace(/\/+$/, '') : null;
}

/** Direct call for the M1 endpoints the legacy XanoAdapter has no method for. */
async function xanoJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = xanoBaseUrl();
  if (!base) throw new Error('XANO_BASE_URL is not configured');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.XANO_API_KEY ?? process.env.XANO_AUTH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Xano ${init?.method ?? 'GET'} ${path} -> ${response.status} ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/**
 * PUT /cases/{id} — best effort. The endpoint is new in M1; a deployment
 * without it must not fail the caller's turn.
 */
async function updateCase(caseId: Id, patch: Record<string, unknown>): Promise<boolean> {
  try {
    await xanoJson(`/cases/${encodeURIComponent(caseId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return true;
  } catch (error) {
    console.warn('[voice] PUT /cases/{id} unavailable:', (error as Error).message);
    return false;
  }
}

/** Absolute origin for links that leave the app (SMS). */
function publicBaseUrl(): string | null {
  const raw = (process.env[PUBLIC_BASE_URL_ENV] ?? '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = publicBaseUrl();
  return base ? `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}` : pathOrUrl;
}

function maskPhone(to: string): string {
  const digits = to.replace(/\D/g, '');
  return `***${digits.slice(-4)}`;
}

/** Loose E.164 normalisation for spoken numbers: "(415) 555-0123" -> "+14155550123". */
function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.length >= 8 ? digits : null;
  const only = digits.replace(/\D/g, '');
  if (only.length === 10) return `+1${only}`;
  if (only.length === 11 && only.startsWith('1')) return `+${only}`;
  return only.length >= 8 ? `+${only}` : null;
}

function titleCase(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Section key -> spoken/feed label, e.g. "personal_information" -> "Personal information". */
function sectionLabel(section: string | undefined): string {
  if (!section) return 'Answer';
  const spaced = titleCase(section);
  return spaced.charAt(0) + spaced.slice(1).toLowerCase();
}

function isNeedCategory(value: unknown): value is NeedCategory {
  return typeof value === 'string' && (NEED_CATEGORIES as readonly string[]).includes(value);
}

function isForbiddenField(field: Pick<FormSchemaField, 'field_id' | 'label'>): boolean {
  const haystack = `${field.field_id} ${field.label}`.toLowerCase();
  return FORBIDDEN_FIELD_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Feed copy for an accessibility status. Only `processed` may claim that an
 * accessibility pass ran; `preserved` means no pass ran and the official
 * document's own tagging was kept. Kept local so the voice layer does not
 * import the adapter layer (see adapter-registry.ts).
 */
function accessibilityEventFor(status: AccessibilityStatus): { event_type: string; message: string } {
  switch (status) {
    case 'processed':
      return { event_type: 'accessibility_processed', message: 'Accessibility processing complete' };
    case 'preserved':
      return {
        event_type: 'accessibility_preserved',
        message: "Official document's accessibility tagging preserved",
      };
    case 'failed':
      return { event_type: 'accessibility_failed', message: 'Accessibility processing unavailable' };
    case 'processing':
      return { event_type: 'accessibility_processing', message: 'Accessibility processing running' };
    case 'pending':
      return { event_type: 'accessibility_pending', message: 'Accessibility processing not yet run' };
    case 'not_applicable':
      return {
        event_type: 'accessibility_not_applicable',
        message: 'Accessibility processing does not apply',
      };
  }
}

/* ------------------------------------------------------------------ */
/* Organization matching (reused by discovery)                         */
/* ------------------------------------------------------------------ */

const GENERIC_ORG_WORDS = new Set([
  'medical', 'center', 'centre', 'hospital', 'health', 'healthcare', 'system',
  'the', 'of', 'and', 'inc', 'foundation', 'clinic', 'group', 'services',
  'service', 'agency', 'college', 'university', 'transit', 'authority',
]);

function orgTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length >= 3 && !GENERIC_ORG_WORDS.has(token)),
  );
}

/**
 * True when the organization the caller named is the one discovery actually
 * has a verified source for. "Cedars", "Cedars Sinai" and "Cedars-Sinai Medical
 * Center" all match each other; "UCSF Medical Center" matches none of them.
 */
export function organizationMatches(requested: string, known: string): boolean {
  const a = orgTokens(requested);
  const b = orgTokens(known);
  if (a.size === 0 || b.size === 0) return false;
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Form schema access                                                  */
/* ------------------------------------------------------------------ */

function normalizeSchemaRow(raw: unknown, programId: Id): FormSchemaField | null {
  const row = asRecord(raw);
  const fieldId = typeof row.field_id === 'string' ? row.field_id : '';
  if (!fieldId) return null;
  const mapping = row.pdf_mapping;
  const mappedName =
    typeof mapping === 'string'
      ? mapping
      : typeof asRecord(mapping).acroform_field === 'string'
        ? (asRecord(mapping).acroform_field as string)
        : fieldId;
  const pdfFieldName =
    typeof row.pdf_field_name === 'string' && row.pdf_field_name ? row.pdf_field_name : mappedName || fieldId;
  const section =
    typeof row.section === 'string' && row.section
      ? row.section
      : typeof row.group_key === 'string'
        ? row.group_key
        : '';
  const options = asArray(row.options)
    .filter((option): option is string => typeof option === 'string')
    .map((option) => option.replace(/^\//, ''));
  const dependency = typeof row.dependency_rule === 'string' && row.dependency_rule ? row.dependency_rule : null;
  return {
    id: row.id === undefined || row.id === null ? '' : String(row.id),
    program_id: row.program_id === undefined || row.program_id === null ? programId : String(row.program_id),
    field_id: fieldId,
    label: typeof row.label === 'string' && row.label ? row.label : fieldId,
    normalized_key: typeof row.normalized_key === 'string' ? row.normalized_key : '',
    type: (typeof row.type === 'string' ? row.type : 'text') as FormSchemaField['type'],
    required: row.required === undefined ? true : Boolean(row.required),
    conversational_prompt: typeof row.conversational_prompt === 'string' ? row.conversational_prompt : '',
    dependency_rule: dependency,
    pdf_mapping: mappedName || fieldId,
    section,
    order: typeof row.order === 'number' ? row.order : 0,
    options,
    pdf_field_name: pdfFieldName,
  };
}

/**
 * The program's form_schema rows, in asking order, from Xano.
 *
 * Tries the M1 path first, then the legacy `/fields` alias, and accepts every
 * response shape those endpoints have used (`{fields}`, `{form_schema}`, a bare
 * array). Outside demo mode an unreachable Xano yields `[]` — never the
 * Cedars interview plan for a program that is not Cedars.
 */
async function loadFormSchema(programId: Id): Promise<FormSchemaField[]> {
  const paths = [
    `/programs/${encodeURIComponent(programId)}/form_schema`,
    `/programs/${encodeURIComponent(programId)}/fields`,
  ];
  if (xanoBaseUrl()) {
    for (const path of paths) {
      try {
        const raw = await xanoJson<unknown>(path);
        const rows = Array.isArray(raw)
          ? raw
          : asArray(asRecord(raw).fields).length > 0
            ? asArray(asRecord(raw).fields)
            : asArray(asRecord(raw).form_schema);
        const fields = rows
          .map((row) => normalizeSchemaRow(row, programId))
          .filter((row): row is FormSchemaField => row !== null);
        if (fields.length > 0) return fields;
      } catch (error) {
        console.warn(`[voice] GET ${path} failed:`, (error as Error).message);
      }
    }
  }
  return isDemoMode() ? interviewPlanAsFormSchema(programId) : [];
}

function findSchemaField(schema: readonly FormSchemaField[], fieldIdOrKey: string): FormSchemaField | null {
  const wanted = fieldIdOrKey.trim();
  const lower = wanted.toLowerCase();
  return (
    schema.find((field) => field.field_id === wanted) ??
    schema.find((field) => field.normalized_key === wanted) ??
    schema.find((field) => field.field_id.toLowerCase() === lower) ??
    schema.find((field) => field.normalized_key.toLowerCase() === lower) ??
    schema.find((field) => (field.pdf_field_name ?? '').toLowerCase() === lower) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Progress access                                                     */
/* ------------------------------------------------------------------ */

function emptyProgress(): InterviewProgress {
  return { answered: 0, total: 0, percent: 0, section_index: 0, section_count: 0, sections: [] };
}

/**
 * Xano's progress for the interview. Prefers the M1 `next_question` response
 * (which carries `sections`); falls back to the pre-M1 `progress` endpoint —
 * still Xano's numbers, never recomputed here.
 */
async function loadInterviewProgress(caseId: Id): Promise<{ progress: InterviewProgress; question: NextQuestion | null; done: boolean } | null> {
  if (xanoBaseUrl()) {
    try {
      const raw = await xanoJson<NextQuestionResponse>(`/cases/${encodeURIComponent(caseId)}/next_question`);
      const progress = raw.progress ?? emptyProgress();
      const question = raw.question ? { ...raw.question, progress: raw.question.progress ?? progress } : null;
      return { progress, question, done: raw.done ?? question === null };
    } catch (error) {
      console.warn('[voice] GET /cases/{id}/next_question unavailable:', (error as Error).message);
    }
  }
  try {
    const legacy = await getXanoAdapter().getCaseProgress(caseId);
    const sections = legacy.sections ?? [];
    const activeIndex = sections.findIndex((section) => section.state === 'active');
    const progress: InterviewProgress = {
      answered: legacy.answersSaved,
      total: legacy.answersExpected,
      percent: legacy.percent,
      section_index: activeIndex >= 0 ? activeIndex : sections.length,
      section_count: sections.length,
      sections,
    };
    const question: NextQuestion | null = legacy.nextFieldId
      ? {
          field_id: legacy.nextFieldId,
          prompt: legacy.nextPrompt ?? '',
          section: sections[activeIndex]?.key ?? '',
          progress,
          required: true,
        }
      : null;
    return { progress, question, done: question === null };
  } catch (error) {
    console.warn('[voice] GET /cases/{id}/progress failed:', (error as Error).message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Document helpers                                                    */
/* ------------------------------------------------------------------ */

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Best-effort copy of the produced PDF on disk; the API route stays the URL of record. */
async function writeGeneratedFile(fileName: string, bytes: Uint8Array): Promise<string | null> {
  try {
    const fs = await import('node:fs/promises');
    for (const dir of ['public/generated', 'app/public/generated']) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dir}/${fileName}`, bytes);
        return `/generated/${fileName}`;
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // no filesystem (should not happen on the Node runtime)
  }
  return null;
}

/**
 * Demo-mode stand-in for the fill pipeline, written through the live system
 * of record when there is one and the in-memory store otherwise. Never used
 * outside demo mode.
 */
async function saveFallbackDocument(caseId: Id, sourceUrl: string | null): Promise<CaseDocument> {
  const input: SaveDocumentInput = {
    type: 'filled_application',
    source_url: sourceUrl,
    generated_url: DEMO_FILLED_PDF_PATH,
    accessibility_status: 'processed',
    version_hash: `fixture-${String(caseId).toLowerCase()}-v1`,
  };
  try {
    return await getXanoAdapter().saveDocument(caseId, input);
  } catch (error) {
    console.warn('[voice] could not persist the document, using the local store:', (error as Error).message);
  }
  try {
    return fixtures.markReadyForReview(caseId);
  } catch {
    return {
      id: `doc_${String(caseId)}`,
      case_id: caseId,
      type: 'filled_application',
      source_url: input.source_url ?? null,
      generated_url: input.generated_url ?? null,
      accessibility_status: 'processed',
      version_hash: input.version_hash ?? null,
    };
  }
}

/** Organization name for spoken copy, from whatever the bundle knows. */
function organizationName(bundle: CaseBundle | null): string {
  const org = bundle?.organization?.name?.trim();
  if (org) return org;
  const hospital = bundle?.hospital?.name?.trim();
  if (hospital) return hospital;
  return 'The organization';
}

async function safeBundle(caseId: Id): Promise<CaseBundle | null> {
  try {
    return await getXanoAdapter().getCase(caseId);
  } catch (error) {
    console.warn('[voice] GET /cases/{id} failed:', (error as Error).message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export const voiceToolHandlers: M1VoiceToolHandlers = {
  async create_case(args: CreateCaseToolInput): Promise<CreateCaseToolResult> {
    const xano = getXanoAdapter();
    // POST /cases (M1 widening). No organization, no bill: a case starts from
    // the caller's words. `hospital_name` is deliberately absent so the
    // endpoint never auto-attaches a default hospital.
    const request: CreateCaseM1Request = {
      situation_text: args.situation_text,
      patient_display_name: 'Caller',
      ...(args.caller_phone ? { caller_phone: args.caller_phone } : {}),
      ...(args.location ? { location: args.location } : {}),
    };
    const created = await xano.createCase(request as unknown as CreateCaseInput);
    // Keep the local safety net aware of the case even when Xano owns it.
    fixtures.adoptCase(created);
    if (isDemoMode()) {
      await xano.appendEvent(created.id, {
        actor: 'xano',
        event_type: 'case_created',
        message: 'Case created',
        metadata_json: { case_id: created.id },
      });
    }
    return { case_id: created.id, status: created.status, note: COPY.caseOpened };
  },

  async resolve_need(args: ResolveNeedToolInput): Promise<ResolveNeedToolResult> {
    const xano = getXanoAdapter();
    let resolution: NeedResolution;
    try {
      resolution = await resolveNeed({ situation_text: args.situation_text });
    } catch (error) {
      console.warn('[voice] resolveNeed failed:', (error as Error).message);
      resolution = {
        category: 'other',
        confidence: 0,
        clarifying_question: 'Could you tell me a little more about what you need help with?',
      };
    }
    if (!isNeedCategory(resolution.category)) resolution = { ...resolution, category: 'other' };

    // Persist what was understood (never the situation text in the feed).
    await updateCase(args.case_id, {
      need_category: resolution.category,
      situation_text: args.situation_text,
      ...(resolution.location ? { location: resolution.location } : {}),
    });
    await xano.appendEvent(args.case_id, {
      actor: 'voice_agent',
      event_type: 'need_resolved',
      message: `Need understood: ${NEED_CATEGORY_LABELS[resolution.category]}`,
      metadata_json: {
        category: resolution.category,
        confidence: resolution.confidence,
        organization_named: Boolean(resolution.organization),
      },
    });

    return {
      ...resolution,
      case_id: args.case_id,
      category_label: NEED_CATEGORY_LABELS[resolution.category],
    };
  },

  async discover_program(args: DiscoverProgramToolInput): Promise<DiscoverProgramToolResult> {
    const xano = getXanoAdapter();
    const resolution = await resolveProgram({
      category: args.category,
      organization: args.organization,
      location: args.location,
      case_id: args.case_id,
    });

    // The discovery module owns the organization-match invariant (it knows the
    // organization row). This guard only refuses an unverified or non-https
    // result, which must never be filled from.
    const program: ResolvedProgram | undefined = resolution.program;
    const verified =
      resolution.found &&
      program !== undefined &&
      program.verified === true &&
      /^https:\/\//i.test(program.application_url);

    if (!verified || !program) {
      const reason =
        resolution.reason ??
        `I could not verify an official form for ${args.organization ?? `that need in ${args.location}`}.`;
      return {
        found: false,
        organization: args.organization,
        reason,
        note: COPY.notFoundNote,
      };
    }

    const formKind = program.form_kind ?? 'fillable_pdf';
    let fieldCount = program.field_count ?? 0;

    if (formKind === 'fillable_pdf') {
      // Make sure the interview plan exists before the first question.
      let schema: FormSchemaField[] = [];
      try {
        schema = await understandForm({ program_id: program.id, pdf_url: program.application_url });
      } catch (error) {
        console.warn('[voice] understandForm failed, reading the stored schema:', (error as Error).message);
        schema = await loadFormSchema(program.id);
      }
      if (schema.length > 0) {
        fieldCount = fieldCount || schema.length;
        await xano.appendEvent(args.case_id, {
          actor: 'nutrient',
          event_type: 'form_extracted',
          message: 'Form structure extracted',
          metadata_json: {
            fields: fieldCount,
            questions: schema.filter((field) => field.required).length,
            sections: [...new Set(schema.map((field) => field.section ?? ''))].filter(Boolean),
          },
        });
      }
    }

    // Link the program to the case (the discovery module does this too when it
    // can; this is the belt to its braces and is harmless when redundant).
    await updateCase(args.case_id, {
      program_id: program.id,
      ...(program.organization_id ? { organization_id: program.organization_id } : {}),
      status: 'FORM_FOUND',
    });

    const bundle = await safeBundle(args.case_id);
    const organization =
      bundle?.organization?.name?.trim() || args.organization || organizationName(bundle);

    return {
      found: true,
      program_id: program.id,
      program_name: program.name,
      organization,
      form_kind: formKind,
      application_url: program.application_url,
      source_domain: program.source_domain,
      field_count: fieldCount,
      submission_instructions: program.submission_instructions ?? '',
      note: formKind === 'fillable_pdf' ? COPY.foundNote : COPY.foundNonPdfNote,
    };
  },

  async get_next_question(args: GetNextQuestionToolInput): Promise<GetNextQuestionToolResult> {
    let question: NextQuestion | null = null;
    let viaModule = false;
    try {
      question = await nextQuestion(args.case_id);
      viaModule = true;
    } catch (error) {
      console.warn('[voice] nextQuestion failed, reading Xano progress directly:', (error as Error).message);
    }
    if (viaModule && question) {
      return { done: false, question, progress: question.progress };
    }
    const loaded = await loadInterviewProgress(args.case_id);
    if (!loaded) {
      throw new Error('I could not reach the system of record to find the next question. Please try again.');
    }
    if (viaModule) {
      // The module said the interview is done; the progress comes from Xano.
      return { done: true, question: null, progress: loaded.progress };
    }
    return { done: loaded.done, question: loaded.question, progress: loaded.progress };
  },

  get_case_progress(args: GetNextQuestionToolInput): Promise<GetNextQuestionToolResult> {
    return voiceToolHandlers.get_next_question(args);
  },

  async save_answer(args: SaveAnswerM1ToolInput): Promise<SaveAnswerToolResult> {
    const xano = getXanoAdapter();
    const bundle = await safeBundle(args.case_id);
    const programId = bundle?.case.program_id || bundle?.program?.id || null;

    let field: FormSchemaField | null = null;
    if (programId) {
      const schema = await loadFormSchema(programId);
      field = findSchemaField(schema, args.field_id);
    }
    if (!field && isDemoMode()) {
      const legacy = resolveField(args.field_id);
      if (legacy) {
        field = interviewPlanAsFormSchema(programId ?? undefined).find((row) => row.field_id === legacy.fieldId) ?? null;
      }
    }
    if (!field) {
      throw new Error(
        programId
          ? 'That is not a question on this form. Call get_next_question and use the field_id it returns.'
          : 'No official form is linked to this case yet. Call discover_program first.',
      );
    }
    if (field.type === 'signature' || isForbiddenField(field)) {
      throw new Error('AccessForm never fills that field. Skip it and call get_next_question.');
    }

    const saveInput = { value: args.value, source: 'voice' as const, confirmed: true };
    const answer = await xano.saveAnswer(args.case_id, field.field_id, saveInput);
    fixtures.mirrorAnswer(args.case_id, field.field_id, saveInput);
    await xano.appendEvent(args.case_id, {
      actor: 'xano',
      event_type: 'answer_saved',
      message: `${sectionLabel(field.section)} answer saved`,
      metadata_json: {
        field_id: field.field_id,
        normalized_key: field.normalized_key,
        section: field.section ?? '',
      },
    });

    const next = await voiceToolHandlers.get_next_question({ case_id: args.case_id });
    return { saved: true, field_id: answer.field_id, value: answer.value_json, next };
  },

  async validate_case(args: ValidateCaseToolInput): Promise<ValidateCaseToolResult> {
    const xano = getXanoAdapter();
    const summary = await xano.validateCase(args.case_id);
    for (const requirement of summary.missingRequirements) {
      await xano.appendEvent(args.case_id, {
        actor: 'xano',
        event_type: 'missing_requirement_detected',
        message: `Still required: ${requirement.label}`,
        metadata_json: { key: requirement.key, type: requirement.type },
      });
    }
    const bundle = await safeBundle(args.case_id);
    return {
      appears_complete: summary.readyForReview,
      required_fields_complete: summary.requiredFieldsComplete,
      required_fields_total: summary.requiredFieldsTotal,
      still_required: summary.missingRequirements.map((req) => humanizeRequirementLabel(req.label)),
      basis: SAFE_COPY.completenessBasis,
      disclaimer: COPY.disclaimer(organizationName(bundle)),
    };
  },

  async finalize_document(args: FinalizeDocumentToolInput): Promise<FinalizeDocumentToolResult> {
    const xano = getXanoAdapter();
    const bundle = await xano.getCase(args.case_id);
    const program = bundle.program;
    const demo = isDemoMode();

    if (!demo && !program?.application_url) {
      throw new Error('No verified official form is linked to this case yet. Call discover_program first.');
    }
    const formKind = program?.form_kind ?? 'fillable_pdf';
    if (formKind !== 'fillable_pdf') {
      throw new Error(
        'This application is not a fillable PDF, so AccessForm cannot fill it yet. Tell the caller where the official form is instead.',
      );
    }
    const sourceUrl = program?.application_url ?? null;
    const nutrient = getNutrientAdapter();

    let finalized: FinalizedDocument | null = null;
    let unmapped: string[] = [];

    if (nutrient && program && sourceUrl) {
      // M1 path: schema + answers -> mapAnswers -> Instant JSON -> engine.
      let instantJson: InstantJson | null = null;
      try {
        // The interview uses Xano's asked-rows subset, but filling needs the
        // COMPLETE schema (comb boxes, followers) so names spread across
        // character boxes. understandForm is idempotent and cache-backed.
        let schema = await loadFormSchema(program.id);
        try {
          const full = await understandForm({ program_id: program.id, pdf_url: sourceUrl });
          if (full.length > schema.length) schema = full;
        } catch (error) {
          console.warn('[voice] full schema unavailable, mapping with the interview subset:', (error as Error).message);
        }
        if (schema.length > 0 && bundle.answers.length > 0) {
          const mapped = await mapAnswers({ schema, answers: bundle.answers });
          unmapped = mapped.unmapped;
          const allowed = new Set(schema.map((field) => field.pdf_field_name ?? field.field_id));
          const values = mapped.values.filter((value) => allowed.has(value.pdf_field_name) && value.value !== '');
          if (values.length > 0) {
            instantJson = {
              formFieldValues: values.map((value) => ({
                name: value.pdf_field_name,
                type: INSTANT_JSON_FIELD_TYPE,
                v: 1,
                value: value.value,
              })),
              format: INSTANT_JSON_FORMAT,
            };
          }
        }
      } catch (error) {
        console.warn('[voice] mapAnswers failed, using the adapter pipeline:', (error as Error).message);
      }

      if (instantJson) {
        const filled = await nutrient.fillForm({ pdfUrl: sourceUrl, instantJson });
        const tagged = await nutrient.autotag(filled.pdfBytes);
        const versionHash = sha256Hex(tagged.pdfBytes);
        const fileName = `case-${encodeURIComponent(args.case_id)}-${versionHash.slice(0, 12)}.pdf`;
        const writtenPath = await writeGeneratedFile(fileName, tagged.pdfBytes);
        const documentUrl = signedDocumentPath(args.case_id);
        const document = await xano.saveDocument(args.case_id, {
          type: 'filled_application',
          source_url: sourceUrl,
          generated_url: writtenPath ?? documentUrl,
          accessibility_status: tagged.accessibilityStatus,
          version_hash: versionHash,
        });
        // The live POST /cases/{id}/documents endpoint records one feed event
        // itself: `accessibility_processed` when the status is processed,
        // otherwise `document_generated`. Write only the one it did not.
        const xanoWritesDocumentEvent = Boolean(xanoBaseUrl()) && !demo;
        const status = tagged.accessibilityStatus;
        if (!xanoWritesDocumentEvent || status === 'processed') {
          await xano.appendEvent(args.case_id, {
            actor: 'nutrient',
            event_type: 'document_generated',
            message: 'Completed PDF generated',
            metadata_json: {
              fields_filled: instantJson.formFieldValues.length,
              unmapped: unmapped.length,
              bytes: tagged.byteLength,
            },
          });
        }
        if (!xanoWritesDocumentEvent || status !== 'processed') {
          const accessCopy = accessibilityEventFor(status);
          await xano.appendEvent(args.case_id, {
            actor: 'nutrient',
            event_type: accessCopy.event_type,
            message: accessCopy.message,
            metadata_json: { accessibility_status: status },
          });
        }
        finalized = {
          caseId: args.case_id,
          documentUrl,
          accessibilityStatus: tagged.accessibilityStatus,
          versionHash,
          fieldsFilled: instantJson.formFieldValues.length,
          document,
        };
      } else {
        // Pre-M1 adapter pipeline (the proven Cedars path). It writes its own
        // document_generated / accessibility events.
        finalized = await nutrient.finalizeDocument({ case_id: args.case_id, source_url: sourceUrl });
      }
    } else if (nutrient) {
      finalized = await nutrient.finalizeDocument({ case_id: args.case_id });
    } else if (demo) {
      const document = await saveFallbackDocument(args.case_id, sourceUrl);
      const fieldsFilled = fixtures.filledFieldCount(args.case_id);
      await xano.appendEvent(args.case_id, {
        actor: 'nutrient',
        event_type: 'document_generated',
        message: 'Completed PDF generated',
        metadata_json: { fields_filled: fieldsFilled, source: 'fixture' },
      });
      const copy = accessibilityEventFor(document.accessibility_status);
      await xano.appendEvent(args.case_id, {
        actor: 'nutrient',
        event_type: copy.event_type,
        message: copy.message,
        metadata_json: { accessibility_status: document.accessibility_status, source: 'fixture' },
      });
      finalized = {
        caseId: args.case_id,
        documentUrl: document.generated_url ?? DEMO_FILLED_PDF_PATH,
        accessibilityStatus: document.accessibility_status,
        versionHash: document.version_hash ?? 'fixture-v1',
        fieldsFilled,
        document,
      };
    } else {
      throw new Error('The document engine is not available right now. The answers are saved; try again shortly.');
    }

    const summary = await xano.validateCase(args.case_id);
    return {
      document_url: buildPublicDocumentUrl(args.case_id).url,
      fields_filled: finalized.fieldsFilled,
      accessibility_status: finalized.accessibilityStatus,
      still_required: summary.missingRequirements.map((req) => humanizeRequirementLabel(req.label)),
      note: COPY.notSubmitted,
    };
  },

  async send_summary(args: SendSummaryToolInput): Promise<SendSummaryToolResult> {
    const xano = getXanoAdapter();
    const bundle = await xano.getCase(args.case_id);
    const to = normalizePhone(args.to ?? bundle.case.caller_phone ?? '');
    if (!to) {
      throw new Error(
        "I don't have a number to text. Ask the caller which mobile number to use, then call send_summary with it.",
      );
    }

    const program = bundle.program;
    const formKind = program?.form_kind ?? 'fillable_pdf';
    const hasFilledDocument = bundle.documents.some((doc) => doc.type === 'filled_application');
    let documentUrl: string | null = null;
    if (formKind === 'fillable_pdf' && hasFilledDocument) {
      documentUrl = buildPublicDocumentUrl(args.case_id).url;
    } else if (formKind !== 'fillable_pdf' && program?.application_url) {
      documentUrl = program.application_url;
    }
    if (!documentUrl) {
      throw new Error('There is no filled form to send yet. Call finalize_document first.');
    }

    const summary = await xano.validateCase(args.case_id);
    const nextSteps = program?.submission_instructions?.trim() || COPY.genericNextSteps;

    const delivery = await sendSummary({
      case_id: args.case_id,
      to,
      document_url: documentUrl,
      missing: summary.missingRequirements,
      next_steps: nextSteps,
    });

    const masked = maskPhone(to);
    const status: DeliveryStatus = delivery.status;
    const note =
      status === 'sent'
        ? `Tell the caller a text is on its way to the number ending in ${masked.slice(-4)}. Do not say the application was sent anywhere.`
        : status === 'queued'
          ? `The text is queued for the number ending in ${masked.slice(-4)}. Say it should arrive shortly; do not say the application was sent anywhere.`
          : `I could not send the text${delivery.error ? ` (${delivery.error})` : ''}. Tell the caller plainly that no text was sent, and read them the review link: ${documentUrl}`;

    return { delivery_id: delivery.id, status, to_masked: masked, note };
  },
};

/* ------------------------------------------------------------------ */
/* Dispatch — argument coercion + speech-friendly results              */
/* ------------------------------------------------------------------ */

export function isVapiToolName(name: string): name is M1VoiceToolName {
  return (M1_VOICE_TOOL_NAMES as readonly string[]).includes(name);
}

export interface ToolRunResult {
  ok: boolean;
  /** Compact object handed back to the model — never the whole case bundle. */
  result: Record<string, unknown>;
}

function needCaseId(args: Record<string, unknown>, tool: string): string {
  const caseId = readString(args, 'case_id');
  if (!caseId) throw new Error(`${tool} needs case_id — the id returned by create_case.`);
  return caseId;
}

/**
 * Run one tool call from Vapi. Arguments arrive as loosely typed JSON, so each
 * branch validates before touching the system of record. Failures come back as
 * `ok: false` with a sentence the agent can say out loud, never as a throw —
 * a dropped tool call must not end the caller's call.
 *
 * `caller_phone` may be injected by the route from the Vapi call's customer
 * number; it is only ever used as a default for create_case / send_summary.
 */
export async function runVoiceTool(name: string, rawArgs: unknown): Promise<ToolRunResult> {
  const args = asRecord(rawArgs);
  try {
    if (!isVapiToolName(name)) {
      return { ok: false, result: { error: `Unknown tool "${name}".` } };
    }

    switch (name) {
      case 'create_case': {
        const situation = readString(args, 'situation_text');
        if (!situation) {
          return {
            ok: false,
            result: { error: 'I still need to hear what is going on before I can open a case. Ask the caller to describe their situation.' },
          };
        }
        const phone = readString(args, 'caller_phone');
        const created = await voiceToolHandlers.create_case({
          situation_text: situation,
          caller_phone: phone ? (normalizePhone(phone) ?? undefined) : undefined,
          location: readString(args, 'location') ?? undefined,
        });
        return { ok: true, result: { ...created } };
      }

      case 'resolve_need': {
        const caseId = needCaseId(args, 'resolve_need');
        const situation = readString(args, 'situation_text');
        if (!situation) {
          return { ok: false, result: { error: 'resolve_need needs situation_text — what the caller said.' } };
        }
        const resolved = await voiceToolHandlers.resolve_need({ case_id: caseId, situation_text: situation });
        // Below the floor the resolver is unsure about the NEED: ask and call
        // again. At or above it, a clarifying question is the resolver's own
        // wording for the one thing still missing (usually the location).
        const unsure = resolved.confidence < NEED_CONFIDENCE_FLOOR;
        const note = unsure
          ? COPY.clarifyNote
          : resolved.clarifying_question && !resolved.location
            ? `Need understood. Ask the caller: "${resolved.clarifying_question}" A city or ZIP is enough. ` +
              'Then call discover_program with this category, the organization they named (if any) and their answer as the location.'
            : COPY.resolvedNote;
        return { ok: true, result: { ...resolved, note } };
      }

      case 'discover_program': {
        const caseId = needCaseId(args, 'discover_program');
        const category = args.category;
        if (!isNeedCategory(category)) {
          return {
            ok: false,
            result: { error: 'discover_program needs the category returned by resolve_need. Call resolve_need first.' },
          };
        }
        const location = readString(args, 'location');
        if (!location) {
          return {
            ok: false,
            result: { error: 'I need to know where the caller is before I can look for the official form. Ask "where are you right now?" — a city or ZIP is enough.' },
          };
        }
        const discovered = await voiceToolHandlers.discover_program({
          case_id: caseId,
          category,
          organization: readString(args, 'organization') ?? undefined,
          location,
        });
        return { ok: true, result: { ...discovered } };
      }

      case 'get_next_question':
      case 'get_case_progress': {
        const caseId = needCaseId(args, name);
        const next = await voiceToolHandlers.get_next_question({ case_id: caseId });
        return { ok: true, result: { ...next } };
      }

      case 'save_answer': {
        const caseId = needCaseId(args, 'save_answer');
        const fieldId = readString(args, 'field_id');
        if (!fieldId) return { ok: false, result: { error: 'save_answer needs field_id — the id from get_next_question.' } };
        const rawValue = args.value;
        const value =
          rawValue === null || rawValue === undefined
            ? ''
            : typeof rawValue === 'object'
              ? JSON.stringify(rawValue)
              : typeof rawValue === 'boolean'
                ? rawValue ? 'Yes' : 'No'
                : String(rawValue);
        const saved = await voiceToolHandlers.save_answer({ case_id: caseId, field_id: fieldId, value });
        return { ok: true, result: { ...saved } };
      }

      case 'validate_case': {
        const caseId = needCaseId(args, 'validate_case');
        const summary = await voiceToolHandlers.validate_case({ case_id: caseId });
        return { ok: true, result: { ...summary } };
      }

      case 'finalize_document': {
        const caseId = needCaseId(args, 'finalize_document');
        const finalized = await voiceToolHandlers.finalize_document({ case_id: caseId });
        return { ok: true, result: { ...finalized } };
      }

      case 'send_summary': {
        const caseId = needCaseId(args, 'send_summary');
        const to = readString(args, 'to') ?? readString(args, 'caller_phone') ?? undefined;
        const sent = await voiceToolHandlers.send_summary({ case_id: caseId, channel: 'sms', to });
        return { ok: true, result: { ...sent } };
      }
    }
  } catch (error) {
    const message = (error as Error).message || 'The tool call did not complete.';
    console.warn(`[voice] tool ${name} failed:`, message);
    return { ok: false, result: { error: message } };
  }
}
