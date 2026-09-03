/**
 * AccessForm — the interview plan.
 *
 * One entry per question the voice agent may ask, in asking order. The order
 * follows the eight `PROGRESS_STEP_IDS` on /live, so "what do I ask next?" is
 * always answerable from this array plus the answers saved so far.
 *
 * `fieldId` values are the exact AcroForm field names on the official
 * Cedars-Sinai application (spike/cedars_form_fields.json), identical to the
 * `field_id` values in `DEMO_ANSWERS`, so a saved answer maps 1:1 into
 * Instant JSON without a translation table.
 *
 * `prompt` is what the agent says out loud. It is NEVER the raw PDF label:
 * "Do you live alone?" — not "Household size:".
 */

import {
  DEMO_ANSWERS,
  DEMO_PROGRAM_ID,
  type FormFieldType,
  type FormSchemaField,
  type ProgressStepId,
} from '../contract';

export interface InterviewField {
  /** Exact AcroForm field name in the official PDF. */
  fieldId: string;
  /** Stable snake_case key used by voice + UI. */
  normalizedKey: string;
  /** Human label as printed on the form (for the UI, never spoken verbatim). */
  label: string;
  type: FormFieldType;
  required: boolean;
  /** Which of the eight /live progress steps this question belongs to. */
  step: ProgressStepId;
  /** The spoken question. */
  prompt: string;
  /** Spoken only when the patient asks why, or when the topic is sensitive. */
  why: string | null;
}

/**
 * 26 required questions: 8 personal, 2 household, 5 insurance, 11 income.
 * The `documents` and `review` steps carry requirements, not form fields.
 */
