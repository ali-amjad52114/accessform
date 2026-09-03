/**
 * Xano adapter — the system of record.
 *
 * Xano is AUTHORITATIVE for completeness. `getCaseProgress()`,
 * `validateCase()` and `getNextQuestion()` return whatever Xano computed;
 * this adapter normalizes shapes and coerces types but never recalculates
 * percentages, sections, requirement statuses, or the next question.
 *
 * Every numeric primary key is stringified at this boundary — nothing
 * downstream may assume a number (see `Id` in the contract). Optional foreign
 * keys come back from Xano as `0`, never `null`; they are normalized to
 * `null` (nullable ids) or `""` (`hospital_id`).
 *
 * Server-side only. The pre-M1 methods keep their fixture fallback (the demo
 * must never break). The M1 methods (`XanoM1Adapter`) have NO fallback: a
 * failing service surfaces as a thrown `AdapterError`, never as Jane's data,
 * per docs/M1_CONTRACT.md §0.5.
 */

import {
  ACCESSIBILITY_STATUSES,
  ANSWER_SOURCES,
  CASE_DELIVERY_STATUSES,
  CASE_STATUSES,
  DELIVERY_CHANNELS,
  DELIVERY_STATUSES,
  DOCUMENT_TYPES,
  EVENT_ACTORS,
  FORM_KINDS,
  NEED_CATEGORIES,
  ORGANIZATION_KINDS,
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
  type CaseDeliveryStatus,
  type CaseDocument,
  type CaseEvent,
  type CaseProgress,
  type CaseStatus,
  type CompletenessSummary,
  type CreateCaseInput,
  type CreateCaseM1Request,
  type CreateDeliveryRequest,
  type Delivery,
  type DeliveryChannel,
  type DeliveryStatus,
  type DiscoveryResult,
  type DocumentType,
  type EventActor,
  type FormFieldType,
  type FormKind,
  type FormSchemaField,
  type GetFormSchemaResponse,
  type Hospital,
  type Id,
  type InterviewProgress,
  type InterviewSection,
  type M1FormSchemaField,
  type NeedCategory,
  type NewCaseEvent,
  type NextQuestion,
  type NextQuestionResponse,
  type Organization,
  type OrganizationKind,
  type Program,
  type ProgressState,
  type ProgressStep,
  type ProgressStepId,
  type ReplaceFormSchemaRequest,
  type ReplaceFormSchemaResponse,
  type ResolvedProgram,
  type ResolveProgramQuery,
  type ResolveProgramResponse,
  type Requirement,
  type RequirementStatus,
  type RequirementType,
  type SaveAnswerInput,
  type SaveDocumentInput,
  type UpsertCatalogProgramRequest,
  type UpsertOrganizationRequest,
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

/** Optional FK: Xano returns 0 for "none"; the contract wants null. */
function asNullableId(value: unknown): Id | null {
  if (value === 0 || value === '0') return null;
  const id = asId(value, '');
  return id === '' ? null : id;
}

/** Optional FK on a non-nullable field (`hospital_id`): 0/null -> "" (absent). */
function asFkId(value: unknown): Id {
  return asNullableId(value) ?? '';
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

/** `options` is a json column: an array of export values, or null for old rows. */
function asStringArray(value: unknown): string[] {
  return asArray(parseJsonish(value))
    .map((entry) => asString(entry))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith('/') ? entry.slice(1) : entry));
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

export function normalizeOrganization(raw: unknown): Organization {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    name: asString(row.name),
    kind: asEnum<OrganizationKind>(row.kind, ORGANIZATION_KINDS, 'other'),
    domain: asString(row.domain),
    region: asString(row.region),
    website: asString(row.website),
    created_at: asTimestamp(row.created_at),
  };
}

/**
 * A `programs` row. The M1 columns exist on every live row (Xano returns
 * "" / 0 / null, never undefined), so the result always satisfies
 * `ResolvedProgram`; use `normalizeResolvedProgram` when you need that type.
 */
