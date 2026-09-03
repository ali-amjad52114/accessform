// A hospital that publishes a financial-assistance program.
// The vertical slice seeds exactly one: Cedars-Sinai Medical Center.
table hospitals {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    text name filters=trim
    text website? filters=trim

    // HCAI facility identifier, used to verify the source is the official record.
    text hcai_id? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "name", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "KTMAAKjuzuxS3SG2-F3oRjNhP4M"
}
