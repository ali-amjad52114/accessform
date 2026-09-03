/**
 * The Cedars-Sinai regression: the 26 questions the live Xano program 1
 * carries today (GET /programs/1/fields, 2026-09-03), with the `group_key`
 * each sits in. docs/M1_CONTRACT.md §3.3 says understandForm() MUST mark
 * exactly these `required: true` with these sections — and this file is the
 * assertion data for that test. It is NOT used as an override in product
 * code; `understandForm()` has to earn it.
 */

export interface CedarsRegressionField {
  field_id: string;
  section: string;
}

export const CEDARS_REGRESSION_FIELDS: readonly CedarsRegressionField[] = [
  { field_id: 'Patient name', section: 'personal_information' },
  { field_id: 'Date of birth', section: 'personal_information' },
  { field_id: 'Home address', section: 'personal_information' },
  { field_id: 'City', section: 'personal_information' },
  { field_id: 'State', section: 'personal_information' },
  { field_id: 'ZIP code', section: 'personal_information' },
  { field_id: 'Home phone number', section: 'personal_information' },
  { field_id: 'Preferred method of contact', section: 'personal_information' },
  { field_id: 'Marital status:', section: 'household_information' },
  { field_id: 'as reported on your taxes', section: 'household_information' },
  { field_id: 'Employment status', section: 'household_information' },
  { field_id: 'Insurer', section: 'insurance_information' },
  { field_id: 'Policyholder', section: 'insurance_information' },
  { field_id: 'Have you applied for MediCalMedicaid', section: 'insurance_information' },
  { field_id: 'Have you been screened for MediCalMedicaid eligibility', section: 'insurance_information' },
  { field_id: 'Are you eligible for any health insurance coverage?', section: 'insurance_information' },
  { field_id: 'Annual household income:', section: 'income_information' },
  { field_id: 'Gross income', section: 'income_information' },
  { field_id: 'Outstanding medical debt at Cedars-Sinai or Huntington Health', section: 'income_information' },
  { field_id: 'Rent or mortgage', section: 'monthly_expenses' },
  { field_id: 'Utilities and telephone', section: 'monthly_expenses' },
  { field_id: 'Food', section: 'monthly_expenses' },
  { field_id: 'Medical and dental', section: 'monthly_expenses' },
  { field_id: 'Transportation and auto (insurance, gas, repairs, lease)', section: 'monthly_expenses' },
  { field_id: 'Clothing and laundry', section: 'monthly_expenses' },
  { field_id: 'Total monthly expenses', section: 'monthly_expenses' },
];

export const CEDARS_REGRESSION_FIELD_IDS: ReadonlySet<string> = new Set(
  CEDARS_REGRESSION_FIELDS.map((field) => field.field_id),
);
