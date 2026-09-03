# API Integration Plan

## 1. SerpApi — official-source discovery
Purpose: live discovery, not generic web search decoration.

Input from voice/NLU:
- hospital = Cedars-Sinai
- intent = financial assistance
- location = California

Suggested search queries:
- `Cedars-Sinai financial assistance application`
- `Cedars-Sinai charity care application HCAI`
- `site:hcai.ca.gov Cedars-Sinai financial assistance`

Source allowlist/preference:
1. `hcai.ca.gov`
2. `api.hdc.hcai.ca.gov`
3. `cedars-sinai.org`

Persist in Xano:
- result URL;
- title;
- source domain;
- retrieved_at;
- effective date if discoverable;
- source verification status.

Hardcoded demo fallback:
- HCAI hospital page: https://hcai.ca.gov/affordability/hospital-billing-policies/cedars-sinai-medical-center/
- HCAI application PDF: https://api.hdc.hcai.ca.gov/Public/Extract/Attachment?id=1b7ee017-9db0-4a44-b3dc-a39c5986f24e

## 2. Xano — orchestration/system of record

VERIFIED 2026-09-03. Use Xano **workspace 2 (`accessform`)**. Workspace 1
("ALI's Workspace") is an unrelated retail rescue-engine project - do not write
to it. The eight tables below are defined as XanoScript in
`../../accessform-xano/table/` and have been pushed to the workspace 2 sandbox.

Direct CLI push is disabled on this instance, so schema changes go:
`xano sandbox push` -> `xano sandbox review` -> promote in the browser.

Tables/objects required:
- hospitals
- programs
- cases
- form_schema
- answers
- requirements
- documents
- events

Minimum endpoints to expose:
- POST `/cases`
- GET `/cases/:id`
- POST `/cases/:id/events`
- PUT `/cases/:id/answers/:fieldId`
- GET `/cases/:id/progress`
- POST `/cases/:id/validate`
- POST `/programs/discovered`

The UI should not directly recompute authoritative completeness if Xano can do it. Xano should return the next missing requirement/state.

## 3. Nutrient - document layer

VERIFIED 2026-09-02 against the live account. The four DWS products do NOT share
one key and the endpoints are not configurable. Each key is scoped to one path;
using it on another path returns 403 (a wrong key returns 401, so the two are
distinguishable).

| Product | Env var | Endpoint | Verified |
|---|---|---|---|
| Processor | `NUTRIENT_DWS_PROCESSOR_API` | `POST /build` | HTML->PDF, 14 KB out |
| Data Extraction | `NUTRIENT_DATA_EXTRACTION_API` | `POST /extraction/parse` | elements + bounds returned |
| Accessibility | `NUTRIENT_ACCESSIBILITY_API` | `POST /accessibility/autotag` | tagged PDF, 1.4 -> 1.7 |
| Viewer | `NEXT_PUBLIC_NUTRIENT_VIEWER_KEY` | browser SDK | `pdf_pub_live_` publishable |

Base URL is `https://api.nutrient.io` for all three server-side products. Do not
introduce `NUTRIENT_PROCESSOR_URL` / `_EXTRACTION_URL` / `_ACCESSIBILITY_URL`
env vars - there is nothing to configure.

Extraction has two paths. `/extraction/parse` is confirmed working and returns
spatial elements with bounding boxes, reading order and confidence.
`/extraction/extract` does schema-driven typed field extraction and expects a
different request shape - it rejected a multipart `schema` field, so treat it as
unproven until someone confirms the payload.

Recommended sequence:
1. Give Nutrient the official application PDF.
2. Extract structure/fields/instructions via `/extraction/parse`.
3. Normalize extracted fields into the Xano `form_schema`.
4. After voice collection, map Xano answers back to PDF fields/coordinates.
5. Fill the PDF via `/build`.
6. Run `/accessibility/autotag`.
7. Store generated-document URL/status in Xano.
8. Load result into Viewer on `/review`.

OPEN RISK: filling an existing AcroForm through `/build` is not yet proven.
HTML->PDF is. This is the highest-risk step in the slice - prove it first.

If automatic field extraction is insufficient, hardcode only the Cedars field
mapping as a fallback. The demo must work even if extraction is imperfect.

## 4. Voice
Fastest recommended provider: Vapi.

Required tools/functions exposed to voice agent:
- `create_case`
- `discover_program`
- `save_answer`
- `get_case_progress`
- `validate_case`
- `finalize_document`

Voice agent policy:
- Ask one clear question at a time.
- Do not read the PDF field labels mechanically.
- Explain why sensitive information is requested when appropriate.
- Allow “I don't know” / “not now.”
- Never claim approval.
- Before ending, state exactly what remains.

## Environment variables
See `starter/.env.example`.
