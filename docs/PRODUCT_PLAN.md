# AccessForm — Product Plan

*Status: approved direction, 2026-09-03. Supersedes the "vertical slice" framing in the build pack. The Cedars-Sinai path is the first catalog entry and the regression test, not the product boundary.*

## 1. The product in one paragraph

A person with a disability calls a phone number. No app, no internet, no screen. They describe what they need in their own words — help with a hospital bill, a paratransit application, a scholarship form, a disability accommodation, an appointment. The agent understands the need, asks where they are, finds the official form for that need and that place, interviews them conversationally, fills the real document, and sends the result by SMS: the filled form, what is still missing, and what to do next. Everything happens on one phone call.

## 2. What is already generic, what is not

The technology was proven on Cedars-Sinai. Most of it never cared which form it was.

| Layer | Status | What is still Cedars-specific |
|---|---|---|
| Voice (Vapi assistant, nine tools, webhook) | generic | nothing — need-first prompt; paratransit call verified live 2026-09-03 |
| Xano (cases, answers, requirements, events, `form_schema`) | generic | `hospitals` table name; seed data |
| Document filler (pdf-lib `local` engine) | generic for `fillable_pdf` | nothing; `flat_pdf` has no overlay engine yet |
| Discovery (SerpApi, allowlist, verification, cache) | generic | nothing — organization-scoped, honest `found=false`; UCSF and Kaiser resolve to their own applications |
| Interview plan | generic for the verified catalog | `lib/voice/form-plan.ts` Cedars plan remains the fixture |
| Answer → field mapping | generic for the verified catalog | Cedars plan remains the fixture |
| Delivery | **built** (SMS via Twilio, signed 72 h document link) | Twilio account is a Trial: only the verified test number receives texts; the trial guard skips others |
| Phone entry | **routed** | +1 (945) 277-2309 imported into Vapi and pointed at the AccessForm assistant (2026-09-03); webhooks still ride a temporary tunnel |

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
| hospital bill | UCSF financial assistance (its own application) | San Francisco | `flat_pdf` — discovered live, delivered, not filled |
| hospital bill | Kaiser Permanente financial assistance (its own application) | California | `flat_pdf` — discovered live, delivered, not filled |

The four `fillable_pdf` rows were verified 2026-09-03 by downloading the PDF and reading its AcroForm field list. Manifest with URLs, hashes and field counts: `spike/catalog.json`. UCSF and Kaiser were resolved by live, organization-scoped discovery the same day and marked `flat_pdf`; until the overlay engine exists they get the PDF plus the checklist described above. A made-up hospital returns `found=false`.

## 6. Generic voice tools

Nine tools are live on the assistant. The original names are kept where the meaning is unchanged; `get_next_question` and `send_summary` were added, `get_case_progress` stays for progress-only reads.

| Tool | Input | Output |
|---|---|---|
| `create_case` | `caller_phone`, `situation_text`, `location` | `case_id` |
| `resolve_need` | `case_id`, `situation_text` | `category`, `organization?`, confidence, one clarifying question if needed |
| `discover_program` | `case_id`, `category`, `organization?`, `location` | verified program + `form_kind` + `application_url`, or `found=false` |
| `get_next_question` | `case_id` | next `field_id`, spoken question, progress |
| `save_answer` | `case_id`, `field_id`, `value` | saved answer, progress |
| `validate_case` | `case_id` | completeness, missing requirements |
| `finalize_document` | `case_id` | signed document URL (72 h HMAC token), accessibility status |
| `send_summary` | `case_id`, `channel=sms` | delivery id (trial-guarded: only the verified test number receives it today) |
| `get_case_progress` | `case_id` | progress and completeness without advancing the interview |

## 7. Data model changes (Xano, additive)

