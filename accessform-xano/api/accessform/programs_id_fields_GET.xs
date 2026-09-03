// GET /programs/{id}/fields - the normalized form schema for a program, in the
// order the interview asks for it. Backs XanoAdapter.getFormSchema.
//
// Two consumers: the voice agent reads `conversational_prompt` so it never
// reads a raw PDF label aloud, and the Nutrient step reads
// `pdf_mapping.acroform_field` to build Instant JSON.
//
// Defaults to the 26 fields the interview actually collects. Pass
// required_only=false for all 101 AcroForm fields on the official PDF.
query "programs/{id}/fields" verb=GET {
  api_group = "AccessForm"
  description = "Normalized form schema for a program, in ask order."

  input {
    int id
    bool required_only?=true
  }

  stack {
    db.get programs {
      field_name = "id"
      field_value = $input.id
    } as $program

    precondition ($program != null) {
      error_type = "notfound"
      error = "No program found with that id."
    }

    conditional {
      if ($input.required_only) {
        db.query form_schema {
          where = $db.form_schema.program_id == $input.id && $db.form_schema.required == true
          sort = {id: "asc"}
          return = {type: "list"}
        } as $required_rows
        var $fields { value = $required_rows }
      }
      else {
        db.query form_schema {
          where = $db.form_schema.program_id == $input.id
          sort = {id: "asc"}
          return = {type: "list"}
        } as $all_rows
        var $fields { value = $all_rows }
      }
    }
  }

  response = {
    program_id     : $program.id
    application_url: $program.application_url
    count          : ($fields|count)
    fields         : $fields
  }
  tags = ["accessform"]
  guid = "N67ptG-2QlGqIly7GHb0AwH1ayQ"
}
