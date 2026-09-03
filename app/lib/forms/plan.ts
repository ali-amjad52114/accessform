/**
 * form_schema rows -> the interview plan the voice layer walks.
 *
 * This is the ONE code path from a form's schema (whatever produced it —
 * understandForm(), Xano, or the cached Cedars fixture) to the ordered list
 * of questions the agent may ask. `lib/voice/form-plan.ts` is now just this
 * function applied to the Cedars fixture.
 */

import {
  LEGACY_STEP_SECTION_ALIASES,
  type FormFieldType,
  type FormSchemaField,
  type ProgressStepId,
} from '../contract';

/** One question the agent may ask, in asking order. */
export interface InterviewField {
  /** Exact AcroForm field name in the official PDF (= form_schema.field_id). */
  fieldId: string;
  /** Stable snake_case key used by voice + UI. */
  normalizedKey: string;
  /** Human label as printed on the form (for the UI, never spoken verbatim). */
  label: string;
  type: FormFieldType;
  required: boolean;
  /** Which of the eight legacy /live progress steps this question rolls up into. */
  step: ProgressStepId;
  /** The form's own section key (form_schema.section). */
  section: string;
  /** The spoken question. */
  prompt: string;
  /** Spoken only when the caller asks why, or when the topic is sensitive. */
  why: string | null;
  /** Export values for option fields, slash-less. Empty for text. */
  options: string[];
  /** 1-based asking order across the whole form. */
  order: number;
}

/** Legacy step that a section rolls up into, per LEGACY_STEP_SECTION_ALIASES; null when none matches. */
export function legacyStepForSection(section: string): ProgressStepId | null {
  const key = section.trim().toLowerCase();
  for (const [step, aliases] of Object.entries(LEGACY_STEP_SECTION_ALIASES)) {
    if ((aliases as readonly string[]).includes(key)) return step as ProgressStepId;
  }
  return null;
}

/**
 * The askable questions of a schema: required, with a spoken prompt, in
 * `order`. Sections with no legacy alias (a paratransit "mobility_aids")
 * roll up into `personal_information` so the eight-step card still counts
 * every question exactly once.
 */
export function schemaToInterviewPlan(rows: readonly FormSchemaField[]): InterviewField[] {
  const plan = rows
    .filter((row) => row.required && row.conversational_prompt.trim() !== '' && row.type !== 'signature')
    .map((row, index) => {
      const section = row.section ?? 'general';
      const why = (row as { why?: unknown }).why;
      return {
        fieldId: row.field_id,
        normalizedKey: row.normalized_key,
        label: row.label,
        type: row.type,
        required: row.required,
        step: legacyStepForSection(section) ?? 'personal_information',
        section,
        prompt: row.conversational_prompt,
        why: typeof why === 'string' && why.trim() !== '' ? why : null,
        options: (row.options ?? []).slice(),
        order: typeof row.order === 'number' && row.order > 0 ? row.order : index + 1,
      } satisfies InterviewField;
    });
  plan.sort((a, b) => a.order - b.order);
  return plan;
}
