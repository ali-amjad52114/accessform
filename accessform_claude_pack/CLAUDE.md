# CLAUDE CODE INSTRUCTIONS — AccessForm

You are building a hackathon vertical slice. Do not broaden scope.

## Product sentence
AccessForm lets a blind or low-vision patient prepare a hospital financial-assistance application by voice: it finds the correct official form, asks the relevant questions conversationally, fills the real PDF, catches missing evidence, makes the output accessible, and gives the patient control for review.

## Only supported scenario
- Hospital: Cedars-Sinai Medical Center, California.
- Need: financial assistance / charity care / discount payment.
- Demo patient: Jane, age 68, low vision, lives alone, retired, Medicare, Social Security $2,050/month, $7,800 bill, proof-of-income document not currently available.
- Expected missing item: proof of Social Security income.
- Final status: READY FOR REVIEW, NOT READY TO SUBMIT.

## Required stack
- Next.js + TypeScript.
- Keep the UI accessible and responsive.
- Use the starter visual scaffold in `starter/` rather than inventing a dashboard.
- SerpApi for official-source discovery.
- Xano as system of record/workflow engine.
- Nutrient Document Web Services for extraction/processing/accessibility; Nutrient Viewer for final review.
- Voice: use Vapi for fastest hackathon implementation unless the repository already has another voice provider. Keep a deterministic demo/simulation mode as fallback.

## Do not build
- No login/auth unless absolutely required by a sponsor API.
- No generic dashboard/sidebar.
- No other hospitals.
- No housing, SNAP, paratransit, SSI, etc.
- No eligibility guarantee. Say “may qualify” and “application appears complete based on published requirements.”
- No electronic submission to Cedars.
- No autonomous signature.
- No Foxit.

## Three user-facing screens only
1. `/` — sparse start page, one dominant CTA: call/start voice.
2. `/live` — live call + application progress + transcript + visible sponsor/tool events.
3. `/review` — Nutrient Viewer / PDF area + completeness summary + missing-document warning.

## Demo-safe behavior
Real integrations are preferred. If credentials are missing or an API fails, fall back to fixtures without breaking the demo. Clearly label simulated integration events in development only; remove that label for the final demo when real calls are working.

## The main visual sequence
Problem → SerpApi discovers official program/form → Nutrient extracts form → Xano creates case/schema → voice collects answers → Xano detects gaps → Nutrient fills PDF → Nutrient accessibility pass → user reviews.

## Implement sponsor visibility
Do not hide integrations completely. During `/live`, show small event rows such as:
- SerpApi · Official Cedars program found
- SerpApi · HCAI source verified
- Nutrient · Form structure extracted
- Xano · Household answer saved
- Xano · Missing proof of income detected
- Nutrient · Completed PDF generated
- Nutrient · Accessibility processing complete

This makes sponsor depth obvious without turning the product into a dev console.

## Definition of done
See `specs/PRODUCT.md`. Do not spend time polishing anything outside that checklist until all required states work end-to-end.
