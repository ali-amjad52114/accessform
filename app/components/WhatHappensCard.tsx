import { Card } from './Card';

/** The five things AccessForm does, in order. Verbatim from mockups/01_start.png. */
export const WHAT_HAPPENS_STEPS = [
  'Find the official program',
  'Ask only relevant questions',
  'Fill the real hospital PDF',
  'Catch what is still missing',
  'Return an accessible form',
] as const;

export function WhatHappensCard() {
  return (
    <Card title="What happens" titleId="what-happens-title">
      <ol className="af-steps">
        {WHAT_HAPPENS_STEPS.map((label, index) => (
          <li className="af-steps__item" key={label}>
            <span className="af-steps__num" aria-hidden="true">
              {index + 1}
            </span>
            <span className="af-steps__label">
              <span className="af-sr-only">{`Step ${index + 1}: `}</span>
              {label}
            </span>
          </li>
        ))}
      </ol>
      <p className="af-note">
        Designed for voice, keyboard, screen readers, and high contrast.
      </p>
    </Card>
  );
}
