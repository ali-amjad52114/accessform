# AccessForm — Product Plan

*Status: approved direction, 2026-09-03. Supersedes the "vertical slice" framing in the build pack. The Cedars-Sinai path is the first catalog entry and the regression test, not the product boundary.*

## 1. The product in one paragraph

A person with a disability calls a phone number. No app, no internet, no screen. They describe what they need in their own words — help with a hospital bill, a paratransit application, a scholarship form, a disability accommodation, an appointment. The agent understands the need, asks where they are, finds the official form for that need and that place, interviews them conversationally, fills the real document, and sends the result by SMS: the filled form, what is still missing, and what to do next. Everything happens on one phone call.

## 2. What is already generic, what is not

The technology was proven on Cedars-Sinai. Most of it never cared which form it was.

| Layer | Status | What is still Cedars-specific |
|---|---|---|
| Voice (Vapi assistant, six tools, webhook) | generic | the opening script expects a hospital bill |
| Xano (cases, answers, requirements, events, `form_schema`) | generic | `hospitals` table name; seed data |
| Document filler (pdf-lib `local` engine) | generic | nothing |
| Discovery (SerpApi, allowlist, verification, cache) | machinery generic | three literal query strings; `cedars-sinai.org` in the allowlist |
| Interview plan | **not generic** | `lib/voice/form-plan.ts` — 26 hardcoded fields |
| Answer → field mapping | **not generic** | hardcoded in the same file |
| Delivery | **missing** | result is a web page; product needs SMS |
| Phone entry | **missing** | two numbers exist, neither routed to AccessForm |

## 3. Architecture

```
  caller ──phone──► Vapi assistant (need-agnostic)
                        │  tools
                        ▼
              ┌── Need resolver ──────────────► {category, organization?, location}
              │
              ├── Program discovery (SerpApi) ─► verified program + application URL + form_kind
              │        └ cache in Xano.programs
              │
              ├── Form understanding ──────────► form_schema rows (fields, types, spoken questions)
              │        pdf-lib fields + LLM      └ cache in Xano.form_schema per program
              │
              ├── Interview engine (Xano) ─────► next question, progress, completeness
              │
              ├── Answer mapper (LLM) ─────────► {pdf_field: value}, constrained to real fields
              │
              ├── Filler (pdf-lib) ────────────► filled, flattened PDF; honest accessibility status
              │
              └── Delivery (Twilio SMS) ───────► link to PDF + "still missing" list + next steps
```

Xano remains the system of record and the only place completeness is computed. The LLM never writes a PDF and never decides completeness; it classifies, judges sources, writes questions, and maps answers.

## 4. Sponsor input / output contract

| Sponsor | Input | Output | Used for |
|---|---|---|---|
| **Vapi** (+ Twilio number) | live phone/browser audio | transcript, tool calls, speech; SMS via the Twilio number | the front door and the delivery rail |
| **SerpApi** | `{category, organization?, location}` → templated queries | ranked candidate URLs with domains and titles | finding the official program and form |
| **Xano** | tool calls (create case, save answer, validate, documents, events) | case state, next question, completeness, requirements | orchestration and truth |
| **Nutrient** (optional, when credits exist) | source PDF + Instant JSON | filled/tagged PDF; Extraction API: structure of flat PDFs | premium document path; flat-form understanding |
| **LLM** (Claude or OpenAI) | situation text; candidate pages; PDF field list; answers | need category; official-source verdict; `form_schema`; field mapping | every judgment step, always with constrained output |
| **pdf-lib** (default engine) | source PDF + field values | filled, flattened PDF | filling any fillable PDF, no credits, no watermark |

## 5. Program catalog and form kinds

Every program has a `form_kind`. The product must be honest about each.

| `form_kind` | What AccessForm does |
|---|---|
| `fillable_pdf` | fills it, sends it |
| `flat_pdf` | phase 2: overlay by coordinates (Nutrient Extraction or OCR); until then, sends the PDF plus a spoken/SMS checklist of every answer collected |
| `online_form` | collects the answers, sends an SMS with the link and every answer ready to type in |
| `in_person` | sends the address, hours, and what to bring |

Launch catalog (pre-verified, real forms, cached like Cedars — live discovery covers everything else):

| Need | Program | Region | Verified |
|---|---|---|---|
| hospital bill | Cedars-Sinai financial assistance | Los Angeles | `fillable_pdf`, 3 pages, 101 fields |
| paratransit | Access Services ADA paratransit application (English; Spanish twin exists) | LA County | `fillable_pdf`, 10 pages, 146 fields |
| paratransit | SF Paratransit ADA application (rev 6-2020) | San Francisco | `fillable_pdf`, 10 pages, 168 fields |
| disability accommodation | Napa Valley College DSPS student application | Napa | `fillable_pdf`, 2 pages, 32 fields |

