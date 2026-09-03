/**
 * AccessForm — shared TypeScript contract.
 *
 * This file is the single source of truth every other module imports from.
 * It contains ONLY types and constants: no React, no fetch, no side effects,
 * no node imports. It must keep compiling standalone.
 *
 * Conventions
 * -----------
 * - Row types that mirror a live Xano table use snake_case property names,
 *   exactly as the table columns are defined in DATA_MODEL.md.
 * - Computed / UI-facing types (progress, completeness, voice) use camelCase.
 * - All ids cross the adapter boundary as strings. Xano's numeric primary keys
 *   are stringified by the Xano adapter; nothing downstream should assume
 *   a number.
 * - All timestamps are ISO-8601 strings (UTC).
 * - Money is a plain number of US dollars. Strings written into the PDF are
 *   pre-formatted WITHOUT a leading "$" because the Cedars form already
 *   prints the dollar sign next to the field.
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Every entity id, stringified at the adapter boundary. */
export type Id = string;

/** ISO-8601 timestamp, e.g. "2026-09-03T05:37:15.986Z". */
export type IsoTimestamp = string;

/** A value stored in `answers.value_json`. */
export type AnswerValue = string | number | boolean | null;

/* ------------------------------------------------------------------ */
/* Enum unions (DATA_MODEL.md)                                         */
/* ------------------------------------------------------------------ */

export type CaseStatus =
  | 'CREATED'
  | 'DISCOVERING'
  | 'FORM_FOUND'
  | 'INTERVIEWING'
  | 'VALIDATING'
  | 'GENERATING'
  | 'ACCESSIBILITY_PROCESSING'
  | 'READY_FOR_REVIEW'
  | 'BLOCKED';

export const CASE_STATUSES = [
  'CREATED',
  'DISCOVERING',
  'FORM_FOUND',
  'INTERVIEWING',
  'VALIDATING',
  'GENERATING',
  'ACCESSIBILITY_PROCESSING',
  'READY_FOR_REVIEW',
  'BLOCKED',
] as const satisfies readonly CaseStatus[];

export type RequirementStatus = 'complete' | 'missing' | 'not_applicable';

export const REQUIREMENT_STATUSES = [
  'complete',
  'missing',
  'not_applicable',
] as const satisfies readonly RequirementStatus[];

export type RequirementType = 'field' | 'attachment' | 'signature';

export const REQUIREMENT_TYPES = [
  'field',
  'attachment',
  'signature',
] as const satisfies readonly RequirementType[];

export type AnswerSource = 'voice' | 'manual' | 'document';

export const ANSWER_SOURCES = [
  'voice',
  'manual',
  'document',
] as const satisfies readonly AnswerSource[];

export type DocumentType =
  | 'source_application'
  | 'filled_application'
  | 'supporting_document';

export const DOCUMENT_TYPES = [
  'source_application',
  'filled_application',
  'supporting_document',
] as const satisfies readonly DocumentType[];

/**
 * Lifecycle of a document through `POST /accessibility/autotag`.
 * `processed` is the only state that may be described in UI copy as
 * "accessibility processed".
 */
export type AccessibilityStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'not_applicable';

export const ACCESSIBILITY_STATUSES = [
  'pending',
  'processing',
  'processed',
  'failed',
  'not_applicable',
] as const satisfies readonly AccessibilityStatus[];

export type EventActor = 'user' | 'voice_agent' | 'serpapi' | 'xano' | 'nutrient';

export const EVENT_ACTORS = [
  'user',
  'voice_agent',
  'serpapi',
  'xano',
  'nutrient',
] as const satisfies readonly EventActor[];

/** Field kinds normalized out of the real AcroForm into `form_schema.type`. */
export type FormFieldType =
  | 'text'
  | 'number'
  | 'currency'
  | 'date'
  | 'choice'
  | 'checkbox'
  | 'radio'
  | 'signature';

/* ------------------------------------------------------------------ */
/* Domain rows — the 8 live Xano tables                                */
/* ------------------------------------------------------------------ */

/** Xano table `hospitals`. */
export interface Hospital {
  id: Id;
  name: string;
  website: string;
  hcai_id: string;
}

/** Xano table `programs`. */
export interface Program {
  id: Id;
  hospital_id: Id;
  name: string;
  policy_url: string;
  application_url: string;
  source_domain: string;
  effective_date: string | null;
  retrieved_at: IsoTimestamp;
  verified: boolean;
}

