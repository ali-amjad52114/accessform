/**
 * Browser-side conversation history. AccessForm has no accounts: the ids of
 * the conversations a person started (or opened from an SMS link) live in
 * localStorage under one key, newest first, capped at 50.
 *
 * Client-only. Every access is wrapped so a blocked storage API (private
 * windows, hardened browsers) degrades to an empty history, never a crash.
 */

import type { CaseStatus, Id } from '../../lib/contract';
import type { CaseDeliveryStatus } from '../../lib/m1/contract';

export const CASE_HISTORY_KEY = 'accessform.cases';
export const CASE_HISTORY_MAX = 50;

/** Fired on `window` whenever the history changes, so the sidebar can re-read it. */
export const CASE_HISTORY_EVENT = 'accessform:cases';

export function readCaseHistory(): Id[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CASE_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return Array.from(new Set(ids)).slice(0, CASE_HISTORY_MAX);
  } catch {
    return [];
  }
}

function writeCaseHistory(ids: Id[]): void {
  try {
    window.localStorage.setItem(
      CASE_HISTORY_KEY,
      JSON.stringify(ids.slice(0, CASE_HISTORY_MAX)),
    );
    window.dispatchEvent(new Event(CASE_HISTORY_EVENT));
  } catch {
    /* storage unavailable: the page still works, history is just not kept */
  }
}

/** Put `id` at the front of the history (moving it if already present). */
export function rememberCase(id: Id): Id[] {
  if (typeof window === 'undefined' || !id) return [];
  const next = [id, ...readCaseHistory().filter((existing) => existing !== id)];
  writeCaseHistory(next);
  return next.slice(0, CASE_HISTORY_MAX);
}

/* ------------------------------------------------------------------ */
/* POST /api/cases                                                     */
/* ------------------------------------------------------------------ */

export interface CreateCaseResponse {
  case_id: Id;
  status: CaseStatus;
  created_at: string;
}

export class CreateCaseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CreateCaseError';
    this.status = status;
  }
}

/**
 * Create an empty case for a new browser conversation. Throws on any failure;
 * there is deliberately no fixture fallback — the caller shows the error.
 *
 * Server contract: 201 { case_id, status, created_at };
 * 400 { error: 'invalid_body' }; 502 { error: 'case_unavailable', message }.
 */
export async function createCase(
  body: { situation_text?: string; location?: string } = {},
): Promise<CreateCaseResponse> {
  let response: Response;
  try {
    response = await fetch('/api/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (networkError) {
    throw new CreateCaseError(
      `Could not reach AccessForm: ${(networkError as Error).message}`,
      0,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON body: fall through to the status-based message */
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; message?: string };
    const detail = record.message || record.error || `HTTP ${response.status}`;
    throw new CreateCaseError(detail, response.status);
  }

  const record = (payload ?? {}) as Partial<CreateCaseResponse>;
  if (typeof record.case_id !== 'string' || !record.case_id) {
    throw new CreateCaseError(
      'The server did not return a conversation id.',
      response.status,
    );
  }
  return {
    case_id: record.case_id,
    status: (record.status ?? 'CREATED') as CaseStatus,
    created_at: record.created_at ?? new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/cases/summary                                              */
/* ------------------------------------------------------------------ */

export interface CaseSummary {
  id: Id;
  situation_text?: string | null;
  organization_name?: string | null;
  program_name?: string | null;
  status?: CaseStatus | string | null;
  created_at?: string | null;
  delivery_status?: CaseDeliveryStatus | string | null;
  answers_saved?: number;
  answers_expected?: number;
  /** Last four digits of the caller's number when the case came in by phone. */
  caller_phone_last4?: string | null;
}

/**
 * Summaries for this browser's ids plus, when `recent` is set, the newest
 * cases in the system of record — that is how a case opened by phone appears
 * on the laptop that is watching. Newest first, as the server orders them.
 */
export async function fetchCaseSummaries(ids: Id[], options: { recent?: number } = {}): Promise<CaseSummary[]> {
  const recent = options.recent ?? 0;
  if (ids.length === 0 && recent === 0) return [];
  const params = new URLSearchParams();
  if (ids.length > 0) params.set('ids', ids.join(','));
  if (recent > 0) params.set('recent', String(recent));
  const response = await fetch(`/api/cases/summary?${params.toString()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`History could not be loaded (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as { cases?: unknown };
  if (!Array.isArray(payload.cases)) return [];
  return payload.cases.filter(
    (row): row is CaseSummary =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as CaseSummary).id === 'string',
  );
}

/* ------------------------------------------------------------------ */
/* Status pill wording (safe copy only)                                */
/* ------------------------------------------------------------------ */

export type HistoryPillTone = 'live' | 'ok' | 'warn' | 'mute';

export interface HistoryPill {
  label: string;
  tone: HistoryPillTone;
}

/**
 * Never "approved", "eligible", "submitted", "signed" or "sent" as a claim
 * about the application. "texted" only describes the SMS carrying the link.
 */
export function historyPill(
  summary: Pick<CaseSummary, 'status' | 'delivery_status'> | null,
): HistoryPill {
  if (summary?.delivery_status === 'sent') return { label: 'texted', tone: 'ok' };
  switch (summary?.status) {
    case 'READY_FOR_REVIEW':
      return { label: 'ready to review', tone: 'warn' };
    case 'BLOCKED':
      return { label: 'stopped', tone: 'mute' };
    default:
      return { label: 'in progress', tone: 'live' };
  }
}
