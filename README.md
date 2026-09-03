# AccessForm

**Any official form, by phone, for people who can't do paperwork the usual way.**

A person with a disability calls a number. No app, no internet, no screen. They say what's going on in their own words — a hospital bill they can't pay, needing a ride to the doctor, a college accommodation. AccessForm works out the need, finds the **official** form for that need and that place, interviews them one question at a time, fills the **real** PDF, and texts them a link to the filled document with exactly what is still missing. Everything happens on one phone call.

It never submits, never signs, never decides eligibility.

```
"I'm 65 and I can't walk far and I need to get to my doctor."
      │
      ▼  Vapi: the call
resolve_need ──────────► paratransit · "Which city or county do you live in?"
      │  "Los Angeles, 90071"
      ▼  SerpApi + catalog
discover_program ──────► Access Services · ADA Paratransit Application · 146 fields · verified accessla.org
      │
      ▼  Xano: the interview
get_next_question ─────► "What is your last name?" … "What is your date of birth?" …
save_answer ×N
      │
      ▼  pdf-lib (or Nutrient)
finalize_document ─────► the real 10-page application, filled and flattened
      │
      ▼  Twilio
send_summary ──────────► SMS: signed link + "Still needed: Emergency Contact; Medical Professional; Your signature"
```

That transcript is not a mock. It ran end to end on 3 September 2026 against the live services, and the text was delivered.

---

## How each sponsor is used

The product is a pipeline; each sponsor owns one stage and nothing pretends to be another. Everything below was exercised against the live service, not a stub.

### Xano — the system of record and the interview engine

Xano is where truth lives. Every case, every answer, every requirement, every event, and — crucially — **completeness** is computed in Xano and nowhere else. The UI and the voice agent never recompute it; they display what Xano says. That is what makes "26 of 26 fields, one document still missing" trustworthy rather than hardcoded.

Workspace `accessform` (workspace 2), written as XanoScript in [`accessform-xano/`](accessform-xano/) and pushed with the Xano CLI.

| Table | Holds |
|---|---|
| `organizations` | hospitals, transit agencies, colleges, agencies — name, kind, domain, region |
| `programs` | a discovered program: category, `form_kind`, application URL, source domain, `verified`, field count, sha256 |
| `form_schema` | one row per PDF field: type, required, **the spoken question for it**, section, order, dependency rule |
| `cases` | need category, location, caller phone, status, progress, delivery status |
| `answers` | one per field per case, upserted |
| `requirements` | fields, attachments, signatures — `complete` / `missing` |
| `documents` | source and filled PDFs with a literal accessibility status |
| `deliveries` | every SMS, with provider id and status |
| `events` | the audit trail that drives the sponsor feed on screen |

Endpoints the voice tools call (no auth on the demo instance):

| Endpoint | Purpose |
|---|---|
| `POST /cases`, `PUT /cases/{id}`, `GET /cases/{id}` | case lifecycle |
| `GET /programs/resolve?category&location&organization` | catalog lookup — **never returns another organization's program** |
| `POST /programs/catalog` | upsert a verified program by application URL |
| `GET`/`PUT /programs/{id}/form_schema` | the form's fields and questions, cached per program |
| `GET /cases/{id}/next_question` | next unanswered required field in section order, honoring dependency rules |
| `PUT /cases/{id}/answers/{field_id}` | save an answer |
| `POST /cases/{id}/validate` | recompute completeness and the "still missing" list |
| `POST /cases/{id}/documents`, `POST /cases/{id}/deliveries` | record the filled PDF and the text message |

### SerpApi — finding the official form

SerpApi answers the question that makes the product real: *for this need, in this place, what is the current official application, and can we prove it is official?*

Discovery is **catalog-first, then live**. Pre-verified programs resolve from Xano with zero credits. Anything else runs 2–3 queries templated from `{category, organization, location}` — e.g. *"San Diego ADA paratransit eligibility application form pdf"* — then:

1. **Allowlist by authority**, not by name: `.gov`, `.edu`, `hcai.ca.gov`, the organization's own domain, known transit agencies. A hospital name is never hardcoded.
2. **Download the candidate PDF** and count its AcroForm fields with pdf-lib to set `form_kind` (`fillable_pdf`, `flat_pdf`, `online_form`, `in_person`).
3. **An OpenAI verdict** with a strict JSON schema: *is this the official application for this organization in this region?*
4. Persist as a verified program, or return **`found=false` with a reason**.

Rule one of the product: **never substitute**. An early bug served the Cedars-Sinai form to a caller who said "UCSF" and labeled the source verified. Discovery now refuses unless the source is verified for the *exact* organization named. Live proof during verification: a fictional "Northwind Regional Hospital" → `found=false`; "Kaiser Permanente", which nobody pre-verified, → Kaiser's real Medical Financial Assistance application on kaiserpermanente.org, honestly tagged `flat_pdf`.

Results are cached ([`cache/discovered_program.json`](cache/discovered_program.json)) so rehearsals spend nothing; the free plan's 250 searches/month are treated as a budget.

### Nutrient — understanding and building the document

Nutrient's Document Web Services were the first thing proven in this project, on the hardest step: filling a real government PDF.

