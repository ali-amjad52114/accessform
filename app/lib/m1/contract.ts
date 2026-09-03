/**
 * AccessForm — M1 contract ("product spine").
 *
 * Everything six parallel builders need to agree on, in one module:
 * enums, row types, the eight voice tools (names, JSON schemas, inputs,
 * results), the binding module interfaces (file paths + signatures), the Xano
 * endpoint request/response shapes, the catalog seed shape, the SMS template,
 * and the section-driven progress model.
 *
 * The prose spec is docs/M1_CONTRACT.md. When the two disagree, THIS FILE wins
 * for shapes and the doc wins for behaviour.
 *
 * Rules (same as ../contract.ts): types and constants only. No React, no
 * fetch, no node imports, no side effects. `import type` only from
 * ../contract so the re-export cycle (contract.ts -> m1/contract.ts) is erased
 * at compile time.
 *
 * Conventions
 * -----------
 * - snake_case for anything that crosses the Xano or Vapi boundary.
 * - camelCase only for the pre-existing UI-facing types (CaseProgress etc.).
 * - Ids are strings. Xano's numeric PKs are stringified at the adapter.
 * - Timestamps in TypeScript are ISO-8601. Xano stores epoch milliseconds;
 *   adapters convert in both directions.
 * - Xano text columns come back as "" — never null. Adapters map "" -> null
 *   for `| null` fields and null -> "" on the way in.
 */

import type {
  AccessibilityStatus,
  Answer,
  AnswerValue,
  CaseStatus,
  FormFieldType,
  FormSchemaField,
  Id,
  IsoTimestamp,
  Program,
  ProgressState,
  Requirement,
} from '../contract';

/* ------------------------------------------------------------------ */
/* 1. Enums                                                            */
/* ------------------------------------------------------------------ */

/** What the caller needs. Resolved from their own words by resolveNeed(). */
export type NeedCategory =
  | 'hospital_financial_assistance'
  | 'paratransit'
  | 'disability_accommodation'
  | 'scholarship_financial_aid'
  | 'benefits'
  | 'appointment'
  | 'other';

export const NEED_CATEGORIES = [
  'hospital_financial_assistance',
  'paratransit',
  'disability_accommodation',
  'scholarship_financial_aid',
  'benefits',
  'appointment',
  'other',
] as const satisfies readonly NeedCategory[];

/** Spoken/UI label per category. Never say "eligible" or "approved" here. */
export const NEED_CATEGORY_LABELS: Readonly<Record<NeedCategory, string>> = {
  hospital_financial_assistance: 'Hospital financial assistance',
  paratransit: 'Paratransit (door-to-door transit) application',
  disability_accommodation: 'Disability accommodation',
  scholarship_financial_aid: 'Scholarship or financial aid',
  benefits: 'Public benefits',
  appointment: 'Appointment',
  other: 'Something else',
};

/**
 * What kind of thing the official application is. M1 fills `fillable_pdf`
 * only; the other three are delivered honestly (link/address + checklist).
 */
export type FormKind = 'fillable_pdf' | 'flat_pdf' | 'online_form' | 'in_person';

export const FORM_KINDS = [
  'fillable_pdf',
  'flat_pdf',
  'online_form',
  'in_person',
] as const satisfies readonly FormKind[];

export type OrganizationKind = 'hospital' | 'transit_agency' | 'college' | 'agency' | 'other';

export const ORGANIZATION_KINDS = [
  'hospital',
  'transit_agency',
  'college',
  'agency',
  'other',
] as const satisfies readonly OrganizationKind[];

/** Categories the M1 catalog covers. Live discovery covers the rest. */
export const CATALOG_CATEGORIES: readonly NeedCategory[] = [
  'hospital_financial_assistance',
  'paratransit',
  'disability_accommodation',
];

/* ------------------------------------------------------------------ */
/* 2. Rows                                                             */
/* ------------------------------------------------------------------ */

/** Xano table `organizations` (new in M1). `hospitals` stays for Cedars. */
export interface Organization {
  id: Id;
  /** Canonical display name, unique. Upsert key of POST /organizations. */
  name: string;
  kind: OrganizationKind;
  /** Registrable domain, lowercase, no scheme, no www — e.g. "accessla.org". */
  domain: string;
  /** Free text, e.g. "Los Angeles County, CA". "" when unknown. */
  region: string;
  /** Homepage; "" when unknown. */
  website: string;
  created_at: IsoTimestamp;
}

