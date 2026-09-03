// GET /cases/{id} - the whole case in one read: CaseBundle.
// {id} accepts either the numeric primary key or the human reference
// ("AF-001"), so the demo can deep-link without knowing Xano's ids.
query "cases/{id}" verb=GET {
  api_group = "AccessForm"
  description = "Case + hospital + program + answers + requirements + documents + events."

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
    answers     : $answers
    requirements: $requirements
    documents   : $documents
    events      : $event_feed
  }
  tags = ["accessform"]
  guid = "yPXfBKj7xxKfC6HEzxsSLPpyHpY"
}
