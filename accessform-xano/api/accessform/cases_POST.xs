// POST /cases - open a case for one patient's financial-assistance application.
// Vapi tool `create_case`. The hospital is resolved (or created) by name and the
// most recently verified program for that hospital is attached automatically, so
// a case created after discovery already knows which official form it is filling.
query "cases" verb=POST {
  api_group = "AccessForm"
  description = "Create a case. Resolves the hospital by name and attaches the latest verified program."

  input {
    text patient_display_name filters=trim
    text hospital_name?="Cedars-Sinai Medical Center" filters=trim
    decimal bill_amount?=0
    int? program_id?

    // Optional human-facing reference, e.g. "AF-001". Every case endpoint
    // accepts either this or the numeric id.
    text? external_ref?
  }

  stack {
    db.get hospitals {
      field_name = "name"
      field_value = $input.hospital_name
    } as $existing_hospital

    conditional {
      if ($existing_hospital != null) {
        var $hospital { value = $existing_hospital }
      }
      else {
        db.add hospitals {
          data = {name: $input.hospital_name}
        } as $new_hospital
        var $hospital { value = $new_hospital }
      }
    }

    // Attach the newest verified program unless the caller named one.
    var $program_id { value = $input.program_id }
    conditional {
      if ($program_id == null) {
        db.query programs {
          where = $db.programs.hospital_id == $hospital.id && $db.programs.verified == true
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
        hospital_id        : $hospital.id
        program_id         : $program_id
        bill_amount        : $input.bill_amount
        status             : $status
        progress_percent   : 0
        external_ref       : $input.external_ref
      }
    } as $case

    db.add events {
      data = {
        case_id      : $case.id
        actor        : "xano"
        event_type   : "case_created"
        message      : "Case created"
        metadata_json: {case_id: $case.id, hospital: $hospital.name}
      }
    } as $event
  }

  response = $case
  tags = ["accessform"]
  guid = "Tpc5nAuLUnZX8qxM1L1eKkNkO9I"
}
