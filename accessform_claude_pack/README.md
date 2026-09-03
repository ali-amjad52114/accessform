# AccessForm — Claude Code Build Pack

## Goal
Build one vertical slice only:

> A blind/low-vision Californian has a $7,800 Cedars-Sinai hospital bill and cannot afford it. They speak to AccessForm. The system finds the current official financial-assistance application, turns it into a natural voice interview, fills the real PDF, detects the one missing supporting document, runs accessibility processing, and presents the completed application for review.

## Open this first
1. `CLAUDE.md` — implementation instructions for Claude Code.
2. `mockups/` — four target visuals.
3. `specs/PRODUCT.md` — scope and definition of done.
4. `specs/UI.md` — screen-by-screen UI behavior.
5. `specs/API_INTEGRATIONS.md` — SerpApi, Xano, Nutrient, voice.
6. `starter/` — runnable Next.js visual scaffold.

## Sponsor roles
- **SerpApi = Find** the current official hospital program/application.
- **Xano = Orchestrate** case state, answers, requirements, progress, audit events.
- **Nutrient = Understand + Build + Make Accessible + Review** the real PDF.
- No Foxit in this vertical slice.

## Demo success
The demo is not done until the user can speak naturally and finish with the real current Cedars-Sinai financial-assistance application filled and ready to review, while AccessForm explicitly warns that proof of Social Security income and the user's signature remain.

## Official demo sources
- HCAI Cedars-Sinai listing: https://hcai.ca.gov/affordability/hospital-billing-policies/cedars-sinai-medical-center/
- Current HCAI-hosted application used for this pack (effective 2025-09-17):
  https://api.hdc.hcai.ca.gov/Public/Extract/Attachment?id=1b7ee017-9db0-4a44-b3dc-a39c5986f24e

Always re-discover/validate the current source at runtime with SerpApi rather than blindly trusting the hardcoded URL.
