// POST /organizations - upsert an organization by exact name.
//
// The catalog seed and live discovery both call this before recording a
// program, so every program can point at the authority that publishes it.
// `domain` is the registrable domain (lowercase, no scheme, no www): it is
// what makes a .com/.org source count as official for THIS organization only.
query "organizations" verb=POST {
  api_group = "AccessForm"
  description = "Create or update an organization (hospital, transit agency, college, agency) by name."

  input {
    text name filters=trim

    enum kind?="other" {
      values = ["hospital", "transit_agency", "college", "agency", "other"]
    }

    text domain? filters=trim|lower
    text region? filters=trim
    text website? filters=trim
  }

  stack {
    var $domain {
      value = ($input.domain ?? "")|replace:"www.":""
    }

    db.get organizations {
      field_name = "name"
      field_value = $input.name
    } as $existing

    conditional {
      if ($existing != null) {
        db.edit organizations {
          field_name = "id"
          field_value = $existing.id
          data = {
            kind   : $input.kind
            domain : $domain
            region : ($input.region ?? "")
            website: ($input.website ?? "")
          }
        } as $edited
        var $organization { value = $edited }
      }
      else {
        db.add organizations {
          data = {
            name   : $input.name
            kind   : $input.kind
            domain : $domain
            region : ($input.region ?? "")
            website: ($input.website ?? "")
          }
        } as $added
        var $organization { value = $added }
      }
    }
  }

  response = $organization
  tags = ["accessform"]
  guid = "tBElVQpAIe_0hL-2CSCVNF-tbWE"
}
