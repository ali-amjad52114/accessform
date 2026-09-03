/**
 * OpenAI strict-JSON helper for the judgment steps that live under
 * lib/forms and lib/interview (form understanding, answer mapping).
 *
 * Rules (docs/M1_CONTRACT.md §0.7):
 *   - server-side only, plain `fetch` to OPENAI_CHAT_COMPLETIONS_URL
 *   - `response_format: { type: 'json_schema', json_schema: { strict: true } }`
 *     on EVERY call, so the output shape is enforced by the API
 *   - temperature 0
 *   - every `enum` in a schema is built from real data by the caller
 *
 * The helper never invents a fallback answer: a missing key, a refusal, a
 * truncated completion or bad JSON all throw, and the caller decides what
 * "cannot judge" means for its own output (usually: leave it unmapped).
 */

import { serverSecret } from '../adapters/env';
import {
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_JUDGMENT_MODEL,
  OPENAI_TEMPERATURE,
} from '../contract';

export class OpenAiJsonError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(`[openai] ${message}`);
    this.name = 'OpenAiJsonError';
    this.status = status;
  }
}

/** A JSON-schema fragment. Kept loose on purpose; strictness is enforced by the API. */
export type JsonSchema = Record<string, unknown>;

export interface StrictJsonRequest {
  /** Defaults to OPENAI_JUDGMENT_MODEL (gpt-4o). */
  model?: string;
  system: string;
  user: string;
  /** Name of the schema, [a-zA-Z0-9_-]. */
  schemaName: string;
  /** Root object schema. Must already satisfy strict-mode rules (all props required, additionalProperties: false). */
  schema: JsonSchema;
  maxTokens?: number;
  timeoutMs?: number;
}

export function hasOpenAiKey(): boolean {
  return Boolean(serverSecret('OPENAI_API_KEY'));
}

/** Build a strict-mode string enum property. Empty lists are not allowed by the API. */
export function enumProperty(values: readonly string[], description: string): JsonSchema {
  return { type: 'string', enum: Array.from(new Set(values)), description };
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }>;
  error?: { message?: string };
}

/**
 * One strict JSON completion. Retries once on 429 / 5xx / network error.
 * Returns the parsed object; throws `OpenAiJsonError` on anything else.
 */
export async function openaiStrictJson<T>(request: StrictJsonRequest): Promise<T> {
  const apiKey = serverSecret('OPENAI_API_KEY');
  if (!apiKey) throw new OpenAiJsonError('OPENAI_API_KEY is not set');

  const body = {
    model: request.model ?? OPENAI_JUDGMENT_MODEL,
    temperature: OPENAI_TEMPERATURE,
    max_tokens: request.maxTokens ?? 8000,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: request.schemaName, strict: true, schema: request.schema },
    },
  };

  let lastError: OpenAiJsonError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);
    let response: Response;
    try {
      response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      clearTimeout(timer);
      lastError = new OpenAiJsonError(
        `network failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    clearTimeout(timer);

    if (response.status === 429 || response.status >= 500) {
      const detail = await response.text().catch(() => '');
      lastError = new OpenAiJsonError(`HTTP ${response.status}: ${detail.slice(0, 200)}`, response.status);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new OpenAiJsonError(`HTTP ${response.status}: ${detail.slice(0, 400)}`, response.status);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const choice = json.choices?.[0];
    if (!choice?.message) throw new OpenAiJsonError('no choices in response');
    if (choice.message.refusal) throw new OpenAiJsonError(`refused: ${choice.message.refusal}`);
    if (choice.finish_reason === 'length') {
      throw new OpenAiJsonError('completion truncated (finish_reason=length); reduce the batch size');
    }
    const content = choice.message.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new OpenAiJsonError('empty content');
    }
    try {
      return JSON.parse(content) as T;
    } catch (error) {
      throw new OpenAiJsonError(
        `content was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw lastError ?? new OpenAiJsonError('request failed');
}
