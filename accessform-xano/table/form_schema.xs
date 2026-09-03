// Normalized fields of the official PDF, one row per field. Produced by the
// form-understanding pass (pdf-lib extraction + constrained LLM), then used
// to drive the voice interview. Xano owns completeness, so grouping (section)
// and asking order live here, not in the UI.
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

    // "bool" is kept for rows written before checkbox/radio existed.
    enum type?="text" {
      values = ["text", "number", "currency", "date", "bool", "choice", "checkbox", "radio", "signature"]
    }

    bool required?=false

    // Legacy requirement group. M1 reads `section`, falling back to this
    // when section is "".
    text? group_key? filters=trim

    // How the voice agent asks for this, in plain language. Never read the raw
    // PDF label aloud.
    text conversational_prompt?

    // When this field only applies conditionally: "<normalized_key> == '<value>'".
    text dependency_rule?

    // How the value is written back into the PDF: AcroForm field name, or
    // page/coordinate box when the form has no fillable fields.
    json pdf_mapping?

    // ---- M1 columns (docs/M1_CONTRACT.md section 5) ----

    // Interview section, snake_case. For Cedars equals group_key.
    text section? filters=trim

    // 1-based asking order across the whole form. 0 = legacy row (id order).
    int order?=0 filters=min:0

    // Export values for button/radio/choice fields, without the leading "/".
    json options?

    // Exact AcroForm field name to write. Equals field_id for fillable PDFs.
    text pdf_field_name? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "program_id", op: "asc"}]}
    {type: "btree", field: [{name: "normalized_key", op: "asc"}]}
    {type: "btree", field: [{name: "group_key", op: "asc"}]}
    {type: "btree", field: [{name: "program_id", op: "asc"}, {name: "order", op: "asc"}]}
  ]

  tags = ["accessform"]
  guid = "2Uk9tsXAKgxCAGbexO9mCawmB2U"
}
