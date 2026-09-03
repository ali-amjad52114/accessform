/**
 * Vapi adapter — server-side control plane.
 *
 * `VAPI_PRIVATE_KEY` authenticates api.vapi.ai and is SERVER-SIDE ONLY. The
 * public key is browser-safe and is used solely by the Vapi web SDK; the REST
 * API rejects it by design.
 *
 * Account state at build time: 3 pre-existing assistants (unrelated dental /
 * clinic scheduling, no tools defined) and 2 phone numbers pointing at an
 * unrelated assistant. Nothing here mutates those by accident — `ensureAssistant`
 * only touches an assistant whose name matches `ACCESSFORM_ASSISTANT_NAME`.
 *
 * The tool definitions come verbatim from `M1_VOICE_TOOL_SCHEMAS` in the
 * contract; `scripts/vapi/assistant.config.mjs` mirrors the same schemas for
 * the provisioning CLI (which cannot import TypeScript).
 *
 * Mirrors `clients/vapi.py`.
 */

import {
  M1_VAPI_ASSISTANT_TOOLS,
  M1_VOICE_TOOL_NAMES,
  M1_VOICE_TOOL_SCHEMAS,
  type CreateCaseToolInput,
  type DiscoverProgramToolInput,
  type FinalizeDocumentToolInput,
  type GetNextQuestionToolInput,
  type JsonSchemaProperty,
  type M1VoiceToolName,
  type ResolveNeedToolInput,
  type SaveAnswerM1ToolInput,
  type SendSummaryToolInput,
  type ValidateCaseToolInput,
} from '../contract';
import { ACCESSFORM_ASSISTANT_NAME } from '../voice/assistant';
import { vapiPrivateKey } from './env';
import { AdapterError } from './errors';
import { requestJson } from './http';

const VAPI_BASE_URL = 'https://api.vapi.ai';

/**
 * The only assistant this project is allowed to create or update. Same
 * constant as `lib/voice/assistant.ts` (the session route looks the assistant
 * up by this exact name) and `ASSISTANT_NAME` in scripts/vapi/assistant.config.mjs.
 */
export { ACCESSFORM_ASSISTANT_NAME };

/* ------------------------------------------------------------------ */
/* Control-plane row shapes (only the fields we rely on)               */
/* ------------------------------------------------------------------ */

export interface VapiAssistant {
  id: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface VapiPhoneNumber {
  id: string;
  number?: string;
  provider?: string;
  assistantId?: string | null;
  [key: string]: unknown;
}

export interface VapiCall {
  id: string;
  status?: string;
  assistantId?: string;
  createdAt?: string;
  endedReason?: string;
  [key: string]: unknown;
}

/** Payload for a Vapi server tool, as the assistant config expects it. */
export interface VapiToolDefinition {
  type: 'function';
  function: {
    name: M1VoiceToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required: string[];
    };
  };
  server: { url: string };
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

/**
 * The tools exposed to the voice agent — the eight M1 tools plus the
 * `get_case_progress` alias — in the contract's order, with the contract's
 * exact JSON schemas. Every `name` is exactly what the server-side
 * `runVoiceTool` router keys on.
 */
export function buildToolDefinitions(serverUrl: string): VapiToolDefinition[] {
  return M1_VAPI_ASSISTANT_TOOLS.map((name) => {
    const schema = M1_VOICE_TOOL_SCHEMAS[name];
    return {
      type: 'function' as const,
      function: {
        name: schema.name,
        description: schema.description,
        parameters: {
          type: 'object' as const,
          properties: { ...schema.parameters.properties },
          required: [...schema.parameters.required],
        },
      },
      server: { url: serverUrl },
    };
  });
}

/** Argument shapes, keyed by tool name — useful when routing raw tool calls. */
export type VapiToolArgs = {
  create_case: CreateCaseToolInput;
  resolve_need: ResolveNeedToolInput;
  discover_program: DiscoverProgramToolInput;
  get_next_question: GetNextQuestionToolInput;
  save_answer: SaveAnswerM1ToolInput;
  validate_case: ValidateCaseToolInput;
  finalize_document: FinalizeDocumentToolInput;
  send_summary: SendSummaryToolInput;
  get_case_progress: GetNextQuestionToolInput;
};

export function isVapiToolName(value: string): value is M1VoiceToolName {
  return (M1_VOICE_TOOL_NAMES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export class VapiControlPlane {
  private readonly privateKey: string;

  constructor(privateKey: string) {
    this.privateKey = privateKey;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.privateKey}` };
  }

  private call<T>(
    operation: string,
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<T> {
    return requestJson<T>('vapi', operation, `${VAPI_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      json: init.json,
      headers: this.headers(),
    });
  }

  async listAssistants(): Promise<VapiAssistant[]> {
    const payload = await this.call<unknown>('listAssistants', '/assistant');
    return Array.isArray(payload) ? (payload as VapiAssistant[]) : [];
  }

  async getAssistant(assistantId: string): Promise<VapiAssistant> {
    return this.call<VapiAssistant>(
      'getAssistant',
      `/assistant/${encodeURIComponent(assistantId)}`,
    );
  }

  async createAssistant(payload: Record<string, unknown>): Promise<VapiAssistant> {
    return this.call<VapiAssistant>('createAssistant', '/assistant', {
      method: 'POST',
      json: payload,
    });
  }

  async updateAssistant(
    assistantId: string,
    payload: Record<string, unknown>,
  ): Promise<VapiAssistant> {
    return this.call<VapiAssistant>(
      'updateAssistant',
      `/assistant/${encodeURIComponent(assistantId)}`,
      { method: 'PATCH', json: payload },
    );
  }

  async listPhoneNumbers(): Promise<VapiPhoneNumber[]> {
    const payload = await this.call<unknown>('listPhoneNumbers', '/phone-number');
    return Array.isArray(payload) ? (payload as VapiPhoneNumber[]) : [];
  }

  async listCalls(): Promise<VapiCall[]> {
    const payload = await this.call<unknown>('listCalls', '/call');
    return Array.isArray(payload) ? (payload as VapiCall[]) : [];
  }

  async getCall(callId: string): Promise<VapiCall> {
    return this.call<VapiCall>('getCall', `/call/${encodeURIComponent(callId)}`);
  }

  /**
   * Find the AccessForm assistant by name.
   *
   * Deliberately name-scoped: the account holds three unrelated assistants and
   * this must never adopt or overwrite one of them.
   */
  async findAccessFormAssistant(): Promise<VapiAssistant | null> {
    const assistants = await this.listAssistants();
    return (
      assistants.find((assistant) => assistant.name === ACCESSFORM_ASSISTANT_NAME) ?? null
    );
  }

  /**
   * Create the AccessForm assistant, or update the existing one in place.
   * `serverUrl` is the public HTTPS endpoint that implements the voice tools
   * (`/api/voice/tools`).
   */
  async ensureAssistant(
    serverUrl: string,
    overrides: Record<string, unknown> = {},
  ): Promise<VapiAssistant> {
    if (!/^https:\/\//i.test(serverUrl)) {
      throw new AdapterError(
        'vapi',
        'ensureAssistant',
        'tool server URL must be public HTTPS',
        { detail: serverUrl },
      );
    }

    const payload: Record<string, unknown> = {
      name: ACCESSFORM_ASSISTANT_NAME,
      firstMessage: ASSISTANT_FIRST_MESSAGE,
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        tools: buildToolDefinitions(serverUrl),
        messages: [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }],
      },
      ...overrides,
    };

