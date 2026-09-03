import { Card } from './Card';

/** The five things AccessForm does, in order — for any need, any official form. */
export const WHAT_HAPPENS_STEPS = [
  'Tell us about the bill',
  'We find your hospital’s official assistance form',
  'Answer a few questions by voice',
  'We fill the hospital’s real PDF',
  'You get it by text, with what’s still missing',
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
        Nothing is submitted or signed for you. Designed for voice, keyboard,
        screen readers, and high contrast.
      </p>
    </Card>
  );
}