/**
 * The M1 columns on `programs`. They are OPTIONAL on the base `Program`
 * interface (so pre-M1 code keeps compiling) and REQUIRED on
 * `ResolvedProgram`, which is what every M1 module returns.
 */
export interface ProgramM1Columns {
  category: NeedCategory;
  form_kind: FormKind;
  /** FK to `organizations`. null only for legacy rows that have hospital_id. */
  organization_id: Id | null;
  /** Plain-language "how to hand this in", spoken and texted. "" if unknown. */
  submission_instructions: string;
  /** Number of AcroForm fields on the application PDF; 0 for non-PDF kinds. */
  field_count: number;
  /** Free text region the program serves, e.g. "San Francisco, CA". */
  region: string;
  /** Page count of the PDF; 0 for non-PDF kinds. */
  page_count: number;
  /** First 16 hex chars of the sha256 of the verified PDF bytes; "" if none. */
  sha256: string;
}

/** A program with every M1 column populated. */
export type ResolvedProgram = Program & ProgramM1Columns;

/** The M1 columns on `form_schema`. Optional on the base, required here. */
export interface FormSchemaM1Columns {
  /**
   * Interview section this question belongs to, snake_case, e.g.
   * "personal_information", "trip_needs", "mobility_aids". Sections are the
   * progress model on /live. For Cedars this equals the legacy `group_key`.
   */
  section: string;
  /** 1-based asking order across the whole form. Unique per program. */
  order: number;
  /**
   * For button/radio/choice fields: the exact export values the PDF accepts,
   * WITHOUT the leading "/" (e.g. ["Single", "Married"]). Empty for text.
   * The answer mapper may only emit one of these for such a field.
   */
  options: string[];
  /** Exact AcroForm field name to write. Equals `field_id` for fillable PDFs. */
  pdf_field_name: string;
}

/** A form_schema row as written by understandForm() and read by everything else. */
export type M1FormSchemaField = FormSchemaField & FormSchemaM1Columns;

/** The M1 columns on `cases`. Optional on the base `Case`. */
export interface CaseM1Columns {
  need_category: NeedCategory;
  /** What the caller said about where they are, verbatim-ish. "" if unknown. */
  location: string;
  /** E.164 when known ("+14155550123"), else "". Never spoken back in full. */
  caller_phone: string;
  /** The caller's own words, first turn. Never read back to them. */
  situation_text: string;
  delivery_status: CaseDeliveryStatus;
  organization_id: Id | null;
}

export type CaseDeliveryStatus = 'none' | 'queued' | 'sent' | 'failed';

export const CASE_DELIVERY_STATUSES = [
  'none',
  'queued',
  'sent',
  'failed',
] as const satisfies readonly CaseDeliveryStatus[];

/**
 * - sms    the summary text with the signed link (send_summary)
 * - email  the filled application emailed to the program's published intake
 *          address after the person's explicit approval (POST /api/delivery/email).
 *          Requires the Xano `deliveries.channel` enum to include "email".
 */
export type DeliveryChannel = 'sms' | 'email';

export const DELIVERY_CHANNELS = ['sms', 'email'] as const satisfies readonly DeliveryChannel[];

/**
 * - queued   row written, provider not yet called (or call in flight)
 * - sent     provider accepted the message (Twilio returned a SID)
 * - failed   provider rejected it, or no `to` number was available
 * - skipped  delivery intentionally not attempted (demo mode, or the caller
 *            declined SMS). Never reported to the caller as "sent".
 */
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'skipped';

export const DELIVERY_STATUSES = [
  'queued',
  'sent',
  'failed',
  'skipped',
] as const satisfies readonly DeliveryStatus[];

/** Xano table `deliveries` (new in M1). One row per send attempt. */
export interface Delivery {
  id: Id;
  case_id: Id;
  channel: DeliveryChannel;
  /** E.164 destination. */
  to: string;
  /** The exact body sent. <= SMS_MAX_CHARS, no personal data. */
  message: string;
  /** Absolute URL to the filled document (or the official form for non-PDF kinds). */
  document_url: string;
  status: DeliveryStatus;
  /** Twilio Message SID ("SM..."), or "" until sent. */
  provider_id: string;
  /** Provider error text when status = failed; "" otherwise. */
  error: string;
  created_at: IsoTimestamp;
}