/** Xano table `cases`. */
export interface Case {
  id: Id;
  patient_display_name: string;
  hospital_id: Id;
  program_id: Id | null;
  /** Outstanding hospital bill, in US dollars. */
  bill_amount: number;
  status: CaseStatus;
  /** 0-100, authoritative value computed by Xano. */
  progress_percent: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** Xano table `form_schema`. One row per question we may ask. */
export interface FormSchemaField {
  id: Id;
  program_id: Id;
  /** Exact AcroForm field name in the official PDF, e.g. "Annual household income:". */
  field_id: string;
  /** Human label as printed on the form. */
  label: string;
  /** Stable snake_case key used by voice + UI, e.g. "annual_household_income". */
  normalized_key: string;
  type: FormFieldType;
  required: boolean;
  /** How the voice agent should ask for it — never read the raw PDF label aloud. */
  conversational_prompt: string;
  /** Optional guard, e.g. "employment_status == 'Employed'". */
  dependency_rule: string | null;
  /** Target AcroForm field name for Instant JSON. Usually equal to `field_id`. */
  pdf_mapping: string;
}

/** Xano table `answers`. */
export interface Answer {
  id: Id;
  case_id: Id;
  /** Matches `FormSchemaField.field_id`. */
  field_id: string;
  value_json: AnswerValue;
  source: AnswerSource;
  confirmed: boolean;
  updated_at: IsoTimestamp;
}

/** Xano table `requirements`. */
export interface Requirement {
  id: Id;
  case_id: Id;
  /** Stable snake_case key, e.g. "proof_of_social_security_income". */
  key: string;
  label: string;
  type: RequirementType;
  status: RequirementStatus;
  evidence_url: string | null;
}

/**
 * Xano table `documents`.
 * Named `CaseDocument` rather than `Document` so it never shadows the DOM lib.
 */
export interface CaseDocument {
  id: Id;
  case_id: Id;
  type: DocumentType;
  /** Where the original came from (official HCAI/Cedars URL). */
  source_url: string | null;
  /** Where the produced artifact can be fetched from. */
  generated_url: string | null;
  accessibility_status: AccessibilityStatus;
  version_hash: string | null;
}

/** Xano table `events`. Drives the sponsor-visibility feed on /live. */
export interface CaseEvent {
  id: Id;
  case_id: Id;
  timestamp: IsoTimestamp;
  actor: EventActor;
  /** Machine key, e.g. "program_discovered", "missing_requirement_detected". */
  event_type: string;
  /** One short human sentence, e.g. "Official Cedars program found". */
  message: string;
  metadata_json: Record<string, unknown> | null;
}

/** Payload accepted by `POST /cases/:id/events`. */
export type NewCaseEvent = Omit<CaseEvent, 'id' | 'case_id' | 'timestamp'> & {
  timestamp?: IsoTimestamp;
};

/** Everything /live and /review need for one case, in a single read. */
export interface CaseBundle {
  case: Case;
  hospital: Hospital;
  program: Program | null;
  answers: Answer[];
  requirements: Requirement[];
  documents: CaseDocument[];
  events: CaseEvent[];
}

/* ------------------------------------------------------------------ */
/* Progress — the 8 application steps on /live                         */
/* ------------------------------------------------------------------ */

export type ProgressState = 'done' | 'active' | 'todo';

export type ProgressStepId =
  | 'program_found'
  | 'current_form'
  | 'personal_information'
  | 'household'
  | 'insurance'
  | 'income'
  | 'documents'
  | 'review';

/** Canonical order. The /live progress card renders exactly this sequence. */
export const PROGRESS_STEP_IDS = [
  'program_found',
  'current_form',
  'personal_information',
  'household',
  'insurance',
  'income',
  'documents',
  'review',
] as const satisfies readonly ProgressStepId[];

/** Display labels, verbatim from UI.md / mockups/02_live_call.png. */
export const PROGRESS_STEP_LABELS: Readonly<Record<ProgressStepId, string>> = {
  program_found: 'Program found',
  current_form: 'Current form',
  personal_information: 'Personal information',
  household: 'Household',
  insurance: 'Insurance',
  income: 'Income',
  documents: 'Documents',
  review: 'Review',
};

export interface ProgressStep {
  id: ProgressStepId;
  label: string;
  state: ProgressState;
}

/** Response of `GET /cases/:id/progress`. Xano is authoritative here. */
export interface CaseProgress {
  caseId: Id;
  status: CaseStatus;
  /** 0-100. */
  percent: number;
  /** Always 8 entries, in `PROGRESS_STEP_IDS` order. */
  steps: ProgressStep[];
  /** Answers saved so far — "12 of 17 answers" in the mockup. */
  answersSaved: number;
  answersExpected: number;
  /** Next thing the voice agent should ask for, or null when interviewing is done. */
  nextFieldId: string | null;
  nextPrompt: string | null;
}

/* ------------------------------------------------------------------ */
/* Completeness — /review                                              */
/* ------------------------------------------------------------------ */

/**
 * Response of `POST /cases/:id/validate`.
 *
 * `readyForReview` means "the application appears complete based on published
 * requirements". It NEVER means eligible, approved, submitted, or signed.
 */
export interface CompletenessSummary {
  /** 0-100, as shown in the completeness dial. */
  percent: number;
  requiredFieldsComplete: number;
  requiredFieldsTotal: number;
  /** Only requirements with status 'missing'. May be empty. */
  missingRequirements: Requirement[];
  readyForReview: boolean;
}

/* ------------------------------------------------------------------ */
/* SerpApi — official-source discovery                                 */
/* ------------------------------------------------------------------ */

export interface DiscoverProgramInput {
  /** e.g. "Cedars-Sinai Medical Center". */
  hospital: string;
  /** e.g. "financial_assistance". */
  intent: string;
  /** e.g. "California". */
  location?: string;
}

/** One SerpApi organic result, after domain allowlist verification. */
export interface DiscoveredSource {
  query: string;
  title: string;
  url: string;
  source_domain: string;
  /** True when `source_domain` is in `OFFICIAL_SOURCE_DOMAINS`. */
  verified: boolean;
}

/**
 * Shape of `cache/discovered_program.json` — the fixture and the live result
 * use the same keys so one can be swapped for the other.
 */
export interface DiscoveryResult {
  hospital: string;
  intent: string;
  retrieved_at: IsoTimestamp;
  searches_used: number;
  verified_sources: DiscoveredSource[];
  all_results: DiscoveredSource[];
  policy_url: string;
  application_url: string;
  from_cache: boolean;
}

/** Preference order from API_INTEGRATIONS.md. Index 0 is most trusted. */
export const OFFICIAL_SOURCE_DOMAINS = [
  'hcai.ca.gov',
  'api.hdc.hcai.ca.gov',
  'cedars-sinai.org',
] as const;

export const DISCOVERY_QUERIES = [
  'Cedars-Sinai financial assistance application',
  'Cedars-Sinai charity care application HCAI',
  'site:hcai.ca.gov Cedars-Sinai financial assistance',
] as const;

export interface SerpAdapter {
  /** Vapi tool `discover_program`. Falls back to the cached fixture in demo mode. */
  discoverProgram(input: DiscoverProgramInput): Promise<DiscoveryResult>;
}

/* ------------------------------------------------------------------ */
/* Xano — system of record                                             */
/* ------------------------------------------------------------------ */

export interface CreateCaseInput {
  patient_display_name: string;
  /** Resolved to a `hospitals` row by the adapter. */
  hospital_name: string;
  /** Outstanding bill in US dollars. */
  bill_amount: number;
  program_id?: Id | null;
}

export interface SaveAnswerInput {
  value: AnswerValue;
  source: AnswerSource;
  confirmed?: boolean;
}

export interface SaveDocumentInput {
  type: DocumentType;
  source_url?: string | null;
  generated_url?: string | null;
  accessibility_status?: AccessibilityStatus;
  version_hash?: string | null;
}

export interface XanoAdapter {
  /** Vapi tool `create_case` — POST /cases */
  createCase(input: CreateCaseInput): Promise<Case>;

