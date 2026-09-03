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
import type { CaseBundle, CaseDeliveryStatus, CaseProgress, CaseStatus, Id } from '../../../../lib/contract';
import { getXanoAdapter } from '../../../../lib/voice/xano-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Most ids one request will resolve. */
const MAX_IDS = 30;
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
  const ids = parseIds(new URL(request.url).searchParams.get('ids'));
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
