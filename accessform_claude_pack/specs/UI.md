# UI Specification

## Visual direction
Use the provided `mockups/` as the primary target.

Design principles:
- high contrast;
- large text / touch targets;
- generous whitespace;
- warm off-white background instead of generic hospital blue;
- one calm accent color;
- no dashboard chrome;
- no tiny gray helper text;
- keyboard + screen-reader usable;
- status is conveyed with text/icons, not color alone.

Suggested sizing:
- page headline: 48–56px desktop;
- screen title: 34–42px;
- primary question/status: 26–32px;
- body: 18–20px;
- buttons: >=18px and >=52px high.

## Screen 1 `/`
Reference: `mockups/01_start.png`.

Must contain:
- AccessForm identity.
- Headline: “Hospital paperwork shouldn't require sight.”
- Short explanation.
- Primary CTA: Call AccessForm.
- Secondary CTA: Start in browser.
- Example utterance.
- Small “what happens” 5-step explanation.

Do not add navigation menus, feature grids, testimonials, pricing, etc.

## Screen 2 `/live`
Reference: `mockups/02_live_call.png`.

Desktop layout:
- top: patient/case title and call state;
- left card: application progress states;
- right card: voice state + transcript;
- bottom of right card: latest structured form state saved to Xano;
- subtle integration event feed can sit below/alongside on wider screens.

Required application states:
Program found → Current form → Personal → Household → Insurance → Income → Documents → Review.

Voice state options:
Listening / Thinking / Speaking / Paused / Ended.

Progress must be understandable without audio.

## Screen 3 `/review`
Reference: `mockups/03_application_ready.png`.

Layout:
- left ~65%: Nutrient Viewer / actual PDF;
- right ~35%: completeness summary;
- show “One thing left” warning prominently;
- CTA: Review application / Add missing document.

No “Submit” unless real submission is implemented later.

## Interaction details
- `Escape` or visible button pauses voice.
- Live transcript should auto-scroll but allow manual review.
- Announce progress changes via `aria-live="polite"`.
- Announce critical missing-document warning via `role="alert"`.
