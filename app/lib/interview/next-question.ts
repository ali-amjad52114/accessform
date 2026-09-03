/**
 * Next question — lib/interview/next-question.ts (M1_MODULES.nextQuestion).
 *
 * `nextQuestion(case_id)` is thin over Xano `GET /cases/{id}/next_question`:
 * Xano orders by section then `order`, skips answered and non-required
 * fields, evaluates `dependency_rule`, and reports progress. Nothing here
 * recomputes completeness for a live case.
 *
 * `computeNextQuestion(schema, answers)` is the same walk in memory. It is
 * used (a) by the demo-mode fallback against the fixture store, (b) by the
 * live fallback when the Xano endpoint is not deployed yet — in that case
 * the ordering is local but `percent` is still Xano's number from
 * `GET /cases/{id}/progress` — and (c) by tests.
 *
 * SERVER-SIDE ONLY.
 */

import { isDemoMode, xanoCredentials } from '../adapters/env';
import {
  type Answer,
  type FormSchemaField,
  type Id,
  type InterviewProgress,
  type InterviewSection,
  type NextQuestion,
  type NextQuestionResponse,
  type ProgressState,
} from '../contract';
import { fixtureXanoAdapter } from '../fixtures/xano';
import { isForbiddenField, parseDependencyRule } from '../forms/understand-form';
import { interviewPlanAsFormSchema } from '../voice/form-plan';

/* ------------------------------------------------------------------ */
/* In-memory walk                                                      */
/* ------------------------------------------------------------------ */

/** Labels for the five legacy Cedars groups; everything else is Title-cased. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  personal_information: 'Personal information',
  household_information: 'Household',
  insurance_information: 'Insurance',
  income_information: 'Income',
  monthly_expenses: 'Monthly expenses',
};

export function sectionLabel(key: string): string {
  return (
    SECTION_LABELS[key] ??
    key
      .split('_')
      .filter(Boolean)
      .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ')
  );
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === '';
}

/** Comparison key for export values: "Yes_2" ~ "yes". */
function loose(text: string): string {
  return text.trim().replace(/^\//, '').replace(/[_ ]\d{1,2}$/, '').toLowerCase();
}

export interface ComputedNextQuestion {
  done: boolean;
  question: NextQuestion | null;
  progress: InterviewProgress;
}

export interface ComputeOptions {
  /** Xano's percent for the case, when known. Without it percent = answered/total (fields only). */
  percent?: number;
}

/**
 * The walk Xano performs, in memory. Candidates = required rows with a
 * prompt (forbidden identifiers and signatures never), ordered by section
 * (first appearance) then `order`; a row whose dependency_rule evaluates
 * false against the saved answers is neither asked nor counted.
 */
export function computeNextQuestion(
  schema: readonly FormSchemaField[],
  answers: readonly Answer[],
  options: ComputeOptions = {},
): ComputedNextQuestion {
  const answeredByFieldId = new Map<string, Answer>();
  const answeredByKey = new Map<string, Answer>();
  for (const answer of answers) {
    if (isBlank(answer.value_json)) continue;
    answeredByFieldId.set(answer.field_id, answer);
  }
  for (const row of schema) {
    const answer = answeredByFieldId.get(row.field_id);
    if (answer && row.normalized_key) answeredByKey.set(row.normalized_key, answer);
  }
  // Answers may also have been saved under the normalized key.
  for (const answer of answers) {
    if (isBlank(answer.value_json)) continue;
    if (!answeredByKey.has(answer.field_id) && schema.some((row) => row.normalized_key === answer.field_id)) {
      answeredByKey.set(answer.field_id, answer);
    }
  }
  const isAnswered = (row: FormSchemaField): boolean =>
    answeredByFieldId.has(row.field_id) || (row.normalized_key !== '' && answeredByKey.has(row.normalized_key));

  const dependencyHolds = (row: FormSchemaField): boolean => {
    const rule = parseDependencyRule(row.dependency_rule);
    if (!rule) return true; // no rule, or unparsable -> ask
    const answer = answeredByKey.get(rule.key);
    if (!answer) return false; // the gate question is unanswered -> not yet
    return loose(String(answer.value_json)) === loose(rule.value);
  };

  const ordered = schema
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        row.required &&
        row.type !== 'signature' &&
        row.conversational_prompt.trim() !== '' &&
        !isForbiddenField(row.field_id, row.label),
    );
  const sectionFirst = new Map<string, number>();
  ordered.forEach(({ row, index }) => {
    const key = row.section ?? 'general';
    if (!sectionFirst.has(key)) sectionFirst.set(key, index);
  });
  ordered.sort(
    (a, b) =>
      (sectionFirst.get(a.row.section ?? 'general') ?? 0) - (sectionFirst.get(b.row.section ?? 'general') ?? 0) ||
      (a.row.order ?? a.index + 1) - (b.row.order ?? b.index + 1) ||
      a.index - b.index,
  );

  const candidates = ordered.map(({ row }) => row).filter(dependencyHolds);

  const sections: InterviewSection[] = [];
  for (const row of candidates) {
    const key = row.section ?? 'general';
    let section = sections.find((s) => s.key === key);
    if (!section) {
      section = { key, label: sectionLabel(key), order: sections.length + 1, field_count: 0, answered_count: 0, state: 'todo' };
      sections.push(section);
    }
    section.field_count += 1;
    if (isAnswered(row)) section.answered_count += 1;
  }
  let activeSeen = false;
  for (const section of sections) {
    let state: ProgressState = 'todo';
    if (section.answered_count >= section.field_count) state = 'done';
    else if (!activeSeen) {
      state = 'active';
      activeSeen = true;
    }
    section.state = state;
  }

  const next = candidates.find((row) => !isAnswered(row)) ?? null;
  const answered = candidates.filter(isAnswered).length;
  const total = candidates.length;
  const sectionIndex = next ? sections.findIndex((s) => s.key === (next.section ?? 'general')) : sections.length;
  const progress: InterviewProgress = {
    answered,
    total,
    percent:
      typeof options.percent === 'number'
        ? Math.max(0, Math.min(100, Math.round(options.percent)))
        : total === 0
          ? 0
          : Math.round((answered / total) * 100),
    section_index: sectionIndex < 0 ? sections.length : sectionIndex,
    section_count: sections.length,
    sections,
  };

  if (!next) return { done: true, question: null, progress };
  const why = (next as { why?: unknown }).why;
  return {
    done: false,
    question: {
      field_id: next.field_id,
      prompt: next.conversational_prompt,
      section: next.section ?? 'general',
      progress,
      type: next.type,
      options: (next.options ?? []).slice(),
      required: true,
      why: typeof why === 'string' && why !== '' ? why : undefined,
    },
    progress,
  };
}

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

