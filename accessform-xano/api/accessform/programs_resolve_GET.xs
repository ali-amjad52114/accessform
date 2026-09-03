// GET /programs/resolve?category=&location=&organization= - the catalog.
//
// The first thing discovery does, before spending a SerpApi search. Returns a
// verified program for the category and place, or found=false.
//
// NEVER substitutes. When the caller named an organization, only a program
// whose organization name shares a distinctive whole word with it can be returned;
// otherwise found=false with a reason, even if the category has other
// verified programs (those come back as `alternatives` for the agent to
// offer, never as `program`).
query "programs/resolve" verb=GET {
  api_group = "AccessForm"
  description = "Find a verified catalog program for a need category, organization and/or location. Never returns a different organization's program."

  input {
    enum category {
      values = ["hospital_financial_assistance", "paratransit", "disability_accommodation", "scholarship_financial_aid", "benefits", "appointment", "other"]
    }

    text location? filters=trim
    text organization? filters=trim
  }

  stack {
    db.query programs {
      where = $db.programs.verified == true && $db.programs.category == $input.category
      sort = {retrieved_at: "desc", id: "asc"}
      return = {type: "list"}
    } as $programs

    // Attach the organization (or legacy hospital) name to each row.
    var $rows { value = [] }
    var $row_org { value = null }
    var $row_hospital { value = null }
    var $org_name { value = "" }
    var $entry { value = {} }

    foreach ($programs) {
      each as $program {
        var.update $row_org { value = null }
        var.update $org_name { value = "" }

        conditional {
          if (($program.organization_id ?? 0) > 0) {
            db.get organizations {
              field_name = "id"
              field_value = $program.organization_id
            } as $found_org
            var.update $row_org { value = $found_org }
          }
        }

        conditional {
          if ($row_org != null) {
            var.update $org_name { value = $row_org.name }
          }
          elseif (($program.hospital_id ?? 0) > 0) {
            db.get hospitals {
              field_name = "id"
              field_value = $program.hospital_id
            } as $found_hospital
            var.update $row_hospital { value = $found_hospital }
            conditional {
              if ($row_hospital != null) {
                var.update $org_name { value = $row_hospital.name }
              }
            }
          }
        }

        // Whole-word tokens of the organization name, hyphens split, so
        // "Cedars Sinai" and "Cedars-Sinai" agree and "transit" can never
        // match inside "paratransit".
        var.update $entry {
          value = {
            program     : ($program|set:"organization_name":$org_name)
            organization: $row_org
            org_tokens  : (((((($org_name|to_lower)|replace:",":" ")|replace:"/":" ")|replace:"-":" ")|split:" ")|filter:($$|strlen) > 0)
            region_lower: (($program.region ?? "")|to_lower)
          }
        }
        var.update $rows { value = $rows|push:$entry }
      }
    }

    var $alternatives { value = $rows|map:$$.program }

    var $found { value = false }
    var $match { value = null }
    var $reason { value = "" }

    // Words that name a kind of place, not a specific one.
    var $stopwords {
      value = "|medical|center|centre|hospital|health|healthcare|system|services|service|agency|county|city|of|the|and|college|university|community|district|department|office|program|programs|inc|llc|"
    }

    var $organization { value = ($input.organization ?? "")|trim }
    var $location { value = ($input.location ?? "")|trim }

    conditional {
      if ($organization != "") {
        var $org_tokens {
          value = ((((($organization|to_lower)|replace:",":" ")|replace:"/":" ")|replace:"-":" ")|split:" ")|filter:($$|strlen) >= 3 && !($stopwords|contains:("|" ~ $$ ~ "|"))
        }

        // Every distinctive word the caller used must appear in the
        // organization's name ("Golden Gate Transit" never matches an agency
        // that merely has "Transit" in its name). No distinctive word => no
        // match. The TypeScript caller re-checks with organizationMatches().
        var $all_present { value = false }
        var $token { value = "" }

        foreach ($rows) {
          each as $row {
            conditional {
              if ($match == null && ($org_tokens|count) > 0) {
                var.update $all_present { value = true }
                foreach ($org_tokens) {
                  each as $org_token {
                    var.update $token { value = $org_token }
                    conditional {
                      if (!($row.org_tokens|some:$$ == $token)) {
                        var.update $all_present { value = false }
                      }
                    }
                  }
                }
                conditional {
                  if ($all_present) {
                    var.update $match { value = $row }
                  }
                }
              }
            }
          }
        }

        conditional {
          if ($match != null) {
            var.update $found { value = true }
          }
          else {
            var.update $reason { value = "no verified program for that organization" }
          }
        }
      }
      elseif ($location != "") {
        var $loc_tokens {
          value = (((($location|to_lower)|replace:",":" ")|replace:"/":" ")|split:" ")|filter:($$|strlen) >= 3 && !($stopwords|contains:("|" ~ $$ ~ "|"))
        }

        var $best_score { value = 0 }
        var $score { value = 0 }
        var $loc_token { value = "" }

        foreach ($rows) {
          each as $row {
            var.update $score { value = 0 }
            foreach ($loc_tokens) {
              each as $candidate_token {
                var.update $loc_token { value = $candidate_token }
                conditional {
                  if ($row.region_lower != "" && ($row.region_lower|contains:$loc_token)) {
                    var.update $score { value = $score + 1 }
                  }
                }
              }
            }
            conditional {
              if ($score > $best_score) {
                var.update $best_score { value = $score }
                var.update $match { value = $row }
              }
            }
          }
        }

        conditional {
          if ($match != null) {
            var.update $found { value = true }
          }
          else {
            var.update $reason { value = "no verified program for that location" }
          }
        }
      }
      else {
        var.update $reason { value = "give an organization or a location" }
      }
    }

    conditional {
      if (($rows|count) == 0) {
        var.update $reason { value = "no verified program in the catalog for that category" }
      }
    }

    var $program_out { value = null }
    var $organization_out { value = null }
    conditional {
      if ($found) {
        var.update $program_out { value = $match.program }
        var.update $organization_out { value = $match.organization }
      }
    }
  }

  response = {
    found       : $found
    program     : $program_out
    organization: $organization_out
    alternatives: $alternatives
    reason      : $reason
  }
  tags = ["accessform"]
  guid = "-y05JZHEIUG_oa1w1Tcr-kCzKrk"
}
