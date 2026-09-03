/**
 * GET /api/cases/summary?ids=1,2,3 — one row per case for the history sidebar.
 *
 * The browser remembers which cases it opened; this endpoint turns those ids
 * into the few fields a list needs. Ids that cannot be read are skipped, not
 * reported, so one stale id never blanks the sidebar. Completeness figures
 * (`answers_saved` / `answers_expected`) come from Xano's progress endpoint
 * and are omitted for a case when that read fails — never recomputed here.
 *
 * Response: `{ cases: CaseSummary[] }`, newest first by `created_at`.
 */

import { NextResponse } from 'next/server';
import { xanoCredentials } from '../../../../lib/adapters/env';
import { requestJson } from '../../../../lib/adapters/http';
import type { CaseBundle, CaseDeliveryStatus, CaseProgress, CaseStatus, Id } from '../../../../lib/contract';
import { getXanoAdapter } from '../../../../lib/voice/xano-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Most ids one request will resolve. */
const MAX_IDS = 30;
/** Cap for `?recent=N` (GET /cases on Xano caps at 50). */
const MAX_RECENT = 30;

/**
 * Ids of the newest cases in the system of record, via Xano `GET /cases`.
 * Empty (never fixture ids) when Xano is not configured or the read fails.
 */
async function recentCaseIds(limit: number): Promise<Id[]> {
  const creds = xanoCredentials();
  if (!creds) return [];
  try {
    const payload = await requestJson<{ cases?: { id?: unknown }[] }>('xano', 'listCases', `${creds.baseUrl}/cases`, {
      query: { limit },
      headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {},
      timeoutMs: 15_000,
    });
    return (payload.cases ?? [])
      .map((row) => (typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : ''))
      .filter((id) => id.length > 0);
  } catch (error) {
    console.warn('[cases] summary: recent list unavailable —', (error as Error).message);
    return [];
  }
}
/** Cases read from Xano at the same time. */
const CONCURRENCY = 5;

export interface CaseSummary {
  id: Id;
  situation_text: string;
  organization_name: string | null;
  program_name: string | null;
  status: CaseStatus;
  created_at: string;
  delivery_status: CaseDeliveryStatus;
  answers_saved?: number;
  answers_expected?: number;
  /** Last four digits of the caller's number when the case came in by phone; never the full number. */
  caller_phone_last4: string | null;
}

function parseIds(raw: string | null): Id[] {
  if (!raw) return [];
  const ids: Id[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    const id = piece.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_IDS) break;
  }
  return ids;
}

function summarize(bundle: CaseBundle, progress: CaseProgress | null): CaseSummary {
  const summary: CaseSummary = {
    id: bundle.case.id,
    situation_text: bundle.case.situation_text ?? '',
    organization_name: bundle.organization?.name ?? bundle.hospital?.name ?? null,
    program_name: bundle.program?.name ?? null,
    status: bundle.case.status,
    created_at: bundle.case.created_at,
    delivery_status: bundle.case.delivery_status ?? 'none',
    caller_phone_last4: bundle.case.caller_phone ? bundle.case.caller_phone.replace(/\D/g, '').slice(-4) || null : null,
  };
  if (progress) {
    summary.answers_saved = progress.answersSaved;
    summary.answers_expected = progress.answersExpected;
  }
  return summary;
}

async function readOne(id: Id): Promise<CaseSummary | null> {
  const xano = getXanoAdapter();
  let bundle: CaseBundle;
  try {
    bundle = await xano.getCase(id);
  } catch (error) {
    console.warn(`[cases] summary: case "${id}" skipped —`, (error as Error).message);
    return null;
  }
  const progress = await xano.getCaseProgress(id).catch(() => null);
  return summarize(bundle, progress);
}

function createdAtMillis(summary: CaseSummary): number {
  const millis = new Date(summary.created_at).getTime();
  return Number.isNaN(millis) ? 0 : millis;
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const requested = parseIds(params.get('ids'));
  const recentRaw = Number(params.get('recent') ?? '0');
  const recentLimit = Number.isFinite(recentRaw) ? Math.min(MAX_RECENT, Math.max(0, Math.floor(recentRaw))) : 0;
  const recent = recentLimit > 0 ? await recentCaseIds(recentLimit) : [];
  // Recent first, then anything this browser remembers that is not already listed.
  const ids = Array.from(new Set([...recent, ...requested])).slice(0, MAX_IDS + MAX_RECENT);
  const cases: CaseSummary[] = [];

  for (let start = 0; start < ids.length; start += CONCURRENCY) {
    const chunk = ids.slice(start, start + CONCURRENCY);
    const results = await Promise.all(chunk.map((id) => readOne(id)));
    for (const summary of results) {
      if (summary) cases.push(summary);
    }
  }

  cases.sort((a, b) => createdAtMillis(b) - createdAtMillis(a));
  return NextResponse.json({ cases });
}
