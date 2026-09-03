// The one place completeness is computed. Read-only.
//
// POST /cases/{id}/validate, GET /cases/{id}/progress and
// GET /cases/{id}/next_question all call this, so percent, sections and the
// next question can never disagree with each other.
//
// Sections are the form's own (form_schema.section, falling back to the
// legacy group_key) in order of first appearance. For Cedars-Sinai that is
// the five groups the demo always had, so the regression scores identically.
//
// Score: half the dial is the required form fields, half is the requirement
// checklist - one item per section, plus the evidence items the published
// policy demands (proof of income for hospital financial assistance, and the
// applicant's signature). AccessForm never signs anything, so the signature
// item stays missing until a human supplies it.
function "case_completeness" {
  description = "Authoritative completeness for a case: fields, sections, requirement checklist, percent, next field."

  input {
    int case_id
  }

  stack {
    db.get cases {
      field_name = "id"
      field_value = $input.case_id
    } as $case

    precondition ($case != null) {
      error_type = "notfound"
      error = "No case found with that id."
    }

    db.get programs {
      field_name = "id"
      field_value = $case.program_id
    } as $program

    var $program_id { value = 0 }
    var $category { value = "hospital_financial_assistance" }
    conditional {
      if ($program != null) {
        var.update $program_id { value = $program.id }
        conditional {
          if (($program.category ?? "") != "") {
            var.update $category { value = $program.category }
          }
        }
      }
    }

    function.run "form_schema_rows" {
      input = {program_id: $program_id, required_only: false}
    } as $all_fields

    var $required_rows {
      value = $all_fields|filter:$$.required == true
    }

    db.query answers {
      where = $db.answers.case_id == $case.id
      sort = {id: "asc"}
      return = {type: "list"}
    } as $answers

    // Blank strings and nulls do not count as answered.
    var $answered {
      value = $answers|filter:$$.value_json != null && (($$.value_json|to_text)|trim) != ""
    }
    var $answered_ids {
      value = $answered|map:$$.field_id
    }
    // Delimited membership string. Field ids come from the AcroForm and never
    // contain a pipe, so this stays an exact-match test.
    var $answered_key {
      value = "|" ~ ($answered_ids|join:"|") ~ "|"
    }

    // ---------------------------------------------------------------
    // Dependency rules: "<normalized_key> == '<value>'". A field whose rule
    // evaluates false against the saved answers is not applicable right now
    // and is left out of every count. Unparsable rule or unknown key => ask.
    // ---------------------------------------------------------------
    var $required_fields { value = [] }
    var $rule { value = "" }
    var $parts { value = [] }
    var $dep_key { value = "" }
    var $dep_value { value = "" }
    var $dep_field { value = null }
    var $dep_field_id { value = "" }
    var $dep_answer { value = null }
    var $keep { value = true }

    foreach ($required_rows) {
      each as $row {
        var.update $keep { value = true }
        var.update $rule { value = ($row.dependency_rule ?? "")|trim }

        conditional {
          if ($rule != "") {
            var.update $parts { value = $rule|split:"==" }
            conditional {
              if (($parts|count) == 2) {
                var.update $dep_key { value = ($parts|first)|trim }
                var.update $dep_value { value = ((($parts|last)|trim)|replace:"'":"")|replace:"\"":"" }
                var.update $dep_field { value = $all_fields|find:$$.normalized_key == $dep_key }

                conditional {
                  if ($dep_field != null) {
                    var.update $dep_field_id { value = $dep_field.field_id }
                    var.update $dep_answer { value = $answered|find:$$.field_id == $dep_field_id }

                    conditional {
                      if ($dep_answer == null) {
                        var.update $keep { value = false }
                      }
                      elseif ((($dep_answer.value_json|to_text)|trim|to_lower) != ($dep_value|trim|to_lower)) {
                        var.update $keep { value = false }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        conditional {
          if ($keep) {
            var.update $required_fields { value = $required_fields|push:$row }
          }
        }
      }
    }

    var $complete_fields {
      value = $required_fields|filter:($answered_key|contains:("|" ~ $$.field_id ~ "|"))
    }
    var $missing_fields {
      value = $required_fields|filter:!($answered_key|contains:("|" ~ $$.field_id ~ "|"))
    }

    var $fields_total { value = $required_fields|count }
    var $fields_complete { value = $complete_fields|count }

    // ---------------------------------------------------------------
    // Sections, in order of first appearance among the required fields.
    // ---------------------------------------------------------------
    var $section_labels {
      value = {
        personal_information : "Personal information"
        household_information: "Household information"
        insurance_information: "Insurance information"
        income_information   : "Income information"
        monthly_expenses     : "Monthly expenses"
      }
    }

    var $section_keys { value = [] }
    var $key { value = "" }
    var $already { value = false }

    foreach ($required_fields) {
      each as $row {
        var.update $key { value = $row.section ?? "" }
        conditional {
          if ($key == "") {
            var.update $key { value = "form" }
          }
        }
        var.update $already { value = $section_keys|some:$$ == $key }
        conditional {
          if ($already == false) {
            var.update $section_keys { value = $section_keys|push:$key }
          }
        }
      }
    }

    var $sections { value = [] }
    var $section_fields { value = [] }
    var $section_done { value = [] }
    var $section_state { value = "todo" }
    var $section_label { value = "" }
    var $section_order { value = 0 }
    var $sections_complete { value = 0 }
    var $active_taken { value = false }
    var $active_index { value = 0 }
    var $section_entry { value = {} }

    foreach ($section_keys) {
      each as $section_key {
        var.update $section_order { value = $section_order + 1 }
        var.update $key { value = $section_key }
        var.update $section_fields { value = $required_fields|filter:($$.section ?? "") == $key || (($$.section ?? "") == "" && $key == "form") }
        var.update $section_done { value = $complete_fields|filter:($$.section ?? "") == $key || (($$.section ?? "") == "" && $key == "form") }
        var.update $section_state { value = "todo" }

        conditional {
          if (($section_fields|count) > 0 && ($section_done|count) == ($section_fields|count)) {
            var.update $section_state { value = "done" }
            var.update $sections_complete { value = $sections_complete + 1 }
          }
          elseif ($active_taken == false) {
            var.update $section_state { value = "active" }
            var.update $active_taken { value = true }
            var.update $active_index { value = $section_order - 1 }
          }
        }

        var.update $section_label { value = $section_labels|get:$key:"" }
        conditional {
          if ($section_label == "") {
            var.update $section_label { value = ($key|replace:"_":" ")|capitalize }
          }
        }

        var.update $section_entry {
          value = {
            key           : $key
            label         : $section_label
            order         : $section_order
            field_count   : ($section_fields|count)
            answered_count: ($section_done|count)
            state         : $section_state
          }
        }
        var.update $sections { value = $sections|push:$section_entry }
      }
    }

    var $section_count { value = $sections|count }
    conditional {
      if ($active_taken == false) {
        var.update $active_index { value = $section_count }
      }
    }

    // ---------------------------------------------------------------
    // Requirement checklist: one item per section, then the evidence items.
    // ---------------------------------------------------------------
    var $requirement_specs { value = [] }
    var $spec { value = {} }
    var $req_status { value = "missing" }

    foreach ($sections) {
      each as $section {
        var.update $req_status { value = "missing" }
        conditional {
          if ($section.state == "done") {
            var.update $req_status { value = "complete" }
          }
        }
        var.update $spec {
          value = {key: $section.key, label: $section.label, type: "field", status: $req_status, evidence_url: null}
        }
        var.update $requirement_specs { value = $requirement_specs|push:$spec }
      }
    }

    // Proof of income: an uploaded supporting document, nothing else. Only a
    // hospital financial-assistance policy demands it.
    conditional {
      if ($category == "hospital_financial_assistance") {
        db.query documents {
          where = $db.documents.case_id == $case.id && $db.documents.type == "supporting_document"
          sort = {id: "asc"}
          return = {type: "list"}
        } as $supporting_docs

        var $proof_status { value = "missing" }
        var $proof_evidence { value = null }
        var $first_doc { value = null }

        conditional {
          if (($supporting_docs|count) > 0) {
            var.update $first_doc { value = $supporting_docs|first }
            var.update $proof_status { value = "complete" }
            var.update $proof_evidence { value = ($first_doc.generated_url ?? $first_doc.source_url) }
          }
        }

        var.update $spec {
          value = {
            key         : "proof_of_social_security_income"
            label       : "Proof of Social Security income"
            type        : "attachment"
            status      : $proof_status
            evidence_url: $proof_evidence
          }
        }
        var.update $requirement_specs { value = $requirement_specs|push:$spec }
      }
    }

    // Signature: only a human can complete this one. Any signature field on
    // the form counts; the first one names the requirement.
    var $signature_fields {
      value = $all_fields|filter:(($$.field_id|to_lower)|contains:"signature") || $$.type == "signature"
    }
    var $signature_ids {
      value = $signature_fields|map:$$.field_id
    }
    var $signature_key {
      value = "|" ~ ($signature_ids|join:"|") ~ "|"
    }
    var $signed {
      value = $answered|filter:($signature_key|contains:("|" ~ $$.field_id ~ "|"))
    }

    var $signature_status { value = "missing" }
    conditional {
      if (($signature_fields|count) > 0 && ($signed|count) > 0) {
        var.update $signature_status { value = "complete" }
      }
    }

    var $signature_label { value = "Applicant signature" }
    var $first_signature { value = $signature_fields|first }
    conditional {
      if ($first_signature != null) {
        var.update $signature_label { value = $first_signature.field_id }
      }
    }

    var.update $spec {
      value = {
        key         : "applicant_signature"
        label       : $signature_label
        type        : "signature"
        status      : $signature_status
        evidence_url: null
      }
    }
    var.update $requirement_specs { value = $requirement_specs|push:$spec }

    // ---------------------------------------------------------------
    // Score.
    // ---------------------------------------------------------------
    var $req_total { value = $requirement_specs|count }
    var $req_complete { value = ($requirement_specs|filter:$$.status == "complete")|count }

    var $fields_ratio { value = 0 }
    conditional {
      if ($fields_total > 0) {
        var.update $fields_ratio { value = ($fields_complete|to_decimal) / ($fields_total|to_decimal) }
      }
    }

    var $req_ratio { value = 0 }
    conditional {
      if ($req_total > 0) {
        var.update $req_ratio { value = ($req_complete|to_decimal) / ($req_total|to_decimal) }
      }
    }

    var $percent {
      value = ((50 * $fields_ratio) + (50 * $req_ratio))|round:0
    }

    // "Appears complete based on the published requirements." Not eligible,
    // not approved, not submitted, not signed.
    var $ready_for_review {
      value = $fields_total > 0 && $fields_complete == $fields_total
    }

    var $next_field { value = $missing_fields|first }
  }

  response = {
    case             : $case
    program          : $program
    category         : $category
    all_fields       : $all_fields
    required_fields  : $required_fields
    complete_fields  : $complete_fields
    missing_fields   : $missing_fields
    fields_total     : $fields_total
    fields_complete  : $fields_complete
    answered_count   : ($answered|count)
    sections         : $sections
    section_count    : $section_count
    section_index    : $active_index
    requirement_specs: $requirement_specs
    req_total        : $req_total
    req_complete     : $req_complete
    percent          : $percent
    ready_for_review : $ready_for_review
    next_field       : $next_field
  }
  guid = "B_seSPp40368P6Rd3lj3sG_STrA"
}
