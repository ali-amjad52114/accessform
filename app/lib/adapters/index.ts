/**
 * Adapter factory.
 *
 * One place decides, per integration, whether the real service or the
 * deterministic fixture answers. The rule is deliberately conservative:
 *
 *   NEXT_PUBLIC_DEMO_MODE != "false"  -> fixtures everywhere. Nothing is called,
 *                                        no SerpApi credit is spent.
 *   otherwise                         -> live where credentials exist, fixture
 *                                        where they do not, and any live call
 *                                        that fails falls back to the fixture
 *                                        rather than throwing into the UI.
 *
 * SerpApi is stricter still: even in live mode, `discoverProgram` serves the
 * cache unless the caller explicitly asks to refresh. See `adapters/serp.ts`.
 */

import {
  type Answer,
  type Case,
  type CaseIdToolInput,
  type CaseProgress,
  type CompletenessSummary,
  type CreateCaseInput,
  type DiscoverProgramInput,
  type DiscoveryResult,
  type FinalizeDocumentInput,
  type FinalizedDocument,
  type NutrientAdapter,
  type SaveAnswerToolInput,
  type SerpAdapter,
  type VoiceAdapter,
  type VoiceToolHandlers,
  type XanoAdapter,
} from '../contract';
import { fixtureNutrientAdapter } from '../fixtures/nutrient';
import { fixtureSerpAdapter } from '../fixtures/serp';
import { fixtureVoiceAdapter } from '../fixtures/voice';
import { fixtureXanoAdapter } from '../fixtures/xano';
import {
  documentEngine,
  hasAllNutrientKeys,
  isBrowser,
  isDemoMode,
  serpApiKey,
  vapiPrivateKey,
  xanoCredentials,
} from './env';
import { createNutrientAdapter } from './nutrient';
import { createSerpAdapter } from './serp';
import { createVapiControlPlane, type VapiControlPlane } from './vapi';
import { createXanoAdapter } from './xano';

export type AdapterMode = 'live' | 'fixture';

export interface AdapterModes {
  serp: AdapterMode;
  xano: AdapterMode;
  nutrient: AdapterMode;
  voice: AdapterMode;
}

export interface Adapters {
  serp: SerpAdapter;
  xano: XanoAdapter;
  nutrient: NutrientAdapter;
  modes: AdapterModes;
  demoMode: boolean;
}

/* ------------------------------------------------------------------ */
/* Mode resolution                                                     */
/* ------------------------------------------------------------------ */

/** Which implementation each integration will actually use. */
export function resolveModes(): AdapterModes {
  if (isDemoMode() || isBrowser()) {
    return { serp: 'fixture', xano: 'fixture', nutrient: 'fixture', voice: 'fixture' };
  }
  return {
    // Live only ever means "may refresh on request"; the default path is cached.
    serp: serpApiKey() ? 'live' : 'fixture',
    xano: xanoCredentials() ? 'live' : 'fixture',
    // With the local document engine the fill runs on pdf-lib, so missing
    // Nutrient keys must not force the fixture document.
    nutrient: hasAllNutrientKeys() || documentEngine() === 'local' ? 'live' : 'fixture',
    voice: vapiPrivateKey() ? 'live' : 'fixture',
  };
}

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

export function getSerpAdapter(): SerpAdapter {
  return resolveModes().serp === 'live' ? createSerpAdapter() : fixtureSerpAdapter;
}

export function getXanoAdapter(): XanoAdapter {
  return resolveModes().xano === 'live' ? createXanoAdapter() : fixtureXanoAdapter;
}

export function getNutrientAdapter(xano: XanoAdapter = getXanoAdapter()): NutrientAdapter {
  return resolveModes().nutrient === 'live'
    ? createNutrientAdapter(xano)
    : fixtureNutrientAdapter;
}

/**
 * The Vapi control plane, or `null` in demo mode / without a private key.
 * Server-side only.
 */