export function normalizeProgram(raw: unknown): Program {
  return normalizeResolvedProgram(raw);
}

export function normalizeResolvedProgram(raw: unknown): ResolvedProgram {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    hospital_id: asFkId(row.hospital_id),
    name: asString(row.name),
    policy_url: asString(row.policy_url),
    application_url: asString(row.application_url),
    source_domain: asString(row.source_domain),
    effective_date: asNullableString(row.effective_date),
    retrieved_at: asTimestamp(row.retrieved_at),
    verified: asBoolean(row.verified),
    category: asEnum<NeedCategory>(row.category, NEED_CATEGORIES, 'other'),
    form_kind: asEnum<FormKind>(row.form_kind, FORM_KINDS, 'fillable_pdf'),
    organization_id: asNullableId(row.organization_id),
    submission_instructions: asString(row.submission_instructions),
    field_count: Math.max(0, Math.round(asNumber(row.field_count))),
    region: asString(row.region),
    page_count: Math.max(0, Math.round(asNumber(row.page_count))),
    sha256: asString(row.sha256),
  };
}

export function normalizeCase(raw: unknown): Case {
  const row = asRecord(raw);
  const created = asTimestamp(row.created_at);
  return {
    id: asId(row.id),
    patient_display_name: asString(row.patient_display_name),
    hospital_id: asFkId(row.hospital_id),
    program_id: asNullableId(row.program_id),
    bill_amount: asNumber(row.bill_amount),
    status: asEnum<CaseStatus>(row.status, CASE_STATUSES, 'CREATED'),
    progress_percent: Math.max(0, Math.min(100, asNumber(row.progress_percent))),
    created_at: created,
    updated_at: asTimestamp(row.updated_at, created),
    need_category: asEnum<NeedCategory>(row.need_category, NEED_CATEGORIES, 'other'),
    location: asString(row.location),
    caller_phone: asString(row.caller_phone),
    situation_text: asString(row.situation_text),
    delivery_status: asEnum<CaseDeliveryStatus>(
      row.delivery_status,
      CASE_DELIVERY_STATUSES,
      'none',
    ),
    organization_id: asNullableId(row.organization_id),
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

export function normalizeDelivery(raw: unknown, caseId: Id = ''): Delivery {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    case_id: asId(row.case_id, caseId),
    channel: asEnum<DeliveryChannel>(row.channel, DELIVERY_CHANNELS, 'sms'),
    to: asString(row.to),
    message: asString(row.message),
    document_url: asString(row.document_url),
    status: asEnum<DeliveryStatus>(row.status, DELIVERY_STATUSES, 'queued'),
    provider_id: asString(row.provider_id),
    error: asString(row.error),
    created_at: asTimestamp(row.created_at),
  };
}

/**
 * The legacy `pdf_mapping` column is either the AcroForm name (string) or the
 * seed's `{ acroform_field, pdf_type }` object. Either way the contract wants
 * the field name.
 */
function asPdfMapping(value: unknown, fieldId: string): string {
  const parsed = parseJsonish(value);
  if (typeof parsed === 'string' && parsed.length > 0) return parsed;
  const acroform = asString(asRecord(parsed).acroform_field);
  return acroform.length > 0 ? acroform : fieldId;
}

/**
 * A `form_schema` row. Xano backfills section / order / options /
 * pdf_field_name for pre-M1 rows (function form_schema_rows), so the result
 * always satisfies `M1FormSchemaField`; use `normalizeM1FormSchemaField` when
 * you need that type.
 */
export function normalizeFormSchemaField(raw: unknown): FormSchemaField {
  return normalizeM1FormSchemaField(raw);
}

export function normalizeM1FormSchemaField(raw: unknown): M1FormSchemaField {
  const row = asRecord(raw);
  const fieldId = asString(row.field_id);
  const section = asString(row.section) || asString(row.group_key);
  const pdfFieldName = asString(row.pdf_field_name) || fieldId;
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
    pdf_mapping: asPdfMapping(row.pdf_mapping, pdfFieldName),
    section,
    order: Math.max(0, Math.round(asNumber(row.order))),
    options: asStringArray(row.options),
    pdf_field_name: pdfFieldName,
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
    organization: row.organization ? normalizeOrganization(row.organization) : null,
    answers: asArray(row.answers).map((entry) => normalizeAnswer(entry, id)),
    requirements: asArray(row.requirements).map((entry) =>
      normalizeRequirement(entry, id),
    ),
    documents: asArray(row.documents).map((entry) => normalizeDocument(entry, id)),
    events: asArray(row.events).map((entry) => normalizeEvent(entry, id)),
    deliveries: asArray(row.deliveries).map((entry) => normalizeDelivery(entry, id)),
  };
}

