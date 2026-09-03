# CLAUDE CODE INSTRUCTIONS — AccessForm

AccessForm is a generic access-and-benefits navigator. A person describes their
situation in their own words — by voice — and AccessForm finds the official
program that applies, locates the current official form, asks only the relevant
questions conversationally, fills the real document, catches missing evidence,
keeps the result accessible, and hands it back for human review. It never
submits, never signs, never decides eligibility.

The Cedars-Sinai financial-assistance path is the **first catalog entry and the
regression test**, not the product boundary. The product plan — architecture,
sponsor input/output contract, generic tools, catalog, milestones — is in
`docs/PRODUCT_PLAN.md`. Read it before any generalization work.

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
| "I can't walk far and I'm 65, I need to get to appointments" | Paratransit eligibility (ADA complementary paratransit) | The regional transit agency (e.g. Access Services in LA County, SFMTA/SF Paratransit) |
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

## Architecture (unchanged shape, generalized inputs)

```
voice ──► intent + situation ──► SerpApi discovery ──► official form (PDF)
                                      │                      │
                                      ▼                      ▼
                                 Xano: case, program,   pdf-lib: real field
                                 answers, requirements, list + export values
                                 completeness                │
                                      │                      ▼
                                      └──► LLM mapper: answers → fields ──► local engine fills + flattens ──► /review
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
- **Vapi = Voice.** One assistant, six tools: `create_case`, `discover_program`,
  `save_answer`, `get_case_progress`, `validate_case`, `finalize_document`.
  The system prompt must describe the *product*, not a single hospital.

## Three screens only

1. `/` — one dominant CTA.
2. `/live` — call state, progress steps, transcript, live form row, sponsor event feed.
3. `/review?case=<id>` — the filled document, completeness, what is still missing.

No dashboards, no sidebars, no auth unless a sponsor API forces it.

## Generalization work, in order

1. **Honest not-found** in `discover_program`: unknown/unverifiable
   organization → tell the person, do not proceed to fill.
2. **Parameterized discovery**: queries and allowlist derived from the
   organization + program category; HCAI-style registries first where they exist.
3. **Per-form field extraction**: pdf-lib field list for fillable PDFs;
   coordinate-overlay fallback for flat/scanned forms (not yet built).
4. **LLM mapper** with constrained output; hardcoded Cedars plan becomes its
   fallback fixture.
5. **Situation → program classifier** in the assistant prompt/tools so
   "I can't walk far" routes to paratransit, not hospital billing.
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
  script); localhost is unreachable from Vapi.
- Xano direct push is enabled on workspace 2 only. Never `--delete`. Never
  re-run `POST /demo/seed` against real cases (it prunes them).

## Known gaps (keep this list honest)

- `discover_program` ignores the organization and serves the Cedars cache (fix #1 above).
- Bundled fixture PDF is a watermarked Nutrient output; some fallback paths
  still label it `processed`.
- Each finalize writes duplicate events to the feed.
- Nutrient account: watermark on `/build`, `402` on accessibility. Local engine
  is the default for that reason.
- No end-to-end conversation has yet completed and reached `/review` with a
  case created by a real person.

## Definition of done for the next milestone

A person can say **"I can't walk far and I need to get to the doctor"** and
AccessForm: classifies it as paratransit, discovers the correct regional
agency's official application from a verified source, extracts that form's real
fields, interviews them, fills it, and presents it for review — with the Cedars
slice still passing unchanged.
