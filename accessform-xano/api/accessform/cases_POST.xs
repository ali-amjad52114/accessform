// POST /cases - open a case for one caller. Vapi tool `create_case`.
//
// M1: a case no longer needs an organization to exist. The caller describes
// their situation; need resolution and discovery attach the organization and
// program later. When a hospital_name IS given (legacy Cedars path) the
// hospital is resolved or created by name and the newest verified program for
// it is attached, exactly as before. There is no default hospital any more:
// nothing is ever auto-attached to a caller who did not name it.
query "cases" verb=POST {
  api_group = "AccessForm"
  description = "Create a case. Records the caller's situation; attaches a hospital/program only when one is named."

  input {
    text patient_display_name?="Caller" filters=trim
    text? hospital_name? filters=trim
    decimal bill_amount?=0
    int? program_id?

    // Optional human-facing reference, e.g. "AF-001". Every case endpoint
    // accepts either this or the numeric id.
    text? external_ref?

    // ---- M1 ----
    text situation_text?
    text caller_phone? filters=trim
    text location? filters=trim

    enum need_category?="other" {
      values = ["hospital_financial_assistance", "paratransit", "disability_accommodation", "scholarship_financial_aid", "benefits", "appointment", "other"]
    }
  }

  stack {
    var $hospital { value = null }
    var $hospital_id { value = null }
    var $hospital_name { value = null }

    conditional {
      if ($input.hospital_name != null && $input.hospital_name != "") {
        db.get hospitals {
          field_name = "name"
          field_value = $input.hospital_name
        } as $existing_hospital

        conditional {
          if ($existing_hospital != null) {
            var.update $hospital { value = $existing_hospital }
          }
          else {
            db.add hospitals {
              data = {name: $input.hospital_name}
            } as $new_hospital
            var.update $hospital { value = $new_hospital }
          }
        }

        var.update $hospital_id { value = $hospital.id }
        var.update $hospital_name { value = $hospital.name }
      }
    }

    // Attach the newest verified program for a named hospital unless the
    // caller named a program.
    var $program_id { value = $input.program_id }
    conditional {
      if ($program_id == null && $hospital_id != null) {
        db.query programs {
          where = $db.programs.hospital_id == $hospital_id && $db.programs.verified == true
          sort = {retrieved_at: "desc"}
          return = {type: "single"}
        } as $latest_program

        conditional {
          if ($latest_program != null) {
            var.update $program_id { value = $latest_program.id }
          }
        }
      }
    }

    var $organization_id { value = null }
    conditional {
      if ($program_id != null) {
        db.get programs {
          field_name = "id"
          field_value = $program_id
        } as $named_program
        conditional {
          if ($named_program != null && ($named_program.organization_id ?? 0) > 0) {
            var.update $organization_id { value = $named_program.organization_id }
          }
        }
      }
    }

    // A case with a known official form is already past discovery.
    var $status { value = "CREATED" }
    conditional {
      if ($program_id != null) {
        var.update $status { value = "FORM_FOUND" }
      }
    }

    db.add cases {
      data = {
        patient_display_name: $input.patient_display_name
        hospital_id         : $hospital_id
        program_id          : $program_id
        organization_id     : $organization_id
        bill_amount         : $input.bill_amount
        status              : $status
        progress_percent    : 0
        external_ref        : $input.external_ref
        situation_text      : ($input.situation_text ?? "")
        caller_phone        : ($input.caller_phone ?? "")
        location            : ($input.location ?? "")
        need_category       : $input.need_category
        delivery_status     : "none"
      }
    } as $case

    // The feed never carries the caller's own words or number.
    db.add events {
      data = {
        case_id      : $case.id
        actor        : "xano"
        event_type   : "case_created"
        message      : "Case created"
        metadata_json: {case_id: $case.id, hospital: $hospital_name, need_category: $input.need_category, has_location: (($input.location ?? "") != "")}
      }
    } as $event
  }

  response = $case
  tags = ["accessform"]
  guid = "Tpc5nAuLUnZX8qxM1L1eKkNkO9I"
}