export function normalizeInterviewSection(raw: unknown): InterviewSection {
  const row = asRecord(raw);
  const key = asString(row.key);
  return {
    key,
    label: asString(row.label, key),
    order: Math.max(0, Math.round(asNumber(row.order))),
    field_count: Math.max(0, Math.round(asNumber(row.field_count))),
    answered_count: Math.max(0, Math.round(asNumber(row.answered_count))),
    state: asEnum<ProgressState>(row.state, PROGRESS_STATES, 'todo'),
  };
}

export function normalizeInterviewProgress(raw: unknown): InterviewProgress {
  const row = asRecord(raw);
  const sections = asArray(row.sections).map(normalizeInterviewSection);
  return {
    answered: Math.max(0, Math.round(asNumber(row.answered))),
    total: Math.max(0, Math.round(asNumber(row.total))),
    percent: Math.max(0, Math.min(100, asNumber(row.percent))),
    section_index: Math.max(0, Math.round(asNumber(row.section_index))),
    section_count: Math.max(0, Math.round(asNumber(row.section_count, sections.length))),
    sections,
  };
}

export function normalizeNextQuestion(
  raw: unknown,
  progress: InterviewProgress,
): NextQuestion | null {
  const row = asRecord(raw);
  const fieldId = asString(row.field_id);
  if (fieldId === '') return null;
  return {
    field_id: fieldId,
    prompt: asString(row.prompt),
    section: asString(row.section, 'form'),
    progress: row.progress ? normalizeInterviewProgress(row.progress) : progress,
    type: asEnum<FormFieldType>(row.type, FORM_FIELD_TYPES, 'text'),
    options: asStringArray(row.options),
    required: asBoolean(row.required, true),
    why: asString(row.why),
  };
}

