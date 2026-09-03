/**
 * Form understanding — lib/forms/understand-form.ts (M1_MODULES.understandForm).
 *
 *   official PDF bytes
 *     -> pdf-lib: every AcroForm field, type, page, export values  (extract-fields.ts)
 *     -> gpt-4o, strict JSON, one call per <= 60 fields: label, key, type,
 *        required, section, order, spoken prompt, why, dependency, skip
 *     -> deterministic post-rules (forbidden identifiers never asked,
 *        signatures never asked, options = real export values,
 *        pdf_field_name = field_id, order renumbered per section)
 *     -> M1FormSchemaField rows
 *
 * Caching, so understanding a form is idempotent and cheap:
 *   1. app/.formcache/<sha256>.json      (keyed by the PDF bytes; survives restarts)
 *   2. Xano GET/PUT /programs/{id}/form_schema  (the system of record, live mode)
 * A cache hit costs zero OpenAI tokens. The model can NEVER add a field: the
 * `field_id` enum in every request is the extracted list, and the post-rules
 * drop anything that is not on it anyway.
 *
 * SERVER-SIDE ONLY.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isDemoMode, xanoCredentials } from '../adapters/env';
import {
  FORBIDDEN_FIELD_PATTERNS,
  type FormFieldType,
  type FormSchemaField,
  type FormSchemaWriteRow,
  type Id,
  type M1FormSchemaField,
  type UnderstandFormInput,
} from '../contract';
import {
  extractFormFields,
  type ExtractedField,
  type ExtractedForm,
} from './extract-fields';
import { enumProperty, openaiStrictJson, type JsonSchema } from './openai-json';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A form_schema row as this module produces it: every M1 column plus `why`. */
export type UnderstoodField = M1FormSchemaField & {
  /** Spoken only when the caller asks why the form wants this. "" when there is nothing to add. */
  why: string;
  /** PDF page (1-based) of the field's first widget; 0 when unknown. */
  page: number;
};

export interface UnderstandFormOptions {
  /**
   * 'auto'  (default) read/write Xano when XANO_BASE_URL is set and demo mode is off
   * 'never' file cache only — for scripts that must not touch the live workspace
   * 'always' force the Xano round-trip even in demo mode
   */
  xano?: 'auto' | 'never' | 'always';
  /** Override the cache directory (default: <cwd>/.formcache). */
  cacheDir?: string;
  /** Skip the file cache and rebuild (still writes the fresh result). */
  force?: boolean;
  /** Progress lines for scripts. */
  log?: (line: string) => void;
}

export interface UnderstandFormResult {
  program_id: Id;
  sha256: string;
  sha16: string;
  page_count: number;
  field_count: number;
  fields: UnderstoodField[];
  /** Where the rows came from. */
  origin: 'file_cache' | 'xano' | 'built';
  /** OpenAI calls made by this invocation (0 on a cache hit). */
  model_calls: number;
}