/* ------------------------------------------------------------------ */
/* 3. Judgment results                                                  */
/* ------------------------------------------------------------------ */

/** Output of resolveNeed() and of the resolve_need tool. */
export interface NeedResolution {
  category: NeedCategory;
  /** Organization the caller NAMED, normalized ("Cedars-Sinai Medical Center"). Absent if none named. */
  organization?: string;
  /** Location the caller gave or that was passed in. Absent if none. */
  location?: string;
  /** 0..1. Below NEED_CONFIDENCE_FLOOR the tool must ask `clarifying_question`. */
  confidence: number;
  /** One short spoken question, present only when the resolver is unsure. */
  clarifying_question?: string;
}

/** Below this the agent asks the clarifying question instead of proceeding. */
export const NEED_CONFIDENCE_FLOOR = 0.6 as const;

/** One candidate URL discovery looked at. Surfaced for the /live feed. */
export interface ProgramCandidate {
  title: string;
  url: string;
  source_domain: string;
  /** True only when the domain passed the allowlist for this organization/category. */
  verified: boolean;
  /** Short reason from the OpenAI verdict, e.g. "PDF is the eligibility application". */
  reason?: string;
}

/**
 * Output of resolveProgram() and of the discover_program tool.
 *
 * INVARIANT: `found === true` implies `program` is present, `program.verified`
 * is true and `program.application_url` is an absolute https URL from a
 * verified official source for the SAME organization the caller named.
 * Anything else is `found: false` with a `reason` the agent can say aloud.
 */
export interface ProgramResolution {
  found: boolean;
  program?: ResolvedProgram;
  /** Plain sentence for the caller when found=false. */
  reason?: string;
  /** What was considered, verified or not. May be empty. */
  candidates?: ProgramCandidate[];
  /** SerpApi credits spent by this call (0 for a catalog hit). */
  searches_used?: number;
  /** True when the answer came from Xano `programs` without a live search. */
  from_catalog?: boolean;
}

/** One interview section's progress, computed by Xano. */
export interface InterviewSection {
  key: string;
  label: string;
  order: number;
  field_count: number;
  answered_count: number;
  state: ProgressState;
}

/** Progress as Xano reports it with every next_question. */
export interface InterviewProgress {
  /** Required fields answered (non-blank). */
  answered: number;
  /** Required fields total. */
  total: number;
  /** 0-100, Xano's number. Never recomputed in the app. */
  percent: number;
  /** 0-based index of the section the next question is in; equals section_count when done. */
  section_index: number;
  section_count: number;
  sections: InterviewSection[];
}

/** Output of nextQuestion() and of the get_next_question tool (null when done). */
export interface NextQuestion {
  /** Exact `form_schema.field_id` to pass back to save_answer. */
  field_id: string;
  /** The spoken question (form_schema.conversational_prompt). */
  prompt: string;
  /** form_schema.section */
  section: string;
  progress: InterviewProgress;
  /** Extra hints for the agent; optional so a minimal Xano response still validates. */
  type?: FormFieldType;
  options?: string[];
  required?: boolean;
  /** Why the form asks, spoken only if the caller asks. */
  why?: string;
}

/** One value the deterministic filler writes. */
export interface MappedValue {
  /** Must be one of the schema's `pdf_field_name`s — never invented. */
  pdf_field_name: string;
  /** Text as it will appear in the PDF; for option fields, exactly one of `options`. */
  value: string;
}

/** Output of mapAnswers(). */
export interface MappedAnswers {
  values: MappedValue[];
  /** `Answer.field_id`s that could not be placed on any field. Reported, never dropped silently. */
  unmapped: string[];
}

/* ------------------------------------------------------------------ */
/* 4. The eight voice tools                                            */
/* ------------------------------------------------------------------ */

/**
 * Exact names Vapi calls. `get_case_progress` is kept as an alias of
 * `get_next_question` so the Cedars regression (and the provisioned
 * assistant) keep working. The legacy `VAPI_TOOL_NAMES` tuple in ../contract
 * is unchanged and is the OLD six-tool set; new code uses this one.
 */
export const M1_VOICE_TOOL_NAMES = [
  'create_case',
  'resolve_need',
  'discover_program',
  'get_next_question',
  'save_answer',
  'validate_case',
  'finalize_document',
  'send_summary',
  'get_case_progress',
] as const;

