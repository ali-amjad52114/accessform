// POST /cases/{id}/validate - recompute the requirement checklist and say what
// is still outstanding. Vapi tool `validate_case`.
//
// Xano owns completeness. The UI and the voice agent both read the answer from
// here; nothing downstream re-derives it.
//
// Two things are deliberately NOT inferable from form fields:
//   - proof_of_social_security_income  completes only when a supporting
//     document row exists for the case;
//   - applicant_signature              completes only when a human has supplied
//     the signature field. AccessForm never signs anything for a patient, so
//     for the demo patient this stays missing by construction.
//
// `readyForReview` means the required form fields are all collected. It never
// means eligible, approved, submitted or signed.
query "cases/{id}/validate" verb=POST {
  api_group = "AccessForm"
  description = "Recompute requirements for a case and return the authoritative completeness summary."

  input {
    text id filters=trim
  }

  stack {
    db.get cases {
      field_name = "external_ref"
      field_value = $input.id
    } as $by_ref

    conditional {
      if ($by_ref != null) {
        var $case { value = $by_ref }
      }
      else {
        db.get cases {
          field_name = "id"
          field_value = ($input.id|to_int)
        } as $by_id
        var $case { value = $by_id }
      }
    }

    precondition ($case != null) {
      error_type = "notfound"
      error = "No case found with that id."
    }

    // ---------------------------------------------------------------
    // Which required fields are answered?
    // ---------------------------------------------------------------
    db.query form_schema {
      where = $db.form_schema.program_id == $case.program_id && $db.form_schema.required == true
      sort = {id: "asc"}
      return = {type: "list"}
    } as $required_fields

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

    var $complete_fields {
      value = $required_fields|filter:($answered_key|contains:("|" ~ $$.field_id ~ "|"))
    }
    var $missing_fields {
      value = $required_fields|filter:!($answered_key|contains:("|" ~ $$.field_id ~ "|"))
    }

    var $fields_total {
      value = $required_fields|count
    }
    var $fields_complete {
      value = $complete_fields|count
    }

    // ---------------------------------------------------------------
    // Requirement checklist: five field groups, then the two evidence items.
    // ---------------------------------------------------------------
    var $groups {
      value = [
        {key: "personal_information", label: "Personal information"}
        {key: "household_information", label: "Household information"}
        {key: "insurance_information", label: "Insurance information"}
        {key: "income_information", label: "Income information"}
        {key: "monthly_expenses", label: "Monthly expenses"}
      ]
    }

    var $requirement_specs { value = [] }
    var $group_key { value = "" }
    var $group_fields { value = [] }
    var $group_done { value = [] }
    var $group_status { value = "missing" }
    var $spec { value = {} }

    foreach ($groups) {
      each as $group {
        var.update $group_key { value = $group.key }
        var.update $group_fields { value = $required_fields|filter:$$.group_key == $group_key }
        var.update $group_done { value = $complete_fields|filter:$$.group_key == $group_key }
        var.update $group_status { value = "missing" }

        conditional {
          if (($group_fields|count) == 0) {
            var.update $group_status { value = "not_applicable" }
          }
          elseif (($group_done|count) == ($group_fields|count)) {
            var.update $group_status { value = "complete" }
          }
        }

        var.update $spec {
          value = {key: $group.key, label: $group.label, type: "field", status: $group_status, evidence_url: null}
        }
        var.update $requirement_specs { value = $requirement_specs|push:$spec }
      }
    }

    // Proof of income: an uploaded supporting document, nothing else.
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

    // Signature: only a human can complete this one.
    db.query answers {
      where = $db.answers.case_id == $case.id && $db.answers.field_id == "Signature of person applying for financial assistance"
      return = {type: "single"}
    } as $signature_answer

    var $signature_status { value = "missing" }
    conditional {
      if ($signature_answer != null) {
        conditional {
          if ((($signature_answer.value_json|to_text)|trim) != "") {
            var.update $signature_status { value = "complete" }
          }
        }
      }
    }

    var.update $spec {
      value = {
        key         : "applicant_signature"
        label       : "Signature of person applying for financial assistance"
        type        : "signature"
        status      : $signature_status
        evidence_url: null
      }
    }
    var.update $requirement_specs { value = $requirement_specs|push:$spec }

    // ---------------------------------------------------------------
    // Persist the checklist (upsert by case_id + key).
    // ---------------------------------------------------------------
    var $existing_req { value = null }

    foreach ($requirement_specs) {
      each as $requirement {
        db.query requirements {
          where = $db.requirements.case_id == $case.id && $db.requirements.key == $requirement.key
          return = {type: "single"}
        } as $found_req

        var.update $existing_req { value = $found_req }

        conditional {
          if ($existing_req != null) {
            db.edit requirements {
              field_name = "id"
              field_value = $existing_req.id
              data = {
                label       : $requirement.label
                type        : $requirement.type
                status      : $requirement.status
                evidence_url: $requirement.evidence_url
              }
            } as $edited_req
          }
          else {
            db.add requirements {
              data = {
                case_id     : $case.id
                key         : $requirement.key
                label       : $requirement.label
                type        : $requirement.type
                status      : $requirement.status
                evidence_url: $requirement.evidence_url
              }
            } as $added_req
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // Score. Half the dial is the required form fields, half is the published
    // requirement checklist - so outstanding evidence still reads as work left
    // even once every field has been collected.
    // ---------------------------------------------------------------
    var $req_total {
      value = $requirement_specs|count
    }
    var $req_complete {
      value = ($requirement_specs|filter:$$.status == "complete")|count
    }

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

    var $new_status { value = "INTERVIEWING" }
    conditional {
      if ($ready_for_review) {
        var.update $new_status { value = "READY_FOR_REVIEW" }
      }
      elseif (($answered|count) == 0) {
        var.update $new_status { value = $case.status }
      }
    }

    db.edit cases {
      field_name = "id"
      field_value = $case.id
      data = {
        status          : $new_status
        progress_percent: $percent
        updated_at      : "now"
      }
    } as $updated_case

    db.query requirements {
      where = $db.requirements.case_id == $case.id && $db.requirements.status == "missing"
      sort = {id: "asc"}
      return = {type: "list"}
    } as $missing_requirements

    // What should the patient be asked for next?
    var $next_missing { value = null }
    var $next_field { value = $missing_fields|first }
    var $next_req { value = $missing_requirements|first }

    conditional {
      if ($next_field != null) {
        var.update $next_missing {
          value = {
            kind  : "field"
            key   : $next_field.field_id
            label : $next_field.label
            prompt: $next_field.conversational_prompt
          }
        }
      }
      elseif ($next_req != null) {
        var.update $next_missing {
          value = {kind: $next_req.type, key: $next_req.key, label: $next_req.label, prompt: null}
        }
      }
    }

    var $missing_keys {
      value = $missing_requirements|map:$$.key
    }

    db.add events {
      data = {
        case_id      : $case.id
        actor        : "xano"
        event_type   : "case_validated"
        message      : "Completeness recomputed"
        metadata_json: {percent: $percent, missing: $missing_keys, ready_for_review: $ready_for_review}
      }
    } as $event
  }

  response = {
    caseId                : $case.id
    externalRef           : $case.external_ref
    status                : $new_status
    percent               : $percent
    requiredFieldsComplete: $fields_complete
    requiredFieldsTotal   : $fields_total
    missingRequirements   : $missing_requirements
    readyForReview        : $ready_for_review
    nextMissing           : $next_missing
  }
  tags = ["accessform"]
  guid = "U3-78oPNcXFlCvx0R0tRLjL4f4g"
}