  /** GET /cases/:id */
  getCase(caseId: Id): Promise<CaseBundle>;

  /** POST /cases/:id/events */
  appendEvent(caseId: Id, event: NewCaseEvent): Promise<CaseEvent>;

  /** Vapi tool `save_answer` — PUT /cases/:id/answers/:fieldId */
  saveAnswer(caseId: Id, fieldId: string, input: SaveAnswerInput): Promise<Answer>;

  /** Vapi tool `get_case_progress` — GET /cases/:id/progress */
  getCaseProgress(caseId: Id): Promise<CaseProgress>;

  /** Vapi tool `validate_case` — POST /cases/:id/validate */
  validateCase(caseId: Id): Promise<CompletenessSummary>;

  /** POST /programs/discovered */
  saveDiscoveredProgram(result: DiscoveryResult): Promise<Program>;

  /** Normalized questions for a program, in asking order. */
  getFormSchema(programId: Id): Promise<FormSchemaField[]>;

  /** Persist a generated/source document against the case. */
  saveDocument(caseId: Id, input: SaveDocumentInput): Promise<CaseDocument>;
}

/* ------------------------------------------------------------------ */
/* Nutrient — document layer                                           */
/* ------------------------------------------------------------------ */

/**
 * Verified live: each server key is locked to exactly one path and the base URL
 * is not configurable. Do not introduce base-URL env vars.
 */
export const NUTRIENT_BASE_URL = 'https://api.nutrient.io' as const;

export const NUTRIENT_ENDPOINTS = {
  /** Auth: NUTRIENT_DWS_PROCESSOR_API */
  build: 'https://api.nutrient.io/build',
  /** Auth: NUTRIENT_DATA_EXTRACTION_API */
  extractionParse: 'https://api.nutrient.io/extraction/parse',
  /** Auth: NUTRIENT_ACCESSIBILITY_API */
  accessibilityAutotag: 'https://api.nutrient.io/accessibility/autotag',
} as const;

export type NutrientEndpointName = keyof typeof NUTRIENT_ENDPOINTS;

/** Instant JSON constants — required literal values. */
export const INSTANT_JSON_FORMAT = 'https://pspdfkit.com/instant-json/v1' as const;
export const INSTANT_JSON_FIELD_TYPE = 'pspdfkit/form-field-value' as const;

export interface InstantJsonFormFieldValue {
  /** Exact AcroForm field name. */
  name: string;
  type: typeof INSTANT_JSON_FIELD_TYPE;
  v: 1;
  value: string;
}

export interface InstantJson {
  formFieldValues: InstantJsonFormFieldValue[];
  format: typeof INSTANT_JSON_FORMAT;
}

/**
 * The only /build instruction shape proven to fill the Cedars AcroForm.
 * `flatten` is REQUIRED — without it every value renders blank.
 * Multipart parts must be named exactly "document" (the PDF) and "instant".
 */
export interface NutrientBuildInstructions {
  parts: [{ file: 'document' }];
  actions: [{ type: 'applyInstantJson'; file: 'instant' }, { type: 'flatten' }];
}

export const NUTRIENT_BUILD_INSTRUCTIONS: NutrientBuildInstructions = {
  parts: [{ file: 'document' }],
  actions: [{ type: 'applyInstantJson', file: 'instant' }, { type: 'flatten' }],
};

/** Multipart part names for POST /build. */
export const NUTRIENT_BUILD_PART_DOCUMENT = 'document' as const;
export const NUTRIENT_BUILD_PART_INSTANT = 'instant' as const;

/** One AcroForm field as read off the official PDF (spike/cedars_form_fields.json). */
export interface PdfFormFieldDescriptor {
  field_id: string;
  type: 'text' | 'button';
  /** Export values for button/radio groups; empty for text fields. */
  states: string[];
}

export interface ExtractedElementBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One element returned by POST /extraction/parse. */
export interface ExtractedElement {
  type: string;
  text: string;
  page: number;
  bounds: ExtractedElementBounds | null;
  confidence: number | null;
  readingOrder: number | null;
}

export interface ExtractedForm {
  sourceUrl: string;
  pageCount: number;
  elements: ExtractedElement[];
  fields: PdfFormFieldDescriptor[];
}

export interface ExtractFormInput {
  /** Remote PDF to fetch, or supply `pdfBytes` directly. */
  pdfUrl?: string;
  pdfBytes?: Uint8Array;
}

export interface FillFormInput {
  pdfUrl?: string;
  pdfBytes?: Uint8Array;
  instantJson: InstantJson;
}

export interface FilledDocument {
  pdfBytes: Uint8Array;
  byteLength: number;
  versionHash: string;
}

export interface TaggedDocument {
  pdfBytes: Uint8Array;
  byteLength: number;
  accessibilityStatus: AccessibilityStatus;
}

export interface FinalizeDocumentInput {
  case_id: Id;
  /** Defaults to the case's program application_url. */
  source_url?: string;
}

/** Result of the fill + autotag pipeline, already persisted in Xano. */
export interface FinalizedDocument {
  caseId: Id;
  /** URL the Nutrient Viewer on /review loads. */
  documentUrl: string;
  accessibilityStatus: AccessibilityStatus;
  versionHash: string;
  fieldsFilled: number;
  document: CaseDocument;
}

export interface NutrientAdapter {
  /** POST /extraction/parse */
  extractFormStructure(input: ExtractFormInput): Promise<ExtractedForm>;

