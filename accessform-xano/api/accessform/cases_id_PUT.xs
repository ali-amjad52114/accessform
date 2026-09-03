// PUT /cases/{id} - small partial update of a case row.
//
// Used by the resolve_need tool (need_category, situation_text, location) and
// by the delivery and discovery modules. Edits only the inputs that were
// provided. Returns the case row.
query "cases/{id}" verb=PUT {
  api_group = "AccessForm"
  description = "Partial update of a case: need, location, caller phone, situation, delivery status, organization, program, status."

  input {
    text id filters=trim

    enum need_category? {
      values = ["hospital_financial_assistance", "paratransit", "disability_accommodation", "scholarship_financial_aid", "benefits", "appointment", "other"]
    }

    text location? filters=trim
    text caller_phone? filters=trim
    text situation_text?

    enum delivery_status? {
      values = ["none", "queued", "sent", "failed"]
    }

    int organization_id?
    int program_id?

    enum status? {
      values = ["CREATED", "DISCOVERING", "FORM_FOUND", "INTERVIEWING", "VALIDATING", "GENERATING", "ACCESSIBILITY_PROCESSING", "READY_FOR_REVIEW", "BLOCKED"]
    }

    text patient_display_name? filters=trim
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

    var $updates { value = {updated_at: "now"} }

    conditional {
      if ($input.need_category != null) {
        var.update $updates { value = $updates|set:"need_category":$input.need_category }
      }
    }
    conditional {
      if ($input.location != null) {
        var.update $updates { value = $updates|set:"location":$input.location }
      }
    }
    conditional {
      if ($input.caller_phone != null) {
        var.update $updates { value = $updates|set:"caller_phone":$input.caller_phone }
      }
    }
    conditional {
      if ($input.situation_text != null) {
        var.update $updates { value = $updates|set:"situation_text":$input.situation_text }
      }
    }
    conditional {
      if ($input.delivery_status != null) {
        var.update $updates { value = $updates|set:"delivery_status":$input.delivery_status }
      }
    }
    conditional {
      if ($input.organization_id != null) {
        var.update $updates { value = $updates|set:"organization_id":$input.organization_id }
      }
    }
    conditional {
      if ($input.program_id != null) {
        var.update $updates { value = $updates|set:"program_id":$input.program_id }
      }
    }
    conditional {
      if ($input.status != null) {
        var.update $updates { value = $updates|set:"status":$input.status }
      }
    }
    conditional {
      if ($input.patient_display_name != null) {
        var.update $updates { value = $updates|set:"patient_display_name":$input.patient_display_name }
      }
    }

    db.patch cases {
      field_name = "id"
      field_value = $case.id
      data = $updates
    } as $updated_case

    // Feed line without any of the caller's words or number.
    conditional {
      if ($input.need_category != null) {
        db.add events {
          data = {
            case_id      : $case.id
            actor        : "xano"
            event_type   : "case_updated"
            message      : "Need recorded: " ~ $input.need_category
            metadata_json: {need_category: $input.need_category, has_location: ($input.location != null)}
          }
        } as $event
      }
    }
  }

  response = $updated_case
  tags = ["accessform"]
  guid = "zbUi77aNJhQJsWDo1Wj_y_Emrew"
}
