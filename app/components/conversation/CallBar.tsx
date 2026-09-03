'use client';

import type { CaseProgress } from '../../lib/contract';

export interface CallBarProps {
  /** "Listening…", "Connecting…", "Saved conversation". */
  stateLabel: string;
  /** True while the browser call is live (drives the dot). */
  live: boolean;
  starting: boolean;
  paused: boolean;
  progress: CaseProgress | null;
  onStart: () => void;
  onTogglePause: () => void;
  onEnd: () => void;
  onOpenHistory: () => void;
  historyId: string;
  historyOpen: boolean;
}

/**
 * Sticky bar above the timeline: call state, "N of M answers" with a bar,
 * and the call controls. Xano owns the numbers; this only renders them.
 */
export function CallBar({
  stateLabel,
  live,
  starting,
  paused,
  progress,
  onStart,
  onTogglePause,
  onEnd,
  onOpenHistory,
  historyId,
  historyOpen,
}: CallBarProps) {
  const saved = progress?.answersSaved ?? 0;
  const expected = progress?.answersExpected ?? 0;
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const answersText =
    expected > 0 ? `${saved} of ${expected} answers` : saved > 0 ? `${saved} answers` : 'No answers yet';

  return (
    <div className="af-cv-callbar" role="status" aria-live="polite">
      <button
        type="button"
        className="af-cv-ctl af-cv-menu"
        onClick={onOpenHistory}
        aria-controls={historyId}
        aria-expanded={historyOpen}
      >
        History
      </button>

      <span className="af-cv-state">
        <span
          className={live ? 'af-cv-dot' : 'af-cv-dot af-cv-dot--idle'}
          aria-hidden="true"
        />
        <span className="af-cv-state__text">{stateLabel}</span>
      </span>

      <span className="af-cv-prog">
        <span
          className="af-cv-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% complete, ${answersText}`}
          aria-label="Application progress"
        >
          <i style={{ width: `${percent}%` }} />
        </span>
        <span className="af-cv-prog__text" aria-hidden="true">
          {answersText}
        </span>
      </span>

      <span className="af-cv-spacer" />

      {live ? (
        <>
          <button type="button" className="af-cv-ctl" onClick={onTogglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="af-cv-ctl af-cv-ctl--end" onClick={onEnd}>
            End call
          </button>
        </>
      ) : (
        <button
          type="button"
          className="af-cv-ctl af-cv-ctl--primary"
          onClick={onStart}
          disabled={starting}
          aria-busy={starting}
        >
          {starting ? 'Connecting…' : 'Start call'}
        </button>
      )}
    </div>
  );
}