- `organizations` (new): `name`, `kind` (hospital, transit_agency, college, agency), `domain`, `region`. `hospitals` stays as-is until migrated.
- `programs`: add `category`, `form_kind`, `submission_instructions`, `organization_id`.
- `cases`: add `need_category`, `location`, `caller_phone`, `situation_text`, `delivery_status`.
- `form_schema`: already has `conversational_prompt`, `dependency_rule`, `pdf_mapping`; add `section`, `order`.
- `deliveries` (new): `case_id`, `channel`, `to`, `message`, `document_url`, `status`, `provider_id`.

## 8. Milestones

**M1 — product spine (target: 2 days with agents).** Need-first assistant prompt. Generic tools. Parameterized, verified discovery. Form understanding for `fillable_pdf`. LLM answer mapper with the Cedars plan as its fixture. SMS delivery through the Twilio number. One phone number routed to AccessForm. Public deployment so webhooks and SMS links are stable. Catalog: Cedars, LA and SF paratransit, Napa Valley College DSPS — all real, all verified fillable.
*Done when:* "I'm 65 and I need to get to my doctor" with an LA address ends in an SMS containing a filled paratransit application — and the Cedars call still passes unchanged.

**Status 2026-09-03 — M1 verified (commit `75317c5`), with exceptions.** "I'm 65 and I can't walk far" through the live tunnel resolved to Access Services, filled the 146-field application, and Twilio delivered the SMS. Cedars regression holds. UCSF and Kaiser resolve to their own applications as `flat_pdf`; a made-up hospital returns `found=false`. Document links are signed and `/api/document` is token-gated. Exceptions still open: public URL is a temporary trycloudflare tunnel (no stable deployment); Twilio is a Trial account (texts reach only the verified test number); `flat_pdf` is delivered, not filled; call transcripts are not yet persisted; the activity feed mislabeled local-engine events as Nutrient (being fixed); duplicate finalize events are unverified either way and need a re-check.

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
5. **"Approve and send" — pending, not decided.** Proposal: after the person's explicit approval, AccessForm emails the filled application to the program's published intake address. This contradicts the "never submits / never say sent" rule and can only land as a rule change: "sent" may be shown only after (a) an `approval_recorded` event exists for the case and (b) the email provider has confirmed delivery; before both, the wording stays "ready for you to review". Adopting it implies HIPAA/PHI handling obligations and a per-program intake address in `programs.submission_instructions`. Nothing sends until this is decided.

## 12. Verification

Three golden calls, run as fixtures against the live stack before every demo: Cedars hospital bill, LA paratransit, one scholarship. Each must produce a case in Xano, a filled PDF, and a logged SMS delivery. UCSF and Kaiser must resolve to their own applications (marked `flat_pdf`), never to Cedars; a made-up hospital must return `found=false`.

## 13. Frontend: conversation page

Agreed 2026-09-03. Two pages, no dashboards, no admin, no auth.

- `/` — start: headline, the phone number, one **Start a conversation** CTA.
- `/c/<case-id>` — one long conversation page. Left: a history sidebar of this browser's conversations (per browser, `localStorage`, no login). Main column: the transcript is the spine, with inline cards where they happen — location map, search candidates, the form as it fills, what is still missing, the result. `/live` and `/review` stay until this page replaces them, then redirect.

Supporting API: `POST /api/cases` creates a case from the browser; `GET /api/cases/summary?ids=` returns the summaries the history sidebar needs.

Phases:

0. **Ground the demo** — stable deployment replacing the tunnel, Twilio upgrade out of Trial, engine labels honest in the event feed, docs current (this update).
1. **Page shell** — `/c/<case-id>` route, layout, empty and loading states.
2. **Timeline from events** — render the transcript and tool events from Xano live; requires persisted call transcripts.
3. **Search candidates** — the discovery card: candidates, verified source, `found=false` honestly shown.
4. **Result, approve, flat PDF** — result card with signed link and still-missing list; approval recorded as an event (display of "sent" gated on the pending decision in section 11); `flat_pdf` shown as delivered-not-filled.
5. **History** — per-browser sidebar backed by `GET /api/cases/summary?ids=`.
6. **Nearby map** — location card for the organization or intake office.
7. **Retire old pages** — `/live` and `/review` redirect to `/c/<case-id>`.
