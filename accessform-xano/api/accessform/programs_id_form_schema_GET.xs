// GET /programs/{id}/form_schema - the form's fields in ask order.
// Backs XanoAdapter.getFormSchema and understandForm()'s cache check.
//
// Rows come through the form_schema_rows function, so legacy Cedars rows
// carry section / order / options / pdf_field_name too. Empty is `[]` with
// count 0, never a 404 - "no schema yet" is a normal state before the form
// understanding pass has run.
//
// GET /programs/{id}/fields is kept as an alias with the same stack.
query "programs/{id}/form_schema" verb=GET {
  api_group = "AccessForm"
  description = "Normalized form schema for a program, in ask order, with sections and options."

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
  guid = "qbZwBjuoCBcI9jY270AgLOp6dwQ"
}
