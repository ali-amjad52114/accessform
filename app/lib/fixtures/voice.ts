/**
 * Deterministic voice adapter.
 *
 * Replays the scripted Jane call and drives the real fixture Xano / SerpApi /
 * Nutrient adapters as it goes, so the store genuinely walks from an empty case
 * to `READY_FOR_REVIEW` with 26 answers, two missing requirements and a
 * generated, accessibility-processed document — with zero network.
 *
 * It emits the same `VoiceEvent` stream a live Vapi session would, so /live can
 * be written once against this and swapped to the real transport later.
 */

import {
  DEMO_CASE,
  DEMO_CASE_ID,
  DEMO_HOSPITAL,
  VAPI_TOOL_NAMES,
  type CaseEvent,
  type Id,
  type NutrientAdapter,
  type SerpAdapter,
  type StartVoiceSessionOptions,
  type TranscriptTurn,
  type VapiToolName,
  type VoiceAdapter,
  type VoiceEvent,
  type VoiceSession,
  type VoiceSpeaker,
  type VoiceState,
  type XanoAdapter,
} from '../contract';
import { FIXTURE_FORM_SCHEMA } from './form-schema';
import { delay, FIXTURE_LATENCY } from './latency';
import { fixtureNutrientAdapter } from './nutrient';
import { fixtureSerpAdapter } from './serp';
import {
  fixtureXanoAdapter,
  markFixtureMilestone,
  peekEvents,
  resetFixtureStore,
} from './xano';
import {
  AFTER_DISCOVERY,
  ANSWER_VALUES,
  CLOSING,
  DOCUMENTS_SECTION,
  OPENING,
  SECTION_INTROS,
  SPOKEN_ANSWERS,
  speakingTimeMs,
  type ScriptedTurn,
} from './transcript';

class Cancelled extends Error {
  constructor() {
    super('voice session cancelled');
    this.name = 'Cancelled';
  }
}

interface PauseGate {
  promise: Promise<void>;
  release: () => void;
}

export interface FixtureVoiceAdapterOptions {
  xano?: XanoAdapter;
  serp?: SerpAdapter;
  nutrient?: NutrientAdapter;
  /** Reset the fixture store to an empty case on `start()`. Default true. */
  resetStore?: boolean;
}

export class FixtureVoiceAdapter implements VoiceAdapter {
  private readonly xano: XanoAdapter;
  private readonly serp: SerpAdapter;
  private readonly nutrient: NutrientAdapter;
  private readonly resetStore: boolean;

  private listeners = new Set<(event: VoiceEvent) => void>();
  private voiceState: VoiceState = 'ended';
  private session: VoiceSession | null = null;
  private pauseGate: PauseGate | null = null;
  private cancelled = false;
  private running: Promise<void> | null = null;
  private emittedEventIds = new Set<string>();
  private turnSeq = 0;
  private callSeq = 0;

  constructor(options: FixtureVoiceAdapterOptions = {}) {
    this.xano = options.xano ?? fixtureXanoAdapter;
    this.serp = options.serp ?? fixtureSerpAdapter;
    this.nutrient = options.nutrient ?? fixtureNutrientAdapter;
    this.resetStore = options.resetStore ?? true;
  }

