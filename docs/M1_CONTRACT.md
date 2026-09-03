# AccessForm — M1 Contract

*Binding for every M1 builder. Types: `app/lib/m1/contract.ts` (re-exported from `app/lib/contract.ts`, so `import { … } from '../contract'` keeps working). This document is the behavioural spec; the TypeScript file is the shape spec. Where they disagree, the `.ts` wins for shapes and this file wins for behaviour. Nothing here weakens the non-negotiables in `accessform_claude_pack/CLAUDE.md` and `docs/PRODUCT_PLAN.md` §9.*

Reading order for a builder: §0 (rules), the section for your module, §4 (tools) if you touch voice, §5 (Xano) if you read or write the system of record, §10 (what changed in the base contract).

---

## 0. Rules that apply to every module

1. **Never substitute.** `found: true` means a verified official source for the *exact* organization the caller named (or, when they named none, the official authority for that category in that region). Any doubt → `found: false` + `reason`. Never fall back to Cedars for a non-Cedars caller. `organizationMatches()` in `lib/voice/tool-handlers.ts` is the existing token test; reuse it.
2. **Never claim** approved / eligible / qualified / accepted / submitted / sent (of the application) / filed / signed. Allowed: "may qualify", "appears complete based on the published requirements", "ready for you to review", "a text is on its way".
3. **Completeness comes from Xano.** `percent`, `sections`, `done`, `still_required` are read from Xano responses and never recomputed in TypeScript. The one exception: the fixture store in demo mode.
4. **Accessibility status is literal.** `preserved` is what the local engine produces. Copy for it says "tagging preserved", never "processed".
5. **No fixtures outside demo mode.** `NEXT_PUBLIC_DEMO_MODE=false` (current). A failing service surfaces as a failure result (`ok: false`, `found: false`, `status: 'failed'`), not as Jane's data.
6. **Never ask for identifiers.** `FORBIDDEN_FIELD_PATTERNS` (SSN, account, passport, license, Medicare/Medi-Cal numbers). `understandForm()` marks such fields `required: false` with `conversational_prompt: ""`; `nextQuestion()` skips them; `mapAnswers()` never emits them.
7. **OpenAI usage.** Server-side only, `fetch` to `OPENAI_CHAT_COMPLETIONS_URL`, model `OPENAI_JUDGMENT_MODEL` (`gpt-4o`) or `OPENAI_CLASSIFIER_MODEL` (`gpt-4o-mini`), `temperature: 0`, and **always** `response_format: { type: 'json_schema', json_schema: { strict: true, … } }`. Every `enum` in a schema is built from real data at call time (real `pdf_field_name`s, real `options`, `NEED_CATEGORIES`). The model never outputs a PDF field name that is not in the extracted list — if the schema cannot enforce it, post-filter and count it in `unmapped`.
8. **SerpApi budget.** `SERPAPI_RUN_BUDGET = 12` live searches for the whole run, all agents combined. Catalog first, always. A live search happens only when the catalog has no verified program for `{category, organization|location}`.
9. **Xano quirks.** Text columns return `""`, never `null` (map `""` → `null` for `| null` fields in TS; send `""` not `null` on writes). Timestamps are epoch **milliseconds**; convert to ISO at the adapter. Ids are numbers on the wire; stringify at the adapter. Enums are validated server-side: adding a value means editing the table `.xs` **and** every endpoint input `.xs`. Case endpoints accept either the numeric id or `external_ref` in `{id}`. Validate with `xano_validate_xanoscript` before every push; `xano workspace push --dry-run` then `--force`; never `--delete`; never call `POST /demo/seed`.
10. **File ownership is strict.** If you need a change in a file you don't own, code against this contract and put the exact change in your `blockers`.

---

## 1. Enums

| Type | Values | Notes |
|---|---|---|
| `NeedCategory` | `hospital_financial_assistance`, `paratransit`, `disability_accommodation`, `scholarship_financial_aid`, `benefits`, `appointment`, `other` | `NEED_CATEGORIES` tuple; `NEED_CATEGORY_LABELS` spoken labels. |
| `FormKind` | `fillable_pdf`, `flat_pdf`, `online_form`, `in_person` | M1 fills only `fillable_pdf`. Others: see §8 "non-PDF kinds". |
| `OrganizationKind` | `hospital`, `transit_agency`, `college`, `agency`, `other` | |
| `CaseDeliveryStatus` | `none`, `queued`, `sent`, `failed` | on `cases.delivery_status` |
| `DeliveryStatus` | `queued`, `sent`, `failed`, `skipped` | on `deliveries.status` |
| `DeliveryChannel` | `sms` | |

