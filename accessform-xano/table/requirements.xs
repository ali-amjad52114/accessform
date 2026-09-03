// Everything the published policy demands, including items that are not form
// fields. This is what lets the product say "one thing left" truthfully.
table requirements {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int case_id {
      table = "cases"
    }

    // Stable key, e.g. "proof_of_social_security_income".
    text key filters=trim

    text label? filters=trim

    enum type?="field" {
      values = ["field", "attachment", "signature"]
    }

    enum status?="missing" {
      values = ["complete", "missing", "not_applicable"]
    }

    text evidence_url? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "case_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "sVWpK1azakFTIKne6ZWuPVcY9gU"
}
