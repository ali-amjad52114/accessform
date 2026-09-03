// POST /cases/{id}/documents - record a PDF against the case. Backs
// XanoAdapter.saveDocument, and is how the Nutrient step writes back the
// generated file and the result of the accessibility pass.
//
// source_application and filled_application are upserted (a case has one of
// each, and re-running the fill replaces it). supporting_document always
// appends - a patient may add several pieces of evidence, and the first one
// is what completes the proof-of-income requirement.
query "cases/{id}/documents" verb=POST {
  api_group = "AccessForm"
  description = "Record or update a document on a case: source PDF, filled output, or supporting evidence."

  input {
    text id filters=trim

    enum type?="filled_application" {
      values = ["source_application", "filled_application", "supporting_document"]
    }

    text? source_url?
    text? generated_url?

    // Contract vocabulary. Only "processed" may be described in UI copy as
    // "accessibility processed".
    enum accessibility_status?="pending" {
      values = ["pending", "processing", "processed", "failed", "not_applicable"]
    }

    text? version_hash?
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

    var $existing { value = null }

    conditional {
      if ($input.type != "supporting_document") {
        db.query documents {
          where = $db.documents.case_id == $case.id && $db.documents.type == $input.type
          return = {type: "single"}
        } as $found_doc
        var.update $existing { value = $found_doc }
      }
    }

    conditional {
      if ($existing != null) {
        db.edit documents {
          field_name = "id"
          field_value = $existing.id
          data = {
            source_url          : $input.source_url
            generated_url       : $input.generated_url
            accessibility_status: $input.accessibility_status
            version_hash        : $input.version_hash
          }
        } as $edited_doc
        var $document { value = $edited_doc }
      }
      else {
        db.add documents {
          data = {
            case_id             : $case.id
            type                : $input.type
            source_url          : $input.source_url
            generated_url       : $input.generated_url
            accessibility_status: $input.accessibility_status
            version_hash        : $input.version_hash
          }
        } as $added_doc
        var $document { value = $added_doc }
      }
    }

    // The document layer is the only thing that can move these two statuses,
    // so say so on the feed rather than letting the UI infer it.
    var $event_type { value = "document_generated" }
    var $event_message { value = "Completed PDF generated" }

    conditional {
      if ($input.type == "supporting_document") {
        var.update $event_type { value = "document_uploaded" }
        var.update $event_message { value = "Supporting document added" }
      }
      elseif ($input.type == "source_application") {
        var.update $event_type { value = "source_document_recorded" }
        var.update $event_message { value = "Official application recorded" }
      }
      elseif ($input.accessibility_status == "processed") {
        var.update $event_type { value = "accessibility_processed" }
        var.update $event_message { value = "Accessibility processing complete" }
      }
    }

    db.add events {
      data = {
        case_id      : $case.id
        actor        : "nutrient"
        event_type   : $event_type
        message      : $event_message
        metadata_json: {
          document_id         : $document.id
          type                : $document.type
          accessibility_status: $document.accessibility_status
        }
      }
    } as $event
  }

  response = $document
  tags = ["accessform"]
  guid = "Wg0tX1nG6h1fulKV9u2fYABdpAE"
}
