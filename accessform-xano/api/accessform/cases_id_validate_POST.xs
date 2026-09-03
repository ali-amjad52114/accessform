// POST /cases/{id}/validate - recompute the requirement checklist and say what
// is still outstanding. Vapi tool `validate_case`.
//
// Xano owns completeness. The UI and the voice agent both read the answer from
// here; nothing downstream re-derives it. The scoring itself lives in the
// case_completeness function, shared with GET /progress and
// GET /next_question, so the three never disagree.
//
// Two things are deliberately NOT inferable from form fields:
//   - proof_of_social_security_income  (hospital financial assistance only)
//     completes only when a supporting document row exists for the case;
//   - applicant_signature              completes only when a human has supplied
//     a signature field. AccessForm never signs anything for a caller.
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

    function.run "case_completeness" {
      input = {case_id: $case.id}
    } as $c

    var $requirement_specs { value = $c.requirement_specs }
    var $fields_total { value = $c.fields_total }
    var $fields_complete { value = $c.fields_complete }
    var $percent { value = $c.percent }
    var $ready_for_review { value = $c.ready_for_review }

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

    var $new_status { value = "INTERVIEWING" }
    conditional {
      if ($ready_for_review) {
        var.update $new_status { value = "READY_FOR_REVIEW" }
      }
      elseif ($c.answered_count == 0) {
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

    // What should the caller be asked for next?
    var $next_missing { value = null }
    var $next_field { value = $c.next_field }
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
    sections              : $c.sections
    nextMissing           : $next_missing
  }
  tags = ["accessform"]
  guid = "U3-78oPNcXFlCvx0R0tRLjL4f4g"
}