export type M1VoiceToolName = (typeof M1_VOICE_TOOL_NAMES)[number];

/** Tool names that must be listed on the Vapi assistant (alias included). */
export const M1_VAPI_ASSISTANT_TOOLS: readonly M1VoiceToolName[] = M1_VOICE_TOOL_NAMES;

/* ---- inputs (what Vapi sends, after coercion) ---- */

export interface CreateCaseToolInput {
  /** E.164 when the call has a caller id; omitted for browser calls. */
  caller_phone?: string;
  /** The caller's own words. Required. */
  situation_text: string;
  /** City/county/state if already known. */
  location?: string;
}

export interface ResolveNeedToolInput {
  case_id: Id;
  situation_text: string;
}

export interface DiscoverProgramToolInput {
  case_id: Id;
  category: NeedCategory;
  /** Exact organization the caller named, if any. Never guessed by the agent. */
  organization?: string;
  /** Required: discovery is regional. */
  location: string;
}

export interface GetNextQuestionToolInput {
  case_id: Id;
}

export interface SaveAnswerM1ToolInput {
  case_id: Id;
  /** Exact `field_id` returned by get_next_question. */
  field_id: string;
  /** Plain text. Money without "$", dates MM/DD/YYYY, yes/no as "Yes"/"No". */
  value: string;
}

export interface ValidateCaseToolInput {
  case_id: Id;
}

export interface FinalizeDocumentToolInput {
  case_id: Id;
}

export interface SendSummaryToolInput {
  case_id: Id;
  /** Only 'sms' in M1. Defaults to 'sms'. */
  channel?: DeliveryChannel;
  /** E.164 override. Defaults to the case's caller_phone. */
  to?: string;
}

/* ---- results (compact objects handed back to the model) ---- */

export interface CreateCaseToolResult {
  case_id: Id;
  status: CaseStatus;
  /** Always present: "Case opened. Nothing has been sent anywhere." */
  note: string;
}

export interface ResolveNeedToolResult extends NeedResolution {
  case_id: Id;
  /** Spoken label for the category. */
  category_label: string;
}

export interface DiscoverProgramToolResult {
  found: boolean;
  program_id?: Id;
  program_name?: string;
  organization?: string;
  form_kind?: FormKind;
  application_url?: string;
  source_domain?: string;
  field_count?: number;
  submission_instructions?: string;
  /** Present when found=false. */
  reason?: string;
  /** Instruction to the agent, e.g. "Say you found the current official form." */
  note: string;
}

export interface GetNextQuestionToolResult {
  /** True when every required field is answered; then `question` is null. */
  done: boolean;
  question: NextQuestion | null;
  progress: InterviewProgress;
}

export interface SaveAnswerToolResult {
  saved: boolean;
  field_id: string;
  value: AnswerValue;
  /** Same shape get_next_question would return right now. */
  next: GetNextQuestionToolResult;
}

export interface ValidateCaseToolResult {
  appears_complete: boolean;
  required_fields_complete: number;
  required_fields_total: number;
  /** Labels of requirements with status 'missing'. */
  still_required: string[];
  basis: string;
  disclaimer: string;
}

export interface FinalizeDocumentToolResult {
  document_url: string;
  fields_filled: number;
  accessibility_status: AccessibilityStatus;
  still_required: string[];
  /** SAFE_COPY.notSubmitted or equivalent. */
  note: string;
}

export interface SendSummaryToolResult {
  delivery_id: Id;
  status: DeliveryStatus;
  /** Last 4 digits only, e.g. "***0123". */
  to_masked: string;
  /** Instruction to the agent, e.g. "Tell the caller a text is on its way." */
  note: string;
}

/** Server-side handlers keyed by exact tool name. */
export interface M1VoiceToolHandlers {
  create_case(args: CreateCaseToolInput): Promise<CreateCaseToolResult>;
  resolve_need(args: ResolveNeedToolInput): Promise<ResolveNeedToolResult>;
  discover_program(args: DiscoverProgramToolInput): Promise<DiscoverProgramToolResult>;
  get_next_question(args: GetNextQuestionToolInput): Promise<GetNextQuestionToolResult>;
  save_answer(args: SaveAnswerM1ToolInput): Promise<SaveAnswerToolResult>;
  validate_case(args: ValidateCaseToolInput): Promise<ValidateCaseToolResult>;
  finalize_document(args: FinalizeDocumentToolInput): Promise<FinalizeDocumentToolResult>;
  send_summary(args: SendSummaryToolInput): Promise<SendSummaryToolResult>;
  /** Alias: identical to get_next_question. */
  get_case_progress(args: GetNextQuestionToolInput): Promise<GetNextQuestionToolResult>;
}

