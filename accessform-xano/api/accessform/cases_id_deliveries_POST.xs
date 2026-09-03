// POST /cases/{id}/deliveries - record one SMS send attempt.
//
// The delivery module writes a `queued` row before calling Twilio and then
// the outcome: `sent` with the provider SID, `failed` with the error, or
// `skipped` (trial-account guard, demo mode). When provider_id matches an
// existing row for the case the row is edited in place; otherwise a new row
// is inserted - the history is the point.
//
// Sets cases.delivery_status. The feed event carries only the masked number
// and the status - never the full number, never the message body.
query "cases/{id}/deliveries" verb=POST {
  api_group = "AccessForm"
  description = "Record an SMS delivery attempt for a case and update the case's delivery status."

  input {
    text id filters=trim

    enum channel?="sms" {
      values = ["sms"]
    }

    text to filters=trim
    text message?
    text document_url? filters=trim

    enum status?="queued" {
      values = ["queued", "sent", "failed", "skipped"]
    }

    text provider_id? filters=trim
    text error?
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

    var $provider_id { value = ($input.provider_id ?? "") }
    var $existing { value = null }

    conditional {
      if ($provider_id != "") {
        db.query deliveries {
          where = $db.deliveries.case_id == $case.id && $db.deliveries.provider_id == $provider_id
          return = {type: "single"}
        } as $found
        var.update $existing { value = $found }
      }
    }

    conditional {
      if ($existing != null) {
        db.edit deliveries {
          field_name = "id"
          field_value = $existing.id
          data = {
            channel     : $input.channel
            to          : $input.to
            message     : ($input.message ?? "")
            document_url: ($input.document_url ?? "")
            status      : $input.status
            provider_id : $provider_id
            error       : ($input.error ?? "")
          }
        } as $edited
        var $delivery { value = $edited }
      }
      else {
        db.add deliveries {
          data = {
            case_id     : $case.id
            channel     : $input.channel
            to          : $input.to
            message     : ($input.message ?? "")
            document_url: ($input.document_url ?? "")
            status      : $input.status
            provider_id : $provider_id
            error       : ($input.error ?? "")
          }
        } as $added
        var $delivery { value = $added }
      }
    }

    // queued -> queued, sent -> sent, failed -> failed, skipped -> none.
    var $case_delivery_status { value = "none" }
    conditional {
      if ($input.status == "queued") {
        var.update $case_delivery_status { value = "queued" }
      }
      elseif ($input.status == "sent") {
        var.update $case_delivery_status { value = "sent" }
      }
      elseif ($input.status == "failed") {
        var.update $case_delivery_status { value = "failed" }
      }
    }

    db.edit cases {
      field_name = "id"
      field_value = $case.id
      data = {delivery_status: $case_delivery_status, updated_at: "now"}
    } as $updated_case

    // Last four digits only.
    var $to_masked { value = "***" }
    var $to_length { value = $input.to|strlen }
    conditional {
      if ($to_length >= 4) {
        var.update $to_masked { value = "***" ~ ($input.to|substr:($to_length - 4):4) }
      }
    }

    var $event_type { value = "summary_failed" }
    var $event_message { value = "Text message not sent (" ~ $input.status ~ ")" }
    conditional {
      if ($input.status == "sent") {
        var.update $event_type { value = "summary_sent" }
        var.update $event_message { value = "Summary text sent to " ~ $to_masked }
      }
      elseif ($input.status == "queued") {
        var.update $event_type { value = "summary_queued" }
        var.update $event_message { value = "Summary text queued for " ~ $to_masked }
      }
    }

    db.add events {
      data = {
        case_id      : $case.id
        actor        : "xano"
        event_type   : $event_type
        message      : $event_message
        metadata_json: {delivery_id: $delivery.id, status: $input.status, to_masked: $to_masked, channel: $input.channel}
      }
    } as $event
  }

  response = $delivery
  tags = ["accessform"]
  guid = "QS6BCjpG5Gky8Dkk7uSAcBx_BaM"
}
