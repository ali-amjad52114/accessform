/**
 * AccessForm — the Cedars-Sinai interview plan, as a cached form_schema.
 *
 * Before M1 this file hand-listed 26 questions. Now the Cedars plan is just
 * what every other form gets: `understandForm()` ran on the official
 * Cedars-Sinai application (spike/catalog.json entry #1), its 101-row
 * form_schema was cached as `lib/forms/fixtures/cedars-form-schema.json`
 * (regenerate with lib/forms/scripts/write-cedars-fixture.ts), and this
 * module loads that fixture through the same `schemaToInterviewPlan()` code
 * path the live path uses. 26 rows come out `required` with the legacy
 * `group_key` sections — that is the regression, not a hardcoded list.
 *
 * `fieldId` values are the exact AcroForm field names on the official PDF,
 * identical to the `field_id` values in `DEMO_ANSWERS`, so a saved answer
 * maps 1:1 into Instant JSON without a translation table.
 *
 * `prompt` is what the agent says out loud. It is NEVER the raw PDF label.
 */

import {
  DEMO_ANSWERS,
  DEMO_PROGRAM_ID,
  type FormFieldType,
  type FormSchemaField,
  type M1FormSchemaField,
  type ProgressStepId,
} from '../contract';
import cedarsFixture from '../forms/fixtures/cedars-form-schema.json';
import { schemaToInterviewPlan, type InterviewField } from '../forms/plan';

export type { InterviewField };

/** One row of the cached fixture: an M1 form_schema row minus ids, plus `why`/`page`. */
export interface CachedFormSchemaRow extends Omit<M1FormSchemaField, 'id' | 'program_id'> {
  why: string;
  page: number;
}

interface CachedFormSchemaFile {
  sha256: string;
  sha16: string;
  page_count: number;
  field_count: number;
  fields: Array<Omit<CachedFormSchemaRow, 'type'> & { type: string }>;
}

const FIXTURE = cedarsFixture as unknown as CachedFormSchemaFile;

/** sha256 of the official Cedars PDF the fixture was built from (first 16 hex = spike/catalog.json). */
export const CEDARS_FORM_SCHEMA_SHA16 = FIXTURE.sha16;

/**
 * Every row of the cached Cedars form_schema (101), stamped with a program
 * id. `required`, `section`, `order`, `options` and `pdf_field_name` are the
 * real M1 columns; `why` rides along for the voice layer.
 */
export function cedarsFormSchema(programId = DEMO_PROGRAM_ID): Array<FormSchemaField & CachedFormSchemaRow> {
  return FIXTURE.fields.map((row, index) => ({
    ...row,
    type: row.type as FormFieldType,
    id: `fs_${String(index + 1).padStart(3, '0')}`,
    program_id: programId,
  }));
}

/**
 * The askable questions, in asking order: required rows with a spoken
 * prompt. 26 for Cedars (8 personal, 3 household, 5 insurance, 3 income,
 * 7 monthly expenses).
 */
export const INTERVIEW_PLAN: readonly InterviewField[] = schemaToInterviewPlan(cedarsFormSchema());

/** Fast lookup by exact AcroForm field name. */
export const FIELD_BY_ID: ReadonlyMap<string, InterviewField> = new Map(
  INTERVIEW_PLAN.map((field) => [field.fieldId, field]),
);

/** Fast lookup by snake_case key, so the agent may send either form. */
export const FIELD_BY_KEY: ReadonlyMap<string, InterviewField> = new Map(
  INTERVIEW_PLAN.map((field) => [field.normalizedKey, field]),
);

/**
 * Resolve whatever the voice agent sent — an exact AcroForm name or the
 * normalized key — to a plan entry. Returns null for anything unknown so the
 * caller can reject the write instead of inventing a field.
 */
export function resolveField(fieldIdOrKey: string): InterviewField | null {
  const trimmed = fieldIdOrKey.trim();
  return FIELD_BY_ID.get(trimmed) ?? FIELD_BY_KEY.get(trimmed) ?? null;
}

/** Number of required questions in one legacy progress step. */
export function fieldCountForStep(step: ProgressStepId): number {
  return INTERVIEW_PLAN.filter((field) => field.step === step).length;
}

/**
 * The plan expressed as Xano `form_schema` rows (the 26 askable rows, M1
 * columns populated), for the fixture adapter and demo-mode lookups. Use
 * `cedarsFormSchema()` for all 101 rows.
 */
export function interviewPlanAsFormSchema(programId = DEMO_PROGRAM_ID): FormSchemaField[] {
  const askable = new Set(INTERVIEW_PLAN.map((field) => field.fieldId));
  return cedarsFormSchema(programId).filter((row) => askable.has(row.field_id));
}

/** Currency fields print a "$" in the UI; the PDF prints its own. */
export function formatFieldValue(field: InterviewField, value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '';
  return field.type === 'currency' ? `$${text}` : text;
}

/**
 * The scripted answers, keyed by AcroForm field name. Sourced from
 * `DEMO_ANSWERS` so the simulation, the fixture store and the PDF fill can
 * never drift apart.
 */
export const SCRIPTED_ANSWER_BY_FIELD_ID: ReadonlyMap<string, string> = new Map(
  DEMO_ANSWERS.map((answer) => [answer.field_id, String(answer.value_json ?? '')]),
);

/** The scripted value for a field, or '' when the fixture has none. */
export function scriptedValue(fieldId: string): string {
  return SCRIPTED_ANSWER_BY_FIELD_ID.get(fieldId) ?? '';
}
