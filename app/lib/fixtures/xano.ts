/**
 * Deterministic in-memory implementation of the Xano system of record.
 *
 * This is the fallback that keeps the demo alive with zero network, and it is
 * authoritative about completeness exactly the way Xano is — the UI reads
 * `getCaseProgress` / `validateCase` and never recomputes.
 *
 * Progress model (chosen so the fixture reproduces the demo constants exactly):
 *
 *   percent = 25   verified official program found
 *           + 26   official form structure extracted
 *           +  7 × (requirement groups complete, out of 7)
 *
 * Three groups complete -> 51 + 21 = 72  (mid-call snapshot)
 * Five  groups complete -> 51 + 35 = 86  (DEMO_CASE.progress_percent,
 *                                         DEMO_COMPLETENESS.percent)
 *
 * The remaining 14 points are the two requirements AccessForm deliberately
 * cannot satisfy for Jane: proof of Social Security income, and her signature.
 */

import {
  DEMO_ANSWERS,
  DEMO_CASE,
  DEMO_CASE_ID,
  DEMO_DOCUMENTS,
  DEMO_EVENTS,
  DEMO_FILLED_PDF_PATH,
  DEMO_HOSPITAL,
  DEMO_HOSPITAL_ID,
  DEMO_PROGRAM,
  DEMO_PROGRAM_ID,
  DEMO_REQUIREMENTS,
  PROGRESS_STEP_IDS,
  PROGRESS_STEP_LABELS,
  type Answer,
  type Case,
  type CaseBundle,
  type CaseDocument,
  type CaseEvent,
  type CaseProgress,
  type CaseStatus,
  type CompletenessSummary,
  type CreateCaseInput,
  type DiscoveryResult,
  type FormSchemaField,
  type Hospital,
  type Id,
  type NewCaseEvent,
  type Program,
  type ProgressState,
  type ProgressStep,
  type Requirement,
  type SaveAnswerInput,
  type SaveDocumentInput,
  type XanoAdapter,
} from '../contract';
import { CACHED_DISCOVERY } from './discovery-cache';
import { delay, FIXTURE_LATENCY } from './latency';
import {
  FIELD_GROUP_KEYS,
  FIXTURE_FORM_SCHEMA,
  FIXTURE_FORM_SCHEMA_FIELDS,
  FIXTURE_REQUIRED_FIELD_COUNT,
  REQUIREMENT_GROUPS,
  resolveField,
  type FieldGroupKey,
  type FixtureFormField,
  type RequirementGroupKey,
} from './form-schema';

/* ------------------------------------------------------------------ */
/* Scoring constants                                                   */
/* ------------------------------------------------------------------ */

const POINTS_PROGRAM_FOUND = 25;
const POINTS_FORM_EXTRACTED = 26;
const POINTS_PER_REQUIREMENT_GROUP = 7;

/** Requirement rows keep the ids the demo constants use. */
const REQUIREMENT_ROW_IDS: Readonly<Record<RequirementGroupKey, string>> = {
  personal_information: 'req_personal',
  household_information: 'req_household',
  insurance_information: 'req_insurance',
  income_information: 'req_income',
  monthly_expenses: 'req_expenses',
  proof_of_social_security_income: 'req_proof_income',
  applicant_signature: 'req_signature',
};

/* ------------------------------------------------------------------ */
/* Store state                                                         */
/* ------------------------------------------------------------------ */

interface CaseRecord {
  case: Case;
  answers: Map<string, Answer>;
  requirements: Map<RequirementGroupKey, Requirement>;
  documents: CaseDocument[];
  events: CaseEvent[];
  /** True once a verified program has been attached. */
  programFound: boolean;
  /** True once the official form structure has been extracted. */
  formExtracted: boolean;
}

export type FixtureSeed = 'complete' | 'empty';