/** Summary counts, the shape the task report asks for. */
export interface FormSchemaCounts {
  fields: number;
  asked: number;
  skipped: number;
  required: number;
  sections: string[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const FORMCACHE_DIR_NAME = '.formcache' as const;
export const FORMCACHE_VERSION = 1 as const;
/** Fields per OpenAI call. 60 keeps the strict JSON output well under the 16k output cap. */
export const UNDERSTAND_BATCH_SIZE = 60 as const;

const FIELD_TYPES: readonly FormFieldType[] = [
  'text',
  'number',
  'currency',
  'date',
  'choice',
  'checkbox',
  'radio',
  'signature',
];

/** Types the model may pick for a plain text widget. Buttons/signatures are forced by the extractor. */
const TEXT_WIDGET_TYPES: readonly FormFieldType[] = ['text', 'number', 'currency', 'date'];

/**
 * Preferred section keys. Generic across hospitals, transit agencies and
 * colleges; the model may add its own snake_case key when none fits. The
 * first five are the legacy Cedars `group_key` values, which is why they are
 * spelled exactly so.
 */
export const CANONICAL_SECTIONS: Readonly<Record<string, string>> = {
  personal_information: 'the applicant: name, date of birth, address, phone, email, preferred contact',
  household_information:
    'household: marital status, household size, employment status, spouse/partner/guarantor, dependents, employer details',
  insurance_information: 'health coverage: insurer, policyholder, policy, Medi-Cal/Medicaid questions',
  income_information:
    'money coming in and owed: annual household income, gross income lines, outstanding debts or bills (even when the box sits next to household questions on the page)',
  monthly_expenses: 'monthly expense lines (rent, utilities, food, medical, transportation, …)',
  disability_information: 'the disability or health condition and how it affects the person',
  mobility_aids: 'mobility devices and equipment: wheelchair, walker, cane, service animal',
  travel_needs: 'how the person travels today, distances, transit use, trip purposes, assistance needed',
  emergency_contact: 'emergency contact person',
  medical_professional: 'doctor / health professional who can verify the condition',
  student_information: 'student id, program, enrollment, campus',
  accommodations: 'accommodations or services requested',
  certification: 'signatures, dates signed, consent and attestation text',
  office_use: 'fields the organization fills in, not the applicant',
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function snakeCase(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

/** Substring match, case-insensitive, on the field name or label (FORBIDDEN_FIELD_PATTERNS). */
export function isForbiddenField(fieldId: string, label = ''): boolean {
  const haystack = `${fieldId}\n${label}`.toLowerCase();
  return FORBIDDEN_FIELD_PATTERNS.some((pattern) => haystack.includes(pattern));
}

const DEPENDENCY_RULE = /^\s*([a-z0-9_]+)\s*==\s*'([^']*)'\s*$/;

/** Parse "<normalized_key> == '<value>'"; null for "" or anything else. */
export function parseDependencyRule(rule: string | null | undefined): { key: string; value: string } | null {
  if (!rule) return null;
  const match = DEPENDENCY_RULE.exec(rule);
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

function titleCase(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Counts for the report: fields, asked (required with a prompt), skipped (never asked). */
export function countFormSchema(fields: readonly UnderstoodField[]): FormSchemaCounts {
  const sections: string[] = [];
  for (const field of fields) {
    if (!sections.includes(field.section)) sections.push(field.section);
  }
  const asked = fields.filter((f) => f.conversational_prompt.trim() !== '').length;
  return {
    fields: fields.length,
    asked,
    skipped: fields.length - asked,
    required: fields.filter((f) => f.required).length,
    sections,
  };
}

/* ------------------------------------------------------------------ */
/* The model call                                                      */
/* ------------------------------------------------------------------ */

interface ModelFieldRow {
  field_id: string;
  label: string;
  normalized_key: string;
  type: FormFieldType;
  required: boolean;
  section: string;
  order: number;
  conversational_prompt: string;
  why: string;
  dependency_rule: string;
  skip: boolean;
}

interface ModelBatchResponse {
  fields: ModelFieldRow[];
}

function batchSchema(fieldIds: readonly string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['fields'],
    properties: {
      fields: {
        type: 'array',
        description: 'Exactly one entry per field_id in this batch, in asking order.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'field_id',
            'label',
            'normalized_key',
            'type',
            'required',
            'section',
            'order',
            'conversational_prompt',
            'why',
            'dependency_rule',
            'skip',
          ],
          properties: {
            field_id: enumProperty(fieldIds, 'The exact AcroForm field name, copied verbatim.'),
            label: {
              type: 'string',
              description: 'Short human label as it would be printed on the form (e.g. "Home phone number").',
            },
            normalized_key: {
              type: 'string',
              description: 'Stable snake_case key, unique on this form (e.g. "home_phone_number").',
            },
            type: enumProperty(FIELD_TYPES, 'Value type. Money lines are "currency", dates are "date".'),
            required: {
              type: 'boolean',
              description: 'True when the applicant must answer this for the application to be usable.',
            },
            section: {
              type: 'string',
              description: 'snake_case section key. Prefer the canonical keys listed in the instructions.',
            },
            order: { type: 'integer', description: '1-based position in the asking order for the whole form.' },
            conversational_prompt: {
              type: 'string',
              description:
                'How a kind human helper would ask this by phone. One question, plain words, never the raw label. "" when skip is true.',
            },
            why: {
              type: 'string',
              description: 'One sentence explaining why the form asks, said only if the caller asks. "" if nothing useful.',
            },
            dependency_rule: {
              type: 'string',
              description:
                "\"\" or exactly \"<normalized_key> == '<export value>'\" referring to another field on this form, e.g. \"marital_status == 'Married'\".",
            },
            skip: {
              type: 'boolean',
              description:
                'True for fields the assistant must never ask: signatures, dates next to signatures, office-use, SSN / account / license / policy numbers, consent checkboxes the person must tick themselves.',
            },
          },
        },
      },
    },
  };
}

const SYSTEM_PROMPT = `You prepare official application forms for a phone assistant that helps people with disabilities. The assistant reads nothing to the caller except the questions you write, then fills the real PDF.

You receive the real AcroForm fields of ONE official form, in reading order (page, position, widget type, export values). For every field in the batch you return one object. Rules:

1. field_id is copied verbatim. Never invent or rename a field.
2. label: the short printed label a person would see next to the box.
3. normalized_key: snake_case, unique on the whole form, meaningful (not the suffix _2).
4. type: text | number | currency | date | choice | checkbox | radio | signature. Money lines are currency. Dates are date. Counts are number.
5. required: true when the applicant must answer for the application to be usable, or when a helper would always ask it. Required: the applicant's own name, date of birth, home address, city, state, ZIP, main phone number and preferred way to be contacted; marital status, household size (even when the field name is only a fragment such as "as reported on your taxes") and employment status; whether they have health coverage plus the main insurer and policyholder, and the yes/no questions about having applied for or been screened for Medi-Cal / Medicaid; every primary income line and any outstanding bill the form asks about; the everyday monthly expense lines in the applicant's column (rent or mortgage, utilities and telephone, food, medical and dental, transportation, clothing and laundry) and the expenses total; on a disability or transit application, the disability question, how it affects travel, the mobility devices in use, the emergency contact, and the healthcare professional's name. NOT required: email or a second phone when a main phone exists, mailing address if different, spouse / guarantor / other-member columns, "if yes, describe" follow-ups, employer details, rarer expense lines (real estate taxes, home maintenance, alimony, education, childcare, insurance premiums, other or extraordinary), other medical debt, "optional" fields, staff-only and signature fields.
6. Suffixed names (_1, _2, _3, "Name_2") are repeated columns or rows: the unsuffixed one is the applicant's own; suffixed copies are for a spouse, guarantor, other household member or extra entries. Mark those required=false and, when the form makes the link, give a dependency_rule (e.g. relationship_to_patient == 'Spouse'). A field marked "comb=N boxes" is ONE answer typed one character per box (a name, an ID); treat it as a single normal field with that label.
7. section: a snake_case key. Prefer the canonical keys given below when they fit; invent a new key only when none fits. Keep sections few (3-8 per form) and contiguous in reading order.
8. order: 1-based asking order for the whole form (reading order is a good default; keep a section together).
9. conversational_prompt: exactly what a warm, plain-spoken helper would say on the phone. One question. Never the raw label, never legalese, never a claim about eligibility or approval. For choice fields say the options in natural words. For yes/no questions ask a yes/no question. For a repeated column say whose it is ("your spouse's"). "" when skip is true.
10. why: one short sentence on why the form asks, spoken only if the caller asks. "" if obvious.
11. dependency_rule: "" or "<normalized_key> == '<export value>'" using another field's normalized_key and one of its exact export values.
12. skip=true for: signature fields, the date next to a signature, office/staff-use fields, Social Security numbers, account / policy / license / Medicare / Medi-Cal numbers, and consent checkboxes the person must tick in their own hand. The assistant never asks for identifiers.

Canonical section keys and what belongs in each:
${Object.entries(CANONICAL_SECTIONS)
  .map(([key, what]) => `- ${key}: ${what}`)
  .join('\n')}`;

function describeField(field: ExtractedField): string {
  const parts = [`#${field.reading_index}`, `p${field.page}`, field.type];
  if (field.options.length > 0) parts.push(`options=[${field.options.join(' | ')}]`);
  if (field.comb_size > 1) parts.push(`comb=${field.comb_size} boxes (one character each, ONE answer)`);
  else if (field.max_length) parts.push(`maxlen=${field.max_length}`);
  if (field.multiline) parts.push('multiline');
  return `${parts.join(' ')} :: ${JSON.stringify(field.field_id)}`;
}

/** A comb follower is a box of a comb that is not its leader — never shown to the model. */
function isCombFollower(field: ExtractedField): boolean {
  return field.comb_leader !== null && field.comb_leader !== field.field_id;
}

/** The fields the model reasons about: everything except comb followers. */
export function modelVisibleFields(form: ExtractedForm): ExtractedField[] {
  return form.fields.filter((field) => !isCombFollower(field));
}

/** Suffix that marks a comb box's normalized_key: `<leader_key>__box_<n>`. */
export const COMB_BOX_KEY_INFIX = '__box_' as const;

function userPrompt(
  form: ExtractedForm,
  batch: readonly ExtractedField[],
  sectionsSoFar: readonly string[],
  formTitle: string,
): string {
  const all = form.fields.map(describeField).join('\n');
  const ids = batch.map((f) => JSON.stringify(f.field_id)).join('\n');
  const sections =
    sectionsSoFar.length > 0
      ? `Sections already used by earlier batches of this form (reuse them where the fields continue): ${sectionsSoFar.join(', ')}.`
      : 'This is the first batch.';
  return `Form: ${formTitle}
Pages: ${form.page_count}. Fields: ${form.field_count}.

ALL fields of the form in reading order (context only):
${all}

${sections}

Return one object for EACH of these ${batch.length} field_ids, and nothing else:
${ids}`;
}

/* ------------------------------------------------------------------ */
/* Build (extraction + model + post-rules)                             */
/* ------------------------------------------------------------------ */

/**
 * Deterministic post-rules applied to whatever the model returned. This is
 * where the product's promises are enforced, not in the prompt.
 */
export function applyPostRules(
  programId: Id,
  form: ExtractedForm,
  modelRows: readonly ModelFieldRow[],
): UnderstoodField[] {
  const byId = new Map<string, ModelFieldRow>();
  for (const row of modelRows) {
    if (!byId.has(row.field_id)) byId.set(row.field_id, row);
  }

  const usedKeys = new Set<string>();
  const uniqueKey = (wanted: string, fallback: string): string => {
    let base = snakeCase(wanted) || snakeCase(fallback) || 'field';
    if (base.length > 60) base = base.slice(0, 60).replace(/_+$/, '');
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) {
      key = `${base}_${n}`;
      n += 1;
    }
    usedKeys.add(key);
    return key;
  };

