# Product / Vertical Slice Spec

## User story
Jane has low vision, is retired, lives alone, receives $2,050/month Social Security, has Medicare, and receives a $7,800 Cedars-Sinai bill. She does not know where the hospital's financial-assistance application is or how to complete it.

She calls AccessForm and says: “I received a Cedars-Sinai bill for $7,800 and I can't afford it.”

Within one conversation, AccessForm should:
1. Identify Cedars-Sinai and financial assistance as the need.
2. Use SerpApi to find official Cedars/HCAI sources.
3. Identify the current application.
4. Use Nutrient to understand the real document.
5. Create a case in Xano.
6. Ask only relevant questions, conversationally.
7. Save each structured answer to Xano.
8. Continuously calculate completeness.
9. Detect that proof of income is still missing.
10. Use Nutrient to fill the official PDF.
11. Run Nutrient accessibility processing.
12. Present the completed application in Nutrient Viewer for human review.

## Final outcome
The final screen must not say “submitted” or “approved.” It says:

- 26/26 required fields completed (adjust to actual mapped count if different).
- Official current form.
- Accessibility processed.
- Still required: proof of Social Security income.
- Still required: user signature.
- Ready for review.

## Product safety/accuracy language
- Do not guarantee financial-assistance eligibility.
- The hospital determines approval/denial.
- Always show source URLs and retrieval timestamps in a details panel.
- If source validation fails, stop and ask for human confirmation rather than fill an unverified form.

## Definition of done
A single uninterrupted demo can:
- start a call/browser voice session;
- infer hospital + need + bill amount;
- show SerpApi discovery happening;
- show the official HCAI/Cedars application found;
- create/update the Xano case;
- ask the demo questions;
- save structured answers;
- visibly update progress;
- detect missing proof of income;
- generate a filled PDF through Nutrient;
- run accessibility processing;
- open a review experience with the actual populated document.