/* ---- JSON schemas (what is provisioned on the Vapi assistant) ---- */

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: readonly string[];
}

export interface ToolJsonSchema {
  name: M1VoiceToolName;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required: readonly string[];
  };
}

const CASE_ID_PROP: JsonSchemaProperty = {
  type: 'string',
  description: 'The case id returned by create_case.',
};

/**
 * The exact function schemas for the Vapi assistant. scripts/vapi/*.mjs must
 * mirror these (the provisioning script compares names against this list).
 */
export const M1_VOICE_TOOL_SCHEMAS: Readonly<Record<M1VoiceToolName, ToolJsonSchema>> = {
  create_case: {
    name: 'create_case',
    description:
      'Open a case as soon as the caller has described what they need. Records their own words. Nothing is sent anywhere.',
    parameters: {
      type: 'object',
      properties: {
        caller_phone: {
          type: 'string',
          description: 'The phone number the call is from, if known, in E.164 form. Omit for browser calls.',
        },
        situation_text: {
          type: 'string',
          description: 'What the caller said they need, in their own words.',
        },
        location: {
          type: 'string',
          description: 'City, county or state the caller is in, if they said it.',
        },
      },
      required: ['situation_text'],
    },
  },
  resolve_need: {
    name: 'resolve_need',
    description:
      'Work out which kind of program the caller needs from their own words. Returns a category, the organization they named (if any), a confidence, and a clarifying question when unsure.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        situation_text: {
          type: 'string',
          description: 'Everything the caller has said about their situation so far.',
        },
      },
      required: ['case_id', 'situation_text'],
    },
  },
  discover_program: {
    name: 'discover_program',
    description:
      'Find the official program and its current application for this category and place, from a verified official source only. Returns found=false when nothing can be verified — never substitutes another organization.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        category: {
          type: 'string',
          enum: NEED_CATEGORIES,
          description: 'The category returned by resolve_need.',
        },
        organization: {
          type: 'string',
          description: 'The exact organization the caller named, if any. Do not guess one.',
        },
        location: {
          type: 'string',
          description: 'Where the caller is: city, county or region, e.g. "Los Angeles, CA".',
        },
      },
      required: ['case_id', 'category', 'location'],
    },
  },
  get_next_question: {
    name: 'get_next_question',
    description:
      'Ask the system of record for the next question to ask, its section, and progress. Call it before each question. Returns done=true when the interview is complete.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
  save_answer: {
    name: 'save_answer',
    description:
      'Save one answer immediately after the caller gives it. One call per answer. field_id must be the exact field_id from get_next_question.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        field_id: {
          type: 'string',
          description: 'The field_id returned by get_next_question for the question you just asked.',
        },
        value: {
          type: 'string',
          description:
            'The answer as plain text. Money without a dollar sign (2,050). Dates as MM/DD/YYYY. Yes/no as "Yes" or "No".',
        },
      },
      required: ['case_id', 'field_id', 'value'],
    },
  },
  validate_case: {
    name: 'validate_case',
    description:
      'Check the application against the published requirements and return what is still missing. Call before wrapping up.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
  finalize_document: {
    name: 'finalize_document',
    description:
      'Fill the official form with the saved answers so the caller can review it. Does NOT submit or sign anything.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
  send_summary: {
    name: 'send_summary',
    description:
      'Text the caller a link to their filled form, what is still missing, and the next step. Call once, after finalize_document, with their permission.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        channel: {
          type: 'string',
          enum: DELIVERY_CHANNELS,
          description: 'Always "sms".',
        },
        to: {
          type: 'string',
          description: 'A different mobile number in E.164 form, only if the caller asked for one.',
        },
      },
      required: ['case_id'],
    },
  },
  get_case_progress: {
    name: 'get_case_progress',
    description: 'Alias of get_next_question. Kept for older assistants.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
};

/* ------------------------------------------------------------------ */
/* 5. Binding module interfaces                                        */
/* ------------------------------------------------------------------ */

