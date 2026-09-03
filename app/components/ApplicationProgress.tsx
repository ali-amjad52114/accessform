import { Check, Circle } from 'lucide-react';
import type { CaseProgress, ProgressState, ProgressStep } from '../lib/contract';

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

interface ProgressRow {
  id: string;
  label: string;
  state: ProgressState;
  /** "3 of 8 answered" for a form section; empty for the fixed steps. */
  detail: string;
}

/**
 * Rows to render. When Xano reports the form's own `sections`, the interview
 * rows are those sections — however many the form has — framed by the fixed
 * `Program found` / `Current form` steps before and `Documents` / `Review`
 * after. Without sections (demo fixtures, pre-M1 responses) the eight legacy
 * steps are rendered as they arrive. Nothing here is hardcoded to a form.
 */
export function progressRows(progress: CaseProgress): ProgressRow[] {
  const byId = new Map<string, ProgressStep>(progress.steps.map((step) => [step.id, step]));
  const fixed = (id: ProgressStep['id']): ProgressRow[] => {
    const step = byId.get(id);
    return step ? [{ id: step.id, label: step.label, state: step.state, detail: '' }] : [];
  };
  const sections = progress.sections ?? [];
  if (sections.length === 0) {
    return progress.steps.map((step) => ({
      id: step.id,
      label: step.label,
      state: step.state,
      detail: '',
    }));
  }
  return [
    ...fixed('program_found'),
    ...fixed('current_form'),
    ...sections.map((section) => ({
      id: `section:${section.key}`,
      label: section.label,
      state: section.state,
      detail:
        section.field_count > 0 ? `${section.answered_count} of ${section.field_count} answered` : '',
    })),
    ...fixed('documents'),
    ...fixed('review'),
  ];
}

/**
 * The left card on /live: the application steps, a progress bar and the
 * "N% complete" summary. Xano owns these numbers — this component only
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
  const rows = progressRows(progress);

  return (
    <>
      <ol className="af-progress">
        {rows.map((row) => (
          <li className={`af-progress__row af-progress__row--${row.state}`} key={row.id}>
            <span className="af-progress__icon">
              <StepIcon state={row.state} />
            </span>
            <span>
              {row.label}
              {row.detail ? (
                <span className="af-progress__detail">
                  <span aria-hidden="true"> · </span>
                  {row.detail}
                </span>
              ) : null}
              <span className="af-sr-only">{` — ${STATE_WORD[row.state]}`}</span>
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
