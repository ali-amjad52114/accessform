// GET /cases/{id} - the whole case in one read: CaseBundle.
// {id} accepts either the numeric primary key or the human reference
// ("AF-001"), so the demo can deep-link without knowing Xano's ids.
// M1 adds `organization` (the case's, else the program's) and `deliveries`.
query "cases/{id}" verb=GET {
  api_group = "AccessForm"
  description = "Case + hospital + program + organization + answers + requirements + documents + events + deliveries."

  input {
    text id filters=trim
  }

  stack {
    db.get cases {
      field_name = "external_ref"
      field_value = $input.id
    } as $by_ref

    conditional {
      if ($by_ref != null) {
        var $case { value = $by_ref }
      }
      else {
        db.get cases {
          field_name = "id"
          field_value = ($input.id|to_int)
        } as $by_id
        var $case { value = $by_id }
      }
    }

    precondition ($case != null) {
      error_type = "notfound"
      error = "No case found with that id."
    }

    db.get hospitals {
      field_name = "id"
      field_value = $case.hospital_id
    } as $hospital

    db.get programs {
      field_name = "id"
      field_value = $case.program_id
    } as $program

    var $organization_id { value = $case.organization_id ?? 0 }
    conditional {
      if ($organization_id == 0 && $program != null) {
        var.update $organization_id { value = $program.organization_id ?? 0 }
      }
    }

    var $organization { value = null }
    conditional {
      if ($organization_id > 0) {
        db.get organizations {
          field_name = "id"
          field_value = $organization_id
        } as $found_org
        var.update $organization { value = $found_org }
      }
    }

    db.query answers {
      where = $db.answers.case_id == $case.id
      sort = {id: "asc"}
      return = {type: "list"}
    } as $answers

    db.query requirements {
      where = $db.requirements.case_id == $case.id
      sort = {id: "asc"}
      return = {type: "list"}
    } as $requirements

    db.query documents {
      where = $db.documents.case_id == $case.id
      sort = {id: "asc"}
      return = {type: "list"}
    } as $documents

    db.query events {
      where = $db.events.case_id == $case.id
      sort = {id: "asc"}
      return = {type: "list"}
    } as $events

    db.query deliveries {
      where = $db.deliveries.case_id == $case.id
      sort = {id: "asc"}
      return = {type: "list"}
    } as $deliveries

    // The contract calls the event time `timestamp`; the column is `created_at`.
    var $event_feed {
      value = $events|map:{
        id           : $$.id
        case_id      : $$.case_id
        timestamp    : $$.created_at
        actor        : $$.actor
        event_type   : $$.event_type
        message      : $$.message
        metadata_json: $$.metadata_json
      }
    }
  }

  response = {
    case        : $case
    hospital    : $hospital
    program     : $program
    organization: $organization
    answers     : $answers
    requirements: $requirements
    documents   : $documents
    events      : $event_feed
    deliveries  : $deliveries
  }
  tags = ["accessform"]
  guid = "yPXfBKj7xxKfC6HEzxsSLPpyHpY"
}
