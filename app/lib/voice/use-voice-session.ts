'use client';

/**
 * useVoiceSession — the only thing /live needs to import.
 *
 * One hook drives both paths (live Vapi call, or the deterministic Jane
 * script) and exposes plain state: voice state, transcript, progress, the
 * sponsor-visibility event feed, the live form row, and the completeness
 * summary. Nothing here recomputes completeness — the numbers come from the
 * adapter, which gets them from Xano.
 *
 * Accessibility notes for the screen that renders this:
 *   - `stateLabel` is ready to place in an `aria-live="polite"` region;
 *   - `progressAnnouncement` is a full sentence, also for `aria-live`;
 *   - `missingRequirements` belongs in a `role="alert"` region;
 *   - Escape pauses/resumes the call (set `bindEscapeKey: false` to opt out).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEMO_CASE_ID,
  VOICE_STATE_LABELS,
  type CaseEvent,
  type CaseProgress,
  type CompletenessSummary,
  type Id,
  type Requirement,
  type TranscriptTurn,
  type VoiceSession,
  type VoiceState,
  type VoiceToolCall,
} from '../contract';
import { createVoiceAdapter, fetchVoiceRuntimeConfig, type VoiceRuntimeConfig } from './factory';
import type { AccessFormVoiceAdapter, LiveFormState, VoiceStreamEvent } from './types';

export interface UseVoiceSessionOptions {
  /** Defaults to the demo case, AF-001. */
  caseId?: Id;
  /** Start the session as soon as the hook mounts. */
  autoStart?: boolean;
  /** Force the scripted conversation regardless of environment. */
  simulated?: boolean;
  /** Bind Escape to pause / resume. Default true. */
  bindEscapeKey?: boolean;
}

export interface UseVoiceSessionResult {
  /** null until `start()` has been called. */
  session: VoiceSession | null;
  caseId: Id;
  state: VoiceState;
  /** "Listening…", "Speaking…", "Call ended" — from the contract. */
  stateLabel: string;
  /** True once the call has started and has not ended. */
  active: boolean;
  starting: boolean;
  /** True when the scripted conversation is being replayed. */
  simulated: boolean;
  runtime: VoiceRuntimeConfig | null;

  transcript: TranscriptTurn[];
  /** Sponsor-visibility feed, oldest first. */
  events: CaseEvent[];
  toolCalls: VoiceToolCall[];

  progress: CaseProgress | null;
  /** Full sentence for an aria-live region. */
  progressAnnouncement: string;
  completeness: CompletenessSummary | null;
  missingRequirements: Requirement[];
  /** The "Live form state" row: last answer written to Xano. */
  lastSavedAnswer: LiveFormState | null;

  error: string | null;

  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  end: () => Promise<void>;
  /** Clears the transcript/feed so the demo can be run again. */
  reset: () => void;
}

const MAX_TRANSCRIPT_TURNS = 200;

