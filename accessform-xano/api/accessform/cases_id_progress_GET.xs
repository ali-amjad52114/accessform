// GET /cases/{id}/progress - the authoritative progress card. Legacy Vapi
// tool `get_case_progress`.
//
// Read-only twin of POST /cases/{id}/validate: identical scoring (both call
// the case_completeness function), no writes. Returns the form's own
// `sections` plus the eight legacy steps, derived from those sections per
// LEGACY_STEP_SECTION_ALIASES in the app contract, so a paratransit form
// still shows a sensible card.
query "cases/{id}/progress" verb=GET {
  api_group = "AccessForm"
  description = "Authoritative completeness for a case: percent, sections, eight derived steps, and the next question to ask."

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

    var $program { value = $c.program }
    var $sections { value = $c.sections }
    var $fields_total { value = $c.fields_total }
    var $fields_complete { value = $c.fields_complete }

    // ---------------------------------------------------------------
    // Interview as a whole, for steps with no matching section.
    // ---------------------------------------------------------------
    var $interview_done {
      value = $fields_total > 0 && $fields_complete == $fields_total
    }
    var $interview_state { value = "todo" }
    conditional {
      if ($interview_done) {
        var.update $interview_state { value = "done" }
      }
      elseif ($fields_complete > 0 || $case.status == "INTERVIEWING") {
        var.update $interview_state { value = "active" }
      }
    }

    // ---------------------------------------------------------------
    // Legacy field steps, derived from sections.
    // ---------------------------------------------------------------
    var $aliases {
      value = [
        {id: "personal_information", label: "Personal information", keys: "|personal_information|applicant|contact|personal|"}
        {id: "household", label: "Household", keys: "|household|household_information|family|"}
        {id: "insurance", label: "Insurance", keys: "|insurance|insurance_information|coverage|medical|"}
        {id: "income", label: "Income", keys: "|income|income_information|monthly_expenses|expenses|financial|"}
      ]
    }

    var $field_steps { value = [] }
    var $alias_keys { value = "" }
    var $matching { value = [] }
    var $step_state { value = "todo" }
    var $step_entry { value = {} }

    foreach ($aliases) {
      each as $alias {
        var.update $alias_keys { value = $alias.keys }
        var.update $matching { value = $sections|filter:($alias_keys|contains:("|" ~ $$.key ~ "|")) }
        var.update $step_state { value = "todo" }

        conditional {
          if (($matching|count) == 0) {
            var.update $step_state { value = $interview_state }
          }
          elseif ((($matching|filter:$$.state == "done")|count) == ($matching|count)) {
            var.update $step_state { value = "done" }
          }
          elseif ((($matching|filter:$$.state == "active")|count) > 0) {
            var.update $step_state { value = "active" }
          }
        }

        var.update $step_entry { value = {id: $alias.id, label: $alias.label, state: $step_state} }
        var.update $field_steps { value = $field_steps|push:$step_entry }
      }
    }

    // ---------------------------------------------------------------
    // The other four steps keep their existing rules.
    // ---------------------------------------------------------------
    var $step_program { value = "todo" }
    conditional {
      if (($case.program_id ?? 0) > 0) {
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

    db.query documents {
      where = $db.documents.case_id == $case.id && $db.documents.type == "filled_application"
      return = {type: "count"}
    } as $filled_count

    // Documents is done once the interview is finished AND the filled
    // application exists. A filled PDF left over from an earlier pass does not
    // count while fields are still outstanding - it is stale by definition.
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
        ($field_steps|get:0)
        ($field_steps|get:1)
        ($field_steps|get:2)
        ($field_steps|get:3)
        {id: "documents", label: "Documents", state: $step_documents}
        {id: "review", label: "Review", state: $step_review}
      ]
    }

    var $next_field { value = $c.next_field }
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
    percent        : $c.percent
    steps          : $steps
    sections       : $sections
    answersSaved   : $fields_complete
    answersExpected: $fields_total
    nextFieldId    : $next_field_id
    nextPrompt     : $next_prompt
  }
  tags = ["accessform"]
  guid = "WJ8-xHzzhtm44ih9rmlJEfDEZu0"
}
