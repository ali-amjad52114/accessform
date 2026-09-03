// POST /programs/discovered - persist what SerpApi found.
//
// Takes the DiscoveryResult shape verbatim (hospital, intent, retrieved_at,
// searches_used, verified_sources, all_results, policy_url, application_url,
// from_cache), so the cached fixture and a live search post the same body.
//
// A program is only `verified` when the application actually came from an
// allowlisted official domain. An unverified program must not be filled.
query "programs/discovered" verb=POST {
  api_group = "AccessForm"
  description = "Persist a SerpApi discovery result as a hospital + program, with source verification."

  input {
    text hospital?="Cedars-Sinai Medical Center" filters=trim
    text? program_name?
    text? intent?
    text? retrieved_at?
    int searches_used?=0
    json? verified_sources?
    json? all_results?
    text policy_url filters=trim
    text application_url filters=trim
    text? effective_date?
    bool from_cache?=false

    // Optional: attach the program to a case in the same call.
    text? case_id?
  }

  stack {
    db.get hospitals {
      field_name = "name"
      field_value = $input.hospital
    } as $existing_hospital

    conditional {
      if ($existing_hospital != null) {
        var $hospital { value = $existing_hospital }
      }
      else {
        db.add hospitals {
          data = {name: $input.hospital}
        } as $new_hospital
        var $hospital { value = $new_hospital }
      }
    }

    // Host of the application URL, without scheme, path or www.
    var $after_scheme {
      value = ($input.application_url|split:"://")|last
    }
    var $host {
      value = ($after_scheme|split:"/")|first
    }
    var $source_domain {
      value = $host|replace:"www.":""
    }

    // Allowlist from API_INTEGRATIONS.md, most trusted first.
    var $allowlist {
      value = "|hcai.ca.gov|api.hdc.hcai.ca.gov|cedars-sinai.org|"
    }
    var $verified {
      value = $allowlist|contains:("|" ~ $source_domain ~ "|")
    }

    var $name {
      value = ($input.program_name ?? "Financial Assistance Application")
    }
    var $retrieved {
      value = ($input.retrieved_at ?? "now")
    }

    // Upsert on (hospital, application_url) so re-running discovery updates the
    // same program instead of stacking duplicates.
    db.query programs {
      where = $db.programs.hospital_id == $hospital.id && $db.programs.application_url == $input.application_url
      return = {type: "single"}
    } as $existing_program

    conditional {
      if ($existing_program != null) {
        db.edit programs {
          field_name = "id"
          field_value = $existing_program.id
          data = {
            name          : $name
            policy_url    : $input.policy_url
            source_domain : $source_domain
            effective_date: $input.effective_date
            retrieved_at  : $retrieved
            verified      : $verified
          }
        } as $edited_program
        var $program { value = $edited_program }
      }
      else {
        db.add programs {
          data = {
            hospital_id    : $hospital.id
            name           : $name
            policy_url     : $input.policy_url
            application_url: $input.application_url
            source_domain  : $source_domain
            effective_date : $input.effective_date
            retrieved_at   : $retrieved
            verified       : $verified
          }
        } as $added_program
        var $program { value = $added_program }
      }
    }

    // Optionally bind the discovery to a live case.
    var $linked_case_id { value = null }

    conditional {
      if ($input.case_id != null) {
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

            db.edit cases {
              field_name = "id"
              field_value = $case.id
              data = {
                hospital_id: $hospital.id
                program_id : $program.id
                status     : "FORM_FOUND"
                updated_at : "now"
              }
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
          }
        }
      }
    }

    var $verified_count {
      value = ($input.verified_sources ?? [])|count
    }

    db.add events {
      data = {
        case_id      : $linked_case_id
        actor        : "serpapi"
        event_type   : "program_discovered"
        message      : "Official " ~ $hospital.name ~ " program found"
        metadata_json: {
          policy_url     : $input.policy_url
          application_url: $input.application_url
          intent         : $input.intent
          searches_used  : $input.searches_used
          from_cache     : $input.from_cache
          verified_sources: $verified_count
        }
      }
    } as $discovery_event

    var $verify_message { value = $source_domain ~ " source not on the official allowlist" }
    conditional {
      if ($verified) {
        var.update $verify_message { value = $source_domain ~ " source verified" }
      }
    }

    db.add events {
      data = {
        case_id      : $linked_case_id
        actor        : "serpapi"
        event_type   : "source_verified"
        message      : $verify_message
        metadata_json: {source_domain: $source_domain, verified: $verified}
      }
    } as $verify_event
  }

  response = {
    id             : $program.id
    hospital_id    : $program.hospital_id
    name           : $program.name
    policy_url     : $program.policy_url
    application_url: $program.application_url
    source_domain  : $program.source_domain
    effective_date : $program.effective_date
    retrieved_at   : $program.retrieved_at
    verified       : $program.verified
    case_id        : $linked_case_id
  }
  tags = ["accessform"]
  guid = "zLLL4G_WasTiRz-jl6P4b2_Oozo"
}
