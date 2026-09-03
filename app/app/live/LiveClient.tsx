'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { ArrowRight, Pause, PhoneOff, Play, RotateCcw } from 'lucide-react';
import {
  DEMO_CASE_ID,
  PROGRESS_STEP_IDS,
  PROGRESS_STEP_LABELS,
  type CaseProgress,
} from '../../lib/contract';
import { useVoiceSession } from '../../lib/voice';
import { SiteHeader } from '../../components/SiteHeader';
import { CallStatus } from '../../components/CallStatus';
import { Card } from '../../components/Card';
import { ApplicationProgress } from '../../components/ApplicationProgress';
import { MissingRequirementAlert } from '../../components/MissingRequirementAlert';
import { VoiceOrb } from '../../components/VoiceOrb';
import { Transcript } from '../../components/Transcript';
import {
  LiveFormState,
  type LiveFieldSnapshot,
} from '../../components/LiveFormState';
import { IntegrationFeed } from '../../components/IntegrationFeed';

/**
 * Shown for the moment between mount and the first progress event. These are
 * the legacy eight steps; once Xano reports the form's own sections the
 * progress card renders those instead (see ApplicationProgress).
 */
const EMPTY_PROGRESS: CaseProgress = {
  caseId: DEMO_CASE_ID,
  status: 'CREATED',
  percent: 0,
  steps: PROGRESS_STEP_IDS.map((id) => ({
    id,
    label: PROGRESS_STEP_LABELS[id],
    state: 'todo',
  })),
  answersSaved: 0,
  answersExpected: 0,
  nextFieldId: null,
  nextPrompt: null,
};

const FORM_KIND_WORD = {
  fillable_pdf: 'fillable PDF form',
  flat_pdf: 'PDF form (not fillable yet)',
  online_form: 'online form',
  in_person: 'in-person application',
} as const;

export function LiveClient() {
  const voice = useVoiceSession({ caseId: DEMO_CASE_ID, autoStart: true });

  const {
    state,
    activeCaseId,
    progress,
    progressAnnouncement,
    transcript,
    events,
    missingRequirements,
    lastSavedAnswer,
    lastSavedSection,
    program,
    completeness,
    simulated,
    error,
    pause,
    resume,
    end,
    reset,
    start,
  } = voice;

  const reviewHref = activeCaseId
    ? `/review?case=${encodeURIComponent(activeCaseId)}`
    : '/review';
  const callerName = simulated ? 'Jane' : 'You';

  /* "Your call" until discover_program has matched a verified program. */
  const title = program ? program.name : 'Your call';
  const subtitle = program
    ? [program.organization, program.formKind ? FORM_KIND_WORD[program.formKind] : null]
        .filter(Boolean)
        .join(' · ')
    : 'Describe what is going on and where you are. AccessForm finds the official form from there.';

  const togglePause = useCallback(() => {
    if (state === 'ended') return;
    void (state === 'paused' ? resume() : pause());
  }, [state, pause, resume]);

  const replay = useCallback(() => {
    reset();
    void start();
  }, [reset, start]);

  const ended = state === 'ended';
  const paused = state === 'paused';
  const shownProgress = progress ?? EMPTY_PROGRESS;
  const readyForReview =
    completeness?.readyForReview === true ||
    shownProgress.status === 'READY_FOR_REVIEW';

  const field: LiveFieldSnapshot | null = lastSavedAnswer
    ? {
        key: lastSavedAnswer.normalizedKey,
        label: lastSavedAnswer.label,
        display: lastSavedAnswer.displayValue,
        saved: lastSavedAnswer.savedToXano,
        section: lastSavedSection,
      }
    : null;

  return (
    <div className="af-page">
      <SiteHeader aside={<CallStatus state={state} />} />

      <main className="af-container" id="main">
        <div className="af-screenhead">
          <h1 className="af-screenhead__title">{title}</h1>
          <p className="af-screenhead__sub" aria-live="polite">
            {subtitle}
          </p>
        </div>

        <div className="af-livegrid">
          <Card title="Application" titleId="application-card-title">
            <ApplicationProgress
              progress={shownProgress}
              announcement={progressAnnouncement}
            />
            <MissingRequirementAlert requirements={missingRequirements} />
          </Card>

          <Card title="Conversation" titleId="conversation-card-title">
            <VoiceOrb state={state} />
            <Transcript turns={transcript} patientName={callerName} />
            <LiveFormState field={field} />

            {error ? (
              <p className="af-controls__hint" role="status">
                {error}
              </p>
            ) : null}

            <div className="af-controls">
              {ended ? (
                <button
                  type="button"
                  className="af-btn af-btn--quiet"
                  onClick={replay}
                >
                  <RotateCcw size={20} strokeWidth={2.5} aria-hidden="true" />
                  {simulated ? 'Replay the call' : 'Start a new call'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="af-btn af-btn--quiet"
                    onClick={togglePause}
                  >
                    {paused ? (
                      <Play size={20} strokeWidth={2.5} aria-hidden="true" />
                    ) : (
                      <Pause size={20} strokeWidth={2.5} aria-hidden="true" />
                    )}
                    {paused ? 'Resume the call' : 'Pause the call'}
                  </button>
                  <button
                    type="button"
                    className="af-btn af-btn--quiet"
                    onClick={() => void end()}
                  >
                    <PhoneOff size={20} strokeWidth={2.5} aria-hidden="true" />
                    End the call
                  </button>
                </>
              )}

              <Link
                className={
                  readyForReview
                    ? 'af-btn af-btn--primary'
                    : 'af-btn af-btn--quiet'
                }
                href={reviewHref}
              >
                Review the form
                <ArrowRight size={20} strokeWidth={2.5} aria-hidden="true" />
              </Link>

              <p className="af-controls__hint">
                Press <kbd>Escape</kbd> at any time to pause or resume.
              </p>
            </div>
          </Card>
        </div>

        <div className="af-livefoot">
          <Card title="Activity" titleId="activity-card-title">
            <IntegrationFeed
              events={events}
              simulated={simulated}
              callerName={simulated ? 'Jane' : undefined}
            />
          </Card>
        </div>
      </main>
    </div>
  );
}
