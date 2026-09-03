/**
 * The normalized Cedars-Sinai question set.
 *
 * Every `field_id` below is an exact AcroForm field name taken from the official
 * PDF (verified: 101 fields, 90 text + 9 button groups). The 26 rows here are
 * the subset the voice agent actually asks Jane about, in asking order, so they
 * map 1:1 onto `DEMO_ANSWERS` and straight into Instant JSON.
 *
 * `conversational_prompt` is what the agent says out loud. It is never the raw
 * PDF label — reading "as reported on your taxes" aloud is useless to a caller.
 *
 * Button/radio values are the export values without the leading "/" — that form
 * is proven to fill correctly through POST /build.
 */

import {
  DEMO_PROGRAM_ID,
  type FormFieldType,
  type FormSchemaField,
  type Id,
  type RequirementType,
} from '../contract';

/**
 * The seven requirement groups a case is scored against.
 * Order matters: it is the order the interview walks through them.
 */
export const REQUIREMENT_GROUP_KEYS = [
  'personal_information',
  'household_information',
  'insurance_information',
  'income_information',
  'monthly_expenses',
  'proof_of_social_security_income',
  'applicant_signature',
] as const;

export type RequirementGroupKey = (typeof REQUIREMENT_GROUP_KEYS)[number];

/** Groups that are satisfied by answering form fields (vs. attaching/signing). */
export const FIELD_GROUP_KEYS = [
  'personal_information',
  'household_information',
  'insurance_information',
  'income_information',
  'monthly_expenses',
] as const satisfies readonly RequirementGroupKey[];

export type FieldGroupKey = (typeof FIELD_GROUP_KEYS)[number];

export interface RequirementGroupDefinition {
  key: RequirementGroupKey;
  label: string;
  type: RequirementType;
}

export const REQUIREMENT_GROUPS: readonly RequirementGroupDefinition[] = [
  { key: 'personal_information', label: 'Personal information', type: 'field' },
  { key: 'household_information', label: 'Household information', type: 'field' },
  { key: 'insurance_information', label: 'Insurance information', type: 'field' },
  { key: 'income_information', label: 'Income information', type: 'field' },
  { key: 'monthly_expenses', label: 'Monthly expenses', type: 'field' },
  {
    key: 'proof_of_social_security_income',
    label: 'Proof of Social Security income',
    type: 'attachment',
  },
  {
    key: 'applicant_signature',
    label: 'Signature of person applying for financial assistance',
    type: 'signature',
  },
];

/** A schema row plus the group it is scored under. */
export interface FixtureFormField extends FormSchemaField {
  group: FieldGroupKey;
  /** Export values for button groups; empty for text fields. */
  choices: string[];
}

interface Spec {
  field_id: string;
  label: string;
  normalized_key: string;
  type: FormFieldType;
  group: FieldGroupKey;
  prompt: string;
  choices?: string[];
  required?: boolean;
  dependency?: string;
}

