// Normalized fields of the official PDF, one row per field. Produced by the
// Nutrient extraction pass, then used to drive the voice interview.
table form_schema {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int program_id {
      table = "programs"
    }

    // Field identifier as it appears in the source PDF.
    text field_id filters=trim

    text label? filters=trim

    // Stable key the rest of the system uses, e.g. "monthly_social_security".
    text normalized_key? filters=trim

    enum type?="text" {
      values = ["text", "number", "currency", "date", "bool", "choice", "signature"]
    }

    bool required?=false

    // Requirement group this field rolls up into, e.g. "personal_information".
    // Xano owns completeness, so the grouping has to live here, not in the UI.
    text? group_key? filters=trim

    // How the voice agent asks for this, in plain language. Never read the raw
    // PDF label aloud.
    text conversational_prompt?

    // When this field only applies conditionally, e.g. spouse income.
    text dependency_rule?

    // How the value is written back into the PDF: AcroForm field name, or
    // page/coordinate box when the form has no fillable fields.
    json pdf_mapping?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "program_id", op: "asc"}]}
    {type: "btree", field: [{name: "normalized_key", op: "asc"}]}
    {type: "btree", field: [{name: "group_key", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "2Uk9tsXAKgxCAGbexO9mCawmB2U"
}
