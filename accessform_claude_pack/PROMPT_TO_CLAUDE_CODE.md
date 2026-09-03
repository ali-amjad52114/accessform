# Copy/paste this into Claude Code

Build the AccessForm vertical slice in this repository.

Read in this order:
1. `CLAUDE.md`
2. `specs/PRODUCT.md`
3. `specs/UI.md`
4. `specs/API_INTEGRATIONS.md`
5. `specs/DATA_MODEL.md`
6. `mockups/*.png`
7. `references/09_nutrient_api_overview.png`
8. `references/SOURCE_LINKS.md`

Use `starter/` as the visual scaffold. Preserve the three-screen architecture and accessible design. Do not invent a dashboard or broaden the product.

Work in phases and keep the app runnable after each phase:

Phase 1 — UI fidelity
- Make `/`, `/live`, and `/review` match the supplied mockups closely.
- Add an integration-event feed to `/live`.
- Make responsive and keyboard accessible.

Phase 2 — domain model/adapters
- Create typed integration adapters for SerpApi, Xano, Nutrient, and Vapi.
- Keep fixture adapters behind `NEXT_PUBLIC_DEMO_MODE=true` so the demo always works.

Phase 3 — SerpApi
- From hospital=`Cedars-Sinai` and intent=`financial assistance`, run live searches.
- Prefer official HCAI/Cedars domains.
- Display source verification events in the UI.
- Persist result metadata to Xano.

Phase 4 — Xano
- Implement case creation, answers, progress, requirements, documents, and event logging.
- Make Xano authoritative for completeness state.

Phase 5 — Nutrient
- Ingest the official current Cedars application.
- Extract usable field/document structure.
- Map collected answers into the PDF.
- Generate the completed PDF.
- Run accessibility processing.
- Render the result in Nutrient Viewer on `/review`.
- If automatic extraction/mapping is unreliable, create a Cedars-specific fallback mapping so the demo is guaranteed to work.

Phase 6 — Voice
- Use Vapi for browser/phone voice.
- Expose tools for create case, discover program, save answer, progress, validate, and finalize.
- Ask natural questions, not PDF field labels.
- Finish by explaining exactly what is missing.

Demo fixture:
- Jane, 68, low vision, lives alone, retired, Medicare, Social Security $2,050/month, $7,800 bill.
- Intentionally do not provide proof of Social Security income.
- Final state = READY_FOR_REVIEW, missing proof of income + signature.

Do not claim eligibility, approval, submission, or signature.

Before calling the task complete, verify the end-to-end flow against the Definition of Done in `specs/PRODUCT.md` and run the app/build checks.
