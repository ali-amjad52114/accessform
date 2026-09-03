# CLAUDE CODE INSTRUCTIONS — AccessForm

AccessForm is a generic access-and-benefits navigator. A person describes their
situation in their own words — by voice — and AccessForm finds the official
program that applies, locates the current official form, asks only the relevant
questions conversationally, fills the real document, catches missing evidence,
keeps the result accessible, and hands it back for human review. It never
submits, never signs, never decides eligibility. (A proposal to send the
filled application on the person's explicit approval is recorded below as
**pending, not decided**.)

The Cedars-Sinai financial-assistance path is the **first catalog entry and the
regression test**, not the product boundary. The LA County paratransit path
(Access Services) is the second proven path as of 2026-09-03. The product plan
— architecture, sponsor input/output contract, generic tools, catalog,
milestones — is in `docs/PRODUCT_PLAN.md`. Read it before any generalization
work.

## Product sentence

> "Tell AccessForm what is going on. It finds the official program for your
> situation, turns the paperwork into a conversation, fills the real form, and
> tells you exactly what is still missing."

## Situations this product must grow to handle

Each row is a *situation* → *program category* → *official authority*. The
pipeline is the same for all of them; only discovery, the form, and the
interview plan differ.

| Situation the person describes | Program category | Where the official form lives |
|---|---|---|
| "I got a $7,800 hospital bill I can't pay" | Hospital financial assistance / charity care | HCAI (hcai.ca.gov) + the hospital's own site — **proven for Cedars-Sinai** |
| "I can't walk far and I'm 65, I need to get to appointments" | Paratransit eligibility (ADA complementary paratransit) | The regional transit agency (e.g. Access Services in LA County, SFMTA/SF Paratransit) — **proven for Access Services, 2026-09-03** |
| "I'm a college student with ADHD and I'm struggling" | Disability accommodations (Section 504 / ADA in higher ed) | The college's Disability Services / DSPS office |
| "My kid has an IEP question" | Special education (IDEA) | The school district |
| "I lost my job and can't cover food" | CalFresh / SNAP | The county social services agency |

Do not hardcode any hospital, agency, or school name in product code. Cedars is
a **fixture**, not a constant baked into the pipeline.

## Non-negotiable rules

1. **Never substitute.** If discovery cannot verify an official source for the
   *exact* organization the person named, stop and say so. Serving a different
   organization's form and calling it "verified" is the single worst failure
   this product can have. (This happened once with UCSF → Cedars. Never again.)
2. **Never claim** approved, eligible, qualified, accepted, submitted, sent,
   filed, or signed. Allowed: "may qualify", "appears complete based on the
   published requirements", "ready for you to review".
3. **Completeness comes from Xano**, never recomputed in the UI.
4. **Accessibility status is literal.** Only `processed` may say processing
   ran. `preserved` = source tagging kept, no pass ran. `failed` says failed.
5. **No fixture data outside demo mode.** A failure surfaces as a failure.
6. **No identifiers.** Never ask for SSN, passport, or account numbers. Leave
   those fields blank for the person to complete.
7. **Verified sources only.** Allowlist by program authority (`.gov`, the
   agency's domain, the institution's `.edu`), never by a single hospital name.
8. **Sponsor labels are literal.** Every event names the component that
   actually did the work. A Nutrient label is allowed only when the Nutrient
   engine ran; a document filled by the local pdf-lib engine is labeled as such.

## Architecture (unchanged shape, generalized inputs)

```
voice ──► intent + situation ──► SerpApi discovery ──► official form (PDF)
                                      │                      │
                                      ▼                      ▼
                                 Xano: case, program,   pdf-lib: real field
                                 answers, requirements, list + export values
                                 completeness                │
                                      │                      ▼
                                      └──► LLM mapper: answers → fields ──► local engine fills + flattens ──► SMS link + /c/<case-id>
```

- **SerpApi = Find.** Queries are built from `{organization, program_category,
  region}`, never literal strings. Rank official authority first.
- **Xano = Orchestrate.** Workspace 2 `accessform`. Tables: hospitals →
  rename conceptually to *organizations*; programs; cases; form_schema;
  answers; requirements; documents; events. Completeness lives here.
- **Document engine = Build.** `DOCUMENT_ENGINE=local` (pdf-lib, default, no
  credits, no watermark) or `nutrient` (optional, when credits exist).
  Interface: `app/lib/document/engine.ts`.
- **LLM mapper (to build) = Understand.** Given the discovered form's real
  field names/export values and the person's answers, return a JSON mapping
  with constrained output. It replaces the hardcoded 26-field Cedars plan in
  `lib/voice/form-plan.ts`. Deterministic code still writes the PDF.