Xano enum edits required (Xano builder): `cases.need_category`, `cases.delivery_status`, `programs.category`, `programs.form_kind`, `organizations.kind`, `deliveries.channel`, `deliveries.status` — and **`form_schema.type` must gain `checkbox` and `radio`** (the TS `FormFieldType` has them; the live table has `bool` instead). Keep `bool` for old rows.

---

## 2. Row types

### `Organization` (new table `organizations`)
`id, name (unique, upsert key), kind, domain (lowercase registrable domain, no www), region, website, created_at`. `hospitals` stays; Cedars gets an `organizations` row too (`kind: hospital`, `domain: cedars-sinai.org`).

### `Program` — base interface gains **optional** M1 columns; `ResolvedProgram = Program & ProgramM1Columns` has them **required**
Added: `category`, `form_kind`, `organization_id`, `submission_instructions`, `field_count`, `region`, `page_count`, `sha256`. Already present and unchanged: `source_domain`, `verified`, `retrieved_at`, `application_url`, `policy_url`, `hospital_id` (→ Xano builder makes `hospital_id` optional on the table; catalog rows for non-hospitals leave it null → normalizes to `""`/`"0"`; treat `hospital_id === ''` as absent).

Every M1 module returns `ResolvedProgram`. Pre-M1 code (`normalizeProgram`, `DEMO_PROGRAM`) keeps compiling because the base fields are optional.

### `FormSchemaField` — base gains **optional** `section`, `order`, `options`, `pdf_field_name`; `M1FormSchemaField` has them **required**
- `field_id` stays the exact AcroForm name (unchanged; it is the `save_answer` key and the `answers.field_id` unique index).
- `pdf_field_name` = `field_id` for fillable PDFs (kept separate so `flat_pdf` can later map a spoken field to a coordinate box).
- `options` = button export values **without** the leading `/` (`"/Single"` → `"Single"`). The local engine accepts either, but the mapper's JSON-schema enum uses the slash-less form.
- `section` is the grouping key. For Cedars it MUST equal the existing `group_key` values (`personal_information`, `household_information`, `insurance_information`, `income_information`, `monthly_expenses`) so `POST /validate` and the regression keep scoring the same. Xano reads `section`, falling back to `group_key` when `section == ""`.
- `order` is 1-based, unique per program, across all sections.
- `dependency_rule` on the wire is `""` for none (Xano text); TS keeps `string | null`.

### `Case` — base gains **optional** `need_category`, `location`, `caller_phone`, `situation_text`, `delivery_status`, `organization_id`
`caller_phone` is E.164 or `""`. It is never spoken back in full; masks are last-4 only.

### `Delivery` (new table `deliveries`)
`id, case_id, channel, to, message, document_url, status, provider_id ("" until sent), error ("" unless failed), created_at`.

### `CaseBundle` — gains optional `organization?: Organization | null` and `deliveries?: Delivery[]`.

### Judgment results
- `NeedResolution { category, organization?, location?, confidence (0..1), clarifying_question? }`. If `confidence < NEED_CONFIDENCE_FLOOR (0.6)` then `clarifying_question` MUST be present and the tool tells the agent to ask it before `discover_program`.
- `ProgramResolution { found, program?, reason?, candidates?, searches_used?, from_catalog? }`. Invariant: `found === true` ⇒ `program` present, `program.verified === true`, `program.application_url` absolute `https://`, organization matches the request.
- `NextQuestion { field_id, prompt, section, progress: InterviewProgress, type?, options?, required?, why? }`.
- `InterviewProgress { answered, total, percent, section_index, section_count, sections: InterviewSection[] }` — all from Xano.
- `MappedAnswers { values: MappedValue[] ({pdf_field_name, value}), unmapped: string[] }`.

---

## 3. Binding module interfaces

Paths are relative to `app/`. Function names and signatures are exact. Each module is server-only, imports types from `'../contract'` (or `'@/lib/contract'`), and never imports another builder's module except through these signatures.

