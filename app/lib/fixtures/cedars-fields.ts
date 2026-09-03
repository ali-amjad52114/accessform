/**
 * The 101 real AcroForm fields on the official Cedars-Sinai financial-assistance
 * application (verified live: 394,890 bytes, 90 text fields + 9 button groups
 * + 2 signature text fields).
 *
 * GENERATED from `spike/cedars_form_fields.json`. Button `states` are the raw
 * PDF export values and carry a leading "/". Instant JSON wants them WITHOUT
 * the slash — use `exportValues()`.
 */

import type { PdfFormFieldDescriptor } from '../contract';

export const CEDARS_FORM_FIELDS: readonly PdfFormFieldDescriptor[] = [
  { field_id: "Patient name", type: "text", states: [] },
  { field_id: "Social Security number", type: "text", states: [] },
  { field_id: "Date of birth", type: "text", states: [] },
  { field_id: "Home address", type: "text", states: [] },
  { field_id: "City", type: "text", states: [] },
  { field_id: "State", type: "text", states: [] },
  { field_id: "ZIP code", type: "text", states: [] },
  { field_id: "Home phone number", type: "text", states: [] },
  { field_id: "Cellphone number", type: "text", states: [] },
  { field_id: "Email address", type: "text", states: [] },
  { field_id: "Preferred method of contact", type: "button", states: ["/Cellphone", "/Email", "/Home phone", "/U.S. mail"] },
  { field_id: "Annual household income:", type: "text", states: [] },
  { field_id: "Marital status:", type: "button", states: ["/Divorced", "/Domestic partner", "/Married", "/Separated", "/Single", "/Widowed"] },
  { field_id: "as reported on your taxes", type: "text", states: [] },
  { field_id: "Employment status", type: "button", states: ["/Disabled", "/Employed", "/Retired", "/Self-employed", "/Unemployed \u0085 Last date worked:"] },
  { field_id: "Unemployed \u2013 Last date worked", type: "text", states: [] },
  { field_id: "Employer name", type: "text", states: [] },
  { field_id: "Phone number", type: "text", states: [] },
  { field_id: "Employer address", type: "text", states: [] },
  { field_id: "City_2", type: "text", states: [] },
  { field_id: "State_2", type: "text", states: [] },
  { field_id: "ZIP code_2", type: "text", states: [] },
  { field_id: "Relationship to patient", type: "button", states: ["/Domestic partner", "/Guarantor", "/Other", "/Parent", "/Spouse"] },
  { field_id: "Other:_1", type: "text", states: [] },
  { field_id: "Name", type: "text", states: [] },
  { field_id: "Social Security number_2", type: "text", states: [] },
  { field_id: "Date of birth_2", type: "text", states: [] },
  { field_id: "Employment status_1", type: "button", states: ["/Disabled", "/Employed", "/Retired", "/Self-employed", "/Unemployed \u0085 Last date worked:"] },
  { field_id: "Unemployed \u2013 Last date worked:", type: "text", states: [] },
  { field_id: "Employer name_2", type: "text", states: [] },
  { field_id: "Phone number_2", type: "text", states: [] },
  { field_id: "Employer address_2", type: "text", states: [] },
  { field_id: "City_3", type: "text", states: [] },
  { field_id: "State_3", type: "text", states: [] },
  { field_id: "ZIP code_3", type: "text", states: [] },
  { field_id: "Policyholder", type: "text", states: [] },
  { field_id: "Insurer", type: "text", states: [] },
  { field_id: "Policy number", type: "text", states: [] },
  { field_id: "Policyholder_2", type: "text", states: [] },
  { field_id: "Insurer_2", type: "text", states: [] },
  { field_id: "Policy number_2", type: "text", states: [] },
  { field_id: "Have you applied for MediCalMedicaid", type: "button", states: ["/No", "/Yes"] },
  { field_id: "If Yes please describe the results of that application", type: "text", states: [] },
  { field_id: "Have you been screened for MediCalMedicaid eligibility", type: "button", states: ["/No", "/Yes"] },
  { field_id: "If Yes please describe the results of that screening", type: "text", states: [] },
  { field_id: "Are you eligible for any health insurance coverage?", type: "button", states: ["/No", "/Yes"] },
  { field_id: "Gross income", type: "text", states: [] },
  { field_id: "Gross income_2", type: "text", states: [] },
  { field_id: "Gross income_3", type: "text", states: [] },
  { field_id: "Rent or mortgage", type: "text", states: [] },
  { field_id: "Rent or mortgage_1", type: "text", states: [] },
  { field_id: "Rent or mortgage_2", type: "text", states: [] },
  { field_id: "Real estate taxes", type: "text", states: [] },
  { field_id: "Real estate taxes_1", type: "text", states: [] },
  { field_id: "Real estate taxes_2", type: "text", states: [] },
  { field_id: "Home maintenance cleaning and household supplies", type: "text", states: [] },
  { field_id: "Home maintenance cleaning and household supplies_1", type: "text", states: [] },
  { field_id: "Home maintenance cleaning and household supplies_2", type: "text", states: [] },
  { field_id: "Utilities and telephone", type: "text", states: [] },
  { field_id: "Utilities and telephone_1", type: "text", states: [] },
  { field_id: "Utilities and telephone_2", type: "text", states: [] },
  { field_id: "Clothing and laundry", type: "text", states: [] },
  { field_id: "Clothing and laundry_1", type: "text", states: [] },
  { field_id: "Clothing and laundry_2", type: "text", states: [] },
  { field_id: "Medical and dental", type: "text", states: [] },
  { field_id: "Medical and dental_1", type: "text", states: [] },
  { field_id: "Medical and dental_2", type: "text", states: [] },
  { field_id: "Alimony/Child support", type: "text", states: [] },
  { field_id: "Alimony/Child support_1", type: "text", states: [] },
  { field_id: "Alimony/Child support_2", type: "text", states: [] },
  { field_id: "Transportation and auto (insurance, gas, repairs, lease)", type: "text", states: [] },
  { field_id: "Transportation and auto (insurance, gas, repairs, lease)_1", type: "text", states: [] },
  { field_id: "Education", type: "text", states: [] },
  { field_id: "Education_1", type: "text", states: [] },
  { field_id: "Education_2", type: "text", states: [] },
  { field_id: "School/Childcare (minor dependents)", type: "text", states: [] },
  { field_id: "School/Childcare (minor dependents)_1", type: "text", states: [] },
  { field_id: "School/Childcare (minor dependents)_2", type: "text", states: [] },
  { field_id: "Food", type: "text", states: [] },
  { field_id: "Food_1", type: "text", states: [] },
  { field_id: "Food_2", type: "text", states: [] },
  { field_id: "Insurance", type: "text", states: [] },
  { field_id: "Insurance_1", type: "text", states: [] },
  { field_id: "Insurance_2", type: "text", states: [] },
  { field_id: "Other extraordinary expenses", type: "text", states: [] },
  { field_id: "Other extraordinary expenses_1", type: "text", states: [] },
  { field_id: "Other extraordinary expenses_2", type: "text", states: [] },
  { field_id: "Total monthly expenses", type: "text", states: [] },
  { field_id: "Total monthly expenses_1", type: "text", states: [] },
  { field_id: "Total monthly expenses_2", type: "text", states: [] },
  { field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health", type: "text", states: [] },
  { field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health_1", type: "text", states: [] },
  { field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health_2", type: "text", states: [] },
  { field_id: "Other medical debt", type: "text", states: [] },
  { field_id: "Other medical debt_1", type: "text", states: [] },
  { field_id: "Other medical debt_2", type: "text", states: [] },
  { field_id: "Yes I consent to the use of presumptive eligibility for the consideration of Charity Care or Discount", type: "button", states: ["/Off", "/On"] },
  { field_id: "Signature of person applying for financial assistance", type: "text", states: [] },
  { field_id: "Date", type: "text", states: [] },
  { field_id: "Signature of spousedomestic partnerguarantor if applicable", type: "text", states: [] },
  { field_id: "Date_2", type: "text", states: [] },
];

/** Export values for a button group, with the PDF name-object "/" stripped. */
export function exportValues(field: PdfFormFieldDescriptor): string[] {
  return field.states.map((state) => (state.startsWith('/') ? state.slice(1) : state));
}

const BY_ID = new Map<string, PdfFormFieldDescriptor>(
  CEDARS_FORM_FIELDS.map((field) => [field.field_id, field]),
);

export function findFormField(fieldId: string): PdfFormFieldDescriptor | undefined {
  return BY_ID.get(fieldId);
}