  interface Draft {
    field: UnderstoodField;
    extracted: ExtractedField;
    modelOrder: number;
  }

  const drafts: Draft[] = [];
  for (const extracted of form.fields) {
    if (isCombFollower(extracted)) continue; // filled in after the leaders exist
    const model = byId.get(extracted.field_id);
    const label = (model?.label ?? '').trim() || extracted.field_id;
    const forbidden = isForbiddenField(extracted.field_id, label);
    const isSignature = extracted.type === 'signature' || model?.type === 'signature';
    const skip = Boolean(model?.skip) || forbidden || isSignature || extracted.type === 'button';

    let type: FormFieldType;
    switch (extracted.type) {
      case 'radio':
      case 'dropdown':
        type = 'choice';
        break;
      case 'checkbox':
        type = 'checkbox';
        break;
      case 'signature':
        type = 'signature';
        break;
      case 'button':
        type = 'text';
        break;
      default:
        type =
          model && TEXT_WIDGET_TYPES.includes(model.type)
            ? model.type
            : model?.type === 'signature'
              ? 'signature'
              : 'text';
    }

    const section = snakeCase(model?.section ?? '') || (skip ? 'certification' : 'general');
    const required = !skip && Boolean(model?.required);
    const prompt = skip ? '' : (model?.conversational_prompt ?? '').trim();

    const field: UnderstoodField = {
      id: '',
      program_id: programId,
      field_id: extracted.field_id,
      label,
      normalized_key: uniqueKey(model?.normalized_key ?? '', extracted.field_id),
      type,
      required,
      conversational_prompt: prompt,
      dependency_rule: null,
      pdf_mapping: extracted.field_id,
      section,
      order: 0,
      options: extracted.options.slice(),
      pdf_field_name: extracted.field_id,
      why: skip ? '' : (model?.why ?? '').trim(),
      page: extracted.page,
    };
    drafts.push({ field, extracted, modelOrder: model?.order ?? Number.MAX_SAFE_INTEGER });
  }

