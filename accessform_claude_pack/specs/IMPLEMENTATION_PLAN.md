# Fast Build Order

## First 60–90 minutes: prove the document path
1. Open/fetch the official Cedars application.
2. Prove Nutrient can accept/process it.
3. Hardcode Jane's answer map and produce a filled output.
4. Prove the completed output can be shown in Viewer.

Do this before voice or visual polish. The filled real PDF is the highest-risk and highest-value part.

## Next: state and validation
5. Create Xano tables/endpoints from `DATA_MODEL.md`.
6. Create AF-001 and save Jane's answers.
7. Implement completeness logic so proof of income and signature remain missing.

## Next: discovery
8. Add SerpApi live discovery and domain/source validation.
9. Write discovery events into Xano and surface them on `/live`.

## Next: voice
10. Add Vapi tool calls into the Xano/SerpApi workflow.
11. Use the deterministic Jane script for the demo path, but permit natural phrasing.

## Last: polish
12. Match mockups.
13. Run keyboard/screen-reader sanity checks.
14. Add retry/fallback states.
15. Rehearse 90–120 second demo from `DEMO_SCRIPT.md`.

## Non-negotiable fallback
Every external integration must have a fixture mode. The demo must still reach `/review` if one sponsor API is temporarily slow. Keep sponsor calls real when working, but never let a network hiccup destroy the presentation.
