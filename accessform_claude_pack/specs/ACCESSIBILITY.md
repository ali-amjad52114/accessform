# Accessibility Checklist

Because accessibility is the product, the demo UI must itself be credible.

- WCAG-oriented contrast; avoid low-contrast gray-on-white.
- Body text >=18px for primary content.
- Visible keyboard focus ring.
- Semantic headings in order.
- Buttons are real `<button>` elements.
- Every icon-only control has an accessible name.
- `aria-live="polite"` for transcript/progress updates.
- `role="alert"` for the missing-document warning.
- Do not rely on color alone for statuses; always include icon + text.
- Voice can be paused/stopped without pointer precision.
- Support browser zoom to 200% without loss of content/function.
- Final PDF should be passed through Nutrient Accessibility API before review.
- Keep a “read summary aloud” action on the review screen if time allows.