  // Comb followers: one row per box, never asked, keyed `<leader_key>__box_<n>`
  // so the answer mapper can spread the leader's value across the boxes.
  const leaderDrafts = new Map(drafts.map((d) => [d.field.field_id, d]));
  for (const extracted of form.fields) {
    if (!isCombFollower(extracted) || !extracted.comb_leader) continue;
    const leader = leaderDrafts.get(extracted.comb_leader);
    if (!leader) continue;
    const key = `${leader.field.normalized_key}${COMB_BOX_KEY_INFIX}${extracted.comb_index}`;
    usedKeys.add(key);
    drafts.push({
      field: {
        id: '',
        program_id: programId,
        field_id: extracted.field_id,
        label: `${leader.field.label} (box ${extracted.comb_index})`,
        normalized_key: key,
        type: 'text',
        required: false,
        conversational_prompt: '',
        dependency_rule: null,
        pdf_mapping: extracted.field_id,
        section: leader.field.section,
        order: 0,
        options: [],
        pdf_field_name: extracted.field_id,
        why: '',
        page: extracted.page,
      },
      extracted,
      modelOrder: leader.modelOrder + extracted.comb_index / 1000,
    });
  }

  // Dependency rules: keep only well-formed rules that point at a real key.
  const keyByFieldId = new Map(drafts.map((d) => [d.field.field_id, d.field.normalized_key]));
  const knownKeys = new Set(keyByFieldId.values());
  for (const draft of drafts) {
    const model = byId.get(draft.field.field_id);
    const parsed = parseDependencyRule(model?.dependency_rule);
    if (parsed && knownKeys.has(parsed.key) && parsed.key !== draft.field.normalized_key) {
      draft.field.dependency_rule = `${parsed.key} == '${parsed.value}'`;
    }
  }

