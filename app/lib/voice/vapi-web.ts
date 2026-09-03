/**
 * The live browser voice adapter (Vapi Web SDK).
 *
 * The SDK is loaded at runtime from a CDN module URL rather than bundled, so
 * the voice layer adds no build-time dependency and a blocked/offline CDN
 * degrades to the scripted simulation instead of breaking the page. Override
 * the URL with NEXT_PUBLIC_VAPI_SDK_URL, or preload the SDK yourself and
 * expose it as `window.Vapi`.
 *
 * Authentication is the publishable key, NEXT_PUBLIC_VAPI_PUBLIC_KEY. The
 * private key is never referenced in browser code.
 *
 * Tool names: the assistant calls the M1 tool set (`M1_VOICE_TOOL_NAMES`);
 * the legacy six are still accepted so an older assistant keeps working.
 * `VoiceToolCall.name` is the legacy closed union in the contract and is
 * widened at this boundary by a cast (docs/M1_CONTRACT.md §4).
 */

import {
  DEMO_CASE_ID,
  M1_VOICE_TOOL_NAMES,
  VAPI_TOOL_NAMES,
  type Answer,
  type CaseEvent,
  type Id,
  type StartVoiceSessionOptions,
  type M1VoiceToolName,
  type VoiceSession,
  type VoiceState,
} from '../contract';
import {
  VoiceEventBus,
  newSessionId,
  type AccessFormVoiceAdapter,
  type VoiceStreamEvent,
} from './types';

/* ------------------------------------------------------------------ */
/* Minimal structural typing for the SDK                               */
/* ------------------------------------------------------------------ */

interface VapiClient {
  start(assistantId: string, overrides?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  setMuted(muted: boolean): void;
  on(event: string, handler: (payload: unknown) => void): void;
  removeAllListeners?: () => void;
}

type VapiConstructor = new (publicKey: string) => VapiClient;

const DEFAULT_SDK_URL = 'https://esm.sh/@vapi-ai/web@2.7.0';

/** Every tool name the browser should surface: the M1 set plus the legacy six. */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...M1_VOICE_TOOL_NAMES,
  ...VAPI_TOOL_NAMES,
]);

function isKnownToolName(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(name);
}

async function loadVapiConstructor(): Promise<VapiConstructor> {
  const scope = globalThis as unknown as { Vapi?: VapiConstructor };
  if (typeof scope.Vapi === 'function') return scope.Vapi;

  const url = process.env.NEXT_PUBLIC_VAPI_SDK_URL || DEFAULT_SDK_URL;
  const loaded: unknown = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  const module = loaded as { default?: unknown; Vapi?: unknown };
  const candidate = module.default ?? module.Vapi ?? loaded;
  if (typeof candidate !== 'function') {
    throw new Error(`Vapi Web SDK at ${url} did not export a constructor`);
  }
  return candidate as VapiConstructor;
}

/** True when this browser can actually run a live call. */
export async function browserVoiceSupported(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const media = navigator.mediaDevices;
  if (!media || typeof media.enumerateDevices !== 'function') return false;
  try {
    const devices = await media.enumerateDevices();
    return devices.some((device) => device.kind === 'audioinput');
  } catch {
    return false;
  }
}

export interface VapiWebOptions {
  publicKey: string;
  assistantId: string;
  caseId?: Id;
  /** Absolute or relative URL of GET /api/voice/case/:caseId. */
  caseEndpoint?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

interface CasePayload {
  bundle?: { answers?: Answer[] };
  progress?: unknown;
  completeness?: unknown;
  events?: CaseEvent[];
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export function createVapiWebAdapter(options: VapiWebOptions): AccessFormVoiceAdapter {
  const bus = new VoiceEventBus();
  let client: VapiClient | null = null;
  let state: VoiceState = 'ended';
  let caseId: Id = options.caseId ?? DEMO_CASE_ID;
  let sequence = 0;

  const nextId = (prefix: string) => {
    sequence += 1;
    return `live_${prefix}_${sequence}`;
  };

  const emit = (event: VoiceStreamEvent) => bus.emit(event);

  const setState = (next: VoiceState) => {
    state = next;
    emit({ kind: 'state', state: next });
  };

  /**
   * Progress is authoritative on the server, so after every tool result we
   * re-read it rather than guessing from the transcript. Returns the payload
   * so a caller can confirm a specific write landed.
   */
  const refreshCase = async (): Promise<CasePayload | null> => {
    if (caseId === DEMO_CASE_ID) return null;
    const endpoint = options.caseEndpoint ?? `/api/voice/case/${encodeURIComponent(caseId)}`;
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return null;
      const payload = (await response.json()) as CasePayload;
      if (payload.progress) {
        emit({ kind: 'progress', progress: payload.progress as never });
      }
      if (payload.completeness) {
        emit({ kind: 'completeness', summary: payload.completeness as never });
      }
      for (const event of payload.events ?? []) {
        emit({ kind: 'case_event', event });
      }
      return payload;
    } catch {
      /* the call continues even if the read fails */
      return null;
    }
  };

