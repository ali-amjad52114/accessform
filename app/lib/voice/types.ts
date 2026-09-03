/**
 * Voice-layer types.
 *
 * Everything here is a *superset* of the shared contract: the contract's
 * `VoiceEvent` / `VoiceAdapter` remain the public shape, and this module adds
 * the three extra stream events /live needs (authoritative progress, the
 * completeness summary, and the "live form state" row from the mockup).
 *
 * `asVoiceAdapter()` narrows an AccessForm adapter back down to the plain
 * contract adapter, which proves the superset relationship at compile time.
 */

import type {
  CaseProgress,
  CompletenessSummary,
  Id,
  StartVoiceSessionOptions,
  VoiceAdapter,
  VoiceEvent,
  VoiceSession,
  VoiceState,
} from '../contract';

/**
 * The "Live form state" row on /live: the answer that was most recently
 * written to Xano, ready to render as
 * `annual_household_income   $24,600   saved to Xano`.
 */
export interface LiveFormState {
  /** Exact AcroForm field name. */
  fieldId: string;
  /** snake_case key shown in the mockup. */
  normalizedKey: string;
  /** Human label, for screen readers. */
  label: string;
  /** Already formatted for display — currency carries its "$". */
  displayValue: string;
  /** True once Xano acknowledged the write. */
  savedToXano: boolean;
  savedAt: string;
}

/** Contract `VoiceEvent`, plus the three AccessForm-specific stream events. */
export type VoiceStreamEvent =
  | VoiceEvent
  | { kind: 'progress'; progress: CaseProgress }
  | { kind: 'completeness'; summary: CompletenessSummary }
  | { kind: 'form_state'; formState: LiveFormState };

/** The stream events that are also contract `VoiceEvent`s. */
const CONTRACT_EVENT_KINDS: ReadonlySet<string> = new Set([
  'state',
  'transcript',
  'tool_call',
  'tool_result',
  'case_event',
  'error',
]);

export function isContractVoiceEvent(event: VoiceStreamEvent): event is VoiceEvent {
  return CONTRACT_EVENT_KINDS.has(event.kind);
}

/**
 * Same lifecycle as the contract's `VoiceAdapter`, with a widened `subscribe`.
 */
export interface AccessFormVoiceAdapter {
  start(options?: StartVoiceSessionOptions): Promise<VoiceSession>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  end(): Promise<void>;
  getState(): VoiceState;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: VoiceStreamEvent) => void): () => void;
  /** True when this adapter replays the scripted conversation. */
  readonly simulated: boolean;
}

/** Narrow an AccessForm adapter to the plain contract adapter. */
export function asVoiceAdapter(adapter: AccessFormVoiceAdapter): VoiceAdapter {
  return {
    start: (options) => adapter.start(options),
    pause: () => adapter.pause(),
    resume: () => adapter.resume(),
    end: () => adapter.end(),
    getState: () => adapter.getState(),
    subscribe: (listener: (event: VoiceEvent) => void) =>
      adapter.subscribe((event) => {
        if (isContractVoiceEvent(event)) listener(event);
      }),
  };
}

/** Minimal event bus shared by the simulated and live adapters. */
export class VoiceEventBus {
  private listeners = new Set<(event: VoiceStreamEvent) => void>();

  subscribe(listener: (event: VoiceStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: VoiceStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a broken subscriber must never stop the call */
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface VoiceSessionIdentity {
  sessionId: string;
  caseId: Id;
  startedAt: string;
}

let sessionCounter = 0;

export function newSessionId(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${sessionCounter}`;
}
