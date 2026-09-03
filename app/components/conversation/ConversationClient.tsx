'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaseEvent, Id } from '../../lib/contract';
import { useVoiceSession } from '../../lib/voice';
import { CallBar } from './CallBar';
import { DocumentsStrip } from './DocumentsStrip';
import { LiveCallWatcher } from './LiveCallWatcher';
import { Sidebar } from './Sidebar';
import { Timeline } from './Timeline';
import { buildTimeline } from './timeline-model';
import { useCaseState } from './use-case-state';

const HISTORY_ID = 'conversation-history';

/**
 * One long conversation page. Everything shown comes from the backend
 * (GET /api/voice/case/:id) merged with the live browser call; nothing is
 * recomputed here and nothing is faked when a read fails.
 */
export function ConversationClient({
  caseId,
  autoStart,
  fontClass,
}: {
  caseId: Id;
  autoStart: boolean;
  fontClass: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const voice = useVoiceSession({ caseId, autoStart, bindEscapeKey: false });
  const caseState = useCaseState(caseId, voice.active);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  /* Drop `?start=1` once the call is up so a reload does not redial. */
  useEffect(() => {
    if (autoStart && voice.session) router.replace(pathname, { scroll: false });
  }, [autoStart, voice.session, router, pathname]);

  /* Escape closes the drawer first; otherwise it pauses / resumes the call. */
  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      if (historyOpen) {
        keyEvent.preventDefault();
        setHistoryOpen(false);
        return;
      }
      if (voice.active) {
        keyEvent.preventDefault();
        void (voice.state === 'paused' ? voice.resume() : voice.pause());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [historyOpen, voice]);

  const data = caseState.data;
  const bundle = data?.bundle ?? null;
  const progress = data?.progress ?? voice.progress ?? null;
  const completeness = data?.completeness ?? voice.completeness ?? null;

  /**
   * The demo runtime replays a scripted call on purpose; a live call that
   * fell back to the script would put fixture turns on a real case, so the
   * browser stream is only merged when it belongs to this case.
   */
  const demoMode = voice.runtime?.simulationOnly === true;
  const browserStreamTrusted = !voice.simulated || demoMode;

  const events: CaseEvent[] = useMemo(() => {
    const merged = new Map<string, CaseEvent>();
    for (const event of data?.events ?? []) merged.set(event.id, event);
    if (browserStreamTrusted) {
      for (const event of voice.events) {
        if (event.case_id === caseId || demoMode) merged.set(event.id, event);
      }
    }
    return Array.from(merged.values());
  }, [data?.events, voice.events, browserStreamTrusted, caseId, demoMode]);

  const items = useMemo(
    () => buildTimeline(events, browserStreamTrusted ? voice.transcript : []),
    [events, voice.transcript, browserStreamTrusted],
  );

  const stateLabel = (() => {
    if (voice.starting) return 'Connecting…';
    if (voice.active) return voice.stateLabel;
    if (caseState.loading && !data) return 'Loading…';
    switch (bundle?.case.status) {
      case 'READY_FOR_REVIEW':
        return 'Ready for review';
      case 'BLOCKED':
        return 'Stopped';
      default:
        return voice.session ? 'Call ended' : 'Saved conversation';
    }
  })();

  const emptyText = voice.starting || (autoStart && !voice.session)
    ? 'Connecting your call…'
    : caseState.loading && !data
      ? 'Loading this conversation…'
      : 'Nothing has happened in this conversation yet. Start a call to begin.';

  const togglePause = useCallback(() => {
    void (voice.state === 'paused' ? voice.resume() : voice.pause());
  }, [voice]);

  return (
    <div className={`af-cv ${fontClass}`}>
      <Sidebar
        id={HISTORY_ID}
        currentCaseId={caseId}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
      {historyOpen ? (
        <button
          type="button"
          className="af-cv-backdrop"
          aria-label="Close history"
          onClick={() => setHistoryOpen(false)}
        />
      ) : null}

      <section className="af-cv-main" aria-label="Conversation">
        <CallBar
          stateLabel={stateLabel}
          live={voice.active}
          starting={voice.starting}
          paused={voice.state === 'paused'}
          progress={progress}
          onStart={() => void voice.start()}
          onTogglePause={togglePause}
          onEnd={() => void voice.end()}
          onOpenHistory={() => setHistoryOpen(true)}
          historyId={HISTORY_ID}
          historyOpen={historyOpen}
        />
        <DocumentsStrip documents={bundle?.documents ?? []} caseId={caseId} signedUrl={data?.documentUrl ?? null} />

        <div className="af-cv-scroll" ref={scrollRef} id="main" tabIndex={-1}>
          <div className="af-cv-column">
            <LiveCallWatcher mode="conversation" currentCaseId={caseId} />
            {caseState.error ? (
              <div className="af-cv-error" role="alert">
                <p>{caseState.error}</p>
                <button type="button" className="af-cv-ctl" onClick={() => void caseState.refresh()}>
                  Try again
                </button>
              </div>
            ) : null}
            {voice.error ? (
              <p className="af-cv-error" role="status">
                {voice.error}
              </p>
            ) : null}
            {voice.simulated && !demoMode && voice.session ? (
              <p className="af-cv-gap">
                The recorded demonstration is playing. It is not attached to this conversation.
              </p>
            ) : null}

            <Timeline
              items={items}
              bundle={bundle}
              progress={progress}
              completeness={completeness}
              events={events}
              caseId={caseId}
              signedUrl={data?.documentUrl ?? null}
              scrollRef={scrollRef}
              emptyText={emptyText}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