/** Paths (relative to app/) each builder MUST create, with the export it MUST have. */
export const M1_MODULES = {
  resolveNeed: { path: 'lib/need/resolve-need.ts', exportName: 'resolveNeed' },
  resolveProgram: { path: 'lib/discovery/resolve-program.ts', exportName: 'resolveProgram' },
  understandForm: { path: 'lib/forms/understand-form.ts', exportName: 'understandForm' },
  mapAnswers: { path: 'lib/forms/map-answers.ts', exportName: 'mapAnswers' },
  sendSummary: { path: 'lib/delivery/sms.ts', exportName: 'sendSummary' },
  buildSummaryMessage: { path: 'lib/delivery/sms.ts', exportName: 'buildSummaryMessage' },
  nextQuestion: { path: 'lib/interview/next-question.ts', exportName: 'nextQuestion' },
} as const;

export interface ResolveNeedInput {
  situation_text: string;
  location?: string;
}
/** lib/need/resolve-need.ts */
export type ResolveNeedFn = (input: ResolveNeedInput) => Promise<NeedResolution>;

export interface ResolveProgramInput {
  category: NeedCategory;
  organization?: string;
  location?: string;
  /** When present, the resolver links the program to the case and writes feed events. */
  case_id?: Id;
}
/** lib/discovery/resolve-program.ts */
export type ResolveProgramFn = (input: ResolveProgramInput) => Promise<ProgramResolution>;

export interface UnderstandFormInput {
  program_id: Id;
  pdf_url: string;
}
/**
 * lib/forms/understand-form.ts — returns rows that satisfy M1FormSchemaField
 * (section, order, options, pdf_field_name all populated) even though the
 * declared element type is the base FormSchemaField.
 */
export type UnderstandFormFn = (input: UnderstandFormInput) => Promise<FormSchemaField[]>;

export interface MapAnswersInput {
  schema: FormSchemaField[];
  answers: Answer[];
}
/** lib/forms/map-answers.ts */
export type MapAnswersFn = (input: MapAnswersInput) => Promise<MappedAnswers>;

export interface SendSummaryInput {
  case_id: Id;
  /** E.164. */
  to: string;
  document_url: string;
  /** Requirements with status 'missing' — the function takes the first SMS_MAX_MISSING_ITEMS. */
  missing: Requirement[];
  /** One sentence, e.g. the program's submission_instructions. */
  next_steps: string;
}
/** lib/delivery/sms.ts */
export type SendSummaryFn = (input: SendSummaryInput) => Promise<Delivery>;

export interface BuildSummaryMessageInput {
  document_url: string;
  missing: Requirement[];
  next_steps: string;
}
/** lib/delivery/sms.ts — pure, deterministic, <= SMS_MAX_CHARS. */
export type BuildSummaryMessageFn = (input: BuildSummaryMessageInput) => string;

/** lib/interview/next-question.ts */
export type NextQuestionFn = (case_id: Id) => Promise<NextQuestion | null>;

/* ------------------------------------------------------------------ */
/* 6. Xano endpoint contracts                                          */
/* ------------------------------------------------------------------ */

/** Paths under XANO_BASE_URL (https://.../api:accessform). */
export const M1_XANO_ENDPOINTS = {
  upsertOrganization: { method: 'POST', path: '/organizations' },
  upsertCatalogProgram: { method: 'POST', path: '/programs/catalog' },
  resolveProgram: { method: 'GET', path: '/programs/resolve' },
  getFormSchema: { method: 'GET', path: '/programs/{id}/form_schema' },
  replaceFormSchema: { method: 'PUT', path: '/programs/{id}/form_schema' },
  nextQuestion: { method: 'GET', path: '/cases/{id}/next_question' },
  createDelivery: { method: 'POST', path: '/cases/{id}/deliveries' },
  /* pre-existing, widened */
  createCase: { method: 'POST', path: '/cases' },
  getCase: { method: 'GET', path: '/cases/{id}' },
  saveAnswer: { method: 'PUT', path: '/cases/{id}/answers/{field_id}' },
  progress: { method: 'GET', path: '/cases/{id}/progress' },
  validate: { method: 'POST', path: '/cases/{id}/validate' },
  documents: { method: 'POST', path: '/cases/{id}/documents' },
  events: { method: 'POST', path: '/cases/{id}/events' },
} as const;

