// An organization that publishes an official program: a hospital, a transit
// agency, a college, a public agency. Generalizes `hospitals`, which stays
// for the Cedars-Sinai regression. Upsert key is `name` (POST /organizations).
table organizations {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    // Canonical display name, e.g. "Access Services". Unique.
    text name filters=trim

    enum kind?="other" {
      values = ["hospital", "transit_agency", "college", "agency", "other"]
    }

    // Registrable domain, lowercase, no scheme, no www - e.g. "accessla.org".
    // A .com/.org source is only "official" when it equals this domain.
    text domain? filters=trim

    // Free text, e.g. "Los Angeles County, CA".
    text region? filters=trim

    text website? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "name", op: "asc"}]}
    {type: "btree", field: [{name: "domain", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "IJyMjKfK8AvfhxCn79HnT8VjwqA"
}