  /** POST /build with applyInstantJson + flatten. */
  fillForm(input: FillFormInput): Promise<FilledDocument>;

  /** POST /accessibility/autotag */
  autotag(pdfBytes: Uint8Array): Promise<TaggedDocument>;

  /** Vapi tool `finalize_document` — fill, autotag, persist, return viewer URL. */
  finalizeDocument(input: FinalizeDocumentInput): Promise<FinalizedDocument>;
}

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

export type VoiceState = 'listening' | 'thinking' | 'speaking' | 'paused' | 'ended';

export const VOICE_STATES = [
  'listening',
  'thinking',
  'speaking',
  'paused',
  'ended',
] as const satisfies readonly VoiceState[];

/** Display labels for the voice-state indicator on /live. */
export const VOICE_STATE_LABELS: Readonly<Record<VoiceState, string>> = {
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  paused: 'Paused',
  ended: 'Call ended',
};

/** The six tools exposed to the voice agent (API_INTEGRATIONS.md §4). */
export const VAPI_TOOL_NAMES = [
  'create_case',
  'discover_program',
  'save_answer',
  'get_case_progress',
  'validate_case',
  'finalize_document',
] as const;

export type VapiToolName = (typeof VAPI_TOOL_NAMES)[number];

/** Arguments the voice agent sends for `save_answer`. */
export interface SaveAnswerToolInput {
  case_id: Id;
  /** Exact AcroForm field name, or the normalized_key — adapter resolves either. */
  field_id: string;
  value: AnswerValue;
  source?: AnswerSource;
  confirmed?: boolean;
}

export interface CaseIdToolInput {
  case_id: Id;
}

/** Server-side handlers, keyed by the exact tool names Vapi will call. */
export interface VoiceToolHandlers {
  create_case(args: CreateCaseInput): Promise<Case>;
  discover_program(args: DiscoverProgramInput): Promise<DiscoveryResult>;
  save_answer(args: SaveAnswerToolInput): Promise<Answer>;
  get_case_progress(args: CaseIdToolInput): Promise<CaseProgress>;
  validate_case(args: CaseIdToolInput): Promise<CompletenessSummary>;
  finalize_document(args: FinalizeDocumentInput): Promise<FinalizedDocument>;
}

export type VoiceSpeaker = 'patient' | 'agent';

export interface TranscriptTurn {
  id: string;
  speaker: VoiceSpeaker;
  text: string;
  timestamp: IsoTimestamp;
  /** False while the utterance is still being transcribed. */
  final: boolean;
}

export interface VoiceToolCall {
  id: string;
  name: VapiToolName;
  args: Record<string, unknown>;
}

export type VoiceEvent =
  | { kind: 'state'; state: VoiceState }
  | { kind: 'transcript'; turn: TranscriptTurn }
  | { kind: 'tool_call'; call: VoiceToolCall }
  | { kind: 'tool_result'; callId: string; name: VapiToolName; ok: boolean }
  | { kind: 'case_event'; event: CaseEvent }
  | { kind: 'error'; message: string };

export interface StartVoiceSessionOptions {
  caseId?: Id;
  /** Skip Vapi entirely and replay the scripted Jane conversation. */
  simulated?: boolean;
}

export interface VoiceSession {
  sessionId: string;
  caseId: Id;
  simulated: boolean;
  startedAt: IsoTimestamp;
}

export interface VoiceAdapter {
  start(options?: StartVoiceSessionOptions): Promise<VoiceSession>;
  /** Escape key and the visible Pause button both call this. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  end(): Promise<void>;
  getState(): VoiceState;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: VoiceEvent) => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Official Cedars sources (verified live)                             */
/* ------------------------------------------------------------------ */

export const CEDARS_POLICY_URL =
  'https://hcai.ca.gov/affordability/hospital-billing-policies/cedars-sinai-medical-center/' as const;

/** Verified live: 394,890 bytes, 101 AcroForm fields (90 text, 9 button groups). */
export const CEDARS_APPLICATION_PDF_URL =
  'https://api.hdc.hcai.ca.gov/Public/Extract/Attachment?id=1b7ee017-9db0-4a44-b3dc-a39c5986f24e' as const;

export const CEDARS_APPLICATION_FIELD_COUNT = 101 as const;

/* ------------------------------------------------------------------ */
/* Demo fixture — Jane                                                 */
/* ------------------------------------------------------------------ */

export const DEMO_CASE_ID: Id = 'AF-001';
export const DEMO_HOSPITAL_ID: Id = 'hosp_cedars_sinai';
export const DEMO_PROGRAM_ID: Id = 'prog_cedars_financial_assistance';

const DEMO_CREATED_AT: IsoTimestamp = '2026-09-03T05:31:00.000Z';
const DEMO_UPDATED_AT: IsoTimestamp = '2026-09-03T05:46:00.000Z';
const DEMO_RETRIEVED_AT: IsoTimestamp = '2026-09-03T05:37:15.986Z';

export const DEMO_HOSPITAL: Hospital = {
  id: DEMO_HOSPITAL_ID,
  name: 'Cedars-Sinai Medical Center',
  website: 'https://www.cedars-sinai.org',
  hcai_id: '106190522',
};

export const DEMO_PROGRAM: Program = {
  id: DEMO_PROGRAM_ID,
  hospital_id: DEMO_HOSPITAL_ID,
  name: 'Cedars-Sinai Financial Assistance Application',
  policy_url: CEDARS_POLICY_URL,
  application_url: CEDARS_APPLICATION_PDF_URL,
  source_domain: 'api.hdc.hcai.ca.gov',
  effective_date: '2025-01-01',
  retrieved_at: DEMO_RETRIEVED_AT,
  verified: true,
};

/**
 * Jane: 68, low vision, lives alone, retired, Medicare,
 * Social Security $2,050/month ($24,600/yr), $7,800 Cedars bill, household of 1.
 * Deliberately missing: proof of Social Security income, applicant signature.
 */
export const DEMO_CASE: Case = {
  id: DEMO_CASE_ID,
  patient_display_name: 'Jane Doe',
  hospital_id: DEMO_HOSPITAL_ID,
  program_id: DEMO_PROGRAM_ID,
  bill_amount: 7800,
  status: 'READY_FOR_REVIEW',
  progress_percent: 86,
  created_at: DEMO_CREATED_AT,
  updated_at: DEMO_UPDATED_AT,
};

/**
 * The 26 required answers Jane gives on the call.
 *
 * `field_id` values are the exact AcroForm field names from the official PDF
 * (spike/cedars_form_fields.json) so this array can be mapped straight into
 * Instant JSON. Currency values carry NO "$" — the form already prints one.
 * Monthly expense lines sum to the 1,850 total.
 */
export const DEMO_ANSWERS: Answer[] = [
  { id: 'ans_01', case_id: DEMO_CASE_ID, field_id: 'Patient name', value_json: 'Jane Doe', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_02', case_id: DEMO_CASE_ID, field_id: 'Date of birth', value_json: '01/15/1958', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_03', case_id: DEMO_CASE_ID, field_id: 'Home address', value_json: '1234 Beverly Blvd, Apt 5', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_04', case_id: DEMO_CASE_ID, field_id: 'City', value_json: 'Los Angeles', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_05', case_id: DEMO_CASE_ID, field_id: 'State', value_json: 'CA', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_06', case_id: DEMO_CASE_ID, field_id: 'ZIP code', value_json: '90048', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_07', case_id: DEMO_CASE_ID, field_id: 'Home phone number', value_json: '(323) 555-0142', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_08', case_id: DEMO_CASE_ID, field_id: 'Preferred method of contact', value_json: 'Home phone', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_09', case_id: DEMO_CASE_ID, field_id: 'Marital status:', value_json: 'Single', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_10', case_id: DEMO_CASE_ID, field_id: 'as reported on your taxes', value_json: '1', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_11', case_id: DEMO_CASE_ID, field_id: 'Employment status', value_json: 'Retired', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_12', case_id: DEMO_CASE_ID, field_id: 'Insurer', value_json: 'Medicare', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_13', case_id: DEMO_CASE_ID, field_id: 'Policyholder', value_json: 'Jane Doe', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_14', case_id: DEMO_CASE_ID, field_id: 'Have you applied for MediCalMedicaid', value_json: 'No', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_15', case_id: DEMO_CASE_ID, field_id: 'Have you been screened for MediCalMedicaid eligibility', value_json: 'No', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_16', case_id: DEMO_CASE_ID, field_id: 'Are you eligible for any health insurance coverage?', value_json: 'Yes', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_17', case_id: DEMO_CASE_ID, field_id: 'Annual household income:', value_json: '24,600', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_18', case_id: DEMO_CASE_ID, field_id: 'Gross income', value_json: '2,050', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_19', case_id: DEMO_CASE_ID, field_id: 'Rent or mortgage', value_json: '950', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_20', case_id: DEMO_CASE_ID, field_id: 'Utilities and telephone', value_json: '180', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_21', case_id: DEMO_CASE_ID, field_id: 'Food', value_json: '320', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_22', case_id: DEMO_CASE_ID, field_id: 'Medical and dental', value_json: '230', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_23', case_id: DEMO_CASE_ID, field_id: 'Transportation and auto (insurance, gas, repairs, lease)', value_json: '110', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_24', case_id: DEMO_CASE_ID, field_id: 'Clothing and laundry', value_json: '60', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_25', case_id: DEMO_CASE_ID, field_id: 'Total monthly expenses', value_json: '1,850', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
  { id: 'ans_26', case_id: DEMO_CASE_ID, field_id: 'Outstanding medical debt at Cedars-Sinai or Huntington Health', value_json: '7,800', source: 'voice', confirmed: true, updated_at: DEMO_UPDATED_AT },
];

/**
 * Five requirement groups complete, two deliberately missing.
 * Never mark the signature complete — AccessForm does not sign anything.
 */
export const DEMO_REQUIREMENTS: Requirement[] = [
  { id: 'req_personal', case_id: DEMO_CASE_ID, key: 'personal_information', label: 'Personal information', type: 'field', status: 'complete', evidence_url: null },
  { id: 'req_household', case_id: DEMO_CASE_ID, key: 'household_information', label: 'Household information', type: 'field', status: 'complete', evidence_url: null },
  { id: 'req_insurance', case_id: DEMO_CASE_ID, key: 'insurance_information', label: 'Insurance information', type: 'field', status: 'complete', evidence_url: null },
  { id: 'req_income', case_id: DEMO_CASE_ID, key: 'income_information', label: 'Income information', type: 'field', status: 'complete', evidence_url: null },
  { id: 'req_expenses', case_id: DEMO_CASE_ID, key: 'monthly_expenses', label: 'Monthly expenses', type: 'field', status: 'complete', evidence_url: null },
  { id: 'req_proof_income', case_id: DEMO_CASE_ID, key: 'proof_of_social_security_income', label: 'Proof of Social Security income', type: 'attachment', status: 'missing', evidence_url: null },
  { id: 'req_signature', case_id: DEMO_CASE_ID, key: 'applicant_signature', label: 'Signature of person applying for financial assistance', type: 'signature', status: 'missing', evidence_url: null },
];

export const DEMO_MISSING_REQUIREMENTS: Requirement[] = DEMO_REQUIREMENTS.filter(
  (r) => r.status === 'missing',
);

/** Local fallback the Viewer loads when Nutrient output is unavailable. */
export const DEMO_FILLED_PDF_PATH = '/fixtures/cedars-application-filled.pdf' as const;

export const DEMO_DOCUMENTS: CaseDocument[] = [
  {
    id: 'doc_source',
    case_id: DEMO_CASE_ID,
    type: 'source_application',
    source_url: CEDARS_APPLICATION_PDF_URL,
    generated_url: null,
    accessibility_status: 'not_applicable',
    version_hash: null,
  },
  {
    id: 'doc_filled',
    case_id: DEMO_CASE_ID,
    type: 'filled_application',
    source_url: CEDARS_APPLICATION_PDF_URL,
    generated_url: DEMO_FILLED_PDF_PATH,
    accessibility_status: 'processed',
    version_hash: 'demo-af-001-v1',
  },
];

/** Sponsor-visibility feed shown on /live, in chronological order. */
export const DEMO_EVENTS: CaseEvent[] = [
  { id: 'evt_01', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:31:04.000Z', actor: 'user', event_type: 'call_started', message: 'Call started', metadata_json: null },
  { id: 'evt_02', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:31:22.000Z', actor: 'serpapi', event_type: 'program_discovered', message: 'Official Cedars program found', metadata_json: { policy_url: CEDARS_POLICY_URL } },
  { id: 'evt_03', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:31:29.000Z', actor: 'serpapi', event_type: 'source_verified', message: 'HCAI source verified', metadata_json: { source_domain: 'hcai.ca.gov' } },
  { id: 'evt_04', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:31:48.000Z', actor: 'nutrient', event_type: 'form_extracted', message: 'Form structure extracted', metadata_json: { fields: CEDARS_APPLICATION_FIELD_COUNT } },
  { id: 'evt_05', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:32:01.000Z', actor: 'xano', event_type: 'case_created', message: 'Case created', metadata_json: { case_id: DEMO_CASE_ID } },
  { id: 'evt_06', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:38:12.000Z', actor: 'xano', event_type: 'answer_saved', message: 'Household answer saved', metadata_json: { field_id: 'as reported on your taxes' } },
  { id: 'evt_07', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:41:37.000Z', actor: 'xano', event_type: 'answer_saved', message: 'Income answer saved', metadata_json: { field_id: 'Annual household income:' } },
  { id: 'evt_08', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:43:02.000Z', actor: 'xano', event_type: 'missing_requirement_detected', message: 'Missing proof of income detected', metadata_json: { key: 'proof_of_social_security_income' } },
  { id: 'evt_09', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:45:10.000Z', actor: 'nutrient', event_type: 'document_generated', message: 'Completed PDF generated', metadata_json: { fields_filled: 26 } },
  { id: 'evt_10', case_id: DEMO_CASE_ID, timestamp: '2026-09-03T05:45:52.000Z', actor: 'nutrient', event_type: 'accessibility_processed', message: 'Accessibility processing complete', metadata_json: { accessibility_status: 'processed' } },
];

/** Mid-call snapshot matching mockups/02_live_call.png (Income active, 72%). */
export const DEMO_PROGRESS_IN_CALL: CaseProgress = {
  caseId: DEMO_CASE_ID,
  status: 'INTERVIEWING',
  percent: 72,
  steps: [
    { id: 'program_found', label: PROGRESS_STEP_LABELS.program_found, state: 'done' },
    { id: 'current_form', label: PROGRESS_STEP_LABELS.current_form, state: 'done' },
    { id: 'personal_information', label: PROGRESS_STEP_LABELS.personal_information, state: 'done' },
    { id: 'household', label: PROGRESS_STEP_LABELS.household, state: 'done' },
    { id: 'insurance', label: PROGRESS_STEP_LABELS.insurance, state: 'done' },
    { id: 'income', label: PROGRESS_STEP_LABELS.income, state: 'active' },
    { id: 'documents', label: PROGRESS_STEP_LABELS.documents, state: 'todo' },
    { id: 'review', label: PROGRESS_STEP_LABELS.review, state: 'todo' },
  ],
  answersSaved: 12,
  answersExpected: 17,
  nextFieldId: 'Gross income',
  nextPrompt: 'Is Social Security your only source of income?',
};

/** End-of-call snapshot used by /review. */
export const DEMO_PROGRESS_COMPLETE: CaseProgress = {
  caseId: DEMO_CASE_ID,
  status: 'READY_FOR_REVIEW',
  percent: 86,
  steps: PROGRESS_STEP_IDS.map((id) => ({
    id,
    label: PROGRESS_STEP_LABELS[id],
    state: id === 'review' ? ('active' as ProgressState) : ('done' as ProgressState),
  })),
  answersSaved: 26,
  answersExpected: 26,
  nextFieldId: null,
  nextPrompt: null,
};

/**
 * 26/26 required fields complete; two non-field requirements still outstanding.
 * `readyForReview` is true — the application appears complete based on the
 * published requirements. It is not submitted, signed, or approved.
 */
export const DEMO_COMPLETENESS: CompletenessSummary = {
  percent: 86,
  requiredFieldsComplete: 26,
  requiredFieldsTotal: 26,
  missingRequirements: DEMO_MISSING_REQUIREMENTS,
  readyForReview: true,
};

export const DEMO_CASE_BUNDLE: CaseBundle = {
  case: DEMO_CASE,
  hospital: DEMO_HOSPITAL,
  program: DEMO_PROGRAM,
  answers: DEMO_ANSWERS,
  requirements: DEMO_REQUIREMENTS,
  documents: DEMO_DOCUMENTS,
  events: DEMO_EVENTS,
};

/* ------------------------------------------------------------------ */
/* Safe copy                                                           */
/* ------------------------------------------------------------------ */

/**
 * Approved status wording. Never render "submitted", "approved", "eligible",
 * or "signed" anywhere in the UI.
 */
export const SAFE_COPY = {
  readyForReview: 'Ready for review',
  notSubmitted: 'Not submitted. The hospital decides approval.',
  completenessBasis:
    'This application appears complete based on the published requirements.',
  eligibilityDisclaimer:
    'AccessForm cannot determine eligibility. Cedars-Sinai makes that decision.',
  missingWarningTitle: 'One thing left',
  missingProofOfIncome:
    'Proof of Social Security income is still required before submission.',
  missingSignature: 'Your signature is still required before submission.',
} as const;

/* ------------------------------------------------------------------ */
/* Design tokens (assets/design-tokens.json)                           */
/* ------------------------------------------------------------------ */

export const DESIGN_TOKENS = {
  colors: {
    background: '#F7F5F0',
    surface: '#FFFFFF',
    text: '#171717',
    mutedText: '#66635F',
    accent: '#2F6B5F',
    accentSoft: '#E6F0EC',
    border: '#D8D3CB',
    success: '#2E7D57',
    warning: '#A85D22',
    warningBackground: '#FFF1E6',
  },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    bodyMinPx: 18,
    buttonMinPx: 18,
    headlineDesktopPx: 54,
  },
  layout: {
    maxWidthPx: 1440,
    pagePaddingDesktopPx: 72,
    cardRadiusPx: 24,
    buttonMinHeightPx: 52,
  },
} as const;

export type DesignTokens = typeof DESIGN_TOKENS;
export type DesignColorName = keyof DesignTokens['colors'];