  /**
   * The "live form state" row for a save_answer call. The value is what the
   * assistant sent; it is marked saved only once the case read-back contains
   * the answer, so the row never claims a write Xano did not acknowledge.
   */
  const trackSave = (args: Record<string, unknown>, payloadPromise: Promise<CasePayload | null>) => {
    const fieldId = typeof args.field_id === 'string' ? args.field_id.trim() : '';
    if (!fieldId) return;
    const value = args.value === null || args.value === undefined ? '' : String(args.value);
    const base = {
      fieldId,
      normalizedKey: fieldId,
      label: fieldId,
      displayValue: value,
      savedAt: new Date().toISOString(),
    };
    emit({ kind: 'form_state', formState: { ...base, savedToXano: false } });
    void payloadPromise.then((payload) => {
      const answers = payload?.bundle?.answers ?? [];
      const saved = answers.find((answer) => answer.field_id === fieldId);
      if (!saved) return;
      emit({
        kind: 'form_state',
        formState: {
          ...base,
          displayValue: String(saved.value_json ?? value),
          savedToXano: true,
          savedAt: saved.updated_at || base.savedAt,
        },
      });
    });
  };

  const handleMessage = (payload: unknown) => {
    const message = record(payload);
    const type = typeof message.type === 'string' ? message.type : '';

    if (type === 'transcript') {
      const role = message.role === 'user' ? 'patient' : 'agent';
      const text = typeof message.transcript === 'string' ? message.transcript : '';
      if (!text) return;
      emit({
        kind: 'transcript',
        turn: {
          id: nextId('turn'),
          speaker: role,
          text,
          timestamp: new Date().toISOString(),
          final: message.transcriptType !== 'partial',
        },
      });
      return;
    }

    if (type === 'tool-calls' || type === 'function-call') {
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      const singular = record(message.functionCall);
      const entries = calls.length > 0 ? calls : singular.name ? [singular] : [];
      const saves: Record<string, unknown>[] = [];
      for (const entry of entries) {
        const item = record(entry);
        const fn = record(item.function);
        const name = typeof fn.name === 'string' ? fn.name : String(item.name ?? '');
        if (!isKnownToolName(name)) continue;
        const callId = typeof item.id === 'string' ? item.id : nextId('call');
        let args: Record<string, unknown> = {};
        const rawArgs = fn.arguments ?? item.parameters ?? item.arguments;
        if (typeof rawArgs === 'string') {
          try {
            args = record(JSON.parse(rawArgs));
          } catch {
            args = {};
          }
        } else {
          args = record(rawArgs);
        }
        if (typeof args.case_id === 'string' && args.case_id) caseId = args.case_id;
        const toolName = name as M1VoiceToolName;
        emit({ kind: 'tool_call', call: { id: callId, name: toolName, args } });
        emit({ kind: 'tool_result', callId, name: toolName, ok: true });
        if (name === 'save_answer') saves.push(args);
      }
      const readBack = refreshCase();
      for (const args of saves) trackSave(args, readBack);
    }
  };

  return {
    simulated: false,

    async start(startOptions?: StartVoiceSessionOptions): Promise<VoiceSession> {
      caseId = startOptions?.caseId ?? options.caseId ?? DEMO_CASE_ID;
      const Vapi = await loadVapiConstructor();
      const instance = new Vapi(options.publicKey);
      client = instance;

      instance.on('call-start', () => setState('listening'));
      instance.on('call-end', () => setState('ended'));
      instance.on('speech-start', () => setState('speaking'));
      instance.on('speech-end', () => setState('listening'));
      instance.on('message', handleMessage);
      instance.on('error', (payload: unknown) => {
        const message = record(payload);
        emit({
          kind: 'error',
          message:
            typeof message.message === 'string'
              ? message.message
              : 'The voice connection had a problem.',
        });
      });

      setState('thinking');
      // The assistant opens its own case with create_case. Only a real,
      // pre-existing case id is worth handing over.
      const knownCase = caseId === DEMO_CASE_ID ? undefined : caseId;
      await instance.start(options.assistantId, {
        variableValues: knownCase ? { case_id: knownCase } : {},
        metadata: { ...(knownCase ? { case_id: knownCase } : {}), product: 'accessform' },
      });

      return {
        sessionId: newSessionId('vapi'),
        caseId,
        simulated: false,
        startedAt: new Date().toISOString(),
      };
    },

    async pause(): Promise<void> {
      client?.setMuted(true);
      setState('paused');
    },

    async resume(): Promise<void> {
      client?.setMuted(false);
      setState('listening');
    },

    async end(): Promise<void> {
      try {
        client?.stop();
      } finally {
        client?.removeAllListeners?.();
        client = null;
        if (state !== 'ended') setState('ended');
      }
    },

    getState(): VoiceState {
      return state;
    },

    subscribe(listener: (event: VoiceStreamEvent) => void): () => void {
      return bus.subscribe(listener);
    },
  };
}
