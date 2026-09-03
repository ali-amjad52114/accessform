/**
 * Xano adapter — the system of record.
 *
 * Xano is AUTHORITATIVE for completeness. `getCaseProgress()` and
 * `validateCase()` return whatever Xano computed; this adapter normalizes
 * shapes and coerces types but never recalculates percentages, requirement
 * statuses, or the next question.
 *
 * Every numeric primary key is stringified at this boundary — nothing
 * downstream may assume a number (see `Id` in the contract).
 *
 * Server-side only. If `XANO_BASE_URL` is absent, or any call fails, the
 * deterministic fixture store answers instead so the demo cannot break.
 */

import {
  ACCESSIBILITY_STATUSES,
  ANSWER_SOURCES,
  CASE_STATUSES,
  DOCUMENT_TYPES,
  EVENT_ACTORS,
  PROGRESS_STEP_IDS,
  PROGRESS_STEP_LABELS,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
  type AccessibilityStatus,
  type Answer,
  type AnswerSource,
  type AnswerValue,
  type Case,
  type CaseBundle,
  type CaseDocument,
  type CaseEvent,
  type CaseProgress,
  type CaseStatus,
  type CompletenessSummary,
  type CreateCaseInput,
  type DiscoveryResult,
  type DocumentType,
  type EventActor,
  type FormFieldType,
  type FormSchemaField,
  type Hospital,
  type Id,
  type NewCaseEvent,
  type Program,
  type ProgressState,
  type ProgressStep,
  type ProgressStepId,
  type Requirement,
  type RequirementStatus,
  type RequirementType,
  type SaveAnswerInput,
  type SaveDocumentInput,
  type XanoAdapter,
} from '../contract';
import { fixtureXanoAdapter } from '../fixtures/xano';
import { xanoCredentials, type XanoCredentials } from './env';
import { withFallback } from './errors';
import { requestJson } from './http';

/* ------------------------------------------------------------------ */
/* Coercion helpers                                                    */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return typeof value === 'object' && value !== null ? (value as Raw) : {};
}

/** Xano ids arrive as numbers; the contract says every id is a string. */
function asId(value: unknown, fallback = ''): Id {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function asNullableId(value: unknown): Id | null {
  const id = asId(value, '');
  return id === '' ? null : id;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return asString(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
  }
  return fallback;
}

/** Xano timestamps may be epoch millis or an ISO string. */
function asTimestamp(value: unknown, fallback?: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return fallback ?? new Date().toISOString();
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const text = typeof value === 'string' ? value : '';
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

/** `value_json` / `metadata_json` may come back as a JSON string. */
function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asAnswerValue(value: unknown): AnswerValue {
  const parsed = parseJsonish(value);
  if (parsed === null || parsed === undefined) return null;
  if (
    typeof parsed === 'string' ||
    typeof parsed === 'number' ||
    typeof parsed === 'boolean'
  ) {
    return parsed;
  }
  return JSON.stringify(parsed);
}

function asMetadata(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonish(value);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const FORM_FIELD_TYPES: readonly FormFieldType[] = [
  'text',
  'number',
  'currency',
  'date',
  'choice',
  'checkbox',
  'radio',
  'signature',
];

const PROGRESS_STATES: readonly ProgressState[] = ['done', 'active', 'todo'];

/* ------------------------------------------------------------------ */
/* Row normalizers                                                     */
/* ------------------------------------------------------------------ */

export function normalizeHospital(raw: unknown): Hospital {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    name: asString(row.name),
    website: asString(row.website),
    hcai_id: asString(row.hcai_id),
  };
}

export function normalizeProgram(raw: unknown): Program {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    hospital_id: asId(row.hospital_id),
    name: asString(row.name),
    policy_url: asString(row.policy_url),
    application_url: asString(row.application_url),
    source_domain: asString(row.source_domain),
    effective_date: asNullableString(row.effective_date),
    retrieved_at: asTimestamp(row.retrieved_at),
    verified: asBoolean(row.verified),
  };
}

export function normalizeCase(raw: unknown): Case {
  const row = asRecord(raw);
  const created = asTimestamp(row.created_at);
  return {
    id: asId(row.id),
    patient_display_name: asString(row.patient_display_name),
    hospital_id: asId(row.hospital_id),
    program_id: asNullableId(row.program_id),
    bill_amount: asNumber(row.bill_amount),
    status: asEnum<CaseStatus>(row.status, CASE_STATUSES, 'CREATED'),
    progress_percent: Math.max(0, Math.min(100, asNumber(row.progress_percent))),
    created_at: created,
    updated_at: asTimestamp(row.updated_at, created),
  };
}

export function normalizeAnswer(raw: unknown, caseId: Id = ''): Answer {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    case_id: asId(row.case_id, caseId),
    field_id: asString(row.field_id),
    value_json: asAnswerValue(row.value_json ?? row.value),
    source: asEnum<AnswerSource>(row.source, ANSWER_SOURCES, 'voice'),
    confirmed: asBoolean(row.confirmed, true),
    updated_at: asTimestamp(row.updated_at),
  };
}

