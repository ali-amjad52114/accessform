/**
 * The simulated voice adapter.
 *
 * Replays `SIMULATION_SCRIPT` beat by beat and emits exactly the same stream
 * of events the live Vapi adapter emits, so /live cannot tell the difference.
 * It runs entirely in the browser tab: no network, no microphone, no
 * telephony — which is what makes the demo unbreakable.
 */

import {
  CEDARS_APPLICATION_FIELD_COUNT,
  CEDARS_APPLICATION_PDF_URL,
  CEDARS_POLICY_URL,
  DEMO_CASE_ID,
  DEMO_FILLED_PDF_PATH,
  DEMO_HOSPITAL,
  DEMO_PROGRAM,
  type Answer,
  type CaseBundle,
  type CaseEvent,
  type Id,
  type StartVoiceSessionOptions,
  type VapiToolName,
  type VoiceSession,
  type VoiceState,
} from '../contract';
import {
  computeCompleteness,
  computeProgress,
  defaultRequirements,
  READY_FOR_REVIEW_PERCENT,
} from './case-store';
import { formatFieldValue, resolveField, scriptedValue } from './form-plan';
import { SIMULATION_SCRIPT, beatDelayMs, type ScriptBeat } from './script';
import {
  VoiceEventBus,
  newSessionId,
  type AccessFormVoiceAdapter,
  type VoiceStreamEvent,
} from './types';

export interface SimulationOptions {
  /** 1 = real time. 2 = twice as fast. Read from NEXT_PUBLIC_VOICE_SIM_SPEED. */
  speedFactor?: number;
  caseId?: Id;
}

