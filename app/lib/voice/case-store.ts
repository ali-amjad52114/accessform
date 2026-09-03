/**
 * Server-side fixture store — the demo-safe fallback behind every voice tool.
 *
 * This is NOT a replacement for Xano. It is the "the demo cannot break" layer
 * required by CLAUDE.md: when `XANO_API_BASE` is unset, or a live Xano call
 * fails mid-demo, the voice tools keep answering from this in-memory store,
 * seeded from the shared fixtures in `lib/contract.ts`.
 *
 * It also owns the progress / completeness maths, so the numbers the voice
 * agent hears are the same numbers /live renders.
 */

import {
  CEDARS_APPLICATION_PDF_URL,
  DEMO_CASE_BUNDLE,
  DEMO_CASE_ID,
  DEMO_FILLED_PDF_PATH,
  DEMO_HOSPITAL,
  DEMO_PROGRAM,
  DEMO_PROGRAM_ID,
  PROGRESS_STEP_IDS,
  PROGRESS_STEP_LABELS,
  type Answer,
  type Case,
  type CaseBundle,
  type CaseDocument,
  type CaseEvent,
  type CaseProgress,
  type CompletenessSummary,
  type CreateCaseInput,
  type DiscoveryResult,
  type Hospital,
  type Id,
  type NewCaseEvent,
  type Program,
  type ProgressState,
  type ProgressStepId,
  type Requirement,
  type SaveAnswerInput,
  type SaveDocumentInput,
} from '../contract';
import { INTERVIEW_PLAN, fieldCountForStep, resolveField } from './form-plan';

/** Every case ends at 86% — 26/26 fields, two non-field requirements open. */
export const READY_FOR_REVIEW_PERCENT = 86;

/** The two requirements AccessForm can never satisfy on the patient's behalf. */
export const OPEN_REQUIREMENT_TEMPLATES: readonly Omit<Requirement, 'id' | 'case_id'>[] = [
  {
    key: 'proof_of_social_security_income',
    label: 'Proof of Social Security income',
    type: 'attachment',
    status: 'missing',
    evidence_url: null,
  },
  {
    key: 'applicant_signature',
    label: 'Signature of person applying for financial assistance',
    type: 'signature',
    status: 'missing',
    evidence_url: null,
  },
];

const FIELD_REQUIREMENT_TEMPLATES: readonly Omit<Requirement, 'id' | 'case_id'>[] = [
  { key: 'personal_information', label: 'Personal information', type: 'field', status: 'complete', evidence_url: null },
  { key: 'household_information', label: 'Household information', type: 'field', status: 'complete', evidence_url: null },
  { key: 'insurance_information', label: 'Insurance information', type: 'field', status: 'complete', evidence_url: null },
  { key: 'income_information', label: 'Income information', type: 'field', status: 'complete', evidence_url: null },
  { key: 'monthly_expenses', label: 'Monthly expenses', type: 'field', status: 'complete', evidence_url: null },
];

/**
 * The requirement rows every case gets the first time it is validated: the
 * five field groups, plus the two things AccessForm can never satisfy for the
 * patient (proof of income, and their signature).
 */