export function useVoiceSession(options: UseVoiceSessionOptions = {}): UseVoiceSessionResult {
  const caseId = options.caseId ?? DEMO_CASE_ID;
  const bindEscapeKey = options.bindEscapeKey ?? true;

  const adapterRef = useRef<AccessFormVoiceAdapter | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);

  const [session, setSession] = useState<VoiceSession | null>(null);
  const [state, setState] = useState<VoiceState>('ended');
  const [starting, setStarting] = useState(false);
  const [simulated, setSimulated] = useState(true);
  const [runtime, setRuntime] = useState<VoiceRuntimeConfig | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [toolCalls, setToolCalls] = useState<VoiceToolCall[]>([]);
  const [progress, setProgress] = useState<CaseProgress | null>(null);
  const [completeness, setCompleteness] = useState<CompletenessSummary | null>(null);
  const [lastSavedAnswer, setLastSavedAnswer] = useState<LiveFormState | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Which runtime we will use, resolved once so the UI can say so up front. */
  useEffect(() => {
    let cancelled = false;
    void fetchVoiceRuntimeConfig().then((config) => {
      if (cancelled) return;
      setRuntime(config);
      setSimulated(options.simulated || config.simulationOnly);
    });
    return () => {
      cancelled = true;
    };
  }, [options.simulated]);

  const handleEvent = useCallback((event: VoiceStreamEvent) => {
    switch (event.kind) {
      case 'state':
        setState(event.state);
        break;
      case 'transcript':
        setTranscript((current) => {
          const withoutDraft = current.filter(
            (turn) => turn.final || turn.speaker !== event.turn.speaker,
          );
          const next = [...withoutDraft, event.turn];
          return next.length > MAX_TRANSCRIPT_TURNS
            ? next.slice(next.length - MAX_TRANSCRIPT_TURNS)
            : next;
        });
        break;
      case 'case_event':
        setEvents((current) =>
          current.some((existing) => existing.id === event.event.id)
            ? current
            : [...current, event.event],
        );
        break;
      case 'tool_call':
        setToolCalls((current) => [...current, event.call]);
        break;
      case 'tool_result':
        break;
      case 'progress':
        setProgress(event.progress);
        break;
      case 'completeness':
        setCompleteness(event.summary);
        break;
      case 'form_state':
        setLastSavedAnswer(event.formState);
        break;
      case 'error':
        setError(event.message);
        break;
    }
  }, []);

  const teardown = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    startedRef.current = false;
    if (adapter) void adapter.end().catch(() => undefined);
  }, []);

  const attach = useCallback(
    (adapter: AccessFormVoiceAdapter) => {
      unsubscribeRef.current?.();
      adapterRef.current = adapter;
      unsubscribeRef.current = adapter.subscribe(handleEvent);
      setSimulated(adapter.simulated);
    },
    [handleEvent],
  );

  const start = useCallback(async () => {
    if (startedRef.current || starting) return;
    setStarting(true);
    setError(null);
    startedRef.current = true;
    try {
      const adapter = await createVoiceAdapter({
        caseId,
        simulated: options.simulated,
        config: runtime ?? undefined,
      });
      attach(adapter);
      setSession(await adapter.start({ caseId, simulated: adapter.simulated }));
    } catch (liveError) {
      // A live call that will not start must never end the demo: fall back to
      // the scripted conversation and say so.
      console.warn('[voice] live session unavailable, replaying the script:', liveError);
      setError('Live voice is unavailable — replaying the recorded conversation.');
      const fallback = await createVoiceAdapter({ caseId, simulated: true });
      attach(fallback);
      setSession(await fallback.start({ caseId, simulated: true }));
    } finally {
      setStarting(false);
    }
  }, [attach, caseId, options.simulated, runtime, starting]);

  const pause = useCallback(async () => {
    await adapterRef.current?.pause();
  }, []);

  const resume = useCallback(async () => {
    await adapterRef.current?.resume();
  }, []);

  const end = useCallback(async () => {
    await adapterRef.current?.end();
    startedRef.current = false;
  }, []);

  const reset = useCallback(() => {
    teardown();
    setSession(null);
    setState('ended');
    setTranscript([]);
    setEvents([]);
    setToolCalls([]);
    setProgress(null);
    setCompleteness(null);
    setLastSavedAnswer(null);
    setError(null);
  }, [teardown]);

  /* Auto-start. */
  useEffect(() => {
    if (!options.autoStart || startedRef.current) return;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.autoStart]);

  /* Escape pauses, and resumes again. */
  useEffect(() => {
    if (!bindEscapeKey || typeof window === 'undefined') return;
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || !adapterRef.current) return;
      const current = adapterRef.current.getState();
      if (current === 'ended') return;
      keyEvent.preventDefault();
      void (current === 'paused' ? resume() : pause());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bindEscapeKey, pause, resume]);

  /* Stop the call if the screen unmounts. */
  useEffect(() => teardown, [teardown]);

  const progressAnnouncement = useMemo(() => {
    if (!progress) return '';
    const activeStep = progress.steps.find((step) => step.state === 'active');
    const stepText = activeStep ? `Now on ${activeStep.label}.` : 'All sections answered.';
    return `${progress.percent}% complete. ${progress.answersSaved} of ${progress.answersExpected} answers saved. ${stepText}`;
  }, [progress]);

  return {
    session,
    caseId,
    state,
    stateLabel: VOICE_STATE_LABELS[state],
    active: state !== 'ended',
    starting,
    simulated,
    runtime,
    transcript,
    events,
    toolCalls,
    progress,
    progressAnnouncement,
    completeness,
    missingRequirements: completeness?.missingRequirements ?? [],
    lastSavedAnswer,
    error,
    start,
    pause,
    resume,
    end,
    reset,
  };
}
