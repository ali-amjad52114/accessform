// One caller's attempt at one application. The spine of the product.
table cases {
  auth = false

  schema {
    int id
    timestamp created_at?=now
    timestamp updated_at?=now

    // Display name only. The product deliberately stores no identifiers.
    text patient_display_name? filters=trim

    int hospital_id? {
      table = "hospitals"
    }

    int program_id? {
      table = "programs"
    }

    decimal bill_amount?=0 filters=min:0

    enum status?="CREATED" {
      values = ["CREATED", "DISCOVERING", "FORM_FOUND", "INTERVIEWING", "VALIDATING", "GENERATING", "ACCESSIBILITY_PROCESSING", "READY_FOR_REVIEW", "BLOCKED"]
    }

    int progress_percent?=0 filters=min:0|max:100

    // Human-facing case reference used by the demo and the voice agent
    // (e.g. "AF-001"), so a case can be addressed without knowing the numeric PK.
    text? external_ref? filters=trim

    // ---- M1 columns (docs/M1_CONTRACT.md section 5) ----

    enum need_category?="other" {
      values = ["hospital_financial_assistance", "paratransit", "disability_accommodation", "scholarship_financial_aid", "benefits", "appointment", "other"]
    }

    // What the caller said about where they are, verbatim-ish.
    text location? filters=trim

    // E.164 when known. Never spoken back in full; masks are last-4 only.
    text caller_phone? filters=trim

    // The caller's own words, first turn. Never read back to them.
    text situation_text?

    enum delivery_status?="none" {
      values = ["none", "queued", "sent", "failed"]
    }

    int organization_id? {
      table = "organizations"
    }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "external_ref", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "jOngptmaTUuFAm6xmCCBsmJ70Xs"
}