export function getVapiControlPlane(): VapiControlPlane | null {
  if (isDemoMode()) return null;
  return createVapiControlPlane();
}

/**
 * Browser-side voice transport.
 *
 * Only the scripted adapter exists in this slice — a live Vapi web session is
 * driven by the Vapi SDK from a client component using the public key, and can
 * be swapped in here without changing any caller.
 */
export function getVoiceAdapter(): VoiceAdapter {
  return fixtureVoiceAdapter;
}

/** Every adapter plus the resolved modes, built once. */
export function getAdapters(): Adapters {
  const modes = resolveModes();
  const xano = modes.xano === 'live' ? createXanoAdapter() : fixtureXanoAdapter;
  const serp = modes.serp === 'live' ? createSerpAdapter() : fixtureSerpAdapter;
  const nutrient =
    modes.nutrient === 'live' ? createNutrientAdapter(xano) : fixtureNutrientAdapter;
  return { serp, xano, nutrient, modes, demoMode: isDemoMode() };
}

/* ------------------------------------------------------------------ */
/* Voice tool router                                                   */
/* ------------------------------------------------------------------ */

/**
 * Server-side implementation of the six tools Vapi calls, keyed by the exact
 * tool names. A route handler can dispatch straight into this.
 *
 * `discover_program` also persists the verified program and writes the two
 * SerpApi rows to the event feed, which is what /live renders.
 */
export function createVoiceToolHandlers(
  adapters: Adapters = getAdapters(),
): VoiceToolHandlers {
  const { serp, xano, nutrient } = adapters;

  return {
    async create_case(args: CreateCaseInput): Promise<Case> {
      return xano.createCase(args);
    },

    async discover_program(args: DiscoverProgramInput): Promise<DiscoveryResult> {
      const result = await serp.discoverProgram(args);
      const program = await xano.saveDiscoveredProgram(result);
      return { ...result, application_url: program.application_url || result.application_url };
    },

    async save_answer(args: SaveAnswerToolInput): Promise<Answer> {
      return xano.saveAnswer(args.case_id, args.field_id, {
        value: args.value,
        source: args.source ?? 'voice',
        confirmed: args.confirmed ?? true,
      });
    },

    async get_case_progress(args: CaseIdToolInput): Promise<CaseProgress> {
      return xano.getCaseProgress(args.case_id);
    },

    async validate_case(args: CaseIdToolInput): Promise<CompletenessSummary> {
      return xano.validateCase(args.case_id);
    },

    async finalize_document(args: FinalizeDocumentInput): Promise<FinalizedDocument> {
      return nutrient.finalizeDocument(args);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Re-exports                                                          */
/* ------------------------------------------------------------------ */

export {
  isBrowser,
  isDemoMode,
  nutrientViewerKey,
  vapiPublicKey,
} from './env';

export {
  AdapterError,
  clearFallbackLog,
  getFallbackLog,
  type FallbackRecord,
  type IntegrationName,
} from './errors';

export {
  cleanUrl,
  hostOf,
  isAllowedDomain,
  pickApplicationUrl,
  pickPolicyUrl,
  rankSources,
  verifySources,
} from './discovery-rules';

export { LiveSerpAdapter, createSerpAdapter, type DiscoverOptions } from './serp';
export { LiveXanoAdapter, createXanoAdapter } from './xano';
export {
  GENERATED_DIR,
  LiveNutrientAdapter,
  buildInstantJson,
  createNutrientAdapter,
  formatFieldValue,
  getGeneratedDocument,
} from './nutrient';
export {
  ACCESSFORM_ASSISTANT_NAME,
  ASSISTANT_SYSTEM_PROMPT,
  VapiControlPlane,
  buildToolDefinitions,
  createVapiControlPlane,
  isVapiToolName,
  type VapiAssistant,
  type VapiCall,
  type VapiPhoneNumber,
  type VapiToolArgs,
  type VapiToolDefinition,
} from './vapi';
