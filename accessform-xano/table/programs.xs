// A discovered financial-assistance program and the current official application
// behind it. Written by the SerpApi discovery step, never hand-edited.
table programs {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int hospital_id {
      table = "hospitals"
    }

    text name filters=trim
    text policy_url? filters=trim
    text application_url? filters=trim

    // Domain the application was retrieved from. Only allowlisted domains
    // (hcai.ca.gov, api.hdc.hcai.ca.gov, cedars-sinai.org) count as verified.
    text source_domain? filters=trim

    text effective_date?
    timestamp retrieved_at?=now

    // False until the source domain passes the allowlist check. An unverified
    // program must not be filled — the product stops and asks for confirmation.
    bool verified?=false
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "hospital_id", op: "asc"}]}
    {type: "btree", field: [{name: "retrieved_at", op: "desc"}]}
  ]

  tags = ["accessform"]
  guid = "SAu_3mhaqcVLTjNG6yZ_Pu8TM0o"
}
