// POST /demo/seed - put workspace 2 into the known AccessForm demo state.
//
// Idempotent: every call converges on the same rows. The hospital and program
// are upserted by natural key; the case is upserted on external_ref "AF-001";
// its answers, requirements, documents and events are replaced wholesale, so
// running this twice leaves no duplicates.
//
// The data is not invented. The 101 form_schema rows are the real AcroForm
// field names read off the official PDF (spike/cedars_form_fields.json), and
// the policy/application URLs are the verified ones from the SerpApi discovery
// already on disk (cache/discovered_program.json) - this endpoint spends no
// SerpApi quota.
//
// Jane is deliberately incomplete: 26 of 26 required form fields are collected,
// but proof of Social Security income and the applicant signature are not.
// The case ends at READY_FOR_REVIEW. Nothing here is submitted, approved,
// eligible, or signed.
query "demo/seed" verb=POST {
  api_group = "AccessForm"
  description = "Reset the AccessForm demo to the known Jane / Cedars-Sinai state. Idempotent."

  input {
  }

  stack {
    var $application_url {
      value = "https://api.hdc.hcai.ca.gov/Public/Extract/Attachment?id=1b7ee017-9db0-4a44-b3dc-a39c5986f24e"
    }
    var $policy_url {
      value = "https://hcai.ca.gov/affordability/hospital-billing-policies/cedars-sinai-medical-center/"
    }

    // ---------------------------------------------------------------
    // Hospital
    // ---------------------------------------------------------------
    db.get hospitals {
      field_name = "name"
      field_value = "Cedars-Sinai Medical Center"
    } as $existing_hospital

    conditional {
      if ($existing_hospital != null) {
        db.edit hospitals {
          field_name = "id"
          field_value = $existing_hospital.id
          data = {website: "https://www.cedars-sinai.org", hcai_id: "106190522"}
        } as $edited_hospital
        var $hospital { value = $edited_hospital }
      }
      else {
        db.add hospitals {
          data = {
            name   : "Cedars-Sinai Medical Center"
            website: "https://www.cedars-sinai.org"
            hcai_id: "106190522"
          }
        } as $added_hospital
        var $hospital { value = $added_hospital }
      }
    }

    // ---------------------------------------------------------------
    // Program - the official HCAI-hosted application, verified domain
    // ---------------------------------------------------------------
    db.query programs {
      where = $db.programs.hospital_id == $hospital.id && $db.programs.application_url == $application_url
      return = {type: "single"}
    } as $existing_program

    conditional {
      if ($existing_program != null) {
        db.edit programs {
          field_name = "id"
          field_value = $existing_program.id
          data = {
            hospital_id    : $hospital.id
            name           : "Cedars-Sinai Financial Assistance Application"
            policy_url     : $policy_url
            application_url: $application_url
            source_domain  : "api.hdc.hcai.ca.gov"
            effective_date : "2025-01-01"
            retrieved_at   : "2026-09-03T05:37:15Z"
            verified       : true
          }
        } as $edited_program
        var $program { value = $edited_program }
      }
      else {
        db.add programs {
          data = {
            hospital_id    : $hospital.id
            name           : "Cedars-Sinai Financial Assistance Application"
            policy_url     : $policy_url
            application_url: $application_url
            source_domain  : "api.hdc.hcai.ca.gov"
            effective_date : "2025-01-01"
            retrieved_at   : "2026-09-03T05:37:15Z"
            verified       : true
          }
        } as $added_program
        var $program { value = $added_program }
      }
    }

    // ---------------------------------------------------------------
    // form_schema - all 101 real AcroForm fields. The 26 the interview
    // actually asks for come first and carry required=true, a group and a
    // plain-language prompt; the rest are recorded so the field map is
    // complete but are never asked about.
    // ---------------------------------------------------------------
    db.bulk.delete form_schema {
      where = $db.form_schema.program_id == $program.id
    } as $cleared_schema

    var $schema_rows {
      value = [
        {field_id: "Patient name", label: "Full name", normalized_key: "patient_name", type: "text", required: true, group_key: "personal_information", conversational_prompt: "Let's start with your full name, exactly as it appears on your Medicare card.", pdf_mapping: {acroform_field: "Patient name", pdf_type: "text"}}
        {field_id: "Date of birth", label: "Date of birth", normalized_key: "date_of_birth", type: "date", required: true, group_key: "personal_information", conversational_prompt: "What is your date of birth?", pdf_mapping: {acroform_field: "Date of birth", pdf_type: "text"}}
        {field_id: "Home address", label: "Street address", normalized_key: "home_address", type: "text", required: true, group_key: "personal_information", conversational_prompt: "What is your street address, including any apartment number?", pdf_mapping: {acroform_field: "Home address", pdf_type: "text"}}
        {field_id: "City", label: "City", normalized_key: "city", type: "text", required: true, group_key: "personal_information", conversational_prompt: "Which city do you live in?", pdf_mapping: {acroform_field: "City", pdf_type: "text"}}
        {field_id: "State", label: "State", normalized_key: "state", type: "text", required: true, group_key: "personal_information", conversational_prompt: "And which state is that in?", pdf_mapping: {acroform_field: "State", pdf_type: "text"}}
        {field_id: "ZIP code", label: "ZIP code", normalized_key: "zip_code", type: "text", required: true, group_key: "personal_information", conversational_prompt: "What is your ZIP code?", pdf_mapping: {acroform_field: "ZIP code", pdf_type: "text"}}
        {field_id: "Home phone number", label: "Phone number", normalized_key: "home_phone_number", type: "text", required: true, group_key: "personal_information", conversational_prompt: "What is the best phone number to reach you on?", pdf_mapping: {acroform_field: "Home phone number", pdf_type: "text"}}
        {field_id: "Preferred method of contact", label: "Preferred method of contact", normalized_key: "preferred_contact_method", type: "choice", required: true, group_key: "personal_information", conversational_prompt: "How would you like the hospital to reach you: home phone, cellphone, email, or mail?", pdf_mapping: {acroform_field: "Preferred method of contact", pdf_type: "button"}}
        {field_id: "Marital status:", label: "Marital status", normalized_key: "marital_status", type: "choice", required: true, group_key: "household_information", conversational_prompt: "Are you married, single, widowed, divorced, separated, or in a domestic partnership?", pdf_mapping: {acroform_field: "Marital status:", pdf_type: "button"}}
        {field_id: "as reported on your taxes", label: "Household size as reported on your taxes", normalized_key: "household_size", type: "number", required: true, group_key: "household_information", conversational_prompt: "How many people are in your household, counting yourself, as reported on your taxes?", pdf_mapping: {acroform_field: "as reported on your taxes", pdf_type: "text"}}
        {field_id: "Employment status", label: "Employment status", normalized_key: "employment_status", type: "choice", required: true, group_key: "household_information", conversational_prompt: "Are you working right now, retired, unemployed, self-employed, or unable to work?", pdf_mapping: {acroform_field: "Employment status", pdf_type: "button"}}
        {field_id: "Insurer", label: "Health insurer", normalized_key: "insurer", type: "text", required: true, group_key: "insurance_information", conversational_prompt: "Which health insurance do you have?", pdf_mapping: {acroform_field: "Insurer", pdf_type: "text"}}
        {field_id: "Policyholder", label: "Policyholder", normalized_key: "policyholder", type: "text", required: true, group_key: "insurance_information", conversational_prompt: "Whose name is that policy in?", pdf_mapping: {acroform_field: "Policyholder", pdf_type: "text"}}
        {field_id: "Have you applied for MediCalMedicaid", label: "Applied for Medi-Cal or Medicaid", normalized_key: "applied_for_medicaid", type: "choice", required: true, group_key: "insurance_information", conversational_prompt: "Have you applied for Medi-Cal? It is fine either way, the hospital just needs to know.", pdf_mapping: {acroform_field: "Have you applied for MediCalMedicaid", pdf_type: "button"}}
        {field_id: "Have you been screened for MediCalMedicaid eligibility", label: "Screened for Medi-Cal or Medicaid eligibility", normalized_key: "screened_for_medicaid", type: "choice", required: true, group_key: "insurance_information", conversational_prompt: "Has anyone screened you for Medi-Cal eligibility?", pdf_mapping: {acroform_field: "Have you been screened for MediCalMedicaid eligibility", pdf_type: "button"}}
        {field_id: "Are you eligible for any health insurance coverage?", label: "Eligible for health insurance coverage", normalized_key: "eligible_for_coverage", type: "choice", required: true, group_key: "insurance_information", conversational_prompt: "Are you covered by any health insurance at the moment?", pdf_mapping: {acroform_field: "Are you eligible for any health insurance coverage?", pdf_type: "button"}}
        {field_id: "Annual household income:", label: "Annual household income", normalized_key: "annual_household_income", type: "currency", required: true, group_key: "income_information", conversational_prompt: "About how much income does your household receive in a year, before any deductions? The hospital asks because the discount is based on income.", pdf_mapping: {acroform_field: "Annual household income:", pdf_type: "text"}}
        {field_id: "Gross income", label: "Monthly gross income", normalized_key: "monthly_gross_income", type: "currency", required: true, group_key: "income_information", conversational_prompt: "And how much comes in each month, before deductions?", pdf_mapping: {acroform_field: "Gross income", pdf_type: "text"}}
        {field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health", label: "Outstanding Cedars-Sinai balance", normalized_key: "outstanding_cedars_balance", type: "currency", required: true, group_key: "income_information", conversational_prompt: "How much do you still owe Cedars-Sinai?", pdf_mapping: {acroform_field: "Outstanding medical debt at Cedars-Sinai or Huntington Health", pdf_type: "text"}}
        {field_id: "Rent or mortgage", label: "Rent or mortgage (monthly)", normalized_key: "monthly_rent_or_mortgage", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "How much do you pay for rent or your mortgage each month?", pdf_mapping: {acroform_field: "Rent or mortgage", pdf_type: "text"}}
        {field_id: "Utilities and telephone", label: "Utilities and telephone (monthly)", normalized_key: "monthly_utilities", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "About how much are your utilities and phone each month?", pdf_mapping: {acroform_field: "Utilities and telephone", pdf_type: "text"}}
        {field_id: "Food", label: "Food (monthly)", normalized_key: "monthly_food", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "Roughly how much do you spend on food each month?", pdf_mapping: {acroform_field: "Food", pdf_type: "text"}}
        {field_id: "Medical and dental", label: "Medical and dental (monthly)", normalized_key: "monthly_medical", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "How much goes to medical and dental costs in a typical month?", pdf_mapping: {acroform_field: "Medical and dental", pdf_type: "text"}}
        {field_id: "Transportation and auto (insurance, gas, repairs, lease)", label: "Transportation (monthly)", normalized_key: "monthly_transportation", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "What do you spend on getting around each month, including any car costs?", pdf_mapping: {acroform_field: "Transportation and auto (insurance, gas, repairs, lease)", pdf_type: "text"}}
        {field_id: "Clothing and laundry", label: "Clothing and laundry (monthly)", normalized_key: "monthly_clothing", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "And about how much for clothing and laundry?", pdf_mapping: {acroform_field: "Clothing and laundry", pdf_type: "text"}}
        {field_id: "Total monthly expenses", label: "Total monthly expenses", normalized_key: "monthly_total_expenses", type: "currency", required: true, group_key: "monthly_expenses", conversational_prompt: "So that comes to about this much a month in total. Does that sound right?", pdf_mapping: {acroform_field: "Total monthly expenses", pdf_type: "text"}}
        {field_id: "Social Security number", label: "Social Security number", normalized_key: "social_security_number", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Social Security number", pdf_type: "text"}}
        {field_id: "Cellphone number", label: "Cellphone number", normalized_key: "cellphone_number", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Cellphone number", pdf_type: "text"}}
        {field_id: "Email address", label: "Email address", normalized_key: "email_address", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Email address", pdf_type: "text"}}
        {field_id: "Unemployed – Last date worked", label: "Unemployed – Last date worked", normalized_key: "unemployed_last_date_worked", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Unemployed – Last date worked", pdf_type: "text"}}
        {field_id: "Employer name", label: "Employer name", normalized_key: "employer_name", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Employer name", pdf_type: "text"}}
        {field_id: "Phone number", label: "Phone number", normalized_key: "phone_number", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Phone number", pdf_type: "text"}}
        {field_id: "Employer address", label: "Employer address", normalized_key: "employer_address", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Employer address", pdf_type: "text"}}
        {field_id: "City_2", label: "City_2", normalized_key: "city_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "City_2", pdf_type: "text"}}
        {field_id: "State_2", label: "State_2", normalized_key: "state_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "State_2", pdf_type: "text"}}
        {field_id: "ZIP code_2", label: "ZIP code_2", normalized_key: "zip_code_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "ZIP code_2", pdf_type: "text"}}
        {field_id: "Relationship to patient", label: "Relationship to patient", normalized_key: "relationship_to_patient", type: "choice", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Relationship to patient", pdf_type: "button"}}
        {field_id: "Other:_1", label: "Other:_1", normalized_key: "other_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other:_1", pdf_type: "text"}}
        {field_id: "Name", label: "Name", normalized_key: "name", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Name", pdf_type: "text"}}
        {field_id: "Social Security number_2", label: "Social Security number_2", normalized_key: "social_security_number_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Social Security number_2", pdf_type: "text"}}
        {field_id: "Date of birth_2", label: "Date of birth_2", normalized_key: "date_of_birth_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Date of birth_2", pdf_type: "text"}}
        {field_id: "Employment status_1", label: "Employment status_1", normalized_key: "employment_status_1", type: "choice", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Employment status_1", pdf_type: "button"}}
        {field_id: "Unemployed – Last date worked:", label: "Unemployed – Last date worked:", normalized_key: "unemployed_last_date_worked", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Unemployed – Last date worked:", pdf_type: "text"}}
        {field_id: "Employer name_2", label: "Employer name_2", normalized_key: "employer_name_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Employer name_2", pdf_type: "text"}}
        {field_id: "Phone number_2", label: "Phone number_2", normalized_key: "phone_number_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Phone number_2", pdf_type: "text"}}
        {field_id: "Employer address_2", label: "Employer address_2", normalized_key: "employer_address_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Employer address_2", pdf_type: "text"}}
        {field_id: "City_3", label: "City_3", normalized_key: "city_3", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "City_3", pdf_type: "text"}}
        {field_id: "State_3", label: "State_3", normalized_key: "state_3", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "State_3", pdf_type: "text"}}
        {field_id: "ZIP code_3", label: "ZIP code_3", normalized_key: "zip_code_3", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "ZIP code_3", pdf_type: "text"}}
        {field_id: "Policy number", label: "Policy number", normalized_key: "policy_number", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Policy number", pdf_type: "text"}}
        {field_id: "Policyholder_2", label: "Policyholder_2", normalized_key: "policyholder_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Policyholder_2", pdf_type: "text"}}
        {field_id: "Insurer_2", label: "Insurer_2", normalized_key: "insurer_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Insurer_2", pdf_type: "text"}}
        {field_id: "Policy number_2", label: "Policy number_2", normalized_key: "policy_number_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Policy number_2", pdf_type: "text"}}
        {field_id: "If Yes please describe the results of that application", label: "If Yes please describe the results of that application", normalized_key: "if_yes_please_describe_the_results_of_that_application", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "If Yes please describe the results of that application", pdf_type: "text"}}
        {field_id: "If Yes please describe the results of that screening", label: "If Yes please describe the results of that screening", normalized_key: "if_yes_please_describe_the_results_of_that_screening", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "If Yes please describe the results of that screening", pdf_type: "text"}}
        {field_id: "Gross income_2", label: "Gross income_2", normalized_key: "gross_income_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Gross income_2", pdf_type: "text"}}
        {field_id: "Gross income_3", label: "Gross income_3", normalized_key: "gross_income_3", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Gross income_3", pdf_type: "text"}}
        {field_id: "Rent or mortgage_1", label: "Rent or mortgage_1", normalized_key: "rent_or_mortgage_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Rent or mortgage_1", pdf_type: "text"}}
        {field_id: "Rent or mortgage_2", label: "Rent or mortgage_2", normalized_key: "rent_or_mortgage_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Rent or mortgage_2", pdf_type: "text"}}
        {field_id: "Real estate taxes", label: "Real estate taxes", normalized_key: "real_estate_taxes", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Real estate taxes", pdf_type: "text"}}
        {field_id: "Real estate taxes_1", label: "Real estate taxes_1", normalized_key: "real_estate_taxes_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Real estate taxes_1", pdf_type: "text"}}
        {field_id: "Real estate taxes_2", label: "Real estate taxes_2", normalized_key: "real_estate_taxes_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Real estate taxes_2", pdf_type: "text"}}
        {field_id: "Home maintenance cleaning and household supplies", label: "Home maintenance cleaning and household supplies", normalized_key: "home_maintenance_cleaning_and_household_supplies", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Home maintenance cleaning and household supplies", pdf_type: "text"}}
        {field_id: "Home maintenance cleaning and household supplies_1", label: "Home maintenance cleaning and household supplies_1", normalized_key: "home_maintenance_cleaning_and_household_supplies_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Home maintenance cleaning and household supplies_1", pdf_type: "text"}}
        {field_id: "Home maintenance cleaning and household supplies_2", label: "Home maintenance cleaning and household supplies_2", normalized_key: "home_maintenance_cleaning_and_household_supplies_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Home maintenance cleaning and household supplies_2", pdf_type: "text"}}
        {field_id: "Utilities and telephone_1", label: "Utilities and telephone_1", normalized_key: "utilities_and_telephone_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Utilities and telephone_1", pdf_type: "text"}}
        {field_id: "Utilities and telephone_2", label: "Utilities and telephone_2", normalized_key: "utilities_and_telephone_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Utilities and telephone_2", pdf_type: "text"}}
        {field_id: "Clothing and laundry_1", label: "Clothing and laundry_1", normalized_key: "clothing_and_laundry_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Clothing and laundry_1", pdf_type: "text"}}
        {field_id: "Clothing and laundry_2", label: "Clothing and laundry_2", normalized_key: "clothing_and_laundry_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Clothing and laundry_2", pdf_type: "text"}}
        {field_id: "Medical and dental_1", label: "Medical and dental_1", normalized_key: "medical_and_dental_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Medical and dental_1", pdf_type: "text"}}
        {field_id: "Medical and dental_2", label: "Medical and dental_2", normalized_key: "medical_and_dental_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Medical and dental_2", pdf_type: "text"}}
        {field_id: "Alimony/Child support", label: "Alimony/Child support", normalized_key: "alimony_child_support", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Alimony/Child support", pdf_type: "text"}}
        {field_id: "Alimony/Child support_1", label: "Alimony/Child support_1", normalized_key: "alimony_child_support_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Alimony/Child support_1", pdf_type: "text"}}
        {field_id: "Alimony/Child support_2", label: "Alimony/Child support_2", normalized_key: "alimony_child_support_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Alimony/Child support_2", pdf_type: "text"}}
        {field_id: "Transportation and auto (insurance, gas, repairs, lease)_1", label: "Transportation and auto (insurance, gas, repairs, lease)_1", normalized_key: "transportation_and_auto_insurance_gas_repairs_lease_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Transportation and auto (insurance, gas, repairs, lease)_1", pdf_type: "text"}}
        {field_id: "Education", label: "Education", normalized_key: "education", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Education", pdf_type: "text"}}
        {field_id: "Education_1", label: "Education_1", normalized_key: "education_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Education_1", pdf_type: "text"}}
        {field_id: "Education_2", label: "Education_2", normalized_key: "education_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Education_2", pdf_type: "text"}}
        {field_id: "School/Childcare (minor dependents)", label: "School/Childcare (minor dependents)", normalized_key: "school_childcare_minor_dependents", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "School/Childcare (minor dependents)", pdf_type: "text"}}
        {field_id: "School/Childcare (minor dependents)_1", label: "School/Childcare (minor dependents)_1", normalized_key: "school_childcare_minor_dependents_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "School/Childcare (minor dependents)_1", pdf_type: "text"}}
        {field_id: "School/Childcare (minor dependents)_2", label: "School/Childcare (minor dependents)_2", normalized_key: "school_childcare_minor_dependents_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "School/Childcare (minor dependents)_2", pdf_type: "text"}}
        {field_id: "Food_1", label: "Food_1", normalized_key: "food_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Food_1", pdf_type: "text"}}
        {field_id: "Food_2", label: "Food_2", normalized_key: "food_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Food_2", pdf_type: "text"}}
        {field_id: "Insurance", label: "Insurance", normalized_key: "insurance", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Insurance", pdf_type: "text"}}
        {field_id: "Insurance_1", label: "Insurance_1", normalized_key: "insurance_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Insurance_1", pdf_type: "text"}}
        {field_id: "Insurance_2", label: "Insurance_2", normalized_key: "insurance_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Insurance_2", pdf_type: "text"}}
        {field_id: "Other extraordinary expenses", label: "Other extraordinary expenses", normalized_key: "other_extraordinary_expenses", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other extraordinary expenses", pdf_type: "text"}}
        {field_id: "Other extraordinary expenses_1", label: "Other extraordinary expenses_1", normalized_key: "other_extraordinary_expenses_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other extraordinary expenses_1", pdf_type: "text"}}
        {field_id: "Other extraordinary expenses_2", label: "Other extraordinary expenses_2", normalized_key: "other_extraordinary_expenses_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other extraordinary expenses_2", pdf_type: "text"}}
        {field_id: "Total monthly expenses_1", label: "Total monthly expenses_1", normalized_key: "total_monthly_expenses_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Total monthly expenses_1", pdf_type: "text"}}
        {field_id: "Total monthly expenses_2", label: "Total monthly expenses_2", normalized_key: "total_monthly_expenses_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Total monthly expenses_2", pdf_type: "text"}}
        {field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health_1", label: "Outstanding medical debt at Cedars-Sinai or Huntington Health_1", normalized_key: "outstanding_medical_debt_at_cedars_sinai_or_huntington_health_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Outstanding medical debt at Cedars-Sinai or Huntington Health_1", pdf_type: "text"}}
        {field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health_2", label: "Outstanding medical debt at Cedars-Sinai or Huntington Health_2", normalized_key: "outstanding_medical_debt_at_cedars_sinai_or_huntington_health_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Outstanding medical debt at Cedars-Sinai or Huntington Health_2", pdf_type: "text"}}
        {field_id: "Other medical debt", label: "Other medical debt", normalized_key: "other_medical_debt", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other medical debt", pdf_type: "text"}}
        {field_id: "Other medical debt_1", label: "Other medical debt_1", normalized_key: "other_medical_debt_1", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other medical debt_1", pdf_type: "text"}}
        {field_id: "Other medical debt_2", label: "Other medical debt_2", normalized_key: "other_medical_debt_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Other medical debt_2", pdf_type: "text"}}
        {field_id: "Yes I consent to the use of presumptive eligibility for the consideration of Charity Care or Discount", label: "Yes I consent to the use of presumptive eligibility for the consideration of Charity Care or Discount", normalized_key: "yes_i_consent_to_the_use_of_presumptive_eligibility_for_the_consideration_of_charity_care_or_discount", type: "choice", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Yes I consent to the use of presumptive eligibility for the consideration of Charity Care or Discount", pdf_type: "button"}}
        {field_id: "Signature of person applying for financial assistance", label: "Signature of person applying for financial assistance", normalized_key: "signature_of_person_applying_for_financial_assistance", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Signature of person applying for financial assistance", pdf_type: "text"}}
        {field_id: "Date", label: "Date", normalized_key: "date", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Date", pdf_type: "text"}}
        {field_id: "Signature of spousedomestic partnerguarantor if applicable", label: "Signature of spousedomestic partnerguarantor if applicable", normalized_key: "signature_of_spousedomestic_partnerguarantor_if_applicable", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Signature of spousedomestic partnerguarantor if applicable", pdf_type: "text"}}
        {field_id: "Date_2", label: "Date_2", normalized_key: "date_2", type: "text", required: false, group_key: null, conversational_prompt: null, pdf_mapping: {acroform_field: "Date_2", pdf_type: "text"}}
      ]
    }

    foreach ($schema_rows) {
      each as $row {
        db.add form_schema {
          data = {
            program_id           : $program.id
            field_id             : $row.field_id
            label                : $row.label
            normalized_key       : $row.normalized_key
            type                 : $row.type
            required             : $row.required
            group_key            : $row.group_key
            conversational_prompt: $row.conversational_prompt
            pdf_mapping          : $row.pdf_mapping
          }
        } as $schema_row
      }
    }

    // ---------------------------------------------------------------
    // Case AF-001
    // ---------------------------------------------------------------
    db.get cases {
      field_name = "external_ref"
      field_value = "AF-001"
    } as $existing_case

    conditional {
      if ($existing_case != null) {
        db.edit cases {
          field_name = "id"
          field_value = $existing_case.id
          data = {
            patient_display_name: "Jane Doe"
            hospital_id         : $hospital.id
            program_id          : $program.id
            bill_amount         : 7800
            status              : "READY_FOR_REVIEW"
            progress_percent    : 86
            external_ref        : "AF-001"
            updated_at          : "now"
          }
        } as $edited_case
        var $case { value = $edited_case }
      }
      else {
        db.add cases {
          data = {
            patient_display_name: "Jane Doe"
            hospital_id         : $hospital.id
            program_id          : $program.id
            bill_amount         : 7800
            status              : "READY_FOR_REVIEW"
            progress_percent    : 86
            external_ref        : "AF-001"
            updated_at          : "now"
          }
        } as $added_case
        var $case { value = $added_case }
      }
    }

    // ---------------------------------------------------------------
    // Jane's answers. Currency values carry no "$" - the form prints one.
    // The monthly lines sum to the 1,850 total.
    // ---------------------------------------------------------------
    db.bulk.delete answers {
      where = $db.answers.case_id == $case.id
    } as $cleared_answers

    var $answer_rows {
      value = [
        {field_id: "Patient name", value: "Jane Doe"}
        {field_id: "Date of birth", value: "01/15/1958"}
        {field_id: "Home address", value: "1234 Beverly Blvd, Apt 5"}
        {field_id: "City", value: "Los Angeles"}
        {field_id: "State", value: "CA"}
        {field_id: "ZIP code", value: "90048"}
        {field_id: "Home phone number", value: "(323) 555-0142"}
        {field_id: "Preferred method of contact", value: "Home phone"}
        {field_id: "Marital status:", value: "Single"}
        {field_id: "as reported on your taxes", value: "1"}
        {field_id: "Employment status", value: "Retired"}
        {field_id: "Insurer", value: "Medicare"}
        {field_id: "Policyholder", value: "Jane Doe"}
        {field_id: "Have you applied for MediCalMedicaid", value: "No"}
        {field_id: "Have you been screened for MediCalMedicaid eligibility", value: "No"}
        {field_id: "Are you eligible for any health insurance coverage?", value: "Yes"}
        {field_id: "Annual household income:", value: "24,600"}
        {field_id: "Gross income", value: "2,050"}
        {field_id: "Outstanding medical debt at Cedars-Sinai or Huntington Health", value: "7,800"}
        {field_id: "Rent or mortgage", value: "950"}
        {field_id: "Utilities and telephone", value: "180"}
        {field_id: "Food", value: "320"}
        {field_id: "Medical and dental", value: "230"}
        {field_id: "Transportation and auto (insurance, gas, repairs, lease)", value: "110"}
        {field_id: "Clothing and laundry", value: "60"}
        {field_id: "Total monthly expenses", value: "1,850"}
      ]
    }

    foreach ($answer_rows) {
      each as $answer {
        db.add answers {
          data = {
            case_id   : $case.id
            field_id  : $answer.field_id
            value_json: $answer.value
            source    : "voice"
            confirmed : true
          }
        } as $answer_row
      }
    }

    // ---------------------------------------------------------------
    // Requirement checklist. Two items are missing on purpose; POST
    // /cases/{id}/validate recomputes exactly these from the data.
    // ---------------------------------------------------------------
    db.bulk.delete requirements {
      where = $db.requirements.case_id == $case.id
    } as $cleared_requirements

    var $requirement_rows {
      value = [
        {key: "personal_information", label: "Personal information", type: "field", status: "complete"}
        {key: "household_information", label: "Household information", type: "field", status: "complete"}
        {key: "insurance_information", label: "Insurance information", type: "field", status: "complete"}
        {key: "income_information", label: "Income information", type: "field", status: "complete"}
        {key: "monthly_expenses", label: "Monthly expenses", type: "field", status: "complete"}
        {key: "proof_of_social_security_income", label: "Proof of Social Security income", type: "attachment", status: "missing"}
        {key: "applicant_signature", label: "Signature of person applying for financial assistance", type: "signature", status: "missing"}
      ]
    }

    foreach ($requirement_rows) {
      each as $requirement {
        db.add requirements {
          data = {
            case_id: $case.id
            key    : $requirement.key
            label  : $requirement.label
            type   : $requirement.type
            status : $requirement.status
          }
        } as $requirement_row
      }
    }

    // ---------------------------------------------------------------
    // Documents: the official source PDF, and the filled output the demo
    // shows in the viewer. No supporting document - that is the gap.
    // ---------------------------------------------------------------
    db.bulk.delete documents {
      where = $db.documents.case_id == $case.id
    } as $cleared_documents

    db.add documents {
      data = {
        case_id             : $case.id
        type                : "source_application"
        source_url          : $application_url
        accessibility_status: "not_applicable"
      }
    } as $source_doc

    db.add documents {
      data = {
        case_id             : $case.id
        type                : "filled_application"
        source_url          : $application_url
        generated_url       : "/fixtures/cedars-application-filled.pdf"
        accessibility_status: "processed"
        version_hash        : "demo-af-001-v1"
      }
    } as $filled_doc

    // ---------------------------------------------------------------
    // Sponsor-visibility feed for /live.
    // ---------------------------------------------------------------
    db.bulk.delete events {
      where = $db.events.case_id == $case.id
    } as $cleared_events

    var $event_rows {
      value = [
        {at: "2026-09-03T05:31:04Z", actor: "user", event_type: "call_started", message: "Call started", metadata_json: {}}
        {at: "2026-09-03T05:31:22Z", actor: "serpapi", event_type: "program_discovered", message: "Official Cedars program found", metadata_json: {policy_url: "https://hcai.ca.gov/affordability/hospital-billing-policies/cedars-sinai-medical-center/"}}
        {at: "2026-09-03T05:31:29Z", actor: "serpapi", event_type: "source_verified", message: "HCAI source verified", metadata_json: {source_domain: "hcai.ca.gov"}}
        {at: "2026-09-03T05:31:48Z", actor: "nutrient", event_type: "form_extracted", message: "Form structure extracted", metadata_json: {fields: 101}}
        {at: "2026-09-03T05:32:01Z", actor: "xano", event_type: "case_created", message: "Case created", metadata_json: {external_ref: "AF-001"}}
        {at: "2026-09-03T05:38:12Z", actor: "xano", event_type: "answer_saved", message: "Household answer saved", metadata_json: {field_id: "as reported on your taxes"}}
        {at: "2026-09-03T05:41:37Z", actor: "xano", event_type: "answer_saved", message: "Income answer saved", metadata_json: {field_id: "Annual household income:"}}
        {at: "2026-09-03T05:43:02Z", actor: "xano", event_type: "missing_requirement_detected", message: "Missing proof of income detected", metadata_json: {key: "proof_of_social_security_income"}}
        {at: "2026-09-03T05:45:10Z", actor: "nutrient", event_type: "document_generated", message: "Completed PDF generated", metadata_json: {fields_filled: 26}}
        {at: "2026-09-03T05:45:52Z", actor: "nutrient", event_type: "accessibility_processed", message: "Accessibility processing complete", metadata_json: {accessibility_status: "processed"}}
      ]
    }

    foreach ($event_rows) {
      each as $event {
        db.add events {
          data = {
            case_id      : $case.id
            created_at   : $event.at
            actor        : $event.actor
            event_type   : $event.event_type
            message      : $event.message
            metadata_json: $event.metadata_json
          }
        } as $event_row
      }
    }

    // ---------------------------------------------------------------
    // Reset means reset. Anything left over from probing or from a
    // discovery run that failed source verification is removed, so the demo
    // database holds exactly one hospital, one official program, one case.
    // ---------------------------------------------------------------
    db.query cases {
      return = {type: "list"}
    } as $all_cases

    var $stale_cases {
      value = $all_cases|filter:$$.id != $case.id
    }

    foreach ($stale_cases) {
      each as $stale_case {
        db.bulk.delete answers {
          where = $db.answers.case_id == $stale_case.id
        } as $dropped_answers
        db.bulk.delete requirements {
          where = $db.requirements.case_id == $stale_case.id
        } as $dropped_requirements
        db.bulk.delete documents {
          where = $db.documents.case_id == $stale_case.id
        } as $dropped_documents
        db.bulk.delete events {
          where = $db.events.case_id == $stale_case.id
        } as $dropped_events
        db.del cases {
          field_name = "id"
          field_value = $stale_case.id
        }
      }
    }

    db.query programs {
      return = {type: "list"}
    } as $all_programs

    var $stale_programs {
      value = $all_programs|filter:$$.id != $program.id
    }

    foreach ($stale_programs) {
      each as $stale_program {
        db.bulk.delete form_schema {
          where = $db.form_schema.program_id == $stale_program.id
        } as $dropped_schema
        db.del programs {
          field_name = "id"
          field_value = $stale_program.id
        }
      }
    }

    db.query form_schema {
      where = $db.form_schema.program_id == $program.id
      return = {type: "count"}
    } as $schema_count

    db.query form_schema {
      where = $db.form_schema.program_id == $program.id && $db.form_schema.required == true
      return = {type: "count"}
    } as $required_count
  }

  response = {
    ok             : true
    hospital_id    : $hospital.id
    program_id     : $program.id
    case_id        : $case.id
    external_ref   : "AF-001"
    application_url: $application_url
    policy_url     : $policy_url
    form_fields    : $schema_count
    required_fields: $required_count
    answers_seeded : ($answer_rows|count)
    requirements   : ($requirement_rows|count)
    documents      : 2
    events_seeded  : ($event_rows|count)
    stale_cases_removed   : ($stale_cases|count)
    stale_programs_removed: ($stale_programs|count)
    status         : $case.status
  }
  tags = ["accessform"]
  guid = "5To7_S68sxP9heQih6jiLMwgF5E"
}