async function getJson(url: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function normalizeProgress(raw: unknown): InterviewProgress {
  const row = asRecord(raw);
  const sections = Array.isArray(row.sections)
    ? row.sections.map((entry): InterviewSection => {
        const s = asRecord(entry);
        const state = s.state === 'done' || s.state === 'active' ? s.state : 'todo';
        return {
          key: String(s.key ?? ''),
          label: String(s.label ?? sectionLabel(String(s.key ?? ''))),
          order: Number(s.order ?? 0),
          field_count: Number(s.field_count ?? 0),
          answered_count: Number(s.answered_count ?? 0),
          state,
        };
      })
    : [];
  return {
    answered: Number(row.answered ?? 0),
    total: Number(row.total ?? 0),
    percent: Math.max(0, Math.min(100, Number(row.percent ?? 0))),
    section_index: Number(row.section_index ?? 0),
    section_count: Number(row.section_count ?? sections.length),
    sections,
  };
}

function normalizeQuestion(raw: unknown, progress: InterviewProgress): NextQuestion | null {
  const q = asRecord(raw);
  const fieldId = typeof q.field_id === 'string' ? q.field_id : '';
  if (!fieldId) return null;
  const options = Array.isArray(q.options) ? q.options.map(String) : undefined;
  return {
    field_id: fieldId,
    prompt: typeof q.prompt === 'string' ? q.prompt : '',
    section: typeof q.section === 'string' ? q.section : 'general',
    progress,
    type: typeof q.type === 'string' ? (q.type as NextQuestion['type']) : undefined,
    options,
    required: q.required === undefined ? true : Boolean(q.required),
    why: typeof q.why === 'string' && q.why !== '' ? q.why : undefined,
  };
}

/** Parse Xano's NextQuestionResponse. */
export function normalizeNextQuestionResponse(raw: unknown): NextQuestionResponse {
  const row = asRecord(raw);
  const progress = normalizeProgress(row.progress);
  const question = row.done === true ? null : normalizeQuestion(row.question, progress);
  return {
    case_id: String(row.case_id ?? ''),
    status: (typeof row.status === 'string' ? row.status : 'CREATED') as NextQuestionResponse['status'],
    done: row.done === true || question === null,
    question,
    progress,
  };
}

/**
 * Live fallback when GET /cases/{id}/next_question is not deployed (404):
 * the case bundle + the program's schema + Xano's own percent from
 * /progress, walked locally. Every input is live data — no fixture.
 */
async function computeFromLiveBundle(baseUrl: string, caseId: Id): Promise<ComputedNextQuestion> {
  const id = encodeURIComponent(caseId);
  const bundle = await getJson(`${baseUrl}/cases/${id}`);
  if (bundle.status !== 200) throw new Error(`GET /cases/${caseId} -> HTTP ${bundle.status}`);
  const root = asRecord(bundle.json);
  const caseRow = asRecord(root.case ?? root);
  const programId = caseRow.program_id ?? asRecord(root.program).id;
  if (programId === undefined || programId === null || programId === '' || programId === 0) {
    throw new Error(`case ${caseId} has no program linked yet`);
  }
  const answers: Answer[] = (Array.isArray(root.answers) ? root.answers : []).map((entry) => {
    const a = asRecord(entry);
    return {
      id: String(a.id ?? ''),
      case_id: caseId,
      field_id: String(a.field_id ?? ''),
      value_json: (a.value_json ?? a.value ?? null) as Answer['value_json'],
      source: 'voice',
      confirmed: true,
      updated_at: new Date(Number(a.updated_at) || Date.now()).toISOString(),
    };
  });

  let schema: FormSchemaField[] = [];
  for (const suffix of ['form_schema', 'fields']) {
    const result = await getJson(`${baseUrl}/programs/${encodeURIComponent(String(programId))}/${suffix}`);
    if (result.status !== 200) continue;
    const rows = Array.isArray(result.json) ? result.json : asRecord(result.json).fields;
    if (!Array.isArray(rows)) continue;
    schema = rows.map((entry) => {
      const r = asRecord(entry);
      const fieldId = String(r.field_id ?? '');
      return {
        id: String(r.id ?? ''),
        program_id: String(programId),
        field_id: fieldId,
        label: String(r.label ?? fieldId),
        normalized_key: String(r.normalized_key ?? ''),
        type: (typeof r.type === 'string' ? r.type : 'text') as FormSchemaField['type'],
        required: r.required === true,
        conversational_prompt: String(r.conversational_prompt ?? ''),
        dependency_rule: typeof r.dependency_rule === 'string' && r.dependency_rule !== '' ? r.dependency_rule : null,
        pdf_mapping: String(r.pdf_mapping ?? fieldId),
        section: String(r.section || r.group_key || 'general'),
        order: Number(r.order ?? 0),
        options: Array.isArray(r.options) ? r.options.map(String) : [],
        pdf_field_name: String(r.pdf_field_name || fieldId),
      };
    });
    break;
  }
  if (schema.length === 0) throw new Error(`program ${String(programId)} has no form_schema rows`);

  let percent: number | undefined;
  const progress = await getJson(`${baseUrl}/cases/${id}/progress`);
  if (progress.status === 200) {
    const p = asRecord(progress.json);
    const value = Number(p.percent ?? p.progress_percent);
    if (Number.isFinite(value)) percent = value;
  }
  return computeNextQuestion(schema, answers, { percent });
}

/**
 * Full result (done + question + progress) for a case. Live: Xano's
 * endpoint, or the live-bundle fallback when it is not deployed. Demo mode:
 * the fixture store walked against the Cedars plan. Throws when nothing
 * live can be reached outside demo mode.
 */
export async function nextQuestionDetailed(caseId: Id): Promise<ComputedNextQuestion> {
  const credentials = xanoCredentials();
  if (credentials && !isDemoMode()) {
    const result = await getJson(`${credentials.baseUrl}/cases/${encodeURIComponent(caseId)}/next_question`);
    if (result.status === 200) {
      const parsed = normalizeNextQuestionResponse(result.json);
      return { done: parsed.done, question: parsed.question, progress: parsed.progress };
    }
    if (result.status !== 404) {
      throw new Error(`GET /cases/${caseId}/next_question -> HTTP ${result.status}`);
    }
    console.warn('[interview] GET /cases/{id}/next_question is not deployed; walking the live bundle locally (percent is still Xano\'s).');
    return computeFromLiveBundle(credentials.baseUrl, caseId);
  }
  if (!isDemoMode()) {
    throw new Error('XANO_BASE_URL is not set; the next question comes from the system of record.');
  }
  const bundle = await fixtureXanoAdapter.getCase(caseId);
  const schema = interviewPlanAsFormSchema(bundle.program?.id ?? bundle.case.program_id ?? undefined);
  return computeNextQuestion(schema, bundle.answers, { percent: bundle.case.progress_percent });
}

/** M1_MODULES.nextQuestion: the next question, or null when the interview is done. */
export async function nextQuestion(caseId: Id): Promise<NextQuestion | null> {
  const result = await nextQuestionDetailed(caseId);
  return result.done ? null : result.question;
}
