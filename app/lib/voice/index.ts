/**
 * Public surface of the voice layer.
 *
 * Client-safe only — everything exported here can be imported from a React
 * component. The server-side pieces (`tool-handlers`, `xano-bridge`,
 * `case-store`, `vapi-messages`) are imported directly by the route handlers
 * under app/api/voice, never through this barrel.
 *
 * The /live screen normally needs exactly one import:
 *
 *   import { useVoiceSession } from '../../lib/voice';
 *   const voice = useVoiceSession({ caseId: DEMO_CASE_ID });
 */

export { useVoiceSession } from './use-voice-session';
export type { UseVoiceSessionOptions, UseVoiceSessionResult } from './use-voice-session';

export {
  createVoiceAdapter,
  fetchVoiceRuntimeConfig,
  SIMULATION_ONLY_CONFIG,
  type CreateVoiceAdapterOptions,
  type VoiceRuntimeConfig,
} from './factory';

export { createSimulatedVoiceAdapter, type SimulationOptions } from './simulation';
export { browserVoiceSupported, createVapiWebAdapter, type VapiWebOptions } from './vapi-web';

export {
  asVoiceAdapter,
  isContractVoiceEvent,
  VoiceEventBus,
  type AccessFormVoiceAdapter,
  type LiveFormState,
  type VoiceStreamEvent,
} from './types';

export {
  FIELD_BY_ID,
  FIELD_BY_KEY,
  INTERVIEW_PLAN,
  fieldCountForStep,
  formatFieldValue,
  interviewPlanAsFormSchema,
  resolveField,
  scriptedValue,
  type InterviewField,
} from './form-plan';

export { FIRST_MESSAGE, SIMULATION_SCRIPT, scriptDurationMs, type ScriptBeat } from './script';
export { TOOL_ACTIVITY_LABELS, isVapiToolNameLoose } from './tool-names';
