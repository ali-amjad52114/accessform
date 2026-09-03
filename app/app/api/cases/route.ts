/**
 * POST /api/cases — open a case from the browser before a call starts.
 *
 * Body (all optional): `{ situation_text, location, caller_phone }`. Xano's
 * `POST /cases` accepts an empty situation, so a case can exist before the
 * person has said a word; the voice tools then attach the need, the program
 * and the answers to it.
 *
 * Live mode goes through the M1 create path (`createCaseM1`), which has no
 * fixture fallback: when Xano is unreachable the response is a 502, never a
 * placeholder case. Demo mode uses the in-memory fixture store, exactly like
 * the `create_case` voice tool.
 *
 * Response: `201 { case_id, status, created_at }`.
 */

import { NextResponse } from 'next/server';
import { isDemoMode } from '../../../lib/adapters/env';
import { createLiveXanoAdapter } from '../../../lib/adapters/xano';
import type { Case, CreateCaseInput, CreateCaseM1Request } from '../../../lib/contract';
import * as fixtures from '../../../lib/voice/case-store';
import { getXanoAdapter } from '../../../lib/voice/xano-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Longest free-text value accepted from the browser. */
const MAX_TEXT_LENGTH = 2000;

function optionalText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'Body must be a JSON object.' }, { status: 400 });
  }

  const input: CreateCaseM1Request = {
    situation_text: optionalText(body.situation_text) ?? '',
    patient_display_name: 'Caller',
  };
  const location = optionalText(body.location, 200);
  const callerPhone = optionalText(body.caller_phone, 40);
  if (location) input.location = location;
  if (callerPhone) input.caller_phone = callerPhone;

  let created: Case;
  try {
    if (isDemoMode()) {
      // Same path as the create_case voice tool in demo mode: fixture store,
      // plus the case_created row (live Xano writes that row itself).
      const xano = getXanoAdapter();
      created = await xano.createCase(input as unknown as CreateCaseInput);
      fixtures.adoptCase(created);
      await xano.appendEvent(created.id, {
        actor: 'xano',
        event_type: 'case_created',
        message: 'Case created',
        metadata_json: { case_id: created.id, source: 'browser' },
      });
    } else {
      const live = createLiveXanoAdapter();
      if (!live) {
        return NextResponse.json(
          { error: 'case_unavailable', message: 'The case service is not configured.' },
          { status: 502 },
        );
      }
      created = await live.createCaseM1(input);
      // Keep the local safety net aware of the case even when Xano owns it, so
      // GET /api/voice/case/:id can answer while Xano is briefly unreachable.
      fixtures.adoptCase(created);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[cases] POST /api/cases could not create a case:', message);
    return NextResponse.json({ error: 'case_unavailable', message }, { status: 502 });
  }

  return NextResponse.json(
    { case_id: created.id, status: created.status, created_at: created.created_at },
    { status: 201 },
  );
}
