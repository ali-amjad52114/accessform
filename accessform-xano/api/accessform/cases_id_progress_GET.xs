// GET /cases/{id}/progress - the authoritative progress card. Vapi tool
// `get_case_progress`.
//
// Read-only twin of POST /cases/{id}/validate: identical scoring, no writes, so
// the voice agent can ask "where are we" mid-call without mutating the case.
// Returns the eight progress steps in canonical order plus the next field the
// agent should ask about, in the plain language stored on form_schema.
query "cases/{id}/progress" verb=GET {
  api_group = "AccessForm"
  description = "Authoritative completeness for a case: percent, eight steps, and the next question to ask."

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

    db.get programs {
      field_name = "id"
      field_value = $case.program_id
    } as $program

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

    var $answered {
      value = $answers|filter:$$.value_json != null && (($$.value_json|to_text)|trim) != ""
    }
    var $answered_ids {
      value = $answered|map:$$.field_id
    }
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
    // Group states. The first group that is not finished is the active one,
    // which is what the progress card highlights.
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

    var $group_states { value = {} }
    var $groups_complete { value = 0 }
    var $active_taken { value = false }
    var $group_key { value = "" }
    var $group_fields { value = [] }
    var $group_done { value = [] }
    var $group_state { value = "todo" }

    foreach ($groups) {
      each as $group {
        var.update $group_key { value = $group.key }
        var.update $group_fields { value = $required_fields|filter:$$.group_key == $group_key }
        var.update $group_done { value = $complete_fields|filter:$$.group_key == $group_key }
        var.update $group_state { value = "todo" }

        conditional {
          if (($group_fields|count) > 0 && ($group_done|count) == ($group_fields|count)) {
            var.update $group_state { value = "done" }
            var.update $groups_complete { value = $groups_complete + 1 }
          }
          elseif ($active_taken == false) {
            var.update $group_state { value = "active" }
            var.update $active_taken { value = true }
          }
        }

        var.update $group_states { value = $group_states|set:$group_key:$group_state }
      }
    }

    // ---------------------------------------------------------------
    // Evidence items, scored exactly as POST /validate scores them.
    // ---------------------------------------------------------------
    db.query documents {
      where = $db.documents.case_id == $case.id && $db.documents.type == "supporting_document"
      return = {type: "count"}
    } as $supporting_count

    db.query documents {
      where = $db.documents.case_id == $case.id && $db.documents.type == "filled_application"
      return = {type: "count"}
    } as $filled_count

    var $proof_complete {
      value = $supporting_count > 0
    }

    db.query answers {
      where = $db.answers.case_id == $case.id && $db.answers.field_id == "Signature of person applying for financial assistance"
      return = {type: "single"}
    } as $signature_answer

    var $signature_complete { value = false }
    conditional {
      if ($signature_answer != null) {
        conditional {
          if ((($signature_answer.value_json|to_text)|trim) != "") {
            var.update $signature_complete { value = true }
          }
        }
      }
    }

    var $req_total { value = 7 }
    var $req_complete { value = $groups_complete }
    conditional {
      if ($proof_complete) {
        var.update $req_complete { value = $req_complete + 1 }
      }
    }
    conditional {
      if ($signature_complete) {
        var.update $req_complete { value = $req_complete + 1 }
      }
    }

    var $fields_ratio { value = 0 }
    conditional {
      if ($fields_total > 0) {
        var.update $fields_ratio { value = ($fields_complete|to_decimal) / ($fields_total|to_decimal) }
      }
    }
    var $req_ratio {
      value = ($req_complete|to_decimal) / ($req_total|to_decimal)
    }
    var $percent {
      value = ((50 * $fields_ratio) + (50 * $req_ratio))|round:0
    }

    // ---------------------------------------------------------------
    // The eight canonical steps.
    // ---------------------------------------------------------------
    var $step_program { value = "todo" }
    conditional {
      if ($case.program_id != null) {
        var.update $step_program { value = "done" }
      }
    }

    var $step_form { value = "todo" }
    conditional {
      if ($program != null) {
        conditional {
          if (($program.application_url ?? "") != "") {
            var.update $step_form { value = "done" }
          }
        }
      }
    }

    var $state_personal { value = $group_states|get:"personal_information":"todo" }
    var $state_household { value = $group_states|get:"household_information":"todo" }
    var $state_insurance { value = $group_states|get:"insurance_information":"todo" }
    var $state_income_only { value = $group_states|get:"income_information":"todo" }
    var $state_expenses { value = $group_states|get:"monthly_expenses":"todo" }

    // Income and monthly expenses share one step on the card.
    var $step_income { value = "todo" }
    conditional {
      if ($state_income_only == "done" && $state_expenses == "done") {
        var.update $step_income { value = "done" }
      }
      elseif ($state_income_only == "active" || $state_expenses == "active") {
        var.update $step_income { value = "active" }
      }
    }

    // Documents is done once the interview is finished AND the filled
    // application exists. A filled PDF left over from an earlier pass does not
    // count while fields are still outstanding - it is stale by definition.
    var $interview_done {
      value = $fields_total > 0 && $fields_complete == $fields_total
    }
    var $step_documents { value = "todo" }
    conditional {
      if ($interview_done && $filled_count > 0) {
        var.update $step_documents { value = "done" }
      }
      elseif ($interview_done) {
        var.update $step_documents { value = "active" }
      }
    }

    var $step_review { value = "todo" }
    conditional {
      if ($case.status == "READY_FOR_REVIEW") {
        var.update $step_review { value = "active" }
      }
    }

    var $steps {
      value = [
        {id: "program_found", label: "Program found", state: $step_program}
        {id: "current_form", label: "Current form", state: $step_form}
        {id: "personal_information", label: "Personal information", state: $state_personal}
        {id: "household", label: "Household", state: $state_household}
        {id: "insurance", label: "Insurance", state: $state_insurance}
        {id: "income", label: "Income", state: $step_income}
        {id: "documents", label: "Documents", state: $step_documents}
        {id: "review", label: "Review", state: $step_review}
      ]
    }

    var $next_field { value = $missing_fields|first }
    var $next_field_id { value = null }
    var $next_prompt { value = null }

    conditional {
      if ($next_field != null) {
        var.update $next_field_id { value = $next_field.field_id }
        var.update $next_prompt { value = $next_field.conversational_prompt }
      }
    }
  }

  response = {
    caseId         : $case.id
    externalRef    : $case.external_ref
    status         : $case.status
    percent        : $percent
    steps          : $steps
    answersSaved   : $fields_complete
    answersExpected: $fields_total
    nextFieldId    : $next_field_id
    nextPrompt     : $next_prompt
  }
  tags = ["accessform"]
  guid = "WJ8-xHzzhtm44ih9rmlJEfDEZu0"
}
