// GET /cases/{id}/next_question - what the agent should ask next, and how far
// along the interview is. Vapi tools `get_next_question` / `get_case_progress`.
//
// Read-only. The next question is the first required field, in section/order
// sequence, that has no non-blank answer and whose dependency_rule (if any)
// holds. Sections and percent come from the same function as /progress and
// /validate, so the three never disagree.
query "cases/{id}/next_question" verb=GET {
  api_group = "AccessForm"
  description = "Next unanswered required field for a case, in ask order, plus section progress."

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

    var $progress {
      value = {
        answered     : $c.fields_complete
        total        : $c.fields_total
        percent      : $c.percent
        section_index: $c.section_index
        section_count: $c.section_count
        sections     : $c.sections
      }
    }

    var $question { value = null }
    var $done { value = true }
    var $next { value = $c.next_field }
    var $question_section { value = "" }

    conditional {
      if ($next != null) {
        var.update $done { value = false }
        var.update $question_section { value = $next.section ?? "" }
        conditional {
          if ($question_section == "") {
            var.update $question_section { value = "form" }
          }
        }
        var.update $question {
          value = {
            field_id: $next.field_id
            prompt  : ($next.conversational_prompt ?? "")
            section : $question_section
            type    : $next.type
            options : $next.options
            required: true
            why     : ""
            progress: $progress
          }
        }
      }
    }
  }

  response = {
    case_id    : $case.id
    externalRef: $case.external_ref
    status     : $case.status
    done       : $done
    question   : $question
    progress   : $progress
  }
  tags = ["accessform"]
  guid = "rd-GtXo_e8YbrbdH_eatk-Q0n5w"
}
