# Generates accessform-xano/api/accessform/demo_seed_POST.xs from the verified
# fixtures: spike/cedars_form_fields.json (101 AcroForm fields) and
# cache/discovered_program.json (SerpApi discovery, already spent).
import io, json, re, unicodedata

FIELDS = json.load(io.open(r'C:/AI/api3/spike/cedars_form_fields.json', encoding='utf-8'))
DISCO = json.load(io.open(r'C:/AI/api3/cache/discovered_program.json', encoding='utf-8'))

APP_URL = 'https://api.hdc.hcai.ca.gov/Public/Extract/Attachment?id=1b7ee017-9db0-4a44-b3dc-a39c5986f24e'
POLICY_URL = DISCO['policy_url']

# The 26 required fields, in interview order, grouped exactly as the
# requirement checklist groups them. field_id values are the exact AcroForm
# names, so answers map 1:1 into Nutrient Instant JSON.
REQUIRED = [
    # (field_id, label, normalized_key, type, group_key, prompt, answer)
    ("Patient name", "Full name", "patient_name", "text", "personal_information",
     "Let's start with your full name, exactly as it appears on your Medicare card.", "Jane Doe"),
    ("Date of birth", "Date of birth", "date_of_birth", "date", "personal_information",
     "What is your date of birth?", "01/15/1958"),
    ("Home address", "Street address", "home_address", "text", "personal_information",
     "What is your street address, including any apartment number?", "1234 Beverly Blvd, Apt 5"),
    ("City", "City", "city", "text", "personal_information",
     "Which city do you live in?", "Los Angeles"),
    ("State", "State", "state", "text", "personal_information",
     "And which state is that in?", "CA"),
    ("ZIP code", "ZIP code", "zip_code", "text", "personal_information",
     "What is your ZIP code?", "90048"),
    ("Home phone number", "Phone number", "home_phone_number", "text", "personal_information",
     "What is the best phone number to reach you on?", "(323) 555-0142"),
    ("Preferred method of contact", "Preferred method of contact", "preferred_contact_method", "choice", "personal_information",
     "How would you like the hospital to reach you: home phone, cellphone, email, or mail?", "Home phone"),

    ("Marital status:", "Marital status", "marital_status", "choice", "household_information",
     "Are you married, single, widowed, divorced, separated, or in a domestic partnership?", "Single"),
    ("as reported on your taxes", "Household size as reported on your taxes", "household_size", "number", "household_information",
     "How many people are in your household, counting yourself, as reported on your taxes?", "1"),
    ("Employment status", "Employment status", "employment_status", "choice", "household_information",
     "Are you working right now, retired, unemployed, self-employed, or unable to work?", "Retired"),

    ("Insurer", "Health insurer", "insurer", "text", "insurance_information",
     "Which health insurance do you have?", "Medicare"),
    ("Policyholder", "Policyholder", "policyholder", "text", "insurance_information",
     "Whose name is that policy in?", "Jane Doe"),
    ("Have you applied for MediCalMedicaid", "Applied for Medi-Cal or Medicaid", "applied_for_medicaid", "choice", "insurance_information",
     "Have you applied for Medi-Cal? It is fine either way, the hospital just needs to know.", "No"),
    ("Have you been screened for MediCalMedicaid eligibility", "Screened for Medi-Cal or Medicaid eligibility", "screened_for_medicaid", "choice", "insurance_information",
     "Has anyone screened you for Medi-Cal eligibility?", "No"),
    ("Are you eligible for any health insurance coverage?", "Eligible for health insurance coverage", "eligible_for_coverage", "choice", "insurance_information",
     "Are you covered by any health insurance at the moment?", "Yes"),

    ("Annual household income:", "Annual household income", "annual_household_income", "currency", "income_information",
     "About how much income does your household receive in a year, before any deductions? The hospital asks because the discount is based on income.", "24,600"),
    ("Gross income", "Monthly gross income", "monthly_gross_income", "currency", "income_information",
     "And how much comes in each month, before deductions?", "2,050"),
    ("Outstanding medical debt at Cedars-Sinai or Huntington Health", "Outstanding Cedars-Sinai balance", "outstanding_cedars_balance", "currency", "income_information",
     "How much do you still owe Cedars-Sinai?", "7,800"),

    ("Rent or mortgage", "Rent or mortgage (monthly)", "monthly_rent_or_mortgage", "currency", "monthly_expenses",
     "How much do you pay for rent or your mortgage each month?", "950"),
    ("Utilities and telephone", "Utilities and telephone (monthly)", "monthly_utilities", "currency", "monthly_expenses",
     "About how much are your utilities and phone each month?", "180"),
    ("Food", "Food (monthly)", "monthly_food", "currency", "monthly_expenses",
     "Roughly how much do you spend on food each month?", "320"),
    ("Medical and dental", "Medical and dental (monthly)", "monthly_medical", "currency", "monthly_expenses",
     "How much goes to medical and dental costs in a typical month?", "230"),
    ("Transportation and auto (insurance, gas, repairs, lease)", "Transportation (monthly)", "monthly_transportation", "currency", "monthly_expenses",
     "What do you spend on getting around each month, including any car costs?", "110"),
    ("Clothing and laundry", "Clothing and laundry (monthly)", "monthly_clothing", "currency", "monthly_expenses",
     "And about how much for clothing and laundry?", "60"),
    ("Total monthly expenses", "Total monthly expenses", "monthly_total_expenses", "currency", "monthly_expenses",
     "So that comes to about this much a month in total. Does that sound right?", "1,850"),
]

