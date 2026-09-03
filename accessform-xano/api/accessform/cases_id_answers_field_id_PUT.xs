// PUT /cases/{id}/answers/{field_id} - upsert one collected answer.
// Vapi tool `save_answer`. The answers table carries a unique index on
// (case_id, field_id), so this looks the row up first and edits in place rather
// than letting a repeated answer collide.
//
// {field_id} is the exact AcroForm field name from the official PDF, so the
// saved answers map straight into Nutrient Instant JSON with no translation.
query "cases/{id}/answers/{field_id}" verb=PUT {
  api_group = "AccessForm"
  description = "Create or update the answer for one form field on a case."

  input {
    text id filters=trim
    text field_id filters=trim

    // json so numbers, booleans and choices round-trip exactly as collected.
    json? value?

    enum source?="voice" {
      values = ["voice", "manual", "document"]
    }

    bool confirmed?=false
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

    db.query answers {
      where = $db.answers.case_id == $case.id && $db.answers.field_id == $input.field_id
      return = {type: "single"}
    } as $existing

    conditional {
      if ($existing != null) {
        db.edit answers {
          field_name = "id"
          field_value = $existing.id
          data = {
            value_json: $input.value
            source    : $input.source
            confirmed : $input.confirmed
            updated_at: "now"
          }
        } as $edited
        var $answer { value = $edited }
      }
      else {
        db.add answers {
          data = {
            case_id   : $case.id
            field_id  : $input.field_id
            value_json: $input.value
            source    : $input.source
            confirmed : $input.confirmed
          }
        } as $added
        var $answer { value = $added }
      }
    }

    // Saving an answer means the interview has started. Never downgrade a case
    // that has already been validated.
    conditional {
      if ($case.status == "CREATED" || $case.status == "DISCOVERING" || $case.status == "FORM_FOUND") {
        db.edit cases {
          field_name = "id"
          field_value = $case.id
          data = {status: "INTERVIEWING", updated_at: "now"}
        } as $touched_case
      }
    }

    // Label the field for the /live feed rather than reading the raw PDF name.
    db.query form_schema {
      where = $db.form_schema.program_id == $case.program_id && $db.form_schema.field_id == $input.field_id
      return = {type: "single"}
    } as $schema_field

    var $field_label {
      value = ($schema_field.label ?? $input.field_id)
    }

    db.add events {
      data = {
        case_id      : $case.id
        actor        : "xano"
        event_type   : "answer_saved"
        message      : $field_label ~ " saved"
        metadata_json: {field_id: $input.field_id, source: $input.source, confirmed: $input.confirmed}
      }
    } as $event
  }

  response = {
    id        : $answer.id
    case_id   : $answer.case_id
    field_id  : $answer.field_id
    value_json: $answer.value_json
    source    : $answer.source
    confirmed : $answer.confirmed
    updated_at: $answer.updated_at
  }
  tags = ["accessform"]
  guid = "9JH_f1HstIHhPGRWIj7pUrcMTJQ"
}
