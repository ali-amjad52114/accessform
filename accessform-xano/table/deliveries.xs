// One SMS send attempt for a case: link to the filled document, the "still
// needed" list and the next step. Never the answers themselves. The row is
// the audit trail of what was (or was not) texted; `cases.delivery_status`
// mirrors the latest one.
table deliveries {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int case_id {
      table = "cases"
    }

    enum channel?="sms" {
      values = ["sms"]
    }

    // E.164 destination. Masked (last 4) everywhere it is spoken or logged.
    text to? filters=trim

    // The exact body sent. <= 320 characters, no personal data.
    text message?

    text document_url? filters=trim

    // queued -> provider not yet called; sent -> provider accepted (SID);
    // failed -> provider rejected; skipped -> intentionally not attempted
    // (trial-account guard, demo mode). Never reported to the caller as sent.
    enum status?="queued" {
      values = ["queued", "sent", "failed", "skipped"]
    }

    // Twilio Message SID ("SM..."), "" until sent.
    text provider_id? filters=trim

    // Provider error text when failed/skipped; "" otherwise.
    text error?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "case_id", op: "asc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "q91Rt4_t8DTb24vMZW4EkLLyym4"
}
