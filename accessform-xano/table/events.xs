// Audit trail and the source of the sponsor event feed on /live.
// Every integration writes here, so the UI never has to invent activity.
table events {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int case_id? {
      table = "cases"
    }

    enum actor?="xano" {
      values = ["user", "voice_agent", "serpapi", "xano", "nutrient"]
    }

    text event_type? filters=trim

    // Human-readable line shown in the UI, e.g. "HCAI source verified".
    text message?

    json metadata_json?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "case_id", op: "asc"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]

  tags = ["accessform"]
  guid = "5ByYcFVhz7Q_axGs166iiCOc8Pw"
}