export function normalizeRequirement(raw: unknown, caseId: Id = ''): Requirement {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    case_id: asId(row.case_id, caseId),
    key: asString(row.key),
    label: asString(row.label),
    type: asEnum<RequirementType>(row.type, REQUIREMENT_TYPES, 'field'),
    status: asEnum<RequirementStatus>(row.status, REQUIREMENT_STATUSES, 'missing'),
    evidence_url: asNullableString(row.evidence_url),
  };
}

export function normalizeDocument(raw: unknown, caseId: Id = ''): CaseDocument {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    case_id: asId(row.case_id, caseId),
    type: asEnum<DocumentType>(row.type, DOCUMENT_TYPES, 'supporting_document'),
    source_url: asNullableString(row.source_url),
    generated_url: asNullableString(row.generated_url),
    accessibility_status: asEnum<AccessibilityStatus>(
      row.accessibility_status,
      ACCESSIBILITY_STATUSES,
      'pending',
    ),
    version_hash: asNullableString(row.version_hash),
  };
}

export function normalizeEvent(raw: unknown, caseId: Id = ''): CaseEvent {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    case_id: asId(row.case_id, caseId),
    timestamp: asTimestamp(row.timestamp ?? row.created_at),
    actor: asEnum<EventActor>(row.actor, EVENT_ACTORS, 'xano'),
    event_type: asString(row.event_type),
    message: asString(row.message),
    metadata_json: asMetadata(row.metadata_json ?? row.metadata),
  };
}

export function normalizeFormSchemaField(raw: unknown): FormSchemaField {
  const row = asRecord(raw);
  const fieldId = asString(row.field_id);
  return {
    id: asId(row.id),
    program_id: asId(row.program_id),
    field_id: fieldId,
    label: asString(row.label, fieldId),
    normalized_key: asString(row.normalized_key),
    type: asEnum<FormFieldType>(row.type, FORM_FIELD_TYPES, 'text'),
    required: asBoolean(row.required, true),
    conversational_prompt: asString(row.conversational_prompt),
    dependency_rule: asNullableString(row.dependency_rule),
    pdf_mapping: asString(row.pdf_mapping, fieldId),
  };
}

export function normalizeBundle(raw: unknown, caseId: Id): CaseBundle {
  const row = asRecord(raw);
  // Xano may return the case row at the top level or nested under `case`.
  const caseRaw = row.case !== undefined ? row.case : row;
  const normalizedCase = normalizeCase(caseRaw);
  const id = normalizedCase.id || caseId;

  return {
    case: { ...normalizedCase, id },
    hospital: normalizeHospital(row.hospital),
    program: row.program ? normalizeProgram(row.program) : null,
    answers: asArray(row.answers).map((entry) => normalizeAnswer(entry, id)),
    requirements: asArray(row.requirements).map((entry) =>
      normalizeRequirement(entry, id),
    ),
    documents: asArray(row.documents).map((entry) => normalizeDocument(entry, id)),
    events: asArray(row.events).map((entry) => normalizeEvent(entry, id)),
  };
}

