import { Check, Circle } from 'lucide-react';
import type { CaseProgress, ProgressState } from '../lib/contract';

/**
 * Status is never carried by colour alone: every row has a distinct icon
 * shape AND a screen-reader-only word ("Completed", "In progress", "Not
 * started") in addition to its colour.
 */
const STATE_WORD: Readonly<Record<ProgressState, string>> = {
  done: 'Completed',
  active: 'In progress',
  todo: 'Not started',
};

function StepIcon({ state }: { state: ProgressState }) {
  if (state === 'done') {
    return <Check size={24} strokeWidth={3} aria-hidden="true" />;
  }
  if (state === 'active') {
    return <Circle size={18} strokeWidth={2} fill="currentColor" aria-hidden="true" />;
  }
  return <Circle size={18} strokeWidth={2.5} aria-hidden="true" />;
}

/**
 * The left card on /live: the eight application states, a progress bar and
 * the "N% complete" summary. Xano owns these numbers — this component only
 * renders the `CaseProgress` it is handed.
 */
export function ApplicationProgress({
  progress,
  announcement,
}: {
  progress: CaseProgress;
  /** Fuller sentence to announce instead of the terse visible summary. */
  announcement?: string;
}) {
  const summary = `${progress.percent}% complete · ${progress.answersSaved} of ${progress.answersExpected} answers`;
  const spoken = announcement && announcement.length > 0 ? announcement : summary;

  return (
    <>
      <ol className="af-progress">
        {progress.steps.map((step) => (
          <li
            className={`af-progress__row af-progress__row--${step.state}`}
            key={step.id}
          >
            <span className="af-progress__icon">
              <StepIcon state={step.state} />
            </span>
            <span>
              {step.label}
              <span className="af-sr-only">{` — ${STATE_WORD[step.state]}`}</span>
            </span>
          </li>
        ))}
      </ol>

      <div
        className="af-bar"
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={spoken}
        aria-label="Application completeness"
      >
        <span
          className="af-bar__fill"
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      <p className="af-progress__summary" aria-hidden="true">
        {summary}
      </p>

      {/* Progress changes are announced politely, per ACCESSIBILITY.md. */}
      <p className="af-sr-only" aria-live="polite" aria-atomic="true">
        {spoken}
      </p>
    </>
  );
}
