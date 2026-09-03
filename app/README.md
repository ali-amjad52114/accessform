# AccessForm visual starter

```bash
npm install
npm run dev
```

Pages:
- `/` — start: headline, phone number, **Start a conversation**
- `/c/<case-id>` — the conversation page: history sidebar (this browser only, `localStorage`) plus the transcript with inline cards (location, search, form, still missing, result)
- `/live`, `/review?case=<id>` — kept until `/c/<case-id>` replaces them, then they redirect

API:
- `POST /api/cases` — create a case from the browser
- `GET /api/cases/summary?ids=<id,id,...>` — summaries for the history sidebar
- `GET /api/document/:caseId` — the filled PDF; token-gated (72 h HMAC link) when `PUBLIC_BASE_URL` is set
- `GET /api/document/:caseId/status` — engine and accessibility status
- `POST /api/voice/tools`, `POST /api/voice/webhook` — Vapi tool calls and call events

## Document engine

The filled application is produced by `lib/document/engine.ts`, selected with `DOCUMENT_ENGINE` in `.env.local`:

- `local` (default) — pdf-lib fills and flattens the official HCAI PDF on the server. No paid API, no "For Evaluation Purposes Only" watermark, and the source document's existing accessibility tagging (structure tree, `MarkInfo`, `Lang`) is kept intact. The document reports `accessibility_status: "preserved"`.
- `nutrient` — Nutrient DWS `POST /build` + `POST /accessibility/autotag`. Only used when set explicitly and `NUTRIENT_DWS_PROCESSOR_API` is present; a 402 (out of credit) on autotag reports `failed`, and a 401/402/403 on `/build` falls back to the local engine.

Only `processed` (a real autotag run) is ever described as "accessibility processing complete". `/api/document/:caseId/status` reports the engine and status for a case; generated PDFs are cached per engine under `.doccache/`.

This starter intentionally uses fixture data and plain CSS. Claude Code should keep the layout and progressively replace fixture states with the real SerpApi/Xano/Nutrient/Vapi adapters described in the root `specs/` folder.