req_by_id = {r[0]: r for r in REQUIRED}
assert len(REQUIRED) == 26, len(REQUIRED)

field_ids = [f['field_id'] for f in FIELDS]
for fid in req_by_id:
    assert fid in field_ids, 'missing from PDF: ' + repr(fid)


def slug(s):
    s = unicodedata.normalize('NFKD', s)
    s = re.sub(r'[^A-Za-z0-9]+', '_', s).strip('_').lower()
    return s or 'field'


def xs_str(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


def xs_val(v):
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    return xs_str(v)


# ---- form_schema rows, all 101, required ones first so id order = ask order ----
ordered = [f for f in FIELDS if f['field_id'] in req_by_id]
ordered.sort(key=lambda f: [r[0] for r in REQUIRED].index(f['field_id']))
ordered += [f for f in FIELDS if f['field_id'] not in req_by_id]
assert len(ordered) == 101

schema_lines = []
for f in ordered:
    fid = f['field_id']
    pdf_type = f['type']
    if fid in req_by_id:
        _, label, nkey, ftype, gkey, prompt, _ans = req_by_id[fid]
        required = True
    else:
        label = fid
        nkey = slug(fid)
        ftype = 'choice' if pdf_type == 'button' else 'text'
        gkey = None
        prompt = None
        required = False
    mapping = '{acroform_field: %s, pdf_type: %s}' % (xs_str(fid), xs_str(pdf_type))
    schema_lines.append(
        '        {field_id: %s, label: %s, normalized_key: %s, type: %s, required: %s, group_key: %s, conversational_prompt: %s, pdf_mapping: %s}'
        % (xs_str(fid), xs_str(label), xs_str(nkey), xs_str(ftype),
           'true' if required else 'false', xs_val(gkey), xs_val(prompt), mapping))

# ---- Jane's 26 answers ----
answer_lines = [
    '        {field_id: %s, value: %s}' % (xs_str(r[0]), xs_str(r[6]))
    for r in REQUIRED
]

# ---- requirement checklist ----
REQS = [
    ("personal_information", "Personal information", "field", "complete"),
    ("household_information", "Household information", "field", "complete"),
    ("insurance_information", "Insurance information", "field", "complete"),
    ("income_information", "Income information", "field", "complete"),
    ("monthly_expenses", "Monthly expenses", "field", "complete"),
    ("proof_of_social_security_income", "Proof of Social Security income", "attachment", "missing"),
    ("applicant_signature", "Signature of person applying for financial assistance", "signature", "missing"),
]
req_lines = [
    '        {key: %s, label: %s, type: %s, status: %s}' % (xs_str(k), xs_str(l), xs_str(t), xs_str(s))
    for (k, l, t, s) in REQS
]

# ---- sponsor-visibility event feed ----
EVENTS = [
    ("2026-09-03T05:31:04Z", "user", "call_started", "Call started", '{}'),
    ("2026-09-03T05:31:22Z", "serpapi", "program_discovered", "Official Cedars program found",
     '{policy_url: %s}' % xs_str(POLICY_URL)),
    ("2026-09-03T05:31:29Z", "serpapi", "source_verified", "HCAI source verified",
     '{source_domain: "hcai.ca.gov"}'),
    ("2026-09-03T05:31:48Z", "nutrient", "form_extracted", "Form structure extracted", '{fields: 101}'),
    ("2026-09-03T05:32:01Z", "xano", "case_created", "Case created", '{external_ref: "AF-001"}'),
    ("2026-09-03T05:38:12Z", "xano", "answer_saved", "Household answer saved",
     '{field_id: "as reported on your taxes"}'),
    ("2026-09-03T05:41:37Z", "xano", "answer_saved", "Income answer saved",
     '{field_id: "Annual household income:"}'),
    ("2026-09-03T05:43:02Z", "xano", "missing_requirement_detected", "Missing proof of income detected",
     '{key: "proof_of_social_security_income"}'),
    ("2026-09-03T05:45:10Z", "nutrient", "document_generated", "Completed PDF generated", '{fields_filled: 26}'),
    ("2026-09-03T05:45:52Z", "nutrient", "accessibility_processed", "Accessibility processing complete",
     '{accessibility_status: "processed"}'),
]
event_lines = [
    '        {at: %s, actor: %s, event_type: %s, message: %s, metadata_json: %s}'
    % (xs_str(a), xs_str(ac), xs_str(et), xs_str(m), md)
    for (a, ac, et, m, md) in EVENTS
]

TEMPLATE = '''// POST /demo/seed - put workspace 2 into the known AccessForm demo state.
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
      value = "__APP_URL__"
    }
    var $policy_url {
      value = "__POLICY_URL__"
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
__SCHEMA__
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
__ANSWERS__
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
__REQS__
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
__EVENTS__
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
'''

out = (TEMPLATE
       .replace('__APP_URL__', APP_URL)
       .replace('__POLICY_URL__', POLICY_URL)
       .replace('__SCHEMA__', '\n'.join(schema_lines))
       .replace('__ANSWERS__', '\n'.join(answer_lines))
       .replace('__REQS__', '\n'.join(req_lines))
       .replace('__EVENTS__', '\n'.join(event_lines)))

io.open(r'C:/AI/api3/accessform-xano/api/accessform/demo_seed_POST.xs', 'w',
        encoding='utf-8', newline='\n').write(out)
print('wrote demo_seed_POST.xs', len(out), 'bytes;', len(ordered), 'schema rows;',
      len(answer_lines), 'answers;', len(req_lines), 'requirements;', len(event_lines), 'events')
print('policy_url =', POLICY_URL)