const SPECS: Spec[] = [
  /* --- Personal information (8) ------------------------------------- */
  {
    field_id: 'Patient name',
    label: 'Patient name',
    normalized_key: 'patient_name',
    type: 'text',
    group: 'personal_information',
    prompt: 'Can you tell me your full name, the way it appears on your hospital bill?',
  },
  {
    field_id: 'Date of birth',
    label: 'Date of birth',
    normalized_key: 'date_of_birth',
    type: 'date',
    group: 'personal_information',
    prompt: 'What is your date of birth?',
  },
  {
    field_id: 'Home address',
    label: 'Home address',
    normalized_key: 'home_address',
    type: 'text',
    group: 'personal_information',
    prompt: 'What is your street address, including the apartment number if you have one?',
  },
  {
    field_id: 'City',
    label: 'City',
    normalized_key: 'city',
    type: 'text',
    group: 'personal_information',
    prompt: 'And which city is that in?',
  },
  {
    field_id: 'State',
    label: 'State',
    normalized_key: 'state',
    type: 'text',
    group: 'personal_information',
    prompt: 'Which state?',
  },
  {
    field_id: 'ZIP code',
    label: 'ZIP code',
    normalized_key: 'zip_code',
    type: 'text',
    group: 'personal_information',
    prompt: 'What is your ZIP code?',
  },
  {
    field_id: 'Home phone number',
    label: 'Home phone number',
    normalized_key: 'home_phone_number',
    type: 'text',
    group: 'personal_information',
    prompt: 'What phone number should the hospital use to reach you?',
  },
  {
    field_id: 'Preferred method of contact',
    label: 'Preferred method of contact',
    normalized_key: 'preferred_method_of_contact',
    type: 'radio',
    group: 'personal_information',
    choices: ['Cellphone', 'Email', 'Home phone', 'U.S. mail'],
    prompt:
      'How would you prefer Cedars-Sinai to contact you — home phone, cellphone, email, or mail?',
  },

  /* --- Household information (3) ------------------------------------ */
  {
    field_id: 'Marital status:',
    label: 'Marital status',
    normalized_key: 'marital_status',
    type: 'radio',
    group: 'household_information',
    choices: ['Divorced', 'Domestic partner', 'Married', 'Separated', 'Single', 'Widowed'],
    prompt:
      'The form asks about marital status. Are you single, married, in a domestic partnership, separated, divorced, or widowed?',
  },
  {
    field_id: 'as reported on your taxes',
    label: 'Number of people in your household, as reported on your taxes',
    normalized_key: 'household_size',
    type: 'number',
    group: 'household_information',
    prompt:
      'How many people are in your household? That means everyone you claim on your taxes, including yourself.',
  },
  {
    field_id: 'Employment status',
    label: 'Employment status',
    normalized_key: 'employment_status',
    type: 'radio',
    group: 'household_information',
    choices: ['Disabled', 'Employed', 'Retired', 'Self-employed', 'Unemployed'],
    prompt: 'Are you currently working, retired, unemployed, self-employed, or disabled?',
  },

  /* --- Insurance information (5) ------------------------------------ */
  {
    field_id: 'Insurer',
    label: 'Insurer',
    normalized_key: 'insurer',
    type: 'text',
    group: 'insurance_information',
    prompt: 'Do you have health insurance right now, and who is it through?',
  },
  {
    field_id: 'Policyholder',
    label: 'Policyholder',
    normalized_key: 'policyholder',
    type: 'text',
    group: 'insurance_information',
    prompt: 'Is the policy in your own name, or someone else’s?',
  },
  {
    field_id: 'Have you applied for MediCalMedicaid',
    label: 'Have you applied for Medi-Cal / Medicaid?',
    normalized_key: 'applied_for_medi_cal',
    type: 'radio',
    group: 'insurance_information',
    choices: ['Yes', 'No'],
    prompt: 'Have you ever applied for Medi-Cal?',
  },
  {
    field_id: 'Have you been screened for MediCalMedicaid eligibility',
    label: 'Have you been screened for Medi-Cal / Medicaid eligibility?',
    normalized_key: 'screened_for_medi_cal',
    type: 'radio',
    group: 'insurance_information',
    choices: ['Yes', 'No'],
    prompt: 'Has anyone at the hospital checked whether you qualify for Medi-Cal?',
  },
  {
    field_id: 'Are you eligible for any health insurance coverage?',
    label: 'Are you eligible for any health insurance coverage?',
    normalized_key: 'eligible_for_coverage',
    type: 'radio',
    group: 'insurance_information',
    choices: ['Yes', 'No'],
    prompt:
      'The form asks whether you can get any health coverage. You mentioned Medicare — should I put yes for that?',
  },

  /* --- Income information (3) --------------------------------------- */
  {
    field_id: 'Annual household income:',
    label: 'Annual household income',
    normalized_key: 'annual_household_income',
    type: 'currency',
    group: 'income_information',
    prompt:
      'I can work out your yearly income from your monthly amount. Does about twenty-four thousand six hundred a year sound right?',
  },
  {
    field_id: 'Gross income',
    label: 'Gross monthly income',
    normalized_key: 'gross_monthly_income',
    type: 'currency',
    group: 'income_information',
    prompt: 'Is Social Security your only source of income?',
  },
  {
    field_id: 'Outstanding medical debt at Cedars-Sinai or Huntington Health',
    label: 'Outstanding medical debt at Cedars-Sinai or Huntington Health',
    normalized_key: 'outstanding_medical_debt',
    type: 'currency',
    group: 'income_information',
    prompt: 'And how much is the Cedars-Sinai bill you are trying to get help with?',
  },

  /* --- Monthly expenses (7) ----------------------------------------- */
  {
    field_id: 'Rent or mortgage',
    label: 'Rent or mortgage',
    normalized_key: 'expense_rent_or_mortgage',
    type: 'currency',
    group: 'monthly_expenses',
    prompt: 'How much do you pay each month for rent or your mortgage?',
  },
  {
    field_id: 'Utilities and telephone',
    label: 'Utilities and telephone',
    normalized_key: 'expense_utilities_and_telephone',
    type: 'currency',
    group: 'monthly_expenses',
    prompt: 'Roughly what do your utilities and phone come to in a month?',
  },
  {
    field_id: 'Food',
    label: 'Food',
    normalized_key: 'expense_food',
    type: 'currency',
    group: 'monthly_expenses',
    prompt: 'About how much do you spend on groceries and food each month?',
  },
  {
    field_id: 'Medical and dental',
    label: 'Medical and dental',
    normalized_key: 'expense_medical_and_dental',
    type: 'currency',
    group: 'monthly_expenses',
    prompt:
      'What do you spend on medical and dental costs each month, including any prescriptions?',
  },
  {
    field_id: 'Transportation and auto (insurance, gas, repairs, lease)',
    label: 'Transportation and auto',
    normalized_key: 'expense_transportation_and_auto',
    type: 'currency',
    group: 'monthly_expenses',
    prompt: 'What does getting around cost you in a month — rides, bus, gas, or car costs?',
  },
  {
    field_id: 'Clothing and laundry',
    label: 'Clothing and laundry',
    normalized_key: 'expense_clothing_and_laundry',
    type: 'currency',
    group: 'monthly_expenses',
    prompt: 'And roughly how much for clothing and laundry?',
  },
  {
    field_id: 'Total monthly expenses',
    label: 'Total monthly expenses',
    normalized_key: 'total_monthly_expenses',
    type: 'currency',
    group: 'monthly_expenses',
    prompt:
      'Adding those up I get about one thousand eight hundred fifty a month. Does that sound close?',
  },
];

