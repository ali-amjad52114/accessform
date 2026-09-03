# AccessForm visual starter

```bash
npm install
npm run dev
```

Routes:
- `/`
- `/live`
- `/review`

## Document engine

The filled application is produced by `lib/document/engine.ts`, selected with `DOCUMENT_ENGINE` in `.env.local`:

- `local` (default) — pdf-lib fills and flattens the official HCAI PDF on the server. No paid API, no "For Evaluation Purposes Only" watermark, and the source document's existing accessibility tagging (structure tree, `MarkInfo`, `Lang`) is kept intact. The document reports `accessibility_status: "preserved"`.
- `nutrient` — Nutrient DWS `POST /build` + `POST /accessibility/autotag`. Only used when set explicitly and `NUTRIENT_DWS_PROCESSOR_API` is present; a 402 (out of credit) on autotag reports `failed`, and a 401/402/403 on `/build` falls back to the local engine.

Only `processed` (a real autotag run) is ever described as "accessibility processing complete". `/api/document/:caseId/status` reports the engine and status for a case; generated PDFs are cached per engine under `.doccache/`.

This starter intentionally uses fixture data and plain CSS. Claude Code should keep the layout and progressively replace fixture states with the real SerpApi/Xano/Nutrient/Vapi adapters described in the root `specs/` folder.