    const existing = await this.findAccessFormAssistant();
    if (existing) return this.updateAssistant(existing.id, payload);
    return this.createAssistant(payload);
  }
}

/** Need-agnostic opening line. Same as FIRST_MESSAGE in scripts/vapi/assistant.config.mjs. */
export const ASSISTANT_FIRST_MESSAGE =
  "This is AccessForm. I help people find the official form for their situation and fill it in by voice. Take your time — what's going on?";

/**
 * Voice-agent policy, from docs/PRODUCT_PLAN.md and docs/M1_CONTRACT.md §4.
 * The disclaimers are not optional — AccessForm must never claim eligibility,
 * approval, submission, or a signature. The full conversational prompt lives
 * in scripts/vapi/assistant.config.mjs; this is the compact policy used when
 * the adapter provisions the assistant itself.
 */
export const ASSISTANT_SYSTEM_PROMPT = [
  'You are AccessForm, a voice assistant for people with disabilities. The',
  'caller describes what they need in their own words; you find the official',
  'program and form for that need and place, interview them from that form,',
  'fill the real document, and text them the result. You never submit anything.',
  '',
  'How to talk:',
  '- Ask exactly one clear question at a time, then wait.',
  '- Never read PDF field labels mechanically. Use plain language.',
  '- Explain why the form asks for sensitive information before asking for it.',
  '- "I don\'t know" and "not now" are always acceptable answers. Move on and',
  '  record that the item is still outstanding.',
  '- Read numbers back for confirmation before saving them.',
  '',
  'How to work, in order:',
  '- Listen first. Call create_case with what the caller said, then resolve_need.',
  '- If resolve_need is unsure, ask its clarifying question and call it again.',
  '- If you do not know where the caller is, ask "where are you right now?" —',
  '  a city or ZIP is enough — then call discover_program.',
  '- If discover_program returns found=false, say plainly that you could not',
  '  verify an official form for that organization or place, and stop. Never',
  '  substitute another organization\'s form.',
  '- Call get_next_question before every question and ask its prompt in plain',
  '  words. Call save_answer after each answer. Never guess at progress.',
  '- Call validate_case, then finalize_document, then send_summary to the',
  '  caller\'s phone (ask which number to text if you do not know it).',
  '',
  'What you must never say:',
  '- Never say the caller is eligible, qualifies, is approved, or will be',
  '  approved. The organization decides that.',
  '- Never say the application has been submitted, sent, or filed. It has not.',
  '- Never say the form is signed. You cannot sign anything.',
  '',
  'Before ending the call, state plainly what is still missing, that a text',
  'with the review link is on its way only if send_summary said so, and that',
  'nothing has been sent to the organization.',
].join('\n');

/**
 * The control plane, or `null` when `VAPI_PRIVATE_KEY` is absent (or when this
 * is evaluated in the browser). Callers fall back to the simulated voice
 * adapter.
 */
export function createVapiControlPlane(): VapiControlPlane | null {
  const key = vapiPrivateKey();
  return key ? new VapiControlPlane(key) : null;
}
