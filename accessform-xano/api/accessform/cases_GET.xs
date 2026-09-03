// GET /cases?limit=20 - the most recent cases, newest first.
//
// Feeds the conversation page's history sidebar so a case opened by phone
// shows up on the laptop that is watching. No auth in this workspace, so the
// list is deliberately thin: ids and the few display columns, never answers.
query "cases" verb=GET {
  api_group = "AccessForm"
  description = "Most recent cases (id and display columns only), newest first."

  input {
    int limit?=20 filters=min:1|max:50
  }

  stack {
    db.query cases {
      sort = {created_at: "desc"}
      return = {
        type: "list"
        paging: {page: 1, per_page: $input.limit, metadata: false}
      }
    } as $rows

    var $cases {
      value = $rows|map:{
        id: $$.id,
        created_at: $$.created_at,
        status: $$.status,
        situation_text: ($$.situation_text ?? ""),
        need_category: ($$.need_category ?? "other"),
        location: ($$.location ?? ""),
        delivery_status: ($$.delivery_status ?? "none"),
        caller_phone_last4: (($$.caller_phone ?? "")|substr:-4:4)
      }
    }
  }

  response = {cases: $cases}
  guid = "kT6SZ7q8mOvn-2Q2xqZDMPQq0HE"
}