  // Order: canonical sections in their canonical order (who you are ->
  // household -> coverage -> money -> ... -> certification), other sections
  // after them by first appearance on the page; inside a section the
  // model's order, then reading position. Renumber 1..n.
  const canonicalRank = Object.keys(CANONICAL_SECTIONS);
  const sectionFirstSeen = new Map<string, number>();
  for (const draft of drafts) {
    const seen = sectionFirstSeen.get(draft.field.section);
    if (seen === undefined || draft.extracted.reading_index < seen) {
      sectionFirstSeen.set(draft.field.section, draft.extracted.reading_index);
    }
  }
  const rankOf = (section: string): number => {
    const canonical = canonicalRank.indexOf(section);
    return canonical >= 0 ? canonical : canonicalRank.length + (sectionFirstSeen.get(section) ?? 0);
  };
  drafts.sort(
    (a, b) =>
      rankOf(a.field.section) - rankOf(b.field.section) ||
      a.modelOrder - b.modelOrder ||
      a.extracted.reading_index - b.extracted.reading_index,
  );
  return drafts.map((draft, index) => ({
    ...draft.field,
    id: `fs_${String(index + 1).padStart(3, '0')}`,
    order: index + 1,
  }));
}

/**
 * Extraction + model + post-rules, no caches. Exported for tests and for
 * callers that already hold the bytes.
 */