- **Vapi = Voice.** One assistant, nine tools: `create_case`, `resolve_need`,
  `discover_program`, `get_next_question`, `save_answer`, `validate_case`,
  `finalize_document`, `send_summary`, `get_case_progress`. The Twilio number
  +1 (945) 277-2309 is imported into Vapi and routed to the assistant. The
  system prompt must describe the *product*, not a single hospital.
- **Twilio = Deliver.** `send_summary` texts a signed document link plus the
  still-missing list. Links carry a 72-hour HMAC token and `/api/document` is
  token-gated whenever `PUBLIC_BASE_URL` is set.

## Two pages

1. `/` — start: headline, the phone number, one **Start a conversation** CTA.
2. `/c/<case-id>` — one long conversation page. Left: a history sidebar of
   this browser's conversations. Main column: the transcript is the spine,
   with inline cards where they happen — location map, search candidates,
   the form, what is still missing, the result.

History is per browser (`localStorage`), no login. `/live` and `/review` stay
until the conversation page replaces them, then redirect to `/c/<case-id>`.
Still no dashboards, no admin, no auth unless a sponsor API forces it.

## Generalization work, in order

1. **Honest not-found** in `discover_program`: unknown/unverifiable
   organization → tell the person, do not proceed to fill. *(done: a made-up
   hospital returns `found=false`.)*
2. **Parameterized discovery**: queries and allowlist derived from the
   organization + program category; HCAI-style registries first where they exist.
   *(done: UCSF and Kaiser resolve live to their own applications.)*
3. **Per-form field extraction**: pdf-lib field list for fillable PDFs *(done)*;
   coordinate-overlay fallback for flat/scanned forms (not yet built).
4. **LLM mapper** with constrained output; hardcoded Cedars plan becomes its
   fallback fixture.
5. **Situation → program classifier** in the assistant prompt/tools so
   "I can't walk far" routes to paratransit, not hospital billing. *(done via
   `resolve_need`; verified on a live call.)*
6. **Requirements catalog per program** (attachments, signatures, proofs), so
   "one thing left" is truthful for every form, not just Cedars.

## Runtime and environment

- `NEXT_PUBLIC_DEMO_MODE=true` → all fixtures, scripted call, zero network.
  `false` → live services; fixtures only if a service is unreachable.
- `DOCUMENT_ENGINE=local|nutrient` (default `local`).
- Nutrient: three separate keys, three fixed paths, no base-URL vars.
  Processor `/build`, Extraction `/extraction/parse`, Accessibility
  `/accessibility/autotag`. Viewer key is `pdf_pub_live_` (browser only).
- Vapi tool webhooks need a public URL (`VAPI_SERVER_URL` + provisioning
  script); localhost is unreachable from Vapi. `PUBLIC_BASE_URL` is the base
  for SMS document links and turns on token-gating of `/api/document`.
- Xano direct push is enabled on workspace 2 only. Never `--delete`. Never
  re-run `POST /demo/seed` against real cases (it prunes them).

## Pending decision: "Approve and send" (not decided)

Proposed, not agreed: after the person's **explicit approval**, AccessForm
would email the filled application to the program's published intake address.
This contradicts rule 2 ("never claim sent") and the "never submits" line at
the top, so it can only land as a rule change, worded like this:

> "Sent" may be shown only after (a) an `approval_recorded` event exists for
> the case and (b) the email provider has confirmed delivery. Before both,
> the wording stays "ready for you to review".

If adopted it implies HIPAA/PHI handling obligations (the email carries a
medical application) and a per-program submission address stored in
`programs.submission_instructions`. Until the owner decides, nothing sends
and no UI or prompt may say "sent".

## Known gaps (keep this list honest)

- Flat PDFs (UCSF, Kaiser) are discovered and delivered as `flat_pdf` but not
  filled — there is no coordinate-overlay engine yet.
- Phone-call transcripts are not persisted (being built; the conversation page
  needs them).
- The activity feed labeled local-engine document events as Nutrient (being
  fixed; rule 8 above).
- `PUBLIC_BASE_URL` is a temporary trycloudflare tunnel; there is no stable
  deployment yet, so SMS links and webhooks break when the tunnel restarts.
- Twilio account is a Trial: texts reach only the verified test number and the
  SMS trial guard skips every other recipient.
- Nutrient account: watermark on `/build`, `402` on accessibility. Local engine
  is the default for that reason.
- Bundled fixture PDF is a watermarked Nutrient output; some fallback paths
  still label it `processed`.
- Finalize may write duplicate events to the feed — to re-check; not verified
  either way on 2026-09-03.

## Definition of done for the next milestone

The conversation page `/c/<case-id>` renders a real phone call live from Xano
events — transcript as the spine, search candidates, form progress, still
missing, result — for a case created by a caller, and both golden calls
(Cedars hospital bill, LA County paratransit) still pass unchanged.
