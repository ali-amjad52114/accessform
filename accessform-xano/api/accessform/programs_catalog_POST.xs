// POST /programs/catalog - upsert a verified program by exact application_url.
//
// Called by the catalog seed (spike/catalog.json) and by live discovery after
// it has verified the PDF bytes. Resolves or creates the organization by name,
// then upserts the program. `verified` is recomputed here and never trusted
// from the request alone: a program is verified only when the caller says so
// AND the source domain is .gov / .edu / the organization's own domain.
//
// Optional case_id links the case to the program exactly like
// POST /programs/discovered does (status FORM_FOUND, source document, events).
query "programs/catalog" verb=POST {
  api_group = "AccessForm"
  description = "Upsert a verified program (by application_url) and its organization. Never substitutes."

  input {
    text organization_name filters=trim

    enum organization_kind?="other" {
      values = ["hospital", "transit_agency", "college", "agency", "other"]
    }

    text organization_domain? filters=trim|lower
    text name filters=trim

    enum category?="other" {
      values = ["hospital_financial_assistance", "paratransit", "disability_accommodation", "scholarship_financial_aid", "benefits", "appointment", "other"]
    }

    enum form_kind?="fillable_pdf" {
      values = ["fillable_pdf", "flat_pdf", "online_form", "in_person"]
    }

    text application_url filters=trim
    text policy_url? filters=trim
    text source_domain? filters=trim|lower
    text region? filters=trim
    text submission_instructions?
    int field_count?=0 filters=min:0
    int page_count?=0 filters=min:0
    text sha256? filters=trim
    bool verified?=false
    text? retrieved_at?
    text? effective_date?

    // Optional: attach the program to a case in the same call.
    text? case_id?
  }

  stack {
    precondition (($input.application_url|starts_with:"https://") || ($input.application_url|starts_with:"http://")) {
      error_type = "inputerror"
      error = "application_url must be an absolute URL."
    }

    // ---------------------------------------------------------------
    // Organization (upsert by name)
    // ---------------------------------------------------------------
    var $org_domain {
      value = ($input.organization_domain ?? "")|replace:"www.":""
    }

    db.get organizations {
      field_name = "name"
      field_value = $input.organization_name
    } as $existing_org

    conditional {
      if ($existing_org != null) {
        db.edit organizations {
          field_name = "id"
          field_value = $existing_org.id
          data = {
            kind  : $input.organization_kind
            domain: $org_domain
            region: ($input.region ?? "")
          }
        } as $edited_org
        var $organization { value = $edited_org }
      }
      else {
        db.add organizations {
          data = {
            name  : $input.organization_name
            kind  : $input.organization_kind
            domain: $org_domain
            region: ($input.region ?? "")
          }
        } as $added_org
        var $organization { value = $added_org }
      }
    }

    // Hospitals also keep their legacy row so the Cedars path is unchanged.
    var $hospital_id { value = null }
    conditional {
      if ($input.organization_kind == "hospital") {
        db.get hospitals {
          field_name = "name"
          field_value = $input.organization_name
        } as $existing_hospital

        conditional {
          if ($existing_hospital != null) {
            var.update $hospital_id { value = $existing_hospital.id }
          }
          else {
            db.add hospitals {
              data = {name: $input.organization_name, website: "https://" ~ $org_domain}
            } as $new_hospital
            var.update $hospital_id { value = $new_hospital.id }
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // Source domain and verification
    // ---------------------------------------------------------------
    var $source_domain {
      value = ($input.source_domain ?? "")|replace:"www.":""
    }
    conditional {
      if ($source_domain == "") {
        var $after_scheme {
          value = ($input.application_url|split:"://")|last
        }
        var $host {
          value = (($after_scheme|split:"/")|first)|to_lower
        }
        var.update $source_domain { value = $host|replace:"www.":"" }
      }
    }

    var $own_domain { value = false }
    conditional {
      if ($org_domain != "") {
        var.update $own_domain {
          value = $source_domain == $org_domain || ($source_domain|ends_with:("." ~ $org_domain))
        }
      }
    }
    var $official {
      value = ($source_domain|ends_with:".gov") || ($source_domain|ends_with:".edu") || $own_domain
    }
    var $verified {
      value = $input.verified && $official
    }

    var $retrieved {
      value = ($input.retrieved_at ?? "now")
    }

    // ---------------------------------------------------------------
    // Program (upsert by application_url)
    // ---------------------------------------------------------------
    db.query programs {
      where = $db.programs.application_url == $input.application_url
      sort = {id: "asc"}
      return = {type: "single"}
    } as $existing_program

    conditional {
      if ($existing_program != null) {
        var $program_data {
          value = {
            name                   : $input.name
            policy_url             : ($input.policy_url ?? "")
            source_domain          : $source_domain
            effective_date         : $input.effective_date
            retrieved_at           : $retrieved
            verified               : $verified
            category               : $input.category
            form_kind              : $input.form_kind
            organization_id        : $organization.id
            submission_instructions: ($input.submission_instructions ?? "")
            field_count            : $input.field_count
            region                 : ($input.region ?? "")
            page_count             : $input.page_count
            sha256                 : ($input.sha256 ?? "")
          }
        }
        conditional {
          if ($hospital_id != null && ($existing_program.hospital_id ?? 0) == 0) {
            var.update $program_data { value = $program_data|set:"hospital_id":$hospital_id }
          }
        }
        db.patch programs {
          field_name = "id"
          field_value = $existing_program.id
          data = $program_data
        } as $edited_program
        var $program { value = $edited_program }
      }
      else {
        db.add programs {
          data = {
            hospital_id            : $hospital_id
            name                   : $input.name
            policy_url             : ($input.policy_url ?? "")
            application_url        : $input.application_url
            source_domain          : $source_domain
            effective_date         : $input.effective_date
            retrieved_at           : $retrieved
            verified               : $verified
            category               : $input.category
            form_kind              : $input.form_kind
            organization_id        : $organization.id
            submission_instructions: ($input.submission_instructions ?? "")
            field_count            : $input.field_count
            region                 : ($input.region ?? "")
            page_count             : $input.page_count
            sha256                 : ($input.sha256 ?? "")
          }
        } as $added_program
        var $program { value = $added_program }
      }
    }

    // ---------------------------------------------------------------
    // Optionally bind the program to a live case.
    // ---------------------------------------------------------------
    var $linked_case_id { value = null }

    conditional {
      if ($input.case_id != null && $input.case_id != "") {
        db.get cases {
          field_name = "external_ref"
          field_value = $input.case_id
        } as $case_by_ref

        conditional {
          if ($case_by_ref != null) {
            var $case { value = $case_by_ref }
          }
          else {
            db.get cases {
              field_name = "id"
              field_value = ($input.case_id|to_int)
            } as $case_by_id
            var $case { value = $case_by_id }
          }
        }

        conditional {
          if ($case != null) {
            var.update $linked_case_id { value = $case.id }

            var $case_data {
              value = {
                program_id     : $program.id
                organization_id: $organization.id
                status         : "FORM_FOUND"
                updated_at     : "now"
              }
            }
            conditional {
              if ($hospital_id != null) {
                var.update $case_data { value = $case_data|set:"hospital_id":$hospital_id }
              }
            }
            db.patch cases {
              field_name = "id"
              field_value = $case.id
              data = $case_data
            } as $updated_case

            // Record the official PDF as the source document for this case.
            db.query documents {
              where = $db.documents.case_id == $case.id && $db.documents.type == "source_application"
              return = {type: "single"}
            } as $existing_doc

            conditional {
              if ($existing_doc != null) {
                db.edit documents {
                  field_name = "id"
                  field_value = $existing_doc.id
                  data = {source_url: $input.application_url, accessibility_status: "not_started"}
                } as $edited_doc
              }
              else {
                db.add documents {
                  data = {
                    case_id             : $case.id
                    type                : "source_application"
                    source_url          : $input.application_url
                    accessibility_status: "not_started"
                  }
                } as $added_doc
              }
            }

            db.add events {
              data = {
                case_id      : $case.id
                actor        : "serpapi"
                event_type   : "program_discovered"
                message      : "Official " ~ $organization.name ~ " program found"
                metadata_json: {
                  program_id     : $program.id
                  policy_url     : $program.policy_url
                  application_url: $program.application_url
                  form_kind      : $program.form_kind
                  category       : $program.category
                }
              }
            } as $discovery_event

            var $verify_message { value = $source_domain ~ " source not verified" }
            var $verify_type { value = "source_not_verified" }
            conditional {
              if ($verified) {
                var.update $verify_message { value = $source_domain ~ " source verified" }
                var.update $verify_type { value = "source_verified" }
              }
            }

            db.add events {
              data = {
                case_id      : $case.id
                actor        : "serpapi"
                event_type   : $verify_type
                message      : $verify_message
                metadata_json: {source_domain: $source_domain, verified: $verified}
              }
            } as $verify_event
          }
        }
      }
    }

    var $result {
      value = ($program|set:"organization_name":$organization.name)|set:"case_id":$linked_case_id
    }
  }

  response = $result
  tags = ["accessform"]
  guid = "P-s3n2nevpL5J7nX1R2kDAc_Kho"
}