/** POST /organizations — upsert by exact `name`. */
export interface UpsertOrganizationRequest {
  name: string;
  kind: OrganizationKind;
  domain: string;
  region?: string;
  website?: string;
}
export type UpsertOrganizationResponse = Organization;

/** POST /programs/catalog — upsert by exact `application_url`. */
export interface UpsertCatalogProgramRequest {
  /** Resolved/created by name inside the endpoint. */
  organization_name: string;
  organization_kind: OrganizationKind;
  organization_domain: string;
  name: string;
  category: NeedCategory;
  form_kind: FormKind;
  /** Absolute https URL. The upsert key. */
  application_url: string;
  policy_url: string;
  source_domain: string;
  region: string;
  submission_instructions?: string;
  field_count?: number;
  page_count?: number;
  sha256?: string;
  verified: boolean;
  /** ISO-8601; Xano stores epoch ms. */
  retrieved_at?: IsoTimestamp;
  effective_date?: string;
}
export type UpsertCatalogProgramResponse = ResolvedProgram;

/** GET /programs/resolve?category=&location=&organization= */
export interface ResolveProgramQuery {
  category: NeedCategory;
  location?: string;
  organization?: string;
}
export interface ResolveProgramResponse {
  found: boolean;
  program: ResolvedProgram | null;
  organization: Organization | null;
  /** Other verified programs in the category (different regions), for the agent to offer. */
  alternatives: ResolvedProgram[];
  /** Why nothing matched, e.g. "no verified program for that organization". */
  reason: string;
}

/** One form_schema row on the wire (no id / created_at / program_id — the path carries the program). */
export interface FormSchemaWriteRow {
  field_id: string;
  label: string;
  normalized_key: string;
  type: FormFieldType;
  required: boolean;
  section: string;
  order: number;
  options: string[];
  conversational_prompt: string;
  /** "" when none (Xano text). */
  dependency_rule: string;
  pdf_field_name: string;
  /** Legacy column; write the same value as pdf_field_name. */
  pdf_mapping: string;
  /** Legacy grouping column; write the same value as section. */
  group_key: string;
}

/** PUT /programs/{id}/form_schema — delete all rows for the program, insert these. */
export interface ReplaceFormSchemaRequest {
  fields: FormSchemaWriteRow[];
}
export interface ReplaceFormSchemaResponse {
  program_id: Id;
  count: number;
  fields: M1FormSchemaField[];
}

/** GET /programs/{id}/form_schema?required_only=true */
export interface GetFormSchemaResponse {
  program_id: Id;
  application_url: string;
  count: number;
  fields: M1FormSchemaField[];
}

/** GET /cases/{id}/next_question */
export interface NextQuestionResponse {
  case_id: Id;
  status: CaseStatus;
  done: boolean;
  question: NextQuestion | null;
  progress: InterviewProgress;
}

/** POST /cases/{id}/deliveries */
export interface CreateDeliveryRequest {
  channel: DeliveryChannel;
  to: string;
  message: string;
  document_url: string;
  status: DeliveryStatus;
  provider_id?: string;
  error?: string;
}
export type CreateDeliveryResponse = Delivery;

/** POST /cases — M1 widening. All legacy inputs stay optional. */
export interface CreateCaseM1Request {
  situation_text: string;
  caller_phone?: string;
  location?: string;
  need_category?: NeedCategory;
  /** Legacy, optional now. Defaults "Caller". */
  patient_display_name?: string;
  hospital_name?: string;
  bill_amount?: number;
  program_id?: Id;
  external_ref?: string;
}

/* ------------------------------------------------------------------ */
/* 7. Catalog seed                                                     */
/* ------------------------------------------------------------------ */

/** Repo-relative path of the verified manifest. */
export const CATALOG_MANIFEST_PATH = 'spike/catalog.json' as const;

/** One entry of spike/catalog.json, exactly as written by the spike. */
export interface CatalogEntry {
  need: NeedCategory;
  organization: string;
  region: string;
  kind: OrganizationKind;
  program: string;
  /** MUST be an absolute https URL before seeding; a placeholder in parentheses is NOT seedable. */
  application_url: string;
  policy_url: string;
  source_domain: string;
  /** Repo-relative path of the downloaded PDF, or null. */
  local_file: string | null;
  notes?: string;
  form_kind: FormKind;
  pages: number;
  field_count: number;
  /** First 16 hex chars of sha256. */
  sha256: string;
  field_types: { '/Tx': number; '/Btn': number; '/Sig': number; '/Ch': number };
  /** YYYY-MM-DD */
  verified_at: string;
  verified: boolean;
}