function envSpeedFactor(): number {
  const raw = process.env.NEXT_PUBLIC_VOICE_SIM_SPEED;
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function emptyBundle(caseId: Id): CaseBundle {
  const timestamp = new Date().toISOString();
  return {
    case: {
      id: caseId,
      patient_display_name: 'Jane Doe',
      hospital_id: DEMO_HOSPITAL.id,
      program_id: null,
      bill_amount: 7800,
      status: 'CREATED',
      progress_percent: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
    hospital: { ...DEMO_HOSPITAL },
    program: null,
    answers: [],
    requirements: [],
    documents: [],
    events: [],
  };
}

export function createSimulatedVoiceAdapter(
  options: SimulationOptions = {},
): AccessFormVoiceAdapter {
  const bus = new VoiceEventBus();
  const speed = options.speedFactor ?? envSpeedFactor();

  let caseId: Id = options.caseId ?? DEMO_CASE_ID;
  let bundle = emptyBundle(caseId);
  let state: VoiceState = 'ended';
  let index = 0;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let session: VoiceSession | null = null;

  const nextId = (prefix: string) => {
    sequence += 1;
    return `sim_${prefix}_${sequence}`;
  };

  const emit = (event: VoiceStreamEvent) => bus.emit(event);

  const setState = (next: VoiceState) => {
    state = next;
    emit({ kind: 'state', state: next });
  };

  const emitProgress = () => {
    bundle.case.progress_percent = computeProgress(bundle).percent;
    emit({ kind: 'progress', progress: computeProgress(bundle) });
  };

  const pushEvent = (
    actor: CaseEvent['actor'],
    eventType: string,
    message: string,
    metadata: Record<string, unknown> | null = null,
  ) => {
    const record: CaseEvent = {
      id: nextId('evt'),
      case_id: caseId,
      timestamp: new Date().toISOString(),
      actor,
      event_type: eventType,
      message,
      metadata_json: metadata,
    };
    bundle.events.push(record);
    emit({ kind: 'case_event', event: record });
  };

  const applySave = (fieldId: string) => {
    const field = resolveField(fieldId);
    if (!field) return;
    const value = scriptedValue(field.fieldId);
    const answer: Answer = {
      id: nextId('ans'),
      case_id: caseId,
      field_id: field.fieldId,
      value_json: value,
      source: 'voice',
      confirmed: true,
      updated_at: new Date().toISOString(),
    };
    bundle.answers = [
      ...bundle.answers.filter((existing) => existing.field_id !== field.fieldId),
      answer,
    ];
    if (bundle.case.status === 'CREATED' || bundle.case.status === 'FORM_FOUND') {
      bundle.case.status = 'INTERVIEWING';
    }

    const displayValue = formatFieldValue(field, value);
    emit({
      kind: 'form_state',
      formState: {
        fieldId: field.fieldId,
        normalizedKey: field.normalizedKey,
        label: field.label,
        displayValue,
        savedToXano: true,
        savedAt: answer.updated_at,
      },
    });
    pushEvent(
      'xano',
      'answer_saved',
      field.step === 'household'
        ? 'Household answer saved'
        : field.step === 'income'
          ? 'Income answer saved'
          : field.step === 'insurance'
            ? 'Insurance answer saved'
            : 'Personal detail saved',
      { field_id: field.fieldId, normalized_key: field.normalizedKey, display_value: displayValue },
    );
    emitProgress();
  };

  const applyToolEffect = (name: VapiToolName) => {
    switch (name) {
      case 'create_case': {
        bundle.case.status = 'DISCOVERING';
        pushEvent('xano', 'case_created', 'Case created', {
          case_id: caseId,
          bill_amount: bundle.case.bill_amount,
        });
        break;
      }
      case 'discover_program': {
        bundle.program = { ...DEMO_PROGRAM };
        bundle.case.program_id = DEMO_PROGRAM.id;
        bundle.case.status = 'FORM_FOUND';
        bundle.documents = [
          ...bundle.documents,
          {
            id: nextId('doc'),
            case_id: caseId,
            type: 'source_application',
            source_url: CEDARS_APPLICATION_PDF_URL,
            generated_url: null,
            accessibility_status: 'not_applicable',
            version_hash: null,
          },
        ];
        pushEvent('serpapi', 'program_discovered', 'Official Cedars program found', {
          policy_url: CEDARS_POLICY_URL,
        });
        pushEvent('serpapi', 'source_verified', 'HCAI source verified', {
          source_domain: 'hcai.ca.gov',
          application_url: CEDARS_APPLICATION_PDF_URL,
        });
        pushEvent('nutrient', 'form_extracted', 'Form structure extracted', {
          fields: CEDARS_APPLICATION_FIELD_COUNT,
        });
        break;
      }
      case 'validate_case': {
        if (bundle.requirements.length === 0) {
          bundle.requirements = defaultRequirements(caseId, nextId);
        }
        bundle.case.status = 'VALIDATING';
        pushEvent('xano', 'missing_requirement_detected', 'Missing proof of income detected', {
          key: 'proof_of_social_security_income',
        });
        emit({ kind: 'completeness', summary: computeCompleteness(bundle) });
        break;
      }
      case 'finalize_document': {
        bundle.documents = [
          ...bundle.documents,
          {
            id: nextId('doc'),
            case_id: caseId,
            type: 'filled_application',
            source_url: CEDARS_APPLICATION_PDF_URL,
            generated_url: DEMO_FILLED_PDF_PATH,
            accessibility_status: 'processed',
            version_hash: `sim-${caseId.toLowerCase()}-v1`,
          },
        ];
        bundle.case.status = 'READY_FOR_REVIEW';
        bundle.case.progress_percent = READY_FOR_REVIEW_PERCENT;
        pushEvent('nutrient', 'document_generated', 'Completed PDF generated', {
          fields_filled: bundle.answers.length,
        });
        pushEvent('nutrient', 'accessibility_processed', 'Accessibility processing complete', {
          accessibility_status: 'processed',
        });
        emit({ kind: 'completeness', summary: computeCompleteness(bundle) });
        break;
      }
      case 'save_answer':
      case 'get_case_progress':
        break;
    }
  };

  const runBeat = (beat: ScriptBeat) => {
    switch (beat.kind) {
      case 'state':
        setState(beat.state);
        break;
      case 'say':
        emit({
          kind: 'transcript',
          turn: {
            id: nextId('turn'),
            speaker: beat.speaker,
            text: beat.text,
            timestamp: new Date().toISOString(),
            final: true,
          },
        });
        break;
      case 'save':
        applySave(beat.fieldId);
        break;
      case 'tool': {
        const callId = nextId('call');
        emit({ kind: 'tool_call', call: { id: callId, name: beat.name, args: beat.args } });
        applyToolEffect(beat.name);
        emit({ kind: 'tool_result', callId, name: beat.name, ok: true });
        emitProgress();
        break;
      }
    }
  };

  const schedule = () => {
    if (!running || index >= SIMULATION_SCRIPT.length) return;
    const beat = SIMULATION_SCRIPT[index];
    const delay = Math.max(60, beatDelayMs(beat) / speed);
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      index += 1;
      runBeat(beat);
      if (index >= SIMULATION_SCRIPT.length) {
        running = false;
        if (state !== 'ended') setState('ended');
        return;
      }
      schedule();
    }, delay);
  };

  const stopTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    simulated: true,

    async start(startOptions?: StartVoiceSessionOptions): Promise<VoiceSession> {
      stopTimer();
      caseId = startOptions?.caseId ?? options.caseId ?? DEMO_CASE_ID;
      bundle = emptyBundle(caseId);
      index = 0;
      sequence = 0;
      running = true;
      session = {
        sessionId: newSessionId('sim'),
        caseId,
        simulated: true,
        startedAt: new Date().toISOString(),
      };
      // The session is live from this moment: report a state before the first
      // beat lands, so the screen never shows "Call ended" on a started call.
      setState('thinking');
      pushEvent('user', 'call_started', 'Call started', { simulated: true });
      emitProgress();
      schedule();
      return session;
    },

    async pause(): Promise<void> {
      if (!running) return;
      running = false;
      stopTimer();
      setState('paused');
    },

    async resume(): Promise<void> {
      if (running || index >= SIMULATION_SCRIPT.length) return;
      running = true;
      setState('listening');
      schedule();
    },

    async end(): Promise<void> {
      running = false;
      stopTimer();
      if (state !== 'ended') setState('ended');
    },

    getState(): VoiceState {
      return state;
    },

    subscribe(listener: (event: VoiceStreamEvent) => void): () => void {
      return bus.subscribe(listener);
    },
  };
}