/** Always 8 steps, in canonical order, whatever Xano returned. */
export function normalizeProgress(raw: unknown, caseId: Id): CaseProgress {
  const row = asRecord(raw);
  const byId = new Map<ProgressStepId, ProgressState>();
  for (const entry of asArray(row.steps)) {
    const step = asRecord(entry);
    const id = asString(step.id) as ProgressStepId;
    if (!(PROGRESS_STEP_IDS as readonly string[]).includes(id)) continue;
    byId.set(id, asEnum<ProgressState>(step.state, PROGRESS_STATES, 'todo'));
  }

  const steps: ProgressStep[] = PROGRESS_STEP_IDS.map((id) => ({
    id,
    label: PROGRESS_STEP_LABELS[id],
    state: byId.get(id) ?? 'todo',
  }));

  return {
    caseId: asId(row.caseId ?? row.case_id, caseId),
    status: asEnum<CaseStatus>(row.status, CASE_STATUSES, 'CREATED'),
    percent: Math.max(0, Math.min(100, asNumber(row.percent ?? row.progress_percent))),
    steps,
    answersSaved: asNumber(row.answersSaved ?? row.answers_saved),
    answersExpected: asNumber(row.answersExpected ?? row.answers_expected),
    nextFieldId: asNullableString(row.nextFieldId ?? row.next_field_id),
    nextPrompt: asNullableString(row.nextPrompt ?? row.next_prompt),
  };
}

