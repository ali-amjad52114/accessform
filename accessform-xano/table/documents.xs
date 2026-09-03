// Every PDF in the case: the official source, the filled output, and any
// supporting evidence the patient adds.
table documents {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int case_id {
      table = "cases"
    }

    enum type?="source_application" {
      values = ["source_application", "filled_application", "supporting_document"]
    }

    text source_url? filters=trim
    text generated_url? filters=trim

    // The app contract (app/lib/contract.ts AccessibilityStatus) spells these
    // pending / processing / processed / failed / not_applicable, and only
    // "processed" may be described in UI copy as "accessibility processed".
    // Those are the values to write. The original four are kept so rows
    // written before the vocabularies were reconciled still validate.
    enum accessibility_status?="pending" {
      values = ["pending", "processing", "processed", "preserved", "failed", "not_applicable", "not_started", "complete"]
    }

    // Hash of the source bytes, so we can prove which version was filled.
    text version_hash? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "case_id", op: "asc"}]}
    {type: "btree", field: [{name: "type", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "6s-s07O9RrR8OCHQCTWFB3-xnsU"
}