function toField(spec: Spec, index: number, programId: Id): FixtureFormField {
  return {
    id: `fs_${String(index + 1).padStart(2, '0')}`,
    program_id: programId,
    field_id: spec.field_id,
    label: spec.label,
    normalized_key: spec.normalized_key,
    type: spec.type,
    required: spec.required ?? true,
    conversational_prompt: spec.prompt,
    dependency_rule: spec.dependency ?? null,
    pdf_mapping: spec.field_id,
    group: spec.group,
    choices: spec.choices ?? [],
  };
}

/** The 26 questions, in asking order. */
export const FIXTURE_FORM_SCHEMA: readonly FixtureFormField[] = SPECS.map((spec, index) =>
  toField(spec, index, DEMO_PROGRAM_ID),
);

/** Same rows, narrowed to the plain contract type. */
export const FIXTURE_FORM_SCHEMA_FIELDS: readonly FormSchemaField[] = FIXTURE_FORM_SCHEMA;

const BY_FIELD_ID = new Map<string, FixtureFormField>(
  FIXTURE_FORM_SCHEMA.map((field) => [field.field_id, field]),
);
const BY_NORMALIZED_KEY = new Map<string, FixtureFormField>(
  FIXTURE_FORM_SCHEMA.map((field) => [field.normalized_key, field]),
);

/**
 * Resolve either an exact AcroForm field name or a `normalized_key` to a schema
 * row. The voice agent is allowed to send whichever it has.
 */
export function resolveField(fieldIdOrKey: string): FixtureFormField | undefined {
  return BY_FIELD_ID.get(fieldIdOrKey) ?? BY_NORMALIZED_KEY.get(fieldIdOrKey);
}

/** Field ids belonging to a group, in asking order. */
export function fieldsInGroup(group: FieldGroupKey): readonly FixtureFormField[] {
  return FIXTURE_FORM_SCHEMA.filter((field) => field.group === group);
}

/** 26 — the denominator behind "26 of 26 required fields". */
export const FIXTURE_REQUIRED_FIELD_COUNT = FIXTURE_FORM_SCHEMA.filter(
  (field) => field.required,
).length;
