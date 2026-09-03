/**
 * OpenAI structured-output helper shared by the M1 judgment modules
 * (need resolution, source verdict).
 *
 * Rules (docs/M1_CONTRACT.md §0.7): server-side only, plain `fetch` to
 * `OPENAI_CHAT_COMPLETIONS_URL`, `temperature: 0`, and ALWAYS
 * `response_format: { type: 'json_schema', json_schema: { strict: true } }`.
 * Callers build every `enum` in their schema from real data at call time.
 *
 * Throws on any failure (no key, HTTP error, refusal, unparseable content).
 * Callers decide how to degrade — the tool boundary never sees a throw.
 */

import { OPENAI_CHAT_COMPLETIONS_URL, OPENAI_TEMPERATURE } from '../contract';
import { serverSecret } from '../adapters/env';

/** A JSON-schema fragment. Kept loose on purpose; strictness is enforced by OpenAI. */
export type JsonSchema = Record<string, unknown>;

export interface StrictJsonRequest {
  model: string;
  /** Schema name (letters, digits, underscores). */
  name: string;
  schema: JsonSchema;
  system: string;
  user: string;
  timeoutMs?: number;
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

export class OpenAiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(`[openai] ${message}`);
    this.name = 'OpenAiError';
    this.status = status;
  }
}

export function hasOpenAiKey(): boolean {
  return Boolean(serverSecret('OPENAI_API_KEY'));
}

/** Nullable string property for strict schemas. */
export const NULLABLE_STRING: JsonSchema = { type: ['string', 'null'] };

export async function completeStrictJson<T>(request: StrictJsonRequest): Promise<T> {
  const key = serverSecret('OPENAI_API_KEY');
  if (!key) throw new OpenAiError('OPENAI_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 45_000);

  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: OPENAI_TEMPERATURE,
        max_tokens: request.maxTokens ?? 1200,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.name, strict: true, schema: request.schema },
        },
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    throw new OpenAiError(
      error instanceof Error && error.name === 'AbortError'
        ? 'request timed out'
        : `network request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new OpenAiError(`HTTP ${response.status}: response was not JSON`, response.status);
  }
  if (!response.ok) {
    throw new OpenAiError(
      `HTTP ${response.status}: ${payload.error?.message ?? 'request failed'}`,
      response.status,
    );
  }

  const choice = payload.choices?.[0];
  if (!choice?.message) throw new OpenAiError('no choices returned');
  if (choice.message.refusal) throw new OpenAiError(`refusal: ${choice.message.refusal}`);
  if (choice.finish_reason === 'length') throw new OpenAiError('output truncated (max_tokens)');
  const content = choice.message.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new OpenAiError('empty content');
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new OpenAiError('content was not valid JSON');
  }
}
