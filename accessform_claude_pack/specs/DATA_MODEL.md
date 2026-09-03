# Xano Data Model

## hospitals
- id
- name
- website
- hcai_id

## programs
- id
- hospital_id
- name
- policy_url
- application_url
- source_domain
- effective_date
- retrieved_at
- verified

## cases
- id
- patient_display_name
- hospital_id
- program_id
- bill_amount
- status
- progress_percent
- created_at
- updated_at

Suggested statuses:
`CREATED`, `DISCOVERING`, `FORM_FOUND`, `INTERVIEWING`, `VALIDATING`, `GENERATING`, `ACCESSIBILITY_PROCESSING`, `READY_FOR_REVIEW`, `BLOCKED`.

## form_schema
- id
- program_id
- field_id
- label
- normalized_key
- type
- required
- conversational_prompt
- dependency_rule
- pdf_mapping

## answers
- id
- case_id
- field_id
- value_json
- source (`voice`, `manual`, `document`)
- confirmed
- updated_at

## requirements
- id
- case_id
- key
- label
- type (`field`, `attachment`, `signature`)
- status (`complete`, `missing`, `not_applicable`)
- evidence_url

## documents
- id
- case_id
- type (`source_application`, `filled_application`, `supporting_document`)
- source_url
- generated_url
- accessibility_status
- version_hash

## events
- id
- case_id
- timestamp
- actor (`user`, `voice_agent`, `serpapi`, `xano`, `nutrient`)
- event_type
- message
- metadata_json