### 3.1 `lib/need/resolve-need.ts`
```ts
export async function resolveNeed(input: { situation_text: string; location?: string }): Promise<NeedResolution>
```
- `gpt-4o-mini`, strict JSON schema: `category` enum = `NEED_CATEGORIES`; `organization` string (nullable); `location` string (nullable); `confidence` number; `clarifying_question` string (nullable).
- Deterministic pre-pass (no model call) for obvious phrases is allowed but must produce the same shape.
- `organization` is only what the caller **named**. Never infer one ("hospital in LA" is not Cedars).
- On OpenAI failure: return `{ category: 'other', confidence: 0, clarifying_question: 'Could you tell me a little more about what you need help with?' }`. Never throw across the tool boundary.

### 3.2 `lib/discovery/resolve-program.ts`
```ts
export async function resolveProgram(input: { category: NeedCategory; organization?: string; location?: string; case_id?: string }): Promise<ProgramResolution>
```
Order, stop at the first hit:
1. **Catalog (Xano)** — `GET /programs/resolve?category=&location=&organization=`. If `found` and (`organization` absent or `organizationMatches(input.organization, program.organization name)`), return `{ found: true, program, from_catalog: true, searches_used: 0 }`.
2. **Live SerpApi** (only when budget allows): queries templated from `{category, organization, location}` — never literal strings. Allowlist = `OFFICIAL_TLD_SUFFIXES` (`.gov`, `.edu`) ∪ the organization's own domain (from `organizations.domain` if known, else the registrable domain of the organization's homepage found in the same search) ∪ known authority registries per category (HCAI for hospital financial assistance). A `.com`/`.org` is allowed **only** when it is the named organization's own domain.
3. **OpenAI verdict** (`gpt-4o`, strict schema): for the top ≤5 allowlisted candidates, `{ is_official_application: boolean, organization_matches: boolean, form_kind: enum FORM_KINDS, reason }`. Enum for `url` = the candidate URLs. Accept only `is_official_application && organization_matches`.
4. **Verify the bytes** for `fillable_pdf`: fetch, confirm `%PDF`, count AcroForm fields with pdf-lib, set `field_count`, `page_count`, `sha256` (first 16 hex). Zero fields ⇒ `form_kind: 'flat_pdf'`.
5. Persist via `POST /programs/catalog` (and `POST /organizations`), then return `{ found: true, program, from_catalog: false, searches_used }`.
- Anything else ⇒ `{ found: false, reason, candidates, searches_used }`. `reason` is a sentence the agent can say: "I could not verify an official form for UCSF Medical Center."
- When `case_id` is given: on success link the case (`POST /programs/discovered` with `case_id`, or the new catalog endpoint's `case_id`), write `program_discovered` and `source_verified` events; on failure write `source_not_verified`.
- Never return `found: true` from a fixture when demo mode is off.

### 3.3 `lib/forms/understand-form.ts`
```ts
export async function understandForm(input: { program_id: string; pdf_url: string }): Promise<FormSchemaField[]>
```
- Idempotent and cached: `GET /programs/{id}/form_schema?required_only=false`; if `count > 0` and the program's `sha256` matches the fetched PDF's, return the rows. Else rebuild and `PUT /programs/{id}/form_schema`.
- Extraction: pdf-lib `getForm().getFields()` → `{ field_id, type: 'text'|'button'|'choice'|'signature', states[] }` (same shape as `spike/cedars_form_fields.json`; strip `/` from states; use `PdfFormFieldDescriptor`).
- Understanding (`gpt-4o`, strict schema, one call per ≤60 fields): input is the field list plus the PDF's page text (pdf-lib cannot extract text; use `pdfjs-dist` or pass just the field names and neighbouring field names). Output per field: `normalized_key`, `label`, `type` (enum `FormFieldType`), `required`, `section` (snake_case), `order`, `conversational_prompt`, `why` (may be `""`), `dependency_rule` (`""` or `"<normalized_key> == '<option>'"`). The `field_id` enum in the schema is the extracted list — the model cannot add fields.
- Post-rules: forbidden identifiers → `required: false`, prompt `""`; signature fields → `type: 'signature'`, `required: false` (never asked); `options` = states; `pdf_field_name = field_id`; `pdf_mapping = field_id`; `group_key = section`. `order` renumbered 1..n in section order after the model returns.
- Returned rows satisfy `M1FormSchemaField`.
- Cedars regression: for `DEMO_PROGRAM_ID` / the live Cedars program, the 26 fields in `lib/voice/form-plan.ts` MUST come out `required: true` with their existing `section` (= `group_key`) values; other Cedars fields `required: false`. Implement this as a validation assertion in your test, not as a hardcoded override in product code.

### 3.4 `lib/forms/map-answers.ts`
```ts
export async function mapAnswers(input: { schema: FormSchemaField[]; answers: Answer[] }): Promise<MappedAnswers>
```
- Direct pass for every answer whose `field_id` exactly matches a schema `field_id` (or `normalized_key`) and whose field has no `options`: `value = String(value_json)`; currency without `$`.
- Option fields: if `value` matches an option case-insensitively, take the option verbatim; otherwise send **that field only** to `gpt-4o` with a strict schema whose `value` enum = the field's `options` (plus `""` for "no match").
- Free-text answers with no direct match (e.g. the agent saved under a normalized key not in the schema): one `gpt-4o` call with `pdf_field_name` enum = all schema `pdf_field_name`s. Post-filter anything not in the list into `unmapped`.
- Never emit a `pdf_field_name` for a forbidden field or a `signature` field. Never emit two values for one field (last write wins, by `Answer.updated_at`).
- Output `values` are what `fillAndFlatten()` receives as Instant JSON `formFieldValues` (`{ name: pdf_field_name, type: 'pspdfkit/form-field-value', v: 1, value }`).
- Fixture: `DEMO_ANSWERS` + `interviewPlanAsFormSchema()` must map 26/26 with `unmapped: []`.

### 3.5 `lib/delivery/sms.ts`
```ts
export async function sendSummary(input: { case_id: string; to: string; document_url: string; missing: Requirement[]; next_steps: string }): Promise<Delivery>
export function buildSummaryMessage(input: { document_url: string; missing: Requirement[]; next_steps: string }): string
```
- `buildSummaryMessage` is pure and deterministic; see §8 for the template. Output length ≤ `SMS_MAX_CHARS` (320). Truncate `next_steps` first, then drop the missing line to `"+N more"`, never touch the link line.
- `sendSummary`: write `POST /cases/{id}/deliveries` with `status: 'queued'` → Twilio `POST /2010-04-01/Accounts/{sid}/Messages.json` with API key SID/secret basic auth, `From` = env `TWILIO_FROM_NUMBER` (add to `.env.local`: `+19452772309`; do not hardcode) → record the outcome with a second `POST /cases/{id}/deliveries` carrying `status: 'sent'` + `provider_id` (the Twilio SID) or `status: 'failed'` + `error`. Simplest correct implementation: write the `queued` row, call Twilio, then write the final row; the endpoint edits in place when `provider_id` matches an existing row and inserts otherwise, so a failed attempt (no SID) is a second row — that is fine, the history is the point. The endpoint sets `cases.delivery_status`.
- **Trial-account guard:** if `to !== TWILIO_TEST_MOBILE` (env) the send is `skipped` with `error: 'trial account: only the verified test number may receive SMS'`. The tool result says so plainly; the agent must not say a text was sent.
- `document_url` must be absolute: `${PUBLIC_BASE_URL}/api/document/{case_id}` (or whatever `finalize_document` returned, if already absolute). `PUBLIC_BASE_URL` is the one new env var M1 adds (`PUBLIC_BASE_URL_ENV`).
- Demo mode: no Twilio call; row `skipped`.

### 3.6 `lib/interview/next-question.ts`
```ts
export async function nextQuestion(case_id: string): Promise<NextQuestion | null>
```
- Thin: `GET /cases/{id}/next_question` → `question` (or `null` when `done`). No local computation of what is next; Xano orders by `section`-group then `order`, skips answered (non-blank) fields, skips `required: false`, evaluates `dependency_rule` (`"<normalized_key> == '<value>'"` against saved answers; unknown rule ⇒ ask).
- Fallback when Xano is unreachable **in demo mode only**: walk `interviewPlanAsFormSchema()` against the fixture store. Live mode: throw; the tool handler converts to `ok: false`.

---

## 4. The eight voice tools

Names are exact (`M1_VOICE_TOOL_NAMES`). JSON schemas are `M1_VOICE_TOOL_SCHEMAS`; the Vapi provisioning script must emit them verbatim (the `enum` on `discover_program.category` is `NEED_CATEGORIES`; `save_answer.field_id` has **no** enum any more — it is validated server-side against the case's `form_schema`). Route stays `POST /api/voice/tools`. Results are compact objects (never a whole bundle). Failures are `{ ok: false, result: { error: <sentence the agent can say> } }` — never a throw.

| Tool | Input | Result | Server behaviour |
|---|---|---|---|
| `create_case` | `caller_phone?`, `situation_text`, `location?` | `CreateCaseToolResult {case_id, status, note}` | `POST /cases` (`CreateCaseM1Request`). `patient_display_name` defaults `"Caller"`. Event `case_created`. No organization required any more. |
| `resolve_need` | `case_id`, `situation_text` | `ResolveNeedToolResult` (= `NeedResolution` + `case_id`, `category_label`) | `resolveNeed()`; writes `cases.need_category`, `situation_text`, `location` through `PUT /cases/{id}` (§5). Event `need_resolved` with `{category, confidence}` (never the situation text). If `confidence < 0.6` the `note` tells the agent to ask `clarifying_question` and call again. |
| `discover_program` | `case_id`, `category`, `organization?`, `location` | `DiscoverProgramToolResult` | `resolveProgram()`. On `found`: `understandForm()` (so the schema exists before the first question), link program to case, `note: 'Official source verified. Say you found the current official form.'` On `!found`: `note` = the existing "do not continue the interview" instruction from `tool-handlers.ts`. |
| `get_next_question` | `case_id` | `GetNextQuestionToolResult {done, question, progress}` | `nextQuestion()`; `progress` from the same Xano response. |
| `save_answer` | `case_id`, `field_id`, `value` | `SaveAnswerToolResult {saved, field_id, value, next}` | Validate `field_id` against the case's program `form_schema` (exact `field_id` or `normalized_key`); unknown ⇒ `ok: false` "that is not a question on this form". `PUT /cases/{id}/answers/{field_id}`; event `answer_saved` with the section label. `next` = what `get_next_question` returns now. |
| `validate_case` | `case_id` | `ValidateCaseToolResult` | Unchanged semantics (`POST /cases/{id}/validate`). `still_required` = labels of `missing`. |
| `finalize_document` | `case_id` | `FinalizeDocumentToolResult` | `GET /programs/{id}/form_schema` + answers → `mapAnswers()` → Instant JSON → `fillAndFlatten()` (local engine default) → `processAccessibility()` → `POST /cases/{id}/documents` with the literal status → `document_url` absolute (`PUBLIC_BASE_URL`). `note: SAFE_COPY.notSubmitted` generalized ("Not submitted. The organization decides."). Never the Jane fixture PDF unless demo mode. |
| `send_summary` | `case_id`, `channel='sms'`, `to?` | `SendSummaryToolResult {delivery_id, status, to_masked, note}` | `to` = arg or `cases.caller_phone`; none ⇒ `ok: false` "I don't have a number to text". `missing` from `validate_case`; `next_steps` = `program.submission_instructions` or a generic sentence. `note` reflects `status` honestly (`sent` → "a text is on its way"; `skipped`/`failed` → "I could not send the text; the review link is …"). Event `summary_sent` / `summary_failed`. |
| `get_case_progress` | `case_id` | same as `get_next_question` | Alias. `TOOL_ACTIVITY_LABELS` gets entries for all nine names. |

Order the assistant follows: `create_case` → `resolve_need` (loop on clarifying question) → `discover_program` → (`get_next_question` → `save_answer`)* → `validate_case` → `finalize_document` → `send_summary` (with permission) → end. The assistant prompt describes the **product**, not a hospital; the first message is need-agnostic.

Voice-layer owner: `VAPI_TOOL_NAMES`/`VapiToolName` in `lib/contract.ts` are untouched (closed Record keys elsewhere). Migrate `tool-names.ts`, `tool-handlers.ts`, `api/voice/tools/route.ts`, `vapi-web.ts` and `LiveClient.tsx` to `M1VoiceToolName` / `M1_VOICE_TOOL_NAMES`; `VoiceToolCall.name` may be widened to `VapiToolName | M1VoiceToolName` in your files by casting at the boundary.

---

## 5. Xano endpoint contracts

Base: `XANO_BASE_URL` (`…/api:accessform`), no auth. All `{id}` case parameters accept numeric id or `external_ref`. All responses use the table column names (snake_case) except the pre-existing `progress`/`validate` camelCase responses, which stay.

### New tables
```
organizations: id, created_at, name (text, unique btree), kind (enum), domain (text), region (text), website (text)
deliveries:    id, created_at, case_id (→cases), channel (enum sms), to (text), message (text),
               document_url (text), status (enum queued|sent|failed|skipped), provider_id (text), error (text)
```
### Added columns
```
cases:       need_category (enum NEED_CATEGORIES, default "other"), location (text), caller_phone (text),
             situation_text (text), delivery_status (enum none|queued|sent|failed, default "none"),
             organization_id (int? → organizations)
programs:    category (enum, default "hospital_financial_assistance"), form_kind (enum, default "fillable_pdf"),
             organization_id (int? → organizations), submission_instructions (text), field_count (int, 0),
             region (text), page_count (int, 0), sha256 (text); hospital_id becomes optional (int hospital_id?)
form_schema: section (text), order (int, 0), options (json, default []), pdf_field_name (text);
             type enum += "checkbox", "radio"
```
Existing Cedars rows: backfill `section = group_key`, `pdf_field_name = field_id`, `order` = current `id` order, `programs.category = hospital_financial_assistance`, `form_kind = fillable_pdf`, `field_count = 101`. Do this in the endpoint stacks that read them (fallback when `""`), not with a seed run.

### `POST /organizations` — upsert by `name`
Req `UpsertOrganizationRequest { name, kind, domain, region?, website? }` → Res `Organization`.

### `POST /programs/catalog` — upsert by `application_url`
Req `UpsertCatalogProgramRequest` (see .ts). Resolves/creates the organization by `organization_name` (kind, domain), then upserts `programs` on exact `application_url`. `verified` is **recomputed** server-side: true iff `source_domain` ends with `.gov`/`.edu` or equals `organization_domain`, AND the request said `verified: true`. Res `ResolvedProgram` (with `organization_id`). Optional `case_id` links the case exactly like `POST /programs/discovered` does (status `FORM_FOUND`, source document row, events).

### `GET /programs/resolve?category=&location=&organization=`
- `category` required. Filter `programs.verified == true && category == $category`.
- If `organization` given: keep rows whose organization `name` token-matches (Xano: lowercase `contains` on the distinctive token; the TS caller re-checks with `organizationMatches()`), else `found: false, reason: "no verified program for that organization"` — **never** return a different organization's row as `program`.
- Else if `location` given: prefer rows whose `region` shares a token with `location` (e.g. "Los Angeles" ↔ "Los Angeles County, CA"; "San Francisco"); ties → newest `retrieved_at`.
- Else: `found: false`, `alternatives` = all verified rows in the category.
- Res `ResolveProgramResponse { found, program, organization, alternatives, reason }`.

### `GET /programs/{id}/form_schema?required_only=true`
Same stack as the existing `GET /programs/{id}/fields` (keep that path as an alias — `lib/adapters/xano.ts` already calls `/form_schema`). Sort by `section` order of first appearance then `order` asc then `id`. Res `GetFormSchemaResponse { program_id, application_url, count, fields: M1FormSchemaField[] }`. Empty `fields` is `[]`, and `count: 0` (never 404).

### `PUT /programs/{id}/form_schema` — bulk replace
Req `ReplaceFormSchemaRequest { fields: FormSchemaWriteRow[] }`. Deletes every `form_schema` row for the program, inserts the given rows (`program_id` from the path), returns `ReplaceFormSchemaResponse { program_id, count, fields }`. Rejects (400) when `fields` is empty, when two rows share `field_id`, or when `type` is not in the enum. Updates `programs.field_count` to the count.

### `GET /cases/{id}/next_question`
Res `NextQuestionResponse { case_id, status, done, question, progress }`.
- Candidate rows: `form_schema` for the case's program, `required == true`, ordered as above.
- Answered = `answers.value_json` non-null and non-blank after `to_text|trim`.
- Skip when `dependency_rule != ""` and it evaluates false against answers (`normalized_key == 'value'` only; anything unparsable ⇒ ask).
- `question` = first unanswered `{ field_id, prompt: conversational_prompt, section, type, options, required: true, why: "" , progress }`; `done = question == null`.
- `progress.sections[]` one per distinct section (order of first appearance): `{ key, label (Title-cased key, or the `label` of the group when it is one of the five Cedars groups), order, field_count, answered_count, state }` with `state` `done` when `answered_count == field_count`, `active` for the first not-done section, `todo` otherwise. `percent` = the same formula as `GET /cases/{id}/progress` (50% fields + 50% requirements) so the two never disagree; `section_index` = index of the active section or `section_count` when done.
- No writes. `GET /cases/{id}/progress` additionally returns `sections` (same array) and keeps `steps` derived per §9.

### `POST /cases/{id}/deliveries`
Req `CreateDeliveryRequest { channel, to, message, document_url, status, provider_id?, error? }`. Insert; when `provider_id` is given and a row with that `provider_id` exists for the case, edit it instead. Sets `cases.delivery_status` from `status`: `queued`→`queued`, `sent`→`sent`, `failed`→`failed`, `skipped`→`none`. Event `summary_sent` (`status == sent`) or `summary_failed` (otherwise) with `{ delivery_id, status, to_masked }` — never the full number or the message body in `metadata_json`. Res `Delivery`.

### `PUT /cases/{id}` (new, small)
Optional inputs `need_category, location, caller_phone, situation_text, delivery_status, organization_id, program_id, status`; edits only the provided ones; Res the case row. Used by `resolve_need` and by tests.

### `POST /cases` (widened)
Adds optional `situation_text, caller_phone, location, need_category`. `patient_display_name` optional (default `"Caller"`), `hospital_name` optional (**no default any more** — a case with no organization is normal now; do not auto-attach Cedars when `hospital_name` is absent). `GET /cases/{id}` adds `organization` and `deliveries` to the bundle.

---

## 6. Catalog seed

Source: `spike/catalog.json` (`CATALOG_MANIFEST_PATH`), entries typed as `CatalogEntry`. Seeding = for each entry with `verified: true` **and** an absolute `https://` `application_url`: `POST /organizations { name: organization, kind, domain: source_domain, region }` then `POST /programs/catalog` with:

```
organization_name = organization        name = program
organization_kind = kind                category = need
organization_domain = source_domain     form_kind = form_kind
application_url, policy_url, source_domain, region
field_count, page_count = pages, sha256
submission_instructions = CATALOG_SUBMISSION_INSTRUCTIONS[source_domain] ?? ""
verified = true, retrieved_at = verified_at + "T00:00:00.000Z"
```
The seed lives in a script (`scripts/catalog/seed.mjs` or `app/scripts/…`, catalog builder's choice), is idempotent (upsert keys), and is **not** an HTTP endpoint the assistant can reach. The Napa Valley College entry has a placeholder `application_url` (`"(from napavalley.edu DSPS page)"`): it is **not seedable** until the real `napavalley.edu` PDF URL is recorded in `catalog.json` (budget: 1 SerpApi search, or a direct fetch of the policy page). Until then it is skipped with a console warning, never inserted with a fake URL. The Cedars entry upserts onto the live Cedars program (same `application_url`) — it must not create a second Cedars program row.

---

## 7. SMS message

Plain text, ≤ 320 chars, built by `buildSummaryMessage()` from `SMS_TEMPLATE`:
```
AccessForm: your form is ready to review: {document_url}
Still needed: {label 1}; {label 2}; {label 3}; +{n} more
Next: {next_steps}
Not submitted. You decide what to send.
```
- Line 2 omitted when nothing is missing. At most `SMS_MAX_MISSING_ITEMS` (3) labels; extra count as `+N more`.
- No name, no amounts, no answers, no phone number, no organization-specific claims of outcome. `next_steps` is one sentence (the program's `submission_instructions`), truncated with `…` to fit.
- The link is `PUBLIC_BASE_URL + /review?case=<id>` **or** the document URL — pick the review page (it shows the PDF and the checklist) unless the case has no review page; either way absolute.
- Example (Jane): `AccessForm: your form is ready to review: https://phd-handy-hose-org.trycloudflare.com/review?case=1\nStill needed: Proof of Social Security income; Signature of person applying for financial assistance\nNext: Sign the printed application and return it to the Cedars-Sinai Patient Financial Services office with proof of income.\nNot submitted. You decide what to send.` (289 chars).

**Non-PDF kinds** (`flat_pdf`, `online_form`, `in_person`) in M1: `finalize_document` returns the official `application_url` as `document_url` with `accessibility_status: 'not_applicable'` and `fields_filled: 0`; the SMS still goes out with the link and the "Still needed" list being every required field the caller answered (so they have the checklist). The agent says plainly that this form cannot be filled automatically yet.

---

## 8. UI progress model

- Source of truth: `InterviewProgress.sections` (from `GET /cases/{id}/next_question` or the `sections` array on `GET /cases/{id}/progress`). Sections are the form's own, ordered, with `field_count/answered_count/state`.
- `/live` renders: `Program found` → `Current form` → one row per section → `Documents` → `Review`. For Cedars that is the five groups (6 rows collapse to the old look only if the UI chooses to merge `income_information` + `monthly_expenses`; not required).
- `CaseProgress.steps` (always 8, `PROGRESS_STEP_IDS` order) is **derived** for compatibility — by Xano in `GET /cases/{id}/progress` and by `normalizeProgress()` when only `sections` are present — using `LEGACY_STEP_SECTION_ALIASES`: a legacy step is `done` when all matching sections are done, `active` when any matching section is active, and when no section matches it mirrors the interview as a whole (`done` when `answered == total`, `active` while the interview is running, `todo` before it starts). `program_found`, `current_form`, `documents`, `review` keep their existing rules.
- `answersSaved/answersExpected` = `progress.answered/total`. `percent` is Xano's.
- Demo mode continues to serve `DEMO_PROGRESS_*` unchanged (they carry no `sections`; the UI must handle `sections === undefined` by rendering the 8 steps).

---

## 9. Environment

Unchanged secrets in `app/.env.local`. M1 adds exactly two non-secret vars: `PUBLIC_BASE_URL=https://phd-handy-hose-org.trycloudflare.com` and `TWILIO_FROM_NUMBER=+19452772309`. `NEXT_PUBLIC_DEMO_MODE=false`; `DOCUMENT_ENGINE` unset (local).

---

## 10. What changed in `app/lib/contract.ts` (base) — all additive

- `export * from './m1/contract'` plus type-only imports for the new names used below.
- `Program`: optional `category, form_kind, organization_id, submission_instructions, field_count, region, page_count, sha256`.
- `Case`: optional `need_category, location, caller_phone, situation_text, delivery_status, organization_id`.
- `FormSchemaField`: optional `section, order, options, pdf_field_name`.
- `CaseBundle`: optional `organization, deliveries`.
- `CaseProgress`: optional `sections`; doc on `steps` says derived.
- `VAPI_TOOL_NAMES` doc comment marks it as the legacy six; value unchanged.
- Every previous export is intact. `npx tsc --noEmit` clean at the time of writing.

## 11. Verification checklist (for the Verify agent)
1. `npx tsc --noEmit` in `app/` clean.
2. Live Xano case 1 (Jane): `GET /cases/1/next_question` → `done: true`, `progress.sections` = 5 Cedars groups all `done`; `GET /cases/1/progress` → same `steps` as before M1.
3. `resolveProgram({ category: 'hospital_financial_assistance', organization: 'UCSF Medical Center', location: 'San Francisco' })` → `found: false`, `searches_used ≤ 1`.
4. `resolveProgram({ category: 'paratransit', location: 'Los Angeles, CA' })` → `found: true`, `from_catalog: true`, `program.source_domain === 'accessla.org'`, `field_count === 146`.
5. `understandForm` for LA Access → 146 rows, every `pdf_field_name` in the extracted list, ≥ 1 section, no forbidden field `required`.
6. `mapAnswers` on `DEMO_ANSWERS` → 26 values, `unmapped: []`, option values slash-less.
7. `buildSummaryMessage` output ≤ 320 chars for 0, 1, 3 and 7 missing items; contains no digits other than the URL.
8. `send_summary` to `TWILIO_TEST_MOBILE` → `deliveries` row `sent` with an `SM…` `provider_id`; to any other number → `skipped`.
9. Vapi assistant lists all nine tool names from `M1_VOICE_TOOL_NAMES`; the Cedars golden call still reaches `READY_FOR_REVIEW`.