export async function buildFormSchema(
  programId: Id,
  form: ExtractedForm,
  options: { formTitle?: string; log?: (line: string) => void } = {},
): Promise<{ fields: UnderstoodField[]; model_calls: number }> {
  const log = options.log ?? (() => undefined);
  const title = options.formTitle ?? 'Official application';
  const modelRows: ModelFieldRow[] = [];
  const sectionsSoFar: string[] = [];
  let calls = 0;

  const visible = modelVisibleFields(form);
  for (let start = 0; start < visible.length; start += UNDERSTAND_BATCH_SIZE) {
    const batch = visible.slice(start, start + UNDERSTAND_BATCH_SIZE);
    const ids = batch.map((f) => f.field_id);
    log(`understand-form: batch ${start / UNDERSTAND_BATCH_SIZE + 1}, ${batch.length} fields`);
    const response = await openaiStrictJson<ModelBatchResponse>({
      system: SYSTEM_PROMPT,
      user: userPrompt(form, batch, sectionsSoFar, title),
      schemaName: 'form_schema_batch',
      schema: batchSchema(ids),
      maxTokens: 12000,
    });
    calls += 1;
    const allowed = new Set(ids);
    for (const row of response.fields) {
      // The enum already constrains field_id; this is the belt to that brace.
      if (!allowed.has(row.field_id)) continue;
      modelRows.push(row);
      const key = snakeCase(row.section);
      if (key && !sectionsSoFar.includes(key)) sectionsSoFar.push(key);
    }
  }

  return { fields: applyPostRules(programId, form, modelRows), model_calls: calls };
}

/* ------------------------------------------------------------------ */
/* File cache                                                          */
/* ------------------------------------------------------------------ */

interface CacheFile {
  version: number;
  sha256: string;
  sha16: string;
  page_count: number;
  field_count: number;
  built_at: string;
  fields: Array<Omit<UnderstoodField, 'id' | 'program_id'>>;
}

export function formCacheDir(override?: string): string {
  return override ?? path.join(process.cwd(), FORMCACHE_DIR_NAME);
}

function cacheFilePath(sha256: string, dir: string): string {
  return path.join(dir, `${sha256}.json`);
}

