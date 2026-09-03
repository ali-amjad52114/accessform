'use client';

/**
 * useVoiceSession — the only thing /live needs to import.
 *
 * One hook drives both paths (live Vapi call, or the deterministic Jane
 * script) and exposes plain state: voice state, transcript, progress, the
 * sponsor-visibility event feed, the live form row, the program the case was
 * matched to, and the completeness summary. Nothing here recomputes
 * completeness — the numbers come from the adapter, which gets them from Xano.
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
  type CaseBundle,
  type CaseEvent,
  type CaseProgress,
  type CompletenessSummary,
  type FormKind,
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

/** The program a case has been matched to, as far as the browser knows. */
export interface MatchedProgram {
  name: string;
  /** Organization the program belongs to; null when not yet known. */
  organization: string | null;
  formKind: FormKind | null;
}

export interface UseVoiceSessionResult {
  /** null until `start()` has been called. */
  session: VoiceSession | null;
  caseId: Id;
  /**
   * The case the assistant is actually working on. On a live call the
   * assistant opens its own case, so this is the id carried by the latest
   * tool call; in the script it is the demo case.
   */
  activeCaseId: Id | null;
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
  /** Section label of the last saved answer, when known. */
  lastSavedSection: string | null;
  /** Null until discover_program has matched a verified program. */
  program: MatchedProgram | null;

  error: string | null;

  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  end: () => Promise<void>;
  /** Clears the transcript/feed so the demo can be run again. */
  reset: () => void;
}

const MAX_TRANSCRIPT_TURNS = 200;

/** Tools after which the case's program may have changed on the server. */
const PROGRAM_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  'discover_program',
  'finalize_document',
  'validate_case',
]);

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function programFromBundle(bundle: Partial<CaseBundle> | undefined): MatchedProgram | null {
  const program = bundle?.program;
  if (!program || !program.name) return null;
  const organization =
    bundle?.organization?.name || (bundle?.hospital?.name ? bundle.hospital.name : null);
  return {
    name: program.name,
    organization: organization || null,
    formKind: program.form_kind ?? null,
  };
}

export function useVoiceSession(options: UseVoiceSessionOptions = {}): UseVoiceSessionResult {
  const caseId = options.caseId ?? DEMO_CASE_ID;
  const bindEscapeKey = options.bindEscapeKey ?? true;

  const adapterRef = useRef<AccessFormVoiceAdapter | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);
  const progressRef = useRef<CaseProgress | null>(null);
  const activeCaseRef = useRef<Id | null>(null);
  const simulatedRef = useRef(true);

  const [session, setSession] = useState<VoiceSession | null>(null);
  const [state, setState] = useState<VoiceState>('ended');
  const [starting, setStarting] = useState(false);
  const [simulated, setSimulated] = useState(true);
  const [runtime, setRuntime] = useState<VoiceRuntimeConfig | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [toolCalls, setToolCalls] = useState<VoiceToolCall[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<Id | null>(null);
  const [progress, setProgress] = useState<CaseProgress | null>(null);
  const [completeness, setCompleteness] = useState<CompletenessSummary | null>(null);
  const [lastSavedAnswer, setLastSavedAnswer] = useState<LiveFormState | null>(null);
  const [lastSavedSection, setLastSavedSection] = useState<string | null>(null);
  const [program, setProgram] = useState<MatchedProgram | null>(null);
  const [error, setError] = useState<string | null>(null);

  simulatedRef.current = simulated;

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

  /**
   * On a live call the program name lives in Xano, not in the event stream:
   * read the case bundle once a program-changing tool has run.
   */
  const readProgramFromServer = useCallback(async (id: Id) => {
    try {
      const response = await fetch(`/api/voice/case/${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { bundle?: Partial<CaseBundle> };
      const matched = programFromBundle(payload.bundle);
      if (matched) setProgram(matched);
    } catch {
      /* the title simply stays "Your call" until the next read */
    }
  }, []);

  const handleEvent = useCallback(
    (event: VoiceStreamEvent) => {
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
        case 'case_event': {
          const record = event.event;
          setEvents((current) =>
            current.some((existing) => existing.id === record.id) ? current : [...current, record],
          );
          if (record.event_type === 'program_discovered') {
            const name = metadataString(record.metadata_json, 'program_name');
            if (name) {
              const formKind = metadataString(record.metadata_json, 'form_kind') as FormKind | null;
              setProgram({
                name,
                organization: metadataString(record.metadata_json, 'organization_name'),
                formKind,
              });
            }
          }
          if (record.event_type === 'answer_saved') {
            const label =
              metadataString(record.metadata_json, 'section_label') ??
              metadataString(record.metadata_json, 'section');
            if (label) setLastSavedSection(label);
          }
          break;
        }
        case 'tool_call': {
          setToolCalls((current) => [...current, event.call]);
          const id = event.call.args.case_id;
          if (typeof id === 'string' && id) {
            activeCaseRef.current = id;
            setActiveCaseId(id);
          }
          break;
        }
        case 'tool_result': {
          const id = activeCaseRef.current;
          if (!simulatedRef.current && id && PROGRAM_CHANGING_TOOLS.has(event.name)) {
            void readProgramFromServer(id);
          }
          break;
        }
        case 'progress':
          progressRef.current = event.progress;
          setProgress(event.progress);
          break;
        case 'completeness':
          setCompleteness(event.summary);
          break;
        case 'form_state': {
          setLastSavedAnswer(event.formState);
          /* Best guess until the answer_saved event names the section. */
          const current = progressRef.current;
          const active =
            current?.sections?.find((section) => section.state === 'active') ??
            current?.steps.find((step) => step.state === 'active');
          setLastSavedSection(active?.label ?? null);
          break;
        }
        case 'error':
          setError(event.message);
          break;
      }
    },
    [readProgramFromServer],
  );

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
      simulatedRef.current = adapter.simulated;
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
    progressRef.current = null;
    activeCaseRef.current = null;
    setSession(null);
    setState('ended');
    setTranscript([]);
    setEvents([]);
    setToolCalls([]);
    setActiveCaseId(null);
    setProgress(null);
    setCompleteness(null);
    setLastSavedAnswer(null);
    setLastSavedSection(null);
    setProgram(null);
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
    const sections = progress.sections ?? [];
    const activeSection = sections.find((section) => section.state === 'active');
    const activeStep = progress.steps.find((step) => step.state === 'active');
    let stepText: string;
    if (activeSection) {
      stepText = `Now on ${activeSection.label}: ${activeSection.answered_count} of ${activeSection.field_count} answered.`;
    } else if (activeStep) {
      stepText = `Now on ${activeStep.label}.`;
    } else {
      stepText = 'All sections answered.';
    }
    return `${progress.percent}% complete. ${progress.answersSaved} of ${progress.answersExpected} answers saved. ${stepText}`;
  }, [progress]);

  return {
    session,
    caseId,
    activeCaseId,
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
    lastSavedSection,
    program,
    error,
    start,
    pause,
    resume,
    end,
    reset,
  };
}
