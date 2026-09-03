/**
 * Per-call registry: one Vapi call → one AccessForm case.
 *
 * Vapi identifies every server message by `call.id`, but a phone call carries
 * no case id of its own (browser sessions pass one as an assistant variable).
 * Without this map two things go wrong, both seen on the first real test call:
 *
 *   - the agent calls `create_case` again when the caller changes topic, so
 *     one conversation is split across several cases;
 *   - `transcript` messages arrive without a case id and are dropped, so the
 *     conversation page never shows the words.
 *
 * The registry remembers which case a call opened, hands that id to every
 * later tool call and transcript on the same call, and buffers the few
 * transcript turns spoken before the case exists so they land on it too.
 *
 * In-process and best-effort: a server restart forgets it, which only costs
 * the dedupe for calls already in progress. Entries expire after six hours.
 */

export interface PendingTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp of when the turn was received. */
  at: string;
}

interface CallRecord {
  caseId: string | null;
  pending: PendingTurn[];
  updatedAt: number;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING = 40;

/** Survives Next.js dev-mode module reloads so a recompiling route keeps its map. */
const REGISTRY_KEY = Symbol.for('accessform.voice.callRegistry');
const store = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, CallRecord> };
const calls: Map<string, CallRecord> = store[REGISTRY_KEY] ?? (store[REGISTRY_KEY] = new Map());

function sweep(now: number): void {
  for (const [id, record] of calls) {
    if (now - record.updatedAt > TTL_MS) calls.delete(id);
  }
}

function recordFor(callId: string, now: number): CallRecord {
  let record = calls.get(callId);
  if (!record) {
    record = { caseId: null, pending: [], updatedAt: now };
    calls.set(callId, record);
  }
  record.updatedAt = now;
  return record;
}

/** The case this call already opened, or null. */
export function caseForCall(callId: string | null | undefined): string | null {
  if (!callId) return null;
  const record = calls.get(callId);
  return record?.caseId ?? null;
}

/** Bind a call to its case. Later calls with the same id are no-ops. */
export function rememberCaseForCall(callId: string | null | undefined, caseId: string): void {
  if (!callId || !caseId) return;
  const now = Date.now();
  sweep(now);
  const record = recordFor(callId, now);
  if (!record.caseId) record.caseId = caseId;
}

/** Hold a transcript turn that arrived before the call had a case. */
export function bufferTranscript(callId: string | null | undefined, turn: PendingTurn): void {
  if (!callId) return;
  const now = Date.now();
  sweep(now);
  const record = recordFor(callId, now);
  record.pending.push(turn);
  if (record.pending.length > MAX_PENDING) record.pending.splice(0, record.pending.length - MAX_PENDING);
}

/** Take (and clear) the turns buffered for a call. */
export function drainTranscripts(callId: string | null | undefined): PendingTurn[] {
  if (!callId) return [];
  const record = calls.get(callId);
  if (!record || record.pending.length === 0) return [];
  const turns = record.pending;
  record.pending = [];
  return turns;
}

/** Test/inspection helper. */
export function registrySize(): number {
  return calls.size;
}