async function readFileCache(sha256: string, dir: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(cacheFilePath(sha256, dir), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== FORMCACHE_VERSION || parsed.sha256 !== sha256) return null;
    if (!Array.isArray(parsed.fields) || parsed.fields.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeFileCache(entry: CacheFile, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(cacheFilePath(entry.sha256, dir), JSON.stringify(entry, null, 2), 'utf8');
}

function stampProgram(programId: Id, rows: readonly Omit<UnderstoodField, 'id' | 'program_id'>[]): UnderstoodField[] {
  return rows.map((row, index) => ({
    ...row,
    id: `fs_${String(index + 1).padStart(3, '0')}`,
    program_id: programId,
  }));
}

/* ------------------------------------------------------------------ */
/* Xano                                                                */
/* ------------------------------------------------------------------ */

/** The wire row for PUT /programs/{id}/form_schema. */
export function toWriteRow(field: UnderstoodField): FormSchemaWriteRow {
  return {
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
    pdf_mapping: field.pdf_field_name,
    group_key: field.section,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Normalize a Xano form_schema row (any vintage) into an UnderstoodField; "" -> null etc. */
export function normalizeXanoFormSchemaRow(raw: unknown, programId: Id): UnderstoodField {
  const row = asRecord(raw);
  const fieldId = typeof row.field_id === 'string' ? row.field_id : '';
  const section =
    (typeof row.section === 'string' && row.section) ||
    (typeof row.group_key === 'string' && row.group_key) ||
    'general';
  const rawOptions = row.options;
  let options: string[] = [];
  if (Array.isArray(rawOptions)) options = rawOptions.map(String);
  else if (typeof rawOptions === 'string' && rawOptions.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(rawOptions) as unknown;
      if (Array.isArray(parsed)) options = parsed.map(String);
    } catch {
      options = [];
    }
  }
  const typeText = typeof row.type === 'string' ? row.type : 'text';
  const type = (FIELD_TYPES as readonly string[]).includes(typeText) ? (typeText as FormFieldType) : 'text';
  const dependency = typeof row.dependency_rule === 'string' && row.dependency_rule.trim() !== '' ? row.dependency_rule : null;
  const orderRaw = row.order;
  const order = typeof orderRaw === 'number' ? orderRaw : Number(orderRaw) || 0;
  return {
    id: row.id === undefined || row.id === null ? '' : String(row.id),
    program_id: row.program_id === undefined || row.program_id === null ? programId : String(row.program_id),
    field_id: fieldId,
    label: (typeof row.label === 'string' && row.label) || fieldId,
    normalized_key: (typeof row.normalized_key === 'string' && row.normalized_key) || snakeCase(fieldId),
    type,
    required: row.required === true || row.required === 'true' || row.required === 1,
    conversational_prompt: typeof row.conversational_prompt === 'string' ? row.conversational_prompt : '',
    dependency_rule: dependency,
    pdf_mapping: (typeof row.pdf_mapping === 'string' && row.pdf_mapping) || fieldId,
    section,
    order,
    options,
    pdf_field_name: (typeof row.pdf_field_name === 'string' && row.pdf_field_name) || fieldId,
    why: typeof row.why === 'string' ? row.why : '',
    page: typeof row.page === 'number' ? row.page : 0,
  };
}

async function xanoGetFormSchema(baseUrl: string, programId: Id): Promise<UnderstoodField[] | null> {
  const id = encodeURIComponent(programId);
  for (const suffix of ['form_schema', 'fields']) {
    try {
      const response = await fetch(`${baseUrl}/programs/${id}/${suffix}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) continue;
      const json = (await response.json()) as unknown;
      const rows = Array.isArray(json) ? json : asRecord(json).fields ?? asRecord(json).form_schema;
      if (!Array.isArray(rows)) continue;
      const fields = rows.map((row) => normalizeXanoFormSchemaRow(row, programId)).filter((f) => f.field_id !== '');
      return fields.sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id));
    } catch {
      /* try the next path */
    }
  }
  return null;
}

async function xanoPutFormSchema(
  baseUrl: string,
  programId: Id,
  fields: readonly UnderstoodField[],
): Promise<UnderstoodField[] | null> {
  const response = await fetch(`${baseUrl}/programs/${encodeURIComponent(programId)}/form_schema`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ fields: fields.map(toWriteRow) }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`PUT /programs/${programId}/form_schema -> HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as unknown;
  const rows = asRecord(json).fields;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.map((row) => normalizeXanoFormSchemaRow(row, programId));
}

/** True when the Xano rows cover exactly the extracted fields and carry the M1 columns. */
function xanoRowsMatch(rows: readonly UnderstoodField[], form: ExtractedForm): boolean {
  if (rows.length !== form.field_count) return false;
  const names = new Set(form.fields.map((f) => f.field_id));
  return rows.every((row) => names.has(row.field_id) && row.pdf_field_name !== '' && row.order > 0);
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

async function loadPdf(pdfUrl: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(pdfUrl)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(pdfUrl, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`GET ${pdfUrl} -> HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
        throw new Error(`${pdfUrl} did not return a PDF`);
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }
  // Local path (scripts, tests). Never used by the voice path.
  return new Uint8Array(await readFile(pdfUrl));
}

/**
 * Full pipeline from bytes already in hand. Cache order: file cache -> Xano
 * -> build. Whatever produced the rows, the other store is brought up to
 * date so the next call is a hit everywhere.
 */
export async function understandFormFromBytes(
  programId: Id,
  pdfBytes: Uint8Array,
  options: UnderstandFormOptions & { formTitle?: string } = {},
): Promise<UnderstandFormResult> {
  const log = options.log ?? (() => undefined);
  const dir = formCacheDir(options.cacheDir);
  const form = await extractFormFields(pdfBytes);
  log(`understand-form: ${form.field_count} fields on ${form.page_count} pages, sha256 ${form.sha16}`);

  const xanoMode = options.xano ?? 'auto';
  const credentials = xanoCredentials();
  const useXano =
    xanoMode === 'always' ? Boolean(credentials) : xanoMode === 'auto' ? Boolean(credentials) && !isDemoMode() : false;

  let fields: UnderstoodField[] | null = null;
  let origin: UnderstandFormResult['origin'] = 'built';
  let modelCalls = 0;

  // 1. File cache (keyed by the bytes, so it is sha-consistent by construction).
  if (!options.force) {
    const cached = await readFileCache(form.sha256, dir);
    if (cached) {
      fields = stampProgram(programId, cached.fields);
      origin = 'file_cache';
      log(`understand-form: file cache hit (${fields.length} rows)`);
    }
  }

  // 2. Xano rows, if they cover exactly this form.
  let xanoRows: UnderstoodField[] | null = null;
  if (useXano && credentials) {
    xanoRows = await xanoGetFormSchema(credentials.baseUrl, programId);
    if (!fields && xanoRows && xanoRowsMatch(xanoRows, form)) {
      fields = xanoRows;
      origin = 'xano';
      log(`understand-form: Xano rows match (${fields.length} rows)`);
    }
  }

  // 3. Build.
  if (!fields) {
    const built = await buildFormSchema(programId, form, { formTitle: options.formTitle, log });
    fields = built.fields;
    modelCalls = built.model_calls;
    origin = 'built';
  }

  // Bring the caches up to date.
  if (origin !== 'file_cache') {
    await writeFileCache(
      {
        version: FORMCACHE_VERSION,
        sha256: form.sha256,
        sha16: form.sha16,
        page_count: form.page_count,
        field_count: form.field_count,
        built_at: new Date().toISOString(),
        fields: fields.map(({ id: _id, program_id: _pid, ...rest }) => rest),
      },
      dir,
    );
    log(`understand-form: wrote ${FORMCACHE_DIR_NAME}/${form.sha256}.json`);
  }
  if (useXano && credentials && origin !== 'xano' && !(xanoRows && xanoRowsMatch(xanoRows, form))) {
    try {
      const written = await xanoPutFormSchema(credentials.baseUrl, programId, fields);
      if (written && written.length === fields.length) {
        // Keep Xano's ids; everything else is what we wrote.
        const byFieldId = new Map(written.map((row) => [row.field_id, row]));
        fields = fields.map((field) => ({ ...field, id: byFieldId.get(field.field_id)?.id ?? field.id }));
      }
      log(`understand-form: PUT /programs/${programId}/form_schema (${fields.length} rows)`);
    } catch (error) {
      // The file cache already holds the rows; the system of record catches up on the next call.
      log(`understand-form: Xano write skipped — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    program_id: programId,
    sha256: form.sha256,
    sha16: form.sha16,
    page_count: form.page_count,
    field_count: form.field_count,
    fields,
    origin,
    model_calls: modelCalls,
  };
}

/**
 * M1_MODULES.understandForm — the binding signature. Returns rows that
 * satisfy `M1FormSchemaField` (section, order, options, pdf_field_name all
 * populated) even though the declared element type is the base
 * `FormSchemaField`.
 */
export async function understandForm(
  input: UnderstandFormInput,
  options: UnderstandFormOptions = {},
): Promise<FormSchemaField[]> {
  const bytes = await loadPdf(input.pdf_url);
  const result = await understandFormFromBytes(input.program_id, bytes, options);
  return result.fields;
}

/** Sections in order of first appearance, with Title-cased labels. */
export function sectionsOf(fields: readonly FormSchemaField[]): Array<{ key: string; label: string }> {
  const seen: Array<{ key: string; label: string }> = [];
  for (const field of fields) {
    const key = field.section ?? 'general';
    if (!seen.some((s) => s.key === key)) seen.push({ key, label: titleCase(key) });
  }
  return seen;
}