interface StoreState {
  hospitals: Map<Id, Hospital>;
  programs: Map<Id, Program>;
  formSchema: Map<Id, FormSchemaField[]>;
  cases: Map<Id, CaseRecord>;
  sequence: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

let state: StoreState = createState('complete');

function createState(seed: FixtureSeed): StoreState {
  const next: StoreState = {
    hospitals: new Map([[DEMO_HOSPITAL_ID, clone(DEMO_HOSPITAL)]]),
    programs: new Map([[DEMO_PROGRAM_ID, clone(DEMO_PROGRAM)]]),
    formSchema: new Map([[DEMO_PROGRAM_ID, clone(FIXTURE_FORM_SCHEMA_FIELDS.slice())]]),
    cases: new Map(),
    sequence: 0,
  };
  next.cases.set(DEMO_CASE_ID, seed === 'complete' ? completedRecord() : emptyRecord());
  return next;
}

function freshRequirements(): Map<RequirementGroupKey, Requirement> {
  const map = new Map<RequirementGroupKey, Requirement>();
  for (const group of REQUIREMENT_GROUPS) {
    map.set(group.key, {
      id: REQUIREMENT_ROW_IDS[group.key],
      case_id: DEMO_CASE_ID,
      key: group.key,
      label: group.label,
      type: group.type,
      status: 'missing',
      evidence_url: null,
    });
  }
  return map;
}

function emptyRecord(): CaseRecord {
  return {
    case: {
      ...clone(DEMO_CASE),
      program_id: null,
      status: 'CREATED',
      progress_percent: 0,
      updated_at: DEMO_CASE.created_at,
    },
    answers: new Map(),
    requirements: freshRequirements(),
    documents: [],
    events: [],
    programFound: false,
    formExtracted: false,
  };
}

function completedRecord(): CaseRecord {
  const answers = new Map<string, Answer>();
  for (const answer of clone(DEMO_ANSWERS)) answers.set(answer.field_id, answer);

  const requirements = new Map<RequirementGroupKey, Requirement>();
  for (const requirement of clone(DEMO_REQUIREMENTS)) {
    requirements.set(requirement.key as RequirementGroupKey, requirement);
  }

  return {
    case: clone(DEMO_CASE),
    answers,
    requirements,
    documents: clone(DEMO_DOCUMENTS),
    events: clone(DEMO_EVENTS),
    programFound: true,
    formExtracted: true,
  };
}

/**
 * Reset the store. `'complete'` (default) leaves case AF-001 in the finished
 * Jane state so /review renders standalone; `'empty'` gives a fresh case for a
 * live call replay.
 */
export function resetFixtureStore(seed: FixtureSeed = 'complete'): void {
  state = createState(seed);
}

/** Escape hatch for the voice fixture: mark discovery/extraction as done. */
export function markFixtureMilestone(
  caseId: Id,
  milestone: 'program_found' | 'form_extracted',
): void {
  const record = state.cases.get(caseId);
  if (!record) return;
  if (milestone === 'program_found') {
    record.programFound = true;
    record.case.program_id = DEMO_PROGRAM_ID;
    if (record.case.status === 'CREATED' || record.case.status === 'DISCOVERING') {
      record.case.status = 'FORM_FOUND';
    }
  } else {
    record.formExtracted = true;
    if (!record.documents.some((doc) => doc.type === 'source_application')) {
      record.documents.push({
        id: 'doc_source',
        case_id: caseId,
        type: 'source_application',
        source_url: DEMO_PROGRAM.application_url,
        generated_url: null,
        accessibility_status: 'not_applicable',
        version_hash: null,
      });
    }
  }
  recompute(record);
}

function nextId(prefix: string): string {
  state.sequence += 1;
  return `${prefix}_${String(state.sequence).padStart(3, '0')}`;
}

function getRecord(caseId: Id): CaseRecord {
  const record = state.cases.get(caseId);
  if (record) return record;
  throw new Error(`Fixture store has no case "${caseId}".`);
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

function groupIsComplete(record: CaseRecord, group: FieldGroupKey): boolean {
  return FIXTURE_FORM_SCHEMA.filter((field) => field.group === group).every((field) =>
    record.answers.has(field.field_id),
  );
}

/** Re-derive requirement statuses, percent and case status from the answers. */
function recompute(record: CaseRecord): void {
  for (const group of FIELD_GROUP_KEYS) {
    const requirement = record.requirements.get(group);
    if (!requirement) continue;
    requirement.status = groupIsComplete(record, group) ? 'complete' : 'missing';
  }

  const completeGroups = REQUIREMENT_GROUPS.filter(
    (group) => record.requirements.get(group.key)?.status === 'complete',
  ).length;

  const percent =
    (record.programFound ? POINTS_PROGRAM_FOUND : 0) +
    (record.formExtracted ? POINTS_FORM_EXTRACTED : 0) +
    completeGroups * POINTS_PER_REQUIREMENT_GROUP;

  record.case.progress_percent = Math.max(0, Math.min(100, percent));
  record.case.updated_at = nowIso();

  const allFieldsAnswered = FIELD_GROUP_KEYS.every((group) =>
    groupIsComplete(record, group),
  );

  const terminal: CaseStatus[] = ['READY_FOR_REVIEW', 'BLOCKED'];
  if (!terminal.includes(record.case.status)) {
    if (allFieldsAnswered) {
      record.case.status = 'VALIDATING';
    } else if (record.answers.size > 0) {
      record.case.status = 'INTERVIEWING';
    } else if (record.programFound) {
      record.case.status = 'FORM_FOUND';
    }
  }
}

function stepStateFor(record: CaseRecord, index: number): ProgressState {
  const id = PROGRESS_STEP_IDS[index];
  const status = record.case.status;
  const done = (group: FieldGroupKey): boolean => groupIsComplete(record, group);
  const allAnswered = FIELD_GROUP_KEYS.every(done);

  /** The first field group that is not yet complete, if any. */
  const activeGroup = FIELD_GROUP_KEYS.find((group) => !done(group));

  switch (id) {
    case 'program_found':
      if (record.programFound) return 'done';
      return status === 'DISCOVERING' ? 'active' : 'todo';
    case 'current_form':
      if (record.formExtracted) return 'done';
      return record.programFound ? 'active' : 'todo';
    case 'personal_information':
      if (done('personal_information')) return 'done';
      return activeGroup === 'personal_information' ? 'active' : 'todo';
    case 'household':
      if (done('household_information')) return 'done';
      return activeGroup === 'household_information' ? 'active' : 'todo';
    case 'insurance':
      if (done('insurance_information')) return 'done';
      return activeGroup === 'insurance_information' ? 'active' : 'todo';
    case 'income':
      // One visible step covers both income and the monthly expense lines.
      if (done('income_information') && done('monthly_expenses')) return 'done';
      return activeGroup === 'income_information' || activeGroup === 'monthly_expenses'
        ? 'active'
        : 'todo';
    case 'documents':
      if (!allAnswered) return 'todo';
      return status === 'INTERVIEWING' || status === 'VALIDATING' ? 'active' : 'done';
    case 'review':
      return status === 'READY_FOR_REVIEW' ? 'active' : 'todo';
    default:
      return 'todo';
  }
}

function buildSteps(record: CaseRecord): ProgressStep[] {
  return PROGRESS_STEP_IDS.map((id, index) => ({
    id,
    label: PROGRESS_STEP_LABELS[id],
    state: stepStateFor(record, index),
  }));
}

/** First required field with no saved answer, in asking order. */
function nextUnanswered(record: CaseRecord): FixtureFormField | undefined {
  return FIXTURE_FORM_SCHEMA.find(
    (field) => field.required && !record.answers.has(field.field_id),
  );
}

function buildProgress(record: CaseRecord): CaseProgress {
  const next = nextUnanswered(record);
  return {
    caseId: record.case.id,
    status: record.case.status,
    percent: record.case.progress_percent,
    steps: buildSteps(record),
    answersSaved: record.answers.size,
    answersExpected: FIXTURE_REQUIRED_FIELD_COUNT,
    nextFieldId: next ? next.field_id : null,
    nextPrompt: next ? next.conversational_prompt : null,
  };
}

function buildCompleteness(record: CaseRecord): CompletenessSummary {
  const missing = REQUIREMENT_GROUPS.map((group) => record.requirements.get(group.key))
    .filter((requirement): requirement is Requirement => Boolean(requirement))
    .filter((requirement) => requirement.status === 'missing');

  const allFieldsAnswered = FIELD_GROUP_KEYS.every((group) =>
    groupIsComplete(record, group),
  );

  return {
    percent: record.case.progress_percent,
    requiredFieldsComplete: record.answers.size,
    requiredFieldsTotal: FIXTURE_REQUIRED_FIELD_COUNT,
    missingRequirements: clone(missing),
    readyForReview: allFieldsAnswered,
  };
}

function buildBundle(record: CaseRecord): CaseBundle {
  const hospital = state.hospitals.get(record.case.hospital_id) ?? DEMO_HOSPITAL;
  const program = record.case.program_id
    ? (state.programs.get(record.case.program_id) ?? null)
    : null;

  return clone({
    case: record.case,
    hospital,
    program,
    answers: orderedAnswers(record),
    requirements: REQUIREMENT_GROUPS.map(
      (group) => record.requirements.get(group.key),
    ).filter((requirement): requirement is Requirement => Boolean(requirement)),
    documents: record.documents,
    events: record.events,
  });
}

/** Answers in the schema's asking order, so the UI never has to sort. */
function orderedAnswers(record: CaseRecord): Answer[] {
  const ordered: Answer[] = [];
  for (const field of FIXTURE_FORM_SCHEMA) {
    const answer = record.answers.get(field.field_id);
    if (answer) ordered.push(answer);
  }
  for (const [fieldId, answer] of record.answers) {
    if (!FIXTURE_FORM_SCHEMA.some((field) => field.field_id === fieldId)) {
      ordered.push(answer);
    }
  }
  return ordered;
}

function pushEvent(record: CaseRecord, event: NewCaseEvent): CaseEvent {
  const row: CaseEvent = {
    id: nextId('evt'),
    case_id: record.case.id,
    timestamp: event.timestamp ?? nowIso(),
    actor: event.actor,
    event_type: event.event_type,
    message: event.message,
    metadata_json: event.metadata_json ?? null,
  };
  record.events.push(row);
  return row;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class FixtureXanoAdapter implements XanoAdapter {
  async createCase(input: CreateCaseInput): Promise<Case> {
    await delay(FIXTURE_LATENCY.xanoWrite);

    // The only supported hospital is Cedars-Sinai; anything else still resolves
    // there rather than failing the demo.
    const hospital = DEMO_HOSPITAL;
    const record = emptyRecord();
    record.case = {
      ...record.case,
      id: DEMO_CASE_ID,
      patient_display_name: input.patient_display_name,
      hospital_id: hospital.id,
      program_id: input.program_id ?? null,
      bill_amount: input.bill_amount,
      status: 'CREATED',
      progress_percent: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (record.case.program_id) record.programFound = true;

    state.cases.set(record.case.id, record);
    pushEvent(record, {
      actor: 'xano',
      event_type: 'case_created',
      message: 'Case created',
      metadata_json: { case_id: record.case.id },
    });
    recompute(record);
    return clone(record.case);
  }

  async getCase(caseId: Id): Promise<CaseBundle> {
    await delay(FIXTURE_LATENCY.xanoRead);
    return buildBundle(getRecord(caseId));
  }

  async appendEvent(caseId: Id, event: NewCaseEvent): Promise<CaseEvent> {
    await delay(FIXTURE_LATENCY.xanoWrite);
    const record = getRecord(caseId);
    return clone(pushEvent(record, event));
  }

  async saveAnswer(
    caseId: Id,
    fieldId: string,
    input: SaveAnswerInput,
  ): Promise<Answer> {
    await delay(FIXTURE_LATENCY.xanoWrite);
    const record = getRecord(caseId);
    const field = resolveField(fieldId);
    const resolvedFieldId = field ? field.field_id : fieldId;

    const existing = record.answers.get(resolvedFieldId);
    const answer: Answer = {
      id: existing ? existing.id : nextId('ans'),
      case_id: caseId,
      field_id: resolvedFieldId,
      value_json: input.value,
      source: input.source,
      confirmed: input.confirmed ?? true,
      updated_at: nowIso(),
    };
    record.answers.set(resolvedFieldId, answer);

    const groupBefore = field ? record.requirements.get(field.group)?.status : undefined;
    recompute(record);
    const groupAfter = field ? record.requirements.get(field.group)?.status : undefined;

    pushEvent(record, {
      actor: 'xano',
      event_type: 'answer_saved',
      message: answerSavedMessage(field),
      metadata_json: { field_id: resolvedFieldId },
    });

    if (field && groupBefore !== 'complete' && groupAfter === 'complete') {
      pushEvent(record, {
        actor: 'xano',
        event_type: 'requirement_completed',
        message: `${record.requirements.get(field.group)?.label ?? 'Section'} complete`,
        metadata_json: { key: field.group },
      });
    }

    return clone(answer);
  }

  async getCaseProgress(caseId: Id): Promise<CaseProgress> {
    await delay(FIXTURE_LATENCY.xanoRead);
    const record = getRecord(caseId);
    recompute(record);
    return clone(buildProgress(record));
  }

  async validateCase(caseId: Id): Promise<CompletenessSummary> {
    await delay(FIXTURE_LATENCY.xanoValidate);
    const record = getRecord(caseId);
    recompute(record);
    const summary = buildCompleteness(record);

    for (const requirement of summary.missingRequirements) {
      const alreadyLogged = record.events.some(
        (event) =>
          event.event_type === 'missing_requirement_detected' &&
          (event.metadata_json as { key?: string } | null)?.key === requirement.key,
      );
      if (alreadyLogged) continue;
      pushEvent(record, {
        actor: 'xano',
        event_type: 'missing_requirement_detected',
        message:
          requirement.key === 'proof_of_social_security_income'
            ? 'Missing proof of income detected'
            : `Missing ${requirement.label.toLowerCase()} detected`,
        metadata_json: { key: requirement.key },
      });
    }

    if (summary.readyForReview && record.case.status !== 'READY_FOR_REVIEW') {
      record.case.status = 'READY_FOR_REVIEW';
      record.case.updated_at = nowIso();
    }

    return summary;
  }

  async saveDiscoveredProgram(result: DiscoveryResult): Promise<Program> {
    await delay(FIXTURE_LATENCY.xanoWrite);
    const program: Program = {
      ...clone(DEMO_PROGRAM),
      policy_url: result.policy_url || DEMO_PROGRAM.policy_url,
      application_url: result.application_url || DEMO_PROGRAM.application_url,
      source_domain:
        result.verified_sources[0]?.source_domain ?? DEMO_PROGRAM.source_domain,
      retrieved_at: result.retrieved_at,
      verified: result.verified_sources.length > 0,
    };
    state.programs.set(program.id, program);

    for (const record of state.cases.values()) {
      if (record.case.program_id === null) {
        record.case.program_id = program.id;
        record.programFound = program.verified;
        recompute(record);
      }
    }
    return clone(program);
  }

  async getFormSchema(programId: Id): Promise<FormSchemaField[]> {
    await delay(FIXTURE_LATENCY.xanoRead);
    const rows = state.formSchema.get(programId);
    // Any program id resolves to the Cedars schema — it is the only one.
    return clone(rows ?? FIXTURE_FORM_SCHEMA_FIELDS.slice());
  }

  async saveDocument(caseId: Id, input: SaveDocumentInput): Promise<CaseDocument> {
    await delay(FIXTURE_LATENCY.xanoWrite);
    const record = getRecord(caseId);
    const existingIndex = record.documents.findIndex((doc) => doc.type === input.type);
    const document: CaseDocument = {
      id:
        existingIndex >= 0
          ? record.documents[existingIndex].id
          : nextId(input.type === 'filled_application' ? 'doc_filled' : 'doc'),
      case_id: caseId,
      type: input.type,
      source_url: input.source_url ?? null,
      generated_url: input.generated_url ?? null,
      accessibility_status: input.accessibility_status ?? 'pending',
      version_hash: input.version_hash ?? null,
    };
    if (existingIndex >= 0) record.documents[existingIndex] = document;
    else record.documents.push(document);

    if (input.type === 'source_application') {
      record.formExtracted = true;
      recompute(record);
    }
    return clone(document);
  }
}

export const fixtureXanoAdapter: XanoAdapter = new FixtureXanoAdapter();

/* ------------------------------------------------------------------ */
/* Helpers used by the other fixtures                                  */
/* ------------------------------------------------------------------ */

function answerSavedMessage(field: FixtureFormField | undefined): string {
  if (!field) return 'Answer saved';
  switch (field.group) {
    case 'personal_information':
      return 'Personal answer saved';
    case 'household_information':
      return 'Household answer saved';
    case 'insurance_information':
      return 'Insurance answer saved';
    case 'income_information':
      return 'Income answer saved';
    case 'monthly_expenses':
      return 'Expense answer saved';
    default:
      return 'Answer saved';
  }
}

/**
 * Synchronous, latency-free read of a case's event feed. Used by the voice
 * fixture to stream newly-appended events without an extra round trip.
 * Returns an empty array for an unknown case rather than throwing.
 */
export function peekEvents(caseId: Id): CaseEvent[] {
  const record = state.cases.get(caseId);
  return record ? clone(record.events) : [];
}

/** Synchronous, latency-free read of the case row. */
export function peekCase(caseId: Id): Case | undefined {
  const record = state.cases.get(caseId);
  return record ? clone(record.case) : undefined;
}

/** Force a case status (used when the voice fixture reaches a milestone). */
export function setFixtureCaseStatus(caseId: Id, status: CaseStatus): void {
  const record = state.cases.get(caseId);
  if (!record) return;
  record.case.status = status;
  record.case.updated_at = nowIso();
}

/** The cached discovery payload, exported here for the voice fixture. */
export const FIXTURE_DISCOVERY = CACHED_DISCOVERY;

/** Viewer URL the fixture Nutrient adapter and /review both fall back to. */
export const FIXTURE_DOCUMENT_URL = DEMO_FILLED_PDF_PATH;