export function normalizeCompleteness(raw: unknown, caseId: Id): CompletenessSummary {
  const row = asRecord(raw);
  const missing = asArray(row.missingRequirements ?? row.missing_requirements).map(
    (entry) => normalizeRequirement(entry, caseId),
  );
  return {
    percent: Math.max(0, Math.min(100, asNumber(row.percent))),
    requiredFieldsComplete: asNumber(
      row.requiredFieldsComplete ?? row.required_fields_complete,
    ),
    requiredFieldsTotal: asNumber(row.requiredFieldsTotal ?? row.required_fields_total),
    missingRequirements: missing.filter(
      (requirement) => requirement.status === 'missing',
    ),
    readyForReview: asBoolean(row.readyForReview ?? row.ready_for_review),
  };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class LiveXanoAdapter implements XanoAdapter {
  private readonly credentials: XanoCredentials;
  private readonly fallback: XanoAdapter;

  constructor(credentials: XanoCredentials, fallback: XanoAdapter = fixtureXanoAdapter) {
    this.credentials = credentials;
    this.fallback = fallback;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.credentials.apiKey) {
      headers.Authorization = `Bearer ${this.credentials.apiKey}`;
    }
    return headers;
  }

  private url(path: string): string {
    return `${this.credentials.baseUrl}${path}`;
  }

  private async call<T>(
    operation: string,
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<T> {
    return requestJson<T>('xano', operation, this.url(path), {
      method: init.method ?? 'GET',
      json: init.json,
      headers: this.headers(),
    });
  }

  async createCase(input: CreateCaseInput): Promise<Case> {
    return withFallback(
      'xano',
      'createCase',
      async () => {
        const raw = await this.call<unknown>('createCase', '/cases', {
          method: 'POST',
          json: input,
        });
        return normalizeCase(asRecord(raw).case ?? raw);
      },
      () => this.fallback.createCase(input),
    );
  }

  async getCase(caseId: Id): Promise<CaseBundle> {
    return withFallback(
      'xano',
      'getCase',
      async () => {
        const raw = await this.call<unknown>(
          'getCase',
          `/cases/${encodeURIComponent(caseId)}`,
        );
        return normalizeBundle(raw, caseId);
      },
      () => this.fallback.getCase(caseId),
    );
  }

  async appendEvent(caseId: Id, event: NewCaseEvent): Promise<CaseEvent> {
    return withFallback(
      'xano',
      'appendEvent',
      async () => {
        const raw = await this.call<unknown>(
          'appendEvent',
          `/cases/${encodeURIComponent(caseId)}/events`,
          {
            method: 'POST',
            json: {
              actor: event.actor,
              event_type: event.event_type,
              message: event.message,
              metadata_json: event.metadata_json ?? null,
              timestamp: event.timestamp ?? new Date().toISOString(),
            },
          },
        );
        return normalizeEvent(asRecord(raw).event ?? raw, caseId);
      },
      () => this.fallback.appendEvent(caseId, event),
    );
  }

  async saveAnswer(
    caseId: Id,
    fieldId: string,
    input: SaveAnswerInput,
  ): Promise<Answer> {
    return withFallback(
      'xano',
      'saveAnswer',
      async () => {
        // Field ids are raw AcroForm names — spaces, colons, parentheses.
        const path =
          `/cases/${encodeURIComponent(caseId)}` +
          `/answers/${encodeURIComponent(fieldId)}`;
        const raw = await this.call<unknown>('saveAnswer', path, {
          method: 'PUT',
          json: {
            value: input.value,
            value_json: input.value,
            source: input.source,
            confirmed: input.confirmed ?? true,
          },
        });
        return normalizeAnswer(asRecord(raw).answer ?? raw, caseId);
      },
      () => this.fallback.saveAnswer(caseId, fieldId, input),
    );
  }

  async getCaseProgress(caseId: Id): Promise<CaseProgress> {
    return withFallback(
      'xano',
      'getCaseProgress',
      async () => {
        const raw = await this.call<unknown>(
          'getCaseProgress',
          `/cases/${encodeURIComponent(caseId)}/progress`,
        );
        return normalizeProgress(raw, caseId);
      },
      () => this.fallback.getCaseProgress(caseId),
    );
  }

  async validateCase(caseId: Id): Promise<CompletenessSummary> {
    return withFallback(
      'xano',
      'validateCase',
      async () => {
        const raw = await this.call<unknown>(
          'validateCase',
          `/cases/${encodeURIComponent(caseId)}/validate`,
          { method: 'POST', json: {} },
        );
        return normalizeCompleteness(raw, caseId);
      },
      () => this.fallback.validateCase(caseId),
    );
  }

  async saveDiscoveredProgram(result: DiscoveryResult): Promise<Program> {
    return withFallback(
      'xano',
      'saveDiscoveredProgram',
      async () => {
        const primary = result.verified_sources[0];
        const raw = await this.call<unknown>(
          'saveDiscoveredProgram',
          '/programs/discovered',
          {
            method: 'POST',
            json: {
              hospital: result.hospital,
              intent: result.intent,
              name: primary?.title ?? 'Financial Assistance Application',
              policy_url: result.policy_url,
              application_url: result.application_url,
              source_domain: primary?.source_domain ?? '',
              retrieved_at: result.retrieved_at,
              verified: result.verified_sources.length > 0,
              verified_sources: result.verified_sources,
            },
          },
        );
        return normalizeProgram(asRecord(raw).program ?? raw);
      },
      () => this.fallback.saveDiscoveredProgram(result),
    );
  }

  async getFormSchema(programId: Id): Promise<FormSchemaField[]> {
    return withFallback(
      'xano',
      'getFormSchema',
      async () => {
        const raw = await this.call<unknown>(
          'getFormSchema',
          `/programs/${encodeURIComponent(programId)}/form_schema`,
        );
        const rows = Array.isArray(raw) ? raw : asArray(asRecord(raw).form_schema);
        if (rows.length === 0) {
          throw new Error('form schema was empty');
        }
        return rows.map(normalizeFormSchemaField);
      },
      () => this.fallback.getFormSchema(programId),
    );
  }

  async saveDocument(caseId: Id, input: SaveDocumentInput): Promise<CaseDocument> {
    return withFallback(
      'xano',
      'saveDocument',
      async () => {
        const raw = await this.call<unknown>(
          'saveDocument',
          `/cases/${encodeURIComponent(caseId)}/documents`,
          { method: 'POST', json: input },
        );
        return normalizeDocument(asRecord(raw).document ?? raw, caseId);
      },
      () => this.fallback.saveDocument(caseId, input),
    );
  }
}

/**
 * Live Xano client when `XANO_BASE_URL` is set, otherwise the fixture store.
 * Never throws for missing configuration.
 */
export function createXanoAdapter(): XanoAdapter {
  const credentials = xanoCredentials();
  if (!credentials) return fixtureXanoAdapter;
  return new LiveXanoAdapter(credentials);
}
