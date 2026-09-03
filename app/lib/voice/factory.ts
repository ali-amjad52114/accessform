/**
 * Choosing between the live Vapi session and the scripted simulation.
 *
 * Order of preference:
 *   1. explicit `simulated: true` from the caller;
 *   2. NEXT_PUBLIC_DEMO_MODE=true — the demo always runs the script;
 *   3. no publishable key / no provisioned assistant / no microphone;
 *   4. otherwise, a live browser call through the Vapi Web SDK.
 */

import { DEMO_CASE_ID, type Id } from '../contract';
import { ACCESSFORM_ASSISTANT_NAME } from './assistant';
import { createSimulatedVoiceAdapter } from './simulation';
import type { AccessFormVoiceAdapter } from './types';
import { browserVoiceSupported, createVapiWebAdapter } from './vapi-web';

export interface VoiceRuntimeConfig {
  assistantName: string;
  assistantId: string | null;
  publicKey: string | null;
  demoMode: boolean;
  simulationOnly: boolean;
}

export const SIMULATION_ONLY_CONFIG: VoiceRuntimeConfig = {
  assistantName: ACCESSFORM_ASSISTANT_NAME,
  assistantId: null,
  publicKey: null,
  demoMode: true,
  simulationOnly: true,
};

/** Reads GET /api/voice/session. Never throws — falls back to simulation. */
export async function fetchVoiceRuntimeConfig(
  endpoint = '/api/voice/session',
): Promise<VoiceRuntimeConfig> {
  try {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) return SIMULATION_ONLY_CONFIG;
    const payload = (await response.json()) as Partial<VoiceRuntimeConfig>;
    return {
      assistantName: payload.assistantName ?? SIMULATION_ONLY_CONFIG.assistantName,
      assistantId: payload.assistantId ?? null,
      publicKey: payload.publicKey ?? null,
      demoMode: payload.demoMode ?? true,
      simulationOnly: payload.simulationOnly ?? true,
    };
  } catch {
    return SIMULATION_ONLY_CONFIG;
  }
}

export interface CreateVoiceAdapterOptions {
  caseId?: Id;
  /** Force the deterministic script, whatever the environment says. */
  simulated?: boolean;
  config?: VoiceRuntimeConfig;
}

export async function createVoiceAdapter(
  options: CreateVoiceAdapterOptions = {},
): Promise<AccessFormVoiceAdapter> {
  const caseId = options.caseId ?? DEMO_CASE_ID;

  if (options.simulated || process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    return createSimulatedVoiceAdapter({ caseId });
  }

  const config = options.config ?? (await fetchVoiceRuntimeConfig());
  if (config.simulationOnly || !config.publicKey || !config.assistantId) {
    return createSimulatedVoiceAdapter({ caseId });
  }

  if (!(await browserVoiceSupported())) {
    return createSimulatedVoiceAdapter({ caseId });
  }

  return createVapiWebAdapter({
    publicKey: config.publicKey,
    assistantId: config.assistantId,
    caseId,
  });
}