  /* ---------------------------------------------------------------- */
  /* VoiceAdapter                                                      */
  /* ---------------------------------------------------------------- */

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): VoiceState {
    return this.voiceState;
  }

  async start(options: StartVoiceSessionOptions = {}): Promise<VoiceSession> {
    await this.end();

    this.cancelled = false;
    this.pauseGate = null;
    this.emittedEventIds.clear();
    this.turnSeq = 0;
    this.callSeq = 0;
    if (this.resetStore) resetFixtureStore('empty');

    const session: VoiceSession = {
      sessionId: `sim_${Date.now().toString(36)}`,
      caseId: options.caseId ?? DEMO_CASE_ID,
      simulated: true,
      startedAt: new Date().toISOString(),
    };
    this.session = session;
    this.setState('thinking');

    this.running = this.run(session.caseId).catch((error) => {
      if (error instanceof Cancelled) return;
      this.emit({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      this.setState('ended');
    });

    return session;
  }

  async pause(): Promise<void> {
    if (this.pauseGate || this.voiceState === 'ended') return;
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pauseGate = { promise, release };
    this.setState('paused');
  }

  async resume(): Promise<void> {
    const gate = this.pauseGate;
    if (!gate) return;
    this.pauseGate = null;
    gate.release();
    this.setState('thinking');
  }

  async end(): Promise<void> {
    this.cancelled = true;
    if (this.pauseGate) {
      this.pauseGate.release();
      this.pauseGate = null;
    }
    const running = this.running;
    this.running = null;
    if (running) await running;
    this.session = null;
    if (this.voiceState !== 'ended') this.setState('ended');
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private emit(event: VoiceEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never stop the call.
      }
    }
  }

  private setState(next: VoiceState): void {
    if (this.voiceState === next) return;
    this.voiceState = next;
    this.emit({ kind: 'state', state: next });
  }

  /** Await any pause, and abort if the session was ended. */
  private async checkpoint(): Promise<void> {
    while (this.pauseGate) {
      await this.pauseGate.promise;
      if (this.cancelled) throw new Cancelled();
    }
    if (this.cancelled) throw new Cancelled();
  }

  private async wait(ms: number): Promise<void> {
    await this.checkpoint();
    await delay(ms);
    await this.checkpoint();
  }

  private turn(speaker: VoiceSpeaker, text: string, final: boolean): TranscriptTurn {
    if (final) this.turnSeq += 1;
    return {
      id: `turn_${String(this.turnSeq || 1).padStart(3, '0')}${final ? '' : '_partial'}`,
      speaker,
      text,
      timestamp: new Date().toISOString(),
      final,
    };
  }

  /** Speak one line: state change, an interim transcript, then the final turn. */
  private async say(speaker: VoiceSpeaker, text: string): Promise<void> {
    const duration = speakingTimeMs(text);
    this.setState(speaker === 'agent' ? 'speaking' : 'listening');

    const breakpoint = Math.max(1, Math.floor(text.length * 0.55));
    const interim = text.slice(0, breakpoint).trimEnd();
    await this.wait(Math.round(duration * 0.55));
    this.emit({ kind: 'transcript', turn: this.turn(speaker, interim, false) });

    await this.wait(Math.round(duration * 0.45));
    this.emit({ kind: 'transcript', turn: this.turn(speaker, text, true) });
  }

  private async playTurns(turns: readonly ScriptedTurn[]): Promise<void> {
    for (const turn of turns) {
      await this.say(turn.speaker, turn.text);
      await this.wait(250);
    }
  }

  /** Run a tool, emitting the call, the result, and any events it produced. */
  private async tool<T>(
    caseId: Id,
    name: VapiToolName,
    args: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    await this.checkpoint();
    this.callSeq += 1;
    const callId = `call_${String(this.callSeq).padStart(3, '0')}`;
    this.setState('thinking');
    this.emit({ kind: 'tool_call', call: { id: callId, name, args } });

    try {
      const result = await run();
      this.emit({ kind: 'tool_result', callId, name, ok: true });
      this.flushCaseEvents(caseId);
      return result;
    } catch (error) {
      this.emit({ kind: 'tool_result', callId, name, ok: false });
      this.flushCaseEvents(caseId);
      throw error;
    }
  }

  /** Emit every store event not yet streamed to subscribers. */
  private flushCaseEvents(caseId: Id): void {
    for (const event of peekEvents(caseId)) {
      if (this.emittedEventIds.has(event.id)) continue;
      this.emittedEventIds.add(event.id);
      this.emit({ kind: 'case_event', event });
    }
  }

  private async announce(caseId: Id, event: Omit<CaseEvent, 'id' | 'case_id' | 'timestamp'>): Promise<void> {
    await this.xano.appendEvent(caseId, event);
    this.flushCaseEvents(caseId);
  }

  private async run(caseId: Id): Promise<void> {
    /* 1. Greeting and the two facts we need before anything else. */
    await this.playTurns(OPENING);

    /* 2. Create the case. */
    await this.tool(
      caseId,
      'create_case',
      {
        patient_display_name: DEMO_CASE.patient_display_name,
        hospital_name: DEMO_HOSPITAL.name,
        bill_amount: DEMO_CASE.bill_amount,
      },
      () =>
        this.xano.createCase({
          patient_display_name: DEMO_CASE.patient_display_name,
          hospital_name: DEMO_HOSPITAL.name,
          bill_amount: DEMO_CASE.bill_amount,
        }),
    );

    /* 3. Discover the official program via SerpApi, and persist it. */
    const discovery = await this.tool(
      caseId,
      'discover_program',
      { hospital: DEMO_HOSPITAL.name, intent: 'financial_assistance', location: 'California' },
      () =>
        this.serp.discoverProgram({
          hospital: DEMO_HOSPITAL.name,
          intent: 'financial_assistance',
          location: 'California',
        }),
    );

    await this.announce(caseId, {
      actor: 'serpapi',
      event_type: 'program_discovered',
      message: 'Official Cedars program found',
      metadata_json: { policy_url: discovery.policy_url },
    });
    await this.announce(caseId, {
      actor: 'serpapi',
      event_type: 'source_verified',
      message: 'HCAI source verified',
      metadata_json: {
        source_domain: discovery.verified_sources[0]?.source_domain ?? 'hcai.ca.gov',
        verified_sources: discovery.verified_sources.length,
      },
    });

    await this.xano.saveDiscoveredProgram(discovery);
    markFixtureMilestone(caseId, 'program_found');
    this.flushCaseEvents(caseId);

    /* 4. Extract the real form structure. */
    const extracted = await this.nutrient.extractFormStructure({
      pdfUrl: discovery.application_url,
    });
    await this.xano.saveDocument(caseId, {
      type: 'source_application',
      source_url: discovery.application_url,
      accessibility_status: 'not_applicable',
    });
    markFixtureMilestone(caseId, 'form_extracted');
    await this.announce(caseId, {
      actor: 'nutrient',
      event_type: 'form_extracted',
      message: 'Form structure extracted',
      metadata_json: { fields: extracted.fields.length, pages: extracted.pageCount },
    });

    await this.playTurns(AFTER_DISCOVERY);

    /* 5. Walk the 26 questions. */
    for (const field of FIXTURE_FORM_SCHEMA) {
      const intro = SECTION_INTROS[field.field_id];
      if (intro) {
        await this.say('agent', intro);
        await this.wait(300);
      }

      await this.say('agent', field.conversational_prompt);
      await this.wait(400);

      const spoken = SPOKEN_ANSWERS[field.field_id] ?? 'Yes.';
      await this.say('patient', spoken);

      const value = ANSWER_VALUES[field.field_id] ?? null;
      await this.tool(
        caseId,
        'save_answer',
        { case_id: caseId, field_id: field.field_id, value, source: 'voice', confirmed: true },
        () =>
          this.xano.saveAnswer(caseId, field.field_id, {
            value,
            source: 'voice',
            confirmed: true,
          }),
      );

      await this.tool(caseId, 'get_case_progress', { case_id: caseId }, () =>
        this.xano.getCaseProgress(caseId),
      );
      await this.wait(200);
    }

    /* 6. Documents — the deliberately missing evidence. */
    await this.playTurns(DOCUMENTS_SECTION);

    await this.tool(caseId, 'validate_case', { case_id: caseId }, () =>
      this.xano.validateCase(caseId),
    );

    /* 7. Fill, autotag, persist. */
    await this.tool(
      caseId,
      'finalize_document',
      { case_id: caseId, source_url: discovery.application_url },
      () =>
        this.nutrient.finalizeDocument({
          case_id: caseId,
          source_url: discovery.application_url,
        }),
    );
    this.flushCaseEvents(caseId);

    /* 8. Re-validate so the case lands on READY_FOR_REVIEW. */
    await this.tool(caseId, 'validate_case', { case_id: caseId }, () =>
      this.xano.validateCase(caseId),
    );

    await this.wait(FIXTURE_LATENCY.xanoRead);

    /* 9. Close out, stating exactly what remains. */
    await this.playTurns(CLOSING);
    this.flushCaseEvents(caseId);
    this.setState('ended');
  }
}

export const fixtureVoiceAdapter: VoiceAdapter = new FixtureVoiceAdapter();

/** Tool names the scripted call exercises — all six. */
export const SIMULATED_TOOL_NAMES: readonly VapiToolName[] = VAPI_TOOL_NAMES;
