// A value collected for one form field. Written by the voice agent as the
// interview proceeds; Xano stays authoritative for what has been answered.
table answers {
  auth = false

  schema {
    int id
    timestamp created_at?=now
    timestamp updated_at?=now

    int case_id {
      table = "cases"
    }

    text field_id filters=trim

    // Kept as JSON so numbers, booleans and choices round-trip unchanged.
    json value_json?

    enum source?="voice" {
      values = ["voice", "manual", "document"]
    }

    // True once the patient has confirmed the value back to the agent.
    bool confirmed?=false
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "case_id", op: "asc"}]}
    {type: "btree|unique", field: [{name: "case_id", op: "asc"}, {name: "field_id", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "lT4GRxPLNt-hdMoVqOxHqosY-HM"
}
