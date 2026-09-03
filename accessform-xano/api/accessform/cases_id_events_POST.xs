// POST /cases/{id}/events - append one line to the audit trail.
// This is also the sponsor-visibility feed on /live, so every integration
// (SerpApi, Nutrient, the voice agent) writes here rather than the UI inventing
// activity of its own.
query "cases/{id}/events" verb=POST {
  api_group = "AccessForm"
  description = "Append an event to a case. Powers the /live sponsor feed."

  input {
    text id filters=trim

    enum actor?="xano" {
      values = ["user", "voice_agent", "serpapi", "xano", "nutrient"]
    }

    text event_type filters=trim
    text? message?
    json? metadata_json?
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

    db.add events {
      data = {
        case_id      : $case.id
        actor        : $input.actor
        event_type   : $input.event_type
        message      : $input.message
        metadata_json: $input.metadata_json
      }
    } as $event
  }

  response = {
    id           : $event.id
    case_id      : $event.case_id
    timestamp    : $event.created_at
    actor        : $event.actor
    event_type   : $event.event_type
    message      : $event.message
    metadata_json: $event.metadata_json
  }
  tags = ["accessform"]
  guid = "gRF9OLFAmk1YsH-DiL7dIQ6675s"
}