/** Submission instructions per catalog program, keyed by application_url host+path prefix. */
export const CATALOG_SUBMISSION_INSTRUCTIONS: Readonly<Record<string, string>> = {
  'api.hdc.hcai.ca.gov':
    'Sign the printed application and return it to the Cedars-Sinai Patient Financial Services office with proof of income.',
  'accessla.org':
    'Sign the application and mail or fax it to Access Services; they will call you to schedule an in-person eligibility interview.',
  'sfmta.com':
    'Sign the application and mail it to SF Paratransit; the office will contact you about the next step.',
  'napavalley.edu':
    'Sign the application and bring it with your documentation to the DSPS office at Napa Valley College.',
};

/* ------------------------------------------------------------------ */
/* 8. SMS delivery                                                     */
/* ------------------------------------------------------------------ */

/** Hard cap on the body. Two GSM segments; we stay under to be safe. */
export const SMS_MAX_CHARS = 320 as const;
/** "Still missing" items listed; the rest become "+N more". */
export const SMS_MAX_MISSING_ITEMS = 3 as const;
/** The only new non-secret env var M1 adds: absolute origin used in SMS links. */
export const PUBLIC_BASE_URL_ENV = 'PUBLIC_BASE_URL' as const;
/** From-number is read from the environment; never hardcoded in code that ships. */
export const TWILIO_FROM_ENV = 'TWILIO_FROM_NUMBER' as const;

/**
 * Template. Lines joined with "\n". No name, no amounts, no answers.
 *   L1  "AccessForm: your form is ready to review: <document_url>"
 *   L2  "Still needed: <item 1>; <item 2>; <item 3>[; +N more]"   (omitted when nothing is missing)
 *   L3  "Next: <next_steps>"
 *   L4  "Not submitted. You decide what to send."
 */
export const SMS_TEMPLATE = {
  link: 'AccessForm: your form is ready to review: {document_url}',
  missing: 'Still needed: {items}',
  more: '; +{n} more',
  next: 'Next: {next_steps}',
  footer: 'Not submitted. You decide what to send.',
} as const;

/* ------------------------------------------------------------------ */
/* 9. UI progress model                                                */
/* ------------------------------------------------------------------ */

/**
 * Legacy /live steps are DERIVED from sections. A legacy field step is 'done'
 * when every section whose key matches one of its aliases is done, 'active'
 * when any is active, and mirrors the overall interview state when the form
 * has no matching section at all (so a paratransit form still shows a
 * sensible card). program_found / current_form / documents / review keep
 * their existing rules.
 */
export const LEGACY_STEP_SECTION_ALIASES: Readonly<
  Record<'personal_information' | 'household' | 'insurance' | 'income', readonly string[]>
> = {
  personal_information: ['personal_information', 'applicant', 'contact', 'personal'],
  household: ['household', 'household_information', 'family'],
  insurance: ['insurance', 'insurance_information', 'coverage', 'medical'],
  income: ['income', 'income_information', 'monthly_expenses', 'expenses', 'financial'],
};

/* ------------------------------------------------------------------ */
/* 10. OpenAI usage constants                                          */
/* ------------------------------------------------------------------ */

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions' as const;
/** Judgment steps: source verdict, form understanding, answer mapping. */
export const OPENAI_JUDGMENT_MODEL = 'gpt-4o' as const;
/** Cheap classification: need category. */
export const OPENAI_CLASSIFIER_MODEL = 'gpt-4o-mini' as const;
export const OPENAI_TEMPERATURE = 0 as const;

/** Official-authority suffixes that are always allowed, whatever the organization. */
export const OFFICIAL_TLD_SUFFIXES = ['.gov', '.edu'] as const;
/** Hard budget for THIS run, shared by every agent. Prefer the catalog. */
export const SERPAPI_RUN_BUDGET = 12 as const;

/** Never asked, never mapped, always left blank. Substring match, case-insensitive, on field_id/label. */
export const FORBIDDEN_FIELD_PATTERNS = [
  'social security number',
  'ssn',
  'account number',
  'passport',
  'driver',
  'license number',
  'medicare number',
  'medi-cal number',
] as const;
