// PUT /programs/{id}/form_schema - bulk replace the form's schema.
//
// Written by understandForm() once per program (idempotent: same PDF, same
// rows). Deletes every form_schema row for the program and inserts the given
// ones. Rejects an empty list, duplicate field_ids, or a type outside the
// enum (the input schema enforces the enum). Updates programs.field_count.
//
// Answers reference fields by field_id, not by row id, so replacing the rows
// never orphans a saved answer.
query "programs/{id}/form_schema" verb=PUT {
  api_group = "AccessForm"
  description = "Replace every form_schema row for a program with the given fields."

  input {
    int id

    object[] fields {
      schema {
        text field_id filters=trim
        text? label? filters=trim
        text? normalized_key? filters=trim

        enum type?="text" {
          values = ["text", "number", "currency", "date", "bool", "choice", "checkbox", "radio", "signature"]
        }

        bool required?=false
        text? section? filters=trim
        int order?=0 filters=min:0
        json? options?
        text? conversational_prompt?
        text? dependency_rule?
        text? pdf_field_name? filters=trim
        json? pdf_mapping?
        text? group_key? filters=trim
      }
    }
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

    precondition (($input.fields|count) > 0) {
      error_type = "inputerror"
      error = "fields must not be empty."
    }

    var $field_ids { value = $input.fields|map:$$.field_id }
    precondition ((($field_ids|unique)|count) == ($field_ids|count)) {
      error_type = "inputerror"
      error = "fields contains a duplicate field_id."
    }

    precondition ((($field_ids|filter:$$ == "")|count) == 0) {
      error_type = "inputerror"
      error = "every field needs a field_id."
    }

    // Build the rows first so a bad row cannot leave the program half-written.
    var $rows { value = [] }
    var $position { value = 0 }
    var $section { value = "" }
    var $order { value = 0 }
    var $pdf_field_name { value = "" }
    var $pdf_mapping { value = null }
    var $group_key { value = "" }
    var $options { value = [] }
    var $row { value = {} }

    foreach ($input.fields) {
      each as $field {
        var.update $position { value = $position + 1 }

        var.update $section { value = ($field.section ?? "")|trim }
        var.update $group_key { value = ($field.group_key ?? "")|trim }
        conditional {
          if ($group_key == "") {
            var.update $group_key { value = $section }
          }
        }
        conditional {
          if ($section == "") {
            var.update $section { value = $group_key }
          }
        }

        var.update $order { value = $field.order ?? 0 }
        conditional {
          if ($order == 0) {
            var.update $order { value = $position }
          }
        }

        var.update $pdf_field_name { value = ($field.pdf_field_name ?? "")|trim }
        conditional {
          if ($pdf_field_name == "") {
            var.update $pdf_field_name { value = $field.field_id }
          }
        }

        var.update $pdf_mapping { value = $field.pdf_mapping }
        conditional {
          if ($pdf_mapping == null) {
            var.update $pdf_mapping { value = $pdf_field_name }
          }
        }

        var.update $options { value = $field.options }
        conditional {
          if ($options == null) {
            var.update $options { value = [] }
          }
        }

        var.update $row {
          value = {
            program_id           : $program.id
            field_id             : $field.field_id
            label                : ($field.label ?? $field.field_id)
            normalized_key       : ($field.normalized_key ?? "")
            type                 : $field.type
            required             : $field.required
            group_key            : $group_key
            conversational_prompt: ($field.conversational_prompt ?? "")
            dependency_rule      : ($field.dependency_rule ?? "")
            pdf_mapping          : $pdf_mapping
            section              : $section
            order                : $order
            options              : $options
            pdf_field_name       : $pdf_field_name
          }
        }
        var.update $rows { value = $rows|push:$row }
      }
    }

    db.bulk.delete form_schema {
      where = $db.form_schema.program_id == $program.id
    } as $deleted

    foreach ($rows) {
      each as $new_row {
        db.add form_schema {
          data = {
            program_id           : $new_row.program_id
            field_id             : $new_row.field_id
            label                : $new_row.label
            normalized_key       : $new_row.normalized_key
            type                 : $new_row.type
            required             : $new_row.required
            group_key            : $new_row.group_key
            conversational_prompt: $new_row.conversational_prompt
            dependency_rule      : $new_row.dependency_rule
            pdf_mapping          : $new_row.pdf_mapping
            section              : $new_row.section
            order                : $new_row.order
            options              : $new_row.options
            pdf_field_name       : $new_row.pdf_field_name
          }
        } as $inserted
      }
    }

    db.edit programs {
      field_name = "id"
      field_value = $program.id
      data = {field_count: ($rows|count)}
    } as $updated_program

    function.run "form_schema_rows" {
      input = {program_id: $program.id, required_only: false}
    } as $fields
  }

  response = {
    program_id: $program.id
    count     : ($fields|count)
    fields    : $fields
  }
  tags = ["accessform"]
  guid = "uqg2J7tsfPqwPYCktyJ9hXuSyeU"
}
