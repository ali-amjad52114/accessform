/**
 * The simulated voice adapter.
 *
 * Replays `SIMULATION_SCRIPT` beat by beat and emits exactly the same stream
 * of events the live Vapi adapter emits, so /live cannot tell the difference.
 * It runs entirely in the browser tab: no network, no microphone, no
 * telephony — which is what makes the demo unbreakable.
 *
 * Demo mode is the ONE place fixtures are allowed (M1_CONTRACT §0.3/§0.5):
 * progress, sections and completeness here come from the fixture store, and
 * the send_summary step is recorded as `skipped` — never claimed as sent.
 */

import {
  CEDARS_APPLICATION_FIELD_COUNT,
  CEDARS_APPLICATION_PDF_URL,
  CEDARS_POLICY_URL,
  DEMO_CASE_ID,
  DEMO_FILLED_PDF_PATH,
  DEMO_HOSPITAL,
  DEMO_PROGRAM,
  NEED_CATEGORY_LABELS,
  PROGRESS_STEP_LABELS,
  type Answer,
  type CaseBundle,
  type CaseEvent,
  type CaseProgress,
  type Delivery,
  type Id,
  type InterviewSection,
  type M1VoiceToolName,
  type ProgressState,
  type ProgressStepId,
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
import {
  INTERVIEW_PLAN,
  formatFieldValue,
  resolveField,
  scriptedValue,
  type InterviewField,
} from './form-plan';
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

/** The interview steps that carry form fields, in asking order. */
const FIELD_STEPS: readonly ProgressStepId[] = [
  'personal_information',
  'household',
  'insurance',
  'income',
];

/** Section label for the live form row and the activity feed. */
export function sectionLabelForField(field: InterviewField): string {
  return PROGRESS_STEP_LABELS[field.step];
}

/**
 * The fixture form's sections, in the shape Xano's GET /cases/{id}/next_question
 * returns them, so demo mode exercises the same section-driven progress UI as
 * a live case. Only rendered once the form has been found.
 */
function fixtureSections(bundle: CaseBundle): InterviewSection[] {
  const answered = new Set(
    bundle.answers
      .filter((answer) => String(answer.value_json ?? '').trim() !== '')
      .map((answer) => answer.field_id),
  );
  let activeAssigned = false;
  return FIELD_STEPS.map((step, index) => {
    const fields = INTERVIEW_PLAN.filter((field) => field.step === step);
    const answeredCount = fields.filter((field) => answered.has(field.fieldId)).length;
    let state: ProgressState;
    if (answeredCount >= fields.length) {
      state = 'done';
    } else if (!activeAssigned) {
      state = 'active';
      activeAssigned = true;
    } else {
      state = 'todo';
    }
    return {
      key: step,
      label: PROGRESS_STEP_LABELS[step],
      order: index + 1,
      field_count: fields.length,
      answered_count: answeredCount,
      state,
    };
  });
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
      need_category: 'other',
      location: '',
      caller_phone: '',
      situation_text: '',
      delivery_status: 'none',
    },
    hospital: { ...DEMO_HOSPITAL },
    program: null,
    answers: [],
    requirements: [],
    documents: [],
    events: [],
    deliveries: [],
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

  const currentProgress = (): CaseProgress => {
    const progress = computeProgress(bundle);
    if (bundle.program) progress.sections = fixtureSections(bundle);
    return progress;
  };

  const emitProgress = () => {
    const progress = currentProgress();
    bundle.case.progress_percent = progress.percent;
    emit({ kind: 'progress', progress });
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
    const sectionLabel = sectionLabelForField(field);
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
    pushEvent('xano', 'answer_saved', `${sectionLabel} answer saved`, {
      field_id: field.fieldId,
      normalized_key: field.normalizedKey,
      section: field.step,
      section_label: sectionLabel,
    });
    emitProgress();
  };

  const applyToolEffect = (name: M1VoiceToolName, args: Record<string, unknown>) => {
    switch (name) {
      case 'create_case': {
        bundle.case.status = 'DISCOVERING';
        bundle.case.situation_text = typeof args.situation_text === 'string' ? args.situation_text : '';
        bundle.case.location = typeof args.location === 'string' ? args.location : '';
        pushEvent('xano', 'case_created', 'Case created', { case_id: caseId });
        break;
      }
      case 'resolve_need': {
        bundle.case.need_category = 'hospital_financial_assistance';
        pushEvent(
          'voice_agent',
          'need_resolved',
          `Need understood: ${NEED_CATEGORY_LABELS.hospital_financial_assistance}`,
          { category: 'hospital_financial_assistance', confidence: 0.95 },
        );
        break;
      }
      case 'discover_program': {
        bundle.program = {
          ...DEMO_PROGRAM,
          category: 'hospital_financial_assistance',
          form_kind: 'fillable_pdf',
          field_count: CEDARS_APPLICATION_FIELD_COUNT,
          region: 'Los Angeles, CA',
        };
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
        pushEvent('serpapi', 'program_discovered', `Official ${DEMO_HOSPITAL.name} program found`, {
          policy_url: CEDARS_POLICY_URL,
          program_name: DEMO_PROGRAM.name,
          organization_name: DEMO_HOSPITAL.name,
          form_kind: 'fillable_pdf',
          from_catalog: true,
        });
        pushEvent('serpapi', 'source_verified', 'Official source verified (hcai.ca.gov)', {
          source_domain: 'hcai.ca.gov',
          application_url: CEDARS_APPLICATION_PDF_URL,
        });
        pushEvent('xano', 'form_extracted', 'Form fields read from the official PDF', {
          fields: CEDARS_APPLICATION_FIELD_COUNT,
        });
        break;
      }
      case 'get_next_question':
      case 'get_case_progress': {
        /* Read-only on the system of record: progress is re-emitted after every tool. */
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
        pushEvent('nutrient', 'document_generated', 'Filled PDF generated', {
          fields_filled: bundle.answers.length,
        });
        pushEvent('nutrient', 'accessibility_processed', 'Accessibility processing complete', {
          accessibility_status: 'processed',
        });
        emit({ kind: 'completeness', summary: computeCompleteness(bundle) });
        break;
      }
      case 'send_summary': {
        /* Demo mode never calls Twilio: the row is `skipped`, and the feed says so. */
        const delivery: Delivery = {
          id: nextId('dlv'),
          case_id: caseId,
          channel: 'sms',
          to: '',
          message: '',
          document_url: `/review?case=${encodeURIComponent(caseId)}`,
          status: 'skipped',
          provider_id: '',
          error: 'demo mode: no text is sent',
          created_at: new Date().toISOString(),
        };
        bundle.deliveries = [...(bundle.deliveries ?? []), delivery];
        pushEvent('xano', 'summary_failed', 'Text summary skipped (demo run, nothing sent)', {
          delivery_id: delivery.id,
          status: delivery.status,
        });
        break;
      }
      case 'save_answer':
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
        /* VoiceToolCall.name is the legacy closed union; widened at this boundary (M1_CONTRACT §4). */
        const name = beat.name as VapiToolName;
        emit({ kind: 'tool_call', call: { id: callId, name, args: beat.args } });
        applyToolEffect(beat.name, beat.args);
        emit({ kind: 'tool_result', callId, name, ok: true });
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