export function defaultRequirements(caseId: Id, makeId: (prefix: string) => string): Requirement[] {
  return [...FIELD_REQUIREMENT_TEMPLATES, ...OPEN_REQUIREMENT_TEMPLATES].map((template) => ({
    ...template,
    id: makeId('req'),
    case_id: caseId,
  }));
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface StoreShape {
  cases: Map<Id, CaseBundle>;
  sequence: number;
}

/** Survives Next.js dev hot-reloads. */
const STORE_KEY = Symbol.for('accessform.voice.caseStore');

function store(): StoreShape {
  const globalStore = globalThis as unknown as Record<symbol, StoreShape | undefined>;
  let existing = globalStore[STORE_KEY];
  if (!existing) {
    existing = { cases: new Map(), sequence: 1 };
    existing.cases.set(DEMO_CASE_ID, clone(DEMO_CASE_BUNDLE));
    globalStore[STORE_KEY] = existing;
  }
  return existing;
}

function nextId(prefix: string): string {
  const state = store();
  state.sequence += 1;
  return `${prefix}_${state.sequence.toString(36)}${Date.now().toString(36).slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Progress + completeness maths                                       */
/* ------------------------------------------------------------------ */

const FIELD_STEPS: readonly ProgressStepId[] = [
  'personal_information',
  'household',
  'insurance',
  'income',
];

function answeredFieldIds(bundle: CaseBundle): Set<string> {
  const answered = new Set<string>();
  for (const answer of bundle.answers) {
    const value = answer.value_json;
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const field = resolveField(answer.field_id);
    answered.add(field ? field.fieldId : answer.field_id);
  }
  return answered;
}

function answeredCountForStep(answered: Set<string>, step: ProgressStepId): number {
  return INTERVIEW_PLAN.filter((field) => field.step === step && answered.has(field.fieldId)).length;
}

/**
 * Authoritative progress for one case. The voice agent and /live both read
 * this — nothing recomputes completeness on its own.
 */
export function computeProgress(bundle: CaseBundle): CaseProgress {
  const answered = answeredFieldIds(bundle);
  const answersSaved = INTERVIEW_PLAN.filter((field) => answered.has(field.fieldId)).length;
  const answersExpected = INTERVIEW_PLAN.length;

  const hasProgram = Boolean(bundle.case.program_id ?? bundle.program);
  const hasSourceForm =
    Boolean(bundle.program?.application_url) ||
    bundle.documents.some((doc) => doc.type === 'source_application');
  const hasRequirements = bundle.requirements.length > 0;
  const hasFilledDocument = bundle.documents.some((doc) => doc.type === 'filled_application');
  const readyForReview = bundle.case.status === 'READY_FOR_REVIEW' || hasFilledDocument;

  const fieldStepDone: Record<string, boolean> = {};
  for (const step of FIELD_STEPS) {
    fieldStepDone[step] = answeredCountForStep(answered, step) >= fieldCountForStep(step);
  }
  const firstOpenFieldStep = FIELD_STEPS.find((step) => !fieldStepDone[step]) ?? null;
  const allFieldsDone = firstOpenFieldStep === null;

  const stateFor = (step: ProgressStepId): ProgressState => {
    switch (step) {
      case 'program_found':
        return hasProgram ? 'done' : 'active';
      case 'current_form':
        if (hasSourceForm) return 'done';
        return hasProgram ? 'active' : 'todo';
      case 'documents':
        if (hasRequirements) return 'done';
        return allFieldsDone ? 'active' : 'todo';
      case 'review':
        return readyForReview ? 'active' : 'todo';
      default: {
        if (fieldStepDone[step]) return 'done';
        if (!hasSourceForm) return 'todo';
        return step === firstOpenFieldStep ? 'active' : 'todo';
      }
    }
  };

  const steps = PROGRESS_STEP_IDS.map((id) => ({
    id,
    label: PROGRESS_STEP_LABELS[id],
    state: stateFor(id),
  }));

  let weight = 0;
  for (const step of steps) {
    if (step.state === 'done') {
      weight += 1;
    } else if (step.state === 'active') {
      if ((FIELD_STEPS as readonly string[]).includes(step.id)) {
        const total = fieldCountForStep(step.id);
        weight += total === 0 ? 0.5 : answeredCountForStep(answered, step.id) / total;
      } else if (step.id === 'review') {
        weight += 1;
      } else {
        weight += 0.5;
      }
    }
  }

  const percent = readyForReview
    ? READY_FOR_REVIEW_PERCENT
    : Math.min(
        READY_FOR_REVIEW_PERCENT,
        Math.round((READY_FOR_REVIEW_PERCENT * weight) / PROGRESS_STEP_IDS.length),
      );

  const nextField = INTERVIEW_PLAN.find((field) => !answered.has(field.fieldId)) ?? null;

  return {
    caseId: bundle.case.id,
    status: bundle.case.status,
    percent,
    steps,
    answersSaved,
    answersExpected,
    nextFieldId: nextField ? nextField.fieldId : null,
    nextPrompt: nextField ? nextField.prompt : null,
  };
}

/**
 * `readyForReview` means "appears complete against the published
 * requirements". It never means eligible, approved, submitted, or signed.
 */
export function computeCompleteness(bundle: CaseBundle): CompletenessSummary {
  const answered = answeredFieldIds(bundle);
  const requiredFieldsTotal = INTERVIEW_PLAN.filter((field) => field.required).length;
  const requiredFieldsComplete = INTERVIEW_PLAN.filter(
    (field) => field.required && answered.has(field.fieldId),
  ).length;
  const missingRequirements = bundle.requirements.filter((req) => req.status === 'missing');
  const allFieldsAnswered = requiredFieldsComplete >= requiredFieldsTotal;

  return {
    percent: allFieldsAnswered
      ? READY_FOR_REVIEW_PERCENT
      : Math.round((READY_FOR_REVIEW_PERCENT * requiredFieldsComplete) / requiredFieldsTotal),
    requiredFieldsComplete,
    requiredFieldsTotal,
    missingRequirements,
    readyForReview: allFieldsAnswered,
  };
}

/* ------------------------------------------------------------------ */
/* Store operations                                                    */
/* ------------------------------------------------------------------ */

export function getBundle(caseId: Id): CaseBundle | null {
  return store().cases.get(caseId) ?? null;
}

export function requireBundle(caseId: Id): CaseBundle {
  const bundle = getBundle(caseId);
  if (!bundle) throw new Error(`Unknown case "${caseId}"`);
  return bundle;
}

export function createCase(input: CreateCaseInput): Case {
  const state = store();
  const id = `AF-${String(state.cases.size + 1).padStart(3, '0')}`;
  const timestamp = nowIso();
  const hospital = { ...DEMO_HOSPITAL, name: input.hospital_name || DEMO_HOSPITAL.name };
  const newCase: Case = {
    id,
    patient_display_name: input.patient_display_name,
    hospital_id: hospital.id,
    program_id: input.program_id ?? null,
    bill_amount: input.bill_amount,
    status: 'CREATED',
    progress_percent: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  state.cases.set(id, {
    case: newCase,
    hospital,
    program: null,
    answers: [],
    requirements: [],
    documents: [],
    events: [],
  });
  return { ...newCase };
}

/**
 * Mirror a case that actually lives in Xano into the local safety net.
 *
 * Without this the fallback store only ever knows about cases it created
 * itself, so the moment a live Xano is configured every fixture fallback
 * (`markReadyForReview`, `attachProgram`, the GET /api/voice/case fallback)
 * fails with `Unknown case "<xano id>"`. Idempotent: an existing bundle wins,
 * which keeps it a no-op when the fixture store *is* the system of record.
 */
export function adoptCase(caseRow: Case, hospital: Hospital = DEMO_HOSPITAL): CaseBundle {
  const state = store();
  const existing = state.cases.get(caseRow.id);
  if (existing) return existing;
  const bundle: CaseBundle = {
    case: { ...caseRow },
    hospital: { ...hospital, name: hospital.name || DEMO_HOSPITAL.name },
    program: null,
    answers: [],
    requirements: [],
    documents: [],
    events: [],
  };
  state.cases.set(caseRow.id, bundle);
  return bundle;
}

/**
 * Best-effort local copy of an answer already written to Xano. Never throws —
 * a cold mirror must not fail the caller's turn.
 */
export function mirrorAnswer(caseId: Id, fieldId: string, input: SaveAnswerInput): void {
  try {
    saveAnswer(caseId, fieldId, input);
  } catch {
    /* the local net simply stays cold for this case */
  }
}

export function appendEvent(caseId: Id, event: NewCaseEvent): CaseEvent {
  const bundle = requireBundle(caseId);
  const record: CaseEvent = {
    id: nextId('evt'),
    case_id: caseId,
    timestamp: event.timestamp ?? nowIso(),
    actor: event.actor,
    event_type: event.event_type,
    message: event.message,
    metadata_json: event.metadata_json ?? null,
  };
  bundle.events.push(record);
  return { ...record };
}

export function attachProgram(caseId: Id, result: DiscoveryResult): Program {
  const bundle = requireBundle(caseId);
  const program: Program = {
    id: DEMO_PROGRAM_ID,
    hospital_id: bundle.hospital.id,
    name: DEMO_PROGRAM.name,
    policy_url: result.policy_url || DEMO_PROGRAM.policy_url,
    application_url: result.application_url || CEDARS_APPLICATION_PDF_URL,
    source_domain: result.verified_sources[0]?.source_domain ?? DEMO_PROGRAM.source_domain,
    effective_date: DEMO_PROGRAM.effective_date,
    retrieved_at: result.retrieved_at,
    verified: result.verified_sources.length > 0,
  };
  bundle.program = program;
  bundle.case.program_id = program.id;
  bundle.case.status = 'FORM_FOUND';
  bundle.case.updated_at = nowIso();
  if (!bundle.documents.some((doc) => doc.type === 'source_application')) {
    bundle.documents.push({
      id: nextId('doc'),
      case_id: caseId,
      type: 'source_application',
      source_url: program.application_url,
      generated_url: null,
      accessibility_status: 'not_applicable',
      version_hash: null,
    });
  }
  return { ...program };
}

export function saveAnswer(caseId: Id, fieldIdOrKey: string, input: SaveAnswerInput): Answer {
  const bundle = requireBundle(caseId);
  const field = resolveField(fieldIdOrKey);
  const fieldId = field ? field.fieldId : fieldIdOrKey.trim();
  const timestamp = nowIso();
  const existing = bundle.answers.find((answer) => answer.field_id === fieldId);

  const answer: Answer = existing
    ? Object.assign(existing, {
        value_json: input.value,
        source: input.source,
        confirmed: input.confirmed ?? true,
        updated_at: timestamp,
      })
    : {
        id: nextId('ans'),
        case_id: caseId,
        field_id: fieldId,
        value_json: input.value,
        source: input.source,
        confirmed: input.confirmed ?? true,
        updated_at: timestamp,
      };
  if (!existing) bundle.answers.push(answer);

  if (bundle.case.status === 'CREATED' || bundle.case.status === 'FORM_FOUND') {
    bundle.case.status = 'INTERVIEWING';
  }
  bundle.case.progress_percent = computeProgress(bundle).percent;
  bundle.case.updated_at = timestamp;
  return { ...answer };
}

/** Ensures the requirement rows exist, then returns the completeness summary. */
export function validateCase(caseId: Id): CompletenessSummary {
  const bundle = requireBundle(caseId);
  if (bundle.requirements.length === 0) {
    bundle.requirements.push(...defaultRequirements(caseId, nextId));
  }

  const answered = answeredFieldIds(bundle);
  const stepKey: Record<string, ProgressStepId> = {
    personal_information: 'personal_information',
    household_information: 'household',
    insurance_information: 'insurance',
    income_information: 'income',
  };
  for (const requirement of bundle.requirements) {
    if (requirement.type !== 'field') continue;
    const step = stepKey[requirement.key];
    if (!step) continue;
    const total = fieldCountForStep(step);
    requirement.status = answeredCountForStep(answered, step) >= total ? 'complete' : 'missing';
  }

  const summary = computeCompleteness(bundle);
  // Validating again after the document exists must not walk the case back.
  if (bundle.case.status !== 'READY_FOR_REVIEW') {
    bundle.case.status = summary.readyForReview ? 'VALIDATING' : 'INTERVIEWING';
  }
  bundle.case.progress_percent = computeProgress(bundle).percent;
  bundle.case.updated_at = nowIso();
  return summary;
}

export function saveDocument(caseId: Id, input: SaveDocumentInput): CaseDocument {
  const bundle = requireBundle(caseId);
  const existing = bundle.documents.find((doc) => doc.type === input.type);
  const document: CaseDocument = existing
    ? Object.assign(existing, {
        source_url: input.source_url ?? existing.source_url,
        generated_url: input.generated_url ?? existing.generated_url,
        accessibility_status: input.accessibility_status ?? existing.accessibility_status,
        version_hash: input.version_hash ?? existing.version_hash,
      })
    : {
        id: nextId('doc'),
        case_id: caseId,
        type: input.type,
        source_url: input.source_url ?? null,
        generated_url: input.generated_url ?? null,
        accessibility_status: input.accessibility_status ?? 'pending',
        version_hash: input.version_hash ?? null,
      };
  if (!existing) bundle.documents.push(document);
  bundle.case.updated_at = nowIso();
  return { ...document };
}

/**
 * Fixture stand-in for the Nutrient fill + autotag pipeline. Used only when the
 * Nutrient adapter is unavailable, so the voice call can still finish.
 */
export function markReadyForReview(caseId: Id): CaseDocument {
  const bundle = requireBundle(caseId);
  validateCase(caseId);
  const document = saveDocument(caseId, {
    type: 'filled_application',
    source_url: bundle.program?.application_url ?? CEDARS_APPLICATION_PDF_URL,
    generated_url: DEMO_FILLED_PDF_PATH,
    accessibility_status: 'processed',
    version_hash: `fixture-${caseId.toLowerCase()}-v1`,
  });
  bundle.case.status = 'READY_FOR_REVIEW';
  bundle.case.progress_percent = READY_FOR_REVIEW_PERCENT;
  bundle.case.updated_at = nowIso();
  return document;
}

/** Number of answers that map onto a real AcroForm field. */
export function filledFieldCount(caseId: Id): number {
  const bundle = getBundle(caseId);
  if (!bundle) return 0;
  const answered = answeredFieldIds(bundle);
  return INTERVIEW_PLAN.filter((field) => answered.has(field.fieldId)).length;
}
