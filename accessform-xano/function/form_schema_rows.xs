// form_schema rows for a program in ask order, with the M1 columns filled in
// for rows written before they existed (Cedars): section falls back to
// group_key, pdf_field_name to field_id, order to the row's position, options
// to []. Every consumer of form_schema (GET /programs/{id}/form_schema, the
// /fields alias, next_question, progress, validate) reads through here so
// they can never disagree about what the form contains.
function "form_schema_rows" {
  description = "form_schema rows for a program, in ask order, M1 columns backfilled."

  input {
    int program_id
    bool required_only?=false
  }

  stack {
    conditional {
      if ($input.required_only) {
        db.query form_schema {
          where = $db.form_schema.program_id == $input.program_id && $db.form_schema.required == true
          sort = {order: "asc", id: "asc"}
          return = {type: "list"}
        } as $required_rows
        var $rows { value = $required_rows }
      }
      else {
        db.query form_schema {
          where = $db.form_schema.program_id == $input.program_id
          sort = {order: "asc", id: "asc"}
          return = {type: "list"}
        } as $all_rows
        var $rows { value = $all_rows }
      }
    }

    var $fields { value = [] }
    var $position { value = 0 }
    var $section { value = "" }
    var $order { value = 0 }
    var $options { value = [] }
    var $pdf_field_name { value = "" }
    var $field { value = {} }

    foreach ($rows) {
      each as $row {
        var.update $position { value = $position + 1 }

        var.update $section { value = $row.section ?? "" }
        conditional {
          if ($section == "") {
            var.update $section { value = $row.group_key ?? "" }
          }
        }

        var.update $order { value = $row.order ?? 0 }
        conditional {
          if ($order == 0) {
            var.update $order { value = $position }
          }
        }

        var.update $options { value = $row.options }
        conditional {
          if ($options == null) {
            var.update $options { value = [] }
          }
        }

        var.update $pdf_field_name { value = $row.pdf_field_name ?? "" }
        conditional {
          if ($pdf_field_name == "") {
            var.update $pdf_field_name { value = $row.field_id }
          }
        }

        var.update $field {
          value = {
            id                   : $row.id
            created_at           : $row.created_at
            program_id           : $row.program_id
            field_id             : $row.field_id
            label                : ($row.label ?? "")
            normalized_key       : ($row.normalized_key ?? "")
            type                 : $row.type
            required             : $row.required
            group_key            : ($row.group_key ?? "")
            conversational_prompt: ($row.conversational_prompt ?? "")
            dependency_rule      : ($row.dependency_rule ?? "")
            pdf_mapping          : $row.pdf_mapping
            section              : $section
            order                : $order
            options              : $options
            pdf_field_name       : $pdf_field_name
          }
        }
        var.update $fields { value = $fields|push:$field }
      }
    }
  }

  response = $fields
  guid = "jdlEotfz7s3bA8gaurBcm2mfDfQ"
}