export function normalizeNextQuestionResponse(
  raw: unknown,
  caseId: Id,
): NextQuestionResponse {
  const row = asRecord(raw);
  const progress = normalizeInterviewProgress(row.progress);
  const question = normalizeNextQuestion(row.question, progress);
  return {
    case_id: asId(row.case_id ?? row.caseId, caseId),
    status: asEnum<CaseStatus>(row.status, CASE_STATUSES, 'CREATED'),
    done: question === null ? true : asBoolean(row.done, false),
    question,
    progress,
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

  const progress: CaseProgress = {
    caseId: asId(row.caseId ?? row.case_id, caseId),
    status: asEnum<CaseStatus>(row.status, CASE_STATUSES, 'CREATED'),
    percent: Math.max(0, Math.min(100, asNumber(row.percent ?? row.progress_percent))),
    steps,
    answersSaved: asNumber(row.answersSaved ?? row.answers_saved),
    answersExpected: asNumber(row.answersExpected ?? row.answers_expected),
    nextFieldId: asNullableString(row.nextFieldId ?? row.next_field_id),
    nextPrompt: asNullableString(row.nextPrompt ?? row.next_prompt),
  };

  // M1: the form's own sections, when Xano sent them. Left undefined
  // otherwise so demo fixtures (which carry none) render the 8 steps.
  if (Array.isArray(row.sections)) {
    progress.sections = row.sections.map(normalizeInterviewSection);
  }
  return progress;
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

export function normalizeResolveProgramResponse(raw: unknown): ResolveProgramResponse {
  const row = asRecord(raw);
  const program = row.program ? normalizeResolvedProgram(row.program) : null;
  // The invariant lives here too: found means a verified program is present.
  const found = asBoolean(row.found) && program !== null && program.verified;
  return {
    found,
    program: found ? program : null,
    organization: row.organization ? normalizeOrganization(row.organization) : null,
    alternatives: asArray(row.alternatives).map(normalizeResolvedProgram),
    reason: asString(row.reason),
  };
}

export function normalizeFormSchemaResponse(
  raw: unknown,
  programId: Id,
): GetFormSchemaResponse {
  const row = asRecord(raw);
  const fields = (Array.isArray(raw) ? raw : asArray(row.fields ?? row.form_schema)).map(
    normalizeM1FormSchemaField,
  );
  return {
    program_id: asId(row.program_id, programId),
    application_url: asString(row.application_url),
    count: fields.length,
    fields,
  };
}

/* ------------------------------------------------------------------ */
/* Wire vocabulary                                                     */
/* ------------------------------------------------------------------ */

/**
 * `documents.accessibility_status` on workspace 2 now accepts every contract
 * value, `preserved` included (table + endpoint enum edited together). The
 * map stays as the single place to translate if a value ever diverges again.
 */
const XANO_ACCESSIBILITY_STATUS_ON_WIRE: Partial<
  Record<AccessibilityStatus, AccessibilityStatus>
> = {
  preserved: 'preserved',
};

/** The `accessibility_status` value Xano will accept for a contract status. */
export function toXanoAccessibilityStatus(status: AccessibilityStatus): AccessibilityStatus {
  return XANO_ACCESSIBILITY_STATUS_ON_WIRE[status] ?? status;
}

/** Optional inputs of PUT /cases/{id}. Only the provided keys are written. */
export interface UpdateCaseInput {
  need_category?: NeedCategory;
  location?: string;
  caller_phone?: string;
  situation_text?: string;
  delivery_status?: CaseDeliveryStatus;
  organization_id?: Id;
  program_id?: Id;
  status?: CaseStatus;
  patient_display_name?: string;
}

/**
 * The M1 endpoints (docs/M1_CONTRACT.md §5). Live only — no fixture fallback.
 * Obtain one with `createLiveXanoAdapter()`; it is null when `XANO_BASE_URL`
 * is not configured, and callers decide what that means for their mode.
 */
export interface XanoM1Adapter {
  /** POST /cases — the widened, need-first shape. */
  createCaseM1(input: CreateCaseM1Request): Promise<Case>;
  /** PUT /cases/{id} — small partial update. */
  updateCase(caseId: Id, input: UpdateCaseInput): Promise<Case>;
  /** POST /organizations — upsert by name. */
  upsertOrganization(input: UpsertOrganizationRequest): Promise<Organization>;
  /** POST /programs/catalog — upsert by application_url; verified recomputed server-side. */
  upsertCatalogProgram(input: UpsertCatalogProgramRequest): Promise<ResolvedProgram>;
  /** GET /programs/resolve — catalog lookup; never another organization's row. */
  resolveCatalogProgram(query: ResolveProgramQuery): Promise<ResolveProgramResponse>;
  /** GET /programs/{id}/form_schema — count 0 and [] when no schema exists yet. */
  getFormSchemaDetail(
    programId: Id,
    options?: { requiredOnly?: boolean },
  ): Promise<GetFormSchemaResponse>;
  /** PUT /programs/{id}/form_schema — bulk replace. */
  replaceFormSchema(
    programId: Id,
    input: ReplaceFormSchemaRequest,
  ): Promise<ReplaceFormSchemaResponse>;
  /** GET /cases/{id}/next_question — Xano decides what is next. */
  getNextQuestion(caseId: Id): Promise<NextQuestionResponse>;
  /** POST /cases/{id}/deliveries — record a send attempt; edits in place on provider_id. */
  createDelivery(caseId: Id, input: CreateDeliveryRequest): Promise<Delivery>;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class LiveXanoAdapter implements XanoAdapter, XanoM1Adapter {
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

  /* ---- pre-M1 methods (fixture fallback kept for the demo) ---- */

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

  /**
   * Required questions for a program, in ask order. An EMPTY schema is a
   * real answer (`[]`) — the program has not been understood yet — and is
   * never replaced by the Cedars fixture: that would be a substitution.
   * Only a transport failure falls back.
   */
  async getFormSchema(programId: Id): Promise<FormSchemaField[]> {
    return withFallback(
      'xano',
      'getFormSchema',
      async () => {
        const raw = await this.call<unknown>(
          'getFormSchema',
          `/programs/${encodeURIComponent(programId)}/form_schema`,
        );
        const rows = Array.isArray(raw) ? raw : asArray(asRecord(raw).fields ?? asRecord(raw).form_schema);
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
        const json: SaveDocumentInput = input.accessibility_status
          ? { ...input, accessibility_status: toXanoAccessibilityStatus(input.accessibility_status) }
          : input;
        const raw = await this.call<unknown>(
          'saveDocument',
          `/cases/${encodeURIComponent(caseId)}/documents`,
          { method: 'POST', json },
        );
        return normalizeDocument(asRecord(raw).document ?? raw, caseId);
      },
      () => this.fallback.saveDocument(caseId, input),
    );
  }

  /* ---- M1 methods: live only, no fixture fallback ---- */

  async createCaseM1(input: CreateCaseM1Request): Promise<Case> {
    const json: Record<string, unknown> = {
      situation_text: input.situation_text,
      patient_display_name: input.patient_display_name ?? 'Caller',
      need_category: input.need_category ?? 'other',
    };
    if (input.caller_phone !== undefined) json.caller_phone = input.caller_phone;
    if (input.location !== undefined) json.location = input.location;
    if (input.hospital_name !== undefined) json.hospital_name = input.hospital_name;
    if (input.bill_amount !== undefined) json.bill_amount = input.bill_amount;
    if (input.program_id !== undefined) json.program_id = Number(input.program_id);
    if (input.external_ref !== undefined) json.external_ref = input.external_ref;

    const raw = await this.call<unknown>('createCaseM1', '/cases', {
      method: 'POST',
      json,
    });
    return normalizeCase(asRecord(raw).case ?? raw);
  }

  async updateCase(caseId: Id, input: UpdateCaseInput): Promise<Case> {
    const json: Record<string, unknown> = {};
    if (input.need_category !== undefined) json.need_category = input.need_category;
    if (input.location !== undefined) json.location = input.location;
    if (input.caller_phone !== undefined) json.caller_phone = input.caller_phone;
    if (input.situation_text !== undefined) json.situation_text = input.situation_text;
    if (input.delivery_status !== undefined) json.delivery_status = input.delivery_status;
    if (input.organization_id !== undefined) json.organization_id = Number(input.organization_id);
    if (input.program_id !== undefined) json.program_id = Number(input.program_id);
    if (input.status !== undefined) json.status = input.status;
    if (input.patient_display_name !== undefined) {
      json.patient_display_name = input.patient_display_name;
    }

    const raw = await this.call<unknown>(
      'updateCase',
      `/cases/${encodeURIComponent(caseId)}`,
      { method: 'PUT', json },
    );
    return normalizeCase(asRecord(raw).case ?? raw);
  }

  async upsertOrganization(input: UpsertOrganizationRequest): Promise<Organization> {
    const raw = await this.call<unknown>('upsertOrganization', '/organizations', {
      method: 'POST',
      json: {
        name: input.name,
        kind: input.kind,
        domain: input.domain,
        region: input.region ?? '',
        website: input.website ?? '',
      },
    });
    return normalizeOrganization(raw);
  }

  async upsertCatalogProgram(input: UpsertCatalogProgramRequest): Promise<ResolvedProgram> {
    const json: Record<string, unknown> = {
      organization_name: input.organization_name,
      organization_kind: input.organization_kind,
      organization_domain: input.organization_domain,
      name: input.name,
      category: input.category,
      form_kind: input.form_kind,
      application_url: input.application_url,
      policy_url: input.policy_url,
      source_domain: input.source_domain,
      region: input.region,
      submission_instructions: input.submission_instructions ?? '',
      field_count: input.field_count ?? 0,
      page_count: input.page_count ?? 0,
      sha256: input.sha256 ?? '',
      verified: input.verified,
    };
    if (input.retrieved_at !== undefined) json.retrieved_at = input.retrieved_at;
    if (input.effective_date !== undefined) json.effective_date = input.effective_date;

    const raw = await this.call<unknown>('upsertCatalogProgram', '/programs/catalog', {
      method: 'POST',
      json,
    });
    return normalizeResolvedProgram(raw);
  }

  async resolveCatalogProgram(query: ResolveProgramQuery): Promise<ResolveProgramResponse> {
    const params = new URLSearchParams({ category: query.category });
    if (query.location) params.set('location', query.location);
    if (query.organization) params.set('organization', query.organization);
    const raw = await this.call<unknown>(
      'resolveCatalogProgram',
      `/programs/resolve?${params.toString()}`,
    );
    return normalizeResolveProgramResponse(raw);
  }

  async getFormSchemaDetail(
    programId: Id,
    options: { requiredOnly?: boolean } = {},
  ): Promise<GetFormSchemaResponse> {
    const requiredOnly = options.requiredOnly ?? true;
    const raw = await this.call<unknown>(
      'getFormSchemaDetail',
      `/programs/${encodeURIComponent(programId)}/form_schema?required_only=${requiredOnly ? 'true' : 'false'}`,
    );
    return normalizeFormSchemaResponse(raw, programId);
  }

  async replaceFormSchema(
    programId: Id,
    input: ReplaceFormSchemaRequest,
  ): Promise<ReplaceFormSchemaResponse> {
    const raw = await this.call<unknown>(
      'replaceFormSchema',
      `/programs/${encodeURIComponent(programId)}/form_schema`,
      {
        method: 'PUT',
        json: {
          fields: input.fields.map((field) => ({
            field_id: field.field_id,
            label: field.label,
            normalized_key: field.normalized_key,
            type: field.type,
            required: field.required,
            section: field.section,
            order: field.order,
            options: field.options,
            conversational_prompt: field.conversational_prompt,
            dependency_rule: field.dependency_rule ?? '',
            pdf_field_name: field.pdf_field_name,
            pdf_mapping: field.pdf_mapping,
            group_key: field.group_key,
          })),
        },
      },
    );
    const response = normalizeFormSchemaResponse(raw, programId);
    return {
      program_id: response.program_id,
      count: response.count,
      fields: response.fields,
    };
  }

  async getNextQuestion(caseId: Id): Promise<NextQuestionResponse> {
    const raw = await this.call<unknown>(
      'getNextQuestion',
      `/cases/${encodeURIComponent(caseId)}/next_question`,
    );
    return normalizeNextQuestionResponse(raw, caseId);
  }

  async createDelivery(caseId: Id, input: CreateDeliveryRequest): Promise<Delivery> {
    const raw = await this.call<unknown>(
      'createDelivery',
      `/cases/${encodeURIComponent(caseId)}/deliveries`,
      {
        method: 'POST',
        json: {
          channel: input.channel,
          to: input.to,
          message: input.message,
          document_url: input.document_url,
          status: input.status,
          provider_id: input.provider_id ?? '',
          error: input.error ?? '',
        },
      },
    );
    return normalizeDelivery(asRecord(raw).delivery ?? raw, caseId);
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

/**
 * The live client with the M1 endpoints, or null when `XANO_BASE_URL` is not
 * configured. There is no fixture implementation of `XanoM1Adapter` — outside
 * demo mode a missing system of record is a failure, not Jane's data.
 */
export function createLiveXanoAdapter(): LiveXanoAdapter | null {
  const credentials = xanoCredentials();
  if (!credentials) return null;
  return new LiveXanoAdapter(credentials);
}