export const INTERVIEW_PLAN: readonly InterviewField[] = [
  /* ---------------- Personal information ---------------- */
  {
    fieldId: 'Patient name',
    normalizedKey: 'patient_name',
    label: 'Patient name',
    type: 'text',
    required: true,
    step: 'personal_information',
    prompt: 'Can I start with your full name, as it appears on your hospital bill?',
    why: 'The hospital matches your application to your account by name.',
  },
  {
    fieldId: 'Date of birth',
    normalizedKey: 'date_of_birth',
    label: 'Date of birth',
    type: 'date',
    required: true,
    step: 'personal_information',
    prompt: 'And what is your date of birth?',
    why: 'Cedars-Sinai uses your date of birth to be sure they have the right patient record.',
  },
  {
    fieldId: 'Home address',
    normalizedKey: 'home_address',
    label: 'Home address',
    type: 'text',
    required: true,
    step: 'personal_information',
    prompt: 'What is your street address, including an apartment number if you have one?',
    why: null,
  },
  {
    fieldId: 'City',
    normalizedKey: 'city',
    label: 'City',
    type: 'text',
    required: true,
    step: 'personal_information',
    prompt: 'Which city is that in?',
    why: null,
  },
  {
    fieldId: 'State',
    normalizedKey: 'state',
    label: 'State',
    type: 'text',
    required: true,
    step: 'personal_information',
    prompt: 'And which state?',
    why: null,
  },
  {
    fieldId: 'ZIP code',
    normalizedKey: 'zip_code',
    label: 'ZIP code',
    type: 'text',
    required: true,
    step: 'personal_information',
    prompt: 'What is your ZIP code?',
    why: null,
  },
  {
    fieldId: 'Home phone number',
    normalizedKey: 'home_phone_number',
    label: 'Home phone number',
    type: 'text',
    required: true,
    step: 'personal_information',
    prompt: 'What phone number should the hospital use to reach you?',
    why: null,
  },
  {
    fieldId: 'Preferred method of contact',
    normalizedKey: 'preferred_contact_method',
    label: 'Preferred method of contact',
    type: 'choice',
    required: true,
    step: 'personal_information',
    prompt: 'Would you rather they reach you by phone, or by mail?',
    why: null,
  },

  /* ---------------- Household ---------------- */
  {
    fieldId: 'Marital status:',
    normalizedKey: 'marital_status',
    label: 'Marital status',
    type: 'choice',
    required: true,
    step: 'household',
    prompt: 'The form asks about marital status — are you single, married, widowed, or divorced?',
    why: 'It affects how the hospital counts your household.',
  },
  {
    fieldId: 'as reported on your taxes',
    normalizedKey: 'household_size',
    label: 'Household size as reported on your taxes',
    type: 'number',
    required: true,
    step: 'household',
    prompt: 'Do you live alone, or is anyone else in your household?',
    why: 'The discount is worked out against household size, so living alone can help you.',
  },

  /* ---------------- Insurance ---------------- */
  {
    fieldId: 'Insurer',
    normalizedKey: 'insurer',
    label: 'Insurer',
    type: 'text',
    required: true,
    step: 'insurance',
    prompt: 'Do you have health coverage right now — Medicare, Medi-Cal, or a private plan?',
    why: null,
  },
  {
    fieldId: 'Policyholder',
    normalizedKey: 'policyholder',
    label: 'Policyholder',
    type: 'text',
    required: true,
    step: 'insurance',
    prompt: 'Is that coverage in your own name?',
    why: null,
  },
  {
    fieldId: 'Have you applied for MediCalMedicaid',
    normalizedKey: 'applied_for_medicaid',
    label: 'Have you applied for Medi-Cal / Medicaid?',
    type: 'choice',
    required: true,
    step: 'insurance',
    prompt: 'Have you applied for Medi-Cal at any point?',
    why: 'Cedars-Sinai has to ask this before they can apply their own discount.',
  },
  {
    fieldId: 'Have you been screened for MediCalMedicaid eligibility',
    normalizedKey: 'screened_for_medicaid',
    label: 'Have you been screened for Medi-Cal / Medicaid eligibility?',
    type: 'choice',
    required: true,
    step: 'insurance',
    prompt: 'Has anyone at the hospital checked whether you qualify for Medi-Cal?',
    why: null,
  },
  {
    fieldId: 'Are you eligible for any health insurance coverage?',
    normalizedKey: 'eligible_for_coverage',
    label: 'Are you eligible for any health insurance coverage?',
    type: 'choice',
    required: true,
    step: 'insurance',
    prompt: 'And you are covered by Medicare today — is that right?',
    why: null,
  },

  /* ---------------- Income and monthly costs ---------------- */
  {
    fieldId: 'Employment status',
    normalizedKey: 'employment_status',
    label: 'Employment status',
    type: 'choice',
    required: true,
    step: 'income',
    prompt: 'Are you working at the moment, or retired?',
    why: null,
  },
  {
    fieldId: 'Gross income',
    normalizedKey: 'gross_monthly_income',
    label: 'Gross monthly income',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'About how much money comes in each month, before anything is taken out?',
    why: 'The hospital needs your income to work out how much of the bill you may not have to pay. It stays with your application.',
  },
  {
    fieldId: 'Annual household income:',
    normalizedKey: 'annual_household_income',
    label: 'Annual household income',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'Is that your only source of income for the year?',
    why: 'The form asks for a yearly total, so I add up the monthly amounts for you.',
  },
  {
    fieldId: 'Rent or mortgage',
    normalizedKey: 'rent_or_mortgage',
    label: 'Rent or mortgage',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'How much do you pay for rent or your mortgage each month?',
    why: 'The form asks what you spend each month, so the hospital can see what is left over.',
  },
  {
    fieldId: 'Utilities and telephone',
    normalizedKey: 'utilities_and_telephone',
    label: 'Utilities and telephone',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'Roughly what do your utilities and phone come to each month?',
    why: null,
  },
  {
    fieldId: 'Food',
    normalizedKey: 'food',
    label: 'Food',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'And about how much on groceries and food?',
    why: null,
  },
  {
    fieldId: 'Medical and dental',
    normalizedKey: 'medical_and_dental',
    label: 'Medical and dental',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'What do you spend on medications and medical or dental costs in a month?',
    why: null,
  },
  {
    fieldId: 'Transportation and auto (insurance, gas, repairs, lease)',
    normalizedKey: 'transportation_and_auto',
    label: 'Transportation and auto',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'How about getting around — rides, bus fare, or a car?',
    why: null,
  },
  {
    fieldId: 'Clothing and laundry',
    normalizedKey: 'clothing_and_laundry',
    label: 'Clothing and laundry',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'And clothing and laundry?',
    why: null,
  },
  {
    fieldId: 'Total monthly expenses',
    normalizedKey: 'total_monthly_expenses',
    label: 'Total monthly expenses',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'Let me add those up and read the total back to you.',
    why: null,
  },
  {
    fieldId: 'Outstanding medical debt at Cedars-Sinai or Huntington Health',
    normalizedKey: 'outstanding_medical_debt',
    label: 'Outstanding medical debt at Cedars-Sinai',
    type: 'currency',
    required: true,
    step: 'income',
    prompt: 'And the Cedars-Sinai bill you mentioned — is that the full amount you still owe them?',
    why: null,
  },
];

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

/** Number of required questions in one progress step. */
export function fieldCountForStep(step: ProgressStepId): number {
  return INTERVIEW_PLAN.filter((field) => field.step === step).length;
}

/** The plan expressed as Xano `form_schema` rows, for the fixture adapter. */
export function interviewPlanAsFormSchema(programId = DEMO_PROGRAM_ID): FormSchemaField[] {
  return INTERVIEW_PLAN.map((field, index) => ({
    id: `fs_${String(index + 1).padStart(2, '0')}`,
    program_id: programId,
    field_id: field.fieldId,
    label: field.label,
    normalized_key: field.normalizedKey,
    type: field.type,
    required: field.required,
    conversational_prompt: field.prompt,
    dependency_rule: null,
    pdf_mapping: field.fieldId,
  }));
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