All four verified 2026-09-03 by downloading the PDF and reading its AcroForm field list. Manifest with URLs, hashes and field counts: `spike/catalog.json`.

## 6. Generic voice tools

The six tools keep their names where the meaning is unchanged; two are widened and two are new.

| Tool | Input | Output |
|---|---|---|
| `create_case` | `caller_phone`, `situation_text`, `location` | `case_id` |
| `resolve_need` *(new)* | `case_id`, `situation_text` | `category`, `organization?`, confidence, one clarifying question if needed |
| `discover_program` | `case_id`, `category`, `organization?`, `location` | verified program + `form_kind` + `application_url`, or `found=false` |
| `get_next_question` *(widens `get_case_progress`)* | `case_id` | next `field_id`, spoken question, progress |
| `save_answer` | `case_id`, `field_id`, `value` | saved answer, progress |
| `validate_case` | `case_id` | completeness, missing requirements |
| `finalize_document` | `case_id` | document URL, accessibility status |
| `send_summary` *(new)* | `case_id`, `channel=sms` | delivery id |

## 7. Data model changes (Xano, additive)

- `organizations` (new): `name`, `kind` (hospital, transit_agency, college, agency), `domain`, `region`. `hospitals` stays as-is until migrated.
- `programs`: add `category`, `form_kind`, `submission_instructions`, `organization_id`.
- `cases`: add `need_category`, `location`, `caller_phone`, `situation_text`, `delivery_status`.
- `form_schema`: already has `conversational_prompt`, `dependency_rule`, `pdf_mapping`; add `section`, `order`.
- `deliveries` (new): `case_id`, `channel`, `to`, `message`, `document_url`, `status`, `provider_id`.

## 8. Milestones

**M1 — product spine (target: 2 days with agents).** Need-first assistant prompt. Generic tools. Parameterized, verified discovery. Form understanding for `fillable_pdf`. LLM answer mapper with the Cedars plan as its fixture. SMS delivery through the Twilio number. One phone number routed to AccessForm. Public deployment so webhooks and SMS links are stable. Catalog: Cedars, LA and SF paratransit, Napa Valley College DSPS — all real, all verified fillable.
*Done when:* "I'm 65 and I need to get to my doctor" with an LA address ends in an SMS containing a filled paratransit application — and the Cedars call still passes unchanged.

**M2 — every form kind.** `flat_pdf` overlay. `online_form` and `in_person` delivery. Callback when a form needs a document the caller has to find. Spanish.

**M3 — operating a product.** Catalog growth tooling, human review queue, consent and retention policy for PII, cost controls (SerpApi tier, Vapi minutes), analytics on where callers get stuck.

## 9. Non-negotiables (carried from CLAUDE.md)

Never substitute one organization's form for another. Never say approved, eligible, submitted, or signed. Completeness comes only from Xano. Accessibility status is literal. No fixtures outside demo mode. Never ask for SSN or account numbers. Verified sources only. SMS carries a link and a checklist, never the answers themselves.

## 10. Risks and how each is handled

| Risk | Handling |
|---|---|
| Forms vary wildly | `form_kind` per program; honesty for anything not fillable |
| Wrong form served | discovery returns `found=false` unless verified; the UCSF bug is now a regression test |
| LLM invents a field or value | constrained output against the real field list; deterministic code writes the PDF |
| SerpApi credits (250/month free) | cache per program; refresh is opt-in; paid tier before launch |
| Nutrient credits | pdf-lib is the default engine; Nutrient is optional |
| PII over SMS | link + checklist only; short-lived document URLs; consent captured on the call |
| Tunnel instability | deploy to a stable public host for M1 |

## 11. Decisions needed from the owner

1. LLM for the judgment steps: Claude or OpenAI. (Vapi's conversation model stays gpt-4o either way.)
2. SMS: Twilio directly with the existing number — needs Twilio credentials in `.env.local`.
3. Public host for M1 (Vercel is the least work for Next.js).
4. Which two paratransit agencies and which scholarship form to pre-verify first.

## 12. Verification

Three golden calls, run as fixtures against the live stack before every demo: Cedars hospital bill, LA paratransit, one scholarship. Each must produce a case in Xano, a filled PDF, and a logged SMS delivery. The UCSF substitution case must return `found=false`.