| API | Endpoint | What we verified |
|---|---|---|
| Processor | `POST /build` — `applyInstantJson` + `flatten` | fills the 101-field Cedars-Sinai application from Instant JSON; `flatten` is required or values render blank |
| Data Extraction | `POST /extraction/parse` | returns page elements with bounds, reading order, confidence |
| Accessibility | `POST /accessibility/autotag` | tags a filled PDF for PDF/UA |
| Viewer | Web SDK, publishable `pdf_pub_live_` key | the review screen |

Each API has its own key and its own fixed path; a key used on the wrong path returns 403 (a bad key returns 401), which is how we learned the model.

The document engine is switchable — [`app/lib/document/engine.ts`](app/lib/document/engine.ts):

- `DOCUMENT_ENGINE=nutrient` — the path above.
- `DOCUMENT_ENGINE=local` (default) — pdf-lib fills and flattens on the server. Built because the evaluation account stamps *"For Evaluation Purposes Only"* on every page and the accessibility API returned 402 once its allowance was spent. The local engine handles character-comb fields (one letter per box, common on transit forms), preserves the source document's structure tree, and reports **`preserved`** — a status that means exactly "no accessibility pass ran; the official document's tagging was kept" and is never described as processing.

Only a real Nutrient autotag run may be described as "accessibility processing complete". Statuses are literal: `processed`, `preserved`, `failed`.

### Vapi — the phone call

One assistant, gpt-4o, Deepgram transcription, nine tools whose webhooks point at this server. The system prompt is need-first: listen, `create_case`, `resolve_need`, ask where they are, `discover_program`, then interview from `get_next_question` one question at a time, repeating answers back, accepting "I don't know". It ends by stating what is still missing and that nothing has been sent. It is forbidden from saying approved, eligible, submitted, or signed.

Provisioning is idempotent: [`scripts/vapi/provision-assistant.mjs`](scripts/vapi/provision-assistant.mjs). The Twilio number `+1 (945) 277-2309` routes to it.

### Twilio — delivery

The result reaches the caller as a text: a signed link to the filled PDF (HMAC token, 72 h), up to three "still needed" items in plain words, one next step, and *"Nothing has been sent to \<organization\>. You decide what to send."* Never the answers themselves. Under 320 characters.

### OpenAI — the judgment steps

Used only where judgment is needed, always with `response_format: json_schema, strict: true`, temperature 0, and enums built from **real extracted data**:

- need classification from free speech
- the official-source verdict in discovery
- writing a spoken question for each PDF field (never the raw label)
- mapping spoken answers onto the form's real field names and radio export values

The model never writes a PDF and never decides completeness.

---

## The catalog

Four real, pre-verified, fillable forms. Every one was downloaded and its AcroForm field list read before it was trusted. Manifest: [`spike/catalog.json`](spike/catalog.json).

| Need | Program | Region | Form |
|---|---|---|---|
| hospital bill | Cedars-Sinai financial assistance (HCAI-hosted) | Los Angeles | 3 pages, 101 fields |
| paratransit | Access Services ADA paratransit application (Spanish twin exists) | LA County | 10 pages, 146 fields |
| paratransit | SF Paratransit ADA application | San Francisco | 10 pages, 168 fields |
| disability accommodation | Napa Valley College DSPS application | Napa | 2 pages, 32 fields |

Live discovery covers everything else, with `form_kind` telling the truth about forms that aren't fillable.

---

## Honesty rules, enforced in code

- Never substitute one organization's form for another.
- Never say approved, eligible, qualified, submitted, sent, filed, or signed.
- Completeness comes only from Xano.
- Accessibility status is literal.
- No fixture data outside demo mode — a failure surfaces as a failure.
- Never ask for SSN or account numbers; those boxes stay for the person.
- SMS carries a link and a checklist, never personal data.

---

## Running it

```bash
cd app && npm install
cp .env.example .env.local     # fill in the keys
npm run dev                    # http://localhost:3000
```

For a real phone or browser call, Vapi's servers must reach your machine:

```bash
cloudflared tunnel --url http://localhost:3000
VAPI_SERVER_URL=https://<your-tunnel>.trycloudflare.com node scripts/vapi/provision-assistant.mjs
```

Set `PUBLIC_BASE_URL` to the same URL so SMS links resolve. `NEXT_PUBLIC_DEMO_MODE=true` runs the whole thing on fixtures with zero network — the demo can't break on stage.

Health check for every key, no credits spent:

```bash
python check_apis.py
```

## Repository map

| Path | What |
|---|---|
| `app/` | Next.js 15 app: `/`, `/live`, `/review`, the voice tool webhook, the document routes |
| `app/lib/contract.ts` + `lib/m1/` | the shared contract every module codes against |
| `app/lib/need`, `discovery`, `forms`, `interview`, `delivery`, `document` | the pipeline stages |
| `accessform-xano/` | Xano tables and endpoints as XanoScript |
| `scripts/vapi/` | assistant definition and idempotent provisioning |
| `clients/`, `check_apis.py` | Python reference clients that first proved each API |
| `spike/` | the verified forms, their field maps, the catalog manifest |
| `docs/PRODUCT_PLAN.md`, `docs/M1_CONTRACT.md` | the product plan and the M1 contract |
| `accessform_claude_pack/` | the original build pack and specs |

Built at a hackathon with Claude Code orchestrating parallel agents against a written contract, with every integration verified live before it was trusted.
