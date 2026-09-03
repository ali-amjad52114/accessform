// A verified program and the current official application behind it: a
// hospital's financial-assistance form, a transit agency's paratransit
// application, a college's DSPS application. Written by the catalog seed and
// by live discovery, never hand-edited.
table programs {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    // Legacy link for hospital programs (Cedars). Optional since M1: a
    // paratransit or college program has an organization, not a hospital.
    int hospital_id? {
      table = "hospitals"
    }

    text name filters=trim
    text policy_url? filters=trim
    text application_url? filters=trim

    // Domain the application was retrieved from. Verified only when it is
    // .gov / .edu or the organization's own domain.
    text source_domain? filters=trim

    text effective_date?
    timestamp retrieved_at?=now

    // False until the source domain passes the allowlist check. An unverified
    // program must not be filled - the product stops and asks for confirmation.
    bool verified?=false

    // ---- M1 columns (docs/M1_CONTRACT.md section 5) ----

    enum category?="hospital_financial_assistance" {
      values = ["hospital_financial_assistance", "paratransit", "disability_accommodation", "scholarship_financial_aid", "benefits", "appointment", "other"]
    }

    // M1 fills fillable_pdf only; the others are delivered as link + checklist.
    enum form_kind?="fillable_pdf" {
      values = ["fillable_pdf", "flat_pdf", "online_form", "in_person"]
    }

    int organization_id? {
      table = "organizations"
    }

    // Plain-language "how to hand this in", spoken and texted.
    text submission_instructions?

    // Number of AcroForm fields on the application PDF; 0 for non-PDF kinds.
    int field_count?=0 filters=min:0

    // Free text region the program serves, e.g. "San Francisco, CA".
    text region? filters=trim

    int page_count?=0 filters=min:0

    // First 16 hex chars of the sha256 of the verified PDF bytes.
    text sha256? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "hospital_id", op: "asc"}]}
    {type: "btree", field: [{name: "retrieved_at", op: "desc"}]}
    {type: "btree", field: [{name: "application_url", op: "asc"}]}
    {type: "btree", field: [{name: "category", op: "asc"}]}
    {type: "btree", field: [{name: "organization_id", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "SAu_3mhaqcVLTjNG6yZ_Pu8TM0o"
}
