// GET /programs/{id}/fields - alias of GET /programs/{id}/form_schema, kept
// for the pre-M1 callers. Same stack, same response shape.
query "programs/{id}/fields" verb=GET {
  api_group = "AccessForm"
  description = "Alias of /programs/{id}/form_schema: normalized form schema for a program, in ask order."

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

    function.run "form_schema_rows" {
      input = {program_id: $program.id, required_only: $input.required_only}
    } as $fields
  }

  response = {
    program_id     : $program.id
    application_url: $program.application_url
    sha256         : ($program.sha256 ?? "")
    form_kind      : $program.form_kind
    count          : ($fields|count)
    fields         : $fields
  }
  tags = ["accessform"]
  guid = "N67ptG-2QlGqIly7GHb0AwH1ayQ"
}
