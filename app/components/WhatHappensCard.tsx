import { Card } from './Card';

/** The five things AccessForm does, in order — for any need, any official form. */
export const WHAT_HAPPENS_STEPS = [
  'Find hospitals near you that offer financial assistance',
  'Find that hospital’s official application form',
  'Fill it in by voice — a few questions, one at a time',
  'Review the filled form from a text link',
  'Send it to the hospital yourself, in one step',
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
