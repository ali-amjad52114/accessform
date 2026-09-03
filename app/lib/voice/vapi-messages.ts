/**
 * Normalizing Vapi's server payloads.
 *
 * Vapi has shipped several shapes for a `tool-calls` server message over time
 * (`toolCalls`, `toolCallList`, `toolWithToolCallList`, and the legacy
 * `function-call`). This module flattens all of them into one list, so the
 * route handler has exactly one code path.
 */

export interface NormalizedToolCall {
  /** Echoed back as `toolCallId` in the response. */
  id: string;
  name: string;
  args: unknown;
}

export interface VapiServerMessage {
  type: string;
  /** Present on most messages. */
  callId: string | null;
  /** Case id passed through `assistantOverrides.variableValues.case_id`. */
  caseId: string | null;
  toolCalls: NormalizedToolCall[];
  /** The original payload, for logging. */
  raw: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function fromToolCallEntry(entry: unknown): NormalizedToolCall | null {
  const item = record(entry);
  // { id, function: { name, arguments } }  — OpenAI-style
  const fn = record(item.function);
  const id = text(item.id) ?? text(item.toolCallId) ?? '';
  const name = text(fn.name) ?? text(item.name);
  if (!name) return null;
  const args = parseArgs(fn.arguments ?? item.arguments ?? item.parameters);
  return { id, name, args };
}

function fromToolWithToolCall(entry: unknown): NormalizedToolCall | null {
  const item = record(entry);
  const toolCall = record(item.toolCall);
  const fn = record(toolCall.function);
  const name =
    text(fn.name) ??
    text(item.name) ??
    text(record(record(item.tool).function).name) ??
    null;
  if (!name) return null;
  const id = text(toolCall.id) ?? text(item.id) ?? '';
  const args = parseArgs(toolCall.parameters ?? fn.arguments ?? toolCall.arguments);
  return { id, name, args };
}

/** Case id carried on the call, if the client set one when starting. */
function extractCaseId(message: Record<string, unknown>): string | null {
  const call = record(message.call);
  const candidates = [
    record(record(call.assistantOverrides).variableValues).case_id,
    record(call.metadata).case_id,
    record(message.metadata).case_id,
    message.caseId,
  ];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return value;
  }
  return null;
}

export function parseVapiServerMessage(body: unknown): VapiServerMessage {
  const payload = record(body);
  const message = record(payload.message ?? payload);
  const type = text(message.type) ?? 'unknown';

  const toolCalls: NormalizedToolCall[] = [];
  for (const entry of list(message.toolCallList)) {
    const parsed = fromToolCallEntry(entry);
    if (parsed) toolCalls.push(parsed);
  }
  for (const entry of list(message.toolCalls)) {
    const parsed = fromToolCallEntry(entry);
    if (parsed) toolCalls.push(parsed);
  }
  for (const entry of list(message.toolWithToolCallList)) {
    const parsed = fromToolWithToolCall(entry);
    if (parsed) toolCalls.push(parsed);
  }
  // Legacy single function call.
  const legacy = record(message.functionCall);
  const legacyName = text(legacy.name);
  if (legacyName) {
    toolCalls.push({
      id: text(legacy.id) ?? '',
      name: legacyName,
      args: parseArgs(legacy.parameters ?? legacy.arguments),
    });
  }

  // De-duplicate by id+name: some payloads carry the same call in two shapes.
  const seen = new Set<string>();
  const unique = toolCalls.filter((call) => {
    const key = `${call.id}::${call.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    type,
    callId: text(record(message.call).id),
    caseId: extractCaseId(message),
    toolCalls: unique,
    raw: message,
  };
}

/** One spoken turn from a Vapi `transcript` server message. */
export interface VapiTranscriptTurn {
  role: 'user' | 'assistant';
  /** The spoken words, trimmed. */
  text: string;
  transcript_type: 'partial' | 'final';
}

/**
 * Read a `transcript` message (`role`, `transcript`, `transcriptType`). Returns
 * null when the payload is not a usable transcript turn. Any role other than
 * `user` is treated as the assistant (Vapi uses `assistant`; older payloads
 * said `bot`).
 */
export function parseVapiTranscript(message: Record<string, unknown>): VapiTranscriptTurn | null {
  if (text(message.type) !== 'transcript') return null;
  const spoken = text(message.transcript);
  if (!spoken) return null;
  const role = text(message.role) === 'user' ? 'user' : 'assistant';
  const kind = text(message.transcriptType) ?? text(message.transcript_type);
  return { role, text: spoken, transcript_type: kind === 'final' ? 'final' : 'partial' };
}

/** The response body Vapi expects from a tool-call webhook. */
export interface VapiToolResponse {
  results: { toolCallId: string; result: string }[];
}

export function toolResponse(results: { toolCallId: string; result: unknown }[]): VapiToolResponse {
  return {
    results: results.map((entry) => ({
      toolCallId: entry.toolCallId,
      result: typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result),
    })),
  };
}
