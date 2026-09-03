// One patient's attempt at one application. The spine of the demo.
table cases {
  auth = false

  schema {
    int id
    timestamp created_at?=now
    timestamp updated_at?=now

    // Display name only. The slice deliberately stores no patient identifiers.
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
