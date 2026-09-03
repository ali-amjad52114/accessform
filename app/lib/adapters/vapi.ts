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
 * Mirrors `clients/vapi.py`.
 */

import {
  VAPI_TOOL_NAMES,
  type CaseIdToolInput,
  type CreateCaseInput,
  type DiscoverProgramInput,
  type FinalizeDocumentInput,
  type SaveAnswerToolInput,
  type VapiToolName,
} from '../contract';
import { vapiPrivateKey } from './env';
import { AdapterError } from './errors';
import { requestJson } from './http';

const VAPI_BASE_URL = 'https://api.vapi.ai';

/** The only assistant this project is allowed to create or update. */
export const ACCESSFORM_ASSISTANT_NAME = 'AccessForm — Cedars-Sinai financial assistance';

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
    name: VapiToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
  server: { url: string };
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const STRING = { type: 'string' } as const;
const NUMBER = { type: 'number' } as const;

/**
 * The six tools exposed to the voice agent, in the contract's order. Every
 * `name` is exactly what the server-side `VoiceToolHandlers` router keys on.
 */
export function buildToolDefinitions(serverUrl: string): VapiToolDefinition[] {
  const tool = (
    name: VapiToolName,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
  ): VapiToolDefinition => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
    server: { url: serverUrl },
  });

  return [
    tool(
      'create_case',
      'Create the application case once the caller has named their hospital and the amount of the bill.',
      {
        patient_display_name: STRING,
        hospital_name: STRING,
        bill_amount: NUMBER,
      },
      ['patient_display_name', 'hospital_name', 'bill_amount'],
    ),
    tool(
      'discover_program',
      'Find the official financial-assistance program and application form for a hospital. Only official government or hospital domains are treated as verified.',
      { hospital: STRING, intent: STRING, location: STRING },
      ['hospital', 'intent'],
    ),
    tool(
      'save_answer',
      'Save one confirmed answer against the case. Pass the field id exactly as returned by get_case_progress.',
      {
        case_id: STRING,
        field_id: STRING,
        value: { type: ['string', 'number', 'boolean', 'null'] },
        source: { type: 'string', enum: ['voice', 'manual', 'document'] },
        confirmed: { type: 'boolean' },
      },
      ['case_id', 'field_id', 'value'],
    ),
    tool(
      'get_case_progress',
      'Ask the system of record what to ask next and how complete the application is. Never compute this yourself.',
      { case_id: STRING },
      ['case_id'],
    ),
    tool(
      'validate_case',
      'Check the application against the published requirements and list anything still missing. This never means approved or eligible.',
      { case_id: STRING },
      ['case_id'],
    ),
    tool(
      'finalize_document',
      'Fill the official PDF, run the accessibility pass, and return the URL the review screen loads.',
      { case_id: STRING, source_url: STRING },
      ['case_id'],
    ),
  ];
}

/** Argument shapes, keyed by tool name — useful when routing raw tool calls. */
export type VapiToolArgs = {
  create_case: CreateCaseInput;
  discover_program: DiscoverProgramInput;
  save_answer: SaveAnswerToolInput;
  get_case_progress: CaseIdToolInput;
  validate_case: CaseIdToolInput;
  finalize_document: FinalizeDocumentInput;
};

export function isVapiToolName(value: string): value is VapiToolName {
  return (VAPI_TOOL_NAMES as readonly string[]).includes(value);
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
   * `serverUrl` is the public HTTPS endpoint that implements
   * `VoiceToolHandlers`.
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
      firstMessage:
        'Hello, this is AccessForm. I can help you prepare a financial assistance application for your hospital bill. Which hospital is the bill from?',
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

/**
 * Voice-agent policy, straight from API_INTEGRATIONS.md §4 and the product
 * rules. The disclaimers are not optional — AccessForm must never claim
 * eligibility, approval, submission, or a signature.
 */
export const ASSISTANT_SYSTEM_PROMPT = [
  'You are AccessForm, a patient advocate helping someone prepare a hospital',
  'financial-assistance application by voice. The caller may be blind or have',
  'low vision, so everything must work by ear alone.',
  '',
  'How to talk:',
  '- Ask exactly one clear question at a time, then wait.',
  '- Never read PDF field labels mechanically. Use plain language.',
  '- Explain why you need sensitive information before asking for it.',
  '- "I don\'t know" and "not now" are always acceptable answers. Move on and',
  '  record that the item is still outstanding.',
  '- Read numbers back for confirmation before saving them.',
  '',
  'How to work:',
  '- Call create_case once you know the hospital and the amount of the bill.',
  '- Call discover_program to find the official form. Only official government',
  '  or hospital sources count as verified.',
  '- Call get_case_progress to decide what to ask next. Never guess at progress',
  '  or completeness yourself — the system of record is authoritative.',
  '- Call save_answer after the caller confirms each answer.',
  '- Call validate_case before wrapping up, then finalize_document.',
  '',
  'What you must never say:',
  '- Never say the caller is eligible, qualifies, is approved, or will be',
  '  approved. The hospital decides that.',
  '- Never say the application has been submitted or sent. It has not.',
  '- Never say the form is signed. You cannot sign anything.',
  '',
  'Before ending the call, state plainly what is still outstanding, and that the',
  'application is ready for the caller to review but has not been submitted.',
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
